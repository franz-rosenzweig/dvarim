#!/usr/bin/env python3
"""Offline, making lists: an area, a project in it, a heading, a to-do under the
heading, the heading renamed, and a setting changed — all with the server gone,
all still there after a reload, and all on the server, under the phone's ids,
once it is back. frontend/src/lib/outbox.js."""
import asyncio, sys

from touch import Phone, adb, check, finish
from offline import fresh, plane, land, get, lists_kept, waiting, synced, close_card


async def menu(p, button_js, item):
    """Open a menu with `button_js`, then pick the item whose text matches."""
    await p.js(button_js); await asyncio.sleep(0.8)
    return await p.js(f"""(() => {{ const b = [...document.querySelectorAll('.menu .opt')].find(x => /{item}/i.test(x.textContent));
        if (b) b.click(); return !!b; }})()""")


async def main():
    fresh()
    p = Phone(); await p.launch()
    await lists_kept(p)
    plane()

    await menu(p, "[...document.querySelectorAll('.sidebar button')].find(x => /new list/i.test(x.textContent)).click()", "new area")
    await asyncio.sleep(2.0)
    path = await p.js("location.pathname")
    area = path.split("/area/")[-1] if "/area/" in path else None
    check("a new area opens offline, under an id the server would have made", area and area.startswith("a") and len(area) == 8, path)
    if not area: return finish()

    await p.js("window.dvarim.run('project.new')"); await asyncio.sleep(2.0)
    path = await p.js("location.pathname")
    project = path.split("/project/")[-1] if "/project/" in path else None
    check("a new project opens offline, inside it", project and project.startswith("p") and len(project) == 8, path)
    if not project: return finish()

    await p.js("window.dvarim.run('heading.new')"); await asyncio.sleep(1.5)
    check("a heading made offline is on the page",
          await p.js("[...document.querySelectorAll('.hname')].some(h => h.textContent === 'New Heading')"))

    made = await menu(p, "document.querySelector('.hd .more').click()", "new to-do")
    await asyncio.sleep(1.8)
    check("a to-do can be made under it, from the heading's own menu", made and await p.js("!!document.querySelector('.card')"))
    await p.js("(() => { const t = document.querySelector('.card .ttl'); t.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, 'Rollers'); })()")
    await asyncio.sleep(0.5)
    await close_card(p)

    # A finger, not script: the inline editor commits on a blur that a scripted
    # focus()/blur() never reaches in this WebView. Enter blurs it.
    name = await p.rect(".hname[contenteditable]")
    p.tap(name["cx"], name["cy"]); await asyncio.sleep(1.0)
    adb("shell", "input", "keycombination", "113", "29", check=False)      # ⌃A
    adb("shell", "input", "text", "Materials"); await asyncio.sleep(0.5)
    adb("shell", "input", "keyevent", "ENTER"); await asyncio.sleep(2.0)
    check("renamed offline, the heading shows its new name",
          await p.js("[...document.querySelectorAll('.hname')].some(h => h.textContent === 'Materials')"))
    kept = await waiting(p)
    check("area, project, heading, to-do, its title and the rename are all kept", kept >= 6, kept)

    await p.js("window.dvarim.run('settings.open')"); await asyncio.sleep(1.2)
    await p.js("(() => { const s = document.querySelector('#set-log'); s.value = 'daily'; s.dispatchEvent(new Event('change', {bubbles: true})); })()")
    await asyncio.sleep(1.0)
    await p.js("document.querySelector('.sheet .x').click()"); await asyncio.sleep(0.8)   # Done, not BACK
    check("and a setting changed offline", await waiting(p) == kept + 1)
    p.shot("offline_lists")

    await p.js("location.reload()"); await asyncio.sleep(5)
    check("after a reload with no server, the area and the project are in the sidebar",
          await p.js(f"""!!document.querySelector('.sidebar [data-drop-area="{area}"]') && !!document.querySelector('.sidebar [data-drop-project="{project}"]')"""))
    check("and the project still has its renamed heading and its to-do",
          await p.js("document.querySelectorAll('[data-todo-id]').length >= 1 && [...document.querySelectorAll('.hname')].some(h => h.textContent === 'Materials')"))

    print("--- server back ---")
    land()
    toast = await synced(p)
    check("everything landed, nothing refused", toast and "made offline saved" in toast and "Not saved" not in toast, toast)
    await asyncio.sleep(2.5)
    a = next((x for x in get("/state")["areas"] if x["id"] == area), None)
    check("the area is on the server under the phone's id", a is not None)
    check("with the project in it, under the phone's id", a and any(q["id"] == project for q in a["projects"]))
    view = get(f"/projects/{project}")
    check("the heading is there under its new name", any(h["name"] == "Materials" for h in view["project"]["headings"]), view["project"]["headings"])
    check("and the to-do under it", any(t["title"] == "Rollers" and t["headingName"] == "Materials" for t in view["items"]),
          [(t["title"], t.get("headingName")) for t in view["items"]])
    check("the setting landed", get("/settings")["logCompleted"] == "daily")
    check("the strip is gone", not await p.js("!!document.querySelector('.offline')"))
    return finish()

sys.exit(asyncio.run(main()))
