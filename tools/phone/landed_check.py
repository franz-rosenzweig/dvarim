#!/usr/bin/env python3
"""Closing a card: the row it shrinks back into is still paper for a moment, the
When grid's columns line up with their own headings, and the lift is quicker."""
import asyncio, sys, json
from touch import Phone, adb, check, finish


async def main():
    p = Phone(); await p.launch()
    await p.to_top(); await p.quiet()

    # --- the When grid lines up with its own headings
    r = await p.row(1)
    p.swipe(r["x"] + 90, r["cy"], r["x"] + 280, r["cy"], 350)
    ok = await p.wait("document.querySelector('.pop .cal.roll')", 3)
    check("a swipe opens the When panel", ok)
    if ok:
        cal = await p.js("""(() => { const cal=document.querySelector('.pop .cal.roll'); const heads=[...document.querySelectorAll('.pop .cal b')].map(b=>b.textContent); const cells=[...cal.querySelectorAll('.d')].map(d=>d.getAttribute('aria-label')); const day=(s)=>s.slice(0,3); const T=new Date(); const tm=new Date(T.getTime()+86400000); const names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; return {head0:heads[0], startsOn:cells[0][0], head0raw:heads[0],         first:cells[0], tomorrow:cells.findIndex(c=>c && c.startsWith(names[tm.getDay()]) && c.includes(' '+tm.getDate()+' '))} })()""")
        print("   ", json.dumps(cal))
        check("the grid starts on the day its first heading names", cal["startsOn"] == cal["head0"], cal)
        check("and tomorrow is in the first row", 0 <= cal["tomorrow"] < 7, cal)
        p.back(); await asyncio.sleep(0.8)

    # --- a card that closes leaves paper behind, then nothing
    await p.to_top(); await p.quiet()
    r = await p.row(1)
    p.tap(r["cx"], r["cy"])
    check("the card opens", await p.wait("document.querySelector('.card')", 4))
    await asyncio.sleep(0.8)
    for _ in range(6):
        if not p.keyboard(): break
        adb("shell", "input", "keyevent", "BACK"); await asyncio.sleep(0.5)
    adb("shell", "input", "keyevent", "BACK")     # close the card
    await asyncio.sleep(0.12)
    st = await p.js("""({landed: !!document.querySelector('.titem.landed'), card: !!document.querySelector('.card')})""")
    check("the row it shrinks into is still paper", st["landed"], st)
    await asyncio.sleep(0.9)
    late = await p.js("""({landed: !!document.querySelector('.titem.landed'), sel: !!document.querySelector('.row.sel')})""")
    check("and a moment later it is a row like any other", not late["landed"] and not late["sel"], late)


    # --- the Move / Delete capsule is not there while the keyboard is
    await p.to_top(); await p.quiet()
    r = await p.row(1)
    p.tap(r["cx"], r["cy"])
    check("the card opens again", await p.wait("document.querySelector('.card')", 4))
    await asyncio.sleep(0.9)
    # a tap on the title raises the keyboard
    t = await p.js("""(() => { const e=document.querySelector('.card .ttl').getBoundingClientRect(); return {cx:e.left+e.width/2, cy:e.top+e.height/2} })()""")
    p.tap(t["cx"], t["cy"])
    for _ in range(14):
        if p.keyboard(): break
        await asyncio.sleep(0.2)
    await asyncio.sleep(0.9)
    typing = await p.js("""(() => { const b=document.querySelector('.cardbar'); return {bar: !!b && getComputedStyle(b).display !== 'none', kb: document.querySelector('.app').classList.contains('kb')} })()""")
    p.shot("l_typing")
    check("the capsule goes while the keyboard is up", typing["kb"] and not typing["bar"], typing)
    adb("shell", "input", "keyevent", "BACK")      # the keyboard only
    for _ in range(14):
        if not p.keyboard(): break
        await asyncio.sleep(0.2)
    await asyncio.sleep(1.0)
    back = await p.js("""(() => { const b=document.querySelector('.cardbar'); return {bar: !!b && getComputedStyle(b).display !== 'none', kb: document.querySelector('.app').classList.contains('kb')} })()""")
    check("and comes back when it goes", back["bar"] and not back["kb"], back)

    return finish()

sys.exit(asyncio.run(main()))
