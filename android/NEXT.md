# Next on Android: the app on a folder (phase 3)

For the Claude session that builds the Android shell. Written on morten, where
there is no Android SDK. Everything that could be built and tested there has
been. This is the part that needs the SDK and a phone. The protocol is in
`docs/BRIDGE.md`; read that first. The plan as a whole is in `docs/ROADMAP.md`.

## What exists already

- **The page's half of the bridge** (`engine/src/storage-bridge.js`,
  `frontend/src/lib/backend.js`):
  - When the page finds `window.DvarimStorage` with `request(id, json)`, it
    runs on the engine and keeps its to-dos in the folder that interface
    answers for. Replies come back through `window.__dvarimStorageReply(id, json)`,
    in any order.
  - It rescans on `window.__dvarimFilesChanged()`, when the window comes to
    the front, and every `pollSeconds` while in front.
  - It shows a failed save as *Not saved — …*.
  - Settings → Data names the folder and offers **Choose another folder…**,
    **Use a server instead…** and **Check this folder**.
- **The proof** (`tools/e2e_folder.py`): it drives the real page in Chrome with
  exactly this interface, replying out of order, over a real folder through
  `tools/bridge_sim.py`. All checks pass.
- **Drafts of the Java you need**, in `android/next/`. None of it has been
  compiled; it sits outside `shell/src` so `apply.sh` does not copy it until
  you move it.

  | file | what |
  | --- | --- |
  | `Folder.java` | the mode (server / folder), the SAF tree URI and its persisted grant, the folder's name for Settings |
  | `FolderActivity.java` | a plain WebView (like `DevActivity`) serving `assets/web/` at `https://appassets.androidplatform.net/`, with `FolderBridge` as `DvarimStorage`; the folder picker; back; resume → rescan |
  | `FolderBridge.java` | every op of the protocol over `DocumentsContract`, on a single-thread executor |

## Why not the TWA

In folder mode the app cannot be the Trusted Web Activity. Chrome draws a TWA,
and a page drawn by Chrome cannot be given a JavaScript interface or served
from the APK. Neither can android-browser-helper's `WebViewFallbackActivity`.

So in folder mode the launcher hands over to `FolderActivity` instead. Server
mode stays exactly as it is: the TWA, or the WebView fallback for other
servers.

## The steps

Work on a branch from master once #54, #56 and this phase's PR are merged. If
they are not merged yet, branch from `device-folders`.

1. **Build the web app**: `cd frontend && npm ci && npm run build`. That makes
   `frontend/dist/`.

2. **`apply.sh` copies it into the APK.** Next to the other `cp -R` lines:

   ```zsh
   # The web app, served from inside the APK in folder mode (FolderActivity).
   if [[ -f ../frontend/dist/index.html ]]; then
       rm -rf app/src/main/assets/web && mkdir -p app/src/main/assets
       cp -R ../frontend/dist app/src/main/assets/web
   else
       echo "no web build: folder mode will be unavailable (cd frontend && npm ci && npm run build)"
   fi
   ```

   Without it, `Folder.isOn` is false and the app is exactly today's.

3. **Move `android/next/*.java` into
   `shell/src/java/xyz/tiresia/dvarim/`**, run `./shell/apply.sh`, and get
   it compiling. Fix whatever the compiler says; the drafts were written blind.
   Keep the behaviour in `docs/BRIDGE.md`, section 2.
   - No new dependencies: `DocumentsContract` and `WebView` are framework.
   - Folder mode needs API 24 (`moveDocument`). `Folder.isOn` already says no
     below that.

4. **Declare the activity** in `shell/manifest-additions.xml`:

   ```xml
   <activity android:name=".FolderActivity"
       android:theme="@style/Theme.Dvarim"
       android:exported="false"
       android:launchMode="singleTask"
       android:configChanges="orientation|screenSize|screenLayout|keyboardHidden" />
   ```

   Leave `uiMode` out of `configChanges`, so a change to dark mode recreates it
   and the page follows (see `Theme.Dvarim` in the README).

