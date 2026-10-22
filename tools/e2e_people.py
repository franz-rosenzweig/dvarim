#!/usr/bin/env python3
"""Other people on the owner's server (docs/PEOPLE.md), in a real browser, on
one shared browser as a family iPad would be: the owner signs in and invites
Dana from Settings, Dana opens the link and joins, sees her own to-dos and
none of the owner's (not even in what the browser keeps for offline), signs
out and in by name, and downloads her files; then the owner signs back in.

    tools/e2e_people.py --url http://172.19.0.1:8437 --password '…' --shots /tmp/shots

--url is a throwaway server with a password set and DVARIM_AUTH_FILE outside
its data folder (never the vault: this makes people and to-dos).
"""
import argparse, asyncio, base64, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

SECRET = "Only the owner's own (e2e)"
DANA_PW = "dana's own password"


async def fill(b, sel, value):
    await b.js("""const el = document.querySelector(%s);
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, %s); el.dispatchEvent(new Event('input', {bubbles: true})); return true;""" % (json.dumps(sel), json.dumps(value)))


async def press(b, text, within="document"):
    await b.js("[...%s.querySelectorAll('button')].find(x => x.textContent.trim() === %s).click(); return true;" % (within, json.dumps(text)))


async def shot(b, args, name):
    if args.shots:
        data = await b.send("Page.captureScreenshot", {"format": "png"})
        Path(args.shots, name).write_bytes(base64.b64decode(data["data"]))


async def sign_in(b, name, password):
    await b.wait_for("!!document.querySelector('#pw')", timeout=15)
    await fill(b, "#who", name)
    await fill(b, "#pw", password)
    await b.js("document.querySelector('#pw').form.requestSubmit(); return true;")
    return await b.wait_for("!!document.querySelector('.nav')", timeout=20)


async def settings_account(b):
    await b.js("document.querySelector('.sidefoot [aria-label=\"Settings\"]').click(); return true;")
    await b.wait_for("!!document.querySelector('#pane-tab-account')", timeout=8)
    await b.js("document.querySelector('#pane-tab-account').click(); return true;")


async def sign_out(b):
    await settings_account(b)
    await b.wait_for("[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Sign out')", timeout=8)
    await press(b, "Sign out")
    await b.wait_for("!!document.querySelector('#pw')", timeout=10)


ASK_NOTE = """const el = document.querySelector('#ask-note');
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(el, 'Dana told me about it'); el.dispatchEvent(new Event('input', {bubbles: true})); return true;"""
REQUEST_SHOWN = ("document.querySelector('[aria-label=\"Asking for an account\"]')?.innerText.includes('eli@example.com')"
                 " && document.body.innerText.includes('Dana told me about it')")
REQUESTS_GONE = "!document.querySelector('[aria-label=\"Asking for an account\"]')"

