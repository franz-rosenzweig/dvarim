# Dvarim for macOS

Dvarim on the Mac is a native app: SwiftUI and AppKit for every screen, and
Dvarim's one engine inside it (`Native/`, built by `build-native.sh`). I built it
in rounds beside the web-view app, as "Dvarim Native", and on 22 October 2026 it
took over as Dvarim. *Dvarim on the Mac* below is how it works and how it came
to be.

One engine stays one engine. The native app draws every screen itself, but
nothing in it re-implements a rule: it asks the same engine the server runs,
inside the app, and draws the answers.

The web-view app it replaced (`Dvarim/`, built by `build.sh`), a window
around the web app plus Quick Entry, the menu bar and the rest, was taken out
of this repository once the native app had replaced it. It's in the history,
up to the takeover.

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
  "<this Mac> (Dvarim Native)" and kept beside the copies, in `Tokens/`, in a
  file only my account can read. The app opens and works with no network.
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
  stay "Dvarim Native": the folder in Application Support and this Mac's token
  on the server.
- **What was the web-view app's is its now.** With that app gone from
  Applications, Quick Entry is on ⌃Space, and Today in the menu bar and the
  reminders are on to begin with. macOS asked again about notifications.
- **The web-view app went to the Trash.**

**The token out of the Keychain, 25 October 2026.** The releases are signed
with a certificate of their own, which has no Apple team ID, and the login
keychain trusts such an app one build at a time. So every launch asked for the
keychain password, until "Always Allow", and then again after each update.
The token now lives in a file only my account can read, as the Android app
keeps its own. The first launch of the new build moves it out of the Keychain
and deletes the Keychain item.

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
- **The login keychain trusts an app without a team ID build by build.** It
  lists the app's code hash in the item's partition list, so each new build
  asks again, however stable the certificate. Only a team ID, which comes
  from Apple, makes that stable; a file only the account can read doesn't
  need one.

## What you need, and building it

- macOS 26 and the Command Line Tools (`xcode-select --install`).
- Xcode, for one thing only: the App Intents metadata that Shortcuts, Spotlight
  and Siri read. Without it the app builds and runs, and just isn't in Shortcuts.
- `brew install xcodegen`.
- Node, for esbuild, which bundles the engine into the app:
  `cd ../frontend && npm ci` once.

```sh
git clone git@github.com:franz-rosenzweig/dvarim.git
cd dvarim/frontend && npm ci
cd ../mac && ./build-native.sh          # build-native/Dvarim.app
cp -R build-native/Dvarim.app /Applications/ && open /Applications/Dvarim.app
```

Releases (GitHub Releases, and the Homebrew tap that installs them) are made
by `tools/release.sh`, signed with a release certificate of their own. A
local build is signed with your Apple Development identity, which carries your
name, so it's for this Mac only and never published.

`build-native.sh` compiles with `swiftc` from the Command Line Tools. It takes
the Info.plist keys and the version from `project.yml`, bundles `Native/Engine/host.js`
with the engine into `engine.js`, makes the icon from `AppIcon-1024.png`, writes
the App Intents metadata when Xcode is there, and signs. `xcodegen generate &&
open Dvarim.xcodeproj` gives the same app from Xcode; the project file it
generates isn't in git.

On first run, the window asks for the server's password. The address is in
Settings → Where (the default is in `Account.swift`; put in your own first).
The password goes to the server once and isn't kept. After that the copy fills, and the app opens
and works with no network.

## Signing, and why reminders may stay quiet

`build-native.sh` signs with an Apple Development identity if the keychain has
one, and ad hoc if it doesn't (`DVARIM_SIGN=-` asks for ad hoc, as the self-test
does). Get one by adding an Apple ID in Xcode → Settings → Accounts → Manage
Certificates → + → Apple Development; a free personal team is enough. If the
certificate won't validate ("0 valid identities found" while it's in the
keychain), the WWDR intermediate that signed it is missing: Xcode ships it at
`Contents/SharedFrameworks/DVTFoundation.framework/Versions/A/Resources/AppleWWDRCA-2030.cer`,
and `security import` of that file into the login keychain fixes it.

**Notifications need the app to live in `/Applications`.** Anywhere else,
macOS refuses the request with no prompt, whatever the signing. It asks once;
if Dvarim was ever refused, including by running from the wrong place, the
answer sticks, and only System Settings → Notifications → Dvarim changes it.
Settings → This Mac says which state it's in.

## Worth knowing before you change anything

- **The API is the contract** (`docs/API.md`). The screens ask it of the engine
  here or of the server, and draw the answers. A rule wanted in Swift belongs
  in `engine/` instead, where every device gets it.
- **Reminders arrive twice** if the server's Signal reminders are on as well as
  this Mac's. Keep one.
- **Reminder times are wall-clock times here, on the to-do's own When date.**
  The server keeps its own zone (`TZ`, see `docs/DEPLOY.md`), so its today and
  the Mac's differ for part of every day when the Mac is elsewhere; nothing here
  schedules by the Mac's today.
- **The sandbox is off**, for the socket to the server, the global hotkey and
  EventKit. Turning it on means adding `com.apple.security.network.client`.
- **Plain HTTP is allowed** (`NSAllowsArbitraryLoads` in `project.yml`), for a
  server on the tailnet. With only an HTTPS one, delete that key.
- **It builds in Swift 5 language mode** (`-swift-version 5`), with the main
  actor marked where it matters.
