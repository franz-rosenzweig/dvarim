#!/usr/bin/env python3
"""The Settings sheet, clear of the clock and the camera — the same thing Quick
Find had to learn."""
import asyncio, sys, json
from touch import Phone, check, finish


async def main():
    p = Phone(); await p.launch()
    await p.to_top(); await p.quiet()
    chev = await p.js("""(() => { const b=document.querySelector('.topbar .back');
        if (!b) return null; const r=b.getBoundingClientRect(); return {cx:r.left+r.width/2, cy:r.top+r.height/2} })()""")
    p.tap(chev["cx"], chev["cy"]); await asyncio.sleep(1.0)
    check("the drawer is out", await p.wait("document.querySelector('.app').classList.contains('root')", 3))
    g = await p.js("""(() => { const b=[...document.querySelectorAll('button')].find(x =>
        (x.getAttribute('aria-label')||'').match(/setting/i) || (x.title||'').match(/setting/i));
        if (!b) return null; const r=b.getBoundingClientRect(); return {cx:r.left+r.width/2, cy:r.top+r.height/2} })()""")
    if not g: raise SystemExit("no settings button found")
    p.tap(g["cx"], g["cy"])
    ok = await p.wait("document.querySelector('.sheet')", 4)
    check("Settings opens", ok)
    if not ok: return finish()
    await asyncio.sleep(0.6)
    st = await p.js("""(() => { const s=document.querySelector('.sheet'); const r=s.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;
      const probe = document.createElement('div');
      probe.style.cssText='position:fixed;top:0;height:env(safe-area-inset-top);width:1px';
      document.body.appendChild(probe);
      const safe = probe.getBoundingClientRect().height; probe.remove();
      return {top: r.top, bottom: r.bottom, safe, vh: innerHeight} })()""")
    p.shot("set_sheet")
    print("   ", json.dumps(st))
    check("its top is below the status bar, not under it", st["top"] >= st["safe"] + 6,
          f"sheet at {st['top']:.0f}, the inset ends at {st['safe']:.0f}")
    check("and it still fits on the screen", st["bottom"] <= st["vh"] - 2, st)
    return finish()

sys.exit(asyncio.run(main()))
