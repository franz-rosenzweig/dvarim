// App state (Svelte 5 runes) and every write action. Components import `app` and the
// action functions; nothing else talks to api.js directly except QuickFind/WhenPopover
// read-only lookups (search, parse-date, tags).
import * as api from './api.js';
import * as outbox from './outbox.js';
import { setKeyOverrides } from './keys.js';
import { todayISO, addDays } from './dates.js';
import { localBackend, mirrorWanted, leaveMirror, personKey, isAppCopy, leaveAppCopy } from './backend.js';
import { watchSync } from './davsync.js';

export const app = $state({
  state: null,          // GET /api/state
  settings: null,       // GET /api/settings
  settingsOpen: false,  // the Settings sheet
  shared: null,         // an Android share waiting to become a to-do
  source: null,         // path of the file open in the source editor
  selected: [],         // every selected id; app.selection is the anchor among them
  selecting: false,     // phone: the list is in selection mode, circles and all
  startNew: false,      // /new: open a fresh to-do as soon as we are signed in
  showTodo: null,       // /todo/<id>: open that to-do in its list, likewise
  slim: false,          // desk: the sidebar is put away (lib/slim.svelte.js)
  placing: null,        // a to-do made by the + button, not yet where it was dropped
  inboxSheet: false,    // phone: the + button was dropped on the Inbox
  fromPlus: false,      // the + button has just been dropped: the card that opens next grows out of it
  authChecked: false,   // have we asked the server yet
  authRequired: false,  // does this server want a password
  authed: true,         // are we signed in (true when no password is set)
  person: null,         // who: { name, owner } (docs/PEOPLE.md); null with no password
  view: { kind: 'list', id: 'today' },
  data: null,           // current view payload (null while first loading)
  selection: null,      // selected to-do id
  expanded: null,       // to-do id being edited
  newId: null,          // to-do created just now: its card selects the title on mount
  focusChecklist: false, // ⇧⌘C: the open card adds/focuses a checklist item
  editTitle: false,     // project/area just created: title becomes editable
  editHeading: null,    // heading id just created: focus its name
  editTodayHeading: null, // the same, for a heading of Today's own
  filterTag: null,
  showCompleted: false,
  popover: null,        // { kind, target, rect, ... } see openPopover()
  quickFind: null,      // { query } | null
  root: false,          // phone: the navigation drawer is open over the page
  toast: null,          // { text, undo, error }
  completing: {},       // id -> 'done' | 'canceled' while the row fades out
  connected: true,      // SSE state
  online: true,         // did the server answer the last time we asked (lib/offline.js)
  mirror: false,        // this device keeps a copy of the server's vault (lib/backend.js)
  staleAt: null,        // when the lists on screen were last true, if they are a kept copy
  pending: 0,           // edits made while offline, waiting to be sent (lib/outbox.js)
  logbookExhausted: false
});

export const today = () => (app.state && app.state.today) || todayISO();
export const weekStartsOn = () => (app.settings && Number.isInteger(app.settings.weekStartsOn) ? app.settings.weekStartsOn : 0);

// ------------------------------------------------------------------ toast + undo
const undoStack = [];
let toastTimer = null;

export function toast(text, { undo = false, error = false, duration } = {}) {
  app.toast = { text, undo, error };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { app.toast = null; }, duration || (undo ? 6000 : 4000));
}
export function dismissToast() {
  app.toast = null;
  if (toastTimer) clearTimeout(toastTimer);
}
export function toastError(e) {
  console.error(e);
  const msg = e && e.message ? e.message : String(e);
  toast(msg, { error: true });
  if (e && e.status === 409) refresh();
}
function pushUndo(label, fn) {
  undoStack.push({ label, fn });
  if (undoStack.length > 30) undoStack.shift();
}
export async function undo() {
  const u = undoStack.pop();
  if (!u) return;
  dismissToast();
  try {
    await u.fn();
    toast(`Undone: ${u.label}`);
  } catch (e) {
    toastError(e);
  }
  await refresh();
}

// ------------------------------------------------------------------ loading
let hold = 0;
let pendingRefresh = false;
let seq = 0;

/** Pause data refreshes (e.g. while a completed row fades). Returns a release function. */
function holdRefresh() {
  hold++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hold--;
    if (hold === 0 && pendingRefresh) {
      pendingRefresh = false;
      refresh();
    }
  };
}

function fetchView(view) {
  if (view.kind === 'project') return api.getProject(view.id);
  if (view.kind === 'area') return api.getArea(view.id);
  if (view.id === 'logbook') return api.getLogbook({ limit: 200 });
  return api.getList(view.id);
}
/** The same view as the path fetchView() asks for; the outbox files a to-do
 *  made offline under it so it shows in the list it was made in. */
