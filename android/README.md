# Dvarim for Android

A Trusted Web Activity: the installed web app, in its own window, with no
browser bar. Android treats it as a real app — its own icon, its own task in the
switcher, its own notification channel — while the interface stays the one
codebase everything else uses.

What the wrapper adds that a browser tab cannot:

- **Your to-dos in a folder on the phone, with no server.** Settings → *Where
  your to-dos live* → *In a folder on this phone*: a Syncthing folder with the
  vault's Tasks in it, say. See *A folder instead of a server* below.
- **Share to Dvarim.** Share a link, a selection, anything, from any app, and it
  opens a small sheet where you can fix the wording and add a date before it
  lands. The server does the parsing, so "tomorrow 3pm #home" works there too.
- **Today on the home screen.** A widget listing today's to-dos, each with a
  checkbox that completes it where it stands — on a plane too, where the tick
  is kept on the phone and sent when there is a server again.
- **Reminders that arrive with the app closed** — a to-do's ⏰, delivered by the
  phone rather than by a browser, with a Complete button; tapping one opens the
  to-do. They can be turned off in the app's own Settings, as the Mac's can.
- **New To-Do** on the icon's long-press menu and as a quick settings tile,
  landing in the Inbox with an empty to-do already open.
- **Home-screen shortcuts** straight into Today and Inbox, on long-press.
- **Settings of its own** — which server the app talks to, whether it reminds
  at all and whether Android is letting those reminders through, and which
  build this one is. On the icon's
  long-press menu, and from the web app's own Settings → Data.
- **A real app identity**: launcher icon — themed, so it tints with the
  wallpaper — splash, recents entry, and the back button behaving as one.

## Before you build

The app must prove it belongs to the site, or Android shows a browser bar across
the top. That proof is a fingerprint of your signing key, published by the
server at `/.well-known/assetlinks.json`.

1. Make a signing key. Keep it: losing it means a new app identity.

   ```sh
   keytool -genkeypair -v -keystore android.keystore -alias dvarim \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Read its SHA-256 fingerprint.

   ```sh
   keytool -list -v -keystore android.keystore -alias dvarim | grep SHA256
   ```

3. Give it to the server and restart, so the asset links file is served.
   `DVARIM_ANDROID_PACKAGE` lives in `/srv/docker/docker-compose.yml`; the fingerprint goes
   in `/srv/docker/dvarim/dvarim.env`, which is outside git:

   ```
   DVARIM_ANDROID_FINGERPRINT=AB:CD:…          # comma-separated if more than one
   ```

   Check it: `curl https://dvarim.tiresia.xyz/.well-known/assetlinks.json`

   **Done as of 2026-09-19** for the key at `android/android.keystore`, alias
   `dvarim`. If you ever rebuild with a different key, the fingerprint here has
   to change with it or the app grows a browser bar.

## If Bubblewrap loops on the JDK

It can get stuck installing a JDK, exiting without an error and forgetting it
tried. Point it at your own instead: answer **No** to the install prompt and
give it the path from `/usr/libexec/java_home`. The Android SDK is the same
story — `brew install --cask android-commandlinetools` and hand over
`/opt/homebrew/share/android-commandlinetools`.

## If Bubblewrap dies with ENOTEMPTY

`cli ERROR ENOTEMPTY: directory not empty, rmdir '.../android/app/'` means
Finder has been in `app/` and left a `.DS_Store` behind: bubblewrap removes the
files it generated and then removes the folder, and the stray dotfile stops it —
after everything else has already gone. Nothing is lost, `app/` is generated and
git ignores it. Clear them and regenerate:

```sh
find . -name .DS_Store -delete && bubblewrap update && ./shell/apply.sh
```

`shell/apply.sh` clears them too, so in the normal loop this happens once.

## Build it

```sh
npm install -g @bubblewrap/cli
cd android
bubblewrap init --manifest https://dvarim.tiresia.xyz/manifest.webmanifest
# it will offer the values already in twa-manifest.json; keep them
./shell/apply.sh          # see "Without Chrome" — always before a build
bubblewrap build
adb install app-release-signed.apk
```

Rebuilding later, after any change to `twa-manifest.json`:

```sh
bubblewrap update && ./shell/apply.sh && bubblewrap build
```

