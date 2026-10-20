import AppKit
import WebKit

/// Where the shell's own requests go when the to-dos live in a folder: the
/// menu bar, the badge, reminders, Quick Entry and the intents ask the page
/// what they would ask a server, through window.dvarim.request, and the engine
/// in the page answers from the folder (docs/BRIDGE.md, "What stays with the
/// server").
///
/// A window's page answers when a window is open. With none, a page of its
/// own that is never shown does. It also goes on watching the folder and
/// syncing, so the menu bar keeps up with every window closed. Never both: two
/// pages are two stores writing one folder, so the hidden one goes as soon as
/// a window's page is there.
@MainActor
final class LocalPage {
    static let shared = LocalPage()
    private var hidden: WKWebView?
    private var bridge: FolderBridge?

    private init() {
        // another folder, or the server: the hidden page is on the wrong one
        NotificationCenter.default.addObserver(forName: .dvarimReload, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { LocalPage.shared.dropHidden() }
        }
    }

    /// One API request, answered by the page: its status and its body as JSON.
    /// Throws Client.Unreachable if no page comes up to answer.
    func request(_ method: String, _ path: String, json body: Data?) async throws -> (Int, Data) {
        guard let web = await page() else { throw Client.Unreachable() }
        let answer = try await web.callAsyncJavaScript("""
            const r = await window.dvarim.request(method, path, body === null ? undefined : JSON.parse(body));
            return [r.status, JSON.stringify(r.body === undefined ? null : r.body)];
            """, arguments: ["method": method, "path": path, "body": body.map { String(decoding: $0, as: UTF8.self) } ?? NSNull()],
            contentWorld: .page) as? [Any]
        guard let answer, answer.count == 2, let status = (answer[0] as? NSNumber)?.intValue, let text = answer[1] as? String else {
            throw Client.Unreachable()
        }
        return (status, Data(text.utf8))
    }

    /// A window opened on the folder: its page answers from now on.
    func windowOpened() { dropHidden() }

    /// Whether the hidden page is up, for the self-test.
    var hasHiddenPage: Bool { hidden != nil }

    /// A window's page if one is up, or the hidden one, loaded if need be.
    private func page() async -> WKWebView? {
        guard Vault.usesFolder else { return nil }
        for web in windowPages() where await Self.ready(web, within: 5) {
            dropHidden()
            return web
        }
        if hidden == nil { makeHidden() }
        guard let hidden else { return nil }
        return await Self.ready(hidden, within: 20) ? hidden : nil
    }

    private func windowPages() -> [WKWebView] {
        NSApp.windows.filter { $0.isVisible || $0.isMiniaturized }.compactMap { Self.webView(in: $0.contentView) }
            .filter { $0.url?.scheme == AppScheme.scheme }
    }

    private func makeHidden() {
        let config = WKWebViewConfiguration()
        guard let bridge = WebView.configure(config) else { return }
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1024, height: 768), configuration: config)
        web.load(WebView.fresh(Vault.url(for: "/today")))
        bridge.webView = web
        bridge.startWatching()
        hidden = web
        self.bridge = bridge
    }

    private func dropHidden() {
        bridge?.stopWatching()
        hidden?.configuration.userContentController.removeAllScriptMessageHandlers()
        hidden?.stopLoading()
        hidden = nil
        bridge = nil
    }

    /// Whether the page's engine is up (frontend/src/lib/backend.js sets
    /// __dvarimLocal once the store is open), waiting up to `within` seconds.
    private static func ready(_ web: WKWebView, within seconds: Double) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if (try? await web.evaluateJavaScript("!!(window.__dvarimLocal && window.dvarim)")) as? Bool == true { return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        } while Date() < deadline
        return false
    }

    private static func webView(in view: NSView?) -> WKWebView? {
        guard let view else { return nil }
        if let web = view as? WKWebView { return web }
        for sub in view.subviews { if let web = webView(in: sub) { return web } }
        return nil
    }
}

/// The page said the vault changed (op `changed`): in the app, by a sync, or
/// on disk. The badge, the menu bar and reminders ask again, once for a burst
/// of changes, whichever window's page it came from.
@MainActor
enum VaultChanges {
    private static var pending: Task<Void, Never>?

    static func changed() {
        pending?.cancel()
        pending = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await BadgeUpdater.shared.refresh()          // which reloads the menu bar too
            await ReminderScheduler.shared.sync()
        }
    }
}
