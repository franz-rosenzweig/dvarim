import SwiftUI

// MARK: - the window

struct MainView: View {
    @Bindable var model: AppModel
    @Environment(\.undoManager) private var undoManager
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch model.phase {
            case .starting:
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .signIn(let message):
                SignInView(model: model, message: message)
            case .failed(let message):
                ProblemView(model: model, message: message)
            case .ready:
                NavigationSplitView {
                    Sidebar(model: model)
                        .navigationSplitViewColumnWidth(min: 200, ideal: 236, max: 320)
                } detail: {
                    ListScreen(model: model)
                }
            }
        }
        .frame(minWidth: 720, minHeight: 460)
        .onAppear { model.undoManager = undoManager }
        .onChange(of: undoManager) { _, u in model.undoManager = u }
        .onChange(of: scenePhase) { _, p in if p == .active { model.catchUp() } }
    }
}

struct ProblemView: View {
    let model: AppModel
    let message: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 34)).foregroundStyle(Color.orange)
            Text(message).multilineTextAlignment(.center).frame(maxWidth: 380)
            HStack {
                Button("Try again") { Task { await model.start() } }
                SettingsLink { Text("Settings…") }
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - the sidebar

struct Sidebar: View {
    @Bindable var model: AppModel

    var body: some View {
        List(selection: Binding(get: { model.place }, set: { if let p = $0 { model.place = p } })) {
            Section {
                row(.inbox, count: model.state.inboxCount)
            }
            Section {
                row(.today, count: model.state.todayCount, urgent: model.state.todayDeadlines)
                row(.upcoming)
                row(.anytime)
                row(.someday)
            }
            Section {
                row(.logbook)
                row(.trash)
            }
            if !model.state.looseProjects.isEmpty {
                Section {
                    ForEach(model.state.looseProjects) { p in projectRow(p) }
                }
            }
            ForEach(model.state.areas) { a in
                Section {
                    Label { Text(a.name).fontWeight(.semibold) } icon: {
                        Image(systemName: "shippingbox").foregroundStyle(Color(nsColor: .secondaryLabelColor))
                    }
                    .tag(Place.area(a.id))
                    ForEach(a.projects) { p in projectRow(p) }
                }
            }
        }
        .listStyle(.sidebar)
    }

    private func row(_ place: Place, count: Int = 0, urgent: Int = 0) -> some View {
        Label { Text(place.title) } icon: { ListIcon(place: place) }
            .badge(urgent > 0 ? Text("\(urgent)").foregroundStyle(Color.red) : count > 0 ? Text("\(count)") : nil)
            .tag(place)
    }

    private func projectRow(_ p: Project) -> some View {
        Label { Text(p.name.isEmpty ? "New Project" : p.name) } icon: { ProgressPie(progress: p.progress) }
            .badge(p.openCount > 0 ? Text("\(p.openCount)") : nil)
            .tag(Place.project(p.id))
    }
}

/// The lists' icons, each in its own colour.
struct ListIcon: View {
    let place: Place
    var size: CGFloat = 14

    var body: some View {
        let (name, colour): (String, Color) = switch place {
        case .inbox: ("tray.fill", Color(red: 0.24, green: 0.53, blue: 0.96))
        case .today: ("star.fill", Color(red: 0.98, green: 0.78, blue: 0.13))
        case .upcoming: ("calendar", Color(red: 0.93, green: 0.25, blue: 0.40))
        case .anytime: ("square.stack.3d.up.fill", Color(red: 0.20, green: 0.68, blue: 0.62))
        case .someday: ("archivebox.fill", Color(red: 0.80, green: 0.66, blue: 0.40))
        case .logbook: ("checkmark.square.fill", Color(red: 0.30, green: 0.70, blue: 0.40))
        case .trash: ("trash", Color(nsColor: .secondaryLabelColor))
        case .area: ("shippingbox", Color(nsColor: .secondaryLabelColor))
        case .project: ("circle", Color(red: 0.24, green: 0.53, blue: 0.96))
        }
        Image(systemName: name).font(.system(size: size, weight: .semibold)).foregroundStyle(colour)
    }
}

/// A project's progress: a ring that fills as a pie.
struct ProgressPie: View {
    let progress: Double
    var size: CGFloat = 14
    var colour = Color(red: 0.24, green: 0.53, blue: 0.96)

    var body: some View {
        ZStack {
            Circle().stroke(colour, lineWidth: 1.5)
            PieSlice(progress: progress).fill(colour).padding(2.5)
        }
        .frame(width: size, height: size)
    }
}

struct PieSlice: Shape {
    let progress: Double
    func path(in r: CGRect) -> Path {
        var p = Path()
        guard progress > 0 else { return p }
        let c = CGPoint(x: r.midX, y: r.midY)
        p.move(to: c)
        p.addArc(center: c, radius: r.width / 2, startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * min(progress, 1)), clockwise: false)
        p.closeSubpath()
        return p
    }
}

