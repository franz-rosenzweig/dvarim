#!/usr/bin/env python3
"""Today's own headings, in a real browser: made from Today's ••• menu, with
Ctrl/⌘+Shift+N and with the + button let go at the left edge; to-dos dragged
under one and back out; headings moved, deleted and brought back with Undo;
and all of it still there after a reload, in .dvarim/state.json and in no note.

    tools/e2e_today_headings.py --url http://172.19.0.1:8436 --root /tmp/dv-th

--url is a throwaway server over --root, a copy of the sample vault (never the
vault: this makes to-dos and headings).
"""
import argparse, asyncio, base64, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

# as tools/e2e_dnd.py drags (importing it would run it)
DRAG = """async function dragTo(fromSel, toX, toY, steps) {
  const el = document.querySelector(fromSel);
  if (!el) throw new Error('no element for ' + fromSel);
  const b = el.getBoundingClientRect();
  const sx = b.left + 30, sy = b.top + b.height/2;
  const opts = (x,y) => ({clientX:x, clientY:y, bubbles:true, pointerId:1, pointerType:'mouse', button:0, buttons:1});
  el.dispatchEvent(new PointerEvent('pointerdown', opts(sx,sy)));
  for (let i=1;i<=steps;i++){
    const x = sx + (toX-sx)*i/steps, y = sy + (toY-sy)*i/steps;
    el.dispatchEvent(new PointerEvent('pointermove', opts(x,y)));
    await new Promise(r=>setTimeout(r,16));
  }
  el.dispatchEvent(new PointerEvent('pointerup', opts(toX,toY)));
  return true;
}
"""

TODAY = "return (await (await fetch('/api/lists/today')).json());"
ROWS = "return [...document.querySelectorAll('.content [data-todo-id]')].map(r => r.dataset.todoId);"


def under(hid: str) -> str:
    """The ids on screen under a heading of Today's own ('' the run above them)."""
    return ("return [...document.querySelectorAll('[data-list-today-heading=%s] [data-todo-id]')]"
            ".map(r => r.dataset.todoId);" % json.dumps(hid))


async def menu_item(b, opener: str, label: str):
    """Open a ••• (opener: a JS expression for the button) and pick from it."""
    await b.js("(%s).click(); return true;" % opener)
    await b.wait_for("[...document.querySelectorAll('[role=menuitem]')].some(x => x.textContent.trim() === %s)" % json.dumps(label), timeout=5)
    await b.js("[...document.querySelectorAll('[role=menuitem]')].find(x => x.textContent.trim() === %s).click(); return true;" % json.dumps(label))


async def name_focused(b, name: str):
    """Type a name into the heading name that has the focus, as a person would."""
    ok = await b.wait_for("document.activeElement && document.activeElement.classList.contains('hname')", timeout=5)
    await b.js("""const el = document.activeElement; el.textContent = %s;
                  el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); return true;""" % json.dumps(name))
    return ok


async def headings(b):
    return (await b.js(TODAY)).get("headings") or []


