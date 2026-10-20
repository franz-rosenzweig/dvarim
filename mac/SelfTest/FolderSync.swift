import AppKit
import EventKit
import UserNotifications
import WebKit

/// Phases 5 and 6 on a folder: the built-in sync with a Dvarim server (sync),
/// the device's calendars and the rules of the http op (calendars), and the
/// badge, menu bar, Quick Entry and reminders answered by the folder's page
/// (local). Each section works on folders of its own, set in the argument
/// domain as folder() does, and puts the server back afterwards.
extension SelfTest {

    // MARK: sync: the device check of mac/NEXT.md, phase 5

    /// A server of our own on a copy of sample-vault, a device token from it,
    /// and a new, empty folder that syncs with it through Settings → Sync: once
    /// with the page making the requests, once with the app making them (op
    /// http). The folder arrives; a change goes each way; one made while the
    /// server is down goes when it is back; a revoked token is said to be.
    static func sync() async {
        let d = UserDefaults.standard
        guard Vault.webBundle != nil, let sample = d.string(forKey: "SelfTestSample"),
              let repo = d.string(forKey: "SelfTestRepo"), let node = d.string(forKey: "SelfTestNode") else {
            return log("SKIP  sync: needs the web app inside the app, -SelfTestSample, -SelfTestRepo and -SelfTestNode")
        }
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("dvarim-selftest-sync-\(UUID().uuidString.prefix(8))")
        defer { try? FileManager.default.removeItem(at: base) }
        let server = SyncServer(root: base.appendingPathComponent("server"), node: node, repo: URL(fileURLWithPath: repo))
        do {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: sample), to: server.root)
        } catch {
            return check(false, "a copy of sample-vault for the sync server", error.localizedDescription)
        }
        guard server.auth("a.setPassword('selftest-only-password'); console.log('ok')") == "ok" else {
            return check(false, "a password on the sync server, so that it asks for a token")
        }
        defer { server.stop() }
        for http in [false, true] {
            // a server started afresh each time: its throttle remembers the wrong tokens
            server.stop()
            guard await server.start() else { return check(false, "a sync server on a copy of sample-vault", server.url) }
            await syncPass(server, http: http, folder: base.appendingPathComponent(http ? "device-http" : "device-page"))
        }
    }

    private static func syncPass(_ server: SyncServer, http: Bool, folder: URL) async {
        log("INFO  sync: " + (http ? "the app making the sync's requests (op http)" : "the page making the sync's requests"))
        let name = http ? "Selftest Mac 2" : "Selftest Mac 1"
        let token = server.auth("console.log(a.addToken('\(name)'))")
        guard token.hasPrefix("dvt_") else { return check(false, "a device token from the sync server") }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let saved = useFolder(folder, ["FolderHTTP": http])
        guard let w = await folderWindow() else {
            check(false, "the app opens on a new, empty folder")
            return await leaveFolder(saved)
        }
        // The page keeps the sync's setting in its own storage. A Mac already
        // syncing a folder of its own is left alone rather than reset.
        if await js(w, "String(localStorage.getItem('dvarim.sync') !== null)") == "true" {
            log("SKIP  sync: this Mac's Dvarim already syncs a folder, and its setting is left alone")
            return await leaveFolder(saved)
        }
        // a new vault starts with the tutorial (#87), which the first round
        // drops again when the server already has notes
        check(markdown(folder) == ["Inbox.md", "Projects/Meet Dvarim.md", "Standalone.md", "Trash.md"],
              "it starts empty but for Meet Dvarim", markdown(folder).joined(separator: ", "))

        let asked = FolderBridge.httpRequests
        guard await syncPane(w) else {
            check(false, "Settings → Sync opens")
            return await leaveFolder(saved)
        }
        check((await syncState(w)).contains("Not syncing"), "Settings → Sync says it is not syncing", await syncState(w))
        _ = await js(w, "document.querySelector('input[name=\"sync-kind\"][value=\"dvarim\"]')?.click(); 'ok'")
        _ = await until(5) { await js(w, "String(!!document.querySelector('#sync-address'))") == "true" }
        await fill(w, "#sync-address", server.url)
        await fill(w, "#sync-token", "dvt_not-a-real-token")
        await syncButton(w, "Save and sync")
        _ = await until(15) { (await syncState(w)).contains("Couldn't sync") }
        check((await syncState(w)).contains("did not accept"), "a wrong token is said plainly", await syncState(w))

        await fill(w, "#sync-token", token)
        await syncButton(w, "Save and sync")
        let synced = await until(30) { (await syncState(w)).contains("Last synced") }
        check(synced, "with the right token it syncs, from the app's own page to another origin", await syncState(w))
        let here = markdown(folder), there = markdown(server.root)
        check(here == there, "the server's vault is now in the folder, every file", "\(here.count) here, \(there.count) there")
        check(there.allSatisfy { (try? Data(contentsOf: folder.appendingPathComponent($0))) == (try? Data(contentsOf: server.root.appendingPathComponent($0))) },
              "and the same, byte for byte")
        check(!contains(folder, token), "the token is kept by the app, not in the folder")
        let through = FolderBridge.httpRequests - asked
        if http {
            check(through > 5, "every request went through the app (op http)", "\(through)")
        } else {
            check(through == 0, "the page made the requests itself: none through the app", "\(through)")
        }
        await closeSettings(w)

        // a change here goes there by itself
        let theirs = server.root.appendingPathComponent("Inbox.md"), ours = folder.appendingPathComponent("Inbox.md")
        let made = (await ask(w, "POST", "/api/todos", ["title": "Made on this Mac", "inbox": true]))?["body"] as? [String: Any]
        let id = made?["id"] as? String ?? "none"
        check(await until(20) { text(theirs).contains(id) }, "a to-do made here reaches the server within seconds", id)

        // and a change there comes here, on Sync now
        let typed = http ? "selfth01" : "selftp01"
        append(theirs, "- [ ] Typed on the server 🆔 \(typed)\n")
        _ = await syncPane(w)
        await syncButton(w, "Sync now")
        check(await until(20) { text(ours).contains(typed) }, "one typed on the server arrives on Sync now")
        await closeSettings(w)
        _ = await js(w, "window.dvarim.run('go.inbox'); 'ok'")
        check(await until(8) { await js(w, "String(!!document.querySelector('[data-todo-id=\"\(typed)\"]'))") == "true" },
              "and shows in the Inbox")

        // made while the server is down, it goes when the server is back
        server.stop()
        let away = ((await ask(w, "POST", "/api/todos", ["title": "Made while the server was down", "inbox": true]))?["body"] as? [String: Any])?["id"] as? String ?? "none"
        _ = await syncPane(w)
        _ = await until(15) { (await syncState(w)).contains("Couldn't sync") }
        log("INFO  with the server down, Settings → Sync says: \(await syncState(w))")
        guard await server.start() else { return check(false, "the sync server back up") }
        await syncButton(w, "Sync now")
        check(await until(20) { text(theirs).contains(away) }, "made while the server was down, it reaches the server once it is back")

        // the device removed on the server
        _ = server.auth("a.removeToken('\(name)')")
        await syncButton(w, "Sync now")
        let refused = await until(15) { (await syncState(w)).contains("accept") }
        check(refused, "a device removed on the server is told its token is not accepted", await syncState(w))

        _ = await js(w, "document.querySelector('input[name=\"sync-kind\"][value=\"off\"]')?.click(); 'ok'")
        await syncButton(w, "Stop syncing")
        _ = await until(8) { (await syncState(w)).contains("Not syncing") }
        check(await js(w, "String(localStorage.getItem('dvarim.sync'))") == "null", "Stop syncing forgets the token")
        await closeSettings(w)
        await leaveFolder(saved)
    }

    /// node server/src/main.js on 127.0.0.1, on its own copy of sample-vault.
    @MainActor
    final class SyncServer {
        let root: URL, node: String, repo: URL
        let port = 8431
        private var process: Process?
        var url: String { "http://127.0.0.1:\(port)" }

        init(root: URL, node: String, repo: URL) {
            self.root = root
            self.node = node
            self.repo = repo
        }

        /// A script run against the server's auth file, `a` being its Auth
        /// (server/src/auth.js); what it prints. The server reads the file
        /// again at each request, so a token made or revoked here counts at once.
        func auth(_ script: String) -> String {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            let module = repo.appendingPathComponent("server/src/auth.js").absoluteString
            p.arguments = ["--input-type=module", "-e",
                           "const { Auth } = await import(process.argv[1]); const a = Auth.load(process.argv[2]); " + script,
                           module, root.path]
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            do { try p.run() } catch { return "" }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        func start() async -> Bool {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [repo.appendingPathComponent("server/src/main.js").path]
            var env = ProcessInfo.processInfo.environment
            env["PORT"] = String(port)
            env["HOST"] = "127.0.0.1"
            env["DVARIM_ROOT"] = root.path
            env["DVARIM_STATIC"] = repo.appendingPathComponent("frontend/dist").path
            p.environment = env
            let log = SelfTest.outDir.appendingPathComponent("sync-server.log")
            if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
            if let handle = try? FileHandle(forWritingTo: log) {
                handle.seekToEndOfFile()
                p.standardOutput = handle
                p.standardError = handle
            }
            do { try p.run() } catch { return false }
            process = p
            let probe = URL(string: url + "/api/auth")!
            return await SelfTest.until(10) { (try? await URLSession.shared.data(from: probe)) != nil }
        }

        /// Whether any of the server's Markdown says this.
        func contains(_ needle: String) -> Bool { SelfTest.contains(root, needle) }

        func stop() {
            guard let p = process else { return }
            p.terminate()
            p.waitUntilExit()
            process = nil
        }
    }

    // MARK: calendars: the device's own, and the http op's rules

    static func calendars() async {
        // how an EventKit occurrence reaches the page, in Phoenix's wall time
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Phoenix")!
        let at = { (y: Int, m: Int, d: Int, h: Int, min: Int, s: Int) in cal.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min, second: s))! }
        let timed = DeviceCalendars.row(uid: "u1", title: "Dentist", calendar: "Home", color: "#112233", allDay: false,
                                        start: at(2026, 9, 24, 9, 30, 0), end: at(2026, 9, 24, 10, 15, 0), in: cal)
        check(timed["start"] as? String == "2026-09-24T09:30" && timed["end"] as? String == "2026-09-24T10:15",
              "an event at a time is written in the Mac's own wall time", "\(timed["start"] ?? "") – \(timed["end"] ?? "")")
        let days = DeviceCalendars.row(uid: "u2", title: "Conference", calendar: "Work", color: "#112233", allDay: true,
                                       start: at(2026, 9, 24, 0, 0, 0), end: at(2026, 9, 25, 23, 59, 59), in: cal)
        check(days["start"] as? String == "2026-09-24" && days["end"] as? String == "2026-09-26",
              "an all-day event of two days ends on the day after its last, as iCalendar has it", "\(days["start"] ?? "") – \(days["end"] ?? "")")

        // plain http only to this Mac, the local network and the tailnet
        let near: [[UInt8]] = [[127, 0, 0, 1], [10, 1, 2, 3], [172, 20, 0, 1], [192, 168, 1, 5], [100, 91, 202, 11],
                               [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], Array(repeating: 0, count: 15) + [1]]
        let far: [[UInt8]] = [[8, 8, 8, 8], [100, 128, 0, 1], [172, 32, 0, 1], [0x26, 0x06, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]]
        check(near.allSatisfy(ShellHTTP.isPrivate(address:)) && !far.contains(where: ShellHTTP.isPrivate(address:)),
              "the http op tells this Mac, the local network and the tailnet from the internet")
        let refused = await ShellHTTP.answer(url: "http://example.com/dav/", method: "PROPFIND", headers: [:], body: nil)
        let odd = await ShellHTTP.answer(url: "file:///etc/hosts", method: "GET", headers: [:], body: nil)
        check((refused["error"] as? [String: Any])?["code"] as? String == "EINVAL" && (odd["error"] as? [String: Any])?["code"] as? String == "EINVAL",
              "and refuses plain http to the internet, and anything but http, before sending a thing")

        // The page's side, with a file standing in for EventKit: this build may
        // not have the calendar permission, and must not ask for it in a test.
        let status = ["not asked", "restricted", "denied", "full access", "write only"]
        log("INFO  calendar permission: \(status[min(EKEventStore.authorizationStatus(for: .event).rawValue, 4)])")
        guard Vault.webBundle != nil, let sample = UserDefaults.standard.string(forKey: "SelfTestSample") else {
            return log("SKIP  device calendars: no -SelfTestSample")
        }
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("dvarim-selftest-cal-\(UUID().uuidString.prefix(8))")
        let root = base.appendingPathComponent("vault"), file = base.appendingPathComponent("calendars.json")
        defer { try? FileManager.default.removeItem(at: base) }
        do {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: sample), to: root)
        } catch {
            return check(false, "a copy of sample-vault", error.localizedDescription)
        }
        let saved = useFolder(root, ["DeviceCalendarsFile": file.path])
        guard let w = await folderWindow() else {
            check(false, "the app opens on the folder")
            return await leaveFolder(saved)
        }
        let today = ((await ask(w, "GET", "/api/state"))?["body"] as? [String: Any])?["today"] as? String ?? ""
        let day0 = DeviceCalendars.day(today) ?? Date()
        let later = { (n: Int) in
            let c = Calendar.current.dateComponents([.year, .month, .day], from: Calendar.current.date(byAdding: .day, value: n, to: day0)!)
            return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
        }
        let json: [String: Any] = [
            "calendars": [["name": "Personal", "color": "#E0533A"], ["name": "Work", "color": "#3A7BE0"]],
            "events": [
                ["uid": "e1", "title": "Dentist", "calendar": "Personal", "color": "#E0533A", "allDay": false,
                 "start": "\(today)T09:30", "end": "\(today)T10:15"],
                ["uid": "e2", "title": "Conference", "calendar": "Work", "color": "#3A7BE0", "allDay": true,
                 "start": later(1), "end": later(3)],
            ]]
        try? JSONSerialization.data(withJSONObject: json).write(to: file)

        // Nothing is asked of the Mac until its calendars are turned on here
        // (#74): turning them on is what brings macOS's permission prompt. The
        // page keeps that choice in its own storage, which is put back after.
        let kept = await js(w, "localStorage.getItem('dvarim.deviceCalendars') ?? 'unset'")
        _ = await js(w, "localStorage.removeItem('dvarim.deviceCalendars'); 'ok'")
        let evs = "[...document.querySelectorAll('.ev')]"
        w.load(WebView.fresh(Vault.url(for: "/today")))
        _ = await until(10) { await js(w, "String(!!(window.__dvarimLocal && document.querySelector('.sidebar')))") == "true" }
        await pause(1.5)
        check(await js(w, "String(\(evs).length)") == "0", "until they are turned on, Today shows none of the Mac's events")
        func calendarPane() async {
            _ = await js(w, "document.querySelector('.sidefoot [aria-label=\"Settings\"]')?.click(); 'ok'")
            _ = await until(5) { await js(w, "String(!!document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"]'))") == "true" }
            _ = await js(w, "document.querySelector('#pane-tab-calendar')?.click(); 'ok'")
        }
        func button(_ text: String) async -> Bool {
            let found = await until(8) {
                (try? await w.callAsyncJavaScript("return [...document.querySelectorAll('#pane-body button')].some(b => b.textContent.includes(text))",
                                                  arguments: ["text": text], contentWorld: .page)) as? Bool == true
            }
            _ = try? await w.callAsyncJavaScript("[...document.querySelectorAll('#pane-body button')].find(b => b.textContent.includes(text))?.click()",
                                                 arguments: ["text": text], contentWorld: .page)
            return found
        }
        await calendarPane()
        check(await button("Show this device's calendars"), "Settings → Calendar offers to show the Mac's calendars")
        let listed = await until(8) {
            await js(w, "[...document.querySelectorAll('.callist label')].map(l => l.textContent.trim()).join(',')") == "Personal,Work"
        }
        check(listed, "turned on, it lists the Mac's calendars")
        await closeSettings(w)

        w.load(WebView.fresh(Vault.url(for: "/today")))
        let shown = await until(12) { await js(w, "String(\(evs).some(e => e.textContent.includes('Dentist')))") == "true" }
        let texts = await js(w, "\(evs).map(e => e.textContent).join(' | ')")
        check(shown && texts.contains("9:30"), "an event from the Mac's calendar shows in Today, at its time", texts)
        w.load(WebView.fresh(Vault.url(for: "/upcoming")))
        check(await until(12) { await js(w, "String(\(evs).filter(e => e.textContent.includes('Conference')).length)") == "2" },
              "an all-day event of two days shows on both in Upcoming")
        await calendarPane()
        _ = await until(8) { await js(w, "String(document.querySelectorAll('.callist label').length)") == "2" }
        _ = await js(w, "[...document.querySelectorAll('.callist label')].find(l => l.textContent.includes('Personal'))?.querySelector('input')?.click(); 'ok'")
        await pause(0.8)
        await closeSettings(w)
        w.load(WebView.fresh(Vault.url(for: "/today")))
        _ = await until(10) { await js(w, "String(!!document.querySelector('.sidebar'))") == "true" }
        await pause(1.5)
        check(await js(w, "String(\(evs).some(e => e.textContent.includes('Dentist')))") == "false", "and a calendar unticked there leaves Today")
        await calendarPane()
        _ = await button("Stop showing this device's calendars")
        await closeSettings(w)
        w.load(WebView.fresh(Vault.url(for: "/upcoming")))
        _ = await until(10) { await js(w, "String(!!document.querySelector('.sidebar'))") == "true" }
        await pause(1.5)
        check(await js(w, "String(\(evs).length)") == "0", "and turned off again, Upcoming shows none of them")
        _ = try? await w.callAsyncJavaScript(
            "if (kept === 'unset') localStorage.removeItem('dvarim.deviceCalendars'); else localStorage.setItem('dvarim.deviceCalendars', kept)",
            arguments: ["kept": kept], contentWorld: .page)
        await leaveFolder(saved)
    }

    // MARK: local: the shell's own features on a folder, phase 6

    /// The badge, the menu bar, Quick Entry and reminders with the to-dos in a
    /// folder and no server to ask: a window's page answers, and with every
    /// window closed, a page the app keeps for it. A change anywhere reaches
    /// the menu bar at once, through op `changed`.
    static func local() async {
        guard Vault.webBundle != nil, let sample = UserDefaults.standard.string(forKey: "SelfTestSample") else {
            return log("SKIP  local: no -SelfTestSample")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dvarim-selftest-local-\(UUID().uuidString.prefix(8))")
        defer { try? FileManager.default.removeItem(at: root) }
        do { try FileManager.default.copyItem(at: URL(fileURLWithPath: sample), to: root) } catch {
            return check(false, "a copy of sample-vault", error.localizedDescription)
        }
        let saved = useFolder(root)
        guard let w = await folderWindow() else {
            check(false, "the app opens on the folder")
            return await leaveFolder(saved)
        }
        let menu = TodayMenu.shared
        let state = (await ask(w, "GET", "/api/state"))?["body"] as? [String: Any]
        let today = state?["today"] as? String ?? ""
        let count = (state?["counts"] as? [String: Any])?["today"] as? Int ?? -1
        await BadgeUpdater.shared.refresh()
        check(NSApp.dockTile.badgeLabel == (count > 0 ? String(count) : nil), "on a folder the Dock badge counts Today from the folder",
              "badge \(NSApp.dockTile.badgeLabel ?? "none"), Today \(count)")
        let items = ((await ask(w, "GET", "/api/lists/today"))?["body"] as? [String: Any])?["items"] as? [[String: Any]] ?? []
        let open = items.filter { ($0["status"] as? String ?? "open") == "open" }.count
        check(menu.count == open, "and the menu bar lists it", "menu \(menu.count), page \(open)")

        // Quick Entry saves into the folder
        let inbox = root.appendingPathComponent("Inbox.md")
        let quick = try? await Outbox.shared.quickAdd("Selftest quick entry on a folder")
        if case .sent? = quick {} else { check(false, "Quick Entry is saved at once, not kept for later") }
        check(await until(3) { text(inbox).contains("- [ ] Selftest quick entry on a folder") }, "Quick Entry saves into the folder's Inbox.md")

        // a change in the page reaches the menu bar with nothing asking
        _ = await ask(w, "POST", "/api/todos", ["title": "Selftest made for today", "when": today])
        check(await until(6) { menu.items.contains { $0.title == "Selftest made for today" } },
              "a to-do made in the window reaches the menu bar at once (op changed)")
        if let item = menu.items.first(where: { $0.title == "Selftest made for today" }) {
            await menu.complete(item)
            check(await until(5) { lines(root).contains { $0.hasPrefix("- [x] Selftest made for today") } },
                  "ticked in the menu bar, it is ticked in the file")
        }

        // every window closed: the app's own page answers, and still watches
        for window in appWindows { window.close() }
        _ = await until(5) { appWindows.isEmpty }
        await menu.load()
        check(LocalPage.shared.hasHiddenPage && menu.problem == nil,
              "with every window closed, a page the app keeps answers the menu bar", menu.problem ?? "\(menu.count) in Today")
        append(root.appendingPathComponent("Standalone.md"), "- [ ] Selftest brought by disk 🆔 selftdsk ⏳ \(today)\n")
        check(await until(8) { menu.items.contains { $0.title == "Selftest brought by disk" } },
              "and a line written into the folder reaches the menu bar with no window open")
        let unseen = try? await Outbox.shared.quickAdd("Selftest quick entry, no window")
        if case .sent? = unseen {} else { check(false, "Quick Entry with no window is saved at once") }
        check(await until(3) { text(inbox).contains("- [ ] Selftest quick entry, no window") }, "Quick Entry with no window open saves into the folder too")

        // reminders from the folder, where this build may show them
        let allowed = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .authorized
        if allowed {
            let soon = Calendar.current.dateComponents([.hour, .minute], from: Date().addingTimeInterval(20 * 60))
            let body: [String: Any] = ["title": "Selftest folder reminder", "when": today,
                                       "reminder": String(format: "%02d:%02d", soon.hour ?? 0, soon.minute ?? 0)]
            let (_, data) = (try? await LocalPage.shared.request("POST", "/api/todos", json: JSONSerialization.data(withJSONObject: body))) ?? (0, Data())
            let id = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["id"] as? String ?? ""
            await ReminderScheduler.shared.sync()
            check(await UNUserNotificationCenter.current().pendingNotificationRequests().contains { $0.identifier == id },
                  "a reminder later today in the folder becomes a notification")
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
        } else {
            log("SKIP  reminders from the folder: this build may not show notifications")
        }

        // a window again: its page answers, and the app's own goes
        Windows.open?("/today")
        _ = await folderWindow()
        await menu.load()
        check(!LocalPage.shared.hasHiddenPage, "once a window is open again, its page answers and the app's own goes")
        await leaveFolder(saved)
    }

    // MARK: copy: the default since offline-first, a copy on this Mac synced with the server

    /// A server of our own with a password, and the app in copy mode on it.
    /// Before a sign-in the window is the server's page; signing in there makes
    /// this Mac a token, a private folder and a window on the app's own page,
    /// whose storage says how to sync. The copy fills from the server and a
    /// change goes back; signing out takes the token, the sign-in and the copy
    /// away again. Server-only mode tells the server's page it is in the app.
    static func copy() async {
        let d = UserDefaults.standard
        guard Vault.webBundle != nil, let sample = d.string(forKey: "SelfTestSample"),
              let repo = d.string(forKey: "SelfTestRepo"), let node = d.string(forKey: "SelfTestNode") else {
            return log("SKIP  copy: needs the web app inside the app, -SelfTestSample, -SelfTestRepo and -SelfTestNode")
        }
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("dvarim-selftest-copy-\(UUID().uuidString.prefix(8))")
        defer { try? FileManager.default.removeItem(at: base) }
        let server = SyncServer(root: base.appendingPathComponent("server"), node: node, repo: URL(fileURLWithPath: repo))
        do {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: sample), to: server.root)
        } catch {
            return check(false, "a copy of sample-vault for the copy's server", error.localizedDescription)
        }
        guard server.auth("a.setPassword('selftest-only-password'); console.log('ok')") == "ok" else {
            return check(false, "a password on the copy's server")
        }
        guard await server.start() else { return check(false, "a server for the copy", server.url) }
        defer { server.stop() }
        let saved = d.volatileDomain(forName: UserDefaults.argumentDomain)
        var args = saved
        args[Defaults.serverKey] = server.url
        args[Vault.modeKey] = Vault.copyMode
        d.setVolatileDomain(args, forName: UserDefaults.argumentDomain)
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
        defer {
            d.setVolatileDomain(saved, forName: UserDefaults.argumentDomain)
            NotificationCenter.default.post(name: .dvarimReload, object: nil)
        }

        // 1. No sign-in yet: the server's page, told it is inside the app.
        check(AppCopy.current == nil, "copy mode with no sign-in has no copy yet")
        var serverPage: WKWebView?
        _ = await until(15) {
            guard let w = appWindows.first.flatMap(web), w.url?.host == "127.0.0.1", await page(w) == "login" else { return false }
            serverPage = w
            return true
        }
        guard let first = serverPage else { return check(false, "before a sign-in the window is the server's sign-in page") }
        check(true, "before a sign-in the window is the server's sign-in page")
        check(await js(first, "String(window.__dvarimShell && window.__dvarimShell.copy)") == "true",
              "the server's page is told the app keeps the copy (window.__dvarimShell)")

        // 2. Signing in, as the page does, leaves the session cookie in the
        //    window's store; the app sets the copy up from it.
        guard await signIn(server.url, password: "selftest-only-password") else {
            return check(false, "a sign-in on the copy's server")
        }
        let madeIt = await until(15) { AppCopy.current != nil }
        check(madeIt, "after a sign-in the app sets up a copy on this Mac")
        guard let copy = AppCopy.current else { return }
        let tokens = server.auth("console.log(JSON.stringify(a.tokenList(null).map((t) => t.name)))")
        check(tokens.contains("\"\(copy.device)\""), "the server lists this Mac as a device", tokens)
        check(AppCopy.token(for: copy)?.hasPrefix("dvt_") == true, "the token is kept in the Keychain")
        guard let folder = AppCopy.folder else { return check(false, "the copy has a folder") }
        check(folder.path.contains("/Application Support/Dvarim/Copies/127.0.0.1-8431/owner"), "the copy's folder is the app's own", folder.path)

        // 3. The window is the app's own page on that folder, told how to sync.
        guard let w = await folderWindow(25) else { return check(false, "the window comes back on the app's own page") }
        check(true, "the window comes back on the app's own page")
        let info = (try? await w.callAsyncJavaScript("return await window.webkit.messageHandlers.dvarimStorage.postMessage({ v: 1, op: 'info', args: {} })",
                                                     arguments: [:], contentWorld: .page) as? [String: Any])?["ok"] as? [String: Any]
        let sync = info?["sync"] as? [String: Any]
        check(info?["name"] as? String == "This Mac", "Settings → Data calls it This Mac", "\(info?["name"] ?? "nil")")
        check(sync?["kind"] as? String == "dvarim" && sync?["address"] as? String == server.url && sync?["app"] as? Bool == true
              && (sync?["token"] as? String)?.hasPrefix("dvt_") == true,
              "storage.info() tells the page to sync with the server, by the app's token")

        // 4. The copy fills from the server, and a change goes back — once the
        //    page reads info.sync (the web side of offline-first).
        let filled = await until(20) { contains(folder, "Reply about October hours") }
        if filled {
            check(true, "the copy fills from the server")
            let title = "Copy selftest \(Int(Date().timeIntervalSince1970))"
            _ = await ask(w, "POST", "/api/quick-add", ["text": title])
            let back = await until(20) { server.contains(title) }
            check(back, "a to-do made in the copy reaches the server")
        } else {
            log("SKIP  copy: the copy did not fill; the page does not read storage.info().sync yet")
        }
        check(Client.current.local, "the badge, menu bar and reminders read the copy, not the server")

        // 5. Signing out: the page's storage op, once it has synced.
        _ = try? await w.callAsyncJavaScript("return await window.webkit.messageHandlers.dvarimStorage.postMessage({ v: 1, op: 'signOut', args: {} })",
                                             arguments: [:], contentWorld: .page)
        check(await until(15) { AppCopy.current == nil }, "signing out forgets the copy")
        let after = server.auth("console.log(JSON.stringify(a.tokenList(null).map((t) => t.name)))")
        check(!after.contains("\"\(copy.device)\""), "signing out takes the token off the server", after)
        check(AppCopy.token(for: copy) == nil, "signing out takes the token out of the Keychain")
        check(!FileManager.default.fileExists(atPath: folder.path), "signing out moves the copy to the Trash")
        if let trashed = AppCopy.lastTrashed { try? FileManager.default.removeItem(at: trashed) }
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies().filter { $0.domain == "127.0.0.1" }
        check(cookies.isEmpty, "signing out signs the window out too")
        _ = await until(15) {
            guard let w = appWindows.first.flatMap(web) else { return false }
            return w.url?.host == "127.0.0.1"
        }
        check(appWindows.first.flatMap(web)?.url?.host == "127.0.0.1", "after signing out the window is the server's page again")

        // 6. Server only: the server's page still knows it is in the app.
        args[Vault.modeKey] = "server"
        d.setVolatileDomain(args, forName: UserDefaults.argumentDomain)
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
        var onServer = ""
        _ = await until(10) {
            guard let w = appWindows.first.flatMap(web), w.url?.host == "127.0.0.1" else { return false }
            onServer = await js(w, "String(window.__dvarimShell && window.__dvarimShell.mode)")
            return onServer == "server"
        }
        check(onServer == "server", "in server-only mode the server's page is told so", onServer)
    }

    /// The page's sign-in, done here: the password to /api/login, and the
    /// session cookie it sets put in the window's store, where a page puts it.
    static func signIn(_ server: String, password: String) async -> Bool {
        guard let url = URL(string: server + "/api/login") else { return false }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: ["password": password])
        r.httpShouldHandleCookies = false
        guard let (_, response) = try? await URLSession.shared.data(for: r), let http = response as? HTTPURLResponse,
              http.statusCode == 200 else { return false }
        let fields = http.allHeaderFields.reduce(into: [String: String]()) { $0["\($1.key)"] = "\($1.value)" }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
        for c in cookies { await WKWebsiteDataStore.default().httpCookieStore.setCookie(c) }
        return !cookies.isEmpty
    }

    // MARK: helpers

    /// The app on `root` for a section, in the argument domain: never saved,
    /// so the real app never finds itself on a temporary folder. Returns what
    /// to put back.
    static func useFolder(_ root: URL, _ extra: [String: Any] = [:]) -> [String: Any] {
        let saved = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        var args = saved
        args[Vault.modeKey] = "folder"
        args[Vault.folderKey] = root.path
        for (k, v) in extra { args[k] = v }
        UserDefaults.standard.setVolatileDomain(args, forName: UserDefaults.argumentDomain)
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
        return saved
    }

    /// Back to the server, and a window on it.
    static func leaveFolder(_ saved: [String: Any]) async {
        UserDefaults.standard.setVolatileDomain(saved, forName: UserDefaults.argumentDomain)
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
        if appWindows.isEmpty { Windows.open?("/today") }
        _ = await until(15) {
            guard let w = appWindows.first.flatMap(web), w.url?.scheme != AppScheme.scheme else { return false }
            return await page(w) != "loading"
        }
    }

    /// The first window's page, once its engine is up on the folder.
    static func folderWindow(_ timeout: Double = 20) async -> WKWebView? {
        var found: WKWebView?
        _ = await until(timeout) {
            guard let w = appWindows.first.flatMap(web), w.url?.scheme == AppScheme.scheme,
                  await js(w, "String(!!(window.__dvarimLocal && document.querySelector('.sidebar')))") == "true" else { return false }
            found = w
            return true
        }
        return found
    }

    /// An API route, answered by the page: {status, body}.
    static func ask(_ web: WKWebView, _ method: String, _ path: String, _ body: [String: Any]? = nil) async -> [String: Any]? {
        try? await web.callAsyncJavaScript("return await window.dvarim.request(method, path, body === null ? undefined : body)",
                                           arguments: ["method": method, "path": path, "body": body ?? NSNull()],
                                           contentWorld: .page) as? [String: Any]
    }

    static func syncPane(_ w: WKWebView) async -> Bool {
        if await js(w, "String(!!document.querySelector('[data-sync-state]'))") == "true" { return true }
        _ = await js(w, "document.querySelector('.sidefoot [aria-label=\"Settings\"]')?.click(); 'ok'")
        _ = await until(5) { await js(w, "String(!!document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"]'))") == "true" }
        _ = await js(w, "document.querySelector('#pane-tab-sync')?.click(); 'ok'")
        return await until(8) { await js(w, "String(!!document.querySelector('[data-sync-state]'))") == "true" }
    }

    static func syncState(_ w: WKWebView) async -> String {
        await js(w, "document.querySelector('[data-sync-state]')?.textContent.trim() || ''")
    }

    static func syncButton(_ w: WKWebView, _ label: String) async {
        _ = try? await w.callAsyncJavaScript(
            "[...document.querySelectorAll('.syncacts button')].find(b => b.textContent.trim().startsWith(label))?.click()",
            arguments: ["label": label], contentWorld: .page)
    }

    static func closeSettings(_ w: WKWebView) async {
        _ = await js(w, "document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"] .x')?.click(); 'ok'")
    }

    /// A value typed into a field as a person would, so the page's bindings hear it.
    static func fill(_ w: WKWebView, _ selector: String, _ value: String) async {
        _ = try? await w.callAsyncJavaScript("""
            const el = document.querySelector(selector);
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            """, arguments: ["selector": selector, "value": value], contentWorld: .page)
    }

    /// The Markdown files under `dir`, relative, sorted, leaving out .dvarim.
    static func markdown(_ dir: URL) -> [String] {
        let walk = FileManager.default.enumerator(atPath: dir.path)
        var out: [String] = []
        while let rel = walk?.nextObject() as? String {
            if rel.hasSuffix(".md") && !rel.hasPrefix(".dvarim/") { out.append(rel) }
        }
        return out.sorted()
    }

    static func contains(_ dir: URL, _ needle: String) -> Bool {
        let walk = FileManager.default.enumerator(atPath: dir.path)
        while let rel = walk?.nextObject() as? String {
            if text(dir.appendingPathComponent(rel)).contains(needle) { return true }
        }
        return false
    }

    /// Every line of every Markdown file in the vault.
    static func lines(_ dir: URL) -> [String] {
        markdown(dir).flatMap { text(dir.appendingPathComponent($0)).split(separator: "\n").map(String.init) }
    }

    static func text(_ url: URL) -> String { (try? String(contentsOf: url, encoding: .utf8)) ?? "" }

    static func append(_ url: URL, _ line: String) {
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    }
}
