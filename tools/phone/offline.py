"""What the offline checks share.

Each starts from a fresh copy of sample-vault and a debug build that has kept
nothing, so they run in any order. The plane is `devserver.sh --stop` and
landing is starting it again on the same copy, so what the phone kept arrives
on the data it was made against — then the server is asked directly whether it
did.
"""
import asyncio, json, os, subprocess, time, urllib.request

from touch import PKG, adb, app_user

HERE = os.path.dirname(os.path.abspath(__file__))
DEVSERVER = os.path.join(HERE, "devserver.sh")
API = "http://127.0.0.1:8421/api"


# ---- the server, asked directly

def get(path):
    return json.load(urllib.request.urlopen(API + path, timeout=6))


def send(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method, headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=6))


def fresh():
    """A new copy of sample-vault, and a debug build that has kept nothing."""
    subprocess.run([DEVSERVER, "--fresh"], check=True)
    adb("shell", "pm", "clear", "--user", app_user(), PKG, check=False)


def plane():
    subprocess.run([DEVSERVER, "--stop"], check=True)
    time.sleep(1.0)


def land():
    subprocess.run([DEVSERVER], check=True)


# ---- the page

async def text(p, sel):
    return await p.js(f"(document.querySelector({json.dumps(sel)}) || {{}}).innerText || null")


# What the page keeps of its own accord (keepLists in lib/store.svelte.js):
# the standard lists, fetched in the background after the first load, and the
# state and settings every load reads.
STANDARD = ["/lists/inbox", "/lists/today", "/lists/upcoming", "/lists/anytime", "/lists/someday", "/state", "/settings"]


async def lists_kept(p, secs=10):
    """The API paths the page has kept (lib/offline.js), once every standard one
    is among them. Waiting for a count of them instead let a slow phone answer
    before the last of the background fetches had landed."""
    keys = []
    for _ in range(int(secs / 0.5)):
        keys = await p.js("""(async () => {
            const db = await new Promise((r) => { const q = indexedDB.open('dvarim'); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
            if (!db) return [];
            return await new Promise((r) => { const q = db.transaction('reads').objectStore('reads').getAllKeys();
                                              q.onsuccess = () => r(q.result); q.onerror = () => r([]); }); })()""") or []
        if all(k in keys for k in STANDARD):
            break
        await asyncio.sleep(0.5)
    return keys


async def keep(p, op):
    """Put an operation in the outbox directly, as api.js would have recorded it."""
    await p.js(f"""(async () => {{
        const db = await new Promise((r) => {{ const q = indexedDB.open('dvarim'); q.onsuccess = () => r(q.result); }});
        await new Promise((r) => {{ const t = db.transaction('outbox', 'readwrite');
                                    t.objectStore('outbox').add({{ ...{json.dumps(op)}, at: Date.now() }}); t.oncomplete = r; }}); }})()""")


async def waiting(p):
    """How many changes the offline strip says are kept on this device."""
    strip = await text(p, ".offline") or ""
    words = strip.split(" change")[0].split()
    return int(words[-1]) if " change" in strip and words and words[-1].isdigit() else 0


async def synced(p, secs=45):
    """The toast that says what landed once the server is back, or None."""
    for _ in range(int(secs / 0.5)):
        t = await text(p, ".toast")
        if t and ("saved" in t or "Not saved" in t):
            return t
        await asyncio.sleep(0.5)
    return None


async def close_card(p):
    """The way the app closes a card on a phone: one step back in its own history
    (lib/backstack.svelte.js). A hardware BACK can reach DevActivity instead and,
    with nothing behind the page, close the whole activity."""
    await p.js("(() => { const t = document.querySelector('.card .ttl'); if (t) t.blur(); if (document.querySelector('.card')) history.back(); })()")
    await asyncio.sleep(1.2)
