# Integrations

## Radicale calendars in Today and Upcoming (read-only)

Set three variables on the container and the events appear at the top of
Today and under each day in Upcoming:

```yaml
environment:
  DVARIM_CALDAV_URL: http://radicale:5232/jason/    # the user's collection root
  DVARIM_CALDAV_USER: jason
  DVARIM_CALDAV_PASS: "…"                            # the htpasswd password
```

`GET /api/calendars` lists what the server offers (name, colour, VEVENT or
VTODO). `PUT /api/settings {"calendars": ["home", "work"]}` restricts which ones
show; empty means all event calendars. Recurring events are expanded with
their EXDATEs and overrides honoured; multi-day all-day events show on every
day they cover. Results are cached for 60 seconds.

If the container is on the same compose network as Radicale, `radicale:5232`
resolves; otherwise use `http://127.0.0.1:5232/jason/` with `network_mode: host`
or the host gateway address.

## Signal bot quick-add

The bot at `/srv/obsidian/Synergathan/.claude/scripts/signal-bot.py` can forward
any message that starts with `t ` (or a `+`) to the Inbox. One call, no parsing
on the bot side; the API understands the quick-entry grammar:

Every `/api/*` call needs a credential now that the app is on the public
internet. Bots use a bearer token rather than the password:

```bash
docker exec dvarim node server/src/cli.js add-token signal-bot
```

The token is printed once; only its hash is stored. Revoke with
`remove-token`, list with `list-tokens`.

```python
import httpx, os

DVARIM = "http://127.0.0.1:8420"                 # over the tunnel: https://dvarim.tiresia.xyz
AUTH = {"Authorization": f"Bearer {os.environ['DVARIM_TOKEN']}"}

def dvarim_quick_add(text: str) -> str:
    """'t Call the plumber tomorrow 3pm #home !fri' → confirmation line."""
    r = httpx.post(f"{DVARIM}/api/quick-add", json={"text": text}, headers=AUTH, timeout=5)
    r.raise_for_status()
    t = r.json()
    where = "Today" if t["when"] else ("Someday" if t["someday"] else "Inbox")
    extra = " · ".join(x for x in [
        f"when {t['when']}" if t["when"] else "",
        f"deadline {t['deadline']}" if t["deadline"] else "",
        f"at {t['reminder']}" if t["reminder"] else "",
        " ".join("#" + g for g in t["tags"]),
    ] if x)
    return f"✓ {t['title']} → {where}" + (f" ({extra})" if extra else "")
```

Grammar: trailing date words set When (`tomorrow`, `sunday`, `in 3 days`,
`oct 2`, `someday`, `tonight`); `!<date>` sets the Deadline (`!fri`, `!oct 1`);
`@<time>` sets a reminder (`@9am`, `@15:30`); `#tag` anywhere. Anything the
parser is unsure about stays in the title, so it never eats words.

## Mazkir morning brief

```python
today = httpx.get(f"{DVARIM}/api/lists/today", headers=AUTH, timeout=5).json()
lines = [f"- {t['title']}" + (f" ({t['projectName']})" if t["projectName"] else "") for t in today["items"] if not t["evening"]]
evening = [t["title"] for t in today["items"] if t["evening"]]
```

