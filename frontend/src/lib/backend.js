// Who answers the app's requests: the server, as always, or this page itself.
//
// Every request the app makes goes through lib/api.js's req(). With a server,
// that is fetch(). In local mode it is the engine (engine/src/api.js) — the
// same routes, answered from a vault this device keeps for itself — so the
// lists, the outbox, the offline copies and every screen work unchanged, and
// nothing needs a network. See docs/ROADMAP.md, phases 2 and 3.
//
// Which one, in order:
//   1. a native shell that hands the page a folder (docs/BRIDGE.md): the Mac's
//      WebKit message handler or Android's JavaScript interface;
//   2. ?backend=local, remembered on this device — a vault in this browser's
//      IndexedDB, of its own;
//   3. ?backend=server, remembered — the server alone, as the app always was,
//      with copies of the lists it has seen and an outbox for the rest;
//   4. otherwise the mirror: the server's vault, copied to this device and
//      kept in step with it (docs/SYNC.md, "The mirror"). Every list and every
//      change works with no network, and syncs when there is one. That is what
//      the browser, the Mac app and the Android app all get from the server's
//      own page.
// The engine is loaded only when one of these needs it.
//
// A folder has other writers — Obsidian, Syncthing, the server on the far
// side of a sync — so in local mode the vault is read again whenever the shell
// says it changed, whenever this window comes back to the front, and every so
// often while it is in front. A browser vault's only other writer is another
// tab, which says so over a BroadcastChannel.

import { startSync, startMirror, stopMirror, mirrorState, forgetMirrorState, syncNow, syncConfig, davUrl } from './davsync.js';
import { SHELL_KEEPS_COPY } from './shell.js';

const KEY = 'dvarim.backend';
const MIRROR = 'dvarim-mirror';

/** In a mirror, what only the server can answer: who you are, other people,
 *  devices, the zip of its folder, its calendars, reminders and to-do mirror.
 *  Everything else is answered on this device. */
export const SERVER_ONLY = /^\/(auth|login|logout|password|people|tokens|requests|join|export|calendar|calendars|reminders|tasksync|health)(\/|\?|$)/u;

let local = null;          // { api, store, storage, kind, info } in local mode

export const isLocal = () => local !== null;
export const localBackend = () => local;

// Settled once setupBackend has decided, however it ends: with this device's
// vault, or null for the server. A shell may ask window.dvarim.request before
// the vault is open, and must get its answer from the vault, not the origin.
// The device's own calendars are shown only once turned on in Settings →
// Calendar, on this device: turning them on is what makes the shell ask the
// system for permission.
const DEVICE_CALENDARS = 'dvarim.deviceCalendars';
export function deviceCalendarsShown() {
  try { return localStorage.getItem(DEVICE_CALENDARS) === 'on'; } catch { return false; }
}
export function showDeviceCalendars(on) {
  try {
    if (on) localStorage.setItem(DEVICE_CALENDARS, 'on');
    else localStorage.removeItem(DEVICE_CALENDARS);
  } catch { /* private mode: for as long as the page is open */ }
  if (local) local.store.notify([]);                     // the lists ask again
}

let decided;
const ready = new Promise((resolve) => { decided = resolve; });
export const whenReady = () => ready;

/** Where the vault is, for Settings → Data: its kind, and for a folder what
 *  the shell says about it ({ name, detail, canPick, canUseServer }). */
export function where() {
  if (!local) return { kind: 'server' };
  return { kind: local.kind, ...(local.info || {}) };
}

/** A shell has a folder for this page: checked without loading anything. */
function shellHasFolder() {
  try {
    return !!(window.dvarimStorage || window.webkit?.messageHandlers?.dvarimStorage || window.DvarimStorage);
  } catch {
    return false;
  }
}

function wanted() {
  try {
    const q = new URLSearchParams(location.search).get('backend');
    if (q === 'local' || q === 'server' || q === 'mirror') {
      localStorage.setItem(KEY, q);
      // the address keeps no trace of the switch: a bookmark should not flip it back
      const url = new URL(location.href);
      url.searchParams.delete('backend');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }
    // an app that keeps its own copy: its page of the server keeps none
    if (SHELL_KEEPS_COPY) return 'server';
    const v = localStorage.getItem(KEY);
    return v === 'local' || v === 'server' ? v : 'mirror';
  } catch {
    return 'server';                       // nowhere to keep a copy either
  }
}

/** The server's page that has not opened its mirror yet: signed out when it
 *  loaded, so it did not know whose copy to open. Signing in reloads it. */
export const mirrorWanted = () => typeof window !== 'undefined' && !shellHasFolder() && wanted() === 'mirror';

