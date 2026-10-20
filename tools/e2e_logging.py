#!/usr/bin/env python3
"""Today grouping and the three Logbook logging modes, in a real browser."""
import argparse, asyncio, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--devtools", default="http://172.19.0.16:9222")
    args = ap.parse_args()
    refuse_live_data(None, args.url)

    async with Browser(args.devtools) as b:
        async def settings(patch):
            await b.js("await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},"
                       "body:JSON.stringify(%s)}); return true;" % patch)

        await b.goto(args.url + "/today")
        await b.wait_for("document.querySelectorAll('.item').length > 3", timeout=25)

        print("\nGrouping Today by list")
        # Today is empty in a fresh copy, so give it something from two different
        # projects plus one loose to-do — the three cases the grouping has to get right.
        seeded = await b.js("""
            const st = await (await fetch('/api/state')).json();
            const a = st.areas[0], b2 = st.areas[1];
            const mk = async (title, extra) => {
              const r = await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify(Object.assign({title, when: st.today}, extra))});
              return (await r.json()).id;
            };
            return [
              await mk('Grouped A', {projectId: a.projects[0].id}),
              await mk('Grouped B', {projectId: b2.projects[0].id}),
              await mk('Loose one', {}),
            ];
        """)
        await settings('{"groupTodayByList": false}')
        await b.goto(args.url + "/today"); await asyncio.sleep(2.5)
        flat_heads = await b.js("return document.querySelectorAll('.hd.grp').length;")
        check("off: one flat list", flat_heads == 0, f"{flat_heads} headings")

        await settings('{"groupTodayByList": true}')
        await b.goto(args.url + "/today"); await asyncio.sleep(2.5)
        heads = await b.js("return [...document.querySelectorAll('.hd.grp')].map(h=>h.textContent.trim());")
        check("on: a heading per list", len(heads) > 0, str(heads))
        print("  headings:", heads)
        rows = await b.js("return document.querySelectorAll('.rows [data-todo-id]').length;")
        check("and no to-do is lost in the regrouping", rows >= 3, f"{rows} rows")
        check("the loose to-do sits above the headings", bool(await b.js("""
            const first = document.querySelector('.rows [data-todo-id], .hd.grp');
            return first && !first.classList.contains('hd');
        """)))
        await settings('{"groupTodayByList": false}')
        for i in seeded:
            await b.js("await fetch('/api/todos/%s',{method:'DELETE'}); return true;" % i)
        await b.js("await fetch('/api/trash/empty',{method:'POST'}); return true;")

        # Whatever happens in here, the server must not be left in a mode
        # the next suite does not expect.
        try:
            print("\nLogging: immediately")
            await settings('{"logCompleted": "immediately"}')
            tid = await b.js("""
                const today = (await (await fetch('/api/state')).json()).today;
                const r = await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
                  body: JSON.stringify({title:'Logging mode probe', when: today})});
                const t = await r.json();
                await fetch('/api/todos/' + t.id + '/complete', {method:'POST'});
                return t.id;
            """)
            await b.goto(args.url + "/today"); await asyncio.sleep(2.5)
            check("it leaves the list at once", not await b.js("return !!document.querySelector('[data-todo-id=\"%s\"]');" % tid))
            await b.goto(args.url + "/logbook"); await asyncio.sleep(2.5)
            check("and is in the Logbook", bool(await b.js("return !!document.querySelector('[data-todo-id=\"%s\"]');" % tid)))

            print("\nLogging: manually")
            await settings('{"logCompleted": "manually", "logCutoff": null}')
            await b.goto(args.url + "/today"); await asyncio.sleep(2.5)
            check("the completed one comes back to its list", bool(await b.js("return !!document.querySelector('[data-todo-id=\"%s\"]');" % tid)))
            check("shown as done", bool(await b.js("return document.querySelector('[data-todo-id=\"%s\"]')?.classList.contains('done');" % tid)))

            await b.goto(args.url + "/logbook"); await asyncio.sleep(2.5)
            check("the Logbook offers to file it", bool(await b.js("return !!document.querySelector('.pendrow button');")))
            print("  banner:", await b.js("return document.querySelector('.pendrow')?.textContent?.trim().slice(0,80);"))
            await b.js("document.querySelector('.pendrow button')?.click(); return true;")
            await asyncio.sleep(2.5)
            check("Log Now files it", bool(await b.js("return !!document.querySelector('[data-todo-id=\"%s\"]');" % tid)))
            await b.goto(args.url + "/today"); await asyncio.sleep(2.5)
            check("and it leaves the list", not await b.js("return !!document.querySelector('[data-todo-id=\"%s\"]');" % tid))

            print("\nLogging: daily")
            await settings('{"logCompleted": "daily"}')
            tid2 = await b.js("""
                const today = (await (await fetch('/api/state')).json()).today;
                const r = await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
                  body: JSON.stringify({title:'Daily mode probe', when: today})});
                const t = await r.json();
                await fetch('/api/todos/' + t.id + '/complete', {method:'POST'});
                return t.id;
            """)
            await b.goto(args.url + "/today"); await asyncio.sleep(2.5)
            check("completed today stays put", bool(await b.js("return !!document.querySelector('[data-todo-id=\"%s\"]');" % tid2)))

        finally:
            await settings('{"logCompleted": "immediately"}')
    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: " + "; ".join(FAILURES))
        return 1
    print("grouping and logging modes work")
    return 0


raise SystemExit(asyncio.run(main()))
