# Dvarim for macOS

A native shell around the web app. The web app stays the entire interface; this
adds only the things a browser cannot do:

- **Your to-dos in a folder, with no server**: Settings → Where your to-dos live
  → *In a folder on this Mac*. The app then carries the web app inside it and
  reads and writes that folder's Markdown itself — the Tasks folder of an
  Obsidian vault, say, with Syncthing or iCloud Drive keeping it in step
  elsewhere. See *A folder instead of a server* below.
- **Quick Entry from any app**, on ⌃Space to begin with, and on whatever chord
  you record in Settings after that: a title, and notes under it. The server
  does the date parsing. It takes the keyboard without bringing Dvarim forward,
  and hands it back when you save or press Escape.
- **Today in the menu bar**: the count beside the clock, the list behind it, each
  line tickable without opening a window.
- **Dock badge** from `GET /api/state`, counting whatever the web app's
  Settings → Badge count says.
- **Native reminder notifications** instead of, or as well as, Signal. Each has a
  Complete button, as on the phone, and clicking it opens the to-do.
- **Real windows**: ⌃⌘N for a new one, and the web app's "open in a new window"
  button opens one on the list you were looking at. ⌘N is left alone so it
  reaches the web app, where it means New To-Do.
- **Links out**: a link in a to-do's notes opens in your browser instead of
  stranding you inside the app.
- **Open at login**, so the badge, the hotkey and the reminders are there without
  you starting anything.
- **"New To-Do in Dvarim" in the Services menu**, on the selection in any app,
  with a key of your own if you give it one in System Settings. It opens Quick
  Entry with the first line as the title and the rest as notes.
- **Shortcuts, Spotlight and Siri** through App Intents: Create To-Do, Show Quick
  Entry, Open List.
- **No server, no problem**: a Quick Entry line, a Create To-Do from Shortcuts, a
  tick in the menu bar and a reminder's Complete are kept on this Mac when the
  server cannot be reached, and sent when it can (`Outbox.swift`). The badge and
  the menu bar keep what they last knew rather than emptying, and Quick Entry
  says how many are waiting. The window itself is the web app, whose own outbox
  covers everything else.

One codebase stays one codebase. Nothing here re-implements a list.

## What you need

- macOS 14 or newer and the Command Line Tools (`xcode-select --install`).
  Xcode is optional; see *Signing* for the one thing it buys you.
- `brew install xcodegen`.
- The server up. Check with `curl -s https://dvarim.tiresia.xyz/api/health`
  before building anything, or `http://100.91.202.11:8420/api/health` on the
  tailnet. `/api/state` answers 401 until you are signed in, which is the point.

## Build it

```sh
git clone git@github.com:franz-rosenzweig/dvarim.git
cd dvarim/mac
./build.sh                # build/Dvarim.app, in about ten seconds
open build/Dvarim.app     # or drag it into /Applications
```

For the folder mode, build the web app first (`cd ../frontend && npm ci && npm run
build`): `build.sh` copies `frontend/dist` into the app. Without it the app is
the server's window and nothing else, and `build.sh` says so.

`build.sh` compiles with `swiftc` from the Command Line Tools, takes the
Info.plist keys and the version from `project.yml`, makes the app icon out of the
web app's own icon, and signs. With Xcode installed you can work the other way
instead — `xcodegen generate && open Dvarim.xcodeproj`, set Signing &
Capabilities → Team, press Run — and get the same app: both builds read the same
`project.yml`, and the project file and `Dvarim/Info.plist` it generates are not
in git.

On first run, sign in on the web app's own login screen in the Dvarim window.
That one login is all: the badge, reminders and Quick Entry borrow the window's
session cookie, so they are signed in exactly when the window is, and the shell
never handles the password. The server address is in Dvarim → Settings….

## Signing, and why reminders may stay quiet

`build.sh` signs with an Apple Development identity if your keychain has one, and
ad-hoc if it does not. Get one by adding your Apple ID in Xcode → Settings →
Accounts → Manage Certificates → + → Apple Development; a free personal team is
enough, and `build.sh` finds the identity by itself afterwards. If your
certificate will not validate ("0 valid identities found" while the certificate
is in the keychain), the WWDR intermediate that signed it is missing: Xcode ships
it at `Contents/SharedFrameworks/DVTFoundation.framework/Versions/A/Resources/AppleWWDRCA-2030.cer`,
and `security import` of that file into the login keychain fixes it.