# Everything this browser keeps in IndexedDB, every database and store: the
# copy of the server's vault (the mirror, lib/backend.js) and the lists kept
# for offline in server-only mode (lib/offline.js) alike.
KEPT = """const dbs = (await indexedDB.databases?.()) || [{ name: 'dvarim' }];
let all = '';
for (const { name } of dbs) {
  all += await new Promise((ok) => {
    const r = indexedDB.open(name);
    r.onerror = () => ok('');
    r.onsuccess = () => {
      const db = r.result, stores = [...db.objectStoreNames];
      if (!stores.length) { db.close(); return ok(''); }
      const tx = db.transaction(stores);
      Promise.all(stores.map((n) => new Promise((done) => { const q = tx.objectStore(n).getAll(); q.onsuccess = () => done(JSON.stringify(q.result)); q.onerror = () => done(''); })))
        .then((parts) => { db.close(); ok(parts.join('')); });
    };
  });
}
return all;"""


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--password", required=True, help="the throwaway server's owner password")
    ap.add_argument("--devtools", default="http://172.19.0.17:9222")
    ap.add_argument("--shots", help="a folder for screenshots")
    args = ap.parse_args()
    refuse_live_data(None, args.url)
    desktop = {"width": 1200, "height": 900, "deviceScaleFactor": 1, "mobile": False}
    phone = {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True}

    async with Browser(args.devtools) as b:
        await b.send("Emulation.setDeviceMetricsOverride", desktop)
        await b.goto(args.url + "/today")
        await b.js("localStorage.clear(); await new Promise((ok) => { const r = indexedDB.deleteDatabase('dvarim'); r.onsuccess = r.onerror = r.onblocked = ok; }); return true;")
        await b.goto(args.url + "/today")

        print("\nSomeone without an account asks for one, from the sign-in screen")
        check("the sign-in screen asks for a name and a password", await b.wait_for("!!document.querySelector('#who') && !!document.querySelector('#pw')", timeout=15))
        check("and offers to ask for an account", await b.wait_for("[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'No account? Ask for one')", timeout=8))
        await press(b, "No account? Ask for one")
        await b.wait_for("!!document.querySelector('#ask-email')", timeout=5)
        await fill(b, "#ask-name", "Eli Cohen")
        await fill(b, "#ask-email", "eli@example.com")
        await b.js(ASK_NOTE)
        await shot(b, args, "ask.png")
        await b.js("document.querySelector('#ask-email').form.requestSubmit(); return true;")
        check("thanked, and told they'll hear back", await b.wait_for("document.body.innerText.includes('hear back by email')", timeout=8))
        await press(b, "Back to sign in")

        print("\nThe owner signs in, with no name, and has a to-do of their own")
        check("signed in", bool(await sign_in(b, "", args.password)))
        check("and is told someone asked for an account", await b.wait_for("document.body.innerText.includes('Someone asked for an account')", timeout=8))
        await b.js("await fetch('/api/todos', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({title: %s, inbox: true})}); return true;" % json.dumps(SECRET))
        await b.goto(args.url + "/inbox")
        check("it is in the Inbox", await b.wait_for("document.body.innerText.includes(%s)" % json.dumps(SECRET), timeout=15))
        check("and in what this browser keeps for offline", SECRET in await b.js(KEPT))

        print("\nAn invitation from Settings → Account")
        await settings_account(b)
        await b.wait_for("!!document.querySelector('#invite-note')", timeout=10)
        await fill(b, "#owner-name", "Robin")
        await press(b, "Save")
        await asyncio.sleep(0.8)
        check("Eli's request is there, with what he wrote", await b.wait_for(REQUEST_SHOWN, timeout=8))
        await press(b, "Invite")
        await b.wait_for("!!document.querySelector('[data-invite-shown] a.mail')", timeout=8)
        href = await b.js("return document.querySelector('[data-invite-shown] a.mail').getAttribute('href');")
        check("an email to send it in, to him, with the link in it",
              href.startswith("mailto:eli@example.com?") and "%2Fjoin%2F" in href and "Hi%20Eli" in href, href[:120])
        check("and the request is answered", await b.wait_for(REQUESTS_GONE, timeout=8))
        await fill(b, "#invite-note", "Dana")
        await press(b, "Make an invitation link")
        # Eli's is still showing until Dana's replaces it: hers has no email to send it in
        await b.wait_for("!!document.querySelector('[data-invite-shown] code') && !document.querySelector('[data-invite-shown] a.mail')", timeout=10)
        link = (await b.js("return document.querySelector('[data-invite-shown] code').textContent.trim();"))
        check("a link to send", "/join/" in link, link)
        await shot(b, args, "people-settings.png")
        # a shared browser: the owner signs out before handing it over, which
        # takes the copy of their to-dos off it
        await b.js("document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"] .x')?.click(); return true;")
        await sign_out(b)
        check("signing out takes the owner's to-dos off the browser", SECRET not in await b.js(KEPT))

        print("\nDana opens it on the same browser, on her phone's width")
        await b.send("Emulation.setDeviceMetricsOverride", phone)
        await b.goto(args.url + link[link.index("/join/"):])
        check("the join form, with her name filled in", await b.wait_for("document.querySelector('#join-name')?.value === 'Dana'", timeout=15))
        await shot(b, args, "join.png")
        await fill(b, "#join-pw", DANA_PW)
        await fill(b, "#join-again", DANA_PW)
        await b.js("document.querySelector('#join-pw').form.requestSubmit(); return true;")
        check("joined, the app opens", bool(await b.wait_for("!!document.querySelector('.nav') && !document.querySelector('#join-name')", timeout=20)))
        auth = await b.js("return await (await fetch('/api/auth')).json();")
        check("as Dana", {k: (auth.get("person") or {}).get(k) for k in ("name", "owner")} == {"name": "Dana", "owner": False}, str(auth))
        state = await b.js("return await (await fetch('/api/state')).json();")
        check("with the tutorial", [p["name"] for p in state["looseProjects"]] == ["Meet Dvarim"])
        inbox = await b.js("return (await (await fetch('/api/lists/inbox')).json()).items.map(t => t.title);")
        check("and none of the owner's to-dos", SECRET not in inbox, str(inbox))
        await b.goto(args.url + "/inbox")
        await b.wait_for("!!document.querySelector('.nav')", timeout=15)
        await asyncio.sleep(1.5)
        check("not on screen, and not in what the browser keeps", SECRET not in await b.js("return document.body.innerText;") and SECRET not in await b.js(KEPT))
        await shot(b, args, "dana-today.png")

        print("\nDana signs out and in again by name, and downloads her files")
        await b.send("Emulation.setDeviceMetricsOverride", desktop)
        await b.goto(args.url + "/today")
        await b.wait_for("!!document.querySelector('.nav')", timeout=15)
        await sign_out(b)
        check("her name is filled in, the password has the focus",
              await b.js("return document.querySelector('#who').value.toLowerCase() === 'dana' && document.activeElement === document.querySelector('#pw');"))
        await sign_in(b, "dana", DANA_PW)
        check("signed in as Dana again", (await b.js("return await (await fetch('/api/auth')).json();")).get("person", {}).get("name") == "Dana")
        exp = await b.js("const r = await fetch('/api/export'); return [r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength];")
        check("Download my files is a zip", exp[0] == 200 and exp[1] == "application/zip" and exp[2] > 1000, str(exp))
        check("and Settings → Data offers it", await b.js("""
          document.querySelector('.sidefoot [aria-label="Settings"]').click();
          await new Promise((r) => setTimeout(r, 400));
          document.querySelector('#pane-tab-data').click();
          await new Promise((r) => setTimeout(r, 400));
          return !!document.querySelector('a[href="/api/export"]');"""))

        print("\nThe tutorial, again, from Settings → General")
        await b.js("""if (!document.querySelector('#pane-tab-general')) document.querySelector('.sidefoot [aria-label="Settings"]').click();
          await new Promise((r) => setTimeout(r, 400));
          document.querySelector('#pane-tab-general').click(); return true;""")
        await b.wait_for("[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Show the tutorial again')", timeout=8)
        await press(b, "Show the tutorial again")
        check("it opens on Meet Dvarim", await b.wait_for("document.querySelector('h1.t')?.innerText.includes('Meet Dvarim')", timeout=10))
        check("Dana's is the same one, not a second", (await b.js("return (await (await fetch('/api/state')).json()).looseProjects.map(p => p.name);")) == ["Meet Dvarim"])

        print("\nThe owner, back on the same browser")
        await sign_out(b)
        check("signs in by the name they gave", bool(await sign_in(b, "Robin", args.password)))
        await b.goto(args.url + "/inbox")
        check("and their own to-do is there again", await b.wait_for("document.body.innerText.includes(%s)" % json.dumps(SECRET), timeout=15))
        people = await b.js("return await (await fetch('/api/people')).json();")
        check("Dana is among the people", [p["display"] for p in people["people"]] == ["Dana"], str(people))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: " + "; ".join(FAILURES))
        return 1
    print("other people work")
    return 0


raise SystemExit(asyncio.run(main()))
