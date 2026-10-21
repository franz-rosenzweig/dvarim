import SwiftUI

/// A project's own menu: in the sidebar on a right-click, and from the … beside its title.
struct ProjectMenu: View {
    let model: AppModel
    let project: Project

    var body: some View {
        Group {
            Button("Complete Project") { Task { await model.completeProject(project) } }
            Button("Cancel Project") { Task { await model.cancelProject(project) } }
            Divider()
            Menu("When") {
                Button("Today") { Task { await model.setProjectWhen(project, .today) } }
                Button("Someday") { Task { await model.setProjectWhen(project, .someday) } }
                Button("Anytime") { Task { await model.setProjectWhen(project, .anytime) } }
            }
            Menu("Move to") {
                Button("No area") { Task { await model.moveProject(project, toArea: nil) } }
                ForEach(model.state.areas) { a in
                    Button(a.name) { Task { await model.moveProject(project, toArea: a) } }
                }
            }
            Divider()
            Button("Rename") { model.place = .project(project.id); model.renamingTitle = true }
            Button("New Heading") { Task { model.place = .project(project.id); await model.loadList(); await model.newHeading() } }
            Divider()
            Button("Delete Project") { Task { await model.deleteProject(project) } }
        }
    }
}

struct AreaMenu: View {
    let model: AppModel
    let area: Area

    var body: some View {
        Group {
            Button("Rename") { model.place = .area(area.id); model.renamingTitle = true }
            Button("New Project in \(area.name)") { Task { model.place = .area(area.id); await model.newProject() } }
            Divider()
            Button("Delete Area") { Task { await model.deleteArea(area) } }
        }
    }
}

/// A project's or an area's title, which a click (or Rename) turns into a field.
struct EditableTitle: View {
    let model: AppModel
    let name: String
    let save: (String) async -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        if model.renamingTitle {
            TextField("Name", text: $draft)
                .textFieldStyle(.plain)
                .focused($focused)
                .onAppear { draft = name == "New Project" || name == "New Area" ? "" : name; DispatchQueue.main.async { focused = true } }
                .onSubmit { finish() }
                .onExitCommand { model.renamingTitle = false }
                .onChange(of: focused) { _, f in if !f { finish() } }
        } else {
            Text(name).onTapGesture(count: 2) { model.renamingTitle = true }
        }
    }

    private func finish() {
        guard model.renamingTitle else { return }
        model.renamingTitle = false
        let d = draft
        Task { await save(d.isEmpty ? name : d) }
    }
}

/// Notes under a project's or an area's title, written in place.
struct EditableNotes: View {
    let text: String
    let save: (String) async -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField("Notes", text: $draft, axis: .vertical)
            .textFieldStyle(.plain)
            .font(.system(size: 13.5)).lineSpacing(3)
            .foregroundStyle(Palette.text2)
            .focused($focused)
            .frame(maxWidth: 520, alignment: .leading)
            .padding(.top, 2).padding(.bottom, 14)
            .onAppear { draft = text }
            .onChange(of: text) { _, t in if !focused { draft = t } }
            .onChange(of: focused) { _, f in if !f, draft != text { let d = draft; Task { await save(d) } } }
    }
}

/// A heading in a project: its name and rule, a right-click for its menu, and
/// a field in its place while it is renamed.
struct HeadingHeader: View {
    let model: AppModel
    let id: String
    let name: String
    let first: Bool
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.renamingHeading == id {
                TextField("Heading", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13, weight: .semibold))
                    .focused($focused)
                    .onAppear { draft = name.hasPrefix("New Heading") ? "" : name; DispatchQueue.main.async { focused = true } }
                    .onSubmit { finish() }
                    .onExitCommand { model.renamingHeading = nil }
                    .onChange(of: focused) { _, f in if !f { finish() } }
            } else {
                Text(name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.accent)
                    .onTapGesture(count: 2) { model.renamingHeading = id }
            }
            Rectangle().fill(Palette.hair).frame(maxWidth: .infinity).frame(height: 1)
        }
        .padding(.top, first ? 14 : 28)
        .padding(.bottom, 4)
        .contentShape(Rectangle())
        .contextMenu {
            Button("Rename") { model.renamingHeading = id }
            Button("Archive") { Task { await model.archiveHeading(id) } }
            Divider()
            Button("Delete Heading") { Task { await model.deleteHeading(id) } }
        }
    }

    private func finish() {
        guard model.renamingHeading == id else { return }
        let d = draft
        Task { await model.renameHeading(id, d.isEmpty ? name : d) }
    }
}