**Notifications need the app to live in `/Applications`.** Anywhere else — a
build folder, `~/Applications`, a temp directory — `requestAuthorization` fails
with "Notifications are not allowed for this application", no prompt appears, and
no amount of signing changes it; a ten-line app that does nothing but ask behaves
the same way. So copy the build in:

```sh
./build.sh && cp -R build/Dvarim.app /Applications/ && open /Applications/Dvarim.app
```

macOS asks once. If Dvarim was ever refused — including by being run from the
wrong place — the answer sticks as a denial and no prompt comes back; turn it on
again in System Settings → Notifications → Dvarim. Settings reports whichever
state it is in, and the server's Signal reminders cover the gap.

## Keyboard

Quick Entry's chord is recorded in Settings: click it, press what you want. It
must carry ⌃, ⌥ or ⌘, because macOS keeps plain and Shift-only chords for typing,
and Settings says so when the chord you picked is already spoken for.

The page gets every shortcut first, which is what makes ⌘N New To-Do: every ⌘
shortcut in `frontend/src/lib/keys.js` works here as it does in a browser,
including ⌘, for the web app's own Settings. Chords with ⌃ go to the menu bar
first, because the web app reads ⌃ only as the non-Mac spelling of ⌘ while a Mac
spends it on windows: ⌃⌘N is New Window whatever the page is doing, ⌃Space is
Quick Entry, and ⌃⌘R is Reload — which used to be ⇧⌘R until the web app took
that for Repeat…. The shell's own settings — server, hotkey, reminders — are
under Dvarim → Settings….

The **Go** and **To-Do** menus put those shortcuts where a Mac expects to find
them, because a command nobody can see may as well not exist. They are not a
second copy of the keymap: the web app exposes it at `window.dvarim`
(`frontend/src/lib/shell.js`), and each item runs its command *by id*, so
rebinding a key in Settings → Keyboard moves the key without breaking the menu
item. The one seam is the shortcut printed beside the item, which a SwiftUI menu
fixes at build time: rebind something and the menu goes on advertising the
original key while still doing the right thing. `./selftest.sh URL menus` checks
the door is open and that choosing an item moves the page.

Choosing a menu item needs a web app new enough to answer — anything from the
commit that added `shell.js` onwards. Against an older server the menu appears
and does nothing, which is why the self-test checks for the bridge by name.

Other apps can want ⌃Space too, macOS among them: it switches keyboard layouts
with it (System Settings → Keyboard → Keyboard Shortcuts → Input Sources →
"Select the previous input source"). macOS wins over any app, and it is read
straight from the system's shortcut table, so Settings names the clash. Record a
different chord, turn the other one off, or use File → Quick Entry.

## A folder instead of a server

Settings → *Where your to-dos live* has two choices, and the server is the one
anyone gets who does nothing:

- **On the server**: the window is the server's page, as it always was.
- **In a folder on this Mac**: the window is the page from inside the app
  (`dvarim-app://app/`, `AppScheme.swift`), running on the engine, and
  `FolderBridge.swift` answers its reads and writes from the folder — the
  protocol in `docs/BRIDGE.md`. FSEvents tells the page when Obsidian, Syncthing
  or anyone else changes a file, and it is on screen a moment later.

The page's own Settings → Data can switch too (*Choose another folder…*, *Use a
server instead…*) and has **Check this folder**, the conformance checks every
shell must pass.

**The rest of the app works on the folder too.** The badge, the menu bar,
Quick Entry, reminders, the Services item and the intents ask the page what
they would ask a server (`LocalPage.swift`, through `window.dvarim.request`),
and the engine answers from the folder. A window's page answers when a window
is open. With every window closed, the app keeps a page of its own that is
never shown, so the menu bar still hears of a change Syncthing brings; it goes
as soon as a window opens, so two pages never write one folder. The page says
when the vault changed (op `changed`), and the badge, the menu bar and
reminders ask again at once rather than at the next minute.

**Sync without Syncthing.** On a folder no other tool syncs, the page's
Settings → Sync can keep it in step with a Dvarim server (a device token from
the server's own Settings → Sync → *Add a device*) or another WebDAV server.
The page makes the requests itself; a WebDAV server that answers no page from
another origin (Nextcloud, most) is reached through the app instead, the op
`http` (`ShellHTTP.swift`): no cookies, no redirects, 30 seconds, and plain
http only to this Mac, the local network or the tailnet. The token is kept in
the page's storage for now; the Keychain is the better home, later.

**Your calendars.** The page asks the app for this Mac's own calendars (ops
`calendars` and `events`, `DeviceCalendars.swift`, from EventKit), and their
events show in Today and Upcoming; Settings → Calendar lists them to choose
from. Nothing is asked until they are turned on there (*Show this device's
calendars*); macOS asks for the permission then. A refusal is changed in System
Settings → Privacy & Security → Calendars.

