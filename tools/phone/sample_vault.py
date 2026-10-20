#!/usr/bin/env python3
"""A copy of sample-vault that looks today the way it looked the day it was written.

    sample_vault.py DEST        # DEST must not exist yet

The vault's dates are written down, and they pass: a to-do that was coming up
next week is overdue a fortnight later, Upcoming empties, and a check that
wanted something there fails for no fault of the app's. So every date in the
copy — scheduled, deadline, created, completed — moves by the days since
WRITTEN, and today in the copy is the day the vault was written about.

A repeat pinned to a weekday ("every week on Sunday") keeps its rule but not
its weekday until it is next completed; nothing checks that.
"""
import datetime as dt
import re
import shutil
import sys
from pathlib import Path

SAMPLE = Path(__file__).resolve().parents[2] / "sample-vault"
# The day sample-vault is written as of: what is scheduled for today in it is
# scheduled for this day. A date added to it is written as of this day too.
WRITTEN = dt.date(2026, 9, 19)
DATE = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)")


def copy(dest, today=None):
    shift = (today or dt.date.today()) - WRITTEN

    def moved(m):
        try:
            return (dt.date(*map(int, m.groups())) + shift).isoformat()
        except ValueError:
            return m.group(0)                 # digits shaped like a date, and not one

    shutil.copytree(SAMPLE, dest)
    for f in Path(dest).rglob("*.md"):
        f.write_text(DATE.sub(moved, f.read_text(encoding="utf-8")), encoding="utf-8")
    return shift.days


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: sample_vault.py DEST   (DEST must not exist yet)")
    copy(sys.argv[1])
