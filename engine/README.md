# engine/

Dvarim's rules — the Markdown format, the lists, dates and repeats, every
change to a to-do, project, heading or area — as plain ES modules that run in
the page, in the Mac's and Android's WebViews, and in Node. No build step and
no dependencies. It was phase 1 of `docs/ROADMAP.md`, a port of the Python
server (`backend/dvarim`, kept in git at the tag `python-final`). Now it is
what every device runs, and the server too (`server/`), so each can keep its
own copy of the vault and work offline.

| module | what | ported from |
| --- | --- | --- |
| `day.js` | calendar days as day numbers, weekdays Python's way | `datetime.date` |
| `frontmatter.js` | front matter kept exactly as written | `frontmatter.py` |
| `mdformat.js` | parse and serialize the format | `mdformat.py` |
| `dates.js` | the When popover's suggestions, quick entry | `dates.py` |
| `repeat.js` | repeat rules, with dateutil's rrule for them | `repeat.py` + dateutil |
| `store.js` | the index and every mutation | `store.py` |
| `views.js` | Today, Upcoming, Anytime, Logbook… | `views.py` |
| `api.js` | every route the app calls, answered without a server | `api.py` |
| `storage.js`, `storage-node.js`, `storage-idb.js` | the storage contract, and where the files are: memory, a Node folder, the browser's IndexedDB | — |
| `storage-bridge.js` | a folder the Mac or Android app looks after, over its message bridge (`docs/BRIDGE.md`) | — |
| `storage-conformance.js` | the contract as checks, runnable against any storage, on a device too | — |
| `merge.js` | two versions of a file made into one, to-do by to-do (`docs/SYNC.md`) | — |
| `state-merge.js` | settings and sort orders from two devices, the newer change winning key by key | — |
| `webdav.js` | the built-in sync: this vault in step with a WebDAV folder, merged against what both last agreed (`docs/SYNC.md`) | — |
| `events.js` | calendar events as rows for Today and Upcoming, from a device's own calendars too | part of `calendar.py` |
| `xml.js` | enough XML for CalDAV and WebDAV answers | ElementTree |
| `sha1.js`, `util.js`, `ids.js`, `errors.js`, `model.js` | what the rest needs | — |

## One store, any storage

The store works on its own copy of the vault in memory and is synchronous,
as the Python's is; writes go through a queue to a storage adapter, because
the bridges the apps will use are asynchronous. `await store.flush()` waits
for the queue; `await store.scanChanges()` reads what someone else changed
(Obsidian, a sync tool). A storage is seven async calls — `list`, `read`,
`write`, `remove`, `move`, `removeDir`, `mkdir` — described in `storage.js`.

```js
import { Store, MemoryStorage, views } from './src/index.js';
const store = await Store.open(new MemoryStorage({ 'Inbox.md': '- [ ] Call Dana 🆔 aa11bb22\n' }));
store.completeTodo('aa11bb22');
views.listLogbook(store);
await store.flush();
```

## A folder on a device

A native shell gives the page a folder through a message bridge: the Mac's
WebKit message handler, or Android's JavaScript interface. `storage-bridge.js`
turns those messages back into a storage, and the protocol for the shells is
`docs/BRIDGE.md`. Every storage keeps one contract, written at the top of
`storage.js`: exact text, names as written, no move over what is there, calls in
the order sent, and paths that cannot leave the folder. `storage-conformance.js`
checks it, inside a scratch folder under `.dvarim/`. `test/storage.test.js` runs
it on memory, a Node folder and the bridge over both transports, and shows it
failing on six storages that are each wrong in one way a native one could be. On
a device, Settings → Data → **Check this folder** runs the same checks.

## When two devices changed one file

`merge.js` merges three versions of a file: the one both started from, ours,
and theirs. It works to-do by to-do (matched by 🆔) and field by field, is
symmetric, and settles. The store uses it when a file changes on disk.
- If the new version was built on what this device had (an edit in Obsidian,
  say), the store takes it as it is, as always.
- If it was made alongside this device's own changes, by another device, the
  store merges.
- It also merges back the conflict copies sync tools leave, then files them
  in `.dvarim/conflicts/`.

`docs/SYNC.md` has the rules. `test/merge.test.js` fuzzes the merge, and
`test/sync.test.js` runs two stores with a simulated sync between them, both
Syncthing-style and keep-the-newer-file.

