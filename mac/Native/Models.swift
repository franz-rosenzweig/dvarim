import Foundation

/// JSON as the API sends it, read loosely: a field that is missing, null or of
/// another type reads as nothing, rather than failing the whole answer, so a
/// field the engine adds or drops never blanks a list.
struct J: @unchecked Sendable {
    let raw: Any?

    init(_ raw: Any?) { self.raw = raw is NSNull ? nil : raw }
    init(data: Data) { self.init(try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) }

    subscript(_ key: String) -> J { J((raw as? [String: Any])?[key]) }
    var string: String? { raw as? String }
    var bool: Bool { (raw as? Bool) ?? ((raw as? NSNumber)?.boolValue ?? false) }
    var int: Int? { (raw as? NSNumber)?.intValue }
    var double: Double? { (raw as? NSNumber)?.doubleValue }
    var array: [J] { ((raw as? [Any]) ?? []).map(J.init) }
    var strings: [String] { ((raw as? [Any]) ?? []).compactMap { $0 as? String } }
    var exists: Bool { raw != nil }
}

struct ChecklistItem: Hashable, Sendable {
    var text: String
    var done: Bool
}

struct Todo: Identifiable, Hashable, Sendable {
    let id: String
    var title: String
    var notes: String
    var status: String                 // open, done, canceled
    var inbox: Bool
    var someday: Bool
    var when: String?
    var evening: Bool
    var reminder: String?
    var deadline: String?
    var repeatRule: String?
    var tags: [String]
    var checklist: [ChecklistItem]
    var completed: String?
    var projectId: String?
    var projectName: String?
    var areaId: String?
    var areaName: String?
    var headingId: String?
    var headingName: String?
    var trashed: Bool

    var isOpen: Bool { status == "open" }

    init(_ j: J) {
        id = j["id"].string ?? UUID().uuidString
        title = j["title"].string ?? ""
        notes = j["notes"].string ?? ""
        status = j["status"].string ?? "open"
        inbox = j["inbox"].bool
        someday = j["someday"].bool
        when = j["when"].string
        evening = j["evening"].bool
        reminder = j["reminder"].string
        deadline = j["deadline"].string
        repeatRule = j["repeat"].string
        tags = j["tags"].strings
        checklist = j["checklist"].array.map { ChecklistItem(text: $0["text"].string ?? "", done: $0["done"].bool) }
        completed = j["completed"].string
        projectId = j["projectId"].string
        projectName = j["projectName"].string
        areaId = j["areaId"].string
        areaName = j["areaName"].string
        headingId = j["headingId"].string
        headingName = j["headingName"].string
        trashed = j["trashed"].bool
    }
}

struct Project: Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var notes: String
    var status: String
    var when: String?
    var deadline: String?
    var someday: Bool
    var areaId: String?
    var areaName: String?
    var progress: Double
    var openCount: Int
    var headings: [Heading]

    struct Heading: Hashable, Sendable {
        let id: String
        let name: String
        let archived: Bool
    }

    init(_ j: J) {
        id = j["id"].string ?? UUID().uuidString
        name = j["name"].string ?? ""
        notes = j["notes"].string ?? ""
        status = j["status"].string ?? "open"
        when = j["when"].string
        deadline = j["deadline"].string
        someday = j["someday"].bool
        areaId = j["areaId"].string
        areaName = j["areaName"].string
        progress = j["progress"].double ?? 0
        openCount = j["openCount"].int ?? 0
        // archived is the day it was archived, or nothing
        headings = j["headings"].array.map { h in
            Heading(id: h["id"].string ?? "", name: h["name"].string ?? "",
                    archived: h["archived"].exists && (h["archived"].raw as? Bool) != false)
        }
    }
}

struct Area: Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var notes: String
    var openCount: Int
    var projects: [Project]

    init(_ j: J) {
        id = j["id"].string ?? UUID().uuidString
        name = j["name"].string ?? ""
        notes = j["notes"].string ?? ""
        openCount = j["openCount"].int ?? 0
        projects = j["projects"].array.map(Project.init)
    }
}

/// GET /state: the sidebar's whole content and the counts beside it.
struct AppState: Sendable {
    var today: String
    var inboxCount: Int
    var todayCount: Int
    var todayDeadlines: Int
    var areas: [Area]
    var looseProjects: [Project]
    var tags: [String]
    var weekStartsOn: Int
    var badgeCount: String
    /// The engine's other settings (store.js DEFAULT_SETTINGS), as Settings shows them.
    var logCompleted: String
    var groupTodayByList: Bool
    var showCalendarEvents: Bool
    /// The calendars shown: nil for all of them.
    var calendars: [String]?

    static let empty = AppState(J(nil))

