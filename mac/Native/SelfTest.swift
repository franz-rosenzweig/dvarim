import AppKit
import SwiftUI

/// The app testing itself, the real app against a throwaway server
/// (selftest-native.sh starts one on a copy of sample-vault, with a password of
/// its own): never your vault, never your server. It writes PASS and
/// FAIL lines and a picture of each step, then puts back what it touched: its
/// settings are a suite of its own, its copy a folder of its own, and its
/// sign-in, token and cookies are removed at the end.
///
///   -SelfTest YES -SelfTestServer http://127.0.0.1:8441 -SelfTestPassword … -SelfTestOut DIR
@MainActor
enum SelfTest {
    static var asked: Bool { UserDefaults.standard.bool(forKey: "SelfTest") }
    static let suite = "moe.ptr.dvarim.native.selftest"
    private static var failures = 0
    private static var lines: [String] = []
    private static var step = 0

    static var out: URL {
        URL(fileURLWithPath: UserDefaults.standard.string(forKey: "SelfTestOut") ?? NSTemporaryDirectory(), isDirectory: true)
    }
    static var server: URL { URL(string: UserDefaults.standard.string(forKey: "SelfTestServer") ?? "http://127.0.0.1:8441")! }

    /// Before anything reads a setting: a fresh suite and a folder of the test's own.
    static func prepare() {
        UserDefaults().removePersistentDomain(forName: suite)
        Prefs.store = UserDefaults(suiteName: suite)!
        Prefs.store.set(server.absoluteString, forKey: Prefs.serverKey)
        Prefs.store.set(Mode.copy.rawValue, forKey: Prefs.modeKey)
        Account.appFolder = "Dvarim Native self-test"
        Account.forgetCookies(for: server)
        try? FileManager.default.removeItem(at: appFolder)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    }

