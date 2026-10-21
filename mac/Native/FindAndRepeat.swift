import SwiftUI

// MARK: - Quick Find

/// ⌘F: a field at the top of the window, and what matches as you type: lists,
/// areas, projects and to-dos. ↑ ↓ to choose, Return to go, Escape to close.
struct QuickFind: View {
    @Bindable var model: AppModel
    @State private var query = ""
    @State private var results: [AppModel.Found] = []
    @State private var chosen = 0
    @State private var asking: Task<Void, Never>?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Palette.text3)
                TextField("Quick Find", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 15))
                    .focused($focused)
                    .onSubmit { go() }
                    .onKeyPress(.upArrow) { chosen = max(0, chosen - 1); return .handled }
                    .onKeyPress(.downArrow) { chosen = min(results.count - 1, chosen + 1); return .handled }
                    .onExitCommand { model.finding = false }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            if !results.isEmpty {
                Rectangle().fill(Palette.hair).frame(height: 1)
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(Array(results.enumerated()), id: \.element.id) { i, f in
                                row(f)
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(i == chosen ? Palette.rowSelected : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                                    .contentShape(Rectangle())
                                    .onTapGesture { chosen = i; go() }
                                    .id(i)
                            }
                        }
                        .padding(6)
                    }
                    .frame(height: min(340, CGFloat(results.count) * 33 + 12))
                    .onChange(of: chosen) { _, c in proxy.scrollTo(c) }
                }
            }
        }
        .frame(width: 440)
        .tint(Palette.accent)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.hair, lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 30, y: 12)
        .padding(.top, 48)
        .onAppear { focused = true; ask("") }
        .onChange(of: query) { _, q in ask(q) }
    }

    @ViewBuilder private func row(_ f: AppModel.Found) -> some View {
        HStack(spacing: 8) {
            switch f.kind {
            case .list(let p): ListIcon(place: p, size: 15); Text(p.title)
            case .area(let a): ListIcon(place: .area(a.id), size: 15); Text(a.name)
            case .project(let p): ProgressPie(progress: p.progress, size: 14); Text(p.name)
            case .todo(let t):
                Image(systemName: t.isOpen ? "square" : "checkmark.square").foregroundStyle(Palette.text3)
                Text(t.title)
                if let p = t.projectName ?? t.areaName { Text(p).font(.system(size: 11.5)).foregroundStyle(Palette.text3) }
            }
            Spacer()
        }
        .font(.system(size: 13.5))
        .foregroundStyle(Palette.text)
    }

    private func ask(_ q: String) {
        asking?.cancel()
        asking = Task {
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled else { return }
            let found = await model.find(q)
            guard !Task.isCancelled else { return }
            results = found
            chosen = 0
        }
    }

    private func go() {
        guard results.indices.contains(chosen) else { return }
        let f = results[chosen]
        Task { await model.go(f) }
    }
}

// MARK: - Repeat

/// A to-do's repeat, in the words the engine reads (engine/src/repeat.js):
/// "every 2 weeks on Monday, Thursday", "every month on the last Friday when
/// done", "every day until 2026-12-31". The engine checks each rule and says
/// its next dates before anything is kept.
struct RepeatPicker: View {
    let model: AppModel
    let todo: Todo

    @State private var afterDone = false
    @State private var n = 1
    @State private var unit = "week"
    @State private var days: Set<String> = []
    @State private var monthKind = "day"        // day: the 15th; nth: the 2nd Tuesday
    @State private var monthDay = 1
    @State private var nth = "1"
    @State private var nthDay = "Monday"
    @State private var yearMonth = 1
    @State private var yearDay = 1
    @State private var ends = "never"
    @State private var endsOn = Date()
    @State private var endsAfter = 10
    @State private var preview: (ok: Bool, words: String, next: [String], error: String?) = (true, "", [], nil)
    @State private var checking: Task<Void, Never>?

