// The engine's router (src/api.js) against the backend's FastAPI app, request
// for request.
//
// The store suite proves the operations agree; this proves the layer the app
// actually talks to does: the routes, how each reads its body and query (bad
// JSON, a list where an object belongs, a string where a list does), what the
// quick-add and repeat helpers put together, the source editor's read and
// write with its stale-copy check, and what every error comes back as —
// status and message. A seeded fuzzer drives the engine through a session of
// requests, choosing each one's targets from what the engine then holds; the
// Python replays it through its HTTP app on a real folder; every status, every
// body, every file byte and every folder must be the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Day } from '../src/day.js';
import { Store, readText } from '../src/store.js';
import { MemoryStorage } from '../src/storage.js';
import { Api } from '../src/api.js';
import { sha1 } from '../src/sha1.js';
import { available, askAll } from './oracle.js';
import { sampleVault } from './corpus.js';

const TODAY = '2026-09-19';
const OBSIDIAN = { vault: 'Syn ergathan', prefix: '/Notes/Projects (tasks)/' };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function counterIds() {
  let n = 0;
  const next = (prefix = '') => { n += 1; return prefix + n.toString(36).padStart(8 - prefix.length, '0'); };
  next.count = () => n;
  return next;
}

const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
const enc = encodeURIComponent;

const TITLES = ['Call Dana', 'Buy milk tomorrow', '', 'Email #urgent re budget', 'שלום', 'Party 🎉', 'Fake 🆔 marker'];
const QUICK = ['Call the plumber tomorrow 3pm #home !fri', 'Pay rent next month', 'Book flights someday',
  'Water plants every 3 days', 'tonight', 'Dinner tonight at 7', '   ', 'Review in 2 weeks #work', 'Thing today evening'];
const NOTES = ['', 'A note', '- [ ] a task in the notes\n## a heading', '**bold** and ==marked=='];
const RULES = ['every day', 'every 2 weeks on Monday, Thursday', 'every month on the last Friday',
  'every weekday when done', 'every 0 days', 'every blue moon', '', '  every year  '];
const HEADINGS = ['Planning', 'Treats / to buy', 'Later 50%', 'Why?', 'Später'];
const NAMES = ['Launch', 'Kitchen', 'Tax 2026', 'a/b:c', 'Studio'];
const DATE_TEXT = ['tom', 'next fri', 'in 3 days', 'oct 3', 'someday', '', 'evening', 'yesterday'];

