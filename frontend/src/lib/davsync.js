// Built-in sync, in local mode (docs/SYNC.md, "Built-in sync"): this device's
// vault kept in step with a folder on a server — a Dvarim server's own, or any
// WebDAV server (Nextcloud, Synology…). The engine does the work
// (engine/src/webdav.js); this decides when, and remembers where.
//
// When: on opening, whenever the window comes back to the front, a few seconds
// after a change here, and every five minutes while in front.
//
// Where, and the password or token, are kept in this browser's own storage on
// this device, never in the vault: the vault is what gets synced.

const KEY = 'dvarim.sync';
const EVERY = 5 * 60 * 1000;
let AFTER_CHANGE = 4000;

let local = null;                  // backend.js's { store, storage, ... }
let sync = null;                   // the engine's WebDavSync, when configured
let timer = null, periodic = null;
let changedDuring = false;
// A vault that has never synced with this server, filled by its first round a
// file at a time, lists its files in the order they came; opened, in the
// order of their paths, as the server has them, and a list breaks ties by it.
// So once that round is done, it is read again, as opening would.
let rebuildAfter = false;

/** This sync has nothing agreed yet: its first round fills the vault. */
async function neverSynced(s) {
  try { return !Object.keys((await s._loadState()).files).length; } catch { return false; }
}
// `offline`: the last round could not reach the server, as against one it refused
const status = { state: 'off', at: null, result: null, error: null, offline: false };
const watchers = new Set();

function tell() { for (const cb of watchers) { try { cb({ ...status }); } catch { /* a watcher must not stop a sync */ } } }

