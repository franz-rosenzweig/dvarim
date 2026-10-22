import AppKit
import SwiftUI
import Carbon.HIToolbox
import UserNotifications

/// Round 5 of the self-test: the Mac's parts. Quick Entry, the Services menu,
/// the Dock badge, Today in the menu bar, reminders, Shortcuts, the chord,
/// and the outbox. Nothing here is left on: the menu bar goes again, the
/// reminders are never asked of macOS, and open at login is not touched.
@MainActor
extension SelfTest {
    static func roundFive(_ m: AppModel, _ folder: URL) async {
        let today = m.state.today
        let tomorrow = Dates.iso.string(from: Calendar.current.date(byAdding: .day, value: 1, to: Dates.date(today) ?? Date())!)
        let qe = QuickEntry.shared

        // Quick Entry: typed into, Return, and the engine reads the words
        qe.show()
        check(await until(3) { qe.isShown && qe.panel?.isKeyWindow == true && qe.panel?.firstResponder is NSTextView },
              "Quick Entry opens over everything, ready to type",
              "shown \(qe.isShown), key \(qe.panel?.isKeyWindow == true), \(qe.panel?.firstResponder.map { String(describing: Swift.type(of: $0)) } ?? "nothing") has the keyboard")
        await pause(0.3)
        check(qe.panel?.frame.size == NSSize(width: QuickEntryView.width, height: QuickEntryView.height),
              "at its own size, no room for a title bar", "\(qe.panel?.frame.size ?? .zero)")
        typeInPanel("Call the bakery #errand tomorrow")
        await pause(0.3)
        await snapWindow(qe.panel, "quick-entry")
        submitPanel()
        check(await until(6) { !qe.isShown }, "Return saves it, and Quick Entry goes")
        let bakery = await until(6) { found(folder, "Call the bakery")?.text.contains("⏳ \(tomorrow)") == true }
        check(bakery && found(folder, "Call the bakery")?.text.contains("#errand") == true,
              "the engine reads its words: a day and a tag", found(folder, "Call the bakery")?.text ?? "nowhere")
        qe.toggle()
        check(qe.isShown, "the chord opens it")
        qe.toggle()
        check(await until(2) { !qe.isShown }, "and closes it again")

        // the Services menu: the chosen text, its first line the title
        let pb = NSPasteboard(name: NSPasteboard.Name("dvarim-native-selftest"))
        pb.clearContents()
        pb.setString("Pick up the proofs\nfrom the printer, before noon", forType: .string)
        var refusal: NSString?
        ServiceProvider().newToDo(pb, userData: nil, error: &refusal)
        check(qe.isShown && qe.draft.text == "Pick up the proofs" && qe.draft.notes == "from the printer, before noon",
              "New To-Do in the Services menu opens Quick Entry with the chosen text", "\(qe.draft.text) / \(qe.draft.notes)")
        await pause(0.3)
        await snapWindow(qe.panel, "service")
        qe.save()
        check(await until(6) { found(folder, "Pick up the proofs")?.under.contains { $0.contains("from the printer") } == true },
              "and the rest of it is the notes")
        pb.releaseGlobally()

        // the Dock badge: Today's count, or the Inbox's, as the setting says
        await m.refresh()
        check(NSApp.dockTile.badgeLabel == label(m.state.todayCount), "the Dock badge is Today's count",
              "\(NSApp.dockTile.badgeLabel ?? "none"), \(m.state.todayCount)")
        _ = try? await m.ask("PUT", "/api/settings", ["badgeCount": "inbox"])
        check(await until(5) { m.state.badgeCount == "inbox" && NSApp.dockTile.badgeLabel == label(m.state.inboxCount) },
              "set to count the Inbox, it does", "\(NSApp.dockTile.badgeLabel ?? "none"), \(m.state.inboxCount)")
        _ = try? await m.ask("PUT", "/api/settings", ["badgeCount": "today"])
        _ = await until(5) { m.state.badgeCount == "today" }

        // Today in the menu bar, and a tick there
        let shell = Shell.shared
        let before = statusItems.count
        shell.menuBar = true
        check(await until(4) { statusItems.count == before + 1 }, "Today can be in the menu bar", "\(before) → \(statusItems.count)")
        m.place = .today
        _ = await until(5) { !m.loading }
        await pause(0.3)
        await TodayMenu.shared.load()
        let open = m.content.allTodos.filter(\.isOpen)
        check(Set(TodayMenu.shared.items.map(\.id)) == Set(open.map(\.id)) && !open.isEmpty,
              "its list is Today's", "\(TodayMenu.shared.items.count) there, \(open.count) in the window")
        // A click on the item itself can't be made from here: on macOS 26 it is
        // a scene's, answered outside the app. Its list, drawn in a panel of
        // the test's own, for the picture.
        let sample = NSPanel(contentRect: NSRect(x: 200, y: 200, width: 290, height: 420), styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        let drawn = NSHostingView(rootView: MenuBarContent(menu: TodayMenu.shared, shell: shell))
        sample.contentView = drawn
        sample.setContentSize(drawn.fittingSize)
        sample.orderFrontRegardless()
        await pause(0.5)
        check(drawn.fittingSize.height > CGFloat(TodayMenu.shared.items.count) * 20, "its list draws a line for each", "\(Int(drawn.fittingSize.height)) points for \(TodayMenu.shared.items.count)")
        await snapWindow(sample, "menu-bar")
        sample.orderOut(nil)
        if let t = TodayMenu.shared.items.first {
            await m.refresh()
            let count = m.state.todayCount
            await TodayMenu.shared.complete(t)
            check(await until(6) { line(folder, t.id)?.text.hasPrefix("- [x]") == true }, "ticking a line there completes it")
            check(await until(6) { NSApp.dockTile.badgeLabel == label(count - 1) }, "and the badge follows",
                  "\(NSApp.dockTile.badgeLabel ?? "none") after \(count)")
            _ = try? await m.ask("POST", "/api/todos/\(t.id)/reopen", [:])
        }
        shell.menuBar = false
        check(await until(4) { statusItems.count == before }, "and it goes from the menu bar again", "\(statusItems.count)")

        // reminders: which are still to come today, and answering one
        let morning = Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: Dates.date(today) ?? Date())!
        let samples = [
            Todo(J(["id": "r1", "title": "Ring the printer", "status": "open", "when": today, "reminder": "09:30"])),
            Todo(J(["id": "r2", "title": "Gone by", "status": "open", "when": today, "reminder": "07:15"])),
            Todo(J(["id": "r3", "title": "Done already", "status": "done", "when": today, "reminder": "10:00"])),
            Todo(J(["id": "r4", "title": "No time", "status": "open", "when": today])),
        ]
        let wanted = Reminders.wanted(samples, now: morning)
        check(wanted.map(\.id) == ["r1"] && wanted.first?.at.hour == 9 && wanted.first?.at.minute == 30,
              "a reminder still to come today is asked for; one gone by, or done, is not", wanted.map(\.id).joined(separator: ","))
        if let t = open.first {
            await Reminders.shared.answer(Reminders.completeAction, id: t.id, title: t.title)
            check(await until(6) { line(folder, t.id)?.text.hasPrefix("- [x]") == true }, "a reminder's Complete button completes its to-do")
            _ = try? await m.ask("POST", "/api/todos/\(t.id)/reopen", [:])
            _ = await until(6) { line(folder, t.id)?.text.hasPrefix("- [ ]") == true }
            m.place = .inbox
            _ = await until(5) { !m.loading }
            await Reminders.shared.answer(UNNotificationDefaultActionIdentifier, id: t.id, title: t.title)
            check(await until(6) { m.openId == t.id }, "and a click on the reminder opens it in its list")
            await snap("reminder-opened")
            m.close()
        }

        // Shortcuts: the three intents, run as Shortcuts runs them
        let add = CreateToDo()
        add.text = "Water the plants"
        add.list = .today
        _ = try? await add.perform()
        check(await until(6) { found(folder, "Water the plants")?.text.contains("⏳ \(today)") == true },
              "Create To-Do, from Shortcuts, adds it to Today", found(folder, "Water the plants")?.text ?? "nowhere")
        let show = OpenList()
        show.list = .upcoming
        _ = try? await show.perform()
        check(await until(4) { m.place == .upcoming }, "Open List shows the list")
        _ = try? await ShowQuickEntry().perform()
        check(qe.isShown, "Show Quick Entry opens it")
        qe.close()
        check(Bundle.main.url(forResource: "Metadata", withExtension: "appintents") != nil, "and Shortcuts can find them: the app carries their metadata")

        // the chord: one, or Settings says why not; and one already held is refused
        check(shell.chord != nil || shell.chordNote != nil, "Quick Entry has a chord, or Settings says why not",
              shell.chord.map { $0.display + (shell.chordNote.map { ", " + $0 } ?? "") } ?? shell.chordNote ?? "")
        let test = Shortcut(keyCode: UInt16(kVK_F19), modifiers: NSEvent.ModifierFlags([.control, .option, .command]).rawValue, display: "⌃⌥⌘F19")
        let a = GlobalHotKey(id: 90), b = GlobalHotKey(id: 91)
        let first = a.register(test) {}
        let second = b.register(test) {}
        check(first && !second, "a chord this app holds already is refused", "\(first), \(second)")
        a.unregister()
        b.unregister()
    }

