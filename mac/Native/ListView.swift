import AppKit
import SwiftUI

// The list in front, drawn the way the web app draws it (frontend/src/app.css):
// a column at most 640 points wide, centred, 48 points in from the window's
// sides; the title at 26 points; rows 6 by 8 points round a 16-point box. It
// is a column of our own rather than a system List, so the card can open in
// place and the margins are the web app's, not the system's.

struct ListScreen: View {
    @Bindable var model: AppModel
    @FocusState private var listFocused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ListTitle(model: model)
                    if !model.content.notes.isEmpty {
                        Text(model.content.notes)
                            .font(.system(size: 13.5)).lineSpacing(3)
                            .foregroundStyle(Palette.text2)
                            .padding(.top, 2).padding(.bottom, 14)
                            .frame(maxWidth: 520, alignment: .leading)
                    }
                    ForEach(Array(model.content.sections.enumerated()), id: \.element.id) { index, section in
                        if let title = section.title {
                            SectionHeader(place: model.place, section: section, title: title, first: index == 0 || model.content.sections[..<index].allSatisfy { $0.rows.isEmpty && $0.title == nil })
                        }
                        ForEach(Array(section.rows.enumerated()), id: \.element.id) { i, row in
                            switch row {
                            case .todo(let t):
                                if model.openId == t.id {
                                    TodoCard(model: model, todo: t, first: index == 0 && i == 0 && section.title == nil)
                                        .id(row.id)
                                } else {
                                    TodoRow(model: model, todo: t).id(row.id)
                                }
                            case .project(let p):
                                ProjectRow(model: model, project: p).id(row.id)
                            }
                        }
                    }
                    if model.content.sections.allSatisfy({ $0.rows.isEmpty }) && !model.loading {
                        Text(model.place == .today ? "Nothing for today." : "Nothing here.")
                            .foregroundStyle(Palette.text3)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 60)
                    }
                }
                .frame(maxWidth: Metrics.column, alignment: .leading)
                .padding(.horizontal, Metrics.sideMargin)
                .padding(.top, Metrics.topMargin)
                .padding(.bottom, Metrics.bottomMargin)
                .frame(maxWidth: .infinity)
            }
            .background(Palette.main)
            .contentShape(Rectangle())
            .onTapGesture {
                // a click on nothing: nothing chosen, and any card closed
                model.selected = []
                model.close()
                listFocused = true
            }
            .focusable()
            .focused($listFocused)
            .focusEffectDisabled()
            .onKeyPress(phases: .down) { press in keys(press) }
            .onChange(of: model.anchor) { _, a in if let a { withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(a) } } }
            .onChange(of: model.openId) { _, id in if id == nil { listFocused = true } }
            .onAppear { listFocused = true }
        }
        .overlay(alignment: .bottom) { Notice(model: model) }
        .toolbar { ToolbarItem(placement: .automatic) { SyncBadge(sync: model.sync) } }
        .navigationTitle("")
    }

    /// The list's own keys, while no field has the keyboard.
    private func keys(_ press: KeyPress) -> KeyPress.Result {
        let shift = press.modifiers.contains(.shift), command = press.modifiers.contains(.command)
        switch press.key {
        case .upArrow:
            if command { Task { await model.shift(-1) } } else { model.step(-1, extend: shift) }
            return .handled
        case .downArrow:
            if command { Task { await model.shift(1) } } else { model.step(1, extend: shift) }
            return .handled
        case .return, .space:
            guard let a = model.anchor, a.hasPrefix("t:") else { return .ignored }
            model.open(String(a.dropFirst(2)))
            return .handled
        case .delete, .deleteForward:
            guard !model.chosen.isEmpty else { return .ignored }
            Task { await model.trashChosen() }
            return .handled
        case .escape:
            if model.openId != nil { model.close() } else { model.selected = [] }
            return .handled
        default:
            return .ignored
        }
    }
}

