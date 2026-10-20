#!/usr/bin/env python3
"""The web app's Settings → Data offers a way out to the Android shell's own
settings (android/shell/.../SettingsActivity.java), and only inside the shell.

On a phone that has both builds, the link opens the real app's settings rather
than this test build's: dvarim://settings belongs to the release build, and a
test build answers dvarim-debug:// (android/shell/apply.sh, settings_scheme).
Either way a SettingsActivity must come forward, and it is closed again after."""
import asyncio, sys

from touch import Phone, adb, check, finish


def focus():
    return adb("shell", "dumpsys", "window").split("mCurrentFocus")[1].split("\n")[0]


async def main():
    p = Phone(); await p.launch()
    check("the page knows it is inside the Android shell", await p.js("/;\\s*wv\\)/.test(navigator.userAgent)"))
    await p.js("window.dvarim.run('settings.open')")
    check("the Settings sheet opens", await p.wait("document.querySelector('.sheet')", 4))
    await p.js("[...document.querySelectorAll('.panes button')].find(b => /data/i.test(b.textContent)).click()")
    await asyncio.sleep(0.6)
    link = await p.js("""(() => { const a = document.querySelector('a.native'); if (!a) return null;
        a.scrollIntoView({block: 'center'}); const r = a.getBoundingClientRect();
        return {href: a.getAttribute('href'), cx: r.left + r.width / 2, cy: r.top + r.height / 2}; })()""")
    check("Settings → Data has the way out to the app's own settings", link and link["href"] == "dvarim://settings", link)
    if not link: return finish()
    await asyncio.sleep(0.4)
    p.tap(link["cx"], link["cy"])
    for _ in range(20):
        if "SettingsActivity" in focus(): break
        await asyncio.sleep(0.3)
    check("tapping it brings the shell's settings forward", "SettingsActivity" in focus(), focus().strip())
    adb("shell", "input", "keyevent", "BACK")             # and back to where it was
    return finish()

sys.exit(asyncio.run(main()))
