import AppKit

/// Round 6 of the self-test: calendar events (from a stand-in calendar, set in
/// prepare(), never this Mac's), Today's own headings, grouping Today by list,
/// the note about a crowded project, and Dvarim's own settings.
@MainActor
extension SelfTest {
    /// Events as the server's /api/calendar gives them: one timed and one all
    /// day today, one timed in three days.
    static func standInEvents() -> [[String: Any]] {
        let today = Dates.iso.string(from: Date())
        let later = Dates.add(today, days: 3)
        return [
            ["date": today, "allDay": false, "time": "09:30", "end": "10:00", "title": "Standup", "calendar": "Work", "color": "#5A9CF2", "uid": "e1"],
            ["date": today, "allDay": true, "time": NSNull(), "end": NSNull(), "title": "Robin's birthday", "calendar": "Family", "color": "#4CB35B", "uid": "e2"],
            ["date": later, "allDay": false, "time": "15:00", "end": "16:00", "title": "Dentist", "calendar": "Family", "color": "#4CB35B", "uid": "e3"],
        ]
    }

    static func roundSix(_ m: AppModel, _ folder: URL) async {
        let today = m.state.today
        let later = Dates.add(today, days: 3)

        // events: in Today above the to-dos, and on their day in Upcoming
        m.place = .today
        _ = await until(5) { !m.loading }
        await m.loadList()
        check(m.content.events.map(\.title) == ["Robin's birthday", "Standup"], "Today shows the calendars' events, all-day first",
              m.content.events.map(\.title).joined(separator: ", "))
        await snap("today-events")
        m.place = .upcoming
        _ = await until(5) { !m.loading }
        await pause(0.3)
        check(m.content.sections.first { $0.id == later }?.events.map(\.title) == ["Dentist"], "and Upcoming shows one on its day")
        await snap("upcoming-events")

        // which calendars, and whether at all: the engine's settings
        _ = try? await m.ask("PUT", "/api/settings", ["calendars": ["Work"]])
        m.place = .today
        _ = await until(5) { !m.loading }
        check(await until(5) { await reload(m); return m.content.events.map(\.title) == ["Standup"] }, "choosing calendars shows only theirs")
        _ = try? await m.ask("PUT", "/api/settings", ["calendars": NSNull(), "showCalendarEvents": false])
        check(await until(5) { await reload(m); return m.content.events.isEmpty }, "and turning events off takes them away")
        _ = try? await m.ask("PUT", "/api/settings", ["showCalendarEvents": true])
        _ = await until(5) { await reload(m); return m.content.events.count == 2 }

        // Today's own headings: made, renamed, a to-do dropped under one, deleted, each undone
        await m.newTodayHeading()
        guard let hid = m.todayHeadings.first?.id else { return check(false, "⇧⌘N in Today makes a heading of its own") }
        check(m.renamingHeading == "th:" + hid, "⇧⌘N in Today makes a heading of its own, its name ready to type")
        await m.renameTodayHeading(hid, "After lunch")
        check(await until(5) { m.todayHeadings.first?.name == "After lunch" }, "renaming it renames it")
        if let t = m.content.sections.first(where: { $0.id == "today" })?.rows.compactMap({ if case .todo(let x) = $0 { x } else { nil } }).first {
            m.dragging = [t.id]
            await m.drop(onSection: "th:" + hid)
            check(await until(5) { m.todayHeading(of: t.id) == hid }, "dropping a to-do on it puts it under the heading")
            await snap("today-heading")
            m.history.undo()
            check(await until(5) { m.todayHeading(of: t.id) == nil }, "and ⌘Z takes it out again")
            m.history.redo()
            _ = await until(5) { m.todayHeading(of: t.id) == hid }
            await m.deleteTodayHeading(hid)
            check(await until(5) { m.todayHeadings.isEmpty && m.content.allTodos.contains { $0.id == t.id } },
                  "deleting the heading keeps its to-dos in Today")
            m.history.undo()
            check(await until(5) { m.todayHeading(of: t.id) == hid && m.todayHeadings.first?.name == "After lunch" },
                  "and ⌘Z puts it back, with them under it")
            await m.deleteTodayHeading(hid)
            _ = await until(5) { m.todayHeadings.isEmpty }
        }

        // two headings, and the second moved up above the first, then back
        await m.newTodayHeading()
        await m.renameTodayHeading(m.todayHeadings.last?.id ?? "", "Morning")
        await m.newTodayHeading()
        await m.renameTodayHeading(m.todayHeadings.last?.id ?? "", "Evening errands")
        _ = await until(5) { m.todayHeadings.map(\.name) == ["Morning", "Evening errands"] }
        if let second = m.todayHeadings.last?.id {
            await m.moveTodayHeading(second, by: -1)
            check(await until(5) { m.todayHeadings.map(\.name) == ["Evening errands", "Morning"] }, "Move Up puts a heading above the one before it")
            m.history.undo()
            check(await until(5) { m.todayHeadings.map(\.name) == ["Morning", "Evening errands"] }, "and ⌘Z puts it back")
        }
        for h in m.todayHeadings { await m.deleteTodayHeading(h.id) }
        _ = await until(5) { m.todayHeadings.isEmpty }

        // the tag filter: only the to-dos with that tag, then all again
        let all = m.content.todoCount
        if let tag = m.fullContent.tags.first {
            m.filterTag = tag
            check(!m.content.allTodos.isEmpty && m.content.allTodos.allSatisfy { $0.tags.contains(tag) } && m.content.todoCount < all,
                  "the tag filter shows only the to-dos with that tag", "\(tag): \(m.content.todoCount) of \(all)")
            await snap("today-filtered")
            m.filterTag = nil
            check(m.content.todoCount == all, "and All shows them all again")
        } else {
            check(false, "Today has tags to filter by")
        }

        // grouped by list, and the note about a project with several to-dos in Today
        _ = try? await m.ask("PUT", "/api/settings", ["groupTodayByList": true])
        check(await until(5) { await reload(m); return m.content.sections.contains { $0.id.hasPrefix("group:") } },
              "grouping Today by list gives each list a heading",
              m.content.sections.compactMap(\.title).joined(separator: ", "))
        await snap("today-grouped")
        _ = try? await m.ask("PUT", "/api/settings", ["groupTodayByList": false])
        _ = await until(5) { await reload(m); return !m.content.sections.contains { $0.id.hasPrefix("group:") } }
        check(!m.content.crowded.isEmpty, "Today says which projects have more than one to-do in it",
              m.content.crowded.map { "\($0.name) (\($0.count))" }.joined(separator: ", "))

        // Dvarim's own settings, as the engine keeps them
        _ = try? await m.ask("PUT", "/api/settings", ["weekStartsOn": 1, "logCompleted": "manually"])
        await m.refresh()
        check(m.state.weekStartsOn == 1 && m.state.logCompleted == "manually", "Settings → Dvarim sets the week's first day and when to log")
        _ = try? await m.ask("PUT", "/api/settings", ["weekStartsOn": 0, "logCompleted": "immediately"])
        await m.refresh()

        // Settings, a picture of each tab
        clickMenu("Settings…")
        _ = await until(4) { settingsWindow != nil }
        if let w = settingsWindow, let items = w.toolbar?.items {
            check(items.count == 3, "Settings has its three tabs", items.map(\.label).joined(separator: ", "))
            for item in items {
                if let action = item.action { NSApp.sendAction(action, to: item.target, from: item) }
                await pause(0.8)
                await snapWindow(w, "settings-" + item.label.lowercased().replacingOccurrences(of: " ", with: "-"))
            }
            w.close()
        } else {
            check(false, "Settings opens")
        }
    }

    private static var settingsWindow: NSWindow? {
        NSApp.windows.first { $0.isVisible && $0.identifier?.rawValue.contains("Settings") == true || ($0.isVisible && $0.title.contains("Where")) || ($0.isVisible && $0.toolbar?.items.count == 3 && $0.title != "Dvarim") }
    }

    private static func reload(_ m: AppModel) async {
        await m.refresh()
        await m.loadList()
    }
}
