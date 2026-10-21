import SwiftUI

/// Projects, areas and headings: making them, naming them, finishing and
/// removing them; and a to-do's repeat and its turning into a project. As in
/// Actions.swift, each is the web app's request, with its opposite for ⌘Z.
@MainActor
extension AppModel {
    // ---- projects ---------------------------------------------------------------------

    /// ⌥⌘N: a project, in the area in front if there is one, its name open to type.
    func newProject() async {
        var body: [String: Any] = ["name": "New Project"]
        if case .area(let a) = place { body["areaId"] = a }
        do {
            let p = Project(try await ask("POST", "/api/projects", body))
            register("New Project",
                     undo: { m in _ = try await m.ask("DELETE", "/api/projects/\(p.id)") },
                     redo: { m in _ = try await m.ask("POST", "/api/projects/\(p.id)/restore", [:]) })
            await refresh()
            place = .project(p.id)
            renamingTitle = true
        } catch { notice = error.localizedDescription }
    }

    func patchProject(_ p: Project, name: String, to: [String: Any], back: [String: Any], notice text: String? = nil) async {
        let f = UncheckedBox(to), b = UncheckedBox(back)
        await act(name, notice: text,
                  do: { m in _ = try await m.ask("PATCH", "/api/projects/\(p.id)", f.value) },
                  undo: { m in _ = try await m.ask("PATCH", "/api/projects/\(p.id)", b.value) })
    }

    func renameProject(_ p: Project, _ name: String) async {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, n != p.name else { return }
        await patchProject(p, name: "Rename", to: ["name": n], back: ["name": p.name])
    }

    func setProjectNotes(_ p: Project, _ notes: String) async {
        guard notes != p.notes else { return }
        await patchProject(p, name: "Notes", to: ["notes": notes], back: ["notes": p.notes])
    }

    func setProjectWhen(_ p: Project, _ when: When) async {
        let to: [String: Any]
        switch when {
        case .today: to = ["when": state.today, "someday": false]
        case .evening: to = ["when": state.today, "evening": true, "someday": false]
        case .anytime, .clear: to = ["when": NSNull(), "someday": false]
        case .someday: to = ["when": NSNull(), "someday": true]
        case .date(let d): to = ["when": d, "someday": false]
        }
        await patchProject(p, name: "When", to: to, back: ["when": p.when ?? NSNull(), "someday": p.someday])
    }

    func setProjectDeadline(_ p: Project, _ date: String?) async {
        await patchProject(p, name: "Deadline", to: ["deadline": date ?? NSNull()], back: ["deadline": p.deadline ?? NSNull()])
    }

    func moveProject(_ p: Project, toArea area: Area?) async {
        await patchProject(p, name: "Move", to: ["areaId": area?.id ?? NSNull()], back: ["areaId": p.areaId ?? NSNull()],
                           notice: "Moved to \(area?.name ?? "no area")")
    }

    func completeProject(_ p: Project) async {
        await act("Complete Project", notice: "Completed “\(p.name)”",
                  do: { m in _ = try await m.ask("POST", "/api/projects/\(p.id)/complete", ["completeOpenTodos": true]) },
                  undo: { m in _ = try await m.ask("POST", "/api/projects/\(p.id)/reopen", [:]) })
    }

    func cancelProject(_ p: Project) async {
        await act("Cancel Project", notice: "Canceled “\(p.name)”",
                  do: { m in _ = try await m.ask("POST", "/api/projects/\(p.id)/cancel", [:]) },
                  undo: { m in _ = try await m.ask("POST", "/api/projects/\(p.id)/reopen", [:]) })
    }

    func deleteProject(_ p: Project) async {
        if place == .project(p.id) { place = .today }
        await act("Delete Project", notice: "Moved “\(p.name)” to the Trash",
                  do: { m in _ = try await m.ask("DELETE", "/api/projects/\(p.id)") },
                  undo: { m in _ = try await m.ask("POST", "/api/projects/\(p.id)/restore", [:]) })
    }

