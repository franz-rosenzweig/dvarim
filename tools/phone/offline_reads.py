#!/usr/bin/env python3
"""Offline, reading: the lists are kept as they arrive and shown from that copy
when the server goes, with the strip saying how old it is; a list with no copy
says so; a write is kept; and the strip goes when the server comes back.
frontend/src/lib/offline.js."""
import asyncio, sys

from touch import Phone, check, finish
from offline import fresh, plane, land, text, lists_kept, close_card, synced


async def main():
    fresh()
    p = Phone(); await p.launch()
    rows = await p.js("document.querySelectorAll('[data-todo-id]').length")
    kept = await lists_kept(p)
    check("the standard lists are kept while online",
          "/state" in kept and all(f"/lists/{k}" in kept for k in ["inbox", "today", "upcoming", "anytime", "someday"]), kept)
    check("no strip while online", not await p.js("!!document.querySelector('.offline')"))

    print("--- server gone ---")
    plane()
    await p.js("location.reload()"); await asyncio.sleep(5)
    shown = await p.js("document.querySelectorAll('[data-todo-id]').length")
    strip = await text(p, ".offline")
    check("Today still shows its rows, from the kept copy", shown == rows and rows > 0, f"{shown} of {rows}")
    check("the strip says it is offline and how old the copy is", strip and strip.startswith("Offline") and "as of" in strip, strip)
    p.shot("offline_reads_today")

    await p.goto("/upcoming"); await asyncio.sleep(1.5)
    check("Upcoming, never opened by hand, is there from the background fetch",
          await p.js("document.querySelectorAll('[data-list-when]').length") > 0)

    # a project nobody opened is not kept, and has to say so rather than look empty
    project = await p.js("(() => { const a = document.querySelector('.sidebar [data-drop-project]'); return a && a.dataset.dropProject; })()")
    if project:
        await p.goto(f"/project/{project}"); await asyncio.sleep(1.5)
        empty = await text(p, ".empty")
        check("a list with no copy says the server is unreachable, not that it is empty", empty and "reach the server" in empty, empty)

    await p.goto("/today"); await asyncio.sleep(1.2)
    fab = await p.rect(".fab"); p.tap(fab["cx"], fab["cy"]); await asyncio.sleep(1.5)
    check("a to-do made offline is kept, and the strip counts it",
          await p.js("!!document.querySelector('.card')") and "1 change kept" in (await text(p, ".offline") or ""))
    await close_card(p)

    print("--- server back ---")
    land()
    # The strip goes at the first answer, which is before the kept to-do has been
    # sent and the list fetched again; the toast comes after both.
    toast = await synced(p)
    after = await p.js("document.querySelectorAll('[data-todo-id]').length")
    check("the strip goes by itself when the server answers", not await p.js("!!document.querySelector('.offline')"))
    check("and the to-do made offline is sent and there", toast and "1 change made offline saved" in toast and after == rows + 1,
          f"{toast!r}, {after} rows, {rows} before")
    return finish()

sys.exit(asyncio.run(main()))
