import AppKit
import ServiceManagement
import SwiftUI
import UserNotifications
import WebKit

/// Called from hook.c before main: start once the app has launched.
@_cdecl("selftest_install")
public func selftestInstall() {
    NotificationCenter.default.addObserver(forName: NSApplication.didFinishLaunchingNotification,
                                           object: nil, queue: .main) { _ in
        Task { @MainActor in await SelfTest.run() }
    }
}

/// Drives the real app from inside. Keys are genuine NSEvents posted to the app's
/// own queue, so a key equivalent takes the same path as a keypress: the key
/// window's views first (the web view hands it to the page), then the menu bar.
/// Results are checked against the server, and pictures land in -SelfTestOut.
@MainActor
enum SelfTest {
    static var failures = 0
    static var outDir: URL {
        URL(fileURLWithPath: UserDefaults.standard.string(forKey: "SelfTestOut") ?? NSTemporaryDirectory())
    }

    /// -SelfTestOnly keys,quick,… runs some sections; auth runs only with -SelfTestSession.
    static func wants(_ part: String) -> Bool {
        if part == "auth" && UserDefaults.standard.string(forKey: "SelfTestSession") == nil { return false }
        guard let only = UserDefaults.standard.string(forKey: "SelfTestOnly") else { return true }
        return only.split(separator: ",").contains { $0 == part }
    }

    static func run() async {
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        log("SELFTEST against \(Defaults.server.absoluteString)")
        _ = await until(10) { NSApp.isActive && !appWindows.isEmpty }
        guard let w1 = appWindows.first, let web1 = web(w1) else { check(false, "a window with the web app opened"); return finish() }
        _ = await until(20) { await page(web1) != "loading" }
        check(await page(web1) != "loading", "the web app loads in the window", await page(web1))
        await snap(web1, "01-window")
        dumpMenus()

        if wants("auth") { await auth(web1) }
        if wants("layout") { await layout(w1, web1) }
        if wants("menus") { await menus(web1) }
        if wants("slim") { await slim(w1, web1) }
        if wants("keys") { await keys(w1, web1) }
        if wants("quick") { await quick() }
        if wants("badge") { await badge() }
        if wants("reminders") { await reminders() }
        if wants("menubar") { await menubar() }
        if wants("intents") { await intents() }
        if wants("offline") { await offline() }
        if wants("hotkey") { hotkey() }
        if wants("settings") { await settings() }
        if wants("notes") { await notes(w1, web1) }
        if wants("folder") { await folder() }
        if wants("sync") { await sync() }
        if wants("calendars") { await calendars() }
        if wants("local") { await local() }
        if wants("copy") { await copy() }
        finish()
    }

