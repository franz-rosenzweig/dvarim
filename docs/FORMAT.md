# Dvarim file format (v1)

The data is a folder of Markdown files. Everything the app knows is derived from
these files; the in-memory index is a cache. The format is a strict superset of the
[Obsidian Tasks](https://publish.obsidian.md/tasks/) emoji format, so the same
files render and query correctly in Obsidian with or without that plugin, and
remain readable as plain text forever.

## Folder layout

```
<root>/                          e.g. MyVault/Tasks/  or  /srv/dev/dvarim/data/
  Inbox.md                       to-dos in the Inbox (start = inbox)
  Standalone.md                  to-dos in no area and no project
  Trash.md                       deleted to-dos, restorable
  Areas/
    Work/                        an area is a folder
      Work.md                    the area's own note (same name as folder): notes, tags,
                                 and to-dos that live directly in the area
      Annual report.md           a project inside the area
      Team handbook.md
    Personal/
      Personal.md
      Run a 10k.md
  Projects/                      projects that belong to no area
    Prepare talk.md
  Trash/                         deleted projects (whole files moved here)
  .dvarim/                       app-private view state, never data (see below)
```

Rules:

- Area name = folder name. Project name = file name. Renaming in Obsidian or Finder
  is a rename in the app and vice versa. Stable identity comes from ids, not names.
- A project moves between areas by moving its file. Obsidian updates wiki-links.
- Completed and canceled projects stay where they are with `status: done` or
  `status: canceled` in front matter. The sidebar hides them; Logbook shows them.
- Files that are not areas or projects (no `type:` in front matter) inside the
  root are ignored by the indexer, so ordinary notes can live alongside.

## Project file

```markdown
---
id: p7k3j9a2
type: project
status: open            # open | done | canceled
when: 2026-09-22        # optional start date; makes the project appear in Today on that day
evening: false          # optional
someday: false          # optional; true puts the project in Someday
deadline: 2026-10-01    # optional
tags: [work, client]    # optional; nested tags as "work/client"
created: 2026-09-19
completed:              # date set when status becomes done or canceled
repeat:                 # optional Tasks-style rule, e.g. "every month when done"
---
Free-form project notes in Markdown. Everything before the first heading or
to-do line is the project's notes.

- [ ] A to-do with no heading 🆔 a1b2c3

## Planning
- [ ] To-dos under a heading 🆔 d4e5f6
- [x] A finished one 🆔 g7h8i9 ✅ 2026-09-18

## To buy ✅ 2026-09-18
- [x] A heading with a ✅ date is archived 🆔 j0k1l2 ✅ 2026-09-18
```

### Front matter belongs to the note

Only the keys above are Dvarim's. Everything else in the front matter — what
Obsidian's Properties panel, a template or the user put there — is never read
and never rewritten. Dvarim writes the front matter back exactly as it found
it, byte for byte, except for a key whose value it changed: that key's lines
are rewritten in the style they were already in (a block list stays a block
list with the same indent, `[flow]` stays flow), a key it removed goes, and a
key it added is appended at the end in Obsidian's style:

```yaml
tags:
  - work
  - client
```

Values are read as strings, `true`/`false`, empty, or lists; a date stays the
text it is, and so does a time (`reminder: 18:30`). A block that does not read
as a mapping — a note that opens with a horizontal rule — is not front matter,
and stays part of the notes.


Headings are `##`. Order of headings and to-dos in the file is their order in the
app. Anything indented under a to-do belongs to that to-do (see below).

## Area file

`Areas/Work/Work.md`:

```markdown
---
id: a5m6n7o8
type: area
tags: [work]
---
Optional notes about the area.

- [ ] A to-do that lives directly in the area, not in a project 🆔 q9r0s1
```

## To-do line

One line per to-do, a Markdown task list item. Fields after the title are emoji
markers followed by a value. Obsidian Tasks parses fields from the end of the
line, so Dvarim writes its own extensions immediately after the title and the
Tasks-standard fields after them; unknown markers simply stay in the description
for Tasks.

```
- [ ] Title with #tags 🌙 💤 ⏰ 15:00 🆔 a1b2c3 🔁 every week when done ➕ 2026-09-19 ⏳ 2026-09-22 📅 2026-09-30
```

| Marker | Meaning in Dvarim | Notes |
| --- | --- | --- |
| `- [ ]` / `- [x]` / `- [-]` | open / completed / canceled | Tasks treats `[-]` as cancelled |
| `- [/]` | open (Tasks: in progress) | written back as `[/]` until it is ticked; `[ ]` if reopened |
| `- [>]`, any other box | open, **if the line has a `🆔`** | the box is kept as it was; without a `🆔` the line is text, as `- [1] a footnote` should be |
| `#tag`, `#parent/child` | tags, nested tags | anywhere in the title; Obsidian-native |
| `⏳ YYYY-MM-DD` | **When** (start date) | Tasks "scheduled". A past date still counts as Today |
| `🌙` | **This Evening** | Dvarim extension; only meaningful with a When of today or none |
| `💤` | **Someday** | Dvarim extension; a to-do with no When that is parked |
| `⏰ HH:MM` | **Reminder** time on the When date | Dvarim extension, 24-hour |
| `📅 YYYY-MM-DD` | **Deadline** | Tasks "due" |
| `🔁 rule` | **Repeat** | Tasks recurrence text; `when done` = "After completion" |
| `🆔 id` | stable identity | Tasks "id". 6-8 chars base36. See "Ids" |
| `➕ YYYY-MM-DD` | created | Tasks "created" |
| `✅ YYYY-MM-DD` | completed on | Tasks "done"; set with `[x]` |
| `❌ YYYY-MM-DD` | canceled on | Tasks "cancelled"; set with `[-]` |

Other tools that write Obsidian Tasks lines mark work in progress with `[/]`,
and a line whose box Dvarim did not know used to be text to it: invisible in the
app, moved to the end of its section whenever Dvarim wrote the file, and, in a
merge, a line the other side did not have, so it went in beside the to-do of
the same `🆔` (a note written by another tool, October 2026). Matching by `🆔`
is what the format promises, so a box is read by its id first.

Start state is derived: in `Inbox.md` → Inbox; `💤` → Someday; otherwise Anytime.
A to-do is in **Today** when it is open and (When ≤ today, or Deadline ≤ today).
It is in **Upcoming** when When or Deadline is after today, or it repeats.

### Notes and checklist under a to-do

Lines indented by four spaces (or a tab) after a to-do belong to it. Paragraph
lines are the to-do's notes (Markdown allowed). Nested task items are its
checklist. Notes come first, then checklist items.

```markdown
- [ ] Book hotels 🆔 t2u3v4 ⏳ 2026-09-25
    Make sure they are central, have Wifi, and are close to a subway station.

    Second paragraph of notes is fine.
    - [ ] London from June 3
    - [x] Paris from June 10
    - [ ] Berlin from June 17
```

Obsidian renders this as a list item with a paragraph and a sub-list, and the
Tasks plugin will also index the checklist items as tasks; that is accepted.

### Markdown in notes

Notes — a to-do's, and a file's own notes above its first heading or to-do —
are Markdown, and any Markdown can go in them. Two kinds of line would read as
something else, though: an unindented task line, which is a to-do at the top of
a file and a checklist item under a to-do, and a line starting `## `, which is a
project heading. Inside notes, such a line is written with a backslash in front
— Markdown's own way of saying "this is not syntax" — and the backslash is taken
off again on reading:

```markdown
---
id: p7k3j9a2
type: project
---
What the launch needs.
\## Budget
Still waiting on the quote.

- [ ] Book the venue 🆔 a1b2c3d4
    Questions to ask:
    \- [ ] parking
    \- [ ] step-free access
    - [ ] Call them
```

Here the project's notes read "## Budget" and the to-do's notes hold a task
list of two lines; its checklist has one item, "Call them". Obsidian shows an
escaped line as plain text rather than as a heading or a box. Only exactly those
lines are escaped: `# ` and `### ` are never headings of the project, an indented
task line is never a checklist item, and an empty `- [ ]` (the bullet a template
leaves behind) is never a to-do, so none of them need it. A line that already
starts with backslashes gets one more, so every note reads back exactly as it
was written.

### Repeat rules

The `🔁` value uses the Obsidian Tasks vocabulary, which is what the repeat
editor offers:

```
every day | every 3 days | every week | every 2 weeks | every week on Monday, Thursday
every month | every month on the 15th | every month on the last | every 2 months on the 2nd Tuesday
every year | every year on January 5th
... when done          → "After completion": next date counts from the completion date
... until 2026-12-31   → Dvarim extension: end date ("Ends on" in the editor)
... for 12 times       → Dvarim extension: end after N occurrences
```

Completing a repeating to-do marks the line done with `✅` and inserts a new
open copy above it with the next When (and Deadline shifted by the same
distance), exactly as the Tasks plugin does. The checklist is copied reset.
For a regular schedule the next copy is the next scheduled date after the
completed one even if that is already past, so missed copies surface in Today
rather than silently skipping; "when done" rules count from the completion
day. The open copy carries the rule, and nothing else is kept for it.

### Ids

Every to-do the app writes carries `🆔`. A to-do typed in Obsidian without one is
indexed under a temporary id (hash of file path and title) and receives a real
`🆔` the next time the app writes that file, or after the file has been quiet
for two minutes (the normalizer pass). Ids are 8 chars of base36 from a random
source; project and area ids start with `p` and `a` only for readability.

Links: a to-do's link is `dvarim://show?id=X` and, inside Obsidian, a normal
wiki-link to the project file or a block reference `[[Project#^a1b2c3]]`.
Dvarim writes `^a1b2c3` block ids only when asked to (setting), because they
duplicate `🆔`.

## Inbox, Standalone, Trash files

Plain files with no front matter, containing only to-do lines. `Trash.md` lines
carry an extra marker so they can be restored:

```
- [ ] Old idea 🆔 w5x6y7 🗑️ 2026-09-19 ↩ Areas/Work/Annual report.md#Planning
```

Deleting a project moves the whole file to `Trash/`. "Empty Trash" deletes files
and lines. Trashed items stay until you empty the Trash.

## What is NOT in the files

View state that has no place in a document lives in `<root>/.dvarim/state.json`
and is disposable, like Obsidian's `workspace.json`:

- manual order of the Today list (`todayIndex`), the Anytime list and
  the Upcoming day groups;
- Today's own headings (`todayHeadings`: id, name, and which to-dos are under
  each), since Today is a view and has no file to hold them;
- collapsed areas in the sidebar; last selected list; window layout;
- the log of when "log completed items daily" last ran.

The index is in memory only and is rebuilt from the files at startup in well
under a second for thousands of to-dos.

## Concurrency with Obsidian and Syncthing

- The app writes a file atomically (write temp, rename) and remembers the mtime
  and hash it produced, so its own writes do not trigger a reindex storm.
- A file changed by anyone else is reparsed after a 300 ms debounce. If the app
  has an unsaved edit to the same to-do, the file wins and the UI refreshes;
  the app never merges silently.
- Syncthing conflicts (`*.sync-conflict-*.md`) are ignored by the indexer and
  surfaced in the UI as a warning to resolve by hand.

## Compatibility notes

- With Obsidian Tasks installed, `⏳`, `📅`, `🔁`, `🆔`, `➕`, `✅`, `❌` are
  understood; `🌙 💤 ⏰` appear as part of the description. Tasks' "scheduled"
  is Dvarim's "When"; Tasks' "due" is Dvarim's "Deadline".
- Dataview users can query `file.tasks` and the same emoji fields.
- Nothing here needs a plugin. A project file is a readable checklist in any
  Markdown viewer, including GitHub and the Kindle.
