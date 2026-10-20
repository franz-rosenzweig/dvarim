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

        // 5b. round 2: a to-do made, typed into, and changed every way, each undone
        await editing(m, folder)

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

    // MARK: round 2: editing

    private static func editing(_ m: AppModel, _ folder: URL) async {
        let todayISO = m.state.today
        m.place = .inbox
        _ = await until(5) { !m.loading }
        await pause(0.4)

        // ⌘N: a to-do in the Inbox, open to type in
        await m.newTodo()
        guard let id = m.openId, m.newId == id else { return check(false, "⌘N makes a to-do and opens its card") }
        check(true, "⌘N makes a to-do and opens its card")
        check(await until(6) { line(folder, id)?.text.contains("New To-Do") == true }, "it is a line in the Inbox's Markdown", line(folder, id)?.file ?? "nowhere")
        await snap("new-card")
        type("Buy bread")
        await pause(0.4)
        m.close()
        check(await until(6) { line(folder, id)?.text.contains("Buy bread") == true }, "what was typed is its title once the card closes")
        await snap("typed")
        m.undoManager?.undo()
        check(await until(6) { line(folder, id)?.text.contains("New To-Do") == true }, "⌘Z takes the title back")
        m.undoManager?.redo()
        check(await until(6) { line(folder, id)?.text.contains("Buy bread") == true }, "⇧⌘Z gives it again")

        // each change, then ⌘Z
        func step(_ what: String, _ change: () async -> Void, _ done: @escaping (Found) -> Bool, _ undone: @escaping (Found) -> Bool) async {
            m.selectOnly(id)
            await change()
            check(await until(6) { line(folder, id).map(done) == true }, what, line(folder, id)?.text ?? "gone")
            m.undoManager?.undo()
            check(await until(6) { line(folder, id).map(undone) == true }, "and ⌘Z undoes it", line(folder, id)?.text ?? "gone")
        }
        await step("⌘T puts it in Today", { await m.setWhen(.today) }, { $0.text.contains("⏳ \(todayISO)") }, { !$0.text.contains("⏳") })
        await step("⌘E puts it in This Evening", { await m.setWhen(.evening) }, { $0.text.contains("🌙") }, { !$0.text.contains("🌙") })
        let later = Dates.iso.string(from: Calendar.current.date(byAdding: .day, value: 9, to: Date())!)
        await step("a deadline is set", { await m.setDeadline(later) }, { $0.text.contains("📅 \(later)") }, { !$0.text.contains("📅") })
        await step("a tag is added", { if let t = m.todo(id) { await m.setTags(["errand"], for: t) } }, { $0.text.contains("#errand") }, { !$0.text.contains("#errand") })
        await step("a checklist is added", {
            if let t = m.todo(id) { await m.setChecklist([ChecklistItem(text: "Flour", done: false), ChecklistItem(text: "Yeast", done: false)], for: t) }
        }, { $0.under.contains("    - [ ] Flour") && $0.under.contains("    - [ ] Yeast") }, { !$0.under.contains { $0.contains("Flour") } })
        await step("⌥⌘K cancels it", { await m.cancelChosen() }, { $0.text.hasPrefix("- [-]") }, { $0.text.hasPrefix("- [ ]") })
        if let p = m.state.looseProjects.first ?? m.state.areas.first?.projects.first {
            await step("⇧⌘M moves it to \(p.name)", { await m.move(to: .project(p.id), named: p.name) },
                       { $0.file.hasSuffix("\(p.name).md") }, { $0.file == "Inbox.md" })
        }
        await step("⌫ moves it to the Trash", { await m.trashChosen() }, { $0.file == "Trash.md" }, { $0.file == "Inbox.md" })
        m.selectOnly(id)
        await m.duplicateChosen()
        check(await until(6) { lines(folder).filter { $0.contains("Buy bread") }.count == 2 }, "⌘D duplicates it")
        m.undoManager?.undo()
        check(await until(6) { liveLines(folder).filter { $0.contains("Buy bread") && $0.hasPrefix("- [") }.count == 1 }, "and ⌘Z takes the copy away, to the Trash")

        // ⌘↓: one step down the Inbox, and back
        m.place = .inbox
        _ = await until(5) { !m.loading }
        await pause(0.4)
        let before = inboxOrder(folder)
        if before.count >= 2 {
            m.selectOnly(before[0])
            await m.shift(1)
            check(await until(6) { inboxOrder(folder).prefix(2) == [before[1], before[0]] }, "⌘↓ moves it down a place")
            m.undoManager?.undo()
            check(await until(6) { inboxOrder(folder) == before }, "and ⌘Z puts it back")
        }

        // the pickers, pictured
        m.selectOnly(id)
        for (name, pop) in [("when", AppModel.Popover.when(id)), ("deadline", .deadline(id)), ("tags", .tags(id)), ("move", .move(id))] {
            m.popover = pop
            await pause(0.6)
            await snap("picker-" + name)
            m.popover = nil
            await pause(0.2)
        }
        // the card from the keyboard: ↓ to choose, Return to open
        m.selected = []
        m.anchor = nil
        m.step(1, extend: false)
        check(m.anchor != nil, "↓ chooses the first row")
        if let a = m.anchor, a.hasPrefix("t:") {
            m.open(String(a.dropFirst(2)))
            await snap("card")
            check(m.openId == String(a.dropFirst(2)), "and Return opens it")
            m.close()
        }
    }

    struct Found {
        let file: String
        let text: String
        let under: [String]
    }

    /// The to-do's line, wherever it is now, and the indented lines under it.
    static func line(_ dir: URL, _ id: String) -> Found? {
        let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)
        while let u = e?.nextObject() as? URL {
            guard u.pathExtension == "md", !u.path.contains("/.") else { continue }
            let all = ((try? String(contentsOf: u, encoding: .utf8)) ?? "").components(separatedBy: "\n")
            guard let i = all.firstIndex(where: { $0.contains("🆔 \(id)") }) else { continue }
            let under = all[(i + 1)...].prefix { $0.hasPrefix("    ") || $0.hasPrefix("\t") }
            return Found(file: String(u.path.dropFirst(dir.path.count + 1)), text: all[i], under: Array(under))
        }
        return nil
    }

    /// Every line but the Trash's.
    static func liveLines(_ dir: URL) -> [String] {
        var out: [String] = []
        let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)
        while let u = e?.nextObject() as? URL {
            guard u.pathExtension == "md", !u.path.contains("/."), u.lastPathComponent != "Trash.md", !u.path.contains("/Trash/") else { continue }
            out += ((try? String(contentsOf: u, encoding: .utf8)) ?? "").components(separatedBy: "\n")
        }
        return out
    }

    static func inboxOrder(_ dir: URL) -> [String] {
        let text = (try? String(contentsOf: dir.appendingPathComponent("Inbox.md"), encoding: .utf8)) ?? ""
        return text.components(separatedBy: "\n").filter { $0.hasPrefix("- [ ]") }
            .compactMap { line -> String? in
                guard let r = line.range(of: "🆔 ") else { return nil }
                return String(line[r.upperBound...].prefix { !$0.isWhitespace })
            }
    }

    /// Keys as the keyboard sends them, into whatever has the keyboard.
    static func type(_ text: String) {
        // the keys go to the key window: be it, whatever else is in front
        NSApp.activate()
        let main = NSApp.windows.first { $0.isVisible && $0.canBecomeKey && !$0.className.contains("Popover") }
        main?.makeKeyAndOrderFront(nil)
        if let editor = (NSApp.keyWindow ?? main)?.firstResponder as? NSTextView {
            editor.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
            return
        }
        guard let w = NSApp.keyWindow ?? main else { return }
        for ch in text {
            for kind in [NSEvent.EventType.keyDown, .keyUp] {
                if let e = NSEvent.keyEvent(with: kind, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: w.windowNumber, context: nil, characters: String(ch),
                                            charactersIgnoringModifiers: String(ch), isARepeat: false, keyCode: ch == " " ? 49 : 0) {
                    NSApp.postEvent(e, atStart: false)
                }
            }
        }
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
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && !($0 is NSPanel) && !$0.className.contains("Popover") }) else { return }
        let popovers = NSApp.windows.filter { $0.isVisible && $0.className.contains("Popover") }
        let extra: [(String, NSWindow?)] = popovers.enumerated().map { ("-popover\($0.offset + 1)", Optional($0.element)) }
        for (suffix, w) in [("", window), ("-sheet", window.attachedSheet)] + extra {
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