function viewApiPath(view) {
  if (view.kind === 'project') return `/projects/${view.id}`;
  if (view.kind === 'area') return `/areas/${view.id}`;
  if (view.id === 'logbook') return '/lists/logbook?limit=200';
  return `/lists/${view.id}`;
}
function sameView(a, b) {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/** Refetch state + the current view. Called on SSE `changed` (debounced) and after writes. */
export async function refresh() {
  if (hold > 0) {
    pendingRefresh = true;
    return;
  }
  const my = ++seq;
  const view = app.view;
  try {
    const [st, data] = await Promise.all([api.getState(), fetchView(view)]);
    if (my !== seq) return;
    app.state = st;
    if (sameView(view, app.view)) {
      app.data = data;
      if (view.id === 'logbook') app.logbookExhausted = false;
    }
  } catch (e) {
    if (my !== seq) return;
    if (e.status === 404 && view.kind !== 'list') {
      navigate({ kind: 'list', id: 'today' });
      return;
    }
    // Not reaching the server is a state, not an event: the strip under the
    // title says so for as long as it lasts, which a four-second toast could
    // not, and the empty state says it where there is nothing kept to show.
    if (e.status !== 0) toastError(e);
  }
  if (app.online) keepLists();
}

/**
 * The lists a plane trip wants, fetched while there is still a network.
 *
 * The cache in lib/offline.js only holds what this browser has asked for, so
 * a phone that opened on Today and nothing else would land at 30,000 feet with
 * Today alone. Once per session, and again after every reconnect, ask for the
 * rest quietly; the answers are kept as a side effect of reading them.
 */
let kept = false;
const STANDARD = ['inbox', 'today', 'upcoming', 'anytime', 'someday'];
function keepLists() {
  if (kept) return;
  kept = true;
  for (const id of STANDARD) api.getList(id).catch(() => { kept = false; });
}

/**
 * Send the edits made offline, then refetch so the screen shows what the
 * server made of them. One toast for the lot: how many landed, and each one
 * that could not — a to-do deleted on another device, say — by name.
 */
async function sendWaiting() {
  const r = await api.drain();
  if (!r.sent && !r.dropped.length) return;
  await refresh();
  const n = r.sent;
  let text = n ? `${n} ${n === 1 ? 'change' : 'changes'} made offline saved` : '';
  if (r.dropped.length) {
    const why = r.dropped.map((d) => `${outbox.describe(d.op)}: ${d.why}`).join('; ');
    text = (text ? text + '. Not saved — ' : 'Not saved — ') + why;
  }
  toast(text, { error: r.dropped.length > 0, duration: r.dropped.length ? 9000 : undefined });
}

let sseTimer = null;
function onChanged() {
  if (sseTimer) clearTimeout(sseTimer);
  sseTimer = setTimeout(() => { sseTimer = null; refresh(); }, 150);
}

const LIST_IDS = ['inbox', 'today', 'upcoming', 'anytime', 'someday', 'logbook', 'trash'];

/** The path a view lives at: /today, /project/<id>, /area/<id>. */
export function viewPath(v) {
  if (v.kind === 'project') return `/project/${encodeURIComponent(v.id)}`;
  if (v.kind === 'area') return `/area/${encodeURIComponent(v.id)}`;
  return `/${v.id}`;
}

/** The view a path means, or null when the path names nothing we know. */
function pathView(path) {
  const parts = String(path || '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 1 && LIST_IDS.includes(parts[0])) return { kind: 'list', id: parts[0] };
  if (parts.length === 2 && (parts[0] === 'project' || parts[0] === 'area')) return { kind: parts[0], id: parts[1] };
  return null;
}

/** On a phone Back belongs to lib/backstack.svelte.js, which keeps history as a
 *  stack of depths: it answers popstate first, and moving between lists
 *  replaces the entry instead of adding one. */
let backStack = null;
export function useBackStack(onPop) { backStack = onPop; }

function syncUrl(view, replace) {
  if (typeof history === 'undefined') return;
  if (app.shared) return;              // keep /share until the sheet is done
  const path = viewPath(view);
  if (path === location.pathname) return;
  // A snapshot: history keeps a structured clone, and a state proxy has none —
  // init() passes app.view itself, and that threw into the catch below.
  const plain = $state.snapshot(view);
  const state = backStack ? { ...(history.state || {}), view: plain } : { view: plain };
  try { history[replace || backStack ? 'replaceState' : 'pushState'](state, '', path); } catch { /* ignore */ }
}

/** What the address asked for beyond a list, done once there is somewhere to
 *  do it: /new wants an empty to-do, and the list has to exist before one can
 *  go in it; /todo/<id> — what a reminder opens — wants that to-do open where
 *  it lives. */
async function followArrival() {
  if (app.startNew) {
    app.startNew = false;
    await createTodo({ inbox: true });
  }
  if (app.showTodo) {
    const id = app.showTodo;
    app.showTodo = null;
    try { revealTodo(await api.getTodo(id)); } catch { /* gone, or never seen offline: stay on the list */ }
  }
}

/** Called after a successful sign-in: drop the login screen and load everything. */
/** Settings arrived: keep them, and put any rebound keys into force. */
function applySettings(s) {
  app.settings = s;
  setKeyOverrides(s && s.keymap);
  return s;
}

/**
 * Who is signed in. Someone other than last time in this browser: what it kept
 * for the last one, their lists and any edits still waiting, is theirs, so it
 * goes before anything is shown or sent. Edits waiting from one person would
 * otherwise land in the next one's to-dos.
 */
async function settlePerson(person) {
  app.person = person || null;
  if (!person) return;
  const key = personKey(person);
  let was = null;
  try { was = localStorage.getItem('dvarim.person'); } catch { /* storage refused: nothing kept either */ }
  if (was !== null && was !== key) {
    await api.forgetKept();
    app.pending = 0;
  }
  try {
    localStorage.setItem('dvarim.person', key);
    // the name to put on the sign-in screen next time: none for the owner
    localStorage.setItem('dvarim.signin-name', person.owner ? '' : String(person.name || ''));
  } catch { /* as above */ }
}

/** The owner, told once that someone asked for an account (Settings →
 *  Account → People), and again only when more have. */
function tellOfRequests(n) {
  let seen = 0;
  try { seen = Number(localStorage.getItem('dvarim.requests-seen') || 0); } catch { /* not kept */ }
  if (n > seen) toast(n === 1 ? "Someone asked for an account. It's in Settings → Account." : `${n} people asked for an account. They're in Settings → Account.`);
  try { localStorage.setItem('dvarim.requests-seen', String(n)); } catch { /* as above */ }
}

/** "Meet Dvarim" again: the one there is while it is open, else a new one. */
export async function showTutorial() {
  const p = await write(() => api.createTutorial());
  if (p && p.id) {
    closeSettings();
    await goProject(p.id);
  }
}

export async function signedIn(person = null) {
  if (person) await settlePerson(person);
  // The mirror opens on loading, for whoever is signed in then: signed out
  // then, or someone else now, and the page loads again to open theirs.
  // A mirror opens on loading, for whoever is signed in then; its sync stopped
  // before this sign-in (backend.js, beforeSignIn). Load the page again to open
  // the right person's copy and start it again.
  if (mirrorWanted()) {
    location.reload();
    return;
  }
  app.authed = true;
  if (person && person.owner) api.authState().then((a) => a && a.requests && tellOfRequests(a.requests)).catch(() => {});
  await refresh();
  api.getSettings().then(applySettings).catch(() => {});
  await followArrival();     // /new or /todo/<id>, when the password screen came first
  sendWaiting();             // edits that waited out a lapsed session (api.drain)
}

export async function signOut() {
  // An app's own copy: everything sent first, then the app signs out and
  // forgets the copy. Not sent (no network): nobody is signed out.
  if (isAppCopy()) {
    try {
      await leaveAppCopy();
    } catch (e) {
      toastError(e);
    }
    return;
  }
  // a mirror: sent to the server, then gone from this device (lib/backend.js)
  const mirrored = localBackend()?.kind === 'mirror';
  if (mirrored) await leaveMirror();
  try { await api.logout(); } catch { /* the cookie is gone either way */ }
  if (mirrored) { location.reload(); return; }
  app.authed = false;
  app.person = null;
  app.data = null;
  app.state = null;
  app.staleAt = null;
  app.pending = 0;
  app.settingsOpen = false;
}

export function init() {
  // a vault on this device that could not be written or read (lib/backend.js):
  // said out loud, because a change that silently failed to save is the worst
  // thing a to-do app can do
  if (typeof window !== 'undefined') {
    window.addEventListener('dvarim:vault-problem', (e) => toast(`Not saved — ${e.detail.message}`, { error: true, duration: 10000 }));
  }
  // the URL wins (a shared or bookmarked link), then the last view used here
  const fromUrl = typeof location !== 'undefined' ? pathView(location.pathname) : null;
  if (fromUrl) {
    app.view = fromUrl;
  } else {
    try {
      const v = JSON.parse(localStorage.getItem('dvarim.view') || 'null');
      if (v && v.kind && v.id) app.view = v;
    } catch { /* ignore */ }
  }
  // An Android share arrives as GET /share?title=&text=&url= (see the web
  // manifest's share_target). Hold it aside; the sign-in screen may come first.
  if (typeof location !== 'undefined' && location.pathname === '/share') {
    const q = new URLSearchParams(location.search);
    app.shared = { title: q.get('title') || '', text: q.get('text') || '', url: q.get('url') || '' };
    app.view = { kind: 'list', id: 'inbox' };
  }
  // The Android app's "New To-Do" — its icon's long-press menu and its quick
  // settings tile — asks for GET /new. Land in the Inbox with an empty to-do
  // already open, which is the whole point of reaching for that shortcut.
  if (typeof location !== 'undefined' && location.pathname === '/new') {
    app.startNew = true;
    app.view = { kind: 'list', id: 'inbox' };
  }
  // A reminder, tapped on the Mac or the phone, opens GET /todo/<id>. Where the
  // to-do lives is the server's to say; until it has, Today.
  const asked = typeof location !== 'undefined' && location.pathname.match(/^\/todo\/([0-9a-z]+)$/);
  if (asked) {
    app.showTodo = asked[1];
    app.view = { kind: 'list', id: 'today' };
  }
  // ?settings opens Settings. Read it before syncUrl, which rewrites the address
  // to the view's own and drops the query with it. It was read after, twice now,
  // and the link silently did nothing.
  try {
    if (new URLSearchParams(location.search).get('settings') !== null) app.settingsOpen = true;
  } catch { /* ignore */ }
  syncUrl(app.view, true);
  setTextScale(getTextScale());
  try { app.slim = localStorage.getItem('dvarim.slim') === '1'; } catch { /* ignore */ }
  api.setUnauthorizedHandler(() => {
    app.authed = false;
    app.authRequired = true;
    app.data = null;
  });
  api.setReachabilityHandler((ok, at) => {
    const was = app.online;
    app.online = ok;
    app.staleAt = ok ? null : (at || app.staleAt);
    if (ok && !was) {
      kept = false;                        // keep the lists again: they have moved on
      sendWaiting();
    }
  });
  api.setPendingHandler((n) => { app.pending = n; });
  // A mirror is online when its sync reaches the server, and offline when it
  // cannot: what the strip says (components/Offline.svelte), and nothing else
  // changes, since every list and every change works here either way.
  // the same for a vault on this device that syncs with a Dvarim server (an app's own copy)
  if (localBackend()?.kind === 'mirror' || localBackend()?.server) {
    app.mirror = true;
    let wasOffline = false;
    watchSync((st) => {
      app.online = !st.offline;
      app.staleAt = st.offline ? (st.at || app.staleAt) : null;
      // opened with no server, it could not ask who you are: it can now
      if (wasOffline && !st.offline) {
        api.authState().then((a) => { app.authRequired = !!a.required; if (a.person) app.person = a.person; }).catch(() => {});
      }
      wasOffline = !!st.offline;
    });
    window.addEventListener('dvarim:unauthorized', () => {
      app.authed = false;
      app.authRequired = true;
    });
  }
  api.setOutboxContext(() => ({
    list: viewApiPath(app.view),
    today: today(),
    settings: app.settings || {},
    areaName: (id) => { const a = id && findArea(id); return a ? a.name : null; },
    todo: (id) => findTodo(id),
    staleAt: app.staleAt
  }));
  api.pendingCount().then((n) => { app.pending = n; if (n) sendWaiting(); });
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', (e) => {
      if (backStack && backStack(e)) return;
      const v = (e.state && e.state.view) || pathView(location.pathname) || { kind: 'list', id: 'today' };
      navigate(v, { fromHistory: true });
    });
  }
  // The phone opens on the list you were reading, with the navigation put
  // away: it is a drawer now, not the screen underneath everything.
  app.root = false;
  api.authState()
    .then((a) => {
      app.authRequired = !!a.required;
      try { localStorage.setItem('dvarim.authRequired', a.required ? '1' : '0'); } catch { /* asked again next time */ }
      app.authed = !!a.authenticated;
      app.authChecked = true;
      if (app.authed) {
        settlePerson(a.person).then(() => refresh()).then(followArrival);
        if (a.requests) tellOfRequests(a.requests);
        api.getSettings().then(applySettings).catch(() => {});
      }
    })
    .catch(() => {
      // An old server with no /api/auth: behave as before. Or no server at all
      // (a mirror opened offline): as it was the last time it was asked.
      try { app.authRequired = localStorage.getItem('dvarim.authRequired') === '1'; } catch { /* as before */ }
      app.authChecked = true;
      app.authed = true;
      refresh();
      api.getSettings().then(applySettings).catch(() => {});
    });
  const stop = api.subscribe(onChanged, (ok) => {
    const was = app.connected;
    app.connected = ok;
    if (ok && !was) refresh();
  });
  const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
  document.addEventListener('visibilitychange', onVis);
  return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
}