// MARK: - a list

struct ListScreen: View {
    @Bindable var model: AppModel

    var body: some View {
        List(selection: $model.selection) {
            ListTitle(model: model)
                .listRowSeparator(.hidden)
                .selectionDisabled()
            if !model.content.notes.isEmpty {
                Text(model.content.notes).foregroundStyle(Color(nsColor: .secondaryLabelColor))
                    .listRowSeparator(.hidden).selectionDisabled()
            }
            ForEach(model.content.sections) { section in
                if let title = section.title {
                    SectionTitle(title: title, subtitle: section.subtitle)
                        .listRowSeparator(.hidden).selectionDisabled()
                }
                ForEach(section.rows) { row in
                    switch row {
                    case .todo(let t):
                        TodoRow(model: model, todo: t).tag(row.id)
                    case .project(let p):
                        ProjectRow(project: p).tag(row.id)
                            .onTapGesture(count: 2) { model.place = .project(p.id) }
                    }
                }
                .listRowSeparator(.hidden)
            }
            if model.content.todoCount == 0 && model.content.sections.allSatisfy({ $0.rows.isEmpty }) && !model.loading {
                EmptyList(place: model.place).listRowSeparator(.hidden).selectionDisabled()
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(nsColor: .textBackgroundColor))
        .contextMenu(forSelectionType: String.self) { ids in
            let todos = model.content.allTodos.filter { ids.contains("t:" + $0.id) }
            if !todos.isEmpty {
                Button(todos.allSatisfy(\.isOpen) ? "Complete" : "Reopen") {
                    Task { for t in todos { await model.toggle(t) } }
                }
            }
        } primaryAction: { ids in
            if let id = ids.first, id.hasPrefix("p:") { model.place = .project(String(id.dropFirst(2))) }
        }
        .overlay(alignment: .bottom) { Notice(model: model) }
        .toolbar { ToolbarItem(placement: .automatic) { SyncBadge(sync: model.sync) } }
        .navigationTitle("")
    }
}

struct ListTitle: View {
    let model: AppModel
    var body: some View {
        HStack(spacing: 10) {
            switch model.place {
            case .project(let id):
                ProgressPie(progress: model.state.project(id)?.progress ?? 0, size: 24)
                Text(model.state.project(id)?.name ?? "")
            case .area(let id):
                ListIcon(place: model.place, size: 24)
                Text(model.state.area(id)?.name ?? "")
            default:
                ListIcon(place: model.place, size: 24)
                Text(model.place.title)
            }
        }
        .font(.system(size: 26, weight: .bold))
        .padding(.top, 18)
        .padding(.bottom, 8)
    }
}

struct SectionTitle: View {
    let title: String
    let subtitle: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title).font(.system(size: 14, weight: .bold))
                if let subtitle { Text(subtitle).font(.system(size: 12)).foregroundStyle(Color(nsColor: .secondaryLabelColor)) }
            }
            Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: 1)
        }
        .padding(.top, 14)
    }
}

struct EmptyList: View {
    let place: Place
    var body: some View {
        Text(place == .today ? "Nothing for today." : "Nothing here.")
            .foregroundStyle(Color(nsColor: .tertiaryLabelColor))
            .frame(maxWidth: .infinity)
            .padding(.top, 60)
    }
}

