#!/usr/bin/env python3
"""Take every picture in docs/images again, from a demo vault, in a real browser.

    tools/docs_shots/shoot.py                 # all of them, into docs/images
    tools/docs_shots/shoot.py --only hero-light,when --out /tmp/shots

What it needs: Docker, the Chrome container (docker-chrome-1, DevTools on
:9222), the images node:22-alpine and tomsquest/docker-radicale, Python with
httpx, websockets and Pillow, and a built web app (frontend/build.sh; --build
runs it first).

What it does, all of it throwaway and in a scratch folder:

- builds the demo vault (demo_vault.py) as of the shoot day, and copies of it;
- starts a Radicale of its own with the calendars Work and Home and the
  events the pictures show;
- starts four sandbox servers inside the Chrome container's network, so the
  browser reaches them at localhost: the one most pictures show (a password,
  the calendars, three devices), one more to sync a browser vault with, one to
  serve that browser vault's page, and one with other people on it;
- drives the web app over the DevTools Protocol, each scene in a browser
  profile of its own, and frames what it sees: a window for the desktop, a
  phone for the phone;
- stops and removes every container it started, and deletes the scratch
  folder (--keep leaves both, to look around in).

The shoot day is the latest Sunday (--today to choose another), 16:00 in
America/Phoenix: the docs name the weekdays a Sunday gives ("Tuesday with an
event", "yesterday, Friday, Thursday"). Both the servers' clock and the page's
are moved there (clock.mjs).

It never touches a real vault, the live server or the real `radicale`
container: everything it runs is named dvarim-docs-*, and it refuses to start
if one of those names is taken.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import datetime as dt
import io
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import websockets
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
import demo_vault  # noqa: E402

TZ = "America/Phoenix"
CHROME = "docker-chrome-1"
PREFIX = "dvarim-docs-"
PORTS = {"main": 8521, "sync": 8522, "page": 8523, "people": 8524, "radicale": 8529}
DESK = (1440, 900)           # the window the desktop pictures are taken in, CSS px
PHONE = (390, 844)           # the phone's
MAC_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
ANDROID_UA = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")


def log(*a):
    print(*a, flush=True)


def sh(*cmd, check=True, capture=True, env=None):
    r = subprocess.run(cmd, check=False, capture_output=capture, text=True, env=env)
    if check and r.returncode != 0:
        raise SystemExit(f"failed: {' '.join(cmd)}\n{r.stdout}\n{r.stderr}")
    return r


# --------------------------------------------------------------------------
# The stack: Radicale and the sandbox servers, in Docker
# --------------------------------------------------------------------------

class Stack:
    """Everything this run starts, in `work`, and how to take it down again."""

    def __init__(self, work: Path, day: dt.date):
        self.work = work
        self.day = day
        self.uid = f"{os.getuid()}:{os.getgid()}"
        self.started: list[str] = []
        self.chrome_ip = sh("docker", "inspect", "-f",
                            "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", CHROME).stdout.split()[0]
        state = work / "stack.json"
        if state.exists():                       # --attach: the same clock as the servers already have
            saved = json.loads(state.read_text())
            self.offset_ms, self.secrets = saved["offset_ms"], saved["secrets"]
        else:
            start = dt.datetime.combine(day, dt.time(16, 0), ZoneInfo(TZ))
            self.offset_ms = int(start.timestamp() * 1000 - time.time() * 1000)
            self.secrets = {k: secrets.token_urlsafe(18) for k in ("main", "sync", "people", "caldav")}
            state.write_text(json.dumps({"offset_ms": self.offset_ms, "secrets": self.secrets}))

    def url(self, which, host=None):
        """The server as the browser sees it (localhost), or from here (the container's address)."""
        return f"http://{host or self.chrome_ip}:{PORTS[which]}"

    def refuse_taken(self):
        names = sh("docker", "ps", "-a", "--format", "{{.Names}}").stdout.split()
        taken = [n for n in names if n.startswith(PREFIX)]
        if taken:
            raise SystemExit(f"already there: {', '.join(taken)}. Remove them (docker rm -f …) or use --attach.")

    def run(self, name, *args):
        sh("docker", "run", "-d", "--name", PREFIX + name, "--network", f"container:{CHROME}", *args)
        self.started.append(PREFIX + name)

    def start(self):
        self.refuse_taken()
        w = self.work
        # the vaults: the one the pictures show, a copy to sync a browser vault
        # with, a copy for the server with other people on it, and an empty one
        # behind the page of the browser vault
        demo_vault.build(w / "main/vault", self.day)
        shutil.copytree(w / "main/vault", w / "sync/vault")
        shutil.copytree(w / "main/vault", w / "people/vault")
        (w / "page/vault").mkdir(parents=True)
        for k in ("main", "sync", "people", "page"):
            (w / k / "auth").mkdir(parents=True, exist_ok=True)

        # Radicale, on an empty folder, at a port of its own
        (w / "radicale/data").mkdir(parents=True)
        (w / "radicale/config").mkdir(parents=True)
        (w / "radicale/config/config").write_text(
            f"[server]\nhosts = 0.0.0.0:{PORTS['radicale']}\n[auth]\ntype = none\n"
            "[storage]\nfilesystem_folder = /data/collections\n")
        self.run("radicale", "-u", self.uid,
                 "-v", f"{w}/radicale/data:/data", "-v", f"{w}/radicale/config:/config:ro",
                 "tomsquest/docker-radicale:latest")
        self.wait_http(f"http://{self.chrome_ip}:{PORTS['radicale']}/.web/", "Radicale")
        self.make_calendars()

        for k in ("main", "sync", "people", "page"):
            env = ["-e", f"PORT={PORTS[k]}", "-e", "HOST=0.0.0.0", "-e", f"TZ={TZ}",
                   "-e", "DVARIM_ROOT=/vault", "-e", "DVARIM_STATIC=/repo/frontend/dist",
                   "-e", "DVARIM_AUTH_FILE=/auth/auth.json", "-e", "DVARIM_PEOPLE=/auth/people",
                   "-e", f"DVARIM_SHOTS_CLOCK_OFFSET={self.offset_ms}"]
            if k in ("main", "people"):
                env += ["-e", f"DVARIM_CALDAV_URL=http://127.0.0.1:{PORTS['radicale']}/shots/",
                        "-e", "DVARIM_CALDAV_USER=shots", "-e", f"DVARIM_CALDAV_PASS={self.secrets['caldav']}"]
            self.run(k, "-u", self.uid, "-e", "HOME=/tmp", "-v", f"{REPO}:/repo:ro",
                     "-v", f"{w}/{k}/vault:/vault", "-v", f"{w}/{k}/auth:/auth", *env,
                     "node:22-alpine", "node", "--import", "/repo/tools/docs_shots/clock.mjs",
                     "/repo/server/src/main.js")
        for k in ("main", "sync", "people", "page"):
            self.wait_http(self.url(k) + "/api/health", k)
        for k in ("main", "sync", "people"):
            self.set_password(k)

    def set_password(self, which):
        """The server's own Auth, as `cli.js set-password` would do it, without the terminal."""
        code = ("import { Auth } from '/repo/server/src/auth.js';"
                "const a = Auth.load('/vault', '/auth/auth.json');"
                "a.setPassword(process.env.SHOTS_PW); a.rotateSecret();")
        sh("docker", "exec", "-e", f"SHOTS_PW={self.secrets[which]}", PREFIX + which,
           "node", "--input-type=module", "-e", code)
        for _ in range(50):
            if httpx.get(self.url(which) + "/api/auth", timeout=5).json().get("required"):
                return
            time.sleep(0.1)
        raise SystemExit(f"{which}: the password did not take")

    def wait_http(self, url, what, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if httpx.get(url, timeout=2).status_code < 500:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.25)
        raise SystemExit(f"{what} never answered at {url}")

    def make_calendars(self):
        """Work and Home, and the events, made over CalDAV like any client would."""
        base = f"http://{self.chrome_ip}:{PORTS['radicale']}/shots/"
        auth = ("shots", self.secrets["caldav"])
        with httpx.Client(auth=auth, timeout=10) as c:
            c.request("PROPFIND", base, headers={"Depth": "0"})
            for i, (name, color) in enumerate(demo_vault.CALENDARS, 1):
                body = ('<?xml version="1.0" encoding="utf-8"?>'
                        '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" '
                        'xmlns:A="http://apple.com/ns/ical/"><D:set><D:prop>'
                        f'<D:displayname>{name}</D:displayname><A:calendar-color>{color}FF</A:calendar-color>'
                        '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>'
                        '</D:prop></D:set></C:mkcalendar>')
                r = c.request("MKCALENDAR", base + f"c{i}-{name.lower()}/", content=body,
                              headers={"Content-Type": "application/xml; charset=utf-8"})
                if r.status_code >= 300:
                    raise SystemExit(f"MKCALENDAR {name}: {r.status_code} {r.text[:200]}")
            hrefs = {name: f"c{i}-{name.lower()}" for i, (name, _) in enumerate(demo_vault.CALENDARS, 1)}
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            zone = ZoneInfo(TZ)
            for n, (day, hhmm, minutes, cal, title) in enumerate(demo_vault.EVENTS):
                start = dt.datetime.combine(self.day + dt.timedelta(days=day),
                                            dt.time(*map(int, hhmm.split(":"))), zone)
                end = start + dt.timedelta(minutes=minutes)
                z = lambda t: t.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")  # noqa: E731
                uid = f"docs-shots-{n}@example.com"
                ics = ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Dvarim docs shots//EN\r\n"
                       f"BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:{stamp}\r\nDTSTART:{z(start)}\r\n"
                       f"DTEND:{z(end)}\r\nSUMMARY:{title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
                r = c.put(base + f"{hrefs[cal]}/{uid}.ics", content=ics.encode(),
                          headers={"Content-Type": "text/calendar; charset=utf-8"})
                if r.status_code >= 300:
                    raise SystemExit(f"PUT {title}: {r.status_code} {r.text[:200]}")

    def stop(self):
        names = [n for n in sh("docker", "ps", "-a", "--format", "{{.Names}}").stdout.split() if n.startswith(PREFIX)]
        for n in names:
            sh("docker", "rm", "-f", n, check=False)
        return names


# --------------------------------------------------------------------------
# The browser, over the DevTools Protocol
# --------------------------------------------------------------------------

class CDP:
    """One websocket to Chrome: the browser's own, or one page's."""

    def __init__(self, url):
        self.url = url
        self.ws = None
        self.n = 0
        self.errors: list[str] = []

    async def connect(self):
        self.ws = await websockets.connect(self.url, max_size=200 * 1024 * 1024)
        return self

    async def close(self):
        if self.ws:
            await self.ws.close()

    async def send(self, method, params=None):
        self.n += 1
        me = self.n
        await self.ws.send(json.dumps({"id": me, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("method") == "Runtime.exceptionThrown":
                d = msg["params"].get("exceptionDetails", {})
                self.errors.append(str((d.get("exception") or {}).get("description") or d.get("text"))[:300])
            elif msg.get("method") == "Runtime.consoleAPICalled" and msg["params"].get("type") == "error":
                self.errors.append(" ".join(str(a.get("value", a.get("description", ""))) for a in msg["params"].get("args", []))[:300])
            if msg.get("id") == me:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})


class Tab(CDP):
    """A page in a browser profile of its own."""

    def __init__(self, browser, target_id, kind, dark):
        super().__init__(f"ws://{browser.host}/devtools/page/{target_id}")
        self.browser, self.target_id, self.kind, self.dark = browser, target_id, kind, dark

    async def setup(self, offset_ms):
        await self.send("Page.enable")
        await self.send("Runtime.enable")
        await self.send("Page.bringToFront")
        await self.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
        await self.send("Emulation.setTimezoneOverride", {"timezoneId": TZ})
        await self.send("Emulation.setLocaleOverride", {"locale": "en-US"})
        if self.kind == "phone":
            w, h = PHONE
            await self.send("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 3, "mobile": True})
            await self.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
            await self.send("Emulation.setUserAgentOverride", {"userAgent": ANDROID_UA, "platform": "Linux armv8l"})
        else:
            w, h = DESK
            await self.send("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 2, "mobile": False})
            await self.send("Emulation.setUserAgentOverride", {"userAgent": MAC_UA, "platform": "MacIntel"})
        await self.send("Emulation.setEmulatedMedia", {"features": [
            {"name": "prefers-color-scheme", "value": "dark" if self.dark else "light"},
            {"name": "prefers-reduced-motion", "value": "reduce"}]})
        # The Mac's and the phone's own fonts are not in this browser; Inter is
        # what the pictures have always been set in, and FreeMono their code.
        await self.send("Page.setFontFamilies", {"fontFamilies": {
            "standard": "Inter Variable", "sansSerif": "Inter Variable", "serif": "Inter Variable",
            "fixed": "FreeMono"}})
        # the clock of the shoot day, the same as the servers' (clock.mjs)
        await self.send("Page.addScriptToEvaluateOnNewDocument", {"source": CLOCK_JS % offset_ms})

    async def goto(self, url, ready="!!document.querySelector('.nav')", timeout=30):
        await self.send("Page.navigate", {"url": url})
        await asyncio.sleep(0.5)
        if ready and not await self.wait_for(ready, timeout):
            raise RuntimeError(f"{url}: never ready ({ready})")

    async def js(self, expr):
        r = await self.send("Runtime.evaluate", {"expression": f"(async () => {{ {expr} }})()",
                                                 "awaitPromise": True, "returnByValue": True})
        if r.get("exceptionDetails"):
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:500])
        return r.get("result", {}).get("value")

    async def wait_for(self, expr, timeout=20.0):
        end = time.time() + timeout
        while time.time() < end:
            try:
                v = await self.js(f"return ({expr});")
            except RuntimeError:
                v = None
            if v:
                return v
            await asyncio.sleep(0.2)
        return None

    async def rect(self, sel, text=None):
        """The middle of the element a selector (and, if given, its text) names."""
        r = await self.js(f"""
            const els = [...document.querySelectorAll({json.dumps(sel)})];
            const t = {json.dumps(text)};
            const el = t === null ? els[0] : els.find((e) => e.textContent.trim().startsWith(t));
            if (!el) return null;
            el.scrollIntoView({{block: 'nearest'}});
            const b = el.getBoundingClientRect();
            return {{x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, top: b.top}};""")
        if not r:
            raise RuntimeError(f"no element {sel} {text or ''}")
        return r

    async def click(self, sel, text=None, count=1):
        r = await self.rect(sel, text)
        await self.mouse(r["x"], r["y"], count)
        return r

    async def mouse(self, x, y, count=1):
        await self.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
        for i in range(1, count + 1):
            for t in ("mousePressed", "mouseReleased"):
                await self.send("Input.dispatchMouseEvent", {"type": t, "x": x, "y": y, "button": "left",
                                                             "clickCount": i, "pointerType": "mouse"})
        await asyncio.sleep(0.15)

    async def tap(self, sel, text=None):
        r = await self.rect(sel, text)
        p = [{"x": r["x"], "y": r["y"]}]
        await self.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": p})
        await self.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        await asyncio.sleep(0.4)
        return r

    async def key(self, key, code=None, mods=(), vk=None):
        bits = {"alt": 1, "ctrl": 2, "meta": 4, "shift": 8}
        m = sum(bits[x] for x in mods)
        code = code or (f"Key{key.upper()}" if len(key) == 1 and key.isalpha() else
                        f"Digit{key}" if len(key) == 1 and key.isdigit() else key)
        vk = vk or (ord(key.upper()) if len(key) == 1 else {"Escape": 27, "Enter": 13, "ArrowDown": 40, "ArrowUp": 38}.get(key, 0))
        base = {"modifiers": m, "key": key, "code": code, "windowsVirtualKeyCode": vk}
        await self.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", **base})
        await self.send("Input.dispatchKeyEvent", {"type": "keyUp", **base})
        await asyncio.sleep(0.2)

    async def type(self, text):
        await self.send("Input.insertText", {"text": text})
        await asyncio.sleep(0.3)

    async def settle(self, extra=0.6):
        """Let the page finish: fonts, the stream's refetches, the mirror's round."""
        await self.wait_for("document.fonts.status === 'loaded'", 10)
        await self.js("await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return true;")
        await asyncio.sleep(extra)

    async def shot(self) -> Image.Image:
        await self.settle()
        bad = await self.js("return [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim());")
        if bad:
            log(f"    note: a toast is showing: {bad}")
        data = await self.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        return Image.open(io.BytesIO(base64.b64decode(data["data"]))).convert("RGB")


CLOCK_JS = r"""(() => {
  const offset = %d, Real = Date;
  function ShotDate(...a) {
    if (!new.target) return new Real(Real.now() + offset).toString();
    return a.length ? new Real(...a) : new Real(Real.now() + offset);
  }
  ShotDate.prototype = Real.prototype;
  ShotDate.now = () => Real.now() + offset;
  ShotDate.parse = Real.parse; ShotDate.UTC = Real.UTC;
  window.Date = ShotDate;
})();"""


class Browser:
    def __init__(self, devtools):
        self.devtools = devtools.rstrip("/")
        self.host = self.devtools.split("://", 1)[1]
        self.cdp = None
        self.contexts = []

    async def __aenter__(self):
        info = httpx.get(self.devtools + "/json/version", timeout=10).json()
        path = info["webSocketDebuggerUrl"].split("/devtools/", 1)[1]
        self.cdp = await CDP(f"ws://{self.host}/devtools/{path}").connect()
        return self

    async def __aexit__(self, *a):
        for c in self.contexts:
            try:
                await self.cdp.send("Target.disposeBrowserContext", {"browserContextId": c})
            except Exception:
                pass
        await self.cdp.close()

    async def tab(self, stack, kind="desk", dark=False):
        """A new tab in a new profile: nothing kept from any other scene."""
        ctx = (await self.cdp.send("Target.createBrowserContext", {"disposeOnDetach": True}))["browserContextId"]
        self.contexts.append(ctx)
        tid = (await self.cdp.send("Target.createTarget", {"url": "about:blank", "browserContextId": ctx}))["targetId"]
        t = Tab(self, tid, kind, dark)
        await t.connect()
        await t.setup(stack.offset_ms)
        return t

    async def done(self, tab):
        await tab.close()
        try:
            await self.cdp.send("Target.closeTarget", {"targetId": tab.target_id})
        except Exception:
            pass


# --------------------------------------------------------------------------
# Frames, measured on the pictures they replace
# --------------------------------------------------------------------------

# A window: the page pasted into a rounded rectangle (not antialiased, as the
# old ones were), a 1px outline at 15% black, and a soft shadow below.
WINDOWS = {
    #         canvas        window box (inclusive)     radius  shadow: alpha blur  drop
    "desk": ((1486, 961), (43, 43, 1442, 917), 12, 74, 19.5, 8),
    "hero": ((1700, 1100), (50, 50, 1649, 1049), 14, 74, 21.5, 10),
}


def window(raw: Image.Image, kind="desk") -> Image.Image:
    (W, H), box, radius, alpha, blur, drop = WINDOWS[kind]
    x0, y0, x1, y1 = box
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + drop, x1, y1 + drop), radius=radius, fill=alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    win = Image.new("L", (W, H), 0)
    ImageDraw.Draw(win).rounded_rectangle(box, radius=radius, fill=255)
    inner = Image.new("L", (W, H), 0)
    ImageDraw.Draw(inner).rounded_rectangle(box, radius=radius, fill=255, outline=0, width=1)
    ring = ImageChops.subtract(win, inner)
    # outline over shadow: 1 - (1 - s)(1 - .15)
    a = Image.composite(Image.eval(shadow, lambda s: round(255 - (255 - s) * 0.85)), shadow, ring)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.putalpha(a)
    page = raw.convert("RGB").resize((x1 - x0 - 1, y1 - y0 - 1), Image.LANCZOS)
    full = Image.new("RGB", (W, H))
    full.paste(page, (x0 + 1, y0 + 1))
    out.paste(full, (0, 0), inner)
    return out


# A phone, drawn at twice the size and brought down, as the old ones were:
# a dark body with a lighter rim, and the screen's rounded corners.
PHONE_FRAME = dict(canvas=(1188, 2312), body=(74, 74, 1113, 2237), body_r=144, rim=6,
                   rim_c=(70, 70, 76), bezel_c=(24, 24, 27), screen=(111, 111, 1076, 2200), screen_r=124,
                   shadow_a=60, blur=30, drop=16, out=(594, 1156))


def phone(raw: Image.Image) -> Image.Image:
    f = PHONE_FRAME
    W, H = f["canvas"]
    bx0, by0, bx1, by1 = f["body"]
    sh = Image.new("L", (W, H), 0)
    ImageDraw.Draw(sh).rounded_rectangle((bx0, by0 + f["drop"], bx1, by1 + f["drop"]), radius=f["body_r"], fill=f["shadow_a"])
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.putalpha(sh.filter(ImageFilter.GaussianBlur(f["blur"])))
    d = ImageDraw.Draw(out)
    d.rounded_rectangle(f["body"], radius=f["body_r"], fill=f["rim_c"] + (255,))
    r = f["rim"]
    d.rounded_rectangle((bx0 + r, by0 + r, bx1 - r, by1 - r), radius=f["body_r"] - r, fill=f["bezel_c"] + (255,))
    sx0, sy0, sx1, sy1 = f["screen"]
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle(f["screen"], radius=f["screen_r"], fill=255)
    screen = Image.new("RGBA", (W, H))
    screen.paste(raw.convert("RGB").resize((sx1 - sx0 + 1, sy1 - sy0 + 1), Image.LANCZOS), (sx0, sy0))
    out.paste(screen, (0, 0), mask)
    return out.resize(f["out"], Image.LANCZOS)


def side_by_side(phones: list[Image.Image], gap=40) -> Image.Image:
    w, h = phones[0].size
    out = Image.new("RGBA", (w * len(phones) + gap * (len(phones) - 1), h), (0, 0, 0, 0))
    for i, p in enumerate(phones):
        out.alpha_composite(p, (i * (w + gap), 0))
    return out


# --------------------------------------------------------------------------
# The scenes: what each picture shows, and how to get the app there
# --------------------------------------------------------------------------

SCENES = {}


def scene(name, frame="desk", kind="desk", dark=False, server="main"):
    """Register a scene. `frame` is desk, hero or phone; phones is put together from three."""
    def deco(fn):
        SCENES[name] = dict(fn=fn, frame=frame, kind=kind, dark=dark, server=server)
        return fn
    return deco


ROW = ("[...document.querySelectorAll('.row[data-todo-id]')]"
       ".find((r) => (r.querySelector('.txt')?.textContent || '').trim().startsWith(%s))")


async def sign_in(t, stack, which="main", path="/today", prep=None):
    base = stack.url(which, "localhost")
    await t.goto(base + "/today", ready="!!document.querySelector('#pw') || !!document.querySelector('.nav')")
    if prep:
        await t.js(prep)
    if await t.js("return !!document.querySelector('#pw');"):
        ok = await t.js(f"""
            const r = await fetch('/api/login', {{method: 'POST', headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{password: {json.dumps(stack.secrets[which])}}})}});
            return r.ok;""")
        if not ok:
            raise RuntimeError(f"{which}: could not sign in")
    await t.goto(base + path)
    await loaded(t)


async def loaded(t):
    """The lists are in, and so is the calendar on Today."""
    await t.wait_for("document.querySelectorAll('.nav .item').length > 8", 20)
    await t.wait_for("!document.querySelector('.loading, .spin')", 10)
    await t.settle(1.0)


async def open_row(t, title):
    """A to-do open in place, as a double-click opens it."""
    await t.wait_for("!!" + ROW % json.dumps(title))
    r = await t.js(f"const r = {ROW % json.dumps(title)}; r.scrollIntoView({{block: 'nearest'}}); "
                   "const b = r.querySelector('.txt').getBoundingClientRect(); return {x: b.x + 20, y: b.y + b.height / 2};")
    await t.mouse(r["x"], r["y"], count=2)
    await t.wait_for("!!document.querySelector('.card[data-card]')", 5)
    await t.settle()


async def select_row(t, title):
    await t.wait_for("!!" + ROW % json.dumps(title))
    r = await t.js(f"const r = {ROW % json.dumps(title)}; r.scrollIntoView({{block: 'nearest'}}); "
                   "const b = r.querySelector('.txt').getBoundingClientRect(); return {x: b.x + b.width + 4, y: b.y + b.height / 2};")
    await t.mouse(r["x"], r["y"])
    await t.wait_for(f"{ROW % json.dumps(title)}.classList.contains('sel')", 5)


async def no_hover(t):
    """The mouse out of the way, so nothing shows a hover."""
    await t.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": DESK[0] - 2, "y": 2})


async def settings(t, pane):
    await t.js("document.querySelector('.sidefoot [aria-label=\"Settings\"]').click(); return true;")
    await t.wait_for(f"!!document.querySelector('#pane-tab-{pane}')", 8)
    await t.js(f"document.querySelector('#pane-tab-{pane}').click(); return true;")
    await t.settle()


# ---- the lists, on the desktop ----

@scene("hero-light", frame="hero")
async def hero_light(t, stack):
    await sign_in(t, stack, path="/today")
    await t.wait_for("document.querySelectorAll('.events .ev').length === 3", 15)
    await no_hover(t)
    return await t.shot()


@scene("hero-dark", frame="hero", dark=True)
async def hero_dark(t, stack):
    return await hero_light(t, stack)


@scene("anytime")
async def anytime(t, stack):
    await sign_in(t, stack, path="/anytime")
    await no_hover(t)
    return await t.shot()


@scene("someday")
async def someday(t, stack):
    await sign_in(t, stack, path="/someday")
    await no_hover(t)
    return await t.shot()


@scene("logbook")
async def logbook(t, stack):
    await sign_in(t, stack, path="/logbook")
    await no_hover(t)
    return await t.shot()


@scene("upcoming")
async def upcoming(t, stack):
    await sign_in(t, stack, path="/upcoming")
    await t.wait_for("document.querySelectorAll('.ev').length >= 5", 15)
    await no_hover(t)
    return await t.shot()


@scene("upcoming-dark", dark=True)
async def upcoming_dark(t, stack):
    return await upcoming(t, stack)


@scene("area")
async def area(t, stack):
    await sign_in(t, stack, path="/area/ahome0001")
    await no_hover(t)
    return await t.shot()



# ---- popovers, cards and menus ----

MOD = ("meta",)          # the page thinks it is on a Mac (MAC_UA), so ⌘


@scene("when")
async def when(t, stack):
    await sign_in(t, stack, path="/today")
    await select_row(t, "Call the bank about the new card")
    await t.key("s", mods=MOD)
    await t.wait_for("!!document.querySelector('.pop')", 5)
    await no_hover(t)
    return await t.shot()


@scene("deadline")
async def deadline(t, stack):
    await sign_in(t, stack, path="/today")
    await select_row(t, "Write the summary page")
    await t.key("d", mods=MOD + ("shift",))
    await t.wait_for("!!document.querySelector('.pop')", 5)
    await no_hover(t)
    return await t.shot()


@scene("tags")
async def tags(t, stack):
    await sign_in(t, stack, path="/today")
    await select_row(t, "Call the bank about the new card")
    await t.key("t", mods=MOD + ("shift",))
    await t.wait_for("!!document.querySelector('.pop')", 5)
    await no_hover(t)
    return await t.shot()


@scene("move")
async def move(t, stack):
    await sign_in(t, stack, path="/inbox")
    await select_row(t, "Gift idea: a good bread knife")
    await t.key("m", mods=MOD + ("shift",))
    await t.wait_for("!!document.querySelector('.pop')", 5)
    await no_hover(t)
    return await t.shot()


@scene("quick-find")
async def quick_find(t, stack):
    await sign_in(t, stack, path="/today")
    await t.wait_for("document.querySelectorAll('.events .ev').length === 3", 15)
    await t.key("f", mods=MOD)
    await t.wait_for("!!document.querySelector('.qf input')", 5)
    await t.type("tr")
    await t.wait_for("document.querySelectorAll('.qf .r').length >= 8", 8)
    await no_hover(t)
    return await t.shot()


@scene("project")
async def project(t, stack):
    await sign_in(t, stack, path="/project/pkitch001")
    await open_row(t, "Choose the cabinet colour")
    await t.js("document.activeElement && document.activeElement.blur(); return true;")
    await no_hover(t)
    return await t.shot()


@scene("notes")
async def notes(t, stack):
    await sign_in(t, stack, path="/project/ptrip0001")
    await open_row(t, "Find a place to stay near the harbour")
    await t.js("document.activeElement && document.activeElement.blur(); return true;")
    await no_hover(t)
    return await t.shot()


@scene("project-menu")
async def project_menu(t, stack):
    await sign_in(t, stack, path="/project/pkitch001")
    await t.click("h1.t .more")
    await t.wait_for("!!document.querySelector('.pop')", 5)
    await no_hover(t)
    return await t.shot()


@scene("edit-the-note")
async def edit_the_note(t, stack):
    await sign_in(t, stack, path="/project/pkitch001")
    await t.click("h1.t .more")
    await t.wait_for("!!document.querySelector('.pop')", 5)
    await t.click(".pop button", "Edit the note itself")
    await t.wait_for("!!document.querySelector('textarea') && document.querySelector('textarea').value.length > 100", 8)
    await no_hover(t)
    return await t.shot()



# ---- the file beside the app ----

EDITOR_FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")


def editor_html(name, folder, text):
    """The project's Markdown as a plain editor shows it: line numbers, soft wrap,
    and the colours an editor gives front matter, headings, tags and done lines."""
    import html
    import re

    def esc(x):
        return html.escape(x, quote=False)

    def todo_line(line):
        box = re.match(r"\s*- \[.\] ", line).group(0)
        rest = esc(line[len(box):])
        rest = re.sub(r"(#[\w/-]+)", r'<span class="tag">\1</span>', rest)
        rest = re.sub(r"🆔 (\w+)", r'🆔 <span class="id">\1</span>', rest)
        return f'{esc(box)}<span class="{"done" if "[x]" in box else ""}">{rest}</span>'

    rows, fm = [], 0
    for line in text.rstrip("\n").split("\n"):
        if line == "---" and fm < 2:
            fm += 1
            body = f'<span class="rule">{esc(line)}</span>'
        elif fm == 1 and ":" in line:
            k, v = line.split(":", 1)
            body = f'<span class="key">{esc(k)}:</span><span class="val">{esc(v)}</span>'
        elif line.startswith("## "):
            body = f'<span class="h">{esc(line)}</span>'
        elif re.match(r"\s*- \[.\]", line):
            body = todo_line(line)
        else:
            body = esc(line) or "&#8203;"
        rows.append(f'<div class="l"><span class="n">{len(rows) + 1}</span><span class="t">{body}</span></div>')
    font = base64.b64encode(EDITOR_FONT.read_bytes()).decode() if EDITOR_FONT.exists() else ""
    face = f"@font-face{{font-family:Mono;src:url(data:font/ttf;base64,{font})}}" if font else ""
    return f"""<!doctype html><meta charset="utf-8"><style>{face}
html,body{{margin:0;height:100%;background:#FBFBFA}}
body{{border-right:1px solid #E7E5E1;box-sizing:border-box;overflow:hidden;-webkit-font-smoothing:antialiased}}
.top{{height:39px;border-bottom:1px solid #E7E6E2;background:#F1F0EE;display:flex;align-items:center;gap:8px;
  padding:0 16px;font:600 13px 'Inter Variable',sans-serif;color:#141414}}
.top span{{font-weight:400;color:#8E8E8F}}
.code{{padding:17px 10px 0 0;font:12.7px/21.5px Mono,'Noto Color Emoji',monospace;color:#2A2A2A}}
.l{{display:flex}}
.n{{flex:none;width:46px;text-align:right;color:#C2C2C1;padding-right:12px;box-sizing:content-box}}
.t{{flex:1;min-width:0;white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;padding-left:2em;text-indent:-2em}}
.rule{{color:#ADADAD}} .key{{color:#6B2FD9}} .val{{color:#939393}}
.h{{color:#0A5EE8;font-weight:bold}} .tag{{color:#007A69}} .id{{color:#ADADAD}} .done{{color:#929292}}
</style><div class="top">{esc(name)}<span>{esc(folder)}</span></div><div class="code">{''.join(rows)}</div>"""


@scene("files")
async def files(t, stack):
    # the app, narrower, with its sidebar put away (⌘/)
    w_app, w_file = 840, DESK[0] - 840
    await t.send("Emulation.setDeviceMetricsOverride", {"width": w_app, "height": DESK[1], "deviceScaleFactor": 2, "mobile": False})
    await sign_in(t, stack, path="/project/pkitch001")
    await t.key("/", code="Slash", mods=MOD, vk=191)
    await t.wait_for("document.querySelector('.app')?.classList.contains('slim')", 5)
    await no_hover(t)
    app_img = await t.shot()
    # the file, as an editor beside it shows it
    rel = "Areas/Home/Kitchen renovation.md"
    text = (stack.work / "main/vault" / rel).read_text(encoding="utf-8")
    await t.send("Emulation.setDeviceMetricsOverride", {"width": w_file, "height": DESK[1], "deviceScaleFactor": 2, "mobile": False})
    doc = editor_html("Kitchen renovation.md", "Areas/Home", text)
    await t.goto("data:text/html;base64," + base64.b64encode(doc.encode()).decode(), ready="document.readyState === 'complete'")
    file_img = await t.shot()
    both = Image.new("RGB", (DESK[0] * 2, DESK[1] * 2))
    both.paste(file_img, (0, 0))
    both.paste(app_img, (w_file * 2, 0))
    return both


# ---- Settings ----

@scene("settings-general")
async def settings_general(t, stack):
    await sign_in(t, stack, path="/today")
    await settings(t, "general")
    await no_hover(t)
    return await t.shot()


@scene("settings-calendar")
async def settings_calendar(t, stack):
    await sign_in(t, stack, path="/today")
    await settings(t, "calendar")
    await t.wait_for("document.querySelectorAll('#pane-body input[type=checkbox]').length >= 3", 10)
    await no_hover(t)
    return await t.shot()


@scene("settings-keyboard")
async def settings_keyboard(t, stack):
    await sign_in(t, stack, path="/today")
    await settings(t, "keyboard")
    await no_hover(t)
    return await t.shot()


@scene("settings-sync")
async def settings_sync(t, stack):
    await sign_in(t, stack, path="/today")
    await settings(t, "sync")
    await t.wait_for("document.querySelectorAll('.devices li').length === 3", 10)
    await no_hover(t)
    return await t.shot()


@scene("settings-data")
async def settings_data(t, stack):
    await sign_in(t, stack, path="/today")
    await t.wait_for("!!window.__dvarimLocal", 10)
    await settings(t, "data")
    await t.wait_for("/Last synced/.test(document.querySelector('[data-mirror-status]')?.textContent || '')", 20)
    await no_hover(t)
    return await t.shot()



async def fill(t, sel, value):
    """Type into an input the way Svelte hears it."""
    await t.js(f"""
        const el = document.querySelector({json.dumps(sel)});
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, {json.dumps(value)});
        el.dispatchEvent(new Event('input', {{bubbles: true}}));
        return true;""")


@scene("settings-sync-device")
async def settings_sync_device(t, stack):
    # A browser keeping a vault of its own (local mode), on a page of another
    # origin, set to sync with the sync server through Settings → Sync.
    page = stack.url("page", "localhost")
    await t.goto(page + "/today?backend=local", ready="!!window.__dvarimLocal && !!document.querySelector('.nav')")
    await settings(t, "sync")
    await t.js("document.querySelector('input[name=\"sync-kind\"][value=\"dvarim\"]').click(); return true;")
    await t.wait_for("!!document.querySelector('#sync-address')", 5)
    await fill(t, "#sync-address", stack.url("sync", "127.0.0.1"))
    await fill(t, "#sync-token", (stack.work / "sync-token").read_text().strip())
    await t.js("[...document.querySelectorAll('.syncacts button')].find((b) => b.textContent.trim() === 'Save and sync').click(); return true;")
    ok = await t.wait_for("/Last synced/.test(document.querySelector('[data-sync-state]')?.textContent || '')", 30)
    if not ok:
        raise RuntimeError("the browser vault never synced: " + str(await t.js("return document.querySelector('[data-sync-state]')?.textContent")))
    await t.wait_for("document.querySelectorAll('.row[data-todo-id]').length >= 10", 10)
    await t.js("document.activeElement && document.activeElement.blur(); return true;")
    await no_hover(t)
    return await t.shot()



# ---- on a phone ----

async def phone_today(t, stack, path="/today"):
    await sign_in(t, stack, path=path)
    if path == "/today":
        await t.wait_for("document.querySelectorAll('.events .ev').length === 3", 15)
    await t.settle(1.0)


async def phone_open(t, title):
    """A to-do opened with a tap, as a phone opens it."""
    await t.wait_for("!!" + ROW % json.dumps(title))
    await t.js(f"{ROW % json.dumps(title)}.querySelector('.txt').click(); return true;")
    await t.wait_for("!!document.querySelector('.card[data-card]')", 5)
    await t.settle(1.0)
    await t.js("document.activeElement && document.activeElement.blur(); return true;")


@scene("today-phone-dark", frame="phone", kind="phone", dark=True)
async def today_phone_dark(t, stack):
    await phone_today(t, stack)
    return await t.shot()


@scene("lists-phone", frame="phone", kind="phone")
async def lists_phone(t, stack):
    await phone_today(t, stack)
    await t.js("document.querySelector('.topbar .back').click(); return true;")
    await t.wait_for("document.querySelector('.app')?.classList.contains('root')", 5)
    await t.settle(1.0)
    return await t.shot()


@scene("repeat-phone", frame="phone", kind="phone")
async def repeat_phone(t, stack):
    await phone_today(t, stack)
    await phone_open(t, "Weekly review")
    await t.js("document.querySelector('.card[data-card] [aria-label=\"Repeat\"]').click(); return true;")
    await t.wait_for("!!document.querySelector('.rpt')", 5)
    await t.settle(1.0)
    return await t.shot()


@scene("share-phone", frame="phone", kind="phone")
async def share_phone(t, stack):
    await sign_in(t, stack, path="/today")
    q = "title=" + "Call%20the%20bike%20shop%20tomorrow%20%23errand" + "&url=" + "https%3A%2F%2Fexample.com%2Fbikes"
    await t.goto(stack.url("main", "localhost") + "/share?" + q, ready="!!document.querySelector('#sh-title')")
    await t.js("const f = document.querySelector('#sh-title'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); return true;")
    await t.settle(1.0)
    return await shot_with_caret(t, "#sh-title")


async def shot_with_caret(t, sel):
    """A picture with the field's caret in it. Headless Chrome never paints the
    caret into a screenshot, so it is drawn where the page says it is, in the
    accent colour a phone gives it."""
    c = await t.js(f"""
        const f = document.querySelector({json.dumps(sel)}), cs = getComputedStyle(f);
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = cs.font;
        const b = f.getBoundingClientRect();
        return {{x: b.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) + ctx.measureText(f.value).width + 1,
                y: b.top + b.height / 2, size: parseFloat(cs.fontSize), dpr: devicePixelRatio,
                color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()}};""")
    img = await t.shot()
    d, h = c["dpr"], c["size"] * 1.23
    ImageDraw.Draw(img).rectangle((round(c["x"] * d), round((c["y"] - h / 2) * d),
                                   round((c["x"] + 1.6) * d) - 1, round((c["y"] + h / 2) * d)), fill=c["color"])
    return img


@scene("phones", frame="phones", kind="phone")
async def phones(t, stack):
    await phone_today(t, stack)
    today = await t.shot()
    await t.goto(stack.url("main", "localhost") + "/project/ptrip0001")
    await loaded(t)
    trip = await t.shot()
    await phone_open(t, "Pack the bags")
    card = await t.shot()
    return [today, trip, card]



@scene("people-phone", frame="phone", kind="phone", server="people")
async def people_phone(t, stack):
    # told of the request already, so no toast says so over Settings
    await sign_in(t, stack, which="people", path="/today",
                  prep="localStorage.setItem('dvarim.requests-seen', '1'); return true;")
    await settings(t, "account")
    await t.wait_for("!!document.querySelector('[aria-label=\"People\"]')", 10)
    # scrolled until People sits where it did in the old picture
    await t.js("""
        const body = document.querySelector('#pane-body');
        const h = [...body.querySelectorAll('h3')].find((x) => x.textContent.trim() === 'People');
        body.scrollTop += h.getBoundingClientRect().top - 356;
        return true;""")
    await t.settle(1.0)
    return await t.shot()


# --------------------------------------------------------------------------

async def take(browser, stack, name, out: Path):
    s = SCENES[name]
    t = await browser.tab(stack, s["kind"], s["dark"])
    try:
        raw = await s["fn"](t, stack)
    finally:
        errors = list(t.errors)
        await browser.done(t)
    if errors:
        log(f"    page errors: {errors[:3]}")
    if isinstance(raw, list):
        img = side_by_side([phone(r) for r in raw])
    elif s["frame"] == "phone":
        img = phone(raw)
    else:
        img = window(raw, s["frame"])
    path = out / f"{name}.png"
    img.save(path, optimize=True)
    return path


def shoot_day(arg):
    if arg:
        return arg
    today = dt.datetime.now(ZoneInfo(TZ)).date()
    return today - dt.timedelta(days=(today.weekday() + 1) % 7)      # the latest Sunday


SIZES = {"desk": (1486, 961), "hero": (1700, 1100), "phone": (594, 1156), "phones": (1862, 1156)}


async def run(args, stack, names):
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    failed = []
    async with Browser(args.devtools or f"http://{stack.chrome_ip}:9222") as b:
        for name in names:
            log(f"  {name}")
            try:
                path = await take(b, stack, name, out)
            except Exception as e:                      # the rest are still worth taking
                log(f"    FAILED: {e}")
                failed.append(name)
                continue
            size, want = Image.open(path).size, SIZES[SCENES[name]["frame"]]
            if size != want:
                log(f"    FAILED: {size[0]}×{size[1]}, not {want[0]}×{want[1]}")
                failed.append(name)
    return failed


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=str(REPO / "docs/images"), help="where the pictures go (default docs/images)")
    ap.add_argument("--only", help="comma-separated scene names (default: every one)")
    ap.add_argument("--today", type=dt.date.fromisoformat, help="the shoot day (default: the latest Sunday)")
    ap.add_argument("--work", help="the scratch folder (default: a new one under $TMPDIR)")
    ap.add_argument("--keep", action="store_true", help="leave the containers and the scratch folder")
    ap.add_argument("--attach", action="store_true", help="use the stack a --keep run left in --work")
    ap.add_argument("--build", action="store_true", help="run frontend/build.sh first")
    ap.add_argument("--devtools", help="Chrome's DevTools address (default: docker-chrome-1's, :9222)")
    ap.add_argument("--list", action="store_true", help="list the scenes and stop")
    args = ap.parse_args()
    if args.list:
        print("\n".join(SCENES))
        return 0
    names = args.only.split(",") if args.only else list(SCENES)
    unknown = [n for n in names if n not in SCENES]
    if unknown:
        raise SystemExit(f"no such scene: {', '.join(unknown)}")
    if args.build:
        sh(str(REPO / "frontend/build.sh"), capture=False)
    if not (REPO / "frontend/dist/index.html").exists():
        raise SystemExit("no frontend/dist: run frontend/build.sh (or pass --build)")
    if args.attach and not args.work:
        raise SystemExit("--attach needs the --work folder of the run that kept its stack")
    work = Path(args.work) if args.work else Path(tempfile.mkdtemp(prefix="dvarim-docs-shots-"))
    work.mkdir(parents=True, exist_ok=True)
    day = shoot_day(args.today)
    stack = Stack(work, day)
    log(f"shoot day {day.isoformat()} ({day.strftime('%A')}), scratch {work}")
    try:
        if not args.attach:
            stack.start()
            setup(stack)
        failed = asyncio.run(run(args, stack, names))
    finally:
        if args.keep:
            log(f"kept: {', '.join(stack.started) or 'the stack'} and {work}")
        else:
            gone = stack.stop()
            log(f"removed {', '.join(gone)}")
            shutil.rmtree(work, ignore_errors=True)
    log(f"pictures in {args.out}")
    if failed:
        log(f"not taken: {', '.join(failed)}")
        return 1
    return 0


