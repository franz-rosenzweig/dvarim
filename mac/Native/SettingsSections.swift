import SwiftUI

/// Dvarim's own settings, the engine's (store.js DEFAULT_SETTINGS), kept in
/// the vault and so the same on every device: the web app's Settings → General
/// sets the same ones.
struct DvarimSettings: View {
    let model: AppModel
    @State private var tourNote: String?

    var body: some View {
        Section("Dvarim") {
            Picker("Move completed to-dos to the Logbook", selection: setting("logCompleted", model.state.logCompleted)) {
                Text("Immediately").tag("immediately")
                Text("Daily").tag("daily")
                Text("Manually").tag("manually")
            }
            Picker("Week starts on", selection: setting("weekStartsOn", model.state.weekStartsOn)) {
                ForEach(0..<7, id: \.self) { d in Text(Self.days[d]).tag(d) }
            }
            Toggle("Group to-dos in Today by project or area", isOn: setting("groupTodayByList", model.state.groupTodayByList))
            HStack {
                Button("Show the tutorial again") {
                    Task {
                        tourNote = (try? await model.ask("POST", "/api/tutorial", [:])) != nil
                            ? "“Meet Dvarim” is back in your projects: every to-do in it is something to try." : "The tutorial couldn't be made."
                    }
                }
                Spacer()
            }
            if let tourNote { Text(tourNote).font(.caption).foregroundStyle(Color(nsColor: .secondaryLabelColor)) }
        }
    }

    /// As the engine numbers them, Sunday first.
    static let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    private func setting<T: Equatable>(_ key: String, _ value: T) -> Binding<T> {
        Binding(get: { value }, set: { v in
            guard v != value else { return }
            let box = UncheckedBox(v)
            Task { _ = try? await model.ask("PUT", "/api/settings", [key: box.value]) }
        })
    }
}

/// Calendars' events in Today and Upcoming: whether, and which. Where they
/// come from is the mode's: the server's calendars for a copy or Remote mode,
/// this Mac's for a folder, once turned on here (Calendars.swift).
struct CalendarSettings: View {
    let model: AppModel
    let mode: Mode
    @State private var found: [(name: String, color: String?)] = []
    @State private var configured = false
    @State private var problem: String?
    @State private var looking = true
    @State private var deviceOn = Calendars.deviceOn

    var body: some View {
        Section("Calendar") {
            Toggle("Show calendar events in Today and Upcoming", isOn: Binding(get: { model.state.showCalendarEvents }, set: { v in
                Task { _ = try? await model.ask("PUT", "/api/settings", ["showCalendarEvents": v]) }
            }))
            if mode == .folder {
                Toggle("Use this Mac's calendars", isOn: $deviceOn)
                    .onChange(of: deviceOn) { _, on in
                        Calendars.deviceOn = on
                        Task { await model.session.calendarsChanged(); await look() }
                    }
            }
            if looking {
                caption("Looking for calendars…")
            } else if configured && !found.isEmpty {
                HStack {
                    Text("Calendars")
                    Spacer()
                    Button("All") { choose(nil) }.disabled(model.state.calendars == nil)
                    Button("None") { choose([]) }.disabled(model.state.calendars == [])
                }
                ForEach(found, id: \.name) { c in
                    Toggle(isOn: Binding(get: { shows(c.name) }, set: { on in toggle(c.name, on) })) {
                        HStack(spacing: 7) {
                            Circle().fill(c.color.flatMap(Color.init(css:)) ?? Palette.text3).frame(width: 9, height: 9)
                            Text(c.name)
                        }
                    }
                }
            } else if let problem {
                caption(problem)
            } else if mode == .folder {
                caption(deviceOn ? "This Mac has no calendars with events." : "Turn on this Mac's calendars to see their events in Today and Upcoming. macOS asks first.")
            } else {
                caption("Your server reads no calendars. It shows CalDAV ones, set up on the server with DVARIM_CALDAV_URL, DVARIM_CALDAV_USER and DVARIM_CALDAV_PASS.")
            }
        }
        .task(id: mode) { await look() }
    }

    private func look() async {
        looking = true
        defer { looking = false }
        guard let j = try? await model.backend?.request("GET", "/api/calendars", body: nil) else {
            configured = false; found = []; problem = "The calendars couldn't be asked for."
            return
        }
        configured = j["configured"].bool
        problem = j["error"].string
        found = j["calendars"].array
            .filter { $0["components"].strings.isEmpty || $0["components"].strings.contains("VEVENT") }
            .compactMap { c in c["name"].string.map { ($0, c["color"].string) } }
    }

    private func shows(_ name: String) -> Bool { model.state.calendars.map { $0.contains(name) } ?? true }

    /// Every one ticked is all of them, which is nil, so a calendar added later shows too.
    private func toggle(_ name: String, _ on: Bool) {
        var set = model.state.calendars ?? found.map(\.name)
        if on { if !set.contains(name) { set.append(name) } } else { set.removeAll { $0 == name } }
        choose(found.allSatisfy { set.contains($0.name) } ? nil : set)
    }

    private func choose(_ names: [String]?) {
        let value: Any = names ?? NSNull()
        let box = UncheckedBox(value)
        Task { _ = try? await model.ask("PUT", "/api/settings", ["calendars": box.value]) }
    }

    private func caption(_ s: String) -> some View {
        Text(s).font(.caption).foregroundStyle(Color(nsColor: .secondaryLabelColor))
    }
}
