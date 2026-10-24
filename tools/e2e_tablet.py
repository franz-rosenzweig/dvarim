#!/usr/bin/env python3
"""A tablet, in a real browser: which layout each screen and pointer gets, and
what a finger, a pen and a resting palm do on a tablet on its side.

    tools/e2e_tablet.py --url http://localhost:8530 --devtools http://172.19.0.18:9222 --root /tmp/dv-tab

--url is a throwaway server over --root, a copy of the demo vault
(tools/docs_shots/demo_vault.py); never the vault: this ticks to-dos. The
input is Chrome's own (Input.dispatchTouchEvent, and mouse events with
pointerType "pen"), so it goes through the same paths a tablet's does.
A tablet here is a Galaxy Tab S10 FE's screen: 1152×720 CSS px on its side.
"""
import argparse, asyncio, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

LAND = {"width": 1152, "height": 720, "deviceScaleFactor": 2, "mobile": True}
PORT = {"width": 720, "height": 1152, "deviceScaleFactor": 2, "mobile": True}
PHONE = {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True}
DESK = {"width": 1152, "height": 720, "deviceScaleFactor": 1, "mobile": False}

LAYOUT = """return (() => {
  const vis = (s) => { const el = document.querySelector(s); if (!el) return false;
    const c = getComputedStyle(el); return c.display !== 'none' && c.visibility !== 'hidden' && el.getBoundingClientRect().width > 0; };
  const sb = document.querySelector('.sidebar').getBoundingClientRect();
  const row = document.querySelector('.content .row');
  return { sidebarAt: Math.round(sb.left), sidebarW: Math.round(sb.width), toolbar: vis('.toolbar'), fab: vis('.fab'),
           qfind: vis('.topbar .qfind'), edge: vis('.edge'), rowH: row ? Math.round(row.getBoundingClientRect().height) : 0 };
})();"""


def centre(sel_js: str) -> str:
    return "return (() => { const b = (%s).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })();" % sel_js


async def setup(b, metrics, touch: bool, path: str):
    await b.send("Emulation.setDeviceMetricsOverride", metrics)
    await b.send("Emulation.setTouchEmulationEnabled", {"enabled": touch, "maxTouchPoints": 5})
    await b.send("Emulation.setTimezoneOverride", {"timezoneId": "America/Phoenix"})
    await b.goto(b.base + path)
    await b.wait_for("!!document.querySelector('.content .row')", timeout=15)
    await asyncio.sleep(0.6)


async def finger(b, x, y, radius=5.0):
    """A tap: down and up in one place, a fingertip's size unless a palm is meant."""
    pt = {"x": x, "y": y, "radiusX": radius, "radiusY": radius, "force": 0.5, "id": 1}
    await b.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [pt]})
    await asyncio.sleep(0.05)
    await b.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    await asyncio.sleep(0.35)


async def swipe(b, x, y, dx, steps=8):
    pt = lambda px: {"x": px, "y": y, "radiusX": 5, "radiusY": 5, "id": 1}
    await b.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [pt(x)]})
    for i in range(1, steps + 1):
        await asyncio.sleep(0.02)
        await b.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [pt(x + dx * i / steps)]})
    await b.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    await asyncio.sleep(0.5)


async def pen(b, kind, x, y, button="none", buttons=0):
    await b.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "pointerType": "pen",
                                              "button": button, "buttons": buttons, "clickCount": 1})


async def ticked(b, tid: str) -> bool:
    return await b.js("return (document.querySelector('[data-todo-id=%s] .cb') || {}).getAttribute?.('aria-label') === 'Reopen';" % json.dumps(tid))