// ------------------------------------------------------------------ navigation
export async function navigate(view, opts = {}) {
  app.shared = null;
  const changed = !sameView(view, app.view);
  app.view = view;
  app.root = false;
  app.popover = null;
  app.quickFind = null;
  if (changed) {
    app.selection = null;
    app.selected = [];
    app.expanded = null;
    app.filterTag = null;
    app.showCompleted = false;
    app.data = null;
  }
  if (opts.filterTag !== undefined) app.filterTag = opts.filterTag;
  if (opts.select) selectOnly(opts.select);
  if (opts.expand) { app.expanded = opts.expand; selectOnly(opts.expand); app.showCompleted = app.showCompleted || !!opts.showCompleted; }
  try { localStorage.setItem('dvarim.view', JSON.stringify(view)); } catch { /* ignore */ }
  if (!opts.fromHistory) syncUrl(view, false);
  const el = document.querySelector('.content');
  if (el && changed) el.scrollTo({ top: 0, behavior: 'auto' });
  await refresh();
}
export const goList = (id, opts) => navigate({ kind: 'list', id }, opts);
export const goProject = (id, opts) => navigate({ kind: 'project', id }, opts);
export const goArea = (id, opts) => navigate({ kind: 'area', id }, opts);
export function goBack() {
  app.root = true;
  app.popover = null;
  app.quickFind = null;
}

