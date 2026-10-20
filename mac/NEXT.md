# Next on the Mac: the app on a folder (phase 3)

For the Claude session that builds the macOS shell. Written on morten, where
there is no Xcode. Everything that could be built and tested there has been.
This is the part that needs a Mac. The protocol is in `docs/BRIDGE.md`; read
that first. The plan as a whole is in `docs/ROADMAP.md`.

## What exists already

- **The page's half of the bridge** (`engine/src/storage-bridge.js`,
  `frontend/src/lib/backend.js`):
  - When the page finds `window.webkit.messageHandlers.dvarimStorage`, it runs
    on the engine and keeps its to-dos in whatever folder the handler answers
    for.
  - It rescans when `window.__dvarimFilesChanged()` is called, and whenever the
    window comes to the front.
  - It shows a failed save as *Not saved — …*.
  - Settings → Data names the folder and offers **Choose another folder…**,
    **Use a server instead…** and **Check this folder**.
- **The proof** (`tools/e2e_folder.py`):
  - It drives the real page in Chrome, with the bridge pointing at
    `tools/bridge_sim.py` on a real folder.
  - All checks pass, as the Mac and as Android. That covers: to-dos in and out
    of the files, Obsidian-style edits noticed, the Settings buttons, the
    conformance checks, a failed save reported, and the server's files never
    touched.
- **Drafts of the Swift you need**, in `mac/next/`. None of it has been
  compiled; it sits outside `Dvarim/` so `build.sh` does not pick it up until
  you move it.

  | file | what |
  | --- | --- |
  | `Vault.swift` | the mode (server / folder), the folder, `NSOpenPanel`, the page's URL in each mode |
  | `AppScheme.swift` | `WKURLSchemeHandler` serving the bundled web app at `dvarim-app://app/` |
  | `FolderBridge.swift` | the `dvarimStorage` handler over `FileManager`, on a serial queue, plus FSEvents |

## The steps

Work on a branch from master once #54, #56 and this phase's PR are merged. If
they are not merged yet, branch from `device-folders`.

1. **Build the web app** once: `cd frontend && npm ci && npm run build`. That
   makes `frontend/dist/`. It needs Node, which the Android build already needs.

2. **Bundle it.** Add this to `build.sh`, after the Info.plist step:

   ```zsh
   # The web app, served from inside the app in folder mode (AppScheme.swift).
   WEB=../frontend/dist
   if [[ -f $WEB/index.html ]]; then
       rm -rf $APP/Contents/Resources/web && cp -R $WEB $APP/Contents/Resources/web
   else
       echo "no web build: folder mode will be unavailable (cd ../frontend && npm ci && npm run build)" >&2
   fi
   ```

   `Vault.usesFolder` is false without `Resources/web`, so a build without it
   still works exactly as today.

3. **Move `mac/next/*.swift` into `Dvarim/`** and get them compiling. Fix
   whatever the compiler says; the drafts were written blind. Keep the
   behaviour described in `docs/BRIDGE.md`, section 2.

4. **Wire them into `WebView.swift`.** In `makeNSView`, before the view is made:

   ```swift
   if Vault.usesFolder, let folder = Vault.folder, let web = Vault.webBundle {
       config.setURLSchemeHandler(AppScheme(root: web), forURLScheme: AppScheme.scheme)
       let bridge = FolderBridge(root: folder)
       config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "dvarimStorage")
       context.coordinator.bridge = bridge
   }
   ```

   After `let view = ShellWebView(...)`:

   ```swift
   context.coordinator.bridge?.webView = view
   context.coordinator.bridge?.startWatching()
   ```

   Also:
   - Add `var bridge: FolderBridge?` to `Coordinator`.
   - Add a `static func dismantleNSView` that calls `stopWatching()` and
     `removeAllScriptMessageHandlers()`.
   - In the coordinator, **`isServer(_:)` becomes "is this our own page"**:
     `url.scheme == AppScheme.scheme` counts as well as the server's
     host/port. Otherwise every in-app link opens in Safari.
   - `go(_:)` uses `Vault.url(for:)`.

5. **Use the right address.** In `ContentView`:
   - `WebView(url: Vault.url(for: target?.path ?? "/"), …)`.
   - Put the mode and folder into `.id(...)`, so switching rebuilds the view:
     `@AppStorage(Vault.modeKey)` and `@AppStorage(Vault.folderKey)`.

   `Vault.useFolder` and `Vault.useServer` post `.dvarimReload` already.

