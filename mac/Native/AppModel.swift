import AppKit
import Observation
import SwiftUI

/// The app's one model: where the to-dos are, what the sidebar holds, and the
/// list in front. Every change is a request to the backend, whichever it is,
/// followed by asking again; the engine (or the server) decides everything.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    enum Phase: Equatable {
        case starting
        case signIn(String?)            // a message, after a refusal
        case ready
        case failed(String)
    }

    private(set) var phase: Phase = .starting
    private(set) var backend: Backend?
    private(set) var state = AppState.empty
    private(set) var content = ListContent()
    private(set) var loading = false
    private(set) var sync = SyncState()
    private(set) var person: Account.Person?
    var place: Place = .today {
        didSet {
            guard place != oldValue else { return }
            selected = []
            anchor = nil
            openId = nil
            popover = nil
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

    enum Popover: Equatable {
        case when(String), deadline(String), tags(String), move(String), repeating(String)
        var todoId: String {
            switch self { case .when(let id), .deadline(let id), .tags(let id), .move(let id), .repeating(let id): id }
        }
    }
    /// What the last thing done says, with its Undo (a toast at the foot of the list).
    var notice: String?

    /// The app's own undo history, a step per change, for ⌘Z and ⇧⌘Z (the Edit
    /// menu sends typing's undo to the text field instead). Not the window's:
    /// that one groups by event, and a change made after an await, outside any
    /// event, could land in a group another change had left open, so that one
    /// ⌘Z undid two things.
    let history: UndoManager = {
        let u = UndoManager()
        u.groupsByEvent = false
        return u
    }()
    var undoManager: UndoManager? { history }

    private var refreshTask: Task<Void, Never>?

    // ---- starting, and which backend --------------------------------------------------

    func start() async {
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
                try await use(LocalBackend(root: Account.folder(for: copy), sync: (copy.server, token), tutorial: false))
            case .folder:
                guard let path = Prefs.store.string(forKey: Prefs.folderKey), !path.isEmpty else {
                    phase = .failed("Choose the folder your to-dos live in, in Settings.")
                    return
                }
                try await use(LocalBackend(root: URL(fileURLWithPath: path, isDirectory: true), sync: nil, tutorial: true))
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
        content = ListContent()
        phase = .signIn(nil)
        return nil
    }

    func switchMode(_ m: Mode) async {
        guard m != Mode.current else { return }
        Mode.current = m
        await start()
    }

    // ---- reading ----------------------------------------------------------------------

    /// Something changed somewhere: ask again, once, a moment later.
    private func changed() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    func refresh() async {
        guard let backend else { return }
        if let j = try? await backend.request("GET", "/api/state", body: nil) { state = AppState(j) }
        // a project or area that has gone (deleted, or elsewhere) is not a place any more
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
        content = Lists.content(asked, j, state: state)
    }

    func ask(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> J {
        guard let backend else { throw APIError(status: 0, message: "Not ready yet.") }
        let j = try await backend.request(method, path, body: body)
        changed()
        return j
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
    /// follows. Registered inside a group of its own: from outside a key
    /// event an undo manager would otherwise open one and leave it open until
    /// the run loop next turns over, and an Undo in between undoes nothing.
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

    func catchUp() { backend?.catchUp() }
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
            let items = j["items"].array.map(Todo.init)
            let rows = projects(j["projects"]) + items.filter { !$0.evening }.map(ListContent.Row.todo)
            out.sections = [.init(id: "today", rows: rows)]
            let evening = items.filter(\.evening)
            if !evening.isEmpty { out.sections.append(.init(id: "evening", title: "This Evening", rows: evening.map(ListContent.Row.todo))) }
        case .upcoming:
            out.sections = j["days"].array.map { d in
                let date = d["date"].string ?? ""
                return .init(id: date, title: Dates.dayTitle(date, today: state.today), subtitle: Dates.daySubtitle(date, today: state.today),
                             rows: projects(d["projects"]) + todos(d["items"]))
            }.filter { !$0.rows.isEmpty }
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
        case .area(let id):
            out.notes = j["area"]["notes"].string ?? ""
            let area = state.area(id)
            out.sections = [.init(id: "area", rows: (area?.projects ?? []).map(ListContent.Row.project) + todos(j["items"]))]
        }
        return out
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
