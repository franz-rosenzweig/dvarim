#!/usr/bin/env python3
"""Offline, writing to-dos: a completion with a thumb and a queued delete are
kept, laid over the copy across a reload, and sent when the server is back.
frontend/src/lib/outbox.js."""
import asyncio, sys

from touch import Phone, check, finish
from offline import fresh, plane, land, get, text, lists_kept, keep, waiting, synced


def today():
    return {t["id"]: t for t in get("/lists/today")["items"]}


async def main():
    fresh()
    p = Phone(); await p.launch()
    ids = list(today())
    done, gone = ids[0], ids[1]
    await lists_kept(p)
    plane()

    # the circle on the row, as a thumb does it
    cb = await p.rect(f"[data-todo-id='{done}'] .cb")
    p.tap(cb["cx"], cb["cy"]); await asyncio.sleep(2.0)
    check("completing offline says Completed, as it does online", "Completed" in (await text(p, ".toast") or ""))
    check("and the strip counts it", await waiting(p) == 1)

    # a delete, kept the way api.deleteTodo() keeps one
    await keep(p, {"kind": "delete", "id": gone})
    await p.js("location.reload()"); await asyncio.sleep(5)
    row = await p.js(f"""(() => {{ const r = document.querySelector("[data-todo-id='{done}']");
        return r ? ((r.querySelector('.cb') || {{}}).getAttribute('aria-label') === 'Reopen') : 'filed'; }})()""")
    check("after a reload with no server, the completed one still shows as done", row in (True, "filed"), row)
    check("and the deleted one is gone", not await p.js(f"""!!document.querySelector("[data-todo-id='{gone}']")"""))
    check("the strip counts both", await waiting(p) == 2)
    p.shot("offline_todos")

    land()
    toast = await synced(p)
    check("back online: both saved, nothing refused", toast and "2 changes made offline saved" in toast and "Not saved" not in toast, toast)
    await asyncio.sleep(2)
    now = today()
    check("the server completed it", done not in now or now[done]["status"] == "done")
    check("and has the other in the Trash, not Today", gone not in now)
    check("the strip is gone", not await p.js("!!document.querySelector('.offline')"))
    return finish()

sys.exit(asyncio.run(main()))
