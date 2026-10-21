import AppKit
import SwiftUI

/// Dvarim as a native Mac app: every screen SwiftUI and AppKit, and the
/// one engine the server and every other device run, inside the app
/// (EngineHost). It lives beside the web-view Dvarim under its own name and
/// bundle id until it does everything that one does.
@main
struct DvarimNativeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared
    @Environment(\.openWindow) private var openWindow

    init() {
        // the self-test's settings, folder and sign-in are its own, from the first read
        if SelfTest.asked { SelfTest.prepare() }
    }

    var body: some Scene {
        WindowGroup("Dvarim", id: "main") {
            MainView(model: model)
                .task { if model.phase == .starting && model.backend == nil { await model.start() } }
        }
        .defaultSize(width: 980, height: 660)
        .commands {
            CommandMenu("Go") {
                go("Inbox", .inbox, "1")
                go("Today", .today, "2")
                go("Upcoming", .upcoming, "3")
                go("Anytime", .anytime, "4")
                go("Someday", .someday, "5")
                go("Logbook", .logbook, "6")
                go("Trash", .trash, "7")
            }
            CommandGroup(replacing: .newItem) {
                Button("New To-Do") { Task { await model.newTodo() } }.keyboardShortcut("n")
                Button("New Window") { openWindow(id: "main") }.keyboardShortcut("n", modifiers: [.control, .command])
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
                Divider()
                Button("Duplicate") { Task { await model.duplicateChosen() } }.keyboardShortcut("d")
                Button("Move to Trash") { Task { await model.trashChosen() } }.keyboardShortcut(.delete, modifiers: [.command])
                Divider()
                Button("Log Completed") { Task { await model.logNow() } }.keyboardShortcut("y", modifiers: [.shift, .command])
            }
            CommandGroup(after: .toolbar) {
                Button("Reload") { Task { await model.refresh() } }.keyboardShortcut("r")
            }
        }

        Settings {
            SettingsView(model: model)
        }
    }

    private func pick(_ p: (String) -> AppModel.Popover) {
        guard let t = model.chosen.first else { return }
        model.popover = p(t.id)
    }

    private func go(_ title: String, _ place: Place, _ key: KeyEquivalent) -> some View {
        Button(title) { model.place = place }.keyboardShortcut(key)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false
        if SelfTest.asked { SelfTest.start() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationDidBecomeActive(_ notification: Notification) {
        MainActor.assumeIsolated { AppModel.shared.catchUp() }
    }
}