/** The sidebar put away, remembered on this machine: it is about this window on this desk. */
export function toggleSlim(on = !app.slim) {
  if (!!on === app.slim) return;
  app.slim = !!on;
  try { localStorage.setItem('dvarim.slim', app.slim ? '1' : ''); } catch { /* ignore */ }
  // The web-view Mac app (retired) gave the room back: its window narrowed by
  // the sidebar's width and the list stayed the size it was.
  // Told only when it changes here, never on load: a window that opens slim is
  // already the width it was left.
  try {
    const width = document.querySelector('.sidebar')?.offsetWidth || 236;
    window.webkit?.messageHandlers?.dvarim?.postMessage({ type: 'slim', on: app.slim, width });
  } catch { /* not in the shell */ }
}

/** Open the list a to-do lives in and expand it (Quick Find, toast links). */
export function revealTodo(t) {
  const done = t.status && t.status !== 'open';
  if (t.projectId) return goProject(t.projectId, { expand: t.id, showCompleted: done });
  if (done) return goList('logbook', { expand: t.id });
  if (t.inbox) return goList('inbox', { expand: t.id });
  if (t.someday) return goList('someday', { expand: t.id });
  if (t.when && t.when <= today()) return goList('today', { expand: t.id });
  if (t.when || t.deadline) return goList('upcoming', { expand: t.id });
  if (t.areaId) return goArea(t.areaId, { expand: t.id });
  return goList('anytime', { expand: t.id });
}

export function viewTitle() {
  const v = app.view;
  if (v.kind === 'project') return (app.data && app.data.project && app.data.project.name) || findProject(v.id)?.name || 'Project';
  if (v.kind === 'area') return (app.data && app.data.area && app.data.area.name) || findArea(v.id)?.name || 'Area';
  return v.id[0].toUpperCase() + v.id.slice(1);
}

// ------------------------------------------------------------------ lookups
export function allProjects() {
  const st = app.state;
  if (!st) return [];
  const out = [];
  for (const a of st.areas || []) for (const p of a.projects || []) out.push(p);
  for (const p of st.looseProjects || []) out.push(p);
  return out;
}
export function findProject(id) {
  return allProjects().find((p) => p.id === id) || null;
}
function findArea(id) {
  return ((app.state && app.state.areas) || []).find((a) => a.id === id) || null;
}
/** Every to-do in the current view payload, flattened. */
function allTodos(data = app.data) {
  if (!data) return [];
  const out = [];
  if (Array.isArray(data.items)) out.push(...data.items);
  if (Array.isArray(data.groups)) for (const g of data.groups) if (Array.isArray(g.items)) out.push(...g.items);
  if (Array.isArray(data.days)) for (const d of data.days) if (Array.isArray(d.items)) out.push(...d.items);
  return out;
}
export function findTodo(id) {
  if (!id) return null;
  return allTodos().find((t) => t.id === id) || null;
}
/** The underlying reactive array that holds a to-do (for optimistic edits). */
function containerOf(id) {
  const data = app.data;
  if (!data) return null;
  const arrays = [];
  if (Array.isArray(data.items)) arrays.push(data.items);
  if (Array.isArray(data.groups)) for (const g of data.groups) if (Array.isArray(g.items)) arrays.push(g.items);
  if (Array.isArray(data.days)) for (const d of data.days) if (Array.isArray(d.items)) arrays.push(d.items);
  for (const arr of arrays) {
    const i = arr.findIndex((t) => t.id === id);
    if (i >= 0) return { arr, i };
  }
  return null;
}
/** Move a to-do between Upcoming's day arrays, so the list is right before the
 *  server has said so — and so a reorder that follows measures the day it is
 *  going to rather than the one it left. */
export function moveToDayLocal(id, when) {
  const data = app.data;
  if (!data || !Array.isArray(data.days)) return;
  let obj = null;
  for (const d of data.days) {
    const i = (d.items || []).findIndex((t) => t.id === id);
    if (i >= 0) { [obj] = d.items.splice(i, 1); break; }
  }
  if (!obj) return;
  obj.when = when;
  const target = data.days.find((d) => d.date === when);
  if (target) (target.items || (target.items = [])).push(obj);
}

function removeLocal(id) {
  const c = containerOf(id);
  if (c) c.arr.splice(c.i, 1);
}
function nextSelectionAfter(id) {
  const els = Array.from(document.querySelectorAll('.content [data-todo-id]'));
  const i = els.findIndex((el) => el.dataset.todoId === id);
  if (i < 0) return null;
  const nb = els[i + 1] || els[i - 1];
  return nb ? nb.dataset.todoId : null;
}

// ------------------------------------------------------------------ to-do actions
async function write(fn) {
  try {
    const r = await fn();
    await refresh();
    return r;
  } catch (e) {
    toastError(e);
    await refresh();
    return null;
  }
}

/** New to-do in the current context; opens the editor with the title selected. */
/**
 * @param {object} extra  fields for the new to-do, over what the view implies
 * @param {{ place?: (todo) => Promise<any> }} opts  `place` runs once the to-do
 *   exists and before it is shown — the + button uses it to put the to-do
 *   where it was dropped, so it is never seen anywhere else first.
 */
