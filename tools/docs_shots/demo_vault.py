#!/usr/bin/env python3
"""The demo vault the pictures in docs/images are taken of.

    demo_vault.py DEST [--today YYYY-MM-DD]     # DEST must not exist yet

Three areas (Health, Home, Work) with their projects, two projects of no area,
an Inbox of three, a Today of ten, the Logbook of the last week, Someday, and
an empty Trash. Every to-do is invented.

Every date is written relative to --today (by default the real today), so
Today, Upcoming and the Logbook always look the way the pictures show them:
"Yesterday", "3 days left", ten to-dos for today. The Logbook is the one
exception: after yesterday its days are the Friday before and the four
weekdays before that, because the docs call its groups "yesterday, Friday,
Thursday". On a Sunday that is simply the six days before.

The calendar events the pictures show are not in here: they live in a CalDAV
server (shoot.py makes them), and are listed in EVENTS below for it.
"""
import argparse
import datetime as dt
import hashlib
import sys
from pathlib import Path

# Calendar events, by day relative to today: (day, "HH:MM", minutes, calendar, title).
# Work is orange and Home green, as on the calendar server.
CALENDARS = [("Work", "#FF9500"), ("Home", "#34C759")]
EVENTS = [
    (0, "09:30", 90, "Home", "Farmers' market"),
    (0, "13:00", 60, "Home", "Lunch at the park"),
    (0, "17:30", 60, "Home", "Yoga class"),
    (1, "09:00", 30, "Work", "Team meeting"),
    (1, "15:00", 30, "Work", "Call about the website"),
    (2, "08:15", 30, "Home", "Haircut"),
    (3, "10:00", 60, "Work", "Report review"),
    (3, "18:30", 90, "Home", "Book club"),
    (5, "19:00", 120, "Home", "Dinner with friends"),
    (6, "11:00", 60, "Work", "Website launch call"),
]


