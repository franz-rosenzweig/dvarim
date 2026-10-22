#!/usr/bin/env python3
"""The mirror (frontend/src/lib/backend.js), in a real browser, against a
server it runs itself over --root: a COPY of a vault, never the vault.

    tools/e2e_mirror.py --root /tmp/dv-mirror/vault --auth /tmp/dv-mirror/secrets/auth.json \\
        --password '…' --port 8439 --devtools http://172.19.0.17:9222

The server runs in a container inside the browser's own network
(--network container:docker-chrome-1), so the page is at http://localhost:PORT:
a service worker works only on a secure origin, and localhost is one, which is
what lets the page load again with no server. This side reaches it at the
browser container's address.

1. Signing in copies the whole vault to the browser, and leaves every file on
   the server exactly as it was.
2. Every list, project and area the browser answers is what the server answers.
3. With the server stopped: every list opens, ones never visited included; a
   to-do made, dated today (and so moved into Today), ticked; a project made;
   and all of it still there after a reload with no server.
4. The server back: the changes reach its files by themselves, and a line
   typed into a file on the server (as in Obsidian) reaches the browser.
5. Signing out takes the copy off the browser.
"""
import argparse, asyncio, json, os, subprocess, sys, time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

MADE = "Made with no network (e2e)"
TYPED = "Typed on the server while the browser watched (e2e)"


class Server:
    """The server, in a container that shares the browser's network."""
    NAME = "dv-mirror-e2e"

    def __init__(self, args):
        self.args = args
        self.url = f"http://localhost:{args.port}"                 # as the page has it
        self.direct = f"http://{args.chrome_ip}:{args.port}"       # as this side reaches it
        self.made = False

    def start(self):
        if not self.made:
            work = Path(self.args.root).parent
            subprocess.run(["docker", "rm", "-f", self.NAME], capture_output=True)
            subprocess.run(["docker", "run", "-d", "--name", self.NAME, "--network", f"container:{self.args.chrome}",
                            "-u", f"{os.getuid()}:{os.getgid()}", "-e", "TZ=America/Phoenix",
                            "-v", f"{HERE.parent}:/repo:ro", "-v", f"{work}:/w",
                            "-e", f"DVARIM_ROOT=/w/{Path(self.args.root).name}",
                            "-e", f"DVARIM_AUTH_FILE=/w/{Path(self.args.auth).relative_to(work)}",
                            "-e", "DVARIM_STATIC=/repo/frontend/dist", "-e", f"PORT={self.args.port}", "-e", "HOST=0.0.0.0",
                            "node:22-alpine", "node", "/repo/server/src/main.js"], check=True, capture_output=True)
            self.made = True
        else:
            subprocess.run(["docker", "start", self.NAME], check=True, capture_output=True)
        for _ in range(120):
            try:
                if httpx.get(self.direct + "/api/health", timeout=1).status_code == 200:
                    return
            except Exception:
                pass
            time.sleep(0.25)
        raise SystemExit("the server did not start")

    def stop(self):
        subprocess.run(["docker", "stop", "-t", "3", self.NAME], capture_output=True)

    def remove(self):
        subprocess.run(["docker", "rm", "-f", self.NAME], capture_output=True)


def files(root: Path) -> dict:
    """Every note on the server, and the two state files, as text."""
    out = {}
    for p in root.rglob("*"):
        rel = p.relative_to(root).as_posix()
        if p.is_file() and (rel.endswith(".md") and not rel.startswith(".") or rel in (".dvarim/state.json",)):
            if ".sync-conflict-" in rel or rel.startswith(".dvarim/conflicts"):
                continue
            out[rel] = p.read_text()
    return out


