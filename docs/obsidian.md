<sub>[Dvarim docs](README.md) › Your files</sub>

# Using it with Obsidian

Dvarim was made to sit inside an Obsidian vault, and this page is how to set that up and what to expect when the app and Obsidian work on the same files. Nothing here needs a plugin: Obsidian shows the files as notes with checkboxes. With the Obsidian Tasks plugin, Obsidian understands the dates too.

## Putting the folder in your vault

Make a folder for your to-dos inside the vault, like `Tasks`, and point Dvarim at it. On a server, that's the folder you give the container as `/data` (see [Your own server](server.md)). In the Mac app it's **In a folder on this Mac** in Dvarim → Settings…, and on Android **In a folder on this phone**, which can be the vault's folder that Syncthing keeps on the phone. The folder can start empty: Dvarim makes `Inbox.md`, `Standalone.md`, `Trash.md`, `Areas/`, `Projects/` and `Trash/` the first time it starts.

I keep mine in a Tasks folder inside my vault, the server works on it directly, and Syncthing carries the vault, Tasks and all, to the Mac and the phone. This way, instead of my to-dos living in one app and my notes in another, I have one folder of Markdown that both of them read.

## Editing in both

You can edit a to-do file in Obsidian at any time, while the app is open too. The server notices a changed file within a moment and reads it again, and every open window refreshes. The apps on a folder do the same: the Mac hears about it from macOS straight away, and Android looks again every 15 seconds while the app is in front.

The rule when both touched the same thing is simple: an edit made in Obsidian wins, even one that undoes something the app just did, like deleting a to-do it added. That's on purpose, because the file is the truth and you're the one editing it.

A few things worth knowing when you type in Obsidian:

- **New to-dos**: write a line like `- [ ] Book the electrician` in a project file, under the heading you want, and it's in the app. Dvarim gives it a `🆔` the next time it saves that file, or after two quiet minutes.
- **Dates**: `⏳ 2026-10-14` is When and `📅 2026-10-16` is Deadline. That's how the Tasks plugin writes them too.
- **Ticking boxes**: the Tasks plugin adds a `✅` with the date when you tick a task, and the Logbook files it under that day. A box ticked without a date still counts as done, and the Logbook puts it under "Completed, date unknown" rather than inventing one.
- **Notes under a to-do** are lines indented by four spaces, and a checklist is indented boxes. In a to-do's notes, a line that would otherwise read as a heading or a to-do, like `## Budget` or `- [ ] parking`, is written with a backslash in front (`\## Budget`), which Obsidian shows as plain text. Dvarim adds and removes those backslashes itself.
- **Properties**: whatever you or Obsidian put in a note's front matter stays exactly as it was. Dvarim only touches its own keys, like `when`, `deadline` and `tags`.
- **Other notes**: notes in the folder that aren't projects or areas are ignored, so a note about a project can sit right beside it.

## The Obsidian Tasks plugin

The format is the Tasks plugin's own, so with the plugin installed, Obsidian understands `⏳` (Tasks calls it "scheduled", Dvarim calls it When), `📅` ("due", Dvarim's Deadline), `🔁`, `🆔`, `➕`, `✅` and `❌`, and its queries work on your Dvarim to-dos. Dvarim's own markers, `🌙` for This Evening, `💤` for Someday and `⏰` for a reminder time, show up as part of the task's description, which is harmless. The plugin will also count checklist items as tasks of their own, because to Obsidian they're indented checkboxes. Dataview can query the same fields.

## Open in Obsidian

You can jump from the app straight to the file. Give the server two settings, `DVARIM_OBSIDIAN_VAULT`, the vault's name, and `DVARIM_OBSIDIAN_PREFIX`, the path of the Tasks folder inside the vault, and every project and area gets **Open in Obsidian** at the top of its ••• menu, and every to-do card gets an Obsidian button at the bottom right. The to-do's button opens the note on that to-do's exact line, which needs the Advanced URI plugin in Obsidian. The project and area links work without it.

## With Syncthing

If Syncthing carries the vault between devices, two of them changing the same file before they see each other leaves a conflict copy (`… .sync-conflict-….md`). Dvarim merges that copy back into the file, to-do by to-do, and puts the copy away in `.dvarim/conflicts/`, so you don't end up with two versions of your Inbox. [Sync](syncing.md) has the details.

<sub>Next: [The Mac app](mac.md) →</sub>
