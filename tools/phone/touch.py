#!/usr/bin/env python3
"""Real fingers, as near as adb can make them: touches are injected into the
phone's input pipeline, so the WebView's own scroll-vs-gesture arbitration runs,
and the page is inspected over the DevTools socket of the debug build."""
import asyncio, atexit, json, re, subprocess, time, urllib.request, shutil, os, tempfile
import websockets

PKG = "xyz.tiresia.dvarim.debug"
URL = "http://localhost:8421/today"   # the URL wins over the last list used
ADB = shutil.which("adb")
# Outside the repository: the copy of sample-vault devserver.sh serves, its log,
# and the screenshots every check takes. The same place devserver.sh uses.
WORK = os.environ.get("DVARIM_PHONE_WORK") or os.path.join(tempfile.gettempdir(), "dvarim-phone")

# ---- the tally every check keeps: one line per claim, then the verdict

_fails = []

def check(name, ok, detail=""):
    print(("  ok  " if ok else "FAIL  ") + name + ("" if detail in ("", None) else f"   {detail}"))
    if not ok: _fails.append(name)

def finish():
    """Print the verdict and return the exit status: sys.exit(asyncio.run(main()))."""
    print()
    print("ALL PASSED" if not _fails else f"{len(_fails)} FAILED")
    for f in _fails: print("   -", f)
    return 1 if _fails else 0


def adb(*a, check=True):
    return subprocess.run([ADB, *a], capture_output=True, text=True, check=check).stdout

_user = None
def app_user():
    """Which Android user has the app. This phone runs Island, an app-cloning
    profile, and the debug build lives inside it as user 10 — so `am start`
    without --user says the activity "does not exist", and the profile stops
    itself when it has been idle, which is when that starts happening."""
    global _user
    if _user is None:
        _user = "0"
        for u in ["0"] + re.findall(r"UserInfo\{(\d+):", adb("shell", "pm", "list", "users", check=False)):
            if PKG in adb("shell", "pm", "list", "packages", "--user", u, check=False):
                _user = u
                break
    return _user


_rot = None
def portrait():
    """Upright until this process ends, then however the owner had it."""
    global _rot
    if _rot is None:
        _rot = (adb("shell", "settings", "get", "system", "accelerometer_rotation", check=False).strip(),
                adb("shell", "settings", "get", "system", "user_rotation", check=False).strip())
        atexit.register(_restore)
    adb("shell", "settings", "put", "system", "accelerometer_rotation", "0", check=False)
    adb("shell", "settings", "put", "system", "user_rotation", "0", check=False)
    time.sleep(0.4)

def _restore():
    if not _rot: return
    a, u = _rot
    if u.isdigit(): adb("shell", "settings", "put", "system", "user_rotation", u, check=False)
    if a.isdigit(): adb("shell", "settings", "put", "system", "accelerometer_rotation", a, check=False)

