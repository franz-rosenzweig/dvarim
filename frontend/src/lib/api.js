// Fetch wrapper for every endpoint in docs/API.md. Functions are named after the endpoints.
import * as offline from './offline.js';
import * as outbox from './outbox.js';
import { localBackend, SERVER_ONLY, serverRequest } from './backend.js';

const BASE = '/api';

/** Called whenever the server says we are not signed in, so the UI can swap to
 *  the login screen from wherever it happened, mid-refresh included. */
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

/**
 * Called with (true) when the server answers and (false, at) when it cannot be
 * reached — `at` being when the copy we handed back instead was taken, or null
 * when there was none to hand back. The store turns this into the offline
 * strip; nothing here decides what to show.
 */
let onReach = () => {};
export function setReachabilityHandler(fn) { onReach = fn; }

async function req(method, path, body) {
  const local = localBackend();
  // A vault on this device answers everything but what only a server can
  // (backend.js): a mirror asks its own server below; a vault that syncs with
  // a Dvarim server asks that one, with its token; one with no server answers
  // all of it itself.
  if (local) {
    if (!SERVER_ONLY.test(path)) return localReq(local, method, path, body);
    if (local.kind !== 'mirror') return local.server ? serverRequest(method, path, body) : localReq(local, method, path, body);
  }
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    throw unreachable();
  }
  // A 502, 503 or 504 is not the server answering. It is the tunnel in front of
  // it saying the server is not there — what the twenty seconds of every
  // redeploy look like — so it is the same as no network: a write is kept, a
  // read comes from the copy, rather than "error code: 502" and a lost edit.
  if (res.status === 502 || res.status === 503 || res.status === 504) throw unreachable();
  onReach(true);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.error) || (typeof data === 'string' && data) || `${res.status} ${res.statusText}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 && path !== '/login') onUnauthorized();
    throw err;
  }
  return data;
}

/**
 * The same request, answered by the engine on this device (lib/backend.js).
 * What goes in and what comes out is copied through JSON, exactly as it would
 * be over a network, so nothing on screen can reach into the engine's objects.
 */
async function localReq(local, method, path, body) {
  const res = await local.api.handle(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
  // a vault of this device's own can always be reached; whether a mirror's
  // server can is for its sync to say (store.svelte.js)
  if (local.kind !== 'mirror' && !local.server) onReach(true);
  const data = res.body === undefined || res.body === null ? null : JSON.parse(JSON.stringify(res.body));
  if (res.status >= 400) {
    const err = new Error((data && data.error) || `${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Status 0 is how everything here spells "the server could not be reached". */
function unreachable() {
  const err = new Error('Cannot reach the server');
  err.status = 0;
  return err;
}

/** Today where the person is standing, which is what a completion means. */
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The reads a list is built from, and so the ones worth keeping a copy of. */
const KEPT = /^\/(state|settings|tags|lists\/|projects\/|areas\/)/;

/**
 * A read that has an answer even when the server does not.
 *
 * Every answer that a list is built from is kept as it arrives (lib/offline.js);
 * when the server cannot be reached, the last one is handed back instead, and
 * the store is told how old it is. A real answer from the server — a 404, a
 * 401 — is still an answer and goes through untouched: only a failure to
 * connect is a reason to fall back.
 */
async function read(path) {
  try {
    const data = await req('GET', path);
    // a copy is for when the server cannot be reached; a vault on this device always can
    if (KEPT.test(path) && !localBackend()) offline.remember(path, data);
    return data;
  } catch (e) {
    if (e.status !== 0 || !KEPT.test(path)) throw e;
    const kept = await offline.recall(path);
    const waiting = await outbox.pending();
    if (!kept) {
      // A project or area made offline has no copy, because the server has
      // never answered for it; what it would answer is what it was made from.
      const made = outbox.synthesize(path, waiting, context().today);
      onReach(false, made ? context().staleAt : null);
      if (!made) throw e;
      return made;
    }
    onReach(false, kept.at);
    return outbox.overlay(path, kept.data, waiting, context().today);
  }
}

// ---- Writes that wait
//
// A write the server cannot be reached for is recorded (lib/outbox.js) and
// answered as if it had happened: the store gets back the to-do as it will
// be, shows it, and carries on. The kept copies are read with the waiting
// edits laid over them, so the change stays on screen across reloads. When
// the server answers again, drain() sends everything in order.
//
// Only a failure to connect is treated this way. A 400 or a 404 is the
// server's answer and is thrown as it always was.

/** The store's view of the moment: which list is on screen (as its API path,
 *  so a to-do made there shows there), today's date as last heard, the
 *  settings in force (a queued change answers with them merged), the names of
 *  areas (a project made offline in one shows the area's name), and when the
 *  lists on screen were last true. */
let context = () => ({ list: null, today: null, settings: {}, areaName: () => null, todo: () => null, staleAt: null });
export function setOutboxContext(fn) { context = fn; }

/** How many edits are waiting; the strip shows it. */
let onPending = () => {};
export function setPendingHandler(fn) { onPending = fn; }
async function countPending() { onPending((await outbox.pending()).length); }

/**
 * Try the call; if the server cannot be reached, keep the operation and
 * answer with `instead`, which is what the call would have returned.
 */
async function queued(op, call, instead) {
  try {
    return await call();
  } catch (e) {
    if (e.status !== 0) throw e;
    const key = await outbox.record(op);
    if (key === null) throw e;         // nowhere to keep it: say so rather than lose it
    onReach(false);
    countPending();
    return instead;
  }
}

let draining = null;
/**
 * Send what is waiting, oldest first. Stops at the first operation the
 * server cannot be reached for, since the rest would fail the same way — and
 * at a 401 too: a session that lapsed while the phone was away is a reason to
 * sign in, not to throw away everything made meanwhile. The login screen is
 * already up by then (req() saw to it) and signedIn() sends them afterwards.
 * Resolves with what happened to the rest: `{ sent, dropped:[{op, why}] }`.
 * An operation the server refuses outright — the to-do was deleted
 * elsewhere, or the id was never valid — is dropped and reported; it would
 * refuse it the same way forever.
 */
export function drain() {
  // What waits in the outbox was meant for the server. In local mode it stays
  // where it is, for when the server is back, rather than landing in this
  // device's vault.
  if (localBackend()) return Promise.resolve({ sent: 0, dropped: [] });
  if (draining) return draining;
  draining = (async () => {
    const result = { sent: 0, dropped: [] };
    for (const op of await outbox.pending()) {
      try {
        await outbox.send(calls, op);
        await outbox.done(op.key);
        result.sent++;
      } catch (e) {
        if (e.status === 0 || e.status === 401) break;   // gone, or signed out: the rest wait with it
        // A heading's id is its name, so "heading exists" on a create means
        // the create has landed already — a sync that got that far and no
        // further — and there is nothing left to send.
        if (e.status === 409 && op.kind === 'heading-create') {
          await outbox.done(op.key);
          result.sent++;
          continue;
        }
        if (e.status === 409) {         // the file moved on; once more, on the fresh copy
          try {
            await outbox.send(calls, op);
            await outbox.done(op.key);
            result.sent++;
            continue;
          } catch (e2) {
            if (e2.status === 0 || e2.status === 401) break;
            e = e2;
          }
        }
        await outbox.done(op.key);
        result.dropped.push({ op, why: e.message });
      }
    }
    countPending();
    return result;
  })().finally(() => { draining = null; });
  return draining;
}

/** Ask once at startup, so the strip is right before anyone types. */
export const pendingCount = () => (localBackend() ? Promise.resolve(0) : outbox.pending().then((ops) => ops.length));

const q = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
};

