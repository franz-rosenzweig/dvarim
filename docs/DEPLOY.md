# Deploying Dvarim on the home server

How the original copy is run: one Linux machine, Docker Compose, the to-dos in
an Obsidian vault that Syncthing carries to the other devices. The paths are
that machine's; put your own in their place.

## Build and run

The `dvarim` service lives in **`/srv/docker/docker-compose.yml`** with the rest
of the stack, right after `radicale`. It is the only service there built from
source rather than pulled, and the source is this directory.

```bash
cd /srv/dev/dvarim
frontend/build.sh                 # builds frontend/dist through the node:22 container
cd /srv/docker && docker compose up -d --build dvarim
curl -s http://127.0.0.1:8420/api/auth
```

**Always pass `--build`.** `up -d --force-recreate` restarts the container from
the image it already has, so server changes look deployed and are not. Check
with `docker exec dvarim ls -l /app/server/src` if in doubt.
A stack-wide `docker compose up -d` never rebuilds it; a stack-wide
`docker compose up -d --build` does, from whatever is in this working tree at
that moment, uncommitted edits included.

Three directories, and they are deliberately separate:

| | |
| --- | --- |
| `/srv/dev/dvarim` | the source and the Dockerfile — this repo |
| `/srv/docker/dvarim` | `auth.json` and `dvarim.env`: the password hash, session secret and CalDAV credentials; `requests.json`, the requests for an account; and `people/`, one folder per invited person (`docs/PEOPLE.md`). Outside git, and outside the Syncthing-synced vault |
| `/srv/obsidian/MyVault/Tasks` | the data. Mounted at `/data`; the Markdown files *are* the database |

The service declares no `networks:` key, and that is the point: the `docker`
project's default network is `docker_default`, which is where `radicale` already
sits, so `DVARIM_CALDAV_URL=http://radicale:5232/me/` resolves by name with no
external-network plumbing. Verify after any change with:

```bash
docker exec dvarim python -c "import socket; print(socket.gethostbyname('radicale'))"
```

The container serves the API and the built frontend on port 8420, bound to
localhost (which is what the Cloudflare tunnel reaches for dvarim.tiresia.xyz)
and to this machine's Tailscale address.

## Deploying itself

A push to master reaches the server on its own. `tools/autodeploy.sh` runs from
cron every five minutes and is silent unless it does something:

```
*/5 * * * * /srv/dev/dvarim/tools/autodeploy.sh --quiet >> $HOME/logs/cron.log 2>&1
```

It refuses rather than guesses. This checkout is also where the code gets edited
by hand, so **a dirty working tree, a detached HEAD, a branch other than master
or a history that has diverged from origin all stop it** — it says so once and
changes nothing. When it does run: fast-forward, the engine's and the server's tests
(`tools/test-gate.sh`, in Node, in Docker), frontend build,
`up -d --build dvarim`, then poll `/api/auth` until it returns 200. Anything that
fails before the build leaves the tree where it was; a deploy that never answers
is rolled back to the image it replaced and the tree reset to the previous
commit.

Watch it with `grep dvarim-deploy ~/logs/cron.log`, run it by hand
with `tools/autodeploy.sh`, and turn it off by removing that crontab line.

The server has no dependencies to install: the engine and the server use Node's
own library, so nothing on the host needs updating for a deploy.

## Reach it from the Mac and the phone

It is one Docker container listening on port 8420, bound to localhost and to
this machine's Tailscale address. Nothing else is in front of it.

`http://<tailscale-ip>:8420` works from any device on the tailnet, as does
`http://<hostname>:8420` via MagicDNS. No sudo, no reverse proxy. That is
the fastest way in and is enough for daily use in a browser tab.