class Phone:
    def __init__(self): self.ws = None; self.n = 0; self.dpr = 2.8125
    async def launch(self, fresh=True):
        # A phone lying on a desk turns itself sideways, and at 832px the layout
        # is no longer the phone layout: every gesture disarms (touchLayout()),
        # and a whole run fails for a reason no code caused. Lock it upright and
        # put it back the way it was on the way out. The shade, if a stray swipe
        # pulled it down, eats every touch meant for the app.
        portrait()
        adb("shell", "cmd", "statusbar", "collapse", check=False)
        u = app_user()
        if fresh: adb("shell", "am", "force-stop", "--user", u, PKG, check=False)
        adb("reverse", "tcp:8421", "tcp:8421")
        adb("shell", "am", "start", "--user", u, "-n", f"{PKG}/xyz.tiresia.dvarim.DevActivity", "--es", "url", URL)
        await self.attach("http://localhost")

    async def attach(self, origin):
        """The DevTools of the page this app is showing from `origin`: DevActivity's
        development server, or FolderActivity's own https://appassets.androidplatform.net."""
        # The socket is named for the process that owns it, and the real app may
        # be running too — picking the newest one attached to the wrong app is
        # how this used to fail with "no page target".
        sock = None
        for _ in range(40):
            pid = adb("shell", "pidof", PKG, check=False).strip().split()
            if pid:
                want = f"webview_devtools_remote_{pid[0]}"
                if any(want in l for l in adb("shell", "cat", "/proc/net/unix").splitlines()):
                    sock = want
                    break
            time.sleep(0.25)
        if not sock: raise RuntimeError(f"{PKG} has no DevTools socket: is it running?")
        adb("forward", "--remove-all")
        adb("forward", "tcp:9222", f"localabstract:{sock}")
        page = None
        for _ in range(40):
            try:
                targets = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=2))
                page = next(t for t in targets if t["type"] == "page" and t["url"].startswith(origin))
                break
            except Exception: time.sleep(0.25)
        if not page: raise RuntimeError("no page on the DevTools socket")
        self.ws = await websockets.connect(page["webSocketDebuggerUrl"], max_size=None)
        await self.wait("document.querySelectorAll('[data-todo-id]').length > 0 || document.querySelector('.empty')", 10)
        self.dpr = await self.js("devicePixelRatio")
    async def goto(self, path):
        """Another list, the way the app itself moves: no reload, same history."""
        await self.js(f"(() => {{ history.replaceState(history.state, '', {json.dumps(path)}); dispatchEvent(new PopStateEvent('popstate', {{state: null}})); }})()")
        await asyncio.sleep(1.0)
    async def call(self, method, **params):
        self.n += 1; me = self.n
        await self.ws.send(json.dumps({"id": me, "method": method, "params": params}))
        while True:
            m = json.loads(await self.ws.recv())
            if m.get("id") == me: return m
    async def js(self, expr):
        r = (await self.call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)).get("result", {})
        if "exceptionDetails" in r: raise RuntimeError(json.dumps(r["exceptionDetails"])[:600])
        return r.get("result", {}).get("value")
    async def wait(self, expr, secs=4):
        end = time.time() + secs
        while time.time() < end:
            if await self.js(f"!!({expr})"): return True
            await asyncio.sleep(0.1)
        return False
    def px(self, v): return str(round(v * self.dpr))
    # --- fingers (CSS px in, device px out)
    def tap(self, x, y): adb("shell", "input", "tap", self.px(x), self.px(y))
    def swipe(self, x1, y1, x2, y2, ms=350): adb("shell", "input", "swipe", self.px(x1), self.px(y1), self.px(x2), self.px(y2), str(ms))
    def down(self, x, y): adb("shell", "input", "motionevent", "DOWN", self.px(x), self.px(y))
    def move(self, x, y): adb("shell", "input", "motionevent", "MOVE", self.px(x), self.px(y))
    def up(self, x, y): adb("shell", "input", "motionevent", "UP", self.px(x), self.px(y))
    def keyboard(self): return "mInputShown=true" in adb("shell", "dumpsys", "input_method")
    def back(self):
        """Back, as a person means it. Android spends the first one on the keyboard
        when that is up, and nothing of it reaches the app: so does everyone's thumb."""
        if self.keyboard():
            adb("shell", "input", "keyevent", "BACK"); time.sleep(0.5)
        adb("shell", "input", "keyevent", "BACK")
    def shot(self, name):
        os.makedirs(os.path.join(WORK, "shots"), exist_ok=True)
        p = os.path.join(WORK, "shots", name + ".png")
        with open(p, "wb") as f: f.write(subprocess.run([ADB, "exec-out", "screencap", "-p"], capture_output=True).stdout)
        subprocess.run(["sips", "-Z", "1000", p, "--out", p.replace(".png", "_s.png")], capture_output=True)
        return p
    async def rect(self, sel, i=0):
        return await self.js(f"(() => {{ const e=[...document.querySelectorAll({json.dumps(sel)})][{i}]; if(!e) return null; const r=e.getBoundingClientRect(); return {{x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2}} }})()")
    async def quiet(self, ms=320, timeout=5):
        """Wait until the list has stopped moving. A scroller the browser still
        considers active takes the next touch for itself, so a gesture sent into
        one does nothing — which is what a person sees too, if they are quick."""
        await self.js("(() => { if (window.__quiet) return; window.__quiet = 1; window.__lastScroll = performance.now();"
                      " const c = document.querySelector('.content'); if (!c) return;"
                      " c.addEventListener('scroll', () => { window.__lastScroll = performance.now(); }, {passive: true}); })()")
        end = time.time() + timeout
        while time.time() < end:
            if await self.js(f"performance.now() - (window.__lastScroll || 0) > {ms}"): return True
            await asyncio.sleep(0.1)
        return False

    async def to_top(self, tries=12):
        """Put the list at the top and make it stay there. Setting scrollTop once
        is not enough: a refresh re-renders the rows and Chrome's scroll
        anchoring puts the position back, so the pull — which only starts from a
        standstill at the top — never begins."""
        for _ in range(tries):
            await self.js("document.querySelector('.content').scrollTop = 0")
            await self.quiet()
            if await self.js("document.querySelector('.content').scrollTop === 0"): return True
            await asyncio.sleep(0.2)
        return False

    async def row(self, i=0):
        """A collapsed row. An open card carries data-todo-id too, and measuring
        that instead of a row is how a tap meant for the list landed in the card."""
        return await self.js(f"(() => {{ const e=[...document.querySelectorAll('[data-todo-id]')].filter(x => !x.matches('.card'))[{i}]; if(!e) return null; const r=e.getBoundingClientRect(); return {{x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2}} }})()")

    async def titles(self, n=8):
        return await self.js(f"[...document.querySelectorAll('[data-todo-id]')].slice(0,{n}).map(r => (r.querySelector('.txt')?.textContent || r.querySelector('input,textarea')?.value || '').trim().slice(0,26))")
    def foreground(self): return PKG in adb("shell", "dumpsys", "window").split("mCurrentFocus")[1].split("\n")[0]
