import SwiftUI
import WebKit

/// The web app, which is the whole UI. The shell adds only what a browser
/// cannot do. The page comes from the server, or — with the to-dos in a folder
/// on this Mac (Vault) — from inside the app, reading and writing that folder
/// through FolderBridge (docs/BRIDGE.md).
struct WebView: NSViewRepresentable {
    let url: URL
    /// Opens another shell window at a path of the web app, e.g. "/project/p7k3j9a2".
    var openWindow: (String) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(openWindow: openWindow) }

    /// The app, from the server and not from WebKit's cache. The page that comes
    /// back names the build's bundles, and WebKit was answering for it out of its
    /// own cache without asking anyone - no request reached the server at launch
    /// at all - so the window went on showing an old build after a deploy. The
    /// service worker still answers when there is no network.
    /// A string as a JavaScript literal.
    static func js(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(decoding: data, as: UTF8.self).dropFirst().dropLast().description
    }

    static func fresh(_ url: URL) -> URLRequest {
        URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
    }

    /// What every page of the app is given, a window's or LocalPage's hidden
    /// one: the shell's user agent, and in folder mode the page from inside the
    /// app with the folder behind it. Returns the folder's bridge, in folder mode.
    @MainActor
    static func configure(_ config: WKWebViewConfiguration) -> FolderBridge? {
        config.websiteDataStore = .default()          // keep the login, the service worker and its cache
        // Lets the page tell it is inside the shell. "chromeless" says the window
        // has no title bar, so the page must make room for the traffic lights
        // itself; a shell that still had one said "Dvarim/1.0 (macOS shell)".
        config.applicationNameForUserAgent = "Dvarim/1.1 (macOS shell; chromeless)"
        // A folder instead of a server: the page from inside the app, and the
        // folder behind it. Only a page from the app's own scheme may use it.
        guard Vault.usesFolder, let folder = Vault.folder, let web = Vault.webBundle else { return nil }
        config.setURLSchemeHandler(AppScheme(root: web), forURLScheme: AppScheme.scheme)
        let bridge = FolderBridge(root: folder)
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "dvarimStorage")
        return bridge
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // The one thing the page tells the shell: see Coordinator's
        // userContentController(_:didReceive:) below.
        config.userContentController.add(context.coordinator, name: "dvarim")
        context.coordinator.bridge = Self.configure(config)
        // The server's page, in an app that can keep the to-dos itself: it
        // must not keep a second copy in its own storage, and its "keep a copy
        // on this device" asks the app (useCopy, below) instead.
        if context.coordinator.bridge == nil && Vault.webBundle != nil {
            let shell = "window.__dvarimShell = Object.freeze({ copy: true, mode: \(Self.js(Vault.mode)) });"
            config.userContentController.addUserScript(WKUserScript(source: shell, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        if context.coordinator.bridge != nil { LocalPage.shared.windowOpened() }
        let view = ShellWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.load(Self.fresh(url))
        context.coordinator.view = view
        context.coordinator.bridge?.webView = view
        context.coordinator.bridge?.startWatching()
        return view
    }

    /// A window closed, or rebuilt for another mode: stop watching its folder,
    /// and let go of the handlers, which the configuration would otherwise keep.
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.bridge?.stopWatching()
        view.configuration.userContentController.removeAllScriptMessageHandlers()
        // the last window on a folder: the badge and the menu bar ask again, which
        // brings up LocalPage's own page to go on watching the folder
        if coordinator.bridge != nil { VaultChanges.changed() }
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        if view.url == nil { view.load(Self.fresh(url)) }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        weak var view: WKWebView?
        let openWindow: (String) -> Void
        /// The folder behind the page, in folder mode.
        var bridge: FolderBridge?

        init(openWindow: @escaping (String) -> Void) { self.openWindow = openWindow }

        /// The app's own page: from the server, or from inside the app.
        private func isOurs(_ url: URL) -> Bool {
            url.scheme == AppScheme.scheme || (url.host == Defaults.server.host && url.port == Defaults.server.port)
        }

        /// Links to anywhere but the app's own page open in the real browser, so
        /// a link in a to-do's notes does not strand you inside the app.
        func webView(_ webView: WKWebView,
                     decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            guard let target = action.request.url else { return decisionHandler(.allow) }
            // The web app's Settings → Data points at the shell's own settings.
            if target.scheme == "dvarim" {
                if target.host == "settings" { Windows.openSettings() }
                return decisionHandler(.cancel)
            }
            if action.navigationType == .linkActivated && !isOurs(target) {
                NSWorkspace.shared.open(target)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        /// window.open and target=_blank. The web app's "Open in a new window"
        /// becomes a real shell window on the same list; anything off the
        /// server goes to the browser. Without this WebKit silently drops both.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let target = action.request.url else { return nil }
            if isOurs(target) {
                openWindow(target.path + (target.query.map { "?" + $0 } ?? ""))
            } else {
                NSWorkspace.shared.open(target)
            }
            return nil
        }

        /// A page of the server's has loaded in copy mode with no copy yet:
        /// the person is about to sign in, or has. Signing in does not load a
        /// page (the app swaps its screen), so until the copy is set up the
        /// window asks every few seconds whether there is a sign-in to set it
        /// up from (AppCopy), which reloads it into the copy.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard bridge == nil, Vault.mode == Vault.copyMode, webView.url.map(isOurs) == true else { return }
            Task { await AppCopy.setUpIfSignedIn() }
            guard waitingForSignIn == nil else { return }
            waitingForSignIn = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] timer in
                MainActor.assumeIsolated {
                    guard let self, self.view != nil, Vault.mode == Vault.copyMode, AppCopy.current == nil else {
                        timer.invalidate()
                        return
                    }
                    Task { await AppCopy.setUpIfSignedIn() }
                }
            }
        }
        private var waitingForSignIn: Timer?
        deinit { waitingForSignIn?.invalidate() }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("Dvarim: navigation failed — \(error.localizedDescription)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("Dvarim: could not reach \(Defaults.server.absoluteString) — \(error.localizedDescription)")
        }

        /// Putting the sidebar away is the page's business, and it
        /// does it anywhere; what only a Mac app can do is give the room back:
        /// the window narrows by the sidebar's width and the list stays the
        /// size it was.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            // The server's page asks for the to-dos to be kept on this Mac.
            if body["type"] as? String == "useCopy" {
                guard isOurs(message.frameInfo.request.url ?? Defaults.server) else { return }
                Task { @MainActor in Vault.useCopy() }
                return
            }
            guard body["type"] as? String == "slim",
                  let on = body["on"] as? Bool, let window = view?.window else { return }
            let sidebar = (body["width"] as? NSNumber).map { CGFloat(truncating: $0) } ?? 236
            SlimWindow.apply(on: on, sidebar: sidebar, to: window)
        }

        func reload() { view?.reload() }
        func go(_ path: String) {
            view?.load(WebView.fresh(Vault.url(for: path)))
        }
    }
}

