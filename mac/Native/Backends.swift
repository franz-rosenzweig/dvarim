import CoreServices
import Foundation

/// What answers the screens: the engine on a folder here (Local), or the
/// server (Remote). Both speak the same API, the one docs/API.md describes, so
/// everything above this line is the same in either mode.
@MainActor
protocol Backend: AnyObject {
    /// Asks; throws APIError for an answer of 400 or more.
    func request(_ method: String, _ path: String, body: [String: Any]?) async throws -> J
    /// Called whenever the to-dos may have changed, here or elsewhere.
    var onChange: (() -> Void)? { get set }
    var syncState: SyncState { get }
    var onSyncState: ((SyncState) -> Void)? { get set }
    func start() async throws
    func stop()
    /// The window came forward, or the Mac woke: catch up.
    func catchUp()
}

struct APIError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
    /// No answer at all, or the tunnel's for a server that is not there.
    var unreachable: Bool { status == 0 || [502, 503, 504].contains(status) }
}

/// The built-in sync as the toolbar shows it.
struct SyncState: Equatable, Sendable {
    enum Kind: String, Sendable { case off, idle, syncing, error }
    var kind: Kind = .off
    var at: Date?
    var error: String?
    var offline = false
}

// MARK: - Local: the engine on a folder on this Mac

@MainActor
final class LocalBackend: Backend {
    let root: URL
    let sync: (address: String, token: String)?
    let tutorial: Bool
    private let host: EngineHost
    private var stream: FSEventStreamRef?
    private var scanTask: Task<Void, Never>?
    var onChange: (() -> Void)?
    var onSyncState: ((SyncState) -> Void)?
    private(set) var syncState = SyncState()

    /// Where its calendar events come from: the server's, for the copy; this Mac's, for a folder.
    let events: Calendars.Source?

    init(root: URL, sync: (address: String, token: String)?, tutorial: Bool = true, events: Calendars.Source? = nil) {
        self.root = root
        self.sync = sync
        self.tutorial = tutorial
        self.events = events
        host = EngineHost(root: root)
    }

    var engine: EngineHost { host }

    func start() async throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try host.start()
        host.onChanged = { [weak self] _ in self?.onChange?() }
        host.onSyncStatus = { [weak self] obj in
            guard let self else { return }
            let j = J(obj)
            var s = SyncState()
            s.kind = SyncState.Kind(rawValue: j["state"].string ?? "off") ?? .off
            s.at = j["at"].double.map { Date(timeIntervalSince1970: $0 / 1000) }
            s.error = j["error"].string
            s.offline = j["offline"].bool
            self.syncState = s
            self.onSyncState?(s)
        }
        if let events {
            host.onAsk = { op, args in await Calendars.answer(events, op: op, args: args) }
        }
        try await host.open(tutorial: tutorial, sync: sync, events: events?.rawValue)
        watch()
    }

    func stop() {
        stopWatching()
        host.stop()
    }

    func catchUp() {
        guard sync != nil else { return }
        Task { try? await host.syncNow() }
    }

    func request(_ method: String, _ path: String, body: [String: Any]?) async throws -> J {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        let answer = try await host.request(method, path, body: data)
        let j = J(data: answer.body)
        if answer.status >= 400 { throw APIError(status: answer.status, message: j["error"].string ?? "error \(answer.status)") }
        return j
    }

    // Obsidian, Syncthing, a person with an editor: someone else writes the
    // folder, and the engine reads what changed (its own writes come back
    // through here too, and it compares contents, so that costs nothing).
    private func watch() {
        guard stream == nil else { return }
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                           retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            let me = Unmanaged<LocalBackend>.fromOpaque(info).takeUnretainedValue()
            DispatchQueue.main.async { MainActor.assumeIsolated { me.filesChanged() } }
        }
        stream = FSEventStreamCreate(nil, callback, &context, [root.path] as CFArray,
                                     FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.3,
                                     FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer))
        if let stream {
            FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
            FSEventStreamStart(stream)
        }
    }

    private func stopWatching() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    private func filesChanged() {
        scanTask?.cancel()
        scanTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.host.scan()
        }
    }
}

// MARK: - Remote: the server

@MainActor
final class RemoteBackend: Backend {
    let server: URL
    private let session: URLSession
    private var stream: Task<Void, Never>?
    var onChange: (() -> Void)?
    var onSyncState: ((SyncState) -> Void)?
    private(set) var syncState = SyncState()

    init(server: URL, session: URLSession = .shared) {
        self.server = server
        self.session = session
    }

    func start() async throws { listen() }

    func stop() {
        stream?.cancel()
        stream = nil
    }

    func catchUp() {
        if stream == nil { listen() }
        onChange?()
    }

    func request(_ method: String, _ path: String, body: [String: Any]?) async throws -> J {
        guard let url = URL(string: path, relativeTo: server) else { throw APIError(status: 400, message: "not a path: \(path)") }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(for: r)
        } catch {
            throw APIError(status: 0, message: "Can't reach \(server.host ?? "the server").")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let j = J(data: data)
        if status >= 400 { throw APIError(status: status, message: j["error"].string ?? "the server answered \(status)") }
        return j
    }

    /// The server's event stream: a line for every change, from any device.
    private func listen() {
        stream?.cancel()
        let url = server.appendingPathComponent("api/stream")
        stream = Task { [weak self] in
            var wait: UInt64 = 2
            while !Task.isCancelled {
                do {
                    var r = URLRequest(url: url)
                    r.timeoutInterval = 3600
                    r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await URLSession.shared.bytes(for: r)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError(status: 0, message: "no stream") }
                    wait = 2
                    for try await line in bytes.lines where line.hasPrefix("data:") || line.hasPrefix("event:") {
                        await MainActor.run { self?.onChange?() }
                    }
                } catch {
                    if Task.isCancelled { return }
                }
                try? await Task.sleep(nanoseconds: wait * 1_000_000_000)
                wait = min(wait * 2, 60)
            }
        }
    }
}
