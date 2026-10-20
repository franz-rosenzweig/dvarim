import Foundation

/// Writes the shell makes on its own — a Quick Entry line, the Create To-Do
/// intent, a tick in the menu bar or on a reminder — kept on this Mac while the
/// server cannot be reached, and sent when it can.
///
/// The web app in the window has an outbox of its own (frontend/src/lib/
/// outbox.js); this is the same idea for the few things that talk to the API
/// without it. They are few and independent — a line typed into Quick Entry and
/// a tick in the menu bar never refer to each other — so, unlike the web app's
/// queue, order does not matter and each is sent on its own: one that still
/// cannot get through does not hold up the rest.
///
/// Everything here is safe to send twice. A quick-add carries the id it was
/// made under and the server answers a repeat with the to-do it already has;
/// completing a done to-do changes nothing. So a send that landed but whose
/// answer was lost on the way back is simply sent again.
///
/// It goes to whichever server is set when it is sent, not the one set when it
/// was kept: the tunnel's address and the tailnet's reach the same server (see
/// Defaults), and switching from one to the other while something waits should
/// not strand it behind the one that went away.
@MainActor
final class Outbox: ObservableObject {
    static let shared = Outbox()

    enum Op: Codable, Equatable {
        /// A line of quick entry, which the server parses when it arrives,
        /// and any notes, which it does not. (Kept before notes came along, a
        /// line has none: an optional decodes as missing.)
        case quickAdd(id: String, text: String, notes: String?, list: String?)
        /// Ticked on `on`, the day the Logbook should file it under.
        case complete(id: String, on: String, title: String)
    }

    /// What is waiting, oldest first. Quick Entry and the menu bar both say how many.
    @Published private(set) var ops: [Op] = []
    /// The last one the server turned down outright, by name, for the menu bar.
    @Published private(set) var refused: String?

    private let file: URL
    private var draining = false

    init(file: URL = Outbox.defaultFile) {
        self.file = file
        ops = (try? JSONDecoder().decode([Op].self, from: Data(contentsOf: file))) ?? []
    }

    /// ~/Library/Application Support/Dvarim/outbox.json, unless the launch names
    /// another (-OutboxFile). The self-test runs as this app, under its bundle
    /// id, and a line it left behind here would be sent by the real app to the
    /// real vault.
    nonisolated static var defaultFile: URL {
        if let path = UserDefaults.standard.string(forKey: "OutboxFile") { return URL(fileURLWithPath: path) }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Dvarim", isDirectory: true)
            .appendingPathComponent("outbox.json")
    }

    enum Outcome { case sent(Client.Todo), kept }

    /// Add a to-do, or keep it for later. Throws only when the server answers
    /// no — an empty line, a lapsed sign-in — which is worth saying at once.
    func quickAdd(_ text: String, notes: String? = nil, list: String? = nil) async throws -> Outcome {
        let id = Client.newId()
        do {
            return .sent(try await Client.current.quickAdd(text, notes: notes, list: list, id: id))
        } catch is Client.Unreachable {
            keep(.quickAdd(id: id, text: text, notes: notes, list: list))
            return .kept
        }
    }

    /// Complete a to-do, or keep the tick for later: from the menu bar, and
    /// from a reminder's Complete button.
    func complete(_ id: String, title: String) async throws {
        do {
            try await Client.current.complete(id)
        } catch is Client.Unreachable {
            keep(.complete(id: id, on: Self.today(), title: title))
        }
    }

    /// To-dos ticked here and not yet sent. The menu bar leaves them out of what
    /// it last heard from the server, so a tick does not undo itself on reload.
    var completing: Set<String> {
        Set(ops.compactMap { if case let .complete(id, _, _) = $0 { id } else { nil } })
    }

    /// Send what is waiting, each on its own. One the server still cannot be
    /// reached for stays, and so does one it will not take until someone signs
    /// in again — dropping a captured line over a lapsed cookie would lose it.
    /// One it refuses outright (a to-do deleted elsewhere meanwhile) is dropped
    /// and named. Returns how many went.
    @discardableResult
    func drain() async -> Int {
        guard !ops.isEmpty, !draining else { return 0 }
        draining = true
        defer { draining = false }
        var handled: [Op] = []
        for op in ops {
            do {
                try await send(op)
                handled.append(op)
            } catch is Client.Unreachable {
                continue
            } catch is Client.NotSignedIn {
                continue
            } catch {
                refused = "\(Self.describe(op)): \(error.localizedDescription)"
                handled.append(op)
            }
        }
        // Only what this drain dealt with: a line kept while it was sending is
        // still waiting, and replacing the whole list would lose it.
        ops.removeAll { handled.contains($0) }
        save()
        return handled.count
    }

    private func send(_ op: Op) async throws {
        let client = Client.current
        switch op {
        case let .quickAdd(id, text, notes, list): _ = try await client.quickAdd(text, notes: notes, list: list, id: id)
        case let .complete(id, on, _): try await client.complete(id, on: on)
        }
    }

    private func keep(_ op: Op) {
        ops.append(op)
        save()
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(ops).write(to: file, options: .atomic)
        } catch {
            NSLog("Dvarim: could not keep the outbox at \(file.path) — \(error.localizedDescription)")
        }
    }

    static func describe(_ op: Op) -> String {
        switch op {
        case let .quickAdd(_, text, _, _): "Adding “\(text)”"
        case let .complete(_, _, title): "Completing “\(title)”"
        }
    }

    /// Today where the Mac is, which is what a tick means.
    static func today() -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
