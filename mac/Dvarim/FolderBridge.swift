import AppKit
import CoreServices
import Foundation
import WebKit

/// The folder bridge of docs/BRIDGE.md, the Mac's half: the page's storage
/// messages answered from a folder on this Mac, one at a time and in the order
/// sent, and the page told when someone else (Obsidian, Syncthing, iCloud)
/// changes the folder. tools/bridge_sim.py is the reference; when they differ,
/// the document decides.
final class FolderBridge: NSObject, WKScriptMessageHandlerWithReply {
    let files: FolderFiles
    weak var webView: WKWebView?
    private let queue = DispatchQueue(label: "dvarim.folder")      // one message at a time, in order
    private var stream: FSEventStreamRef?

    /// How many `http` ops the pages have sent, for the self-test: with the op
    /// offered, every sync request must come through here.
    static var httpRequests = 0

    init(root: URL) {
        files = FolderFiles(root: root)
    }

    // The stream holds an unretained pointer to this bridge, so it must stop
    // before the bridge goes; and a stream is the main actor's to stop.
    isolated deinit { stopWatching() }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        // only the app's own page, never anything else loaded into the window
        guard message.frameInfo.securityOrigin.protocol == AppScheme.scheme else {
            replyHandler(nil, "the folder is only for the app's own page")
            return
        }
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            replyHandler(FolderFiles.failure("EINVAL", "not a bridge message"), nil)
            return
        }
        let version = (body["v"] as? NSNumber)?.intValue ?? 0
        let args = body["args"] as? [String: Any] ?? [:]
        guard version == 1 else {
            replyHandler(FolderFiles.failure("EPROTO", "this app speaks protocol 1, not \(version)"), nil)
            return
        }
        switch op {
        case "pick":
            // the picker is the app's; the reply goes when it closes, then the reload
            let chosen = Vault.chooseFolder()
            replyHandler(["ok": ["changed": chosen != nil]], nil)
            if let chosen { Vault.useFolder(chosen) }
        case "useServer":
            replyHandler(["ok": NSNull()], nil)
            Vault.useServer()
        case "signOut":
            // The copy's page has synced what it had (AppCopy.signOut).
            guard Vault.mode == Vault.copyMode, AppCopy.current != nil else {
                replyHandler(FolderFiles.failure("ENOSYS", "only a copy kept by the app signs out"), nil)
                return
            }
            replyHandler(["ok": NSNull()], nil)
            Task { await AppCopy.signOut() }
        case "changed":
            replyHandler(["ok": NSNull()], nil)
            VaultChanges.changed()
        // Not file operations, so beside the queue rather than in it: a slow
        // server must not hold up the folder, nor the folder a sync.
        case "http":
            Self.httpRequests += 1
            let url = args["url"] as? String, method = args["method"] as? String, body = args["body"] as? String
            var headers = (args["headers"] as? [String: Any] ?? [:]).mapValues { "\($0)" }
            // `session`: the window's sign-in, for what a token may not do
            // (tokens, people). Only ever to the server the copy syncs with.
            let session = args["session"] as? Bool ?? false
            Task {
                if session {
                    guard let target = url.flatMap(URL.init(string:)), Self.sameOrigin(target, Defaults.server) else {
                        return replyHandler(FolderFiles.failure("EACCES", "the sign-in goes only to \(Defaults.server.absoluteString)"), nil)
                    }
                    for (field, value) in await Session.cookieHeader(for: target) { headers[field] = value }
                }
                let reply = Plist(await ShellHTTP.answer(url: url, method: method, headers: headers, body: body))
                replyHandler(reply.value, nil)
            }
        case "calendars":
            Task { replyHandler(Plist(await DeviceCalendars.shared.calendars()).value, nil) }
        case "events":
            let from = args["from"] as? String ?? "", to = args["to"] as? String ?? "", names = args["calendars"] as? [String]
            Task { replyHandler(Plist(await DeviceCalendars.shared.events(from: from, to: to, names: names)).value, nil) }
        case "info":
            replyHandler(["ok": Self.info(root: files.root)], nil)
        default:
            let files = self.files
            let asked = Plist(args)
            queue.async {
                let reply = Plist(files.answer(op: op, args: asked.value))
                DispatchQueue.main.async { MainActor.assumeIsolated { replyHandler(reply.value, nil) } }
            }
        }
    }

    /// The same scheme, host and port: where the window's sign-in may go.
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme?.lowercased() == b.scheme?.lowercased() && a.host?.lowercased() == b.host?.lowercased()
            && (a.port ?? (a.scheme == "https" ? 443 : 80)) == (b.port ?? (b.scheme == "https" ? 443 : 80))
    }

    /// `info` (docs/BRIDGE.md): what the page is told about its folder. The
    /// app's, not FolderFiles', since the copy and its sync are the app's.
    static func info(root: URL) -> [String: Any] {
        var info: [String: Any] = [
            "name": root.lastPathComponent,
            "detail": (root.path as NSString).abbreviatingWithTildeInPath,
            "canPick": true, "canUseServer": true,
            "pollSeconds": 0,                      // FSEvents says when it changes
            // -FolderHTTP NO leaves the sync's requests to the page, for the self-test
            "http": UserDefaults.standard.object(forKey: "FolderHTTP") == nil || UserDefaults.standard.bool(forKey: "FolderHTTP"),
            "calendars": true, "changes": true]
        // The app's own copy: named for what it is rather than its
        // folder, and synced with the server by the app's token.
        if Vault.mode == Vault.copyMode, let sync = AppCopy.syncInfo {
            info["name"] = "This Mac"
            info["detail"] = "Synced with " + (URL(string: sync["address"] as? String ?? "")?.host ?? "the server")
            info["sync"] = sync
            info["http"] = true
        }
        return info
    }

    // ---- someone else writes the folder -------------------------------------------

    func startWatching() {
        guard stream == nil else { return }
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                           retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            let bridge = Unmanaged<FolderBridge>.fromOpaque(info).takeUnretainedValue()
            DispatchQueue.main.async { MainActor.assumeIsolated { bridge.filesChanged() } }
        }
        // our own writes come back through here too; the page compares contents,
        // so telling it is harmless (docs/BRIDGE.md, 3)
        stream = FSEventStreamCreate(nil, callback, &context, [files.root.path] as CFArray,
                                     FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.3,
                                     FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer))
        if let stream {
            FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
            FSEventStreamStart(stream)
        }
    }

    func stopWatching() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    @MainActor
    private func filesChanged() {
        webView?.evaluateJavaScript("window.__dvarimFilesChanged && window.__dvarimFilesChanged()", completionHandler: nil)
    }
}

/// A message's arguments, or a reply, on its way between the main actor and
/// the bridge's queue. Only strings, numbers, lists, dictionaries and null —
/// what WebKit hands over and takes back — and never changed after it is made,
/// so it is safe to send whatever the type system can tell.
private struct Plist: @unchecked Sendable {
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}
