// The lists — Inbox, Today, Upcoming, Anytime, Someday, Logbook, Trash, and
// the ones Quick Find reaches — computed from the store's index.
//
// backend/dvarim/views.py function for function, returning the same data,
// and held to it by test/store.parity.test.js.
import { Day } from './day.js';
import { INBOX, STANDALONE, TRASH, fmTags } from './store.js';
import { cmpStr, sortBy } from './util.js';

const get = (o, k, d = null) => (o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);
const le = (a, b) => cmpStr(a, b) <= 0;
const gt = (a, b) => cmpStr(a, b) > 0;
const lt = (a, b) => cmpStr(a, b) < 0;
const orderOf = (ids) => new Map((ids || []).map((id, i) => [id, i]));
const rank = (order, id) => (order.has(id) ? order.get(id) : 1e6);

const openPairs = (store) => [...store.openTodos()];

// ---- when a completed to-do stops appearing in its list ---------------------
//
//   immediately  gone at once
//   daily        stays until the day turns
//   manually     stays until Log Now, which sets logCutoff
//
// "Logged" is a view question, not a fact about the file.

export function isLogged(status, completed, settings, today) {
  if (status === 'open') return false;
  const mode = get(settings, 'logCompleted', 'immediately');
  if (mode === 'immediately') return true;
  if (!completed) return true;          // no date to reason about: treat as filed
  if (mode === 'daily') return lt(completed, today);
  const cutoff = get(settings, 'logCutoff') || '';
  return le(completed, cutoff);
}

/** Open work, plus anything completed that has not been filed away yet. */
function* visible(store) {
  const settings = store.getSettings();
  const today = store.todayIso();
  for (const f of store.files.values()) {
    if (store.isTrashedFile(f)) continue;
    if (f.kind === 'project' && get(f.frontmatter, 'status', 'open') !== 'open') continue;
    for (const t of f.allTodos()) {
      if (t.status === 'open' || !isLogged(t.status, t.completed, settings, today)) yield [f, t];
    }
  }
}

export function inToday(t, today) {
  if (t.someday) return false;
  return !!((t.when && le(t.when, today)) || (t.deadline && le(t.deadline, today)));
}

function projectInToday(store, f, today) {
  const fm = f.frontmatter;
  if (get(fm, 'status', 'open') !== 'open' || get(fm, 'someday')) return false;
  return !!((get(fm, 'when') && le(fm.when, today)) || (get(fm, 'deadline') && le(fm.deadline, today)));
}

export function state(store) {
  const today = store.todayIso();
  const open = openPairs(store);
  const todayItems = open.filter(([, t]) => t.status === 'open' && inToday(t, today));
  return {
    today,
    counts: {
      inbox: open.filter(([f]) => f.path === INBOX).length,
      today: todayItems.length + store.projects().filter((p) => projectInToday(store, p, today)).length,
      todayDeadlines: todayItems.filter(([, t]) => t.deadline && le(t.deadline, today)).length,
    },
    areas: store.areas().map((a) => store.areaJson(a)),
    looseProjects: store.looseProjects().map((p) => store.projectJson(p)),
    tags: tags(store),
    settings: store.getSettings(),
    collapsed: store.state.collapsed || [],
  };
}

export function tags(store) {
  const counts = new Map();
  const add = (k, n) => counts.set(k, (counts.get(k) || 0) + n);
  for (const [, t] of openPairs(store)) {
    for (const tag of t.tags) {
      add(tag, 1);
      if (tag.includes('/')) add(tag.split('/')[0], 0);
    }
  }
  for (const f of store.files.values()) {
    if ((f.kind === 'project' || f.kind === 'area') && !store.isTrashedFile(f)) {
      for (const tag of fmTags(f.frontmatter)) add(tag, 0);
    }
  }
  return sortBy([...counts], ([k]) => k.toLowerCase()).map(([name, count]) => ({ name, count }));
}

export function listInbox(store) {
  const f = store._file(INBOX);
  const settings = store.getSettings(), today = store.todayIso();
  const keep = [...f.allTodos()].filter((t) => t.status === 'open' || !isLogged(t.status, t.completed, settings, today));
  return { items: keep.map((t) => store.todoJson(t, f)) };
}

function sortedToday(store, pairs) {
  const order = orderOf(store.state.todayOrder);
  return sortBy(pairs, ([f, t]) => [0, rank(order, t.id), t.when || '', f.path, t.line]);
}

export function listToday(store, events = null) {
  const today = store.todayIso();
  let pairs = [...visible(store)].filter(([, t]) => inToday(t, today));
  pairs = sortedToday(store, pairs);
  const projects = store.projects().filter((p) => projectInToday(store, p, today)).map((p) => store.projectJson(p));
  const out = { date: today, events: events || [], items: pairs.map(([f, t]) => store.todoJson(t, f)), projects };
  // Headings of your own (Store.addTodayHeading), and which of today's to-dos
  // are under each. Only when there are any: the Python had none.
  const headings = store.todayHeadings();
  if (headings.length) {
    const here = new Set(out.items.map((t) => t.id));
    out.headings = headings.map((h) => ({ id: h.id, name: h.name, todos: h.todos.filter((tid) => here.has(tid)) }));
  }
  return out;
}

