<sub>[Dvarim docs](README.md) › Under the hood</sub>

# Developing Dvarim

This page is what you need to work on Dvarim's code: what's where, how to build it, how to test it, and how a change gets from a branch to my server. It's written for whoever picks it up next, me included. The rest of the technical story is in [Architecture](ARCHITECTURE.md) and the files it links to.

## What's where

| Folder | What it is |
| --- | --- |
| `engine/` | The rules: the Markdown format, the lists, dates and repeats, every change to a to-do, the merge and the WebDAV sync. Plain ES modules with no dependencies and no build step, and the same code runs in Node and in the page. [engine/README.md](https://github.com/franz-rosenzweig/dvarim/blob/master/engine/README.md) |
| `server/` | The server, on the engine: signing in, the event stream, WebDAV, CalDAV, the to-do mirror, Signal reminders, the command line. Node's own library only. [server/README.md](https://github.com/franz-rosenzweig/dvarim/blob/master/server/README.md) |
| `frontend/` | The web app: Svelte 5 and Vite, with CodeMirror for the notes. It imports the engine for working without a server. [frontend/README.md](https://github.com/franz-rosenzweig/dvarim/blob/master/frontend/README.md) |
| `mac/` | The macOS app, a SwiftUI shell around the web app. [mac/README.md](https://github.com/franz-rosenzweig/dvarim/blob/master/mac/README.md) |
| `android/` | The Android app: Bubblewrap's project, and `android/shell/`, everything that's ours. [android/README.md](https://github.com/franz-rosenzweig/dvarim/blob/master/android/README.md) |
| `tools/` | The test gate, the auto-deploy, the browser suites, and `tools/phone/`, the checks on a real phone |
| `sample-vault/` | A small vault for development and tests. Never point a tool at a real one |
| `demo/` | The taste on stuffs: the web app on a made-up vault in the visitor's browser, and the page around it (below) |
| `docs/` | These pages, and the specs: [FORMAT](FORMAT.md), [API](API.md), [SYNC](SYNC.md), [BRIDGE](BRIDGE.md) |

## Building the web app

There's no Node on my server, so everything runs in Docker, and the build script does that for you:

```bash
frontend/build.sh              # npm install when needed, then vite build → frontend/dist
frontend/build.sh --install    # force a fresh install first
```

It installs again by itself whenever `package-lock.json` has changed since the last install. The server serves `frontend/dist`, and the Mac and Android builds copy it into the apps. On a machine with Node, `npm run dev` in `frontend/` starts Vite on port 5173 and passes `/api` through to a server on 8420.

## Running a server to work against

Always on a copy of the sample vault, never on real to-dos. `tools/phone/sample_vault.py` makes a copy with every date moved up to today, so Today and Upcoming look the way they did the day the sample was written:

```bash
python3 tools/phone/sample_vault.py /tmp/dv-dev
docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/repo:ro" -v /tmp/dv-dev:/vault \
  -e DVARIM_ROOT=/vault -e DVARIM_STATIC=/repo/frontend/dist \
  -e PORT=8422 -e HOST=127.0.0.1 -e TZ=America/Phoenix \
  node:22-alpine node /repo/server/src/main.js
```

With Node installed, `tools/phone/devserver.sh --fresh` does the same on port 8421 (and `--stop` stops it).

## Tests

**The gate.** `tools/test-gate.sh` runs the engine's and the server's tests in `node:22-alpine`, which is exactly what the auto-deploy runs before it deploys anything. It pipes through `tail`, so its exit code means nothing: read the `# fail N` lines, and both must say `# fail 0`. The engine's suites include the parity tests, which replay the retired Python server's recorded answers from `engine/test/golden/`; how to record them again, and how to fuzz deeper with `DVARIM_FUZZ`, `DVARIM_SEED` and `DVARIM_SESSIONS`, is in the engine's README.

**The web app's own tests**: `npm test` in `frontend/` (in Docker: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/repo" -w /repo/frontend node:22 npm test`).

**The browser suites.** `tools/e2e_*.py` drive the real web app in a real Chrome over the DevTools Protocol, so they need no Node and no browser on the host, only a Chrome container with remote debugging on, plus Python with `httpx` and `websockets`. Each takes the server's `--url` and Chrome's `--devtools`, and the ones that read the files take `--root`. They complete, delete and empty things, so they refuse to run against the real vault or the live address. There's one per area: `e2e_smoke` (clicks reach the files), `e2e_dnd`, `e2e_multiselect`, `e2e_checklist`, `e2e_notes`, `e2e_repeat`, `e2e_shortcuts`, `e2e_settings`, `e2e_logging`, `e2e_source`, `e2e_local` (a vault in the browser), `e2e_folder` (the apps' folder, with `tools/bridge_sim.py` standing in for the shell), `e2e_sync`, `e2e_mirror` (the browser's full copy, with the server stopped and started again under it), `e2e_people` (inviting someone and keeping them apart, on one shared browser) and `e2e_today_headings`. `e2e_mirror` runs its own server inside the Chrome container's network, because a service worker only works on a secure origin and `localhost` is one, and it sets the browser's time zone to the server's. Run all of them before merging anything that changes how the engine behaves.

**On devices.** `mac/selftest.sh` builds a test copy of the Mac app and drives it against a dev server. `tools/phone/` drives the Android debug build on a real phone over `adb`, because a touch gesture can't be tested with synthesized events, and [its README](https://github.com/franz-rosenzweig/dvarim/blob/master/tools/phone/README.md) says how.

## How a change reaches my server

A push to `master` deploys itself. On the server, `tools/autodeploy.sh` runs from cron every five minutes. When `origin/master` has moved, it fast-forwards the deploy checkout, runs the test gate, builds the web app, rebuilds and restarts the `dvarim` container with `docker compose up -d --build dvarim`, and waits for `/api/auth` to answer. If the tests or the build fail, nothing changes, and if the new container never answers, it's rolled back to the image it replaced. It refuses rather than guesses: a dirty working tree, a detached HEAD, a branch other than `master`, or a history that has diverged from `origin` stops it, and it says so once in the cron log. [Deploying on my server](DEPLOY.md) has the details, and `grep dvarim-deploy` in the cron log shows what it did.

## The worktree rule

Basically, never edit the deploy checkout, `/srv/dev/dvarim`. It has to stay clean and on `master`, or the auto-deploy stops. Work in a git worktree on a branch of its own, one change per branch and one pull request per change:

```bash
git -C /srv/dev/dvarim worktree add /srv/dev/dvarim-next -b my-change origin/master
cd /srv/dev/dvarim-next
# work, run the gate and the browser suites, commit
git push -u origin my-change     # then open a pull request against master
```

Merging the pull request is the deploy, so only merge what has passed the gate and the browser suites. When several pull requests depend on each other, point each one at `master` before merging the one below it, because deleting a branch that another pull request is based on closes that pull request on GitHub.

## The taste on stuffs

My public shelf of apps, stuffs, has a page where anyone can try Dvarim without a server: [stuffs.tiresia.xyz/dvarim](https://stuffs.tiresia.xyz/dvarim/). It's the real web app in its local mode (`lib/backend.js`), so the engine answers everything in the page from a vault in the browser's IndexedDB, and nothing in `frontend/` knows it's a demo. `demo/app/demo.js` is the entry point: it fills the vault with the made-up one in `demo/vault.js` the first time (and again on "Reset the demo"), refuses any request outside its own folder, leaves the service worker out, keeps the address as it is, and then loads `frontend/src/main.js`. The Settings panes that only make sense with a server (Quick Add, Account, Sync) are hidden by `demo/app/taste-app.css`. The page around it, with the pictures from `docs/images`, is `demo/index.html`.

```bash
python3 tools/build_taste.py OUT_DIR     # for stuffs, its site/dvarim/ folder
```

builds all of it in Docker, after checking with the engine that the made-up vault reads as it should (`demo/check_vault.mjs`). Nothing deploys it by itself, so run it again after a change the taste should show.

## What to keep in step

- A change in behaviour belongs on the guide page that describes it too, and a change to the format in [FORMAT](FORMAT.md).
- The API is the contract with the Mac and Android apps. [API.md](API.md) lists every route, and a shell should never need a server change.
- Work for the Mac and Android apps is done on a Mac. Notes on that work go beside their code, in `mac/NEXT.md` and `android/NEXT.md`.
- The Mac and Android apps carry their own build of the web app (`frontend/dist`, copied in when they're built) and, keeping a copy of the to-dos, show that one rather than the server's. So a deploy reaches browsers only: a page change the apps should have needs them built again and installed, the Mac with `mac/build.sh`, Android with a new version.

<sub>Next: [The file format](FORMAT.md) →</sub>