`GET /api/state` gives the counts for a one-line summary ("Inbox 2 · Today 8,
1 deadline").

## Reminders (phase 2)

A to-do with `⏰ HH:MM` on its When date should fire a notification. The lean
route on this server is the existing `signal-api` container: a small cron in the
API process checks every minute for reminders due and sends one Signal message
per to-do. Web Push for the PWA comes after that.

## Radicale: calendars in, tasks both ways

**Events: read-only, in.** Your Radicale calendars are read over CalDAV and their
events appear in Today and Upcoming. Dvarim never writes to them.

Which ones show is controlled in Settings → Calendar, or over the API:

| `calendars` | meaning |
| --- | --- |
| `null` | every calendar (the default) |
| `["Work", "Home"]` | exactly those |
| `[]` | none — unticking them all really does mean none |

`showCalendarEvents: false` hides the lot without forgetting which you had
chosen. `GET /api/calendars` lists what the server offers, with colours.

**To-dos: two-way.** Open to-dos are mirrored into a `dvarim` VTODO collection,
which shows up as a task list called **Dvarim** in Tasks.org on Android, Apple
Reminders, or any CalDAV client. Tick something off there and it becomes `- [x]`
in the Markdown file; edit the title, dates or tags and those come back too;
create a task there and it lands in your Inbox; delete one and ours goes to
Trash, which is recoverable.

```yaml
DVARIM_TASKSYNC: "1"          # off by default: it writes to your calendar server
DVARIM_TASKSYNC_EVERY: "300"  # seconds between cycles
DVARIM_TASKSYNC_SOMEDAY: "0"  # send Someday items too
```

`GET /api/tasksync` reports the last cycle and a short log; `POST /api/tasksync`
runs one now. Settings → Calendar shows both and has a Sync now button.

**What is sent.** Every open to-do that is not in Someday. Completed items are
removed from the collection rather than lingering there, because the list is
meant to be the work in front of you.

### The part worth understanding

VTODO cannot say everything a Dvarim to-do can. There is no This Evening, no
Someday, no headings, no checklists, and most clients make no distinction
between a start date and a deadline. Handled like this:

| | |
| --- | --- |
| Title, notes, status, dates, tags | mapped properly, and read back |
| This Evening, Someday, heading, project, repeat, reminder | carried in `X-DVARIM-*` properties |
| Checklists | summarised as `X-DVARIM-CHECKLIST: 1/3`; edit them in Dvarim |

The rule that matters: **a client is only ever believed about fields it can
express.** If Tasks.org rewrites a task without the `X-DVARIM-*` properties,
that is read as "no opinion", not as "cleared". So a round trip through a simple
client changes the title you changed and leaves your headings, checklists and
This Evening exactly as they were. There is a test named after this.

The one exception is dates: a client that drops `DTSTART` or `DUE` really does
mean you cleared them, since that is how clearing a date looks over CalDAV.

Reminders a client adds are not the to-do. Tasks.org (through DAVx⁵) gives each
to-do with a due date two `VALARM`s whose `DESCRIPTION` is the words *Default
Tasks.org description*; read as the to-do's own, they went into the Markdown as
a line of notes and came back from there as its real description. Everything
inside a `VALARM` is now skipped, and that text is never read as notes, wherever
it turns up.

### Setting up Tasks.org

1. Add a CalDAV account pointing at your Radicale server with your usual
   credentials.
2. It will offer the collections it finds. Tick **Dvarim**.
3. Tasks appear as a list. Completing one there reaches the Markdown file on the
   next cycle, within five minutes, or immediately if you press Sync now.

Conflicts are resolved in favour of whoever wrote last: the CalDAV side is read
first each cycle, then our state is published. State lives in
`<root>/.dvarim/vtodo.json` and is disposable; losing it costs one extra round of
writes, never data.

## Reminders (phase 2)

A to-do with `⏰ HH:MM` on its When date should fire a notification. The lean
route on this server is the existing `signal-api` container: a small cron in the
API process checks every minute for reminders due and sends one Signal message
per to-do. Web Push for the PWA comes after that.

## Radicale tasks: what is and is not connected

**Events: connected.** All 12 of your Radicale calendars are read over CalDAV and
their events appear in Today and Upcoming. Read-only, cached for a minute, and
`PUT /api/settings {"calendars": [...]}` narrows which ones show. Nothing Dvarim
does ever writes to them.

**Tasks: not connected, deliberately.** Radicale holds 15 VTODOs across four
collections. Dvarim does not read or write them, and the two systems do not sync.
That is a real gap, not an oversight, and the reason is below.

## VTODO mirror to Radicale (not built)

To-dos with a When or Deadline are mirrored as VTODO into a dedicated `dvarim`
collection so Tasks.org (Android) or any CalDAV client can see and complete
them. Mapping: title → SUMMARY, notes → DESCRIPTION, When → DTSTART (DATE),
Deadline → DUE, tags → CATEGORIES, done → STATUS:COMPLETED + COMPLETED, id →
UID. Changes made on the CalDAV side are pulled back by polling ETags. The
Markdown files stay canonical; the collection is a projection.

**Why it is not done yet.** One-way publishing is an afternoon: walk the open
to-dos, write a VTODO each, done. Two-way is the hard part, and half a sync is
worse than none. VTODO has no concept of Dvarim's When as distinct from a
deadline, no This Evening, no Someday, no headings, and no checklists; a
round-trip through a CalDAV client would quietly flatten all of them. Deciding
which side wins when both changed, without a proper revision history on the
CalDAV side, is the real work.

If the goal is just seeing tasks on the phone, the installed web app already
does that and loses nothing. The case for VTODO is wanting them inside an app
that is not Dvarim, such as Tasks.org or Apple Reminders. Worth saying out loud
before spending the time.