export function listUpcoming(store, events = null, months = 12) {
  const today = store.todayIso();
  const limit = Day.fromISO(today).addDays(31 * months).iso();
  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, { date: d, events: [], items: [], projects: [] });
    return days.get(d);
  };
  for (const [f, t] of visible(store)) {
    if (t.someday) continue;
    let d;
    if (t.when && gt(t.when, today)) d = t.when;
    else if (t.deadline && gt(t.deadline, today) && !t.when) d = t.deadline;
    else continue;
    if (le(d, limit)) day(d).items.push(store.todoJson(t, f));
  }
  for (const p of store.projects()) {
    const fm = p.frontmatter;
    if (get(fm, 'someday')) continue;
    const d = get(fm, 'when') && gt(fm.when, today) ? fm.when
      : (get(fm, 'deadline') && gt(fm.deadline, today) && !get(fm, 'when') ? fm.deadline : null);
    if (d && le(d, limit)) day(d).projects.push(store.projectJson(p));
  }
  for (const ev of events || []) {
    if (ev.date && gt(ev.date, today)) day(ev.date).events.push(ev);
  }
  // within a day, the order the user put them in; the rest keep file order
  const orders = store.state.upcomingOrder || {};
  for (const d of days.values()) {
    const order = orderOf(orders[d.date]);
    d.items = sortBy(d.items, (x) => [rank(order, x.id), x.file, x.line]);
  }
  return { days: [...days.keys()].sort(cmpStr).map((k) => days.get(k)) };
}

export function listAnytime(store) {
  const today = store.todayIso();
  const pairs = [...visible(store)].filter(([f, t]) => f.path !== INBOX && !t.someday && !(t.when && gt(t.when, today)));
  let loose = pairs.filter(([f]) => f.path === STANDALONE).map(([f, t]) => store.todoJson(t, f));
  const order = orderOf(store.state.anytimeOrder);
  loose = sortBy(loose, (x) => rank(order, x.id));
  const groups = [];
  const byFile = new Map();
  for (const [f, t] of pairs) {
    if (f.path !== STANDALONE) {
      if (!byFile.has(f.path)) byFile.set(f.path, []);
      byFile.get(f.path).push(store.todoJson(t, f));
    }
  }
  const got = (path) => (byFile.get(path) || []).length > 0;
  for (const a of store.areas()) {
    if (got(a.path)) groups.push({ project: null, area: store.areaJson(a, false), items: byFile.get(a.path) });
    for (const p of store.projects({ area: a })) {
      if (got(p.path)) groups.push({ project: store.projectJson(p), area: store.areaJson(a, false), items: byFile.get(p.path) });
    }
  }
  for (const p of store.looseProjects()) {
    if (got(p.path)) groups.push({ project: store.projectJson(p), area: null, items: byFile.get(p.path) });
  }
  return { items: loose, groups };
}

export function listSomeday(store) {
  let items = [...visible(store)].filter(([, t]) => t.someday).map(([f, t]) => store.todoJson(t, f));
  const order = orderOf(store.state.somedayOrder);
  items = sortBy(items, (x) => [rank(order, x.id), x.file, x.line]);
  const projects = store.projects().filter((p) => get(p.frontmatter, 'someday')).map((p) => store.projectJson(p));
  return { items, projects };
}

export function listLogbook(store, limit = 200, before = null) {
  const groups = new Map();
  let entries = [];
  const settings = store.getSettings(), todayIso = store.todayIso();
  for (const f of store.files.values()) {
    if (store.isTrashedFile(f)) continue;
    for (const t of f.allTodos()) {
      if (t.status !== 'open') {
        if (!isLogged(t.status, t.completed, settings, todayIso)) continue;   // still in its list
        // completed before we ever saw it: we do not know when, and will not make it up
        const d = t.completed || '';
        if (before && !lt(d, before)) continue;
        entries.push([d, 'todo', f, t]);
      }
    }
    if (f.kind === 'project' && get(f.frontmatter, 'status', 'open') !== 'open') {
      const d = get(f.frontmatter, 'completed') || '';
      if (!(before && !lt(d, before))) entries.push([d, 'project', f, null]);
    }
  }
  entries = sortBy(entries, (e) => e[0], true);
  for (const [d, kind, f, t] of entries.slice(0, limit)) {
    if (!groups.has(d)) groups.set(d, { date: d || null, items: [], projects: [] });
    const g = groups.get(d);
    if (kind === 'todo') g.items.push(store.todoJson(t, f));
    else g.projects.push(store.projectJson(f));
  }
  const dated = [...groups.keys()].filter((k) => k).sort(cmpStr).reverse();
  return { groups: [...dated.map((k) => groups.get(k)), ...(groups.has('') ? [groups.get('')] : [])] };
}