For every other rebuild, use `./shell/release.sh` instead. `bubblewrap build`
asks for the keystore password every time, and when signing fails it prints the
whole `apksigner` command into the terminal — password included, which is how
one ended up in a chat log. `release.sh` re-applies the patches, builds, and
signs from `android/keystore.properties`, which git ignores and nothing echoes:

```sh
cp keystore.properties.example keystore.properties   # then fill in the password
./shell/release.sh
```

Without that file the build still runs and leaves the APK unsigned, which is
enough to check that something compiles. `keyPassword` defaults to
`storePassword`, since that is how the key was made — one answer to give rather
than two that can drift apart.

If a password does get out, it can be changed without touching the key, so the
app's identity and its upgrade path survive:

```sh
keytool -storepasswd -keystore android.keystore
keytool -keypasswd -keystore android.keystore -alias dvarim
```

`bubblewrap doctor` diagnoses a missing JDK or Android SDK, which it can install
for you.

If Bubblewrap is not to your taste, the same thing is a twenty-line Android
Studio project using `androidx.browser`'s `TrustedWebActivityIntentBuilder`, plus
an `ACTION_SEND` intent-filter forwarding to `/share`.

## Without Chrome

A TWA is drawn by whichever browser holds the default-browser role, and only some
browsers implement one. Firefox does not: it opens the app as an ordinary Custom
Tab, address bar and all, however correct the asset links are. On the Mac this was
built from, Android's own check reported `dvarim.tiresia.xyz: verified` while the
bar stayed, which is the giveaway — the check passed, the browser drawing it was
simply not doing TWA.

So `twa-manifest.json` sets `"fallbackType": "webview"`. When no TWA-capable
browser is the default, the app renders the site itself in Android's System
WebView: no address bar, no browser app involved, the same shape as the macOS
shell. If a TWA-capable browser is the default, it still gets a real TWA, so the
setting only ever improves matters.

Rendering the site ourselves means owning a few things the browser used to do.
Bubblewrap writes the Android project from a template, so `shell/apply.sh` puts
them back after any `init` or `update`:

```sh
./shell/apply.sh && bubblewrap build
```

What it applies:

- **`ShareActivity`** — android-browser-helper's fallback drops the shared title
  and text, so sharing would land on the start URL instead of the add screen.
  The share target is a plain GET, so this rebuilds the URL and opens it.
- **`Theme.Dvarim`** — from targetSdk 33 onwards a WebView does not ask the
  system whether it is dark: it reads `android:isLightTheme` off its activity's
  theme. Bubblewrap's is `Theme.Translucent.NoTitleBar`, which descends from the
  original dark `Theme`, so the site rendered dark on a phone in light mode and
  nothing in the web app could say otherwise. `shell/res/values/dvarim.xml` and
  its `values-night` twin are an ordinary day/night pair; Android picks, the
  activity is recreated, and the site follows the phone.
- **`CookieKeeper`** — WebView commits cookies to disk on its own schedule, so a
  sign-in followed soon after by Android killing the app can be lost. This
  flushes them whenever the app stops.
- **A `.debug` variant** — a second applicationId, so a test build can go on the
  phone beside the real app without the release signing key. It answers
  `dvarim-debug://settings` where the real app answers `dvarim://settings`: the
  two answering the same link raised an "Open with" chooser on a phone with
  both. `tools/phone/` tests the page through it on a real phone.
- **`Server`, in `LauncherActivity`** — `getLaunchingUrl` points whatever was
  asked for at the address Settings chose, and `launchTwa` renders anything but
  the built-in address in the WebView rather than as a TWA. Only the built-in
  address has an asset-links statement about it, so any other would open in
  Chrome with a bar across the top; worse, Chrome would hold the session cookie,
  and the widget, the tile and the reminders all read theirs from the WebView's.

Service workers work in the WebView, so the shell still caches. Web Push does
not, which only matters if you were counting on notifications while the app is
closed — see below.

## Checking it worked

- No address bar at the top. With the WebView fallback there should never be
  one; if a bar appears, a TWA-capable browser took the launch and its asset
  links check failed, so confirm the fingerprint matches the key you signed with.
- Light phone, light app. Switching the phone between light and dark should take
  the app with it — the web app's own Settings → Appearance still overrides.
- Share a link from your browser; Dvarim should be in the sheet, and picking it
  should open the add screen pre-filled.
- Long-press the icon; New To-Do, Today, Inbox and Settings should be there.
- Long-press the home screen, add the Dvarim widget, and tick something off from
  it; the app should agree next time you open it.
