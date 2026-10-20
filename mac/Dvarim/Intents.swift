import AppIntents

/// Shortcuts, Spotlight and Siri, through the same API everything else here uses.
/// Shortcuts and Siri are Apple-only and out of reach for the web app; with a
/// native shell they are three small types.
struct CreateToDo: AppIntent {
    static let title: LocalizedStringResource = "Create To-Do"
    static let description = IntentDescription("Adds a to-do, with the grammar Quick Entry understands: a trailing date phrase, !friday for a deadline, @9am for a reminder, #tags anywhere.")

    @Parameter(title: "To-Do") var text: String
    @Parameter(title: "List", default: .inbox) var list: DvarimInbox

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$text) to \(\.$list)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        switch try await Outbox.shared.quickAdd(text, list: list.rawValue) {
        case .sent(let todo):
            await BadgeUpdater.shared.refresh()
            return .result(dialog: "Added \"\(todo.title)\"")
        case .kept:
            return .result(dialog: "Dvarim can't be reached, so \"\(text)\" is kept on this Mac and goes in when it can.")
        }
    }
}

struct ShowQuickEntry: AppIntent {
    static let title: LocalizedStringResource = "Show Quick Entry"
    static let description = IntentDescription("Opens the Quick Entry panel, ready to type into.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        QuickEntryController.shared.show()
        return .result()
    }
}

struct OpenList: AppIntent {
    static let title: LocalizedStringResource = "Open List"
    static let description = IntentDescription("Shows one of Dvarim's lists.")
    static let openAppWhenRun = true

    @Parameter(title: "List", default: .today) var list: DvarimList

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$list)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        Windows.show(list.path)
        return .result()
    }
}

/// Where a new to-do lands, which is what `POST /api/quick-add` takes.
enum DvarimInbox: String, AppEnum {
    case inbox, today

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "List")
    static let caseDisplayRepresentations: [DvarimInbox: DisplayRepresentation] = [
        .inbox: "Inbox", .today: "Today",
    ]
}

/// The lists the web app has routes for.
enum DvarimList: String, AppEnum {
    case inbox, today, upcoming, anytime, someday, logbook

    var path: String { "/" + rawValue }

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "List")
    static let caseDisplayRepresentations: [DvarimList: DisplayRepresentation] = [
        .inbox: "Inbox", .today: "Today", .upcoming: "Upcoming",
        .anytime: "Anytime", .someday: "Someday", .logbook: "Logbook",
    ]
}

struct DvarimShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: CreateToDo(),
                    phrases: ["Add a to-do to \(.applicationName)", "New \(.applicationName) to-do"],
                    shortTitle: "Create To-Do", systemImageName: "plus.circle")
        AppShortcut(intent: ShowQuickEntry(),
                    phrases: ["Open \(.applicationName) Quick Entry"],
                    shortTitle: "Quick Entry", systemImageName: "square.and.pencil")
        AppShortcut(intent: OpenList(),
                    phrases: ["Open a list in \(.applicationName)"],
                    shortTitle: "Open List", systemImageName: "list.bullet")
    }
}
