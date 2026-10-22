# Dvarim for macOS

Dvarim on the Mac is a native app: SwiftUI and AppKit for every screen, and
Dvarim's one engine inside it (`Native/`, built by `build-native.sh`). I built it
in rounds beside the web-view app, as "Dvarim Native", and on 22 October 2026 it
took over as Dvarim. *Dvarim on the Mac* below is how it works and how it came
to be.

One engine stays one engine. The native app draws every screen itself, but
nothing in it re-implements a rule: it asks the same engine the server runs,
inside the app, and draws the answers.

The web-view app it replaced (`Dvarim/`, built by `build.sh`) is retired. It
isn't installed any more, and the rest of this file after *Dvarim on the Mac*
describes it, for as long as its code is here.

## Dvarim on the Mac

I made Dvarim for the Mac the way a Mac app is made: SwiftUI and AppKit for
every screen, not the web app in a window. It was built in rounds beside the
web-view app as its own app, **Dvarim Native** (`moe.ptr.dvarim.native`), so I
could use both. Once it did everything that one did, it became Dvarim.

**One engine.** Dvarim's rules live in `engine/`, and the server and the web app
already run it. Dvarim Native runs the same engine inside the app in
JavaScriptCore (`Native/EngineHost.swift`). The Mac gives it what a browser
would: timers, randomness, URL parsing and the network, plus the folder itself
(`Shared/FolderFiles.swift`, the same file operations the folder mode here
uses). The screens ask the engine the same API the server answers. Against the
server they ask the server instead, so a list looks the same either way. The
Markdown files are still the database.

**Where my to-dos live** (Settings):
- *On this Mac, synced with the server*, the default. It keeps a copy in
  `~/Library/Application Support/Dvarim Native/Copies/<server>/<who>/` and keeps
  it in step with the server's `/dav/` using its own token. The token is named
  "<this Mac> (Dvarim Native)" and kept in the Keychain. The app opens and
  works with no network.
- *On the server only*: every list is asked of the server, and the server's
  event stream says when something changed elsewhere.
- *In a folder on this Mac*: any folder of Markdown, read and written here.

I sign in once, with my server's password. The password goes to the server and
nowhere else. Signing out syncs first, and refuses if the latest changes can't
reach the server yet. Then it takes the token off the server and moves the copy
to the Trash.

**Round 1:**
- **The window.** The sidebar has Inbox, Today, Upcoming, Anytime, Someday,
  Logbook and Trash, then my areas and projects, with counts and each project's
  progress. ⌘1 to ⌘7 go to the lists.
- **Every list, as native rows.** Each row has the box, the title, small marks
  for notes, a checklist or a repeat, tags, the project it's in, its start date
  and its deadline. Today has This Evening, Upcoming has its days, Anytime has
  its projects, Logbook has its dates, and a project has its headings.
- **Ticking off.** Click the box. ⌘Z undoes it, and ⇧⌘Z does it again. The
  notice at the foot of the window has Undo too.
- **Always current.** A change in the folder from Obsidian or Syncthing, a sync
  round, or a change on the server from another device shows up by itself. The
  toolbar says whether the copy is in step, syncing or offline.

**Round 2:**
- **The web app's margins.** The list is a column at most 640 points wide,
  centred, 48 points in from the window's sides. The title is at 26 points,
  rows are 6 by 8 points round a 16-point box, and the colours are the web
  app's in light and dark. The app draws the column itself rather than using a
  system list, so the margins are the web app's and a to-do can open in place.
- **A to-do opens into its card in place.** Double-click it, or choose it and
  press Return or Space. The card has the title, the notes, the checklist
  (Return makes the next item; Return on an empty one ends the list) and the
  tags, and along its foot its When, its deadline and the buttons for tags, a
  checklist and a deadline. What I type is kept when the card closes, with
  Escape or a click outside it.
- **⌘N makes a new to-do**, open to type in, where the list in front says:
  - the Inbox, Today, tomorrow in Upcoming, or Someday;
  - the project or area I'm in;
  - the project of the to-do chosen in Anytime.

  It goes below the chosen to-do when that's in the same place.
