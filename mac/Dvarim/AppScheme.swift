import Foundation
import UniformTypeIdentifiers
import WebKit

/// The web app, served from inside Dvarim.app at dvarim-app://app/ — the page
/// that runs on a folder needs no server to come from (docs/BRIDGE.md, 1).
///
/// A path that names a file in the build is that file; any other path is
/// index.html, because the app routes by path (/today, /project/p7k3j9a2) and a
/// reload on any screen must land back on it.
final class AppScheme: NSObject, WKURLSchemeHandler {
    static let scheme = "dvarim-app"

    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let file = resolve(url.path)
        do {
            let data = try Data(contentsOf: file)
            let headers = [
                "Content-Type": Self.mime(file.pathExtension),
                "Content-Length": String(data.count),
                "Cache-Control": "no-cache",
            ]
            // An HTTPURLResponse with a 200, or WebKit will not run a module script.
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        } catch {
            task.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func resolve(_ path: String) -> URL {
        let index = root.appendingPathComponent("index.html")
        let rel = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard !rel.isEmpty else { return index }
        let candidate = root.appendingPathComponent(rel).standardizedFileURL
        var isDir: ObjCBool = false
        // inside the build, and a file: anything else is the app's own route
        guard candidate.path.hasPrefix(root.path + "/"),
              FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDir), !isDir.boolValue else { return index }
        return candidate
    }

    static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "svg": return "image/svg+xml"
        case "wasm": return "application/wasm"
        default: return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