6. **Settings → "Where your to-dos live"**, in `SettingsView`:
   - two choices, *On the server* and *In a folder on this Mac*;
   - under the second, the folder's path and a **Choose…** button
     (`Vault.chooseFolder()` → `Vault.useFolder`).

   The page's own Settings → Data can do the same through the bridge. This is
   for when there is no page to ask.

7. **What stays on the server.** Leave the badge, the menu bar, Quick Entry,
   reminders and the Services item on `Client`/`Defaults.server` as they are.
   - Nathan keeps his server, so they go on working: the server writes the
     vault, Syncthing brings the change to the folder, and FSEvents tells the
     page.
   - With no server they fail as they do offline today.
   - Phase 6 moves them to the folder through `window.dvarim.request(...)`.
     Nothing needs doing for that now.

8. **A selftest section**, `./selftest.sh URL folder`:
   - point `Vault` at a fresh copy of `sample-vault` in a temp folder;
   - open a window and wait for `.nav`;
   - run the checks and assert `ok`:
     ```swift
     let r = try await webView.callAsyncJavaScript(
         "return await window.__dvarimLocal.conformance()", contentWorld: .page) as? [String: Any]
     ```
   - append `- [ ] From the selftest` to `Inbox.md` on disk, and check that the
     row appears within 2 s (FSEvents → `__dvarimFilesChanged`);
   - make a to-do through `window.dvarim.request('POST', '/api/todos', {title, inbox: true})`
     and check that it lands in `Inbox.md`.

## Done when

Done on the Mac, 2026-09-23 (branch `mac-folder`, on `device-folders`):

- [x] `./build.sh` with and without `frontend/dist` both build, and without it
      the app is exactly today's (it says why folder mode is unavailable).
- [x] Folder mode on a **copy** of the vault: the conformance checks all pass,
      17 in 213 ms on a copy of the real Tasks folder (140–160 ms on
      `sample-vault`). On the same copy, the page's engine and the Python server
      agree about the state and every list (`-SelfTestCompare YES`).
- [x] A box ticked in the app is `[x]` with its ✅ date in the file.
- [x] A line written into a file is in the app within a second or two, with no
      click — appended in place, and saved the way Syncthing and Obsidian save
      (a temporary file renamed over it).
- [x] Reload (⌃⌘R) on a project stays on that project. A new window opens on
      the folder too. Links: `isServer` became `isOurs`, so a link off the app
      still goes to the browser; not driven by the self-test, which would open
      one.
- [x] **Use a server instead…** in the page brings back the server, and it is
      saved, so a relaunch remembers.
- [x] `./selftest.sh URL folder` passes, and the other sections still do.

What the drafts needed, beyond compiling:

- **Names.** Foundation decomposes a name when it creates a file (`Café.md`
  landed on disk as `Cafe` + U+0301), and `standardizedFileURL` decomposes one
  on the way out, so the conformance check failed on *names are kept exactly
  as they were written*. `FolderFiles` now creates through `rename(2)` and
  `mkdir(2)` and lists with `enumerator(atPath:)`; `docs/BRIDGE.md` says so.
- **Swift 6.** The FSEvents stream is stopped in an `isolated deinit` (it holds
  an unretained pointer to the bridge), and a message's arguments and its reply
  cross to and from the bridge's queue in a `Plist` box.
- **`window.dvarim.request`** answers `{status, body}`; step 8's check reads
  `body`.
- `Windows.show` (reminders, Services, intents) opens paths through
  `Vault.url(for:)`, like everything else.

And one in the engine, which the Mac found first because FSEvents reports the
app's own saves: **a scan that was reading while the store wrote put back what
it had read.** A to-do made during the reads vanished (a 404 on the next
action, about one self-test run in five), and the next change to its file
wrote the old text back over it. `Store.scanChanges` now counts the store's
writes and reads again when any happened meanwhile; a test in
`engine/test/engine.test.js` holds a read open to show it.

## Conflict copies, since phase 4

