using System.Text.Json;

namespace Dvarim;

/// <summary>What the window puts in the page before the page's own scripts run (WebView2's document-created scripts).</summary>
static class Scripts
{
    /// <summary>
    /// In the app's own pages only (<paramref name="origins"/>), and only in the top frame:
    /// <list type="bullet">
    /// <item><c>window.DvarimStorage</c>, the folder bridge with Android's transport, which the
    /// page already speaks (engine/src/storage-bridge.js): request(id, json), answered by
    /// window.__dvarimStorageReply. Only in the page served from inside the app, and only
    /// when there is a folder behind it (<paramref name="storage"/>).</item>
    /// <item><c>window.__dvarimShell = { copy: true }</c> in the server's page while the copy
    /// waits for a sign-in (<paramref name="signingIn"/>), so it keeps no copy of its own.</item>
    /// <item><c>window.DvarimShell.postMessage(json)</c>, the page asking the app
    /// (frontend/src/lib/shell.js, askShell): "Keep a full copy on this device".</item>
    /// <item>The other way: the app asking the page (window.dvarim.request) for the
    /// notification area's Today, Quick Entry and reminders.</item>
    /// <item>The window's own keys.</item>
    /// </list>
    /// </summary>
    public static string Shell(IEnumerable<string> origins, bool storage, bool signingIn) => $$"""
        (() => {
          const ours = {{JsonSerializer.Serialize(origins)}};
          const wv = window.chrome && window.chrome.webview;
          if (window.top !== window || !wv || !ours.includes(location.origin)) return;
          const post = (m) => wv.postMessage(m);
          const inside = location.origin === {{JsonSerializer.Serialize(AppScheme.Origin)}};

          if ({{(storage ? "true" : "false")}} && inside) {
            window.DvarimStorage = Object.freeze({ request: (id, json) => post({ channel: 'storage', id, json: String(json) }) });
          }
          if ({{(signingIn ? "true" : "false")}} && !inside) window.__dvarimShell = Object.freeze({ copy: true });
          window.DvarimShell = Object.freeze({ postMessage: (json) => post({ channel: 'shell', json: String(json) }) });

          // window.dvarim (lib/shell.js) is there once the page's first module has run;
          // its request() waits by itself for the to-dos to be open
          const ready = new Promise((resolve) => {
            const look = () => (window.dvarim && typeof window.dvarim.request === 'function') ? resolve() : setTimeout(look, 100);
            look();
          });
          ready.then(() => post({ channel: 'ready' }));

          wv.addEventListener('message', (e) => {
            const m = e.data;
            if (!m || typeof m !== 'object') return;
            if (m.channel === 'storage') {
              if (window.__dvarimStorageReply) window.__dvarimStorageReply(m.id, m.reply);
              return;
            }
            const answer = (id, p) => p.then((r) => post({ channel: 'answer', id, status: r.status, body: r.body === undefined ? null : r.body }),
                                             (err) => post({ channel: 'answer', id, error: String((err && err.message) || err) }));
            if (m.channel === 'ask') {
              answer(m.id, ready.then(() => window.dvarim.request(m.method, m.path, m.body === null ? undefined : m.body)));
            }
            // the vault on this PC (lib/backend.js, window.__dvarimLocal): its last writes
            // on disk before Dvarim quits, or a sync round while the window is put away
            if (m.channel === 'local' && ['flush', 'sync'].includes(m.what)) {
              const local = window.__dvarimLocal;
              answer(m.id, Promise.resolve()
                .then(() => (local && typeof local[m.what] === 'function' ? local[m.what]() : null))
                .then(() => ({ status: local && typeof local[m.what] === 'function' ? 200 : 404, body: null })));
            }
            // the menus' keys, as the page has them now (Settings › Keyboard can rebind any)
            if (m.channel === 'commands') {
              answer(m.id, ready.then(() => ({ status: 200, body: window.dvarim.commands() })));
            }
            if (m.channel === 'textSize') textSize(m.step);
          });

          // The text's size, as in any Windows app: Ctrl and + or - (either row of keys),
          // Ctrl+0 for the usual size, and Ctrl with the mouse wheel or a pinch on the
          // touchpad. Each goes to the page's own text size (Settings › General), never
          // the browser's zoom, which would make the whole window bigger.
          const textSize = (step) => {
            if (window.dvarim && typeof window.dvarim.textSize === 'function') window.dvarim.textSize(step);
          };
          window.addEventListener('keydown', (e) => {
            if (!e.ctrlKey || e.altKey || e.metaKey) return;
            const step = (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+') ? 1
              : (e.code === 'Minus' || e.code === 'NumpadSubtract') ? -1
              : ((e.code === 'Digit0' || e.code === 'Numpad0') && !e.shiftKey) ? 0 : null;
            if (step === null) return;
            e.preventDefault();
            textSize(step);
          }, true);
          let wheel = 0;
          window.addEventListener('wheel', (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            wheel += e.deltaY;
            if (Math.abs(wheel) < 50) return;
            textSize(wheel < 0 ? 1 : -1);
            wheel = 0;
          }, { capture: true, passive: false });

          // The menus' keys, as in any Windows app: Alt and a menu's letter opens it
          // (File, Edit, To-Do, View, Help), and Alt alone, pressed and let go, puts the
          // keyboard on the menu bar. Only if the page leaves them alone.
          const letters = ['F', 'E', 'T', 'V', 'H'];
          let altAlone = false;
          window.addEventListener('keydown', (e) => {
            if (e.key === 'Alt') { altAlone = !e.ctrlKey && !e.shiftKey && !e.metaKey; return; }
            altAlone = false;
            if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || (e.getModifierState && e.getModifierState('AltGraph'))) return;
            const m = /^Key([A-Z])$/.exec(e.code || '');
            if (m && letters.includes(m[1])) setTimeout(() => { if (!e.defaultPrevented) post({ channel: 'window', what: 'menu', letter: m[1] }); }, 0);
          }, true);
          window.addEventListener('keyup', (e) => {
            if (e.key === 'Alt' && altAlone) { altAlone = false; post({ channel: 'window', what: 'menu' }); }
          }, true);
          window.addEventListener('blur', () => { altAlone = false; });

          // The window's own keys, if the page leaves them alone: Ctrl+W puts the window
          // away (Dvarim stays in the notification area), F11 is full screen. AltGr is
          // Ctrl+Alt on many keyboards and types letters, so it never counts.
          const shellKey = (e) => {
            if (e.getModifierState && e.getModifierState('AltGraph')) return null;
            if (e.key === 'F11' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return 'fullScreen';
            if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyW') return 'hide';
            return null;
          };
          window.addEventListener('keydown', (e) => {
            const what = shellKey(e);
            if (what) setTimeout(() => { if (!e.defaultPrevented) post({ channel: 'window', what }); }, 0);
          }, true);
        })();
        """;
}
