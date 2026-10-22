import SwiftUI

/// The pickers' own dark panel, in light mode too, as the web app draws it
/// (frontend/src/app.css .pop): its colours, and its icons' brighter ones.
enum Pop {
    static let background = Color(hex: 0x1E232C)
    static let text = Color(hex: 0xF2F2F7)
    static let muted = Color(hex: 0x98989D)
    static let selected = Color(hex: 0x6E8C58)
    static let accent = Color(hex: 0xA9C08F)
    static let field = Color(hex: 0x424850)
    static let rule = Color.white.opacity(0.1)
    static let hover = Color.white.opacity(0.12)
    static let star = Color(hex: 0xE8A944)
    static let upcoming = Color(hex: 0x8FA4BC)
    static let someday = Color(hex: 0xAAB66B)
    static let moon = Color(hex: 0x8E98D2)
    static let deadline = Color(hex: 0xEA5F57)
    static let width: CGFloat = 250
}

/// When, and Deadline, as the web app has them (WhenPopover.svelte): a field
/// that reads what is typed ("tom", "sat", "in 3 days", "wed 8pm"), the usual
/// choices with their dates, a month to pick a day in, and the reminder.
/// ↑ and ↓ choose, Return takes it.
struct WhenPicker: View {
    let model: AppModel
    let todo: Todo
    var deadline = false

    struct Option: Identifiable {
        let id: Int
        let label: String
        var right = ""
        let icon: SVGIcon?
        var colour: Color = Pop.muted
        var muted = false
        let fields: [String: Any]
    }

    @State private var query = ""
    @State private var suggestions: [Option] = []
    @State private var sel: Int?
    @State private var month = Date()
    @State private var reminding = false
    @State private var time = Date()
    @FocusState private var typing: Bool

