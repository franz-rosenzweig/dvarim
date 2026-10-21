import AppKit
import UserNotifications

/// Notifications on this Mac for the reminders still ahead today, each with a
/// Complete button, as on the phone; a click on one opens its to-do. The server
/// can send them over Signal too (docs/INTEGRATIONS.md): turn one off, or be
/// told twice. Off beside the web-view Dvarim, which has its own (Shell).
@MainActor
@Observable
final class Reminders {
    static let shared = Reminders()
    static let category = "reminder"
    static let completeAction = "complete"

    /// Why they can't show, when they can't; Settings says it.
    private(set) var problem: String?
    @ObservationIgnored private var pending: Task<Void, Never>?

    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    /// Once, at launch: the Complete button, and permission if they are on.
    func start() {
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.category,
                                   actions: [UNNotificationAction(identifier: Self.completeAction, title: "Complete")],
                                   intentIdentifiers: [])
        ])
        if Shell.shared.reminders { Task { await ask() } }
    }

    func turned(_ on: Bool) async {
        if on { await ask(); await sync() } else { clear() }
    }

    /// None waiting: they are off, or nobody is signed in. Not from the
    /// self-test, which has the installed app's bundle id and so its reminders.
    func clear() {
        guard !SelfTest.asked else { return }
        center.removeAllPendingNotificationRequests()
    }

    func ask() async {
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound])
            problem = granted ? nil : "Notifications for Dvarim Native are off. Turn them on in System Settings → Notifications; macOS asks only once."
        } catch {
            // refused with no prompt: macOS does that for an app outside /Applications
            problem = "macOS refused. Dvarim Native has to be in /Applications for notifications."
        }
    }

    /// A moment after a change, so that a run of changes is one look.
    func soon() {
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    struct Wanted: Equatable {
        let id: String
        let title: String
        let subtitle: String?
        let at: DateComponents
    }

    /// The to-dos' reminders still to come, by this Mac's clock. The day is the
    /// to-do's own When, not this Mac's today: the server keeps a zone of its
    /// own, and for part of a day the two dates differ when the Mac is elsewhere.
    static func wanted(_ todos: [Todo], now: Date = Date(), calendar: Calendar = .current) -> [Wanted] {
        todos.compactMap { t in
            guard t.isOpen, let at = t.reminder, let day = t.when else { return nil }
            let d = day.split(separator: "-").compactMap { Int($0) }
            let h = at.split(separator: ":").compactMap { Int($0) }
            guard d.count == 3, h.count == 2 else { return nil }
            let when = DateComponents(year: d[0], month: d[1], day: d[2], hour: h[0], minute: h[1])
            guard let fire = calendar.date(from: when), fire > now else { return nil }
            return Wanted(id: t.id, title: t.title, subtitle: t.projectName ?? t.areaName, at: when)
        }
    }

    /// Today's reminders asked for again; a request per to-do, by its id, so a
    /// second look replaces rather than adds. Ones no longer wanted go, even
    /// those left from while the app wasn't running.
    func sync() async {
        guard Shell.shared.reminders else { return }
        let session = Session.shared
        guard session.phase == .ready, let backend = session.backend,
              let j = try? await backend.request("GET", Place.today.path, body: nil) else { return }
        let todos = Lists.content(.today, j, state: session.state).allTodos
        let wanted = Self.wanted(todos)
        for w in wanted {
            let content = UNMutableNotificationContent()
            content.title = w.title
            if let s = w.subtitle { content.subtitle = s }
            content.sound = .default
            content.categoryIdentifier = Self.category
            content.userInfo = ["id": w.id, "title": w.title]
            let request = UNNotificationRequest(identifier: w.id, content: content,
                                                trigger: UNCalendarNotificationTrigger(dateMatching: w.at, repeats: false))
            try? await center.add(request)
        }
        let ids = Set(wanted.map(\.id))
        let stale = await center.pendingNotificationRequests().map(\.identifier).filter { !ids.contains($0) }
        if !stale.isEmpty { center.removePendingNotificationRequests(withIdentifiers: stale) }
    }

    /// A reminder answered: Complete ticks the to-do (kept here if the server
    /// can't be reached); a click on the reminder opens it.
    func answer(_ action: String, id: String, title: String) async {
        switch action {
        case Self.completeAction:
            try? await Outbox.shared.complete(id, title: title)
        case UNNotificationDefaultActionIdentifier:
            await Windows.open(todo: id)
        default:
            break
        }
    }
}