- **The Items menu**, and the same items on a right-click:
  - Complete ⌘K, Cancel ⌥⌘K;
  - When… ⌘S, Today ⌘T, This Evening ⌘E, Anytime ⌘R, Someday ⌘O;
  - Deadline… ⇧⌘D, Tags… ⇧⌘T, Move… ⇧⌘M, Checklist ⇧⌘C;
  - Duplicate ⌘D, Move to Trash ⌘⌫ (or ⌫ in the list);
  - Log Completed ⇧⌘Y.

  When, Deadline, Tags and Move are popovers on the row or the card, and they
  act on everything chosen.
- **Choosing.** Click; ⌘-click to add or take away; ⇧-click or ⇧↑/⇧↓ to reach.
  ↑ and ↓ move. ⌘↑ and ⌘↓ move the chosen to-do a place up or down.
- **Undo everywhere.** Every one of those changes undoes with ⌘Z and comes back
  with ⇧⌘Z, as does typing in the card. The notice at the foot of the window
  has Undo too.

**Round 3:**
- **The new look.** The lists' icons are the web app's own hand-drawn marks:
  the tray, the sun, the calendar, the stack, the sprout, the book and the bin.
  The app draws them from the same SVG paths (`Icons.swift` is generated from
  `frontend/src/lib/icons.js`). Each one is in its list's earthy colour, with
  the sage accent and its tint for what's chosen. Today in the sidebar shows its
  count, with a red pill for what's due. The app icon is the paper slips.
- **Quick Find (⌘F)** matches lists, areas, projects and to-dos as I type. ↑ and
  ↓ choose, Return goes there, and a to-do opens in the list it lives in. Typing
  "dead", "tomo", "rep" or "proj" also finds its own lists: Deadlines,
  Tomorrow, Repeating, and All Projects and Logged Projects.
- **Projects and areas.**
  - ⌥⌘N makes a project, in the area I'm in, with its name ready to type.
    "New Area" is in the File menu, and both are under "+ New List" at the foot
    of the sidebar.
  - Double-click a project's or an area's title to rename it.
  - Notes go under the title.
  - The … beside a project's title, or a right-click on it in the sidebar,
    holds Complete, Cancel, When, Move to an area, Rename, New Heading and
    Delete. An area's holds Rename, New Project and Delete.
- **Headings.** ⇧⌘N makes one in the project in front. Double-click one to
  rename it, and right-click for Archive and Delete. Deleting a heading keeps
  its to-dos, and ⌘Z puts it back with them under it.
- **Repeating to-dos (⇧⌘R).** It repeats on a schedule or after completion:
  every so many days, weeks, months or years. A week can be on some weekdays,
  a month on the 15th or the 2nd Tuesday, and a year on a date. It can end on a
  date or after a number of times. The engine checks each rule and shows the
  next dates before anything is kept.
- **Convert to Project (⇧⌘P).** A to-do becomes a project of its name, its
  checklist becoming the project's to-dos.
- **Undo has a history of its own.** Every change is one ⌘Z, however quickly
  the next came, and ⇧⌘Z does it again. While a field has the keyboard, ⌘Z
  undoes the typing.

**Round 4:**
- **Several windows.**
  - ⌃⌘N opens one on the list in front, and "Open in New Window" on a project
    or an area in the sidebar opens one there.
  - Each window has its own list, choice and card. They share the one copy,
    the one sync and the one undo history, so a change made in one shows in
    all of them at once.
  - The menus act on the window in front.
- **Drag and drop.**
  - Drag a to-do to put it somewhere else in its list. If it's one of the
    chosen ones, all of them go, and a line shows where they'll land.
  - Drop on a section's heading for its top: This Evening makes them this
    evening's, a day in Upcoming starts them that day, and a heading in a
    project puts them under it.
  - Drop on the sidebar:
    - Inbox moves them there;
    - Today, Anytime and Someday set their When;
    - Upcoming starts them tomorrow;
    - the Logbook completes them;
    - the Trash deletes them;
    - a project or an area moves them into it.

  Every drop is one ⌘Z.
