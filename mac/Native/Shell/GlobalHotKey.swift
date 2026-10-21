import AppKit
import Carbon.HIToolbox
import SwiftUI

/// A global hotkey, through Carbon's RegisterEventHotKey: it needs no
/// permission, and takes the key cleanly while another app is in front, where
/// NSEvent's global monitor needs Accessibility and can't swallow the key.
@MainActor
final class GlobalHotKey {
    let id: UInt32
    private var ref: EventHotKeyRef?
    private static var handler: EventHandlerRef?
    private static var fire: [UInt32: () -> Void] = [:]

    init(id: UInt32) { self.id = id }

    private(set) var isRegistered = false

    /// Whether macOS spends this chord on one of its own shortcuts (⌃Space
    /// switches input sources, ⌘Space is Spotlight), from its own table, so
    /// that Settings can say so.
    static func systemUses(_ s: Shortcut) -> Bool {
        guard let table = UserDefaults(suiteName: "com.apple.symbolichotkeys")?
            .dictionary(forKey: "AppleSymbolicHotKeys") else { return false }
        return table.values.contains { value in
            guard let entry = value as? [String: Any], entry["enabled"] as? Bool == true,
                  let params = (entry["value"] as? [String: Any])?["parameters"] as? [Int], params.count == 3
            else { return false }
            return params[1] == Int(s.keyCode) && UInt(params[2]) == s.modifiers
        }
    }

    /// False when another app (or this one) holds the chord already.
    @discardableResult
    func register(_ s: Shortcut, onFire: @escaping () -> Void) -> Bool {
        unregister()
        Self.installHandler()
        Self.fire[id] = onFire
        let hotKeyId = EventHotKeyID(signature: 0x4456_524E /* 'DVRN' */, id: id)
        let status = RegisterEventHotKey(UInt32(s.keyCode), s.carbonModifiers, hotKeyId, GetApplicationEventTarget(), 0, &ref)
        isRegistered = status == noErr
        if !isRegistered { ref = nil }
        return isRegistered
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
        Self.fire[id] = nil
        isRegistered = false
    }

    private static func installHandler() {
        guard handler == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hk = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            let id = hk.id
            DispatchQueue.main.async { MainActor.assumeIsolated { GlobalHotKey.fire[id]?() } }
            return noErr
        }, 1, &spec, nil, &handler)
    }
}

/// The chord that opens Quick Entry: ⌃Space, unless Settings recorded another.
struct Shortcut: Codable, Equatable, Sendable {
    var keyCode: UInt16
    /// NSEvent.ModifierFlags, only ⌘⌥⌃⇧.
    var modifiers: UInt
    var display: String

    static let controlSpace = Shortcut(keyCode: UInt16(kVK_Space), modifiers: NSEvent.ModifierFlags.control.rawValue, display: "⌃Space")
    static let controlOptionSpace = Shortcut(keyCode: UInt16(kVK_Space),
                                             modifiers: NSEvent.ModifierFlags([.control, .option]).rawValue, display: "⌃⌥Space")

    static var recorded: Shortcut? {
        guard let data = Prefs.store.data(forKey: Shell.shortcutKey) else { return nil }
        return try? JSONDecoder().decode(Shortcut.self, from: data)
    }

    func save() { Prefs.store.set(try? JSONEncoder().encode(self), forKey: Shell.shortcutKey) }

    var carbonModifiers: UInt32 {
        let f = NSEvent.ModifierFlags(rawValue: modifiers)
        var m: UInt32 = 0
        if f.contains(.command) { m |= UInt32(cmdKey) }
        if f.contains(.option) { m |= UInt32(optionKey) }
        if f.contains(.control) { m |= UInt32(controlKey) }
        if f.contains(.shift) { m |= UInt32(shiftKey) }
        return m
    }

    init(keyCode: UInt16, modifiers: UInt, display: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.display = display
    }

    /// A chord as pressed, or nil for one a global hotkey can't have: macOS
    /// keeps plain keys and Shift alone for typing.
    init?(event: NSEvent) {
        let f = event.modifierFlags.intersection([.command, .option, .control, .shift])
        guard f.contains(.command) || f.contains(.option) || f.contains(.control) else { return nil }
        keyCode = event.keyCode
        modifiers = f.rawValue
        display = (f.contains(.control) ? "⌃" : "") + (f.contains(.option) ? "⌥" : "")
            + (f.contains(.shift) ? "⇧" : "") + (f.contains(.command) ? "⌘" : "") + Self.keyName(event)
    }

    private static let named: [UInt16: String] = [
        UInt16(kVK_Space): "Space", UInt16(kVK_Return): "↩", UInt16(kVK_Tab): "⇥",
        UInt16(kVK_Delete): "⌫", UInt16(kVK_ForwardDelete): "⌦",
        UInt16(kVK_LeftArrow): "←", UInt16(kVK_RightArrow): "→", UInt16(kVK_UpArrow): "↑", UInt16(kVK_DownArrow): "↓",
        UInt16(kVK_F1): "F1", UInt16(kVK_F2): "F2", UInt16(kVK_F3): "F3", UInt16(kVK_F4): "F4",
        UInt16(kVK_F5): "F5", UInt16(kVK_F6): "F6", UInt16(kVK_F7): "F7", UInt16(kVK_F8): "F8",
        UInt16(kVK_F9): "F9", UInt16(kVK_F10): "F10", UInt16(kVK_F11): "F11", UInt16(kVK_F12): "F12",
    ]

    private static func keyName(_ e: NSEvent) -> String {
        if let n = named[e.keyCode] { return n }
        let typed = e.charactersIgnoringModifiers ?? ""
        return typed.isEmpty ? "key \(e.keyCode)" : typed.uppercased()
    }
}

/// Click it, press the chord. Escape leaves it as it was; a chord a global
/// hotkey can't have gets a beep.
struct ShortcutRecorder: View {
    let shell: Shell
    @State private var recording = false
    @State private var monitor: Any?

    var body: some View {
        Button(recording ? "Press a chord…" : shell.chord?.display ?? "None") {
            if recording { stop() } else { start() }
        }
        .buttonStyle(.bordered)
        .monospaced()
        .onDisappear(perform: stop)
    }

    private func start() {
        recording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            if e.keyCode == UInt16(kVK_Escape) { stop(); return nil }
            if let s = Shortcut(event: e) {
                shell.record(s)
                stop()
            } else {
                NSSound.beep()
            }
            return nil
        }
    }

    private func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        recording = false
    }
}