function pickRequest(store, r, day, n) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;
  const date = () => pick([day.iso(), day.addDays(1).iso(), day.addDays(-2).iso(), day.addDays(9).iso(), '', null, 'soon']);
  const todos = [...store.todoIndex.keys()];
  const trashTodos = [...store.files.get('Trash.md').allTodos()].map((t) => t.id);
  const projectFiles = [...store.files.values()].filter((f) => f.kind === 'project');
  const projects = projectFiles.map((f) => f.frontmatter.id);
  const trashed = projectFiles.filter((f) => f.path.startsWith('Trash/')).map((f) => f.frontmatter.id);
  const areas = [...store.files.values()].filter((f) => f.kind === 'area').map((f) => f.frontmatter.id);
  const headings = projectFiles.flatMap((f) => f.sections.filter((s) => s.heading).map((s) => `${f.frontmatter.id}:${s.heading.name}`));
  const paths = [...store.files.keys()];
  const bogus = (list) => (chance(0.07) || !list.length ? pick(['zzzzzzzz', 'nope', '50%', 'שלום', 'a b']) : pick(list));
  // a body the way a careless client might send it, now and then
  const odd = (body) => (chance(0.05) ? pick([{ raw: '{not json' }, { body: [1, 2] }, { body: null }, { body: 'text' }]) : { body });

  const k = r();
  if (k < 0.12) {
    const b = { title: pick(TITLES) };
    const where = pick(['inbox', 'none', 'project', 'heading', 'area']);
    if (where === 'inbox') b.inbox = true;
    if (where === 'project') b.projectId = bogus(projects);
    if (where === 'heading' && headings.length) { const h = pick(headings); b.projectId = h.split(':')[0]; b.headingId = h; }
    if (where === 'area') b.areaId = bogus(areas);
    if (chance(0.3)) b.when = date();
    if (chance(0.2)) b.deadline = date();
    if (chance(0.2)) b.notes = pick(NOTES);
    if (chance(0.2)) b.repeat = pick(RULES);
    if (chance(0.15)) b.tags = pick([['work'], 'work', [' '], null]);
    if (chance(0.15)) b.checklist = pick([[{ text: 'one' }, { text: 'two', done: true }], 'x', null]);
    if (chance(0.1)) b.id = pick(['abcd1234', 'ABCD', ...todos.slice(0, 1)]);
    return { method: 'POST', path: '/todos', ...odd(b) };
  }
  if (k < 0.2) {
    const b = {};
    if (chance(0.4)) b.title = pick(TITLES);
    if (chance(0.3)) b.when = date();
    if (chance(0.2)) b.someday = chance(0.5);
    if (chance(0.2)) b.evening = chance(0.5);
    if (chance(0.2)) b.repeat = pick([...RULES, null]);
    if (chance(0.2)) b.reminder = pick(['09:30', '', null, '25:99']);
    if (chance(0.15)) b.notes = pick(NOTES);
    if (chance(0.1)) b.status = pick(['done', 'open', 'bogus']);
    return { method: 'PATCH', path: `/todos/${enc(bogus(todos))}`, ...odd(b) };
  }
  if (k < 0.27) {
    const action = pick(['complete', 'complete', 'cancel', 'reopen', 'duplicate', 'convert', 'restore']);
    const id = action === 'restore' ? bogus(trashTodos) : bogus(todos);
    const b = { complete: { on: pick([null, day.addDays(-1).iso(), 'x']) }, cancel: {}, reopen: null, restore: null,
      duplicate: chance(0.3) ? { id: `d${String(n).padStart(7, '0')}` } : {},
      convert: chance(0.3) ? { id: `p${String(n).padStart(7, '0')}` } : {} }[action];
    return { method: 'POST', path: `/todos/${enc(id)}/${action}`, body: b };
  }
  if (k < 0.31) {
    const b = pick([{ inbox: true }, { projectId: bogus(projects) }, { areaId: bogus(areas) }, {},
      headings.length ? { headingId: pick(headings), projectId: pick(headings).split(':')[0] } : { inbox: true },
      { projectId: bogus(projects), headingName: pick(HEADINGS) }]);
    if (chance(0.3)) b.position = pick(['top', { after: bogus(todos) }, { index: pick([0, 2, 'x']) }]);
    return { method: 'POST', path: `/todos/${enc(bogus(todos))}/move`, body: b };
  }
  if (k < 0.34) return { method: 'DELETE', path: `/todos/${enc(bogus(todos))}` };
  if (k < 0.37) return { method: 'GET', path: `/todos/${enc(bogus(todos))}` };
  if (k < 0.41) {
    const ctx = pick(['inbox', 'today', 'anytime', 'someday', 'areas', 'bogus', `project:${bogus(projects)}`,
      `heading:${bogus(headings)}`, `area:${bogus(areas)}`, `upcoming:${day.addDays(2).iso()}`]);
    const ids = [...todos, ...projects, ...areas].sort(() => r() - 0.5).slice(0, 5);
    return { method: 'POST', path: '/reorder', ...(chance(0.08) ? { body: pick([{ context: ctx }, { context: ctx, ids: null }, { ids }]) } : { body: { context: ctx, ids } }) };
  }
  if (k < 0.47) {
    const b = { text: pick(QUICK) };
    if (chance(0.5)) b.list = pick(['inbox', 'today', 'anytime', 'someday', 'bogus']);
    if (chance(0.2)) b.notes = pick(['  spaced note  ', '', null]);
    if (chance(0.2)) b.projectId = bogus(projects);
    if (chance(0.1)) b.headingId = bogus(headings);
    if (chance(0.1)) b.areaId = bogus(areas);
    if (chance(0.1)) b.id = `q${String(n).padStart(7, '0')}`;
    return { method: 'POST', path: '/quick-add', ...odd(b) };
  }
  if (k < 0.5) {
    return { method: 'POST', path: '/parse-repeat', body: { repeat: pick(RULES), ...(chance(0.5) ? { when: date() } : {}), ...(chance(0.2) ? { deadline: date() } : {}) } };
  }
  if (k < 0.52) return { method: 'POST', path: '/parse-date', ...odd({ text: pick(DATE_TEXT) }) };
  if (k < 0.55) {
    return { method: 'PUT', path: '/settings', body: pick([{ weekStartsOn: pick([0, 1, 6]) }, { logCompleted: pick(['immediately', 'daily', 'manually']) },
      { showCalendarEvents: false }, { eveningStartsAt: '19:00' }, { unknownKey: 1 }]) };
  }
  if (k < 0.59) {
    const b = { name: pick(NAMES) };
    if (chance(0.4) && areas.length) b.areaId = bogus(areas);
    if (chance(0.2)) b.when = date();
    if (chance(0.2)) b.notes = pick(NOTES);
    return { method: 'POST', path: '/projects', ...odd(b) };
  }
  if (k < 0.62) {
    const b = {};
    if (chance(0.4)) b.name = pick(NAMES);
    if (chance(0.3)) b.areaId = pick([...areas, null, '']);
    if (chance(0.3)) b.when = date();
    if (chance(0.2)) b.deadline = date();
    if (chance(0.2)) b.tags = pick([['work'], []]);
    return { method: 'PATCH', path: `/projects/${enc(bogus(projects))}`, body: b };
  }
  if (k < 0.66) {
    const action = pick(['complete', 'cancel', 'reopen', 'restore', 'headings', 'headings']);
    const id = action === 'restore' ? bogus(trashed) : bogus(projects);
    const b = action === 'headings'
      ? { name: pick(HEADINGS), ...(chance(0.3) ? { position: pick(['top', { before: bogus(todos) }, { after: bogus(todos) }]) } : {}) }
      : { completeOpenTodos: pick([true, false, 1, 'yes', 0, null]) };
    return { method: 'POST', path: `/projects/${enc(id)}/${action}`, body: b };
  }
  if (k < 0.68) return { method: 'DELETE', path: `/projects/${enc(bogus(chance(0.3) ? trashed : projects))}` };
  if (k < 0.72) {
    const b = pick([{ name: pick(HEADINGS) }, { archived: true }, { archived: false }, { projectId: bogus(projects) }, { projectId: '' }, {}]);
    return { method: 'PATCH', path: `/headings/${enc(bogus(headings))}`, body: b };
  }
  if (k < 0.735) return { method: 'DELETE', path: `/headings/${enc(bogus(headings))}` };
  if (k < 0.755) return { method: 'POST', path: '/areas', body: { name: pick(NAMES), ...(chance(0.3) ? { notes: pick(NOTES) } : {}) } };
  if (k < 0.77) return { method: 'PATCH', path: `/areas/${enc(bogus(areas))}`, body: pick([{ name: pick(NAMES) }, { notes: pick(NOTES) }, { tags: ['x'] }]) };
  if (k < 0.78) return { method: 'DELETE', path: `/areas/${enc(bogus(areas))}` };
  if (k < 0.79) return { method: 'POST', path: '/logbook/log-now', body: pick([{}, { cutoff: day.addDays(-1).iso() }, { cutoff: 'x' }]) };
  if (k < 0.795) return { method: 'POST', path: '/trash/empty' };
  if (k < 0.805) return { method: 'PUT', path: '/view-state', body: pick([{ collapsed: [bogus(areas)] }, { collapsed: 'ab' }, {}, { collapsed: null }]) };
  if (k < 0.83) {
    const path = pick([...paths, ...paths, '../x.md', '.dvarim/state.json', '.dvarim/x.md', 'notes.txt', '', 'Nope.md', 'a/../Inbox.md', '/Inbox.md']);
    return { method: 'GET', path: `/file?path=${enc(path)}` };
  }
  if (k < 0.87) return { file: pick([...paths, 'New/Deep/Made here.md', 'Projects/Fresh.md', '../x.md', 'notes.txt']) };
  if (k < 0.89) return { ext: null };
  const reads = ['/state', '/lists/inbox', '/lists/today', '/lists/upcoming', '/lists/anytime', '/lists/someday', '/lists/logbook',
    `/lists/logbook?limit=${pick([3, 200])}${chance(0.5) ? `&before=${day.iso()}` : ''}`, '/lists/trash', '/lists/tomorrow',
    '/lists/deadlines', '/lists/repeating', '/lists/projects', '/lists/logged-projects', `/projects/${enc(bogus(projects))}`,
    `/areas/${enc(bogus(areas))}`, '/tags', `/search?q=${enc(pick(['call', '#w', 'kitchen', '', 'ש']))}`, '/settings',
    '/logbook/pending', `/calendar?from_=${day.iso()}&to=${day.addDays(3).iso()}`, '/health', '/auth'];
  return { method: 'GET', path: pick(reads) };
}