/** The saved choice: null, or { kind: 'dvarim', address, token } | { kind: 'webdav', url, user, password }. */
export function syncConfig() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** A Dvarim server's address, as typed, to its WebDAV folder. */
export function davUrl(address) {
  let a = String(address || '').trim();
  if (a && !/^https?:\/\//iu.test(a)) a = 'https://' + a;
  return a.replace(/\/+$/u, '').replace(/\/dav$/u, '') + '/dav/';
}

function options(cfg) {
  if (cfg.kind === 'dvarim') return { url: davUrl(cfg.address), token: cfg.token };
  return { url: cfg.url, user: cfg.user, password: cfg.password };
}

/** Follow the sync's state: { state: off|idle|syncing|error, at, result, error }. */
export function watchSync(cb) {
  watchers.add(cb);
  cb({ ...status });
  return () => watchers.delete(cb);
}

/** One round now. Resolves to its result; a failure is kept in the status, and thrown. */
export async function syncNow() {
  if (!sync) throw new Error('sync is not set up on this device');
  clearTimeout(timer);
  status.state = 'syncing';
  tell();
  changedDuring = false;
  try {
    const result = await sync.sync();
    Object.assign(status, { state: 'idle', at: Date.now(), result, error: null, offline: false });
    if (rebuildAfter && local) {
      rebuildAfter = false;
      local.store.rebuild();
      local.store.notify([]);
    }
    if (mirror) { markMirror(mirror); retryIn = RETRY_FIRST; }
    return result;
  } catch (e) {
    // no answer at all, or the tunnel's for a server that is not there
    const offline = !e || !e.status || [502, 503, 504].includes(e.status);
    Object.assign(status, { state: 'error', error: e && e.message ? e.message : String(e), offline });
    // A mirror signed in by the page's cookie: an expired session is the sign-in
    // screen, and the sync stops, because whoever signs in next may be somebody
    // else, and their cookie must never carry this copy. The page loads again.
    if (mirror && e && e.status === 401) {
      stopMirror();
      window.dispatchEvent(new CustomEvent('dvarim:unauthorized'));
    }
    // and one that could not reach its server tries again by itself, less often the longer it is away
    if (mirror && offline) {
      clearTimeout(retry);
      retry = setTimeout(() => { if (sync) syncNow().catch(() => {}); }, retryIn);
      retryIn = Math.min(retryIn * 2, RETRY_MOST);
    }
    throw e;
  } finally {
    tell();
    // changed while the round ran (by a person, or by the round itself): once more, soon
    if (changedDuring) soon();
  }
}

function soon() {
  clearTimeout(timer);
  timer = setTimeout(() => { if (sync) syncNow().catch(() => {}); }, AFTER_CHANGE);
}

async function build(cfg) {
  const { WebDavSync } = await import('@engine/webdav.js');
  // a shell that makes requests itself is not held to CORS (docs/BRIDGE.md, op http)
  const info = local.info || {};
  const fetchFn = info.http && local.storage.httpFetch ? local.storage.httpFetch() : undefined;
  return new WebDavSync(local.store, { ...options(cfg), fetch: fetchFn });
}

/** Save a choice (null: stop syncing) and, if there is one, sync at once. */
export async function configure(cfg) {
  try {
    if (cfg) localStorage.setItem(KEY, JSON.stringify(cfg));
    else localStorage.removeItem(KEY);
  } catch { /* private mode: in effect until the page closes */ }
  window.dispatchEvent(new CustomEvent('dvarim:sync-config', { detail: cfg }));
  if (!cfg) {
    sync = null;
    Object.assign(status, { state: 'off', at: null, result: null, error: null });
    tell();
    return null;
  }
  sync = await build(cfg);
  rebuildAfter = await neverSynced(sync);
  return syncNow();
}

/** Called once the local vault is open (backend.js). */
export async function startSync(backend) {
  local = backend;
  local.store.listeners.push(() => {
    if (!sync) return;
    if (status.state === 'syncing') changedDuring = true;
    else soon();
  });
  const front = () => document.visibilityState === 'visible';
  const stale = () => !status.at || Date.now() - status.at > 30000;
  document.addEventListener('visibilitychange', () => { if (sync && front() && stale()) syncNow().catch(() => {}); });
  window.addEventListener('online', () => { if (sync) syncNow().catch(() => {}); });
  periodic = setInterval(() => { if (sync && front()) syncNow().catch(() => {}); }, EVERY);
  // an app that keeps its own copy says where it syncs (info.sync); otherwise Settings → Sync did
  const cfg = (local.info && local.info.sync) || syncConfig();
  if (!cfg) return;
  try {
    sync = await build(cfg);
    rebuildAfter = await neverSynced(sync);
    status.state = 'idle';
    tell();
    setTimeout(() => syncNow().catch(() => {}), 1500);     // after the first screen is up
  } catch (e) {
    Object.assign(status, { state: 'error', error: e && e.message ? e.message : String(e) });
    tell();
  }
}

// ---- the mirror (backend.js): the server's own page keeping a copy of its
// vault on this device, so that every list and every change works with no
// network, and syncing with the server it came from whenever it can. Over
// /dav/ at the same address, signed in by the page's own cookie, so there is
// no token to make and nothing to set up. Each person's copy is its own.

let mirror = null;                 // the copy's name, while there is one
let stream = null;
const RETRY_FIRST = 10000, RETRY_MOST = 120000;
let retryIn = RETRY_FIRST, retry = null;

/** When this copy last synced, or null if it never has: { at }. */
export function mirrorState(name) {
  try {
    const v = JSON.parse(localStorage.getItem(`dvarim.mirror:${name}`) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
function markMirror(name) {
  try { localStorage.setItem(`dvarim.mirror:${name}`, JSON.stringify({ at: Date.now() })); } catch { /* not kept: synced again next time */ }
}
export function forgetMirrorState(name) {
  try { localStorage.removeItem(`dvarim.mirror:${name}`); } catch { /* nothing kept */ }
}

/** Starts the mirror's sync. With `first` (a copy that has never synced) the
 *  first round is awaited, and if it fails the mirror is stopped and the
 *  error thrown: half a copy is not shown as if it were the whole. */
export async function startMirror(backend, { first = false } = {}) {
  const { WebDavSync } = await import('@engine/webdav.js');
  local = backend;
  mirror = backend.info.name;
  AFTER_CHANGE = 1500;
  // the page's own cookie signs it in: the same address, the same session
  sync = new WebDavSync(local.store, { url: `${location.origin}/dav/`, credentials: 'same-origin' });
  status.state = 'idle';
  tell();
  if (first) {
    try {
      await syncNow();
    } catch (e) {
      stopMirror();
      throw e;
    }
    // Filled a file at a time, the store lists its files in the order they
    // came; opened, in the order of their paths, as the server has them. The
    // order of a list breaks ties by it, so read it all again, as opening would.
    local.store.rebuild();
    local.store.notify([]);
  }
  local.store.listeners.push(() => {
    if (!sync) return;
    if (status.state === 'syncing') changedDuring = true;
    else soon();
  });
  const front = () => document.visibilityState === 'visible';
  document.addEventListener('visibilitychange', () => { if (sync && front()) syncNow().catch(() => {}); });
  window.addEventListener('online', () => { if (sync) syncNow().catch(() => {}); });
  periodic = setInterval(() => { if (sync && front()) syncNow().catch(() => {}); }, EVERY);
  listenToServer();
  if (!first) setTimeout(() => { if (sync) syncNow().catch(() => {}); }, 300);
}

/** The server's own stream says when something there changed (Obsidian, a
 *  phone, a Tasks.org tick): a round soon after. It reconnects by itself, and
 *  coming back after a gap means the server is back, so a round then too. */
function listenToServer() {
  if (typeof EventSource === 'undefined') return;
  let wait = null;
  const pull = (ms) => { clearTimeout(wait); wait = setTimeout(() => { if (sync) syncNow().catch(() => {}); }, ms); };
  try {
    stream = new EventSource('/api/stream');
  } catch {
    return;
  }
  // Connected again after a gap, or for the first time after a round that
  // could not reach it (opened with no server): the server is back.
  let opened = false;
  stream.onopen = () => { if (opened || status.offline || status.state === 'error') pull(200); opened = true; };
  stream.addEventListener('changed', () => pull(300));
}

export function stopMirror() {
  sync = null;
  mirror = null;
  clearTimeout(timer);
  clearTimeout(retry);
  clearInterval(periodic);
  if (stream) { stream.close(); stream = null; }
  Object.assign(status, { state: 'off', at: null, result: null, error: null, offline: false });
  tell();
}