export async function createTodo(extra = {}, opts = {}) {
  const v = app.view;
  const body = { title: 'New To-Do', ...extra };
  const sel = app.selection ? findTodo(app.selection) : null;
  if (extra.projectId === undefined && extra.inbox === undefined && extra.areaId === undefined) {
    if (v.kind === 'project') {
      body.projectId = v.id;
      if (extra.headingId === undefined && sel && sel.headingId) body.headingId = sel.headingId;
    } else if (v.kind === 'area') {
      body.areaId = v.id;
    } else if (v.id === 'inbox') {
      body.inbox = true;
    } else if (v.id === 'today') {
      if (extra.when === undefined) body.when = today();
    } else if (v.id === 'someday') {
      body.someday = true;
    } else if (v.id === 'upcoming') {
      // Tomorrow, unless a day was asked for: the + button dropped under the
      // 18th means the 18th, and this used to overwrite it.
      if (extra.when === undefined) body.when = addDays(today(), 1);
    } else if (v.id === 'anytime' && sel) {
      if (sel.projectId) { body.projectId = sel.projectId; if (sel.headingId) body.headingId = sel.headingId; }
      else if (sel.areaId) body.areaId = sel.areaId;
    } else if (v.id === 'logbook' || v.id === 'trash') {
      body.inbox = true;
    }
  }
  if (!body.position) {
    const sameContainer = sel && sel.status === 'open' &&
      ((body.projectId && sel.projectId === body.projectId && (sel.headingId || null) === (body.headingId || null)) ||
       (body.inbox && sel.inbox) || (body.areaId && !sel.projectId && sel.areaId === body.areaId) ||
       (v.id === 'today' && body.when));
    body.position = sameContainer ? { after: sel.id } : 'bottom';
  }
  // In Today, beside a to-do under a heading of Today's own: under it too.
  const besideUnder = v.kind === 'list' && v.id === 'today' && sel && !opts.place && !extra.evening ? todayHeadingOf(sel.id) : null;
  try {
    const t = await api.createTodo(body);
    if (besideUnder) await fileInToday([t.id], besideUnder);
    if (opts.place) {
      app.placing = t.id;           // TodoRow keeps it out of sight meanwhile
      await refresh();
      try { await opts.place(t); } finally { app.placing = null; }
    }
    if (v.id === 'logbook' || v.id === 'trash') {
      await goList('inbox', { expand: t.id });
    } else {
      app.newId = t.id;
      selectOnly(t.id);
      app.expanded = t.id;
      app.root = false;
      await refresh();
    }
    app.newId = t.id;
    return t;
  } catch (e) {
    toastError(e);
    return null;
  }
}

export async function patchTodo(id, patch, { silent = false } = {}) {
  const t = findTodo(id);
  if (t) Object.assign(t, patch); // optimistic
  try {
    const r = await api.patchTodo(id, patch);
    if (!silent) await refresh();
    return r;
  } catch (e) {
    toastError(e);
    await refresh();
    return null;
  }
}

export async function toggleComplete(id) {
  const t = findTodo(id);
  if (!t) return;
  if (app.completing[id]) return;
  if (t.status !== 'open') return reopenTodo(id);
  app.completing[id] = 'done';
  if (app.expanded === id) app.expanded = null;
  const release = holdRefresh();
  try {
    const res = await api.completeTodo(id);
    pushUndo('complete', () => api.reopenTodo(id));
    if (res && res.next) {
      const c = containerOf(id);
      if (c) c.arr.splice(c.i + 1, 0, res.next);
    }
    toast(res && res.next ? 'Completed · repeats' : 'Completed', { undo: true });
  } catch (e) {
    delete app.completing[id];
    release();
    toastError(e);
    return;
  }
  setTimeout(() => {
    delete app.completing[id];
    app.selected = app.selected.filter((x) => x !== id);
    if (app.selection === id) app.selection = nextSelectionAfter(id);
    release();
    refresh();
  }, 600);
}

export async function cancelTodo(id) {
  const t = findTodo(id);
  if (!t || app.completing[id]) return;
  app.completing[id] = 'canceled';
  if (app.expanded === id) app.expanded = null;
  const release = holdRefresh();
  try {
    await api.cancelTodo(id);
    pushUndo('cancel', () => api.reopenTodo(id));
    toast('Canceled', { undo: true });
  } catch (e) {
    delete app.completing[id];
    release();
    toastError(e);
    return;
  }
  setTimeout(() => {
    delete app.completing[id];
    app.selected = app.selected.filter((x) => x !== id);
    if (app.selection === id) app.selection = nextSelectionAfter(id);
    release();
    refresh();
  }, 600);
}

export async function reopenTodo(id) {
  const t = findTodo(id);
  if (t) t.status = 'open';
  await write(async () => {
    await api.reopenTodo(id);
    pushUndo('reopen', () => api.completeTodo(id));
  });
}

export async function deleteTodo(id) {
  const t = findTodo(id);
  if (!t) return;
  const next = nextSelectionAfter(id);
  removeLocal(id);
  if (app.expanded === id) app.expanded = null;
  app.selected = app.selected.filter((x) => x !== id);
  if (app.selection === id) app.selection = next;
  await write(async () => {
    await api.deleteTodo(id);
    pushUndo('move to Trash', () => api.restoreTodo(id));
    toast('Moved to Trash', { undo: true });
  });
}
export async function restoreTodo(id) {
  removeLocal(id);
  await write(async () => {
    await api.restoreTodo(id);
    pushUndo('restore', () => api.deleteTodo(id));
    toast('Restored');
  });
}
export async function duplicateTodo(id) {
  await write(async () => {
    const t = await api.duplicateTodo(id);
    pushUndo('duplicate', () => api.deleteTodo(t.id));
    selectOnly(t.id);
    toast('Duplicated', { undo: true });
  });
}
export async function convertTodo(id) {
  const p = await write(() => api.convertTodo(id));
  if (p && p.id) {
    toast('Converted to project');
    goProject(p.id);
  }
}

/** Where a to-do currently lives, as a body for POST /move (used to undo moves). */
function containerBody(t) {
  if (t.inbox) return { inbox: true };
  if (t.projectId) return t.headingId ? { projectId: t.projectId, headingId: t.headingId } : { projectId: t.projectId };
  if (t.areaId) return { areaId: t.areaId };
  return { standalone: true };
}
export async function moveTodo(id, body, label = 'Moved') {
  const t = findTodo(id);
  const back = t ? containerBody(t) : null;
  await write(async () => {
    await api.moveTodo(id, body);
    if (back) pushUndo('move', () => api.moveTodo(id, back));
    toast(label, { undo: !!back });
  });
}

/** When / This Evening / Someday / reminder. Records the previous values for undo. */
export async function setWhen(id, fields, label) {
  const t = findTodo(id);
  const prev = t ? { when: t.when ?? null, evening: !!t.evening, someday: !!t.someday, reminder: t.reminder ?? null } : null;
  if (t) Object.assign(t, fields);
  await write(async () => {
    await api.patchTodo(id, fields);
    if (prev) pushUndo('when', () => api.patchTodo(id, prev));
    if (label) toast(label, { undo: !!prev });
  });
}
export const moveToToday = (id) => setWhen(id, { when: today(), evening: false, someday: false }, 'Moved to Today');
export const moveToEvening = (id) => setWhen(id, { when: today(), evening: true, someday: false }, 'Moved to This Evening');
export const moveToAnytime = (id) => setWhen(id, { when: null, evening: false, someday: false }, 'Moved to Anytime');
export const moveToSomeday = (id) => setWhen(id, { when: null, evening: false, someday: true }, 'Moved to Someday');

export async function setDeadline(id, deadline) {
  const t = findTodo(id);
  const prev = t ? t.deadline ?? null : null;
  if (t) t.deadline = deadline;
  await write(async () => {
    await api.patchTodo(id, { deadline });
    pushUndo('deadline', () => api.patchTodo(id, { deadline: prev }));
  });
}
export async function setTags(id, tags) {
  return patchTodo(id, { tags });
}

