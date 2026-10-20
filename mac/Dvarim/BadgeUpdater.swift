import AppKit
import Network

/// Dock badge, polled from GET /api/state. The web app cannot set one.
///
/// It is also the shell's heartbeat: every refresh first sends whatever Outbox
/// kept while the server could not be reached, and a Mac that finds a network
/// again refreshes at once rather than at the next tick of the timer.
actor BadgeUpdater {
    static let shared = BadgeUpdater()
    private var timer: Task<Void, Never>?
    private let network = NWPathMonitor()
    private var onNetwork = true
    /// What the badge counts, as the server last said (Settings → Badge count).
    private var mode = "today"
    /// Today's count as the server last gave it, for while it cannot be asked.
    private var lastToday: Int?

    func start(every seconds: UInt64 = 60) {
        timer?.cancel()
        timer = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            }
        }
        network.pathUpdateHandler = { [weak self] path in
            Task { await self?.networkChanged(path.status == .satisfied) }
        }
        network.start(queue: .global(qos: .utility))
    }

    func stop() {
        timer?.cancel()
        timer = nil
        network.cancel()
    }

    /// Only the way back matters: that is when something may be waiting.
    private func networkChanged(_ satisfied: Bool) async {
        let back = satisfied && !onNetwork
        onNetwork = satisfied
        if back { await refresh() }
    }

    /// What it counts is the web app's setting (Settings → Badge count), so there
    /// is one switch for it.
    func refresh() async {
        await Outbox.shared.drain()
        do {
            let state = try await Client.current.state()
            mode = state.settings?.badgeCount ?? "today"
            lastToday = state.counts.today
            let n: Int? = switch mode {
            case "inbox": state.counts.inbox
            case "none": nil
            default: state.counts.today
            }
            await show(n)
        } catch is Client.Unreachable {
            // Keep the count it had, less anything ticked here since: no server
            // is not the same as nothing left, and the menu bar leaves those
            // ticks out already, so the two should agree.
            if mode == "today", let lastToday {
                await show(max(0, lastToday - Outbox.shared.completing.count))
            }
        } catch {
            await show(nil)
        }
        await TodayMenu.shared.load()      // one timer for the badge and the menu bar
    }

    @MainActor private func show(_ n: Int?) {
        NSApp.dockTile.badgeLabel = n.flatMap { $0 > 0 ? String($0) : nil }
    }
}
