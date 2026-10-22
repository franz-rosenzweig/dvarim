import AppKit
import SwiftUI

/// Putting a list or a to-do on screen from outside a window: the menu bar,
/// a reminder, Shortcuts. SwiftUI's openWindow exists only inside a view, so
/// each window hands it over as it appears, and tells its model which window it is.
@MainActor
enum Windows {
    static var openNew: ((Place) -> Void)?

    /// The app's own windows on screen (not Quick Entry, not a popover, not the menu bar's).
    static var visible: [NSWindow] {
        NSApp.windows.filter { $0.isVisible && $0.canBecomeMain && !($0 is NSPanel) && !$0.className.contains("Popover") }
    }

    /// The model of the window in front, once there is a window.
    private static func front() async -> AppModel? {
        for _ in 0..<30 {
            let shown = visible
            if let w = shown.first(where: { $0 === NSApp.keyWindow }) ?? shown.first {
                w.makeKeyAndOrderFront(nil)
                return Session.shared.open.first { $0.window === w } ?? AppModel.shared
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return nil
    }

    /// The app in front, and a window of it.
    static func bringUp(_ openWindow: OpenWindowAction? = nil) {
        NSApp.activate()
        if let w = visible.first { w.makeKeyAndOrderFront(nil); return }
        if let openWindow { openWindow(id: "main", value: Place.today) } else { openNew?(.today) }
    }

    /// A list, in the window in front, or in a new one.
    static func show(_ place: Place) async {
        NSApp.activate()
        if visible.isEmpty { openNew?(place) }
        guard let m = await front() else { return }
        m.place = place
    }

    /// A to-do, open in its list.
    static func open(todo id: String) async {
        NSApp.activate()
        if visible.isEmpty { openNew?(.today) }
        guard let m = await front() else { return }
        await m.session.ready(within: 10)
        guard let j = try? await m.backend?.request("GET", "/api/todos/\(id)", body: nil) else { return }
        await m.go(.init(kind: .todo(Todo(j))))
    }
}

/// "New To-Do in Dvarim" in every app's Services menu, for whatever
/// text is chosen there. It can have a key of its own (System Settings →
/// Keyboard → Keyboard Shortcuts → Services), a second way in when Quick
/// Entry's chord is spoken for. Quick Entry opens with it, the first line the
/// title and the rest the notes, so its words still work and it can be changed first.
final class ServiceProvider: NSObject {
    @MainActor
    @objc func newToDo(_ pasteboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
        let body = (pasteboard.string(forType: .string) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            error.pointee = "Nothing chosen to make a to-do of."
            return
        }
        let (title, notes) = Self.split(body)
        QuickEntry.shared.show(text: title, notes: notes)
    }

    static func split(_ text: String) -> (String, String) {
        let lines = text.split(whereSeparator: \.isNewline)
        let title = lines.first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        let rest = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (title, rest)
    }
}

/// Tells a window's model which NSWindow is its own, as the view lands in it.
struct WindowReader: NSViewRepresentable {
    let model: AppModel

    final class Reporter: NSView {
        weak var model: AppModel?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            model?.window = window
        }
    }

    func makeNSView(context: Context) -> Reporter {
        let v = Reporter()
        v.model = model
        return v
    }

    func updateNSView(_ v: Reporter, context: Context) {}
}
