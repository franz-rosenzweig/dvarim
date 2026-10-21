import AppKit
import Network
import ServiceManagement
import UserNotifications

/// The parts of the app that are the Mac's rather than the lists': Quick
/// Entry's chord, Today in the menu bar, the Dock badge, reminders, open at
/// login, and the heartbeat that keeps them current. Its settings are this
/// app's own (Prefs), like the rest.
@MainActor
@Observable
final class Shell {
    static let shared = Shell()

    nonisolated static let shortcutKey = "quickEntryShortcut"
    nonisolated static let menuBarKey = "menuBar"
    nonisolated static let remindersKey = "reminders"

    /// The web-view Dvarim, which has a menu bar, reminders and ⌃Space of its
    /// own: while it is in /Applications this app's start off (or on another
    /// chord), so that nothing shows twice. They take over once it goes.
    static let oldAppId = "moe.ptr.dvarim"
    static var besideOldApp: Bool {
        let plist = URL(fileURLWithPath: "/Applications/Dvarim.app/Contents/Info.plist")
        return (NSDictionary(contentsOf: plist)?["CFBundleIdentifier"] as? String) == oldAppId
    }

    private init() {}

    // ---- settings ---------------------------------------------------------------------

    var menuBar: Bool = Shell.flag(menuBarKey) {
        didSet { Prefs.store.set(menuBar, forKey: Self.menuBarKey) }
    }

    var reminders: Bool = Shell.flag(remindersKey) {
        didSet {
            Prefs.store.set(reminders, forKey: Self.remindersKey)
            Task { await Reminders.shared.turned(reminders) }
        }
    }

    /// On unless set, or off beside the web-view Dvarim.
    private static func flag(_ key: String) -> Bool {
        Prefs.store.object(forKey: key) == nil ? !besideOldApp : Prefs.store.bool(forKey: key)
    }

    // ---- Quick Entry's chord ----------------------------------------------------------

    /// The chord Quick Entry is on now, and why it is not the one asked for.
    private(set) var chord: Shortcut?
    private(set) var chordNote: String?
    private let hotKey = GlobalHotKey(id: 1)

    /// The chord recorded in Settings, or ⌃Space; beside the web-view Dvarim,
    /// which has ⌃Space, ⌃⌥Space, so that one chord doesn't open both. Two
    /// apps can register one chord, so that is decided here; a refusal means
    /// this app holds it already, or the chord can't be had.
    func registerQuickEntry() {
        let recorded = Shortcut.recorded
        let wanted = recorded ?? (Self.besideOldApp ? .controlOptionSpace : .controlSpace)
        var notes: [String] = []
        if recorded == nil, Self.besideOldApp {
            notes.append("⌃Space is the web-view Dvarim's while it is in Applications, so Quick Entry is on ⌃⌥Space here until it goes.")
        }
        if GlobalHotKey.systemUses(wanted) {
            notes.append("macOS uses \(wanted.display) itself (System Settings → Keyboard → Keyboard Shortcuts), and has it first. Choose another, or turn that one off.")
        }
        if hotKey.register(wanted, onFire: { QuickEntry.shared.toggle() }) {
            chord = wanted
        } else {
            chord = nil
            notes.append("\(wanted.display) can't be had. Choose another chord.")
        }
        chordNote = notes.isEmpty ? nil : notes.joined(separator: " ")
    }

    func record(_ s: Shortcut) {
        s.save()
        registerQuickEntry()
    }

    // ---- open at login ----------------------------------------------------------------

    var opensAtLogin: Bool { SMAppService.mainApp.status == .enabled }

    /// What went wrong, if anything: macOS refuses this for an app it does
    /// not count as installed, one more reason to keep it in /Applications.
    func openAtLogin(_ on: Bool) -> String? {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    // ---- the heartbeat ----------------------------------------------------------------

    private var beat: Task<Void, Never>?
    private let network = NWPathMonitor()
    private var online = true

    /// Every minute: what was kept goes, the badge and the menu bar are
    /// current, and a new day is a new Today. A network found again does the
    /// same at once, and catches the copy up.
    func start() {
        registerQuickEntry()
        beat?.cancel()
        beat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
                await self?.tick()
            }
        }
        network.pathUpdateHandler = { [weak self] path in
            let up = path.status == .satisfied
            Task { @MainActor in self?.networkChanged(up) }
        }
        network.start(queue: .global(qos: .utility))
    }

    func tick() async {
        await Outbox.shared.drain()
        await Session.shared.heartbeat()
    }

    private func networkChanged(_ up: Bool) {
        let back = up && !online
        online = up
        guard back else { return }
        Session.shared.catchUp()
        Task { await tick() }
    }

    // ---- after each refresh -----------------------------------------------------------

    /// The Session has a new state: the badge, the menu bar's list, the reminders.
    func stateChanged(_ state: AppState?) {
        Dock.show(state)
        if menuBar { Task { await TodayMenu.shared.load() } }
        Reminders.shared.soon()
    }
}

/// The Dock badge: what Settings → Dock badge says to count (the engine's
/// setting badgeCount, which the web app's Settings sets too). With no answer
/// from the server it keeps the count it had, less anything ticked here since.
@MainActor
enum Dock {
    private static var last: AppState?

    /// A fresh state, or nil for no answer: then as it was, less the ticks kept here.
    static func show(_ state: AppState?) {
        if let state { last = state }
        guard let s = state ?? last else { return label(nil) }
        let ticked = state == nil ? Outbox.shared.completing.count : 0
        switch s.badgeCount {
        case "inbox": label(s.inboxCount)
        case "none": label(nil)
        default: label(max(0, s.todayCount - ticked))
        }
    }

    static func clear() {
        last = nil
        label(nil)
    }

    private static func label(_ n: Int?) {
        NSApp.dockTile.badgeLabel = n.flatMap { $0 > 0 ? String($0) : nil }
    }
}