/// A to-do's row: its box, its title, and what it carries beside it.
struct TodoRow: View {
    let model: AppModel
    let todo: Todo

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            CheckBox(done: !todo.isOpen, canceled: todo.status == "canceled") { Task { await model.toggle(todo) } }
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(todo.title.isEmpty ? "New To-Do" : todo.title)
                        .foregroundStyle(todo.isOpen ? Color(nsColor: .labelColor) : Color(nsColor: .secondaryLabelColor))
                        .strikethrough(todo.status == "canceled")
                    if !todo.notes.isEmpty { Image(systemName: "doc.text").font(.system(size: 10)).foregroundStyle(Color(nsColor: .tertiaryLabelColor)) }
                    if !todo.checklist.isEmpty { Image(systemName: "list.bullet").font(.system(size: 10)).foregroundStyle(Color(nsColor: .tertiaryLabelColor)) }
                    if todo.repeatRule != nil { Image(systemName: "repeat").font(.system(size: 10)).foregroundStyle(Color(nsColor: .tertiaryLabelColor)) }
                    ForEach(todo.tags, id: \.self) { TagChip(name: $0) }
                }
                if let context = contextLine {
                    Text(context).font(.system(size: 11)).foregroundStyle(Color(nsColor: .secondaryLabelColor))
                }
            }
            Spacer(minLength: 8)
            if let when = whenLabel {
                Text(when).font(.system(size: 11, weight: .medium)).foregroundStyle(Color(nsColor: .secondaryLabelColor))
            }
            if let d = todo.deadline, todo.isOpen {
                Label(Dates.deadline(d, today: model.state.today), systemImage: "flag.fill")
                    .labelStyle(.titleAndIcon)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(d <= model.state.today ? Color.red : Color(nsColor: .secondaryLabelColor))
            }
        }
        .padding(.vertical, 3)
    }

    /// The project (or area) it belongs to, where the list mixes them.
    private var contextLine: String? {
        switch model.place {
        case .today, .upcoming, .anytime, .someday, .logbook, .trash, .inbox:
            return todo.projectName ?? todo.areaName
        default:
            return nil
        }
    }

    /// Its start date, where the list does not already say it.
    private var whenLabel: String? {
        guard let w = todo.when, todo.isOpen else { return nil }
        switch model.place {
        case .today, .upcoming: return nil
        default: return Dates.short(w, today: model.state.today)
        }
    }
}

struct ProjectRow: View {
    let project: Project
    var body: some View {
        HStack(spacing: 9) {
            ProgressPie(progress: project.progress)
            Text(project.name.isEmpty ? "New Project" : project.name).fontWeight(.semibold)
            Spacer()
        }
        .padding(.vertical, 3)
    }
}

struct CheckBox: View {
    let done: Bool
    var canceled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                RoundedRectangle(cornerRadius: 3.5)
                    .strokeBorder(done ? Color.clear : Color(nsColor: .tertiaryLabelColor), lineWidth: 1.2)
                    .background(RoundedRectangle(cornerRadius: 3.5).fill(done ? Color(red: 0.24, green: 0.53, blue: 0.96) : Color.clear))
                if done {
                    Image(systemName: canceled ? "xmark" : "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Color.white)
                }
            }
            .frame(width: 14, height: 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(done ? "Reopen" : "Complete")
    }
}

struct TagChip: View {
    let name: String
    var body: some View {
        Text(name)
            .font(.system(size: 10.5))
            .padding(.horizontal, 6).padding(.vertical, 1)
            .foregroundStyle(Color(nsColor: .secondaryLabelColor))
            .overlay(Capsule().strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
    }
}

/// What was just done, with Undo, at the foot of the window.
struct Notice: View {
    @Bindable var model: AppModel
    @State private var hide: Task<Void, Never>?