/** Come back to the server, or go to this browser's own vault; reloads.
 *  Inside a shell with a folder, the shell decides, and is asked. */
export function switchTo(kind) {
  if (local && local.kind === 'device') {
    if (kind === 'server' && local.storage.useServer) return local.storage.useServer();
    return undefined;
  }
  try { localStorage.setItem(KEY, kind); } catch { /* the reload will ask again */ }
  location.reload();
  return undefined;
}

/** Ask the shell for another folder. It reloads the page if one is chosen. */
export function pickFolder() {
  if (local && local.kind === 'device' && local.storage.pick) return local.storage.pick();
  return undefined;
}

/** Run the storage contract's checks on this vault, in a scratch folder
 *  under .dvarim/ that is removed afterwards. */
export async function checkVault(log) {
  if (!local) throw new Error('not in local mode');
  const { conformance } = await import('@engine/storage-conformance.js');
  return conformance(local.storage, { log });
}

let lastProblem = 0;
function vaultProblem(message) {
  console.error('Dvarim:', message);
  if (Date.now() - lastProblem < 5000) return;          // one at a time, not one per file
  lastProblem = Date.now();
  window.dispatchEvent(new CustomEvent('dvarim:vault-problem', { detail: { message } }));
}

/** Decide, and in local mode open the vault. Called once, before the app mounts. */
export async function setupBackend() {
  try {
    await openBackend();
  } finally {
    decided(local);
  }
}

async function openBackend() {
  if (typeof window === 'undefined') return;
  const inShell = shellHasFolder();
  if (!inShell && wanted() === 'mirror') return openMirror();
  if (!inShell && wanted() !== 'local') return;
  const engine = await import('@engine/index.js');
  const { Api } = await import('@engine/api.js');
  let storage, kind, info = null;
  if (inShell) {
    const { detectNativeStorage } = await import('@engine/storage-bridge.js');
    storage = detectNativeStorage(window);
    kind = storage.kind || 'device';
    info = storage.info ? await storage.info() : null;
  } else {
    const { IdbStorage } = await import('@engine/storage-idb.js');
    storage = new IdbStorage('dvarim-vault');
    kind = 'browser';
  }
  const store = await engine.Store.open(storage, {
    tutorial: true,                 // a brand-new vault starts with "Meet Dvarim" (engine/src/tutorial.js)
    onWriteError: (e, op) => vaultProblem(`could not save ${op.path || op.from || 'a change'}: ${e && e.message ? e.message : e}`),
  });
  // a shell with the device's calendars answers for them, as a server's CalDAV
  // would, once they are turned on here
  const services = info && info.calendars && storage.calendarServices
    ? storage.calendarServices({ enabled: deviceCalendarsShown }) : {};
  const api = new Api(store, services);
  local = { api, store, storage, kind, info, engine, server: serverOf((info && info.sync) || syncConfig(), storage, info) };
  // Settings → Sync changed where it syncs (lib/davsync.js, configure)
  window.addEventListener('dvarim:sync-config', (e) => { if (local) local.server = serverOf((info && info.sync) || e.detail, storage, info); });
  installFetchShim(api);
  watchForOthers(store, kind, info);
  // the built-in sync, if this device was set up for one (Settings → Sync)
  startSync(local).catch((e) => vaultProblem(`could not start syncing: ${e && e.message ? e.message : e}`));
  // for the browser suites (tools/e2e_local.py, e2e_folder.py) and the shells'
  // selftests, which check the Markdown itself and the storage underneath
  window.__dvarimLocal = {
    kind,
    snapshot: async () => { await store.flush(); return storage.snapshot ? storage.snapshot() : null; },
    flush: () => store.flush(),
    rescan: () => store.scanChanges(),
    conformance: () => checkVault(),
  };
}

