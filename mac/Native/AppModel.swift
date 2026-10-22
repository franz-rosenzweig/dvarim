import AppKit
import Observation
import SwiftUI

/// What every window shares: where the to-dos are and the backend that
/// answers for them, the sidebar's state, the sync, who is signed in, and the
/// one undo history. Each window has its own AppModel, for its own list.
@MainActor
@Observable
final class Session {
    static let shared = Session()

    private(set) var phase: AppModel.Phase = .starting
    private(set) var backend: Backend?
    private(set) var state = AppState.empty
    private(set) var sync = SyncState()
    private(set) var person: Account.Person?

    /// The app's own undo history, a step per change, for ⌘Z and ⇧⌘Z (the Edit
    /// menu sends typing's undo to the text field instead). Not a window's:
    /// that one groups by event, and a change made after an await, outside any
    /// event, could land in a group another change had left open, so that one
    /// ⌘Z undid two things. One for all the windows, as a change in one shows
    /// in every one.
    let history: UndoManager = {
        let u = UndoManager()
        u.groupsByEvent = false
        return u
    }()

    private struct Window { weak var model: AppModel? }
    private var windows: [Window] = []
    private var refreshTask: Task<Void, Never>?

    func attach(_ m: AppModel) {
        windows.removeAll { $0.model == nil }
        windows.append(Window(model: m))
    }

    var open: [AppModel] { windows.compactMap(\.model) }

    // ---- starting, and which backend --------------------------------------------------

    private var begun = false

    /// Once, from whichever asks first: the app at launch (Shortcuts and
    /// Quick Entry need no window) or the first window.
    func startIfNeeded() async {
        guard !begun else { return }
        begun = true
        await start()
    }

    /// Until the backend is up, at most this long: a Shortcut or Quick Entry
    /// at launch comes before it.
    func ready(within seconds: Double) async {
        let end = Date().addingTimeInterval(seconds)
        while phase == .starting && Date() < end { try? await Task.sleep(nanoseconds: 100_000_000) }
    }

