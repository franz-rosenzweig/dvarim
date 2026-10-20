#!/usr/bin/env python3
"""Drag and drop, driven with real pointer events in a real browser.

Reordering and dropping cannot be tested any other way: there is no API call to
assert on until the gesture completes, and the gesture is the feature.

    tools/e2e_dnd.py --url https://dvarim.tiresia.xyz --password-file <file>
"""
import argparse, asyncio, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

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


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--password-file")
    ap.add_argument("--devtools", default="http://172.19.0.16:9222")
    args = ap.parse_args()
    refuse_live_data(getattr(args, 'root', None), args.url)
    pw = Path(args.password_file).read_text().strip() if args.password_file else None

    async with Browser(args.devtools) as b:
        await b.goto(args.url + "/today")
        await asyncio.sleep(3)
        if pw and await b.js("return !!document.querySelector('#pw');"):
            await b.js("const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:%r})}); return r.status;" % pw)
            await asyncio.sleep(1.5)

        print("\nReordering inside a project")
        pid = await b.js("const r=await fetch('/api/state'); const s=await r.json(); return s.areas[0].projects[0].id;")
        await b.goto(args.url + "/project/" + pid)
        await b.wait_for("document.querySelectorAll('[data-todo-id]').length > 3", timeout=25)
        before = await b.js("return [...document.querySelectorAll('[data-todo-id]')].map(r=>r.dataset.todoId).slice(0,4);")
        # The sample project puts rows 0-1 under one heading and 2-3 under the
        # next, so this drop crosses a heading. That used to be silently
        # dropped: the reorder endpoint is handed the target section's ids, and
        # a to-do that is not in that section is not one of them.
        where = await b.js("""
          const rows=[...document.querySelectorAll('[data-todo-id]')];
          const ctx = r => r.closest('[data-drop-context]')?.dataset.dropContext || null;
          return { from: ctx(rows[0]), to: ctx(rows[2]) };
        """)
        print("  dragging from", where["from"], "to", where["to"])
        await b.js(DRAG + """
          const rows=[...document.querySelectorAll('[data-todo-id]')];
          const t=rows[2].getBoundingClientRect();
          return await dragTo('[data-todo-id="%s"]', t.left+40, t.bottom-2, 12);
        """ % before[0])
        await asyncio.sleep(2.5)
        after = await b.js("return [...document.querySelectorAll('[data-todo-id]')].map(r=>r.dataset.todoId).slice(0,4);")
        check("the order changes on screen", before != after, f"{before} -> {after}")
        server = await b.js("const r=await fetch('/api/projects/%s'); const d=await r.json(); return d.items.filter(t=>t.status==='open').map(t=>t.id).slice(0,4);" % pid)
        check("and the Markdown file agrees", server[:3] == after[:3], f"screen {after[:3]} vs file {server[:3]}")
        if where["from"] != where["to"] and (where["to"] or "").startswith("heading:"):
            landed = await b.js(
                "const r=await fetch('/api/projects/%s'); const d=await r.json();"
                "const t=d.items.find(x=>x.id==='%s'); return t && (t.headingId || null);" % (pid, before[0]))
            check("dropped under another heading, it belongs to that heading now",
                  landed == where["to"][len("heading:"):], f"{landed!r} vs {where['to']!r}")

        print("\nDropping on the sidebar")
        tid = await b.js("""
            const r = await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({title:'Drag test item', inbox:true})});
            return (await r.json()).id;
        """)
        await b.goto(args.url + "/inbox"); await asyncio.sleep(3)
        for target, list_id, probe in (("Someday", "someday", "someday"), ("Anytime", "anytime", None)):
            await b.js(DRAG + """
              const t=document.querySelector('[data-drop-list="%s"]').getBoundingClientRect();
              return await dragTo('[data-todo-id="%s"]', t.left+40, t.top+t.height/2, 14);
            """ % (list_id, tid))
            await asyncio.sleep(2.5)
            parked = await b.js("const r=await fetch('/api/lists/someday'); const d=await r.json(); return d.items.some(t=>t.id==='%s');" % tid)
            check(f"dropping on {target} does the right thing", parked if probe else not parked)
            if list_id == "someday":
                await b.goto(args.url + "/someday"); await asyncio.sleep(2.5)

        print("\nDropping on a project")
        st = await b.js("const r=await fetch('/api/state'); return await r.json();")
        pid2 = st["areas"][1]["projects"][0]["id"]
        # it is still an Inbox item, and Anytime deliberately excludes those
        await b.goto(args.url + "/inbox"); await asyncio.sleep(3)
        await b.wait_for('!!document.querySelector(\'[data-todo-id="%s"]\')' % tid, timeout=15)
        await b.js("""document.querySelector('[data-drop-project="%s"]')?.scrollIntoView({block:'center'}); return true;""" % pid2)
        await asyncio.sleep(0.6)
        await b.js(DRAG + """
          const t=document.querySelector('[data-drop-project="%s"]').getBoundingClientRect();
          return await dragTo('[data-todo-id="%s"]', t.left+40, t.top+t.height/2, 14);
        """ % (pid2, tid))
        await asyncio.sleep(2.5)
        check("it lands in that project", bool(await b.js(
            "const r=await fetch('/api/projects/%s'); const d=await r.json(); return d.items.some(t=>t.id==='%s');" % (pid2, tid))))

        await b.js("await fetch('/api/todos/%s', {method:'DELETE'}); return true;" % tid)
        await b.js("await fetch('/api/trash/empty', {method:'POST'}); return true;")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: " + "; ".join(FAILURES))
        return 1
    print("drag and drop works")
    return 0


raise SystemExit(asyncio.run(main()))
