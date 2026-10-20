/* Dvarim service worker: the app itself, all of it, so that it opens and every
 * part of it works with no network (the mirror, lib/backend.js, has the data).
 * Data never comes from here: /api and /dav always go to the network.
 *
 * The build fills in BUILD and FILES (vite.config.js, precache): every file
 * the build made, so a part never opened while online (the notes editor, the
 * engine) is here too when it is first wanted offline. A new build is a new
 * sw.js, so it installs again, and the caches of the old one go. */
const BUILD = 'dev';
const FILES = [];
const VERSION = `dvarim-${BUILD}`;
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL)
        // one file the server will not give is no reason to keep the old build
        .then(() => Promise.all(FILES.map((f) => cache.add(f).catch(() => {})))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: network only, never cached (SSE and JSON must be live). The same for
  // the vault over WebDAV: a sync handed yesterday's copy of a note would
  // merge against it as if it were the server's (lib/davsync.js).
  if (url.pathname.startsWith('/api/') || url.pathname === '/dav' || url.pathname.startsWith('/dav/')) return;

  // Navigations: network first so a new build is picked up, cached shell when offline.
  // The network, not the browser's HTTP cache: fetch(req) was answered from it
  // with a shell cached on a guess, which names the old bundles, so the Mac and
  // Android apps could show the previous build until the guess ran out. A new
  // request for the same address, because a navigation's own cannot be changed.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(new Request(req.url, { cache: 'no-store', credentials: 'same-origin' }))
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets (hashed bundles, icons, manifest): cache first, fill on miss.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && (res.type === 'basic' || res.type === 'default')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
