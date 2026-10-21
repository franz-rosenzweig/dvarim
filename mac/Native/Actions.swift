import AppKit
import SwiftUI

/// What can be done to the to-dos in front: choosing them, opening one, and
/// every change the menus and the keyboard make. Each change is the request
/// the web app sends for it (frontend/src/lib/store.svelte.js), and each
/// registers its opposite for ⌘Z (AppModel.act).
@MainActor
extension AppModel {
    // ---- choosing ----------------------------------------------------------------------

    /// Every row in the list, in order, as the keyboard walks it.
    var rowIds: [String] { content.sections.flatMap { $0.rows.map(\.id) } }

    func todo(_ id: String) -> Todo? { content.allTodos.first { $0.id == id } }

    /// The chosen to-dos, in list order; with none chosen, the open one.
    var chosen: [Todo] {
        let picked = content.allTodos.filter { selected.contains("t:" + $0.id) }
        if !picked.isEmpty { return picked }
        return openId.flatMap(todo).map { [$0] } ?? []
    }

    /// A click: on its own, ⌘ to add or take away, ⇧ to reach from the anchor.
    func click(_ row: String, modifiers: NSEvent.ModifierFlags) {
        if modifiers.contains(.command) {
            if selected.contains(row) { selected.remove(row) } else { selected.insert(row) }
            anchor = row
        } else if modifiers.contains(.shift), let a = anchor, let i = rowIds.firstIndex(of: a), let j = rowIds.firstIndex(of: row) {
            selected = Set(rowIds[min(i, j)...max(i, j)])
        } else {
            selected = [row]
            anchor = row
        }
        if let open = openId, !selected.contains("t:" + open) { close() }
    }

    /// ↑ and ↓, with ⇧ to extend.
    func step(_ delta: Int, extend: Bool) {
        let ids = rowIds
        guard !ids.isEmpty else { return }
        let from = anchor.flatMap { ids.firstIndex(of: $0) } ?? (delta > 0 ? -1 : ids.count)
        let to = max(0, min(ids.count - 1, from + delta))
        let row = ids[to]
        if extend, let a = anchor ?? ids.first, let i = ids.firstIndex(of: a) {
            selected.formUnion(ids[min(i, to)...max(i, to)])
        } else {
            selected = [row]
        }
        anchor = row
        if openId != nil { close() }
    }

    /// ⌘A: every to-do in the list.
    func selectAll() {
        selected = Set(content.allTodos.map { "t:" + $0.id })
        anchor = rowIds.first
    }

    func selectOnly(_ todoId: String) {
        selected = ["t:" + todoId]
        anchor = "t:" + todoId
    }

    // ---- the card ----------------------------------------------------------------------

    func open(_ todoId: String, focusTitle: Bool = true) {
        popover = nil
        selectOnly(todoId)
        openId = todoId
        self.focusTitle = focusTitle
    }

    func close() {
        openId = nil
        newId = nil
        focusTitle = false
        popover = nil
    }

    /// The card's title and notes, as they are when it closes or pauses.
    func saveText(_ t: Todo, title: String, notes: String) async {
        let newTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "New To-Do" : title
        var to: [String: Any] = [:], from: [String: Any] = [:]
        if newTitle != t.title { to["title"] = newTitle; from["title"] = t.title }
        if notes != t.notes { to["notes"] = notes; from["notes"] = t.notes }
        guard !to.isEmpty else { return }
        await patch([t], name: "Typing", notice: nil) { _ in to } back: { _ in from }
    }

    // ---- new, duplicate, trash ----------------------------------------------------------

    /// ⌘N: a to-do where the list in front says, below the chosen one, open to type in.
    func newTodo() async {
        var body: [String: Any] = ["title": "New To-Do"]
        let sel = anchor.flatMap { $0.hasPrefix("t:") ? todo(String($0.dropFirst(2))) : nil }
        switch place {
        case .inbox, .logbook, .trash, .extra: body["inbox"] = true
        case .today: body["when"] = state.today
        case .upcoming: body["when"] = Dates.iso.string(from: Calendar.current.date(byAdding: .day, value: 1, to: Dates.date(state.today) ?? Date())!)
        case .someday: body["someday"] = true
        case .anytime:
            if let p = sel?.projectId { body["projectId"] = p; if let h = sel?.headingId { body["headingId"] = h } }
            else if let a = sel?.areaId { body["areaId"] = a }
        case .project(let id):
            body["projectId"] = id
            if let h = sel?.headingId { body["headingId"] = h }
        case .area(let id): body["areaId"] = id
        }
        if let sel, sel.isOpen, sameContainer(sel, body) { body["position"] = ["after": sel.id] } else { body["position"] = "bottom" }
        do {
            let j = try await ask("POST", "/api/todos", body)
            let made = Todo(j)
            register("New To-Do",
                     undo: { m in _ = try await m.ask("DELETE", "/api/todos/\(made.id)") },
                     redo: { m in _ = try await m.ask("POST", "/api/todos/\(made.id)/restore", [:]) })
            if place == .logbook || place == .trash { place = .inbox }
            await refresh()
            newId = made.id
            open(made.id)
        } catch { notice = error.localizedDescription }
    }

