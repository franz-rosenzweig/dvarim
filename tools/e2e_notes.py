#!/usr/bin/env python3
"""Markdown in notes, in a real browser: rendered while being read, the real
text wherever the caret is, and saved to the file exactly as typed.

    tools/e2e_notes.py --url http://172.19.0.1:8422 --root /tmp/dv-next --devtools http://172.19.0.10:9222

Uses a copy of the data (it writes notes and toggles boxes); never the vault.
"""
import argparse, asyncio, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

NOTES = ("Call **Dana** about the *draft* and ==the deadline==\n"
         "## Plan\n"
         "- first\n"
         "- [ ] a box in the notes\n"
         "- [x] a ticked one\n"
         "> quoted\n\n"
         "See [the brief](https://example.com/brief) or https://example.org\n"
         "\n---\n"      # no blank line above, and "---" makes the line above it a heading
         "שלום לכולם")

CM = ".card .notesfield .cm-content"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--root", required=True, help="the copy of the data the server is using")
    ap.add_argument("--devtools", default="http://172.19.0.16:9222")
    args = ap.parse_args()
    refuse_live_data(args.root, args.url)
    root = Path(args.root)

    async with Browser(args.devtools) as b:
        await b.goto(args.url + "/inbox")
        await b.wait_for("document.querySelector('.toolbar') !== null", timeout=25)
        tid = await b.js("""
            const r = await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({title: 'Notes probe', inbox: true, notes: %r})});
            return (await r.json()).id;""" % NOTES)
        # record link opens instead of performing them
        await b.send("Page.addScriptToEvaluateOnNewDocument", {"source":
            "window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; };"})
        await b.goto(args.url + "/inbox")
        await b.wait_for(f"!!document.querySelector('[data-todo-id=\"{tid}\"]')", timeout=15)

        async def open_card():
            await b.js(f"const r=document.querySelector('[data-todo-id=\"{tid}\"]'); r.click(); r.click(); return true;")
            return await b.wait_for(f"!!document.querySelector('{CM}')", timeout=8)

        print("\nRead, not being typed in")
        check("the card's notes are the Markdown editor", bool(await open_card()))
        await asyncio.sleep(0.6)
        seen = await b.js(f"""
            const c = document.querySelector('{CM}');
            const txt = c.innerText;
            const q = (s) => [...c.querySelectorAll(s)];
            return {{
              stars: txt.includes('**'),
              bold: q('span').some(s => s.textContent === 'Dana' && getComputedStyle(s).fontWeight >= 600),
              italic: q('span').some(s => s.textContent === 'draft' && getComputedStyle(s).fontStyle === 'italic'),
              mark: q('.md-mark').map(s => s.textContent).join(''),
              heading: q('.md-h2').map(s => s.textContent).join(''),
              hashes: /^##/m.test(txt),
              bullets: q('.md-bullet').length,
              boxes: q('.md-box').length, ticked: q('.md-box.on').length,
              done: q('.md-done').map(s => s.textContent).join(''),
              quote: q('.cm-line.md-quote').length,
              linktext: q('.md-link').map(s => s.textContent),
              url: txt.includes('(https://example.com/brief)'),
              rule: q('.md-rule').length,
              rtl: q('.cm-line').filter(l => getComputedStyle(l).direction === 'rtl').map(l => l.textContent),
            }};""")
        check("no asterisks on show", not seen["stars"], str(seen))
        check("bold is bold", seen["bold"])
        check("italic is italic", seen["italic"])
        check("==highlight== is marked", seen["mark"] == "the deadline", seen["mark"])
        check("## is a heading, hashes hidden", seen["heading"] == "Plan" and not seen["hashes"], str(seen["heading"]))
        check("a bullet is a bullet", seen["bullets"] == 1, str(seen["bullets"]))
        check("task lines are boxes", seen["boxes"] == 2 and seen["ticked"] == 1, str(seen))
        check("a ticked task is struck through", "a ticked one" in seen["done"], seen["done"])
        check("a quote is a quote", seen["quote"] == 1)
        check("a link shows its text, not its address", "the brief" in seen["linktext"] and not seen["url"],
              str(seen["linktext"]))
        check("a bare address is a link too", "https://example.org" in seen["linktext"], str(seen["linktext"]))
        check("--- is a rule", seen["rule"] == 1)
        check("a Hebrew line runs right to left", seen["rtl"] == ["שלום לכולם"], str(seen["rtl"]))

        print("\nLinks and boxes, while reading")
        await b.js(f"""
            const a = [...document.querySelectorAll('{CM} .md-link')].find(s => s.textContent === 'the brief');
            const r = a.getBoundingClientRect();
            a.dispatchEvent(new MouseEvent('mousedown', {{bubbles:true, cancelable:true, clientX:r.left+4, clientY:r.top+r.height/2}}));
            return true;""")
        await asyncio.sleep(0.4)
        opened = await b.js("return window.__opened;")
        check("tapping a link opens it", opened == ["https://example.com/brief"], str(opened))
        await b.js(f"""
            const box = document.querySelector('{CM} .md-box:not(.on)');
            const r = box.getBoundingClientRect();
            box.dispatchEvent(new MouseEvent('mousedown', {{bubbles:true, cancelable:true, clientX:r.left+3, clientY:r.top+3}}));
            return true;""")
        await asyncio.sleep(1.4)
        on = await b.js(f"return document.querySelectorAll('{CM} .md-box.on').length;")
        check("tapping a box ticks it", on == 2, str(on))
        saved = await b.js(f"""const r = await (await fetch('/api/lists/inbox')).json();
            return (r.items.find(x => x.id === '{tid}') || {{}}).notes;""")
        check("and the tick is saved", saved and "- [x] a box in the notes" in saved, repr(saved)[:120])

        print("\nWriting")
        # caret into the first line: its markers come back
        await b.js(f"""
            const line = document.querySelector('{CM} .cm-line');
            const r = line.getBoundingClientRect();
            line.dispatchEvent(new MouseEvent('mousedown', {{bubbles:true, cancelable:true, clientX:r.left+2, clientY:r.top+r.height/2}}));
            line.dispatchEvent(new MouseEvent('mouseup', {{bubbles:true, cancelable:true, clientX:r.left+2, clientY:r.top+r.height/2}}));
            return true;""")
        await asyncio.sleep(0.4)
        await b.js(f"document.querySelector('{CM}').focus(); return true;")
        await asyncio.sleep(0.3)
        focused = await b.js(f"return document.activeElement === document.querySelector('{CM}');")
        check("clicking a note puts the caret in it", focused)
        first = await b.js(f"return document.querySelector('{CM} .cm-line').innerText;")
        check("the line being edited shows its real text", "**Dana**" in first, first)

        # type at the very end: a list line, then Return continues it
        await b.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "End", "code": "End",
                                                "windowsVirtualKeyCode": 35, "modifiers": 2})   # Ctrl+End
        await b.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "End", "code": "End",
                                                "windowsVirtualKeyCode": 35, "modifiers": 2})
        async def enter():
            for typ in ("rawKeyDown", "keyUp"):
                await b.send("Input.dispatchKeyEvent", {"type": typ, "key": "Enter", "code": "Enter",
                                                        "windowsVirtualKeyCode": 13})
            await asyncio.sleep(0.15)
        await enter()
        await b.send("Input.insertText", {"text": "- milk"})
        await enter()
        await b.send("Input.insertText", {"text": "eggs"})
        await enter()
        await enter()            # an empty item ends the list
        await b.send("Input.insertText", {"text": "plain again"})
        await asyncio.sleep(0.2)
        # ⌘B / Ctrl+B on a selection
        await b.send("Input.insertText", {"text": " bold"})
        for _ in range(4):
            await b.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "ArrowLeft", "code": "ArrowLeft",
                                                    "windowsVirtualKeyCode": 37, "modifiers": 8})   # Shift
            await b.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "ArrowLeft", "code": "ArrowLeft",
                                                    "windowsVirtualKeyCode": 37, "modifiers": 8})
        await b.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "b", "code": "KeyB",
                                                "windowsVirtualKeyCode": 66, "modifiers": 2})       # Ctrl+B
        await b.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "b", "code": "KeyB",
                                                "windowsVirtualKeyCode": 66, "modifiers": 2})
        await asyncio.sleep(1.2)
        await b.js("document.activeElement && document.activeElement.blur(); return true;")
        await asyncio.sleep(1.2)
        saved = await b.js(f"""const r = await (await fetch('/api/lists/inbox')).json();
            return (r.items.find(x => x.id === '{tid}') || {{}}).notes;""")
        tail = (saved or "").split("\n")[-3:]
        check("Return continues a list", tail[:2] == ["- milk", "- eggs"], str(tail))
        # the empty "- " that the second Return left is cleared, and the text goes there
        check("Return on an empty item ends it", tail[2].startswith("plain again"), str(tail))
        check("⌘B / Ctrl+B makes the selection bold", tail[2] == "plain again **bold**", str(tail))

        print("\nThe file")
        inbox = (root / "Inbox.md").read_text("utf-8")
        block = inbox[inbox.index("Notes probe"):]
        check("a task line in notes is escaped, so it stays notes", "    \\- [x] a box in the notes" in block,
              block[:400])
        todo = await b.js(f"""const r = await (await fetch('/api/lists/inbox')).json();
            return r.items.find(x => x.id === '{tid}');""")
        check("…and is not the checklist", not todo.get("checklist"), str(todo.get("checklist")))

        print("\nProject notes keep their headings")
        pid = await b.js("""
            const r = await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({name: 'Notes project probe'})});
            const p = await r.json();
            await fetch('/api/projects/' + p.id, {method:'PATCH', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({notes: 'Intro\\n\\n## Budget\\n\\nafter the heading'})});
            await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({title: 'A real to-do', projectId: p.id})});
            return p.id;""")
        await b.goto(f"{args.url}/project/{pid}")
        await b.wait_for("!!document.querySelector('.pnotes .cm-content')", timeout=12)
        await asyncio.sleep(0.6)
        pv = await b.js("""return { h: [...document.querySelectorAll('.pnotes .md-h2')].map(s=>s.textContent).join(''),
                                    hds: [...document.querySelectorAll('.hd')].length };""")
        check("## in project notes is a heading in the notes", pv["h"] == "Budget", str(pv))
        check("…and not a heading of the project", pv["hds"] == 0, str(pv))

        async def key(k, code, vk, mods):
            for typ in ("rawKeyDown", "keyUp"):
                await b.send("Input.dispatchKeyEvent", {"type": typ, "key": k, "code": code, "windowsVirtualKeyCode": vk, "modifiers": mods})

        async def notes_of(todo_id):
            return await b.js(f"""const r = await (await fetch('/api/lists/inbox')).json();
                return (r.items.find(x => x.id === '{todo_id}') || {{}}).notes;""")

        print("\nA title's Markdown, in the list")
        md = await b.js("""const r = await fetch('/api/todos', {method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({title: 'Order **supplies** for *the* office, see [brief](https://example.com/b)', inbox: true})});
            return (await r.json()).id;""")
        await b.goto(args.url + "/inbox")
        await b.wait_for(f"!!document.querySelector('[data-todo-id=\"{md}\"] .txt')", timeout=15)
        row = await b.js(f"""const t = document.querySelector('[data-todo-id="{md}"] .txt');
            return {{ strong: t.querySelector('strong')?.textContent, em: t.querySelector('em')?.textContent,
                      link: t.querySelector('a.tlink')?.getAttribute('href'), text: t.textContent }};""")
        check("**bold** and *italic* in a title show as such, without their stars",
              row["strong"] == "supplies" and row["em"] == "the" and "*" not in row["text"], str(row))
        check("a link in a title is a link", row["link"] == "https://example.com/b", str(row))
        await b.js(f"document.querySelector('[data-todo-id=\"{md}\"] a.tlink').click(); return true;")
        await asyncio.sleep(0.3)
        check("and clicking it opens it", "https://example.com/b" in (await b.js("return window.__opened;")))

        print("\nThe other Markdown shortcuts")
        await b.js(f"const r=document.querySelector('[data-todo-id=\"{md}\"]'); r.click(); r.click(); return true;")
        await b.wait_for(f"!!document.querySelector('{CM}')", timeout=8)
        await b.js(f"document.querySelector('{CM}').focus(); return true;")
        await b.send("Input.insertText", {"text": "milk"})
        await key("l", "KeyL", 76, 2 | 8)                    # Ctrl+Shift+L: a bulleted list
        await b.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
        await b.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
        await b.send("Input.insertText", {"text": "Plan"})
        await key("l", "KeyL", 76, 2 | 8)                    # off again: a plain line
        await key("2", "Digit2", 50, 1 | 2)                  # Ctrl+Alt+2: a heading
        await asyncio.sleep(1.2)
        await b.js("document.activeElement && document.activeElement.blur(); return true;")
        await asyncio.sleep(1.2)
        check("⇧⌘L makes a list, and takes it off; ^⌘2 makes a heading", (await notes_of(md) or "").split("\n") == ["- milk", "## Plan"],
              repr(await notes_of(md)))

        print("\nOn a phone: the format bar")
        await b.send("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
        await b.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
        await b.goto(args.url + "/inbox")
        await b.wait_for(f"!!document.querySelector('[data-todo-id=\"{md}\"]')", timeout=15)
        coarse = await b.js("return matchMedia('(pointer: coarse)').matches;")
        await b.js(f"document.querySelector('[data-todo-id=\"{md}\"]').click(); return true;")
        await b.wait_for(f"!!document.querySelector('{CM}')", timeout=8)
        check("no bar while the notes are only being read", not await b.js("return !!document.querySelector('.fmtbar');"))
        await b.js(f"document.querySelector('{CM}').focus(); return true;")
        await key("End", "End", 35, 2)
        await b.send("Input.insertText", {"text": " word"})
        bar = await b.wait_for("!!document.querySelector('.fmtbar')", timeout=5)
        names = await b.js("return [...document.querySelectorAll('.fmtbar button')].map(x => x.dataset.format);")
        check("writing them, a bar of formats sits on the keyboard", coarse and bool(bar) and names[:4] == ["bold", "italic", "highlight", "strike"], str(names))
        for _ in range(4):
            await key("ArrowLeft", "ArrowLeft", 37, 8)
        await b.js("""const x = document.querySelector('.fmtbar [data-format=bold]');
            const down = new PointerEvent('pointerdown', {bubbles: true, cancelable: true});
            x.dispatchEvent(down); x.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
            x.click(); return down.defaultPrevented;""")
        await asyncio.sleep(0.3)
        still = await b.js(f"return document.activeElement === document.querySelector('{CM}');")
        await b.js("document.activeElement && document.activeElement.blur(); return true;")
        await asyncio.sleep(1.2)
        check("its B makes the selection bold, and the caret stays in the notes",
              still and (await notes_of(md) or "").endswith("## Plan **word**"), repr(await notes_of(md)))
        check("and the bar goes when the notes do", not await b.js("return !!document.querySelector('.fmtbar');"))
        await b.send("Emulation.setTouchEmulationEnabled", {"enabled": False})
        await b.send("Emulation.clearDeviceMetricsOverride", {})
        await b.js(f"await fetch('/api/todos/{md}', {{method:'DELETE'}}); return true;")

        print("\nWithout the editor")
        await b.send("Network.enable")
        await b.send("Network.setBlockedURLs", {"urls": ["*notes-editor*"]})
        await b.send("Network.setCacheDisabled", {"cacheDisabled": True})
        await b.send("ServiceWorker.enable")
        await b.send("ServiceWorker.stopAllWorkers")
        await b.goto(args.url + "/inbox")
        await b.wait_for(f"!!document.querySelector('[data-todo-id=\"{tid}\"]')", timeout=15)
        await b.js(f"const r=document.querySelector('[data-todo-id=\"{tid}\"]'); r.click(); r.click(); return true;")
        ta = await b.wait_for("!!document.querySelector('.card textarea.note')", timeout=8)
        check("a card whose editor cannot load falls back to a plain field", bool(ta))
        await b.send("Network.setBlockedURLs", {"urls": []})

        await b.js(f"await fetch('/api/todos/{tid}', {{method:'DELETE'}}); return true;")

    print("\n" + ("notes are Markdown" if not FAILURES else f"{len(FAILURES)} failed: " + "; ".join(FAILURES)))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
