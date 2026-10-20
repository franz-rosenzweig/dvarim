#!/usr/bin/env python3
"""Adding checklist items after the first, in a real browser.

The checklist button used to vanish once a to-do had one item, leaving Return
inside an item as the only way to add another — which nothing on screen said,
and which a phone keyboard barely offers. This checks the button stays, adds at
the end, does not stack up blank rows, and that the items reach the file.

    tools/e2e_checklist.py --url http://172.19.0.1:8422 --devtools http://172.19.0.10:9222
"""
import argparse, asyncio, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

TYPE = """
  const el = document.activeElement;
  if (!el || el.tagName !== 'INPUT') return 'no input focused: ' + (el && el.tagName);
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, %r);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
"""
ITEMS = "return [...document.querySelectorAll('.card .cli input')].map(i => i.value);"
BUTTON = "document.querySelector('.card [aria-label=\"Add checklist item\"], .card [aria-label=\"Add checklist\"]')"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--devtools", default="http://172.19.0.16:9222")
    args = ap.parse_args()
    refuse_live_data(None, args.url)

    async with Browser(args.devtools) as b:
        tid = None
        await b.goto(args.url + "/inbox")
        await b.wait_for("document.querySelector('.toolbar') !== null", timeout=25)
        tid = await b.js("""
            const r = await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({title: 'Checklist probe', inbox: true})});
            return (await r.json()).id;
        """)
        await b.goto(args.url + "/inbox")
        await b.wait_for(f"!!document.querySelector('[data-todo-id=\"{tid}\"]')", timeout=15)

        async def open_card():
            await b.js(f"""
                const r = document.querySelector('[data-todo-id="{tid}"]');
                r.click(); r.click(); return true;""")
            await b.wait_for("!!document.querySelector('.card')", timeout=6)
            await asyncio.sleep(0.4)

        async def close_card():
            await b.js("document.activeElement && document.activeElement.blur(); return true;")
            await asyncio.sleep(0.6)
            await b.js("document.querySelector('.content').click(); return true;")
            await asyncio.sleep(1.2)

        print("\nA first item")
        await open_card()
        check("an empty to-do offers a checklist", bool(await b.js(f"return !!{BUTTON};")))
        await b.js(f"{BUTTON}.click(); return true;")
        await asyncio.sleep(0.4)
        await b.js(TYPE % "One")
        check("the phone keyboard gets a Next key", (await b.js(
            "return document.querySelector('.card .cli input')?.getAttribute('enterkeyhint');")) == "next")

        print("\nMore, with the button")
        label = await b.js("return document.querySelector('.card .icons [aria-label^=\"Add checklist\"]')?.getAttribute('aria-label');")
        check("the button is still there with one item", label == "Add checklist item", str(label))
        await b.js(f"{BUTTON}.click(); return true;")
        await asyncio.sleep(0.4)
        await b.js(TYPE % "Two")
        await b.js(f"{BUTTON}.click(); return true;")
        await asyncio.sleep(0.4)
        await b.js(f"{BUTTON}.click(); return true;")      # twice, typing nothing
        await asyncio.sleep(0.4)
        items = await b.js(ITEMS)
        check("it adds at the end", items[:2] == ["One", "Two"], str(items))
        check("a second press on a blank row does not stack blanks", items.count("") == 1, str(items))
        await b.js(TYPE % "Three")

        print("\nMore, with Return")
        await b.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "Enter", "code": "Enter",
                                                "windowsVirtualKeyCode": 13})
        await b.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter",
                                                "windowsVirtualKeyCode": 13})
        await asyncio.sleep(0.4)
        await b.js(TYPE % "Four")
        check("Return still adds the next one", (await b.js(ITEMS)) == ["One", "Two", "Three", "Four"],
              str(await b.js(ITEMS)))
        await close_card()

        server = await b.js(f"""
            const r = await (await fetch('/api/lists/inbox')).json();
            const t = (r.items || []).find(x => x.id === '{tid}');
            return t ? (t.checklist || []).map(c => c.text) : null;""")
        check("all four reach the file", server == ["One", "Two", "Three", "Four"], str(server))

        print("\nReopened")
        await open_card()
        check("a reopened card still offers to add", (await b.js(
            "return document.querySelector('.card .icons [aria-label=\"Add checklist item\"]') !== null;")))
        await b.js(f"{BUTTON}.click(); return true;")
        await asyncio.sleep(0.4)
        await b.js(TYPE % "Five")
        await close_card()
        server = await b.js(f"""
            const r = await (await fetch('/api/lists/inbox')).json();
            const t = (r.items || []).find(x => x.id === '{tid}');
            return t ? (t.checklist || []).map(c => c.text) : null;""")
        check("and the fifth lands after the fourth", server == ["One", "Two", "Three", "Four", "Five"], str(server))

        await b.js(f"await fetch('/api/todos/{tid}', {{method:'DELETE'}}); return true;")

    print("\n" + ("checklists grow" if not FAILURES else f"{len(FAILURES)} failed: " + "; ".join(FAILURES)))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
