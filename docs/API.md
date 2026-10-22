# Dvarim HTTP API (v1)

Base path `/api`. JSON in and out. Dates are `YYYY-MM-DD` strings in the server's
local zone (`TZ` env, default `Asia/Jerusalem`); times are `HH:MM` 24-hour. Ids are
8-char base36 strings. Every endpoint but the three under *Sign in* needs a
credential once a password is set.

## Objects

```jsonc
// Todo
{
  "id": "a1b2c3d4",
  "title": "Send the draft to the board with questions",
  "notes": "Markdown text, may be empty",
  "status": "open",                 // open | done | canceled
  "inbox": false,                   // lives in Inbox.md
  "someday": false,                 // 💤
  "when": "2026-09-19",             // ⏳ or null
  "evening": false,                 // 🌙
  "reminder": "15:00",              // ⏰ or null
  "deadline": "2026-09-24",         // 📅 or null
  "repeat": "every week when done", // 🔁 or null
  "tags": ["queries"],
  "checklist": [{"text": "Rice", "done": false}],
  "created": "2026-09-19",          // ➕
  "completed": null,                // ✅ or ❌ date
  "projectId": "p7k3j9a2", "projectName": "Annual report",
  "areaId": "a5m6n7o8",  "areaName": "Work",
  "headingId": "p7k3j9a2:Hand-in", "headingName": "Hand-in",
  "index": 3,                       // position within its container (file order)
  "todayIndex": 1,                  // position in Today when applicable
  "file": "Areas/Work/Annual report.md",
  "line": 27
}
// Project
{ "id", "name", "notes", "status", "when", "evening", "someday", "deadline", "repeat",
  "tags", "created", "completed", "areaId", "areaName", "progress": 0.45,
  "openCount": 6, "doneCount": 5, "headings": [{"id","name","archived"}], "file" }   // heading id = "<projectId>:<heading name>"; URL-encode it in paths
// Area
{ "id", "name", "notes", "tags", "file", "projects": [Project], "openCount" }
// CalendarEvent (phase 2; empty until Radicale is configured)
{ "date": "2026-09-19", "allDay": true, "time": null, "end": null, "title": "Street festival",
  "calendar": "holidays", "color": "#4CB35B" }
```

## Sign in

A password (`node server/src/cli.js set-password`) turns authentication on; without
one the server is open, which is right on a tailnet and wrong on the internet.
Two ways in: a browser signs in and gets a session cookie, a program carries a
bearer token. These three are the only endpoints that work signed out.

| Method & path | Body | Returns |
| --- | --- | --- |
| `GET /api/health` | | `{ ok:true }` — reachability, no credential needed |
| `GET /api/auth` | | `{ required, authenticated, person?, requests? }` — whether a login is needed, and whether this request has one; with a password set, `person: { name, owner }` says whose (`docs/PEOPLE.md`), and for the owner `requests` how many people are waiting for an answer |
| `POST /api/login` | `{ name?, password }` | `{ authenticated:true, required, person }` and sets `dvarim_session`: HttpOnly, SameSite=Strict, Secure over HTTPS, 30 days. A name someone has signs in as them; no name, the owner's, or one nobody has, as the owner. `401 {error}` with `Retry-After` when wrong, `429` once three failures from one address have earned a lockout |
| `GET /api/join/{code}` | | `{ ok, note, expires }` if the invitation is still good, else `404` |
| `GET /api/requests` | | `{ open }`: whether this server takes requests for an account (a password is set, and there is a folder for other people) |
| `POST /api/requests` | `{ name, email, message?, website? }` | `{ ok:true }`. Kept in `requests.json` beside `auth.json` for the owner. `website` is a field people never see: filled in, the answer is the same and nothing is kept. `400` for a missing name or an odd email, `429` after 3 from one address in a day or with 30 waiting, `404` where requests are not taken. The same email again updates its request |
| `POST /api/join` | `{ code, name, password }` | as `/api/login`, for the new person: their account, a folder of their own with the tutorial in it, and a session. `400` for a name or password that will not do, `409` for a name taken, `404` for a used or lapsed invitation |
| `POST /api/logout` | | `{ authenticated:false }`, clears the cookie |

