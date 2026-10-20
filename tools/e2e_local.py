#!/usr/bin/env python3
"""Local mode: the app with a vault of its own, and no server behind it.

The page's requests are answered by the engine (engine/src/api.js) from a vault
in this browser's IndexedDB. This checks that it starts empty and separate from
the server's, that what is done through the interface lands in real Markdown,
that it survives a reload — and that with the server stopped altogether the app
still opens and still works. Then that switching back finds the server's vault
exactly as it was.

    tools/e2e_local.py --url http://172.19.0.1:8422 --root /tmp/dv-next \\
        --devtools http://172.19.0.10:9222 --stop-cmd '…next_server.sh --stop' --start-cmd '…next_server.sh'

--stop-cmd and --start-cmd stop and start the throwaway server; without them
the offline part is skipped.
"""
import argparse, asyncio, hashlib, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data


def vault_digest(root: Path) -> str:
    h = hashlib.sha1()
    for p in sorted(root.rglob("*.md")):
        h.update(str(p.relative_to(root)).encode() + b"\0" + p.read_bytes())
    return h.hexdigest()


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--root", required=True, help="the server's copy of the data, to prove it is left alone")
    ap.add_argument("--devtools", default="http://172.19.0.16:9222")
    ap.add_argument("--stop-cmd")
    ap.add_argument("--start-cmd")
    args = ap.parse_args()
    refuse_live_data(args.root, args.url)
    root = Path(args.root)
    server_before = vault_digest(root)

    async with Browser(args.devtools) as b:
      try:
        await run(b, args, root, server_before)
      finally:
        # Leave the browser as it was found, however this went: the switch to
        # local mode is remembered per origin, and a suite that stops half way
        # must not leave every later suite on that origin talking to an empty
        # browser vault. (It did, once.)
        try:
            await b.goto(args.url + "/today?backend=server")
            await b.js("""localStorage.clear();
                await new Promise((res) => { const r = indexedDB.deleteDatabase('dvarim-vault'); r.onsuccess = r.onerror = r.onblocked = res; });
                return true;""")
        except Exception:
            pass

    print("\n" + ("local mode works" if not FAILURES else f"{len(FAILURES)} failed: " + "; ".join(FAILURES)))
    return 1 if FAILURES else 0


