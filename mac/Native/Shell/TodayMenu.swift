import AppKit
import SwiftUI
import UserNotifications

/// Today in the menu bar: the count beside the clock, the list behind it, each
/// line tickable, so what is left can be seen without a window.
@MainActor
@Observable
final class TodayMenu {
    static let shared = TodayMenu()

    private(set) var items: [Todo] = []
    private(set) var problem: String?
    /// No answer last time: `items` is what there was before.
    private(set) var offline = false

    /// What is left today, less what was ticked here and not sent yet.
    func load() async {
        let ticked = Outbox.shared.completing
        let session = Session.shared
        guard session.phase == .ready, let backend = session.backend else {
            items = []
            problem = session.phase == .starting ? nil : "Not signed in"
            return
        }
        do {
            let j = try await backend.request("GET", Place.today.path, body: nil)
            items = Lists.content(.today, j, state: session.state).allTodos.filter { $0.isOpen && !ticked.contains($0.id) }
            problem = nil
            offline = false
        } catch let e as APIError where e.unreachable {
            items.removeAll { ticked.contains($0.id) }
            offline = true
        } catch {
            items = []
            problem = error.localizedDescription
            offline = false
        }
    }

    /// The row goes at once; the tick is sent, or kept until it can be. A
    /// reminder waiting for it goes now, rather than ringing first.
    func complete(_ todo: Todo) async {
        items.removeAll { $0.id == todo.id }
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [todo.id])
        do { try await Outbox.shared.complete(todo.id, title: todo.title) } catch { problem = error.localizedDescription }
        if Outbox.shared.ops.isEmpty { await Session.shared.refresh() } else { Dock.show(nil) }
    }
}

/// The menu bar's own mark: the app's tick in its box, and Today's count.
struct MenuBarLabel: View {
    let session: Session
    var body: some View {
        let n = max(0, session.state.todayCount - Outbox.shared.completing.count)
        HStack(spacing: 3) {
            Image(systemName: "checkmark.square")
            if session.phase == .ready, n > 0 { Text("\(n)") }
        }
    }
}

struct MenuBarContent: View {
    let menu: TodayMenu
    let shell: Shell
    @Environment(\.openWindow) private var openWindow

    /// Under the title: that this is as it was last, how much is kept here, and
    /// the last thing the server turned down.
    private var note: String? {
        let n = Outbox.shared.ops.count
        let kept = n > 0 ? "\(n) kept on this Mac" : nil
        if menu.offline { return ["Offline, as it last was", kept].compactMap { $0 }.joined(separator: " · ") }
        if let kept { return kept + ", sending" }
        return Outbox.shared.refused.map { "Not saved: \($0)" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Icons.sun.drawn(Palette.star).frame(width: 15, height: 15)
                Text("Today").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.text)
            }
            .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, note == nil ? 6 : 2)
            if let note {
                Text(note).font(.system(size: 11)).foregroundStyle(Palette.text2).padding(.horizontal, 12).padding(.bottom, 6)
            }
            if let problem = menu.problem {
                message(problem)
            } else if menu.items.isEmpty {
                message("Nothing left for today")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(menu.items) { row($0) }
                    }
                }
                .frame(maxHeight: 320)
            }
            Divider().padding(.vertical, 6)
            command("Quick Entry", shell.chord?.display) { QuickEntry.shared.show() }
            command("Open Dvarim", nil) { Windows.bringUp(openWindow) }
            command("Quit Dvarim", "⌘Q") { NSApp.terminate(nil) }
            Spacer(minLength: 6)
        }
        .frame(width: 290)
        .background(Palette.main)
        .task { await menu.load() }
    }

    private func row(_ todo: Todo) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            CheckBox(done: false) { Task { await menu.complete(todo) } }
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
            VStack(alignment: .leading, spacing: 1) {
                Text(todo.title).font(.system(size: 13)).foregroundStyle(Palette.text).lineLimit(1)
                if let p = todo.projectName ?? todo.areaName {
                    Text(p).font(.system(size: 11)).foregroundStyle(Palette.text2).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if todo.evening { Icons.moon.drawn(Palette.moon).frame(width: 11, height: 11) }
            if let r = todo.reminder { Text(r).font(.system(size: 11)).foregroundStyle(Palette.text2) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
    }

    private func message(_ text: String) -> some View {
        Text(text).font(.system(size: 13)).foregroundStyle(Palette.text2).padding(.horizontal, 12).padding(.vertical, 4)
    }

    private func command(_ title: String, _ key: String?, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).foregroundStyle(Palette.text)
                Spacer()
                if let key { Text(key).foregroundStyle(Palette.text3) }
            }
            .font(.system(size: 13))
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
