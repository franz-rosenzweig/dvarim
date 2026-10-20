import Foundation
import Security
import WebKit

/// The to-dos kept on this Mac and synced with the server: the default since
/// the app went offline-first. The page is the one inside the app (AppScheme),
/// its vault a private folder here (FolderBridge), and the page's own built-in
/// sync keeps that folder in step with the server's /dav with a device token
/// (frontend/src/lib/davsync.js, engine/src/webdav.js). So a window opens with
/// no network at all, and the badge, the menu bar, reminders and Quick Entry
/// read the copy here (Client.current), not the server.
///
/// The one step that needs the server is the first: the person signs in on the
/// server's page as always, and the shell, borrowing that sign-in, makes this
/// Mac its own token (POST /api/tokens, which takes a session and never a
/// token). The token is kept in the Keychain and handed to the page in
/// storage.info()'s `sync`.
///
/// Reading which copy is in use touches only UserDefaults, the Keychain and
/// the file system, so any thread may; setting up and signing out are the
/// main actor's, like the windows they reload.
enum AppCopy {
    /// Which copy is in use: whose, on which server, and the token's name there.
    struct Current: Codable, Equatable {
        let server: String
        let who: String          // "owner", or the person's key on that server (personKey)
        let device: String       // the token's name in Settings → Devices
    }

    private static let currentKey = "vaultCopy"
    private static let keychainService = "Dvarim sync token"

    /// The copy set up for the server in Settings, with its token still in the
    /// Keychain; nil before the first sign-in, or after signing out.
    static var current: Current? {
        guard let data = UserDefaults.standard.data(forKey: currentKey),
              let c = try? JSONDecoder().decode(Current.self, from: data),
              c.server == Defaults.server.absoluteString, token(for: c) != nil else { return nil }
        return c
    }

    /// Its folder: Application Support/Dvarim/Copies/<host>/<who>/, made if missing.
    static var folder: URL? {
        guard let c = current else { return nil }
        return folder(for: c)
    }

    private static func folder(for c: Current) -> URL? {
        guard let support = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                         appropriateFor: nil, create: true) else { return nil }
        let url = URL(string: c.server)
        var host = url?.host ?? "server"
        if let port = url?.port { host += "-\(port)" }
        let dir = support.appendingPathComponent("Dvarim/Copies", isDirectory: true)
            .appendingPathComponent(safe(host), isDirectory: true)
            .appendingPathComponent(safe(c.who), isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// What the page's sync is told (BRIDGE.md, info's `sync`). `app` says the
    /// shell owns it, so Settings → Sync shows it rather than offering to change it.
    static var syncInfo: [String: Any]? {
        guard let c = current, let token = token(for: c) else { return nil }
        return ["kind": "dvarim", "address": c.server, "token": token, "app": true]
    }

    // ---- setting it up, from the window's sign-in -------------------------------

    @MainActor private static var settingUp = false

    /// When the person has signed in on the server's page and there is no copy
    /// yet: make this Mac a token and switch the windows to the copy. Does
    /// nothing in server-only or folder mode, without a sign-in, or with no
    /// network (it is asked again after the next page load).
    @MainActor
    static func setUpIfSignedIn() async {
        guard Vault.mode == Vault.copyMode, current == nil, Vault.webBundle != nil, !settingUp else { return }
        settingUp = true
        defer { settingUp = false }
        let client = Client(base: Defaults.server)
        guard let auth = try? await client.auth(), auth.authenticated else { return }
        let who = personKey(auth.person)
        guard let (device, token) = try? await makeToken(client) else { return }
        let c = Current(server: Defaults.server.absoluteString, who: who, device: device)
        guard storeToken(token, for: c), let data = try? JSONEncoder().encode(c) else { return }
        UserDefaults.standard.set(data, forKey: currentKey)
        NSLog("Dvarim: keeping a copy on this Mac for \(who), synced as “\(device)”")
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
    }

    /// Whose copy, as the page keys them (backend.js personKey): "owner" for
    /// the server's owner (the page's ''), otherwise the account's id, which a
    /// name given up and taken by someone new does not share.
    static func personKey(_ person: Client.AuthState.Person?) -> String {
        guard let person, !person.owner else { return "owner" }
        let key = (person.uid ?? person.name ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        return key.isEmpty ? "owner" : key
    }

    /// A token named for this Mac: its name in Sharing, and "… 2", "… 3" when
    /// another device already has that one.
    @MainActor
    private static func makeToken(_ client: Client) async throws -> (String, String) {
        let base = deviceName()
        for n in 1...9 {
            let name = n == 1 ? base : "\(base) \(n)"
            do {
                return (name, try await client.makeToken(name: name))
            } catch let e as NSError where e.domain == "Dvarim" && e.code == 409 {
                continue
            }
        }
        throw NSError(domain: "Dvarim", code: 409, userInfo: [NSLocalizedDescriptionKey: "every name for this Mac is taken"])
    }

    /// The Mac's name, in the characters the server allows a device (letters,
    /// digits, spaces and . _ ' ’ ( ) -), short enough to number.
    static func deviceName() -> String {
        let raw = Host.current().localizedName ?? "Mac"
        let allowed = raw.unicodeScalars.map { s -> Character in
            CharacterSet.letters.contains(s) || CharacterSet.decimalDigits.contains(s) || " ._'’()-".unicodeScalars.contains(s)
                ? Character(s) : " "
        }
        let name = String(allowed).split(separator: " ").joined(separator: " ")
        return name.isEmpty ? "Mac" : String(name.prefix(36)).trimmingCharacters(in: .whitespaces)
    }

    // ---- signing out ---------------------------------------------------------------

    /// The page has synced what it had and signs out (the storage op
    /// `signOut`): the token goes from the server, the window's sign-in with
    /// it, the copy to the Trash, and the windows back to the server's page to
    /// sign in again.
    @MainActor
    static func signOut() async {
        guard let c = current else { return }
        let client = Client(base: URL(string: c.server) ?? Defaults.server)
        try? await client.revokeToken(name: c.device)
        try? await client.logout()
        let store = WKWebsiteDataStore.default().httpCookieStore
        let host = URL(string: c.server)?.host
        for cookie in await store.allCookies() where cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == host {
            await store.deleteCookie(cookie)
        }
        if let dir = folder(for: c) {
            var trashed: NSURL?
            try? FileManager.default.trashItem(at: dir, resultingItemURL: &trashed)
            lastTrashed = trashed as URL?
        }
        deleteToken(for: c)
        UserDefaults.standard.removeObject(forKey: currentKey)
        NotificationCenter.default.post(name: .dvarimReload, object: nil)
    }

    /// Where the last copy signed out of went in the Trash (the self-test
    /// empties it).
    @MainActor static var lastTrashed: URL?

    // ---- the Keychain --------------------------------------------------------------

    private static func account(_ c: Current) -> String { "\(c.server) \(c.who)" }

    private static func query(_ c: Current) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: keychainService,
         kSecAttrAccount as String: account(c)]
    }

    static func token(for c: Current) -> String? {
        var q = query(c)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func storeToken(_ token: String, for c: Current) -> Bool {
        deleteToken(for: c)
        var q = query(c)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrLabel as String] = "Dvarim: \(c.device)"
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    private static func deleteToken(for c: Current) {
        SecItemDelete(query(c) as CFDictionary)
    }

    /// A name as one folder's name: no slashes, no leading dot.
    private static func safe(_ s: String) -> String {
        let cleaned = s.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        return cleaned.hasPrefix(".") ? "_" + cleaned.dropFirst() : (cleaned.isEmpty ? "_" : cleaned)
    }
}