    private var today: String { model.state.today }
    private var targets: [Todo] { model.chosen.contains(todo) ? model.chosen : [todo] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            field
            ForEach(options) { row($0) }
            if !query.trimmed.isEmpty && options.isEmpty {
                hint(suggestions.isEmpty ? "Keep typing…" : "No date in that")
            }
            if query.trimmed.isEmpty {
                rule
                MonthGrid(month: $month, today: today, picked: deadline ? todo.deadline : todo.when,
                          weekStartsOn: model.state.weekStartsOn) { pick($0) }
            }
            if !deadline && query.trimmed.isEmpty {
                rule
                reminder
                hint("Type “tom”, “sat”, “in 3 days”, “oct 2”, “wed 8pm”, “someday”")
            }
        }
        .padding(8)
        .frame(width: Pop.width)
        .onAppear {
            month = Dates.date((deadline ? todo.deadline : todo.when) ?? today) ?? Date()
            if let r = todo.reminder, let t = Self.clock.date(from: r) { time = t }
            DispatchQueue.main.async { typing = true }
        }
        .task(id: query) { await suggest() }
    }

    // ---- the field --------------------------------------------------------------------

    private var field: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 11, weight: .semibold)).foregroundStyle(Pop.muted)
            TextField(deadline ? "Deadline" : "When", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Pop.text)
                .focused($typing)
                .onSubmit { if let o = sel.flatMap({ i in options.first { $0.id == i } }) { apply(o.fields) } }
                .onKeyPress(.downArrow) { step(1); return .handled }
                .onKeyPress(.upArrow) { step(-1); return .handled }
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Pop.muted)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(Pop.field, in: RoundedRectangle(cornerRadius: 6))
        .padding(.bottom, 6)
    }

    private func step(_ d: Int) {
        guard !options.isEmpty else { return }
        let ids = options.map(\.id)
        let at = sel.flatMap { ids.firstIndex(of: $0) } ?? (d > 0 ? -1 : ids.count)
        sel = ids[max(0, min(ids.count - 1, at + d))]
    }

    // ---- the choices ------------------------------------------------------------------

    private var options: [Option] { query.trimmed.isEmpty ? statics : suggestions }

    private var statics: [Option] {
        let tomorrow = Dates.add(today, days: 1)
        let nextWeek = Dates.nextWeekStart(today, weekStartsOn: model.state.weekStartsOn)
        if deadline {
            var out = [
                Option(id: 0, label: "Today", right: Dates.weekdayShort(today), icon: Icons.flag, colour: Pop.deadline, fields: ["deadline": today]),
                Option(id: 1, label: "Tomorrow", right: Dates.dayShort(tomorrow), icon: Icons.upcoming, colour: Pop.upcoming, fields: ["deadline": tomorrow]),
                Option(id: 2, label: "Next week", right: Dates.dayShort(nextWeek), icon: Icons.upcoming, colour: Pop.upcoming, fields: ["deadline": nextWeek]),
            ]
            if todo.deadline != nil { out.append(Option(id: 3, label: "Remove Deadline", icon: nil, muted: true, fields: ["deadline": NSNull()])) }
            return out
        }
        var out = [
            Option(id: 0, label: "Today", right: Dates.weekdayShort(today), icon: Icons.sun, colour: Pop.star, fields: ["when": today, "evening": false, "someday": false]),
            Option(id: 1, label: "This Evening", icon: Icons.moon, colour: Pop.moon, fields: ["when": today, "evening": true, "someday": false]),
            Option(id: 2, label: "Tomorrow", right: Dates.dayShort(tomorrow), icon: Icons.upcoming, colour: Pop.upcoming, fields: ["when": tomorrow, "evening": false, "someday": false]),
            Option(id: 3, label: "Next week", right: Dates.dayShort(nextWeek), icon: Icons.upcoming, colour: Pop.upcoming, fields: ["when": nextWeek, "evening": false, "someday": false]),
            Option(id: 4, label: "Someday", icon: Icons.someday, colour: Pop.someday, fields: ["when": NSNull(), "evening": false, "someday": true]),
        ]
        if todo.when != nil || todo.someday {
            out.append(Option(id: 5, label: "Clear", right: "Anytime", icon: nil, muted: true, fields: ["when": NSNull(), "evening": false, "someday": false]))
        }
        return out
    }

    /// What the engine makes of the words (POST /api/parse-date), a moment after the last key.
    private func suggest() async {
        let q = query.trimmed
        guard !q.isEmpty else { suggestions = []; sel = nil; return }
        try? await Task.sleep(nanoseconds: 150_000_000)
        guard !Task.isCancelled, let j = try? await model.backend?.request("POST", "/api/parse-date", body: ["text": q]) else { return }
        var out: [Option] = []
        for (i, s) in j.array.enumerated() {
            let when = s["when"].string, evening = s["evening"].bool, someday = s["someday"].bool, at = s["reminder"].string
            if deadline && when == nil { continue }
            let (icon, colour): (SVGIcon, Color) =
                deadline ? (Icons.flag, Pop.deadline)
                : someday ? (Icons.someday, Pop.someday)
                : evening ? (Icons.moon, Pop.moon)
                : when == today ? (Icons.sun, Pop.star) : (Icons.upcoming, Pop.upcoming)
            var fields: [String: Any]
            if deadline { fields = ["deadline": when ?? NSNull()] }
            else {
                fields = ["when": when ?? NSNull(), "evening": evening, "someday": someday]
                if let at { fields["reminder"] = at }
            }
            let label = s["label"].string ?? (someday ? "Someday" : when.map { Dates.short($0, today: today) } ?? "Anytime")
            // the date, where the hint would only say the label again
            let hint = s["hint"].string ?? ""
            let right = !hint.isEmpty && hint != label ? hint : when.map { Dates.label($0) + (at.map { " · \($0)" } ?? "") } ?? ""
            out.append(Option(id: 100 + i, label: label, right: right, icon: icon, colour: colour, fields: fields))
        }
        suggestions = out
        sel = out.first?.id
    }

    private func row(_ o: Option) -> some View {
        Button { apply(o.fields) } label: {
            HStack(spacing: 8) {
                Group {
                    if let icon = o.icon { icon.drawn(o.colour) } else { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Pop.muted) }
                }
                .frame(width: 14, height: 14)
                Text(o.label).foregroundStyle(o.muted ? Pop.muted : Pop.text).lineLimit(1)
                Spacer(minLength: 4)
                if !o.right.isEmpty {
                    Text(o.right).font(.system(size: 12).monospacedDigit())
                        .foregroundStyle(sel == o.id ? Color.white.opacity(0.8) : Pop.muted)
                }
            }
            .font(.system(size: 13))
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(sel == o.id ? Pop.selected : .clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { inside in if inside { sel = o.id } else if query.trimmed.isEmpty, sel == o.id { sel = nil } }
    }

    // ---- the reminder -----------------------------------------------------------------

    @ViewBuilder private var reminder: some View {
        if reminding {
            HStack(spacing: 8) {
                Image(systemName: "bell").font(.system(size: 11)).foregroundStyle(Pop.muted).frame(width: 14)
                DatePicker("", selection: $time, displayedComponents: .hourAndMinute)
                    .labelsHidden()
                    .datePickerStyle(.field)
                Spacer()
                Button("Set") { setReminder(Self.clock.string(from: time)) }
                    .buttonStyle(.plain)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Pop.accent)
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            if todo.reminder != nil {
                plainRow("Remove Reminder", system: "xmark") { setReminder(nil) }
            }
        } else {
            plainRow(todo.reminder.map { "Reminder at \($0)" } ?? "Add Reminder", system: "bell") { reminding = true }
        }
    }

    private func plainRow(_ title: String, system: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: system).font(.system(size: 11)).frame(width: 14)
                Text(title)
                Spacer()
            }
            .font(.system(size: 13))
            .foregroundStyle(Pop.muted)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    static let clock: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()

    // ---- doing it ---------------------------------------------------------------------

    private var rule: some View { Pop.rule.frame(height: 1).padding(.vertical, 4) }

    private func hint(_ s: String) -> some View {
        Text(s).font(.system(size: 11)).foregroundStyle(Pop.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8).padding(.vertical, 4)
    }

    private func pick(_ iso: String) {
        apply(deadline ? ["deadline": iso] : ["when": iso, "evening": false, "someday": false])
    }

    private func apply(_ fields: [String: Any]) {
        let ts = targets
        let box = UncheckedBox(fields)
        Task {
            if deadline { await model.setDeadline(box.value["deadline"] as? String, for: ts) }
            else { await model.setWhen(fields: box.value, for: ts) }
        }
    }

    /// A reminder needs a day: one with none is for today.
    private func setReminder(_ at: String?) {
        var fields: [String: Any] = ["reminder": at ?? NSNull()]
        if at != nil && (todo.when == nil || todo.someday) { fields["when"] = today; fields["someday"] = false }
        let box = UncheckedBox(fields)
        let t = todo
        Task { await model.setWhen(fields: box.value, for: [t], label: at.map { "Reminder at \($0)" } ?? "Reminder removed") }
    }
}

