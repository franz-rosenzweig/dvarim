import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Where a drag would land: before or after a row, into a section (a day in
/// Upcoming, This Evening, a heading), or onto a list in the sidebar.
enum DropTarget: Equatable {
    case row(String, after: Bool)
    case section(String)
    case place(Place)
}

/// Dragging to-dos: in a list to put them in order, into a section to change
/// what it is about them (the day, the evening, the heading), and onto the
/// sidebar to move them there. The drag carries only a marker; what is
/// dragged is the window's own (AppModel.dragging), since nothing leaves the app.
@MainActor
extension AppModel {
    static let dragType = UTType.plainText

    /// A drag begins on a row: it carries the chosen ones if the row is one of them.
    func beginDrag(_ todo: Todo) -> NSItemProvider {
        let row = "t:" + todo.id
        let ids = selected.contains(row)
            ? content.allTodos.filter { selected.contains("t:" + $0.id) }.map(\.id)
            : [todo.id]
        dragging = ids
        if !selected.contains(row) { selectOnly(todo.id) }
        return NSItemProvider(object: "dvarim-todos:\(ids.joined(separator: ","))" as NSString)
    }

    var draggedTodos: [Todo] { dragging.compactMap(todo) }

    func endDrag() {
        dragging = []
        dropTarget = nil
    }

    // ---- in the list ------------------------------------------------------------------

    /// Dropped beside a row: into that row's section, in that place.
    func drop(beside row: String, after: Bool) async {
        defer { endDrag() }
        let moving = draggedTodos
        guard !moving.isEmpty, let section = content.sections.first(where: { $0.rows.contains { $0.id == row } }) else { return }
        let ids = moving.map(\.id)
        let order = section.rows.compactMap { if case .todo(let t) = $0 { t.id } else { nil } }
        var rest = order.filter { !ids.contains($0) }
        let anchorId = String(row.dropFirst(2))
        if let at = rest.firstIndex(of: anchorId) { rest.insert(contentsOf: ids, at: after ? at + 1 : at) }
        else { rest.append(contentsOf: ids) }
        await place(moving, into: section, order: rest)
    }

    /// Dropped on a section's heading: at the top of it.
    func drop(onSection id: String) async {
        defer { endDrag() }
        let moving = draggedTodos
        guard !moving.isEmpty, let section = content.sections.first(where: { $0.id == id }) else { return }
        let ids = moving.map(\.id)
        let order = section.rows.compactMap { if case .todo(let t) = $0 { t.id } else { nil } }
        await place(moving, into: section, order: ids + order.filter { !ids.contains($0) })
    }

    /// Into a section, in this order: first whatever makes them belong there
    /// (a day, the evening, a heading), then the order. One ⌘Z undoes both.
    private func place(_ moving: [Todo], into section: ListContent.Section, order: [String]) async {
        let before = content.sections.map { s in (s.id, s.rows.compactMap { if case .todo(let t) = $0 { t.id } else { nil } }) }
        var change: [(String, UncheckedBox<[String: Any]>, UncheckedBox<[String: Any]>, String)] = []   // id, to, back, path
        var fresh: [Todo] = []
        for t in moving { fresh.append(await current(t)) }
        // Today's own headings: under the one dropped in, or under none
        let heading: String? = section.id.hasPrefix("th:") ? String(section.id.dropFirst(3)) : nil
        let wasUnder = Dictionary(uniqueKeysWithValues: moving.map { ($0.id, todayHeading(of: $0.id)) })
        let filing = place == .today && section.id != "evening" && moving.contains { wasUnder[$0.id] ?? nil != heading }
        for t in fresh {
            switch place {
            case .today:
                let evening = section.id == "evening"
                if t.evening != evening { change.append((t.id, UncheckedBox(["evening": evening, "when": state.today]), UncheckedBox(["evening": t.evening, "when": t.when ?? NSNull()]), "PATCH")) }
            case .upcoming:
                if t.when != section.id { change.append((t.id, UncheckedBox(["when": section.id, "someday": false]), UncheckedBox(["when": t.when ?? NSNull(), "someday": t.someday]), "PATCH")) }
            case .project(let pid):
                let heading: String? = section.id.isEmpty ? nil : section.id
                if t.headingId != heading {
                    var to: [String: Any] = ["projectId": pid]
                    if let heading { to["headingId"] = heading }
                    var back: [String: Any] = ["projectId": t.projectId ?? pid]
                    if let h = t.headingId { back["headingId"] = h }
                    change.append((t.id, UncheckedBox(to), UncheckedBox(back), "MOVE"))
                }
            default: break
            }
        }
        let context = reorderContext(of: section)
        let sectionId = section.id
        let oldOrder = before.first { $0.0 == sectionId }?.1 ?? []
        await act("Move", notice: nil,
                  do: { m in
                      for (id, to, _, how) in change {
                          if how == "MOVE" { _ = try await m.ask("POST", "/api/todos/\(id)/move", to.value) }
                          else { _ = try await m.ask("PATCH", "/api/todos/\(id)", to.value) }
                      }
                      if filing { _ = try await m.ask("POST", "/api/today/file", ["ids": moving.map(\.id), "headingId": heading ?? NSNull()]) }
                      if let context { _ = try await m.ask("POST", "/api/reorder", ["context": context, "ids": order]) }
                  },
                  undo: { m in
                      for (id, _, back, how) in change {
                          if how == "MOVE" { _ = try await m.ask("POST", "/api/todos/\(id)/move", back.value) }
                          else { _ = try await m.ask("PATCH", "/api/todos/\(id)", back.value) }
                      }
                      if filing {
                          for (under, ids) in Dictionary(grouping: moving.map(\.id), by: { wasUnder[$0] ?? nil }) {
                              _ = try await m.ask("POST", "/api/today/file", ["ids": ids, "headingId": under ?? NSNull()])
                          }
                      }
                      if let context, !oldOrder.isEmpty { _ = try await m.ask("POST", "/api/reorder", ["context": context, "ids": oldOrder]) }
                  })
    }

    /// The reorder context for a section of the list in front (engine: Store.reorder).
    func reorderContext(of section: ListContent.Section) -> String? {
        switch place {
        case .today: "today"
        case .inbox: "inbox"
        case .someday: "someday"
        case .anytime: "anytime"
        case .upcoming: "upcoming:\(section.id)"
        case .project(let pid): section.id.isEmpty ? "project:\(pid)" : "heading:\(section.id)"
        case .area(let id): "area:\(id)"
        default: nil
        }
    }

    // ---- onto the sidebar -------------------------------------------------------------

    /// Dropped on a list, a project or an area in the sidebar.
    func drop(onPlace target: Place) async {
        defer { endDrag() }
        let moving = draggedTodos
        guard !moving.isEmpty else { return }
        switch target {
        case .inbox: await move(to: .inbox, for: moving, named: "Inbox")
        case .today: await setWhen(.today, for: moving)
        case .upcoming:
            let tomorrow = Dates.iso.string(from: Calendar.current.date(byAdding: .day, value: 1, to: Dates.date(state.today) ?? Date())!)
            await setWhen(.date(tomorrow), for: moving)
        case .anytime: await setWhen(.anytime, for: moving)
        case .someday: await setWhen(.someday, for: moving)
        case .logbook: for t in moving where t.isOpen { await complete(t) }
        case .trash:
            selected = Set(moving.map { "t:" + $0.id })
            await trashChosen()
        case .project(let id): await move(to: .project(id), for: moving, named: state.project(id)?.name ?? "the project")
        case .area(let id): await move(to: .area(id), for: moving, named: state.area(id)?.name ?? "the area")
        case .extra: break
        }
    }
}

/// A row as a drop target: the line shows above or below it, by which half
/// the drag is over.
struct RowDrop: DropDelegate {
    let model: AppModel
    let row: String
    let height: CGFloat

    private func after(_ info: DropInfo) -> Bool { info.location.y > height / 2 }

    func validateDrop(info: DropInfo) -> Bool { !model.dragging.isEmpty }
    func dropEntered(info: DropInfo) { model.dropTarget = .row(row, after: after(info)) }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        let t = DropTarget.row(row, after: after(info))
        if model.dropTarget != t { model.dropTarget = t }
        return DropProposal(operation: .move)
    }
    func dropExited(info: DropInfo) { if case .row(let r, _) = model.dropTarget, r == row { model.dropTarget = nil } }
    func performDrop(info: DropInfo) -> Bool {
        let a = after(info)
        Task { await model.drop(beside: row, after: a) }
        return true
    }
}

