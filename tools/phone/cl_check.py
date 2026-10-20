#!/usr/bin/env python3
"""The checklist, under a thumb: what a ticked item looks like, that the grip is
there instead of the X, and — the thing the change hangs on — whether the
phone's own Return really does make the next item now that the standing
"Add checklist item" row is gone."""
import asyncio, sys, time, json
from touch import Phone, adb, check, finish


async def main():
    p = Phone(); await p.launch()
    await p.js("""(async () => {
      await fetch('/api/todos/vs0002bb', {method:'PATCH', headers:{'content-type':'application/json'},
        body: JSON.stringify({checklist:[{text:'Alpha',done:false},{text:'Beta',done:true}]})});
    })()""")
    await p.goto('/today'); await asyncio.sleep(0.8)
    await p.js("location.reload()"); await asyncio.sleep(2.5)
    await p.wait("document.querySelector('[data-todo-id=\"vs0002bb\"]')", 8)

    r = await p.js("""(() => { const e=document.querySelector('[data-todo-id="vs0002bb"]').getBoundingClientRect();
        return {cx:e.left+e.width/2, cy:e.top+e.height/2} })()""")
    p.tap(r["cx"], r["cy"])
    ok = await p.wait("document.querySelector('.card .cli')", 4)
    check("the card opens with its checklist", ok)
    if not ok: return finish()
    await asyncio.sleep(0.7)   # let the row-to-card grow finish; it is a scale

    st = await p.js("""(() => {
      const cl=[...document.querySelectorAll('.card .cli')];
      const done=cl.find(c=>c.classList.contains('done'));
      const dot=done.querySelector('.dot');
      const inp=done.querySelector('input');
      return {
        n: cl.length,
        dotH: dot.getBoundingClientRect().height,
        ring: getComputedStyle(dot,'::before').opacity,
        tick: getComputedStyle(dot,'::after').opacity,
        tickColor: getComputedStyle(dot,'::after').borderBottomColor,
        strike: getComputedStyle(inp).textDecorationLine,
        label: getComputedStyle(inp).color,
        grey: getComputedStyle(document.documentElement).getPropertyValue('--text3').trim(),
        grip: !!done.querySelector('.grip'),
        gripH: done.querySelector('.grip').getBoundingClientRect().height,
        gripVisible: getComputedStyle(done.querySelector('.grip')).opacity,
        rm: document.querySelectorAll('.card .cli .rm').length,
        addRow: document.querySelectorAll('.card .cli.new').length,
      } })()""")
    print("   ", json.dumps(st))
    check("a ticked item is a grey tick, not a blue disc", st["ring"] == "0" and st["tick"] == "1", st)
    check("and its label is grey with no line through it", st["strike"] == "none", st)
    check("the X is gone and a grip is there, thumb-sized", st["rm"] == 0 and st["grip"] and st["gripH"] >= 44, st)
    check("no standing 'Add checklist item' row", st["addRow"] == 0, st)
    check("the circle is still a thumb's worth of target", st["dotH"] >= 44, st)
    p.shot("cl_card")

    # --- Return makes the next item: the phone's own key, through its own IME.
    box = await p.js("""(() => { const i=[...document.querySelectorAll('.card .cli input')].pop();
        const e=i.getBoundingClientRect(); return {cx:e.left+e.width/2, cy:e.top+e.height/2} })()""")
    p.tap(box["cx"], box["cy"])
    await asyncio.sleep(1.2)
    check("tapping an item raises the keyboard", p.keyboard())
    n0 = await p.js("document.querySelectorAll('.card .cli').length")
    adb("shell", "input", "keyevent", "66")   # KEYCODE_ENTER, through the input pipeline
    await asyncio.sleep(0.8)
    n1 = await p.js("document.querySelectorAll('.card .cli').length")
    check("Return makes the next item", n1 == n0 + 1, f"{n0} -> {n1}")
    p.shot("cl_after_return")

    # and an emptied row goes when it saves
    if n1 > n0:
        adb("shell", "input", "keyevent", "67")  # DEL on the empty new row
        await asyncio.sleep(0.8)
        n2 = await p.js("document.querySelectorAll('.card .cli').length")
        check("Backspace in an empty row deletes it", n2 == n0, f"{n1} -> {n2}")

    # --- the grip really drags, with a finger, through the phone's own
    #     scroll-vs-gesture arbitration. touch-action:none on the grip is the
    #     only thing keeping the list still under it.
    for _ in range(6):
        if not p.keyboard(): break
        # one BACK, for the keyboard only: p.back() spends a second one on the
        # card and would close it.
        adb("shell", "input", "keyevent", "BACK"); await asyncio.sleep(0.5)
    await asyncio.sleep(0.5)
    before = await p.js("[...document.querySelectorAll('.card .cli input')].map(i=>i.value)")
    g = await p.js("""(() => { const c=[...document.querySelectorAll('.card .cli')];
        const a=c[0].querySelector('.grip').getBoundingClientRect();
        return {cx:a.left+a.width/2, cy:a.top+a.height/2, pitch:c[0].getBoundingClientRect().height,
                top: document.querySelector('.content').scrollTop} })()""")
    ys = [g["cy"] + d for d in (0, 6, 14, 24, 34, 44, 52)]
    p.down(g["cx"], ys[0]); time.sleep(0.05)
    for y in ys[1:]:
        p.move(g["cx"], y); time.sleep(0.05)
    mid = await p.js("[...document.querySelectorAll('.card .cli')].map(c=>c.classList.contains('lifted'))")
    p.up(g["cx"], ys[-1])
    await asyncio.sleep(1.0)
    after = await p.js("[...document.querySelectorAll('.card .cli input')].map(i=>i.value)")
    top = await p.js("document.querySelector('.content').scrollTop")
    p.shot("cl_dragged")
    check("the held row says so while it moves", any(mid), mid)
    check("a finger on the grip reorders the list", after == before[::-1] if len(before) == 2 else after != before,
          f"{before} -> {after}")
    check("and the list did not scroll under it", abs(top - g["top"]) < 2, f"{g['top']} -> {top}")
    await asyncio.sleep(0.8)
    await p.js("location.reload()"); await asyncio.sleep(2.5)
    r2 = await p.js("""(() => { const e=document.querySelector('[data-todo-id="vs0002bb"]').getBoundingClientRect();
        return {cx:e.left+e.width/2, cy:e.top+e.height/2} })()""")
    p.tap(r2["cx"], r2["cy"]); await p.wait("document.querySelector('.card .cli')", 4); await asyncio.sleep(0.6)
    kept = await p.js("[...document.querySelectorAll('.card .cli input')].map(i=>i.value)")
    check("the new order is what was written", kept == after, f"{after} -> {kept}")

    return finish()

sys.exit(asyncio.run(main()))
