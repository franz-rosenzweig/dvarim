// The engine's store and lists against the backend's, operation for operation.
//
// A seeded fuzzer drives the engine's store through a long random session —
// creating, completing, repeating, moving, trashing and restoring to-dos;
// projects renamed, moved between areas, completed, trashed, restored;
// headings added at to-dos and archived; areas renamed and deleted; settings;
// lists read between it all; and someone editing a file in Obsidian behind
// its back — choosing each step's targets from what the engine then holds.
// The session is replayed through the Python store on a real folder, and every
// answer, every file byte and every folder must be the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Day } from '../src/day.js';
import { Store } from '../src/store.js';
import { MemoryStorage } from '../src/storage.js';
import * as views from '../src/views.js';
import { Conflict, Invalid, NotFound } from '../src/errors.js';
import { available, askAll } from './oracle.js';
import { sampleVault, vaultFiles } from './corpus.js';

const TODAY = '2026-09-19';          // the day sample-vault is written as of
const OBSIDIAN = { vault: 'Syn ergathan', prefix: '/Notes/Projects (tasks)/' };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** oracle.py's counter_ids, the same way round. */
function counterIds() {
  let n = 0;
  return (prefix = '') => {
    n += 1;
    return prefix + n.toString(36).padStart(8 - prefix.length, '0');
  };
}

const camel = (s) => s.replace(/_([a-z])/gu, (_, c) => c.toUpperCase());
const kindOf = (e) => (e instanceof NotFound ? 'NotFound' : e instanceof Conflict ? 'Conflict' : e instanceof Invalid ? 'Invalid' : 'Other');
const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

async function run(store, storage, call) {
  try {
    let out;
    if (call.ext) {
      await store.flush();
      if (call.ext.text === null) await storage.remove(call.ext.path);
      else await storage.write(call.ext.path, call.ext.text);
      out = (await store.scanChanges()).sort();
    } else if (call.v) out = views[camel(call.v)](store, ...(call.a || []));
    else out = store[camel(call.m)](...(call.a || []));
    return { ok: plain(out) };
  } catch (e) {
    return { error: kindOf(e), detail: `${e.name}: ${e.message}` };
  }
}

// ---- the fuzzer ------------------------------------------------------------

const TITLES = ['Call Dana', 'Buy milk', 'Draft chapter 4', '', '  spaced  ', 'Email #urgent re budget', 'שלום לכולם',
  'Party 🎉', 'Fake 🆔 marker', 'Date ⏳ 2026-01-01 inside', 'Review', 'x'];
const NOTES = ['', 'A note', 'Line one\nLine two', '- [ ] a task in the notes\n## a heading in the notes', '**bold** and ==marked=='];
const RULES = ['every day', 'every 2 weeks on Monday, Thursday', 'every month on the last Friday', 'every year',
  'every weekday when done', 'every 3 days for 2 times', 'every 0 days', 'every blue moon', 'every month on the 31st'];
const TAGS = [[], ['work'], ['#home', 'a/b'], [' ', 'x'], ['שלום']];
const HEADINGS = ['Planning', 'Treats to buy', 'Later', '  Spaced   heading ', 'Planning'];
const NAMES = ['Launch', 'Kitchen', 'New Project', 'Tax 2026', 'Kitchen', 'a/b:c', '..dots..', 'Studio'];