/** A source-editor save: what the editor holds, changed, and sent back with
 *  the sha it was loaded with — or a stale one, or none. */
async function fileWrite(store, r, path) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  await store.flush();
  let cur = null;
  try { cur = readText(await store.storage.read(path)); } catch { /* a path the editor must refuse: nothing to start from */ }
  const text = cur ? cur.text : '';
  const edited = pick([
    text.replace('- [ ]', '- [x]'),
    text + '- [ ] Typed in the source editor\n',
    text.replace(/^---\n[\s\S]*?\n---\n/u, ''),          // front matter gone: no longer a project
    '---\ntype: project\nid: pe' + String(Math.floor(r() * 1e6)).padStart(6, '0') + '\n---\n- [ ] Only line',
    text.replace(/\n/gu, '\r\n'),
  ]);
  const sha = pick([cur ? sha1(cur.text) : undefined, cur ? sha1(cur.text) : undefined, 'stale', undefined]);
  const body = pick([{ text: edited, ...(sha ? { sha } : {}) }, { text: edited, ...(sha ? { sha } : {}) }, { text: 5 }, {}]);
  return { method: 'PUT', path: `/file?path=${enc(path)}`, body };
}

async function externalEdit(storage, r, n) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const { files } = await storage.list();
  const md = files.filter((p) => p.endsWith('.md') && !p.startsWith('.'));
  const k = r();
  if (k < 0.15 || !md.length) return { path: `Projects/From Obsidian ${n}.md`, text: '---\ntags: x\n---\n- [ ] Typed there\n- [x] Done there\n' };
  const path = pick(md);
  const text = (await storage.read(path)).text;
  if (k < 0.55 && text.includes('- [ ]')) return { path, text: text.replace('- [ ]', '- [x]') };
  if (k < 0.8) return { path, text: text + (text.endsWith('\n') || !text ? '' : '\n') + '- [ ] Typed in Obsidian\n' };
  return { path, text: text.replace(/\n/gu, '\r\n') };
}