class signed_in:
    """An httpx client with the owner's session on one of the servers."""

    def __init__(self, stack, which):
        self.c = httpx.Client(base_url=stack.url(which), timeout=15)
        self.password = stack.secrets[which]

    def __enter__(self):
        self.c.post("/api/login", json={"password": self.password}).raise_for_status()
        return self.c

    def __exit__(self, *a):
        self.c.close()


def setup(stack):
    """State some pictures need, made through the servers' own API."""
    # Settings → Sync on the main server: three devices
    with signed_in(stack, "main") as c:
        for name in ("MacBook", "Phone", "Signal bot"):
            c.post("/api/tokens", json={"name": name}).raise_for_status()
    # the server a browser vault syncs with: a token for that browser
    with signed_in(stack, "sync") as c:
        token = c.post("/api/tokens", json={"name": "Browser"}).json()["token"]
    (stack.work / "sync-token").write_text(token)

    # Other people on the people server (docs/PEOPLE.md): Alex and Sam, who
    # took an invitation each; Jordan Lee, who asked; and Robin's invitation,
    # not used yet. Their passwords are thrown away: nobody signs in as them.
    with signed_in(stack, "people") as owner:
        for name in ("Alex", "Sam"):
            code = owner.post("/api/people/invites", json={"note": name}).json()["code"]
            with httpx.Client(base_url=stack.url("people"), timeout=15) as them:
                them.post("/api/join", json={"code": code, "name": name,
                                             "password": secrets.token_urlsafe(16)}).raise_for_status()
        with httpx.Client(base_url=stack.url("people"), timeout=15) as asker:
            asker.post("/api/requests", json={"name": "Jordan Lee", "email": "jordan@example.com",
                                              "message": "From the book club. Could I try it for my reading list?"}
                       ).raise_for_status()
        owner.post("/api/people/invites", json={"note": "Robin"}).raise_for_status()


if __name__ == "__main__":
    sys.exit(main())
