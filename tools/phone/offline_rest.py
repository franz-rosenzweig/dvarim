#!/usr/bin/env python3
"""Offline, the writes that mint or parse something: Empty Trash, Convert to
Project (a project and a to-do per checklist item), Duplicate, and a line shared
in from another app, which the server parses once it has it.
frontend/src/lib/api.js and outbox.js; backend Store._client_id."""
import asyncio, datetime, json, sys

from touch import Phone, check, finish
from offline import fresh, plane, land, get, send, lists_kept, waiting, synced, close_card


async def card_menu(p, item):
    """The ••• on the bar under an open card, then one of its items — the only way
    a thumb reaches Duplicate and Convert to Project."""
    b = await p.rect('.cardbar button[aria-label="More"]')
    p.tap(b["cx"], b["cy"]); await asyncio.sleep(1.0)
    await p.js(f"(() => {{ const b = [...document.querySelectorAll('.menu .opt')].find(x => /{item}/i.test(x.textContent)); if (b) b.click(); }})()")
    await asyncio.sleep(2.2)


def title(js_row):
    """A row's title as the page shows it, without the date line under it."""
    return f"(({js_row}.querySelector('.title') || {{}}).innerText || '').split('\\n')[0].trim()"


async def main():
    fresh()
    today = get("/state")["today"]
    tomorrow = (datetime.date.fromisoformat(today) + datetime.timedelta(days=1)).isoformat()
    convert = get("/lists/inbox")["items"][0]["id"]
    send("PATCH", f"/todos/{convert}", {"checklist": [{"text": "Measure", "done": False}, {"text": "Samples", "done": True}]})
    send("DELETE", f"/todos/{get('/lists/today')['items'][0]['id']}")     # something in the Trash

    p = Phone(); await p.launch()
    await lists_kept(p)
    await p.goto("/trash"); await asyncio.sleep(1.2)
    in_trash = await p.js("document.querySelectorAll('[data-todo-id]').length")
    plane()

    await p.js("[...document.querySelectorAll('button')].find(x => /empty/i.test(x.textContent)).click()"); await asyncio.sleep(0.8)
    await p.js("(() => { const b = [...document.querySelectorAll('.menu .opt, .pop button')].find(x => /empty/i.test(x.textContent)); if (b) b.click(); })()")
    await asyncio.sleep(1.5)
    check("Empty Trash offline empties it on screen", in_trash > 0 and await p.js("document.querySelectorAll('[data-todo-id]').length") == 0)

    await p.goto("/inbox"); await asyncio.sleep(1.5)
    r = await p.rect(f"[data-todo-id='{convert}']")
    p.tap(r["x"] + 200, r["cy"]); await asyncio.sleep(1.5)
    await card_menu(p, "convert to project")
    view = await p.js("JSON.parse(localStorage.getItem('dvarim.view') || 'null')") or {}
    project = view.get("id") if view.get("kind") == "project" else None
    check("Convert to Project offline opens the new project, under an id the server would have made",
          project and project.startswith("p") and len(project) == 8, view)
    check("and the address is the project's", await p.js("location.pathname") == f"/project/{project}")
    # the ticked checklist item is a done to-do, and done to-dos are filed: one shows
    check("with its checklist items as its to-dos",
          await p.js(f"[...document.querySelectorAll('[data-todo-id]')].map(r => {title('r')})") == ["Measure"])

    await p.goto("/today"); await asyncio.sleep(1.5)
    first = await p.js(f"(() => {{ const r = document.querySelector('[data-todo-id]'); return {{id: r.dataset.todoId, title: {title('r')}}}; }})()")
    r = await p.rect(f"[data-todo-id='{first['id']}']")
    p.tap(r["x"] + 200, r["cy"]); await asyncio.sleep(1.2)
    await card_menu(p, "duplicate")
    await close_card(p)
    copies = await p.js(f"[...document.querySelectorAll('[data-todo-id]')].filter(r => {title('r')} === {json.dumps(first['title'])}).length")
    check("Duplicate offline puts the copy beside the original", copies == 2, copies)

    # the Android share target: a real navigation to /share, as the share sheet makes
    await p.js("location.href = '/share?text=' + encodeURIComponent('Call the plumber tomorrow #home')")
    await asyncio.sleep(5.0)
    await p.js("[...document.querySelectorAll('button')].find(x => /^add/i.test(x.textContent.trim())).click()")
    await asyncio.sleep(2.5)
    check("a shared line is kept too, with the rest", await waiting(p) >= 4, await waiting(p))

    print("--- server back ---")
    land()
    toast = await synced(p)
    check("everything landed, nothing refused", toast and "made offline saved" in toast and "Not saved" not in toast, toast)
    await asyncio.sleep(2.5)
    check("the Trash is empty on the server", get("/lists/trash")["items"] == [])
    if project:
        items = get(f"/projects/{project}")["items"]
        check("the converted project is on the server under the phone's id, with both to-dos",
              sorted(t["title"] for t in items) == ["Measure", "Samples"], [t["title"] for t in items])
    check("so is the duplicate", sum(t["title"] == first["title"] for t in get("/lists/today")["items"]) == 2)
    # "tomorrow" gives it a When, and a dated quick-add is filed out of the Inbox
    upcoming = [t for d in get("/lists/upcoming")["days"] for t in d["items"]]
    plumber = [t for t in upcoming if t["title"] == "Call the plumber"]
    check("and the shared line, parsed by the server rather than kept as typed",
          plumber and plumber[0]["tags"] == ["home"] and plumber[0]["when"] == tomorrow, plumber)
    check("the strip is gone", not await p.js("!!document.querySelector('.offline')"))
    return finish()

sys.exit(asyncio.run(main()))
