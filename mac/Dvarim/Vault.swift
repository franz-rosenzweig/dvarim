import AppKit
import Foundation

/// Where the to-dos live, as a mode:
///
/// - "copy", the default: on this Mac, in a private folder the page keeps in
///   step with the server (AppCopy). The page comes from inside the app, so
///   it opens offline. Until the first sign-in there is no copy, and windows
///   show the server's page to sign in on.
/// - "server": on the server only, as the app always worked. The page comes
///   from the server, and offline is what its service worker can do.
/// - "folder": in a folder on this Mac the person chose, read and written
///   through FolderBridge (docs/BRIDGE.md) — an Obsidian vault, a Syncthing
///   folder.
enum Vault {
    static let modeKey = "vaultMode"          // "copy" | "server" | "folder"; none set is "copy"
    static let folderKey = "vaultFolder"      // a path; the app is not sandboxed
    static let copyMode = "copy"

    /// The page, served from inside the app in folder mode (AppScheme).
    static let appOrigin = URL(string: "dvarim-app://app/")!

    static var mode: String { UserDefaults.standard.string(forKey: modeKey) ?? copyMode }

    /// The folder in use: the chosen one in folder mode, the private copy in
    /// copy mode once there is one; nil otherwise, or if a chosen folder has
    /// gone missing.
    static var folder: URL? {
        switch mode {
        case "folder":
            guard let path = UserDefaults.standard.string(forKey: folderKey) else { return nil }
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else { return nil }
            return URL(fileURLWithPath: path, isDirectory: true)
        case copyMode:
            return AppCopy.folder
        default:
            return nil
        }
    }

    static var usesFolder: Bool { folder != nil && webBundle != nil }

    /// The folder chosen last, whatever the mode: what choosing "a folder" again
    /// goes back to.
    static var folderPath: String? {
        UserDefaults.standard.string(forKey: folderKey).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The built web app inside Dvarim.app (build.sh copies frontend/dist there).
    static var webBundle: URL? {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
              FileManager.default.fileExists(atPath: url.appendingPathComponent("index.html").path) else { return nil }
        return url
    }

    /// Where a window opens a path of the web app ("/today") in the current mode.
    static func url(for path: String) -> URL {
        let base = usesFolder ? appOrigin : Defaults.server
        return URL(string: path, relativeTo: base) ?? base
    }

    static func useFolder(_ url: URL) {
        UserDefaults.standard.set(url.path, forKey: folderKey)
        UserDefaults.standard.set("folder", forKey: modeKey)
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
    }

    static func useServer() {
        UserDefaults.standard.set("server", forKey: modeKey)
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
    }

    /// Back to a copy on this Mac, from server-only or a folder: straight to
    /// it if there is one, otherwise the server's page until the next sign-in.
    @MainActor
    static func useCopy() {
        UserDefaults.standard.set(copyMode, forKey: modeKey)
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
        Task { await AppCopy.setUpIfSignedIn() }
    }

    /// The folder picker. Nil if cancelled.
    @MainActor
    static func chooseFolder() -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use This Folder"
        panel.message = "Choose the folder your to-dos live in — the Tasks folder in your Obsidian vault, "
            + "or any folder Syncthing or iCloud Drive keeps in step. An empty folder starts empty."
        if let current = UserDefaults.standard.string(forKey: folderKey) {
            panel.directoryURL = URL(fileURLWithPath: current)
        }
        return panel.runModal() == .OK ? panel.url : nil
    }
}
