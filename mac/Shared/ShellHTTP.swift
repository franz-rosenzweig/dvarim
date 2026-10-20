import Foundation

/// The bridge's `http` op (docs/BRIDGE.md): one request made by the shell for
/// the page's built-in sync, so a WebDAV server that answers no page from
/// another origin (Nextcloud, most) can still be reached. No cookies, no cache,
/// no redirects, 30 seconds. Only https, and plain http only to this Mac, the
/// local network or the tailnet.
enum ShellHTTP {
    /// A redirect comes back to the page as the 3xx it is: a sync must not be
    /// sent somewhere its token was not meant for.
    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? { nil }
    }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 30
        c.timeoutIntervalForResource = 30
        return URLSession(configuration: c, delegate: NoRedirects(), delegateQueue: nil)
    }()

    /// The op's reply: `{ok: {status, headers, body}}`, or an error. An HTTP
    /// error status is an ordinary reply; only no answer at all is EIO.
    static func answer(url: String?, method: String?, headers: [String: String], body: String?) async -> [String: Any] {
        guard let url = url.flatMap(URL.init(string:)), let scheme = url.scheme?.lowercased(), let host = url.host else {
            return FolderFiles.failure("EINVAL", "not a web address: \(url ?? "")")
        }
        switch scheme {
        case "https":
            break
        case "http":
            guard await isPrivate(host) else {
                return FolderFiles.failure("EINVAL", "\(host) needs an https address: plain http goes only to this Mac, the local network or the tailnet")
            }
        default:
            return FolderFiles.failure("EINVAL", "not a web address: \(url.absoluteString)")
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = method ?? "GET"
        request.httpShouldHandleCookies = false
        for (field, value) in headers { request.setValue(value, forHTTPHeaderField: field) }
        if let body { request.httpBody = Data(body.utf8) }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return FolderFiles.failure("EIO", "\(host) did not answer in HTTP")
            }
            var fields: [String: String] = [:]
            for (k, v) in http.allHeaderFields { fields["\(k)"] = "\(v)" }
            return ["ok": ["status": http.statusCode, "headers": fields, "body": String(decoding: data, as: UTF8.self)]]
        } catch {
            return FolderFiles.failure("EIO", "could not reach \(host): \(error.localizedDescription)")
        }
    }

    /// Whether every address the name has is this Mac's, the local network's
    /// or the tailnet's.
    static func isPrivate(_ host: String) async -> Bool {
        let name = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if name == "localhost" || name.hasSuffix(".localhost") { return true }
        let addresses = await Task.detached { resolve(name) }.value
        return !addresses.isEmpty && addresses.allSatisfy(isPrivate(address:))
    }

    /// Loopback, RFC 1918, link-local, and 100.64/10 where Tailscale puts its
    /// devices; for IPv6 loopback, fc00::/7 (the tailnet's fd7a:115c:a1e0::/48
    /// among them), link-local, and an IPv4 address written as IPv6.
    static func isPrivate(address a: [UInt8]) -> Bool {
        if a.count == 4 {
            return a[0] == 127 || a[0] == 10 || (a[0] == 172 && (16...31).contains(a[1])) || (a[0] == 192 && a[1] == 168)
                || (a[0] == 169 && a[1] == 254) || (a[0] == 100 && (64...127).contains(a[1]))
        }
        guard a.count == 16 else { return false }
        if a[0..<15].allSatisfy({ $0 == 0 }) && a[15] == 1 { return true }
        if a[0] & 0xfe == 0xfc || (a[0] == 0xfe && a[1] & 0xc0 == 0x80) { return true }
        if a[0..<10].allSatisfy({ $0 == 0 }) && a[10] == 0xff && a[11] == 0xff { return isPrivate(address: Array(a[12...])) }
        return false
    }

    /// Every address a name resolves to, as bytes. A literal address is itself.
    private static func resolve(_ name: String) -> [[UInt8]] {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var found: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(name, nil, &hints, &found) == 0, let first = found else { return [] }
        defer { freeaddrinfo(first) }
        var out: [[UInt8]] = []
        for entry in sequence(first: first, next: { $0.pointee.ai_next }) {
            guard let sa = entry.pointee.ai_addr else { continue }
            switch entry.pointee.ai_family {
            case AF_INET:
                sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { out.append(withUnsafeBytes(of: $0.pointee.sin_addr) { Array($0) }) }
            case AF_INET6:
                sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { out.append(withUnsafeBytes(of: $0.pointee.sin6_addr) { Array($0) }) }
            default:
                break
            }
        }
        return out
    }
}
