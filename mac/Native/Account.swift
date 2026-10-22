import Foundation
import Security

/// Settings this app keeps. Its own defaults, under its own bundle id, so it
/// never touches the web-view Dvarim's beside it; the self-test gives it a
/// suite of its own and removes it afterwards (SelfTest.swift).
enum Prefs {
    static var store: UserDefaults = .standard

    static let modeKey = "where"            // "copy" | "remote" | "folder"
    static let serverKey = "server"
    static let folderKey = "folder"
    static let defaultServer = "https://dvarim.tiresia.xyz"

    static var server: URL {
        let s = store.string(forKey: serverKey)?.trimmingCharacters(in: .whitespaces) ?? ""
        return URL(string: s.isEmpty ? defaultServer : s) ?? URL(string: defaultServer)!
    }
}

/// Where the to-dos live, as the three choices in Settings.
enum Mode: String, CaseIterable, Identifiable, Sendable {
    /// On this Mac, in a folder of the app's own, kept in step with the server
    /// by the built-in sync. The default: it opens and works with no network.
    case copy
    /// On the server only: every list is asked of it as you open it.
    case remote
    /// In a folder you chose (an Obsidian vault's Tasks folder, say), read and
    /// written here, with whatever keeps that folder in step doing the rest.
    case folder

    var id: String { rawValue }
    var label: String {
        switch self {
        case .copy: "On this Mac, synced with the server"
        case .remote: "On the server only"
        case .folder: "In a folder on this Mac"
        }
    }

    static var current: Mode {
        get { Mode(rawValue: Prefs.store.string(forKey: Prefs.modeKey) ?? "") ?? .copy }
        set { Prefs.store.set(newValue.rawValue, forKey: Prefs.modeKey) }
    }
}

/// Signing in to the server, and this Mac's own token for syncing with it.
///
/// The password goes to the server once, from the sign-in form, and is never
/// kept: the server answers with a session cookie, which URLSession keeps in
/// this app's cookie store. Remote mode sends that cookie. For the copy, the
/// cookie makes this Mac a token of its own (POST /api/tokens takes a session,
/// never a token), kept in the Keychain and handed to the engine's sync.
@MainActor
enum Account {
    struct Person: Sendable {
        var name: String?
        var owner: Bool
        var uid: String?
    }

    /// Who the server says is signed in here, or nil for nobody.
    static func whoIsSignedIn(_ server: URL = Prefs.server) async throws -> Person? {
        let j = try await RemoteBackend(server: server).request("GET", "/api/auth", body: nil)
        guard j["authenticated"].bool else { return nil }
        let p = j["person"]
        return Person(name: p["name"].string, owner: p.exists ? p["owner"].bool : true, uid: p["uid"].string)
    }

    /// The password, once; an answer of no is thrown with the server's words.
    static func signIn(password: String, name: String?, server: URL = Prefs.server) async throws -> Person {
        var body: [String: Any] = ["password": password]
        if let name, !name.isEmpty { body["name"] = name }
        let j = try await RemoteBackend(server: server).request("POST", "/api/login", body: body)
        let p = j["person"]
        return Person(name: p["name"].string, owner: p.exists ? p["owner"].bool : true, uid: p["uid"].string)
    }

    /// The session cookie goes, and with it Remote mode and the making of tokens.
    static func signOut(server: URL = Prefs.server) async {
        _ = try? await RemoteBackend(server: server).request("POST", "/api/logout", body: [:])
        forgetCookies(for: server)
    }

    static func forgetCookies(for server: URL) {
        let store = HTTPCookieStorage.shared
        for c in store.cookies ?? [] where c.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == server.host {
            store.deleteCookie(c)
        }
    }