async function send(api, store, storage, req, ids) {
  if (req.ext) {
    await store.flush();
    if (req.ext.text === null) await storage.remove(req.ext.path);
    else await storage.write(req.ext.path, req.ext.text);
    return { status: 200, body: (await store.scanChanges()).sort(), ids: ids.count() };
  }
  let body = req.body;
  if (req.raw !== undefined) { try { body = JSON.parse(req.raw); } catch { body = undefined; } }  // as the fetch shim does
  const res = await api.handle(req.method, '/api' + req.path, plain(body));
  return { status: res.status, body: plain(res.body), ids: ids.count() };
}

async function session(seed, steps) {
  const r = rng(seed);
  const files = Object.fromEntries(sampleVault().map((f) => [f.path, f.text]));
  const storage = new MemoryStorage(files);
  const day = Day.fromISO(TODAY);
  const ids = counterIds();
  const store = await Store.open(storage, { today: () => day, newId: ids, obsidian: OBSIDIAN });
  const api = new Api(store);
  const requests = [], results = [];
  const go = async (req) => { requests.push(req); results.push(await send(api, store, storage, req, ids)); };
  for (let n = 0; n < steps; n++) {
    let req = pickRequest(store, r, day, n);
    if (req.ext === null) { await store.flush(); req = { ext: await externalEdit(storage, r, n) }; }
    if (req.file) req = await fileWrite(store, r, req.file);
    await go(req);
  }
  for (const path of ['/state', '/lists/inbox', '/lists/today', '/lists/upcoming', '/lists/anytime', '/lists/someday',
    '/lists/logbook', '/lists/trash', '/lists/tomorrow', '/lists/deadlines', '/lists/repeating', '/lists/projects',
    '/lists/logged-projects', '/tags', '/logbook/pending', '/settings']) await go({ method: 'GET', path });
  for (const f of [...store.files.values()].filter((x) => x.kind === 'project' || x.kind === 'area')) {
    await go({ method: 'GET', path: `/${f.kind === 'project' ? 'projects' : 'areas'}/${enc(f.frontmatter.id)}` });
  }
  await store.flush();
  return { files, requests, results, snap: storage.snapshot(), dirs: [...storage.dirs].filter((d) => d !== '.dvarim').sort() };
}

