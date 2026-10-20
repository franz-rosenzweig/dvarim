#!/usr/bin/env python3
"""Drive the real web app in a real browser and check the Markdown files change.

Unit tests cover the backend and the build proves the client compiles; neither
shows that clicking a checkbox in the UI reaches the file on disk. This does.
It talks to Chrome over the DevTools Protocol, so it needs no Node and no
browser on the host — only the docker-chrome container.

    tools/e2e_smoke.py --url http://172.19.0.1:8422 --root /tmp/dv-e2e

Every step prints PASS or FAIL and the script exits non-zero on the first FAIL.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
from pathlib import Path

import httpx
import websockets

FAILURES: list[str] = []

# Paths that must never be a test target. These tools complete to-dos, duplicate
# them, create projects and empty the Trash; pointed at the real vault they do
# all of that to real data. Learned the hard way on 2026-09-20.
PROTECTED = (
    "/srv/obsidian/",
    "/Users/",
)


def refuse_live_data(root: str | None, url: str | None = None) -> None:
    """Abort rather than run destructive tests against somebody's notes."""
    import os
    if root:
        real = os.path.realpath(root)
        for bad in PROTECTED:
            if real.startswith(bad):
                raise SystemExit(
                    f"refusing to run: {real} looks like the real vault.\n"
                    "Copy it first:  cp -r <vault>/Tasks /tmp/dv-test && rm -rf /tmp/dv-test/.dvarim\n"
                    "then point --root and the server at the copy."
                )
    if url and os.environ.get("DVARIM_ALLOW_LIVE") != "1":
        # the public URL serves the real vault; read-only checks are fine, but
        # these suites are not read-only
        if "tiresia.xyz" in url or "100.91.202.11" in url:
            raise SystemExit(
                f"refusing to run against {url}: that is the live app on the real vault.\n"
                "Start a throwaway server on a copy, or set DVARIM_ALLOW_LIVE=1 if you truly mean it."
            )


