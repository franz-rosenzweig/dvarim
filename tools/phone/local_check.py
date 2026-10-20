#!/usr/bin/env python3
"""Phases 5 and 6 on the phone (android/NEXT.md): the app on a folder, synced
with a Dvarim server, and the phone's own reminders, widget and calendars.

A Dvarim server runs on this Mac (server/src/main.js), on a dated copy of
sample-vault with a throwaway password and a device token, and the phone
reaches it through adb reverse. The test build goes onto a new, empty folder
in Documents, chosen through Android's picker, and then:

- sync (phase 5): Settings → Sync with a wrong token, then the right one; the
  vault arriving, byte for byte; a change each way; one made while the
  server is down arriving once it is back; the device removed on the server.
  The app makes the requests (op http, OkHttp), as it always does now.
- the rest of the app on the folder (phase 6): the page's lists kept on the
  phone, and again after every change (op changed); a reminder in the folder
  set as an alarm; a tick from the widget with the app closed, made by the
  page when the app opens; the phone's calendars, never asked for until they
  are turned on in Settings → Calendar, then from a file standing in for
  them; and, with no file, Android asked for the permission, and a refusal
  said plainly.

The test build only, on a folder of its own; afterwards its data is cleared,
and the folder and the server's copy are deleted.
"""
import asyncio, datetime, json, os, re, shlex, shutil, subprocess, sys, tempfile, time, urllib.request

from touch import PKG, adb, app_user, check, finish, portrait
import folder_check as fc

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "../.."))
NAME = "dvarim-sync-check"
REMOTE = f"/sdcard/Documents/{NAME}"
PORT = 8431
SERVER = f"http://127.0.0.1:{PORT}"
TWA = "xyz.tiresia.dvarim"
STATE = "document.querySelector('[data-sync-state]')?.textContent.trim() || ''"


# ---- the server on this Mac ----

def auth(root, script):
    """A script against the server's auth file, `a` being its Auth; what it prints."""
    module = "file://" + os.path.join(REPO, "server/src/auth.js")
    out = subprocess.run(["node", "--input-type=module", "-e",
                          "const { Auth } = await import(process.argv[1]); const a = Auth.load(process.argv[2]); " + script,
                          module, root], capture_output=True, text=True)
    return out.stdout.strip()


class Server:
    def __init__(self, root, log):
        self.root, self.log, self.proc = root, log, None

    def start(self):
        env = dict(os.environ, PORT=str(PORT), HOST="127.0.0.1", DVARIM_ROOT=self.root,
                   DVARIM_STATIC=os.path.join(REPO, "frontend/dist"))
        self.proc = subprocess.Popen(["node", os.path.join(REPO, "server/src/main.js")], env=env,
                                     stdout=self.log, stderr=subprocess.STDOUT)
        return fc.until(lambda: self.up(), 10)

    def up(self):
        try:
            return urllib.request.urlopen(SERVER + "/api/auth", timeout=1).status == 200
        except Exception:
            return False

    def stop(self):
        if self.proc:
            self.proc.terminate()
            self.proc.wait(timeout=10)
            self.proc = None


# ---- the phone ----

def run_as(*cmd, text=None):
    """A command as the test build, in its own data directory."""
    line = f"run-as {PKG} --user {app_user()} " + " ".join(cmd)
    if text is None:
        return adb("shell", line, check=False)
    return subprocess.run([shutil.which("adb"), "shell", line], input=text, text=True, capture_output=True).stdout


def phone_markdown():
    out = adb("shell", "find", REMOTE, "-name", "'*.md'", check=False)
    return sorted(l[len(REMOTE) + 1:] for l in out.splitlines() if l.startswith(REMOTE + "/") and "/.dvarim/" not in l)


def phone_bytes(rel):
    return subprocess.run([shutil.which("adb"), "exec-out", "cat " + shlex.quote(f"{REMOTE}/{rel}")], capture_output=True).stdout


def kept(which):
    """What the app keeps of the page's lists (Local), parsed, or None."""
    try:
        return json.loads(run_as("cat", f"files/local/_api_lists_{which}.json"))
    except ValueError:
        return None


def outbox():
    return run_as("cat", "shared_prefs/dvarim.outbox.xml")


def reminder_alarms():
    """How many of the test build's reminder alarms Android holds."""
    count, mine = 0, False
    for line in adb("shell", "dumpsys", "alarm", check=False).splitlines():
        if re.search(r"Alarm\{.*\}", line):
            mine = line.strip().endswith(PKG + "}")
        elif mine and "tag=" in line and TWA + ".REMIND" in line:
            count += 1
    return count


