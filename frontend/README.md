# Dvarim frontend

Svelte 5 + Vite 6 web client for Dvarim, a self-hosted task manager over Markdown
files. It talks only to the HTTP API in `docs/API.md` and is served by the backend
from `frontend/dist`.
Dependencies: `svelte`, `vite`, `@sveltejs/vite-plugin-svelte`. No UI kit, no CSS
framework, no icon library.

## Build

There is no Node on the host, so everything runs in a `node:22` container:

```sh
./build.sh              # npm install (first time) + vite build  → dist/
./build.sh --install    # force a reinstall first
```

which is shorthand for

```sh
docker run --rm -u $(id -u):$(id -g) -e HOME=/tmp -v $PWD:/app -w /app node:22 npm install
docker run --rm -u $(id -u):$(id -g) -e HOME=/tmp -v $PWD:/app -w /app node:22 npm run build
```

On a machine with Node, `npm run dev` starts Vite on :5173 and proxies `/api` to
`http://localhost:8420` (the uvicorn backend).

`public/icons/icon-192.png`, `icon-512.png` and `apple-touch-icon.png` are generated from
`icon.svg` and checked in.

## File map

```
index.html                 shell: viewport-fit, theme-color, apple-mobile-web-app meta, early theme apply
public/manifest.webmanifest PWA manifest (standalone, light tokens)
public/sw.js               service worker: precache shell, cache-first static, network-only /api
public/icons/icon.svg      app icon (rounded square, accent blue, check)
src/main.js                mounts App, registers sw.js in production
src/app.css                tokens (light/dark, copied from the mockup) + shared list/card/popover CSS
src/App.svelte             layout (sidebar | topbar / content / toolbar), view switch, global keyboard dispatcher
src/lib/api.js             one function per endpoint; JSON errors → Error(message) with .status; subscribe() = SSE with backoff
src/lib/store.svelte.js    app state ($state), refresh(), navigation, every write action, optimistic updates, undo stack, toasts, popover state
src/lib/keys.js            KEYMAP table, matchKey(event), keyLabel(id), isEditing(el)
src/lib/dates.js           date labels, deadline flag text, month grid
src/lib/icons.js           inline SVG strings from the mockup
src/components/
  Icon, Pie                 icon by name; progress pie
  Sidebar                  lists with counts/badge, areas → projects with pies, New List (Project/Area), theme menu
  Topbar                   list name (small grey + chevron on desktop, title + Back on phone)
  Toolbar                  + new, calendar = When, arrow = Move, magnifier = Quick Find
  TodoRow                  collapsed row: checkbox animation, indicators, deadline pill/flag, star/moon, repeat/bell, project subtitle
  TodoCard                 expanded editor: title, autosizing notes, checklist (add/complete/reorder/delete), footer When + tags/checklist/deadline
  TodoList                 rows with the expanded one swapped for its card
  ProjectRow, ListTitle, InlineEdit, EmptyState, EventsBlock, FilterBar, Toast
  Popover                  anchored dark popover + scrim (centred on phones)
  Menu                     ••• menus and confirm dialogs
  WhenPopover              When / Deadline popover: parse-date suggestions, static options, calendar, reminder
  MovePopover              Inbox / No List / areas / projects / headings (type to filter)
  TagPicker                tags with counts, toggle, create by typing, nested parent/child
  QuickFind                search across lists, projects, areas, tags, to-dos
src/views/                 InboxView TodayView UpcomingView AnytimeView SomedayView LogbookView TrashView ProjectView AreaView
```

## Keyboard

All bindings live in one table, `src/lib/keys.js` (`KEYMAP`), and can be changed
at runtime in Settings → Keyboard: click a shortcut to record a new one, Clear
for no shortcut at all, Default to put the original back. Overrides are stored
server-side under `settings.keymap` as `{actionId: "Mod+Shift+K" | null}`, so a
rebind on one device reaches the others. A combo already in use is reported
rather than silently stolen, with the option to take it anyway.

