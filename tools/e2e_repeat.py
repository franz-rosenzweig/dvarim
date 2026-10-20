#!/usr/bin/env python3
"""The repeat editor, driven in a real browser.

    tools/e2e_repeat.py --url http://172.19.0.1:8425
"""
import argparse, asyncio, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--password-file")
    ap.add_argument("--devtools", default="http://172.19.0.16:9222")
    args = ap.parse_args()
    refuse_live_data(None, args.url)
    pw = Path(args.password_file).read_text().strip() if args.password_file else None

    async with Browser(args.devtools) as b:
        await b.goto(args.url + "/today")
        await asyncio.sleep(3)
        if pw and await b.js("return !!document.querySelector('#pw');"):
            await b.js("const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:%r})}); return r.status;" % pw)
            await asyncio.sleep(1.5)

        # A few days out, so it is in Upcoming whenever this runs. It was a fixed
        # date, which was in the past two days after it was written, and the
        # to-do was in Today where this looked for it in vain.
        tid = await b.js("""
            const today = (await (await fetch('/api/state')).json()).today;
            const d = new Date(today + 'T12:00:00');
            d.setDate(d.getDate() + 3);
            const when = d.toISOString().slice(0, 10);
            const r = await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({title:'Water the plants', when})});
            return (await r.json()).id;
        """)
        await b.goto(args.url + "/upcoming"); await asyncio.sleep(3)
        await b.js("const r=document.querySelector('[data-todo-id=\"%s\"]'); r.click(); r.click(); return true;" % tid)
        await asyncio.sleep(1.2)
        check("the card opens", bool(await b.wait_for("!!document.querySelector('.card .ttl')", timeout=10)))

        await b.js("document.querySelector('.card .icons button[aria-label=\"Repeat\"]')?.click(); return true;")
        check("the repeat editor opens", bool(await b.wait_for("!!document.querySelector('.rep')", timeout=8)))
        print("  default preview:", await b.js("return document.querySelector('.preview')?.textContent?.trim();"))

        print("\n  building: every 2 weeks on Monday and Thursday")
        await b.js("""
            const set=(el,v)=>{const p=el.tagName==='SELECT'?window.HTMLSelectElement:window.HTMLInputElement;
              Object.getOwnPropertyDescriptor(p.prototype,'value').set.call(el,v);
              el.dispatchEvent(new Event('change',{bubbles:true}));
              el.dispatchEvent(new Event('input',{bubbles:true}));};
            set(document.querySelector('.rep input[type=number]'), '2');
            set(document.querySelector('.rep select'), 'week');
            return true;
        """)
        await asyncio.sleep(0.8)
        # pick exactly Monday and Thursday
        await b.js("""
            const btns=[...document.querySelectorAll('.days button')];
            btns.forEach(b => { if (b.getAttribute('aria-pressed')==='true') b.click(); });
            btns[0].click(); btns[3].click();
            return true;
        """)
        await asyncio.sleep(1.5)
        prev = await b.js("return document.querySelector('.preview')?.textContent?.trim();")
        check("it previews real dates", 'Next:' in (prev or ''), str(prev))
        print("  preview:", prev)

        await b.js("[...document.querySelectorAll('.acts button')].find(x=>/Repeat|Update/.test(x.textContent))?.click(); return true;")
        await asyncio.sleep(2)
        rule = await b.js("const r=await fetch('/api/todos/%s'.replace('/todos/','/lists/upcoming?x=')); "
                          "const d=await (await fetch('/api/lists/upcoming')).json(); "
                          "const all=d.days.flatMap(x=>x.items); "
                          "return (all.find(t=>t.id==='%s')||{}).repeat || null;" % (tid, tid))
        check("the rule is saved", rule == 'every 2 weeks on Monday, Thursday', str(rule))

        print("\n  after completion, ending after 5")
        await b.js("const r=document.querySelector('[data-todo-id=\"%s\"]'); r.click(); r.click(); return true;" % tid)
        await asyncio.sleep(1.2)
        await b.js("document.querySelector('.card .icons button[aria-label=\"Repeat\"]')?.click(); return true;")
        await b.wait_for("!!document.querySelector('.rep')", timeout=8)
        loaded = await b.js("return document.querySelector('.rep input[type=number]')?.value;")
        check("it opens showing the existing rule", loaded == '2', str(loaded))
        await b.js("[...document.querySelectorAll('.seg button')].find(x=>x.textContent.includes('After'))?.click(); return true;")
        await asyncio.sleep(0.5)
        await b.js("""
            const sels=[...document.querySelectorAll('.rep select')];
            const ends=sels[sels.length-1];
            Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(ends,'after');
            ends.dispatchEvent(new Event('change',{bubbles:true}));
            return true;
        """)
        await asyncio.sleep(1.2)
        await b.js("[...document.querySelectorAll('.acts button')].find(x=>/Update|Repeat/.test(x.textContent))?.click(); return true;")
        await asyncio.sleep(2)
        rule2 = await b.js("const d=await (await fetch('/api/lists/upcoming')).json(); "
                           "const all=d.days.flatMap(x=>x.items); return (all.find(t=>t.id==='%s')||{}).repeat || null;" % tid)
        check("when done and an end condition both save", rule2 and 'when done' in rule2 and 'times' in rule2, str(rule2))
        print("  saved:", rule2)

        print("\n  completing it makes the next one")
        res = await b.js("const r=await fetch('/api/todos/%s/complete',{method:'POST'}); return await r.json();" % tid)
        check("a next instance appears", bool(res.get('next')), str(res)[:120])
        if res.get('next'):
            print("  next:", res['next']['when'], '|', res['next']['repeat'])
            await b.js("await fetch('/api/todos/%s', {method:'DELETE'}); return true;" % res['next']['id'])
        await b.js("await fetch('/api/trash/empty',{method:'POST'}); return true;")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: " + "; ".join(FAILURES))
        return 1
    print("the repeat editor works")
    return 0


raise SystemExit(asyncio.run(main()))