def calendars(day):
    """Two calendars and two events, in tools/bridge_sim.py's shape: one at
    9:30 today, and one all day tomorrow and the day after."""
    return {"calendars": [{"name": "Personal", "color": "#E0533A"}, {"name": "Work", "color": "#3A7BE0"}],
            "events": [{"uid": "e1", "title": "Dentist", "calendar": "Personal", "color": "#E0533A", "allDay": False,
                        "start": f"{day}T09:30", "end": f"{day}T10:15"},
                       {"uid": "e2", "title": "Conference", "calendar": "Work", "color": "#3A7BE0", "allDay": True,
                        "start": (day + datetime.timedelta(days=1)).isoformat(), "end": (day + datetime.timedelta(days=3)).isoformat()}]}


def launch():
    adb("shell", "am", "start", "--user", app_user(), "-n", f"{PKG}/{TWA}.LauncherActivity")
    return fc.until(lambda: "FolderActivity" in fc.front(), 10)


# ---- the page's Settings → Sync ----

async def sync_pane(p):
    if await p.js("!!document.querySelector('[data-sync-state]')"): return True
    await p.js("window.dvarim.run('settings.open')")
    await p.wait("document.querySelector('.panes')", 4)
    await p.js("(document.querySelector('#pane-tab-sync') || [...document.querySelectorAll('.panes button')].find(b => /sync/i.test(b.textContent)))?.click()")
    return await p.wait("document.querySelector('[data-sync-state]')", 6)


async def close_settings(p):
    await p.js("(document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"] .x') || document.querySelector('.sheet .x'))?.click()")
    time.sleep(0.4)


async def fill(p, selector, value):
    await p.js(f"""(() => {{ const el = document.querySelector({json.dumps(selector)});
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, {json.dumps(value)});
        el.dispatchEvent(new Event('input', {{ bubbles: true }})); return true; }})()""")


async def press(p, label):
    await p.js(f"[...document.querySelectorAll('.syncacts button')].find(b => b.textContent.trim().startsWith({json.dumps(label)}))?.click()")


async def calendar_pane(p):
    await p.js("window.dvarim.run('settings.open')")
    await p.wait("document.querySelector('.panes')", 4)
    await p.js("(document.querySelector('#pane-tab-calendar') || [...document.querySelectorAll('.panes button')].find(b => /calendar/i.test(b.textContent)))?.click()")


async def button(p, text):
    """A button in the open pane, pressed; whether it was there."""
    found = await p.wait(f"[...document.querySelectorAll('#pane-body button')].some(b => b.textContent.includes({json.dumps(text)}))", 8)
    await p.js(f"[...document.querySelectorAll('#pane-body button')].find(b => b.textContent.includes({json.dumps(text)}))?.click()")
    return bool(found)


async def state_has(p, text, secs):
    return await p.wait(f"({STATE}).includes({json.dumps(text)})", secs)


async def main():
    portrait()
    base = tempfile.mkdtemp(prefix="dvarim-local-check-")
    root = os.path.join(base, "server")
    subprocess.run([sys.executable, os.path.join(HERE, "sample_vault.py"), root], check=True, capture_output=True)
    if auth(root, "a.setPassword('local-check-only'); console.log('ok')") != "ok":
        check("a password on the Mac's server, so that it asks for a token", False)
        return finish()
    token = auth(root, "console.log(a.addToken('Phone check'))")
    log = open(os.path.join(base, "server.log"), "w")
    server = Server(root, log)
    check("a Dvarim server on this Mac, on a copy of sample-vault", server.start())
    adb("reverse", f"tcp:{PORT}", f"tcp:{PORT}")
    try:
        await run(server, root, token)
    finally:
        server.stop()
        adb("reverse", "--remove", f"tcp:{PORT}", check=False)
        adb("shell", "am", "force-stop", "--user", app_user(), PKG, check=False)
        adb("shell", "pm", "clear", "--user", app_user(), PKG, check=False)
        adb("shell", "rm", "-rf", REMOTE, check=False)
        shutil.rmtree(base, ignore_errors=True)
    return finish()