One trap worth remembering: the matcher reads a module-level override map, which
Svelte cannot track. Anything that *renders* a binding must read
`app.settings.keymap` instead, or it will save correctly and never redraw.

The defaults: `Mod` is ⌘ or Ctrl
(`metaKey || ctrlKey`). Letters match on the physical key so `Mod+Alt+N` works where
Alt produces a special character.

| Keys | Action |
| --- | --- |
| ⌘1 … ⌘6 | Inbox, Today, Upcoming, Anytime, Someday, Logbook |
| ⌘N | New to-do in the current list/heading, below the selection; opens the editor |
| ⇧⌘N | New heading (in a project) |
| ⌥⌘N | New project (in the current area) |
| ⌘K / ⌥⌘K | Complete (toggle) / cancel the selected to-do |
| ⌘S | When… |
| ⌘T ⌘E ⌘R ⌘O | Move to Today / This Evening / Anytime / Someday |
| ⇧⌘D | Deadline… |
| ⇧⌘M | Move to list… |
| ⇧⌘T | Tags… |
| ⇧⌘C | Add / focus checklist |
| ⇧⌘P | Convert to project |
| ⇧⌘R | Repeat… |
| ⇧⌘Y | Log completed items |
| ⌘D | Duplicate |
| ⌘F, ⇧⌘F | Quick Find |
| ↩ / Space | Open the selected to-do |
| Esc | Close popover → close editor → clear selection |
| ↑ ↓ | Move selection |
| ⌘↑ ⌘↓ | Reorder the selected to-do (POST /api/reorder) |
| ⌫ / Delete | Move to Trash |
| ⌘Z | Undo the last complete / cancel / trash / move / when / deadline (client-side inverse call) |
| any letter | Just start typing: opens Quick Find pre-filled |

In the editor, Return in the title closes the card; in a checklist item Return adds
an item, Backspace on an empty item removes it, ⌘↑/⌘↓ reorders items. Browsers reserve
⌘N/Ctrl+N (new window) in a normal tab; it works in the installed PWA, or rebind it in
`KEYMAP`.

Every one of these can be changed in Settings → Keyboard: click a shortcut, press
the new one, Esc to stop. Clear leaves an action with no key; Default puts back
what it shipped with. A combo that is already spoken for offers to move rather
than silently stealing it. Overrides live in `settings.keymap` on the server, so a
rebind on the Mac reaches the phone. Recording listens in the **capture** phase —
a bubbling listener runs after the app's own window handler, so rebinding ⌘2 used
to navigate to Today instead of recording. Modifiers print in Apple's order,
⌃⌥⇧⌘, which is what every Mac menu shows.

## Behaviour notes

- `refresh()` refetches `GET /api/state` plus the current view. It runs after every
  write and on SSE `changed` (debounced 150 ms). Completing holds refreshes for 600 ms
  so the tick animation and fade can play before the row leaves; a repeating to-do's
  `next` is inserted immediately.
- Optimistic: complete/cancel (fade), reopen, delete, reorder, when/deadline/tags,
  card edits (PATCH debounced 400 ms).
- Errors from the server (`{error}`) show as a toast; a 409 also triggers a refresh.
- Dates read Today, Tomorrow, weekday within a week, then `24 Sep`;
  deadline flags `today`/`yesterday`/`N days ago` in red, `tomorrow`, `N days`.
- Theme: system by default; the sidebar's sliders button forces light/dark
  (`data-theme` on `<html>`, remembered in `localStorage`). `prefers-reduced-motion`
  disables the card/popover animations.
- The URL follows the view: `/today`, `/project/<id>`, `/area/<id>`. A deep link or
  bookmark opens that view, the browser Back button walks the history, and "open in a
  new window" carries the current list. An unknown path falls back to the last view used
  on this device, then to Today.
- Below 720 px the sidebar is the root screen; picking a list opens it with a Back
  button; popovers are centred.
