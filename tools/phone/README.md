# Checks on a real phone

A touch gesture cannot be tested with synthesized events. A touchscreen browser
decides within a few pixels whether a finger is scrolling and sends one
`pointercancel` if so; `dispatchEvent(new PointerEvent(…))` in a desktop browser
skips that arbitration entirely, so everything passes there and fails under a
thumb. That is how four gestures once shipped "verified" and none of them could
be finished by a finger.

So these drive a real Android phone. Touches go into the phone's own input
pipeline through `adb shell input`, where the WebView's arbitration runs, and the
page is read over the debug build's DevTools socket. The same rig checks the
offline behaviour end to end, by taking the server away under a loaded app.

## What you need

- An Android phone over USB with USB debugging on, and `adb` on your `PATH`.
- The debug build on it: `android/shell/dev.sh` builds and installs it (it sits
  beside the real app as `xyz.tiresia.dvarim.debug`, and only it has the
  `DevActivity` these open).
- `pip install websockets`, and Node for the dev server (it is the real
  server, `server/src/main.js`, which needs nothing installed). If python3 is
  not the interpreter with `websockets`, point `DVARIM_PYTHON` at the one that is.
- A built frontend: `npm run build` in `frontend/`.

## Running them

```sh
cd tools/phone
./devserver.sh --fresh          # a copy of sample-vault on 127.0.0.1:8421
python3 offline_reads.py        # or any of the others
```

The server is never your real vault: `devserver.sh` serves a copy of
`sample-vault/`, its dates moved up to today, that it keeps in
`$TMPDIR/dvarim-phone` (or `$DVARIM_PHONE_WORK`), along with the server's log and
every screenshot the checks take. The phone reaches it through `adb reverse`,
which `touch.py` sets up.

The `offline_*` checks start a fresh copy themselves, clear the debug build's
kept data, and stop and start the server as they go. The others expect a server
already running on a fresh copy.

If more than one device is attached, pin the phone — every bare `adb` call
otherwise fails with "more than one device/emulator", at whatever step it is on:

```sh
export ANDROID_SERIAL=…        # the phone's serial, as `adb devices` lists it
```

## The files

| File | What it checks |
| --- | --- |
| `touch.py` | the rig: launching the debug build on the dev server, fingers (`tap`, `swipe`, `down`/`move`/`up`), reading the page over CDP, screenshots |
| `devserver.sh` | the backend on :8421 over a copy of `sample-vault/`; `--fresh`, `--stop` |
| `sample_vault.py` | the copy `devserver.sh --fresh` makes: `sample-vault/` with its dates moved up to today |
| `offline.py` | what the offline checks share: the plane and the landing, asking the server directly, the tally |
| `offline_reads.py` | lists kept and shown from the copy with the server gone; the strip; a list with no copy |
| `offline_todos.py` | a completion and a delete kept, laid over the copy across a reload, and sent |
| `offline_lists.py` | an area, a project, a heading, a to-do under it, a rename and a setting, made offline and landed under the phone's ids |
| `offline_rest.py` | Empty Trash, Convert to Project, Duplicate, and a line shared in from another app |
| `settings_link.py` | Settings → Data's way out to the Android app's own settings |
| `folder_check.py` | the app on a folder (phase 3): Android's picker, the conformance checks, the files, a Syncthing-style write, a share, New To-Do, Back, a turn, Use a server instead…, a lost grant. Needs the debug build from `android/` built after `npm run build` |
| `local_check.py` | phases 5 and 6: a Dvarim server on this Mac (node, a copy of sample-vault, a throwaway token) synced with a new, empty folder on the phone through Settings → Sync and the app's `http` op; the kept lists (`changed`), a reminder from them, a widget tick with the app closed, the calendars and their permission. Needs the debug build and `node` |
| `reminders_check.py` | the Android app's own reminders: caught up on, Complete pressed in the shade with the server gone and kept until it is back, and the switch that turns them off. Needs the debug build from `android/` built first |
| `nav_check.py` | the address follows the app when a navigation closes a layer (Convert to Project, Delete Project), and Back still does what Back does |
| `suite.py` | the gesture suite: swipes, the + button, drag and drop, pull-to-find, the edge drawer, the card, tagging a selection, cancelling, Back |
| `cl_check.py`, `landed_check.py`, `press_check.py`, `settle_check.py`, `settings_check.py` | focused checks for single gestures, each written when one of them went wrong |
| `cdp.py` | `cdp.py 'expr'` evaluates one expression in the phone's page; `cdp.py --reload` reloads it |

`suite.py` runs its blocks in order on one copy of the vault, and each leaves
something behind for the next: a to-do made, a row moved, the list scrolled to
where a card opened. Every block measures rows against the screen and then
touches there, so each starts from the same place: `dismiss()` puts everything
away and the list back at the top, and a block that needs a row further down
brings it into view itself (`into_view()`) before measuring it. Run one block on
its own with `python3 suite.py evening`.

## What will bite you

- **Injected touches land about 240 ms late.** Time a gesture from the page,
  not from the script: poll for the state you expect rather than sampling at a
  fixed delay, and send timing-critical steps on a clock rather than after
  having looked.
- **A hardware BACK with nothing left in the WebView's history closes
  `DevActivity` itself**, and whatever was behind it comes forward — once, the
  real app's settings. Close cards and sheets from inside the page:
  `history.back()`, or the sheet's own Done.
- **`InlineEdit` is deaf to a scripted `focus()` and `blur()`** in this WebView;
  it commits on a real blur. Rename headings and titles with a real tap, `adb
  shell input text`, and ENTER.
- **Android spends the first BACK on the keyboard** when it is up, so a BACK
  meant for the keyboard also closes whatever is behind it if the keyboard was
  already gone.
- **A phone lying on a desk turns itself sideways**, and at 832 px the layout is
  no longer the phone layout, so every gesture disarms. `touch.py` locks it
  upright while it runs and puts the owner's setting back afterwards.
- **An app-cloning profile moves the app.** On a phone with Island the debug
  build can live in user 10, where `am start` without `--user` says the activity
  "does not exist". `touch.app_user()` looks rather than assumes.
- **The vault has to be fresh.** Most checks count rows; a to-do an earlier run
  made is one too many.
- **The sample vault's days are written down, and pass.** `sample_vault.py`
  moves every date in the copy by the days since it was written (2026-09-19),
  so today in the copy is always that day: what was scheduled for it is
  scheduled for today, and Upcoming never runs dry. A date added to
  `sample-vault/` is written as of that day too.