5. **The launcher hands over in folder mode.** In `apply.sh`'s
   `custom_server`, start the generated `launchTwa()` override with:

   ```java
   if (Folder.isOn(this)) {
       startActivity(new android.content.Intent(this, FolderActivity.class).setData(getLaunchingUrl()));
       finish();
       return;
   }
   ```

   Change the idempotence check too, so that an already-patched launcher is
   patched again for this. The shortcuts (Today, Inbox, New To-Do) arrive as
   paths, and `FolderActivity.startPath` keeps them.

6. **Share and the tile.**
   - `ShareActivity` builds `/share?…` on the server. In folder mode, open
     `FolderActivity` with `ORIGIN + "/share?…"` instead.
   - `NewTodoTile` opens `/new`. Send it the same way.

7. **Settings.** Add a "Where your to-dos live" row to `SettingsActivity`:
   - *On the server* / *In a folder on this phone*;
   - under the second, the folder's name (`Folder.name`) and **Choose…**
     (`ACTION_OPEN_DOCUMENT_TREE` → `Folder.use`).

   This is the way in when there is no page to ask, and the first time.

8. **What stays on the server.** Leave the widget, reminders, the tile's
   network calls and `Outbox` on `Server`/`Api` as they are. With Nathan's
   server they go on working, because the server's changes reach the phone's
   folder through Syncthing. Phase 6 moves them to local data.

## Done when

Done on the phone, 2026-09-23 (branch `android-folder`), with
`tools/phone/folder_check.py` — 25 checks, all passing, twice in a row — and
a copy of the vault's Tasks folder made on the phone itself:

- [x] Settings → choose that folder (through Android's own picker, driven by a
      finger). The app opens on it, with no browser bar, and the Inbox matches
      `Inbox.md`.
- [x] Settings → Data → **Check this folder**: all 17 checks pass, including
      *names are kept exactly as they were written*. SAF is slow: 12–23 s on
      `sample-vault`, 25.6 s on a copy of the real Tasks folder (52 notes),
      where a rescan takes about 0.55 s (0.2 s on `sample-vault`). On that
      copy the page's engine and the Python server agree about the state and
      every list.
- [x] Tick a box: it is `[x]` with its ✅ date in the file.
- [x] A line written into a file from outside (as Syncthing would): on screen
      within the 15 s poll while open, and at once on coming back to the app.
- [x] A folder the app has lost access to: the next launch is the server, and
      Settings says so and offers to choose it again. (Simulated by pointing
      the saved choice at a tree with no grant, which is the same check
      `Folder.tree` makes; a grant revoked while the app is open answers
      `EACCES` from the bridge, which is not exercised.)
- [x] Rotate: the page and its list survive. Back: from a list it brings out
      the drawer, from the drawer it leaves the app.
- [x] The page's "open the app's own settings" link opens `SettingsActivity`.
      A link off the app goes to the browser by the same `shouldOverrideUrlLoading`;
      not driven by the check, which would open one.
- [x] **Use a server instead…** brings the server back, and a relaunch
      remembers. Choosing the folder again needs no picker: the grant is kept.
