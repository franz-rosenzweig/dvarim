import Foundation
import WebKit

/// Everything the shell needs from the server, or in folder mode from the
/// folder's page, which answers the same API. The whole contract is
/// docs/API.md; this covers only the handful of endpoints a native wrapper
/// actually uses.
struct Client {
    var base: URL
    /// Asks the folder's page (LocalPage) rather than a server at `base`.
    var local = false

    struct Todo: Decodable, Identifiable {
        let id: String
        let title: String
        let status: String?
        let when: String?
        let evening: Bool
        let reminder: String?
        let deadline: String?
        let projectName: String?
        let someday: Bool
        let tags: [String]

        /// Lists carry done and canceled items too; the client decides to show them.
        var isOpen: Bool { status == nil || status == "open" }
    }

    struct Counts: Decodable {
        let inbox: Int
        let today: Int
    }

    /// The part of the server's settings the shell reads: what the Dock badge counts
    /// is chosen in the web app (Settings → Badge count).
    struct Settings: Decodable {
        let badgeCount: String?
    }

    struct State: Decodable {
        let today: String
        let counts: Counts
        let settings: Settings?
    }

    struct TodayList: Decodable {
        let items: [Todo]
    }

    struct AuthState: Decodable {
        let required: Bool
        let authenticated: Bool
        /// Who is signed in, when the server has a password: its owner, or one
        /// of the people the owner invited.
        let person: Person?
        struct Person: Decodable {
            let name: String?
            let owner: Bool
            let uid: String?
        }
    }

    /// The server wants a login and this request had none that is still valid.
    struct NotSignedIn: LocalizedError {
        var errorDescription: String? { "Not signed in. Sign in once in the Dvarim window." }
    }

    /// The server could not be reached — no network, or a network with no way to
    /// it — as against the server answering no. The difference is the whole of
    /// Outbox: this one is kept and sent later, the other is said out loud.
    ///
    /// A 502, 503 or 504 counts, because it is not the server speaking: it is the
    /// tunnel in front of it saying the server is not there, which is what the
    /// Mac sees for the twenty seconds of every redeploy.
    struct Unreachable: LocalizedError {
        var errorDescription: String? { "Can't reach the server." }
    }

    private static let unreachable: Set<URLError.Code> = [
        .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost,
        .dnsLookupFailed, .timedOut, .dataNotAllowed, .internationalRoamingOff,
    ]

    /// An id the server would have made (backend ids.py), for a to-do made while
    /// it cannot be asked: eight of 0-9a-z. The server takes it and answers a
    /// repeat with the to-do it already has, so a send that lands but whose
    /// answer is lost does no harm when it is sent again.
    static func newId() -> String {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return String((0..<8).map { _ in alphabet.randomElement()! })
    }

    /// Whoever holds the to-dos: the folder's page (LocalPage) when they live in
    /// a folder on this Mac, the server otherwise.
    static var current: Client {
        Vault.usesFolder ? Client(base: Vault.appOrigin, local: true) : Client(base: Defaults.server)
    }

