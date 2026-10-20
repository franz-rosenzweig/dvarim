#!/usr/bin/env python3
"""The Android app's own copy, synced with the server (AppCopy, offline-first).

A server of our own with a password, on a dated copy of sample-vault, reached
from the phone through adb reverse. The test build, cleared, is pointed at it
and opened the way the launcher opens it: the first time that is the server's
sign-in in the app's own WebView (CopySignInActivity), told the app keeps the
copy. Signing in there makes the phone a token and hands over to FolderActivity
on a folder of the app's own, which the page fills from the server. Then:

  - a to-do made on the phone reaches the server;
  - with the server out of reach the app still opens on the copy, and a to-do
    made then reaches the server once it is back;
  - signing out takes the token, the sign-in and the copy away, and the app is
    back at the server's sign-in.

The test build only; afterwards its data is cleared and the server stopped.
"""
import asyncio, json, os, subprocess, sys, tempfile, time, urllib.request

from touch import Phone, PKG, adb, app_user, check, finish, portrait

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "../.."))
APK = os.path.join(REPO, "android/app/build/outputs/apk/debug/app-debug.apk")
PORT = 8431
SERVER = f"http://localhost:{PORT}"
ORIGIN = "https://appassets.androidplatform.net"
TWA = "xyz.tiresia.dvarim"
PASSWORD = "selftest-only-password"           # the project's own self-test password, for a throwaway server
COPY = f"files/copies/localhost-{PORT}/owner"


def node(*args, env=None):
    return subprocess.run(["node", *args], capture_output=True, text=True, env=env, cwd=REPO).stdout.strip()


def auth(root, script):
    module = "file://" + os.path.join(REPO, "server/src/auth.js")
    return node("--input-type=module", "-e",
                f"const {{ Auth }} = await import(process.argv[1]); const a = Auth.load(process.argv[2]); {script}",
                module, root)


def front():
    return adb("shell", "dumpsys", "window").split("mCurrentFocus")[1].split("\n")[0]


def until(cond, secs):
    end = time.time() + secs
    while time.time() < end:
        if cond(): return True
        time.sleep(0.5)
    return False


def run_as(*cmd):
    return adb("shell", "run-as", PKG, "--user", app_user(), *cmd, check=False)


def server_has(root, needle):
    for d, _, files in os.walk(root):
        for f in files:
            if f.endswith(".md") and needle in open(os.path.join(d, f), encoding="utf-8", errors="replace").read():
                return True
    return False


def healthy():
    try:
        return urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=1).status == 200
    except OSError:
        return False


async def bridge(p, op):
    """One storage op straight to FolderBridge, as the page sends it; its reply."""
    return await p.js("new Promise((ok) => { const id = 900000 + Math.floor(Math.random() * 99999); const was = window.__dvarimStorageReply; "
                      "window.__dvarimStorageReply = (i, r) => { if (i === id) { window.__dvarimStorageReply = was; ok(r); } else was(i, r); }; "
                      f"DvarimStorage.request(id, JSON.stringify({{v: 1, op: {json.dumps(op)}, args: {{}}}})); }})")


def launch():
    adb("shell", "am", "force-stop", "--user", app_user(), PKG, check=False)
    adb("shell", "am", "start", "--user", app_user(), "-n", f"{PKG}/{TWA}.LauncherActivity")