- [x] A share and New To-Do (the tile, the launcher's menu) arrive in folder
      mode through the hand-over, and the share lands in `Inbox.md`.
- [x] Server mode, untouched: every other check in `tools/phone` passes.

What the drafts needed, beyond compiling (they compiled as written):

- **Back.** From targetSdk 36 the system keeps Back unless an activity opts
  out, so `FolderActivity` needs `android:enableOnBackInvokedCallback="false"`
  like the others, or every Back closed the app. And then not
  `WebView.canGoBack()`: Chromium skips, on Back, an entry a page added before
  anyone touched it, so straight after opening it said there was nowhere to
  go, and later it went back across whole page loads (a share, New To-Do).
  `onBackPressed` asks the page instead — `history.state.depth`, which
  `lib/backstack.svelte.js` keeps — and calls `history.back()` itself.
- **Relaunching on the server** from `FolderActivity` is a new task, as the
  launcher does it: without one, android-browser-helper's `LauncherActivity`
  restarted itself in a task that `finish()` took down, and *Use a server
  instead…* left the home screen.
- `BuildConfig.DEBUG` went: `DevBuild` already opens a test build's WebViews to
  DevTools. `setDatabaseEnabled` went too (WebSQL; the page uses IndexedDB).
- The launcher's hand-over is its own patch in `apply.sh` (`folder_handoff`),
  in front of `custom_server`'s `launchTwa`, rather than a change to that one.
- `Folder` gained `wanted`, `chosen`, `granted` and `useChosen`, for Settings,
  which shows the folder chosen last in either mode and goes back to it
  without the picker while its grant holds.

## Two things to know

- **Writes are not atomic on SAF.** There is no rename-over, so a file is
  rewritten in place and its size checked afterwards. A short write is
  reported, never trusted. If SAF turns out slow or unreliable on the phone,
  the roadmap's other road for Android is syncing with morten directly
  (phase 5), with the folder in app storage, where it is fast and atomic.
- **Conflict copies, since phase 4 (#60).** Two copies of one file edited at
  nearly the same time leave Syncthing's `.sync-conflict-…` file. The app on a
  folder merges it back into its file, to-do by to-do, and moves the copy to
  `.dvarim/conflicts/`, never deleting it (`docs/SYNC.md`) — and so does the
  server on morten, which runs on the engine since #63. The two the real Tasks
  folder had from 2026-09-20 had left it by the evening of the cutover.

## Phase 5: built-in sync

**Done on Android, 2026-09-23.** `tools/phone/local_check.py` runs the device
check on a phone:
- a Dvarim server on the Mac, on a copy of `sample-vault/`, reached through
  `adb reverse`;
- a new, empty folder, chosen through the picker;
- a wrong token; the vault arriving byte for byte; a change each way; offline
  and back; a revoked token.

The requests go through the `http` op, which the app now offers (`ShellHttp`,
on OkHttp, since `HttpURLConnection` refuses PROPFIND and MKCOL). Still to do:
- the same check by hand against dvarim.tiresia.xyz, with a token only Nathan
  makes;
- the token in the Keystore.

The brief, as written:

The page can now sync its vault by itself with a WebDAV folder (`docs/SYNC.md`,
"Built-in sync"). On Android that is the "direct sync with morten" choice in `docs/ROADMAP.md`: the app in the folder activity,
on a folder no other tool syncs, and Settings → Sync → *A Dvarim server*.

**Nothing native is needed to sync with a Dvarim server.** The page makes the
requests, and the server answers pages from other origins. Please check it on
the device:

1. Put the app in the folder activity on a new, empty folder: not the Syncthing vault,
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
answer no page from another origin (Nextcloud, most others). In the bridge:
HttpURLConnection or OkHttp on the bridge's executor, `setInstanceFollowRedirects(false)`, no cookie store, a 30 s timeout. Only `https:`, and `http:` to private or tailnet addresses. Then set
`http: true` in the `info` reply. The page uses it from then on for every sync
request.

**Later (phase 6):** the token and passwords now sit in the page's own
storage. The Android Keystore is the right home for them.

## Phase 6: the device's own calendars, reminders and widgets

**Done on Android, 2026-09-23.**
- **Calendars** come from CalendarContract's instances (`DeviceCalendars`).
  Android asks for `READ_CALENDAR` the first time the page wants them.
- **The page's Today and Upcoming are kept on the phone** (`Local`), when the
  page comes up and on every op `changed`.
- **The widget and the reminders** read that copy. Reminders are set for the
  days ahead too, and Today is rebuilt after midnight.
- **A tick** from the widget or a reminder waits in `Outbox`. The page makes
  it when the app is next open.

Checked by `tools/phone/local_check.py`. What is not done: nothing refreshes
the copy while the app is closed. A change Syncthing or a sync brings reaches
the widget and the reminders at the next open. The brief, as written:

For the app on a folder, the things the server did must come from Android.

**Calendars.** Everything on the page is done. A shell that answers the
bridge's `calendars` and `events` ops (`docs/BRIDGE.md`), and says
`calendars: true` in `info`, gets the device's events in Today and Upcoming.
Settings → Calendar then lists the device's calendars to choose from.
`tools/bridge_sim.py --calendars FILE` is the reference, and `tools/e2e_folder.py`
checks the page with it. For the shell: `CalendarContract.Calendars` for the list, and `CalendarContract.Instances` (not `Events`: instances have repeats expanded) for the occurrences, queried with `Instances.CONTENT_URI` and the range. All-day instances are in UTC, so read their dates as UTC days. It needs `READ_CALENDAR`, asked for at runtime the first time.

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