def build(dest, today=None):
    today = today or dt.date.today()

    def d(n):
        return (today + dt.timedelta(days=n)).isoformat()

    # The Logbook's days: yesterday, then the Friday before it and the
    # weekdays before that Friday (Python's weekday: Monday 0 … Sunday 6).
    yesterday = today - dt.timedelta(days=1)
    friday = yesterday - dt.timedelta(days=(yesterday.weekday() - 4) % 7 or 7)
    log = {"yesterday": yesterday, "fri": friday}
    for i, name in enumerate(["thu", "wed", "tue", "mon"], 1):
        log[name] = friday - dt.timedelta(days=i)

    def done(day):
        return log[day].isoformat()

    def before(day, n):
        return (log[day] - dt.timedelta(days=n)).isoformat()

    used = set()

    def tid(title, salt=""):
        """A stable 🆔 for a title: the same vault every time it is built."""
        h = hashlib.sha1((title + salt).encode()).digest()
        n = int.from_bytes(h[:8], "big")
        s = ""
        for _ in range(8):
            n, r = divmod(n, 36)
            s += "0123456789abcdefghijklmnopqrstuvwxyz"[r]
        if s in used:
            return tid(title, salt + "+")
        used.add(s)
        return s

    def todo(title, *, tags=(), evening=False, someday=False, reminder=None, id=None,
             repeat=None, created=None, when=None, deadline=None, completed=None,
             canceled=None, notes=(), checklist=()):
        box = "x" if completed else "-" if canceled else " "
        parts = [f"- [{box}] {title}"]
        parts += [f"#{t}" for t in tags]
        if evening:
            parts.append("🌙")
        if someday:
            parts.append("💤")
        if reminder:
            parts.append(f"⏰ {reminder}")
        parts.append(f"🆔 {id or tid(title, completed or canceled or '')}")
        if repeat:
            parts.append(f"🔁 {repeat}")
        if created:
            parts.append(f"➕ {created}")
        if when:
            parts.append(f"⏳ {when}")
        if deadline:
            parts.append(f"📅 {deadline}")
        if completed:
            parts.append(f"✅ {completed}")
        if canceled:
            parts.append(f"❌ {canceled}")
        lines = [" ".join(parts)]
        lines += [("    " + n).rstrip() for n in notes]
        lines += [f"    - [{'x' if ok else ' '}] {text}" for text, ok in checklist]
        return "\n".join(lines)

    def front(**kv):
        out = ["---"]
        for k, v in kv.items():
            if v is None:
                continue
            if isinstance(v, bool):
                v = "true" if v else "false"
            elif isinstance(v, (list, tuple)):
                v = "[" + ", ".join(v) + "]"
            out.append(f"{k}: {v}")
        out.append("---")
        return "\n".join(out)

    files = {}

    files["Inbox.md"] = [
        todo("Look up the podcast about city planning", created=d(-2)),
        todo("Gift idea: a good bread knife", tags=["gifts"], created=d(-1)),
        todo("Find a pumpkin soup recipe", created=d(0)),
    ]

    files["Standalone.md"] = [
        todo("Pay the electricity bill", tags=["money"], created=d(-6), deadline=d(0)),
        todo("Call the bank about the new card", tags=["phone"], reminder="11:30", created=d(-3), when=d(0)),
        todo("Weekly review", tags=["routine"], repeat="every week on Sunday", created=d(-60), when=d(0),
             notes=["Empty the Inbox, look at Someday, plan the week in Upcoming."]),
        todo("Water the plants", evening=True, repeat="every 3 days when done", created=d(-30), when=d(0)),
        todo("Read for an hour", tags=["reading"], evening=True, created=d(-1), when=d(0)),
        todo("Return the library books", tags=["errand"], created=d(-10), deadline=d(2)),
        todo("Renew the home insurance", tags=["money"], created=d(-12), when=d(9)),
        todo("Learn to play the piano", someday=True, created=d(-90)),
        todo("Try a pottery class", someday=True, created=d(-75)),
        todo("Build a bookshelf for the hall", someday=True, created=d(-50)),
        todo("Look into an e-ink monitor", tags=["computer"], someday=True, created=d(-40)),
        todo("Back up the photos", tags=["computer"], created=before("yesterday", 5), completed=done("yesterday")),
        todo("Book the car service", tags=["phone"], created=before("yesterday", 3), completed=done("yesterday")),
        todo("Send the birthday card", created=before("fri", 4), completed=done("fri")),
        todo("Clean out the fridge", created=before("thu", 2), completed=done("thu")),
        todo("Cancel the old phone plan", tags=["phone"], created=before("wed", 6), completed=done("wed")),
    ]

    files["Trash.md"] = []

    files["Areas/Health/Health.md"] = [
        front(id="aheal0001", type="area"),
        todo("Book a dentist check-up", tags=["phone"], created=d(-8), deadline=d(9)),
        todo("Stretch for ten minutes", repeat="every day", created=d(-21), when=d(1)),
    ]

    files["Areas/Health/Run a 10k.md"] = [
        front(id="prun00001", type="project", status="open", deadline=d(45), created=d(-30)),
        "The race is in early December. Three runs a week, one of them long.",
        "",
        todo("Easy run, 5 km", repeat="every week on Sunday, Wednesday", created=done("wed"), when=d(0)),
        todo("Easy run, 5 km", created=before("wed", 4), when=done("wed"), completed=done("wed")),
        todo("Long run, 8 km", created=d(-10), when=d(6)),
        todo("Buy new running shoes", tags=["errand"], created=d(-30)),
    ]

    files["Areas/Home/Home.md"] = [
        front(id="ahome0001", type="area"),
        todo("Replace the smoke alarm batteries", created=d(-4), when=d(5)),
        todo("Fix the squeaky bedroom door", created=d(-15)),
        todo("Hang the new mirror in the hall", created=before("fri", 7), completed=done("fri")),
    ]

    files["Areas/Home/Balcony garden.md"] = [
        front(id="pbalc0001", type="project", status="open", created=d(-14)),
        "Herbs on the shady side, tomatoes along the railing.",
        "",
        todo("Buy two long planters", created=d(-14)),
        todo("Find out which herbs like shade", created=d(-14)),
    ]

    # The project files.png and edit-the-note.png show line by line, so its
    # ids are fixed, and every date in it keeps its distance from today.
    files["Areas/Home/Kitchen renovation.md"] = [
        front(id="pkitch001", type="project", status="open", deadline=d(40), tags=["home"], created=d(-25)),
        "Keep the layout, replace the worktops and the cabinet fronts. Budget agreed in September; "
        "the fitter can start in November.",
        "",
        "## Decide",
        todo("Measure the walls and the window", id="e42l4wfh", created=d(-25), completed=d(-12)),
        todo("Pick a worktop: oak or quartz", id="vdy8ufuq", created=d(-25), completed=done("mon"),
             notes=["Quartz. Oak needs oiling twice a year."]),
        todo("Choose the cabinet colour", id="c66rmrqt", created=d(-20), when=d(0),
             notes=["Samples are on the hall shelf. Sage green or off-white."],
             checklist=[("Order the samples", True), ("Paint test patches", True), ("Look at them in daylight", False)]),
        "",
        "## Order",
        todo("Get three quotes for the worktop", id="363pl6fc", created=d(-10), when=d(1), deadline=d(5),
             checklist=[("The local joiner", True), ("The big hardware store", False), ("The stone yard", False)]),
        todo("Order the tiles", id="cys8rbht", tags=["errand"], created=d(-10), when=d(3)),
        todo("Book the electrician for the new sockets", id="f4sz63y0", tags=["phone"], created=d(-8), when=d(8)),
        "",
        "## Install",
        todo("Clear out the cupboards", id="5faqvudp", created=d(-8)),
        todo("Fit the new handles", id="3ao0ogti", created=d(-8)),
        todo("Seal the worktop edges", id="rzv9cid3", created=d(-8)),
    ]

    # Done the Monday of the Logbook, where it shows as a finished project.
    files["Projects/Repaint the bathroom.md"] = [
        front(id="pbath0001", type="project", status="done", created=before("mon", 20), completed=done("mon")),
        "White ceiling, pale grey walls.",
        "",
        todo("Choose the colour", created=before("mon", 20), completed=before("mon", 3)),
        todo("Buy the paint and the rollers", created=before("mon", 20), completed=before("mon", 2)),
        todo("Paint the ceiling first", created=before("mon", 20), completed=before("mon", 1)),
    ]

    files["Areas/Work/Work.md"] = [
        front(id="awork0001", type="area", tags=["work"]),
        todo("Answer the conference invitation", created=d(-5), when=d(0), deadline=d(6)),
    ]

    files["Areas/Work/Quarterly report.md"] = [
        front(id="pquar0001", type="project", status="open", deadline=d(12), created=d(-20)),
        "July to September: the numbers, a summary page and the charts.",
        "",
        todo("Collect the numbers from the team", created=d(-20), completed=done("thu")),
        todo("Write the summary page", reminder="10:00", created=d(-6), when=d(0)),
        todo("Make the charts", created=d(-6), when=d(1)),
        todo("Send the draft round for comments", created=d(-6), when=d(2)),
    ]

    files["Areas/Work/Website refresh.md"] = [
        front(id="pwebs0001", type="project", status="open", created=d(-30)),
        "Same pages, easier to read, and quicker on a phone.",
        "",
        todo("Choose a new font", created=d(-30), completed=done("tue")),
        todo("Write the new About page", created=d(-30)),
        todo("Resize the photos for the gallery", tags=["computer"], created=d(-12)),
        todo("Test the contact form", tags=["computer"], created=d(-12)),
    ]

    files["Projects/Learn to bake bread.md"] = [
        front(id="pbread001", type="project", status="open", someday=True, created=d(-40)),
        "A loaf a week until one comes out right.",
        "",
        todo("Make a starter", created=d(-40)),
        todo("Buy a proving basket", created=d(-40)),
        todo("Bake a first loaf", created=d(-40)),
    ]

    files["Projects/Plan the trip to the coast.md"] = [
        front(id="ptrip0001", type="project", status="open", deadline=d(19), tags=["travel"], created=d(-12)),
        "Four days at the end of the month. The train there, and bikes once we arrive.",
        "",
        "## Before we go",
        todo("Pick the dates", created=d(-12), completed=done("tue")),
        todo("Book the train tickets", created=d(-5), when=d(0), deadline=d(3)),
        todo("Find a place to stay near the harbour", created=d(-5), when=d(2), notes=[
            "Somewhere with a kitchen and room for the bikes.",
            "",
            "- **Budget:** under 120 a night",
            "- A short walk from the station",
            "- Ask about late check-in",
            "",
            "The tourist office has a list: [coast stays](https://example.com/coast-stays)",
        ]),
        todo("Ask the neighbours to water the plants", created=d(-5), when=d(16)),
        "",
        "## Packing",
        todo("Pack the bags", created=d(-5), when=d(18),
             notes=["One bag each. The bikes go in the luggage car."],
             checklist=[("Rain jackets", False), ("Swimsuits", False), ("Chargers and adapters", False),
                        ("Books for the train", False), ("Sun cream", False)]),
        todo("Download the offline maps", tags=["computer"], created=d(-5), when=d(17)),
    ]

    dest = Path(dest)
    dest.mkdir(parents=True)
    for rel, lines in files.items():
        p = dest / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
    return dest


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("dest", help="a folder that does not exist yet")
    ap.add_argument("--today", type=dt.date.fromisoformat, help="the day the vault is written as of (default: today)")
    args = ap.parse_args()
    if Path(args.dest).exists():
        sys.exit(f"{args.dest} exists already; give a new folder")
    build(args.dest, args.today)
    print(args.dest)


if __name__ == "__main__":
    main()