async def local_get(b, path):
    return await b.js("return await (await fetch(%s)).json();" % json.dumps("/api" + path))


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="the throwaway server's data: a copy")
    ap.add_argument("--auth", required=True, help="its auth file, with --password set")
    ap.add_argument("--password", required=True)
    ap.add_argument("--port", type=int, default=8439)
    ap.add_argument("--chrome", default="docker-chrome-1", help="the browser's container, whose network the server joins")
    ap.add_argument("--chrome-ip", default="172.19.0.17")
    ap.add_argument("--devtools", default="http://172.19.0.17:9222")
    args = ap.parse_args()
    refuse_live_data(args.root)
    root = Path(args.root)
    srv = Server(args)
    srv.start()
    before = files(root)
    print(f"a vault of {sum(1 for p in before if p.endswith('.md'))} notes")

    try:
        async with Browser(args.devtools) as b:
            await b.send("Emulation.setDeviceMetricsOverride", {"width": 1200, "height": 900, "deviceScaleFactor": 1, "mobile": False})
            # the server's day is the browser's: both on America/Phoenix, the zone the server runs in here
            await b.send("Emulation.setTimezoneOverride", {"timezoneId": "America/Phoenix"})
            await b.send("Network.clearBrowserCookies")
            await b.goto(srv.url + "/today")
            await b.js("""localStorage.clear();
              for (const d of (await indexedDB.databases?.()) || []) indexedDB.deleteDatabase(d.name);
              return true;""")
            await b.goto(srv.url + "/today")

            print("\n1. Signing in copies the vault to the browser")
            await b.wait_for("!!document.querySelector('#pw')", timeout=20)
            await b.js("""const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              const pw = document.querySelector('#pw'); set.call(pw, %s); pw.dispatchEvent(new Event('input', {bubbles: true}));
              pw.form.requestSubmit(); return true;""" % json.dumps(args.password))
            t0 = time.time()
            ok = await b.wait_for("window.__dvarimLocal?.kind === 'mirror' && !!document.querySelector('.nav')", timeout=90)
            check("the page opens on a copy of the vault", bool(ok), f"{time.time() - t0:.1f}s")
            await asyncio.sleep(2)
            mine = await b.js("return await window.__dvarimLocal.snapshot();")
            notes = {p: t for p, t in before.items() if p.endswith(".md")}
            mine_notes = {p: t for p, t in mine.items() if p.endswith(".md") and not p.startswith(".")}
            diff = sorted(p for p in set(notes) | set(mine_notes) if notes.get(p) != mine_notes.get(p))
            check("every note here, byte for byte", not diff, str(diff[:5]))
            after = files(root)
            changed = sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))
            check("and nothing on the server rewritten", not changed, str(changed[:5]))

            print("\n2. The browser answers as the server does")
            cookie = "; ".join(f"{c['name']}={c['value']}" for c in (await b.send("Network.getCookies", {"urls": [srv.url]}))["cookies"])
            server = httpx.Client(base_url=srv.direct + "/api", headers={"Cookie": cookie}, timeout=20)
            state = server.get("/state").json()
            projects = [p["id"] for a in state["areas"] for p in a["projects"]] + [p["id"] for p in state["looseProjects"]]
            areas = [a["id"] for a in state["areas"]]
            paths = ["/state", "/lists/inbox", "/lists/today", "/lists/upcoming", "/lists/anytime", "/lists/someday",
                     "/lists/logbook", "/lists/tomorrow", "/lists/deadlines", "/lists/repeating", "/tags"] + \
                    [f"/projects/{p}" for p in projects] + [f"/areas/{a}" for a in areas]
            differ = []
            for path in paths:
                if await local_get(b, path) != server.get(path).json():
                    differ.append(path)
            check(f"all {len(paths)} lists, projects and areas the same", not differ, str(differ[:5]))
            counts = {}
            for path in ["/lists/inbox", "/lists/today", "/lists/anytime", "/lists/someday"] + [f"/projects/{p}" for p in projects]:
                counts[path] = sum(1 for t in server.get(path).json().get("items", []) if t.get("status") == "open")

            print("\n3. With the server stopped")
            srv.stop()
            opened, missing = 0, []
            for sel, path in [("[data-drop-list=inbox]", "/lists/inbox"), ("[data-drop-list=today]", "/lists/today"),
                              ("[data-drop-list=anytime]", "/lists/anytime"), ("[data-drop-list=someday]", "/lists/someday"),
                              ("[data-drop-list=upcoming]", None), ("[data-drop-list=logbook]", None)] + \
                             [(f"[data-drop-project='{p}']", f"/projects/{p}") for p in projects] + \
                             [(f"[data-drop-area='{a}']", None) for a in areas]:
                await b.js("document.querySelector(%s)?.scrollIntoView({block: 'center'}); document.querySelector(%s)?.click(); return true;" % (json.dumps(sel), json.dumps(sel)))
                await asyncio.sleep(0.35)
                shown = await b.js("return document.querySelectorAll('.content [data-todo-id]').length;")
                if path and counts.get(path) and shown == 0:
                    missing.append(sel)
                opened += 1
            check(f"{opened} lists, projects and areas open, every one with its to-dos", not missing, str(missing[:5]))
            made = await b.js("""
              const t = await (await fetch('/api/todos', {method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({title: %s, inbox: true})})).json();
              return t.id;""" % json.dumps(MADE))
            check("a to-do made", bool(made))
            today = (await local_get(b, "/lists/today"))["date"]
            await b.js("await fetch('/api/todos/%s', {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({when: %s})}); return true;" % (made, json.dumps(today)))
            check("dated today, it is in Today: moved, not only changed", made in [t["id"] for t in (await local_get(b, "/lists/today"))["items"]])
            await b.js("document.querySelector('[data-drop-list=today]').click(); return true;")
            check("and on screen there", await b.wait_for("!!document.querySelector('[data-todo-id=\"%s\"]')" % made, timeout=8))
            victim = next((t["id"] for t in (await local_get(b, "/lists/anytime"))["items"] if t["status"] == "open"), None)
            await b.js("await fetch('/api/todos/%s/complete', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}); return true;" % victim)
            check("a to-do ticked", (await local_get(b, f"/todos/{victim}"))["status"] == "done")
            proj = await b.js("return (await (await fetch('/api/projects', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Offline project e2e'})})).json()).id;")
            check("a project made", bool(proj))
            check("the strip says it is offline, and that it all still works",
                  await b.wait_for("document.querySelector('.offline')?.innerText.includes('Everything works on this device')", timeout=20))
            await b.goto(srv.url + "/today")
            check("reloaded with no server, it opens on the copy", await b.wait_for("window.__dvarimLocal?.kind === 'mirror' && !!document.querySelector('.nav')", timeout=25))
            check("with the changes in it", await b.wait_for("!!document.querySelector('[data-todo-id=\"%s\"]')" % made, timeout=10))

            print("\n4. The server back")
            srv.start()
            deadline = time.time() + 45
            def landed():
                return MADE in "".join(files(root).values()) and (root / "Projects" / "Offline project e2e.md").exists()
            while time.time() < deadline and not landed():
                await asyncio.sleep(1)
            check("the changes reach its files by themselves", landed(), f"after {45 - max(0, deadline - time.time()):.0f}s")
            if not landed():
                print("   sync:", await b.js("try { return JSON.stringify(await window.__dvarimLocal.sync()); } catch (e) { return 'failed: ' + e.message; }"))
                print("   page:", "\n         ".join(b.console[-8:]))
            server = httpx.Client(base_url=srv.direct + "/api", headers={"Cookie": cookie}, timeout=20)
            check("dated today and ticked there too",
                  made in [t["id"] for t in server.get("/lists/today").json()["items"]] and server.get(f"/todos/{victim}").json()["status"] == "done")
            inbox = root / "Inbox.md"
            inbox.write_text(inbox.read_text() + f"- [ ] {TYPED}\n")
            check("a line typed on the server reaches the browser", await b.wait_for(
                "(async () => (await (await fetch('/api/lists/inbox')).json()).items.some(t => t.title === %s))()" % json.dumps(TYPED), timeout=30))

            print("\n5. Signing out")
            await b.js("document.querySelector('.sidefoot [aria-label=\"Settings\"]').click(); return true;")
            await b.wait_for("!!document.querySelector('#pane-tab-account')", timeout=8)
            await b.js("document.querySelector('#pane-tab-account').click(); return true;")
            await b.wait_for("[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Sign out')", timeout=8)
            await b.js("[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Sign out').click(); return true;")
            await b.wait_for("!!document.querySelector('#pw')", timeout=20)
            await asyncio.sleep(1)
            dbs = await b.js("return ((await indexedDB.databases?.()) || []).map(d => d.name);")
            check("the copy is gone from the browser", not any(n.startswith("dvarim-mirror") for n in dbs), str(dbs))
    finally:
        srv.remove()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: " + "; ".join(FAILURES))
        return 1
    print("the mirror works")
    return 0


raise SystemExit(asyncio.run(main()))