    private static let dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    private static let monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("", selection: $afterDone) {
                Text("On a schedule").tag(false)
                Text("After completion").tag(true)
            }
            .pickerStyle(.segmented).labelsHidden()
            Text(afterDone ? "The next one is counted from the day you tick this one off." : "The next one comes on schedule, whether or not this one is done.")
                .font(.system(size: 11)).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 8) {
                GridRow {
                    Text("Every").foregroundStyle(Palette.text2)
                    HStack {
                        TextField("", value: $n, format: .number).frame(width: 44).textFieldStyle(.roundedBorder)
                        Picker("", selection: $unit) {
                            ForEach(["day", "week", "month", "year"], id: \.self) { Text(n > 1 ? $0 + "s" : $0).tag($0) }
                        }
                        .labelsHidden().frame(width: 100)
                    }
                }
                if unit == "week" {
                    GridRow {
                        Text("On").foregroundStyle(Palette.text2)
                        HStack(spacing: 3) {
                            ForEach(week, id: \.self) { d in
                                Button(String(d.prefix(2))) { if days.contains(d) { days.remove(d) } else { days.insert(d) } }
                                    .buttonStyle(.plain)
                                    .frame(width: 26, height: 24)
                                    .background(days.contains(d) ? Palette.accent : Palette.pill, in: RoundedRectangle(cornerRadius: 5))
                                    .foregroundStyle(days.contains(d) ? Color.white : Palette.text)
                            }
                        }
                    }
                } else if unit == "month" {
                    GridRow {
                        Text("On").foregroundStyle(Palette.text2)
                        HStack {
                            Text("the").foregroundStyle(Palette.text2)
                            Picker("", selection: Binding(get: { monthKind == "day" ? (monthDay == -1 ? "last" : String(monthDay)) : nth },
                                                          set: { v in if monthKind == "day" { monthDay = v == "last" ? -1 : Int(v) ?? 1 } else { nth = v } })) {
                                ForEach(ords, id: \.0) { Text($0.1).tag($0.0) }
                            }
                            .labelsHidden().frame(width: 76)
                            Picker("", selection: Binding(get: { monthKind == "day" ? "day" : nthDay }, set: setOfWhat)) {
                                Text("day").tag("day")
                                ForEach(Self.dayNames, id: \.self) { Text($0).tag($0) }
                            }
                            .labelsHidden().frame(width: 110)
                        }
                    }
                } else if unit == "year" {
                    GridRow {
                        Text("On").foregroundStyle(Palette.text2)
                        HStack {
                            Picker("", selection: $yearMonth) { ForEach(1...12, id: \.self) { Text(Self.monthNames[$0 - 1]).tag($0) } }.labelsHidden().frame(width: 110)
                            Picker("", selection: $yearDay) { ForEach(1...31, id: \.self) { Text("\($0)").tag($0) } }.labelsHidden().frame(width: 60)
                        }
                    }
                }
                GridRow {
                    Text("Ends").foregroundStyle(Palette.text2)
                    HStack {
                        Picker("", selection: $ends) { Text("never").tag("never"); Text("on").tag("on"); Text("after").tag("after") }
                            .labelsHidden().frame(width: 80)
                        if ends == "on" { DatePicker("", selection: $endsOn, displayedComponents: .date).labelsHidden() }
                        if ends == "after" {
                            TextField("", value: $endsAfter, format: .number).frame(width: 50).textFieldStyle(.roundedBorder)
                            Text("times").foregroundStyle(Palette.text2)
                        }
                    }
                }
            }
            Rectangle().fill(Palette.hair).frame(height: 1)
            Group {
                if let e = preview.error { Text(e).foregroundStyle(Palette.deadline) }
                else if !preview.next.isEmpty { Text("Next: " + preview.next.map { Dates.short($0, today: model.state.today) }.joined(separator: " · ")).foregroundStyle(Palette.text2) }
                else { Text(" ") }
            }
            .font(.system(size: 11.5))
            HStack {
                if todo.repeatRule != nil {
                    Button("Stop repeating") { Task { await model.setRepeat(nil, for: todo) } }.foregroundStyle(Palette.deadline)
                }
                Spacer()
                Button("Cancel") { model.popover = nil }
                Button(todo.repeatRule == nil ? "Repeat" : "Update") { Task { await model.setRepeat(rule, for: todo) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(preview.error != nil)
            }
        }
        .padding(14)
        .frame(width: 330)
        .onAppear { start() }
        .onChange(of: rule) { _, r in check(r) }
    }

    /// The week as Settings starts it.
    private var week: [String] { model.state.weekStartsOn == 1 ? Self.dayNames : [Self.dayNames[6]] + Self.dayNames.prefix(6) }

    private var ords: [(String, String)] {
        monthKind == "day"
            ? (1...31).map { (String($0), "\($0)\(suffix($0))") } + [("last", "last")]
            : ["1", "2", "3", "4"].map { ($0, "\($0)\(suffix(Int($0)!))") } + [("last", "last")]
    }

    private func setOfWhat(_ v: String) {
        if v == "day" {
            if monthKind == "nth" { monthDay = nth == "last" ? -1 : Int(nth) ?? 1 }
            monthKind = "day"
        } else {
            if monthKind == "day" { nth = monthDay == -1 || monthDay > 28 ? "last" : String(min(4, (monthDay + 6) / 7)) }
            monthKind = "nth"
            nthDay = v
        }
    }

    private func suffix(_ x: Int) -> String {
        if (11...13).contains(x % 100) { return "th" }
        return [1: "st", 2: "nd", 3: "rd"][x % 10] ?? "th"
    }

    /// The sentence the engine reads.
    var rule: String {
        var s = "every \(n > 1 ? "\(n) " : "")\(unit)\(n > 1 ? "s" : "")"
        if unit == "week", !days.isEmpty { s += " on " + Self.dayNames.filter(days.contains).joined(separator: ", ") }
        if unit == "month" {
            if monthKind == "nth" { s += " on the \(nth == "last" ? "last" : nth + suffix(Int(nth) ?? 1)) \(nthDay)" }
            else { s += monthDay == -1 ? " on the last" : " on the \(monthDay)\(suffix(monthDay))" }
        }
        if unit == "year" { s += " on \(Self.monthNames[yearMonth - 1]) \(yearDay)\(suffix(yearDay))" }
        if afterDone { s += " when done" }
        if ends == "on" { s += " until \(Dates.iso.string(from: endsOn))" }
        if ends == "after" { s += " for \(endsAfter) times" }
        return s
    }

    /// From the rule it has, or from its date.
    private func start() {
        let anchor = Dates.date(todo.when ?? todo.deadline ?? model.state.today) ?? Date()
        let cal = Calendar(identifier: .gregorian)
        let weekday = Self.dayNames[(cal.component(.weekday, from: anchor) + 5) % 7]
        days = [weekday]
        nthDay = weekday
        monthDay = cal.component(.day, from: anchor)
        yearMonth = cal.component(.month, from: anchor)
        yearDay = monthDay
        endsOn = cal.date(byAdding: .year, value: 1, to: anchor) ?? anchor
        if let r = todo.repeatRule?.lowercased() { load(r) }
        check(rule)
    }

    private func load(_ s: String) {
        afterDone = s.hasSuffix("when done") || s.contains(" when done")
        if let m = s.firstMatch(of: #/^every (?:(\d+)\s+)?(day|week|month|year)s?/#) {
            n = m.1.flatMap { Int($0) } ?? 1
            unit = String(m.2)
        } else if s.hasPrefix("every weekday") {
            unit = "week"; n = 1; days = Set(Self.dayNames.prefix(5))
        }
        if unit == "week" {
            let picked = Self.dayNames.filter { s.contains($0.lowercased()) }
            if !picked.isEmpty { days = Set(picked) }
        }
        if unit == "month" {
            if let m = s.firstMatch(of: #/the (first|second|third|fourth|last|\d)(?:st|nd|rd|th)? ([a-z]+day)/#) {
                monthKind = "nth"
                nth = ["first": "1", "second": "2", "third": "3", "fourth": "4", "last": "last"][String(m.1)] ?? String(m.1)
                nthDay = Self.dayNames.first { $0.lowercased() == m.2 } ?? nthDay
            } else if s.contains("on the last") {
                monthKind = "day"; monthDay = -1
            } else if let m = s.firstMatch(of: #/on the (\d{1,2})/#) {
                monthKind = "day"; monthDay = Int(m.1) ?? 1
            }
        }
        if let m = s.firstMatch(of: #/until (\d{4}-\d{2}-\d{2})/#), let d = Dates.date(String(m.1)) { ends = "on"; endsOn = d }
        else if let m = s.firstMatch(of: #/for (\d+) times?/#) { ends = "after"; endsAfter = Int(m.1) ?? 10 }
    }

    private func check(_ r: String) {
        checking?.cancel()
        checking = Task {
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            let p = await model.parseRepeat(r, from: todo.when)
            guard !Task.isCancelled else { return }
            preview = (p.ok, p.words, p.next, p.ok ? nil : (p.error ?? "That rule doesn't parse."))
        }
    }
}