## The app on the engine (local mode)

`api.js` takes the app's requests (method, path, body) and answers them as the
server would: the same routes, statuses and error messages. The page's
`req()` (`frontend/src/lib/backend.js`) hands its requests here when this
device keeps its own vault: in the browser's IndexedDB with `?backend=local`,
or in a folder when a native shell provides a `window.dvarimStorage` bridge.
Signing in, CalDAV, the VTODO mirror and Signal reminders are server things,
and get the answers a server without them gives.

```js
const api = new Api(store);
await api.handle('POST', '/api/quick-add', { text: 'Call Dana tomorrow 3pm #work' });
// → { status: 200, body: { id, title: 'Call Dana', when: '…', reminder: '15:00', … } }
```

## Proved, not only tested

The Python was the specification until this replaced it, so the engine was
held to it answer for answer. `tools/parity/oracle.py` answered questions with
the backend's own code, and the `*.parity.test.js` suites asked both and
compared:

- **format** — the sample vault, edge cases and a seeded fuzzer built from
  every construct the format has: structure and bytes identical. 60,000
  fuzzed files and a copy of the real vault agree.
- **dates** — every prefix of 80 phrases on nine awkward days, both week
  starts, and fuzzed quick-entry lines: 22,530 answers, all alike.
- **repeat** — thousands of generated rules on awkward anchors, their
  sentence and next six dates (so, against dateutil), and "advance".
- **store** — seeded sessions of random operations, targets chosen from what
  the engine holds, including edits made in Obsidian behind its back, ending
  with every list read; replayed through the Python store on a real folder.
  Every answer, every file byte and every folder must match. 700 sessions of
  80 steps agree, 100 of them started from a copy of the real vault.
- **api** — the same kind of sessions, but as HTTP requests through the
  FastAPI app (`api.py`) and through `api.js`: bad JSON, a list where an
  object belongs, url-encoded heading names, stale source-editor saves.
  Status, body, files, folders, and the number of ids handed out after
  every request must match. 640 sessions of about 100 requests agree.

Each suite was shown to fail on a deliberate one-line change.

**The Python is gone from the tree, and its answers stay.** The suites replay
what it answered, from `test/golden/` (about 1.5 MB), everywhere, the deploy's
gate included. Each batch of questions is stored under its hash, so a replay
checks exactly the questions that were recorded, which is how the suites run
by default. With another seed or size they skip. A behaviour changed on purpose
fails its case: drop the case, or record again.

To record again (a changed generator), check the Python out beside this and
point the suites at its oracle, in an image with Python and the backend's
packages:

```sh
git worktree add /tmp/dvarim-python python-final     # the Python, beside this checkout
# then, in an image with Python and backend/requirements.txt (its tools/parity/Dockerfile),
# with /tmp/dvarim-python mounted at the same path:
DVARIM_ORACLE=/tmp/dvarim-python/tools/parity/oracle.py DVARIM_PYTHON=/usr/bin/python3 \
  DVARIM_GOLDEN=record npm test          # and the same in server/
```

One check is live only: the session cookies, which are stamped with the time
they were made.

```sh
npm test                                   # everything, the Python's answers replayed
# with the Python beside it (DVARIM_ORACLE, above): more fuzz, other seeds, a vault
DVARIM_FUZZ=20000 DVARIM_SEED=3 npm test
DVARIM_SESSIONS=100 DVARIM_STEPS=80 node --test test/store.parity.test.js
DVARIM_PARITY_VAULT=/tmp/copy-of-a-vault npm test   # a COPY; never commit it
```

## Where it differs from the Python, on purpose

- **Digits are 0–9.** Python's `\d` also matches other scripts' digits; the
  format never meant them.
- **Past the year 9999**, a date the Python would raise OverflowError on is
  a rule with no next date here.
- Porting found bugs in the Python, which were fixed there first so the two
  agree: a repeat of every 0 days hung the server (#50); deleting an area
  deleted everything else in its folder (#51); an empty tag in Obsidian
  stopped the app loading (#52); a long to-do could not become a project (#53);
  in quick add, a tag after the date hid the date (#55); renaming an area to
  the name of one of its projects wrote over that project and lost it (#57).