async def run(b, args, root, server_before):
        snap = "return await window.__dvarimLocal.snapshot();"

        async def fresh_local():
            await b.goto(args.url + "/today")
            await b.js("""
                localStorage.clear();
                await new Promise((res) => { const r = indexedDB.deleteDatabase('dvarim-vault'); r.onsuccess = r.onerror = r.onblocked = res; });
                return true;""")
            await b.goto(args.url + "/today?backend=local")
            return await b.wait_for("!!window.__dvarimLocal && !!document.querySelector('.nav')", timeout=25)

        print("\nA vault of its own")
        check("local mode opens", bool(await fresh_local()))
        check("its vault is this browser's", await b.js("return window.__dvarimLocal.kind;") == "browser")
        check("the address does not keep the switch", "backend" not in await b.js("return location.search;"))
        files = await b.js(snap)
        check("it starts new: three empty lists and the tutorial",
              sorted(files) == ["Inbox.md", "Projects/Meet Dvarim.md", "Standalone.md", "Trash.md"]
              and not any(files[p] for p in ("Inbox.md", "Standalone.md", "Trash.md")), str(files)[:200])
        check("the server's to-dos are not in it: its one project is the tutorial", (await b.js(
            "return [...document.querySelectorAll('.nav [data-drop-project]')].map(x => x.textContent.trim()).join('|');")) == "Meet Dvarim")

        print("\nWork, through the interface")
        await b.goto(args.url + "/inbox")
        await b.wait_for("document.querySelector('.toolbar') !== null", timeout=20)
        await b.js("document.querySelector('#tb-add, .toolbar button')?.click(); return true;")
        await b.wait_for("!!document.querySelector('.card .ttl')", timeout=8)
        await b.js("""
            const t = document.querySelector('.card .ttl');
            t.focus();
            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            set.call(t, 'Made with no server');
            t.dispatchEvent(new Event('input', { bubbles: true }));
            t.blur();
            return true;""")
        await asyncio.sleep(1.2)
        await b.js("document.querySelector('.content').click(); return true;")
        await asyncio.sleep(1.0)
        inbox = (await b.js(snap))["Inbox.md"]
        check("a to-do made in the interface is a line of Markdown", "- [ ] Made with no server 🆔 " in inbox, inbox)

        # through the API the app and the suites use, which the engine answers
        made = await b.js("""
            const today = (await (await fetch('/api/state')).json()).today;
            const p = await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({name: 'Offline project'})})).json();
            await fetch('/api/projects/' + p.id + '/headings', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({name: 'Later'})});
            const t = await (await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({title: 'Due today', projectId: p.id, headingId: p.id + ':Later', when: today,
                                    notes: '**bold** note\\n- [ ] a task in the notes', repeat: 'every week'})})).json();
            return { pid: p.id, tid: t.id, today };""")
        await b.goto(args.url + "/today")
        await b.wait_for(f"!!document.querySelector('[data-todo-id=\"{made['tid']}\"]')", timeout=12)
        check("it shows in Today", True)
        await b.js(f"document.querySelector('[data-todo-id=\"{made['tid']}\"] .cb')?.click(); return true;")
        await asyncio.sleep(2.0)
        files = await b.js(snap)
        proj = files.get("Projects/Offline project.md", "")
        check("completing it writes the file", f"- [x] Due today 🆔 {made['tid']}" in proj and f"✅ {made['today']}" in proj, proj)
        check("and makes the next one, a week on", proj.count("Due today") == 2, proj)
        check("its notes keep their task line as notes", "    \\- [ ] a task in the notes" in proj, proj)
        check("the heading is a heading", "## Later\n" in proj, proj)

        print("\nIt lasts")
        await b.goto(args.url + "/inbox")
        await b.wait_for("!!document.querySelector('.nav')", timeout=20)
        titles = await b.js("return [...document.querySelectorAll('[data-todo-id]')].map(r => r.textContent);")
        check("a reload finds it all again", any("Made with no server" in t for t in titles), str(titles)[:200])

        if args.stop_cmd and args.start_cmd:
            print("\nNo server at all")
            await b.goto(args.url + "/inbox")                  # through the service worker, so it keeps the shell
            await asyncio.sleep(2.5)
            subprocess.run(args.stop_cmd, shell=True, check=True)
            await asyncio.sleep(1.0)
            await b.goto(args.url + "/inbox")
            opened = await b.wait_for("!!document.querySelector('.nav') && !!window.__dvarimLocal", timeout=20)
            check("with the server stopped, the app still opens", bool(opened))
            titles = await b.js("return [...document.querySelectorAll('[data-todo-id]')].map(r => r.textContent);")
            check("with everything in it", any("Made with no server" in t for t in titles), str(titles)[:200])
            tid = await b.js("""
                const r = await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
                  body: JSON.stringify({title: 'Written with the server gone', inbox: true})});
                return (await r.json()).id;""")
            await b.goto(args.url + "/inbox")
            await b.wait_for(f"!!document.querySelector('[data-todo-id=\"{tid}\"]')", timeout=12)
            check("and it still works", "Written with the server gone" in (await b.js(snap))["Inbox.md"])
            offline_strip = await b.js("return !!document.querySelector('.offline, [data-offline]');")
            check("and does not claim to be offline: there is nothing to be offline from", not offline_strip)
            subprocess.run(args.start_cmd, shell=True, check=True)
            await asyncio.sleep(1.0)

        print("\nBack to the server")
        await b.goto(args.url + "/inbox?backend=server")
        await b.wait_for("!!document.querySelector('.nav')", timeout=20)
        check("the switch back works", not await b.js("return !!window.__dvarimLocal;"))
        titles = await b.js("return [...document.querySelectorAll('[data-todo-id]')].map(r => r.textContent);")
        check("the server's Inbox does not have the local to-dos", not any("Made with no server" in t for t in titles))
        check("and the server's files were never touched", vault_digest(root) == server_before)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