    static func finish() {
        log(failures == 0 ? "SELFTEST passed" : "SELFTEST \(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }

    // MARK: sections

    /// The menu bar is a view onto the web app's keymap rather than a second
    /// copy of it: items run by id through window.dvarim, so a rebinding in
    /// Settings -> Keyboard moves the key without breaking the menu. Checks that
    /// the door is there, that the newest commands arrived through it, and that
    /// choosing one actually moves the page.
    /// Folder mode (docs/BRIDGE.md): the page from inside the app, on a copy of
    /// sample-vault in a temporary folder, reading and writing it through
    /// FolderBridge. The mode is set in the argument domain, never saved, so the
    /// real app does not find itself on a temporary folder afterwards; and it is
    /// put back at the end, with the windows, so the server is what is left.
    static func folder() async {
        guard Vault.webBundle != nil else {
            return check(false, "the web app is inside the app (build.sh copies frontend/dist)")
        }
        guard let sample = UserDefaults.standard.string(forKey: "SelfTestSample") else {
            return log("SKIP  folder: no -SelfTestSample")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dvarim-selftest-folder-\(UUID().uuidString.prefix(8))")
        do { try FileManager.default.copyItem(at: URL(fileURLWithPath: sample), to: root) } catch {
            return check(false, "a copy of sample-vault to work on", error.localizedDescription)
        }
        let inbox = root.appendingPathComponent("Inbox.md")
        let saved = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        var args = saved
        args[Vault.modeKey] = "folder"
        args[Vault.folderKey] = root.path
        UserDefaults.standard.setVolatileDomain(args, forName: UserDefaults.argumentDomain)
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
        defer {
            UserDefaults.standard.setVolatileDomain(saved, forName: UserDefaults.argumentDomain)
            try? FileManager.default.removeItem(at: root)
        }

        func folderPage() async -> WKWebView? {
            guard let web = appWindows.first.flatMap(web), web.url?.scheme == AppScheme.scheme else { return nil }
            return await page(web) == "app" ? web : nil
        }
        _ = await until(20) { await folderPage() != nil }
        guard let view = await folderPage() else {
            return check(false, "in folder mode the window serves the page from inside the app",
                         appWindows.first.flatMap(web)?.url?.absoluteString ?? "no window")
        }
        check(true, "in folder mode the window serves the page from inside the app", view.url?.absoluteString ?? "")
        await snap(view, "09-folder")

        // the checks every shell must pass (engine/src/storage-conformance.js)
        let r = try? await view.callAsyncJavaScript("return await window.__dvarimLocal.conformance()",
                                                    contentWorld: .page) as? [String: Any]
        let results = r?["results"] as? [[String: Any]] ?? []
        let failed = results.filter { $0["ok"] as? Bool != true }.map { "\($0["name"] ?? "?"): \($0["error"] ?? "")" }
        let ms = results.compactMap { ($0["ms"] as? NSNumber)?.doubleValue }.reduce(0, +)
        check(r?["ok"] as? Bool == true, "the folder passes the bridge's conformance checks",
              failed.isEmpty ? "\(results.count) checks, \(Int(ms)) ms" : failed.joined(separator: "; "))

        // -SelfTestCompare: the server at -serverURL runs on a copy of the same
        // files, so the engine in the page and the server must say the same
        if UserDefaults.standard.bool(forKey: "SelfTestCompare") {
            for path in ["/api/state", "/api/lists/inbox", "/api/lists/today", "/api/lists/upcoming", "/api/lists/anytime", "/api/lists/someday"] {
                let local = try? await view.callAsyncJavaScript("return (await window.dvarim.request('GET', path)).body",
                                                                arguments: ["path": path], contentWorld: .page)
                let remote = await api(String(path.dropFirst()))
                let a = summary(local), b = summary(remote)
                check(a == b, "on the same files the page and the server agree about \(path)", a == b ? a : "page \(a) / server \(b)")
            }
        }

        // the Inbox is the file's
        _ = await js(view, "window.dvarim.run('go.inbox'); 'ok'")
        let lines = ((try? String(contentsOf: inbox, encoding: .utf8)) ?? "").split(separator: "\n").filter { $0.hasPrefix("- [ ]") }.count
        let shown = await until(5) { await js(view, "String(document.querySelectorAll('[data-todo-id]').length)") == String(lines) }
        check(shown, "the Inbox shows what Inbox.md holds", "\(lines) open lines in the file")

        // someone else writes the folder: FSEvents tells the page
        if let handle = try? FileHandle(forWritingTo: inbox) {
            handle.seekToEndOfFile()
            handle.write(Data("- [ ] From the selftest\n".utf8))
            try? handle.close()
        }
        let seen = await until(3) { await js(view, "String([...document.querySelectorAll('[data-todo-id] .txt')].some(e => e.textContent.trim() === 'From the selftest'))") == "true" }
        check(seen, "a line written into the file by someone else is in the window within a moment, with no click")

        // the way Syncthing (and Obsidian) save: a temporary file beside it,
        // renamed over it
        let temp = root.appendingPathComponent(".syncthing.Inbox.md.tmp")
        let synced = ((try? String(contentsOf: inbox, encoding: .utf8)) ?? "") + "- [ ] Brought by Syncthing\n"
        try? Data(synced.utf8).write(to: temp)
        _ = rename(temp.path, inbox.path)
        let brought = await until(3) { await js(view, "String([...document.querySelectorAll('[data-todo-id] .txt')].some(e => e.textContent.trim() === 'Brought by Syncthing'))") == "true" }
        check(brought, "and so is one saved the way Syncthing saves, a temporary file renamed over it")

        // the page writes the folder, and only the folder
        // window.dvarim.request answers {status, body}, as a server would
        let made = try? await view.callAsyncJavaScript(
            "return await window.dvarim.request('POST', '/api/todos', {title: 'Made in folder mode', inbox: true})",
            contentWorld: .page) as? [String: Any]
        let text = { (try? String(contentsOf: inbox, encoding: .utf8)) ?? "" }
        let landed = await until(3) { text().contains("- [ ] Made in folder mode") }
        check(landed, "a to-do made in the app is a line in Inbox.md", "status \(made?["status"] ?? "none")")
        if let id = (made?["body"] as? [String: Any])?["id"] as? String {
            let done = try? await view.callAsyncJavaScript("return await window.dvarim.request('POST', '/api/todos/' + id + '/complete', {})",
                                                           arguments: ["id": id], contentWorld: .page) as? [String: Any]
            let line = { text().split(separator: "\n").first { $0.contains("Made in folder mode") }.map(String.init) ?? "" }
            _ = await until(3) { line().hasPrefix("- [x] ") }
            check(line().hasPrefix("- [x] ") && line().contains("✅ "), "ticked, it is [x] with its ✅ date in the file",
                  "\(line()) — status \(done?["status"] ?? "none") \(done?["body"].map { "\($0)" } ?? "")")
        }
        let onServer = ((await api("api/search?q=Made%20in%20folder%20mode")) as? [String: Any])?["todos"] as? [[String: Any]] ?? []
        check(onServer.isEmpty, "and none of it reached the server")

        // a reload on a project comes back to that project: the first there is
        let project = await js(view, "(() => { const p = document.querySelector('.sidebar [data-drop-project]'); p?.click(); return p ? '/project/' + p.dataset.dropProject : '' })()")
        if project.isEmpty {
            log("SKIP  reload on a project: no project in this folder")
        } else {
            _ = await until(5) { await js(view, "location.pathname") == project }
            NotificationCenter.default.post(name: .dvarimReload, object: nil)
            await pause(1)
            let back = await until(10) {
                guard let w = await folderPage() else { return false }
                return await js(w, "location.pathname") == project
            }
            check(back, "Reload on a project comes back to that project", project)
        }

        // a second window, on the same folder
        let count = appWindows.count
        Windows.open?("/inbox")
        let second = await until(10) {
            guard appWindows.count > count, let w = appWindows.last.flatMap(web), w.url?.scheme == AppScheme.scheme else { return false }
            return await page(w) == "app"
        }
        check(second, "a new window opens on the folder too", appWindows.last.flatMap(web)?.url?.absoluteString ?? "")
        if appWindows.count > count { appWindows.last?.close() }

        // the page's own Settings → Data → Use a server instead…: the shell's mode
        // becomes the server, and is saved, so a relaunch keeps it. The saved
        // mode is put back afterwards, whatever it was.
        let domain = Bundle.main.bundleIdentifier ?? ""
        let keptMode = UserDefaults.standard.persistentDomain(forName: domain)?[Vault.modeKey]
        if let w = await folderPage() {
            _ = await js(w, "window.dvarim.run('settings.open'); 'ok'")
            _ = await until(3) { await js(w, "String(!!document.querySelector('.panes'))") == "true" }
            _ = await js(w, "[...document.querySelectorAll('.panes button')].find(b => /data/i.test(b.textContent))?.click(); 'ok'")
            _ = await until(3) { await js(w, "String([...document.querySelectorAll('button')].some(b => b.textContent.includes('Use a server instead')))") == "true" }
            _ = await js(w, "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Use a server instead'))?.click(); 'ok'")
            _ = await until(3) { await js(w, "String(!!document.querySelector('.menu .opt'))") == "true" }
            _ = await js(w, "[...document.querySelectorAll('.menu .opt')].find(o => /Use a server/.test(o.textContent))?.click(); 'ok'")
            let saved = await until(3) { UserDefaults.standard.persistentDomain(forName: domain)?[Vault.modeKey] as? String == "server" }
            check(saved, "the page's Use a server instead… switches the app to the server, and it is saved for next time")
        }
        var persistent = UserDefaults.standard.persistentDomain(forName: domain) ?? [:]
        persistent[Vault.modeKey] = keptMode
        UserDefaults.standard.setPersistentDomain(persistent, forName: domain)

        // back to the server, for whatever runs next and for the app itself
        UserDefaults.standard.setVolatileDomain(saved, forName: UserDefaults.argumentDomain)
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
        let server = await until(15) {
            guard let w = appWindows.first.flatMap(web), w.url?.scheme != AppScheme.scheme else { return false }
            return await page(w) != "loading"
        }
        check(server, "and back on the server, the window is the server's page again")
    }

    /// The Markdown shortcuts in a to-do's notes (#77), pressed as keys, so
    /// they take the same path a keypress does: a chord with ⌃ goes to the menu
    /// bar first (ShellWebView), anything else to the page first. A menu that
    /// claimed one of them would leave its line unformatted. Each shortcut gets
    /// a line of its own; the notes are read back from the server.
    static func notes(_ w1: NSWindow, _ web1: WKWebView) async {
        guard let todo = await post("api/todos", ["title": "Selftest note shortcuts", "inbox": true]),
              let id = todo["id"] as? String else { return check(false, "a to-do to write notes in") }
        w1.makeKeyAndOrderFront(nil)
        NSApp.activate()
        _ = await js(web1, "window.dvarim.run('go.inbox'); 'ok'")
        let row = "document.querySelector('[data-todo-id=\"\(id)\"]')"
        _ = await until(8) { await js(web1, "String(!!\(row))") == "true" }
        _ = await js(web1, "(() => { const r = \(row); r.click(); r.click(); return 'ok' })()")
        let cm = "document.querySelector('.card .notesfield .cm-content')"
        guard await until(8, { await js(web1, "String(!!\(cm))") == "true" }) else {
            return check(false, "its card opens, with the notes editor")
        }
        _ = await js(web1, "\(cm).focus(); 'ok'")
        await pause(0.3)

        let cmd: NSEvent.ModifierFlags = .command
        func key(_ k: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags) async { press(k, code, flags); await pause(0.2) }
        func text(_ t: String) async { type(t); await pause(0.2) }
        func endOfLine() async { await key("\u{F703}", 124, cmd) }             // ⌘→, out of any marks
        func nextLine() async { await endOfLine(); await key("\r", 36, .shift) } // ⇧↩: a new line, no list carried on
        // an inline format, with nothing selected: the marks, then the text between them
        func wrap(_ k: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags, _ t: String) async {
            await key(k, code, flags); await text(t); await nextLine()
        }
        // a line format: the text, then the format
        func line(_ t: String, _ k: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags) async {
            await text(t); await key(k, code, flags); await nextLine()
        }
        var expected: [(String, String)] = []           // (the shortcut, the line it should make)
        await wrap("b", 11, cmd, "b"); expected.append(("⌘B", "**b**"))
        await wrap("i", 34, cmd, "i"); expected.append(("⌘I", "*i*"))
        await wrap("u", 32, [cmd, .shift], "h"); expected.append(("⇧⌘U", "==h=="))
        await wrap("u", 32, [cmd, .option], "s"); expected.append(("⌥⌘U", "~~s~~"))
        await wrap("j", 38, [cmd, .shift], "c"); expected.append(("⇧⌘J", "`c`"))
        await line("q", "'", 39, cmd); expected.append(("⌘'", "> q"))
        await line("l", "l", 37, [cmd, .shift]); expected.append(("⇧⌘L", "- l"))
        await line("n", "l", 37, [cmd, .option]); expected.append(("⌥⌘L", "1. n"))
        await line("t", "l", 37, [cmd, .control]); expected.append(("⌃⌘L", "- [ ] t"))
        for (n, code) in zip(1...6, [18, 19, 20, 21, 23, 22] as [UInt16]) {
            await line("h\(n)", "\(n)", code, [cmd, .control])
            expected.append(("⌃⌘\(n)", String(repeating: "#", count: n) + " h\(n)"))
        }
        await wrap("k", 40, [cmd, .shift], "u"); expected.append(("⇧⌘K", "[](u)"))
        await text("x"); await key("j", 38, [cmd, .option, .shift])
        expected.append(("⌥⇧⌘J", "```")); expected.append(("⌥⇧⌘J", "x")); expected.append(("⌥⇧⌘J", "```"))

        _ = await js(web1, "document.activeElement && document.activeElement.blur(); 'ok'")
        var got: [String] = []
        _ = await until(5) {
            let items = ((await api("api/lists/inbox")) as? [String: Any])?["items"] as? [[String: Any]] ?? []
            got = ((items.first { $0["id"] as? String == id })?["notes"] as? String ?? "").components(separatedBy: "\n")
            return got.count >= expected.count
        }
        let wrong = expected.enumerated().filter { i, e in i >= got.count || got[i] != e.1 }.map { i, e in
            "\(e.0) made \(i < got.count ? got[i] : "nothing"), not \(e.1)"
        }
        check(wrong.isEmpty, "every Markdown shortcut in the notes reaches the page, none taken by a menu",
              wrong.isEmpty ? "\(expected.count) lines" : wrong.joined(separator: "; "))
        _ = await js(web1, "document.querySelector('.card .x, .card [aria-label=Close]')?.click(); 'ok'")
        escape()
    }

    /// What a list or the state says, short enough to compare and to print:
    /// counts, and the titles and names in order.
    static func summary(_ json: Any?) -> String {
        guard let o = json as? [String: Any] else { return "nothing" }
        if let counts = o["counts"] as? [String: Any] {
            let areas = (o["areas"] as? [[String: Any]] ?? []).map { a in
                "\(a["name"] ?? "")(\((a["projects"] as? [[String: Any]] ?? []).map { "\($0["name"] ?? "")" }.joined(separator: ",")))"
            }
            return "counts \(counts.keys.sorted().map { "\($0)=\(counts[$0]!)" }.joined(separator: " ")); areas \(areas.joined(separator: "; "))"
        }
        let items = (o["items"] as? [[String: Any]] ?? []).map { "\($0["title"] ?? "")" }
        let days = (o["days"] as? [[String: Any]] ?? []).map { d in "\(d["date"] ?? ""):\((d["items"] as? [Any])?.count ?? 0)" }
        return "\(items.count) items [\(items.joined(separator: " | "))]" + (days.isEmpty ? "" : " days \(days.joined(separator: " "))")
    }

    static func menus(_ web1: WKWebView) async {
        let tops = (NSApp.mainMenu?.items ?? []).map { $0.title }
        check(tops.contains("Go") && tops.contains("To-Do"), "the Go and To-Do menus exist",
              tops.joined(separator: ", "))

        let bridge = await js(web1, "typeof window.dvarim")
        check(bridge == "object", "the web app answers on window.dvarim", bridge)
        let known = await js(web1, "window.dvarim ? window.dvarim.commands().length : 0")
        check((Int(known) ?? 0) >= 30, "the keymap comes back through it", "\(known) commands")

        let todo = (NSApp.mainMenu?.items ?? []).first { $0.title == "To-Do" }?.submenu?.items ?? []
        let titles = todo.map { $0.title }
        for wanted in ["Repeat…", "Log Completed Items", "Move Up", "When…"] {
            check(titles.contains(wanted), "To-Do carries \(wanted)", titles.joined(separator: " · "))
        }
        // Reload moved off ⇧⌘R when the web app took it for Repeat…
        let repeatItem = todo.first { $0.title == "Repeat…" }
        check(repeatItem?.keyEquivalent == "r"
              && repeatItem?.keyEquivalentModifierMask == [.command, .shift], "Repeat… is ⇧⌘R")

        // And choosing one runs it, which is the only part that can rot quietly.
        Dvarim.run("go.inbox")
        let landed = await until(5) { await js(web1, "location.pathname") == "/inbox" }
        check(landed, "choosing Go -> Inbox moves the page", await js(web1, "location.pathname"))
    }

    /// The sidebar put away. The page puts it away and says so; the shell gives
    /// the room back, by narrowing the window from the right. Both halves, and
    /// that they undo each other exactly.
    static func slim(_ w1: NSWindow, _ web1: WKWebView) async {
        let view = (NSApp.mainMenu?.items ?? []).first { $0.title == "View" }?.submenu?.items ?? []
        let item = view.first { $0.title == "Show or Hide Sidebar" }
        check(item?.keyEquivalent == "/" && item?.keyEquivalentModifierMask == [.command],
              "View carries Show or Hide Sidebar, ⌘/", view.map { $0.title }.joined(separator: " · "))

        _ = await js(web1, "try { localStorage.removeItem('dvarim.slim') } catch (e) {}")
        let before = w1.frame
        let sidebar = Double(await js(web1, "document.querySelector('.sidebar').offsetWidth")) ?? 0
        check(sidebar > 100, "the sidebar is showing to begin with", "\(sidebar)pt wide")

        Dvarim.run("sidebar.toggle")
        let away = await until(5) { await js(web1, "String(document.querySelector('.app').classList.contains('slim'))") == "true" }
        check(away, "choosing it puts the sidebar away in the page")
        let narrowed = await until(4) { abs(w1.frame.width - (before.width - sidebar)) < 2 || w1.frame.width <= SlimWindow.floor + 1 }
        check(narrowed, "and the window gives up the sidebar's width",
              "\(Int(before.width)) -> \(Int(w1.frame.width)), sidebar \(Int(sidebar))")
        check(abs(w1.frame.minX - before.minX) < 1, "from the right: its left edge has not moved",
              "\(before.minX) -> \(w1.frame.minX)")
        let title = await js(web1, "getComputedStyle(document.querySelector('.topbar .wtitle .name')).opacity")
        _ = await until(2) { await js(web1, "getComputedStyle(document.querySelector('.topbar .wtitle .name')).opacity") == "1" }
        check(await js(web1, "getComputedStyle(document.querySelector('.topbar .wtitle .name')).opacity") == "1",
              "with the sidebar away, the bar says which list this is", "opacity \(title)")
        await snap(web1, "02-slim")

        Dvarim.run("sidebar.toggle")
        let back = await until(5) { abs(w1.frame.width - before.width) < 2 }
        check(back, "choosing it again gives the window exactly that width back",
              "\(Int(w1.frame.width)) against \(Int(before.width))")
        check(await js(web1, "String(document.querySelector('.app').classList.contains('slim'))") == "false",
              "and the sidebar is showing again")
    }

    static func keys(_ w1: NSWindow, _ web1: WKWebView) async {
        if NSApp.keyWindow == nil { NSApp.activate(); await pause(2) }
        guard NSApp.keyWindow != nil else {
            return check(false, "Dvarim gets the keyboard for the key tests", "another app kept it; leave the Mac alone and rerun")
        }
        // ⌘N reaches the web app as New To-Do, before anyone clicks into the page.
        var n = await openTodos("New To-Do").count
        press("n", 45, .command); await pause(1.5)
        check(await openTodos("New To-Do").count == n + 1, "⌘N straight after launch adds a to-do in the web app")
        check(appWindows.count == 1, "⌘N does not open a window")

        // ⌃⌘N is New Window, and never also a to-do, whatever the
        // page is doing. Before ShellWebView it depended on exactly that.
        for state in ["editing a to-do", "idle", "showing its Settings"] {
            if state == "idle" { escape(); escape(); await pause(0.4) }
            if state == "showing its Settings" {
                press(",", 43, .command); await pause(0.8)
                check(await js(web1, "String(!!document.querySelector('[role=dialog][aria-label=Settings]'))") == "true",
                      "⌘, opens the web app's Settings")
            }
            n = await openTodos("New To-Do").count
            press("n", 45, [.command, .control]); await pause(2)
            check(appWindows.count == 2, "⌃⌘N opens a new window while the page is \(state)", "windows: \(appWindows.count)")
            check(await openTodos("New To-Do").count == n, "⌃⌘N does not reach the page while it is \(state)")
            if let w2 = appWindows.first(where: { $0 != w1 }), let web2 = web(w2) {
                _ = await until(15) { await page(web2) != "loading" }
                if state == "idle" { check(await page(web2) != "loading", "the new window loads the web app") }
                w2.close(); await pause(0.6)
            }
            w1.makeKeyAndOrderFront(nil); await pause(0.4)
        }
        escape(); escape(); await pause(0.4)

        press("f", 3, .command); await pause(0.8)
        check(await js(web1, "String(!!document.querySelector('.qf'))") == "true", "⌘F reaches the page (Quick Find)")
        escape(); await pause(0.4)
        press("1", 18, .command); await pause(0.8)
        check(await js(web1, "location.pathname") == "/inbox", "⌘1 reaches the page (Inbox)")

        // The web app's own "Open in a new window" button carries the current list.
        press("3", 20, .command); await pause(0.8)
        let path = await js(web1, "location.pathname")
        _ = await js(web1, "document.querySelector('button.newwin').click(), 'clicked'")
        await pause(2)
        check(appWindows.count == 2, "the web app's Open in New Window button opens a window", "windows: \(appWindows.count)")
        if let w2 = appWindows.first(where: { $0 != w1 }), let web2 = web(w2) {
            _ = await until(15) { await page(web2) != "loading" }
            check(await js(web2, "location.pathname") == path, "the new window opens on the same list", path)
        }
        for w in appWindows where w != w1 { w.close() }
        await pause(0.5)
        w1.makeKeyAndOrderFront(nil)
    }

    static func quick() async {
        // As from another app: Finder in front when the hotkey fires.
        if NSApp.isActive, let finder = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.apple.finder" }) {
            NSApp.yieldActivation(to: finder)
            finder.activate()
            _ = await until(3) { NSWorkspace.shared.frontmostApplication == finder }
        }
        let front = NSWorkspace.shared.frontmostApplication
        QuickEntryController.shared.show(); await pause(0.8)
        let panel = quickEntry
        check(panel?.isVisible == true, "Quick Entry appears")
        check(panel?.firstResponder is NSTextView, "the cursor is in its field",
              panel?.firstResponder.map { String(describing: Swift.type(of: $0)) } ?? "nil")
        check(NSWorkspace.shared.frontmostApplication == front, "Quick Entry leaves \(front?.localizedName ?? "the other app") in front")
        type("Selftest quick entry tomorrow #selftest")
        if let panel { capture(panel, "02-quick-entry") }
        press("\r", 36); await pause(2)
        let added = await openTodos("Selftest quick entry")
        check(added.count == 1, "Return saves it through /api/quick-add")
        check((added.first?["tags"] as? [String])?.contains("selftest") == true, "the server parsed the #tag")
        check(panel?.isVisible == false, "Quick Entry closes after saving")
        check(NSWorkspace.shared.frontmostApplication == front, "and the keyboard goes back to \(front?.localizedName ?? "the other app")",
              "front: \(NSWorkspace.shared.frontmostApplication?.localizedName ?? "nil")")

        QuickEntryController.shared.show(); await pause(0.6)
        type("half typed"); await pause(0.3); escape(); await pause(0.5)
        check(quickEntry?.isVisible == false, "Escape closes Quick Entry")
        QuickEntryController.shared.show(); await pause(0.6)
        let left = find(NSTextField.self, in: quickEntry?.contentView)?.stringValue ?? "?"
        check(left.isEmpty, "it opens empty again", "field: \"\(left)\"")
        escape(); await pause(0.3)
        check(await openTodos("half typed").isEmpty, "Escape saves nothing")
    }

    static func badge() async {
        await BadgeUpdater.shared.refresh()
        let counts = ((await api("api/state")) as? [String: Any])?["counts"] as? [String: Any]
        let today = counts?["today"] as? Int ?? -1
        check(NSApp.dockTile.badgeLabel == (today > 0 ? String(today) : nil), "the Dock badge shows the Today count",
              "badge \(NSApp.dockTile.badgeLabel ?? "none"), Today \(today)")
    }

    static func reminders() async {
        let names = ["not asked", "denied", "allowed", "provisional", "ephemeral"]
        let before = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus.rawValue
        log("INFO  notification permission: \(names[min(Int(before), 4)]), app at \(Bundle.main.bundlePath)")
        await ReminderScheduler.shared.requestPermission()
        // What a reminder's answer does needs no banner, so it is checked either way.
        let problem = await ReminderScheduler.shared.problem
        if let problem { log("SKIP  reminders scheduled here: \(problem)") }
        let center = UNUserNotificationCenter.current()
        let today = ((await api("api/state")) as? [String: Any])?["today"] as? String ?? ""
        let at = Calendar.current.dateComponents([.hour, .minute], from: Date().addingTimeInterval(20 * 60))
        let time = String(format: "%02d:%02d", at.hour ?? 0, at.minute ?? 0)
        guard let todo = await post("api/todos", ["title": "Selftest reminder", "when": today, "reminder": time]),
              let id = todo["id"] as? String else { return check(false, "made a to-do with a reminder") }
        if problem == nil {
            await ReminderScheduler.shared.sync()
            let pending = await center.pendingNotificationRequests().first { $0.identifier == id }
            check(pending != nil, "a reminder later today becomes a notification")
            check(pending?.content.categoryIdentifier == ReminderScheduler.category && pending?.content.userInfo["id"] as? String == id,
                  "and it carries a Complete button, and the to-do it is for")
        }
        // clicked: the to-do opens, where it lives
        await ReminderAnswer.handle(UNNotificationDefaultActionIdentifier, id: id, title: "Selftest reminder")
        let opened = await until(8) {
            guard let web = appWindows.first.flatMap(web) else { return false }
            return await js(web, "document.querySelector('.card[data-todo-id=\"\(id)\"]') ? 'open' : 'no'") == "open"
        }
        check(opened, "clicking a reminder opens its to-do")
        // Complete: done on the server, and gone from what is scheduled
        await ReminderAnswer.handle(ReminderScheduler.completeAction, id: id, title: "Selftest reminder")
        check(await openTodos("Selftest reminder").isEmpty, "its Complete button completes the to-do")
        if problem == nil {
            await ReminderScheduler.shared.sync()
            check(!(await center.pendingNotificationRequests().contains { $0.identifier == id }), "completing the to-do takes it back")
        }
        center.removePendingNotificationRequests(withIdentifiers: [id])
    }

    static func menubar() async {
        let menu = TodayMenu.shared
        await menu.load()
        let server = ((await api("api/lists/today")) as? [String: Any])?["items"] as? [[String: Any]] ?? []
        let open = server.filter { ($0["status"] as? String ?? "open") == "open" }
        check(menu.count == open.count, "the menu bar lists today's open to-dos", "menu \(menu.count), server \(open.count)")
        let panel = NSHostingView(rootView: MenuBarContent())
        panel.frame = NSRect(x: 0, y: 0, width: 280, height: 420)
        panel.layoutSubtreeIfNeeded()
        snap(view: panel, "06-menubar")
        guard let first = menu.items.first else { return check(false, "something in Today to tick") }
        await menu.complete(first)
        check(!menu.items.contains { $0.id == first.id }, "ticking a line takes it off the list")
        let after = ((await api("api/search?q=\(first.title.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")")) as? [String: Any])?["todos"] as? [[String: Any]] ?? []
        check(after.contains { $0["id"] as? String == first.id && ($0["status"] as? String) == "done" },
              "and completes it on the server")
    }

    /// What Shortcuts, Spotlight and the Services menu reach: the intents' own
    /// perform(), and the service handler on a pasteboard.
    static func intents() async {
        let create = CreateToDo()
        create.text = "Selftest intent tomorrow #selftest"
        create.list = .inbox
        _ = try? await create.perform()
        await pause(1)
        check(await openTodos("Selftest intent").count == 1, "the Create To-Do intent adds a to-do")

        let open = OpenList()
        open.list = .inbox
        _ = try? await open.perform()
        await pause(2)
        if let web = appWindows.first.flatMap(web) {
            check(await js(web, "location.pathname") == "/inbox", "the Open List intent shows that list")
        }

        let board = NSPasteboard(name: .init("dvarim-selftest"))
        board.clearContents()
        board.setString("Selftest service line\nand a second line", forType: .string)
        var failure: NSString?
        ServiceProvider().newToDo(board, userData: nil, error: &failure)
        await pause(0.8)
        let fields = findAll(NSTextField.self, in: quickEntry?.contentView).map(\.stringValue).filter { !$0.isEmpty }
        check(fields.first == "Selftest service line" && fields.contains("and a second line"),
              "the Services item opens Quick Entry on the selection: its first line the title, the rest the notes",
              fields.joined(separator: " | "))
        escape(); await pause(0.3)
    }

    /// On a plane: the whole shell pointed at a port nothing listens on, which
    /// fails the way no network does. Quick Entry, the Create To-Do intent and a
    /// tick in the menu bar are kept on this Mac (Outbox); the badge and the menu
    /// keep what they last knew instead of emptying; and when the server is back
    /// it all arrives — the kept line parsed by the server, the tick filed.
    static func offline() async {
        let live = Defaults.server.absoluteString
        let outbox = Outbox.shared, menu = TodayMenu.shared
        let before = outbox.ops.count
        await BadgeUpdater.shared.refresh()
        guard let tick = menu.items.first else { return check(false, "something in Today to tick offline") }
        let shown = menu.count
        let badge = Int(NSApp.dockTile.badgeLabel ?? "")

        point(at: "http://127.0.0.1:9")
        do {
            _ = try await Client(base: Defaults.server).state()
            check(false, "a refused connection reads as unreachable", "it answered")
        } catch {
            check(error is Client.Unreachable, "a refused connection reads as unreachable, not as a refusal", "\(error)")
        }

        QuickEntryController.shared.show(); await pause(0.6)
        type("Selftest offline line tomorrow #selftest")
        press("\r", 36); await pause(1.2)
        check(quickEntry?.isVisible == false, "Quick Entry closes offline too: the line is kept, which is as good as saved")
        check(outbox.ops.count == before + 1, "and the line is kept on this Mac", "\(outbox.ops.count - before) kept")

        let create = CreateToDo()
        create.text = "Selftest offline intent #selftest"
        create.list = .inbox
        _ = try? await create.perform()
        check(outbox.ops.count == before + 2, "the Create To-Do intent keeps its line too")

        await menu.complete(tick)
        check(!menu.items.contains { $0.id == tick.id }, "ticking a line offline takes it off the menu")
        check(menu.offline && menu.count == shown - 1, "and the menu keeps the rest of what it last heard, not an empty list",
              "offline \(menu.offline), \(menu.count) of \(shown)")
        check(outbox.ops.count == before + 3, "the tick is kept")
        if let badge {
            check(NSApp.dockTile.badgeLabel == (badge > 1 ? String(badge - 1) : nil), "the Dock badge keeps its count, less the tick",
                  "badge \(NSApp.dockTile.badgeLabel ?? "none"), was \(badge)")
        }

        QuickEntryController.shared.show(); await pause(0.6)
        if let panel = quickEntry { capture(panel, "07-quick-entry-offline") }
        escape(); await pause(0.3)
        let bar = NSHostingView(rootView: MenuBarContent())
        bar.frame = NSRect(x: 0, y: 0, width: 280, height: 420)
        bar.layoutSubtreeIfNeeded()
        snap(view: bar, "08-menubar-offline")

        point(at: live)
        await BadgeUpdater.shared.refresh()
        check(outbox.ops.count == before, "everything kept is sent when the server is back", "\(outbox.ops.count - before) still waiting")
        let line = await openTodos("Selftest offline line")
        check(line.count == 1 && (line.first?["tags"] as? [String])?.contains("selftest") == true,
              "the kept line reaches the server, which parses it as it would have", "\(line.count) found")
        check(await openTodos("Selftest offline intent").count == 1, "so does the intent's")
        let q = tick.title.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let found = ((await api("api/search?q=\(q)")) as? [String: Any])?["todos"] as? [[String: Any]] ?? []
        check(found.contains { $0["id"] as? String == tick.id && $0["status"] as? String == "done" }, "and so does the tick")
        check(!menu.offline, "the menu is back on the server")
    }

    /// The whole shell at another server, as Settings would, without writing
    /// Settings: -serverURL came in as a launch argument, which outranks
    /// anything the app keeps, so it is the argument that is replaced.
    static func point(at server: String) {
        var args = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        args[Defaults.serverKey] = server
        UserDefaults.standard.setVolatileDomain(args, forName: UserDefaults.argumentDomain)
    }

    /// The chord is recorded in Settings now, so check the parsing and that a
    /// different one registers; ⌃Space itself is often already spoken for.
    static func hotkey() {
        let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .control,
                                     timestamp: 0, windowNumber: 0, context: nil,
                                     characters: " ", charactersIgnoringModifiers: " ",
                                     isARepeat: false, keyCode: 49)!
        check(Shortcut(event: event)?.display == "⌃Space", "a recorded ⌃Space reads back as ⌃Space",
              Shortcut(event: event)?.display ?? "nil")
        let plain = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                                     windowNumber: 0, context: nil, characters: "a",
                                     charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0)!
        check(Shortcut(event: plain) == nil, "a chord with no modifier is refused")
        log("INFO  macOS already uses ⌃Space: \(GlobalHotKey.systemUses(.controlSpace))")

        let spare = Shortcut(keyCode: 100, modifiers: NSEvent.ModifierFlags([.control, .option, .command]).rawValue, display: "⌃⌥⌘F8")
        GlobalHotKey.shared.register(spare) { }
        check(GlobalHotKey.shared.isRegistered, "a recorded chord registers as the hotkey", spare.display)
        GlobalHotKey.shared.register(.controlSpace) { QuickEntryController.shared.toggle() }
        log("INFO  open at login: \(SMAppService.mainApp.status.rawValue == 1 ? "on" : "off")")
    }

    static func settings() async {
        if let menu = NSApp.mainMenu?.items.first?.submenu,
           let i = menu.items.firstIndex(where: { $0.title.hasPrefix("Settings") }) { menu.performActionForItem(at: i) }
        await pause(1)
        let window = NSApp.windows.first { $0.isVisible && $0.title.contains("Settings") }
        check(window != nil, "Dvarim → Settings… opens the shell's settings")
        if let window { capture(window, "03-settings"); window.close() }
        // …and so does the web app's Settings → Data, through dvarim://settings
        if let web = appWindows.first.flatMap(web) {
            _ = await js(web, "location.href = 'dvarim://settings'; 'ok'")
            let shown = await until(4) { NSApp.windows.contains { $0.isVisible && $0.title.contains("Settings") } }
            check(shown, "a dvarim://settings link from the page opens them too")
            NSApp.windows.first { $0.isVisible && $0.title.contains("Settings") }?.close()
        }
    }

    /// Needs a server with a password and -SelfTestSession <a session cookie it issued>.
    static func auth(_ web1: WKWebView) async {
        guard let token = UserDefaults.standard.string(forKey: "SelfTestSession"), let host = Defaults.server.host else { return }
        let store = WKWebsiteDataStore.default().httpCookieStore
        for c in await store.allCookies() where c.domain == host { await store.deleteCookie(c) }
        web1.reload(); _ = await until(15) { await page(web1) == "login" }
        check(await page(web1) == "login", "signed out, the window shows the web app's login")
        do { _ = try await Client(base: Defaults.server).state(); check(false, "native calls are refused while signed out") }
        catch { check(error is Client.NotSignedIn, "native calls are refused while signed out", "\(error)") }
        await BadgeUpdater.shared.refresh()
        check(NSApp.dockTile.badgeLabel == nil, "no Dock badge while signed out")
        QuickEntryController.shared.show(); await pause(0.6)
        type("Selftest signed out"); press("\r", 36); await pause(1.5)
        check(quickEntry?.isVisible == true, "Quick Entry stays open, text kept, when it cannot save")
        if let panel = quickEntry { capture(panel, "04-quick-entry-signed-out") }
        escape(); await pause(0.4)

        // What the login screen leaves behind: a session cookie in the web view.
        let cookie = HTTPCookie(properties: [.domain: host, .path: "/", .name: "dvarim_session", .value: token,
                                             .expires: Date().addingTimeInterval(3600)])!
        await store.setCookie(cookie)
        web1.reload(); _ = await until(15) { await page(web1) == "app" }
        check(await page(web1) == "app", "signed in, the window shows the app")
        await BadgeUpdater.shared.refresh()
        let today = (((await api("api/state")) as? [String: Any])?["counts"] as? [String: Any])?["today"] as? Int ?? -1
        check(today > 0 && NSApp.dockTile.badgeLabel == String(today), "the Dock badge uses the window's login")
        QuickEntryController.shared.show(); await pause(0.6)
        type("Selftest signed in"); press("\r", 36); await pause(1.5)
        check(await openTodos("Selftest signed in").count == 1, "Quick Entry uses the window's login")
        check(await openTodos("Selftest signed out").isEmpty, "nothing was saved while signed out")
        await store.deleteCookie(cookie)               // leave the app's cookie jar as it was
    }

    /// No title bar: the page runs to the top of the window
    /// with the traffic lights over its sidebar. So the page has to have made
    /// room for them, and kept what can be clicked out of the strip at the top
    /// that still drags the window.
    static func layout(_ w1: NSWindow, _ web1: WKWebView) async {
        check(w1.styleMask.contains(.fullSizeContentView) && w1.titleVisibility == .hidden,
              "the window has no title bar")
        let viewport = await js(web1, "String(innerHeight)")
        check(viewport == String(Int(w1.frame.height)), "the page runs to the top of the window",
              "viewport \(viewport), window \(Int(w1.frame.height))")
        check(await js(web1, "String(document.documentElement.classList.contains('chromeless'))") == "true",
              "and knows it, from the user agent",
              await diag(web1))
        let lights = w1.standardWindowButton(.zoomButton).map { $0.convert($0.bounds, to: nil) } ?? .zero
        let firstItem = Double(await js(web1, "document.querySelector('.sidebar .item').getBoundingClientRect().top")) ?? 0
        check(firstItem >= Double(w1.frame.height - lights.minY), "the sidebar starts under the traffic lights",
              "first item at \(Int(firstItem)), lights end at \(Int(w1.frame.height - lights.minY))")
        let strip = Double(w1.frame.height - w1.contentLayoutRect.height)
        let button = Double(await js(web1, "document.querySelector('.topbar .newwin').getBoundingClientRect().top")) ?? 0
        check(button >= strip, "Open in New Window sits below the strip that drags the window",
              "button top \(Int(button)), strip \(Int(strip))")
        capture(w1, "05-window")
    }

    /// Which build the page is, and what its service worker thinks: for when the
    /// window shows something other than what the server is serving.
    static func diag(_ web: WKWebView) async -> String {
        let src = """
        return await (async () => {
          const out = {};
          out.script = [...document.scripts].map(s => s.src.split('/').pop()).filter(Boolean).join(',');
          try { const r = await navigator.serviceWorker.getRegistration(); out.sw = r ? [r.active && r.active.state, r.waiting && r.waiting.state, r.installing && r.installing.state].join('/') : 'none'; out.controlled = !!navigator.serviceWorker.controller; } catch (e) { out.sw = 'err ' + e.message; }
          try { out.caches = (await caches.keys()).join(','); } catch (e) { out.caches = 'err'; }
          try { const t = await (await fetch('/', {cache: 'no-store'})).text(); out.serverShell = (t.match(/index-[\\w-]+\\.js/) || ['?'])[0]; } catch (e) { out.serverShell = 'fetch failed: ' + e.message; }
          try { const t = await (await fetch('/sw.js', {cache: 'no-store'})).text(); out.serverSw = (t.match(/dvarim-shell-v\\d+/) || ['?'])[0]; } catch (e) { out.serverSw = 'fetch failed: ' + e.message; }
          return JSON.stringify(out);
        })();
        """
        do { return String(describing: try await web.callAsyncJavaScript(src, arguments: [:], in: nil, contentWorld: .page) ?? "nil") }
        catch { return "error: \(error.localizedDescription)" }
    }

    // MARK: windows and pages

    static func find<T: NSView>(_ type: T.Type, in v: NSView?) -> T? {
        guard let v else { return nil }
        if let hit = v as? T { return hit }
        for s in v.subviews { if let hit = find(type, in: s) { return hit } }
        return nil
    }
    static func findAll<T: NSView>(_ type: T.Type, in v: NSView?) -> [T] {
        guard let v else { return [] }
        let here = (v as? T).map { [$0] } ?? []
        return here + v.subviews.flatMap { findAll(type, in: $0) }
    }
    static func web(_ w: NSWindow) -> WKWebView? { find(WKWebView.self, in: w.contentView) }
    static var appWindows: [NSWindow] { NSApp.windows.filter { $0.isVisible && web($0) != nil } }
    static var quickEntry: NSPanel? {
        NSApp.windows.compactMap { $0 as? NSPanel }.first { find(NSTextField.self, in: $0.contentView) != nil }
    }

    static func js(_ web: WKWebView, _ src: String) async -> String {
        do { return String(describing: try await web.evaluateJavaScript(src) ?? "undefined") }
        catch { return "error: \(error.localizedDescription)" }
    }
    static func page(_ web: WKWebView) async -> String {
        await js(web, "document.querySelector('.sidebar') ? 'app' : document.querySelector('input[type=password]') ? 'login' : 'loading'")
    }

    // MARK: the server, checked directly, signed in the way the app is

    static func request(_ path: String) async -> URLRequest? {
        guard let url = URL(string: path, relativeTo: Defaults.server) else { return nil }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        for (k, v) in await Session.cookieHeader(for: url) { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }
    static func api(_ path: String) async -> Any? {
        guard let r = await request(path), let (data, _) = try? await URLSession.shared.data(for: r) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }
    static func post(_ path: String, _ body: [String: Any]) async -> [String: Any]? {
        guard var r = await request(path) else { return nil }
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, _) = try? await URLSession.shared.data(for: r) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    static func openTodos(_ title: String) async -> [[String: Any]] {
        let q = title.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? title
        let todos = ((await api("api/search?q=\(q)")) as? [String: Any])?["todos"] as? [[String: Any]] ?? []
        return todos.filter { $0["title"] as? String == title && $0["status"] as? String == "open" }
    }

    // MARK: keys

    /// A key as the keyboard sends it: with ⌃ held, `characters` is the control
    /// character and `charactersIgnoringModifiers` the letter.
    static func press(_ key: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = []) {
        var chars = key
        if flags.contains(.control), let s = key.unicodeScalars.first, s.value >= 0x61, s.value <= 0x7a,
           let c = UnicodeScalar(s.value & 0x1f) { chars = String(Character(c)) }
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags,
                                        timestamp: ProcessInfo.processInfo.systemUptime,
                                        windowNumber: NSApp.keyWindow?.windowNumber ?? 0, context: nil,
                                        characters: chars, charactersIgnoringModifiers: key,
                                        isARepeat: false, keyCode: code) {
                NSApp.postEvent(e, atStart: false)
            }
        }
    }
    static func type(_ text: String) { for ch in text { press(String(ch), ch == " " ? 49 : 0) } }
    static func escape() { press("\u{1b}", 53) }

    // MARK: output

    static func log(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }
    static func check(_ ok: Bool, _ what: String, _ detail: String = "") {
        log((ok ? "PASS  " : "FAIL  ") + what + (detail.isEmpty ? "" : "  [" + detail + "]"))
        if !ok { failures += 1 }
    }
    static func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
    static func until(_ timeout: Double, _ cond: () async -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        repeat { if await cond() { return true }; await pause(0.15) } while Date() < end
        return false
    }

    static func save(_ image: NSImage?, _ name: String) {
        guard let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: outDir.appendingPathComponent(name + ".png"))
    }
    static func snap(_ web: WKWebView, _ name: String) async { save(try? await web.takeSnapshot(configuration: nil), name) }
    static func snap(view: NSView, _ name: String) {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        let image = NSImage(size: view.bounds.size); image.addRepresentation(rep)
        save(image, name)
    }
    /// The app's own windows, chrome and all; no Screen Recording permission needed for these.
    static func capture(_ w: NSWindow, _ name: String) {
        guard let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(w.windowNumber),
                                               [.boundsIgnoreFraming, .bestResolution]) else { return }
        save(NSImage(cgImage: cg, size: .zero), name)
    }
    static func dumpMenus() {
        for top in NSApp.mainMenu?.items ?? [] {
            let items = (top.submenu?.items ?? []).filter { !$0.isSeparatorItem && !$0.isHidden }.map { i -> String in
                let m = i.keyEquivalentModifierMask
                let mods = (m.contains(.control) ? "⌃" : "") + (m.contains(.option) ? "⌥" : "") + (m.contains(.shift) ? "⇧" : "") + (m.contains(.command) ? "⌘" : "")
                // Arrows and friends are private-use characters that print as
                // nothing, which made ⌘↑ look like a menu item with a bare ⌘.
                let named: [String: String] = ["\u{F700}": "↑", "\u{F701}": "↓", "\u{F702}": "←",
                                               "\u{F703}": "→", " ": "Space", "\u{8}": "⌫", "\r": "↩", "\u{1B}": "Esc"]
                let key = named[i.keyEquivalent] ?? i.keyEquivalent.uppercased()
                return i.keyEquivalent.isEmpty ? i.title : "\(i.title) \(mods)\(key)"
            }
            log("MENU  \(top.title): " + items.joined(separator: " · "))
        }
    }
}
