#!/usr/bin/env python3
"""The Settings sheet: its tab strip, its icons, and the Keyboard pane.

Every check here is for something that was actually wrong. The tab strip was a
shrinkable flex item, so a tall pane squeezed it and clipped the labels off the
bottom of their own buttons. Three icons shipped with no width or height, so
outside a menu (where CSS happened to size them) the browser fell back to the
300x150 default for a replaced element and the tab looked empty. The sheet was
centred, so it jumped up the screen every time you changed pane. And recording
a shortcut listened on the bubble, which runs after the app's own handler, so
rebinding Go to Today to a combo the app already knew just ran the old one.
"""
import argparse, asyncio, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

PANES = ["general", "calendar", "keyboard", "quickadd", "account", "sync", "data"]


async def press(b, key, code, vk, meta=False):
    for typ in ("rawKeyDown", "keyUp"):
        await b.send("Input.dispatchKeyEvent", {
            "type": typ, "key": key, "code": code, "windowsVirtualKeyCode": vk,
            "modifiers": 4 if meta else 0,
        })


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--devtools", default="http://172.19.0.16:9222")
    ap.add_argument("--shot", help="write a PNG of the Keyboard pane here")
    args = ap.parse_args()
    refuse_live_data(None, args.url)

    async with Browser(args.devtools) as b:
        # Claim to be a Mac, because that is the machine this is for and it is
        # the branch that prints ⌘ rather than Ctrl+.
        await b.send("Emulation.setUserAgentOverride", {
            "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "platform": "MacIntel",
        })
        await b.send("Emulation.setDeviceMetricsOverride",
                     {"width": 1400, "height": 1000, "deviceScaleFactor": 1, "mobile": False})

        await b.goto(args.url + "/today")
        await b.wait_for("document.querySelector('.nav') !== null", timeout=25)
        await b.js("document.querySelector('.sidefoot [aria-label=\"Settings\"]').click(); return true;")
        await b.wait_for("document.querySelector('[aria-label=\"Settings\"][role=\"dialog\"]') !== null")

        print("\nThe tab strip")
        tabs = await b.js("""
            return [...document.querySelectorAll('.panes [role=tab]')].map(t => {
              const svg = t.querySelector('svg');
              const lb = t.querySelector('.lb');
              const tb = t.getBoundingClientRect(), r = lb.getBoundingClientRect();
              const s = svg && svg.getBoundingClientRect();
              return { label: lb.textContent.trim(),
                       icon: s ? [Math.round(s.width), Math.round(s.height)] : null,
                       labelInside: r.bottom <= tb.bottom + 0.5 && r.top >= tb.top - 0.5 && r.width > 4,
                       iconInside: !!s && s.bottom <= tb.bottom + 0.5 };
            });
        """)
        check("all seven panes are there", [t["label"] for t in tabs] == ["General", "Calendar", "Keyboard", "Quick Add", "Account", "Sync", "Data"],
              str([t["label"] for t in tabs]))
        for t in tabs:
            check(f"{t['label']}: has a drawn icon", t["icon"] == [16, 16], str(t["icon"]))
            check(f"{t['label']}: its label is not clipped", t["labelInside"])
            check(f"{t['label']}: its icon is not clipped", t["iconInside"])

        print("\nThe sheet does not move when you change pane")
        tops, heights = [], []
        for i in range(len(PANES)):
            await b.js(f"document.querySelectorAll('.panes [role=tab]')[{i}].click(); return true;")
            await asyncio.sleep(0.6)
            r = await b.js("""
                const s = document.querySelector('[aria-label="Settings"][role=dialog]').getBoundingClientRect();
                const nav = document.querySelector('.panes').getBoundingClientRect();
                return [Math.round(s.top), Math.round(nav.height)];
            """)
            tops.append(r[0]); heights.append(r[1])
        check("the top edge is the same on every pane", len(set(tops)) == 1, str(tops))
        check("the tab strip keeps its height", len(set(heights)) == 1, str(heights))

        print("\nThe Keyboard pane")
        await b.js("document.querySelectorAll('.panes [role=tab]')[2].click(); return true;")
        await b.wait_for("document.querySelectorAll('#pane-body .combo').length > 10")
        geom = await b.js("""
            const body = document.querySelector('#pane-body');
            const br = body.getBoundingClientRect();
            const combos = [...body.querySelectorAll('.combo')];
            const rights = new Set(combos.map(c => Math.round(c.getBoundingClientRect().right)));
            const over = combos.filter(c => c.getBoundingClientRect().right > br.right - 8).length;
            const gutter = Math.round(br.right - Math.max(...combos.map(c => c.getBoundingClientRect().right)));
            return { n: combos.length, columns: rights.size, over, gutter,
                     labels: combos.slice(0, 3).map(c => c.textContent.trim()) };
        """)
        check("every shortcut is listed", geom["n"] >= 25, str(geom["n"]))
        check("the keys line up in one column", geom["columns"] == 1, f"{geom['columns']} different right edges")
        check("nothing runs past the panel edge", geom["over"] == 0, f"{geom['over']} overflow")
        check("and the column is not stranded in the middle", geom["gutter"] < 40, f"{geom['gutter']}px gutter")
        print("  first three keys:", geom["labels"])

        order = await b.js("""
            const rows = [...document.querySelectorAll('#pane-body .row')];
            const f = n => { const r = rows.find(r => r.querySelector('.lbl').textContent.trim() === n);
                             return r && r.querySelector('.combo').textContent.trim(); };
            return { heading: f('New heading (in a project or Today)'), project: f('New project'),
                     cancel: f('Cancel selected') };
        """)
        check("modifiers print in Apple's order: ⇧⌘N", order.get("heading") == "⇧⌘N", str(order))
        check("…and ⌥⌘N", order.get("project") == "⌥⌘N", str(order))
        check("…and ⌥⌘K", order.get("cancel") == "⌥⌘K", str(order))

        print("\nRecording a new shortcut")
        await b.js("""
            const rows = [...document.querySelectorAll('#pane-body .row')];
            rows.find(r => r.querySelector('.lbl').textContent.trim() === 'Go to Today')
                .querySelector('.combo').click();
            return true;
        """)
        await asyncio.sleep(0.3)
        check("the row says it is listening", "Press a key" in (await b.js("""
            const rows = [...document.querySelectorAll('#pane-body .row')];
            return rows.find(r => r.querySelector('.lbl').textContent.trim() === 'Go to Today')
                       .querySelector('.combo').textContent;
        """)))

        # ⌘9 is not bound to anything, so it should simply be taken.
        await press(b, "9", "Digit9", 57, meta=True)
        await asyncio.sleep(1.2)
        state = await b.js("""
            const rows = [...document.querySelectorAll('#pane-body .row')];
            const lbl = n => rows.find(r => r.querySelector('.lbl').textContent.trim() === n)
                                 .querySelector('.combo').textContent.trim();
            return { today: lbl('Go to Today'),
                     open: !!document.querySelector('[aria-label="Settings"][role=dialog]'),
                     url: location.pathname };
        """)
        check("a free combo is taken straight away", state["today"] == "⌘9", str(state))
        check("the app did not act on it behind the sheet", state["url"].endswith("/today"), state["url"])
        check("Settings stayed open", state["open"])

        print("\nA combo that is already spoken for")
        # ⌘4 is Go to Anytime. It must offer, not silently steal — and pressing it
        # must not navigate, which is what a bubble-phase listener used to do.
        await b.js("""
            const rows = [...document.querySelectorAll('#pane-body .row')];
            rows.find(r => r.querySelector('.lbl').textContent.trim() === 'Go to Today')
                .querySelector('.combo').click();
            return true;
        """)
        await asyncio.sleep(0.3)
        await press(b, "4", "Digit4", 52, meta=True)
        await asyncio.sleep(1.0)
        clash = await b.js("const c = document.querySelector('#pane-body .clash'); return c ? c.textContent.replace(/\\s+/g,' ').trim() : '';")
        check("it says who has it", "Anytime" in clash, clash or "(no offer shown)")
        check("and did not navigate", (await b.js("return location.pathname;")).endswith("/today"))
        await b.js("""
            [...document.querySelectorAll('#pane-body .clash .mini')]
              .find(x => /instead/i.test(x.textContent)).click();
            return true;
        """)
        await asyncio.sleep(1.2)
        moved = await b.js("""
            const rows = [...document.querySelectorAll('#pane-body .row')];
            const lbl = n => rows.find(r => r.querySelector('.lbl').textContent.trim() === n)
                                 .querySelector('.combo').textContent.trim();
            return [lbl('Go to Today'), lbl('Go to Anytime')];
        """)
        check("taking it anyway moves it", moved == ["⌘4", "None"], str(moved))

        print("\nEscape stops recording without closing Settings")
        await b.js("""
            const rows = [...document.querySelectorAll('#pane-body .row')];
            rows.find(r => r.querySelector('.lbl').textContent.trim() === 'Duplicate')
                .querySelector('.combo').click();
            return true;
        """)
        await asyncio.sleep(0.3)
        await press(b, "Escape", "Escape", 27)
        await asyncio.sleep(0.6)
        after = await b.js("""
            const rows = [...document.querySelectorAll('#pane-body .row')];
            const r = rows.find(x => x.querySelector('.lbl').textContent.trim() === 'Duplicate');
            return { open: !!document.querySelector('[aria-label="Settings"][role=dialog]'),
                     combo: r ? r.querySelector('.combo').textContent.trim() : null };
        """)
        check("Settings is still open", after["open"])
        check("and the shortcut is untouched", after["combo"] == "⌘D", str(after))

        if args.shot:
            data = (await b.send("Page.captureScreenshot", {"format": "png"}))["data"]
            import base64
            Path(args.shot).write_bytes(base64.b64decode(data))
            print("  screenshot:", args.shot)

        # put the keymap back the way it shipped
        await b.js("await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},"
                   "body:JSON.stringify({keymap:{}})}); return true;")

    print("\n" + ("settings sheet is sound" if not FAILURES else f"{len(FAILURES)} failed"))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