    func start() async {
        begun = true
        phase = .starting
        backend?.stop()
        backend = nil
        do {
            switch Mode.current {
            case .remote:
                guard let who = try await Account.whoIsSignedIn() else { phase = .signIn(nil); return }
                person = who
                try await use(RemoteBackend(server: Prefs.server))
            case .copy:
                guard let copy = Account.copy, let token = Account.token(for: copy) else {
                    // A copy is made from a sign-in: one already here makes it now.
                    if let who = try? await Account.whoIsSignedIn() {
                        person = who
                        _ = try await Account.makeCopy(for: who)
                        return await start()
                    }
                    phase = .signIn(nil)
                    return
                }
                // No tour of its own: the server's vault has one, and a device's
                // untouched one merged into it on the first sync and doubled it.
                try await use(LocalBackend(root: Account.folder(for: copy), sync: (copy.server, token), tutorial: false, events: .server))
            case .folder:
                guard let path = Prefs.store.string(forKey: Prefs.folderKey), !path.isEmpty else {
                    phase = .failed("Choose the folder your to-dos live in, in Settings.")
                    return
                }
                try await use(LocalBackend(root: URL(fileURLWithPath: path, isDirectory: true), sync: nil, tutorial: true, events: .device))
            }
        } catch let e as APIError where e.unreachable && Mode.current == .remote {
            phase = .failed("Can't reach \(Prefs.server.host ?? "the server"). Remote mode needs it; a copy on this Mac doesn't.")
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func use(_ b: Backend) async throws {
        try await b.start()
        b.onChange = { [weak self] in self?.changed() }
        b.onSyncState = { [weak self] s in self?.sync = s }
        backend = b
        sync = b.syncState
        phase = .ready
        await refresh()
        // what was kept while there was nowhere to send it
        await Outbox.shared.drain()
    }

    /// The password, from the sign-in form; then the mode starts again.
    func signIn(password: String, name: String?) async {
        do {
            let who = try await Account.signIn(password: password, name: name)
            person = who
            if Mode.current == .copy { _ = try await Account.makeCopy(for: who) }
            await start()
        } catch let e as APIError where e.unreachable {
            phase = .signIn("Can't reach \(Prefs.server.host ?? "the server").")
        } catch {
            phase = .signIn(error.localizedDescription)
        }
    }

    /// Off this server: the copy's last changes go first, then its token and
    /// the copy itself, then the sign-in. Refused, and said, if the last
    /// changes can't reach the server.
    @discardableResult
    func signOut() async -> String? {
        if Mode.current == .copy, let local = backend as? LocalBackend, let copy = Account.copy {
            do { try await local.engine.syncNow() } catch {
                return "Your latest changes haven't reached the server yet. Sign out once you're back online."
            }
            local.stop()
            backend = nil
            await Account.dropCopy(copy)
        }
        backend?.stop()
        backend = nil
        await Account.signOut()
        person = nil
        state = .empty
        for w in open { w.clear() }
        Dock.clear()
        Reminders.shared.clear()
        Shell.shared.stateChanged(nil)
        phase = .signIn(nil)
        return nil
    }

    func switchMode(_ m: Mode) async {
        guard m != Mode.current else { return }
        Mode.current = m
        await start()
    }

    // ---- reading ----------------------------------------------------------------------

    /// Something changed somewhere: every window asks again, once, a moment later.
    func changed() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    /// The sidebar's state, then each window's list, then the Mac's parts
    /// (the badge, the menu bar, the reminders).
    func refresh() async {
        guard let backend else { return }
        let fresh = (try? await backend.request("GET", "/api/state", body: nil)).map(AppState.init)
        if let fresh { state = fresh }
        for w in open { await w.reconcile() }
        Shell.shared.stateChanged(fresh)
    }

    /// Each minute (Shell): the state again, and on a new day every list too.
    func heartbeat() async {
        guard phase == .ready, let backend else { return }
        guard let j = try? await backend.request("GET", "/api/state", body: nil) else { return Dock.show(nil) }
        let fresh = AppState(j)
        if fresh.today != state.today { return await refresh() }
        state = fresh
        Shell.shared.stateChanged(fresh)
    }

    func ask(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> J {
        guard let backend else { throw APIError(status: 0, message: "Not ready yet.") }
        let j = try await backend.request(method, path, body: body)
        changed()
        return j
    }

    func catchUp() { backend?.catchUp() }

    /// The calendars were turned on or chosen: the engine asks again, and every list with it.
    func calendarsChanged() async {
        if let local = backend as? LocalBackend { await local.engine.calendarsChanged() } else { await refresh() }
    }
}

/// One window's model: which list it shows, what is chosen in it, the card
/// open in it and the picker showing. Everything shared (the backend, the
/// sidebar's state, the undo history) is the Session's, and read through here.
/// Every change is a request to the backend, followed by asking again; the
/// engine (or the server) decides everything.
@MainActor
@Observable
final class AppModel {
    /// The first window's, and the one the self-test drives.
    static let shared = AppModel(session: .shared)
    private static var handedOut = false

    /// A window's model: the first window gets the shared one, each other its own.
    static func forWindow() -> AppModel {
        if !handedOut { handedOut = true; return shared }
        return AppModel(session: .shared)
    }

    enum Phase: Equatable {
        case starting
        case signIn(String?)            // a message, after a refusal
        case ready
        case failed(String)
    }

    let session: Session

    init(session: Session) {
        self.session = session
        session.attach(self)
    }

    var phase: Phase { session.phase }
    var backend: Backend? { session.backend }
    var state: AppState { session.state }
    var sync: SyncState { session.sync }
    var person: Account.Person? { session.person }
    var history: UndoManager { session.history }
    var undoManager: UndoManager? { session.history }

    /// The list as the engine gave it, and as it shows: less what the tag
    /// filter leaves out. Everything that acts on rows acts on what shows.
    private(set) var fullContent = ListContent()
    private(set) var content = ListContent()
    /// The tag the list is filtered by (the pills under its title), or none.
    var filterTag: String? {
        didSet { if filterTag != oldValue { show() } }
    }

    private func show() {
        if let t = filterTag, !fullContent.tags.contains(t) { filterTag = nil; return }
        content = Lists.filtered(fullContent, tag: filterTag)
        // what the filter hides isn't chosen either
        if filterTag != nil {
            let shown = Set(content.allTodos.map { "t:" + $0.id })
            selected = selected.filter { !$0.hasPrefix("t:") || shown.contains($0) }
        }
    }
    private(set) var loading = false
    var place: Place = .today {
        didSet {
            guard place != oldValue else { return }
            selected = []
            anchor = nil
            openId = nil
            popover = nil
            filterTag = nil
            Task { await loadList() }
        }
    }
    /// The rows chosen ("t:<id>", "p:<id>"), and the one the keyboard moves from.
    var selected: Set<String> = []
    var anchor: String?
    /// The to-do open in place as its card, and whether its title takes the keyboard.
    var openId: String?
    var focusTitle = false
    /// Made a moment ago: its card shows an empty title rather than "New To-Do".
    var newId: String?
    /// The picker showing, and for which to-do.
    var popover: Popover?
    /// Quick Find, while it is open.
    var finding = false
    /// The heading being renamed, by its id ("<project>:<name>"), and whether the list's title is.
    var renamingHeading: String?
    var renamingTitle = false
    /// The window this model is the list of (Windows.swift).
    @ObservationIgnored weak var window: NSWindow?
    /// What is being dragged, and where it would land (DragDrop.swift).
    var dragging: [String] = []
    var dropTarget: DropTarget?

    enum Popover: Equatable {
        case when(String), deadline(String), tags(String), move(String), repeating(String)
        var todoId: String {
            switch self { case .when(let id), .deadline(let id), .tags(let id), .move(let id), .repeating(let id): id }
        }
    }
    /// What the last thing done says, with its Undo (a toast at the foot of the list).
    var notice: String?

    // ---- the shared parts, asked of the Session ------------------------------------

    func start() async { await session.start() }
    func signIn(password: String, name: String?) async { await session.signIn(password: password, name: name) }
    @discardableResult func signOut() async -> String? { await session.signOut() }
    func switchMode(_ m: Mode) async { await session.switchMode(m) }
    func catchUp() { session.catchUp() }
    /// Everything asked again: the sidebar's state and every window's list.
    func refresh() async { await session.refresh() }

    func ask(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> J {
        try await session.ask(method, path, body)
    }

    /// Signed out: nothing of the last person's stays on screen.
    func clear() {
        fullContent = ListContent()
        content = ListContent()
        selected = []
        anchor = nil
        openId = nil
        popover = nil
    }

    // ---- reading ----------------------------------------------------------------------

    /// After the state is asked again: a project or area that has gone (deleted,
    /// or elsewhere) is not a place any more; then the list.
    func reconcile() async {
        switch place {
        case .project(let id) where state.project(id) == nil: place = .today
        case .area(let id) where state.area(id) == nil: place = .today
        default: break
        }
        await loadList()
    }

    func loadList() async {
        guard let backend else { return }
        let asked = place
        loading = true
        defer { loading = false }
        guard let j = try? await backend.request("GET", asked.path, body: nil), asked == place else { return }
        fullContent = Lists.content(asked, j, state: state)
        show()
    }

    // ---- ticking off, with ⌘Z --------------------------------------------------------

    func toggle(_ todo: Todo) async {
        if todo.isOpen { await complete(todo) } else { await reopen(todo) }
    }

    func complete(_ todo: Todo) async {
        await act("Complete", notice: "Completed “\(todo.title)”",
                  do: { m in _ = try await m.ask("POST", "/api/todos/\(todo.id)/complete", [:]) },
                  undo: { m in _ = try await m.ask("POST", "/api/todos/\(todo.id)/reopen", [:]) })
    }

    func reopen(_ todo: Todo) async {
        await act("Reopen", notice: "Reopened “\(todo.title)”",
                  do: { m in _ = try await m.ask("POST", "/api/todos/\(todo.id)/reopen", [:]) },
                  undo: { m in _ = try await m.ask("POST", "/api/todos/\(todo.id)/complete", [:]) })
    }

    typealias Step = @MainActor (AppModel) async throws -> Void

    /// Something done, said at the foot of the window, with its opposite
    /// registered for ⌘Z (and the notice's Undo), and the thing itself again
    /// for ⇧⌘Z.
    func act(_ name: String, notice text: String?, do work: @escaping Step, undo: @escaping Step) async {
        do {
            try await work(self)
            if let text { notice = text }
            register(name, undo: undo, redo: work)
        } catch { notice = error.localizedDescription }
    }

    /// The opposite registers its own opposite at once, while the undo manager
    /// is still undoing, so it lands on the redo stack; the request itself
    /// follows. Each change is a group of its own.
    func register(_ name: String, undo: @escaping Step, redo: @escaping Step) {
        let u = history
        u.beginUndoGrouping()
        u.registerUndo(withTarget: self) { m in
            m.register(name, undo: redo, redo: undo)
            Task { @MainActor in
                do { try await undo(m) } catch { m.notice = error.localizedDescription }
            }
        }
        u.setActionName(name)
        u.endUndoGrouping()
    }
}

/// An answer of the API as sections of rows, list by list.
enum Lists {
    static func content(_ place: Place, _ j: J, state: AppState) -> ListContent {
        var out = ListContent()
        let todos = { (a: J) in a.array.map { ListContent.Row.todo(Todo($0)) } }
        let projects = { (a: J) in a.array.map { ListContent.Row.project(Project($0)) } }
        switch place {
        case .inbox:
            out.sections = [.init(id: "inbox", rows: todos(j["items"]))]
        case .today:
            out = today(j, state: state)
        case .upcoming:
            out.sections = j["days"].array.map { d in
                let date = d["date"].string ?? ""
                return .init(id: date, title: Dates.dayTitle(date, today: state.today), subtitle: Dates.daySubtitle(date, today: state.today),
                             rows: projects(d["projects"]) + todos(d["items"]), events: CalEvent.list(d["events"]))
            }.filter { !$0.rows.isEmpty || !$0.events.isEmpty }
        case .anytime:
            out.sections = [.init(id: "loose", rows: todos(j["items"]))]
            out.sections += j["groups"].array.map { g in
                let p = g["project"], a = g["area"]
                let title = p["name"].string ?? a["name"].string
                return .init(id: p["id"].string ?? a["id"].string ?? UUID().uuidString, title: title, rows: todos(g["items"]))
            }
        case .someday:
            out.sections = [.init(id: "someday", rows: todos(j["items"]) + projects(j["projects"]))]
        case .logbook:
            out.sections = j["groups"].array.map { g in
                let date = g["date"].string ?? ""
                return .init(id: date, title: Dates.logTitle(date, today: state.today), rows: projects(g["projects"]) + todos(g["items"]))
            }
        case .trash:
            out.sections = [.init(id: "trash", rows: todos(j["items"]) + projects(j["projects"]))]
        case .project:
            out.notes = j["project"]["notes"].string ?? ""
            let items = j["items"].array.map(Todo.init)
            var byHeading: [String: [Todo]] = [:]
            for t in items { byHeading[t.headingId ?? "", default: []].append(t) }
            out.sections = [.init(id: "", rows: (byHeading[""] ?? []).map(ListContent.Row.todo))]
            for h in Project(j["project"]).headings where !h.archived {
                out.sections.append(.init(id: h.id, title: h.name, rows: (byHeading[h.id] ?? []).map(ListContent.Row.todo)))
            }
        case .extra:
            out.sections = [.init(id: "extra", rows: projects(j["projects"]) + todos(j["items"]))]
            out.events = CalEvent.list(j["events"])       // Tomorrow has them
        case .area(let id):
            out.notes = j["area"]["notes"].string ?? ""
            let area = state.area(id)
            out.sections = [.init(id: "area", rows: (area?.projects ?? []).map(ListContent.Row.project) + todos(j["items"]))]
        }
        return out
    }
}

extension Lists {
    /// Only the to-dos with this tag (FilterBar.svelte): no events, no
    /// projects, and no section left empty but the first.
    static func filtered(_ c: ListContent, tag: String?) -> ListContent {
        guard let tag else { return c }
        var out = c
        out.events = []
        out.crowded = []
        out.sections = c.sections.enumerated().compactMap { i, s in
            var s = s
            s.rows = s.rows.filter { if case .todo(let t) = $0 { t.tags.contains(tag) } else { false } }
            s.events = []
            return s.rows.isEmpty && i > 0 ? nil : s
        }
        return out
    }

    /// Today as the web app lays it out (TodayView.svelte): the events, the
    /// projects, the day's to-dos (by list, under a heading each, when Settings
    /// says so), Today's own headings with theirs, then This Evening.
    static func today(_ j: J, state: AppState) -> ListContent {
        var out = ListContent()
        out.events = CalEvent.list(j["events"])
        let items = j["items"].array.map(Todo.init)
        let day = items.filter { !$0.evening }
        let headings = j["headings"].array
        let filed = Set(headings.flatMap { $0["todos"].strings })
        let unfiled = day.filter { !filed.contains($0.id) }
        let projects = j["projects"].array.map { ListContent.Row.project(Project($0)) }

        if state.groupTodayByList {
            // loose ones first, then a heading per list, in the sidebar's order
            var order: [String] = []
            for a in state.areas { order.append("area:" + a.id); order += a.projects.map { "project:" + $0.id } }
            order += state.looseProjects.map { "project:" + $0.id }
            let key = { (t: Todo) -> String? in t.projectId.map { "project:" + $0 } ?? t.areaId.map { "area:" + $0 } }
            out.sections = [.init(id: "today", rows: projects + unfiled.filter { key($0) == nil }.map(ListContent.Row.todo))]
            var buckets: [String: [Todo]] = [:]
            for t in unfiled { if let k = key(t) { buckets[k, default: []].append(t) } }
            let rank = { (k: String) in order.firstIndex(of: k) ?? Int.max }
            for k in buckets.keys.sorted(by: { rank($0) < rank($1) }) {
                let list = buckets[k]!
                out.sections.append(.init(id: "group:" + k, title: list[0].projectName ?? list[0].areaName ?? "Elsewhere",
                                          rows: list.map(ListContent.Row.todo)))
            }
        } else {
            out.sections = [.init(id: "today", rows: projects + unfiled.map(ListContent.Row.todo))]
        }
        for h in headings {
            let ids = Set(h["todos"].strings)
            out.sections.append(.init(id: "th:" + (h["id"].string ?? ""), title: h["name"].string ?? "",
                                      rows: day.filter { ids.contains($0.id) }.map(ListContent.Row.todo)))
        }
        let evening = items.filter(\.evening)
        if !evening.isEmpty { out.sections.append(.init(id: "evening", title: "This Evening", rows: evening.map(ListContent.Row.todo))) }
        out.crowded = crowded(items)
        return out
    }

    /// More than one to-do from the same project (frontend lib/today.js): Today
    /// works best with one next step from each. A catch-all of errands, a
    /// project with "agenda" or "admin" in its name, may have any number.
    static func crowded(_ items: [Todo]) -> [(id: String, name: String, count: Int)] {
        var seen: [String: (String, Int)] = [:]
        var order: [String] = []
        for t in items where t.isOpen {
            guard let p = t.projectId, (t.projectName ?? "").firstMatch(of: #/(?i)\b(agenda|admin)\b/#) == nil else { continue }
            if seen[p] == nil { order.append(p) }
            seen[p] = (t.projectName ?? "", (seen[p]?.1 ?? 0) + 1)
        }
        return order.compactMap { p in seen[p].flatMap { $0.1 > 1 ? (p, $0.0, $0.1) : nil } }
    }
}

/// Days in words: Today, Tomorrow, a weekday, then a date.
enum Dates {
    static let iso: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func date(_ s: String) -> Date? { iso.date(from: s) }

    static func days(from a: String, to b: String) -> Int? {
        guard let x = date(a), let y = date(b) else { return nil }
        return Calendar.current.dateComponents([.day], from: x, to: y).day
    }

    static func dayTitle(_ s: String, today: String) -> String {
        guard let d = date(s) else { return s }
        switch days(from: today, to: s) ?? 99 {
        case 0: return "Today"
        case 1: return "Tomorrow"
        case 2...6: return d.formatted(.dateTime.weekday(.wide))
        default: return d.formatted(.dateTime.day().month(.wide))
        }
    }

    static func daySubtitle(_ s: String, today: String) -> String? {
        guard let d = date(s), let n = days(from: today, to: s), n < 7 else { return nil }
        return d.formatted(.dateTime.day().month(.abbreviated))
    }

    static func logTitle(_ s: String, today: String) -> String {
        guard let d = date(s) else { return s }
        switch days(from: s, to: today) ?? 99 {
        case 0: return "Today"
        case 1: return "Yesterday"
        default: return d.formatted(.dateTime.weekday(.wide).day().month(.wide))
        }
    }

    /// "24 Sep", "Tomorrow", "Friday": a when or a deadline in a row.
    static func short(_ s: String, today: String) -> String {
        guard let d = date(s) else { return s }
        switch days(from: today, to: s) ?? 99 {
        case 0: return "Today"
        case 1: return "Tomorrow"
        case 2...6: return d.formatted(.dateTime.weekday(.wide))
        default: return d.formatted(.dateTime.day().month(.abbreviated))
        }
    }

    static func add(_ s: String, days n: Int) -> String {
        guard let d = date(s), let e = Calendar.current.date(byAdding: .day, value: n, to: d) else { return s }
        return iso.string(from: e)
    }

    /// The first day of next week, never today (frontend dates.js nextWeekStart).
    static func nextWeekStart(_ today: String, weekStartsOn: Int) -> String {
        guard let d = date(today) else { return today }
        let dow = Calendar.current.component(.weekday, from: d) - 1
        let n = (weekStartsOn - dow + 7) % 7
        return add(today, days: n == 0 ? 7 : n)
    }

    private static func english(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = format
        return f
    }
    private static let wd = english("EEE"), wdDay = english("EEE d"), wdDayMonth = english("EEE d MMM")

    /// "Wed"
    static func weekdayShort(_ s: String) -> String { date(s).map(wd.string) ?? s }
    /// "Thu 22"
    static func dayShort(_ s: String) -> String { date(s).map(wdDay.string) ?? s }
    /// "Fri 24 Oct" (frontend dates.js labelDate)
    static func label(_ s: String) -> String { date(s).map(wdDayMonth.string) ?? s }

    /// "2 days left", "today", "3 days ago": a deadline's flag.
    static func deadline(_ s: String, today: String) -> String {
        guard let n = days(from: today, to: s) else { return s }
        switch n {
        case 0: return "today"
        case 1: return "tomorrow"
        case 2...: return "\(n) days left"
        case -1: return "yesterday"
        default: return "\(-n) days ago"
        }
    }
}