    // ---- headings ---------------------------------------------------------------------

    /// ⇧⌘N in a project: a heading at the foot, its name open to type.
    func newHeading() async {
        guard case .project(let pid) = place else { return }
        let taken = Set(state.project(pid)?.headings.map(\.name) ?? [])
        var name = "New Heading", n = 2
        while taken.contains(name) { name = "New Heading \(n)"; n += 1 }
        let id = "\(pid):\(name)"
        let made = name
        await act("New Heading", notice: nil,
                  do: { m in _ = try await m.ask("POST", "/api/projects/\(pid)/headings", ["name": made]) },
                  undo: { m in _ = try await m.ask("DELETE", "/api/headings/\(Self.escape(id))") })
        await refresh()
        renamingHeading = id
    }

    func renameHeading(_ id: String, _ name: String) async {
        renamingHeading = nil
        let pid = String(id.prefix { $0 != ":" }), old = String(id.drop { $0 != ":" }.dropFirst())
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, n != old else { return }
        let newId = "\(pid):\(n)"
        await act("Rename Heading", notice: nil,
                  do: { m in _ = try await m.ask("PATCH", "/api/headings/\(Self.escape(id))", ["name": n]) },
                  undo: { m in _ = try await m.ask("PATCH", "/api/headings/\(Self.escape(newId))", ["name": old]) })
    }

    func archiveHeading(_ id: String) async {
        await act("Archive Heading", notice: "Archived",
                  do: { m in _ = try await m.ask("PATCH", "/api/headings/\(Self.escape(id))", ["archived": true]) },
                  undo: { m in _ = try await m.ask("PATCH", "/api/headings/\(Self.escape(id))", ["archived": false]) })
    }

    /// The heading goes; its to-dos stay, in the project without a heading.
    func deleteHeading(_ id: String) async {
        let pid = String(id.prefix { $0 != ":" }), name = String(id.drop { $0 != ":" }.dropFirst())
        let under = content.allTodos.filter { $0.headingId == id }.map(\.id)
        await act("Delete Heading", notice: "Deleted “\(name)”",
                  do: { m in _ = try await m.ask("DELETE", "/api/headings/\(Self.escape(id))") },
                  undo: { m in
                      _ = try await m.ask("POST", "/api/projects/\(pid)/headings", ["name": name])
                      for t in under { _ = try await m.ask("POST", "/api/todos/\(t)/move", ["projectId": pid, "headingId": id]) }
                  })
    }

