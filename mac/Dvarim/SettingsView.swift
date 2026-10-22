import SwiftUI

struct SettingsView: View {
    @AppStorage(Defaults.serverKey) private var server = Defaults.defaultServer
    @AppStorage(Vault.modeKey) private var mode = Vault.copyMode
    @AppStorage(Vault.folderKey) private var folder = ""
    @AppStorage(Defaults.hotkeyEnabledKey) private var hotkey = true
    @AppStorage(Defaults.menuBarKey) private var menuBar = true
    @AppStorage(Defaults.notificationsKey) private var reminders = true
    @State private var shortcut = Shortcut.current
    @State private var probe: String?
    @State private var hotkeyNote: String?
    @State private var reminderProblem: String?
    @State private var loginItem = false
    @State private var loginItemNote: String?

    var body: some View {
        Form {
            // The page's own Settings → Data can switch too; this is the way in
            // when there is no page to ask, and the first time.
            Section {
                Picker("", selection: Binding(get: { mode }, set: choose)) {
                    Text("On this Mac, synced with the server").tag(Vault.copyMode)
                    Text("On the server only").tag("server")
                    Text("In a folder on this Mac").tag("folder")
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()
                if mode == Vault.copyMode {
                    if Vault.webBundle == nil {
                        Text("This build of Dvarim has no copy of the web app inside it, so it opens the server instead. Build it with frontend/dist in place.")
                            .font(.caption).foregroundStyle(.orange)
                    } else if let copy = AppCopy.current {
                        Text("Kept here and synced as “\(copy.device)”. Dvarim opens and works with no network, and catches up when there is one.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Sign in once in a Dvarim window, and Dvarim keeps a copy here from then on.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if mode == "folder" {
                    HStack {
                        Text(folder.isEmpty ? "No folder chosen" : (folder as NSString).abbreviatingWithTildeInPath)
                            .lineLimit(1).truncationMode(.middle)
                            .foregroundStyle(folder.isEmpty ? .secondary : .primary)
                        Spacer()
                        Button("Choose…") { pickFolder() }
                    }
                    if Vault.webBundle == nil {
                        Text("This build of Dvarim has no copy of the web app inside it, so it opens the server instead. Build it with frontend/dist in place.")
                            .font(.caption).foregroundStyle(.orange)
                    } else if !folder.isEmpty && Vault.folder == nil {
                        Text("That folder is not there any more, so Dvarim opens the server instead. Choose it again, or another.")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }
            } header: {
                Text("Where your to-dos live")
            } footer: {
                Text("A folder of Markdown is the Tasks folder in your vault, or any folder Syncthing or iCloud Drive keeps in step: Dvarim reads it and writes it, and needs no server.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                TextField("Server", text: $server, prompt: Text(Defaults.defaultServer))
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Button("Test") { test() }
                    if let probe { Text(probe).font(.caption).foregroundStyle(.secondary) }
                }
            } header: {
                Text("Server")
            } footer: {
                Text(verbatim: "The public address, or the server's address on your tailnet or local network. Sign in once in a Dvarim window: the badge, reminders and Quick Entry use that login — and go on using the server with your to-dos in a folder.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Shell") {
                HStack {
                    Toggle("Quick Entry from any app", isOn: $hotkey)
                    Spacer()
                    ShortcutRecorder(shortcut: $shortcut)
                        .disabled(!hotkey)
                }
                .onChange(of: hotkey) { _, _ in applyHotkey() }
                .onChange(of: shortcut) { _, _ in applyHotkey() }
                if let hotkeyNote {
                    Text(hotkeyNote).font(.caption).foregroundStyle(.orange)
                }

                Toggle("Show Today in the menu bar", isOn: $menuBar)

                Toggle("Open Dvarim at login", isOn: $loginItem)
                    .onChange(of: loginItem) { _, on in
                        loginItemNote = LoginItem.set(on)
                        loginItem = LoginItem.isOn
                    }
                if let loginItemNote {
                    Text(loginItemNote).font(.caption).foregroundStyle(.orange)
                }

                Toggle("Notify me here when a reminder is due", isOn: $reminders)
                    .onChange(of: reminders) { _, _ in Task { await ReminderScheduler.shared.sync() } }
                if reminders, let reminderProblem {
                    Text(reminderProblem).font(.caption).foregroundStyle(.orange)
                }
                Text("Signal can send the same reminders; leave one on, not both. The Dock badge follows the web app's Settings → Badge count.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .padding(.vertical, 8)
        .onAppear {
            checkHotkey()
            loginItem = LoginItem.isOn
        }
        .task { reminderProblem = await ReminderScheduler.shared.problem }
    }

    /// The mode, as the three choices above set it. A folder with none chosen
    /// yet asks for one, and stays where it was if the picker is cancelled.
    private func choose(_ choice: String) {
        if choice == Vault.copyMode {
            if mode != Vault.copyMode { Vault.useCopy() }
        } else if choice == "server" {
            if mode != "server" { Vault.useServer() }
        } else if let path = Vault.folderPath {
            Vault.useFolder(URL(fileURLWithPath: path, isDirectory: true))
        } else {
            pickFolder()
        }
    }

    private func pickFolder() {
        if let chosen = Vault.chooseFolder() { Vault.useFolder(chosen) }
    }

    private func applyHotkey() {
        if hotkey {
            GlobalHotKey.shared.register(shortcut) { QuickEntryController.shared.toggle() }
        } else {
            GlobalHotKey.shared.unregister()
        }
        checkHotkey()
    }

    private func checkHotkey() {
        if !hotkey {
            hotkeyNote = nil
        } else if !GlobalHotKey.shared.isRegistered {
            hotkeyNote = "Another app holds \(shortcut.display). Record a different chord, or turn it off there."
        } else if GlobalHotKey.systemUses(shortcut) {
            hotkeyNote = "macOS uses \(shortcut.display) itself and gets it first — record a different chord, or turn that one off in System Settings → Keyboard → Keyboard Shortcuts."
        } else {
            hotkeyNote = nil
        }
    }

    private func test() {
        probe = "checking…"
        Task {
            do {
                let client = Client(base: Defaults.server)
                let auth = try await client.auth()
                guard !auth.required || auth.authenticated else {
                    probe = "reached it — not signed in yet: sign in in a Dvarim window"
                    return
                }
                let s = try await client.state()
                probe = "reached it — \(s.counts.today) in Today, \(s.counts.inbox) in Inbox"
            } catch {
                probe = error.localizedDescription
            }
        }
    }
}
