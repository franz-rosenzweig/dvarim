#!/usr/bin/env python3
import asyncio, re, sys, json
from touch import Phone, adb

RESULTS = []
def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok))); print(("PASS " if ok else "FAIL ") + name + (f"   [{detail}]" if detail else ""), flush=True)


def fc_screen():
    """What uiautomator sees on the phone now."""
    import xml.etree.ElementTree as ET
    adb("shell", "uiautomator", "dump", "/sdcard/dvarim-ui.xml", check=False)
    return ET.fromstring(adb("shell", "cat", "/sdcard/dvarim-ui.xml"))


def ime_top():
    """The keyboard's top edge in screen pixels, from its inset source, or None
    while it is not showing. (The InputMethod window's own frame is most of the
    screen; the inset is what the keyboard actually covers.)"""
    out = adb("shell", "dumpsys", "window", check=False)
    m = re.search(r"InsetsSource id=\S+ type=ime frame=\[\d+,(\d+)\]\[\d+,\d+\][^\n]*visible=true", out)
    return int(m.group(1)) if m else None

async def dismiss(p):
    """Put everything away, with taps a person could make, and the list back at
    the top. Every block measures rows against the viewport and then touches
    there, so each has to start from the same place: opening a card scrolls it
    into view, a drop scrolls to what it made, and a block that inherits that
    drops its finger above the first row. One that needs a row further down
    brings it into view itself (`into_view`)."""
    for _ in range(4):
        st = await p.js("({pop: !!document.querySelector('.pop'), qf: !!document.querySelector('.qf'), sel: document.querySelector('.app').classList.contains('selecting'), card: !!document.querySelector('.card'), root: document.querySelector('.app').classList.contains('root')})")
        if await p.js("!!document.querySelector('.inboxsheet')"):
            x = await p.rect(".inboxsheet .x"); p.tap(x["cx"], x["cy"])
        elif st["pop"] or st["qf"]: p.back()   # a fixed tap can land on the keyboard
        elif st["sel"]:
            r = await p.rect(".topbar .done"); p.tap(r["cx"], r["cy"])
        elif st["card"]: p.back()          # what a person does: and it minds the keyboard
        elif st["root"]: p.tap(370, 400)
        else:
            # The keyboard shortens the page now, so wait for its height back as
            # well: a check that measures a short page measures the wrong thing.
            for _ in range(12):
                if not p.keyboard(): break
                await asyncio.sleep(0.3)
            full = getattr(p, "full", None)
            if full: await p.wait(f"innerHeight === {full}", 3)
            await asyncio.sleep(0.4)      # let a refresh land before anything is counted
            await p.to_top()              # …and the list be at the top, and still
            return
        await asyncio.sleep(0.5)


# The room the list has opened. One that is closing stays in the page, at no
# height, for as long as it takes to close (frontend/src/lib/gap.js).
OPEN_GAP = "[...document.querySelectorAll('.listgap')].find(g => g.style.height !== '0px')"


async def into_view(p, sel, i=0):
    """Bring the i-th match of `sel` to the middle of the list, wait for the
    list to stop, and measure it there."""
    await p.js(f"[...document.querySelectorAll({json.dumps(sel)})][{i}]?.scrollIntoView({{block: 'center'}})")
    await p.quiet()
    return await p.rect(sel, i)

