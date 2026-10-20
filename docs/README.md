<p align="center"><img src="images/icon.png" width="72" alt=""></p>
<h1 align="center">Dvarim docs</h1>
<p align="center">How to use Dvarim, where your to-dos live, and how to run your own copy.</p>

These pages are how Dvarim works, written down. It's my to-do app, and every to-do in it is a line in a Markdown file you can open in Obsidian or any text editor. If you're new, read "What is Dvarim?" first and then Install, which takes you from nothing to a working copy. The pages under "Using Dvarim" follow the app from the lists down to a single to-do, and the ones at the bottom are the technical notes I keep for myself.

### Getting started
- [What is Dvarim?](what-is-dvarim.md) — what it does, what works where, and what it plays with
- [How I use it](how-i-use-it.md) — my own routine with it, from the Signal bot to the Mac's quick entry
- [Install](install.md) — the web app, the Mac and Android apps, and where each one gets its to-dos

### Using Dvarim
- [The lists](lists.md) — Inbox, Today, This Evening, Upcoming, Anytime, Someday, Logbook and Trash
- [Areas, projects and headings](projects-and-areas.md) — how bigger things are organized
- [To-dos](todos.md) — the to-do card: notes, checklists, tags, moving, completing
- [When, deadlines and reminders](dates.md) — "When" and "Deadline" are different, and why that matters
- [Repeating to-dos](repeats.md) — on a schedule or after completion
- [Quick entry and keyboard shortcuts](quick-entry.md) — every way in, and every key
- [Quick Find](search.md) — finding any list, project, tag or to-do by typing
- [Settings](settings.md) — what each pane does

### Your files
- [Your to-dos as Markdown](files.md) — the file format in plain words
- [Using it with Obsidian](obsidian.md) — editing the same files in both, and the Obsidian Tasks plugin

### Devices & sync
- [The Mac app](mac.md) — Quick Entry on ⌃Space, Today in the menu bar, notifications, Shortcuts
- [The Android app](android.md) — the Today widget, sharing into Dvarim, reminders
- [Sync](syncing.md) — a synced folder (Syncthing, iCloud Drive) or the built-in WebDAV sync
- [Calendars](calendars.md) — your calendar in Today and Upcoming, and your to-dos in other apps

### Running your own server
- [Your own server](server.md) — one Docker container, a folder, a password
- [Other people on your server](PEOPLE.md) — inviting family and friends to keep their own to-dos on it

### Under the hood
- [Developing Dvarim](DEVELOPING.md) — building, testing, and how changes reach the server
- [The file format](FORMAT.md) — the full spec of the Markdown, marker by marker
- [Architecture](ARCHITECTURE.md) — how the files, the engine, the server and the apps fit together
- [Sync you can trust](SYNC.md) — the per-to-do merge rules and how they're proved
- [The HTTP API](API.md) — every route the app and the native apps call
- [The native bridge](BRIDGE.md) — how the Mac and Android apps hand the page a folder
- [Integrations](INTEGRATIONS.md) — Radicale, Signal and the to-do mirror, in detail
- [Deploying on my server](DEPLOY.md) — how my own copy is built, run and auto-deployed
- [Roadmap](ROADMAP.md) — the decisions behind the engine, the apps and sync, and what's left

Start with [What is Dvarim?](what-is-dvarim.md), and if something here doesn't match what the app does, feel free to tell me.