/** Read the vault again when someone else may have changed it. */
function watchForOthers(store, kind, info) {
  let running = null, again = false;
  const rescan = () => {
    if (running) { again = true; return running; }
    running = store.scanChanges()
      .catch((e) => vaultProblem(`could not read the vault: ${e && e.message ? e.message : e}`))
      .finally(() => {
        running = null;
        if (again) { again = false; rescan(); }
      });
    return running;
  };
  let timer = null;
  // the shell calls this when its folder changes (FSEvents on the Mac)
  window.__dvarimFilesChanged = () => {
    clearTimeout(timer);
    timer = setTimeout(rescan, 250);          // a sync writes several files at once
  };
  const front = () => document.visibilityState === 'visible';
  document.addEventListener('visibilitychange', () => { if (front()) rescan(); });
  window.addEventListener('focus', rescan);
  if (kind === 'device') {
    // for shells that cannot hear their folder change (Android's document
    // providers do not say); a Mac shell with FSEvents can ask for 0
    const every = info && typeof info.pollSeconds === 'number' ? info.pollSeconds : 30;
    if (every > 0) setInterval(() => { if (front()) rescan(); }, every * 1000);
  }
  // a shell with its own lists to keep up (menu bar, badge, reminders,
  // widgets) hears of every change, however made, a second after the last
  if (kind === 'device' && info && info.changes && typeof local.storage.changed === 'function') {
    let pending = new Set(), later = null;
    store.listeners.push((paths) => {
      for (const p of paths || []) pending.add(p);
      clearTimeout(later);
      later = setTimeout(() => {
        const batch = [...pending];
        pending = new Set();
        store.flush().then(() => local.storage.changed(batch));        // on disk before anyone reads it
      }, 1000);
    });
  }
  if ((kind === 'browser' || kind === 'mirror') && 'BroadcastChannel' in window) {
    const channel = new BroadcastChannel(kind === 'mirror' ? info.name : 'dvarim-vault');
    channel.onmessage = () => window.__dvarimFilesChanged();
    // after this tab's own writes have landed, tell the others
    store.listeners.push(() => { store.flush().then(() => channel.postMessage('changed')); });
  }
}

/** In local mode, a fetch('/api/…') is answered by the engine too, so nothing
 *  that asks the old way — a component, a test — is left talking to nobody. */
function installFetchShim(api) {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return real(input, init);
    if (local && local.kind === 'mirror' && SERVER_ONLY.test(url.pathname.slice(4))) return real(input, init);
    const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    let body;
    if (init.body !== undefined && init.body !== null) {
      try { body = JSON.parse(init.body); } catch { body = undefined; }
    }
    const res = await api.handle(method, url.pathname + url.search, body);
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  };
}

// ---- the mirror

/** fetch, given up on after `ms`. */
function fetchFor(ms, url, init = {}) {
  const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  return fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, ...(ctl ? { signal: ctl.signal } : {}) })
    .finally(() => clearTimeout(t));
}

/** The name a person's copy goes by: '' for the server's owner, otherwise
 *  their account's id (a name can be given up and taken by someone new). */
export function personKey(person) {
  if (!person || person.owner) return '';
  return String(person.uid || person.name || '').trim().toLowerCase();
}

/** Whose copy to open: the server says, and with no server, whoever signed
 *  in here last (store.svelte.js, settlePerson). null: nobody is signed in. */
async function whoIsHere() {
  try {
    const r = await fetchFor(5000, '/api/auth');
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
    const a = await r.json();
    if (!a.authenticated) return null;
    return { key: personKey(a.person), online: true };
  } catch {
    let key = null;
    try { key = localStorage.getItem('dvarim.person'); } catch { /* not kept */ }
    return { key: key || '', online: false };
  }
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plusDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return isoDay(d); };

/** Calendar events for the mirror's Today and Upcoming, from the server's
 *  calendars (they are its CalDAV, not this device's), with the days around
 *  now kept here, so the events still show with no network. */