- Give a to-do a ⏰ a couple of minutes out and lock the phone.

## The native pieces

Four things a web page cannot do on Android, all in `shell/src`, all signed in
by the same session cookie the WebView already holds — there is no second
credential to manage, and they sign out when the app does.

- **The Today widget** (`TodayWidget`, `TodayWidgetService`) reads
  `GET /api/lists/today` and draws it. The checkbox posts
  `/api/todos/{id}/complete` from the home screen, or keeps the tick (`Outbox`)
  when the server cannot be reached; the rest of a row opens that to-do
  (`/todo/{id}`, which the web app reads as "open it where it lives").
  Android will not refresh a widget more than every half hour, so the arrow in
  its corner refetches, and so does completing something or opening the app.
- **Reminders** (`Reminders`, `ReminderReceiver`, `BootReceiver`) put a to-do's
  ⏰ on AlarmManager. The list is re-read hourly, on launch, and after a reboot,
  which clears every alarm the system was holding. A reminder missed while the
  phone was off still arrives, up to six hours late; older than that it is
  dropped rather than shown at the wrong time of day.

  Time is the subtle part: `"15:00"` against the to-do's own When date means
  three in the afternoon **where you are**, so the two are combined in the
  phone's timezone and never in the server's, which runs on America/Phoenix.

  Android asks about notifications the first time the app opens. For a reminder
  on the dot rather than within a few minutes, Android 12 and up also want
  **Alarms & reminders** enabled under the app's settings — without it the alarm
  still arrives, just inexactly, so this is worth doing and not worth nagging
  about. The server's Signal reminders, if configured, are unaffected: this is a
  second delivery, not a replacement, which is why Settings can turn it off.

  A reminder's Complete button goes through the same `Outbox` as the widget's
  checkbox; tapping the reminder opens the to-do it is about.
- **New To-Do** (`NewTodoTile`, and a third home-screen shortcut) opens
  `GET /new`, which the web app reads as "Inbox, with an empty to-do open and
  its title selected". Add the tile from the pencil at the bottom of the shade.

- **Settings** (`SettingsActivity`, `Server`) is the shell's own screen, for the
  questions the page cannot answer about itself.

  **Which server.** The web app addresses its API relatively — `/api/…` against
  whatever served the page — so it cannot move itself: the screen that would
  change the address is one the old server has to be reachable to serve. So the
  address lives out here, in `Server.java`, and the window, the widget, the tile
  and the reminders all take it from there. It has to be https:
  android-browser-helper's `WebViewFallbackActivity` throws `launchUrl scheme
  must be 'https'` out of its own `onCreate`, so an http address would save
  cleanly and then crash the app every time it opened. A server indoors needs a
  certificate — a local CA, or a tunnel that brings one — before this app can be
  pointed at it.

  There are two ways in, and the first is why there are two: **Settings** on the
  icon's long-press menu works with the server unreachable, which is the case
  this screen exists for. The other is a link in the web app's own Settings →
  Data, a `dvarim://settings` URL, which the WebView hands to the system like
  any other navigation off the page's own origin.

  **Notifications** says whether Android is letting them through, links to its
  own screens for both permissions, and sends a test one — every part of the
  path from an alarm to the shade is somebody else's to allow, and the only
  other way to find out that one of them is off is to miss a reminder.

  **About** gives the version and the address in use, which matters more than it
  sounds on a phone carrying a release, a test build and an app-cloning
  profile's copy of either, all under the same icon.

