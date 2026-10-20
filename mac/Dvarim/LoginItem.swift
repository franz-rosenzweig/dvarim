import ServiceManagement

/// Open at login. A shell that is not running has no badge, no hotkey and no
/// reminders, so for a task app this is closer to required than to a nicety.
@MainActor
enum LoginItem {
    static var isOn: Bool { SMAppService.mainApp.status == .enabled }

    /// Returns what went wrong, if anything: macOS refuses this for an app it does
    /// not consider installed, which is another reason to keep it in /Applications.
    static func set(_ on: Bool) -> String? {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