// ---- Read
export const getState = () => read('/state');

// ---- Sign in
export const authState = () => req('GET', '/auth');
// A name signs in as that person; none, as the server's owner (docs/PEOPLE.md).
export const login = (password, name = '') => req('POST', '/login', name.trim() ? { name: name.trim(), password } : { password });
export const logout = async () => {
  try {
    return await req('POST', '/logout');
  } finally {
    await offline.forget();           // the copies are theirs, not the browser's
  }
};
export const changePassword = (currentPassword, newPassword) => req('POST', '/password', { currentPassword, newPassword });
/** What this browser kept for whoever was signed in before: lists and edits waiting. */
export const forgetKept = () => offline.forget();

// ---- other people on the owner's server (docs/PEOPLE.md)
export const checkInvite = (code) => req('GET', `/join/${encodeURIComponent(code)}`);
export const joinWith = (code, name, password) => req('POST', '/join', { code, name, password });
export const getPeople = () => req('GET', '/people');
export const setOwnerName = (name) => req('PUT', '/people/owner', { name });
export const invitePerson = (note) => req('POST', '/people/invites', { note });
export const cancelInvite = (id) => req('DELETE', `/people/invites/${id}`);
export const removePerson = (key) => req('DELETE', `/people/${encodeURIComponent(key)}`);
export const resetPassword = (key, password) => req('POST', `/people/${encodeURIComponent(key)}/password`, { password });
export const inviteRequest = (id) => req('POST', `/people/requests/${id}/invite`, {});
export const dismissRequest = (id) => req('DELETE', `/people/requests/${id}`);
// asking for an account, signed out
export const canAsk = () => req('GET', '/requests');
export const askForAccount = (body) => req('POST', '/requests', body);
// "Meet Dvarim" again (Store.addTutorial)
export const createTutorial = () => req('POST', '/tutorial', {});
export const getList = (id, params) => read(`/lists/${id}${q(params)}`);
export const getLogbook = (params) => getList('logbook', params);
export const getProject = (id) => read(`/projects/${id}`);
export const getTodo = (id) => read(`/todos/${id}`);
export const getArea = (id) => read(`/areas/${id}`);
export const getTags = () => read('/tags');
export const search = (text) => req('GET', `/search${q({ q: text })}`);
export const parseRepeat = (repeat, when) => req('POST', '/parse-repeat', { repeat, when });
export const parseDate = (text) => req('POST', '/parse-date', { text });