export function listTrash(store) {
  const trash = store._file(TRASH);
  const projects = store.projects({ includeClosed: true, includeTrashed: true })
    .filter((p) => p.path.startsWith('Trash/')).map((p) => store.projectJson(p));
  return { items: [...trash.allTodos()].map((t) => store.todoJson(t, trash)), projects };
}

export function projectDetail(store, pid) {
  const f = store.getFileById(pid);
  return { project: store.projectJson(f), items: [...f.allTodos()].map((t) => store.todoJson(t, f)) };
}

export function areaDetail(store, aid) {
  const f = store.getFileById(aid);
  return { area: store.areaJson(f), items: [...f.allTodos()].filter((t) => t.status === 'open').map((t) => store.todoJson(t, f)) };
}

export const LISTS = [['inbox', 'Inbox'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['anytime', 'Anytime'],
  ['someday', 'Someday'], ['logbook', 'Logbook'], ['trash', 'Trash'],
  ['tomorrow', 'Tomorrow'], ['deadlines', 'Deadlines'], ['repeating', 'Repeating'],
  ['projects', 'All Projects'], ['logged-projects', 'Logged Projects']];

export function search(store, q, limit = 20) {
  q = (q || '').trim();
  const ql = q.toLowerCase();
  const out = { lists: [], projects: [], areas: [], tags: [], todos: [] };
  if (!ql) {
    out.lists = LISTS.slice(0, 7).map(([id, name]) => ({ id, name }));
    return out;
  }
  if (ql.startsWith('#')) {
    const tq = ql.slice(1);
    out.tags = tags(store).filter((t) => String(t.name).toLowerCase().includes(tq));
    return out;
  }
  out.lists = LISTS.filter(([, n]) => n.toLowerCase().includes(ql)).map(([id, name]) => ({ id, name }));
  out.projects = store.projects({ includeClosed: true }).filter((p) => p.name.toLowerCase().includes(ql))
    .map((p) => store.projectJson(p)).slice(0, limit);
  out.areas = store.areas().filter((a) => a.name.toLowerCase().includes(ql)).map((a) => store.areaJson(a, false));
  out.tags = tags(store).filter((t) => String(t.name).toLowerCase().includes(ql)).slice(0, limit);
  let todos = [];
  for (const f of store.files.values()) {
    if (store.isTrashedFile(f)) continue;
    for (const t of f.allTodos()) {
      if (t.title.toLowerCase().includes(ql) || (t.notes && t.notes.toLowerCase().includes(ql))) {
        todos.push([t.status === 'open' ? 0 : 1, f, t]);
      }
    }
  }
  todos = sortBy(todos, (x) => [x[0], x[2].title.toLowerCase()]);
  out.todos = todos.slice(0, limit).map(([, f, t]) => store.todoJson(t, f));
  return out;
}

// ---- Quick-Find-only lists: Tomorrow, Deadlines, Repeating, All Projects, Logged Projects

export function listTomorrow(store, events = null) {
  const d = store.today().addDays(1).iso();
  const items = openPairs(store).filter(([, t]) => !t.someday && (t.when === d || (t.deadline === d && !t.when)))
    .map(([f, t]) => store.todoJson(t, f));
  const projects = store.projects().filter((p) => get(p.frontmatter, 'when') === d).map((p) => store.projectJson(p));
  return { date: d, events: events || [], items, projects };
}

export function listDeadlines(store) {
  let items = openPairs(store).filter(([, t]) => t.deadline).map(([f, t]) => store.todoJson(t, f));
  items = sortBy(items, (x) => x.deadline);
  let projects = store.projects().filter((p) => get(p.frontmatter, 'deadline')).map((p) => store.projectJson(p));
  projects = sortBy(projects, (x) => x.deadline);
  return { items, projects };
}

export function listRepeating(store) {
  let items = openPairs(store).filter(([, t]) => t.repeat).map(([f, t]) => store.todoJson(t, f));
  items = sortBy(items, (x) => [x.when || x.deadline || '9999', x.title.toLowerCase()]);
  const projects = store.projects().filter((p) => get(p.frontmatter, 'repeat')).map((p) => store.projectJson(p));
  return { items, projects };
}

export function listProjects(store, logged = false) {
  let projs;
  if (logged) {
    projs = store.projects({ includeClosed: true }).filter((p) => get(p.frontmatter, 'status', 'open') !== 'open');
    projs = sortBy(projs, (p) => get(p.frontmatter, 'completed') || '', true);
  } else projs = store.projects();
  return { projects: projs.map((p) => store.projectJson(p)) };
}