/// A section heading, or a sidebar row, as a drop target.
struct PlainDrop: DropDelegate {
    let model: AppModel
    let target: DropTarget
    let action: () async -> Void

    func validateDrop(info: DropInfo) -> Bool { !model.dragging.isEmpty }
    func dropEntered(info: DropInfo) { model.dropTarget = target }
    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
    func dropExited(info: DropInfo) { if model.dropTarget == target { model.dropTarget = nil } }
    func performDrop(info: DropInfo) -> Bool {
        Task { await action() }
        return true
    }
}

extension View {
    /// The insertion line a drop would make, above or below this row.
    func dropLine(_ model: AppModel, row: String) -> some View {
        overlay(alignment: .top) {
            if model.dropTarget == .row(row, after: false) { InsertLine().offset(y: -1) }
        }
        .overlay(alignment: .bottom) {
            if model.dropTarget == .row(row, after: true) { InsertLine().offset(y: 1) }
        }
    }
}

struct InsertLine: View {
    var body: some View {
        HStack(spacing: 0) {
            Circle().strokeBorder(Palette.accent, lineWidth: 2).frame(width: 7, height: 7)
            Rectangle().fill(Palette.accent).frame(height: 2)
        }
        .padding(.horizontal, -10)
        .allowsHitTesting(false)
    }
}
