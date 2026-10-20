#!/usr/bin/env python3
"""The raw-note view: the project menu opens it, it shows the real Markdown,
and an edit saved there comes back through the app.

    tools/e2e_source.py --url http://172.19.0.1:8422
"""
import argparse, asyncio, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_smoke import Browser, check, FAILURES, refuse_live_data

SEL = "textarea[aria-label='Markdown source']"


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--devtools", default="http://172.19.0.16:9222")
    ap.add_argument("--password-file")
    args = ap.parse_args()
    # This one writes to the notes it opens, so it must never see real ones.
    refuse_live_data(None, args.url)
    URL = args.url
    pw = Path(args.password_file).read_text().strip() if args.password_file else None

    async with Browser(args.devtools) as b:
        await b.goto(URL + "/today")
        await asyncio.sleep(3)
        if pw and await b.js("return !!document.querySelector('#pw');"):
            await b.js("const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},"
                       "body:JSON.stringify({password:%r})}); return r.status;" % pw)
            await asyncio.sleep(1)
        pid = await b.js("const r=await fetch('/api/state'); const s=await r.json(); return s.areas[0].projects[0].id;")
        await b.goto(URL + "/project/" + pid)
        check("the project view loads", bool(await b.wait_for("!!document.querySelector('h1.t')", timeout=20)))

        await b.js("document.querySelector('h1.t .more').click(); return true;")
        await asyncio.sleep(1)
        labels = await b.js("return [...document.querySelectorAll('.menu .opt, .pop .opt')].map(o=>o.textContent.trim());")
        check("the project menu opens at all", len(labels) > 3, str(labels))
        # The Obsidian entry only exists when the server knows a vault name
        # (DVARIM_OBSIDIAN_VAULT), which a throwaway copy normally does not.
        vault = await b.js("const r=await fetch('/api/projects/%s'); const d=await r.json();"
                           "return !!(d.project && d.project.obsidian);" % pid)
        if vault:
            check("it offers Open in Obsidian", any('Obsidian' in l for l in labels), str(labels))
        else:
            print("  (no Obsidian vault configured here, so no Obsidian entry — correct)")
        check("it offers the source editor", any('note itself' in l for l in labels), str(labels))
        print("  menu:", labels)

        await b.js("[...document.querySelectorAll('.menu .opt, .pop .opt')].find(o=>o.textContent.includes('note itself'))?.click(); return true;")
        await asyncio.sleep(3)
        check("the source sheet opens", bool(await b.js("return !!document.querySelector(%r);" % SEL)))
        text = await b.js("return document.querySelector(%r)?.value || '';" % SEL)
        check("it shows the real Markdown", text.startswith('---') and '\U0001f194' in text, text[:90])
        print("  header:", await b.js("return document.querySelector('[role=dialog] .p')?.textContent;"))
        print("  meta  :", await b.js("return document.querySelector('[role=dialog] .meta')?.textContent;"))

        await b.js(
            "const t=document.querySelector(%r);"
            "const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
            "set.call(t, t.value + '- [ ] Written in the source editor\\n');"
            "t.dispatchEvent(new Event('input',{bubbles:true})); return true;" % SEL)
        await asyncio.sleep(0.6)
        disabled = await b.js("return [...document.querySelectorAll('[role=dialog] button')].find(x=>x.textContent.trim()==='Save')?.disabled;")
        check("Save becomes available", not disabled)
        await b.js("[...document.querySelectorAll('[role=dialog] button')].find(x=>x.textContent.trim()==='Save')?.click(); return true;")
        await asyncio.sleep(3)
        print("  after save:", await b.js("return document.querySelector('[role=dialog] .meta')?.textContent;"))
        got = await b.js("const r=await fetch('/api/projects/%s'); const d=await r.json(); return d.items.some(t=>t.title==='Written in the source editor');" % pid)
        check("the app picked up the edit", bool(got))

        # tidy up: remove the line again through the same editor
        await b.js(
            "const t=document.querySelector(%r);"
            "const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
            "set.call(t, t.value.split('\\n').filter(l=>!l.includes('Written in the source editor')).join('\\n'));"
            "t.dispatchEvent(new Event('input',{bubbles:true})); return true;" % SEL)
        await asyncio.sleep(0.5)
        await b.js("[...document.querySelectorAll('[role=dialog] button')].find(x=>x.textContent.trim()==='Save')?.click(); return true;")
        await asyncio.sleep(2.5)
        gone = await b.js("const r=await fetch('/api/projects/%s'); const d=await r.json(); return !d.items.some(t=>t.title==='Written in the source editor');" % pid)
        check("and removing it there removes it here", bool(gone))
    print()
    print("failed:", FAILURES or "none")
    return 1 if FAILURES else 0

if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