function pickCall(store, r, day, n) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;
  const date = () => pick([day.iso(), day.addDays(1).iso(), day.addDays(-2).iso(), day.addDays(9).iso(), '', null, day.addDays(40).iso()]);
  const todos = [...store.todoIndex.keys()];
  const trashTodos = [...store.files.get('Trash.md').allTodos()].map((t) => t.id);
  const projects = [...store.files.values()].filter((f) => f.kind === 'project').map((f) => f.frontmatter.id);
  const trashed = [...store.files.values()].filter((f) => f.kind === 'project' && f.path.startsWith('Trash/')).map((f) => f.frontmatter.id);
  const areas = [...store.files.values()].filter((f) => f.kind === 'area').map((f) => f.frontmatter.id);
  const headings = [...store.files.values()].filter((f) => f.kind === 'project')
    .flatMap((f) => f.sections.filter((s) => s.heading).map((s) => `${f.frontmatter.id}:${s.heading.name}`));
  const bogus = (list) => (chance(0.06) || !list.length ? pick(['zzzzzzzz', 'pzzzzzzz', 'nope']) : pick(list));
  const target = () => pick([{ inbox: true }, {}, { projectId: bogus(projects) },
    { projectId: bogus(projects), headingName: pick(HEADINGS) },
    headings.length ? (() => { const h = pick(headings); return { projectId: h.split(':')[0], headingId: h }; })() : { inbox: true },
    { areaId: bogus(areas) }]);
  const position = () => pick([null, null, 'top', { after: bogus(todos) }, { index: pick([0, 1, 99, -3, '2', 'x']) }]);
  const patch = () => {
    const p = {};
    if (chance(0.4)) p.title = pick(TITLES);
    if (chance(0.3)) p.notes = pick(NOTES);
    if (chance(0.3)) p.when = date();
    if (chance(0.2)) p.deadline = date();
    if (chance(0.15)) p.evening = chance(0.5);
    if (chance(0.15)) p.someday = chance(0.5);
    if (chance(0.15)) p.reminder = pick(['09:30', null, '']);
    if (chance(0.15)) p.repeat = pick([...RULES, null]);
    if (chance(0.2)) p.tags = pick(TAGS);
    if (chance(0.2)) p.checklist = pick([[], [{ text: 'one' }, { text: ' ', done: true }, { text: 'two', done: 1 }]]);
    if (chance(0.1)) p.status = pick(['open', 'done', 'canceled', 'bogus']);
    return p;
  };
  const k = r();
  if (k < 0.16) {
    const d = { title: pick(TITLES), ...target(), ...patch() };
    if (chance(0.3)) d.position = position();
    if (chance(0.1)) d.id = pick(['abcd1234', 'ABCD', `c${String(n).padStart(7, '0')}`, ...todos.slice(0, 2)]);
    return { m: 'create_todo', a: [d] };
  }
  if (k < 0.26) return { m: 'update_todo', a: [bogus(todos), patch()] };
  if (k < 0.34) return { m: 'complete_todo', a: [bogus(todos), pick([null, day.addDays(-1).iso(), day.addDays(3).iso(), 'x'])] };
  if (k < 0.37) return { m: pick(['cancel_todo', 'reopen_todo']), a: [bogus(todos)] };
  if (k < 0.43) {
    const t = target();
    if (chance(0.3)) t.position = position();
    return { m: 'move_todo', a: [bogus(todos), t] };
  }
  if (k < 0.48) return { m: 'delete_todo', a: [bogus(todos)] };
  if (k < 0.51) return { m: 'restore_todo', a: [bogus(trashTodos)] };
  if (k < 0.53) return { m: 'duplicate_todo', a: [bogus(todos), chance(0.3) ? { id: `d${String(n).padStart(7, '0')}` } : null] };
  // a client's id: "px" and the step, a shape counterIds never makes, so it
  // cannot be one the store hands out later (p0000006 was, at step 6: two
  // projects under one id, which the store now takes apart, _repairIds)
  if (k < 0.55) return { m: 'convert_todo', a: [bogus(todos), chance(0.3) ? { id: `px${String(n).padStart(6, '0')}` } : null] };
  if (k < 0.60) {
    const ctx = pick(['inbox', 'standalone', 'today', 'anytime', 'someday', 'areas', 'bogus',
      `project:${bogus(projects)}`, `heading:${bogus(headings)}`, `area:${bogus(areas)}`,
      `projects:${pick([...areas, ''])}`, `upcoming:${day.addDays(2).iso()}`, 'upcoming:soon']);
    const ids = [...todos, ...projects, ...areas].sort(() => r() - 0.5).slice(0, 6);
    return { m: 'reorder', a: [ctx, ids] };
  }
  if (k < 0.64) {
    const d = { name: pick(NAMES), notes: pick(NOTES) };
    if (chance(0.5) && areas.length) d.areaId = bogus(areas);
    if (chance(0.3)) d.when = date();
    if (chance(0.2)) d.tags = pick(TAGS);
    if (chance(0.1)) d.someday = true;
    return { m: 'create_project', a: [d] };
  }
  if (k < 0.69) {
    const p = {};
    if (chance(0.3)) p.name = pick(NAMES);
    if (chance(0.25)) p.areaId = pick([...areas, null, '']);
    if (chance(0.3)) p.when = date();
    if (chance(0.2)) p.deadline = date();
    if (chance(0.15)) p.someday = chance(0.5);
    if (chance(0.1)) p.evening = chance(0.5);
    if (chance(0.2)) p.tags = pick(TAGS);
    if (chance(0.2)) p.notes = pick(NOTES);
    if (chance(0.1)) p.repeat = pick(RULES);
    if (chance(0.1)) p.reminder = '18:30';
    return { m: 'update_project', a: [bogus(projects), p] };
  }
  if (k < 0.72) return { m: 'complete_project', a: [bogus(projects), chance(0.5), pick(['done', 'canceled'])] };
  if (k < 0.74) return { m: 'reopen_project', a: [bogus(projects)] };
  if (k < 0.765) return { m: 'delete_project', a: [bogus(chance(0.3) ? trashed : projects)] };
  if (k < 0.78) return { m: 'restore_project', a: [bogus(trashed)] };
  if (k < 0.81) {
    const pos = pick([null, 'top', { before: bogus(todos) }, { after: bogus(todos) }, { beforeHeading: bogus(headings) }]);
    return { m: 'add_heading', a: [bogus(projects), pick(HEADINGS), pos] };
  }
  if (k < 0.83) return { m: 'update_heading', a: [bogus(headings), pick([{ name: pick(HEADINGS) }, { archived: true }, { archived: false }, {}])] };
  if (k < 0.845) return { m: 'delete_heading', a: [bogus(headings)] };
  if (k < 0.855) return { m: 'move_heading', a: [bogus(headings), bogus(projects)] };
  if (k < 0.87) return { m: 'create_area', a: [{ name: pick(NAMES), tags: pick(TAGS), notes: pick(NOTES) }] };
  if (k < 0.885) {
    const p = {};
    if (chance(0.5)) p.name = pick(NAMES);
    if (chance(0.3)) p.tags = pick(TAGS);
    if (chance(0.3)) p.notes = pick(NOTES);
    return { m: 'update_area', a: [bogus(areas), p] };
  }
  if (k < 0.895) return { m: 'delete_area', a: [bogus(areas)] };
  if (k < 0.9) return { m: 'empty_trash', a: [] };
  if (k < 0.91) {
    return { m: 'put_settings', a: [pick([{ logCompleted: pick(['immediately', 'daily', 'manually']) },
      { logCutoff: day.iso() }, { keymap: { 'todo.new': null } }, { calendars: ['Work'] }, { unknownKey: 1 }])] };
  }
  if (k < 0.93) return { ext: null };                // filled in by the caller, which can read storage
  const v = pick(['state', 'list_inbox', 'list_today', 'list_upcoming', 'list_anytime', 'list_someday', 'list_logbook',
    'list_trash', 'project_detail', 'area_detail', 'search', 'list_tomorrow', 'list_deadlines', 'list_repeating', 'list_projects']);
  const args = { project_detail: [bogus(projects)], area_detail: [bogus(areas)], search: [pick(['call', '#w', 'kitchen', '', 'ש'])],
    list_logbook: [pick([200, 3]), pick([null, day.iso()])], list_projects: [chance(0.5)] }[v] || [];
  return { v, a: args };
}