async def main():
    only = set(sys.argv[1:])
    p = Phone(); await p.launch()
    want = lambda n: not only or n in only
    p.full = await p.js("innerHeight")      # the page at rest, with no keyboard
    print("viewport", await p.js("[innerWidth, innerHeight, devicePixelRatio]"), "rows", await p.titles(4))

    if want("swipe"):
        r = await p.rect("[data-todo-id]", 1)
        p.swipe(r["x"] + 90, r["cy"], r["x"] + 280, r["cy"], 350)
        check("swipe right opens the When popover", await p.wait("document.querySelector('.pop')", 2))
        await dismiss(p)
        r = await p.rect("[data-todo-id]", 1)
        p.swipe(r["x"] + 300, r["cy"], r["x"] + 110, r["cy"], 350)
        ok = await p.wait("document.querySelector('.app').classList.contains('selecting')", 2)
        picked = await p.js("[...document.querySelectorAll('[data-todo-id]')].map(r => !!r.querySelector('.pick.on'))")
        check("swipe left starts selecting, with that row picked", ok and picked[1] and sum(picked) == 1, picked[:4])
        p.shot("t_selecting")
        # a stroke down the circles picks every row it passes, and back up un-picks
        a = await p.rect(".row .pick", 3); b = await p.rect(".row .pick", 6)
        p.down(a["cx"], a["cy"]); await asyncio.sleep(0.1)
        for i in range(1, 9): p.move(a["cx"], a["cy"] + (b["cy"] - a["cy"]) * i / 8)
        picked = await p.js("[...document.querySelectorAll('[data-todo-id]')].map(r => !!r.querySelector('.pick.on'))")
        check("a stroke down the circles picks each row it passes", picked[1] and all(picked[3:7]) and not picked[2] and not picked[7], picked[:9])
        for i in range(7, 3, -1): p.move(a["cx"], a["cy"] + (b["cy"] - a["cy"]) * i / 8)
        p.up(a["cx"], a["cy"] + (b["cy"] - a["cy"]) * 4 / 8); await asyncio.sleep(0.3)
        back = await p.js("[...document.querySelectorAll('[data-todo-id]')].map(r => !!r.querySelector('.pick.on'))")
        check("drawn back up, it lets go of what it overshot", back[3] and not back[6], back[:9])
        top = await p.js("document.querySelector('.content').scrollTop")
        check("and the list did not scroll under the stroke", top == 0, f"scrollTop={top}")
        k = await p.rect(".row .pick", 0); p.tap(k["cx"], k["cy"]); await asyncio.sleep(0.3)
        check("a tap on a circle picks one row, once", await p.js("!!document.querySelectorAll('[data-todo-id]')[0].querySelector('.pick.on')"))
        await dismiss(p)
        check("Done leaves selection mode", not await p.js("document.querySelector('.app').classList.contains('selecting')"))
        # a short swipe must do nothing, and leave nothing behind
        r = await p.rect("[data-todo-id]", 2)
        p.swipe(r["x"] + 120, r["cy"], r["x"] + 150, r["cy"], 200); await asyncio.sleep(0.5)
        st = await p.js("({pop: !!document.querySelector('.pop'), sel: document.querySelector('.app').classList.contains('selecting'), stuck: !!document.querySelector('.row.swiping,.row.swipe-left,.row.swipe-right')})")
        check("a short swipe does nothing and settles", not st["pop"] and not st["sel"] and not st["stuck"], st)
        await dismiss(p)

    if want("scroll"):
        await p.js("document.querySelector('.content').scrollTop = 0")
        h = await p.js("(() => { const c=document.querySelector('.content'); return [c.scrollHeight, c.clientHeight] })()")
        p.swipe(200, 600, 200, 250, 300); await asyncio.sleep(0.8)
        top = await p.js("document.querySelector('.content').scrollTop")
        check("the list still scrolls from a finger on a row", top > 0 or h[0] <= h[1], f"scrollTop={top} of {h}")
        await p.to_top()                  # the fling is still going, and the next block measures

    if want("plus"):
        before = await p.titles(12)
        f = await p.rect(".fab"); r2 = await p.rect("[data-todo-id]", 2)
        # lift, carry to the boundary above row 2, hold there, drop
        pts = [(f["cx"], f["cy"])] + [(f["cx"] + (r2["x"] + 200 - f["cx"]) * i / 12, f["cy"] + (r2["y"] + 4 - f["cy"]) * i / 12) for i in range(1, 13)]
        p.down(*pts[0]); await asyncio.sleep(0.15)
        for q in pts[1:]: p.move(*q)
        await asyncio.sleep(0.3)
        mid = await p.js("({ghost: !!document.querySelector('.plusghost'), fab: getComputedStyle(document.querySelector('.fab')).visibility, gap: Math.round(document.querySelector('.listgap')?.getBoundingClientRect().height || 0), gapIndex: [...document.querySelector('.listgap')?.parentNode.children || []].filter(e => e.matches('.titem,[data-todo-id],.listgap')).findIndex(e => e.matches('.listgap')), plain: Math.round([...document.querySelectorAll('.content .row')].filter(x => !x.querySelector('.sub'))[0]?.getBoundingClientRect().height || 0), inbox: !!document.querySelector('.plustarget.inbox'), cancel: !!document.querySelector('.plustarget.cancel')})")
        p.shot("t_plus_mid")
        check("the plus itself lifts: its corner empties, and the two targets come up", mid["ghost"] and mid["fab"] == "hidden" and mid["inbox"] and mid["cancel"], mid)
        check("the list parts where it is held, by one plain row's worth", abs(mid["gap"] - mid["plain"]) <= 2 and mid["gapIndex"] == 2, mid)
        p.up(*pts[-1])
        ok = await p.wait("document.querySelector('.card')", 3)
        idx = await p.js("[...document.querySelectorAll('[data-todo-id]')].findIndex(e => e.matches('.card'))")
        after = await p.titles(12)
        check("dropping it opens a new to-do in that room", ok and idx == 2 and len(after) == len(before) + 1, f"card index {idx}")
        await asyncio.sleep(0.4)
        check("and the gap is gone once the card is in it", await p.js("document.querySelectorAll('.listgap').length") == 0)
        await dismiss(p)
        # a plain tap must still be a plain tap
        n0 = len(await p.titles(30)); f = await p.rect(".fab"); p.tap(f["cx"], f["cy"])
        ok = await p.wait(f"document.querySelector('.card') && document.querySelectorAll('[data-todo-id]').length === {n0 + 1}", 3)
        check("tapping the plus still makes a to-do", ok, f"{n0} -> {len(await p.titles(30))}")
        await dismiss(p)
        # out and back to its corner: nothing happens
        n0 = len(await p.titles(30)); f = await p.rect(".fab")
        p.down(f["cx"], f["cy"]); await asyncio.sleep(0.15)
        for q in [(f["cx"] - 40 * i, f["cy"] - 50 * i) for i in range(1, 5)] + [(f["cx"] - 40 * i, f["cy"] - 50 * i) for i in range(3, -1, -1)]: p.move(*q)
        on = await p.js("!!document.querySelector('.plustarget.cancel.on')"); p.up(f["cx"], f["cy"]); await asyncio.sleep(0.8)
        check("carried back to its corner, the cross lights", on)
        n1 = len(await p.titles(30)); st = await p.js("({card: !!document.querySelector('.card'), sheet: !!document.querySelector('.inboxsheet'), owner: null})")
        if n1 != n0 or st["card"] or st["sheet"]: p.shot("t_fail_cancel")
        check("and letting go there does nothing", n1 == n0 and not st["card"] and not st["sheet"], f"{n0}->{n1} {st}")
        # to the bottom-left: the Inbox
        f = await p.rect(".fab")
        pts = [(f["cx"], f["cy"])] + [(f["cx"] + (60 - f["cx"]) * i / 10, f["cy"] + (760 - f["cy"]) * i / 10 - 120 * (1 - abs(5 - i) / 5)) for i in range(1, 11)]
        p.down(*pts[0]); await asyncio.sleep(0.15)
        for q in pts[1:]: p.move(*q)
        await asyncio.sleep(0.3)
        on = await p.js("!!document.querySelector('.plustarget.inbox.on')"); p.shot("t_plus_inbox"); p.up(*pts[-1])
        check("near the Inbox, the target swells and says so", on)
        check("letting go there opens a sheet, and makes nothing yet", await p.wait("document.querySelector('.inboxsheet')", 2) and len(await p.titles(30)) == n0)
        await asyncio.sleep(0.6)
        check("with the keyboard up, because it is there to be typed into", p.keyboard())
        adb("shell", "input", "text", "Ring the bank".replace(" ", "%s")); await asyncio.sleep(0.5)
        sv = await p.rect(".inboxsheet .save"); p.tap(sv["cx"], sv["cy"]); await asyncio.sleep(1.2)
        inbox = await p.js("fetch('/api/lists/inbox').then(r => r.json()).then(d => JSON.stringify(d).includes('Ring the bank'))")
        check("Save puts it in the Inbox, without leaving the list", inbox and "Today" in (await p.js("document.querySelector('h1.t')?.textContent") or ""))
        await dismiss(p)
        for _ in range(10):
            if not p.keyboard(): break
            await asyncio.sleep(0.3)

    if want("pull"):
        await p.to_top()
        p.down(200, 330); await asyncio.sleep(0.1)
        for i in range(1, 9): p.move(200, 330 + i * 22)
        mid = await p.js("({pull: getComputedStyle(document.querySelector('.main')).getPropertyValue('--pull'), mark: getComputedStyle(document.querySelector('.pullmark')).opacity})")
        p.shot("t_pull_mid"); p.up(200, 330 + 8 * 22)
        check("pulling moves the list and fades the magnifier up", mid["pull"].strip() not in ("", "0px") and float(mid["mark"]) > 0.5, mid)
        check("letting go past the mark opens Quick Find", await p.wait("document.querySelector('.qf')", 2))
        box = await p.js("(() => { const q=document.querySelector('.qf').getBoundingClientRect(); const b=document.querySelector('.topbar').getBoundingClientRect(); return {top: Math.round(q.top), bar: Math.round(b.top)} })()")
        check("and it opens clear of the status bar", box["top"] >= box["bar"], f"Quick Find at {box['top']}, the bar starts at {box['bar']}")
        await dismiss(p)
        await asyncio.sleep(0.3)
        p.swipe(200, 330, 200, 370, 250); await asyncio.sleep(0.6)
        ok = not await p.js("!!document.querySelector('.qf')")
        if not ok: p.shot("t_fail_shortpull"); print("   state:", await p.js("({h: innerHeight, depth: history.state?.depth, top: document.querySelector('.content').scrollTop, focus: document.activeElement?.tagName, card: !!document.querySelector('.card')})"))
        check("a short pull does not", ok)
        await dismiss(p)

    if want("drag"):
        before = await p.titles(6)
        a = await p.rect("[data-todo-id]", 0); c = await p.rect("[data-todo-id]", 2)
        p.down(a["x"] + 200, a["cy"]); await asyncio.sleep(0.65)
        lifted = await p.js("document.body.classList.contains('dragging')")
        steps = 10; y1 = c["y"] + c["h"] - 6
        for i in range(1, steps + 1): p.move(a["x"] + 200, a["cy"] + (y1 - a["cy"]) * i / steps)
        mid = await p.js("({dragging: document.body.classList.contains('dragging'), ghost: !!document.querySelector('.drag-card'), line: !!document.querySelector('.listgap')})")
        p.shot("t_drag_mid"); p.up(a["x"] + 200, y1); await asyncio.sleep(1.0)
        after = await p.titles(6)
        check("a held row lifts", lifted)
        check("it stays lifted while it moves", mid["dragging"] and mid["ghost"], mid)
        check("dropping it reorders the list", after[:3] == [before[1], before[2], before[0]], f"{before[:3]} -> {after[:3]}")
        await dismiss(p)

    if want("belongs"):
        await dismiss(p)
        # Every coordinate below is measured against the viewport, so the list
        # has to be where the measuring started. Opening a card scrolls it into
        # view and the earlier blocks leave it there; without this the "+" is
        # dropped above the first row and everything lands at index 0.
        await p.to_top(); await p.quiet()
        async def lift_to(x, y, shot=None):
            f = await p.rect(".fab")
            p.down(f["cx"], f["cy"]); await asyncio.sleep(0.15)
            for i in range(1, 11): p.move(f["cx"] + (x - f["cx"]) * i / 10, f["cy"] + (y - f["cy"]) * i / 10)
            await asyncio.sleep(0.35)
            if shot: p.shot(shot)
            gap = await p.js("!!document.querySelector('.listgap')")
            p.up(x, y); return gap
        # let go on the "This Evening" heading itself: not a row, and it used to do nothing
        h = await into_view(p, ".hd.evening")
        n0 = len(await p.titles(40))
        gap = await lift_to(200, h["cy"] + 2)
        ok = await p.wait(f"document.querySelector('.card') && document.querySelectorAll('[data-todo-id]').length === {n0 + 1}", 4)
        check("let go on a heading, between two sections, the list still parts and a to-do is made", gap and ok)
        await dismiss(p)
        # into This Evening: it has to BE an evening to-do, or it lands in the day
        r = await into_view(p, "[data-list-evening=true] [data-todo-id]")
        ev = {"x": r["x"] + 200, "y": r["y"] + r["h"] + 2}
        before = await p.js("fetch('/api/lists/today').then(r => r.json()).then(d => (d.items||[]).filter(t => t.evening).length)")
        await lift_to(ev["x"], ev["y"], "t_plus_evening")
        await p.wait("document.querySelector('.card')", 4); await asyncio.sleep(0.8)
        after = await p.js("fetch('/api/lists/today').then(r => r.json()).then(d => (d.items||[]).filter(t => t.evening).length)")
        inlist = await p.js("!!document.querySelector('[data-list-evening=true] .card')")
        check("dropped in This Evening, it is an evening to-do, and opens there", after == before + 1 and inlist, f"evening {before} -> {after}, card in evening list: {inlist}")
        await dismiss(p)
        # pulling down through an open to-do's notes is not a pull for Quick Find
        await p.to_top(); await p.quiet()      # the drops above scrolled it away
        r = await p.rect("[data-todo-id]", 0); p.tap(r["x"] + 200, r["cy"]); await p.wait("document.querySelector('.card')", 3); await asyncio.sleep(0.4)
        # one BACK, for the keyboard only: p.back() spends a second one on the
        # card, and the next line measures the card.
        if p.keyboard(): adb("shell", "input", "keyevent", "BACK"); await asyncio.sleep(0.6)
        c = await p.rect(".card"); await p.js("document.querySelector('.content').scrollTop = 0")
        p.swipe(c["cx"], c["y"] + 20, c["cx"], c["y"] + 220, 400); await asyncio.sleep(0.7)
        check("a drag down inside an open to-do does not open Quick Find", not await p.js("!!document.querySelector('.qf')"))
        await dismiss(p)
        # Upcoming: under a day means that day
        await p.goto("/upcoming"); await p.wait("document.querySelector('[data-list-when]')", 5)
        day = await p.js("(() => { const ls=[...document.querySelectorAll('[data-list-when]')]; const l=ls[Math.min(2, ls.length-1)]; const b=l.getBoundingClientRect(); const hd=l.previousElementSibling; return {when:l.dataset.listWhen, x:200, y:(b.height ? b.top+4 : (hd||l).getBoundingClientRect().bottom+3), lists: ls.length} })()")
        await lift_to(day["x"], day["y"], "t_plus_upcoming")
        await p.wait("document.querySelector('.card')", 4); await asyncio.sleep(0.8)
        got = await p.js("(() => { const c=document.querySelector('.card'); const l=c && c.closest('[data-list-when]'); return l && l.dataset.listWhen })()")
        check("dropped under a day in Upcoming, it is made on that day", got == day["when"], f"wanted {day['when']}, card is under {got}")
        await dismiss(p)
        await p.goto("/today"); await p.wait("document.querySelector('h1.t')?.textContent.includes('Today')", 5)

    if want("heading"):
        await dismiss(p)
        q = Phone(); import touch as T; old_url = T.URL; T.URL = "http://localhost:8421/project/pmanu0001"
        await q.launch(); T.URL = old_url
        heads0 = await q.js("[...document.querySelectorAll('.hd .hname')].map(e => e.textContent.trim())")
        f = await q.rect(".fab"); r = await q.rect("[data-todo-id]", 1)
        q.down(f["cx"], f["cy"]); await asyncio.sleep(0.15)
        for i in range(1, 11): q.move(f["cx"] + (30 - f["cx"]) * i / 10, f["cy"] + (r["y"] + 2 - f["cy"]) * i / 10)
        await asyncio.sleep(0.35)
        mid = await q.js("!!document.querySelector('.listgap.heading')"); q.shot("t_heading_mid"); q.up(30, r["y"] + 2); await asyncio.sleep(1.5)
        heads1 = await q.js("[...document.querySelectorAll('.hd .hname')].map(e => e.textContent.trim())")
        under = await q.js("(() => { const hs=[...document.querySelectorAll('.hd')]; const h=hs.find(e => /New Heading/.test(e.textContent)); if(!h) return null; let n=h.nextElementSibling; return n && n.querySelector('[data-todo-id] .txt')?.textContent.trim().slice(0,22) })()")
        check("in a project, the left margin turns the room into a NEW HEADING rule", mid)
        check("and letting go puts a heading there, over the to-dos that were below", len(heads1) == len(heads0) + 1 and "New Heading" in heads1 and heads1.index("New Heading") == 2 and (under or "").startswith("Standardise"), f"{heads1} / under it: {under}")
        p = Phone(); await p.launch()

    if want("group"):
        await dismiss(p)
        before = await p.titles(8)
        r = await p.rect("[data-todo-id]", 0)
        p.swipe(r["x"] + 300, r["cy"], r["x"] + 200, r["cy"], 250); await asyncio.sleep(0.6)
        k = await p.rect(".row .pick", 1); p.tap(k["cx"], k["cy"]); await asyncio.sleep(0.4)
        a = await p.rect("[data-todo-id]", 0); c = await p.rect("[data-todo-id]", 4)
        p.down(a["x"] + 150, a["cy"]); await asyncio.sleep(0.65)
        y1 = c["y"] + c["h"] - 4
        for i in range(1, 10): p.move(a["x"] + 150, a["cy"] + (y1 - a["cy"]) * i / 9)
        await asyncio.sleep(0.35)
        mid = await p.js("""(() => { const gap = document.querySelector('.listgap'); const kids = gap ? [...gap.parentNode.children] : [];
            const resting = kids.filter(e => e.matches('.listgap') || ((e.matches('.titem') || e.matches('[data-todo-id]')) && !e.querySelector('.row.sel') && !e.matches('.sel')));
            const plain = [...document.querySelectorAll('.content .row')].filter(x => !x.querySelector('.sub'))[0];
            return {card: !!document.querySelector('.drag-card'), n: document.querySelector('.drag-card .n')?.textContent,
                    selecting: document.querySelector('.app').classList.contains('selecting'),
                    circles: document.querySelectorAll('.content .row .pick').length,
                    gap: Math.round(gap ? gap.getBoundingClientRect().height : 0),
                    rows: [...document.querySelectorAll('.row.sel')].map(r => Math.round(r.getBoundingClientRect().height)),
                    gathered: [...document.querySelectorAll('.row.sel')].every(r => r.getBoundingClientRect().height < 2),
                    gapAt: resting.findIndex(e => e.matches('.listgap'))} })()""")
        p.shot("t_group_mid"); p.up(a["x"] + 150, y1); await asyncio.sleep(1.6)
        after = await p.titles(8)
        # ONE card, and it says nothing about how many: the room it left open is
        # what says that, and it is as tall as everything travelling.
        check("a held selection gathers into one card, with no count on it",
              mid["card"] and mid.get("n") is None and mid["gathered"], mid)
        check("the room it opens is as tall as the group", mid["gap"] >= 60, mid)
        # …and the chrome goes at the lift, not at the drop.
        check("choosing is over the moment it lifts", not mid["selecting"] and mid["circles"] == 0, mid)
        rest = before[2:]; g = mid["gapAt"]
        want_order = rest[:g] + before[:2] + rest[g:]
        check("and lands together, in order, where the list had parted for it", g >= 0 and after[:7] == want_order[:7], f"gap at {g}: {after[:6]}")
        await dismiss(p)

    if want("evening"):
        await dismiss(p)
        # An evening row carried up onto the heading and held there: between the
        # two sections, in neither list. The list used to close up there and a
        # drop did nothing. (Coming down from Today the heading slides away from
        # the finger as the room above it closes, so only going up stays on it.)
        b = await into_view(p, "[data-list-evening=true] [data-todo-id]")
        p.down(b["x"] + 200, b["cy"]); await asyncio.sleep(0.65)
        h = await p.rect(".hd.evening")
        for i in range(1, 5): p.move(b["x"] + 200, b["cy"] + (h["cy"] - b["cy"]) * i / 4)
        await asyncio.sleep(0.7)                       # the finger there, and the room it left closed
        on_head = await p.js(f"!!{OPEN_GAP}")
        for i in range(1, 5): p.move(b["x"] + 200, h["cy"] + (b["cy"] - h["cy"]) * i / 4)
        await asyncio.sleep(0.5); p.up(b["x"] + 200, b["cy"]); await asyncio.sleep(1.2)
        check("held on the This Evening heading, the list still parts", on_head)
        # Both ends of the drag on screen: the first evening row in the middle,
        # and a Today row a few above it, across the heading.
        e = await into_view(p, "[data-list-evening=true] [data-todo-id]")
        day = "[data-list-evening=false] [data-todo-id]"
        i = max(await p.js(f"document.querySelectorAll('{day}').length") - 3, 0)
        first = await p.js(f"document.querySelectorAll('{day}')[{i}]?.dataset.todoId")
        a = await p.rect(day, i)
        p.down(a["x"] + 200, a["cy"]); await asyncio.sleep(0.65)
        y1 = e["y"] + e["h"] - 4
        for i in range(1, 12): p.move(a["x"] + 200, a["cy"] + (y1 - a["cy"]) * i / 11)
        await asyncio.sleep(0.4)
        where = await p.js(f"{OPEN_GAP}?.closest('[data-list-evening]')?.dataset.listEvening")
        p.shot("t_drag_evening"); p.up(a["x"] + 200, y1); await asyncio.sleep(1.6)
        now = await p.js(f"!!document.querySelector('[data-list-evening=true] [data-todo-id=\"{first}\"]')")
        flag = await p.js(f"fetch('/api/lists/today').then(r => r.json()).then(d => (d.items||[]).find(t => t.id === '{first}')?.evening)")
        check("dragged from Today into This Evening, the list parts THERE", where == "true", f"gap is in evening={where}")
        check("and the to-do becomes an evening one", now and flag is True, f"in evening list: {now}, evening flag: {flag}")
        await dismiss(p)

    if want("keyboard"):
        await dismiss(p)
        n = await p.js("document.querySelectorAll('[data-todo-id]').length")
        r = await into_view(p, "[data-todo-id]", n - 2)      # near the end of the list
        p.tap(r["x"] + 200, r["cy"])
        opened = await p.wait("document.querySelector('.card .note')", 3); await asyncio.sleep(0.8)
        check("a to-do near the end of the list opens", opened, r)
        full = await p.js("innerHeight")
        # Bring the field on screen and let it settle: a card opened near the
        # bottom can start below the fold, and a tap there hits nothing.
        await p.js("document.querySelector('.card .note').scrollIntoView({block:'end'})")
        await p.quiet()
        nb = await p.rect(".card .note")
        would = nb["y"] + nb["h"]
        p.tap(nb["cx"], nb["cy"]); await asyncio.sleep(2.2)
        # the notes are a Markdown editor now (NotesField): what has the keyboard
        # is its own content, somewhere inside .note
        st = await p.js("""({inNote: !!document.activeElement.closest('.card .note'), bottom: Math.round(document.activeElement.getBoundingClientRect().bottom),
              innerH: innerHeight, bar: !!document.querySelector('.cardbar')})""")
        p.shot("t_keyboard")
        check("the keyboard shortens the page, so the app can see it", p.keyboard() and st["innerH"] < full, f"{full} -> {st['innerH']}")
        check("and what is being typed into is not under it",
              st["inNote"] and st["bottom"] <= st["innerH"], f"field ends at {st['bottom']}, page is {st['innerH']} tall (was at {round(would)})")
        p.back(); await asyncio.sleep(0.6)
        check("closing the keyboard gives the page its height back", await p.wait(f"innerHeight === {full}", 3))
        await dismiss(p)

    if want("fmtbar"):
        # #77: while notes are being written on a touchscreen, a bar of formats
        # sits on the keyboard, and the card's own bar gives way to it
        await dismiss(p)
        r = await into_view(p, "[data-todo-id]", 1)
        p.tap(r["x"] + 200, r["cy"])
        await p.wait("document.querySelector('.card .note')", 3); await asyncio.sleep(0.8)
        await p.js("document.querySelector('.card .note').scrollIntoView({block:'end'})")
        await p.quiet()
        check("no format bar while the notes are only read", not await p.js("!!document.querySelector('.fmtbar')"))
        nb = await p.rect(".card .note")
        p.tap(nb["cx"], nb["cy"]); await asyncio.sleep(2.2)
        up = await p.wait("document.querySelector('.fmtbar')", 3)
        st = await p.js("""(() => { const b = document.querySelector('.fmtbar'), btn = b.querySelector('button').getBoundingClientRect();
            const vv = visualViewport, cb = document.querySelector('.cardbar');
            return {bottom: b.getBoundingClientRect().bottom, buttons: btn.bottom, view: vv.offsetTop + vv.height, innerH: innerHeight,
                    dpr: devicePixelRatio, fmt: document.querySelector('.app').classList.contains('fmt'),
                    cardbar: !cb || getComputedStyle(cb).display === 'none' || cb.getBoundingClientRect().height === 0}; })()""")
        p.shot("t_fmtbar")
        check("writing the notes, the format bar is up with the keyboard", p.keyboard() and bool(up), st)
        check("the bar ends where the page does, which the keyboard shortened", abs(st["bottom"] - st["view"]) <= 1 and st["innerH"] < p.full, st)
        # on the screen itself: its buttons end at the keyboard's top edge, not under it
        web = [n for n in fc_screen().iter("node") if n.get("class") == "android.webkit.WebView"]
        ime = ime_top()
        if web and ime:
            top = int(re.findall(r"\d+", web[0].get("bounds"))[1])
            gap = ime - (top + st["buttons"] * st["dpr"])
            check("and on the screen its buttons sit on the keyboard, not under it", 0 <= gap <= 40 * st["dpr"],
                  f"{gap:.0f} px between the buttons and the keyboard (keyboard top {ime}, web view top {top})")
        check("the card's own bar gives way to it", st["fmt"] and st["cardbar"], st)
        # a format pressed by a finger keeps the keyboard and the caret
        cm = "document.querySelector('.card .notesfield .cm-content').innerText"
        before = await p.js(cm)
        bold = await p.rect(".fmtbar [data-format=bold]")
        p.tap(bold["cx"], bold["cy"]); await asyncio.sleep(0.8)
        after = await p.js(cm)
        check("a finger on Bold formats, and keeps the keyboard and the caret",
              p.keyboard() and await p.js("!!document.activeElement.closest('.card .note')") and after.count("**") > before.count("**"),
              f"{before.count('**')} -> {after.count('**')} pairs of stars")
        p.back(); await asyncio.sleep(0.8)
        check("with the keyboard gone, so is the bar", await p.wait("!document.querySelector('.fmtbar')", 3))
        await dismiss(p)

    if want("when"):
        await dismiss(p)
        r = await p.row(1)
        p.swipe(r["x"] + 90, r["cy"], r["x"] + 200, r["cy"], 260)   # a short flick, not a haul
        opened = await p.wait("document.querySelector('.pop')", 3); await asyncio.sleep(0.5)
        check("a short flick is enough to open When", opened)
        st = await p.js("""({rows: [...document.querySelectorAll('.pop .opt .lbl')].map(e => e.textContent.trim()),
           field: !!document.querySelector('.pop .in'), cells: document.querySelectorAll('.pop .cal.roll .d').length,
           star: !!document.querySelector('.pop .cal.roll .d.today .star'), head: document.querySelector('.pop .calhead').textContent.trim()})""")
        p.shot("t_when_panel")
        check("the phone's panel: Today, This Evening, Someday, Clear and the weeks ahead",
              st["rows"][:3] == ["Today", "This Evening", "Someday"] and not st["field"] and st["cells"] == 28 and st["star"], st)
        check("and it does not raise the keyboard over its own calendar", not p.keyboard())
        o = await p.rect(".pop .opt", 0); p.tap(o["cx"], o["cy"]); await asyncio.sleep(0.12)
        held = await p.js("!!document.querySelector('.pop .opt.pressed .tick')")
        check("the row it was told to use is held a moment, with a tick", held)
        check("then the panel goes", await p.wait("!document.querySelector('.pop')", 3))
        await dismiss(p)
        # a day still to come shows on the row. Not in Anytime — those have no day
        # at all — but in a list that mixes them, like a project's.
        await p.goto("/project/pmanu0001"); await p.wait("document.querySelectorAll('[data-todo-id]').length", 5)
        pills = await p.js("[...document.querySelectorAll('.row .dl.when')].map(e => e.textContent.trim())")
        check("a day still to come shows on the row", len(pills) > 0, f"{pills[:4]}")
        await p.goto("/today"); await p.wait("document.querySelector('h1.t')", 5)

    if want("card"):
        await dismiss(p)
        r = await p.rect("[data-todo-id]", 2)
        p.tap(r["x"] + 200, r["cy"]); await p.wait("document.querySelector('.card')", 3); await asyncio.sleep(0.6)
        if p.keyboard(): p.back(); await asyncio.sleep(0.6)
        st = await p.js("""({
          editing: document.querySelector('.app').classList.contains('editing'),
          l: document.querySelector('.card').getBoundingClientRect().left,
          r: document.querySelector('.card').getBoundingClientRect().right, w: innerWidth,
          dim: getComputedStyle([...document.querySelectorAll('.row')][0]).opacity,
          taps: getComputedStyle([...document.querySelectorAll('.row')][0]).pointerEvents,
          bar: !!document.querySelector('.cardbar'), fab: getComputedStyle(document.querySelector('.fab')).display,
          nav: getComputedStyle(document.querySelector('.topbar .back')).opacity,
          cb: document.querySelector('.card .cb').getBoundingClientRect().width,
          icon: document.querySelector('.card .icons button').getBoundingClientRect().height,
          dot: document.querySelector('.card .cli .dot')?.getBoundingClientRect().height || 44
        })""")
        p.shot("t_card_open")
        check("an open to-do goes edge to edge", st["l"] == 0 and st["r"] == st["w"] and st["editing"], st)
        check("the list behind it fades back and takes no taps", float(st["dim"]) < .5 and st["taps"] == "none", st)
        check("the navigation goes, and the plus gives way to Move / Delete / More",
              st["bar"] and st["fab"] == "none" and float(st["nav"]) == 0, st)
        check("and everything in it is finger-sized", st["cb"] >= 22 and st["icon"] >= 44 and st["dot"] >= 44, st)
        # the bar works
        for _ in range(8):
            if not p.keyboard(): break
            p.back(); await asyncio.sleep(0.4)
        mv = await p.rect(".cardbar .move"); p.tap(mv["cx"], mv["cy"])
        ok = await p.wait("document.querySelector('.pop')", 3)
        if not ok: p.shot("t_fail_move")
        check("Move opens the list of places", ok, f"bar at {mv}")
        await dismiss(p)
        await p.wait("!document.querySelector('.card')", 3)
        r2 = await p.row(2)
        p.tap(r2["x"] + 200, r2["cy"]); await p.wait("document.querySelector('.card')", 3); await asyncio.sleep(0.5)
        if p.keyboard(): p.back(); await asyncio.sleep(0.6)
        # a tap on the dimmed list closes it, and opens nothing. Well inside the
        # gap above the card, not on its edge.
        spot = await p.js("""(() => { const c=document.querySelector('.card').getBoundingClientRect();
            const p=document.querySelector('.content').getBoundingClientRect();
            const above=(Math.max(p.top,0)+c.top)/2, below=(c.bottom+p.bottom)/2;
            return c.top - p.top > 120 ? above : below })()""")
        before = await p.js(f"(() => {{ const e=document.elementFromPoint(160,{int(spot)}); return {{at: e && e.tagName+'.'+String(e.className).slice(0,20), inCard: !!(e&&e.closest('.card'))}} }})()")
        p.tap(160, spot)
        gone = await p.wait("!document.querySelector('.card')", 3)
        st = await p.js("({card: !!document.querySelector('.card'), editing: document.querySelector('.app').classList.contains('editing')})")
        if not gone: p.shot("t_fail_outside")
        check("a tap outside closes it, and opens nothing else", gone and not st["editing"], f"tapped y={int(spot)} on {before} -> {st}")
        # a new to-do opens with a placeholder, not the words "New To-Do" to type over
        await p.wait("!document.querySelector('.card')", 3)
        f = await p.rect(".fab"); p.tap(f["cx"], f["cy"]); await p.wait("document.querySelector('.card')", 3); await asyncio.sleep(0.6)
        v = await p.js("document.querySelector('.card .ttl')?.value")
        check("a new to-do opens empty, with the placeholder", v == "", f"title field holds {v!r}")
        await dismiss(p)
        check("and closing it without typing leaves it named New To-Do", "New To-Do" in await p.titles(40))

    if want("tap"):
        r = await p.rect("[data-todo-id]", 3); p.tap(r["x"] + 200, r["cy"]); await asyncio.sleep(0.5)
        st = await p.js("({sel: document.querySelectorAll('.row.sel').length, card: !!document.querySelector('.card')})")
        check("a tap on a row is still a tap", st["sel"] == 1 or st["card"], st)
        await dismiss(p)

    if want("tags"):
        await dismiss(p)
        today = "fetch('/api/lists/today').then(r => r.json()).then(d => Object.fromEntries((d.items||[]).map(t => [t.id, t.tags])))"
        ids = await p.js("[...document.querySelectorAll('[data-todo-id]')].slice(0, 3).map(r => r.dataset.todoId)")
        # one of the three has the tag already, so the picker has a mixed one to show
        await p.js(f"fetch('/api/todos/{ids[0]}', {{method: 'PATCH', headers: {{'content-type': 'application/json'}}, body: JSON.stringify({{tags: ['reading']}})}})")
        await asyncio.sleep(1.5)                       # the server's own push brings it to the list
        r = await p.rect("[data-todo-id]", 0)
        p.swipe(r["x"] + 300, r["cy"], r["x"] + 110, r["cy"], 350)
        await p.wait("document.querySelector('.app').classList.contains('selecting')", 2); await asyncio.sleep(0.4)
        for i in (1, 2):
            k = await p.rect(".row .pick", i); p.tap(k["cx"], k["cy"]); await asyncio.sleep(0.3)
        picked = await p.js("[...document.querySelectorAll('.row .pick.on')].map(k => k.closest('[data-todo-id]').dataset.todoId)")
        check("three to-dos chosen", sorted(picked) == sorted(ids), picked)
        b = await p.js("(() => { const b = [...document.querySelectorAll('.selbar button')].find(x => /Tags/.test(x.textContent)); const r = b.getBoundingClientRect(); return {cx: r.left + r.width / 2, cy: r.top + r.height / 2} })()")
        p.tap(b["cx"], b["cy"])
        check("the bar has Tags, and it opens the picker", await p.wait("document.querySelector('.pop .opt')", 3))
        await asyncio.sleep(0.5)
        opt = "[...document.querySelectorAll('.pop .opt')].find(o => o.querySelector('.lbl')?.textContent.trim() === 'reading')"
        st = await p.js(f"(() => {{ const o = {opt}; return o && {{some: !!o.querySelector('.some'), on: o.getAttribute('aria-selected')}} }})()")
        check("a tag only one of them has shows a dash, not a tick", st and st["some"] and st["on"] == "false", st)
        p.shot("t_tags")
        o = await p.js(f"(() => {{ const r = {opt}.getBoundingClientRect(); return {{cx: r.left + r.width / 2, cy: r.top + r.height / 2}} }})()")
        p.tap(o["cx"], o["cy"]); await asyncio.sleep(1.5)
        tags = await p.js(today)
        check("choosing it puts it on all three", all("reading" in (tags.get(i) or []) for i in ids), {i: tags.get(i) for i in ids})
        check("and the picker ticks it now", await p.js(f"{opt}?.getAttribute('aria-selected') === 'true'"))
        p.tap(o["cx"], o["cy"]); await asyncio.sleep(1.5)
        tags = await p.js(today)
        check("choosing it again takes it off all three", not any("reading" in (tags.get(i) or []) for i in ids), {i: tags.get(i) for i in ids})
        await dismiss(p)

    if want("cancel"):
        await dismiss(p)
        # the phone's one way to cancel a to-do: the open card's •••
        r = await p.row(0); tid = await p.js("document.querySelector('[data-todo-id]').dataset.todoId")
        p.tap(r["x"] + 200, r["cy"]); await p.wait("document.querySelector('.card')", 3); await asyncio.sleep(0.5)
        if p.keyboard(): p.back(); await asyncio.sleep(0.6)
        m = await p.rect('.cardbar button[aria-label="More"]'); p.tap(m["cx"], m["cy"])
        await p.wait("document.querySelector('.menu .opt')", 3); await asyncio.sleep(0.4)
        o = await p.js("(() => { const b = [...document.querySelectorAll('.menu .opt')].find(x => /Mark as Canceled/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return {cx: r.left + r.width / 2, cy: r.top + r.height / 2} })()")
        check("an open to-do's ••• has Mark as Canceled", o is not None)
        if o: p.tap(o["cx"], o["cy"]); await asyncio.sleep(1.5)
        st = await p.js(f"fetch('/api/todos/{tid}').then(r => r.json()).then(t => t.status)")
        check("and it cancels the to-do", st == "canceled", st)
        await dismiss(p)

    if want("edge"):
        await dismiss(p)
        root = "document.querySelector('.app').classList.contains('root')"
        h = await p.js("innerHeight")
        y = int(h * 0.60)                       # inside the band the shell reserves
        mid = "?"
        p.down(6, y)
        for i in range(1, 15):
            p.move(6 + i * 16, y)
            if i == 7: mid = (await p.js("getComputedStyle(document.querySelector('.app')).getPropertyValue('--drawer')")).strip()
        p.up(6 + 14 * 16, y); await asyncio.sleep(0.9)
        carried = mid not in ("", "0", "?") and 0.05 < float(mid) < 0.95
        check("a slow drag from the left edge carries the drawer with the finger", carried, f"--drawer was {mid} half way across")
        check("and letting go leaves it out", await p.js(root))
        check("the app is still in front: the system did not take it for Back", p.foreground())
        p.shot("t_edge_slow")
        p.tap(370, 300); await asyncio.sleep(0.8)
        p.swipe(6, y, 210, y, 90); await asyncio.sleep(1.2)
        check("a flick from the edge is Back, and does not leave the app", p.foreground())
        await dismiss(p)
        # Whether the edge OUTSIDE the band still goes to Android is Android's
        # business, and Samsung's answer varies; it is not ours to assert.

    if want("back"):
        root = "document.querySelector('.app').classList.contains('root')"
        await dismiss(p)
        # something open: Back closes it, and only it
        r = await p.rect("[data-todo-id]", 1); p.swipe(r["x"] + 90, r["cy"], r["x"] + 280, r["cy"], 350)
        await p.wait("document.querySelector('.pop')", 2); await asyncio.sleep(0.3)
        kb = p.keyboard()
        p.back(); await asyncio.sleep(0.6)
        st = await p.js(f"({{pop: !!document.querySelector('.pop'), root: {root}}})")
        check("Back closes an open popover, and does not bring out the drawer", not st["pop"] and not st["root"] and p.foreground(), st)
        check("opening the When popover with a swipe does not raise the keyboard", not kb)
        r = await p.rect("[data-todo-id]", 3); p.tap(r["x"] + 200, r["cy"]); await p.wait("document.querySelector('.card')", 2); await asyncio.sleep(0.3)
        p.back(); await asyncio.sleep(0.6)
        st = await p.js(f"({{card: !!document.querySelector('.card'), root: {root}}})")
        check("Back closes an open to-do", not st["card"] and not st["root"] and p.foreground(), st)
        # nothing open: Back brings out the drawer
        p.back(); await asyncio.sleep(0.7)
        check("Back on a list brings out the drawer", await p.js(root) and p.foreground())
        p.shot("t_drawer")
        # choose a list from it: the drawer goes away, and Back brings it out again, not the last list
        it = await p.js("(() => { const e=[...document.querySelectorAll('.sidebar .item')].find(e => /Anytime/.test(e.textContent)); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2} })()")
        p.tap(it["x"], it["y"]); await asyncio.sleep(0.9)
        st = await p.js(f"({{root: {root}, title: document.querySelector('h1.t')?.textContent.trim(), path: location.pathname, len: history.length, depth: history.state?.depth}})")
        check("choosing a list puts the drawer away", not st["root"] and "Anytime" in (st["title"] or ""), st)
        p.back(); await asyncio.sleep(0.7)
        st = await p.js(f"({{root: {root}, title: document.querySelector('h1.t')?.textContent.trim()}})")
        check("Back from there is the drawer again, not the list before", st["root"] and "Anytime" in (st["title"] or ""), st)
        # the scrim puts it away; the chevron brings it out; both keep history straight
        p.tap(370, 400); await asyncio.sleep(0.6)
        r = await p.rect(".topbar .back"); p.tap(r["cx"], r["cy"]); await asyncio.sleep(0.6)
        check("the chevron brings out the drawer", await p.js(root))
        d = await p.js("history.state?.depth")
        check("and history is back at the bottom", d == 0, f"depth={d}")
        # drag it shut with a finger on the panel itself
        p.swipe(250, 500, 40, 500, 300); await asyncio.sleep(0.7)
        check("the drawer can be pushed shut", not await p.js(root))
        p.back(); await asyncio.sleep(0.6)
        p.back(); await asyncio.sleep(1.0)
        check("Back from the drawer leaves the app", not p.foreground())

    bad = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} passed" + (": FAILED " + "; ".join(bad) if bad else ""))

asyncio.run(main())