    /// Whose copy, as the page keys them (frontend backend.js personKey):
    /// "owner" for the server's owner, otherwise the account's id.
    static func key(_ person: Person?) -> String {
        guard let person, !person.owner else { return "owner" }
        let k = (person.uid ?? person.name ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        return k.isEmpty ? "owner" : k
    }

    // ---- the copy -------------------------------------------------------------------

    /// The copy's record: which server, whose, and the token's name there.
    struct Copy: Codable, Equatable, Sendable {
        let server: String
        let who: String
        let device: String
    }

    private static let copyKey = "copy"
    static let keychainService = "Dvarim Native sync token"

    static var copy: Copy? {
        guard let data = Prefs.store.data(forKey: copyKey),
              let c = try? JSONDecoder().decode(Copy.self, from: data),
              c.server == Prefs.server.absoluteString, token(for: c) != nil else { return nil }
        return c
    }

    /// ~/Library/Application Support/Dvarim Native/Copies/<host>/<who>/: the
    /// folder kept its first name when the app became Dvarim, as the copy did.
    static func folder(for c: Copy) -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = URL(string: c.server)
        var host = url?.host ?? "server"
        if let port = url?.port { host += "-\(port)" }
        return support.appendingPathComponent(appFolder, isDirectory: true)
            .appendingPathComponent("Copies", isDirectory: true)
            .appendingPathComponent(safe(host), isDirectory: true)
            .appendingPathComponent(safe(c.who), isDirectory: true)
    }

    /// The app's own folder in Application Support: the self-test's is apart.
    static var appFolder = "Dvarim Native"

    /// After a sign-in: a token named for this Mac, kept, and the copy recorded.
    static func makeCopy(for person: Person, server: URL = Prefs.server) async throws -> Copy {
        let backend = RemoteBackend(server: server)
        let base = deviceName()
        for n in 1...9 {
            let name = n == 1 ? base : "\(base) \(n)"
            do {
                let j = try await backend.request("POST", "/api/tokens", body: ["name": name])
                guard let token = j["token"].string else { throw APIError(status: 500, message: "the server made no token") }
                let c = Copy(server: server.absoluteString, who: key(person), device: name)
                guard storeToken(token, for: c) else { throw APIError(status: 500, message: "the Keychain would not keep the token") }
                Prefs.store.set(try JSONEncoder().encode(c), forKey: copyKey)
                try FileManager.default.createDirectory(at: folder(for: c), withIntermediateDirectories: true)
                return c
            } catch let e as APIError where e.status == 409 {
                continue                                         // a name already taken: the next number
            }
        }
        throw APIError(status: 409, message: "every name for this Mac is taken")
    }

    /// The copy goes: its token from the server, then from here, and the
    /// folder to the Trash. `trash: false` deletes it (the self-test's).
    static func dropCopy(_ c: Copy, trash: Bool = true) async {
        let name = c.device.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? c.device
        _ = try? await RemoteBackend(server: URL(string: c.server) ?? Prefs.server).request("DELETE", "/api/tokens/" + name, body: nil)
        let dir = folder(for: c)
        if trash { try? FileManager.default.trashItem(at: dir, resultingItemURL: nil) }
        else { try? FileManager.default.removeItem(at: dir) }
        deleteToken(for: c)
        Prefs.store.removeObject(forKey: copyKey)
    }

    /// "Tyrone's Laptop (Dvarim Native)": the Mac's name and which app, in
    /// the characters the server allows a device.
    static func deviceName() -> String {
        let raw = Host.current().localizedName ?? "Mac"
        let allowed = raw.unicodeScalars.map { s -> Character in
            CharacterSet.letters.contains(s) || CharacterSet.decimalDigits.contains(s) || " ._'’()-".unicodeScalars.contains(s)
                ? Character(s) : " "
        }
        let mac = String(allowed).split(separator: " ").joined(separator: " ")
        let name = "\(mac.isEmpty ? "Mac" : String(mac.prefix(20))) (Dvarim Native)"
        return name.trimmingCharacters(in: .whitespaces)
    }

    // ---- the Keychain ---------------------------------------------------------------

    private static func query(_ c: Copy) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: keychainService,
         kSecAttrAccount as String: "\(c.server) \(c.who)"]
    }

    static func token(for c: Copy) -> String? {
        var q = query(c)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func storeToken(_ token: String, for c: Copy) -> Bool {
        deleteToken(for: c)
        var q = query(c)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrLabel as String] = "Dvarim Native: \(c.device)"
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    private static func deleteToken(for c: Copy) {
        SecItemDelete(query(c) as CFDictionary)
    }

    private static func safe(_ s: String) -> String {
        let cleaned = s.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        return cleaned.hasPrefix(".") ? "_" + cleaned.dropFirst() : (cleaned.isEmpty ? "_" : cleaned)
    }
}