- **Choosing several.** ⌘A chooses every to-do in the list; ⌘-click,
  ⇧-click and ⇧↑/⇧↓ add to the choice. Everything in the Items menu, and a
  drag, acts on all of them.
- **What an undo puts back is what was there.** Before a change, the app asks
  the engine for the to-do as it is now, rather than as the list last drew it,
  however quickly the changes come.

**Round 5:**
- **Quick Entry**, from anywhere, on a chord: ⌃Space, or ⌃⌥Space while the
  web-view Dvarim is in Applications, since that one has ⌃Space. Settings →
  This Mac records another.
  - It has a title and notes. Return saves, Escape goes, and the app I was in
    keeps the keyboard and stays in front.
  - The engine reads the line as it does everywhere: "tomorrow 3pm",
    "!friday" for a deadline, "@9am" for a reminder, "#tag".
- **Today in the menu bar:** the count beside the clock and the list behind it.
  Click a box to complete a to-do. Quick Entry, Open and Quit are at its foot.
- **The Dock badge** counts Today, the Inbox, or nothing. It follows the same
  setting the web app's Settings has, and Settings → This Mac sets it too.
- **Reminders on this Mac.**
  - Each one has a Complete button, and a click on it opens the to-do in its
    list.
  - macOS only allows them for an app in Applications.
  - The server can send them over Signal as well. I keep one of the two on,
    or I'm told twice.
- **Shortcuts, Spotlight and Siri:**
  - Create To-Do, into the Inbox or Today, read like Quick Entry;
  - Show Quick Entry;
  - Open List.
- **The Services menu.** "New To-Do in Dvarim Native" works on whatever text is
  chosen in any app. It opens Quick Entry with that text: the first line is the
  title and the rest are the notes, and I can change them before saving.
  System Settings → Keyboard → Keyboard Shortcuts → Services can give it a key.
- **Kept until it can be sent.** In Remote mode the server may not be
  reachable. Then whatever Quick Entry, Shortcuts, the menu bar or a reminder
  saves is kept on this Mac, and it goes in once the server is back. Quick
  Entry and the menu bar say how many are waiting. The copy never needs this:
  it's on this Mac.
- **Open at login**, in Settings → This Mac.
- **Nothing twice.** While the web-view Dvarim is in Applications, its menu bar
  and reminders are the ones on, and this app's start off. Settings says so,
  and they are switches.

**Round 6:**
- **Calendar events in Today and Upcoming.** Today shows the day's events in a
  grey card above its to-dos. Upcoming shows each day's under that day. A
  timed event has its time in its calendar's colour; an all-day one has a
  small bar of that colour.
  - On this Mac (synced) and in Remote mode, the events are the server's
    calendars (its CalDAV). The copy keeps yesterday to six weeks ahead, so
    the events still show with no network.
  - In a folder, they're this Mac's own calendars, once "Use this Mac's
    calendars" is on in Settings → Dvarim. macOS asks first.
  - Settings → Dvarim chooses whether events show, and from which calendars.
- **Today, as the web app has it:**
  - headings of its own: ⇧⌘N in Today makes one, a double-click renames it, a
    right-click moves it up or down or deletes it, and dragging a to-do onto
    one files it there;
  - grouped by project or area, when Settings says so;
  - a note at its foot when one project has more than one to-do in Today,
    except a catch-all named with "agenda" or "admin".
- **Dvarim's own settings, in Settings → Dvarim:**
  - when completed to-dos move to the Logbook;
  - the week's first day;
  - grouping Today;
  - the tutorial again.

  They're the vault's, so they're the same on every device.
- **The tag filter.** Today, Anytime, Upcoming and a project have a row of
  their to-dos' tags under the title. A click on one shows only the to-dos
  with it, and All shows them all again.
- **Settings has three tabs:** Where, Dvarim and This Mac.
- **The pickers are the web app's dark panel.**
  - When and Deadline read what I type: "tom", "sat", "in 3 days", "wed 8pm".
  - Today, This Evening, Tomorrow, Next week and Someday each sit beside
    their date.
  - There's a month to pick a day from, and Add Reminder.
  - ↑ and ↓ choose, and Return takes it.

