# Architecture

What exists. Where it is going — every device with its own copy, offline, and
sync by whatever its owner trusts — is `ROADMAP.md`.

```
 Obsidian / Syncthing / any editor                Mac (Safari "Add to Dock")
        │  edits .md files                         Android (Chrome "Add to Home Screen")
        ▼                                                     │  HTTPS over Tailscale
 ┌────────────────────┐   fs.watch    ┌─────────────────┐     ▼
 │  <root>/ *.md      │ ────────────▶ │  indexer         │  ┌──────────────────────┐
 │  (canonical data)  │ ◀──────────── │  parse/serialize │  │ Svelte PWA (static)  │
 └────────────────────┘   atomic write│  in-memory index │  │ served by the API    │
                                      └────────┬────────┘  └──────────┬───────────┘
                                               │ query/mutate         │ JSON + SSE
                                      ┌────────▼────────────────────────▼───────────┐
                                      │  server/  /api/*   (one container, Node)    │
                                      │  engine/  the rules: format, lists, dates,  │
                                      │           repeats, merge (also in the page) │
                                      │  caldav.js Radicale events in, VTODO out    │
                                      │  notify.js reminders → Signal               │
                                      └─────────────────────────────────────────────┘
                                                 ▲                   ▲
                                        Signal bot, scripts     Radicale (CalDAV)
                                        POST /api/quick-add     home, work, ... calendars
```

## Layers

**Files** (`docs/FORMAT.md`). The only durable state. Root folder is configured
with `DVARIM_ROOT`; the default for development is `./data`, the intended
production value is a folder inside the Obsidian vault so Syncthing carries
the files to every device and Obsidian can read and edit them.

**Indexer** (`engine/src/store.js`, `mdformat.js`). Parses every area and
project file into `TaskFile` → `Section` → `Todo` records and keeps them in an
in-memory index keyed by id (a few thousand to-dos parse in well under a
second, so a persistent SQLite index is not worth its moving parts; it can be
added behind the same `Store` interface if the folder ever grows past that). Every mutation goes file-first: load the file, apply the change to the
parsed model, serialize, atomic-write, then update the index rows for that
file. A watcher (`server/src/watcher.js`) re-reads files changed by others
(debounced, and every few seconds anyway) and takes them as they are. It
merges back the conflict copies a sync tool leaves (`docs/SYNC.md`).

**API** (`engine/src/api.js`, served by `server/src/app.js`). The same router
answers in the page in local mode. Reads are views over the index; writes go
through the store and are on disk before the answer. `GET /api/stream` is a Server-Sent Events stream that
emits `changed` whenever the index changes (own write or external edit) so
every open window refreshes. `POST /api/quick-add` accepts one line of text in
the quick-entry grammar ("Call the plumber tomorrow 3pm #home") for the
Signal bot and other scripts.

**Sync** (`server/src/dav.js`, `engine/src/webdav.js`). The server offers its
folder over WebDAV at `/dav/`, answered from the store, to devices that keep a
vault of their own. Each one syncs with it by itself, merging against the
version both last agreed on (`docs/SYNC.md`, "Built-in sync").

**Frontend** (`frontend/`). Svelte 5 + Vite, built to static files that the API
serves at `/`. PWA manifest and a service worker for the app shell (icons,
fonts, code) so it opens instantly; data is live from the API, and every list
is kept as it arrives so the app still shows it — saying how old it is — when
the server cannot be reached (`lib/offline.js`). Every edit made meanwhile
waits in an outbox and is sent, in order, when it answers again
(`lib/outbox.js`): each is the one API
call it would have been, so it lands on whatever the thing has become and
changes only the fields it names. Anything made offline is made under an id
the page mints in the server's own shape, which the server accepts, and a
completion carries the day it was ticked rather than the day it was sent.
Quick Add is the one thing the page cannot do itself — the quick-entry grammar
is the server's — so what was typed is queued as typed and the row shows the raw
line until the server has parsed it. Keyboard-first: every shortcut, and how
to change it, is in `docs/quick-entry.md`.