One thing about names: when Foundation *creates* a file or a folder it
decomposes the name — `Café.md` lands on disk as `Cafe` plus a combining accent
— and a URL's `standardizedFileURL` decomposes a name on the way out. Either
makes the page see a different file from the one it wrote, and makes a
different name for Syncthing to carry. So `FolderFiles` creates through
`rename(2)` and `mkdir(2)`, which take the bytes as given, and lists with
`enumerator(atPath:)`. Reading and removing through Foundation is fine: APFS
finds a name however it is composed.

## Testing it

```sh
./selftest.sh http://127.0.0.1:8420             # every section
./selftest.sh http://127.0.0.1:8420 keys,quick  # keys quick badge reminders menubar intents offline hotkey settings layout folder sync calendars local
```

This builds a second copy of the app with `SelfTest/` linked in and drives it
from inside, posting real key events into its own queue so a shortcut takes the
same path as a keypress — the key window's views first, the menu bar second. It
checks what you would press and see: ⌘N straight after launch, ⌃⌘N in three
different page states, ⌘F, ⌘1, the new-window button, Quick Entry from another
app (does it type, save, close, and give the keyboard back), the Dock badge, the
reminder queue, the menu bar's list and ticking a line off it, the shortcut
recorder's parsing, the intents behind Shortcuts, the Services handler, and
Settings. `offline` points the whole shell at a port nothing listens on and
checks that Quick Entry, the intent and a tick are kept, that the badge and menu
keep their counts, and that all of it arrives once the server is back. The run
keeps its own outbox (`-OutboxFile`), so nothing it leaves behind can reach your
real one. With `auth --session VALUE` it also checks the
signed-out and signed-in halves against a server that has a password.

`folder` puts the app on a copy of `sample-vault/` in a temporary folder, in the
argument domain so the real app never finds itself there: the conformance
checks, the Inbox against `Inbox.md`, a line written into the file appearing
unasked, a to-do made and ticked landing in the file and not on the server,
Reload on a project, a second window, and the page's *Use a server instead…*.
With `-SelfTestCompare YES`, and the server running on a copy of the same
files, it also checks that the page and the server say the same about the
state and every list — which is how a copy of a real vault is compared.

`sync` is the device check of phase 5 against a server of its own: it starts
`server/src/main.js` on another copy of `sample-vault/` with a throwaway
password and a device token, and syncs a new, empty folder with it through the
page's Settings → Sync. Twice: once with the page making the requests, once
through the app's `http` op. A wrong token is said plainly; the vault arrives,
byte for byte; a to-do goes each way; one made while the server is down goes
when it is back; a token revoked on the server is said to be. It needs `node`,
and leaves alone a Mac whose Dvarim already syncs a folder. `calendars` checks
how an EventKit occurrence is written for the page and the `http` op's
address rules, then the page's side with a file standing in for EventKit
(`-DeviceCalendarsFile`), so it needs no calendar permission. `local` checks
the badge, the menu bar, Quick Entry and reminders on a folder, with a window
open and with none.

It writes to-dos, so it refuses anything but a server on this Mac: run it against
a dev instance on a fresh copy of `sample-vault/`. `tools/phone/devserver.sh
--fresh` starts one on port 8421, with the copy's dates moved up to today. It
takes the keyboard for a few minutes and brings Finder forward once, so
leave the Mac alone while it runs. Pictures of every window it opens land in
`build/selftest/out`.

## Shortcuts, Spotlight, Siri and the Services menu

The three intents in `Intents.swift` are what Shortcuts lists under Dvarim, what
Spotlight can run, and what Siri answers to ("Add a to-do to Dvarim"). They need
a `Metadata.appintents` bundle next to the binary, and only Xcode's
`appintentsmetadataprocessor` writes one — `build.sh` runs it when Xcode is
installed and says so when it is not; everything else still works without it. The
system picks the intents up when it registers the app, so install and launch it
once before looking in Shortcuts.

