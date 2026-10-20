# The folder bridge

How a native shell (the Mac app, the Android app) gives the page a folder of
Markdown to keep its to-dos in. This is the contract both shells implement;
the page's half is `engine/src/storage-bridge.js`.

- **Reference implementation:** `tools/bridge_sim.py`, about a hundred lines of
  Python over a real folder.
- **Proof:** `tools/e2e_folder.py` runs the app against that reference, playing
  first the Mac shell and then the Android one.
- **The check a shell must pass:** `engine/src/storage-conformance.js`. On a
  device, run it from Settings → Data → **Check this folder**, or call
  `await window.__dvarimLocal.conformance()`.

If a shell and this document disagree, this document wins, and the reference
is fixed to match it.

Phase 3 of `docs/ROADMAP.md`.

## The shape of it

```
 ┌──────────── the shell's WebView ─────────────┐
 │  the page, from the app's own bundle          │
 │    engine (store, lists, dates, repeats)      │
 │    BridgeStorage ── message ──┐               │
 └───────────────────────────────┼───────────────┘
                                 ▼
          the shell: one message at a time, a folder on disk
          ◄── window.__dvarimFilesChanged() when someone else writes it
```

In folder mode the shell does three things:

1. It serves the page from inside the app, not from a server.
2. It answers the bridge's messages from the folder.
3. It tells the page when something else has changed the folder.

Everything else is the page's job, and the page already does it: parsing,
lists, repeats, the interface, and Settings → Data.

## 1. Serving the page

Serve the build (`frontend/dist`, made by `npm ci && npm run build` in
`frontend/`) from inside the app:

| | origin | how |
| --- | --- | --- |
| macOS | `dvarim-app://app` | a `WKURLSchemeHandler` registered for `dvarim-app` |
| Android | `https://appassets.androidplatform.net` | `shouldInterceptRequest` answering from `assets/web/` |

- **Paths.** A path that names a file in the build returns that file, with its
  MIME type (`.js` is `text/javascript`, `.css`, `.svg`, `.png`, `.webmanifest`,
  `.html`). Any other path returns `index.html`. The app routes by path
  (`/today`, `/project/p7k3j9a2`), so a reload on any screen must come back to
  that screen.
- **`/api/`.** Nothing under `/api/` needs an answer. In folder mode the page
  answers its own API calls.
- **No service worker.** The page does not register one when it is inside a
  shell. There is nothing to cache, and a cached copy would outlive an app update.
- **User agent.** Keep the one the shell already sends
  (`Dvarim/… (macOS shell; chromeless)` on the Mac; Android's WebView adds
  `; wv)` by itself). The page uses it to show the shell's own settings link.

## 2. The messages

### Transport

**macOS.** A `WKScriptMessageHandlerWithReply` named `dvarimStorage`, added to
the page content world:

```swift
config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "dvarimStorage")
```

- The page calls `window.webkit.messageHandlers.dvarimStorage.postMessage(msg)`.
- `msg` arrives as a dictionary. Reply with `replyHandler(reply, nil)`, where
  `reply` is the dictionary described below.
- Use the `errorMessage` argument only if the bridge itself breaks. File errors
  go inside `reply`.

**Android.** A `@JavascriptInterface` object added as `DvarimStorage`:

```java
web.addJavascriptInterface(bridge, "DvarimStorage");
// in the bridge:
@JavascriptInterface public void request(int id, String json) { … }
```

- The page calls `DvarimStorage.request(id, json)`. `request` must return at
  once: hand the work to a single-thread executor.
- Reply by calling `window.__dvarimStorageReply(id, replyJson)` on the UI thread:

  ```java
  web.post(() -> web.evaluateJavascript(
      "window.__dvarimStorageReply(" + id + "," + JSONObject.quote(replyJson) + ")", null));
  ```

- Replies may arrive in any order. The page matches them by `id`.

**Only the app's own page may call the bridge.**
- On the Mac, check `message.frameInfo.securityOrigin`. Its protocol must be
  `dvarim-app`.