Since October 2026 that is the page's fallback (`?backend=server`). By
default the server's page keeps a full copy of the person's vault in the
browser, answers every list and change from it with the engine, and syncs it
with the server over `/dav/` (`lib/backend.js`, `docs/SYNC.md`, "The mirror").
The Mac and Android apps do the same in a folder of their own, synced by a
device token (`docs/BRIDGE.md`, "Copy").

**Integrations** (phase 2 and 3):

- *Calendar in*: `server/src/caldav.js` fetches VEVENTs from chosen Radicale calendars for
  the visible date range and the API merges them into Today and Upcoming.
  Read-only. Credentials in `.env`.
- *Tasks out*: to-dos with a When or Deadline are mirrored as VTODO into a
  dedicated `dvarim` collection on Radicale so Tasks.org or any CalDAV client
  can see and complete them; completions and date changes are pulled back by
  polling ETags. The files stay canonical.
- *Reminders*: `⏰` times fire a Signal message through the existing signal-api
  container (cheap, reliable, already on the phone) and, later, Web Push.
- *Quick-add*: the Signal bot forwards any message prefixed with a marker to
  `/api/quick-add`; a morning-brief script reads `/api/lists/today`.

## Deployment

One image built with a two-stage Dockerfile (node:22 builds the frontend,
python:3-alpine runs the API). Added as a service in `/srv/docker/docker-compose.yml`
with the data folder bind-mounted, and fronted by Caddy like the other services.
Reachable only over Tailscale, so no auth layer of its own in v1; a Caddy
`basic_auth` block can be added like the homepage's.

## Phases

1. **Core** — format parser and serializer with round-trip tests; indexer;
   API for lists, projects, areas, to-do CRUD, complete/cancel, move, reorder,
   tags, search, quick-add with natural-language dates; frontend with sidebar,
   all fixed lists, project and area views, to-do expansion editor, Quick Find,
   the When date popover, keyboard shortcuts; Docker + Caddy.
2. **Feel** — drag and drop (reorder, move to sidebar, drag to Upcoming day,
   the + button), headings management, checklists, repeats, multi-select and
   batch edit, Logbook grouping and logging setting, Trash, progress pies,
   project completion flows, filter bar by tag, calendar events from Radicale,
   Signal quick-add and reminders.
3. **Reach** — VTODO mirror to Radicale, Web Push, Obsidian block-id links and a
   companion Obsidian command palette, import from other to-do apps.

## Native apps

The web app is the product, and the API is the contract every app speaks. The
Android app is a shell around the page plus the few things a browser cannot do;
the Mac app draws its own screens and asks the same engine. Neither
re-implements a list. Building them needs a Mac (Xcode) and an Android SDK, so
that work happens on those machines, not on this server.

**macOS**, in `mac/`: a native app, SwiftUI and AppKit for every screen, with
the engine running inside it in JavaScriptCore (`Native/EngineHost.swift`), on a
copy synced with the server, on a folder, or asking the server itself. It draws
what the API answers and re-implements no rule. Beside the window: Quick Entry
on a global hotkey (Carbon's `RegisterEventHotKey`, which needs no
Accessibility permission), Today in the menu bar, a Dock badge, native reminder
notifications, several windows, the Services menu, and App Intents for
Shortcuts, Spotlight and Siri. What those save while the server can't be
reached waits on the Mac (`Native/Shell/Outbox.swift`). `mac/build-native.sh`
builds it with the Command Line Tools and `mac/selftest-native.sh` drives the
built app against a throwaway server. `mac/README.md` has the details.

**Android**, in `android/`: a Trusted Web Activity generated by Bubblewrap, with
Android's own WebView as the fallback — which, on a phone where no browser
implements TWAs, is what always runs. `android/shell/` holds everything that is
ours and `shell/apply.sh` puts it back after Bubblewrap regenerates the project:
a share target (`ShareActivity`, which builds the web app's `GET /share`), a
Today widget, a quick-settings tile for New To-Do, reminders through
`AlarmManager` rather than Web Push (there is no Chrome to deliver it), and a
settings screen of its own for the server address, notifications and the
build. `android/README.md` has the details; `tools/phone/` tests the page on a real
phone, gestures and offline both.

**What to carry to those machines**: `docs/API.md` (the entire contract),
`docs/what-is-dvarim.md` (what works where, so a shell does not re-implement
what the web app already does), and the server's address.
