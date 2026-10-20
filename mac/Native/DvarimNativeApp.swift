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
            CommandGroup(after: .toolbar) {
                Button("Reload") { Task { await model.refresh() } }.keyboardShortcut("r")
            }
        }

        Settings {
            SettingsView(model: model)
        }
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
