#!/usr/bin/env python3
"""The phone's touch feel: a plus that lifts under a still finger, a press a row
answers at once, and a band the height of the row that is coming."""
import asyncio, sys, time, json
from touch import Phone, adb, check, finish


async def dismiss_pop(p):
    for _ in range(4):
        if not await p.js("!!document.querySelector('.pop') || document.querySelector('.app').classList.contains('selecting')"): return
        p.back(); await asyncio.sleep(0.6)

async def main():
    p = Phone(); await p.launch()
    await p.to_top(); await p.quiet()

    # --- the button, at rest
    st = await p.js("""(() => { const f=document.querySelector('.fab'); const r=f.getBoundingClientRect();
      const cs=getComputedStyle(f);
      return {w:r.width, h:r.height, right:innerWidth - r.right, bottom:innerHeight - r.bottom,
              shadow:cs.boxShadow, bg:cs.backgroundColor} })()""")
    print("   ", json.dumps(st))
    check("the button is a 50px disc near the corner", st["w"] == 50 and st["h"] == 50, st)
    check("and nearly flat", "0px 1px 5px" in st["shadow"], st["shadow"])

    n0 = len(await p.titles(40))
    fab = await p.rect(".fab")

    # --- held still: it lifts where it stands
    p.down(fab["cx"], fab["cy"]); time.sleep(0.42)
    mid = await p.js("""({
      ghost: !!document.querySelector('.plusghost'),
      fab: getComputedStyle(document.querySelector('.fab')).visibility,
      inbox: !!document.querySelector('.plustarget.inbox'),
      cancel: !!document.querySelector('.plustarget.cancel'),
      gaps: document.querySelectorAll('.listgap').length,
      gx: document.querySelector('.plusghost')?.getBoundingClientRect().left ?? -1,
      gy: document.querySelector('.plusghost')?.getBoundingClientRect().top ?? -1
    })""")
    check("a still finger lifts it in its corner", mid["ghost"] and mid["fab"] == "hidden" and mid["inbox"] and mid["cancel"], mid)
    check("and the list stays shut until it goes somewhere", mid["gaps"] == 0, mid)
    if mid["ghost"]:
        near = abs(mid["gx"] + 25 - fab["cx"]) < 12 and abs(mid["gy"] + 25 - fab["cy"]) < 12
        check("the disc springs up where the button was, not away from it", near,
              f"ghost centre {mid['gx']+25:.0f},{mid['gy']+25:.0f} vs button {fab['cx']:.0f},{fab['cy']:.0f}")
    p.up(fab["cx"], fab["cy"]); await asyncio.sleep(1.4)
    p.shot("p_still")
    n1 = len(await p.titles(40))
    st2 = await p.js("({card: !!document.querySelector('.card'), gaps: document.querySelectorAll('.listgap').length})")
    check("letting go without moving makes a to-do, as a tap would", n1 == n0 + 1, f"{n0} -> {n1}")
    check("and nothing is left open behind it", st2["gaps"] == 0, st2)

    # --- the band is one plain row tall
    for _ in range(8):
        if not p.keyboard(): break
        adb("shell", "input", "keyevent", "BACK"); await asyncio.sleep(0.4)
    if await p.js("!!document.querySelector('.card')"): p.back(); await asyncio.sleep(0.8)
    await p.to_top(); await p.quiet()
    fab = await p.rect(".fab")
    row = await p.row(2)
    p.down(fab["cx"], fab["cy"]); time.sleep(0.32)
    for i in range(1, 7):
        p.move(fab["cx"] - (fab["cx"] - row["cx"]) * i / 6, fab["cy"] - (fab["cy"] - row["cy"]) * i / 6)
        time.sleep(0.04)
    await asyncio.sleep(0.35)      # the band opens over .18s; measure it open
    band = await p.js("""(() => { const g=document.querySelector('.listgap'); if(!g) return null;
      const r=g.getBoundingClientRect(); const cs=getComputedStyle(g);
      const rows=[...document.querySelectorAll('.content .row')].filter(x=>!x.querySelector('.sub'));
      return {h:r.height, w:r.width, vw:innerWidth, radius:cs.borderRadius,
              plain: rows.length ? rows[0].getBoundingClientRect().height : null} })()""")
    p.shot("p_band")
    p.up(row["cx"], row["cy"]); await asyncio.sleep(1.6)
    print("   ", json.dumps(band))
    check("the band is the height of the row that is coming", band and band["plain"] and abs(band["h"] - band["plain"]) <= 2, band)
    check("and a flat strip right across the list", band and band["w"] >= band["vw"] - 14 and band["radius"].startswith("3px"), band)

    # --- a row answers the finger at once
    for _ in range(8):
        if not p.keyboard(): break
        adb("shell", "input", "keyevent", "BACK"); await asyncio.sleep(0.4)
    if await p.js("!!document.querySelector('.card')"): p.back(); await asyncio.sleep(0.8)
    await p.to_top(); await p.quiet()
    row = await p.row(1)
    # adb hands the phone a touch about a quarter of a second before the page
    # hears about it, so this waits for the answer rather than sampling once —
    # and then scrolls at once, inside the window before the 420ms hold lifts
    # the row instead.
    p.down(row["cx"], row["cy"])
    pressed = {"on": False}
    end = time.time() + 1.5
    while time.time() < end:
        pressed = await p.js("""(() => { const r=document.querySelector('.row.pressed'); return r ? {on:true, bg:getComputedStyle(r).backgroundColor} : {on:false} })()""")
        if pressed["on"]: break
        await asyncio.sleep(0.04)
    on = pressed["on"]
    check("a finger on a row is answered before it lifts", on and pressed["on"], pressed)
    p.up(row["cx"], row["cy"]); await asyncio.sleep(0.8)
    if await p.js("!!document.querySelector('.card')"):
        p.back(); await asyncio.sleep(0.8)
    await p.to_top(); await p.quiet()

    # …and a scroll takes it away again. Sent on a clock rather than on the
    # sight of the slab: the round trip to look would spend the whole window
    # between the slab (60ms) and the lift (300ms).
    row = await p.row(1)
    top0 = await p.js("document.querySelector('.content').scrollTop")
    p.down(row["cx"], row["cy"]); time.sleep(0.10)
    for i in range(1, 6):
        p.move(row["cx"], row["cy"] - 16 * i); time.sleep(0.02)
    p.up(row["cx"], row["cy"] - 80); await asyncio.sleep(0.9)
    st = await p.js("""({grey: !!document.querySelector('.row.pressed'), top: document.querySelector('.content').scrollTop, card: !!document.querySelector('.card'), pop: !!document.querySelector('.pop')})""")
    p.shot("p_pressed")
    check("a scroll is a scroll, not a lift", st["top"] > top0 and not st["card"] and not st["pop"], st)
    check("and nothing is left grey behind it", not st["grey"], st)

    # --- the swiped row: the band stays, the writing moves off the tab
    await p.to_top(); await p.quiet()
    row = await p.row(1)
    at_rest = await p.js("""(() => { const r=[...document.querySelectorAll('[data-todo-id]')].filter(x=>!x.matches('.card'))[1];
      const b=r.getBoundingClientRect(); const body=r.querySelector('.body').getBoundingClientRect();
      return {left:b.left, right:b.right, body:body.left} })()""")
    p.down(row["x"] + 90, row["cy"])
    for i in range(1, 8):
        p.move(row["x"] + 90 + 26 * i, row["cy"]); time.sleep(0.03)
    held = await p.js("""(() => { const r=[...document.querySelectorAll('[data-todo-id]')].filter(x=>!x.matches('.card'))[1];
      const b=r.getBoundingClientRect(); const body=r.querySelector('.body').getBoundingClientRect();
      const tab=r.querySelector('.swipeic.whentab'); const t=tab.getBoundingClientRect();
      return {left:b.left, right:b.right, body:body.left, tabLeft:t.left, tabVisible:getComputedStyle(tab).visibility,
              clip:getComputedStyle(tab).clipPath} })()""")
    p.shot("p_swiped")
    p.up(row["x"] + 90 + 26 * 7, row["cy"])
    await asyncio.sleep(1.0)
    await dismiss_pop(p)
    print("   ", json.dumps(at_rest), "->", json.dumps(held))
    check("the grey band stays where it is", abs(held["left"] - at_rest["left"]) < 2 and abs(held["right"] - at_rest["right"]) < 2,
          f"{at_rest['left']:.0f}..{at_rest['right']:.0f} -> {held['left']:.0f}..{held['right']:.0f}")
    check("and only what is written on it moves", held["body"] - at_rest["body"] > 20, held)
    check("the tab is uncovered at the row's own edge", abs(held["tabLeft"] - at_rest["left"]) < 2 and held["tabVisible"] == "visible", held)

    return finish()

sys.exit(asyncio.run(main()))
