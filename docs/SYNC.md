# Sync you can trust

What Dvarim does when the same file was changed in two places before they saw
each other: the Mac and the server, the phone and Obsidian. Phase 4 of
`docs/ROADMAP.md`. The code is `engine/src/merge.js`, used by the store
(`engine/src/store.js`); the proof is `engine/test/merge.test.js` and the
two-device suite `engine/test/sync.test.js`.

Dvarim does not sync anything itself. It reads and writes a folder, and
something else (Syncthing, iCloud Drive, Obsidian Sync, the server) moves the
folder. What follows is how it keeps two copies' work when that something
brings them together.

## The rules, as a person would see them

- **Nothing you did is lost.** If two devices changed different to-dos in the
  same file, both changes are kept. If they changed different things about the
  same to-do (one ticked it, the other moved its date), both changes are kept.
- **When both changed the same thing about the same to-do**, one change wins,
  and it is the same one on every device:
  - a to-do done on either device is done. Done beats cancelled, and cancelled
    beats open. If it was done on both, it takes the earlier date;
  - a date or time set on one device beats one cleared on the other. Between
    two dates, the later one wins;
  - two titles: the one on the side further along wins — done, then in
    progress (`[/]`), then open, since a to-do is often reworded to say what
    came of it as it is ticked — and between two alike, the longer one;
  - two versions of the notes: the lines both kept stay in place, and where
    they differ, both versions are kept, one after the other;
  - tags and checklist items are merged: added on either side means added, and
    removed on either side means removed.
- **Deleted on one device, changed on the other: kept**, with the change. A
  to-do deleted on one device and untouched on the other is deleted.
- **A sync tool's conflict copy is merged back and put away.** Syncthing's
  `name.sync-conflict-….md`, Dropbox's and Nextcloud's `name (… conflicted
  copy …).md`: the copy is merged into the file it is a copy of, then moved to
  `.dvarim/conflicts/`, never deleted. Settings → Data says how many there
  have been. When the copy is a version this device had, it is merged against
  the base described below, so nothing done here since the other device last
  saw the file counts as deleted there. The file is the version the sync tool
  chose, so its front matter stands. A to-do only the copy has that is now in
  another file (Trash, a project it moved to) stays where it went, unless the
  copy changed it: then it is kept with the change, as above. A copy more than
  two days old is put away without merging, because it was left before
  anything merged it.
- **An edit in Obsidian wins**, including one that undoes something Dvarim
  did, such as deleting a to-do the app just added.
