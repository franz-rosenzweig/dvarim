// A door for a native shell to knock on.
//
// The macOS app is a window around this page, and on a Mac a command that is
// not in the menu bar may as well not exist: ⇧⌘Y is undiscoverable until
// something writes "Log Completed Items ⇧⌘Y" down. But the menu must not become
// a second, drifting copy of the keymap — Settings → Keyboard can rebind any of
// these, and a menu that still claims the old key would be worse than no menu.
//
// So the shell asks. `commands()` hands over the live table, ids, labels and
// whatever each one is bound to right now; `run(id)` performs one by id, so a
// rebinding changes the key without breaking the menu item. The action is
// delivered as the keystroke it would have been, which keeps App.svelte the
// only place that decides what a command does.
import { KEYMAP, bindingsFor } from './keys.js';

const CODES = {
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  enter: 'Enter', escape: 'Escape', space: 'Space', backspace: 'Backspace',
  delete: 'Delete', tab: 'Tab', ',': 'Comma', '/': 'Slash'
};

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * True inside the Android shell, which renders this page in a WebView rather
 * than in a browser: Android marks a WebView's user agent with "; wv)", and
 * Chrome on the same phone does not.
 *
 * The shell has settings of its own that this page cannot show — which server
 * it opens, whether Android is letting its reminders through — because a page
 * served by that server is the wrong place to change which server it is. All
 * the page can do is point at them, and only when there is something to point
 * at. See android/shell/src/java/.../SettingsActivity.java.
 */
export const IN_ANDROID_SHELL =
  typeof navigator !== 'undefined' && /;\s*wv\)/.test(navigator.userAgent);

/** True inside the web-view macOS shell, which named itself in the user agent.
 *  It was retired on 2026-10-22 for the native Mac app, which draws its own
 *  screens and shows no page; this stays false everywhere since. */
export const IN_MAC_SHELL =
  typeof navigator !== 'undefined' && /\(macOS shell/.test(navigator.userAgent);

/** True inside the Windows app (windows/), which names itself in the user agent
 *  as `Dvarim/<version> (Windows shell)`. Its own settings — where the to-dos
 *  live, which server, Quick Entry's shortcut, starting with Windows, reminders —
 *  open at dvarim://settings, which the app answers itself. */
export const IN_WINDOWS_SHELL =
  typeof navigator !== 'undefined' && /\(Windows shell\)/.test(navigator.userAgent);

/**
 * Open an address outside the app: a link in a note.
 *
 * In a browser that is a new tab. Both shells already send a link that leaves
 * the server's origin to the system — the Mac's WebView.swift hands window.open
 * to the default browser, and on Android the page is rendered by
 * android-browser-helper, which turns any navigation off the page's origin into
 * an ACTION_VIEW intent (the same road Settings → Data's dvarim:// link takes).
 * On Android that road is a link being followed rather than window.open, so
 * there it is one: an anchor, clicked, in this window.
 */
export function openExternal(url) {
  if (typeof document === 'undefined' || !url) return;
  if (IN_ANDROID_SHELL) {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.click();
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/** A combo from the keymap, as the KeyboardEvent that matchKey() would match. */
function asEvent(combo) {
  const parts = combo.split('+');
  const key = parts.pop().toLowerCase();
  const mod = parts.includes('Mod');
  let code = CODES[key] || key;
  if (/^[a-z]$/.test(key)) code = 'Key' + key.toUpperCase();
  else if (/^\d$/.test(key)) code = 'Digit' + key;
  return new KeyboardEvent('keydown', {
    key: key === 'space' ? ' ' : key,
    code,
    // Mod is ⌘ here and Ctrl elsewhere, and matchKey accepts either.
    metaKey: mod && IS_MAC,
    ctrlKey: mod && !IS_MAC,
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt'),
    bubbles: true,
    cancelable: true
  });
}

export function installShellBridge() {
  if (typeof window === 'undefined') return;
  // The Mac app's window has no title bar: the page runs to the top and the
  // traffic lights sit over its sidebar. It says so in its user agent, and the
  // page makes the room (`.chromeless` in app.css).
  if (/\(macOS shell; chromeless\)/.test(navigator.userAgent)) document.documentElement.classList.add('chromeless');
  window.dvarim = {
    /** Every command, with its label and the key it answers to at this moment. */
    commands() {
      return KEYMAP.map((k) => ({ id: k.id, label: k.label, combo: bindingsFor(k.id)[0] || null }));
    },
    /** Run one by id. False if it has been unbound from Settings → Keyboard. */
    run(id) {
      const combo = bindingsFor(id)[0];
      if (!combo) return false;
      window.dispatchEvent(asEvent(combo));
      return true;
    },
    /**
     * Any API route, answered by whoever answers this page: the engine on this
     * device's folder, or the server. For a shell whose menu bar, Quick Entry
     * or widget needs the lists when the to-dos live in a folder and there is
     * no server to ask (phase 6): `await window.dvarim.request('GET',
     * '/api/lists/today')` → { status, body }. Asked before the vault is
     * open, it waits for it.
     */
    async request(method, path, body) {
      const { whenReady } = await import('./backend.js');
      const local = await whenReady();
      if (local) return local.api.handle(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
      const res = await fetch(path, {
        method, credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let out = null;
      try { out = await res.json(); } catch { /* no body */ }
      return { status: res.status, body: out };
    }
  };
}

/**
 * Ask the shell to do something only it can, such as switching from the
 * server's page to a copy of the vault kept in the app ({ type: 'useCopy' }).
 * The Mac's handler is `dvarim`; Android's JavaScript interface is
 * `DvarimShell`, which takes the message as JSON, and the Windows app puts an
 * object of the same name in the page. False if there is no shell to ask.
 */
export function askShell(msg) {
  try {
    if (typeof window === 'undefined') return false;
    if (window.webkit?.messageHandlers?.dvarim) { window.webkit.messageHandlers.dvarim.postMessage(msg); return true; }
    if (window.DvarimShell?.postMessage) { window.DvarimShell.postMessage(JSON.stringify(msg)); return true; }
  } catch { /* no shell to ask after all */ }
  return false;
}

/** The server's own page inside an app that keeps its own copy of the vault
 *  (a user script sets window.__dvarimShell = { copy: true }): the page keeps
 *  no copy of its own, and asks the app for its copy instead. */
export const SHELL_KEEPS_COPY = typeof window !== 'undefined' && !!(window.__dvarimShell && window.__dvarimShell.copy);