- Drag and drop is in `src/lib/dnd.svelte.js`, on pointer events rather than the
  HTML5 drag API, because the phone matters and HTML5 dragging barely exists on
  touch. A drag starts after a few pixels with a mouse and after a long press on
  touch, so clicking and scrolling still work. Reorder within a list, or drop on
  the sidebar to move, schedule, complete or trash; Upcoming days accept a drop
  to reschedule. Both the list and the sidebar auto-scroll at their edges.
  `tools/e2e_dnd.py` drives the real gestures.
- Multi-select: ⌘-click toggles one, Shift-click takes the range, ⌘A selects
  everything on screen, Shift with the arrows extends. `app.selection` stays the
  anchor the keyboard moves from and popovers open against; `app.selected` is
  everything acted on, and with one item the two agree, so every single-item
  path still works untouched. Every action, popover and drag checks the group
  first. Esc narrows a group to its anchor before clearing it, so it is never an
  accidental "lose what I just picked". `tools/e2e_multiselect.py`.

**Never point the e2e tools at the real vault.** They complete, duplicate,
create and delete. There is a guard now — `refuse_live_data()` in
`e2e_smoke.py` — because on 2026-09-20 I ran the shortcut suite against the live
data and had to restore a reordered file and delete two junk projects from git.

## Notes