- **A line typed in Obsidian gets the same id on every device** (#59). With
  three devices meeting the same new line, it must not become three to-dos.

## How

**Every to-do has an id** (🆔), so two versions of a file can be compared to-do
by to-do rather than line by line. Each to-do, each field of each to-do, each
heading, the front matter key by key, and the notes line by line are merged
three ways:

- *base*: the version both sides started from;
- *ours*: what this device has;
- *theirs*: what arrived.

Anything only one side changed takes that side's value. Anything both changed
to the same value takes that value. Anything both changed differently goes to
the rules above.

**The base** is the newest version of the file this device has had that the
arriving version was built on. The device keeps every version of each file it
has read or written since it started, up to forty. It walks forward through
them, one change at a time, until it reaches a change the arrival lacks. Not
only its own writes count. A box ticked in Obsidian on this device is read
from disk just as a sync's arrival is, but the other device has not seen it,
and nothing that arrives from there may undo it.

**When a file arrives** changed on disk, what happens depends on the sync.

- **A sync that leaves conflict copies** (Syncthing, Dropbox, Nextcloud,
  OneDrive) is the default. What arrives is taken exactly as it is. Such a
  sync never puts a stale version in place: when two devices changed a file,
  it keeps one and leaves the other beside it as a copy, which is merged (the
  rules above). A file changed in Obsidian on this device is taken as it is
  too, even when it undoes one of the app's own changes.
- **A sync that keeps only the newer file of two** (a plain copy, some cloud
  drives) can put a version made without this device's latest change in
  place, and leaves no copy. For that, the store merges arrivals
  (`mergeArrivals`; on the server `DVARIM_MERGE_ARRIVALS=1`). The store merges
  base, ours and theirs:
  - if theirs already contains everything ours changed, theirs is taken as it
    is, and nothing is written;
  - only when theirs lacks something ours did does the store write the merged
    file.

  The price: content can't tell an arrival made without our change from an
  edit that undid it. So in this mode, deleting in Obsidian a to-do the app
  added since it started (or undoing any of its changes there) doesn't stick.
  The change comes back.

Merging arrivals was the default until 2026-09-23. On the server, with
Syncthing, it brought back to-dos deleted in Obsidian, so it is now off unless
asked for.

The merge is **symmetric**: merging theirs into ours gives the same file as
merging ours into theirs. So when both devices merge the same pair, they write
the same bytes, and the sync has nothing left to disagree about.

**Order is the exception.** If the merged file would differ from the version
that arrived only in the order of things, the arriving version is taken as it
is. Order is not worth a write. Two devices that had each reordered the same
list would otherwise hand it back and forth, because each would insist on its
own order. So when two devices reorder the same list at the same time, one
order wins, and every to-do and every change to one is still kept.

A merge is also **settled**: merging the result again with either side
changes nothing, whatever the order. So the device that receives a merged
file takes it and writes nothing further.

**When it can't tell.** Sometimes the arriving version says exactly what one
of this device's earlier versions said. That can mean the other device saw
our change and undid it, or that it never saw it and simply wrote what we once
had (two devices stamping the same tick with the same day do this). No
content can tell those apart, and the two devices meet the same question from
opposite ends. If each trusted its own history, each would restore its own
version, and they would undo each other forever. So both merge without a base
instead: everything either side has is kept, and the rules above settle the
rest. Both compute the same file, and it stops there. The price is small: an
undo can lose to the rules (a date cleared on one device comes back if the
other set it).

## Settings and sort orders

`.dvarim/state.json` (settings, sort orders, collapsed areas) is not
something anyone edits by hand, so it merges the simplest way that always
settles. The newest change wins, setting by setting and list by list.

- The times are kept in `.dvarim/stamps.json`, beside it, so `state.json`
  stays exactly what the server writes.
- Each time is tied to the value it was made for. A sync can bring the times
  of a change whose state lost a conflict, and a time must never lend itself
  to a value it wasn't made for.
- A setting changed on the Mac reaches the phone, and stays changed there.
- Before this, a running device never re-read `state.json`, so it never saw
  another device's settings, and wrote over them at its next save.

## Built-in sync (WebDAV)

For a device with no sync tool of its own, or where one is awkward (Android),
the app syncs by itself with a folder on a WebDAV server: a Dvarim server's
own, or Nextcloud, Synology or any other. Phase 5 of `docs/ROADMAP.md`. The
code is `engine/src/webdav.js` on the device and `server/src/dav.js` on the
server.

**It knows the base.** A sync tool that only moves files never knows what
either side started from. This sync keeps, for every file, the text both sides
last agreed on (`.dvarim/webdav.json`, on the device only). So a file changed
on both sides is merged against exactly that (the rules above), with nothing
to guess:

| here | there | what happens |
| --- | --- | --- |
| changed | as agreed | sent |
| as agreed | changed | taken |
| changed | changed | merged against the agreed text, then sent |
| deleted | as agreed | deleted there |
| as agreed | deleted | deleted here |
| deleted on one side | changed on the other | kept, with the change |

**Nothing is written over.** Every write to the server carries the version it
was made from (`If-Match`). If the server's file changed in the meantime,
because another device or the server's own app got there first, the write is
refused and the file waits for the next round, which merges again. The server
applies a write through its store like any other change, so it can't land
under an edit the app is making at the same moment.

**What goes.** Every note the app reads, and `.dvarim/state.json` and
`stamps.json`, which merge by their stamps as above. Nothing else: not the
rest of `.dvarim/`, where the server's password file can live, not
`.obsidian/`, not attachments. A Dvarim server offers exactly that set and
refuses to be written anything else.

**When.** When the app opens, when its window comes back to the front, a few
seconds after a change on the device, and every five minutes while in front.
Settings → Sync shows when it last ran and what it did.

**Setting it up.**
- On the server: Settings → Sync → *Add a device*. It gives the device a token
  of its own, shown once. Removing the device there stops it at once. (The
  command line still works: `node server/src/cli.js add-token Phone`.)
- On the device: Settings → Sync → *A Dvarim server*, the server's address and
  the token. For any other WebDAV server, choose *A WebDAV server* and give its
  folder address, a user name and a password (an app password, if it offers
  them).
- The address and the password or token stay on the device (the browser's own
  storage), never in the vault.
- The server takes a token as a bearer or as Basic auth's password under any
  user name, so other WebDAV apps can use its folder too. It never takes the
  account password: that stays for signing in, where tries are slowed down.

**Only one sync per folder.** A device syncing this way shouldn't also have
its folder synced by another tool (Syncthing, iCloud Drive). The record of
what was agreed would travel to the other devices and mislead them.

**From a web page, other servers may refuse.** A Dvarim server answers pages
from other origins, which is what the Mac and Android apps' pages are. Most
others (Nextcloud included) don't, and a browser then can't reach them. The
apps can make the requests themselves instead (`docs/BRIDGE.md`, op `http`);
until they do, sync from a browser or app with a Dvarim server.

**Proved by**
- `server/test/dav.test.js`, over real HTTP:
  - who may in (a token, never the password; this site's own cookie only);
  - what is offered (never `auth.json`, never outside the vault);
  - a write landing only on the version it was made from;
  - two devices and the server in step while all three change the same file,
    delete, and are edited in Obsidian;
  - a round cut off halfway;
  - and a fuzzer: two devices and the server working at random and syncing
    now and then, which must end identical, with every to-do made still there
    and every to-do completed still done. 480 sessions of 50 steps pass
    across eight seeds.
- `engine/test/webdav.test.js`: the client against a strict server in the
  manner of Nextcloud (no `Depth: infinity`, no folders made for a PUT, opaque
  ETags, absolute URLs), with file names that have spaces, an `&` and
  Hebrew in them, and a write that loses a race.
- Nine planted faults each fail the suites. Among them: taking the server's
  file without merging, merging without the base, unconditional writes, a
  server ignoring `If-Match`, `auth.json` offered, the password accepted in
  place of a token, and a new order on the server taken as no change (the
  fuzzer found that one: two devices kept different orders for good).
- `tools/e2e_sync.py`: in a real browser, through Settings → Sync, with a
  server on another origin, both ways. It covers a vault in the browser, and
  the device flow of the Mac and Android apps: a new, empty folder behind a
  simulated shell (`tools/bridge_sim.py`), once with the page making the
  requests and once with the shell making them (op `http`).

## The mirror

From October 2026 the server's own page keeps a full copy of the vault in the
browser and answers every list and every change from it (`lib/backend.js`), so
the app works with no network, lists never opened included, and syncs when it
can. It is the built-in sync above, set up without anyone setting it up:

- **Where**: the server the page came from, over `/dav/` at the same address,
  signed in by the page's own session cookie (`credentials: 'same-origin'`, the
  one case a sync sends a cookie). No token.
- **Whose**: each person's copy is its own IndexedDB database,
  `dvarim-mirror` for the owner and `dvarim-mirror:<account id>` for anyone
  else (`docs/PEOPLE.md`). Opened with no network, it is whoever signed in here
  last. Signing out sends what is left and then deletes the copy; if something
  could not be sent, the copy stays for that person's next sign-in.
- **When**: 1.5 s after a change here; at once when the server's event stream
  says something changed there (Obsidian, a phone, a Tasks.org tick); when that
  stream connects again after a gap, which is how it hears the server is back;
  every ten seconds and then less often while the server cannot be reached; and
  every five minutes regardless.
- **First time**: the first copy is made before the first screen shows, and if
  it cannot finish the page works the old way (from the server, with its kept
  lists) and tries again next time. It writes nothing on the server: a copy of
  a real vault came down byte for byte with no file there touched
  (`tools/e2e_mirror.py`).
- **Never across people**: a sync carries a cookie, so whoever's cookie the
  page holds is whose folder it writes. The mirror's sync stops before anyone
  signs in or joins, and when the server says the session is over, and the page
  loads again for the right person's copy.
- **Only the server**: who you are, other people, devices, the server's
  calendars, reminders and to-do mirror still ask the server (`SERVER_ONLY`).
  Calendar events for the next six weeks are kept, so Today and Upcoming still
  show them offline.

`?backend=server` (or Settings → Data, "Use the server without a copy") goes
back to the server alone, with copies of the lists it has seen and an outbox.
The service worker keeps every file of the app (`vite.config.js`, `precache`),
so the page itself opens with no network too, and it never answers for `/dav/`.

## How it is proved

- `engine/test/merge.test.js`: the rules case by case, then a fuzzer over
  pairs of random edit sessions on the sample vault's files (3,000 by default;
  15,000 checked across seeds). It checks that the merge is symmetric, loses
  nothing either side added, changed or kept, keeps deleted what both deleted,
  and is settled: merging the result with either side again changes nothing.
