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
        # The page shows its own copy of the vault, which hears of a change made
        # on the server only once the server has written it (a moment later) and
        # the copy has synced. So each check waits for what it expects, up to
        # WAIT seconds, rather than sleeping a fixed time and looking once.
        WAIT = 12
        row = lambda tid: "document.querySelector('[data-todo-id=\"%s\"]')" % tid
        async def there(tid):
            return bool(await b.wait_for("!!" + row(tid), timeout=WAIT))
        async def gone(tid):
            await b.wait_for("document.querySelectorAll('.content [data-todo-id]').length > 0 || !!document.querySelector('.empty')", timeout=WAIT)
            return bool(await b.wait_for("!" + row(tid), timeout=WAIT))

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
        await b.goto(args.url + "/today")
        await b.wait_for(" && ".join("!!" + row(i) for i in seeded), timeout=WAIT)
        flat_heads = await b.js("return document.querySelectorAll('.hd.grp').length;")
        check("off: one flat list", flat_heads == 0, f"{flat_heads} headings")

        await settings('{"groupTodayByList": true}')
        await b.goto(args.url + "/today")
        await b.wait_for("document.querySelectorAll('.hd.grp').length > 0", timeout=WAIT)
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
            await b.goto(args.url + "/today")
            check("it leaves the list at once", await gone(tid))
            await b.goto(args.url + "/logbook")
            check("and is in the Logbook", await there(tid))

            print("\nLogging: manually")
            await settings('{"logCompleted": "manually", "logCutoff": null}')
            await b.goto(args.url + "/today")
            check("the completed one comes back to its list", await there(tid))
            check("shown as done", bool(await b.wait_for("!!" + row(tid) + "?.classList.contains('done')", timeout=WAIT)))

            await b.goto(args.url + "/logbook")
            check("the Logbook offers to file it", bool(await b.wait_for("!!document.querySelector('.pendrow button')", timeout=WAIT)))
            print("  banner:", await b.js("return document.querySelector('.pendrow')?.textContent?.trim().slice(0,80);"))
            await b.js("document.querySelector('.pendrow button')?.click(); return true;")
            check("Log Now files it", await there(tid))
            await b.goto(args.url + "/today")
            check("and it leaves the list", await gone(tid))

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
            await b.goto(args.url + "/today")
            check("completed today stays put", await there(tid2))

        finally:
            await settings('{"logCompleted": "immediately"}')
    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: " + "; ".join(FAILURES))
        return 1
    print("grouping and logging modes work")
    return 0


raise SystemExit(asyncio.run(main()))