struct ListTitle: View {
    let model: AppModel
    var body: some View {
        HStack(spacing: 10) {
            switch model.place {
            case .project(let id):
                ProgressPie(progress: model.state.project(id)?.progress ?? 0, size: 24)
                Text(model.state.project(id)?.name ?? "")
            case .area(let id):
                ListIcon(place: model.place, size: 24)
                Text(model.state.area(id)?.name ?? "")
            default:
                ListIcon(place: model.place, size: 24)
                Text(model.place.title)
            }
        }
        .font(.system(size: Metrics.titleSize, weight: .bold))
        .foregroundStyle(Palette.text)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }
}

/// A section's heading, as each list has its own: Upcoming's day set large
/// beside its rule, This Evening with its moon, a project's group with its pie.
struct SectionHeader: View {
    let place: Place
    let section: ListContent.Section
    let title: String
    let first: Bool

    var body: some View {
        switch place {
        case .upcoming:
            HStack(alignment: .top, spacing: 7) {
                Text(dayNumber).font(.system(size: 24, weight: .bold)).monospacedDigit().foregroundStyle(Palette.text)
                VStack(alignment: .leading, spacing: 0) {
                    Rectangle().fill(Palette.hair).frame(height: 1).padding(.top, 3)
                    Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.text2).padding(.top, 8)
                }
            }
            .padding(.top, first ? 22 : 56)
            .padding(.bottom, 8)
        case .today where section.id == "evening":
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "moon.fill").foregroundStyle(Palette.moon)
                    Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.text)
                }
                Rectangle().fill(Palette.hair).frame(maxWidth: .infinity).frame(height: 1)
            }
            .padding(.top, 34)
            .padding(.bottom, 4)
        default:
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 7) {
                    if place == .anytime { ProgressPie(progress: 0, size: 14) }
                    Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(place == .anytime ? Palette.text2 : Palette.text)
                    if let s = section.subtitle { Text(s).font(.system(size: 12)).foregroundStyle(Palette.text3) }
                }
                Rectangle().fill(Palette.hair).frame(maxWidth: .infinity).frame(height: 1)
            }
            .padding(.top, first ? 14 : 28)
            .padding(.bottom, 4)
        }
    }

    private var dayNumber: String {
        guard let d = Dates.date(section.id) else { return "" }
        return String(Calendar.current.component(.day, from: d))
    }
}

// MARK: - a row

struct TodoRow: View {
    let model: AppModel
    let todo: Todo
    private var row: String { "t:" + todo.id }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            CheckBox(done: !todo.isOpen, canceled: todo.status == "canceled") { Task { await model.toggle(todo) } }
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    if todo.evening && model.place != .today && todo.isOpen {
                        Image(systemName: "moon.fill").font(.system(size: 11)).foregroundStyle(Palette.moon)
                    }
                    Text(todo.title.isEmpty ? "New To-Do" : todo.title)
                        .font(.system(size: Metrics.rowFont))
                        .foregroundStyle(todo.isOpen ? Palette.text : Palette.text3)
                        .strikethrough(todo.status == "canceled", color: Palette.text3)
                        .lineLimit(1)
                    Marks(todo: todo)
                    ForEach(todo.tags, id: \.self) { TagChip(name: $0) }
                }
                if let context = contextLine {
                    Text(context).font(.system(size: Metrics.subFont)).foregroundStyle(Palette.text3)
                }
            }
            Spacer(minLength: 8)
            if let when = whenLabel { WhenPill(text: when) }
            if let d = todo.deadline, todo.isOpen {
                HStack(spacing: 4) {
                    Image(systemName: "flag.fill").font(.system(size: 10))
                    Text(Dates.deadline(d, today: model.state.today))
                }
                .font(.system(size: 12))
                .foregroundStyle(d <= model.state.today ? Palette.deadline : Palette.text2)
                .padding(.top, 1)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(model.selected.contains(row) ? Palette.rowSelected : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, -8)
        .contentShape(Rectangle())
        .onTapGesture { Clicks.click(row, model: model) { model.open(todo.id) } }
        .contextMenu { ItemsMenu(model: model, forRow: row) }
        .popover(isPresented: model.popoverBinding(for: todo.id, card: false), arrowEdge: .bottom) {
            Pickers(model: model, todo: todo)
        }
    }

    private var contextLine: String? {
        switch model.place {
        case .today, .upcoming, .anytime, .someday, .logbook, .trash, .inbox:
            if model.place == .anytime && (todo.projectId != nil || todo.areaId != nil) { return nil }
            return todo.projectName ?? todo.areaName
        default:
            return nil
        }
    }

    private var whenLabel: String? {
        guard let w = todo.when, todo.isOpen else { return nil }
        switch model.place {
        case .today, .upcoming: return nil
        default: return w <= model.state.today ? "Today" : Dates.short(w, today: model.state.today)
        }
    }
}

