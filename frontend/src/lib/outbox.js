// Edits made while the server cannot be reached, kept until it can.
//
// Every write the app makes is one call to the API: a PATCH of the fields that
// changed, a POST that completes or moves one to-do, a reorder of one list.
// That granularity is what makes offline editing safe over a vault that other
// things also write to — Obsidian, Syncthing, a CalDAV client. An edit made on
// the plane is the same call, made later: it lands on whatever the to-do has
// become meanwhile and changes only the fields it names. There is no merge
// step to get wrong, because there is no whole object to merge.
//
// So an operation is recorded here exactly as it would have been sent, in
// order, and sent in that order when the server answers again. Between the
// two, the lists on screen come from the kept copies in lib/offline.js, and
// `overlay()` lays these operations over them so the row you completed shows
// as completed and the to-do you made is there under your finger. It changes
// rows where they are; it does not re-file them — a to-do dated for next week
// stays in Today, wearing its new date, until the server has done the filing.
// Re-implementing the server's rules here would be a second copy that drifts.
//
// Anything made offline needs an id before the server has heard of it, so the
// phone mints one in the server's own alphabet and shape (see backend ids.py,
// and Store._client_id, which takes it and treats a repeat as already done):
// a to-do's is eight of 0-9a-z, a project's starts with p, an area's with a.
// A heading's id is its project's id and its name, so it needs no minting;
// renaming one renames its id, and the overlay renames it everywhere the
// page could read it from, so nothing recorded afterwards names the old one.
import * as offline from './offline.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** An id the server would have made: eight of 0-9a-z, behind `prefix`. */
export function newId(prefix = '') {
  const bytes = new Uint8Array(8 - prefix.length);
  crypto.getRandomValues(bytes);
  let id = prefix;
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

/** Everything waiting, oldest first. */
export const pending = () => offline.outboxAll();

/**
 * Record one operation. `op` is `{ kind, ... }` as send() reads it.
 *
 * Flattened to plain data first. Half of what an operation carries comes off
 * the store — a to-do's tags, a checklist — and those are Svelte's reactive
 * proxies, which IndexedDB cannot structured-clone: it throws, the write is
 * lost, and the page is told the edit could not be kept. Going through JSON
 * is what makes the operation the plain record it is supposed to be, and it
 * is the only place that has to remember.
 */
export function record(op) {
  let plain;
  try {
    plain = JSON.parse(JSON.stringify({ ...op, at: Date.now() }));
  } catch {
    return Promise.resolve(null);     // not data: better refused than lost
  }
  return offline.outboxAdd(plain);
}

/** It has been sent, or given up on. */
export const done = (key) => offline.outboxRemove(key);

/**
 * The API call an operation stands for. One place, so recording and sending
 * cannot disagree about what an operation means.
 */
export function send(api, op) {
  switch (op.kind) {
    case 'create':           return api.createTodo({ ...op.body, id: op.id });
    case 'patch':            return api.patchTodo(op.id, op.patch);
    case 'complete':         return api.completeTodo(op.id, op.on);
    case 'cancel':           return api.cancelTodo(op.id, op.on);
    case 'reopen':           return api.reopenTodo(op.id);
    case 'delete':           return api.deleteTodo(op.id);
    case 'restore':          return api.restoreTodo(op.id);
    case 'move':             return api.moveTodo(op.id, op.body);
    case 'reorder':          return api.reorder(op.context, op.ids);
    case 'project-create':   return api.createProject({ ...op.body, id: op.id });
    case 'project-patch':    return api.patchProject(op.id, op.patch);
    case 'project-complete': return api.completeProject(op.id, op.completeOpenTodos);
    case 'project-cancel':   return api.cancelProject(op.id);
    case 'project-reopen':   return api.reopenProject(op.id);
    case 'project-delete':   return api.deleteProject(op.id);
    case 'project-restore':  return api.restoreProject(op.id);
    case 'heading-create':   return api.createHeading(op.projectId, op.name, op.position);
    case 'heading-patch':    return api.patchHeading(op.id, op.patch);
    case 'heading-delete':   return api.deleteHeading(op.id);
    case 'today-heading-create': return api.createTodayHeading(op.name, op.position, op.id);
    case 'today-heading-patch':  return api.patchTodayHeading(op.id, op.patch, op.name);
    case 'today-heading-delete': return api.deleteTodayHeading(op.id, op.name);
    case 'today-file':       return api.fileInToday(op.ids, op.headingId);
    case 'area-create':      return api.createArea({ ...op.body, id: op.id });
    case 'area-patch':       return api.patchArea(op.id, op.patch);
    case 'area-delete':      return api.deleteArea(op.id);
    case 'settings':         return api.putSettings(op.patch);
    case 'convert':          return api.convertTodo(op.id, { id: op.projectId, checklist: op.checklist });
    case 'duplicate':        return api.duplicateTodo(op.id, op.copyId);
    case 'quick-add':        return api.quickAdd(op.text, op.target);
    case 'log-now':          return api.logNow(op.cutoff);
    case 'empty-trash':      return api.emptyTrash();
    default:                 return Promise.reject(new Error(`unknown operation ${op.kind}`));
  }
}

/** A sentence for the toast when an operation could not be kept. */
export function describe(op) {
  const q = (s) => (s ? `“${s}”` : null);
  const todo = q(op.title) || 'a to-do';
  const project = q(op.name) || 'a project';
  const area = q(op.name) || 'an area';
  const heading = q(op.name) || 'a heading';
  switch (op.kind) {
    case 'create':           return `adding ${todo}`;
    case 'patch':            return `editing ${todo}`;
    case 'complete':         return `completing ${todo}`;
    case 'cancel':           return `canceling ${todo}`;
    case 'reopen':           return `reopening ${todo}`;
    case 'delete':           return `deleting ${todo}`;
    case 'restore':          return `restoring ${todo}`;
    case 'move':             return `moving ${todo}`;
    case 'reorder':          return 'reordering a list';
    case 'project-create':   return `adding ${project}`;
    case 'project-patch':    return `editing ${project}`;
    case 'project-complete': return `completing ${project}`;
    case 'project-cancel':   return `canceling ${project}`;
    case 'project-reopen':   return `reopening ${project}`;
    case 'project-delete':   return `deleting ${project}`;
    case 'project-restore':  return `restoring ${project}`;
    case 'heading-create':   return `adding the heading ${heading}`;
    case 'heading-patch':    return `editing the heading ${heading}`;
    case 'heading-delete':   return `deleting the heading ${heading}`;
    case 'today-heading-create': return `adding the heading ${heading} to Today`;
    case 'today-heading-patch':  return `renaming the heading ${heading} in Today`;
    case 'today-heading-delete': return `deleting the heading ${heading} from Today`;
    case 'today-file':       return 'putting a to-do under a heading in Today';
    case 'area-create':      return `adding ${area}`;
    case 'area-patch':       return `editing ${area}`;
    case 'area-delete':      return `deleting ${area}`;
    case 'settings':         return 'changing a setting';
    case 'convert':          return `turning ${todo} into a project`;
    case 'duplicate':        return `duplicating ${todo}`;
    case 'quick-add':        return `adding ${todo}`;
    case 'log-now':          return 'filing what was completed';
    case 'empty-trash':      return 'emptying the Trash';
    default:                 return 'a change';
  }
}

// ------------------------------------------------------------- the overlay

/** Every `items` array anywhere in a list payload, whatever its shape:
 *  Today's `items`, Upcoming's `days[].items`, Anytime's `groups[].items`,
 *  the Logbook's `groups[].items`, a project's `items`. */
function itemArrays(data, out = []) {
  if (!data || typeof data !== 'object') return out;
  if (Array.isArray(data)) {
    for (const x of data) itemArrays(x, out);
    return out;
  }
  for (const [k, v] of Object.entries(data)) {
    if (k === 'items' && Array.isArray(v)) out.push(v);
    else if (v && typeof v === 'object') itemArrays(v, out);
  }
  return out;
}

function findIn(arrays, id) {
  for (const arr of arrays) {
    const i = arr.findIndex((t) => t && t.id === id);
    if (i >= 0) return { arr, i, t: arr[i] };
  }
  return null;
}

/** Every array of projects in a payload: the sidebar's `areas[].projects` and
 *  `looseProjects`, an area view's `area.projects`, Someday's `projects`. */
function projectArrays(data, out = []) {
  if (!data || typeof data !== 'object') return out;
  if (Array.isArray(data)) {
    for (const x of data) projectArrays(x, out);
    return out;
  }
  for (const [k, v] of Object.entries(data)) {
    if ((k === 'projects' || k === 'looseProjects') && Array.isArray(v)) out.push(v);
    else if (v && typeof v === 'object') projectArrays(v, out);
  }
  return out;
}

/** The one project a payload is about, if it is a project view. */
const viewProject = (data) => (data && data.project && data.project.id ? data.project : null);

/** Every copy of a project in a payload: the view's own, and the sidebar's.
 *  A heading changed offline has to change in both, or the move popover —
 *  which reads the sidebar's — would offer a heading the server has renamed
 *  by the time the move is sent. */
function projectCopies(data, id) {
  const out = [];
  const p = viewProject(data);
  if (p && p.id === id) out.push(p);
  for (const arr of projectArrays(data)) for (const q of arr) if (q && q.id === id) out.push(q);
  return out;
}
const viewArea = (data) => (data && data.area && data.area.id ? data.area : null);

/** A project as the server would answer, for one it has not seen. */
export function asProject(id, body, today, areaName = null) {
  return { id, name: body.name || 'New Project', notes: body.notes || '', status: 'open', when: body.when || null,
           evening: false, someday: !!body.someday, deadline: body.deadline || null, repeat: null,
           tags: body.tags || [], created: today, completed: null, areaId: body.areaId || null, areaName,
           progress: 0, openCount: 0, doneCount: 0, headings: [], file: null };
}

/** An area as the server would answer, for one it has not seen. */
export function asArea(id, body) {
  return { id, name: body.name || 'New Area', notes: body.notes || '', tags: body.tags || [], file: null,
           projects: [], openCount: 0 };
}

/** Where a project sits in a sidebar payload, or null. */
function findProject(data, id) {
  for (const arr of projectArrays(data)) {
    const i = arr.findIndex((p) => p && p.id === id);
    if (i >= 0) return { arr, i, p: arr[i] };
  }
  return null;
}

/** The array a project belongs in, given its area: an area's `projects`, or
 *  the loose list. Only the sidebar payload has both. */
function projectHome(data, areaId) {
  if (!Array.isArray(data.areas)) return null;
  if (areaId) {
    const a = data.areas.find((x) => x.id === areaId);
    return a ? (a.projects || (a.projects = [])) : null;
  }
  return data.looseProjects || (data.looseProjects = []);
}

/**
 * A kept copy of `path`, with the waiting operations laid over it.
 *
 * Pure: `data` is not touched, and the same input gives the same answer, so
 * it can run on every read from the cache. `today` is the server's idea of
 * today as last heard, for the completed date.
 */
export function overlay(path, data, ops, today) {
  if (!ops.length || !data) return data;
  const out = JSON.parse(JSON.stringify(data));
  const arrays = itemArrays(out);
  const isState = path === '/state';
  for (const op of ops) {
    switch (op.kind) {
      // ---- to-dos
      case 'create': {
        // Where it was made is where it shows, at the end, like a new to-do
        // on a list does. A list it was not made in does not know it yet.
        if (op.list === path && Array.isArray(out.items) && !findIn(arrays, op.id)) {
          out.items.push({ ...op.body, id: op.id, status: 'open', created: today, tags: op.body.tags || [],
                           checklist: op.body.checklist || [], notes: op.body.notes || '' });
        }
        break;
      }
      case 'quick-add': {
        // Whatever was typed, as it was typed: the grammar in it is the
        // server's to read, and it will when it hears (see api.quickAdd).
        if (op.list === path && Array.isArray(out.items) && !findIn(arrays, op.id)) {
          out.items.push({ id: op.id, title: op.text, status: 'open', created: today, tags: [], checklist: [],
                           notes: '', when: op.target === 'today' ? today : null, inbox: (op.target || 'inbox') === 'inbox' });
        }
        break;
      }
      case 'duplicate': {
        // Beside the one it was made from, which is where the server puts it.
        const from = findIn(arrays, op.id);
        if (from && !findIn(arrays, op.copyId)) from.arr.splice(from.i + 1, 0, { ...from.t, id: op.copyId });
        break;
      }
      case 'convert': {
        // The to-do goes, and a project takes its place in the sidebar.
        const gone = findIn(arrays, op.id);
        if (gone) gone.arr.splice(gone.i, 1);
        const home = isState ? projectHome(out, op.body.areaId)
                             : (viewArea(out) && viewArea(out).id === op.body.areaId ? viewArea(out).projects : null);
        if (home && !home.some((q) => q.id === op.projectId)) {
          const area = isState && op.body.areaId ? out.areas.find((a) => a.id === op.body.areaId) : viewArea(out);
          home.push(asProject(op.projectId, op.body, today, area ? area.name : null));
        }
        break;
      }
      case 'empty-trash': {
        // The only list it shows in is the one it empties.
        if (path === '/lists/trash') { out.items = []; out.projects = []; }
        break;
      }
      case 'log-now': {
        // The setting is what this is; which to-dos it then files is the
        // server's rule, and it applies it when it hears — as it does for a
        // to-do completed offline, which also waits to be filed.
        if (path === '/settings') out.logCutoff = op.cutoff;
        if (isState && out.settings) out.settings.logCutoff = op.cutoff;
        break;
      }
      // ---- Today's own headings: only Today shows them
      case 'today-heading-create': case 'today-heading-patch': case 'today-heading-delete': case 'today-file': {
        if (path !== '/lists/today') break;
        const hs = out.headings || (out.headings = []);
        if (op.kind === 'today-heading-create' && !hs.some((h) => h.id === op.id)) {
          const h = { id: op.id, name: op.name, todos: [] };
          if (op.position === 'top') hs.unshift(h);
          else if (op.position && op.position.after) hs.splice(hs.findIndex((x) => x.id === op.position.after) + 1, 0, h);
          else hs.push(h);
        }
        if (op.kind === 'today-heading-patch') for (const h of hs) if (h.id === op.id && op.patch.name) h.name = op.patch.name;
        if (op.kind === 'today-heading-delete') out.headings = hs.filter((h) => h.id !== op.id);
        if (op.kind === 'today-file') {
          for (const h of hs) h.todos = h.todos.filter((id) => !op.ids.includes(id));
          const to = hs.find((h) => h.id === op.headingId);
          if (to) to.todos.push(...op.ids);
        }
        break;
      }
      case 'reorder': {
        if (op.context === 'today-headings') {
          if (path === '/lists/today' && Array.isArray(out.headings)) {
            const rank = new Map(op.ids.map((id, i) => [id, i]));
            out.headings.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity));
          }
          break;
        }
        if (op.list === path && Array.isArray(out.items)) {
          const rank = new Map(op.ids.map((id, i) => [id, i]));
          out.items.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity));
        }
        break;
      }
      case 'patch': case 'complete': case 'cancel': case 'reopen': case 'delete': case 'restore': case 'move': {
        const hit = findIn(arrays, op.id);
        if (!hit) break;
        const t = hit.t;
        switch (op.kind) {
          case 'patch':    Object.assign(t, op.patch); break;
          case 'complete': t.status = 'done'; t.completed = today; break;
          case 'cancel':   t.status = 'canceled'; t.completed = today; break;
          case 'reopen':   t.status = 'open'; t.completed = null; break;
          case 'delete':   hit.arr.splice(hit.i, 1); break;
          case 'restore':  break;          // it is in Trash's copy; the list it goes back to learns on sync
          case 'move':     Object.assign(t, moveFields(op.body)); break;
        }
        break;
      }
      // ---- projects. The sidebar payload lists them by area; a project view
      // carries one; an area view carries its own. Each is changed where it
      // is; closing or deleting one takes it out of the sidebar, as the
      // server's answer would not have it either.
      case 'project-create': {
        const home = isState ? projectHome(out, op.body.areaId) : (viewArea(out) && viewArea(out).id === op.body.areaId ? viewArea(out).projects : null);
        if (home && !home.some((p) => p.id === op.id)) {
          const area = isState && op.body.areaId ? out.areas.find((a) => a.id === op.body.areaId) : viewArea(out);
          home.push(asProject(op.id, op.body, today, area ? area.name : null));
        }
        break;
      }
      case 'project-patch': {
        const p = viewProject(out);
        if (p && p.id === op.id) Object.assign(p, op.patch);
        const hit = findProject(out, op.id);
        if (hit) {
          Object.assign(hit.p, op.patch);
          // moved to another area: it belongs in that area's list now
          if (isState && 'areaId' in op.patch) {
            const home = projectHome(out, op.patch.areaId);
            if (home && home !== hit.arr) {
              hit.arr.splice(hit.i, 1);
              const area = op.patch.areaId ? out.areas.find((a) => a.id === op.patch.areaId) : null;
              hit.p.areaName = area ? area.name : null;
              home.push(hit.p);
            }
          }
        }
        break;
      }
      case 'project-complete': case 'project-cancel': case 'project-delete': {
        const p = viewProject(out);
        if (p && p.id === op.id) {
          if (op.kind !== 'project-delete') { p.status = op.kind === 'project-complete' ? 'done' : 'canceled'; p.completed = today; }
        }
        const hit = findProject(out, op.id);
        if (hit) hit.arr.splice(hit.i, 1);
        break;
      }
      case 'project-reopen': {
        const p = viewProject(out);
        if (p && p.id === op.id) { p.status = 'open'; p.completed = null; }
        break;
      }
      case 'project-restore': break;       // it is in Trash's copy; the sidebar learns on sync
      // ---- headings, which only a project view carries
      case 'heading-create': {
        const id = `${op.projectId}:${op.name}`;
        for (const p of projectCopies(out, op.projectId)) {
          p.headings = p.headings || [];
          if (p.headings.some((h) => h.id === id)) continue;
          const h = { id, name: op.name, archived: null };
          const pos = op.position;
          if (pos === 'top') p.headings.unshift(h);
          else if (pos && pos.beforeHeading) {
            const i = p.headings.findIndex((x) => x.id === pos.beforeHeading);
            p.headings.splice(i < 0 ? p.headings.length : i, 0, h);
          } else p.headings.push(h);
        }
        // At a to-do: everything from there to the end of its section comes
        // under the new heading, as it would in the file.
        const at = op.position && (op.position.before || op.position.after);
        const view = viewProject(out);
        if (at && view && view.id === op.projectId && Array.isArray(out.items)) {
          const i = out.items.findIndex((t) => t.id === at);
          if (i >= 0) {
            const was = out.items[i].headingId || null;
            for (let j = op.position.before ? i : i + 1; j < out.items.length && (out.items[j].headingId || null) === was; j++) {
              out.items[j].headingId = id; out.items[j].headingName = op.name;
            }
          }
        }
        break;
      }
      case 'heading-patch': {
        const pid = op.id.split(':')[0];
        const to = op.patch.name ? `${pid}:${op.patch.name}` : op.id;
        for (const p of projectCopies(out, pid)) {
          const h = (p.headings || []).find((x) => x.id === op.id);
          if (!h) continue;
          if (op.patch.name) { h.id = to; h.name = op.patch.name; }
          if ('archived' in op.patch) h.archived = op.patch.archived ? today : null;
        }
        const view = viewProject(out);
        if (view && view.id === pid) {
          for (const t of out.items || []) {
            if (t.headingId !== op.id && t.headingId !== to) continue;
            if (op.patch.name) { t.headingId = to; t.headingName = op.patch.name; }
            if (op.patch.archived && t.status === 'open') { t.status = 'done'; t.completed = today; }
          }
        }
        break;
      }
      case 'heading-delete': {
        const pid = op.id.split(':')[0];
        for (const p of projectCopies(out, pid)) p.headings = (p.headings || []).filter((x) => x.id !== op.id);
        const view = viewProject(out);
        if (view && view.id === pid) for (const t of out.items || []) if (t.headingId === op.id) { t.headingId = null; t.headingName = null; }
        break;
      }
      // ---- areas, which the sidebar lists and an area view carries
      case 'area-create': {
        if (isState && Array.isArray(out.areas) && !out.areas.some((a) => a.id === op.id)) out.areas.push(asArea(op.id, op.body));
        break;
      }
      case 'area-patch': {
        const a = viewArea(out);
        if (a && a.id === op.id) Object.assign(a, op.patch);
        if (isState && Array.isArray(out.areas)) {
          const x = out.areas.find((y) => y.id === op.id);
          if (x) Object.assign(x, op.patch);
        }
        break;
      }
      case 'area-delete': {
        // Its projects go loose, as the server puts them in Projects/.
        if (isState && Array.isArray(out.areas)) {
          const i = out.areas.findIndex((a) => a.id === op.id);
          if (i >= 0) {
            const [gone] = out.areas.splice(i, 1);
            for (const p of gone.projects || []) { p.areaId = null; p.areaName = null; (out.looseProjects || (out.looseProjects = [])).push(p); }
          }
        }
        break;
      }
      // ---- settings, which both /settings and the sidebar payload carry
      case 'settings': {
        if (path === '/settings') Object.assign(out, op.patch);
        if (isState && out.settings) Object.assign(out.settings, op.patch);
        break;
      }
    }
  }
  return out;
}