// ---- To-dos. These are the writes that wait (see above); the rest of the
// API — projects, areas, headings, settings — still needs the server.
/** A to-do as the server would answer, for a create it has not seen. */
function asTodo(id, body, today) {
  return { id, status: 'open', created: today, notes: '', tags: [], checklist: [], when: null, evening: false,
           someday: false, reminder: null, deadline: null, repeat: null, completed: null, ...body };
}
export const createTodo = (body) => {
  const c = context();
  const id = body.id || outbox.newId();
  return queued({ kind: 'create', id, body, list: c.list, title: body.title },
                () => req('POST', '/todos', { ...body, id }), asTodo(id, body, c.today));
};
export const patchTodo = (id, patch) =>
  queued({ kind: 'patch', id, patch }, () => req('PATCH', `/todos/${id}`, patch), { id, ...patch });
// `on` is the day it was ticked. Nothing passes it online — the server's own
// date is right when it hears at once — but a queued one carries the day it
// was recorded, so a to-do completed on a plane is filed under that day and
// not under the day the phone found signal again.
export const completeTodo = (id, on) =>
  queued({ kind: 'complete', id, on: on || localDay() },
         () => req('POST', `/todos/${id}/complete`, on ? { on } : {}), { todo: { id, status: 'done' }, next: null });
export const cancelTodo = (id, on) =>
  queued({ kind: 'cancel', id, on: on || localDay() },
         () => req('POST', `/todos/${id}/cancel`, on ? { on } : {}), { id, status: 'canceled' });
export const reopenTodo = (id) =>
  queued({ kind: 'reopen', id }, () => req('POST', `/todos/${id}/reopen`, {}), { id, status: 'open' });
export const moveTodo = (id, body) =>
  queued({ kind: 'move', id, body }, () => req('POST', `/todos/${id}/move`, body), { id });
/**
 * To-do becomes project. The server mints a project and one to-do per
 * checklist item; offline the page mints them instead, and carries a copy of
 * what the to-do was, so the project it opens has something to show before
 * the server has ever answered for it.
 */
export const convertTodo = (id, ids) => {
  const c = context();
  const from = c.todo(id) || { id, title: 'New Project', checklist: [] };
  const pid = (ids && ids.id) || outbox.newId('p');
  const checklist = (ids && ids.checklist) || (from.checklist || []).map(() => outbox.newId());
  const body = { name: from.title, notes: from.notes || '', when: from.when || null, deadline: from.deadline || null,
                 tags: from.tags || [], someday: !!from.someday, areaId: from.areaId || null };
  const items = (from.checklist || []).map((x, i) => ({ id: checklist[i], title: x.text, status: x.done ? 'done' : 'open',
                                                        completed: x.done ? c.today : null, created: c.today }));
  return queued({ kind: 'convert', id, projectId: pid, checklist, body, items, name: from.title },
                () => req('POST', `/todos/${id}/convert`, { id: pid, checklist }),
                outbox.asProject(pid, body, c.today, c.areaName(body.areaId)));
};
export const duplicateTodo = (id, copyId) => {
  const c = context();
  const from = c.todo(id) || { id };
  const made = copyId || outbox.newId();
  return queued({ kind: 'duplicate', id, copyId: made, title: from.title },
                () => req('POST', `/todos/${id}/duplicate`, { id: made }),
                { ...from, id: made });
};
export const deleteTodo = (id) =>
  queued({ kind: 'delete', id }, () => req('DELETE', `/todos/${id}`), { id });