    private func sameContainer(_ t: Todo, _ body: [String: Any]) -> Bool {
        if let p = body["projectId"] as? String { return t.projectId == p && t.headingId == body["headingId"] as? String }
        if body["inbox"] as? Bool == true { return t.inbox }
        if let a = body["areaId"] as? String { return t.projectId == nil && t.areaId == a }
        return place == .today
    }

    func duplicateChosen() async {
        for t in chosen {
            do {
                let made = Todo(try await ask("POST", "/api/todos/\(t.id)/duplicate", [:]))
                register("Duplicate",
                         undo: { m in _ = try await m.ask("DELETE", "/api/todos/\(made.id)") },
                         redo: { m in _ = try await m.ask("POST", "/api/todos/\(made.id)/restore", [:]) })
                selectOnly(made.id)
                notice = "Duplicated"
            } catch { notice = error.localizedDescription }
        }
    }

    func trashChosen() async {
        let todos = chosen
        guard !todos.isEmpty else { return }
        let next = rowAfter(todos.map { "t:" + $0.id })
        close()
        await act("Move to Trash", notice: todos.count == 1 ? "Moved to Trash" : "Moved \(todos.count) to Trash",
                  do: { m in for t in todos { _ = try await m.ask("DELETE", "/api/todos/\(t.id)") } },
                  undo: { m in for t in todos { _ = try await m.ask("POST", "/api/todos/\(t.id)/restore", [:]) } })
        selected = next.map { [$0] } ?? []
        anchor = next
    }

    /// The row the keyboard lands on once these go.
    private func rowAfter(_ rows: [String]) -> String? {
        let ids = rowIds
        guard let last = rows.compactMap({ ids.firstIndex(of: $0) }).max() else { return nil }
        let rest = ids.enumerated().filter { !rows.contains($0.element) }
        return (rest.first { $0.offset > last } ?? rest.last { $0.offset < last })?.element
    }

    // ---- completing ---------------------------------------------------------------------

    func completeChosen() async {
        let todos = chosen
        guard !todos.isEmpty else { return }
        if todos.allSatisfy({ !$0.isOpen }) {
            for t in todos { await reopen(t) }
        } else {
            for t in todos where t.isOpen { await complete(t) }
        }
    }

    func cancelChosen() async {
        let todos = chosen.filter(\.isOpen)
        guard !todos.isEmpty else { return }
        await act("Cancel", notice: todos.count == 1 ? "Canceled “\(todos[0].title)”" : "Canceled \(todos.count)",
                  do: { m in for t in todos { _ = try await m.ask("POST", "/api/todos/\(t.id)/cancel", [:]) } },
                  undo: { m in for t in todos { _ = try await m.ask("POST", "/api/todos/\(t.id)/reopen", [:]) } })
    }

    // ---- when, deadline, tags, checklist ------------------------------------------------

    enum When { case today, evening, anytime, someday, date(String), clear }

    func setWhen(_ when: When, for todos: [Todo]? = nil) async {
        let todos = todos ?? chosen
        guard !todos.isEmpty else { return }
        let to: [String: Any]
        let label: String
        switch when {
        case .today: to = ["when": state.today, "evening": false, "someday": false]; label = "Moved to Today"
        case .evening: to = ["when": state.today, "evening": true, "someday": false]; label = "Moved to This Evening"
        case .anytime, .clear: to = ["when": NSNull(), "evening": false, "someday": false]; label = "Moved to Anytime"
        case .someday: to = ["when": NSNull(), "evening": false, "someday": true]; label = "Moved to Someday"
        case .date(let d): to = ["when": d, "evening": false, "someday": false]; label = "Moved to \(Dates.short(d, today: state.today))"
        }
        popover = nil
        await patch(todos, name: "When", notice: label) { _ in to } back: { t in
            ["when": t.when ?? NSNull(), "evening": t.evening, "someday": t.someday]
        }
    }

    func setDeadline(_ date: String?, for todos: [Todo]? = nil) async {
        let todos = todos ?? chosen
        guard !todos.isEmpty else { return }
        popover = nil
        await patch(todos, name: "Deadline", notice: date.map { "Deadline \(Dates.short($0, today: state.today))" } ?? "Deadline cleared") { _ in
            ["deadline": date ?? NSNull()]
        } back: { t in ["deadline": t.deadline ?? NSNull()] }
    }