/**
 * A view the server has never answered for, because what it shows was made
 * offline: the project or area itself, empty, with the rest of the waiting
 * operations laid over that. Null when `path` is nothing of the kind.
 */
export function synthesize(path, ops, today) {
  const m = path.match(/^\/(projects|areas)\/([^/?]+)$/);
  if (!m) return null;
  const [, kind, id] = m;
  if (kind === 'projects') {
    const made = ops.find((op) => op.kind === 'project-create' && op.id === id);
    if (made) return overlay(path, { project: asProject(made.id, made.body, today), items: [] }, ops, today);
    // Converted offline: the project is the to-do it was, and its checklist
    // items are its to-dos.
    const turned = ops.find((op) => op.kind === 'convert' && op.projectId === id);
    if (turned) {
      return overlay(path, { project: asProject(turned.projectId, turned.body, today), items: turned.items.map((x) => ({ ...x })) }, ops, today);
    }
    return null;
  }
  const made = ops.find((op) => op.kind === 'area-create' && op.id === id);
  return made ? overlay(path, { area: asArea(made.id, made.body), items: [] }, ops, today) : null;
}

/** What a move body says about the to-do, as fields on it. */
function moveFields(body) {
  if (body.inbox) return { inbox: true, projectId: null, projectName: null, areaId: null, areaName: null, headingId: null, headingName: null };
  if (body.standalone) return { inbox: false, projectId: null, projectName: null, areaId: null, areaName: null, headingId: null, headingName: null };
  if (body.projectId) return { inbox: false, projectId: body.projectId, headingId: body.headingId || null, headingName: null };
  if (body.areaId) return { inbox: false, areaId: body.areaId, projectId: null, projectName: null, headingId: null, headingName: null };
  return {};
}
