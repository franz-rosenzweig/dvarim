import AppKit
import WebKit

/// "New To-Do in Dvarim" in every app's Services menu, on whatever text is
/// selected. macOS lets you give it a key of your own in System Settings →
/// Keyboard → Keyboard Shortcuts → Services, which makes it a second capture
/// route when the Quick Entry chord is spoken for.
final class ServiceProvider: NSObject {
    @MainActor
    @objc func newToDo(_ pasteboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
        guard let text = pasteboard.string(forType: .string), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            error.pointee = "Dvarim: nothing to add"
            return
        }
        // Quick Entry opens with the selection in it, so the date words and #tags
        // still work and you can edit before saving: its first line is the
        // title and the rest the notes, as a share into the Android app does it.
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = body.split(whereSeparator: \.isNewline)
        let title = lines.first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        let rest = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        QuickEntryController.shared.show(text: title, notes: rest)
    }
}

/// SwiftUI's openWindow only exists inside a view, and the menu bar, the Services
/// handler and the intents all live outside one. Each window installs this as it
/// appears so they can still put a list on screen.
@MainActor
enum Windows {
    static var open: ((String) -> Void)?

    /// Shows a path of the web app: in the front window if there is one, in a new
    /// window if there is not.
    static func show(_ path: String) {
        NSApp.activate()
        if let window = NSApp.windows.first(where: { $0.isVisible && webView(in: $0.contentView) != nil }),
           let web = webView(in: window.contentView) {
            window.makeKeyAndOrderFront(nil)
            web.load(URLRequest(url: Vault.url(for: path)))
        } else {
            open?(path)
        }
    }

    /// The shell's own Settings, for the web app's Settings → Data, which links
    /// to dvarim://settings. SwiftUI's Settings scene has no door of its own
    /// that AppKit can call — `showSettingsWindow:` is refused from macOS 14 on
    /// — so this uses the menu item the scene puts in the app menu.
    static func openSettings() {
        NSApp.activate()
        guard let menu = NSApp.mainMenu?.items.first?.submenu,
              let i = menu.items.firstIndex(where: { $0.keyEquivalent == "," && $0.keyEquivalentModifierMask == .command })
        else { return }
        menu.performActionForItem(at: i)
    }

    private static func webView(in view: NSView?) -> WKWebView? {
        guard let view else { return nil }
        if let web = view as? WKWebView { return web }
        for sub in view.subviews { if let web = webView(in: sub) { return web } }
        return nil
    }
}