    /// One API route, from the server or from the folder's page, decoded.
    private func call<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil, as type: T.Type) async throws -> T {
        guard local else { return try await send(request(method, path, body: body), as: type) }
        let json = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        let (status, data) = try await LocalPage.shared.request(method, "/" + path, json: json)
        return try Self.decode(status, data, as: type)
    }

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: base) else {
            throw URLError(.badURL)
        }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        r.httpMethod = method
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        r.httpShouldHandleCookies = false
        for (field, value) in await Session.cookieHeader(for: url) {
            r.setValue(value, forHTTPHeaderField: field)
        }
        return r
    }

    private func send<T: Decodable>(_ r: URLRequest, as type: T.Type) async throws -> T {
        let data: Data, response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: r)
        } catch let error as URLError where Self.unreachable.contains(error.code) {
            throw Unreachable()
        }
        return try Self.decode((response as? HTTPURLResponse)?.statusCode ?? 200, data, as: type)
    }

    /// An answer, the server's or the page's: they speak the same API.
    private static func decode<T: Decodable>(_ status: Int, _ data: Data, as type: T.Type) throws -> T {
        if !(200..<300).contains(status) {
            if status == 401 { throw NotSignedIn() }
            if [502, 503, 504].contains(status) { throw Unreachable() }
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw NSError(domain: "Dvarim", code: status,
                          userInfo: [NSLocalizedDescriptionKey: message ?? "Server returned \(status)"])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// One line of quick entry. The server does all the parsing:
    /// a trailing date phrase sets When, !friday a deadline, @9am a reminder,
    /// #tag anywhere tags it.
    ///
    /// `id` names the to-do, so one kept by Outbox and sent twice is still one.
    /// `notes` go in as written; only `text` is parsed.
    func quickAdd(_ text: String, notes: String? = nil, list: String? = nil, id: String? = nil) async throws -> Todo {
        var body: [String: Any] = ["text": text]
        if let notes, !notes.isEmpty { body["notes"] = notes }
        if let list { body["list"] = list }
        if let id { body["id"] = id }
        return try await call("POST", "api/quick-add", body: body, as: Todo.self)
    }

    func state() async throws -> State {
        try await call("GET", "api/state", as: State.self)
    }

    func today() async throws -> TodayList {
        try await call("GET", "api/lists/today", as: TodayList.self)
    }

    /// Public: answers whether a login is needed and whether this client has one.
    func auth() async throws -> AuthState {
        try await call("GET", "api/auth", as: AuthState.self)
    }

    /// A token for one device to sync with (Settings → Devices). The server
    /// makes one only for a password sign-in, so this is the window's cookie
    /// speaking, never another token. A name already taken is a 409.
    func makeToken(name: String) async throws -> String {
        struct Made: Decodable { let token: String }
        return try await call("POST", "api/tokens", body: ["name": name], as: Made.self).token
    }

    func revokeToken(name: String) async throws {
        struct Removed: Decodable {}
        let path = "api/tokens/" + (name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? name)
        _ = try await call("DELETE", path, as: Removed.self)
    }

    func logout() async throws {
        struct Out: Decodable {}
        _ = try await call("POST", "api/logout", body: [:], as: Out.self)
    }

    /// The server answers with the to-do and, for a repeating one, its next copy.
    struct Completed: Decodable { let todo: Todo }

    /// `on` is the day it was ticked, for one Outbox kept and sends later: the
    /// Logbook files it under the day it was done, not the day it reached the
    /// server. Without it, the server's today.
    @discardableResult
    func complete(_ id: String, on: String? = nil) async throws -> Todo {
        try await call("POST", "api/todos/\(id)/complete", body: on.map { ["on": $0] } ?? [:], as: Completed.self).todo
    }
}

/// There is one login, the web app's own: you sign in once in a Dvarim window and
/// the server sets a session cookie in the web view. The shell's native requests
/// (badge, reminders, Quick Entry) borrow that cookie, so they are signed in
/// exactly when the window is. Nothing here ever sees the password.
@MainActor
enum Session {
    static func cookieHeader(for url: URL) async -> [String: String] {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        return HTTPCookie.requestHeaderFields(with: cookies.filter { applies($0, to: url) })
    }

    private static func applies(_ cookie: HTTPCookie, to url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        let domain = cookie.domain.lowercased()
        let hostMatches = domain == host
            || (domain.hasPrefix(".") && (host == domain.dropFirst() || host.hasSuffix(domain)))
        let path = url.path.isEmpty ? "/" : url.path
        return hostMatches
            && path.hasPrefix(cookie.path)
            && (!cookie.isSecure || url.scheme == "https")
            && (cookie.expiresDate.map { $0 > Date() } ?? true)
    }
}

enum Defaults {
    static let serverKey = "serverURL"
    static let hotkeyEnabledKey = "hotkeyEnabled"
    static let shortcutKey = "quickEntryShortcut"
    static let menuBarKey = "menuBarItem"
    static let notificationsKey = "nativeReminders"

    /// Over the Cloudflare tunnel, so it works off the tailnet too. The tailnet
    /// address (http://<tailscale-ip>:8420) works as well; set it in Settings.
    static let defaultServer = "https://dvarim.tiresia.xyz"

    static var server: URL {
        let s = UserDefaults.standard.string(forKey: serverKey)?.trimmingCharacters(in: .whitespaces) ?? defaultServer
        return URL(string: s) ?? URL(string: defaultServer)!
    }
}
