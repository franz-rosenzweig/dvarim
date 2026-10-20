#!/usr/bin/env python3
"""The app on a folder, the way the Mac and Android apps will run it (phase 3).

A native shell hands the page a folder over a message bridge (docs/BRIDGE.md).
This plays the shell: a script put into the page before it loads provides the
bridge — once as the Mac's WebKit message handler, once as Android's JavaScript
interface, replying out of order — and carries each message to
tools/bridge_sim.py, which answers it from a real folder on disk. Then it checks
what matters about a folder that other programs also write:

- the app opens on the folder's to-dos, and what is done in it lands in the files;
- a file changed by someone else (Obsidian, a sync) shows once the shell says so,
  or when the window comes back to the front;
- Settings → Data names the folder, asks the shell to choose another or to go
  back to a server, and runs the storage checks on the folder itself;
- a save that fails is said out loud;
- the server's own vault is never touched.

    tools/e2e_folder.py --url http://172.19.0.1:8422 --root /tmp/dv-next \\
        --folder /tmp/dv-folder --sim 172.19.0.1:8431 --devtools http://172.19.0.10:9222
"""
import argparse, asyncio, hashlib, json, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

HERE = Path(__file__).resolve().parent

SHELL = """
(() => {
  const SIM = __SIM__, MODE = __MODE__;
  const realFetch = window.fetch.bind(window);
  let chain = Promise.resolve();
  // a shell takes messages one at a time, in the order sent (docs/BRIDGE.md)
  const call = (msg) => {
    const p = chain.then(() => realFetch(SIM + '/call', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg) }).then((r) => r.json()));
    chain = p.catch(() => {});
    return p;
  };
  if (MODE === 'webkit') {
    window.webkit = { messageHandlers: { dvarimStorage: { postMessage: (msg) => call(msg) } } };
  } else {
    let n = 0;
    window.DvarimStorage = {
      request(id, json) {
        call(JSON.parse(json)).then((reply) =>
          setTimeout(() => window.__dvarimStorageReply(id, JSON.stringify(reply)), (n++ * 7) % 5));
      },
    };
  }
})();
"""


def digest(root: Path) -> str:
    h = hashlib.sha1()
    for p in sorted(root.rglob("*.md")):
        h.update(str(p.relative_to(root)).encode() + b"\0" + p.read_bytes())
    return h.hexdigest()


def sim(base: str, path: str, body=None):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="GET" if body is None else "POST")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


async def until(fn, timeout=6.0, every=0.2):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        await asyncio.sleep(every)
    return fn()


async def open_app(b, args, mode, path="/inbox"):
    await b.send("Page.addScriptToEvaluateOnNewDocument", {"source": SHELL.replace("__SIM__", json.dumps(args.sim_url)).replace("__MODE__", json.dumps(mode))})
    await b.goto(args.url + path)
    return await b.wait_for("!!window.__dvarimLocal && !!document.querySelector('.nav')", timeout=25)


async def add_in_ui(b, title):
    await b.js("document.querySelector('#tb-add, .toolbar button')?.click(); return true;")
    await b.wait_for("!!document.querySelector('.card .ttl')", timeout=8)
    await b.js(f"""
        const t = document.querySelector('.card .ttl');
        t.focus();
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        set.call(t, {json.dumps(title)});
        t.dispatchEvent(new Event('input', {{ bubbles: true }}));
        t.blur();
        return true;""")
    await asyncio.sleep(0.8)
    await b.js("document.querySelector('.content').click(); return true;")


async def rows(b):
    return await b.js("return [...document.querySelectorAll('[data-todo-id]')].map(r => r.textContent);")


