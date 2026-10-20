#!/usr/bin/env python3
"""Built-in sync, in a real browser: a vault of the app's own, synced through
Settings → Sync with a Dvarim server on another origin (so over CORS, with a
token).

Two kinds of vault:

- in the browser (IndexedDB), the page at --page:

    tools/e2e_sync.py --page http://localhost:8425 --server http://localhost:8426 \\
        --root /tmp/dv-sync --token dvt_… --devtools http://172.19.0.10:9222

- on a folder behind a shell, as the Mac and Android apps will run it: the
  shell is tools/bridge_sim.py on a new, empty --folder, run here twice, once
  with the page making the requests and once with the shell making them (the
  bridge's `http` op, as for a server that answers no page from elsewhere):

    tools/e2e_sync.py --page http://172.19.0.1:8422 --server http://172.19.0.1:8427 \\
        --root /tmp/dv-sync2 --token dvt_… --folder /tmp/dv-device --sim 172.19.0.1:8433

--server is the sync server, whose data folder is --root (a throwaway copy,
never the vault) and which --token opens.
"""
import argparse, asyncio, json, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data
import e2e_folder

STATUS = "return document.querySelector('[data-sync-state]')?.textContent.trim() || '';"
CLEAR = """localStorage.clear();
    await new Promise((res) => { const r = indexedDB.deleteDatabase('dvarim-vault'); r.onsuccess = r.onerror = r.onblocked = res; });
    return true;"""


async def settings_sync(b):
    await b.js("document.querySelector('.sidefoot [aria-label=\"Settings\"]').click(); return true;")
    await b.wait_for("document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"]') !== null")
    await b.js("document.querySelector('#pane-tab-sync').click(); return true;")
    await b.wait_for("!!document.querySelector('[data-sync-state]')", timeout=8)


async def close_settings(b):
    await b.js("document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"] .x').click(); return true;")


async def fill(b, sel, value):
    await b.js(f"""
        const el = document.querySelector({json.dumps(sel)});
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, {json.dumps(value)});
        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
        return true;""")


async def press(b, label):
    await b.js(f"[...document.querySelectorAll('.syncacts button')].find(x => x.textContent.trim().startsWith({json.dumps(label)})).click(); return true;")


class BrowserVault:
    """A vault in this browser's IndexedDB."""
    label = "a vault in the browser"

    def __init__(self, args):
        self.args = args

    async def open(self, b, path="/today"):
        await b.goto(self.args.page + "/today")
        await b.js(CLEAR)
        await b.goto(self.args.page + path + "?backend=local")
        return await b.wait_for("!!window.__dvarimLocal && !!document.querySelector('.nav')", timeout=25)

    async def reopen(self, b, path):
        await b.goto(self.args.page + path)
        return await b.wait_for("!!window.__dvarimLocal && !!document.querySelector('.nav')", timeout=25)

    async def files(self, b):
        return await b.js("return await window.__dvarimLocal.snapshot();")

    async def close(self, b):
        await b.goto(self.args.page + "/today?backend=server")
        await b.js(CLEAR)


class FolderVault:
    """A new, empty folder behind a simulated shell (tools/bridge_sim.py)."""

    def __init__(self, args, http):
        self.args, self.http = args, http
        self.folder = Path(args.folder)
        self.label = "a folder, the shell making the requests" if http else "a folder, the page making the requests"
        self.proc = None
        self.sim_args = argparse.Namespace(url=args.page, sim_url="http://" + args.sim)

    async def open(self, b, path="/today"):
        shutil.rmtree(self.folder, ignore_errors=True)
        self.folder.mkdir(parents=True)
        host, port = self.args.sim.split(":")
        self.proc = subprocess.Popen([sys.executable, str(HERE / "bridge_sim.py"), "--root", str(self.folder),
                                      "--host", host, "--port", port, *(["--http"] if self.http else [])])
        for _ in range(40):
            try:
                e2e_folder.sim(self.sim_args.sim_url, "/log"); break
            except Exception:
                await asyncio.sleep(0.1)
        await b.goto(self.args.page + "/today")
        await b.js("localStorage.removeItem('dvarim.sync'); return true;")
        return await e2e_folder.open_app(b, self.sim_args, "webkit", path)

    async def reopen(self, b, path):
        await b.goto(self.args.page + path)
        return await b.wait_for("!!window.__dvarimLocal && !!document.querySelector('.nav')", timeout=25)

    async def files(self, b):
        await b.js("await window.__dvarimLocal.flush(); return true;")
        return {str(p.relative_to(self.folder)): p.read_text() for p in self.folder.rglob("*")
                if p.is_file() and ".dvarim" not in p.relative_to(self.folder).parts}

    def asked(self):
        return [e["op"] for e in e2e_folder.sim(self.sim_args.sim_url, "/log")]

    async def close(self, b):
        await b.js("localStorage.removeItem('dvarim.sync'); return true;")
        if self.proc:
            self.proc.terminate(); self.proc.wait(timeout=5)


