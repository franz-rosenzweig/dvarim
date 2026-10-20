import AppKit
import Carbon.HIToolbox
import SwiftUI

/// The chord that opens Quick Entry. ⌃Space to begin with, but that one is
/// popular: macOS switches keyboard layouts with it and other apps want it
/// too, so this is recorded in Settings rather than fixed in the source.
struct Shortcut: Codable, Equatable {
    var keyCode: UInt16
    /// NSEvent.ModifierFlags raw value, narrowed to ⌘⌥⌃⇧.
    var modifiers: UInt
    /// What to show in Settings, worked out when the chord was pressed.
    var display: String

    static let controlSpace = Shortcut(keyCode: UInt16(kVK_Space),
                                       modifiers: NSEvent.ModifierFlags.control.rawValue,
                                       display: "⌃Space")

    /// Reads back what Settings recorded, or ⌃Space the first time.
    static var current: Shortcut {
        guard let data = UserDefaults.standard.data(forKey: Defaults.shortcutKey),
              let saved = try? JSONDecoder().decode(Shortcut.self, from: data) else { return .controlSpace }
        return saved
    }

    func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(self), forKey: Defaults.shortcutKey)
    }

    /// Carbon wants its own modifier bits, not AppKit's.
    var carbonModifiers: UInt32 {
        let flags = NSEvent.ModifierFlags(rawValue: modifiers)
        var m: UInt32 = 0
        if flags.contains(.command) { m |= UInt32(cmdKey) }
        if flags.contains(.option) { m |= UInt32(optionKey) }
        if flags.contains(.control) { m |= UInt32(controlKey) }
        if flags.contains(.shift) { m |= UInt32(shiftKey) }
        return m
    }

    /// A chord as pressed, or nil if it is not one a global hotkey can have:
    /// macOS keeps plain keys and Shift-only combinations for typing.
    init?(event: NSEvent) {
        let flags = event.modifierFlags.intersection([.command, .option, .control, .shift])
        guard flags.contains(.command) || flags.contains(.option) || flags.contains(.control) else { return nil }
        keyCode = event.keyCode
        modifiers = flags.rawValue
        display = (flags.contains(.control) ? "⌃" : "") + (flags.contains(.option) ? "⌥" : "")
            + (flags.contains(.shift) ? "⇧" : "") + (flags.contains(.command) ? "⌘" : "")
            + Shortcut.keyName(event)
    }

    init(keyCode: UInt16, modifiers: UInt, display: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.display = display
    }

    private static let named: [UInt16: String] = [
        UInt16(kVK_Space): "Space", UInt16(kVK_Return): "↩", UInt16(kVK_Tab): "⇥",
        UInt16(kVK_Delete): "⌫", UInt16(kVK_ForwardDelete): "⌦", UInt16(kVK_Escape): "⎋",
        UInt16(kVK_LeftArrow): "←", UInt16(kVK_RightArrow): "→",
        UInt16(kVK_UpArrow): "↑", UInt16(kVK_DownArrow): "↓",
        UInt16(kVK_F1): "F1", UInt16(kVK_F2): "F2", UInt16(kVK_F3): "F3", UInt16(kVK_F4): "F4",
        UInt16(kVK_F5): "F5", UInt16(kVK_F6): "F6", UInt16(kVK_F7): "F7", UInt16(kVK_F8): "F8",
        UInt16(kVK_F9): "F9", UInt16(kVK_F10): "F10", UInt16(kVK_F11): "F11", UInt16(kVK_F12): "F12",
    ]

    private static func keyName(_ event: NSEvent) -> String {
        if let name = named[event.keyCode] { return name }
        let typed = event.charactersIgnoringModifiers ?? ""
        return typed.isEmpty ? "key \(event.keyCode)" : typed.uppercased()
    }
}

/// Click it, press the chord you want. Escape leaves it as it was, and a chord
/// macOS will not give an app gets a beep rather than a silent nothing.
struct ShortcutRecorder: View {
    @Binding var shortcut: Shortcut
    @State private var recording = false
    @State private var monitor: Any?

    var body: some View {
        Button(recording ? "press a chord…" : shortcut.display) {
            if recording { stop() } else { start() }
        }
        .buttonStyle(.bordered)
        .monospaced()
        .onDisappear(perform: stop)
    }

    private func start() {
        recording = true
        // A local monitor sees the keys before the window does, which is the point.
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == UInt16(kVK_Escape) { stop(); return nil }
            if let pressed = Shortcut(event: event) {
                shortcut = pressed
                pressed.save()
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