    /// Remote mode with no server: a Quick Entry line is kept on this Mac, and
    /// goes in once the server is back.
    static func outbox(_ m: AppModel) async {
        Prefs.store.set("http://127.0.0.1:9", forKey: Prefs.serverKey)
        await m.start()
        if case .failed = m.phase { check(true, "with no server, Remote mode says it can't reach it") }
        else { check(false, "with no server, Remote mode says it can't reach it", "\(m.phase)") }
        let outcome = try? await Outbox.shared.quickAdd("Kept while the server was away")
        let kept = if case .kept = outcome { true } else { false }
        check(kept && Outbox.shared.ops.count == 1 && FileManager.default.fileExists(atPath: Outbox.file.path),
              "a Quick Entry line is kept on this Mac meanwhile", "\(Outbox.shared.ops.count) kept")
        QuickEntry.shared.show()
        await pause(0.4)
        await snapWindow(QuickEntry.shared.panel, "kept")
        QuickEntry.shared.close()
        Prefs.store.set(server.absoluteString, forKey: Prefs.serverKey)
        await m.start()
        check(await until(10) { Outbox.shared.ops.isEmpty }, "and it goes in once the server is back")
        let remote = RemoteBackend(server: server)
        check(await until(5) {
            let j = try? await remote.request("GET", "/api/search?q=server", body: nil)
            return j?["todos"].array.contains { $0["title"].string == "Kept while the server was away" } == true
        }, "where the server has it")
    }