/**
 * Move the selected to-do one step up/down among its visible siblings and persist
 * with POST /api/reorder. The sibling section and the context string depend on the view.
 */
// ------------------------------------------------------------------ selection
//
// app.selection is the anchor — the one the keyboard moves from and the one a
// popover opens against. app.selected is everything acted on. With one item the
// two agree, so every existing single-item path keeps working.

export const isSelected = (id) => app.selected.includes(id);

export function selectOnly(id) {
  app.selection = id;
  app.selected = id ? [id] : [];
}

/** Phone: swiping a row left starts choosing several, with that one picked.
 *  Everything downstream is the multi-select the keyboard already had. */
export function startSelecting(id) {
  app.expanded = null;
  app.popover = null;
  app.selecting = true;
  selectOnly(id);
  if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(8);
}

export function stopSelecting() {
  app.selecting = false;
  clearSelection();
}

export function clearSelection() {
  app.selection = null;
  app.selected = [];
}

export function toggleSelected(id) {
  if (app.selected.includes(id)) {
    app.selected = app.selected.filter((x) => x !== id);
    if (app.selection === id) app.selection = app.selected[app.selected.length - 1] || null;
  } else {
    app.selected = [...app.selected, id];
    app.selection = id;
  }
}

/** Make a to-do chosen or not, whatever it was: what a stroke down the circles
 *  paints with (lib/pickdrag.svelte.js). */
export function setSelected(id, on) {
  if (app.selected.includes(id) !== on) toggleSelected(id);
}

/** Shift-click: everything between the anchor and here, in the order shown. */
export function selectRange(id) {
  const rows = visibleTodoIds();
  const from = rows.indexOf(app.selection);
  const to = rows.indexOf(id);
  if (from < 0 || to < 0) return selectOnly(id);
  const [a, b] = from < to ? [from, to] : [to, from];
  app.selected = rows.slice(a, b + 1);
  app.selection = id;
}

export function selectAllVisible() {
  const rows = visibleTodoIds();
  app.selected = rows;
  app.selection = rows[rows.length - 1] || null;
}

/** The ids on screen, in screen order — the only order a range can mean. */
function visibleTodoIds() {
  if (typeof document === 'undefined') return allTodos().map((t) => t.id);
  const nodes = document.querySelectorAll('[data-todo-id]');
  return [...nodes].map((n) => n.dataset.todoId);
}

/** Act on every selected to-do, anchor last so the UI settles somewhere sane. */
async function forEachSelected(fn) {
  const ids = app.selected.length ? [...app.selected] : (app.selection ? [app.selection] : []);
  const ordered = ids.filter((i) => i !== app.selection).concat(app.selection ? [app.selection] : []);
  for (const id of ordered) {
    if (findTodo(id)) await fn(id);
  }
}

/** Drop a to-do at `index` within a reorder context, and persist the order.
 *  The visible order is what the user sees, so that is what is sent; anything
 *  filtered out keeps its place relative to the rest. */
/**
 * @param {number} index  where among its section's other rows, as shown
 * @param {{beforeId?: string|null, afterId?: string|null}} [near]  the rows it
 *   was dropped between, which is what `index` cannot say when the list on
 *   screen is only part of the section — Today grouped by project shows one
 *   section as several lists, and an index into the third of them is not an
 *   index into the whole. A neighbour is; when given, it wins.
 */
export async function reorderTo(id, context, index, near = null) {
  const t = findTodo(id);
  // A drop inside a project can land under a different heading, or in the
  // un-headed run above the first one. That is a move, not a reorder: the
  // reorder endpoint only shuffles the ids it is handed, and a to-do that does
  // not belong to the target section is not one of them, so the drop used to
  // do nothing at all.
  const toHeading = context.startsWith('heading:') ? context.slice(8) : null;
  if (t && (context.startsWith('heading:') || context.startsWith('project:'))
        && (t.headingId || null) !== toHeading) {
    const projectId = toHeading ? toHeading.split(':')[0] : context.slice(8);
    const back = containerBody(t);
    return write(async () => {
      await api.moveTodo(id, { projectId, headingId: toHeading, position: { index } });
      pushUndo('move', () => api.moveTodo(id, back));
    });
  }

  const c = containerOf(id);
  if (!c) return;
  const full = c.arr;
  const section = sectionFor(context, id);
  if (!section) return;
  const i = full.findIndex((t) => t.id === id);
  if (i < 0) return;
  const siblings = full.filter((t) => t.id !== id && section(t) && t.status === 'open');
  let before = siblings[index];                      // undefined means "at the end"
  if (near) {
    const b = near.beforeId ? siblings.findIndex((t) => t.id === near.beforeId) : -1;
    const a = near.afterId ? siblings.findIndex((t) => t.id === near.afterId) : -1;
    if (b >= 0) before = siblings[b];
    else if (a >= 0) before = siblings[a + 1];
  }
  const [obj] = full.splice(i, 1);
  const at = before ? full.findIndex((t) => t.id === before.id) : -1;
  full.splice(at < 0 ? full.length : at, 0, obj);
  const ids = viewOrdered(context) ? full.map((t) => t.id) : full.filter(section).map((t) => t.id);
  try {
    await api.reorder(context, ids);
  } catch (e) {
    toastError(e);
    refresh();
  }
}

const VIEW_ORDER_CONTEXTS = new Set(['today', 'anytime', 'someday', 'inbox']);
/** Lists whose order is the view's own, kept on the server beside the files
 *  rather than in them. A day in Upcoming is one: it gathers to-dos from every
 *  file there is, so no file's order can speak for it. */
const viewOrdered = (c) => VIEW_ORDER_CONTEXTS.has(c) || c.startsWith('upcoming:');

/** Which to-dos share a reorder context with this one. */
function sectionFor(context, id) {
  const sel = findTodo(id);
  if (!sel) return null;
  if (context === 'today') return (t) => !!t.evening === !!sel.evening;
  if (context === 'inbox' || context === 'someday' || context === 'anytime' || context === 'standalone') return () => true;
  // The day's own array is the section: everything in it is that day.
  if (context.startsWith('upcoming:')) return () => true;
  if (context.startsWith('heading:')) return (t) => t.headingId === context.slice(8);
  if (context.startsWith('project:')) return (t) => !t.headingId;
  if (context.startsWith('area:')) return () => true;
  return null;
}

// ---- batch versions, used when more than one row is selected -------------

