import SwiftUI
import UserNotifications

@main
struct DvarimApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.openWindow) private var openWindow
    @AppStorage(Defaults.menuBarKey) private var menuBar = true
    @StateObject private var today = TodayMenu.shared

    var body: some Scene {
        WindowGroup(id: "main", for: WindowTarget.self) { $target in
            ContentView(target: target)
                // 720 was one point inside the web app's phone layout (max-width:720px).
                .frame(minWidth: SlimWindow.floor, minHeight: 520)
        }
        // No title bar: the traffic lights sit in the sidebar and the
        // page runs to the top of the window. The strip where the title bar was
        // still drags the window (and takes the clicks that land on it), so the
        // page keeps its own controls below it: see `.chromeless` in app.css.
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1100, height: 780)
        .commands {
            DvarimCommands { openWindow(id: "main") }
        }

        // Today's count beside the clock, its list behind it.
        MenuBarExtra(isInserted: $menuBar) {
            MenuBarContent()
        } label: {
            MenuBarLabel(menu: today)
        }
        .menuBarExtraStyle(.window)

        Settings { SettingsView() }
    }
}

extension Notification.Name {
    static let dvarimReload = Notification.Name("dvarim.reload")
}

/// Where a window opens: a path in the web app ("/today", "/project/<id>"). The
/// id makes every opening its own window, even two on the same list.
struct WindowTarget: Codable, Hashable {
    var path: String
    var id = UUID()
}

struct ContentView: View {
    var target: WindowTarget?
    @AppStorage(Defaults.serverKey) private var server = Defaults.defaultServer
    // Switching between the server and a folder, or to another folder, makes
    // the window again from the right place.
    @AppStorage(Vault.modeKey) private var mode = Vault.copyMode
    @AppStorage(Vault.folderKey) private var folder = ""
    @Environment(\.openWindow) private var openWindow
    @State private var reloadToken = UUID()

    var body: some View {
        WebView(url: Vault.url(for: target?.path ?? "/"),
                openWindow: { path in openWindow(id: "main", value: WindowTarget(path: path)) })
            .id("\(server)-\(mode)-\(folder)-\(reloadToken)")
            .ignoresSafeArea()
            .onAppear { Windows.open = { openWindow(id: "main", value: WindowTarget(path: $0)) } }
            .onReceive(NotificationCenter.default.publisher(for: .dvarimReload)) { _ in
                reloadToken = UUID()
            }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let services = ServiceProvider()

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        // "New To-Do in Dvarim" on any app's selection, declared in project.yml.
        NSApp.servicesProvider = services
        NSUpdateDynamicServices()

        if UserDefaults.standard.object(forKey: Defaults.hotkeyEnabledKey) == nil
            || UserDefaults.standard.bool(forKey: Defaults.hotkeyEnabledKey) {
            GlobalHotKey.shared.register { QuickEntryController.shared.toggle() }
        }

        Task {
            // A Mac that has only ever used the server keeps a copy from now on,
            // set up from the sign-in it already has.
            await AppCopy.setUpIfSignedIn()
            await BadgeUpdater.shared.start()
            await ReminderScheduler.shared.requestPermission()
            await ReminderScheduler.shared.start()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Reopening from the Dock with no window open should give you one back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // SwiftUI restores the window group itself; returning true is enough.
        true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        guard let id = content.userInfo["id"] as? String else { return }
        await ReminderAnswer.handle(response.actionIdentifier, id: id,
                                    title: content.userInfo["title"] as? String ?? content.title)
    }
}