Plain HTTP has one limit: Chrome will not offer "Install app" on a non-secure
origin, so on Android you get a website rather than a home-screen app. Safari on
the Mac will still Add to Dock over HTTP. For a real install on both, put
Tailscale's HTTPS in front of it once (this needs sudo):

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8420
```

The app is then at `https://<hostname>.<tailnet>.ts.net/`. `sudo tailscale serve
status` shows the mapping and `sudo tailscale serve --https=443 off` removes it.

- **Mac**: open the URL in Safari, then File → Add to Dock. It gets its own
  window and dock icon. In Chrome, use Install from the address bar.
- **Android**: open in Chrome, then menu → Add to Home screen. The manifest and
  service worker are in place, so over HTTPS it installs as a real app.

If you want a password in front of it, add a Caddy site with a
`basic_auth` block, pointing at `dvarim:8420`, and drop the
Tailscale-IP port binding in `/srv/docker/docker-compose.yml`.

## Where the data lives

Production root is `/srv/obsidian/MyVault/Tasks` inside the
Obsidian vault, so Syncthing carries every change to the Mac and the phone and
Obsidian can read and edit the same files. `/srv/dev/dvarim/data` (a copy of
`sample-vault/`) is only for development; run against it with
`DVARIM_ROOT=/srv/dev/dvarim/data`.

On first start the app creates `Inbox.md`, `Standalone.md`, `Trash.md`,
`Areas/`, `Projects/`, `Trash/` and a hidden `.dvarim/` for view state.

**Other notes already in that folder are left alone**, whatever front matter
they carry: the indexer only adopts a root-level file that declares
`type: project` or `type: area`, plus everything under `Areas/` and
`Projects/`. The rest stay invisible in the app and unchanged on disk.
Converting them into real Dvarim projects would be a one-off import script,
not something the app does on its own.

`.dvarim/` is in the vault's `.gitignore`, so view state is not committed.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DVARIM_ROOT` | `./data` | the folder of Markdown files |
| `DVARIM_STATIC` | `../frontend/dist` | built frontend to serve at `/` |
| `DVARIM_WATCH` | `1` | set `0` to disable the file watcher (tests) |
| `DVARIM_MERGE_ARRIVALS` | `0` | set `1` only if the folder's sync keeps the newer file of two and leaves no conflict copy (not Syncthing): see `docs/SYNC.md`, "When a file arrives" |
| `TZ` | `UTC` | what "today" means. It must match where you are: get it wrong and Today rolls over at the wrong hour and calendar events show at the wrong time |
| `DVARIM_CALDAV_URL/USER/PASS` | unset | phase 2: Radicale calendars in Today and Upcoming |
| `DVARIM_PEOPLE` | `people/` beside `DVARIM_AUTH_FILE` | the folders of the people the owner invites (`docs/PEOPLE.md`); refused inside `DVARIM_ROOT` |

## Backups

The data folder is plain text. It is already covered by whatever backs up the
vault (git + Syncthing versions). The other people's folders are not in the
vault: they sit in `/srv/docker/dvarim/people/`, which the machine's nightly
backup of `/srv/docker` covers.

## Signing in

The app is on the public internet at **https://dvarim.tiresia.xyz** through the
Cloudflare tunnel, so it requires a password before it serves anything under
`/api`. The static shell is public, which is harmless: it holds no data and
shows only the login screen until you sign in.

```bash
docker exec -it dvarim node server/src/cli.js set-password
docker exec dvarim node server/src/cli.js add-token signal-bot
docker exec dvarim node server/src/cli.js list-tokens
docker exec dvarim node server/src/cli.js logout-everywhere   # if a device is lost
```

**Where the secrets live.** `DVARIM_AUTH_FILE=/secrets/auth.json`, bind-mounted
from `/srv/docker/dvarim`, deliberately outside the vault. The data root is
Syncthing-synced, so a password hash and a session secret kept beside the
Markdown files would be copied to every device. `.dvarim` is in the vault's
`.stignore` and `.gitignore` for the same reason.

**What protects it**

| Concern | Answer |
| --- | --- |
| Guessing the password | scrypt, and three free tries per address then a doubling lockout |
| Reading or forging the cookie | HMAC-SHA256 over the payload, HttpOnly, Secure, SameSite=Strict |
| A hostile page acting as you | SameSite plus an explicit same-origin check on every write |
| A device you no longer have | `logout-everywhere` rotates the secret and invalidates every session; remove its sync token in Settings → Sync |
| Bots that cannot log in | named bearer tokens, revocable one at a time |

Sessions last 30 days. Signing out in Settings ends only that browser's session.

**Devices that sync with it.** The server is also the folder the built-in
sync uses (`/dav/`, `docs/SYNC.md`). Each device gets a token of its own from
Settings → Sync → *Add a device*, and removing it there stops it at once. The
tunnel passes WebDAV's methods (`PROPFIND`, `MKCOL`) through to the container
as it passes any other. A token opens the vault's notes and the two state
files, nothing else: `auth.json`, `vtodo.json` and the conflict copies are
never offered.
