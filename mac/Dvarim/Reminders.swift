import Foundation
import UserNotifications

/// What answering a reminder does. Its Complete button ticks the to-do where it
/// stands — kept on this Mac if the server cannot be reached (Outbox), as a tick
/// in the menu bar is. A click on the reminder itself opens the to-do. Apart
/// from AppDelegate so the self-test can answer one: a notification response
/// cannot be made by hand.
@MainActor
enum ReminderAnswer {
    static func handle(_ action: String, id: String, title: String) async {
        switch action {
        case ReminderScheduler.completeAction:
            try? await Outbox.shared.complete(id, title: title)
            await BadgeUpdater.shared.refresh()
        case UNNotificationDefaultActionIdentifier:
            Windows.show("/todo/\(id)")
        default:
            break
        }
    }
}

/// Native notifications for to-dos with a reminder time today.
///
/// The server can already send these over Signal (see docs/INTEGRATIONS.md).
/// Turn one of the two off, or you will be told twice.
actor ReminderScheduler {
    static let shared = ReminderScheduler()
    /// A reminder carries a Complete button, as it does on the phone; clicking
    /// the reminder itself opens the to-do. AppDelegate answers both.
    static let category = "reminder"
    static let completeAction = "complete"
    private var poller: Task<Void, Never>?

    func start(every seconds: UInt64 = 300) {
        poller?.cancel()
        poller = Task { [weak self] in
            while !Task.isCancelled {
                await self?.sync()
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            }
        }
    }

    func stop() {
        poller?.cancel()
        poller = nil
    }

    /// Why reminders cannot show here, when they cannot. Settings displays it.
    private(set) var problem: String?

    func requestPermission() async {
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: Self.category,
                                   actions: [UNNotificationAction(identifier: Self.completeAction, title: "Complete")],
                                   intentIdentifiers: [])
        ])
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            problem = granted ? nil : "Notifications for Dvarim are off. Turn them on in System Settings → Notifications → Dvarim; macOS only asks once, so a refusal sticks."
        } catch {
            // Refused outright, with no prompt: macOS does that for an app that does
            // not live in /Applications, whatever it is signed with.
            problem = "macOS refused the request. Dvarim has to live in /Applications; anywhere else notifications are refused with no prompt. Keep the Signal reminders on meanwhile."
        }
    }

    /// Schedules a local notification for every reminder still ahead in Today.
    /// Re-running is safe: identifiers are the to-do ids, so requests replace.
    /// The day is the to-do's own When, not the Mac's today: the server keeps
    /// its own zone (TZ), and the two dates differ for part of every day when
    /// the Mac is elsewhere. The time is wall-clock time here.
    func sync() async {
        let center = UNUserNotificationCenter.current()
        guard UserDefaults.standard.object(forKey: Defaults.notificationsKey) == nil
                || UserDefaults.standard.bool(forKey: Defaults.notificationsKey) else {
            center.removeAllPendingNotificationRequests()
            return
        }
        guard let list = try? await Client.current.today() else { return }

        let calendar = Calendar.current
        var wanted: Set<String> = []

        for todo in list.items {
            guard let at = todo.reminder, let day = todo.when else { continue }
            let date = day.split(separator: "-").compactMap { Int($0) }
            let time = at.split(separator: ":").compactMap { Int($0) }
            guard date.count == 3, time.count == 2 else { continue }
            let when = DateComponents(year: date[0], month: date[1], day: date[2], hour: time[0], minute: time[1])
            guard let fireDate = calendar.date(from: when), fireDate > Date() else { continue }

            wanted.insert(todo.id)
            let content = UNMutableNotificationContent()
            content.title = todo.title
            if let project = todo.projectName { content.subtitle = project }
            content.sound = .default
            content.categoryIdentifier = Self.category
            content.userInfo = ["id": todo.id, "title": todo.title]
            let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: false)
            let request = UNNotificationRequest(identifier: todo.id, content: content, trigger: trigger)
            try? await center.add(request)
        }

        // drop anything that was rescheduled, completed or deleted since last time,
        // including while the app was not running: pending requests outlive it
        let stale = await center.pendingNotificationRequests().map(\.identifier).filter { !wanted.contains($0) }
        if !stale.isEmpty {
            center.removePendingNotificationRequests(withIdentifiers: stale)
        }
    }
}
