# Roadmap: from a personal server to an app anyone can run

Written 2026-09-23. The plan for making Dvarim work without a server of one's
own: every device keeps its own copy, works offline, and syncs by whatever
means its owner already trusts. This file is the plan and the record of what
has been decided; `ARCHITECTURE.md` describes what exists.

## Decisions

Made on 2026-09-23. Change them here, not in passing.

| Question | Decision |
| --- | --- |
| Licence | GPL-3.0-or-later. Public on GitHub since 2026-10-20. |
| Own look | Yes, and it has one since 2026-10-20: the app icon is three paper slips, the first ticked; each list has its own earthy colour and a cut-paper icon; the accent is the tick's sage. |
| Platforms | **macOS, Android, and the Linux server's web app.** iOS, Windows and Linux desktop are blocked until the maintainer says otherwise. Nothing may be built for them; nothing may be built that rules them out. |
| Sync | Options, not one answer. The original setup — an Obsidian vault, Syncthing, and a Dvarim server at home — is one of them and must keep working at every step. A hosted sync service is wanted someday. |

## Gates

**Before any app store release**, all of these, and the list is not
negotiable piecemeal:

- its own visual identity: app icon, the sidebar's list icons and colours, the
  chrome. Done 2026-10-20;
- plain names in the interface for every feature (the + button, the When
  popover, just start typing). Done 2026-10-20;
- the Android package id `xyz.tiresia.dvarim`. Done 2026-10-20. It is a new app
  as far as Android is concerned, so plan the move of anyone's installed copy;
- a licence file. Done 2026-10-20: `LICENSE`, GPL-3.0-or-later;
- a privacy note that says what leaves the device (nothing, unless a sync
  option sends it). Done 2026-10-20, in the README;
- no personal defaults anywhere: `dvarim.tiresia.xyz` is the Mac app's default
  server and the Android build's launch address today. Still open.

**Before work on a blocked platform**: the maintainer says so, here.

## Where it stands

*(Written before phase 1; kept as the starting point. Since phase 5 the server
runs on the engine, and devices can keep their own copy: see the phases.)*

The server is the app. Parsing the Markdown, filing to-dos into Today and
Upcoming, the date grammar, repeats and reminders are Python on the server
(`backend/dvarim`). The Mac and Android apps are windows onto that server.
Offline, they show what they last saw and queue edits in an outbox — which, by
its own design, cannot file anything or read a date, because that would be a
second copy of the server's rules.

## Where it is going

```
 ┌──────────────────── every app ─────────────────────┐
 │  Svelte UI — bundled inside the app, not fetched   │
 │        │                                           │
 │  Backend interface                                 │
 │    ├─ Local  ──► engine (JavaScript)               │  parse · index · views ·
 │    └─ Remote ──► HTTP (today's path, kept)         │  dates · repeats · merge
 │        │                                           │
 │  Storage adapter, one per platform                 │
 └────────┼───────────────────────────────────────────┘
          ▼
   a folder of Markdown files on the device
          │   sync = whatever moves that folder
          ├─ theirs:   iCloud · Dropbox · Syncthing · Obsidian Sync · git
          └─ built in: WebDAV (Nextcloud, Synology…) · Dvarim Server · hosted, someday
```

**One engine.** The rules move out of Python into a JavaScript package,
`engine/`, that runs in the page, in both shells' WebViews, in Node for the
server, and in Node for its tests. Plain ES modules with JSDoc types, like the
rest of the frontend: no build step, nothing to compile on any device. Python
is retired only when the JavaScript agrees with it byte for byte.

**Sync is a folder.** Dvarim reads and writes a folder of Markdown and does not
care what moves it — the way Obsidian works, and for the same reason. For people
without a sync of their own, and for Android, where third-party folders are
awkward, there are built-in options that replicate the folder.

**Merging is per to-do.** Every to-do line carries its 🆔, so when two devices
changed the same file, the engine merges the two versions against the last
version both had seen, field by field, instead of keeping one file and losing
the other. Sync tools' conflict copies (`.sync-conflict-…`, "conflicted copy",
`name 2.md`) are merged back in and filed away, never deleted. Chosen over a
CRDT: those merge better in theory, but the Markdown would become a rendering of
a binary document and every Obsidian edit would have to be translated back in.

## Three places, one set of files

The server's web app, the Mac app and the Android app all read and write the same
Markdown, and stay in step two ways, mixable per device:

- **As now.** An app talks to the server (the Remote backend). Kept
  working throughout; nothing changes until a device is switched.
- **Each device its own copy.** The server keeps running on the vault. The Mac app
  works on the vault copy Syncthing already keeps there. Android works on a
  Syncthing folder, or — the more dependable choice on Android — syncs with
  the server directly. Everything works offline, and simultaneous edits merge per
  to-do instead of producing conflict copies that go unread.

## Phases

In order. Each leaves the daily app working; nothing switches over by itself.

| # | Phase | What | Status |
| --- | --- | --- | --- |
| 0 | Decide | the table above | done 2026-09-23 |
| 1 | Engine | port format, model, index, views, dates, repeats and ids to `engine/`; prove it against the Python with shared fixtures and a differential fuzzer (same operations, both implementations, compare every file) | done: #54 |
| 2 | Two backends | the UI's store behind a `Backend` interface; Remote = today's HTTP, Local = engine + on-device storage | done: #56 |
| 3 | Files on the device | the Mac app bundles the page and gives the engine a folder; Android through the Storage Access Framework; the web app on the server as today | done: #58 (the page), #62 (the Mac), #65 (Android); results in `mac/NEXT.md` and `android/NEXT.md` |
| 4 | Sync you can trust | per-to-do merge, conflict-copy recovery, state that merges, deterministic ids for lines typed in Obsidian, sync status in the UI, a two-device stress suite | done: #59, #60 (`docs/SYNC.md`) |
| 5 | Built-in sync | WebDAV; the server rebuilt on the engine and serving its folder for sync; Python retired | the server on the engine: #63 (live 2026-09-23), with #64; WebDAV sync, device tokens in Settings → Sync, and the Python's answers kept in `engine/test/golden/`: #67. The Python retired: #70, 2026-09-23 (`backend/` kept at the tag `python-final`). The device checks: the Mac's `sync` self-test (#71) and `tools/phone/local_check.py` on Android, each against a server of its own, with the `http` op on both. Left: the same by hand against dvarim.tiresia.xyz |
| 6 | On-device extras | reminders as local notifications; calendars from the system (EventKit, CalendarContract); widgets and Quick Entry from local data | the page's side done: the device's calendars through the bridge (#68); lists for reminders and widgets through `window.dvarim.request`. The native side: EventKit, and the badge, menu bar, Quick Entry and reminders from the page, on the Mac (#71); CalendarContract, and the widget and reminders from the page's lists kept on the phone, on Android |
| 7 | Ship | behind the store gate; first-run ("where should your to-dos live?"), import from other to-do apps, website | blocked |

## Who does what

The Linux server has no Xcode and no Android SDK, so work splits:

- **on the Linux server:** the engine, the UI, the server, the file format, every
  test that runs in Node or a browser, and notes plus conformance tests for
  whatever the native side has to do;
- **on the Mac:** the macOS shell and the Android shell — building, signing,
  installing, and running the conformance tests on real devices.

Notes for the native side go beside its code, `mac/NEXT.md` and
`android/NEXT.md`, as each phase needs something done there.
