import AppKit
import EventKit

/// Where the engine's calendar events come from, on this Mac. The engine
/// decides what shows (Settings: show events, which calendars) and puts each
/// event on its day; this only answers its two questions (engine/src/api.js
/// services): which calendars there are, and the events between two days.
///
/// - The copy asks the server's calendars (its CalDAV), with the copy's own
///   token, as the web app's copy does (frontend backend.js mirrorEvents), and
///   keeps the days from yesterday to six weeks ahead here, for no network.
/// - A folder asks this Mac's calendars (EventKit), once they are turned on in
///   Settings: until then macOS is not asked, since its first answer is a
///   permission prompt that belongs after a click, not on opening the app.
@MainActor
enum Calendars {
    enum Source: String, Sendable { case server, device }

    static let deviceKey = "deviceCalendars"
    static var deviceOn: Bool {
        get { Prefs.store.bool(forKey: deviceKey) }
        set { Prefs.store.set(newValue, forKey: deviceKey) }
    }

    /// The self-test's events, rows as the server gives them, in place of any calendar.
    static var fixture: [[String: Any]]?

    static func answer(_ source: Source, op: String, args: [String: Any]) async -> Any {
        if let fixture { return fromFixture(fixture, op: op, args: args) }
        switch (source, op) {
        case (.server, "calendars"): return await serverCalendars()
        case (.server, "events"): return await serverEvents(from: args["from"] as? String ?? "", to: args["to"] as? String ?? "")
        case (.device, "calendars"): return await Device.shared.calendars()
        case (.device, "events"):
            return await Device.shared.events(from: args["from"] as? String ?? "", to: args["to"] as? String ?? "", names: args["calendars"] as? [String])
        default: return NSNull()
        }
    }

    // ---- the server's ------------------------------------------------------------------

    private static func serverRequest(_ path: String) async throws -> Any {
        guard let copy = Account.copy, let token = Account.token(for: copy),
              let url = URL(string: copy.server.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else {
            throw APIError(status: 0, message: "no copy")
        }
        var r = URLRequest(url: url, timeoutInterval: 4)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.httpShouldHandleCookies = false
        let (data, response) = try await URLSession.shared.data(for: r)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw APIError(status: status, message: "HTTP \(status)") }
        return try JSONSerialization.jsonObject(with: data)
    }

    private static func serverCalendars() async -> Any {
        do { return try await serverRequest("/api/calendars") }
        catch { return ["configured": false, "calendars": [Any](), "error": "The server can't be reached, so its calendars can't be listed."] }
    }

    /// The days kept: yesterday to six weeks ahead, each day's rows.
    private static var keptFile: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Account.appFolder, isDirectory: true).appendingPathComponent("events.json")
    }
    private static var lastAsked = Date.distantPast

    private static func serverEvents(from: String, to: String) async -> Any {
        var kept = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: keptFile))) as? [String: [[String: Any]]]) ?? [:]
        let days = Self.days(from, to)
        // asked again within two minutes, with every day here: no round trip
        if Date().timeIntervalSince(lastAsked) < 120, days.allSatisfy({ kept[$0] != nil }) {
            return days.flatMap { kept[$0] ?? [] }
        }
        do {
            let path = "/api/calendar?from_=\(from)&to=\(to)"
            guard let rows = try await serverRequest(path) as? [[String: Any]] else { throw APIError(status: 0, message: "no rows") }
            let today = Dates.iso.string(from: Date())
            let first = Dates.add(today, days: -1), last = Dates.add(today, days: 45)
            for d in days where d >= first && d <= last { kept[d] = rows.filter { $0["date"] as? String == d } }
            for d in kept.keys where d < first { kept[d] = nil }
            try? FileManager.default.createDirectory(at: keptFile.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? JSONSerialization.data(withJSONObject: kept).write(to: keptFile, options: .atomic)
            lastAsked = Date()
            return rows
        } catch {
            return days.flatMap { kept[$0] ?? [] }
        }
    }

    static func days(_ from: String, _ to: String) -> [String] {
        var out: [String] = []
        var d = from
        while d <= to && out.count < 400 { out.append(d); d = Dates.add(d, days: 1) }
        return out
    }

    private static func fromFixture(_ rows: [[String: Any]], op: String, args: [String: Any]) -> Any {
        if op == "calendars" {
            var seen = Set<String>()
            let cals = rows.compactMap { r -> [String: Any]? in
                guard let n = r["calendar"] as? String, seen.insert(n).inserted else { return nil }
                return ["name": n, "color": r["color"] ?? NSNull(), "components": ["VEVENT"]]
            }
            return ["configured": true, "calendars": cals]
        }
        let from = args["from"] as? String ?? "", to = args["to"] as? String ?? ""
        return rows.filter { ($0["date"] as? String ?? "") >= from && ($0["date"] as? String ?? "") <= to }
    }

    // ---- this Mac's ---------------------------------------------------------------------

    /// EventKit, as the web-view app's folder mode has it (mac/Dvarim/DeviceCalendars.swift):
    /// occurrences as docs/BRIDGE.md's `events` gives them, which the engine
    /// splits into its rows (events.js occurrenceRows).
    actor Device {
        static let shared = Device()
        static let refused = "Dvarim Native may not read your calendars. Allow it in System Settings → Privacy & Security → Calendars."
        private var store: EKEventStore?

        func calendars() async -> Any {
            guard await MainActor.run(body: { Calendars.deviceOn }) else {
                return ["configured": false, "source": "device", "offered": true, "calendars": [Any]()]
            }
            do {
                let store = try await access()
                var seen = Set<String>()
                let list = store.calendars(for: .event)
                    .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
                    .filter { seen.insert($0.title).inserted }
                    .map { ["name": $0.title, "color": Self.hex($0.color), "components": ["VEVENT"]] as [String: Any] }
                return ["configured": true, "source": "device", "calendars": list]
            } catch {
                return ["configured": true, "source": "device", "calendars": [Any](), "error": Self.refused]
            }
        }

        func events(from: String, to: String, names: [String]?) async -> Any {
            guard await MainActor.run(body: { Calendars.deviceOn }),
                  let first = Self.day(from), let last = Self.day(to), let store = try? await access() else { return [Any]() }
            let chosen = names.map { n in store.calendars(for: .event).filter { n.contains($0.title) } }
            if let chosen, chosen.isEmpty { return [Any]() }        // EventKit reads an empty list as every calendar
            let cal = Calendar.current
            let end = cal.date(byAdding: .day, value: 1, to: last) ?? last
            return store.events(matching: store.predicateForEvents(withStart: first, end: end, calendars: chosen)).map { e in
                Self.row(uid: e.eventIdentifier ?? e.calendarItemIdentifier, title: e.title ?? "",
                         calendar: e.calendar?.title ?? "", color: Self.hex(e.calendar?.color),
                         allDay: e.isAllDay, start: e.startDate, end: e.endDate, in: cal)
            }
        }

        /// macOS asks the first time; after a refusal only System Settings can change it.
        private func access() async throws -> EKEventStore {
            if let store { return store }
            switch EKEventStore.authorizationStatus(for: .event) {
            case .fullAccess: break
            case .notDetermined:
                guard try await EKEventStore().requestFullAccessToEvents() else { throw CocoaError(.userCancelled) }
            default: throw CocoaError(.userCancelled)
            }
            // a store made before the answer may not see what the answer opened
            let made = EKEventStore()
            store = made
            return made
        }

        /// Wall time here; an all-day event's days, ending the day after the
        /// last, as iCalendar has it (EventKit ends it at the last second).
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
    }
}
