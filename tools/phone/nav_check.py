#!/usr/bin/env python3
"""The address follows the app when a navigation closes a layer.

On a phone history is a stack of depths (frontend/src/lib/backstack.svelte.js):
a card or a menu open over a list is one entry above it. Convert to Project
closes the card and opens the project in the same moment, and deleting a
project from its menu closes the menu and leaves the project — and in both the
address used to stay behind on where the app had been, so a reload went back
there. This checks that it lands where the app is, and that Back still does
what Back does."""
import asyncio, sys

from touch import Phone, adb, check, finish
from offline import fresh, get


async def where(p):
    return await p.js("({path: location.pathname, depth: (history.state || {}).depth, "
                      "view: JSON.parse(localStorage.getItem('dvarim.view') || 'null'), "
                      "root: document.querySelector('.app').classList.contains('root')})")


async def menu_item(p, text):
    await asyncio.sleep(0.8)
    return await p.js(f"(() => {{ const b = [...document.querySelectorAll('.menu .opt')].find(x => /{text}/i.test(x.textContent)); if (b) b.click(); return !!b; }})()")


async def main():
    fresh()
    todo = get("/lists/inbox")["items"][0]
    p = Phone(); await p.launch()

    # a card open over the Inbox is one entry up, at the Inbox's address
    await p.goto("/inbox"); await asyncio.sleep(1.2)
    r = await p.rect(f"[data-todo-id='{todo['id']}']")
    p.tap(r["x"] + 200, r["cy"])
    check("a card opens over the Inbox", await p.wait("document.querySelector('.card')", 4))
    await asyncio.sleep(0.8)
    at = await where(p)
    check("and sits one entry up, at the Inbox's address", at["path"] == "/inbox" and at["depth"] == 2, at)

    # Convert to Project, from the card's own •••
    more = await p.rect('.cardbar button[aria-label="More"]')
    p.tap(more["cx"], more["cy"])
    await menu_item(p, "convert to project"); await asyncio.sleep(2.5)
    at = await where(p)
    project = (at["view"] or {}).get("id")
    check("Convert to Project opens the project", (at["view"] or {}).get("kind") == "project", at)
    check("and the address is the project's, not the Inbox's", at["path"] == f"/project/{project}", at)
    check("one entry up: a list, with nothing open over it", at["depth"] == 1, at)

    # a reload stays there
    await p.js("location.reload()"); await asyncio.sleep(4)
    at = await where(p)
    check("a reload comes back to the project", at["path"] == f"/project/{project}" and at["view"]["id"] == project, at)

    # Back from a list still brings the drawer out
    adb("shell", "input", "keyevent", "BACK"); await asyncio.sleep(1.2)
    at = await where(p)
    check("Back from the project brings the drawer out", at["root"] and at["depth"] == 0, at)

    # deleting a project from its menu: the menu is the layer that closes
    await p.goto(f"/project/{project}"); await asyncio.sleep(1.5)
    await p.js("document.querySelector('button[aria-label=\"Project actions\"]').click()")
    await menu_item(p, "delete project")
    await menu_item(p, "delete project")                 # the confirmation
    await asyncio.sleep(2.5)
    at = await where(p)
    check("Delete Project leaves for Today", (at["view"] or {}).get("id") == "today", at)
    check("and the address goes with it", at["path"] == "/today", at)

    # and a card still closes with Back, leaving the address alone
    r = await p.rect("[data-todo-id]")
    p.tap(r["x"] + 200, r["cy"]); await p.wait("document.querySelector('.card')", 4); await asyncio.sleep(0.8)
    if p.keyboard(): adb("shell", "input", "keyevent", "BACK"); await asyncio.sleep(0.6)
    adb("shell", "input", "keyevent", "BACK"); await asyncio.sleep(1.2)
    at = await where(p)
    check("Back from a card closes the card and stays on the list",
          not await p.js("!!document.querySelector('.card')") and at["path"] == "/today" and at["depth"] == 1, at)
    return finish()

sys.exit(asyncio.run(main()))