const SESSIONS = Number(process.env.DVARIM_SESSIONS || 30);
const STEPS = Number(process.env.DVARIM_STEPS || 60);
const SEED = Number(process.env.DVARIM_SEED || 1);

/** The route a request went to, for the tally: ids folded away. */
const routeOf = (req) => (req.ext ? 'external edit'
  : `${req.method} ${req.path.split('?')[0].replace(/^\/(todos|projects|areas|headings)\/[^/]+/u, '/$1/:id')}`);

test(`the API agrees with the Python's over ${SESSIONS} sessions of ${STEPS} requests`,
  { skip: !available() && 'no Python backend here' }, async (t) => {
    const runs = [];
    for (let s = 0; s < SESSIONS; s++) runs.push(await session(SEED * 7919 + s, STEPS));
    const answers = await askAll(runs.map((x) => ({ op: 'http', files: x.files, today: TODAY, obsidian: OBSIDIAN, requests: x.requests })));
    if (answers.some((a) => a.error && /fastapi|httpx|No module/u.test(a.error))) {
      t.skip(`the backend's packages are not installed here: ${answers.find((a) => a.error).error}`);
      return;
    }
    const problems = [];
    runs.forEach((x, s) => {
      const py = answers[s];
      if (py.error) { problems.push(`session ${s}: the Python raised ${py.error}`); return; }
      for (let i = 0; i < x.requests.length; i++) {
        const a = x.results[i], b = py.ok.results[i];
        let same = a.status === b.status && a.ids === b.ids;
        // a 500 is a crash on both sides; what each says about it is its own business
        if (same && a.status !== 500) { try { assert.deepStrictEqual(a.body, b.body); } catch { same = false; } }
        if (!same) {
          problems.push(`session ${s}, request ${i}: ${JSON.stringify(x.requests[i]).slice(0, 300)}\n` +
            `  engine: ${JSON.stringify(a).slice(0, 900)}\n  python: ${JSON.stringify(b).slice(0, 900)}`);
          return;
        }
      }
      // .dvarim/stamps.json is the engine's own (state-merge.js): the server has none
      const paths = new Set([...Object.keys(x.snap), ...Object.keys(py.ok.files)].filter((p) => p !== '.dvarim/stamps.json'));
      for (const p of [...paths].sort()) {
        if (x.snap[p] !== py.ok.files[p]) {
          problems.push(`session ${s}: ${p} differs\n  engine: ${JSON.stringify(x.snap[p] ?? null).slice(0, 700)}\n  python: ${JSON.stringify(py.ok.files[p] ?? null).slice(0, 700)}`);
          return;
        }
      }
      try { assert.deepStrictEqual(x.dirs, py.ok.dirs); } catch { problems.push(`session ${s}: folders differ\n  engine: ${x.dirs}\n  python: ${py.ok.dirs}`); }
    });
    const tally = {};
    for (const x of runs) {
      x.requests.forEach((q, i) => {
        const name = routeOf(q);
        tally[name] = tally[name] || {};
        tally[name][x.results[i].status] = (tally[name][x.results[i].status] || 0) + 1;
      });
    }
    if (process.env.DVARIM_TALLY) console.log('TALLY ' + JSON.stringify(tally));
    if (problems.length) assert.fail(`${problems.length} of ${SESSIONS} sessions diverge:\n\n${problems.slice(0, 3).join('\n\n')}`);
  });