    init(_ j: J) {
        today = j["today"].string ?? ""
        inboxCount = j["counts"]["inbox"].int ?? 0
        todayCount = j["counts"]["today"].int ?? 0
        todayDeadlines = j["counts"]["todayDeadlines"].int ?? 0
        areas = j["areas"].array.map(Area.init)
        looseProjects = j["looseProjects"].array.map(Project.init)
        tags = j["tags"].array.compactMap { $0["name"].string ?? $0.string }
        weekStartsOn = j["settings"]["weekStartsOn"].int ?? 0
        badgeCount = j["settings"]["badgeCount"].string ?? "today"
        logCompleted = j["settings"]["logCompleted"].string ?? "immediately"
        groupTodayByList = j["settings"]["groupTodayByList"].bool
        showCalendarEvents = j["settings"]["showCalendarEvents"].exists ? j["settings"]["showCalendarEvents"].bool : true
        calendars = j["settings"]["calendars"].exists ? j["settings"]["calendars"].strings : nil
    }

    func project(_ id: String) -> Project? {
        looseProjects.first { $0.id == id } ?? areas.lazy.flatMap(\.projects).first { $0.id == id }
    }
    func area(_ id: String) -> Area? { areas.first { $0.id == id } }
}

/// Where the sidebar points.
enum Place: Hashable, Sendable, Codable {
    case inbox, today, upcoming, anytime, someday, logbook, trash
    case project(String)
    case area(String)
    /// Quick Find's own lists: tomorrow, deadlines, repeating, projects, logged-projects.
    case extra(String)

    static let lists: [Place] = [.inbox, .today, .upcoming, .anytime, .someday, .logbook, .trash]

    /// A list id as the API names it (Quick Find's answers).
    init?(list id: String) {
        switch id {
        case "inbox": self = .inbox
        case "today": self = .today
        case "upcoming": self = .upcoming
        case "anytime": self = .anytime
        case "someday": self = .someday
        case "logbook": self = .logbook
        case "trash": self = .trash
        case "tomorrow", "deadlines", "repeating", "projects", "logged-projects": self = .extra(id)
        default: return nil
        }
    }

    /// The lists with the tag filter under their title, as the web app's.
    var filters: Bool {
        switch self {
        case .today, .anytime, .upcoming, .project: true
        default: false
        }
    }

    /// The API path that answers it.
    var path: String {
        switch self {
        case .inbox: "/api/lists/inbox"
        case .today: "/api/lists/today"
        case .upcoming: "/api/lists/upcoming"
        case .anytime: "/api/lists/anytime"
        case .someday: "/api/lists/someday"
        case .logbook: "/api/lists/logbook"
        case .trash: "/api/lists/trash"
        case .project(let id): "/api/projects/\(id)"
        case .area(let id): "/api/areas/\(id)"
        case .extra(let id): "/api/lists/\(id)"
        }
    }

    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .today: "Today"
        case .upcoming: "Upcoming"
        case .anytime: "Anytime"
        case .someday: "Someday"
        case .logbook: "Logbook"
        case .trash: "Trash"
        case .extra("tomorrow"): "Tomorrow"
        case .extra("deadlines"): "Deadlines"
        case .extra("repeating"): "Repeating"
        case .extra("projects"): "All Projects"
        case .extra("logged-projects"): "Logged Projects"
        case .project, .area, .extra: ""
        }
    }
}

/// A calendar's event on a day, as the engine gives it (engine/src/events.js):
/// timed, or all day.
struct CalEvent: Hashable, Sendable {
    let date: String
    let allDay: Bool
    let time: String?
    let title: String
    let calendar: String
    let color: String?

    init(_ j: J) {
        date = j["date"].string ?? ""
        allDay = j["allDay"].bool
        time = j["time"].string
        title = j["title"].string ?? ""
        calendar = j["calendar"].string ?? ""
        color = j["color"].string
    }

    static func list(_ j: J) -> [CalEvent] { j.array.map(CalEvent.init) }
}

/// One list's content, as the screens draw it: sections of rows.
struct ListContent: Sendable {
    struct Section: Identifiable, Sendable {
        let id: String
        var title: String?
        var subtitle: String?
        var rows: [Row]
        /// The day's events, under its heading (Upcoming).
        var events: [CalEvent] = []
    }
    enum Row: Identifiable, Hashable, Sendable {
        case todo(Todo)
        case project(Project)
        var id: String {
            switch self {
            case .todo(let t): "t:" + t.id
            case .project(let p): "p:" + p.id
            }
        }
    }

    var sections: [Section] = []
    var notes: String = ""
    /// The day's events, above its to-dos (Today, Tomorrow).
    var events: [CalEvent] = []
    /// Projects with more than one to-do in Today, for the note at its foot.
    var crowded: [(id: String, name: String, count: Int)] = []
    var todoCount: Int { sections.reduce(0) { $0 + $1.rows.filter { if case .todo = $0 { true } else { false } }.count } }
    var allTodos: [Todo] { sections.flatMap { $0.rows.compactMap { if case .todo(let t) = $0 { t } else { nil } } } }
    /// The tags its to-dos have, for the filter's pills.
    var tags: [String] { Array(Set(allTodos.flatMap(\.tags))).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending } }
}