async def run(server, root, token):
    # a new, empty folder, and the test build on it
    adb("shell", "rm", "-rf", REMOTE)
    adb("shell", "mkdir", "-p", REMOTE)
    adb("install", "-r", "--user", app_user(), fc.APK)
    adb("shell", "pm", "clear", "--user", app_user(), PKG, check=False)
    adb("logcat", "-c")
    check("a new, empty folder, chosen through Android's picker", fc.choose(NAME))
    check("and the app opens on it", fc.until(lambda: "FolderActivity" in fc.front(), 10), fc.front().strip())
    p = await fc.page()
    await p.wait("window.__dvarimLocal && document.querySelector('.nav, .sidebar')", 25)
    check("it starts new: the lists and the tutorial", phone_markdown() == ["Inbox.md", "Projects/Meet Dvarim.md", "Standalone.md", "Trash.md"], phone_markdown())

    # ---- phase 5: Settings → Sync → A Dvarim server
    check("Settings → Sync opens, and says it is not syncing", await sync_pane(p) and await state_has(p, "Not syncing", 3), await p.js(STATE))
    await p.js("document.querySelector('input[name=\"sync-kind\"][value=\"dvarim\"]')?.click()")
    await p.wait("document.querySelector('#sync-address')", 4)
    await fill(p, "#sync-address", SERVER)
    await fill(p, "#sync-token", "dvt_not-a-real-token")
    await press(p, "Save and sync")
    await state_has(p, "Couldn't sync", 20)
    check("a wrong token is said plainly", "did not accept" in await p.js(STATE), await p.js(STATE))
    await fill(p, "#sync-token", token)
    await press(p, "Save and sync")
    check("with the right token it syncs", await state_has(p, "Last synced", 40), await p.js(STATE))
    direct = await p.js(f"performance.getEntriesByType('resource').filter(e => e.name.includes(':{PORT}')).length")
    check("and the app made the requests (op http): none from the page itself", direct == 0, f"{direct} from the page")
    there = sorted(os.path.relpath(os.path.join(d, f), root) for d, _, fs in os.walk(root) for f in fs
                   if f.endswith(".md") and ".dvarim" not in os.path.relpath(d, root).split(os.sep))
    here = phone_markdown()
    check("the server's vault is now in the phone's folder, every file", here == there, f"{len(here)} here, {len(there)} there")
    check("and the same, byte for byte", all(phone_bytes(f) == open(os.path.join(root, f), "rb").read() for f in there))
    check("the token is kept by the app, not in the folder", not any(token.encode() in phone_bytes(f) for f in here))
    await close_settings(p)

    inbox = os.path.join(root, "Inbox.md")
    made = await p.js("window.dvarim.request('POST', '/api/todos', {title: 'Made on the phone', inbox: true}).then(r => r.body.id)")
    check("a to-do made on the phone reaches the server within seconds", fc.until(lambda: made in open(inbox).read(), 25), made)
    with open(inbox, "a") as f: f.write("- [ ] Typed on the server 🆔 selfph01\n")
    await sync_pane(p)
    await press(p, "Sync now")
    check("one typed on the server arrives on Sync now", fc.until(lambda: b"selfph01" in phone_bytes("Inbox.md"), 25))
    await close_settings(p)

    server.stop()
    away = await p.js("window.dvarim.request('POST', '/api/todos', {title: 'Made while the server was down', inbox: true}).then(r => r.body.id)")
    await sync_pane(p)
    await state_has(p, "Couldn't sync", 20)
    print(f"INFO  with the server down, Settings → Sync says: {await p.js(STATE)}")
    server.start()
    await press(p, "Sync now")
    check("made while the server was down, it reaches the server once it is back", fc.until(lambda: away in open(inbox).read(), 25), away)

    auth(root, "a.removeToken('Phone check')")
    await press(p, "Sync now")
    check("a device removed on the server is told its token is not accepted", await state_has(p, "did not accept", 20), await p.js(STATE))
    await p.js("document.querySelector('input[name=\"sync-kind\"][value=\"off\"]')?.click()")
    await press(p, "Stop syncing")
    await state_has(p, "Not syncing", 8)
    check("Stop syncing forgets the token", await p.js("localStorage.getItem('dvarim.sync')") is None)
    await close_settings(p)

    # ---- phase 6: the rest of the app, from the folder
    today = await p.js("window.dvarim.request('GET', '/api/state').then(r => r.body.today)")
    listed = await p.js("window.dvarim.request('GET', '/api/lists/today').then(r => r.body.items.map(t => t.id))")
    check("the page's Today is kept on the phone, for the widget and reminders",
          fc.until(lambda: [t["id"] for t in (kept("today") or {}).get("items", [])] == listed, 10), f"{len(listed)} in Today")
    check("and Upcoming too", (kept("upcoming") or {}).get("days") is not None)
    ours = await p.js(f"window.dvarim.request('POST', '/api/todos', {{title: 'Made for today on the phone', when: '{today}'}}).then(r => r.body.id)")
    check("a change is kept at once (op changed)",
          fc.until(lambda: ours in [t["id"] for t in (kept("today") or {}).get("items", [])], 8), ours)

    before = reminder_alarms()
    soon = (datetime.datetime.now() + datetime.timedelta(minutes=30)).strftime("%H:%M")
    if soon < datetime.datetime.now().strftime("%H:%M"):
        print("SKIP  a reminder from the folder: too near midnight for one later today")
    else:
        await p.js(f"window.dvarim.request('POST', '/api/todos', {{title: 'Reminder from the folder', when: '{today}', reminder: '{soon}'}})")
        check("a reminder in the folder is set as an alarm on the phone", fc.until(lambda: reminder_alarms() > before, 10),
              f"{before} before, {reminder_alarms()} after")

    # a tick on the widget, with the app closed: kept, and made by the page on the next open
    adb("shell", "am", "force-stop", "--user", app_user(), PKG)
    adb("shell", "am", "broadcast", "--user", app_user(), "-n", f"{PKG}/{TWA}.TodayWidget",
        "-a", f"{TWA}.ITEM", "--es", "todoId", ours, "--ez", "complete", "true")
    check("a tick on the widget with the app closed is kept on the phone", fc.until(lambda: ours in outbox(), 8), outbox()[-160:])
    check("and the folder is left alone meanwhile", b"- [ ] Made for today on the phone" in b"".join(phone_bytes(f) for f in phone_markdown()))
    check("the app opens again on the folder", launch(), fc.front().strip())
    ticked = lambda: b"- [x] Made for today on the phone" in b"".join(phone_bytes(f) for f in phone_markdown())
    check("and its page makes the tick: [x] in the file", fc.until(ticked, 20))
    check("and the phone forgets it", fc.until(lambda: ours not in outbox(), 8), outbox()[-160:])

    # the phone's calendars: nothing is asked of the phone until they are turned
    # on in Settings → Calendar (#74), and then a file stands in for them
    # (DevBuild.calendarsFile)
    p = await fc.page()
    await p.wait("window.__dvarimLocal && document.querySelector('.nav, .sidebar')", 25)
    check("until they are turned on, the phone was never asked for its calendars",
          fc.find(lambda n: "permissioncontroller" in (n.get("package") or ""), 1) is None
          and run_as("cat", "shared_prefs/dvarim.calendars.xml").find("asked") < 0)
    run_as("sh", "-c", "'mkdir -p files && cat > files/calendars.json'", text=json.dumps(calendars(datetime.date.fromisoformat(today))))
    await calendar_pane(p)
    check("Settings → Calendar offers to show the phone's calendars", await button(p, "Show this device's calendars"))
    check("turned on, it lists them",
          await p.wait("[...document.querySelectorAll('.callist label')].map(l => l.textContent.trim()).join(',') === 'Personal,Work'", 8))
    await close_settings(p)
    await p.js("location.assign('/today')"); time.sleep(1)
    p = await fc.page()
    shown = await p.wait("[...document.querySelectorAll('.ev')].some(e => e.textContent.includes('Dentist'))", 15)
    check("an event from the phone's calendar shows in Today, at its time",
          shown and "9:30" in await p.js("[...document.querySelectorAll('.ev')].map(e => e.textContent).join(' | ')"))
    await p.js("location.assign('/upcoming')"); time.sleep(1)
    p = await fc.page()
    check("an all-day event of two days shows on both in Upcoming",
          await p.wait("[...document.querySelectorAll('.ev')].filter(e => e.textContent.includes('Conference')).length === 2", 15))

    # and with no file: Android asks, and a refusal is said plainly
    run_as("rm", "files/calendars.json")
    await p.js("location.assign('/today')"); time.sleep(1)
    ask = fc.find(lambda n: "permissioncontroller" in (n.get("package") or ""), 15)
    check("with no permission yet, Android asks for the calendar", ask is not None)
    if ask is not None:
        deny = fc.find(lambda n: re.fullmatch(r"(don.t allow|deny)", (n.get("text") or "").strip(), re.I) is not None, 10)
        if deny is not None: fc.tap(deny)
        check("refused", deny is not None)
        p = await fc.page()
        await p.wait("window.__dvarimLocal && document.querySelector('.nav, .sidebar')", 10)
        await calendar_pane(p)
        check("Settings → Calendar says where to allow it",
              await p.wait("document.body.textContent.includes('may not read this phone')", 8))
        await close_settings(p)

    crashed = [l for l in adb("logcat", "-d", "-s", "AndroidRuntime:E").splitlines() if "FATAL" in l or PKG in l]
    check("and the app never fell over", not crashed, crashed[:3])


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