Programs use `Authorization: Bearer dvt_…` instead of the cookie; tokens are
named, minted with `node server/src/cli.js add-token <name>` or in Settings →
Sync, stored only as hashes, and revoked individually (`docs/INTEGRATIONS.md`).
The server reads `auth.json` again when the command line changes it, so a
token made or revoked there counts at once. A native client around
the web app can also reuse the cookie the web view already holds, which is what
the macOS shell does.

Anything else without a credential answers `401 {"error":"not signed in"}`. A
state-changing request whose `Origin` header names another host answers
`403 {"error":"cross-site request refused"}`; requests with no `Origin` at all,
which is every non-browser client, are let through.

## Devices

The tokens of the devices (and bots) that sync with this server, for Settings →
Sync. Only a browser signed in with the password may use these; a token may
not, so no token can make another.

| Method & path | Body | Returns |
| --- | --- | --- |
| `GET /api/tokens` | | `{ tokens: [{ name, created }] }`, no hashes |
| `POST /api/tokens` | `{ name }` | `{ name, token }`, the token shown this once. `409` if the name is taken, `400` if it is empty or odd |
| `DELETE /api/tokens/{name}` | | `{ removed }`; the token stops working at once |

## People

Other people on the owner's server (`docs/PEOPLE.md`). Every request goes to
the folder of whoever made it, the lists, the event stream, the tokens above
and `/dav/` alike; these are the owner's alone, signed in with the password.

| Method & path | Body | Returns |
| --- | --- | --- |
| `GET /api/people` | | `{ enabled, reason?, owner: { name, owner }, people: [{ name, display, created }], invites: [{ id, note, created, expires }], requests: [{ id, name, email, message, created }] }` |
| `POST /api/people/requests/{id}/invite` | | as an invitation below, in the asker's name, with their `name` and `email`; the request goes |
| `DELETE /api/people/requests/{id}` | | `{ removed }`: dismissed, and nobody is told |
| `PUT /api/people/owner` | `{ name }` | the owner's sign-in name, which nobody else may then take; empty clears it |
| `POST /api/people/invites` | `{ note? }` | `{ id, code, expires, link }`, the link shown this once: it works once, for 7 days |
| `DELETE /api/people/invites/{id}` | | `{ removed }` |
| `POST /api/people/{name}/password` | `{ password }` | `{ ok }`: a new password to pass on, which signs them out everywhere |
| `DELETE /api/people/{name}` | | `{ removed, keptAt }`: signed out at once, their folder moved to `keptAt` under the people folder, never deleted |
| `GET /api/export` | | everyone: their own folder as `Dvarim <date>.zip` |

## The folder, over WebDAV: `/dav/`

The vault for the built-in sync (`docs/SYNC.md`, "Built-in sync"): class 1
WebDAV, answered from the store (`server/src/dav.js`).

- **Who may:** a token, as `Authorization: Bearer dvt_…` or as Basic auth's
  password under any user name; or this site's own session cookie, from this
  site's pages only. Never the account password. Without one: `401` with
  `WWW-Authenticate: Basic`.
- **Other origins:** every answer carries `Access-Control-Allow-Origin: *`,
  and preflights are answered without a credential. No cookie is taken from
  another site's page, so a page elsewhere gets nothing without a token.
- **What is there:** every note the app reads, plus `.dvarim/state.json` and
  `.dvarim/stamps.json`. Nothing else is listed, served or accepted.

