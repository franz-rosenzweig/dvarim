import AppKit
import EventKit

/// The bridge's `calendars` and `events` ops (docs/BRIDGE.md): this Mac's own
/// calendars, from EventKit, for Today, Upcoming and Settings → Calendar when
/// the to-dos live in a folder and no server reads a calendar for the page.
///
/// With -DeviceCalendarsFile, a JSON file in tools/bridge_sim.py's shape
/// stands in for EventKit, so the self-test can check the page's side without
/// a calendar permission of its own.
actor DeviceCalendars {
    static let shared = DeviceCalendars()
    private var store: EKEventStore?

    static let refused = "Dvarim may not read your calendars. Allow it in System Settings → Privacy & Security → Calendars."

    private var file: URL? {
        UserDefaults.standard.string(forKey: "DeviceCalendarsFile").map { URL(fileURLWithPath: $0) }
    }

    /// `[{name, color}]`: the calendars that hold events, one per name.
    func calendars() async -> [String: Any] {
        if let file { return ["ok": Self.fromFile(file)["calendars"] as? [[String: Any]] ?? []] }
        do {
            let store = try await access()
            var seen = Set<String>()
            let list = store.calendars(for: .event)
                .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
                .filter { seen.insert($0.title).inserted }
                .map { ["name": $0.title, "color": Self.hex($0.color)] }
            return ["ok": list]
        } catch {
            return FolderFiles.failure("EACCES", Self.refused)
        }
    }

    /// Every occurrence touching the days `from`...`to`, repeats expanded, in
    /// the calendars named (all of them for nil).
    func events(from: String, to: String, names: [String]?) async -> [String: Any] {
        guard let first = Self.day(from), let last = Self.day(to) else {
            return FolderFiles.failure("EINVAL", "from and to must be days, YYYY-MM-DD")
        }
        if let file {
            let all = Self.fromFile(file)["events"] as? [[String: Any]] ?? []
            return ["ok": all.filter { e in
                let start = String((e["start"] as? String ?? "").prefix(10))
                let end = String(((e["end"] as? String) ?? start).prefix(10))
                return start <= to && end >= from && (names == nil || names!.contains(e["calendar"] as? String ?? ""))
            }]
        }
        do {
            let store = try await access()
            let chosen = names.map { n in store.calendars(for: .event).filter { n.contains($0.title) } }
            if let chosen, chosen.isEmpty { return ["ok": [Any]()] }        // EventKit reads an empty list as every calendar
            let cal = Calendar.current
            let end = cal.date(byAdding: .day, value: 1, to: last) ?? last
            let found = store.events(matching: store.predicateForEvents(withStart: first, end: end, calendars: chosen))
            return ["ok": found.map { e in
                Self.row(uid: e.eventIdentifier ?? e.calendarItemIdentifier, title: e.title ?? "",
                         calendar: e.calendar?.title ?? "", color: Self.hex(e.calendar?.color),
                         allDay: e.isAllDay, start: e.startDate, end: e.endDate, in: cal)
            }]
        } catch {
            return FolderFiles.failure("EACCES", Self.refused)
        }
    }

    /// The store, once the person has allowed it. macOS asks the first time;
    /// after a refusal only System Settings can change it.
    private func access() async throws -> EKEventStore {
        if let store { return store }
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess:
            break
        case .notDetermined:
            guard try await EKEventStore().requestFullAccessToEvents() else { throw CocoaError(.userCancelled) }
        default:
            throw CocoaError(.userCancelled)
        }
        // a store made before the answer may not see the calendars the answer opened
        let made = EKEventStore()
        store = made
        return made
    }

    /// One occurrence as the page wants it (docs/BRIDGE.md): wall time here,
    /// and for an all-day event the days, the end being the day after the last
    /// as iCalendar has it. EventKit ends an all-day event at the last second of
    /// its last day.
    static func row(uid: String, title: String, calendar: String, color: String, allDay: Bool,
                    start: Date, end: Date, in cal: Calendar) -> [String: Any] {
        var row: [String: Any] = ["uid": uid, "title": title, "calendar": calendar, "color": color, "allDay": allDay]
        if allDay {
            let first = cal.startOfDay(for: start)
            var after = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: end.addingTimeInterval(-1))) ?? first
            if after <= first { after = cal.date(byAdding: .day, value: 1, to: first) ?? first }
            row["start"] = stamp(first, cal, time: false)
            row["end"] = stamp(after, cal, time: false)
        } else {
            row["start"] = stamp(start, cal, time: true)
            row["end"] = stamp(max(start, end), cal, time: true)
        }
        return row
    }

    private static func stamp(_ date: Date, _ cal: Calendar, time: Bool) -> String {
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let day = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
        return time ? day + String(format: "T%02d:%02d", c.hour ?? 0, c.minute ?? 0) : day
    }

    /// The start of a YYYY-MM-DD day, here.
    static func day(_ s: String) -> Date? {
        let p = s.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }

    static func hex(_ color: NSColor?) -> String {
        guard let c = color?.usingColorSpace(.sRGB) else { return "#8E8E93" }
        let v = { (x: CGFloat) in Int((max(0, min(1, x)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", v(c.redComponent), v(c.greenComponent), v(c.blueComponent))
    }

    private static func fromFile(_ url: URL) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any] ?? [:]
    }
}