export const restoreTodo = (id) =>
  queued({ kind: 'restore', id }, () => req('POST', `/todos/${id}/restore`), { id });
export const reorder = (ctx, ids) =>
  queued({ kind: 'reorder', context: ctx, ids, list: context().list }, () => req('POST', '/reorder', { context: ctx, ids }), { ok: true });
/**
 * The quick-entry grammar — "Call the plumber tomorrow 3pm #home" —
 * which the server parses. Offline it cannot be parsed here without keeping a
 * second copy of that grammar, so what was typed is queued as typed and the
 * row shows the raw line until the server has had it and answered properly.
 */
export const quickAdd = (text, list) => {
  const c = context();
  const id = outbox.newId();
  // `list` is the list it shows in offline, as for a create; `target` is the
  // list the endpoint puts it in.
  return queued({ kind: 'quick-add', id, text, target: list, list: `/lists/${list || 'inbox'}`, title: text },
                () => req('POST', '/quick-add', { text, id, ...(list ? { list } : {}) }),
                asTodo(id, { title: text, inbox: (list || 'inbox') === 'inbox', when: list === 'today' ? c.today : null }, c.today));
};

// ---- Projects, headings. These wait too. A project made offline gets an id
// the way a to-do does, with the server's own p in front; a heading's id is
// its project's id and its name, which needs no minting.
export const createProject = (body) => {
  const c = context();
  const id = body.id || outbox.newId('p');
  return queued({ kind: 'project-create', id, body, name: body.name },
                () => req('POST', '/projects', { ...body, id }),
                outbox.asProject(id, body, c.today, c.areaName(body.areaId)));
};
export const patchProject = (id, patch) =>
  queued({ kind: 'project-patch', id, patch, name: patch.name }, () => req('PATCH', `/projects/${id}`, patch), { id, ...patch });
export const completeProject = (id, completeOpenTodos) =>
  queued({ kind: 'project-complete', id, completeOpenTodos },
         () => req('POST', `/projects/${id}/complete`, completeOpenTodos === undefined ? {} : { completeOpenTodos }), { id, status: 'done' });
export const cancelProject = (id) =>
  queued({ kind: 'project-cancel', id }, () => req('POST', `/projects/${id}/cancel`), { id, status: 'canceled' });
export const reopenProject = (id) =>
  queued({ kind: 'project-reopen', id }, () => req('POST', `/projects/${id}/reopen`), { id, status: 'open' });
export const deleteProject = (id) =>
  queued({ kind: 'project-delete', id }, () => req('DELETE', `/projects/${id}`), { id });
export const restoreProject = (id) =>
  queued({ kind: 'project-restore', id }, () => req('POST', `/projects/${id}/restore`), { id });
export const createHeading = (projectId, name, position) =>
  queued({ kind: 'heading-create', projectId, name, position },
         () => req('POST', `/projects/${projectId}/headings`, position ? { name, position } : { name }),
         { id: `${projectId}:${name}`, name, archived: null });
export const patchHeading = (id, patch) =>
  queued({ kind: 'heading-patch', id, patch, name: patch.name || id.split(':').slice(1).join(':') },
         () => req('PATCH', `/headings/${encodeURIComponent(id)}`, patch),
         { id: patch.name ? `${id.split(':')[0]}:${patch.name}` : id, name: patch.name || id.split(':').slice(1).join(':'), archived: patch.archived ? context().today : null });
export const deleteHeading = (id) =>
  queued({ kind: 'heading-delete', id, name: id.split(':').slice(1).join(':') }, () => req('DELETE', `/headings/${encodeURIComponent(id)}`), { id });

// ---- Today's own headings, kept in state.json beside Today's order. The app
// mints the id, h and seven of 0-9a-z, so one made offline is the same heading
// once it is sent.
export const createTodayHeading = (name, position = null, id = outbox.newId('h')) =>
  queued({ kind: 'today-heading-create', id, name, position },
         () => req('POST', '/today/headings', position ? { id, name, position } : { id, name }), { id, name, todos: [] });
export const patchTodayHeading = (id, patch, name = patch.name) =>
  queued({ kind: 'today-heading-patch', id, patch, name }, () => req('PATCH', `/today/headings/${encodeURIComponent(id)}`, patch), { id, ...patch });
export const deleteTodayHeading = (id, name) =>
  queued({ kind: 'today-heading-delete', id, name }, () => req('DELETE', `/today/headings/${encodeURIComponent(id)}`), { ok: true });
