import SwiftUI

/// Today's own headings (Store.addTodayHeading): kept in the vault's state,
/// each holding some of the day's to-dos. Made with ⇧⌘N in Today, renamed
/// with a double-click, deleted from a right-click; a drag files a to-do
/// under one. Each is one ⌘Z.
@MainActor
extension AppModel {
    /// Today's headings, as the list shows them: id, name, to-dos.
    var todayHeadings: [(id: String, name: String, todos: [String])] {
        content.sections.filter { $0.id.hasPrefix("th:") }.map { s in
            (String(s.id.dropFirst(3)), s.title ?? "", s.rows.compactMap { if case .todo(let t) = $0 { t.id } else { nil } })
        }
    }

    /// The heading a to-do is under in Today, if any.
    func todayHeading(of id: String) -> String? { todayHeadings.first { $0.todos.contains(id) }?.id }

    func newTodayHeading() async {
        let id = "h" + Outbox.newId().prefix(7)     // the engine takes h and seven of 0-9a-z
        await act("New Heading", notice: nil,
                  do: { m in _ = try await m.ask("POST", "/api/today/headings", ["id": id, "name": "New Heading"]) },
                  undo: { m in _ = try await m.ask("DELETE", "/api/today/headings/\(id)") })
        await refresh()
        renamingHeading = "th:" + id
    }

    func renameTodayHeading(_ id: String, _ name: String) async {
        renamingHeading = nil
        guard let old = todayHeadings.first(where: { $0.id == id })?.name, old != name, !name.isEmpty else { return }
        await act("Rename Heading", notice: nil,
                  do: { m in _ = try await m.ask("PATCH", "/api/today/headings/\(id)", ["name": name]) },
                  undo: { m in _ = try await m.ask("PATCH", "/api/today/headings/\(id)", ["name": old]) })
    }

    /// A place up (-1) or down (1) among Today's headings.
    func moveTodayHeading(_ id: String, by d: Int) async {
        let before = todayHeadings.map(\.id)
        guard let i = before.firstIndex(of: id), before.indices.contains(i + d) else { return }
        var after = before
        after.swapAt(i, i + d)
        await act("Move Heading", notice: nil,
                  do: { m in _ = try await m.ask("POST", "/api/reorder", ["context": "today-headings", "ids": after]) },
                  undo: { m in _ = try await m.ask("POST", "/api/reorder", ["context": "today-headings", "ids": before]) })
    }

    /// Its to-dos stay in Today; ⌘Z makes it again where it was, with them under it.
    func deleteTodayHeading(_ id: String) async {
        let all = todayHeadings
        guard let i = all.firstIndex(where: { $0.id == id }) else { return }
        let h = all[i]
        let position: Any = i == 0 ? "top" : ["after": all[i - 1].id]
        let box = UncheckedBox(position)
        await act("Delete Heading", notice: "Deleted “\(h.name)”",
                  do: { m in _ = try await m.ask("DELETE", "/api/today/headings/\(id)") },
                  undo: { m in
                      _ = try await m.ask("POST", "/api/today/headings", ["id": id, "name": h.name, "position": box.value])
                      if !h.todos.isEmpty { _ = try await m.ask("POST", "/api/today/file", ["ids": h.todos, "headingId": id]) }
                  })
    }
}

/// One of Today's own headings, as a project's look (HeadingHeader).
struct TodayHeadingHeader: View {
    let model: AppModel
    let id: String
    let name: String
    let first: Bool
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var key: String { "th:" + id }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.renamingHeading == key {
                TextField("Heading", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13, weight: .semibold))
                    .focused($focused)
                    .onAppear { draft = name == "New Heading" ? "" : name; DispatchQueue.main.async { focused = true } }
                    .onSubmit { finish() }
                    .onExitCommand { model.renamingHeading = nil }
                    .onChange(of: focused) { _, f in if !f { finish() } }
            } else {
                Text(name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.accent)
                    .onTapGesture(count: 2) { model.renamingHeading = key }
            }
            Rectangle().fill(Palette.hair).frame(maxWidth: .infinity).frame(height: 1)
        }
        .padding(.top, first ? 14 : 28)
        .padding(.bottom, 4)
        .contentShape(Rectangle())
        .contextMenu {
            Button("Rename") { model.renamingHeading = key }
            let ids = model.todayHeadings.map(\.id)
            if ids.first != id { Button("Move Up") { Task { await model.moveTodayHeading(id, by: -1) } } }
            if ids.last != id { Button("Move Down") { Task { await model.moveTodayHeading(id, by: 1) } } }
            Divider()
            Button("Delete Heading") { Task { await model.deleteTodayHeading(id) } }
        }
    }

    private func finish() {
        guard model.renamingHeading == key else { return }
        let d = draft
        Task { await model.renameTodayHeading(id, d.isEmpty ? name : d) }
    }
}

/// The quiet word at the foot of Today, when a project has more than one
/// to-do in it: Today reads best as each project's next step.
struct CrowdedNote: View {
    let model: AppModel
    let crowded: [(id: String, name: String, count: Int)]

    var body: some View {
        Text(message)
            .font(.system(size: 13))
            .foregroundStyle(Palette.text2)
            .lineSpacing(3)
            .padding(.top, 20).padding(.horizontal, 12)
            .environment(\.openURL, OpenURLAction { url in
                if let id = url.host { model.place = .project(id) }
                return .handled
            })
    }

    /// The projects' names as links, each with its count.
    private var message: AttributedString {
        var out = AttributedString("More than one to-do from ")
        for (i, c) in crowded.enumerated() {
            if i > 0 { out += AttributedString(i == crowded.count - 1 ? " and " : ", ") }
            var link = AttributedString(c.name)
            link.link = URL(string: "dvarim-project://\(c.id)")
            link.underlineStyle = .single
            link.foregroundColor = Palette.text2
            out += link
            out += AttributedString(" (\(c.count))")
        }
        out += AttributedString(". One next step from each project keeps Today a list of what to do next.")
        return out
    }
}
