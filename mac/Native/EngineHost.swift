import Foundation
import JavaScriptCore
import Security

/// Dvarim's engine (engine/src), the rules every device shares, running in
/// JavaScriptCore inside the app, so the native screens never re-implement a
/// list: they ask the engine the same API the server answers.
///
/// The engine lives on a thread of its own with a run loop, and is only ever
/// touched there. What JavaScriptCore lacks and the engine uses (timers,
/// randomness, URL parsing, UTF-8, the network for WebDAV, the folder itself)
/// is `__native`, installed below; Engine/prelude.js builds the browser-shaped
/// globals out of it. The bundle (Engine/host.js plus the engine, made by
/// build-native.sh) then answers `__dvarim.request` with `__native.reply`.
final class EngineHost: NSObject, @unchecked Sendable {
    /// What a request came back with: the API's status and its JSON body.
    struct Answer: Sendable {
        let status: Int
        let body: Data
    }

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    let root: URL
    private let files: FolderFiles
    private var thread: Thread?
    private var context: JSContext?

    private let lock = NSLock()
    private var waiting: [Int: CheckedContinuation<Answer, Error>] = [:]
    private var nextId = 0
    private var timers: [Int: Timer] = [:]          // the engine's thread only
    private var front = true

    /// Paths the vault says changed, on the main thread.
    var onChanged: (@MainActor ([String]) -> Void)?
    /// The built-in sync's status as JSON ({state, at, error, offline}), on the main thread.
    var onSyncStatus: (@MainActor ([String: Any]) -> Void)?
    /// The engine asking the Mac something it can't answer itself (the
    /// calendars: `calendars`, `events`), on the main thread; the answer is JSON-able.
    var onAsk: (@MainActor (String, [String: Any]) async -> Any)?

    init(root: URL) {
        self.root = root
        files = FolderFiles(root: root)
    }

    /// Whether a window is in front, which the sync's five-minute round asks.
    var inFront: Bool {
        get { lock.withLock { front } }
        set { lock.withLock { front = newValue } }
    }

    // ---- the thread ----------------------------------------------------------------

    func start() throws {
        guard thread == nil else { return }
        guard let prelude = Bundle.main.url(forResource: "prelude", withExtension: "js"),
              let engine = Bundle.main.url(forResource: "engine", withExtension: "js"),
              let preludeText = try? String(contentsOf: prelude, encoding: .utf8),
              let engineText = try? String(contentsOf: engine, encoding: .utf8) else {
            throw Failure(message: "the engine is missing from the app (build it with build-native.sh)")
        }
        let ready = DispatchSemaphore(value: 0)
        var failed: String?
        let t = Thread { [weak self] in
            guard let self else { return }
            RunLoop.current.add(NSMachPort(), forMode: .default)
            failed = self.setUp(prelude: preludeText, engine: engineText)
            ready.signal()
            while !Thread.current.isCancelled {
                _ = RunLoop.current.run(mode: .default, before: .distantFuture)
            }
        }
        t.name = "dvarim.engine"
        t.qualityOfService = .userInitiated
        t.stackSize = 8 << 20
        thread = t
        t.start()
        ready.wait()
        if let failed { throw Failure(message: failed) }
    }

    func stop() {
        thread?.cancel()
        perform { }                 // wakes the run loop so it sees the cancel
        lock.withLock {
            for (_, c) in waiting { c.resume(throwing: Failure(message: "the engine stopped")) }
            waiting.removeAll()
        }
    }

    private final class Box: NSObject {
        let block: () -> Void
        init(_ block: @escaping () -> Void) { self.block = block }
    }

    @objc private func runBox(_ box: Box) { box.block() }