    static func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/", ":"])) ?? s
    }

    // ---- areas ------------------------------------------------------------------------

    func newArea() async {
        do {
            let a = Area(try await ask("POST", "/api/areas", ["name": "New Area"]))
            register("New Area",
                     undo: { m in _ = try await m.ask("DELETE", "/api/areas/\(a.id)") },
                     redo: { m in _ = try await m.ask("POST", "/api/areas", ["id": a.id, "name": a.name]) })
            await refresh()
            place = .area(a.id)
            renamingTitle = true
        } catch { notice = error.localizedDescription }
    }

    func renameArea(_ a: Area, _ name: String) async {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, n != a.name else { return }
        let old = a.name
        await act("Rename", notice: nil,
                  do: { m in _ = try await m.ask("PATCH", "/api/areas/\(a.id)", ["name": n]) },
                  undo: { m in _ = try await m.ask("PATCH", "/api/areas/\(a.id)", ["name": old]) })
    }

    func setAreaNotes(_ a: Area, _ notes: String) async {
        guard notes != a.notes else { return }
        let old = a.notes
        await act("Notes", notice: nil,
                  do: { m in _ = try await m.ask("PATCH", "/api/areas/\(a.id)", ["notes": notes]) },
                  undo: { m in _ = try await m.ask("PATCH", "/api/areas/\(a.id)", ["notes": old]) })
    }

    /// An area goes only once it holds nothing (the server says so otherwise).
    func deleteArea(_ a: Area) async {
        if place == .area(a.id) { place = .today }
        do {
            _ = try await ask("DELETE", "/api/areas/\(a.id)")
            let name = a.name, id = a.id
            register("Delete Area",
                     undo: { m in _ = try await m.ask("POST", "/api/areas", ["id": id, "name": name]) },
                     redo: { m in _ = try await m.ask("DELETE", "/api/areas/\(id)") })
            notice = "Deleted “\(name)”"
        } catch { notice = error.localizedDescription }
    }

    // ---- repeat, and a to-do as a project ---------------------------------------------

    /// What a repeat rule means: whether it parses, in words, and its next dates.
    func parseRepeat(_ rule: String, from when: String?) async -> (ok: Bool, words: String, next: [String], error: String?) {
        guard let j = try? await backend?.request("POST", "/api/parse-repeat", body: ["repeat": rule, "when": when ?? state.today]) else {
            return (false, "", [], "Can't check that rule now.")
        }
        return (j["ok"].bool, j["describes"].string ?? "", j["next"].strings, j["error"].string)
    }

    func setRepeat(_ rule: String?, for t: Todo) async {
        popover = nil
        await patch([t], name: "Repeat", notice: rule == nil ? "Stopped repeating" : "Repeats \(rule!)") { _ in
            ["repeat": rule ?? NSNull()]
        } back: { t in ["repeat": t.repeatRule ?? NSNull()] }
    }

    /// ⇧⌘P: the to-do becomes a project, its checklist its to-dos.
    func convertChosen() async {
        guard let t = chosen.first else { return }
        do {
            let j = try await ask("POST", "/api/todos/\(t.id)/convert", [:])
            let pid = j["id"].string ?? j["project"]["id"].string
            notice = "Converted to a project"
            await refresh()
            if let pid { place = .project(pid) }
        } catch { notice = error.localizedDescription }
    }

    // ---- Quick Find ---------------------------------------------------------------------

    struct Found: Identifiable, Hashable {
        enum Kind: Hashable { case list(Place), project(Project), area(Area), todo(Todo) }
        let kind: Kind
        var id: String {
            switch kind {
            case .list(let p): "l:\(p)"
            case .project(let p): "p:\(p.id)"
            case .area(let a): "a:\(a.id)"
            case .todo(let t): "t:\(t.id)"
            }
        }
    }

    func find(_ q: String) async -> [Found] {
        let path = "/api/search?q=" + (q.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? q)
        guard let j = try? await backend?.request("GET", path, body: nil) else { return [] }
        var out: [Found] = []
        out += j["lists"].array.compactMap { $0["id"].string.flatMap(Place.init(list:)).map { Found(kind: .list($0)) } }
        out += j["areas"].array.map { Found(kind: .area(Area($0))) }
        out += j["projects"].array.map { Found(kind: .project(Project($0))) }
        out += j["todos"].array.map { Found(kind: .todo(Todo($0))) }
        return out
    }

    /// Where a found thing lives, and there it opens: a to-do in the list it is in.
    func go(_ f: Found) async {
        finding = false
        switch f.kind {
        case .list(let p): place = p
        case .project(let p): place = .project(p.id)
        case .area(let a): place = .area(a.id)
        case .todo(let t):
            let home: Place = if let p = t.projectId { .project(p) }
                else if t.inbox { .inbox }
                else if !t.isOpen { .logbook }
                else if t.someday { .someday }
                else if let w = t.when, w <= state.today { .today }
                else if t.when != nil { .upcoming }
                else if let a = t.areaId { .area(a) }
                else { .anytime }
            place = home
            await loadList()
            if todo(t.id) != nil { open(t.id, focusTitle: false) } else { selectOnly(t.id) }
        }
    }
}