    var body: some View {
        if let text = model.notice {
            HStack(spacing: 12) {
                Text(text).lineLimit(1)
                if model.undoManager?.canUndo == true {
                    Button("Undo") { model.undoManager?.undo(); model.notice = nil }.buttonStyle(.borderless)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .glassEffect(.regular, in: Capsule())
            .padding(.bottom, 14)
            .onAppear { schedule() }
            .onChange(of: text) { _, _ in schedule() }
        }
    }

    private func schedule() {
        hide?.cancel()
        hide = Task { try? await Task.sleep(nanoseconds: 4_000_000_000); if !Task.isCancelled { model.notice = nil } }
    }
}

struct SyncBadge: View {
    let sync: SyncState
    var body: some View {
        switch sync.kind {
        case .off: EmptyView()
        case .syncing: Label("Syncing", systemImage: "arrow.triangle.2.circlepath").labelStyle(.iconOnly).help("Syncing with the server")
        case .idle: Label("Synced", systemImage: "checkmark.icloud").labelStyle(.iconOnly).help(sync.at.map { "Synced \($0.formatted(.relative(presentation: .named)))" } ?? "Synced")
        case .error:
            Label(sync.offline ? "Offline" : "Sync problem", systemImage: sync.offline ? "icloud.slash" : "exclamationmark.icloud")
                .labelStyle(.iconOnly)
                .help(sync.offline ? "Offline: everything still works here, and syncs when the server is back." : (sync.error ?? "The sync had a problem."))
        }
    }
}

// MARK: - signing in

struct SignInView: View {
    let model: AppModel
    let message: String?
    @State private var server = Prefs.server.absoluteString
    @State private var name = ""
    @State private var password = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Sign in to your Dvarim server").font(.system(size: 20, weight: .bold))
            Text(Mode.current == .copy
                 ? "Dvarim keeps a copy of your to-dos on this Mac and syncs it with your server, so it works offline too."
                 : "Dvarim asks your server for every list.")
                .foregroundStyle(Color(nsColor: .secondaryLabelColor))
                .fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("Server", text: $server)
                TextField("Name", text: $name, prompt: Text("Leave empty if it's your server"))
                SecureField("Password", text: $password)
            }
            .formStyle(.columns)
            if let message { Text(message).foregroundStyle(Color.red) }
            HStack {
                SettingsLink { Text("Other ways to keep your to-dos…") }.buttonStyle(.link)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Sign in") { go() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(password.isEmpty || busy)
            }
        }
        .padding(28)
        .frame(width: 440)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func go() {
        let s = server.trimmingCharacters(in: .whitespaces)
        if !s.isEmpty && s != Prefs.server.absoluteString { Prefs.store.set(s, forKey: Prefs.serverKey) }
        busy = true
        Task {
            await model.signIn(password: password, name: name.trimmingCharacters(in: .whitespaces))
            password = ""
            busy = false
        }
    }
}

// MARK: - Settings

struct SettingsView: View {
    @Bindable var model: AppModel
    @State private var mode = Mode.current
    @State private var server = Prefs.server.absoluteString
    @State private var folder = Prefs.store.string(forKey: Prefs.folderKey) ?? ""
    @State private var signOutMessage: String?

    var body: some View {
        Form {
            Section("Where your to-dos live") {
                Picker("", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()
                .onChange(of: mode) { _, m in Task { await model.switchMode(m) } }
                if mode == .folder {
                    HStack {
                        Text(folder.isEmpty ? "No folder chosen" : (folder as NSString).abbreviatingWithTildeInPath)
                            .lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Button("Choose…") { choose() }
                    }
                }
                if mode == .copy, let copy = Account.copy {
                    Text("Kept here and synced as “\(copy.device)”. It opens and works with no network, and catches up when there is one.")
                        .font(.caption).foregroundStyle(Color(nsColor: .secondaryLabelColor))
                }
            }
            Section("Server") {
                TextField("Address", text: $server)
                    .onSubmit {
                        Prefs.store.set(server.trimmingCharacters(in: .whitespaces), forKey: Prefs.serverKey)
                        Task { await model.start() }
                    }
                if let p = model.person {
                    HStack {
                        Text("Signed in" + (p.owner ? "" : " as \(p.name ?? "")"))
                        Spacer()
                        Button("Sign out") { Task { signOutMessage = await model.signOut() } }
                    }
                    if let signOutMessage { Text(signOutMessage).font(.caption).foregroundStyle(Color.red) }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .padding(.vertical, 8)
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Use This Folder"
        panel.message = "Choose the folder your to-dos live in: the Tasks folder in your vault, or any folder Syncthing or iCloud Drive keeps in step."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        folder = url.path
        Prefs.store.set(url.path, forKey: Prefs.folderKey)
        Task { await model.start() }
    }
}
