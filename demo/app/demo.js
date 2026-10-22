// The taste's entry point. It runs the real web app, frontend/src/main.js,
// unchanged, in its own local mode (lib/backend.js, ?backend=local): the
// engine answers every request in the page, from a vault in this browser's
// IndexedDB. Before the app starts, this file
//
//   1. makes sure nothing leaves the taste's own folder: fetch outside it is
//      refused, and there is no service worker, event stream or beacon;
//   2. keeps the address as it is (the app writes /today, /project/<id> into
//      it, which on stuffs would be someone else's address);
//   3. picks the browser's own vault, and fills it with the made-up one
//      (demo/vault.js) the first time, or again after "Reset the demo"
//      (?reset);
//
// and then it wires up the bar on top and the "Where to tap" sheet.
import './taste-app.css';
import { demoVault } from '../vault.js';
import { IdbStorage } from '../../engine/src/storage-idb.js';

const VAULT = 'dvarim-vault';                  // backend.js's vault in this browser
const TOURED = 'dvarim-taste.toured';
const here = new URL('./', location.href);     // …/dvarim/app/
const folder = new URL('../', here).pathname;  // …/dvarim/
const ownWindow = document.documentElement.classList.contains('taste-top');

// ---- 1. nothing leaves the folder

const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  let url;
  try {
    url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
  } catch {
    return Promise.reject(new TypeError('Dvarim demo: not an address'));
  }
  const ok = url.protocol === 'data:' || url.protocol === 'blob:'
    || (url.origin === location.origin && url.pathname.startsWith(folder));
  if (ok) return realFetch(input, init);
  // The app's /api/… is answered in the page before it gets here; anything
  // that does get here would be a request to a server, and there is none.
  return Promise.reject(new TypeError(`Dvarim demo: no server here (${url.pathname})`));
};
class NoStream {
  constructor() { this.readyState = 2; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
window.EventSource = NoStream;
try { navigator.sendBeacon = () => false; } catch { /* read-only here: nothing calls it */ }
if ('serviceWorker' in navigator) {
  // main.js registers /sw.js, the server's, for offline use. Here it would be
  // stuffs' root, so it's left out: the folder is static and small anyway.
  try {
    Object.defineProperty(navigator.serviceWorker, 'register', {
      configurable: true,
      value: () => Promise.reject(new Error('Dvarim demo: no service worker')),
    });
  } catch { /* an older browser: main.js's catch swallows the 404 */ }
}

// ---- 2. the address stays put

const pushState = history.pushState.bind(history);
const replaceState = history.replaceState.bind(history);
history.pushState = (state, title) => pushState(state, title);          // Back still walks the app's views
history.replaceState = (state, title) => replaceState(state, title);

// ---- 3. the browser's own vault, filled with the made-up one

/** Everything the app remembers on this device, but which kind of vault. */
function forgetDevice() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('dvarim.') && k !== 'dvarim.backend') localStorage.removeItem(k);
    }
  } catch { /* nothing kept to forget */ }
  document.documentElement.removeAttribute('data-theme');
}

async function prepare() {
  const reset = new URLSearchParams(location.search).has('reset');
  if (reset) {
    replaceState(history.state, '', here.pathname);
    forgetDevice();
  }
  localStorage.setItem('dvarim.backend', 'local');      // throws where storage is blocked
  const storage = new IdbStorage(VAULT);
  const { files, dirs } = await storage.list();
  if (reset) {
    for (const p of files) await storage.remove(p);
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) await storage.removeDir(d);
  }
  if (reset || !files.length) {
    for (const [path, text] of Object.entries(demoVault())) await storage.write(path, text);
    // another tab with the demo open reads the vault again (backend.js listens)
    try { new BroadcastChannel(VAULT).postMessage('changed'); } catch { /* one tab */ }
  }
}

function cannotStart(e) {
  console.error('Dvarim demo:', e);
  document.getElementById('app').innerHTML = `
    <div class="taste-fail">
      <h1>The demo can't start here</h1>
      <p>It keeps its to-dos in this browser's storage, and this browser won't let it, which a private
      window sometimes does. Try a normal window, or have a look at the pictures on the
      <a href="../">About page</a>.</p>
    </div>`;
}

prepare()
  .then(() => import('../../frontend/src/main.js'))
  .then(() => {
    if (ownWindow) firstRun();
    // main.js fetches the notes editor once the page has loaded, and here the
    // page had loaded before main.js ran: the same, a little later
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 2000));
    idle(() => import('../../frontend/src/lib/notes-editor.js').catch(() => {}));
  })
  .catch(cannotStart);

// ---- the bar and the sheets

const tour = document.getElementById('taste-tour');
const resetSheet = document.getElementById('taste-reset');

// The app listens for keys on the window (just start typing for Quick Find,
// Esc to clear), so keys pressed in a sheet stay in the sheet.
for (const sheet of [tour, resetSheet]) {
  sheet.addEventListener('keydown', (e) => e.stopPropagation());
  sheet.addEventListener('click', (e) => {                // a click on the backdrop closes it
    const r = sheet.getBoundingClientRect();
    const out = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (e.target === sheet && out && (e.clientX || e.clientY)) sheet.close('cancel');
  });
}

function open(sheet) {
  if (typeof sheet.showModal === 'function') sheet.showModal();
  else sheet.setAttribute('open', '');
}

tour.addEventListener('close', () => {
  try { localStorage.setItem(TOURED, '1'); } catch { /* shown again next time, then */ }
});
resetSheet.addEventListener('close', () => {
  if (resetSheet.returnValue === 'reset') location.replace(`${here.pathname}?reset`);
});

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-taste]');
  if (!b) return;
  if (b.dataset.taste === 'tour') open(tour);
  if (b.dataset.taste === 'reset') open(resetSheet);
});

function firstRun() {
  let seen = false;
  try { seen = localStorage.getItem(TOURED) === '1'; } catch { /* show it */ }
  if (!seen) setTimeout(() => open(tour), 600);
}