    /// Run on the engine's thread.
    private func perform(_ block: @escaping () -> Void) {
        guard let thread else { return }
        perform(#selector(runBox(_:)), on: thread, with: Box(block), waitUntilDone: false)
    }

    // ---- calling the engine -----------------------------------------------------------

    /// `__dvarim.<method>(id, ...args)`, answered by `__native.reply(id, json)`.
    private func call(_ method: String, _ args: [Any]) async throws -> Answer {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Answer, Error>) in
            let id: Int = lock.withLock {
                nextId += 1
                waiting[nextId] = c
                return nextId
            }
            perform { [weak self] in
                guard let self, let host = self.context?.objectForKeyedSubscript("__dvarim") else { return }
                host.invokeMethod(method, withArguments: [id] + args)
            }
        }
    }

    /// Open the folder; `sync` is the server it keeps in step with, if any;
    /// `events` where its calendar events come from ("server", "device"), if anywhere.
    func open(tutorial: Bool, sync: (address: String, token: String)?, events: String? = nil) async throws {
        var opts: [String: Any] = ["tutorial": tutorial]
        if let sync { opts["sync"] = ["address": sync.address, "token": sync.token] }
        if let events { opts["events"] = events }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: opts), as: UTF8.self)
        let answer = try await call("open", [json])
        if answer.status != 200 { throw Failure(message: Self.message(answer) ?? "the folder would not open") }
    }

    /// One API request, as the server would answer it.
    func request(_ method: String, _ path: String, body: Data?) async throws -> Answer {
        let text: Any = body.map { String(decoding: $0, as: UTF8.self) } ?? NSNull()
        return try await call("request", [method, path, text])
    }

    /// Someone else changed the folder: the engine reads what changed.
    func scan() async { _ = try? await call("scan", []) }

    /// A sync round now. Throws when the server could not be reached or said no.
    @discardableResult
    func syncNow() async throws -> Answer { try await call("syncNow", []) }

    func flush() async { _ = try? await call("flush", []) }

    /// The calendars changed (turned on, a choice made): every list asks again.
    func calendarsChanged() async { _ = try? await call("calendarsChanged", []) }

    /// The storage contract's own checks, on a scratch folder inside the vault.
    func conformance() async throws -> Answer { try await call("conformance", []) }

    static func message(_ answer: Answer) -> String? {
        (try? JSONSerialization.jsonObject(with: answer.body) as? [String: Any])?["error"] as? String
    }

    // ---- __native, on the engine's thread -----------------------------------------------

    private func setUp(prelude: String, engine: String) -> String? {
        guard let ctx = JSContext() else { return "JavaScriptCore would not start" }
        ctx.name = "Dvarim engine"
        var fault: String?
        ctx.exceptionHandler = { _, exception in
            let text = exception?.toString() ?? "unknown"
            let stack = exception?.objectForKeyedSubscript("stack")?.toString() ?? ""
            NSLog("Dvarim engine: \(text)\n\(stack)")
            fault = text
        }
        let native = JSValue(newObjectIn: ctx)!

        let log: @convention(block) (String, String) -> Void = { level, text in
            NSLog("Dvarim engine [\(level)]: \(text)")
        }
        let timer: @convention(block) (Int, Double) -> Void = { [weak self] id, ms in
            guard let self else { return }
            let t = Timer(timeInterval: ms / 1000, repeats: false) { [weak self] _ in
                guard let self else { return }
                self.timers[id] = nil
                self.context?.objectForKeyedSubscript("__fireTimer")?.call(withArguments: [id])
            }
            self.timers[id]?.invalidate()
            self.timers[id] = t
            RunLoop.current.add(t, forMode: .default)
        }
        let cancelTimer: @convention(block) (Int) -> Void = { [weak self] id in
            self?.timers[id]?.invalidate()
            self?.timers[id] = nil
        }
        let random: @convention(block) (Int) -> [NSNumber] = { n in
            var bytes = [UInt8](repeating: 0, count: max(0, n))
            _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            return bytes.map { NSNumber(value: $0) }
        }
        let utf8: @convention(block) ([NSNumber]) -> String = { numbers in
            String(decoding: numbers.map { $0.uint8Value }, as: UTF8.self)
        }
        let parseURL: @convention(block) (String, JSValue) -> JSValue = { input, base in
            let ctx = JSContext.current()!
            let baseURL = base.isNull || base.isUndefined ? nil : URL(string: base.toString())
            // "" against a base is the base itself, as in a browser; URL(string:) says nil
            let resolved = input.isEmpty ? baseURL : URL(string: input, relativeTo: baseURL)?.absoluteURL
            guard let url = resolved,
                  let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let scheme = parts.scheme else { return JSValue(nullIn: ctx) }
            let hostname = parts.percentEncodedHost ?? ""
            let host = hostname + (parts.port.map { ":\($0)" } ?? "")
            var path = parts.percentEncodedPath
            if path.isEmpty && hostname.isEmpty == false { path = "/" }
            let search = parts.percentEncodedQuery.map { $0.isEmpty ? "" : "?" + $0 } ?? ""
            let hash = parts.percentEncodedFragment.map { $0.isEmpty ? "" : "#" + $0 } ?? ""
            let auth = parts.percentEncodedUser.map { u in u + (parts.percentEncodedPassword.map { ":" + $0 } ?? "") + "@" } ?? ""
            let href = "\(scheme)://\(auth)\(host)\(path)\(search)\(hash)"
            return JSValue(object: ["href": href, "protocol": scheme + ":", "username": parts.percentEncodedUser ?? "",
                                    "password": parts.percentEncodedPassword ?? "", "host": host, "hostname": hostname,
                                    "port": parts.port.map(String.init) ?? "", "pathname": path, "search": search, "hash": hash],
                           in: ctx)
        }
        let fetch: @convention(block) (Int, String, String, String, JSValue) -> Void = { [weak self] id, url, method, headersJSON, body in
            let headers = (try? JSONSerialization.jsonObject(with: Data(headersJSON.utf8)) as? [String: String]) ?? [:]
            let text: String? = body.isNull || body.isUndefined ? nil : body.toString()
            Task {
                let reply = await ShellHTTP.answer(url: url, method: method, headers: headers, body: text)
                self?.perform { [weak self] in
                    guard let done = self?.context?.objectForKeyedSubscript("__fetchDone") else { return }
                    if let ok = reply["ok"] as? [String: Any] {
                        let fields = (ok["headers"] as? [String: String]) ?? [:]
                        let json = String(decoding: (try? JSONSerialization.data(withJSONObject: fields)) ?? Data("{}".utf8), as: UTF8.self)
                        done.call(withArguments: [id, ok["status"] as? Int ?? 0, json, ok["body"] as? String ?? "", NSNull()])
                    } else {
                        let message = ((reply["error"] as? [String: Any])?["message"] as? String) ?? "no answer"
                        done.call(withArguments: [id, 0, "{}", NSNull(), message])
                    }
                }
            }
        }
        let today: @convention(block) () -> String = {
            let d = Calendar.current.dateComponents([.year, .month, .day], from: Date())
            return String(format: "%04d-%02d-%02d", d.year ?? 1970, d.month ?? 1, d.day ?? 1)
        }
        // Values, not JSON: Foundation's JSON parser drops a byte-order mark even
        // inside a string, and a file must come back exactly as it was written.
        let filesOp: @convention(block) (String, JSValue) -> JSValue = { [weak self] op, argsValue in
            let ctx = JSContext.current()!
            guard let self else { return JSValue(object: ["error": ["code": "EIO", "message": "no folder"]], in: ctx) }
            let args = (argsValue.toDictionary() as? [String: Any]) ?? [:]
            return JSValue(object: self.files.answer(op: op, args: args), in: ctx)
        }
        let reply: @convention(block) (Int, String) -> Void = { [weak self] id, json in
            guard let self else { return }
            let c = self.lock.withLock { self.waiting.removeValue(forKey: id) }
            let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
            let status = obj["status"] as? Int ?? 500
            let body = (try? JSONSerialization.data(withJSONObject: obj["body"] ?? NSNull(), options: [.fragmentsAllowed])) ?? Data("null".utf8)
            c?.resume(returning: Answer(status: status, body: body))
        }
        let changed: @convention(block) (String) -> Void = { [weak self] json in
            let paths = (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String]) ?? []
            Task { @MainActor [weak self] in self?.onChanged?(paths) }
        }
        let syncStatus: @convention(block) (String) -> Void = { [weak self] json in
            let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
            let box = UncheckedBox(obj)
            Task { @MainActor [weak self] in self?.onSyncStatus?(box.value) }
        }
        let inFront: @convention(block) () -> Bool = { [weak self] in self?.inFront ?? false }
        let ask: @convention(block) (Int, String, String) -> Void = { [weak self] id, op, argsJSON in
            let args = (try? JSONSerialization.jsonObject(with: Data(argsJSON.utf8)) as? [String: Any]) ?? [:]
            let box = UncheckedBox(args)
            Task { @MainActor [weak self] in
                let answer = await self?.onAsk?(op, box.value) ?? NSNull()
                let data = (try? JSONSerialization.data(withJSONObject: answer, options: [.fragmentsAllowed])) ?? Data("null".utf8)
                let json = String(decoding: data, as: UTF8.self)
                self?.perform { [weak self] in
                    _ = self?.context?.objectForKeyedSubscript("__askDone")?.call(withArguments: [id, json])
                }
            }
        }

        for (name, fn) in [("log", log as Any), ("timer", timer), ("cancelTimer", cancelTimer), ("random", random),
                           ("utf8", utf8), ("parseURL", parseURL), ("fetch", fetch), ("today", today),
                           ("files", filesOp), ("reply", reply), ("changed", changed), ("syncStatus", syncStatus),
                           ("inFront", inFront), ("ask", ask)] {
            native.setObject(fn, forKeyedSubscript: name as NSString)
        }
        ctx.setObject(native, forKeyedSubscript: "__native" as NSString)
        context = ctx
        ctx.evaluateScript(prelude, withSourceURL: URL(string: "dvarim://engine/prelude.js"))
        if let fault { return "the engine's prelude failed: \(fault)" }
        ctx.evaluateScript(engine, withSourceURL: URL(string: "dvarim://engine/engine.js"))
        if let fault { return "the engine failed to load: \(fault)" }
        guard ctx.objectForKeyedSubscript("__dvarim")?.isObject == true else { return "the engine did not start" }
        return nil
    }
}

/// A value carried across an actor hop that the type system cannot vouch for:
/// JSON the engine made, read once on the other side.
struct UncheckedBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}
