import Foundation

/// What the shell writes on its own (a Quick Entry line, Create To-Do from
/// Shortcuts, a tick in the menu bar or on a reminder) kept on this Mac while
/// the server can't be reached, and sent when it can. Only Remote mode ever
/// needs it: a copy on this Mac, or a folder, is answered by the engine here,
/// which is always there.
///
/// Everything is safe to send twice: a quick-add carries the id it was made
/// under, and the engine answers a repeat with the to-do it already has; a
/// done to-do completed again changes nothing.
@MainActor
@Observable
final class Outbox {
    static let shared = Outbox()

    enum Op: Codable, Equatable {
        case quickAdd(id: String, text: String, notes: String?, list: String?)
        case complete(id: String, on: String, title: String)
    }

    enum Outcome { case sent(Todo), kept }

    private(set) var ops: [Op] = []
    /// The last one the server turned down outright, by name.
    private(set) var refused: String?
    private var draining = false

    /// The to-dos ticked here and not sent yet: the menu bar leaves them out.
    var completing: Set<String> { Set(ops.compactMap { if case .complete(let id, _, _) = $0 { id } else { nil } }) }

    init() {
        ops = (try? JSONDecoder().decode([Op].self, from: Data(contentsOf: Self.file))) ?? []
    }

    /// Application Support/<the app's folder>/outbox.json, apart for the self-test.
    static var file: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Account.appFolder, isDirectory: true)
            .appendingPathComponent("outbox.json")
    }

    private func save() {
        try? FileManager.default.createDirectory(at: Self.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(ops).write(to: Self.file, options: .atomic)
    }

    /// An id the engine would have made: eight of 0-9a-z.
    static func newId() -> String {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return String((0..<8).map { _ in alphabet.randomElement()! })
    }

    /// A line of quick entry, parsed by the engine (a date phrase, !deadline,
    /// @reminder, #tags), into the Inbox or Today.
    func quickAdd(_ text: String, notes: String? = nil, list: String? = nil) async throws -> Outcome {
        let id = Self.newId()
        do {
            return .sent(try await send(.quickAdd(id: id, text: text, notes: notes, list: list)))
        } catch let e as APIError where e.unreachable {
            ops.append(.quickAdd(id: id, text: text, notes: notes, list: list))
            save()
            return .kept
        }
    }

    /// A tick, from the menu bar or a reminder.
    func complete(_ id: String, title: String) async throws {
        let on = Dates.iso.string(from: Date())
        do {
            _ = try await send(.complete(id: id, on: on, title: title))
        } catch let e as APIError where e.unreachable {
            ops.append(.complete(id: id, on: on, title: title))
            save()
        }
    }

    /// Everything kept, each on its own: one that still can't get through
    /// doesn't hold up the rest. One the server refuses is dropped and named.
    func drain() async {
        guard !draining, !ops.isEmpty else { return }
        draining = true
        defer { draining = false }
        for op in ops {
            do {
                _ = try await send(op)
                ops.removeAll { $0 == op }
            } catch let e as APIError where e.unreachable {
                continue
            } catch {
                if case .quickAdd(_, let text, _, _) = op { refused = text }
                if case .complete(_, _, let title) = op { refused = title }
                ops.removeAll { $0 == op }
            }
        }
        save()
    }

    private func send(_ op: Op) async throws -> Todo {
        // at launch, the engine or the server a moment from being there
        await Session.shared.ready(within: 10)
        switch op {
        case .quickAdd(let id, let text, let notes, let list):
            var body: [String: Any] = ["text": text, "id": id]
            if let notes, !notes.isEmpty { body["notes"] = notes }
            if let list { body["list"] = list }
            return Todo(try await Session.shared.ask("POST", "/api/quick-add", body))
        case .complete(let id, let on, _):
            return Todo(try await Session.shared.ask("POST", "/api/todos/\(id)/complete", ["on": on]))
        }
    }
}
