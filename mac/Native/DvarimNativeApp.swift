import AppKit
import SwiftUI
import UserNotifications

/// Dvarim as a native Mac app: every screen SwiftUI and AppKit, and the
/// one engine the server and every other device run, inside the app
/// (EngineHost). It lives beside the web-view Dvarim under its own name and
/// bundle id until it does everything that one does.
@main
struct DvarimNativeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var shell = Shell.shared

    init() {
        // the self-test's settings, folder and sign-in are its own, from the first read
        if SelfTest.asked { SelfTest.prepare() }
    }

    var body: some Scene {
        // Several windows, each on a list of its own (⌃⌘N, or Open in New
        // Window), all on the one Session: a change in one shows in all.
        WindowGroup("Dvarim", id: "main", for: Place.self) { $start in
            WindowRoot(start: start)
        }
        .defaultSize(width: 980, height: 660)
        .commands { DvarimCommands() }

        Settings {
            SettingsView(model: AppModel.shared)
        }

        // Today beside the clock (Settings → This Mac). Read here, not only
        // through the binding, so that turning it off takes it away again.
        let inMenuBar = shell.menuBar
        MenuBarExtra(isInserted: Binding(get: { inMenuBar }, set: { if shell.menuBar != $0 { shell.menuBar = $0 } })) {
            MenuBarContent(menu: TodayMenu.shared, shell: shell)
        } label: {
            MenuBarLabel(session: Session.shared)
        }
        .menuBarExtraStyle(.window)
    }
}

/// One window: its own model, given to the menus while the window is in front.
struct WindowRoot: View {
    let start: Place?
    @State private var model = AppModel.forWindow()
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        MainView(model: model)
            .focusedSceneValue(\.windowModel, model)
            .background(WindowReader(model: model))
            .task {
                Windows.openNew = { openWindow(id: "main", value: $0) }
                if let start { model.place = start }
                if model.session.phase == .starting && model.session.backend == nil { await model.session.startIfNeeded() }
                if model.phase == .ready { await model.loadList() }
            }
    }
}

struct WindowModelKey: FocusedValueKey { typealias Value = AppModel }
extension FocusedValues {
    var windowModel: AppModel? {
        get { self[WindowModelKey.self] }
        set { self[WindowModelKey.self] = newValue }
    }
}

/// The menus, acting on the window in front.
struct DvarimCommands: Commands {
    @FocusedValue(\.windowModel) private var focused
    @Environment(\.openWindow) private var openWindow
    private var model: AppModel { focused ?? AppModel.shared }