| Method | What |
| --- | --- |
| `OPTIONS` | `DAV: 1` |
| `PROPFIND` | `Depth: 0`, `1` or `infinity`: `resourcetype`, `getetag`, `getcontentlength`, `getcontenttype`, `displayname` |
| `GET`, `HEAD` | the file, with `ETag` (its SHA-1) |
| `PUT` | `If-Match: <etag>` or `If-None-Match: *`; `412` if the file is not that version any more. `201` new, `204` replaced. The answer carries an `ETag` only if the file is kept exactly as sent |
| `DELETE` | a note, with `If-Match`; `403` for a folder or a state file |
| `MKCOL` | a folder notes can go in; `405` if it is there |

`LOCK`, `MOVE` and `COPY` are not offered (`405`): a sync needs none of them.

## Read

| Method & path | Returns |
| --- | --- |
| `GET /api/state` | `{ today, counts:{inbox, today, todayDeadlines}, areas:[Area], looseProjects:[Project], tags:[{name,count}] }` — everything the sidebar needs |
| `GET /api/lists/inbox` | `{ items:[Todo] }` |
| `GET /api/lists/today` | `{ events:[CalendarEvent], items:[Todo], headings? }` — items ordered by todayIndex; evening items carry `evening:true`. `headings: [{ id, name, todos:[ids] }]`, Today's own in order, with which of today's items are under each, is there only when there are any |
| `GET /api/lists/upcoming` | `{ days:[{ date, events:[CalendarEvent], items:[Todo] }] }` — one entry per date that has anything, ascending, next 12 months. An item appears on its When, or on its Deadline when it has no When, or on its next repeat date |
| `GET /api/lists/anytime` | `{ items:[Todo], groups:[{ project:Project | null, area:Area | null, items:[Todo] }] }` — `items` are loose to-dos; groups follow sidebar order |
| `GET /api/lists/someday` | `{ items:[Todo], projects:[Project] }` |
| `GET /api/lists/logbook?limit=200&before=YYYY-MM-DD` | `{ groups:[{ date, items:[Todo], projects:[Project] }] }` newest first |
| `GET /api/lists/trash` | `{ items:[Todo], projects:[Project] }` |
| `GET /api/lists/tomorrow` | `{ date, events, items, projects }` — a list reached only through Quick Find |
| `GET /api/lists/deadlines` | `{ items:[Todo], projects:[Project] }` sorted by deadline, past ones included |
| `GET /api/lists/repeating` | `{ items:[Todo], projects:[Project] }` sorted by next occurrence |
| `GET /api/lists/projects` / `logged-projects` | `{ projects:[Project] }` all open / all completed-or-canceled |
| `GET /api/calendars` | `{ configured, calendars:[{name,color,components}] }` from the CalDAV server |
| `GET /api/reminders/log` | `{ configured, log:[...] }` last 50 reminder deliveries |
| `GET /api/projects/{id}` | `{ project:Project, items:[Todo] }` — items include done ones (`status`), client decides to show |
| `GET /api/areas/{id}` | `{ area:Area, items:[Todo] }` — loose to-dos in the area |
| `GET /api/tags` | `[{ name, count }]` including nested names like `work/client` |
| `GET /api/search?q=text` | `{ lists:[{id,name}], projects:[Project], areas:[Area], tags:[{name,count}], todos:[Todo] }` for Quick Find; case-insensitive substring; `#tag` narrows to tags |
| `GET /api/calendar?from=&to=` | `[CalendarEvent]` |
| `GET /api/stream` | Server-Sent Events. `event: changed` with `data: {"files":[...]}` after any index change. Clients refetch what they show |
| `POST /api/parse-repeat` `{ repeat, when? }` | `{ ok, repeat, describes, next:[4 dates], whenDone }` or `{ ok:false, error }`. The repeat editor builds a sentence and asks here rather than working the dates out itself |
| `POST /api/parse-date` `{ text }` | `[{ label, when, evening, someday, reminder }]` the When popover's suggestions for natural-language input (e.g. "tom", "sat 8pm", "in 3 days", "oct 2", "someday") |

## Write