async def main():
    portrait()
    base = tempfile.mkdtemp(prefix="dvarim-copy-check-")
    root = os.path.join(base, "server")
    subprocess.run([sys.executable, os.path.join(HERE, "sample_vault.py"), root], check=True)
    check("a password on the throwaway server", auth(root, f"a.setPassword({json.dumps(PASSWORD)}); console.log('ok')") == "ok")
    env = dict(os.environ, PORT=str(PORT), HOST="127.0.0.1", DVARIM_ROOT=root, DVARIM_WATCH="1",
               DVARIM_STATIC=os.path.join(REPO, "frontend/dist"))
    log = open(os.path.join(base, "server.log"), "w")
    srv = subprocess.Popen(["node", "server/src/main.js"], cwd=REPO, env=env, stdout=log, stderr=log)
    try:
        check("the throwaway server is up", until(lambda: healthy(), 15))
        adb("install", "-r", "--user", app_user(), APK)
        adb("shell", "pm", "clear", "--user", app_user(), PKG, check=False)
        adb("reverse", f"tcp:{PORT}", f"tcp:{PORT}")
        # the test build's server: DevActivity remembers it (DevBuild), then the launcher decides
        adb("shell", "am", "start", "--user", app_user(), "-n", f"{PKG}/{TWA}.DevActivity", "--es", "url", SERVER + "/")
        time.sleep(3)
        launch()

        # 1. the first time: the server's sign-in, in the app's own WebView
        check("the first open is the sign-in, in the app's own WebView", until(lambda: "CopySignInActivity" in front(), 15), front().strip())
        p = Phone()
        await p.attach(SERVER)
        check("the server's page there is told the app keeps the copy",
              await p.js("!!(window.__dvarimShell && window.__dvarimShell.copy)") is True)
        check("and shows its sign-in", await p.wait("document.querySelector('input[type=password]')", 10))
        await p.js(f"""(() => {{
            const pw = document.querySelector('input[type=password]');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(pw, {json.dumps(PASSWORD)});
            pw.dispatchEvent(new Event('input', {{bubbles: true}}));
            setTimeout(() => pw.form.requestSubmit(), 50);
        }})()""")

        # 2. the copy: a token, a folder of the app's own, and the app on it
        check("signing in hands over to the app on its copy", until(lambda: "FolderActivity" in front(), 25), front().strip())
        prefs = run_as("cat", "shared_prefs/dvarim.copy.xml")
        check("the phone's token is kept", "dvt_" in prefs)
        names = auth(root, "console.log(JSON.stringify(a.tokenList(null).map((t) => t.name)))")
        check("the server lists the phone as a device", names not in ("", "[]"), names)
        p = Phone()
        await p.attach(ORIGIN)
        info = json.loads(await bridge(p, "info") or "{}").get("ok") or {}
        info = {"name": info.get("name"), "detail": info.get("detail"), "app": (info.get("sync") or {}).get("app"), "kind": (info.get("sync") or {}).get("kind")}
        check("the page is on the app's copy, synced by the app", bool(info) and info.get("name") == "This phone" and info.get("app") is True and info.get("kind") == "dvarim", info)
        check("the copy fills from the server", until(lambda: "Reply about October hours" in run_as("cat", f"{COPY}/Standalone.md"), 30))

        # 3. made on the phone: on the server
        await p.js("window.dvarim.request('POST', '/api/quick-add', {text: 'Copy check, online'})")
        check("a to-do made on the phone reaches the server", until(lambda: server_has(root, "Copy check, online"), 30))

        # 4. no server: the app still opens on the copy, and catches up later
        adb("reverse", "--remove", f"tcp:{PORT}", check=False)
        launch()
        check("with the server out of reach the app opens on its copy", until(lambda: "FolderActivity" in front(), 15), front().strip())
        p = Phone()
        await p.attach(ORIGIN)
        await p.js("window.dvarim.run('go.today')")
        check("and its lists are there", await p.wait("document.querySelectorAll('[data-todo-id]').length > 0", 10))
        await p.js("window.dvarim.request('POST', '/api/quick-add', {text: 'Copy check, offline'})")
        check("a to-do made offline is kept on the phone", until(lambda: "Copy check, offline" in run_as("cat", f"{COPY}/Inbox.md"), 10))
        time.sleep(3)
        check("and not on the server yet", not server_has(root, "Copy check, offline"))
        adb("reverse", f"tcp:{PORT}", f"tcp:{PORT}")
        await p.js("document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus'))")
        check("back online, it reaches the server", until(lambda: server_has(root, "Copy check, offline"), 60))

        # 5. signing out: the token, the sign-in and the copy go
        await bridge(p, "signOut")
        check("signing out goes back to the sign-in", until(lambda: "CopySignInActivity" in front(), 20), front().strip())
        check("the phone's token is forgotten", "dvt_" not in run_as("cat", "shared_prefs/dvarim.copy.xml"))
        names = auth(root, "console.log(JSON.stringify(a.tokenList(null).map((t) => t.name)))")
        check("and off the server", names == "[]", names)
        check("and the copy is gone from the phone", "No such file" in run_as("ls", COPY) or run_as("ls", COPY).strip() == "")
    finally:
        adb("shell", "am", "force-stop", "--user", app_user(), PKG, check=False)
        adb("shell", "pm", "clear", "--user", app_user(), PKG, check=False)
        adb("reverse", "--remove", f"tcp:{PORT}", check=False)
        srv.terminate()
        srv.wait()
    finish()


if __name__ == "__main__":
    asyncio.run(main())