- On Android, add the interface only in the folder-mode activity, and only
  ever load the app's own origin there. The folder-mode `WebViewClient` opens
  every other address in the system browser (`dvarim://settings` goes to the
  shell's own settings), so nothing else ever loads alongside the interface.

### Messages and replies

The page sends:

```json
{ "v": 1, "op": "write", "args": { "path": "Inbox.md", "text": "- [ ] Call Dana 🆔 aa11bb22\n" } }
```

The shell answers:

```json
{ "ok": <result> }
{ "error": { "code": "EACCES", "message": "what went wrong, in words a person can act on" } }
```

**One at a time, in the order sent.** A shell processes messages serially: a
serial `DispatchQueue` on the Mac, a single-thread executor on Android. The
page may send several at once. It relies on a write followed by a read of the
same file getting the new text.

A `v` the shell does not speak gets `{"error": {"code": "EPROTO"}}`.

| op | args | ok | notes |
| --- | --- | --- | --- |
| `list` | — | `{files: [...], dirs: [...]}` | Every file and every directory under the root, empty directories included, as paths (see *Paths*). May leave out what is inside `.git`, `.obsidian`, `.trash`, `.stfolder`, `.stversions` and `node_modules`. Must include what is inside `.dvarim`. Leave out your own temporary files. |
| `read` | `path` | `{text, mtime}` or `null` | `null` when there is no such file. That is not an error. |
| `readMany` | `paths` | `[{text, mtime} or null, ...]` | One answer per path, in the order asked. This is how the page scans the folder in one round trip. |
| `write` | `path`, `text` | `{mtime}` | Creates parent directories. **Atomic** where the platform allows it: write a temporary file beside it, then rename it over the original. |
| `remove` | `path` | `null` | A file. Nothing happens if it is not there. |
| `move` | `from`, `to` | `null` | A file, or a directory with everything in it. Creates the parents of `to`. **`EEXIST` if a file or a non-empty directory is at `to`**, with nothing changed; a directory may replace an *empty* directory, as `rename(2)` does. The store renames an area's folder onto one an earlier move left empty. `ENOENT` if `from` does not exist. |
| `mkdir` | `path` | `null` | Creates the directory and its parents. Nothing happens if it is there. |
| `removeDir` | `path` | `true` / `false` | Removes the directory only if it is empty. `false` if it had anything in it. `true` if there is no directory there afterwards, including when there never was one. |
| `info` | — | `{name, detail, canPick, canUseServer, pollSeconds, http, calendars}` | What Settings → Data shows: `name` is the folder's name, `detail` where it is (a path, or "Syncthing › Tasks"). `pollSeconds`: how often the page should rescan while in front. Use `0` if the shell reports changes itself (the Mac); Android should use about 15. `http`: `true` if the shell answers `http` (below). `calendars`: `true` if it answers `calendars` and `events`. `changes`: `true` if it wants `changed`. |
| `pick` | — | `{changed: bool}` | Offer the folder picker. Reply when it closes. If a folder was chosen, remember it and then reload the page. |
| `useServer` | — | `null` | Switch the shell to server mode and load the server's page. Reply first. |
| `http` | `url`, `method`, `headers`, `body` | `{status, headers, body}` | Optional, since phase 5. One HTTP request made by the shell (URLSession, OkHttp) for the built-in sync, so a WebDAV server that answers no page from another origin (Nextcloud, most) can still be reached. `body` and the reply's `body` are UTF-8 text or `null`; `headers` an object of strings. Any method, `PROPFIND` and `MKCOL` included. Follow no redirects, keep no cookies, and time out after 30 s. A network failure is `{"error": {"code": "EIO"}}`; an HTTP error status is an ordinary reply. Only `https:` URLs, and `http:` to a private or tailnet address. Say `http: true` in `info` once it works. It needn't wait its turn behind file operations, nor they behind it: run it beside the serial queue. |
| `changed` | `paths` | `null` | Optional, since phase 6, from the page to a shell that says `changes: true` in `info`. The vault changed: in the app, by a sync, or on disk. It is sent a second after the last change, once the files are written, with the paths that changed (`[]` for settings or orders only). The menu bar, the badge, reminders and widgets can ask again through `window.dvarim.request`. Nothing waits for the reply. |
| `calendars` | — | `[{name, color}]` | Optional, since phase 6. The device's own calendars that hold events (EventKit on the Mac, CalendarContract on Android), for Settings → Calendar. `color` as `#RRGGBB`. Ask for permission the first time. The page asks only once the person has turned the device's calendars on, in Settings → Calendar on this device, so the prompt follows that click and never comes on opening the app. If it is refused, answer `{"error": {"code": "EACCES", "message": "…"}}`, saying where to allow it. |
| `events` | `from`, `to`, `calendars` | `[{uid, title, calendar, color, allDay, start, end}]` | Optional, since phase 6. Every occurrence touching the days `from`..`to` (both included, `YYYY-MM-DD`), repeats already expanded, as EventKit and CalendarContract's instances give them. `calendars` is the list of names to include, or `null` for all. `start` and `end` in the device's own wall time: `2026-09-24T09:30`, or for an all-day event `2026-09-24`, with `end` the day after its last, as iCalendar has it. The page splits them into days itself (`engine/src/events.js`). Say `calendars: true` in `info` once they work. |

### Paths

A path is relative to the folder, uses `/` as the separator, and has no empty,
`.` or `..` segment.

- **Refuse anything else with `EINVAL`**, and refuse anything that leads outside
  the folder once symlinks are resolved.
- The page never sends such a path. The check is there so that a bug cannot
  write outside the folder.

**Names come back exactly as written.** The page writes names composed (NFC),
such as `Café.md`. If a listing hands them back decomposed, the store sees a
different file from the one it wrote.
- APFS and ext4 keep names as written.
- If a platform's own API normalises names, undo that before replying.
- The conformance check tests this.
- **macOS:** Foundation decomposes a name when it creates a file or folder, and
  `standardizedFileURL` decomposes one on the way out. The Mac shell creates
  through `rename(2)` and `mkdir(2)` and lists with `enumerator(atPath:)`; see
  `mac/Dvarim/FolderBridge.swift`.

### Text

UTF-8, both ways. `write` stores exactly the bytes of the string:
- no byte-order mark added;
- `\n` never turned into `\r\n`.

`read` returns exactly what is in the file, whatever it contains:
- a `\r\n` is kept;
- a leading BOM is kept.

The page does its own normalising, the same way the Python server does. If a
file is not valid UTF-8, decode it with replacement characters rather than
failing.

`mtime` is milliseconds as a number. It must change when the file changes.
Nothing else relies on it: the page compares contents, not times.

### Error codes

| code | when |
| --- | --- |
| `EINVAL` | a bad path, or a missing argument |
| `ENOENT` | `move` from something that is not there |
| `EEXIST` | `move` onto something that is there |
| `EACCES` | permission lost. On Android, the folder's grant was revoked. Say so in `message`, e.g. "Dvarim no longer has access to Tasks; choose it again in Settings". |
| `ENOSPC` | the disk is full |
| `EIO` | anything else |
| `ENOSYS` | an op this shell does not know |
| `EPROTO` | a protocol version this shell does not speak |

A failed write reaches the person as a message: *Not saved — could not save
Inbox.md: …*. So the `message` should be something they can act on.

## 3. When someone else writes the folder

Obsidian, Syncthing, iCloud Drive and a server on the other side of a sync all
write to the same folder. When the shell notices a change it did not make
itself, it calls:

```js
window.__dvarimFilesChanged()
```

- **Mac:** use `FSEventStream` on the folder, with a latency of about 0.3 s.
- **Android:** the document providers do not report changes. Set `pollSeconds`
  in `info` instead.

Calling it too often is harmless. The page debounces the calls, reads the
folder in one `readMany`, and compares contents. It also rescans whenever the
window comes back to the front.

## 4. Which mode the shell is in

The mode is the shell's own setting, and the default is the one in use today:

- **Server**: the shell opens the server's address. The bridge is not
  installed. Since the copy (below), the apps do this only when "On the server
  only" is chosen.
- **Folder**: the shell serves the page from inside the app and installs the
  bridge. On the Mac the folder is a path, and the app is not sandboxed. On
  Android it is a Storage Access Framework tree URI with a persisted permission.

The shell's own Settings switch between the two. So does the page:
- **Choose another folder…** sends `pick`.
- **Use a server instead…** sends `useServer`.

**Copy** (from October 2026): folder mode on a private folder that the app
keeps for one person, synced with their server. The page is the app's own, as in
folder mode, and the shell tells it where to sync:

- `info` carries `sync: { kind: 'dvarim', address, token, app: true }`. The page
  syncs with that server (`lib/davsync.js`) instead of what Settings → Sync would
  keep, and Settings → Sync says the app set it up and offers no change.
- What only the server can answer (who you are, people, devices, calendars,
  account requests: `SERVER_ONLY` in `lib/backend.js`) is asked of that server
  with `Authorization: Bearer <token>`, through `http`. For devices and people,
  which a token may not touch, the request carries `session: true`: the shell
  sends its own session cookie with it, for its own server and no other.
- Signing out runs a last sync round and then sends `signOut` (no arguments):
  the shell revokes its token, signs out of the server, deletes the copy and
  goes back to the server's sign-in. If that round cannot reach the server, the
  page does not send it, and says the changes have not reached the server yet.
- The server's own page inside an app that keeps a copy is told so by a user
  script, `window.__dvarimShell = { copy: true }`: it then keeps no copy of its
  own (no mirror, below), and "Keep a full copy on this device" asks the shell
  for its copy instead, posting `{ type: 'useCopy' }` to the Mac's `dvarim`
  message handler or to Android's `DvarimShell.postMessage(json)`
  (`lib/shell.js`, `askShell`).

In the Mac and Android apps the copy is the default, set up from the first
sign-in (mac/Dvarim/AppCopy.swift, android/…/AppCopy.java):

- Until there is a copy the app shows the server's sign-in. Once someone has
  signed in, the shell makes the device a token with `POST /api/tokens`, named
  for the device ("… 2" if the name is taken), using its session cookie, never
  another token. The Mac keeps the token in the Keychain, Android in the app's
  private storage. Then it reloads into the copy.
- The copy's folder is the app's own: on the Mac
  `~/Library/Application Support/Dvarim/Copies/<host>/<who>/`, on Android
  `files/copies/<host>/<who>/` (a plain folder, not a SAF tree). `<who>` is
  `owner` for the server's owner, otherwise the page's `personKey`. Signing out
  moves the Mac's copy to the Trash and deletes Android's.
- On Android the first sign-in is in the app's own WebView
  (`CopySignInActivity`), not the Trusted Web Activity, because the app cannot
  read Chrome's cookies. Without a document-start script there,
  `window.__dvarimShell` is a JavaScript interface whose `copy` is a method,
  which is truthy.
- "On the server only" and "In a folder" stay choices in each app's own
  Settings, as before.

In a browser the server's page keeps a copy of its own: the mirror
(`docs/SYNC.md`, "The mirror").

## What stays with the server for now

The menu bar, the badge, Quick Entry, the widget, reminders and the share
sheet all talk to the server over HTTP today.

In folder mode they keep doing that if a server is configured. That is
Nathan's setup: the server writes to the vault, Syncthing brings the change
to this folder, and the page picks it up.

With no server, they are off until phase 6. Phase 6 moves them to local data,
using the page's `window.dvarim.request(method, path, body)`. That call answers
any API route from this device's folder, so a shell can use it through
`callAsyncJavaScript` or `evaluateJavascript` while a window is open.

- **The Mac does this** (`mac/Dvarim/LocalPage.swift`). In folder mode every
  one of them asks a page. It uses a window's page if one is open. Otherwise it
  uses a page the app keeps hidden, which also goes on watching the folder and
  syncing, and which goes as soon as a window opens.
- **Android keeps a copy of the lists** (`Local.java`). With the app closed
  there is no page, so `FolderActivity` keeps the page's Today and Upcoming on
  the phone when the engine comes up and on every `changed`. The widget and
  the reminders read that copy. A tick made with the app closed waits in
  `Outbox` until the page is up.
- `window.dvarim.request` waits until the vault is open (#73), so a shell may
  ask the moment `window.dvarim` exists. Both shells also wait for
  `window.__dvarimLocal` before asking, which does no harm and was needed
  before #73.

## Checking a shell

1. Put the app in folder mode on a **copy** of a vault, or on a new empty folder.
2. Open Settings → Data → **Check this folder**. Every check must pass.
   - The checks run in a scratch folder under `.dvarim/`, which is removed
     afterwards.
   - They time each part, which is a quick way to see whether a bridge is slow.
3. Test by hand:
   - edit a file in Obsidian and see it in the app;
   - tick a box in the app and see it in the file;
   - let Syncthing bring a change in with the app open.
4. From a selftest, run `await window.__dvarimLocal.conformance()`. It returns
   `{ok, results: [{name, ok, ms, error?}]}`.