/// The page gets every shortcut first, which is how ⌘N reaches the web app as
/// New To-Do. Chords with ⌃ are the exception: the web app reads ⌃
/// only as the non-Mac spelling of ⌘, while on a Mac ⌃⌘N is New Window and ⌃Space
/// is Quick Entry. Those go to the menu bar first, and on to the page only if no
/// menu item wants them. Without this, whether ⌃⌘N opened a window or made a
/// to-do depended on what the page happened to be doing.
final class ShellWebView: WKWebView {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.control), NSApp.mainMenu?.performKeyEquivalent(with: event) == true {
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    /// Keys go to the page from the moment its window opens, so ⌘N works without
    /// clicking into the page first.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.makeFirstResponder(self)
    }
}

/// A window that has given up its sidebar's width, and what it gave.
@MainActor
enum SlimWindow {
    /// Narrower than this the web app turns into its phone layout, which is a
    /// different thing from a desk with the sidebar put away.
    static let floor: CGFloat = 724
    private static var taken: [Int: CGFloat] = [:]

    static func apply(on: Bool, sidebar: CGFloat, to window: NSWindow) {
        guard !window.styleMask.contains(.fullScreen) else { return }
        var frame = window.frame
        if on {
            // As much of the sidebar's width as there is to give. The origin is
            // the bottom-left corner, so the left edge stays where it is.
            let give = min(sidebar, max(0, frame.width - floor))
            taken[window.windowNumber] = give
            frame.size.width -= give
        } else {
            // Back by what was taken; a window that opened already slim took
            // nothing here, and needs the sidebar's worth to show it in.
            frame.size.width += taken.removeValue(forKey: window.windowNumber) ?? sidebar
            if let screen = window.screen?.visibleFrame {
                frame.size.width = min(frame.width, screen.width)
                if frame.maxX > screen.maxX { frame.origin.x = max(screen.minX, screen.maxX - frame.width) }
            }
        }
        window.setFrame(frame, display: true, animate: true)
    }
}