/** Someone editing a file behind the store's back: a box ticked in Obsidian,
 *  a line typed without an id, a file deleted, a new project note. */
async function externalEdit(storage, r, n) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const { files } = await storage.list();
  const md = files.filter((p) => p.endsWith('.md') && !p.startsWith('.'));
  const k = r();
  if (k < 0.12 || !md.length) {
    return { path: `Projects/From Obsidian ${n}.md`, text: '---\ntags:\n  - x\n---\nNotes\n\n- [ ] Typed there\n- [x] Done there\n' };
  }
  const path = pick(md);
  if (k < 0.18 && !['Inbox.md', 'Standalone.md', 'Trash.md'].includes(path)) return { path, text: null };
  const text = (await storage.read(path)).text;
  if (k < 0.55 && text.includes('- [ ]')) return { path, text: text.replace('- [ ]', '- [x]') };
  if (k < 0.8) return { path, text: text + (text.endsWith('\n') || !text ? '' : '\n') + '- [ ] Typed in Obsidian\n' };
  return { path, text: text.replace(/\n/gu, '\r\n') };
}

async function session(seed, steps) {
  const r = rng(seed);
  // DVARIM_PARITY_VAULT: start from a copy of real notes instead (never committed)
  const source = process.env.DVARIM_PARITY_VAULT ? vaultFiles(process.env.DVARIM_PARITY_VAULT) : sampleVault();
  const files = Object.fromEntries(source.map((f) => [f.path, f.text]));
  const storage = new MemoryStorage(files);
  const day = Day.fromISO(TODAY);
  const store = await Store.open(storage, { today: () => day, newId: counterIds(), obsidian: OBSIDIAN });
  const calls = [], results = [];
  for (let n = 0; n < steps; n++) {
    let call = pickCall(store, r, day, n);
    if (call.ext === null) {
      await store.flush();          // the store's own writes land first, or it reads a file mid-removal
      call = { ext: await externalEdit(storage, r, n) };
    }
    calls.push(call);
    results.push(await run(store, storage, call));
  }
  // and at the end, every list, so none goes unread however the dice fell
  for (const v of ['state', 'list_inbox', 'list_today', 'list_upcoming', 'list_anytime', 'list_someday', 'list_logbook',
    'list_trash', 'list_tomorrow', 'list_deadlines', 'list_repeating', 'list_projects']) {
    calls.push({ v, a: [] });
    results.push(await run(store, storage, { v, a: [] }));
  }
  for (const f of [...store.files.values()].filter((x) => x.kind === 'project' || x.kind === 'area')) {
    const call = { v: f.kind === 'project' ? 'project_detail' : 'area_detail', a: [f.frontmatter.id] };
    calls.push(call);
    results.push(await run(store, storage, call));
  }
  await store.flush();
  const snap = storage.snapshot();
  const dirs = [...storage.dirs].filter((d) => d !== '.dvarim').sort();
  return { files, calls, results, snap, dirs };
}