A to-do's notes and a project's notes are `NotesField.svelte`, which lazily loads
`lib/notes-editor.js`: CodeMirror 6 with the Lezer Markdown parser, styled live
the way Obsidian's live preview is — the syntax is hidden except where the caret
is. It is its own chunk (about 100 KB gzipped; CodeMirror's core is most of it),
fetched when the app goes idle and cached by the service worker, and a card that
opens before it arrives shows the text as it is. If it cannot load at all the
field is the plain textarea it used to be. `@codemirror/lang-markdown` is left
out on purpose: it drags in the HTML, CSS and JavaScript languages.

Links open with a tap while the note is being read and with ⌘/Ctrl-click while
it is being written, through `openExternal()` in `lib/shell.js`, which knows
how each shell sends a link to the system browser. A task list in notes is text
in the notes, not the checklist — the file keeps them apart by escaping
(`docs/FORMAT.md`, "Markdown in notes"). `tests/notes-editor.test.js` pins the
commands; `tools/e2e_notes.py` checks the rendering, the saving and the file.

## End-to-end test

`tools/e2e_smoke.py` drives this app in a real browser over the Chrome DevTools
Protocol and then checks the Markdown files on disk, which is the only way to
prove a click reaches a file. It needs no Node and no browser on the host, only
the `docker-chrome-1` container.

```sh
# serve a throwaway copy of the data, then drive it
cp -r <your data folder> /tmp/dv-e2e && rm -rf /tmp/dv-e2e/.dvarim
docker run -d --name dv-e2e -u $(id -u) -v $PWD/..:/repo:ro -v /tmp/dv-e2e:/data \
  -e DVARIM_ROOT=/data -e DVARIM_STATIC=/repo/frontend/dist -e DVARIM_AUTH_FILE=/tmp/auth.json \
  -p 172.19.0.1:8422:8420 node:22-alpine node /repo/server/src/main.js
docker exec -d docker-chrome-1 chromium-browser --headless=new --no-sandbox \
  --disable-gpu --disable-dev-shm-usage --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 about:blank
tools/e2e_smoke.py --url http://172.19.0.1:8422 --root /tmp/dv-e2e
```

It covers: boot, deep links, completing and reopening a to-do (and the resulting
file lines), creating one from the toolbar, scheduling and deadlines through the
When popover, moving to a project, Quick Find, Settings persisting to the
server, and a file edited outside the app appearing live. Never point it at real
data: it completes, edits and moves things.

`tools/e2e_shortcuts.py` is the same idea for the keymap: it presses every
binding in `src/lib/keys.js` and asserts an observable effect, so the documented
shortcuts are the tested shortcuts. Same arguments, same warning about real data.
A binding that is listed, dispatched and dead looks identical to one that works
until something checks, which is the whole point.

`tools/e2e_settings.py` covers the Settings sheet itself: that all six tabs draw
an icon at the same size and neither icon nor label is clipped, that the sheet's
top edge does not move as you change pane, that the Keyboard pane's keys line up
in one column inside the panel, that modifiers print in Apple's order, and that
recording a shortcut takes a free combo, offers to move a taken one, and lets Esc
stop without closing the window. Every check there is for something that was once
actually broken.

`tools/e2e_local.py` and `tools/e2e_folder.py` are the app with no server behind
it (docs/ROADMAP.md, phases 2 and 3). The first switches a browser to a vault of
its own in IndexedDB and checks that it starts empty and separate, writes real
Markdown, survives a reload, and still opens and works with the server stopped. It
needs a secure context for the service worker, so it runs against a server in
`docker-chrome-1`'s network, reached as `localhost`. The second plays the Mac and
Android shells. It puts the folder bridge into the page before it loads and
answers it with `tools/bridge_sim.py` over a real folder. It checks that to-dos go
in and out of the files, that edits made elsewhere show up, that Settings → Data
works, that the storage checks pass on the folder, and that a failed save is
reported:

```sh
tools/e2e_folder.py --url http://172.19.0.1:8422 --root /tmp/dv-e2e \
    --folder /tmp/dv-folder --sim 172.19.0.1:8431
```

The suites share one browser and one server, so they must leave the server as they
found it. `e2e_local` also resets the browser in a `finally`, because the switch
to a local vault is remembered per origin. `e2e_logging` restores `logCompleted` in a `finally`, and
`e2e_shortcuts` sets the mode it needs rather than inheriting one: its Mod+K check
looks for the item in the Logbook, which only holds it straight away in
"immediately" mode. Each suite also brings its own tab to the front, because a
background tab silently drops `Input.dispatchKeyEvent`.

## API endpoints used

Read: `GET /api/state`, `/api/lists/{inbox|today|upcoming|anytime|someday|trash}`,
`/api/lists/logbook?limit=200[&before=]`, `/api/projects/{id}`, `/api/areas/{id}`,
`/api/tags`, `/api/search?q=`, `/api/settings`, `/api/stream` (SSE), `POST /api/parse-date`.

Write: `POST /api/todos`, `PATCH /api/todos/{id}`, `POST /api/todos/{id}/{complete|cancel|reopen|move|convert|duplicate|restore}`,
`DELETE /api/todos/{id}`, `POST /api/reorder`, `POST /api/projects`, `PATCH /api/projects/{id}`,
`POST /api/projects/{id}/{complete|cancel|reopen}`, `DELETE /api/projects/{id}`,
`POST /api/projects/{id}/headings`, `PATCH|DELETE /api/headings/{id}`, `POST /api/areas`,
`PATCH|DELETE /api/areas/{id}`, `POST /api/trash/empty`.

Not used yet: `GET /api/calendar` (events arrive inside Today/Upcoming), `POST /api/quick-add`
(wrapper exists in `api.js`), `PUT /api/settings`.

## TODOs where the contract was insufficient

Marked `TODO(api)` in the source.

- ~~Restore a trashed project.~~ Resolved: `POST /api/projects/{id}/restore` exists, and
  Trash project rows now have a Restore button with ⌘Z undo.
- ~~Reorder in Someday.~~ Resolved: the `someday` context exists and ⌘↑/⌘↓ works there.
  Logbook and Trash stay date-ordered; Upcoming is date-ordered
  between days and keeps a manual order within one (`upcoming:<date>`).
- ~~Heading ids contain `#`.~~ Resolved: the separator is `:` (`p7k3j9a2:Hand-back`), so
  nothing is lost to a URL fragment. The client still URL-encodes the segment.
- ~~`position` for new to-dos in a project with headings.~~ Confirmed by a backend test:
  `"bottom"` means the end of that heading, not the end of the file.
- ~~Project-level reorder ids.~~ Confirmed by a backend test: sending every id of that
  section, completed ones included, reorders it exactly and drops nothing.
- Quick Find assumes `search.lists[].id` are the list slugs (`today`, `inbox`, ...).