Phase 4 (#60) landed before this did. Two copies of the same file edited at
nearly the same time — the Mac folder and the server on morten, with
Syncthing between them — leave `Inbox.sync-conflict-….md`. The app on a folder
merges it back into its file, to-do by to-do, and moves the copy to
`.dvarim/conflicts/`, never deleting it (`docs/SYNC.md`) — and so does the server
on morten, which runs on the engine since #63. The two the real Tasks folder had
from 2026-09-20 had left it by the evening of the cutover.

## Phase 5: built-in sync

**Done on the Mac, 2026-09-23.** The device check is `./selftest.sh … sync`, against
a server of its own on a copy of `sample-vault/` (the new, empty folder; a wrong
token; the vault arriving byte for byte; a change each way; offline and back;
a revoked token), run once with the page making the requests and once through
the `http` op, which the app now offers (`ShellHTTP.swift`). What is left is
the same check by hand against dvarim.tiresia.xyz, with a token only Nathan
makes, and moving the token to the Keychain. The brief, as written:

The page can now sync its vault by itself with a WebDAV folder (`docs/SYNC.md`,
"Built-in sync"). On the Mac that is the app in the folder mode,
on a folder no other tool syncs, and Settings → Sync → *A Dvarim server*.

**Nothing native is needed to sync with a Dvarim server.** The page makes the
requests, and the server answers pages from other origins. Please check it on
the device:

1. Put the app in the folder mode on a new, empty folder: not the Syncthing vault,
   which already has a sync.
2. On dvarim.tiresia.xyz, Settings → Sync → *Add a device*, named for this
   device. On the device, Settings → Sync → *A Dvarim server*, with
   `dvarim.tiresia.xyz` and the token. *Save and sync.*
3. The vault arrives. A to-do made on the device shows in the web app within
   seconds. One made in the web app arrives when the device's window comes to
   the front, or on *Sync now*.
4. Offline: make a change, go back online, and it goes.
5. Remove the device on the server: the next sync says the token is not
   accepted.

**Optional: the `http` op** (`docs/BRIDGE.md`), for WebDAV servers that
answer no page from another origin (Nextcloud, most others). In FolderBridge.swift:
URLSession with an ephemeral configuration (no cookies, no cache), redirects refused in the delegate, a 30 s timeout. Only `https:`, and `http:` to private or tailnet addresses. Then set
`http: true` in the `info` reply. The page uses it from then on for every sync
request.

**Later (phase 6):** the token and passwords now sit in the page's own
storage. The Keychain is the right home for them.

## Phase 6: the device's own calendars, reminders and widgets

**Done on the Mac, 2026-09-23.** Calendars from EventKit (`DeviceCalendars.swift`;
macOS asks the first time). The badge, the menu bar, Quick Entry, reminders,
the Services item and the intents ask the folder's page (`LocalPage.swift`):
a window's, or with none open one the app keeps hidden, which also goes on
watching the folder and syncing. Op `changed` makes them ask again at once.
The Mac has no widget. Checked by `./selftest.sh … calendars,local`. The brief,
as written:

For the app on a folder, the things the server did must come from the Mac.

**Calendars.** Everything on the page is done. A shell that answers the
bridge's `calendars` and `events` ops (`docs/BRIDGE.md`), and says
`calendars: true` in `info`, gets the device's events in Today and Upcoming.
Settings → Calendar then lists the device's calendars to choose from.
`tools/bridge_sim.py --calendars FILE` is the reference, and `tools/e2e_folder.py`
checks the page with it. For the shell: `EKEventStore`: `requestFullAccessToEvents` (macOS 14) the first time, `calendars(for: .event)`, and `predicateForEvents(withStart:end:calendars:)` for the occurrences. Format the dates in the current time zone. It needs the `NSCalendarsFullAccessUsageDescription` key in Info.plist, and the calendars entitlement for the sandbox.

**Reminders.** In folder mode nobody sends the Signal reminder. The shell
already schedules its own notifications from the server's lists. On a folder
it can ask the page for the same lists instead, with `window.dvarim.request('GET',
'/api/lists/upcoming')` and `…/today`, which the engine answers from the
folder. Schedule each open to-do that has ⏰ on its When day, and schedule
again whenever the page says the vault changed: say `changes: true` in `info`,
and the page sends op `changed` a second after every change (`docs/BRIDGE.md`).

**Widgets and Quick Entry.** The same: `window.dvarim.request` answers every API
route from the folder while the page is loaded. For a widget that must work
while the app is closed, keep the last answer on disk after each change and
show that.