The Services item needs no metadata, only the `NSServices` block `project.yml`
writes into Info.plist. It appears in every app's Services menu on a text
selection, and System Settings → Keyboard → Keyboard Shortcuts → Services is
where you can give it a key — useful when the Quick Entry chord is spoken for.

## Files

| File | What it is |
| --- | --- |
| `DvarimApp.swift` | the app, its menus, its windows, and the AppDelegate that starts everything |
| `WebView.swift` | `WKWebView` wrapper: shortcut routing, new windows, external links, and the folder bridge's wiring |
| `Vault.swift` | server or folder, which folder, the folder picker, and where a window opens in each |
| `AppScheme.swift` | serves the web app from inside the app at `dvarim-app://app/` |
| `FolderBridge.swift` | the page's reads and writes, answered from the folder, and FSEvents |
| `LocalPage.swift` | on a folder, the page that answers the badge, the menu bar, Quick Entry and reminders; a hidden one with no window open |
| `ShellHTTP.swift` | the bridge's `http` op, for a sync server that answers no page from elsewhere |
| `DeviceCalendars.swift` | the bridge's `calendars` and `events` ops, from EventKit |
| `Client.swift` | the few API endpoints a shell needs, from the server or the folder's page; the borrowed login, the defaults keys |
| `GlobalHotKey.swift` | ⌃Space via Carbon, which needs no Accessibility permission |
| `QuickEntry.swift` | the floating one-field panel |
| `Outbox.swift` | what the shell keeps while the server cannot be reached, and sends when it can |
| `BadgeUpdater.swift` | dock badge poller, and the heartbeat that sends what the outbox kept |
| `Reminders.swift` | local notifications for today's reminder times |
| `SettingsView.swift` | server or folder, server address, hotkey, menu bar, login item, notifications |
| `Shortcut.swift` | the Quick Entry chord, and the recorder that takes a new one |
| `MenuBar.swift` | the menu-bar item: today's count, today's list, ticking a line |
| `LoginItem.swift` | open at login, through `SMAppService` |
| `Services.swift` | the Services menu item, and where a list gets opened from outside a view |
| `Intents.swift` | the App Intents behind Shortcuts, Spotlight and Siri |
| `build.sh` | builds and signs `build/Dvarim.app`, no Xcode needed |
| `selftest.sh`, `SelfTest/` | the end-to-end test above; test-only, never built into the app |

## Worth knowing before you change anything

- **The API is the contract.** `docs/API.md` in this repo is complete and tested.
  The shell needs no server changes; if you find yourself wanting one, that is a
  signal the feature belongs in the web app instead.
- **The guide in `docs/`** describes every feature. Check it before building
  anything: most of what you might reach for is already in the web app.
- **One login, the web app's.** The shell reads the session cookie out of the web
  view for its own requests and does nothing else about authentication. When the
  window shows the login screen, Quick Entry says so and keeps your typing; the
  badge clears. A line or a tick the outbox is holding waits through that too,
  rather than being dropped for want of a cookie. A bearer token (`docs/INTEGRATIONS.md`) would be the other way,
  but then there would be two things to sign in.
- **Plain HTTP.** `project.yml` sets `NSAllowsArbitraryLoads` for the tailnet
  address. If you only ever use the HTTPS one, delete that key.
- **Reminders arrive twice** if the server's Signal reminders are on and the
  Mac's are too. Pick one.
- **Reminder times are wall-clock times here, on the to-do's own When date.** The
  server keeps its own zone (`TZ`, America/Phoenix as deployed; see
  `docs/DEPLOY.md`), so its today and the Mac's differ for part of every day
  whenever the Mac is somewhere else; nothing here schedules by the Mac's today.
- **The sandbox is off** so the app can open a socket and take a global hotkey.
  For a personal app that is fine. Turning it on means adding
  `com.apple.security.network.client`, and the Carbon hotkey still works.
- **It compiles clean in Swift 6 language mode**, not only in the 5.9 the project
  asks for. Keep it that way: the WebKit delegate signatures are the fussy part,
  and a stale one stops being called rather than failing to build.

## Where to go after it runs

The menu-bar item, the Services menu, opening at login and working without the
server have all been built. What is left, in rough order of what each is worth:

1. **Quick Entry with Autofill**: grab the frontmost app's document or URL and
   put a link in the to-do's notes, from Mail and Safari to begin with: the way
   in is AppleScript against the frontmost app.
2. **Only then** consider a native list UI. The wrapper has to feel wrong first.
