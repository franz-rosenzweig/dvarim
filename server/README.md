# server/

The Dvarim server, on the engine: what `backend/dvarim` was, in Node, with no
dependencies. Phase 5 of `docs/ROADMAP.md`.

The engine's router (`engine/src/api.js`) answers every route the app calls,
and so does the page in local mode. What only a server does lives here:

| module | what | was |
| --- | --- | --- |
| `app.js` | HTTP: signing in, refusing other sites, the event stream, the app's files, asset links | `api.py` |
| `auth.js` | password (scrypt), session cookies (HMAC), tokens for bots and devices, back-off; `auth.json` re-read when the command line changes it | `auth.py` |
| `dav.js` | the folder over WebDAV for the built-in sync (`docs/SYNC.md`), answered from the store | new in phase 5 |
| `watcher.js` | the folder watched; lines typed without an id named; reminders ticked | `watcher.py` |
| `notify.js` | reminders over Signal | `notify.py` |
| `caldav.js`, `ical.js`, `rrule.js`, `tz.js` (and `engine/src/xml.js`) | calendar events from CalDAV, repeats as dateutil reads them | `calendar.py` + dateutil |
| `vtodo.js`, `tasksync.js` | the two-way to-do mirror to a CalDAV collection | `vtodo.py`, `tasksync.py` |
| `cli.js` | set the password, mint bot tokens | `cli.py` |
| `main.js` | start it all from the environment | `api.py`'s lifespan |

It reads the same environment (`main.js` lists it), the same `auth.json`
(nobody is signed out by the move), the same `.dvarim/vtodo.json` (the mirror's
first cycle writes nothing).

```sh
node server/src/main.js                      # DVARIM_ROOT=… PORT=8420
node server/src/cli.js set-password
```

## Proved, not only tested

Each module was held to the Python it replaced through `tools/parity/oracle.py`,
and still is: the Python's answers are kept in `engine/test/golden/` and
replayed (`engine/README.md`). The Python itself is at the git tag
`python-final`.

- **`test/rrule.parity.test.js`**: generated RRULEs against dateutil. That
  includes every frequency, the BY parts together, ordinals, set positions,
  week numbers, counts, UNTIL as a date and as an instant, zones with daylight
  saving, and malformed rules. Over 100,000 occurrences agree across seeds.
- **`test/calendar.parity.test.js`**: generated calendars into the rows Today
  and Upcoming show. They cover all-day, multi-day, TZID, UTC and floating
  times, the nights the clocks change, exceptions, moved occurrences,
  cancellations, folding and broken dates.
- **`test/tasksync.parity.test.js`**: random sessions of work, of edits in
  another CalDAV app and of sync cycles, through both mirrors. Every answer,
  file, collection item and the mirror's state must match.
- **`test/modules.parity.test.js`**:
  - VTODO both ways, and the merge of what a CalDAV app changed;
  - the mirror's content hash;
  - passwords and cookies, passed between the two in both directions;
  - CalDAV's XML;
  - the reminder text.
- **`test/server.test.js`**: the HTTP layer itself.
- **`test/dav.test.js`**: WebDAV and the built-in sync: who may in, what is
  offered, conditional writes, and two devices and the server in step (with a
  fuzzer).
- **`test/events.test.js`**: a device's own calendar events make the rows the
  server's CalDAV ones do, over generated events.

Planted faults fail each suite. All of them run in the deploy's gate
(`tools/test-gate.sh`), the parity suites on the recorded answers.

## One deliberate difference

A calendar event whose repeat rule has `INTERVAL=0` and no `COUNT` (RFC 5545
forbids it) made dateutil loop for ever or fail the whole fetch. Here that one
event is dropped.