Every write returns the affected object(s) and emits `changed` on the stream.

| Method & path | Body | Returns |
| --- | --- | --- |
| `POST /api/todos` | `{ id?, title, notes?, inbox?, someday?, projectId?, areaId?, headingId?, when?, evening?, reminder?, deadline?, tags?, checklist?, repeat?, position?: "top" \| "bottom" \| {"after": id} }` | `Todo` — with none of inbox/projectId/areaId, lands in Standalone.md. `id` (8 of `0-9a-z`) lets a client name the to-do itself — the web app mints one for a to-do made offline so it can keep editing it before the server has heard of it; if that id already exists the to-do is returned as it is, so a replay after a half-finished sync makes no second copy |
| `GET /api/todos/{id}` | — | `Todo`, wherever it lives; 404 if there is none. What a reminder opens |
| `PATCH /api/todos/{id}` | any subset of `title, notes, when (null clears), evening, someday, reminder, deadline, repeat, tags, checklist` | `Todo` |
| `POST /api/todos/{id}/complete` | `{ on? }` | `{ todo:Todo, next:Todo \| null }` — `next` is the new instance of a repeating to-do. `on` (`YYYY-MM-DD`, never in the future) is the day it was ticked, for a client sending one it kept while offline; without it, today |
| `POST /api/todos/{id}/cancel` | `{ on? }` | `Todo` — `on` as for complete |
| `POST /api/todos/{id}/reopen` | `{}` | `Todo` |
| `POST /api/todos/{id}/move` | `{ inbox?:true } \| { standalone?:true } \| { projectId, headingId? } \| { areaId }` plus optional `position` | `Todo` |
| `POST /api/todos/{id}/convert` | `{ id?, checklist?:[ids] }` | `Project` — to-do becomes a project; checklist items become to-dos. `id` names the project and `checklist` names those to-dos in order, so a conversion made offline keeps its ids; if the project already exists it is returned as it is, the source to-do having gone |
| `POST /api/todos/{id}/duplicate` | `{ id? }` | `Todo` — `id` names the copy, the same rule |
| `DELETE /api/todos/{id}` | | `Todo` (now in Trash.md) |
| `POST /api/todos/{id}/restore` | | `Todo` |
| `POST /api/reorder` | `{ context: "today" \| "anytime" \| "someday" \| "inbox" \| "standalone" \| "project:<id>" \| "heading:<id>" \| "area:<id>" \| "areas" \| "projects:<areaId>", ids:[...] }` | `{ ok:true }` — ids in new order. `today`, `anytime`, `someday` and `upcoming:<YYYY-MM-DD>` are view state; the rest rewrite the file. Send every id of the section, completed ones included. A day in Upcoming gathers to-dos from every file, so its order cannot be the file's: ids it does not name keep file order behind those it does, and orders for days now past are dropped when any of them is written. Logbook and Trash are date-ordered and cannot be reordered |
| `POST /api/quick-add` | `{ text, notes?, id?, list?: "inbox" \| "today" }` | `Todo` — the quick-entry grammar: trailing date words, `#tags`, `!` for deadline marker (`!fri`), `@time`; default list is Inbox. `notes` is kept as written, for a capture that brought more than a line. `id` names the to-do, so a line typed offline keeps its id when the server parses it |
| `POST /api/projects` | `{ id?, name, areaId?, notes?, when?, deadline?, someday?, tags? }` | `Project` — `id` (`p` + 7 of `0-9a-z`) as for to-dos: a client may name it, and an id that exists is answered with the project as it is |
| `PATCH /api/projects/{id}` | `{ name?, notes?, when?, evening?, someday?, deadline?, repeat?, tags?, areaId? (null = no area) }` | `Project` |
| `POST /api/projects/{id}/complete` | `{ completeOpenTodos?: bool }` | `Project` — the app asks first whether the open to-dos should be completed too |
| `POST /api/projects/{id}/cancel` / `reopen` | | `Project` |
| `DELETE /api/projects/{id}` | | `Project` (file moved to Trash/) |
| `POST /api/projects/{id}/restore` | | `Project` (moved back to its original folder) |
| `POST /api/projects/{id}/headings` | `{ name, position?: "top" \| {"after": todoId} \| {"before": todoId} \| {"beforeHeading": headingId} }` | `{ id, name, archived }` — id is `<projectId>:<name>`, URL-encode it in later paths. Without a position it goes last. At a to-do, the to-dos below that point in the same section come under the new heading, as typing `## Name` there in the file would have it |
| `PATCH /api/headings/{id}` | `{ name?, archived? }` | heading |
| `DELETE /api/headings/{id}` | | to-dos under it lose their heading |
| `POST /api/tutorial` | | `Project`: "Meet Dvarim" (`engine/src/tutorial.js`), the one there is while it is open and out of the Trash, else a new one with ids of its own. A vault with no notes at all starts with it |
| `POST /api/today/headings` | `{ id?, name, position?: "top" \| {"after": headingId} }` | `{ id, name, todos:[] }` — a heading of Today's own, kept in `.dvarim/state.json`. `id` is `h` + 7 of `0-9a-z`; sent again, the same heading comes back. Without a position it goes last |
| `PATCH /api/today/headings/{id}` | `{ name }` | heading |
| `DELETE /api/today/headings/{id}` | | `{ ok:true }` — its to-dos stay in Today, above the headings |
| `POST /api/today/file` | `{ ids:[...], headingId: id \| null }` | `[heading]` — those to-dos under that heading, or (null) under none. Reorder Today's headings with `POST /api/reorder` and context `today-headings` |
| `POST /api/areas` | `{ id?, name, notes?, tags? }` | `Area` — `id` (`a` + 7 of `0-9a-z`), the same rule |
| `PATCH /api/areas/{id}` | `{ name?, notes?, tags? }` | `Area` |
| `DELETE /api/areas/{id}` | | projects move to `Projects/`, loose to-dos to Standalone.md, the area's note is deleted. Anything else in its folder (images, other notes) is never deleted: the folder moves to `Trash/<name>` and `{ok, kept}` says where; `kept` is null when the folder was empty |
| `GET /api/logbook/pending` | `{ pending, mode }` — completions still sitting in their lists |
| `POST /api/logbook/log-now` `{ cutoff? }` | files everything completed on or before `cutoff` (sets `logCutoff`), today by default; a client sends the day it was asked for |
| `POST /api/trash/empty` | | `{ ok:true }` |
| `GET /api/file?path=<vault-relative.md>` | `{ path, text, sha, kind, name, obsidian, bytes }` — the raw Markdown behind a project or area |
| `PUT /api/file?path=…` `{ text, sha? }` | `{ path, sha, kind, todos, warning }`. `sha` is what the editor loaded: if the file moved on since, nothing is written and 409 carries the current text back. Guarded to .md files inside the data root, never `.dvarim/` |
| `GET/PUT /api/settings` | `{ logCompleted: "immediately" \| "daily" \| "manually", weekStartsOn: 0..6 (0 = Sunday), calendars:[names], eveningStartsAt: "18:00", groupTodayByList: bool, badgeCount: "today" \| "inbox" \| "none", showCalendarEvents: bool }` | settings |
| `PUT /api/view-state` | `{ collapsed:[areaIds] }` | `{ok:true}` |

Errors are `{ "error": "message" }` with 400/404, or 401/403/429 as above.
Concurrency: a write to a file
that changed on disk since the index last read it returns 409 with the fresh
object; the client refetches and retries.

## Dev

Server: `node server/src/main.js` (port 8420; `DVARIM_ROOT` for the data). Frontend dev server
proxies `/api` to `http://localhost:8420`. Production: the API serves `frontend/dist`
at `/`, with `index.html` as the SPA fallback.
