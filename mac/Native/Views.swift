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
        case .inbox: ("tray.fill", Palette.inbox)
        case .today: ("star.fill", Palette.star)
        case .upcoming: ("calendar", Palette.upcoming)
        case .anytime: ("square.stack.3d.up.fill", Palette.anytime)
        case .someday: ("archivebox.fill", Palette.someday)
        case .logbook: ("checkmark.square.fill", Palette.logbook)
        case .trash: ("trash", Palette.trash)
        case .area: ("shippingbox", Palette.text2)
        case .project: ("circle", Palette.accent)
        }
        Image(systemName: name).font(.system(size: size, weight: .semibold)).foregroundStyle(colour)
    }
}

/// A project's progress: a ring that fills as a pie.
struct ProgressPie: View {
    let progress: Double
    var size: CGFloat = 14
    var colour = Palette.accent

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
