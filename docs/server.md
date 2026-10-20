<sub>[Dvarim docs](README.md) › Running your own server</sub>

# Your own server

A Dvarim server is one Docker container, a folder of Markdown files, and a password. This page is how to run your own copy, keep it safe and reach it from your devices. I run mine on a small Linux machine at home, next to the rest of my self-hosted things, and the whole of my own setup is written down in [Deploying on my server](DEPLOY.md), if you want to see one that's been running for a while.

The server does three jobs. It serves the web app, it answers the app's requests by reading and writing the folder, and it watches the folder, so a change made in Obsidian or by Syncthing is in every open window a moment later. It's written in JavaScript on Node and has no dependencies beyond Node itself, and there's no database: the folder is everything.

## Running it

You need Docker and a copy of this repository. Make a folder for the to-dos (or use one inside your Obsidian vault) and a separate one for the server's secrets, then build and run:

```bash
git clone https://github.com/franz-rosenzweig/dvarim.git
cd dvarim
docker build -t dvarim .
mkdir -p "$HOME/Tasks" "$HOME/.dvarim-secrets"
docker run -d --name dvarim --restart unless-stopped \
  --user "$(id -u):$(id -g)" -p 8420:8420 \
  -v "$HOME/Tasks:/data" -v "$HOME/.dvarim-secrets:/secrets" \
  -e DVARIM_AUTH_FILE=/secrets/auth.json -e TZ=Europe/London \
  dvarim
```

Or the same with Docker Compose:

```yaml
services:
  dvarim:
    build: ./dvarim
    image: dvarim
    restart: unless-stopped
    user: "1000:1000"                # your own user and group, so the files stay yours
    ports:
      - "127.0.0.1:8420:8420"        # only this machine; put HTTPS in front (below)
    volumes:
      - /home/you/Tasks:/data
      - /home/you/.dvarim-secrets:/secrets
    environment:
      TZ: Europe/London
      DVARIM_AUTH_FILE: /secrets/auth.json
```

`TZ` matters more than it looks: it decides when "today" begins, so get it wrong and Today turns over at the wrong hour and your calendar's events sit at the wrong times. `--user` keeps the files owned by you rather than by root, which matters when Syncthing or Obsidian also works on them. On first start the server makes `Inbox.md`, `Standalone.md`, `Trash.md`, `Areas/`, `Projects/` and `Trash/` in the folder, and leaves any other notes there alone. A folder with no notes in it at all also gets "Meet Dvarim", a short tour as a project.

To update, pull the repository and build again, then start a new container (`docker compose up -d --build dvarim`). Always build: restarting the container only restarts the old image.

## The password

Until you set a password, anyone who can reach the server can use it. Set one straight away:

```bash
docker exec -it dvarim node server/src/cli.js set-password
```

Then sign in in the browser. A session lasts 30 days, and you can change the password in Settings → Account, which signs out your other devices. You can also invite other people to keep their own to-dos on your server: see [Other people on your server](PEOPLE.md). Keep the password file outside the to-dos folder, the way the commands above do with `DVARIM_AUTH_FILE`: the folder gets synced to your other devices, and the password's hash and the session secret shouldn't travel with it.

Wrong guesses are slowed down (three free tries per address, then a lockout that doubles each time), the session cookie is signed, and every change has to come from the app's own page. If you lose a device, `docker exec dvarim node server/src/cli.js logout-everywhere` signs out every session at once.

## Tokens for bots and devices

Anything that isn't a person signing in, like a bot that adds to-dos or a device that syncs, uses a token of its own:

```bash
docker exec dvarim node server/src/cli.js add-token signal-bot   # shown once, keep it
docker exec dvarim node server/src/cli.js list-tokens
docker exec dvarim node server/src/cli.js remove-token signal-bot
```

A bot sends it as `Authorization: Bearer <token>`. Settings → Sync → **Add a device** makes the same kind of token from the app. Only a hash of each token is stored.

## Reaching it from your devices

The web app works over plain HTTP on your own network, but to install it as an app on Android, and for the Android app at all, it needs HTTPS. Any of the usual ways works: Tailscale's `tailscale serve`, a reverse proxy like Caddy with a certificate, or a Cloudflare tunnel, which is what my own copy uses. The server answers WebDAV for the built-in sync on the same address, at `/dav/`, so whatever is in front has to pass its methods (`PROPFIND`, `MKCOL`) through, which these do.

## Settings

Everything is set with environment variables:

| Variable | What it does |
| --- | --- |
| `DVARIM_ROOT` | the to-dos folder (`/data` in the Docker image) |
| `DVARIM_AUTH_FILE` | where the password and tokens are kept (default: inside the folder, in `.dvarim/`) |
| `DVARIM_PEOPLE` | where the folders of the people you invite are kept (default: `people/` beside the password file; see [Other people on your server](PEOPLE.md)) |
| `TZ` | your time zone, which decides when "today" is |
| `PORT`, `HOST` | where to listen (8420 on every address) |
| `DVARIM_CALDAV_URL`, `_USER`, `_PASS` | calendars for Today and Upcoming (see [Calendars](calendars.md)) |
| `DVARIM_TASKSYNC`, `_EVERY`, `_SOMEDAY` | the to-do mirror for Tasks.org and other CalDAV apps |
| `DVARIM_SIGNAL_URL` or `_CLI`, with `_FROM` and `_TO` | reminders as Signal messages |
| `DVARIM_OBSIDIAN_VAULT`, `_PREFIX` | the "Open in Obsidian" links (see [Using it with Obsidian](obsidian.md)) |
| `DVARIM_ANDROID_PACKAGE`, `_FINGERPRINT` | the Android app's proof that it belongs to this server |
| `DVARIM_MERGE_ARRIVALS` | `1` only if the folder is synced by something that keeps the newer of two files and leaves no conflict copy (see [Sync](syncing.md)) |
| `DVARIM_WATCH` | `0` stops the server watching the folder (for tests) |

## Reminders over Signal

A browser can't notify you on its own, so the server can send each reminder as a Signal message, at the to-do's time. Point it at a [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) container with `DVARIM_SIGNAL_URL` (like `http://signal-api:8080`), or at the `signal-cli` program with `DVARIM_SIGNAL_CLI`, and give it the number to send from (`DVARIM_SIGNAL_FROM`) and the one to send to (`DVARIM_SIGNAL_TO`). The message is the to-do's title, its project and deadline, and the first line of its notes. A restart never sends the same reminder twice. If you also use the Mac or Android app's reminders, turn one of them off.

## Without Docker

The server needs only Node 20 or newer. Build the web app once (`frontend/build.sh`, which uses Docker, or `npm ci && npm run build` in `frontend/`), then:

```bash
DVARIM_ROOT=$HOME/Tasks DVARIM_AUTH_FILE=$HOME/.dvarim-secrets/auth.json TZ=Europe/London \
  node server/src/main.js
node server/src/cli.js set-password    # with the same DVARIM_ROOT and DVARIM_AUTH_FILE
```

## Backups

There's nothing to back up but the folder, and it's plain text, so whatever already backs up your notes covers it. If you've invited other people, back up the folder with your password file too, because their to-dos live beside it. `/api/health` answers without signing in, if you want to check that it's up.

<sub>Next: [Other people on your server](PEOPLE.md) →</sub>