async def device_calendars(b, args, folder: Path):
    """A shell with the device's calendars: their events in Today and Upcoming,
    and the calendars themselves in Settings → Calendar."""
    print("\nThe device's own calendars")
    today = await b.js("return (await (await fetch('/api/state')).json()).today;")
    y, m, d = map(int, today.split("-"))
    import datetime
    t0 = datetime.date(y, m, d)
    tomorrow = (t0 + datetime.timedelta(days=1)).isoformat()
    after = (t0 + datetime.timedelta(days=3)).isoformat()
    cals = folder.parent / (folder.name + "-calendars.json")
    cals.write_text(json.dumps({
        "calendars": [{"name": "Personal", "color": "#E0533A"}, {"name": "Work", "color": "#3A7BE0"}],
        "events": [
            {"uid": "e1", "title": "Dentist", "calendar": "Personal", "color": "#E0533A", "allDay": False,
             "start": f"{today}T09:30", "end": f"{today}T10:15"},
            {"uid": "e2", "title": "Conference", "calendar": "Work", "color": "#3A7BE0", "allDay": True,
             "start": tomorrow, "end": after},
        ]}))
    asked = lambda: [e["op"] for e in sim(args.sim_url, "/log") if e["op"] in ("calendars", "events")]
    events_shown = "return document.querySelectorAll('.ev').length;"

    async def calendar_pane():
        await b.js("document.querySelector('.sidefoot [aria-label=\"Settings\"]').click(); return true;")
        await b.wait_for("document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"]') !== null")
        await b.js("document.querySelector('#pane-tab-calendar').click(); return true;")

    async def button(text, click=True):
        found = await b.wait_for(f"[...document.querySelectorAll('#pane-body button')].some(x => x.textContent.includes({json.dumps(text)}))", timeout=8)
        if found and click:
            await b.js(f"[...document.querySelectorAll('#pane-body button')].find(x => x.textContent.includes({json.dumps(text)})).click(); return true;")
        return bool(found)

    async def close_settings():
        await b.js("document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"] .x').click(); return true;")

    await b.goto(args.url + "/today")
    await asyncio.sleep(2)
    check("they are not asked for until turned on: no permission prompt on opening",
          not asked() and not await b.js(events_shown), str(asked()))
    await calendar_pane()
    check("Settings → Calendar offers to show them, still without asking",
          await button("Show this device's calendars", click=False) and not asked())
    await button("Show this device's calendars")
    listed = await b.wait_for("[...document.querySelectorAll('.callist label')].map(l => l.textContent.trim()).join(',') === 'Personal,Work'", timeout=8)
    check("turned on, it lists the device's calendars: the shell was asked now", bool(listed) and "calendars" in asked())
    await close_settings()
    await b.goto(args.url + "/today")
    shown = await b.wait_for("[...document.querySelectorAll('.ev')].some(e => e.textContent.includes('Dentist'))", timeout=10)
    check("an event from the device's calendar shows in Today, at its time",
          bool(shown) and "9:30" in (await b.js("return [...document.querySelectorAll('.ev')].map(e => e.textContent).join(' | ');")))
    await b.goto(args.url + "/upcoming")
    days = await b.wait_for("[...document.querySelectorAll('.ev')].filter(e => e.textContent.includes('Conference')).length === 2", timeout=10)
    check("an all-day event of two days shows on both in Upcoming", bool(days))
    await calendar_pane()
    await b.wait_for("document.querySelectorAll('.callist label').length === 2", timeout=8)
    await b.js("[...document.querySelectorAll('.callist label')].find(l => l.textContent.includes('Personal')).querySelector('input').click(); return true;")
    await asyncio.sleep(0.8)
    await close_settings()
    await b.goto(args.url + "/today")
    await asyncio.sleep(1.5)
    hidden = await b.js("return ![...document.querySelectorAll('.ev')].some(e => e.textContent.includes('Dentist'));")
    check("and a calendar unticked there leaves Today", hidden)
    await b.js("await fetch('/api/settings', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({calendars: null})}); return true;")
    await calendar_pane()
    await button("Stop showing this device's calendars")
    await button("Show this device's calendars", click=False)
    await close_settings()
    await b.goto(args.url + "/upcoming")
    await asyncio.sleep(1.5)
    check("turned off again, their events leave the lists", not await b.js(events_shown))


EARLY = """
(() => {
  // a shell asking for the lists the moment window.dvarim is there
  const t = setInterval(() => {
    if (!window.dvarim || !window.dvarim.request) return;
    clearInterval(t);
    window.__earlyAsked = !window.__dvarimLocal;
    window.dvarim.request('GET', '/api/lists/inbox').then((r) => { window.__earlyAnswer = r; });
  }, 1);
})();
"""


