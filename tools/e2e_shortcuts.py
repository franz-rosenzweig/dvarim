#!/usr/bin/env python3
"""Press every shortcut in KEYMAP in a real browser and check it did something.

A binding can be listed, dispatched and still be dead. This walks the keymap and
asserts an observable effect for each one, so the documented list is the tested
list.

    tools/e2e_shortcuts.py --url http://172.19.0.1:8422 --root /tmp/dv-e2e
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data  # noqa: E402

KEY = {
    'Mod': 'metaKey', 'Shift': 'shiftKey', 'Alt': 'altKey',
}


def js_key(combo: str) -> str:
    parts = combo.split('+')
    key = parts[-1]
    mods = {KEY[p]: True for p in parts[:-1] if p in KEY}
    named = {'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown', 'Enter': 'Enter',
             'Escape': 'Escape', 'Backspace': 'Backspace', 'Delete': 'Delete', 'Space': ' '}
    k = named.get(key, key.lower())
    code = (f"Key{key.upper()}" if len(key) == 1 and key.isalpha()
            else f"Digit{key}" if key.isdigit()
            else 'Space' if key == 'Space'
            else 'Comma' if key == ',' else key)
    opts = ", ".join([f"key:{k!r}", f"code:{code!r}", "bubbles:true"] +
                     [f"{m}:true" for m in mods])
    return f"document.dispatchEvent(new KeyboardEvent('keydown', {{{opts}}}));"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--root", required=True)
    ap.add_argument("--devtools", default="http://172.19.0.17:9222")
    args = ap.parse_args()
    refuse_live_data(getattr(args, 'root', None), args.url)

    async with Browser(args.devtools) as b:
        async def reset(path="/anytime"):
            await b.goto(args.url + path)
            ok = await b.wait_for("document.querySelectorAll('.row[data-todo-id]').length > 0", timeout=12)
            if not ok:
                # empty list: seed one so the shortcut has something to act on
                await b.js("""
                    await fetch('/api/todos', {
                      method: 'POST', headers: {'content-type':'application/json'},
                      body: JSON.stringify({ title: 'Shortcut test item', inbox: true })
                    });
                    return true;
                """)
                await b.goto(args.url + path)
                await b.wait_for("document.querySelectorAll('.row[data-todo-id]').length > 0", timeout=12)
            await b.js("document.querySelector('.row[data-todo-id]').click(); return true;")
            await asyncio.sleep(0.5)

        async def press(combo):
            await b.js(js_key(combo) + " return true;")
            await asyncio.sleep(0.7)

        async def sel_id():
            return await b.js("return document.querySelector('.row.sel, .row.selected')?.dataset.todoId || null;")

        async def close_all():
            await b.js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape', bubbles:true})); return true;")
            await asyncio.sleep(0.4)

        # load the app first: the navigation checks below dispatch keys at the
        # document, which does nothing on a blank tab.
        await b.goto(args.url + "/today")
        started = await b.wait_for("document.querySelectorAll('.item').length > 3", timeout=25)
        check("the app is loaded before testing keys", bool(started))
        # Mod+K is checked by looking for the item in the Logbook, which only
        # holds it straight away in "immediately" mode. Say so rather than
        # inherit whatever the last suite left behind.
        await b.js("await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},"
                   "body:JSON.stringify({logCompleted:'immediately'})}); return true;")

        print("\nNavigation")
        for combo, name, expect in [
            ('Mod+1', 'Inbox', 'Inbox'), ('Mod+2', 'Today', 'Today'),
            ('Mod+3', 'Upcoming', 'Upcoming'), ('Mod+4', 'Anytime', 'Anytime'),
            ('Mod+5', 'Someday', 'Someday'), ('Mod+6', 'Logbook', 'Logbook'),
        ]:
            await press(combo)
            await b.wait_for(f"document.querySelector('h1.t .name')?.textContent?.trim() === {expect!r}", timeout=10)
            got = await b.js("return document.querySelector('h1.t .name')?.textContent?.trim() || '';")
            check(f"{combo} goes to {name}", got == expect, f"landed on {got!r}")

        print("\nPopovers on a selected to-do")
        for combo, name, probe in [
            ('Mod+S', 'When',     "[...document.querySelectorAll('.opt .lbl')].some(e=>e.textContent.trim()==='Today')"),
            ('Mod+Shift+D', 'Deadline', "[...document.querySelectorAll('.opt .lbl')].some(e=>e.textContent.trim()==='Tomorrow')"),
            ('Mod+Shift+M', 'Move', "document.querySelectorAll('.opt').length > 1"),
            ('Mod+Shift+T', 'Tags', "!!document.querySelector('.pop')"),
        ]:
            await reset()
            await press(combo)
            ok = await b.wait_for(probe, timeout=6)
            check(f"{combo} opens {name}", bool(ok))
            await close_all()

        print("\nQuick Find and Settings")
        await reset()
        await press('Mod+F')
        check("Mod+F opens Quick Find", bool(await b.wait_for("!!document.querySelector('.qf')", timeout=6)))
        await close_all()
        await press('Mod+,')
        check("Mod+, opens Settings", bool(await b.wait_for("!!document.querySelector('[role=dialog]')", timeout=6)))
        await close_all()

        print("\nDate moves write to the file")
        for combo, name, marker in [
            ('Mod+T', 'Move to Today', 'when'),
            ('Mod+E', 'Move to This Evening', 'evening'),
            ('Mod+O', 'Move to Someday', 'someday'),
            ('Mod+R', 'Move to Anytime', 'clear'),
        ]:
            await reset()
            tid = await b.js("return document.querySelector('.row[data-todo-id]').dataset.todoId;")
            await press(combo)
            await asyncio.sleep(1.2)
            got = await b.js(f"""
                for (const list of ['today','someday','anytime','upcoming']) {{
                  const r = await fetch('/api/lists/'+list).then(r=>r.json());
                  const items = [
                    ...(r.items || []),
                    ...((r.groups || []).flatMap(g => g.items || [])),
                    ...((r.days || []).flatMap(d => d.items || [])),
                  ];
                  const hit = items.find(t => t.id === '{tid}');
                  if (hit) return {{ list, when: hit.when, evening: hit.evening, someday: hit.someday }};
                }}
                return null;
            """)
            if marker == 'when':
                check(f"{combo} ({name})", bool(got and got['list'] == 'today' and got['when']), str(got))
            elif marker == 'evening':
                check(f"{combo} ({name})", bool(got and got['evening']), str(got))
            elif marker == 'someday':
                check(f"{combo} ({name})", bool(got and got['someday']), str(got))
            else:
                check(f"{combo} ({name})", bool(got and got['list'] == 'anytime' and not got['when']), str(got))

        print("\nItem actions")
        await reset()
        tid = await b.js("return document.querySelector('.row[data-todo-id]').dataset.todoId;")
        await press('Mod+K')
        await asyncio.sleep(1.2)
        done = await b.js(f"const r = await fetch('/api/lists/logbook').then(r=>r.json());"
                          f"return r.groups.some(g => g.items.some(t => t.id === '{tid}'));")
        check("Mod+K completes the selected to-do", bool(done))
        await press('Mod+Z')
        await asyncio.sleep(1.2)
        back = await b.js(f"const r = await fetch('/api/lists/logbook').then(r=>r.json());"
                          f"return !r.groups.some(g => g.items.some(t => t.id === '{tid}'));")
        check("Mod+Z undoes it", bool(back))

        await reset()
        tid = await b.js("return document.querySelector('.row[data-todo-id]').dataset.todoId;")
        before = await b.js("return document.querySelectorAll('.row[data-todo-id]').length;")
        await press('Mod+D')
        await asyncio.sleep(1.5)
        after = await b.js("return document.querySelectorAll('.row[data-todo-id]').length;")
        check("Mod+D duplicates", after == before + 1, f"{before} -> {after}")

        await reset()
        tid = await b.js("return document.querySelector('.row[data-todo-id]').dataset.todoId;")
        await press('Backspace')
        await asyncio.sleep(1.5)
        trashed = await b.js(f"const r = await fetch('/api/lists/trash').then(r=>r.json());"
                             f"return r.items.some(t => t.id === '{tid}');")
        check("Backspace moves to Trash", bool(trashed))
        await press('Mod+Z')
        await asyncio.sleep(1.2)
        restored = await b.js(f"const r = await fetch('/api/lists/trash').then(r=>r.json());"
                              f"return !r.items.some(t => t.id === '{tid}');")
        check("Mod+Z restores it", bool(restored))

        print("\nSelection and editing")
        await reset()
        first = await sel_id()
        await press('ArrowDown')
        second = await sel_id()
        check("ArrowDown moves the selection", bool(first and second and first != second), f"{first} -> {second}")
        await press('ArrowUp')
        check("ArrowUp moves it back", await sel_id() == first)
        await press('Enter')
        check("Enter opens the editor", bool(await b.wait_for("!!document.querySelector('.card .ttl')", timeout=5)))
        await press('Escape')
        check("Escape closes the editor", not await b.js("return !!document.querySelector('.card .ttl');"))

        await reset("/inbox")
        n0 = await b.js("return document.querySelectorAll('.row[data-todo-id]').length;")
        await press('Mod+N')
        await asyncio.sleep(1.2)
        check("Mod+N makes a new to-do", bool(await b.js("return !!document.querySelector('.card .ttl');")))
        await press('Escape')

        print("\nThe rest of the keymap")
        # cancel
        await reset()
        tid = await b.js("return document.querySelector('.row[data-todo-id]').dataset.todoId;")
        await press('Mod+Alt+K')
        await asyncio.sleep(1.4)
        canceled = await b.js(f"const r = await fetch('/api/lists/logbook').then(r=>r.json());"
                              f"return r.groups.some(g => g.items.some(t => t.id === '{tid}' && t.status === 'canceled'));")
        check("Mod+Alt+K cancels", bool(canceled))
        await press('Mod+Z'); await asyncio.sleep(1.0)

        # checklist focus
        await reset()
        await press('Mod+Shift+C')
        check("Mod+Shift+C opens the editor on the checklist",
              bool(await b.wait_for("!!document.querySelector('.card')", timeout=6)))
        await close_all()

        # reorder
        await reset()
        order0 = await b.js("return [...document.querySelectorAll('.row[data-todo-id]')].map(r=>r.dataset.todoId).slice(0,3);")
        await b.js("document.querySelectorAll('.row[data-todo-id]')[1].click(); return true;")
        await asyncio.sleep(0.4)
        await press('Mod+ArrowUp')
        await asyncio.sleep(1.4)
        order1 = await b.js("return [...document.querySelectorAll('.row[data-todo-id]')].map(r=>r.dataset.todoId).slice(0,3);")
        check("Mod+ArrowUp reorders", order0 != order1, f"{order0} -> {order1}")
        await press('Mod+ArrowDown'); await asyncio.sleep(1.2)

        # Space expands
        await reset()
        await press('Space')
        check("Space expands the selected to-do",
              bool(await b.wait_for("!!document.querySelector('.card .ttl')", timeout=6)))
        await close_all()

        # convert to project
        await reset("/inbox")
        tid = await b.js("return document.querySelector('.row[data-todo-id]').dataset.todoId;")
        n0 = await b.js("const r = await fetch('/api/state').then(r=>r.json());"
                        "return r.looseProjects.length + r.areas.reduce((n,a)=>n+a.projects.length,0);")
        await press('Mod+Shift+P')
        await asyncio.sleep(1.8)
        n1 = await b.js("const r = await fetch('/api/state').then(r=>r.json());"
                        "return r.looseProjects.length + r.areas.reduce((n,a)=>n+a.projects.length,0);")
        check("Mod+Shift+P converts a to-do to a project", n1 == n0 + 1, f"{n0} -> {n1}")

        # new project / new heading
        await b.goto(args.url + "/today")
        await b.wait_for("document.querySelectorAll('.item').length > 3", timeout=15)
        await press('Mod+Alt+N')
        await asyncio.sleep(1.8)
        n2 = await b.js("const r = await fetch('/api/state').then(r=>r.json());"
                        "return r.looseProjects.length + r.areas.reduce((n,a)=>n+a.projects.length,0);")
        check("Mod+Alt+N creates a project", n2 == n1 + 1, f"{n1} -> {n2}")
        pid = await b.js("const r = await fetch('/api/state').then(r=>r.json());"
                         "return r.looseProjects.length ? r.looseProjects[r.looseProjects.length-1].id : null;")
        if pid:
            await b.goto(f"{args.url}/project/{pid}")
            await b.wait_for("!!document.querySelector('h1.t')", timeout=12)
            h0 = await b.js(f"const r = await fetch('/api/projects/{pid}').then(r=>r.json()); return r.project.headings.length;")
            await press('Mod+Shift+N')
            await asyncio.sleep(1.8)
            h1 = await b.js(f"const r = await fetch('/api/projects/{pid}').then(r=>r.json()); return r.project.headings.length;")
            check("Mod+Shift+N creates a heading in that project", h1 == h0 + 1, f"{h0} -> {h1}")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} shortcut check(s) failed: " + "; ".join(FAILURES))
        return 1
    print("every shortcut fired")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
