import AppIntents

/// Shortcuts, Spotlight and Siri, through the same API as everything else.
struct CreateToDo: AppIntent {
    static let title: LocalizedStringResource = "Create To-Do"
    static let description = IntentDescription("Adds a to-do, read as Quick Entry reads it: a date phrase at the end, !friday for a deadline, @9am for a reminder, #tags anywhere.")

    @Parameter(title: "To-Do") var text: String
    @Parameter(title: "List", default: .inbox) var list: DvarimInbox

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$text) to \(\.$list)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        switch try await Outbox.shared.quickAdd(text, list: list.rawValue) {
        case .sent(let todo):
            return .result(dialog: "Added “\(todo.title)”.")
        case .kept:
            return .result(dialog: "Dvarim can't be reached, so “\(text)” is kept on this Mac and goes in when it can.")
        }
    }
}

struct ShowQuickEntry: AppIntent {
    static let title: LocalizedStringResource = "Show Quick Entry"
    static let description = IntentDescription("Opens Quick Entry, ready to type into.")

    @MainActor
    func perform() async throws -> some IntentResult {
        QuickEntry.shared.show()
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
        await Windows.show(list.place)
        return .result()
    }
}

/// Where a new to-do goes, as POST /api/quick-add takes it.
enum DvarimInbox: String, AppEnum {
    case inbox, today

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "List")
    static let caseDisplayRepresentations: [DvarimInbox: DisplayRepresentation] = [
        .inbox: "Inbox", .today: "Today",
    ]
}

enum DvarimList: String, AppEnum {
    case inbox, today, upcoming, anytime, someday, logbook

    var place: Place { Place(list: rawValue) ?? .today }

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
