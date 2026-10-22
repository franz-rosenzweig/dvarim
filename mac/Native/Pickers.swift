import SwiftUI

/// The pickers a to-do's row or card shows: When, Deadline, Tags, Move.
struct Pickers: View {
    let model: AppModel
    let todo: Todo

    var body: some View {
        // The web app's dark panel, in light mode too, with Dvarim's sage
        // rather than the Mac's accent; the colours resolve as dark ones in it.
        picker
            .tint(Palette.accent)
            .presentationBackground(Pop.background)
            .preferredColorScheme(.dark)
    }

    @ViewBuilder private var picker: some View {
        switch model.popover {
        case .when: WhenPicker(model: model, todo: todo)
        case .deadline: WhenPicker(model: model, todo: todo, deadline: true)
        case .tags: TagsPicker(model: model, todo: todo)
        case .move: MovePicker(model: model, todo: todo)
        case .repeating: RepeatPicker(model: model, todo: todo)
        case .none: EmptyView()
        }
    }
}

struct PickerRow: View {
    let title: String
    let icon: String
    let colour: Color
    let action: () -> Void
    @State private var over = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                glyph.frame(width: 14, height: 14)
                Text(title).foregroundStyle(Pop.text).lineLimit(1)
                Spacer()
            }
            .font(.system(size: 13))
            .padding(.vertical, 6).padding(.horizontal, 8)
            .background(over ? Pop.selected : .clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { over = $0 }
    }

    /// The web app's marks for the lists; a system symbol for the rest.
    @ViewBuilder private var glyph: some View {
        switch icon {
        case "star.fill": Icons.sun.drawn(colour)
        case "moon.fill": Icons.moon.drawn(colour)
        case "archivebox.fill": Icons.someday.drawn(colour)
        case "tray.fill": Icons.inbox.drawn(colour)
        case "shippingbox": Icons.area.drawn(colour)
        case "circle": ProgressPie(progress: 0, size: 13, colour: colour)
        default: Image(systemName: icon).foregroundStyle(colour)
        }
    }
}

struct TagsPicker: View {
    let model: AppModel
    let todo: Todo
    @State private var tags: [String] = []
    @State private var new = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            TextField("New tag", text: $new)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    let t = new.trimmingCharacters(in: .whitespaces)
                    guard !t.isEmpty else { return }
                    if !tags.contains(t) { tags.append(t) }
                    new = ""
                    save()
                }
                .padding(.bottom, 6)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(all, id: \.self) { name in
                        Button {
                            if let i = tags.firstIndex(of: name) { tags.remove(at: i) } else { tags.append(name) }
                            save()
                        } label: {
                            HStack {
                                Image(systemName: tags.contains(name) ? "checkmark.square.fill" : "square")
                                    .foregroundStyle(tags.contains(name) ? Palette.accent : Palette.check)
                                Text(name).foregroundStyle(Palette.text)
                                Spacer()
                            }
                            .padding(.vertical, 4).padding(.horizontal, 4)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: 240)
        }
        .padding(10)
        .frame(width: 230)
        .onAppear { tags = todo.tags }
    }

    private var all: [String] {
        var out = model.state.tags
        for t in tags where !out.contains(t) { out.append(t) }
        return out
    }

    private func save() {
        let t = tags
        Task { await model.setTags(t, for: todo) }
    }
}

struct MovePicker: View {
    let model: AppModel
    let todo: Todo
    @State private var filter = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            TextField("Move to…", text: $filter).textFieldStyle(.roundedBorder).padding(.bottom, 6)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if shows("Inbox") {
                        PickerRow(title: "Inbox", icon: "tray.fill", colour: Palette.inbox) { go(.inbox, "Inbox") }
                    }
                    ForEach(model.state.looseProjects.filter { shows($0.name) }) { p in
                        PickerRow(title: p.name, icon: "circle", colour: Palette.accent) { go(.project(p.id), p.name) }
                    }
                    ForEach(model.state.areas) { a in
                        if shows(a.name) {
                            PickerRow(title: a.name, icon: "shippingbox", colour: Palette.text2) { go(.area(a.id), a.name) }
                        }
                        ForEach(a.projects.filter { shows($0.name) }) { p in
                            PickerRow(title: p.name, icon: "circle", colour: Palette.accent) { go(.project(p.id), p.name) }
                                .padding(.leading, 14)
                        }
                    }
                }
            }
            .frame(maxHeight: 320)
        }
        .padding(10)
        .frame(width: 260)
    }

    private func shows(_ name: String) -> Bool { filter.isEmpty || name.localizedCaseInsensitiveContains(filter) }
    private func go(_ d: AppModel.Destination, _ name: String) {
        Task { await model.move(to: d, for: model.chosen.contains(todo) ? model.chosen : [todo], named: name) }
    }
}

/// The Items menu, for the menu bar and for a row's right-click.
struct ItemsMenu: View {
    let model: AppModel
    var forRow: String? = nil

    var body: some View {
        Group {
            Button("Complete") { run { await $0.completeChosen() } }
            Button("Cancel") { run { await $0.cancelChosen() } }
            Divider()
            Button("When…") { pick { .when($0) } }
            Button("Today") { run { await $0.setWhen(.today) } }
            Button("This Evening") { run { await $0.setWhen(.evening) } }
            Button("Anytime") { run { await $0.setWhen(.anytime) } }
            Button("Someday") { run { await $0.setWhen(.someday) } }
            Divider()
            Button("Deadline…") { pick { .deadline($0) } }
            Button("Tags…") { pick { .tags($0) } }
            Button("Move…") { pick { .move($0) } }
            Button("Repeat…") { pick { .repeating($0) } }
            Button("Convert to Project") { run { await $0.convertChosen() } }
            Divider()
            Button("Duplicate") { run { await $0.duplicateChosen() } }
            Button("Move to Trash") { run { await $0.trashChosen() } }
        }
    }

    /// A right-click on a row that isn't chosen chooses it first, as Finder does.
    private func prepare() {
        if let row = forRow, !model.selected.contains(row) {
            model.selected = [row]
            model.anchor = row
        }
    }

    private func run(_ f: @escaping @MainActor (AppModel) async -> Void) {
        prepare()
        Task { await f(model) }
    }

    private func pick(_ p: @escaping (String) -> AppModel.Popover) {
        prepare()
        guard let t = model.chosen.first else { return }
        model.popover = p(t.id)
    }
}