    func setTags(_ tags: [String], for t: Todo) async {
        guard tags != t.tags else { return }
        await patch([t], name: "Tags", notice: nil) { _ in ["tags": tags] } back: { t in ["tags": t.tags] }
    }

    func setChecklist(_ items: [ChecklistItem], for t: Todo) async {
        guard items != t.checklist else { return }
        let plain = { (list: [ChecklistItem]) in list.map { ["text": $0.text, "done": $0.done] } }
        await patch([t], name: "Checklist", notice: nil) { _ in ["checklist": plain(items)] } back: { t in ["checklist": plain(t.checklist)] }
    }

    /// The to-do as the engine has it now, not as the list last drew it: what
    /// an undo puts back must be what was there, however quickly changes come.
    func current(_ t: Todo) async -> Todo {
        guard let j = try? await backend?.request("GET", "/api/todos/\(t.id)", body: nil), j["id"].string == t.id else { return t }
        return Todo(j)
    }

    /// PATCH each to-do; ⌘Z patches back what each had.
    func patch(_ todos: [Todo], name: String, notice: String?,
               to: @escaping (Todo) -> [String: Any], back: @escaping (Todo) -> [String: Any]) async {
        var pairs: [(String, UncheckedBox<[String: Any]>, UncheckedBox<[String: Any]>)] = []
        for t in todos {
            let now = await current(t)
            pairs.append((t.id, UncheckedBox(to(now)), UncheckedBox(back(now))))
        }
        await act(name, notice: notice,
                  do: { m in for (id, f, _) in pairs { _ = try await m.ask("PATCH", "/api/todos/\(id)", f.value) } },
                  undo: { m in for (id, _, b) in pairs { _ = try await m.ask("PATCH", "/api/todos/\(id)", b.value) } })
    }

    // ---- moving ---------------------------------------------------------------------------

    /// Where a to-do lives, as a body for POST /move (to undo a move).
    private func container(_ t: Todo) -> [String: Any] {
        if t.inbox { return ["inbox": true] }
        if let p = t.projectId { return t.headingId.map { ["projectId": p, "headingId": $0] } ?? ["projectId": p] }
        if let a = t.areaId { return ["areaId": a] }
        return ["standalone": true]
    }

    enum Destination: Hashable {
        case inbox, project(String), heading(project: String, heading: String), area(String)
        var body: [String: Any] {
            switch self {
            case .inbox: ["inbox": true]
            case .project(let p): ["projectId": p]
            case .heading(let p, let h): ["projectId": p, "headingId": h]
            case .area(let a): ["areaId": a]
            }
        }
    }

    func move(to dest: Destination, for todos: [Todo]? = nil, named name: String) async {
        let todos = todos ?? chosen
        guard !todos.isEmpty else { return }
        popover = nil
        var pairs: [(String, UncheckedBox<[String: Any]>)] = []
        for t in todos { pairs.append((t.id, UncheckedBox(container(await current(t))))) }
        let body = UncheckedBox(dest.body)
        await act("Move", notice: "Moved to \(name)",
                  do: { m in for (id, _) in pairs { _ = try await m.ask("POST", "/api/todos/\(id)/move", body.value) } },
                  undo: { m in for (id, back) in pairs { _ = try await m.ask("POST", "/api/todos/\(id)/move", back.value) } })
    }

    // ---- order -----------------------------------------------------------------------------

    /// ⌘↑ and ⌘↓: the chosen to-do a step along its section, kept with POST /reorder.
    func shift(_ delta: Int) async {
        guard let t = chosen.first, let section = content.sections.first(where: { $0.rows.contains { $0.id == "t:" + t.id } }),
              let context = reorderContext(section, t) else { return }
        let ids = section.rows.compactMap { if case .todo(let x) = $0 { x.id } else { nil } }
        guard let i = ids.firstIndex(of: t.id), ids.indices.contains(i + delta) else { return }
        var moved = ids
        moved.swapAt(i, i + delta)
        let before = ids, after = moved
        await act("Move", notice: nil,
                  do: { m in _ = try await m.ask("POST", "/api/reorder", ["context": context, "ids": after]) },
                  undo: { m in _ = try await m.ask("POST", "/api/reorder", ["context": context, "ids": before]) })
    }

    private func reorderContext(_ section: ListContent.Section, _ t: Todo) -> String? {
        switch place {
        case .today: "today"
        case .inbox: "inbox"
        case .someday: "someday"
        case .upcoming: "upcoming:\(section.id)"
        case .project: t.headingId.map { "heading:\($0)" } ?? t.projectId.map { "project:\($0)" }
        case .area(let id): "area:\(id)"
        default: nil
        }
    }

    /// ⇧⌘Y: the done ones go to the Logbook now.
    func logNow() async {
        do {
            _ = try await ask("POST", "/api/logbook/log-now", [:])
            notice = "Logged"
        } catch { notice = error.localizedDescription }
    }
}