/// A month, its days to pick, the week starting where the settings say.
struct MonthGrid: View {
    @Binding var month: Date
    let today: String
    let picked: String?
    let weekStartsOn: Int
    let pick: (String) -> Void

    private let cal = Calendar.current
    private let names = ["S", "M", "T", "W", "T", "F", "S"]

    var body: some View {
        VStack(spacing: 2) {
            HStack {
                arrow("chevron.left", -1)
                Spacer()
                Text(title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Pop.text)
                Spacer()
                arrow("chevron.right", 1)
            }
            .padding(.horizontal, 6).padding(.top, 4)
            let cols = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)
            LazyVGrid(columns: cols, spacing: 2) {
                ForEach(0..<7, id: \.self) { i in
                    Text(names[(weekStartsOn + i) % 7]).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Pop.text)
                }
                ForEach(Array(cells.enumerated()), id: \.offset) { _, iso in
                    if let iso { day(iso) } else { Color.clear.frame(height: 20) }
                }
            }
            .padding(.horizontal, 6).padding(.bottom, 2)
        }
    }

    private var title: String {
        let f = DateFormatter()
        f.dateFormat = "LLLL yyyy"
        return f.string(from: month)
    }

    /// Blanks, then the month's days, as ISO dates.
    private var cells: [String?] {
        guard let first = cal.date(from: cal.dateComponents([.year, .month], from: month)),
              let n = cal.range(of: .day, in: .month, for: first)?.count else { return [] }
        let lead = (cal.component(.weekday, from: first) - 1 - weekStartsOn + 7) % 7
        return Array(repeating: nil, count: lead) + (0..<n).map { Dates.iso.string(from: cal.date(byAdding: .day, value: $0, to: first)!) }
    }

    private func day(_ iso: String) -> some View {
        let n = Int(iso.suffix(2)) ?? 0
        let isToday = iso == today
        return Button { pick(iso) } label: {
            Text("\(n)")
                .font(.system(size: 11.5, weight: isToday ? .semibold : .regular).monospacedDigit())
                .foregroundStyle(iso < today ? Pop.muted : Pop.text)
                .frame(maxWidth: .infinity, minHeight: 20)
                .background(isToday ? Pop.selected : .clear, in: RoundedRectangle(cornerRadius: 5))
                .overlay { if picked == iso { RoundedRectangle(cornerRadius: 5).strokeBorder(Pop.text, lineWidth: 1.5) } }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func arrow(_ symbol: String, _ by: Int) -> some View {
        Button { month = cal.date(byAdding: .month, value: by, to: month) ?? month } label: {
            Image(systemName: symbol).font(.system(size: 10, weight: .semibold)).foregroundStyle(Pop.muted)
                .frame(width: 22, height: 20).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