function mirrorEvents(name) {
  const KEPT = `dvarim.events:${name}`;
  const AHEAD = 45;
  let lastFetch = 0;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEPT) || '{}'); } catch { return {}; } };
  const days = (from, to) => { const out = []; for (let d = from; d <= to && out.length < 400; d = plusDays(d, 1)) out.push(d); return out; };
  const fromKept = (from, to) => {
    const kept = read();
    return days(from, to).flatMap((d) => kept[d] || []);
  };
  return async (from, to) => {
    const kept = read();
    // asked again within two minutes, and every day is here: no round trip
    if (Date.now() - lastFetch < 120000 && days(from, to).every((d) => d in kept)) return fromKept(from, to);
    try {
      const r = await fetchFor(4000, `/api/calendar?from_=${from}&to=${to}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = await r.json();
      const today = isoDay(new Date()), first = plusDays(today, -1), last = plusDays(today, AHEAD);
      for (const d of days(from, to)) if (d >= first && d <= last) kept[d] = rows.filter((x) => x.date === d);
      for (const d of Object.keys(kept)) if (d < first) delete kept[d];
      try { localStorage.setItem(KEPT, JSON.stringify(kept)); } catch { /* full: shown live, not kept */ }
      lastFetch = Date.now();
      return rows;
    } catch {
      return fromKept(from, to);
    }
  };
}

async function openMirror() {
  const who = await whoIsHere();
  if (!who) return;                                    // the sign-in screen first; signing in reloads
  const name = who.key ? `${MIRROR}:${encodeURIComponent(who.key)}` : MIRROR;
  const first = !mirrorState(name);
  // Never copied to this device, and no server to copy it from: the server's
  // own way for now, with the lists it has kept.
  if (first && !who.online) return;
  const engine = await import('@engine/index.js');
  const { Api } = await import('@engine/api.js');
  const { IdbStorage } = await import('@engine/storage-idb.js');
  const storage = new IdbStorage(name);
  // no tutorial: this is a copy of the server's vault, not a new one
  const store = await engine.Store.open(storage, {
    onWriteError: (e, op) => vaultProblem(`could not save ${op.path || op.from || 'a change'}: ${e && e.message ? e.message : e}`),
  });
  const api = new Api(store, { events: mirrorEvents(name) });
  const mine = { api, store, storage, kind: 'mirror', info: { name, person: who.key }, engine };
  try {
    await startMirror(mine, { first });
  } catch (e) {
    // the first copy did not finish: the server's way this time, and on with it next time
    console.warn('Dvarim: could not copy the vault to this device yet:', e && e.message ? e.message : e);
    return;
  }
  local = mine;
  installFetchShim(api);
  watchForOthers(store, 'mirror', mine.info);
  window.__dvarimLocal = {
    kind: 'mirror',
    name,
    snapshot: async () => { await store.flush(); return storage.snapshot ? storage.snapshot() : null; },
    flush: () => store.flush(),
    rescan: () => store.scanChanges(),
    sync: () => syncNow(),
  };
}

/** Signing out of a mirror: what is here goes to the server, and then the
 *  copy goes from this device, so the next person to use it finds nothing.
 *  If something could not be sent (no network), the copy stays, for this
 *  person's next sign-in here. True if it was cleared. */
export async function leaveMirror() {
  if (!local || local.kind !== 'mirror') return true;
  try {
    const r = await syncNow();
    if (r && r.waiting && r.waiting.length) return false;
  } catch {
    return false;
  }
  const { name } = local.info;
  stopMirror();
  await local.store.flush();
  forgetMirrorState(name);
  try { localStorage.removeItem(`dvarim.events:${name}`); } catch { /* nothing kept */ }
  // another tab with the copy open holds the deletion until it closes too
  await Promise.race([local.storage.destroy().catch(() => {}), new Promise((ok) => setTimeout(ok, 2000))]);
  return true;
}

// ---- a vault on this device that syncs with a Dvarim server: the Mac and
// Android apps' own copy (info.sync from the shell), or a browser's vault set
// up in Settings → Sync. What only the server can answer (SERVER_ONLY) is asked
// of it with the device's token, through the shell where it makes requests
// itself (the server's /api has no CORS for a page from elsewhere).

function serverOf(cfg, storage, info) {
  if (!cfg || cfg.kind !== 'dvarim' || !cfg.address || !cfg.token) return null;
  const viaShell = info && info.http && storage && storage.httpFetch ? storage.httpFetch() : null;
  return {
    base: davUrl(cfg.address).replace(/\/dav\/$/u, ''),
    token: cfg.token,
    app: !!cfg.app,
    fetch: viaShell || ((url, init) => fetch(url, { ...init, credentials: 'omit' })),
  };
}

/** One request to the vault's server. Thrown errors carry `status`, 0 for no answer. */
export async function serverRequest(method, path, body) {
  const s = local && local.server;
  const init = { method, headers: { Authorization: `Bearer ${s.token}` } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  // what a token may not do (devices, people) the app's own session may
  if (/^\/(tokens|people)(\/|\?|$)/u.test(path)) init.session = true;
  let res;
  try {
    res = await s.fetch(`${s.base}/api${path}`, init);
  } catch {
    const e = new Error('Cannot reach the server');
    e.status = 0;
    throw e;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const e = new Error((data && data.error) || `${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

/** Signing out of an app's own copy: everything here reaches the server
 *  first, and then the app takes over (it revokes its token, signs out and
 *  forgets the copy). If something has not reached the server, nobody is
 *  signed out, and the error says why. */
export async function leaveAppCopy() {
  const notYet = () => new Error("Your latest changes haven't reached the server yet. Sign out once you're back online.");
  let r;
  try {
    r = await syncNow();
  } catch {
    throw notYet();
  }
  if (r && r.waiting && r.waiting.length) throw notYet();
  await local.storage.signOut();
}

/** An app's own copy of a server's vault, whose sync the app set up. */
export const isAppCopy = () => !!(local && local.server && local.server.app);

/** Before signing in or joining, which changes whose cookie the page holds: a
 *  mirror's sync stops, so this copy can never go to someone else's folder.
 *  Signing in loads the page again, with the right person's copy. */
export function beforeSignIn() {
  if (local && local.kind === 'mirror') stopMirror();
}