**Taking over, 22 October 2026:**
- **It's called Dvarim**, in /Applications as `Dvarim.app`, and "New To-Do in
  Dvarim" is in the Services menu.
- **It kept its own bundle id**, `moe.ptr.dvarim.native`, so its copy, its
  token and its settings stayed where they were. Behind the scenes some names
  stay "Dvarim Native": the folder in Application Support, the Keychain item,
  and this Mac's token on the server.
- **What was the web-view app's is its now.** With that app gone from
  Applications, Quick Entry is on ⌃Space, and Today in the menu bar and the
  reminders are on to begin with. macOS asked again about notifications.
- **The web-view app went to the Trash.**

**Building and testing it:**

```sh
./build-native.sh                       # build-native/Dvarim.app
./selftest-native.sh                    # takes over the screen for about a minute
```

The self-test starts a throwaway server of its own on a dated copy of
`sample-vault`, with a password of its own, on a free port on 127.0.0.1. It
never touches my vault or my server. Then it runs the real app against it:
- signing in;
- the copy filling;
- every list against the server's own answer;
- a tick and ⌘Z, both in the Markdown and on the server, then ⇧⌘Z;
- a new to-do typed into its card, and then When, This Evening, a deadline, a
  tag, a checklist, canceling, moving, the Trash, duplicating and ⌘↓, each
  undone, with a picture of each picker;
- Quick Find, and the lists only it has;
- a project made, renamed and completed, a heading made, renamed, archived
  and deleted, and an area made, renamed and deleted, each undone;
- a repeat, and a to-do turned into a project;
- a second window, and a change in one showing in the other;
- ⌘A, and dropping in a list, into This Evening, on a day in Upcoming, on a
  project and on Someday, each undone;
- a line written into the folder by someone else;
- Quick Entry typed into and saved, the Services menu's text in it, the Dock
  badge both ways, Today in the menu bar and a tick there, which reminders
  are asked for, a reminder's Complete and its click, the three Shortcuts, and
  the chord;
- a stand-in calendar's events in Today and Upcoming, choosing calendars and
  turning events off, Today's own headings made, renamed, filled by a drop and
  deleted, each undone, a heading moved, the tag filter, Today grouped by
  list, its note, Dvarim's settings,
  When read from what's typed, and a picture of each Settings tab;
- the storage contract's checks;
- Remote mode, and a Quick Entry line kept with no server and sent once it's back;
- signing out.

It writes PASS and FAIL lines and a picture of each step to
`build-native/selftest/`. It keeps its settings, folder, token and cookies to
itself, and removes them afterwards. It also has the keyboard while it runs,
so I don't type meanwhile: a key pressed then goes into its Quick Entry. It
doesn't turn on reminders or open at login, and it doesn't keep the menu bar
item.

What I learned building it:
- **Foundation's JSON parser drops a byte-order mark, even inside a string.**
  So the engine and the folder trade values directly, not JSON. Otherwise a
  file with a BOM would come back changed.
- **The window pictures come from the window server**, with
  `CGWindowListCreateImage` looked up at run time. The macOS 26 SDK marks it
  unavailable, but it still pictures an app's own windows without the Screen
  Recording permission. `cacheDisplay` misses glass and draws a selected
  sidebar row as a black bar.
- **A fixed test port can belong to someone else**, an `ssh -R` tunnel for
  example, so the self-test picks a free one and checks that the server
  answering is its own.
- **Undo registers its own reverse straight away, inside a group of its own.**
  That way redo works, and an undo from outside a key event doesn't leave a
  group open.
- **Two apps can register the same global chord.** Carbon refuses a chord only
  when this app holds it already, so nothing says the web-view Dvarim has
  ⌃Space. Dvarim Native takes ⌃⌥Space while that app is in Applications.
- **A menu bar item on macOS 26 is a scene's.** There is one item with a
  button, plus a copy without one for each display. A click on it is answered
  outside the app, so a test can't click it; the self-test draws its list in a
  panel of its own instead.
- **A Mac that sleeps stops a build.** It isn't stuck: it waits, at no CPU,
  until the lid opens.

## The web-view app, retired

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