export const fileInToday = (ids, headingId) =>
  queued({ kind: 'today-file', ids, headingId }, () => req('POST', '/today/file', { ids, headingId }), []);

// ---- Areas
export const createArea = (body) => {
  const id = body.id || outbox.newId('a');
  return queued({ kind: 'area-create', id, body, name: body.name }, () => req('POST', '/areas', { ...body, id }), outbox.asArea(id, body));
};
export const patchArea = (id, patch) =>
  queued({ kind: 'area-patch', id, patch, name: patch.name }, () => req('PATCH', `/areas/${id}`, patch), { id, ...patch });
export const deleteArea = (id) =>
  queued({ kind: 'area-delete', id }, () => req('DELETE', `/areas/${id}`), { id });

// ---- Misc
export const logbookPending = () => req('GET', '/logbook/pending');
// Filing and emptying: no ids to mint, and both mean "as of now", so the day
// goes with the first of them and the order of the queue does the rest — a
// to-do deleted after an empty-trash is still in the Trash afterwards.
export const logNow = (cutoff) =>
  queued({ kind: 'log-now', cutoff: cutoff || localDay() },
         () => req('POST', '/logbook/log-now', cutoff ? { cutoff } : {}),
         { pending: 0, mode: (context().settings || {}).logCompleted || 'immediately' });
export const emptyTrash = () =>
  queued({ kind: 'empty-trash' }, () => req('POST', '/trash/empty'), { ok: true });
export const getSettings = () => read('/settings');
export const putSettings = (s) =>
  queued({ kind: 'settings', patch: s }, () => req('PUT', '/settings', s), { ...context().settings, ...s });

// Calendars and the CalDAV task mirror, used by Settings -> Calendar.
// The raw Markdown behind a project or area, for the source editor.
export const readFile = (path) => req('GET', `/file?path=${encodeURIComponent(path)}`);
export const writeFile = (path, text, sha) => req('PUT', `/file?path=${encodeURIComponent(path)}`, { text, sha });

export const getCalendars = () => req('GET', '/calendars');
/** What merging has done on this device (local mode only; docs/SYNC.md). */
export const getSync = () => req('GET', '/sync');
// the devices that sync with this server (server/src/app.js): tokens, made and revoked here
export const getDevices = () => req('GET', '/tokens');
export const addDevice = (name) => req('POST', '/tokens', { name });
export const removeDevice = (name) => req('DELETE', `/tokens/${encodeURIComponent(name)}`);
export const getTaskSync = () => req('GET', '/tasksync');
export const runTaskSync = () => req('POST', '/tasksync');

/**
 * Server-Sent Events. Calls onChanged(files) for every `changed` event and onStatus(bool)
 * when the connection state flips. Reconnects with exponential backoff. Returns a stop().
 */
export function subscribe(onChanged, onStatus) {
  const local = localBackend();
  if (local) {
    // the engine says when the vault changes, as the server's stream would
    const stop = local.api.subscribe((paths) => onChanged(paths));
    if (onStatus) onStatus(true);
    return stop;
  }
  let es = null;
  let stopped = false;
  let delay = 1000;
  let timer = null;

  function connect() {
    if (stopped) return;
    try {
      es = new EventSource(`${BASE}/stream`);
    } catch {
      schedule();
      return;
    }
    es.onopen = () => {
      delay = 1000;
      onStatus && onStatus(true);
    };
    es.addEventListener('changed', (ev) => {
      let files = [];
      try { files = JSON.parse(ev.data || '{}').files || []; } catch { /* ignore */ }
      onChanged(files);
    });
    es.onerror = () => {
      onStatus && onStatus(false);
      if (es) { es.close(); es = null; }
      schedule();
    };
  }
  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      delay = Math.min(delay * 2, 30000);
      connect();
    }, delay);
  }
  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (es) es.close();
  };
}

/** For lib/outbox.js, which sends a kept operation as the call it stands for. */
const calls = { createTodo, patchTodo, completeTodo, cancelTodo, reopenTodo, moveTodo, deleteTodo, restoreTodo, reorder,
                createProject, patchProject, completeProject, cancelProject, reopenProject, deleteProject, restoreProject,
                createHeading, patchHeading, deleteHeading, createTodayHeading, patchTodayHeading, deleteTodayHeading, fileInToday,
                createArea, patchArea, deleteArea, putSettings,
                convertTodo, duplicateTodo, quickAdd, logNow, emptyTrash };
