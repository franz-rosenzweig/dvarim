#!/usr/bin/env python3
"""The Android app's own reminders, and the ticks it makes without the page.

A to-do whose ⏰ has just passed is caught up on when the app re-reads the
list, and its reminder comes up in the shade. With the server gone, Complete
on that reminder is kept on the phone (Outbox.java) rather than lost, and it
reaches the server, filed under today, once the server is back. Turned off in
the app's own Settings, a reminder that is due stays quiet; turned back on,
it comes.

The shade is driven the way a person drives it: pulled down, and Complete
pressed where uiautomator says it is. The test build's native pieces talk to
the development server DevActivity shows (DevBuild.java), never the real one.
"""
import asyncio, datetime, os, re, sys, time
import xml.etree.ElementTree as ET

from touch import Phone, PKG, adb, app_user, check, finish
from offline import fresh, plane, land, get, send

APK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../android/app/build/outputs/apk/debug/app-debug.apk")


def java_hash(s):
    """String.hashCode(), which is what OutboxJob's id is."""
    h = 0
    for ch in s: h = (31 * h + ord(ch)) & 0xFFFFFFFF
    return h - (1 << 32) if h >= 1 << 31 else h


def resync():
    """Reinstalling is a MY_PACKAGE_REPLACED, which BootReceiver answers by
    sending what waits and re-reading the list — the hourly re-read, now."""
    adb("install", "-r", "--user", app_user(), APK)


def prefs(name):
    return adb("shell", "run-as", PKG, "--user", app_user(), "cat", f"shared_prefs/{name}.xml", check=False)


def shade(title, secs=15):
    """Whether a notification with this title is up."""
    end = time.time() + secs
    while time.time() < end:
        if title in adb("shell", "dumpsys", "notification", "--noredact", check=False): return True
        time.sleep(0.5)
    return False


def screen():
    adb("shell", "uiautomator", "dump", "/sdcard/dvarim-ui.xml", check=False)
    return ET.fromstring(adb("shell", "cat", "/sdcard/dvarim-ui.xml"))


def find(test, secs=6):
    """The first node on screen that passes `test`, once the screen has drawn one."""
    end = time.time() + secs
    while time.time() < end:
        hit = [n for n in screen().iter("node") if test(n)]
        if hit: return hit
        time.sleep(0.4)
    return []


def centre(node):
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds")))
    return (x1 + x2) // 2, (y1 + y2) // 2


def press_complete(title):
    """Pull the shade down, draw this reminder open — a notification shows its
    buttons only then — and press Complete: the button nearest below its title."""
    adb("shell", "cmd", "statusbar", "expand-notifications")
    heads = find(lambda n: n.get("text") == title)
    if not heads: return False
    x, y = centre(heads[0])
    adb("shell", "input", "swipe", str(x), str(y), str(x), str(y + 380), "400")
    buttons = find(lambda n: (n.get("text") or "").strip().lower() == "complete")
    heads = find(lambda n: n.get("text") == title)
    if not heads or not buttons: return False
    _, ty = centre(heads[0])
    below = sorted((b for b in buttons if centre(b)[1] > ty), key=lambda b: centre(b)[1] - ty)
    if not below: return False
    x, y = centre(below[0])
    adb("shell", "input", "tap", str(x), str(y)); time.sleep(1.5)
    adb("shell", "cmd", "statusbar", "collapse")
    return True


def under(title):
    """What the shade shows on the line under a notification's title."""
    adb("shell", "cmd", "statusbar", "expand-notifications")
    heads = find(lambda n: n.get("text") == title)
    lines = None
    if heads:
        _, ty = centre(heads[0])
        lines = [n.get("text") for n in screen().iter("node") if n.get("text") and 0 < centre(n)[1] - ty < 90]
    adb("shell", "cmd", "statusbar", "collapse")
    return lines