def check(name: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(name)
    return ok


class Browser:
    def __init__(self, devtools: str):
        self.devtools = devtools
        self.ws = None
        self.n = 0
        self.console = []          # what the page logged, and errors it threw: for saying why

    async def __aenter__(self):
        info = httpx.get(f"{self.devtools}/json/new?about:blank", timeout=10)
        if info.status_code >= 400:
            info = httpx.put(f"{self.devtools}/json/new?about:blank", timeout=10)
        self.target = info.json()
        self.ws = await websockets.connect(self.target["webSocketDebuggerUrl"], max_size=40 * 1024 * 1024)
        await self.send("Page.enable")
        await self.send("Runtime.enable")
        # Every suite opens its own tab, and a background tab does not receive
        # Input.dispatchKeyEvent — which showed up as one or two shortcut
        # checks failing at random depending on what ran before.
        await self.send("Page.bringToFront")
        try:
            await self.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
        except RuntimeError:
            pass          # older Chrome: bringToFront alone will have to do
        return self

    async def __aexit__(self, *a):
        if self.ws:
            await self.ws.close()
        try:
            httpx.get(f"{self.devtools}/json/close/{self.target['id']}", timeout=5)
        except Exception:
            pass

    async def send(self, method: str, params: dict | None = None):
        self.n += 1
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("method") == "Runtime.consoleAPICalled":
                args = msg["params"].get("args", [])
                self.console.append(msg["params"].get("type", "log") + ": " + " ".join(str(a.get("value", a.get("description", ""))) for a in args))
            elif msg.get("method") == "Runtime.exceptionThrown":
                d = msg["params"].get("exceptionDetails", {})
                self.console.append("exception: " + str((d.get("exception") or {}).get("description") or d.get("text")))
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    async def goto(self, url: str):
        await self.send("Page.navigate", {"url": url})
        await asyncio.sleep(1.0)

    async def js(self, expr: str):
        r = await self.send("Runtime.evaluate", {
            "expression": f"(async () => {{ {expr} }})()",
            "awaitPromise": True, "returnByValue": True,
        })
        res = r.get("result", {})
        if r.get("exceptionDetails"):
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:400])
        return res.get("value")

    async def wait_for(self, expr: str, timeout: float = 20.0, every: float = 0.25):
        """Poll a JS expression until it is truthy; returns its value or None."""
        waited = 0.0
        while waited < timeout:
            v = await self.js(f"return ({expr});")
            if v:
                return v
            await asyncio.sleep(every)
            waited += every
        return None


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="the running app, reachable from the browser container")
    ap.add_argument("--root", required=True, help="the data folder that app is serving")
    ap.add_argument("--devtools", default="http://172.19.0.17:9222")
    args = ap.parse_args()
    refuse_live_data(args.root, args.url)
    root = Path(args.root)
    TODAY = httpx.get(args.url + "/api/state", timeout=10).json()["today"]

    def read(rel: str) -> str:
        p = root / rel
        return p.read_text("utf-8") if p.exists() else ""

    def find_file(title: str) -> Path | None:
        for p in root.rglob("*.md"):
            if title in p.read_text("utf-8", errors="replace"):
                return p
        return None

    async with Browser(args.devtools) as b:
        # The page keeps a copy of the vault in the browser (the mirror), and
        # the browser keeps it between runs. A copy of an earlier run's vault
        # at the same address brings that run's settings and agreements here.
        origin = re.match(r"https?://[^/]+", args.url).group(0)
        await b.send("Storage.clearDataForOrigin", {"origin": origin, "storageTypes": "all"})

        print("\n1. Loading the app")
        await b.goto(args.url + "/today")
        ok = await b.wait_for("document.querySelectorAll('.item').length > 3")
        check("the app boots and the sidebar renders", bool(ok))
        title = await b.js("return document.querySelector('h1.t .name')?.textContent || '';")
        check("it opens on Today", title.strip() == "Today", f"got {title!r}")

        print("\n2. Deep link to a project")
        pid = await b.js("const r = await fetch('/api/state').then(r=>r.json());"
                         "return (r.areas[0]?.projects[0]?.id) || null;")
        check("the API reports at least one project", bool(pid))
        await b.goto(f"{args.url}/project/{pid}")
        name = await b.wait_for("document.querySelector('h1.t .name')?.textContent")
        check("the deep link opens that project", bool(name), f"title was {name!r}")
        rows = await b.js("return document.querySelectorAll('.row').length;")
        check("the project's to-dos render", rows > 0, f"{rows} rows")

        print("\n3. Completing a to-do writes to the Markdown file")
        first = await b.js("""
            const row = document.querySelector('.row[data-todo-id]');
            if (!row) return null;
            return { id: row.dataset.todoId, title: row.querySelector('.txt')?.textContent || '' };
        """)
        check("a to-do row is present", bool(first))
        if not first:
            return 1
        path = find_file(first["title"][:40])
        check("that to-do exists in a file on disk", path is not None, first["title"][:40])
        before = read(path.relative_to(root).as_posix()) if path else ""
        await b.js("document.querySelector('.row[data-todo-id] .cb')?.click(); return true;")
        await asyncio.sleep(2.0)
        after = read(path.relative_to(root).as_posix()) if path else ""
        line_now = next((l for l in after.splitlines() if first["title"][:30] in l), "")
        check("the file changed", before != after)
        check("the line is now ticked", line_now.strip().startswith("- [x]"), line_now[:80])
        check("it carries a completion date", bool(re.search(r"✅ \d{4}-\d{2}-\d{2}", line_now)), line_now[:80])
        check("the row left the list", not await b.js(
            f"return !!document.querySelector('.row[data-todo-id=\\'{first['id']}\\']');"))

        print("\n4. Un-completing it from the Logbook puts it back")
        await b.goto(args.url + "/logbook")
        await b.wait_for("document.querySelectorAll('.row').length > 0")
        clicked = await b.js(f"""
            const row = document.querySelector('.row[data-todo-id="{first['id']}"]');
            if (!row) return false;
            row.querySelector('.cb')?.click();
            return true;
        """)
        check("the completed to-do is in the Logbook", bool(clicked))
        await asyncio.sleep(2.0)
        after2 = read(path.relative_to(root).as_posix()) if path else ""
        line2 = next((l for l in after2.splitlines() if first["title"][:30] in l), "")
        check("the file is back to open", line2.strip().startswith("- [ ]"), line2[:80])
        check("the completion date is gone", "✅" not in line2, line2[:80])

        print("\n5. Creating a to-do from the UI")
        await b.goto(args.url + "/inbox")
        await b.wait_for("document.querySelector('.toolbar')")
        await b.js("document.querySelector('#tb-add, .toolbar button')?.click(); return true;")
        await asyncio.sleep(1.5)
        editing = await b.js("return !!document.querySelector('.card .ttl');")
        check("the new to-do opens its editor", bool(editing))
        # the title is a bound <textarea>: set .value and fire the events Svelte listens for
        await b.js("""
            const t = document.querySelector('.card .ttl');
            if (!t) return false;
            t.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(t, 'Typed in the browser');
            t.dispatchEvent(new Event('input', { bubbles: true }));
            t.dispatchEvent(new Event('change', { bubbles: true }));
            t.blur();
            return true;
        """)
        await asyncio.sleep(2.0)
        inbox = read("Inbox.md")
        check("it lands in Inbox.md", "Typed in the browser" in inbox, inbox[:120])
        check("it was given a stable id", bool(re.search(r"Typed in the browser.*🆔 \w+", inbox)), inbox[:160])

        print("\n5b. Scheduling from the When popover reaches the file")
        # the exact thing that looked broken: the popover opens, you pick Today,
        # and the Markdown line must gain a start date.
        await b.goto(args.url + "/inbox")
        await b.wait_for("document.querySelectorAll('.row[data-todo-id]').length > 0")
        tid = await b.js("return document.querySelector('.row[data-todo-id]')?.dataset.todoId || null;")
        check("an Inbox to-do to schedule", bool(tid))
        await b.js(f"""
            const row = document.querySelector('.row[data-todo-id="{tid}"]');
            row.click();
            return true;
        """)
        await asyncio.sleep(0.8)
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'s', metaKey:true, bubbles:true})); return true;")
        opened = await b.wait_for("[...document.querySelectorAll('.opt .lbl')].some(e => e.textContent.trim() === 'Today')", timeout=8)
        check("the When popover opens with a Today option", bool(opened))
        await b.js("""
            const o = [...document.querySelectorAll('.opt')].find(e => e.querySelector('.lbl')?.textContent.trim() === 'Today');
            if (!o) return false;
            o.click();
            return true;
        """)
        await asyncio.sleep(2.0)
        inbox_now = read("Inbox.md")
        line = next((l for l in inbox_now.splitlines() if tid in l), "")
        check("the popover closed", not await b.js("return !!document.querySelector('.opt');"))
        check("the to-do now has today's start date", f"\u23f3 {TODAY}" in line, line[:110])
        in_today = await b.js("const r = await fetch('/api/lists/today').then(r=>r.json()); "
                              f"return r.items.some(t => t.id === '{tid}');")
        check("it appears in the Today list", bool(in_today))

        print("\n5c. Setting a deadline from the popover")
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'d', metaKey:true, shiftKey:true, bubbles:true})); return true;")
        dl = await b.wait_for("[...document.querySelectorAll('.opt .lbl')].some(e => e.textContent.trim() === 'Tomorrow')", timeout=8)
        check("the Deadline popover opens", bool(dl))
        await b.js("""
            const o = [...document.querySelectorAll('.opt')].find(e => e.querySelector('.lbl')?.textContent.trim() === 'Tomorrow');
            if (!o) return false;
            o.click();
            return true;
        """)
        await asyncio.sleep(2.0)
        line2b = next((l for l in read("Inbox.md").splitlines() if tid in l), "")
        check("the to-do now has a deadline", "\U0001f4c5" in line2b, line2b[:110])

        print("\n5d. Moving a to-do to a project from the Move popover")
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'m', metaKey:true, shiftKey:true, bubbles:true})); return true;")
        mv = await b.wait_for("document.querySelectorAll('.opt').length > 1", timeout=8)
        check("the Move popover opens with destinations", bool(mv))
        dest = await b.js("""
            const o = [...document.querySelectorAll('.opt')].find(e => {
              const t = e.querySelector('.lbl')?.textContent.trim();
              return t && t !== 'Inbox' && t !== 'No List';
            });
            if (!o) return null;
            const name = o.querySelector('.lbl').textContent.trim();
            o.click();
            return name;
        """)
        check("a destination was chosen", bool(dest), str(dest))
        await asyncio.sleep(2.0)
        moved = await b.js(f"const r = await fetch('/api/todos/{tid}'.replace('/todos/','/lists/inbox?_=')).then(()=>0); "
                           f"const st = await fetch('/api/lists/inbox').then(r=>r.json()); "
                           f"return !st.items.some(t => t.id === '{tid}');")
        check("the to-do left the Inbox", bool(moved))
        check("Inbox.md no longer holds it", tid not in read("Inbox.md"))

        print("\n6. Quick Find")
        await b.js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'f', metaKey:true, bubbles:true})); return true;")
        await asyncio.sleep(0.6)
        qf = await b.js("return !!document.querySelector('.qf input, .qf');")
        check("⌘F opens Quick Find", bool(qf))
        await b.js("""
            const i = document.querySelector('.qf input');
            if (!i) return false;
            i.focus(); i.value = 'Typed in the browser';
            i.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        """)
        found = await b.wait_for("[...document.querySelectorAll('.qf .r')].some(r => r.textContent.includes('Typed in the browser'))", timeout=8)
        check("it finds the to-do just created", bool(found))

        print("\n7. Settings persist to the server")
        await b.goto(args.url + "/?settings=1")
        await b.wait_for("document.querySelector('[role=dialog]')")
        check("the Settings sheet opens", bool(await b.js("return !!document.querySelector('[role=dialog]');")))
        await b.js("""
            const sel = document.querySelector('#set-log');
            if (!sel) return false;
            sel.value = 'daily';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        """)
        # changed in the page's copy first; the next sync round, a second and
        # a half after the change, takes it to the server
        srv = {}
        for _ in range(30):
            await asyncio.sleep(0.5)
            srv = httpx.get(args.url + "/api/settings", timeout=10).json()
            if srv.get("logCompleted") == "daily":
                break
        check("changing a setting reaches the server", srv.get("logCompleted") == "daily", str(srv))

        print("\n8. An edit made outside the app shows up live")
        await b.goto(args.url + "/inbox")
        await b.wait_for("document.querySelectorAll('.row').length > 0")
        (root / "Inbox.md").write_text(read("Inbox.md") + "- [ ] Added by another editor\n", "utf-8")
        live = await b.wait_for("[...document.querySelectorAll('.row .txt')].some(e => e.textContent.includes('Added by another editor'))", timeout=15)
        check("a file edit appears without reloading", bool(live))

        print("\n8b. An Android share becomes a to-do")
        await b.goto(args.url + "/share?title=A%20good%20article&text=Worth%20reading&url=https%3A%2F%2Fexample.com%2Fpost")
        check("the share sheet opens", bool(await b.wait_for("!!document.querySelector('#sh-title')", timeout=20)))
        check("it is pre-filled", await b.js("return document.querySelector('#sh-title').value;") == "A good article")
        await b.js("""
            const t = document.querySelector('#sh-title');
            const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            set.call(t, 'Shared and edited tomorrow #reading');
            t.dispatchEvent(new Event('input', {bubbles:true}));
            return true;
        """)
        await asyncio.sleep(0.4)
        check("an edit sticks (the pre-fill must not re-run)",
              await b.js("return document.querySelector('#sh-title').value;") == "Shared and edited tomorrow #reading")
        await b.js("document.querySelector('button[type=submit]').click(); return true;")
        await asyncio.sleep(2.5)
        blob = "\n".join(read(f) for f in ("Inbox.md", "Standalone.md"))
        line = next((l for l in blob.splitlines() if "Shared and edited" in l), "")
        check("the edited title reached a file", bool(line), blob[-200:])
        check("with its date and tag", "⏳" in line and "#reading" in line, line)

        print("\n9. No client-side errors")
        logs = await b.js("return (window.__cdpErrors||[]).length;")
        check("nothing threw during the run", not logs, str(logs))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