    var body: some Commands {
        CommandMenu("Go") {
            go("Inbox", .inbox, "1")
            go("Today", .today, "2")
            go("Upcoming", .upcoming, "3")
            go("Anytime", .anytime, "4")
            go("Someday", .someday, "5")
            go("Logbook", .logbook, "6")
            go("Trash", .trash, "7")
        }
        CommandGroup(replacing: .undoRedo) {
            Button(undoTitle) { undo(redo: false) }.keyboardShortcut("z")
            Button(redoTitle) { undo(redo: true) }.keyboardShortcut("z", modifiers: [.shift, .command])
        }
        CommandGroup(replacing: .pasteboard) {
            Button("Cut") { NSApp.sendAction(#selector(NSText.cut(_:)), to: nil, from: nil) }.keyboardShortcut("x")
            Button("Copy") { NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil) }.keyboardShortcut("c")
            Button("Paste") { NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: nil) }.keyboardShortcut("v")
            // ⌘A: everything in a field while one has the keyboard, else every to-do in the list
            Button("Select All") {
                if NSApp.keyWindow?.firstResponder is NSTextView {
                    NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil)
                } else {
                    model.selectAll()
                }
            }
            .keyboardShortcut("a")
        }
        CommandGroup(replacing: .newItem) {
            Button("New To-Do") { Task { await model.newTodo() } }.keyboardShortcut("n")
            Button("New Heading") { Task { await model.newHeading() } }.keyboardShortcut("n", modifiers: [.shift, .command])
            Button("New Project") { Task { await model.newProject() } }.keyboardShortcut("n", modifiers: [.option, .command])
            Button("New Area") { Task { await model.newArea() } }
            Divider()
            Button("New Window") { openWindow(id: "main", value: model.place) }.keyboardShortcut("n", modifiers: [.control, .command])
            Button("Quick Entry") { QuickEntry.shared.show() }
        }
        CommandMenu("Items") {
            Button("Complete") { Task { await model.completeChosen() } }.keyboardShortcut("k")
            Button("Cancel") { Task { await model.cancelChosen() } }.keyboardShortcut("k", modifiers: [.option, .command])
            Divider()
            Button("When…") { pick { .when($0) } }.keyboardShortcut("s")
            Button("Today") { Task { await model.setWhen(.today) } }.keyboardShortcut("t")
            Button("This Evening") { Task { await model.setWhen(.evening) } }.keyboardShortcut("e")
            Button("Anytime") { Task { await model.setWhen(.anytime) } }.keyboardShortcut("r")
            Button("Someday") { Task { await model.setWhen(.someday) } }.keyboardShortcut("o")
            Divider()
            Button("Deadline…") { pick { .deadline($0) } }.keyboardShortcut("d", modifiers: [.shift, .command])
            Button("Tags…") { pick { .tags($0) } }.keyboardShortcut("t", modifiers: [.shift, .command])
            Button("Move…") { pick { .move($0) } }.keyboardShortcut("m", modifiers: [.shift, .command])
            Button("Checklist") { if let t = model.chosen.first { model.open(t.id, focusTitle: false) } }.keyboardShortcut("c", modifiers: [.shift, .command])
            Button("Repeat…") { pick { .repeating($0) } }.keyboardShortcut("r", modifiers: [.shift, .command])
            Button("Convert to Project") { Task { await model.convertChosen() } }.keyboardShortcut("p", modifiers: [.shift, .command])
            Divider()
            Button("Duplicate") { Task { await model.duplicateChosen() } }.keyboardShortcut("d")
            Button("Move to Trash") { Task { await model.trashChosen() } }.keyboardShortcut(.delete, modifiers: [.command])
            Divider()
            Button("Log Completed") { Task { await model.logNow() } }.keyboardShortcut("y", modifiers: [.shift, .command])
        }
        CommandGroup(after: .textEditing) {
            Button("Quick Find") { model.finding = true }.keyboardShortcut("f")
        }
        CommandGroup(after: .toolbar) {
            // ⌃⌘R: ⌘R is Anytime, in the Items menu
            Button("Reload") { Task { await model.refresh() } }.keyboardShortcut("r", modifiers: [.control, .command])
        }
    }

    /// ⌘Z: typing's undo while a field has the keyboard, else the app's own history.
    private func undo(redo: Bool) {
        if let field = NSApp.keyWindow?.firstResponder as? NSTextView, let u = field.undoManager,
           redo ? u.canRedo : u.canUndo {
            NSApp.sendAction(Selector(redo ? "redo:" : "undo:"), to: nil, from: nil)
            return
        }
        if redo { model.history.redo() } else { model.history.undo() }
        model.notice = nil
    }

    private var undoTitle: String { model.history.canUndo ? "Undo " + model.history.undoActionName : "Undo" }
    private var redoTitle: String { model.history.canRedo ? "Redo " + model.history.redoActionName : "Redo" }

    private func pick(_ p: (String) -> AppModel.Popover) {
        guard let t = model.chosen.first else { return }
        model.popover = p(t.id)
    }

    private func go(_ title: String, _ place: Place, _ key: KeyEquivalent) -> some View {
        Button(title) { model.place = place }.keyboardShortcut(key)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false
        MainActor.assumeIsolated {
            // the Mac's parts: Quick Entry's chord, the heartbeat, reminders, Services
            UNUserNotificationCenter.current().delegate = self
            Shell.shared.start()
            Reminders.shared.start()
            // an install that takes over from an app that opened at login: -OpenAtLogin YES
            if !SelfTest.asked, UserDefaults.standard.bool(forKey: "OpenAtLogin") {
                if let problem = Shell.shared.openAtLogin(true) { NSLog("Dvarim: open at login: \(problem)") }
            }
            NSApp.servicesProvider = ServiceProvider()
            NSUpdateDynamicServices()
            if SelfTest.asked { SelfTest.start() }
            // started here, not by a window: Shortcuts and Quick Entry need none
            Task { await Session.shared.startIfNeeded() }
        }
    }

    // a reminder shows while the app is in front too
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let id = info["id"] as? String else { return }
        let title = info["title"] as? String ?? ""
        let action = response.actionIdentifier
        await Reminders.shared.answer(action, id: id, title: title)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationDidBecomeActive(_ notification: Notification) {
        MainActor.assumeIsolated { AppModel.shared.catchUp() }
    }
}