/// A single click chooses (⌘ and ⇧ as everywhere on the Mac); a second on the
/// same row within the double-click interval opens it. Done by hand so the
/// first click needn't wait to see if a second comes.
@MainActor
enum Clicks {
    private static var last: (row: String, at: Date)?
    static func click(_ row: String, model: AppModel, open: () -> Void) {
        let flags = NSEvent.modifierFlags.intersection([.command, .shift])
        if flags.isEmpty, let l = last, l.row == row, Date().timeIntervalSince(l.at) < NSEvent.doubleClickInterval {
            last = nil
            open()
            return
        }
        last = (row, Date())
        model.click(row, modifiers: flags)
    }
}

/// The small marks after a title: notes, a checklist, a repeat.
struct Marks: View {
    let todo: Todo
    var body: some View {
        HStack(spacing: 5) {
            if !todo.notes.isEmpty { mark("doc.text") }
            if !todo.checklist.isEmpty { mark("list.bullet") }
            if todo.repeatRule != nil { mark("repeat") }
        }
    }
    private func mark(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 10.5)).foregroundStyle(Palette.text3)
    }
}

struct WhenPill: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 11)).monospacedDigit()
            .foregroundStyle(Palette.text2)
            .padding(.horizontal, 6)
            .frame(height: 17)
            .background(Palette.pill, in: RoundedRectangle(cornerRadius: 5))
            .padding(.top, 1)
    }
}

struct ProjectRow: View {
    let model: AppModel
    let project: Project
    private var row: String { "p:" + project.id }

    var body: some View {
        HStack(spacing: 10) {
            ProgressPie(progress: project.progress, size: 16)
            Text(project.name.isEmpty ? "New Project" : project.name)
                .font(.system(size: Metrics.rowFont, weight: .semibold))
                .foregroundStyle(Palette.text)
            Spacer()
            if let d = project.deadline {
                HStack(spacing: 4) {
                    Image(systemName: "flag.fill").font(.system(size: 10))
                    Text(Dates.deadline(d, today: model.state.today))
                }
                .font(.system(size: 12)).foregroundStyle(d <= model.state.today ? Palette.deadline : Palette.text2)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(model.selected.contains(row) ? Palette.rowSelected : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, -8)
        .contentShape(Rectangle())
        .onTapGesture { Clicks.click(row, model: model) { model.place = .project(project.id) } }
    }
}

struct CheckBox: View {
    let done: Bool
    var canceled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                RoundedRectangle(cornerRadius: 4)
                    .fill(done ? (canceled ? Palette.text3 : Palette.accent) : Color.clear)
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(done ? (canceled ? Palette.text3 : Palette.accent) : Palette.check, lineWidth: 1.5)
                if done {
                    Image(systemName: canceled ? "xmark" : "checkmark").font(.system(size: 9.5, weight: .bold)).foregroundStyle(Color.white)
                }
            }
            .frame(width: Metrics.box, height: Metrics.box)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(done ? "Reopen" : "Complete")
    }
}

struct TagChip: View {
    let name: String
    var body: some View {
        Text(name)
            .font(.system(size: 11))
            .foregroundStyle(Palette.text2)
            .padding(.horizontal, 7)
            .frame(height: 16)
            .overlay(Capsule().strokeBorder(Palette.check, lineWidth: 1))
    }
}

