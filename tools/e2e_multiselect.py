#!/usr/bin/env python3
"""Multi-select, driven in a real browser.

    tools/e2e_multiselect.py --url https://dvarim.tiresia.xyz --password-file <f>
"""
import argparse, asyncio, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

CLICK = """
function clickRow(id, mods) {
  const el = document.querySelector(`[data-todo-id="${id}"]`);
  if (!el) throw new Error('no row ' + id);
  el.dispatchEvent(new MouseEvent('click', Object.assign({bubbles:true, cancelable:true}, mods||{})));
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

        # a project with plenty of rows, so nothing real is disturbed by accident
        pid = await b.js("const r=await fetch('/api/state'); const s=await r.json(); return s.areas[0].projects[0].id;")
        await b.goto(args.url + "/project/" + pid)
        await b.wait_for("document.querySelectorAll('[data-todo-id]').length > 4", timeout=25)
        ids = await b.js("return [...document.querySelectorAll('[data-todo-id]')].map(r=>r.dataset.todoId);")

        print("\nPicking things")
        await b.js(CLICK + "return clickRow('%s');" % ids[0])
        await asyncio.sleep(0.4)
        check("a plain click selects one", await b.js("return window.__n ?? document.querySelectorAll('.row.sel').length;") == 1)

        await b.js(CLICK + "return clickRow('%s', {metaKey:true});" % ids[2])
        await asyncio.sleep(0.4)
        check("⌘-click adds a second", await b.js("return document.querySelectorAll('.row.sel').length;") == 2)

        await b.js(CLICK + "return clickRow('%s', {metaKey:true});" % ids[2])
        await asyncio.sleep(0.4)
        check("⌘-click again removes it", await b.js("return document.querySelectorAll('.row.sel').length;") == 1)

        await b.js(CLICK + "return clickRow('%s', {shiftKey:true});" % ids[3])
        await asyncio.sleep(0.4)
        n = await b.js("return document.querySelectorAll('.row.sel').length;")
        check("shift-click takes the range", n == 4, f"{n} selected")
        check("the toolbar says how many", '4 selected' in (await b.js("return document.querySelector('.toolbar')?.innerText || '';")))

        print("\nActing on all of them")
        chosen = await b.js("return [...document.querySelectorAll('.row.sel')].map(r=>r.dataset.todoId);")
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'o',code:'KeyO',metaKey:true,bubbles:true})); return true;")
        await asyncio.sleep(2.5)
        parked = await b.js("const r=await fetch('/api/lists/someday'); const d=await r.json(); "
                            "const want=%s; return want.filter(i=>d.items.some(t=>t.id===i)).length;" % chosen)
        check("⌘O parks every one of them", parked == len(chosen), f"{parked} of {len(chosen)}")

        # put them back
        await b.goto(args.url + "/someday"); await asyncio.sleep(3)
        for i in chosen:
            await b.js("await fetch('/api/todos/%s',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({someday:false})}); return true;" % i)
        await asyncio.sleep(1)
        back = await b.js("const r=await fetch('/api/lists/someday'); const d=await r.json(); "
                          "const want=%s; return want.every(i=>!d.items.some(t=>t.id===i));" % chosen)
        check("and they come back", bool(back))

        print("\nEscape")
        await b.goto(args.url + "/project/" + pid)
        await b.wait_for("document.querySelectorAll('[data-todo-id]').length > 4", timeout=20)
        await b.js(CLICK + "clickRow('%s'); return clickRow('%s', {shiftKey:true});" % (ids[0], ids[3]))
        await asyncio.sleep(0.5)
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true})); return true;")
        await asyncio.sleep(0.5)
        check("Escape narrows to one rather than losing it all",
              await b.js("return document.querySelectorAll('.row.sel').length;") == 1)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: " + "; ".join(FAILURES))
        return 1
    print("multi-select works")
    return 0


raise SystemExit(asyncio.run(main()))