async def row_ids(b):
    return await b.js("return [...document.querySelectorAll('.content [data-todo-id]')].map(r => r.dataset.todoId);")


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--devtools", default="http://172.19.0.18:9222")
    ap.add_argument("--root", required=True)
    args = ap.parse_args()
    refuse_live_data(args.root, args.url)

    async with Browser(args.devtools) as b:
        b.base = args.url.rstrip("/")

        print("\nWhich layout")
        await setup(b, LAND, True, "/today")
        land = await b.js(LAYOUT)
        check("tablet on its side: the sidebar stays", land["sidebarAt"] == 0 and land["sidebarW"] >= 240, str(land))
        check("…the + floats and Quick Find has the bar's corner, the desk's toolbar goes",
              land["fab"] and land["qfind"] and not land["toolbar"], str(land))
        check("…rows at a finger's size", land["rowH"] >= 38, str(land))
        await setup(b, PORT, True, "/today")
        port = await b.js(LAYOUT)
        check("tablet upright: the phone layout, drawer and all", port["edge"] and port["fab"] and port["sidebarAt"] < 0, str(port))
        await setup(b, PHONE, True, "/today")
        phone = await b.js(LAYOUT)
        check("a phone: the phone layout as before", phone["edge"] and phone["fab"] and not phone["toolbar"], str(phone))
        await setup(b, DESK, False, "/today")
        desk = await b.js(LAYOUT)
        check("the same screen with a mouse: the desk", desk["toolbar"] and not desk["fab"] and desk["sidebarAt"] == 0, str(desk))

        print("\nA finger, a palm and a pen, on a tablet on its side")
        await setup(b, LAND, True, "/today")
        ids = await row_ids(b)
        # Where a box is now: a ticked to-do leaves for the Logbook and the rows
        # under it move up, so every tap asks again.
        box = lambda tid: b.js(centre("document.querySelector('[data-todo-id=%s] .cb')" % json.dumps(tid)))
        await finger(b, *await box(ids[0]))
        check("a fingertip on a box ticks it", await ticked(b, ids[0]))
        await finger(b, *await box(ids[1]), radius=28)
        check("a palm on a box does not", not await ticked(b, ids[1]))
        hx, hy = await b.js(centre("document.querySelector('.content h1, .content .t')"))
        await pen(b, "mouseMoved", hx, hy)                      # the pen hovering over the page
        await asyncio.sleep(0.15)
        await finger(b, *await box(ids[1]))
        check("a finger while the pen hovers is the hand resting: nothing happens", not await ticked(b, ids[1]))
        await asyncio.sleep(0.9)
        await finger(b, *await box(ids[1]))
        check("once the pen has gone, a finger ticks again", await ticked(b, ids[1]))

        await setup(b, LAND, True, "/today")
        ids = await row_ids(b)
        tx, ty = await b.js(centre("document.querySelector('[data-todo-id=%s] .title')" % json.dumps(ids[3])))
        await pen(b, "mousePressed", tx, ty, "left", 1)
        await pen(b, "mouseReleased", tx, ty, "left", 0)
        opened = await b.wait_for("!!document.querySelector('.content .card')", timeout=3)
        side = await b.js("return Math.round(document.querySelector('.sidebar').getBoundingClientRect().left);")
        check("a pen tap opens the to-do, in place, beside the sidebar", bool(opened) and side == 0,
              f"card {bool(opened)}, sidebar at {side}, selected {await b.js('return [...document.querySelectorAll(\'.row.sel\')].length;')}")
        await b.js("history.back(); return true;")
        closed = await b.wait_for("!document.querySelector('.content .card')", timeout=3)
        check("Back closes the open to-do and stays in the list", bool(closed) and await b.js("return location.pathname;") == "/today")

        await setup(b, LAND, True, "/today")
        ids = await row_ids(b)
        x0, y0 = await b.js(centre("document.querySelector('[data-todo-id=%s] .title')" % json.dumps(ids[4])))
        await pen(b, "mousePressed", x0, y0, "left", 1)
        lifted = False
        for i in range(1, 9):
            await pen(b, "mouseMoved", x0, y0 - 14 * i, "left", 1)
            await asyncio.sleep(0.03)
            lifted = lifted or bool(await b.js("return !!document.querySelector('.drag-card');"))
        await pen(b, "mouseReleased", x0, y0 - 112, "left", 0)
        await asyncio.sleep(0.6)
        check("a pen lifts a row at once, with no long press", lifted)
        moved = await row_ids(b)
        check("…and it lands where the pen let go", moved.index(ids[4]) < 4, f"{ids} -> {moved}")

        await setup(b, LAND, True, "/today")
        ids = await row_ids(b)
        tx, ty = await b.js(centre("document.querySelector('[data-todo-id=%s] .title')" % json.dumps(ids[2])))
        await pen(b, "mouseMoved", tx, ty)
        await pen(b, "mousePressed", tx, ty, "right", 2)
        await pen(b, "mouseReleased", tx, ty, "right", 0)
        menu = await b.wait_for("[...document.querySelectorAll('[role=menuitem]')].some(m => m.textContent.includes('When'))", timeout=3)
        check("the pen's side button opens the row's menu", bool(menu))
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); return true;")

        await setup(b, LAND, True, "/today")
        ids = await row_ids(b)
        tx, ty = await b.js(centre("document.querySelector('[data-todo-id=%s] .title')" % json.dumps(ids[2])))
        await asyncio.sleep(0.9)                                 # the pen is long gone
        await swipe(b, tx + 120, ty, -140)
        choosing = await b.wait_for("!!(document.querySelector('.app.selecting') && document.querySelector('.selbar'))", timeout=3)
        check("a finger swiping a row left starts choosing several, as on a phone", bool(choosing),
              str(await b.js("return {selecting: !!document.querySelector('.app.selecting'), selbar: !!document.querySelector('.selbar'), sel: document.querySelectorAll('.row.sel').length};")))

    if FAILURES:
        print(f"\n{len(FAILURES)} check(s) failed: " + "; ".join(FAILURES))
        return 1
    print("\nthe tablet works")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
