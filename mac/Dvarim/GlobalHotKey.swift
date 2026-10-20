import AppKit
import Carbon.HIToolbox

/// One global hotkey, registered through Carbon's RegisterEventHotKey.
///
/// Carbon rather than NSEvent.addGlobalMonitorForEvents on purpose: the monitor
/// API needs Accessibility permission and cannot swallow the keystroke, while
/// RegisterEventHotKey needs no permission at all and takes the key cleanly
/// while another app is frontmost. It is old, but it is the API that works.
@MainActor
final class GlobalHotKey {
    static let shared = GlobalHotKey()

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var onFire: (() -> Void)?

    /// False when registering failed, which means another app already holds the chord.
    private(set) var isRegistered = false

    private init() {}

    /// Whether macOS has already spent this chord on one of its own shortcuts —
    /// ⌃Space switches keyboard layouts, ⌘Space is Spotlight, and the system wins
    /// over any app. Read from the system's own table so Settings can say so
    /// instead of the hotkey failing quietly.
    static func systemUses(_ shortcut: Shortcut) -> Bool {
        guard let table = UserDefaults(suiteName: "com.apple.symbolichotkeys")?
            .dictionary(forKey: "AppleSymbolicHotKeys") else { return false }
        return table.values.contains { value in
            guard let entry = value as? [String: Any], entry["enabled"] as? Bool == true,
                  let params = (entry["value"] as? [String: Any])?["parameters"] as? [Int], params.count == 3
            else { return false }
            return params[1] == Int(shortcut.keyCode) && UInt(params[2]) == shortcut.modifiers
        }
    }

    /// Whatever Settings recorded; ⌃Space to begin with.
    func register(_ shortcut: Shortcut = .current, onFire: @escaping () -> Void) {
        unregister()
        self.onFire = onFire

        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var id = EventHotKeyID()
            GetEventParameter(event,
                              EventParamName(kEventParamDirectObject),
                              EventParamType(typeEventHotKeyID),
                              nil,
                              MemoryLayout<EventHotKeyID>.size,
                              nil,
                              &id)
            if id.id == 1 {
                DispatchQueue.main.async { GlobalHotKey.shared.onFire?() }
            }
            return noErr
        }, 1, &spec, nil, &handlerRef)

        let id = EventHotKeyID(signature: 0x4456524D /* 'DVRM' */, id: 1)
        let status = RegisterEventHotKey(UInt32(shortcut.keyCode), shortcut.carbonModifiers,
                                         id, GetApplicationEventTarget(), 0, &hotKeyRef)
        isRegistered = status == noErr
        if status != noErr {
            NSLog("Dvarim: could not register \(shortcut.display) (status \(status)). Another app probably owns it.")
        }
    }

    func unregister() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        hotKeyRef = nil
        if let handlerRef { RemoveEventHandler(handlerRef) }
        handlerRef = nil
        isRegistered = false
    }
}