    // MARK: helpers

    private static func label(_ n: Int) -> String? { n > 0 ? String(n) : nil }

    /// The first line with this text, wherever it is.
    static func found(_ dir: URL, _ text: String) -> Found? {
        let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)
        while let u = e?.nextObject() as? URL {
            guard u.pathExtension == "md", !u.path.contains("/.") else { continue }
            let all = ((try? String(contentsOf: u, encoding: .utf8)) ?? "").components(separatedBy: "\n")
            guard let i = all.firstIndex(where: { $0.hasPrefix("- [") && $0.contains(text) }) else { continue }
            let under = all[(i + 1)...].prefix { $0.hasPrefix("    ") || $0.hasPrefix("\t") }
            return Found(file: String(u.path.dropFirst(dir.path.count + 1)), text: all[i], under: Array(under))
        }
        return nil
    }

    private static func typeInPanel(_ text: String) {
        guard let editor = QuickEntry.shared.panel?.firstResponder as? NSTextView else { return }
        editor.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
    }

    /// Return, as the keyboard sends it.
    private static func submitPanel() {
        guard let editor = QuickEntry.shared.panel?.firstResponder as? NSTextView else { return }
        editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    }

    /// This app's items in the menu bar, those still in it: each status
    /// window says which item it holds, and a removed one is in no bar.
    private static var statusItems: [NSStatusItem] {
        NSApp.windows.filter { $0.className.contains("StatusBarWindow") && $0.responds(to: Selector(("statusItem"))) }
            .compactMap { $0.value(forKey: "statusItem") as? NSStatusItem }
            // macOS 26 adds a copy of it, with no button, for each display
            .filter { $0.statusBar != nil && $0.isVisible && $0.button != nil }
            .uniqued
    }

    /// A picture of one window: a panel, the menu bar's.
    static func snapWindow(_ w: NSWindow?, _ name: String) async {
        step += 1
        guard let w, let image = windowImage(CGWindowID(w.windowNumber)) else { return }
        let file = out.appendingPathComponent(String(format: "%02d-%@.png", step, name))
        try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: file)
    }
}

private extension Array where Element == NSStatusItem {
    /// One item can show in several windows (a screen each).
    var uniqued: [NSStatusItem] {
        var out: [NSStatusItem] = []
        for i in self where !out.contains(where: { $0 === i }) { out.append(i) }
        return out
    }
}