export const completeSelected = () => forEachSelected((id) => toggleComplete(id));
export const cancelSelected   = () => forEachSelected((id) => cancelTodo(id));
export const deleteSelected   = () => forEachSelected((id) => deleteTodo(id));
export const duplicateSelected = () => forEachSelected((id) => duplicateTodo(id));
export const setWhenSelected  = (fields, label) => forEachSelected((id) => setWhen(id, fields, null)).then(() => label && toast(label));
export const setDeadlineSelected = (d) => forEachSelected((id) => setDeadline(id, d));
export const moveSelected     = (target, label) => forEachSelected((id) => moveTodo(id, target, null)).then(() => label && toast(label));

/** One tag on, or off, every selected to-do: those that already agree are
 *  left alone, and the list is fetched once at the end rather than per row. */
export async function setTagSelected(tag, on) {
  await forEachSelected((id) => {
    const had = findTodo(id)?.tags || [];
    if (had.includes(tag) === on) return;
    return patchTodo(id, { tags: on ? [...had, tag] : had.filter((x) => x !== tag) }, { silent: true });
  });
  await refresh();
}

export async function reorderSelected(dir) {
  const id = app.selection;
  const sel = findTodo(id);
  if (!sel || sel.status !== 'open') return;
  const v = app.view;
  const data = app.data;
  let full = null, context = null, section = null;
  const c = containerOf(id);
  if (!c) return;
  full = c.arr;
  if (v.kind === 'list') {
    if (v.id === 'today') {
      // within This Evening, or within the run of Today it is in: above the
      // headings of Today's own, or under one of them
      const under = todayHeadingOf(id);
      context = 'today'; section = (t) => !!t.evening === !!sel.evening && (sel.evening || todayHeadingOf(t.id) === under);
    }
    else if (v.id === 'inbox') { context = 'inbox'; section = () => true; }
    else if (v.id === 'anytime') {
      if (full === data.items) { context = 'anytime'; section = () => true; }
      else if (sel.headingId) { context = `heading:${sel.headingId}`; section = (t) => t.headingId === sel.headingId; }
      else if (sel.projectId) { context = `project:${sel.projectId}`; section = (t) => !t.headingId; }
      else if (sel.areaId) { context = `area:${sel.areaId}`; section = () => true; }
    }
    else if (v.id === 'someday') { context = 'someday'; section = () => true; }
    // Upcoming, Logbook and Trash are ordered by date, so there is nothing to
    // reorder there.
  } else if (v.kind === 'project') {
    if (sel.headingId) { context = `heading:${sel.headingId}`; section = (t) => t.headingId === sel.headingId; }
    else { context = `project:${v.id}`; section = (t) => !t.headingId; }
  } else if (v.kind === 'area') {
    context = `area:${v.id}`; section = () => true;
  }
  if (!context) return;
  const visible = full.filter((t) => section(t) && t.status === 'open' && (!app.filterTag || (t.tags || []).includes(app.filterTag)));
  const k = visible.findIndex((t) => t.id === id);
  const nb = visible[k + dir];
  if (!nb) return;
  const i = full.findIndex((t) => t.id === id);
  const j = full.findIndex((t) => t.id === nb.id);
  const [obj] = full.splice(i, 1);
  full.splice(j, 0, obj);
  const ids = (context === 'today' || context === 'anytime' || context === 'inbox') ? full.map((t) => t.id) : full.filter(section).map((t) => t.id);
  try {
    await api.reorder(context, ids);
  } catch (e) {
    toastError(e);
    refresh();
  }
}

// ------------------------------------------------------------------ projects, headings, areas
export async function createProject(extra = {}) {
  const body = { name: 'New Project', ...extra };
  if (body.areaId === undefined) {
    if (app.view.kind === 'area') body.areaId = app.view.id;
    else if (app.view.kind === 'project') { const p = findProject(app.view.id); if (p && p.areaId) body.areaId = p.areaId; }
  }
  if (body.areaId === undefined || body.areaId === null) delete body.areaId;
  try {
    const p = await api.createProject(body);
    app.editTitle = true;
    await goProject(p.id);
    return p;
  } catch (e) {
    toastError(e);
    return null;
  }
}
export async function patchProject(id, patch) {
  const d = app.data;
  if (d && d.project && d.project.id === id) Object.assign(d.project, patch);
  return write(() => api.patchProject(id, patch));
}
export async function completeProject(id, completeOpenTodos) {
  const p = (app.data && app.data.project && app.data.project.id === id) ? app.data.project : findProject(id);
  const areaId = p ? p.areaId : null;
  const r = await write(async () => {
    const res = await api.completeProject(id, completeOpenTodos);
    pushUndo('complete project', () => api.reopenProject(id));
    toast('Project completed', { undo: true });
    return res;
  });
  if (r && app.view.kind === 'project' && app.view.id === id) {
    if (areaId) goArea(areaId); else goList('today');
  }
}
export async function cancelProject(id) {
  const p = (app.data && app.data.project && app.data.project.id === id) ? app.data.project : findProject(id);
  const areaId = p ? p.areaId : null;
  const r = await write(async () => {
    const res = await api.cancelProject(id);
    pushUndo('cancel project', () => api.reopenProject(id));
    toast('Project canceled', { undo: true });
    return res;
  });
  if (r && app.view.kind === 'project' && app.view.id === id) {
    if (areaId) goArea(areaId); else goList('today');
  }
}
export async function reopenProject(id) {
  return write(() => api.reopenProject(id));
}
export async function deleteProject(id) {
  const p = (app.data && app.data.project && app.data.project.id === id) ? app.data.project : findProject(id);
  const areaId = p ? p.areaId : null;
  const r = await write(async () => {
    const res = await api.deleteProject(id);
    pushUndo('move project to Trash', () => api.restoreProject(id));
    toast('Project moved to Trash', { undo: true });
    return res;
  });
  if (r && app.view.kind === 'project' && app.view.id === id) {
    if (areaId) goArea(areaId); else goList('today');
  }
}
export async function restoreProject(id) {
  return write(async () => {
    const res = await api.restoreProject(id);
    pushUndo('restore project', () => api.deleteProject(id));
    toast('Project restored', { undo: true });
    return res;
  });
}
export async function createHeading(projectId, name = 'New Heading', position) {
  const h = await write(() => api.createHeading(projectId, name, position));
  if (h && h.id) app.editHeading = h.id;
  return h;
}
export async function renameHeading(id, name) {
  return write(() => api.patchHeading(id, { name }));
}
export async function archiveHeading(id, archived = true) {
  return write(async () => {
    await api.patchHeading(id, { archived });
    pushUndo(archived ? 'archive heading' : 'unarchive heading', () => api.patchHeading(id, { archived: !archived }));
    toast(archived ? 'Heading archived' : 'Heading restored', { undo: true });
  });
}
export async function deleteHeading(id) {
  return write(async () => {
    await api.deleteHeading(id);
    toast('Heading deleted');
  });
}
// ---- Today's own headings (Store.addTodayHeading): in state.json, not in a
// note. Today's answer carries them as `headings: [{id, name, todos}]`.

