#!/usr/bin/env python3
"""A dropped row should not vanish: it slides onto the room the list opened for
it, and only then do the shadow and the slab go."""
import asyncio, sys, time
from touch import Phone, check, finish


async def main():
    p = Phone(); await p.launch()
    await p.to_top(); await p.quiet()
    ids = """[...document.querySelectorAll('[data-todo-id]')].filter(e=>!e.matches('.card')).map(e=>e.dataset.todoId)"""
    ids_before = await p.js(ids)
    a = await p.row(0); b = await p.row(3)
    # lift row 0 and carry it down past row 3
    p.down(a["cx"], a["cy"]); time.sleep(0.75)          # past the 420ms hold
    for i in range(1, 9):
        p.move(a["cx"], a["cy"] + (b["cy"] - a["cy"]) * i / 8); time.sleep(0.04)
    await asyncio.sleep(0.28)     # the room opens over .18s
    held = await p.js("""({card: !!document.querySelector('.drag-card'),
                          gap: Math.round(document.querySelector('.listgap')?.getBoundingClientRect().height || 0)})""")
    check("it is lifted, with room open under it", held["card"] and held["gap"] > 20, held)
    p.up(a["cx"], b["cy"])
    # a tenth of a second in, the card should still be there and moving
    await asyncio.sleep(0.12)
    mid = await p.js("""(() => { const c=document.querySelector('.drag-card'); const g=document.querySelector('.listgap');
      if (!c) return {card:false};
      const cs=getComputedStyle(c);
      return {card:true, settling:c.classList.contains('settling'), top:c.getBoundingClientRect().top,
              gapTop:g ? g.getBoundingClientRect().top : null, gap:g ? Math.round(g.getBoundingClientRect().height) : 0,
              shadow:cs.boxShadow} })()""")
    check("the card is still there, settling", mid["card"] and mid.get("settling"), mid)
    check("and the room is still open under it", mid.get("gap", 0) > 20, mid)
    # The shadow is whole while the card travels and goes only once it is
    # down: the two together are what make it read as landing rather than
    # disappearing.
    await asyncio.sleep(0.16)
    fading = await p.js("""(() => { const c=document.querySelector('.drag-card'); return c ? getComputedStyle(c).boxShadow : null })()""")
    p.shot("s_settling")   # a screencap costs half a second: after the readings
    await asyncio.sleep(1.1)
    after_st = await p.js("""({card: !!document.querySelector('.drag-card'),
                              gaps: document.querySelectorAll('.listgap').length,
                              ghost: document.querySelectorAll('.row.ghosted').length})""")
    p.shot("s_landed")
    check("then the card, the room and the ghost are all gone", not after_st["card"] and after_st["gaps"] == 0 and after_st["ghost"] == 0, after_st)
    ids_after = await p.js(ids)
    moved = ids_before[0]
    check("and the row is where it was dropped", ids_after.index(moved) >= 2,
          f"{moved} was 0, is now {ids_after.index(moved)}")
    check("the shadow is whole while it travels", "0.22" in (mid.get("shadow") or ""), mid.get("shadow"))
    check("and fading once it is down", bool(fading) and "0.22" not in fading, fading)

    return finish()

sys.exit(asyncio.run(main()))
