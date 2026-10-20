import SwiftUI
import UserNotifications

/// Today in the menu bar: the count beside the clock, the list behind it, each
/// line tickable. The point is the glance — you see what is left without bringing
/// a window forward, which is most of what a task app is for on a Mac.
@MainActor
final class TodayMenu: ObservableObject {
    static let shared = TodayMenu()

    @Published private(set) var items: [Client.Todo] = []
    @Published private(set) var problem: String?
    /// The server could not be reached last time; `items` is what it said before.
    @Published private(set) var offline = false

    var count: Int { items.count }

    /// What the server says is left today, less what was ticked here and not
    /// sent yet. With no server, what it said last time — still the best guess,
    /// where an empty list would read as "nothing left".
    func load() async {
        let ticked = Outbox.shared.completing
        do {
            items = try await Client.current.today().items.filter { $0.isOpen && !ticked.contains($0.id) }
            problem = nil
            offline = false
        } catch is Client.Unreachable {
            items.removeAll { ticked.contains($0.id) }
            offline = true
        } catch is Client.NotSignedIn {
            items = []
            problem = "Not signed in"
            offline = false
        } catch {
            items = []
            problem = error.localizedDescription
            offline = false
        }
    }

    /// Ticking a line completes it on the server, or keeps the tick for when it
    /// can (Outbox); the row leaves at once either way, as it does in the web
    /// app, and the badge follows. A reminder waiting for it is withdrawn now
    /// rather than at the next reminder sync, which might ring it first.
    func complete(_ todo: Client.Todo) async {
        items.removeAll { $0.id == todo.id }
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [todo.id])
        do { try await Outbox.shared.complete(todo.id, title: todo.title) } catch { problem = error.localizedDescription }
        await BadgeUpdater.shared.refresh()      // which reloads this list too
    }
}

struct MenuBarLabel: View {
    @ObservedObject var menu: TodayMenu

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "checkmark.circle")
            if menu.count > 0 { Text("\(menu.count)") }
        }
    }
}

struct MenuBarContent: View {
    @ObservedObject private var menu = TodayMenu.shared
    @ObservedObject private var outbox = Outbox.shared
    @Environment(\.openWindow) private var openWindow

    /// Said under the title when there is something to say: that the list is
    /// what the server said last, how many ticks and lines are kept here, and
    /// the last thing the server turned down.
    private var note: String? {
        let n = outbox.ops.count
        let kept = n > 0 ? "\(n) kept on this Mac" : nil
        if menu.offline { return ["Offline — as it last was", kept].compactMap { $0 }.joined(separator: " · ") }
        if let kept { return kept + ", sending" }
        return outbox.refused.map { "Not saved — \($0)" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Today").font(.headline).padding(.horizontal, 12).padding(.top, 10).padding(.bottom, note == nil ? 6 : 2)
            if let note {
                Text(note).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.bottom, 6)
            }

            if let problem = menu.problem {
                message(problem)
            } else if menu.items.isEmpty {
                message("Nothing left for today")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(menu.items) { todo in row(todo) }
                    }
                }
                .frame(maxHeight: 320)
            }

            Divider().padding(.vertical, 6)
            command("Quick Entry", "plus.circle") { QuickEntryController.shared.show() }
            command("Open Dvarim", "macwindow") { openDvarim() }
            command("Quit Dvarim", "power") { NSApp.terminate(nil) }
            Spacer(minLength: 6)
        }
        .frame(width: 280)
        .task { await menu.load() }
    }

    private func row(_ todo: Client.Todo) -> some View {
        Button {
            Task { await menu.complete(todo) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "circle").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(todo.title).lineLimit(1)
                    if let project = todo.projectName {
                        Text(project).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if todo.evening { Image(systemName: "moon.fill").font(.caption2).foregroundStyle(.secondary) }
                if todo.reminder != nil { Image(systemName: "bell.fill").font(.caption2).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func message(_ text: String) -> some View {
        Text(text).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.vertical, 4)
    }

    private func command(_ title: String, _ symbol: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func openDvarim() {
        NSApp.activate()
        if let window = NSApp.windows.first(where: { $0.isVisible && $0.canBecomeMain }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            openWindow(id: "main")
        }
    }
}