**Offline** is the web app's to handle, and it does: every list is kept as it
arrives (`frontend/src/lib/offline.js`) and shown from that copy when the server
cannot be reached, with a strip saying how old it is; every edit made
meanwhile waits in an outbox (`lib/outbox.js`) and is sent, in order, when it
answers again — including a line shared into the app from somewhere else,
which the server parses once it has it.
The native pieces keep what they can. A tick on the widget or on a reminder is
kept on the phone (`Outbox`, the same idea as the Mac's) and sent when the app
opens, when the reminders re-read the list, when the widget refreshes, or as
soon as there is a network again (`OutboxJob`), filed under the day it was
ticked. What they cannot do is read: the widget says "Can't reach the server"
rather than pretending the day is clear, and a reminder set on the plane rings
once the phone has synced and re-read the list.

A test build's native pieces talk to the development server its `DevActivity`
is showing (`DevBuild.server`), not to the address in `Server.java`, which would
have a tick on a test build's widget complete a real to-do while its window
showed sample data.

## A folder instead of a server

Settings → *Where your to-dos live* has two choices, and the server is the one
anyone gets who does nothing. *In a folder on this phone* opens Android's own
folder picker; the grant it gives is kept (`Folder`), so the choice survives a
reboot, and going back to it later needs no picker.

In a folder the app is not the Trusted Web Activity. A page Chrome draws cannot
be given a JavaScript interface or served from the APK, and neither can
android-browser-helper's WebView fallback. So the launcher hands over to
`FolderActivity` — a plain WebView serving the web app from `assets/web/` at
`https://appassets.androidplatform.net/` — and `FolderBridge` answers the page's
reads and writes from the folder through the Storage Access Framework
(`docs/BRIDGE.md`). The share sheet hands over the same way, and the tile, the
widget and the reminders reach it through the launcher.

**The rest of the app works on the folder too** (phase 6). Only the page can
turn the folder's Markdown into lists, and with the app closed there is no
page. So `FolderActivity` keeps the page's Today and Upcoming on the phone
(`Local`) when the page comes up and every time it says the vault changed (op
`changed`). The widget and the reminders read that copy:
- reminders are set for every ⏰ in it, today's and the days ahead;
- after midnight, Today is rebuilt from what was left in it plus Upcoming's
  items for the days since.

A tick from the widget or a reminder's Complete waits in `Outbox`. The page
makes it when the app is next open, at once if it is open. With the app closed,
the widget and the reminders show what the folder held when the app was last
open.

**Sync without Syncthing** (phase 5). On a folder no other tool syncs, the
page's Settings → Sync can keep it in step with a Dvarim server (a device token
from the server's own Settings → Sync → *Add a device*) or another WebDAV
server. The app makes those requests for the page, the op `http`
(`ShellHttp`, on OkHttp, since `HttpURLConnection` refuses `PROPFIND` and
`MKCOL`): no cookies, no redirects, 30 seconds, and plain http only to the
phone, the local network or the tailnet. So a server that answers no page from
elsewhere, like Nextcloud, is reachable too. The token is kept in the page's
storage for now; the Android Keystore is the better home, later.

**The phone's calendars.** The page asks the app for them (ops `calendars` and
`events`, `DeviceCalendars`, from CalendarContract's instances), and their
events show in Today and Upcoming; Settings → Calendar lists them to choose
from. Nothing is asked until they are turned on there (*Show this device's
calendars*); Android asks for `READ_CALENDAR` then, once. A refusal is changed
in Settings → Apps → Dvarim → Permissions.

Worth knowing:

- **SAF is slow and has no atomic replace.** A file is rewritten in place and
  its size checked afterwards; a write that went short is reported, never
  trusted. A rescan of the real Tasks folder (52 notes) takes about half a
  second, and the page does one every 15 s while in front, and on coming back.
  Syncthing's changes arrive that way: document providers say nothing when a
  file changes.
- **Back is the page's.** `FolderActivity` opts out of the system's own Back
  (`enableOnBackInvokedCallback="false"`, as the fallback activity does), and
  then asks the page how deep it is (`history.state.depth`) rather than
  `WebView.canGoBack()`, which Chromium answers "no" for entries a page added
  before anyone touched it.
- **Without `frontend/dist`** when `apply.sh` runs there is no web app in the
  APK, and no folder mode: Settings says so and the app opens the server.

`tools/phone/folder_check.py` drives all of it on a phone: the picker, the
conformance checks, the files, Syncthing-style writes, a share, New To-Do,
Back, a turn sideways, *Use a server instead…* and a lost grant.
`tools/phone/local_check.py` checks phases 5 and 6 against a Dvarim server on
this Mac, on a copy of `sample-vault/`, and a new, empty folder on the phone.
It covers:
- the sync, both ways, through the app's `http` op;
- a change made while the server is down;
- a revoked token;
- the kept lists, and a reminder set from them;
- a widget tick with the app closed, made by the page on the next open;
- the calendars, from a file standing in for them in a test build, and the
  permission being asked for.

## Signing in

The app opens the same site, so it uses the same password and the same 30-day
session cookie, kept in the app's own store rather than any browser's. Sign in
once on the phone and it stays signed in — `CookieKeeper` writes the cookie out
whenever the app stops, so being killed in the background does not undo it.