/** The heading of Today's own a to-do is under, or null. */
export function todayHeadingOf(id) {
  const h = (app.data?.headings || []).find((x) => x.todos.includes(id));
  return h ? h.id : null;
}
/** `position`: 'top', or { after: a heading's id }; `todos` go under it. */
export async function createTodayHeading(name = 'New Heading', position = null, todos = []) {
  const h = await write(async () => {
    const made = await api.createTodayHeading(name, position);
    if (made && todos.length) await api.fileInToday(todos, made.id);
    return made;
  });
  if (h && h.id) app.editTodayHeading = h.id;
  return h;
}
export async function renameTodayHeading(id, name) {
  if (!name.trim()) return;
  return write(() => api.patchTodayHeading(id, { name }));
}
export async function deleteTodayHeading(id) {
  const hs = app.data?.headings || [];
  const h = hs.find((x) => x.id === id);
  if (!h) return;
  const order = hs.map((x) => x.id);
  return write(async () => {
    await api.deleteTodayHeading(id, h.name);
    // back as it was: the same heading, its to-dos under it, in its place
    pushUndo('delete heading', async () => {
      await api.createTodayHeading(h.name, null, h.id);
      if (h.todos.length) await api.fileInToday(h.todos, h.id);
      await api.reorder('today-headings', order);
      await refresh();
    });
    toast('Heading deleted. Its to-dos are still in Today.', { undo: true });
  });
}
export async function moveTodayHeading(id, dir) {
  const ids = (app.data?.headings || []).map((x) => x.id);
  const i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return write(() => api.reorder('today-headings', ids));
}
/** Put to-dos under one of Today's headings (null: under none). Shown at once;
 *  the server is told after, as a drag's reorder is. */
export async function fileInToday(ids, headingId) {
  for (const h of app.data?.headings || []) {
    h.todos = h.todos.filter((x) => !ids.includes(x));
    if (h.id === headingId) h.todos.push(...ids);
  }
  try {
    await api.fileInToday(ids, headingId);
  } catch (e) {
    toastError(e);
    refresh();
  }
}

export async function createArea(extra = {}) {
  try {
    const a = await api.createArea({ name: 'New Area', ...extra });
    app.editTitle = true;
    await goArea(a.id);
    return a;
  } catch (e) {
    toastError(e);
    return null;
  }
}
export async function patchArea(id, patch) {
  const d = app.data;
  if (d && d.area && d.area.id === id) Object.assign(d.area, patch);
  return write(() => api.patchArea(id, patch));
}
export async function deleteArea(id) {
  const r = await write(async () => {
    const res = await api.deleteArea(id);
    toast('Area deleted');
    return res;
  });
  if (r && app.view.kind === 'area' && app.view.id === id) goList('today');
}
/** File everything completed so far. Only does anything in manual mode. */
export async function logNow() {
  return write(async () => {
    const r = await api.logNow();
    toast('Logged');
    return r;
  });
}

export async function emptyTrash() {
  await write(async () => {
    await api.emptyTrash();
    toast('Trash emptied');
  });
}
export async function loadMoreLogbook() {
  const d = app.data;
  if (!d || !d.groups || !d.groups.length) return;
  const before = d.groups[d.groups.length - 1].date;
  try {
    const more = await api.getLogbook({ limit: 200, before });
    if (!more.groups || !more.groups.length) { app.logbookExhausted = true; return; }
    for (const g of more.groups) {
      const same = d.groups.find((x) => x.date === g.date);
      if (same) { same.items.push(...(g.items || [])); (same.projects ||= []).push(...(g.projects || [])); }
      else d.groups.push(g);
    }
  } catch (e) {
    toastError(e);
  }
}

// ------------------------------------------------------------------ popovers
function rectOf(el) {
  if (!el || !el.getBoundingClientRect) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
}
/**
 * kind: 'when' | 'deadline' | 'move' | 'tags' | 'menu' | 'confirm' | 'newlist'
 * target: { type: 'todo'|'project'|'area'|'heading', id }
 */
export function openPopover(kind, target, anchorEl, extra = {}) {
  app.quickFind = null;
  app.popover = { kind, target, rect: rectOf(anchorEl), ...extra };
}
export function closePopover() {
  app.popover = null;
}
export function openMenu(anchorEl, items, title) {
  openPopover('menu', null, anchorEl, { items, title });
}
export function confirm(anchorEl, title, actions) {
  openPopover('confirm', null, anchorEl, { title, items: actions });
}
export function openSource(path) {
  app.popover = null;
  app.quickFind = null;
  app.settingsOpen = false;
  app.source = path;
}
export function closeSource() { app.source = null; }

export function openSettings() {
  app.popover = null;
  app.quickFind = null;
  app.settingsOpen = true;
}
export function closeSettings() {
  app.settingsOpen = false;
}
/** Persist one or more server-side settings, optimistically. */
export async function saveSettings(patch) {
  const before = app.settings;
  app.settings = { ...(app.settings || {}), ...patch };
  try {
    applySettings(await api.putSettings(patch));
  } catch (e) {
    app.settings = before;
    toastError(e);
    return;
  }
  await refresh();
}
export function openQuickFind(query = '') {
  app.popover = null;
  app.quickFind = { query };
}
export function closeQuickFind() {
  app.quickFind = null;
}

/** Selected to-do, or the expanded one, whichever exists. */
export function currentTodoId() {
  return app.expanded || app.selection;
}

// ------------------------------------------------------------------ theme
export function getTheme() {
  try { return localStorage.getItem('dvarim.theme') || 'system'; } catch { return 'system'; }
}
export function getTextScale() {
  try { return Number(localStorage.getItem('dvarim.textScale')) || 100; } catch { return 100; }
}
export function setTextScale(pct) {
  const v = Math.max(85, Math.min(130, Number(pct) || 100));
  try {
    if (v === 100) localStorage.removeItem('dvarim.textScale');
    else localStorage.setItem('dvarim.textScale', String(v));
  } catch { /* ignore */ }
  if (typeof document !== 'undefined') document.documentElement.style.setProperty('--text-scale', String(v / 100));
}
export function setTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  else root.removeAttribute('data-theme');
  try {
    if (t === 'system') localStorage.removeItem('dvarim.theme'); else localStorage.setItem('dvarim.theme', t);
  } catch { /* ignore */ }
}
