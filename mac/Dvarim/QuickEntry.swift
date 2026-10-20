import AppKit
import SwiftUI

/// The Quick Entry window: a title and its notes, over whatever you are working
/// in, gone again on Return or Escape. A nonactivating panel so it does not pull
/// your current app out from under you.
@MainActor
final class QuickEntryController {
    static let shared = QuickEntryController()
    private var panel: NSPanel?
    /// The app you were in when Quick Entry opened, to hand the keyboard back to.
    private var returnTo: NSRunningApplication?

    func toggle() {
        if let panel, panel.isVisible {
            close()
        } else {
            show()
        }
    }

    /// `text` and `notes` arrive pre-filled from the Services menu, where the
    /// selection in another app becomes the to-do you are about to save.
    func show(text: String = "", notes: String = "") {
        if panel == nil { panel = makePanel() }
        guard let panel else { return }
        // put it where the mouse is, so it lands on the screen you are looking at
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main {
            let f = panel.frame
            let x = screen.frame.midX - f.width / 2
            let y = screen.frame.midY + screen.frame.height * 0.15
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
        // No NSApp.activate: the panel can take the keyboard on its own, and
        // activating would bring every Dvarim window up over what you were doing.
        let front = NSWorkspace.shared.frontmostApplication
        returnTo = front == NSRunningApplication.current ? nil : front
        panel.makeKeyAndOrderFront(nil)
        // A fresh view each time, built once the panel is key so the field can
        // take focus: an empty line with the cursor in it.
        panel.contentView = NSHostingView(rootView: QuickEntryView(initialText: text, initialNotes: notes))
    }

    func close() {
        // Give the keyboard back first. Ordering out a key panel otherwise lets
        // AppKit promote a Dvarim window, which lifts Dvarim over the app you were in.
        if let returnTo {
            NSApp.yieldActivation(to: returnTo)
            returnTo.activate()
            self.returnTo = nil
        }
        panel?.orderOut(nil)
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: QuickEntryView.height),
                            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
                            backing: .buffered,
                            defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        return panel
    }
}

struct QuickEntryView: View {
    /// Room for the title, three lines of notes and the line under them.
    static let height: CGFloat = 138
    var initialText: String = ""
    var initialNotes: String = ""
    @ObservedObject private var outbox = Outbox.shared
    @State private var text = ""
    @State private var notes = ""
    @State private var status: String?
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("New To-Do", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 18))
                .focused($focused)
                .onSubmit(save)
            // The notes sit under the title from the start. Return
            // saves from here too; ⌥Return starts a new line.
            TextField("Notes", text: $notes, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .lineLimit(3, reservesSpace: true)
                .onSubmit(save)
            if let status {
                Text(status).font(.system(size: 11)).foregroundStyle(.secondary)
            } else if !outbox.ops.isEmpty {
                // Where the eye is when the next line is typed: the only place a
                // line kept offline could be said without a window of its own.
                let n = outbox.ops.count
                Text("\(n) kept on this Mac until the server is back · Return to save")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } else {
                Text("Return to save · tomorrow 3pm · !friday for a deadline · @9am to be reminded · #tag")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(width: 560, height: Self.height, alignment: .topLeading)
        .opacity(busy ? 0.6 : 1)
        // a turn later: set during onAppear itself, SwiftUI drops the focus
        .onAppear { text = initialText; notes = initialNotes; DispatchQueue.main.async { focused = true } }
        .onExitCommand { QuickEntryController.shared.close() }
    }

    private func save() {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, !busy else { return }
        busy = true
        Task {
            do {
                // Out of the way either way: a line the server cannot be reached
                // for is kept on this Mac (Outbox), which is as good as saved.
                let note = notes.trimmingCharacters(in: .whitespacesAndNewlines)
                let outcome = try await Outbox.shared.quickAdd(line, notes: note.isEmpty ? nil : note)
                await MainActor.run {
                    text = ""
                    notes = ""
                    busy = false
                    status = nil
                    QuickEntryController.shared.close()
                }
                if case .sent = outcome { await BadgeUpdater.shared.refresh() }
            } catch {
                await MainActor.run {
                    busy = false
                    status = error.localizedDescription
                }
            }
        }
    }
}