const SESSIONS = Number(process.env.DVARIM_SESSIONS || 30);
const STEPS = Number(process.env.DVARIM_STEPS || 60);
const SEED = Number(process.env.DVARIM_SEED || 1);

test(`the store agrees with the Python over ${SESSIONS} sessions of ${STEPS} steps`,
  { skip: !available() && 'no Python backend here' }, async () => {
    const runs = [];
    for (let s = 0; s < SESSIONS; s++) runs.push(await session(SEED * 1000 + s, STEPS));
    const answers = await askAll(runs.map((x) => ({ op: 'store', files: x.files, today: TODAY, obsidian: OBSIDIAN, calls: x.calls })));
    const problems = [];
    runs.forEach((x, s) => {
      const py = answers[s];
      if (py.error) { problems.push(`session ${s}: the Python raised ${py.error}`); return; }
      for (let i = 0; i < x.calls.length; i++) {
        const a = x.results[i], b = py.ok.results[i];
        const same = a.error || b.error ? a.error === b.error : (() => { try { assert.deepStrictEqual(a.ok, b.ok); return true; } catch { return false; } })();
        if (!same) {
          problems.push(`session ${s}, step ${i}: ${JSON.stringify(x.calls[i]).slice(0, 300)}\n` +
            `  engine: ${JSON.stringify(a).slice(0, 900)}\n  python: ${JSON.stringify(b).slice(0, 900)}`);
          return;                                    // the first divergence is the one that matters
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
    // what the sessions actually exercised, so a pass means something
    const tally = {};
    for (const x of runs) {
      x.calls.forEach((c, i) => {
        const name = c.ext ? 'external edit' : (c.m || c.v);
        const res = x.results[i].error || 'ok';
        tally[name] = tally[name] || {};
        tally[name][res] = (tally[name][res] || 0) + 1;
      });
    }
    if (process.env.DVARIM_TALLY) console.log('TALLY ' + JSON.stringify(tally));
    if (problems.length) assert.fail(`${problems.length} of ${SESSIONS} sessions diverge:\n\n${problems.slice(0, 3).join('\n\n')}`);
  });