async def early_request(b, args, folder: Path):
    """window.dvarim.request asked before the vault is open waits for it, and
    answers from the folder, never from the page's own origin."""
    print("\nA shell that asks at once")
    inbox = folder / "Inbox.md"
    inbox.write_text(inbox.read_text() + "- [ ] Only in this folder 🆔 fold0001\n")
    await b.send("Page.addScriptToEvaluateOnNewDocument", {"source": EARLY})
    await b.goto(args.url + "/today")
    got = await b.wait_for("window.__earlyAnswer !== undefined", timeout=20)
    asked = await b.js("return window.__earlyAsked === true;")
    titles = await b.js("return (window.__earlyAnswer && window.__earlyAnswer.body && window.__earlyAnswer.body.items || []).map(t => t.title);")
    check("asked before the vault was open, it is answered from the folder", bool(got) and asked and "Only in this folder" in titles,
          f"asked early: {asked}; {titles[:6]}")


async def run(b, args, folder: Path, mode: str, full: bool):
    inbox = folder / "Inbox.md"
    as_opened = inbox.read_text()            # what another device, out of touch, would still have
    print(f"\nOpening the folder ({mode})")
    check("the app opens on the folder", bool(await open_app(b, args, mode)))
    check("its vault is the shell's folder", await b.js("return window.__dvarimLocal.kind;") == "device")
    open_lines = [l for l in inbox.read_text().splitlines() if l.startswith("- [ ] ")]
    shown = await rows(b)
    check("the Inbox shows the folder's open to-dos", len(shown) == len(open_lines), f"{len(shown)} shown, {len(open_lines)} in the file")
    projects = {p.stem for p in folder.rglob("*.md") if "type: project" in p.read_text() and "Trash" not in p.parts}
    in_sidebar = await b.js("return [...document.querySelectorAll('.nav [data-drop-project]')].map(e => e.textContent.trim());")
    check("and the sidebar its projects", len(in_sidebar) >= len(projects) - 1
          and all(any(name in entry for name in projects) for entry in in_sidebar), f"{in_sidebar} vs {sorted(projects)}")

    print("\nWork lands in the files")
    title = f"Made in the {mode} window"
    await add_in_ui(b, title)
    got = await until(lambda: title in inbox.read_text())
    check("a to-do made in the interface is a line in Inbox.md", bool(got), inbox.read_text()[-300:])
    tid = await b.js(f"return [...document.querySelectorAll('[data-todo-id]')].find(r => r.textContent.includes({json.dumps(title)}))?.dataset.todoId;")
    await b.js(f"document.querySelector('[data-todo-id=\"{tid}\"] .cb')?.click(); return true;")
    done = await until(lambda: f"- [x] {title} 🆔 {tid}" in inbox.read_text())
    check("ticking it off writes [x] and the day into the file", bool(done) and "✅ " in inbox.read_text())
    told = await until(lambda: any(e["op"] == "changed" for e in sim(args.sim_url, "/log")), timeout=4)
    check("and the shell is told the vault changed, for its menu bar and reminders", bool(told))

    print("\nSomeone else writes the folder")
    text = inbox.read_text()
    inbox.write_text(text + "- [ ] Typed in Obsidian\n")
    await b.js("window.__dvarimFilesChanged(); return true;")
    seen = await b.wait_for("[...document.querySelectorAll('[data-todo-id]')].some(r => r.textContent.includes('Typed in Obsidian'))", timeout=8)
    check("a line added elsewhere shows once the shell says the folder changed", bool(seen))
    if full:
        target = next(l for l in inbox.read_text().splitlines() if l.startswith("- [ ] ") and "🆔 " in l and "Typed in Obsidian" not in l)
        other = target.split("🆔 ")[1].split()[0]
        inbox.write_text(inbox.read_text().replace(target, target.replace("- [ ] ", "- [x] ", 1)))
        await b.js("window.dispatchEvent(new Event('focus')); return true;")
        # logged at once (the default), so it leaves the Inbox
        gone = await b.wait_for(f"!document.querySelector('[data-todo-id=\"{other}\"]')", timeout=8)
        check("a box ticked elsewhere is ticked here when the window comes to the front", bool(gone), target)
        note = folder / "Projects" / "From Obsidian.md"
        note.write_text("---\ntype: project\n---\nWritten in Obsidian.\n\n- [ ] Its first to-do\n")
        await b.js("window.__dvarimFilesChanged(); return true;")
        appeared = await b.wait_for("[...document.querySelectorAll('.nav [data-drop-project]')].some(e => e.textContent.includes('From Obsidian'))", timeout=8)
        check("a project note made elsewhere joins the sidebar", bool(appeared))
        given = await until(lambda: "id: p" in note.read_text(), timeout=4)
        check("and is given its id in the file, front matter otherwise as written", bool(given) and "Written in Obsidian." in note.read_text(), note.read_text()[:200])
        note.unlink()
        await b.js("window.__dvarimFilesChanged(); return true;")
        left = await b.wait_for("![...document.querySelectorAll('.nav [data-drop-project]')].some(e => e.textContent.includes('From Obsidian'))", timeout=8)
        check("and leaves it when the file is deleted", bool(left))

    if full:
        print("\nAnother device, at the same time (docs/SYNC.md)")
        # The other device changed the Inbox too, from the file as it was when
        # this one opened. Syncthing keeps one version and leaves the other
        # beside it as a conflict copy: here the other device's wins, and this
        # one's work is in the copy, to be merged back.
        ours = inbox.read_text()
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        copy = folder / f"Inbox.sync-conflict-{stamp}-ABCDEFG.md"
        copy.write_text(ours)
        inbox.write_text(as_opened + "- [ ] From the other device 🆔 zzzzzzz1\n")
        await b.js("window.__dvarimFilesChanged(); return true;")
        both = await b.wait_for("[...document.querySelectorAll('[data-todo-id]')].some(r => r.textContent.includes('From the other device'))"
                                " && [...document.querySelectorAll('[data-todo-id]')].some(r => r.textContent.includes('Typed in Obsidian'))", timeout=8)
        check("its to-do shows, and nothing done here is lost", bool(both))
        merged = await until(lambda: "From the other device" in inbox.read_text() and "Typed in Obsidian" in inbox.read_text()
                             and f"- [x] {title} 🆔 {tid}" in inbox.read_text(), timeout=6)
        check("and the file holds both sides' work", bool(merged), inbox.read_text()[-400:])
        put_away = await until(lambda: not copy.exists() and (folder / ".dvarim" / "conflicts" / copy.name).exists(), timeout=6)
        check("the conflict copy is put away in .dvarim/conflicts, not deleted", bool(put_away))
        # Syncthing, when both changed the file, keeps one and leaves the other beside it
        # made just now: a copy more than two days old is put away unmerged (docs/SYNC.md)
        copy = folder / f"Inbox.sync-conflict-{time.strftime('%Y%m%d-%H%M%S', time.gmtime(time.time() + 1))}-ABCDEFG.md"
        copy.write_text(as_opened + "- [ ] Only in a conflict copy 🆔 zzzzzzz2\n")
        await b.js("window.__dvarimFilesChanged(); return true;")
        back = await b.wait_for("[...document.querySelectorAll('[data-todo-id]')].some(r => r.textContent.includes('Only in a conflict copy'))", timeout=8)
        check("a sync's conflict copy is merged back in", bool(back))
        put_away = await until(lambda: not copy.exists() and any((folder / ".dvarim" / "conflicts").glob("Inbox.sync-conflict-*")), timeout=6)
        check("and put away in .dvarim/conflicts, not deleted", bool(put_away))

    print("\nSettings → Data")
    await b.js("document.querySelector('.sidefoot [aria-label=\"Settings\"]').click(); return true;")
    await b.wait_for("document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"]') !== null")
    await b.js("[...document.querySelectorAll('.panes [role=tab]')].find(t => t.textContent.includes('Data')).click(); return true;")
    await asyncio.sleep(0.4)
    pane = await b.js("return document.querySelector('[role=dialog]').textContent;")
    check("it says the to-dos are in a folder on this device, and names it", "In a folder on this device" in pane and folder.name in pane, pane[:300])
    if full:
        check("and what was merged from elsewhere", "Merged from elsewhere" in pane and "Inbox" in pane, pane[-600:])
    before = len(sim(args.sim_url, "/log"))
    await b.js("[...document.querySelectorAll('.linkish')].find(x => x.textContent.includes('Choose another folder')).click(); return true;")
    asked = await until(lambda: any(e["op"] == "pick" for e in sim(args.sim_url, "/log")[before:]), timeout=4)
    check("Choose another folder asks the shell for one", bool(asked))
    if full:
        await b.js("[...document.querySelectorAll('.linkish')].find(x => x.textContent.includes('Use a server instead')).click(); return true;")
        await b.wait_for("!!document.querySelector('.menu .opt')", timeout=4)
        await b.js("[...document.querySelectorAll('.menu .opt')].find(o => o.textContent.includes('Use a server')).click(); return true;")
        asked = await until(lambda: any(e["op"] == "useServer" for e in sim(args.sim_url, "/log")[before:]), timeout=4)
        check("Use a server instead, once confirmed, asks the shell to switch", bool(asked))
    await b.js("[...document.querySelectorAll('.linkish')].find(x => x.textContent.includes('Check this folder')).click(); return true;")
    verdict = await b.wait_for("document.querySelector('[data-check]')?.dataset.check", timeout=60)
    fails = await b.js("return [...document.querySelectorAll('.checkfails li')].map(l => l.textContent);")
    check("Check this folder: the folder keeps the storage contract", verdict == "ok", "; ".join(fails)[:600])
    leftovers = [p for p in (folder / ".dvarim").glob("conformance-*")] if (folder / ".dvarim").exists() else []
    check("and the check leaves nothing behind in the folder", not leftovers, str(leftovers))
    await b.js("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); return true;")

    if full:
        print("\nA save that fails")
        sim(args.sim_url, "/fail", {"op": "write", "code": "EACCES", "message": "the folder is read-only"})
        await b.goto(args.url + "/inbox")
        await b.wait_for("!!window.__dvarimLocal && !!document.querySelector('.nav')", timeout=25)
        await add_in_ui(b, "This will not save")
        told = await b.wait_for("document.querySelector('.toast')?.textContent.includes('Not saved')", timeout=8)
        toast = await b.js("return document.querySelector('.toast')?.textContent || '';")
        check("is said out loud, with why", bool(told) and "read-only" in toast, toast)
        check("and nothing half-written is left", "This will not save" not in inbox.read_text())
        sim(args.sim_url, "/fail", {})
        # last: they reload the page, which starts the list of merges afresh
        await device_calendars(b, args, folder)
        await early_request(b, args, folder)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="a throwaway server, only to serve the page")
    ap.add_argument("--root", required=True, help="that server's data, to prove it is left alone")
    ap.add_argument("--folder", default="/tmp/dv-folder", help="made afresh from the sample vault")
    ap.add_argument("--sim", default="172.19.0.1:8431", help="where bridge_sim.py listens, as the browser reaches it")
    ap.add_argument("--devtools", default="http://172.19.0.16:9222")
    args = ap.parse_args()
    refuse_live_data(args.root, args.url)
    refuse_live_data(args.folder)
    folder, root = Path(args.folder), Path(args.root)
    args.sim_url = "http://" + args.sim
    server_before = digest(root)

    code = 0
    for mode, full in (("webkit", True), ("android", False)):
        shutil.rmtree(folder, ignore_errors=True)
        subprocess.run([sys.executable, str(HERE / "phone" / "sample_vault.py"), str(folder)], check=True, capture_output=True)
        host, port = args.sim.split(":")
        # the Mac pass has a shell that offers the device's calendars (docs/BRIDGE.md)
        cals = folder.parent / (folder.name + "-calendars.json")
        cals.unlink(missing_ok=True)
        extra = ["--calendars", str(cals)] if full else []
        proc = subprocess.Popen([sys.executable, str(HERE / "bridge_sim.py"), "--root", str(folder), "--host", host, "--port", port, *extra])
        try:
            for _ in range(40):
                try:
                    sim(args.sim_url, "/log"); break
                except Exception:
                    await asyncio.sleep(0.1)
            async with Browser(args.devtools) as b:
                await run(b, args, folder, mode, full)
        finally:
            proc.terminate(); proc.wait(timeout=5)

    check("the server's own files were never touched", digest(root) == server_before)
    print("\n" + ("the app works on a folder" if not FAILURES else f"{len(FAILURES)} failed: " + "; ".join(FAILURES)))
    return 1 if FAILURES else code


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