    private static var appFolder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Account.appFolder, isDirectory: true)
    }

    static func start() {
        Task { @MainActor in
            await run()
            await cleanUp()
            log(failures == 0 ? "SELFTEST passed" : "SELFTEST \(failures) failed")
            NSApp.terminate(nil)
        }
    }

    // MARK: the run

    private static func run() async {
        let m = AppModel.shared
        log("SELFTEST against \(server.absoluteString)")

        // 1. a fresh start: nobody is signed in, so it asks
        check(await until(15) { if case .signIn = m.phase { true } else { false } }, "a fresh start asks to sign in")
        await snap("sign-in")

        // 2. signing in makes this Mac a copy, synced with the server
        guard let password = UserDefaults.standard.string(forKey: "SelfTestPassword") else {
            return check(false, "a password for the throwaway server (-SelfTestPassword)")
        }
        await m.signIn(password: password, name: nil)
        check(await until(20) { m.phase == .ready }, "signing in opens the app on a copy of its own", "\(m.phase)")
        guard let copy = Account.copy, let token = Account.token(for: copy) else { return check(false, "the copy has a token in the Keychain") }
        check(token.hasPrefix("dvt_"), "the copy's token is kept in the Keychain")
        let tokens = (try? await RemoteBackend(server: server).request("GET", "/api/tokens", body: nil))?["tokens"].array.compactMap { $0["name"].string } ?? []
        check(tokens.contains(copy.device), "the server lists this Mac as a device", tokens.joined(separator: ", "))
        let folder = Account.folder(for: copy)
        check(await until(25) { contains(folder, "Reply about October hours") }, "the copy fills from the server", folder.path)
        check(await until(10) { m.sync.kind == .idle }, "its sync says it is in step", "\(m.sync)")

        // 3. every list, against the server's own answer
        let remote = RemoteBackend(server: server)
        for place in Place.lists {
            m.place = place
            _ = await until(5) { !m.loading }
            await pause(0.4)
            let theirs = (try? await remote.request("GET", place.path, body: nil)).map { Lists.content(place, $0, state: m.state).todoCount } ?? -1
            check(m.content.todoCount == theirs, "\(place.title) shows what the server has", "\(m.content.todoCount) here, \(theirs) there")
            await snap(place.title.lowercased())
        }
        if let p = m.state.looseProjects.first ?? m.state.areas.first?.projects.first {
            m.place = .project(p.id)
            _ = await until(5) { !m.loading }
            await pause(0.4)
            check(!m.content.sections.isEmpty, "a project opens, with its headings", p.name)
            await snap("project")
        }

        // 4. ticking off, and ⌘Z
        m.place = .today
        _ = await until(5) { !m.loading }
        await pause(0.4)
        guard let todo = m.content.allTodos.first(where: \.isOpen) else { return check(false, "an open to-do in Today to tick") }
        await m.complete(todo)
        check(await until(8) { lines(folder).contains { $0.hasPrefix("- [x] \(todo.title)") } }, "ticking it marks it done in the copy's Markdown", todo.title)
        check(await until(25) { await status(todo.id, remote) == "done" }, "and the server has it done after the sync")
        await snap("ticked")
        check(m.undoManager?.canUndo == true, "⌘Z can undo it", m.undoManager?.undoActionName ?? "no undo manager")
        m.undoManager?.undo()
        check(await until(8) { lines(folder).contains { $0.hasPrefix("- [ ] \(todo.title)") } }, "⌘Z reopens it in the copy")
        check(await until(25) { await status(todo.id, remote) == "open" }, "and on the server")

        // 5. someone else writes the folder
        let line = "- [ ] Written by someone else \(Int(Date().timeIntervalSince1970))"
        append(folder.appendingPathComponent("Inbox.md"), line)
        m.place = .inbox
        check(await until(8) { m.content.allTodos.contains { line.hasSuffix($0.title) } }, "a line written into the folder by someone else shows up")
        await snap("written-elsewhere")

        // 6. the folder keeps the storage contract (engine/src/storage-conformance.js)
        if let local = m.backend as? LocalBackend, let answer = try? await local.engine.conformance() {
            let j = J(data: answer.body)
            let failed = j["results"].array.filter { !$0["ok"].bool }.map { "\($0["name"].string ?? ""): \($0["error"].string ?? "")" }
            check(j["ok"].bool, "the folder passes the storage contract's checks", failed.isEmpty ? "\(j["results"].array.count) checks" : failed.joined(separator: "; "))
        } else {
            check(false, "the storage contract's checks ran")
        }

        // 7. Remote: the same lists, asked of the server
        await m.switchMode(.remote)
        check(await until(15) { m.phase == .ready && m.backend is RemoteBackend }, "Remote mode opens on the server")
        m.place = .today
        _ = await until(5) { !m.loading }
        await pause(0.5)
        let there = (try? await remote.request("GET", Place.today.path, body: nil)).map { Lists.content(.today, $0, state: m.state).todoCount } ?? -1
        check(m.content.todoCount == there, "Today in Remote mode is the server's", "\(m.content.todoCount) here, \(there) there")
        if let t = m.content.allTodos.first(where: \.isOpen) {
            await m.complete(t)
            check(await until(5) { await status(t.id, remote) == "done" }, "ticking it in Remote mode is done on the server at once")
            check(m.undoManager?.canUndo == true, "⌘Z can undo it there too", m.undoManager.map { "\($0.undoActionName), \($0.groupingLevel) open groups" } ?? "no undo manager")
            m.undoManager?.undo()
            check(await until(5) { await status(t.id, remote) == "open" }, "and ⌘Z reopens it there")
            check(m.undoManager?.canRedo == true, "⇧⌘Z can redo it", m.undoManager?.redoActionName ?? "")
            m.undoManager?.redo()
            check(await until(5) { await status(t.id, remote) == "done" }, "⇧⌘Z completes it again")
            m.undoManager?.undo()
            check(await until(5) { await status(t.id, remote) == "open" }, "and ⌘Z once more reopens it")
        }
        await snap("remote")

        // 8. signing out, from the copy: the token, the copy and the sign-in go
        await m.switchMode(.copy)
        _ = await until(15) { m.phase == .ready }
        let gone = await m.signOut()
        check(gone == nil, "signing out of the copy syncs and goes", gone ?? "")
        check(Account.copy == nil && !FileManager.default.fileExists(atPath: folder.path), "the copy and its token are gone from this Mac")
        check((HTTPCookieStorage.shared.cookies ?? []).allSatisfy { $0.domain != server.host }, "and so is the sign-in")
        if case .signIn = m.phase { check(true, "and it asks to sign in again") } else { check(false, "and it asks to sign in again", "\(m.phase)") }
        await snap("signed-out")
    }

    private static func cleanUp() async {
        if let copy = Account.copy { await Account.dropCopy(copy, trash: false) }
        Account.forgetCookies(for: server)
        try? FileManager.default.removeItem(at: appFolder)
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Preferences/\(suite).plist"))
    }

    // MARK: helpers

    private static func status(_ id: String, _ remote: RemoteBackend) async -> String? {
        (try? await remote.request("GET", "/api/todos/\(id)", body: nil))?["status"].string
    }

    static func lines(_ dir: URL) -> [String] {
        var out: [String] = []
        let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)
        while let u = e?.nextObject() as? URL {
            guard u.pathExtension == "md", !u.path.contains("/.") else { continue }
            out += ((try? String(contentsOf: u, encoding: .utf8)) ?? "").components(separatedBy: "\n")
        }
        return out
    }

    static func contains(_ dir: URL, _ needle: String) -> Bool { lines(dir).contains { $0.contains(needle) } }

    static func append(_ url: URL, _ line: String) {
        let text = ((try? String(contentsOf: url, encoding: .utf8)) ?? "")
        try? (text + (text.hasSuffix("\n") || text.isEmpty ? "" : "\n") + line + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    static func until(_ seconds: Double, _ cond: () async -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(seconds)
        repeat { if await cond() { return true }; await pause(0.2) } while Date() < end
        return false
    }

    static func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }

    static func check(_ ok: Bool, _ what: String, _ detail: String = "") {
        log((ok ? "PASS  " : "FAIL  ") + what + (detail.isEmpty ? "" : "  [\(detail)]"))
        if !ok { failures += 1 }
    }

    static func log(_ s: String) {
        lines.append(s)
        FileHandle.standardError.write(Data((s + "\n").utf8))
        try? lines.joined(separator: "\n").appending("\n").write(to: out.appendingPathComponent("log.txt"), atomically: true, encoding: .utf8)
    }

    /// A picture of the window as it is on screen, glass and selection and
    /// all, from the window server: an app may picture its own windows without
    /// the Screen Recording permission. A sheet is a window of its own, so it
    /// gets a picture of its own. cacheDisplay is the fallback, and it leaves
    /// out glass and draws a selected sidebar row as a black bar.
    static func snap(_ name: String) async {
        await pause(0.35)
        step += 1
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && !($0 is NSPanel) }) else { return }
        for (suffix, w) in [("", window), ("-sheet", window.attachedSheet)] {
            guard let w else { continue }
            let file = out.appendingPathComponent(String(format: "%02d-%@%@.png", step, name, suffix))
            if let image = windowImage(CGWindowID(w.windowNumber)) {
                try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: file)
                continue
            }
            guard let view = w.contentView?.superview ?? w.contentView,
                  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: file)
        }
    }

    /// CGWindowListCreateImage, looked up at run time: the macOS 26 SDK calls it
    /// unavailable in favour of ScreenCaptureKit, which would ask for the
    /// Screen Recording permission, but the function is still there and still
    /// pictures an app's own windows without asking.
    private static func windowImage(_ id: CGWindowID) -> CGImage? {
        typealias Create = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
        let create = unsafeBitCast(sym, to: Create.self)
        // optionIncludingWindow (1 << 3); boundsIgnoreFraming (1 << 0) | bestResolution (1 << 3)
        return create(.null, 1 << 3, id, (1 << 0) | (1 << 3))?.takeRetainedValue()
    }
}
