import AppKit
import SwiftUI

/// Quick Entry: a title and its notes, over whatever you are working in, gone
/// again on Return or Escape. A panel that doesn't activate the app, so it
/// doesn't pull the app you were in out from under you. The engine reads the
/// line as quick-add does everywhere: a date phrase, !deadline, @reminder, #tags.
@MainActor
final class QuickEntry {
    static let shared = QuickEntry()

    @Observable
    final class Draft {
        var text = ""
        var notes = ""
        var status: String?
        var busy = false
    }

    let draft = Draft()
    private(set) var panel: NSPanel?
    /// The app you were in, to give the keyboard back to.
    private var returnTo: NSRunningApplication?

    var isShown: Bool { panel?.isVisible == true }

    func toggle() { if isShown { close() } else { show() } }

    /// From the Services menu, a selection in another app arrives as its title and notes.
    func show(text: String = "", notes: String = "") {
        if panel == nil { panel = makePanel() }
        guard let panel else { return }
        draft.text = text
        draft.notes = notes
        draft.status = nil
        draft.busy = false
        // on the screen the pointer is on, a little above the middle
        let size = NSSize(width: QuickEntryView.width, height: QuickEntryView.height)
        var origin = panel.frame.origin
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main {
            origin = NSPoint(x: screen.frame.midX - size.width / 2, y: screen.frame.midY + screen.frame.height * 0.15)
        }
        // No NSApp.activate: that would bring every window of this app up over what you were doing.
        let front = NSWorkspace.shared.frontmostApplication
        returnTo = front == NSRunningApplication.current ? nil : front
        panel.makeKeyAndOrderFront(nil)
        // built once the panel is key, so that the title field takes the keyboard
        let host = NSHostingView(rootView: QuickEntryView(draft: draft))
        host.sizingOptions = []
        panel.contentView = host
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    func close() {
        // The keyboard goes back first: ordering out a key panel otherwise lets
        // AppKit bring up a window of this app over the one you were in.
        if let returnTo {
            NSApp.yieldActivation(to: returnTo)
            returnTo.activate()
            self.returnTo = nil
        }
        panel?.orderOut(nil)
    }

    /// Return: kept in the Inbox (or wherever its words say), or on this Mac
    /// until it can be (Outbox), which is as good as saved.
    func save() {
        let line = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, !draft.busy else { return }
        draft.busy = true
        let notes = draft.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                _ = try await Outbox.shared.quickAdd(line, notes: notes.isEmpty ? nil : notes)
                draft.text = ""
                draft.notes = ""
                draft.busy = false
                close()
            } catch {
                draft.busy = false
                draft.status = error.localizedDescription
            }
        }
    }

    /// No title bar, so nothing but the view decides its size (a hidden one
    /// still kept its room, and the panel grew by it); corners and a hairline
    /// of its own, and the system's shadow.
    private func makePanel() -> NSPanel {
        let p = EntryPanel(contentRect: NSRect(x: 0, y: 0, width: QuickEntryView.width, height: QuickEntryView.height),
                           styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isMovableByWindowBackground = true
        p.level = .floating
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.isReleasedWhenClosed = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        return p
    }
}

/// A borderless panel takes the keyboard only if it says it can.
final class EntryPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

struct QuickEntryView: View {
    static let width: CGFloat = 560
    /// The title, three lines of notes and the line under them.
    static let height: CGFloat = 138
    @Bindable var draft: QuickEntry.Draft
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(Palette.check, lineWidth: 1.5)
                    .frame(width: Metrics.box, height: Metrics.box)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                TextField("New To-Do", text: $draft.text)
                    .textFieldStyle(.plain)
                    .font(.system(size: 18))
                    .foregroundStyle(Palette.text)
                    .focused($focused)
                    .onSubmit { QuickEntry.shared.save() }
            }
            // Return saves from the notes too; ⌥Return starts a new line.
            TextField("Notes", text: $draft.notes, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .foregroundStyle(Palette.text2)
                .lineLimit(3, reservesSpace: true)
                .padding(.leading, Metrics.box + 10)
                .onSubmit { QuickEntry.shared.save() }
            Text(hint)
                .font(.system(size: 11))
                .foregroundStyle(draft.status == nil ? Palette.text3 : Palette.deadline)
                .padding(.leading, Metrics.box + 10)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(width: Self.width, height: Self.height, alignment: .topLeading)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.hair, lineWidth: 1))
        .opacity(draft.busy ? 0.6 : 1)
        .tint(Palette.accent)
        // a turn later: set during onAppear itself, SwiftUI drops the focus
        .onAppear { DispatchQueue.main.async { focused = true } }
        .onExitCommand { QuickEntry.shared.close() }
    }

    /// What can be typed, or what is kept, or what went wrong.
    private var hint: String {
        if let s = draft.status { return s }
        let n = Outbox.shared.ops.count
        if n > 0 { return "\(n) kept on this Mac until Dvarim can save \(n == 1 ? "it" : "them") · Return to save" }
        return "Return to save · tomorrow 3pm · !friday for a deadline · @9am to be reminded · #tag"
    }
}