async def drag_below(b, tid: str, target_js: str):
    """Drag a row to just below whatever element target_js returns."""
    await b.js(DRAG + """
      const t = (() => { %s })().getBoundingClientRect();
      return await dragTo('[data-todo-id="%s"]', t.left + 60, t.bottom + 6, 14);
    """ % (target_js, tid))
    await asyncio.sleep(2.5)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--root", required=True, help="the throwaway server's data folder")
    ap.add_argument("--devtools", default="http://172.19.0.17:9222")
    ap.add_argument("--shot", help="save a screenshot of Today with its headings here")
    args = ap.parse_args()
    refuse_live_data(args.root, args.url)
    root = Path(args.root)
    E, M = "Errands (e2e)", "Morning (e2e)"

    async with Browser(args.devtools) as b:
        await b.send("Emulation.setDeviceMetricsOverride", {"width": 1200, "height": 900, "deviceScaleFactor": 1, "mobile": False})
        await b.goto(args.url + "/today")
        await b.wait_for("!!document.querySelector('.nav')", timeout=25)
        day = (await b.js(TODAY))["date"]
        made = await b.js("""
          const ids = [];
          for (const title of ['Post the parcel', 'Buy stamps', 'Ring the bank']) {
            const r = await fetch('/api/todos', {method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({title, when: %s})});
            ids.push((await r.json()).id);
          }
          return ids;""" % json.dumps(day))
        await b.goto(args.url + "/today")
        await b.wait_for("document.querySelectorAll('.content [data-todo-id]').length >= 3", timeout=25)
        check("no heading of Today's own to begin with", not await b.js("return !!document.querySelector('.hd.own');"))

        print("\nA heading from Today's ••• menu")
        await menu_item(b, "document.querySelector('h1.t .more')", "New Heading")
        await b.wait_for("!!document.querySelector('.hd.own')", timeout=8)
        check("its name has the focus, to be typed", await name_focused(b, E))
        await asyncio.sleep(1.2)
        hs = await headings(b)
        check("named, and kept", [h["name"] for h in hs] == [E], str(hs))
        hid = hs[0]["id"] if hs else ""

        print("\nDragging to-dos under it and back out")
        a, bb = made[0], made[1]
        await drag_below(b, a, "return document.querySelector('.hd.own');")
        check("dropped below the heading, it is under it on screen", a in await b.js(under(hid)))
        check("and on the server", a in (await headings(b))[0]["todos"])
        await drag_below(b, bb, "return document.querySelector('[data-todo-id=\"%s\"]');" % a)
        check("a second one dropped after the first is under it too", (await headings(b))[0]["todos"] == [a, bb], str(await headings(b)))
        await b.js(DRAG + """
          const t = document.querySelector('[data-list-today-heading=""] [data-todo-id]').getBoundingClientRect();
          return await dragTo('[data-todo-id="%s"]', t.left + 60, t.top + 3, 14);""" % a)
        await asyncio.sleep(2.5)
        check("dragged back above the headings, it is under none", a not in (await headings(b))[0]["todos"] and a in await b.js(under("")))

        print("\nA second heading with the keyboard, then moved up")
        await b.js("document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true, bubbles: true})); return true;")
        await b.wait_for("document.querySelectorAll('.hd.own').length === 2", timeout=8)
        await name_focused(b, M)
        await asyncio.sleep(1.2)
        check("Ctrl+Shift+N makes one, last", [h["name"] for h in await headings(b)] == [E, M])
        await menu_item(b, "document.querySelectorAll('.hd.own .more')[1]", "Move Up")
        await asyncio.sleep(1.5)
        check("Move Up puts it first", [h["name"] for h in await headings(b)] == [M, E])

        print("\nDeleted, and brought back")
        rows_before = await b.js(ROWS)
        await menu_item(b, "document.querySelectorAll('.hd.own .more')[1]", "Delete Heading")
        await asyncio.sleep(1.5)
        check("the heading goes", [h["name"] for h in await headings(b)] == [M])
        check("its to-do stays in Today, above the headings", bb in await b.js(under("")))
        await b.js("[...document.querySelectorAll('button')].find(x => /undo/i.test(x.textContent))?.click(); return true;")
        await asyncio.sleep(2)
        hs = await headings(b)
        check("Undo brings it back, in its place, with its to-do", [(h["name"], h["todos"]) for h in hs] == [(M, []), (E, [bb])], str(hs))
        check("and the rows are where they were", await b.js(ROWS) == rows_before)

        print("\nAfter a reload")
        await b.goto(args.url + "/today")
        await b.wait_for("document.querySelectorAll('.hd.own').length === 2", timeout=20)
        check("both headings are there", await b.js("return [...document.querySelectorAll('.hd.own .hname')].map(x => x.textContent.trim());") == [M, E])
        state = json.loads((root / ".dvarim" / "state.json").read_text())
        check("they are in .dvarim/state.json", [h["name"] for h in state.get("todayHeadings", [])] == [M, E])
        notes = [p for p in root.rglob("*.md") if ".dvarim" not in p.parts and (E in p.read_text() or M in p.read_text())]
        check("and in no note", not notes, str(notes))
        if args.shot:
            shot = await b.send("Page.captureScreenshot", {"format": "png"})
            Path(args.shot).write_bytes(base64.b64decode(shot["data"]))

        print("\nThe + button, let go at the left edge on a phone")
        await b.send("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
        await b.goto(args.url + "/today")
        await b.wait_for("document.querySelectorAll('.hd.own').length === 2 && !!document.querySelector('.fab')", timeout=20)
        target = made[2]
        await b.js("""
          const fab = document.querySelector('.fab'), f = fab.getBoundingClientRect();
          const row = document.querySelector('[data-todo-id="%s"]'), r = row.getBoundingClientRect();
          const o = (x, y) => ({clientX: x, clientY: y, bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1});
          const sx = f.left + f.width / 2, sy = f.top + f.height / 2, tx = 30, ty = r.top + 4;
          fab.dispatchEvent(new PointerEvent('pointerdown', o(sx, sy)));
          await new Promise((res) => setTimeout(res, 320));
          for (let i = 1; i <= 16; i++) {
            fab.dispatchEvent(new PointerEvent('pointermove', o(sx + (tx - sx) * i / 16, sy + (ty - sy) * i / 16)));
            await new Promise((res) => setTimeout(res, 20));
          }
          fab.dispatchEvent(new PointerEvent('pointerup', o(tx, ty)));
          return true;""" % target)
        await b.wait_for("document.querySelectorAll('.hd.own').length === 3", timeout=8)
        await name_focused(b, "Later (e2e)")
        await asyncio.sleep(1.5)
        hs = await headings(b)
        names = [h["name"] for h in hs]
        check("it makes a heading of Today's own", "Later (e2e)" in names, str(names))
        later = next((h for h in hs if h["name"] == "Later (e2e)"), {"todos": []})
        check("and the to-do it was let go at is under it", target in later["todos"], str(hs))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: " + "; ".join(FAILURES))
        return 1
    print("Today's own headings work")
    return 0


raise SystemExit(asyncio.run(main()))