async def run(b, args, root, vault, tag):
    print(f"\n==== {vault.label}")
    check("it opens", bool(await vault.open(b)))
    files = await vault.files(b)
    check("it starts new: the lists and the tutorial", sorted(p for p in files if p.endswith(".md")) == ["Inbox.md", "Projects/Meet Dvarim.md", "Standalone.md", "Trash.md"], str(sorted(files))[:200])

    print("\nSettings → Sync, a wrong token first")
    await settings_sync(b)
    check("the pane says it is not syncing", "Not syncing" in await b.js(STATUS), await b.js(STATUS))
    await b.js("document.querySelector('input[name=\"sync-kind\"][value=\"dvarim\"]').click(); return true;")
    await b.wait_for("!!document.querySelector('#sync-address')", timeout=5)
    await fill(b, "#sync-address", args.server)
    await fill(b, "#sync-token", "dvt_not-a-real-token")
    await press(b, "Save and sync")
    await b.wait_for("/Couldn't sync/.test(document.querySelector('[data-sync-state]')?.textContent || '')", timeout=15)
    check("a wrong token is said plainly", "did not accept" in await b.js(STATUS), await b.js(STATUS))

    print("\nThe right token")
    await fill(b, "#sync-token", args.token)
    await press(b, "Save and sync")
    ok = await b.wait_for("/Last synced/.test(document.querySelector('[data-sync-state]')?.textContent || '')", timeout=30)
    check("it syncs, across origins", bool(ok), await b.js(STATUS))
    files = await vault.files(b)
    server_md = sorted(str(p.relative_to(root)) for p in root.rglob("*.md") if ".dvarim" not in p.relative_to(root).parts)
    local_md = sorted(p for p in files if p.endswith(".md"))
    check("the server's vault is now here, every file", local_md == server_md, f"{len(local_md)} here, {len(server_md)} there")
    check("and the same, byte for byte", all(files.get(p) == (root / p).read_text() for p in server_md))
    check("the token is kept by the app, not in the vault",
          args.token in (await b.js("return localStorage.getItem('dvarim.sync') || '';"))
          and not any(args.token in t for t in files.values()))
    await close_settings(b)

    print("\nA change here goes there by itself")
    made = await b.js("""
        const t = await (await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({title: 'Made on this device', inbox: true})})).json();
        return t.id;""")
    deadline = time.time() + 20
    while time.time() < deadline and made not in (root / "Inbox.md").read_text():
        await asyncio.sleep(0.5)
    check("a to-do made here reaches the server within seconds", made in (root / "Inbox.md").read_text())

    print("\nA change there comes here")
    inbox = root / "Inbox.md"
    inbox.write_text(inbox.read_text() + f"- [ ] Typed in Obsidian on the server 🆔 e2eobs{tag}\n")
    await settings_sync(b)
    await press(b, "Sync now")
    await b.wait_for("/Last synced/.test(document.querySelector('[data-sync-state]')?.textContent || '')", timeout=20)
    await close_settings(b)
    await vault.reopen(b, "/inbox")
    shown = await b.wait_for(f"!!document.querySelector('[data-todo-id=\"e2eobs{tag}\"]')", timeout=12)
    check("and shows in the Inbox", bool(shown))
    if isinstance(vault, FolderVault):
        check("and is in the folder's own Inbox.md", f"e2eobs{tag}" in (vault.folder / "Inbox.md").read_text())
        asked = vault.asked()
        if vault.http:
            check("every request went through the shell (op http)", asked.count("http") > 5, str(asked.count("http")))
        else:
            check("the page made the requests itself: none through the shell", "http" not in asked)

    print("\nStopping")
    await settings_sync(b)
    await b.js("document.querySelector('input[name=\"sync-kind\"][value=\"off\"]').click(); return true;")
    await press(b, "Stop syncing")
    await b.wait_for("/Not syncing/.test(document.querySelector('[data-sync-state]')?.textContent || '')", timeout=8)
    check("it stops, and forgets the token", (await b.js("return localStorage.getItem('dvarim.sync');")) is None)
    await close_settings(b)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--page", required=True, help="serves the app (a throwaway server)")
    ap.add_argument("--server", required=True, help="the sync server")
    ap.add_argument("--root", required=True, help="the sync server's data folder: a throwaway copy")
    ap.add_argument("--token", required=True)
    ap.add_argument("--folder", help="with --sim: a folder vault behind a simulated shell, made afresh")
    ap.add_argument("--sim", help="where bridge_sim.py listens, as the browser reaches it")
    ap.add_argument("--devtools", default="http://172.19.0.10:9222")
    args = ap.parse_args()
    refuse_live_data(args.root, args.server)
    if args.folder:
        refuse_live_data(args.folder)
    root = Path(args.root)
    vaults = [FolderVault(args, False), FolderVault(args, True)] if args.folder and args.sim else [BrowserVault(args)]

    async with Browser(args.devtools) as b:
        for i, vault in enumerate(vaults):
            try:
                await run(b, args, root, vault, f"{i:02d}")
            finally:
                try:
                    await vault.close(b)
                except Exception:
                    pass
    print("\n" + ("built-in sync works" if not FAILURES else f"{len(FAILURES)} failed: " + "; ".join(FAILURES)))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
