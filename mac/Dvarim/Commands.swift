import AppKit
import SwiftUI

/// The menu bar.
///
/// On a Mac a command that is not in a menu may as well not exist: nothing tells
/// you ⇧⌘Y files completed to-dos, or that ⇧⌘R now opens the repeat editor. The
/// web app knows both — `window.dvarim` (frontend/src/lib/shell.js) hands over
/// the keymap — so the menu is a view onto it rather than a second copy.
///
/// Each item runs its command by id, so rebinding a key in Settings → Keyboard
/// moves the key without breaking the menu item. The shortcut *printed* beside
/// it is the default, because a SwiftUI menu wants its shortcuts at build time;
/// rebind something and the menu will keep advertising the old key while doing
/// the right thing. That is the one seam, and it is the quiet way round.
///
/// Pressing the key never reaches here: WKWebView hands key equivalents to the
/// page first, which is what makes ⌘N a new to-do rather than a new window.
/// These items are for the mouse, and for reading.
@MainActor
enum Dvarim {
    /// The web view in the window the person is looking at.
    static var focused: ShellWebView? {
        let windows = [NSApp.keyWindow, NSApp.mainWindow].compactMap { $0 } + NSApp.windows
        for window in windows {
            if let view = window.contentView, let web = search(view) { return web }
        }
        return nil
    }

    private static func search(_ view: NSView) -> ShellWebView? {
        if let web = view as? ShellWebView { return web }
        for sub in view.subviews {
            if let web = search(sub) { return web }
        }
        return nil
    }

    /// Ask the page to run one of its own commands.
    static func run(_ id: String) {
        guard let web = focused else { return }
        let escaped = id.replacingOccurrences(of: "'", with: "\\'")
        web.evaluateJavaScript("window.dvarim && window.dvarim.run('\(escaped)')")
    }
}

/// One menu item: a title, the command it runs, and the key it advertises.
private struct Item: View {
    let title: String
    let id: String
    var key: KeyEquivalent?
    var modifiers: EventModifiers = .command

    var body: some View {
        let button = Button(title) { Dvarim.run(id) }
        if let key {
            button.keyboardShortcut(key, modifiers: modifiers)
        } else {
            button
        }
    }
}

struct DvarimCommands: Commands {
    var newWindow: () -> Void

    var body: some Commands {
        // ⌘N is deliberately left to the web app, where it means New To-Do.
        // New Window moves to ⌃⌘N.
        CommandGroup(replacing: .newItem) {
            Item(title: "New To-Do", id: "todo.new", key: "n")
            Item(title: "New Project", id: "project.new", key: "n", modifiers: [.command, .option])
            Item(title: "New Heading", id: "heading.new", key: "n", modifiers: [.command, .shift])
            Divider()
            Button("New Window") { newWindow() }
                .keyboardShortcut("n", modifiers: [.command, .control])
            Button("Quick Entry") { QuickEntryController.shared.show() }
                .keyboardShortcut(.space, modifiers: [.control])
        }

        CommandMenu("Go") {
            Item(title: "Inbox", id: "go.inbox", key: "1")
            Item(title: "Today", id: "go.today", key: "2")
            Item(title: "Upcoming", id: "go.upcoming", key: "3")
            Item(title: "Anytime", id: "go.anytime", key: "4")
            Item(title: "Someday", id: "go.someday", key: "5")
            Item(title: "Logbook", id: "go.logbook", key: "6")
            Divider()
            Item(title: "Quick Find…", id: "find", key: "f")
        }

        CommandMenu("To-Do") {
            Item(title: "Complete", id: "todo.complete", key: "k")
            Item(title: "Cancel", id: "todo.cancel", key: "k", modifiers: [.command, .option])
            Item(title: "Move to Trash", id: "todo.trash")
            Divider()
            Item(title: "When…", id: "todo.when", key: "s")
            Item(title: "Today", id: "todo.today", key: "t")
            Item(title: "This Evening", id: "todo.evening", key: "e")
            Item(title: "Anytime", id: "todo.anytime", key: "r")
            Item(title: "Someday", id: "todo.someday", key: "o")
            Item(title: "Deadline…", id: "todo.deadline", key: "d", modifiers: [.command, .shift])
            Item(title: "Repeat…", id: "todo.repeat", key: "r", modifiers: [.command, .shift])
            Divider()
            Item(title: "Move…", id: "todo.move", key: "m", modifiers: [.command, .shift])
            Item(title: "Tags…", id: "todo.tags", key: "t", modifiers: [.command, .shift])
            Item(title: "Checklist", id: "todo.checklist", key: "c", modifiers: [.command, .shift])
            Item(title: "Convert to Project", id: "todo.convert", key: "p", modifiers: [.command, .shift])
            Item(title: "Duplicate", id: "todo.duplicate", key: "d")
            Divider()
            Item(title: "Move Up", id: "todo.moveUp", key: .upArrow)
            Item(title: "Move Down", id: "todo.moveDown", key: .downArrow)
            Divider()
            Item(title: "Log Completed Items", id: "log.now", key: "y", modifiers: [.command, .shift])
        }

        // ⇧⌘R is the web app's Repeat… now, so Reload moves out of its way. ⌃
        // chords reach the menu before the page, so ⌃⌘R is certain to arrive.
        CommandGroup(after: .toolbar) {
            // The sidebar put away. The page does the work, and answers the two-finger swipe
            // on its own (frontend/src/lib/slim.svelte.js); this is the part a Mac
            // expects to find written down: View, ⌘/.
            Item(title: "Show or Hide Sidebar", id: "sidebar.toggle", key: "/")
            Divider()
            Button("Reload") { NotificationCenter.default.post(name: .dvarimReload, object: nil) }
                .keyboardShortcut("r", modifiers: [.command, .control])
        }
    }
}