/// What was just done, with Undo, at the foot of the window.
struct Notice: View {
    @Bindable var model: AppModel
    @State private var hide: Task<Void, Never>?

    var body: some View {
        if let text = model.notice {
            HStack(spacing: 12) {
                Text(text).lineLimit(1)
                if model.undoManager?.canUndo == true {
                    Button("Undo") { model.undoManager?.undo(); model.notice = nil }.buttonStyle(.borderless)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .glassEffect(.regular, in: Capsule())
            .padding(.bottom, 14)
            .onAppear { schedule() }
            .onChange(of: text) { _, _ in schedule() }
        }
    }

    private func schedule() {
        hide?.cancel()
        hide = Task { try? await Task.sleep(nanoseconds: 4_000_000_000); if !Task.isCancelled { model.notice = nil } }
    }
}

// MARK: - the card

/// A to-do opened in place: its title and notes to type in, its checklist and
/// tags, and along the foot its When and its deadline, with the buttons that
/// set them. What is typed is kept when the card closes.
struct TodoCard: View {
    let model: AppModel
    let todo: Todo
    let first: Bool

    @State private var title: String
    @State private var notes: String
    @State private var checklist: [ChecklistItem]
    @FocusState private var focus: Field?

    enum Field: Hashable { case title, notes, item(Int) }

    init(model: AppModel, todo: Todo, first: Bool) {
        self.model = model
        self.todo = todo
        self.first = first
        _title = State(initialValue: model.newId == todo.id && todo.title == "New To-Do" ? "" : todo.title)
        _notes = State(initialValue: todo.notes)
        _checklist = State(initialValue: todo.checklist)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                CheckBox(done: !todo.isOpen, canceled: todo.status == "canceled") { Task { save(); await model.toggle(todo) } }
                    .padding(.top, 2)
                TextField("New To-Do", text: $title)
                    .textFieldStyle(.plain)
                    .font(.system(size: Metrics.rowFont))
                    .foregroundStyle(Palette.text)
                    .focused($focus, equals: .title)
                    .onSubmit { focus = .notes }
            }
            TextField("Notes", text: $notes, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 13.5))
                .lineSpacing(3)
                .lineLimit(3...)
                .foregroundStyle(Palette.text)
                .focused($focus, equals: .notes)
                .padding(.leading, 26)
                .padding(.top, 8)
                .padding(.bottom, 6)
            if !checklist.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(checklist.indices), id: \.self) { i in checklistRow(i) }
                }
                .padding(.leading, 26)
                .padding(.vertical, 4)
            }
            if !todo.tags.isEmpty {
                HStack(spacing: 5) { ForEach(todo.tags, id: \.self) { TagChip(name: $0) } }
                    .padding(.leading, 26).padding(.vertical, 4)
            }
            HStack(spacing: 8) {
                whenChip
                if let d = todo.deadline {
                    Button { model.popover = .deadline(todo.id) } label: {
                        HStack(spacing: 4) { Image(systemName: "flag.fill"); Text("Deadline: \(Dates.short(d, today: model.state.today))") }
                            .font(.system(size: 12)).foregroundStyle(d <= model.state.today ? Palette.deadline : Palette.text2)
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                barButton("tag", "Tags") { model.popover = .tags(todo.id) }
                barButton("list.bullet", "Checklist") { addItem(after: checklist.count - 1) }
                barButton("flag", "Deadline") { model.popover = .deadline(todo.id) }
            }
            .padding(.leading, 26)
            .padding(.top, 8)
            .popover(isPresented: model.popoverBinding(for: todo.id, card: true), arrowEdge: .bottom) {
                Pickers(model: model, todo: todo)
            }
        }
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 12, trailing: 16))
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.hair2, lineWidth: 1))
        .shadow(color: .black.opacity(0.14), radius: 12, y: 6)
        .shadow(color: .black.opacity(0.08), radius: 1.5, y: 1)
        .padding(.horizontal, -16)
        .padding(.top, first ? 8 : 30)
        .padding(.bottom, 44)
        .onExitCommand { model.close() }
        .onAppear {
            if model.focusTitle { DispatchQueue.main.async { focus = .title } }
        }
        .onDisappear { save() }
        .onTapGesture { }                    // a click inside the card is not a click on the list
    }

    private var whenChip: some View {
        Button { model.popover = .when(todo.id) } label: {
            HStack(spacing: 5) {
                switch whenKind {
                case .today: Image(systemName: "star.fill").foregroundStyle(Palette.star); Text("Today")
                case .evening: Image(systemName: "moon.fill").foregroundStyle(Palette.moon); Text("This Evening")
                case .someday: Image(systemName: "archivebox.fill").foregroundStyle(Palette.someday); Text("Someday")
                case .date(let d): Image(systemName: "calendar").foregroundStyle(Palette.upcoming); Text(Dates.short(d, today: model.state.today))
                case .none: Image(systemName: "calendar").foregroundStyle(Palette.text3); Text("When").foregroundStyle(Palette.text3)
                }
            }
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundStyle(Palette.text)
        }
        .buttonStyle(.plain)
    }

    private enum WhenKind { case today, evening, someday, date(String), none }
    private var whenKind: WhenKind {
        if todo.someday { return .someday }
        guard let w = todo.when else { return .none }
        if w <= model.state.today { return todo.evening ? .evening : .today }
        return .date(w)
    }

    private func barButton(_ icon: String, _ help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).font(.system(size: 13)).foregroundStyle(Palette.text3).frame(width: 22, height: 20) }
            .buttonStyle(.plain)
            .help(help)
    }

    private func checklistRow(_ i: Int) -> some View {
        HStack(spacing: 8) {
            Button {
                checklist[i].done.toggle()
                Task { await model.setChecklist(checklist, for: todo) }
            } label: {
                ZStack {
                    Circle().strokeBorder(checklist[i].done ? Palette.accent : Palette.check, lineWidth: 1.3)
                    if checklist[i].done { Image(systemName: "checkmark").font(.system(size: 7, weight: .bold)).foregroundStyle(Palette.accent) }
                }
                .frame(width: 12, height: 12)
            }
            .buttonStyle(.plain)
            TextField("", text: Binding(get: { checklist.indices.contains(i) ? checklist[i].text : "" },
                                        set: { if checklist.indices.contains(i) { checklist[i].text = $0 } }))
                .textFieldStyle(.plain)
                .font(.system(size: 13.5))
                .foregroundStyle(checklist[i].done ? Palette.text3 : Palette.text)
                .focused($focus, equals: .item(i))
                .onSubmit {
                    if checklist[i].text.trimmingCharacters(in: .whitespaces).isEmpty {
                        checklist.remove(at: i)
                        focus = .notes
                    } else {
                        addItem(after: i)
                    }
                }
        }
        .padding(.vertical, 2)
    }

    private func addItem(after i: Int) {
        let at = min(max(i + 1, 0), checklist.count)
        checklist.insert(ChecklistItem(text: "", done: false), at: at)
        DispatchQueue.main.async { focus = .item(at) }
    }

    /// What was typed, kept: the title and notes, and the checklist without its empty items.
    private func save() {
        let items = checklist.filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
        let t = todo, title = title, notes = notes
        Task {
            await model.saveText(t, title: title, notes: notes)
            if items != t.checklist { await model.setChecklist(items, for: t) }
        }
    }
}

extension AppModel {
    /// The picker for this to-do, shown from its row, or from its card while it is open.
    func popoverBinding(for id: String, card: Bool) -> Binding<Bool> {
        Binding(get: { [weak self] in
            guard let self, let p = self.popover, p.todoId == id else { return false }
            return (self.openId == id) == card
        }, set: { [weak self] shown in
            if !shown, self?.popover?.todoId == id { self?.popover = nil }
        })
    }
}
