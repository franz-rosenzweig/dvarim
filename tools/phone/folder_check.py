#!/usr/bin/env python3
"""The Android app on a folder (phase 3, docs/BRIDGE.md, android/NEXT.md).

A dated copy of sample-vault goes onto the phone, in Documents; the app's own
Settings chooses it through Android's folder picker, driven the way a person
drives it; and then FolderActivity — the web app from inside the APK, its
to-dos in that folder — is checked from its DevTools and from the files
themselves: the conformance checks, the Inbox against Inbox.md, a to-do made
and ticked landing in the file, a line written by someone else (Syncthing, say)
showing up, a share and New To-Do arriving through the hand-over, a turn of the
phone, Back, the page's link to the app's own settings, Use a server instead…
remembered, and a folder whose grant has gone falling back to the server.

The test build only, on a folder of its own; afterwards its data is cleared,
which releases the grant, and the folder is deleted.
"""
import asyncio, os, re, shutil, subprocess, sys, tempfile, time
import xml.etree.ElementTree as ET

from touch import Phone, PKG, adb, app_user, check, finish, portrait

HERE = os.path.dirname(os.path.abspath(__file__))
APK = os.path.join(HERE, "../../android/app/build/outputs/apk/debug/app-debug.apk")
NAME = "dvarim-folder-check"
REMOTE = f"/sdcard/Documents/{NAME}"
ORIGIN = "https://appassets.androidplatform.net"
TWA = "xyz.tiresia.dvarim"


def screen():
    adb("shell", "uiautomator", "dump", "/sdcard/dvarim-ui.xml", check=False)
    return ET.fromstring(adb("shell", "cat", "/sdcard/dvarim-ui.xml"))


def find(test, secs=8):
    end = time.time() + secs
    while time.time() < end:
        hit = [n for n in screen().iter("node") if test(n)]
        if hit: return hit[0]
        time.sleep(0.4)
    return None


def tap(node):
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds")))
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def tap_text(text, secs=8):
    node = find(lambda n: (n.get("text") or "").strip().lower() == text.lower(), secs)
    if node is not None: tap(node)
    return node is not None


def front():
    return adb("shell", "dumpsys", "window").split("mCurrentFocus")[1].split("\n")[0]


def until(cond, secs):
    end = time.time() + secs
    while time.time() < end:
        if cond(): return True
        time.sleep(0.5)
    return False


def cat(path):
    return adb("shell", "cat", f"{REMOTE}/{path}", check=False)


def append(path, line):
    adb("shell", f"echo '{line}' >> '{REMOTE}/{path}'")


def settings():
    adb("shell", "am", "start", "--user", app_user(), "-n", f"{PKG}/{TWA}.SettingsActivity")


def prefs():
    return adb("shell", "run-as", PKG, "--user", app_user(), "cat", "shared_prefs/dvarim.vault.xml", check=False)


async def page():
    p = Phone()
    await p.attach(ORIGIN)
    return p


def setup():
    """A fresh copy of the sample on the phone, and the test build, cleared."""
    portrait()
    # the folder: sample-vault, dated to today, in Documents
    local = os.path.join(tempfile.mkdtemp(), NAME)
    subprocess.run([sys.executable, os.path.join(HERE, "sample_vault.py"), local], check=True)
    adb("shell", "rm", "-rf", REMOTE)
    adb("push", local, REMOTE)
    adb("install", "-r", "--user", app_user(), APK)
    adb("shell", "pm", "clear", "--user", app_user(), PKG, check=False)
    adb("logcat", "-c")


def choose(name=NAME):
    """Settings → In a folder on this phone → the system's picker, by a finger:
    Documents, then `name`."""
    settings()
    radio = find(lambda n: (n.get("resource-id") or "").endswith(":id/inFolder"))
    check("the app's Settings asks where the to-dos live", radio is not None)
    if radio is None: return False
    tap(radio)
    return (find(lambda n: n.get("package") == "com.google.android.documentsui", 10) is not None
            and tap_text("Documents") and tap_text(name) and tap_text("Use this folder") and tap_text("Allow"))