def flip_reminders():
    """The switch on the app's own Settings screen, by a finger — scrolled to
    first: below Where your to-dos live and the server, it is off a phone's
    first screen, and uiautomator sees only what is on it."""
    adb("shell", "am", "start", "--user", app_user(), "-n", f"{PKG}/xyz.tiresia.dvarim.SettingsActivity")
    is_switch = lambda n: (n.get("resource-id") or "").endswith(":id/remind")
    hit = find(is_switch, secs=3)
    for _ in range(3):
        if hit: break
        adb("shell", "input", "swipe", "540", "1800", "540", "700", "300"); time.sleep(0.6)
        hit = find(is_switch, secs=2)
    if hit:
        x, y = centre(hit[0])
        adb("shell", "input", "tap", str(x), str(y)); time.sleep(1.0)
    adb("shell", "input", "keyevent", "BACK")
    return bool(hit)


def due_a_moment_ago(title):
    """A to-do for today whose reminder went off two minutes ago, by the phone's clock."""
    at = (datetime.datetime.now() - datetime.timedelta(minutes=2)).strftime("%H:%M")
    return send("POST", "/todos", {"title": title, "inbox": True, "when": get("/lists/today")["date"], "reminder": at})["id"]


async def main():
    fresh()
    # Cleared, the test build has lost the permission the real app asks for on
    # its first launch; a person says yes there, so this does.
    adb("shell", "pm", "grant", "--user", app_user(), PKG, "android.permission.POST_NOTIFICATIONS", check=False)
    p = Phone(); await p.launch()             # DevActivity: the native pieces now follow localhost
    today = get("/lists/today")["date"]
    # The sample, dated to today (sample_vault.py), has reminders of its own due
    # today — Read 20 minutes in Hebrew, ⏰ 16:00 — and caught up on as well,
    # they group this check's out of sight in the shade.
    for t in get("/lists/today")["items"]:
        if t.get("reminder"): send("PATCH", f"/todos/{t['id']}", {"reminder": None})
    adb("logcat", "-c")

    one = due_a_moment_ago("Reminder check one")
    resync()
    check("a reminder due a moment ago is caught up on when the list is re-read", shade("Reminder check one"))
    line = under("Reminder check one")
    check("and an Inbox to-do has nothing under its title, not the word null", line is not None and "null" not in line, line)

    plane()
    pressed = press_complete("Reminder check one")
    check("its Complete button can be pressed, with the server gone", pressed)
    kept = prefs("dvarim.outbox")
    check("the tick is kept on the phone, not lost", one in kept, kept.strip()[-160:])
    check("and the reminder leaves the shade", not shade("Reminder check one", secs=2))

    land()
    # the job waiting for a network runs now, rather than after its backoff
    adb("shell", "cmd", "jobscheduler", "run", "-f", "-u", app_user(), PKG, str(java_hash("dvarim.outbox")), check=False)
    done = None
    for _ in range(40):
        t = get(f"/todos/{one}")
        if t["status"] == "done": done = t; break
        time.sleep(0.5)
    check("once the server is back, it arrives: completed", done is not None)
    check("filed under the day it was ticked", done and done.get("completed") == today, done and done.get("completed"))
    check("and nothing is left waiting", one not in prefs("dvarim.outbox"))

    # the switch
    check("the app's Settings has a switch for its reminders", flip_reminders())
    check("turned off, it says so", 'name="enabled" value="false"' in prefs("dvarim.reminders"))
    two = due_a_moment_ago("Reminder check two")
    resync()
    check("off, a reminder that is due stays quiet", not shade("Reminder check two", secs=6))
    flip_reminders()
    check("turned back on, it comes", shade("Reminder check two"))
    send("POST", f"/todos/{two}/complete", {})
    adb("shell", "cmd", "statusbar", "collapse", check=False)
    crashed = [l for l in adb("logcat", "-d", "-s", "AndroidRuntime:E").splitlines() if "FATAL" in l or PKG in l]
    check("and the app never fell over doing any of it", not crashed, crashed[:3])
    return finish()

sys.exit(asyncio.run(main()))