- `engine/test/sync.test.js`: two stores on two folders, and a sync between
  them. The sync is either Syncthing, which leaves conflict copies, or one
  that keeps only the newer file, like iCloud Drive or a plain copy. Work on
  both devices, edits "in Obsidian" on both, partial syncs, then sync until
  nothing moves.
  - Both folders must end the same within a few rounds.
  - Every to-do made must still exist, and every to-do completed must be done.
  - Both devices must hold the same settings, each the value of its latest
    change.

  The Syncthing half takes arrivals as they are, the default. The other half
  merges them. 1,200 sessions of 60 steps pass across six seeds.

  Three planted faults fail it: turning off the merge on change, trusting a
  device's own history in the ambiguous case, and not re-reading `state.json`.
- The store and API parity suites still hold against the Python server, so on
  a single device nothing behaves differently from before: an edit in Obsidian
  is still taken as it is.

## What it does not do yet

- **A to-do moved to another file on one device and edited on the other** is
  one merge per file, so it can end up in both files. Nothing is lost; there
  are two copies until one is deleted. In the two-device suite this happens to
  about one to-do in every few sessions. Two copies cannot share an id, so one
  is given an id of its own, alike on every device. A copy that is done keeps
  the id, so a box ticked in the old place stays ticked on the to-do everyone
  knows. The new id is written only when its file is next written, and if the
  other copy is gone by then (the move's other half arrived), it is not
  needed, and the copy keeps the id it had.
- **With arrivals merged** (a sync without conflict copies), an undo in
  Obsidian of something Dvarim did loses to the merge. Undo in Dvarim instead.
  (See *When a file arrives* above.)
- **A text editor's half-saved file** is taken as it is, as today.
- **The server does not stamp its changes** to settings. A setting
  changed there and, in the same moment, on a device goes to the device.