async def main():
    setup()
    check("choosing a folder goes through Android's own picker", choose())
    check("and the app opens on it", until(lambda: "FolderActivity" in front(), 10), front().strip())
    check("with its grant kept, and the choice saved", "folder" in prefs() and NAME in prefs(), prefs().strip()[-140:])

    p = await page()
    st = await p.js("({kind: window.__dvarimLocal && window.__dvarimLocal.kind, path: location.pathname})")
    check("it is the page from inside the app, on the folder", st["kind"] == "device", st)

    r = await p.js("window.__dvarimLocal.conformance()")
    failed = [f"{x['name']}: {x.get('error')}" for x in r["results"] if not x["ok"]]
    ms = sum(x["ms"] for x in r["results"])
    check("the folder passes the bridge's conformance checks", r["ok"], "; ".join(failed) or f"{len(r['results'])} checks, {ms / 1000:.1f} s")

    await p.js("window.dvarim.run('go.inbox')")
    lines = len([l for l in cat("Inbox.md").splitlines() if l.startswith("- [ ]")])
    check("the Inbox shows what Inbox.md holds",
          await p.wait(f"document.querySelectorAll('[data-todo-id]').length === {lines}", 5), f"{lines} open lines")

    # made here: in the file; ticked here: [x] with its date
    made = await p.js("window.dvarim.request('POST', '/api/todos', {title: 'Made on the phone', inbox: true})")
    tid = (made or {}).get("body", {}).get("id")
    check("a to-do made in the app is a line in Inbox.md", until(lambda: "- [ ] Made on the phone" in cat("Inbox.md"), 5))
    await p.js(f"window.dvarim.request('POST', '/api/todos/{tid}/complete', {{}})")
    line = lambda: next((l for l in cat("Inbox.md").splitlines() if "Made on the phone" in l), "")
    until(lambda: line().startswith("- [x] "), 5)
    check("ticked, it is [x] with its ✅ date in the file", line().startswith("- [x] ") and "✅ " in line(), line())

    # someone else writes the folder: seen on the next poll, and at once on coming back
    append("Inbox.md", "- [ ] Brought by Syncthing")
    check("a line written into the file by someone else shows up while the app is open",
          await p.wait("[...document.querySelectorAll('[data-todo-id] .txt')].some(e => e.textContent.trim() === 'Brought by Syncthing')", 25))
    adb("shell", "input", "keyevent", "HOME"); time.sleep(1.5)
    append("Inbox.md", "- [ ] Brought while away")
    adb("shell", "am", "start", "--user", app_user(), "-n", f"{PKG}/{TWA}.LauncherActivity")
    p = await page()
    check("and one written while the app was away is there as it comes back",
          await p.wait("[...document.querySelectorAll('[data-todo-id] .txt')].some(e => e.textContent.trim() === 'Brought while away')", 6))

    # a share, and New To-Do, arrive through the hand-over, with no server
    adb("shell", "am", "start", "--user", app_user(), "-a", "android.intent.action.SEND", "-t", "text/plain",
        "--es", "android.intent.extra.TEXT", "'Shared into the folder'", "-n", f"{PKG}/{TWA}.ShareActivity")   # adb joins, so quote
    p = await page()
    sheet = await p.wait("document.querySelector('#sh-title')?.value === 'Shared into the folder'", 8)
    check("a share opens the page's share sheet, on the folder", sheet)
    await p.js("document.querySelector('.wrap form button[type=submit]')?.click()")
    check("and saving it puts it in Inbox.md", until(lambda: "Shared into the folder" in cat("Inbox.md"), 6))
    adb("shell", "am", "start", "--user", app_user(), "-n", f"{PKG}/{TWA}.LauncherActivity", "-d", "https://dvarim.tiresia.xyz/new")
    p = await page()
    check("New To-Do (the tile, the launcher's menu) opens an empty to-do in the Inbox",
          await p.wait("location.pathname === '/inbox' && !!document.querySelector('.card')", 8),
          await p.js("({path: location.pathname, card: !!document.querySelector('.card')})"))
    await p.js("history.back()"); time.sleep(1)

    # Back from a list brings out the drawer, and the app stays
    p = await page()
    adb("shell", "input", "keyevent", "BACK"); time.sleep(1.2)
    check("Back from a list brings out the drawer, and the app stays",
          await p.js("document.querySelector('.app').classList.contains('root')") and "FolderActivity" in front(), front().strip())
    adb("shell", "input", "keyevent", "BACK"); time.sleep(1.5)
    check("and Back from the drawer leaves the app", "FolderActivity" not in front(), front().strip())
    adb("shell", "am", "start", "--user", app_user(), "-n", f"{PKG}/{TWA}.LauncherActivity")
    p = await page()

    # turned sideways and back: the same page, the same list
    await p.js("window.dvarim.run('go.today')"); time.sleep(1)
    adb("shell", "settings", "put", "system", "user_rotation", "1"); time.sleep(2.5)
    p = await page()
    turned = await p.js("({path: location.pathname, w: innerWidth, h: innerHeight})")
    portrait(); time.sleep(2)
    check("turned sideways, it keeps its page and its list", turned["path"] == "/today" and turned["w"] > turned["h"], turned)

    # the page's link to the app's own settings
    await p.js("window.dvarim.run('settings.open')")
    await p.wait("document.querySelector('.panes')", 3)
    await p.js("[...document.querySelectorAll('.panes button')].find(b => /data/i.test(b.textContent))?.click()")
    await p.wait("document.querySelector('a.native')", 3)
    await p.js("document.querySelector('a.native').click()")
    check("the page's link to the app's own settings opens them", until(lambda: "SettingsActivity" in front(), 5), front().strip())
    adb("shell", "input", "keyevent", "BACK"); time.sleep(1)

    # Use a server instead…: the server again, and remembered
    p = await page()
    await p.js("document.querySelector('.sheet .x')?.click()"); time.sleep(0.5)
    await p.js("window.dvarim.run('settings.open')")
    await p.wait("document.querySelector('.panes')", 3)
    await p.js("[...document.querySelectorAll('.panes button')].find(b => /data/i.test(b.textContent))?.click()")
    await p.wait("[...document.querySelectorAll('button')].some(b => b.textContent.includes('Use a server instead'))", 3)
    await p.js("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Use a server instead')).click()")
    await p.wait("document.querySelector('.menu .opt')", 3)
    await p.js("[...document.querySelectorAll('.menu .opt')].find(o => /Use a server/.test(o.textContent))?.click()")
    check("the page's Use a server instead… opens the server's window",
          until(lambda: "WebViewFallbackActivity" in front() or "CustomTab" in front(), 10), front().strip())
    check("and it is remembered", '"mode">server' in prefs(), prefs().strip()[-120:])
    adb("shell", "am", "force-stop", "--user", app_user(), PKG)
    adb("shell", "am", "start", "--user", app_user(), "-n", f"{PKG}/{TWA}.LauncherActivity"); time.sleep(3)
    check("a relaunch stays on the server", "FolderActivity" not in front(), front().strip())
    adb("shell", "am", "force-stop", "--user", app_user(), PKG)

    # back to the folder from Settings: the grant is still held, so no picker
    settings()
    radio = find(lambda n: (n.get("resource-id") or "").endswith(":id/inFolder"))
    if radio is not None: tap(radio)
    check("choosing the folder again in Settings needs no picker: its grant is kept",
          until(lambda: "FolderActivity" in front(), 8), front().strip())

    # a folder whose grant has gone: the server, and Settings says why
    adb("shell", "am", "force-stop", "--user", app_user(), PKG)
    stale = prefs().replace("dvarim-folder-check", "never-granted")
    subprocess.run([shutil.which("adb"), "shell", f"run-as {PKG} --user {app_user()} sh -c 'cat > shared_prefs/dvarim.vault.xml'"],
                   input=stale, text=True, check=True)
    adb("shell", "am", "start", "--user", app_user(), "-n", f"{PKG}/{TWA}.LauncherActivity"); time.sleep(3)
    check("a folder the app has lost access to falls back to the server", "FolderActivity" not in front(), front().strip())
    adb("shell", "am", "force-stop", "--user", app_user(), PKG)
    settings()
    lost = find(lambda n: "no longer has access" in (n.get("text") or ""), 5)
    check("and Settings says so, and offers to choose it again", lost is not None)
    adb("shell", "input", "keyevent", "BACK")

    crashed = [l for l in adb("logcat", "-d", "-s", "AndroidRuntime:E").splitlines() if "FATAL" in l or PKG in l]
    check("and the app never fell over", not crashed, crashed[:3])

    # tidy: the test build forgets the folder (and its grant), and the folder goes
    adb("shell", "am", "force-stop", "--user", app_user(), PKG)
    adb("shell", "pm", "clear", "--user", app_user(), PKG, check=False)
    adb("shell", "rm", "-rf", REMOTE)
    return finish()

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
