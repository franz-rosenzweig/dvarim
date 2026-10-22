// The to-do mirror (src/tasksync.js) against the Python's TaskSync, session
// for session: work on the files, edits in another CalDAV app (ticked,
// retitled, rescheduled, rewritten by a client that knows only the basics,
// created, deleted), and sync cycles between them — through both, each with
// the same in-memory stand-in for the CalDAV server. Every answer, every file,
// what is in the collection and the mirror's own state must be the same.
// Then the cases backend/tests/test_tasksync.py pins, here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Day } from '../../engine/src/day.js';
import { Store } from '../../engine/src/store.js';
import { NodeStorage } from '../../engine/src/storage-node.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep, dirname } from 'node:path';
import { TaskSync } from '../src/tasksync.js';
import * as vtodo from '../src/vtodo.js';
import { available, askAll } from '../../engine/test/oracle.js';
import { sampleVault } from '../../engine/test/corpus.js';

const TODAY = '2026-09-19';
const NOW = '2026-09-19T12:00:00+00:00';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function counterIds() {
  let n = 0;
  return (prefix = '') => { n += 1; return prefix + n.toString(36).padStart(8 - prefix.length, '0'); };
}
const camel = (s) => s.replace(/_([a-z])/gu, (_, c) => c.toUpperCase());

/** The stand-in: a collection in a map, etags that change on every write. */
class FakeCalDAV {
  constructor() { this.items = new Map(); this.etags = new Map(); this.n = 0; this.created = null; }
  async ensureTaskCollection(name, display) { this.created = [name, display]; return `/dav/${name}/`; }
  async listEtags() { return Object.fromEntries(this.etags); }
  async getText(href) { if (!this.items.has(href)) throw new Error(`KeyError: '${href}'`); return this.items.get(href); }
  async putIcs(href, body) { this.n += 1; this.items.set(href, body); this.etags.set(href, `e${this.n}`); return `e${this.n}`; }
  async delete(href) { this.items.delete(href); this.etags.delete(href); }
}

function tree(root) {
  const files = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files[relative(root, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return files;
}

const noStamp = (ics) => ics.replace(/DTSTAMP:[0-9TZ]+\r\n/gu, '');

/** Something done on one side or the other, chosen from what is there now. */
function pick(store, dav, r, n) {
  const one = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;
  const open = [...store.openTodos()].map(([, t]) => t.id).filter((id) => !id.startsWith('tmp'));
  const hrefs = [...dav.items.keys()];
  const k = r();
  if (k < 0.18) return { sync: true };
  if (k < 0.34) return { s: 'create_todo', a: [{ title: one(['Buy stamps', 'Call Dana', 'שלום', 'Parked', 'Draft ch. 4']), inbox: chance(0.5), when: one([TODAY, null, '2026-09-25']), someday: chance(0.15), tags: chance(0.3) ? ['work'] : [] }] };
  if (k < 0.42 && open.length) return { s: 'complete_todo', a: [one(open)] };
  if (k < 0.5 && open.length) return { s: 'update_todo', a: [one(open), one([{ title: 'Renamed here' }, { deadline: '2026-10-01' }, { evening: true }, { notes: 'A note\nwith lines' }, { someday: true }])] };
  if (k < 0.54 && open.length) return { s: 'delete_todo', a: [one(open)] };
  if (k < 0.66 && hrefs.length) {
    return { dav: 'edit', href: one(hrefs), changes: one([{ status: 'done', completed: '2026-09-20' }, { title: 'Renamed there' }, { when: '2026-09-28' }, { tags: ['phone'] }, { status: 'canceled' }, { notes: 'From the phone' }]) };
  }
  if (k < 0.72 && hrefs.length) {
    // a client that knows only the summary and the status
    const href = one(hrefs);
    const id = href.split('/').pop().slice(0, -4);
    return { dav: 'raw', href, text: `BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:${id}@dvarim\r\nSUMMARY:Simple client ${n}\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n` };
  }
  if (k < 0.8) return { dav: 'create', fields: { id: `dav${String(n).padStart(5, '0')}`, title: one(['Ring the dentist', 'From Tasks.org', '']), status: 'open', notes: '', when: one([null, TODAY]), deadline: null } };
  if (k < 0.86 && hrefs.length) return { dav: 'delete', href: one(hrefs) };
  return { sync: true };
}

async function run(store, dav, sync, step) {
  try {
    let out;
    if (step.s) out = store[camel(step.s)](...(step.a || []));
    else if (step.dav === 'edit') {
      const parsed = { ...vtodo.fromIcs(dav.items.get(step.href)), ...step.changes };
      const todo = { id: parsed.id, title: parsed.title ?? '', notes: parsed.notes ?? '', status: parsed.status ?? 'open', when: parsed.when ?? null,
        deadline: parsed.deadline ?? null, tags: parsed.tags ?? [], completed: parsed.completed ?? null, checklist: [] };
      dav.n += 1;
      dav.items.set(step.href, vtodo.toIcs(todo, new Date(NOW)));
      dav.etags.set(step.href, `e${dav.n}`);
      out = null;
    } else if (step.dav === 'raw') {
      dav.n += 1;
      dav.items.set(step.href, step.text);
      dav.etags.set(step.href, `e${dav.n}`);
      out = null;
    } else if (step.dav === 'create') {
      const href = `/dav/dvarim/${step.fields.id}.ics`;
      dav.n += 1;
      dav.items.set(href, vtodo.toIcs({ checklist: [], tags: [], ...step.fields }, new Date(NOW)));
      dav.etags.set(href, `e${dav.n}`);
      out = href;
    } else if (step.dav === 'delete') { await dav.delete(step.href); out = null; }
    else if (step.sync) out = await sync.sync();
    await store.flush();
    return { ok: out === undefined ? null : JSON.parse(JSON.stringify(out)) };
  } catch (e) {
    return { error: e.constructor.name === 'NotFound' ? 'NotFound' : e.constructor.name === 'Conflict' ? 'Conflict' : e.constructor.name === 'Invalid' ? 'Invalid' : 'Other', detail: String(e) };
  }
}

async function session(seed, steps) {
  const r = rng(seed);
  const root = mkdtempSync(join(tmpdir(), 'dv-tasksync-'));
  const files = Object.fromEntries(sampleVault().map((f) => [f.path, f.text]));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  const day = Day.fromISO(TODAY);
  const store = await Store.open(new NodeStorage(root), { today: () => day, newId: counterIds() });
  await store.flush();
  const dav = new FakeCalDAV();
  const sync = new TaskSync(store, dav, { root });
  const recorded = [], results = [];
  for (let n = 0; n < steps; n++) {
    const step = pick(store, dav, r, n);
    recorded.push(step);
    results.push(await run(store, dav, sync, step));
  }
  recorded.push({ sync: true });
  results.push(await run(store, dav, sync, { sync: true }));
  const snap = tree(root);
  const state = snap['.dvarim/vtodo.json'] ? JSON.parse(snap['.dvarim/vtodo.json']) : null;
  rmSync(root, { recursive: true, force: true });
  return { files, recorded, results, snap, dav, state };
}

const SESSIONS = Number(process.env.DVARIM_SESSIONS || 40);
const STEPS = Number(process.env.DVARIM_STEPS || 40);

test(`the to-do mirror agrees with the Python's over ${SESSIONS} sessions of ${STEPS} steps`, { skip: !available() && 'no Python here' }, async () => {
  const runs = [];
  for (let s = 0; s < SESSIONS; s++) runs.push(await session(Number(process.env.DVARIM_SEED || 1) * 1000 + s, STEPS));
  const answers = await askAll(runs.map((x) => ({ op: 'tasksync', files: x.files, today: TODAY, now: NOW, steps: x.recorded })));
  const problems = [];
  const tally = { pulled: 0, adopted: 0, buried: 0, pushed: 0, pruned: 0 };
  runs.forEach((x, s) => {
    const py = answers[s];
    if (py.error) { problems.push(`session ${s}: the oracle failed: ${py.error}`); return; }
    for (let i = 0; i < x.recorded.length; i++) {
      const a = x.results[i], b = py.ok.results[i];
      const same = a.error || b.error ? a.error === b.error : JSON.stringify(a.ok) === JSON.stringify(b.ok);
      if (!same) { problems.push(`session ${s}, step ${i}: ${JSON.stringify(x.recorded[i]).slice(0, 200)}\n  ours:   ${JSON.stringify(a).slice(0, 500)}\n  python: ${JSON.stringify(b).slice(0, 500)}`); return; }
      if (x.recorded[i].sync && a.ok && a.ok.ok) for (const k of Object.keys(tally)) tally[k] += a.ok[k];
    }
    const snap = Object.fromEntries(Object.entries(x.snap).filter(([p]) => p !== '.dvarim/vtodo.json' && p !== '.dvarim/stamps.json'));
    const pySnap = Object.fromEntries(Object.entries(py.ok.files).filter(([p]) => p !== '.dvarim/vtodo.json'));
    try { assert.deepStrictEqual(snap, pySnap); } catch {
      const p = [...new Set([...Object.keys(snap), ...Object.keys(pySnap)])].find((k) => snap[k] !== pySnap[k]);
      problems.push(`session ${s}: ${p} differs\n  ours:   ${JSON.stringify(snap[p] ?? null).slice(0, 500)}\n  python: ${JSON.stringify(pySnap[p] ?? null).slice(0, 500)}`);
      return;
    }
    const items = (m) => Object.fromEntries([...Object.entries(m)].map(([h, t]) => [h, noStamp(t)]));
    try { assert.deepStrictEqual(items(Object.fromEntries(x.dav.items)), items(py.ok.dav)); } catch { problems.push(`session ${s}: the collections differ`); return; }
    try { assert.deepStrictEqual(Object.fromEntries(x.dav.etags), py.ok.etags); } catch { problems.push(`session ${s}: the etags differ`); return; }
    try { assert.deepStrictEqual(x.state, py.ok.state); } catch { problems.push(`session ${s}: the mirror's state differs\n  ours:   ${JSON.stringify(x.state).slice(0, 400)}\n  python: ${JSON.stringify(py.ok.state).slice(0, 400)}`); }
  });
  if (process.env.DVARIM_TALLY) console.log('TASKSYNC ' + JSON.stringify(tally));
  if (problems.length) assert.fail(`${problems.length} of ${SESSIONS} sessions differ:\n${problems.slice(0, 3).join('\n\n')}`);
});

// ---- the cases the Python's own tests pin ------------------------------------------

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dv-ts-'));
  const day = Day.fromISO(TODAY);
  const store = await Store.open(new NodeStorage(root), { today: () => day });
  await store.flush();
  const dav = new FakeCalDAV();
  return { root, store, dav, sync: new TaskSync(store, dav, { root }) };
}

test('a client that knows only the basics cannot flatten what it cannot express', async () => {
  const { root, store, dav, sync } = await setup();
  const p = store.createProject({ name: 'Report' });
  const h = store.addHeading(p.id, 'Hand-in');
  const t = store.createTodo({ title: 'Send part 4', projectId: p.id, headingId: h.id, when: TODAY, evening: true, reminder: '15:00',
    repeat: 'every week', checklist: [{ text: 'bundle', done: false }] });
  await sync.sync();
  const href = [...dav.items.keys()][0];
  dav.items.set(href, `BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:${t.id}@dvarim\r\nSUMMARY:Send part four\r\nSTATUS:NEEDS-ACTION\r\nDTSTART;VALUE=DATE:20260919\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`);
  dav.etags.set(href, 'changed');
  await sync.sync();
  const [, , obj] = store.getTodo(t.id);
  assert.equal(obj.title, 'Send part four');
  assert.equal(obj.evening, true);
  assert.equal(obj.reminder, '15:00');
  assert.equal(obj.repeat, 'every week');
  assert.equal(obj.heading, 'Hand-in');
  assert.deepEqual(obj.checklist.map((c) => c.text), ['bundle']);
  rmSync(root, { recursive: true, force: true });
});

test('losing the state costs writes, not data; a broken server does not take the app down', async () => {
  const { root, store, dav, sync } = await setup();
  store.createTodo({ title: 'Something', when: TODAY });
  await sync.sync();
  rmSync(join(root, '.dvarim', 'vtodo.json'));
  sync.collection = null;
  const r = await sync.sync();
  assert.ok(r.ok && r.pushed === 1);
  assert.equal(dav.items.size, 1);
  dav.listEtags = async () => { throw new Error('radicale is down'); };
  const bad = await sync.sync();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /radicale is down/u);
  assert.ok(sync.status().lastError);
  rmSync(root, { recursive: true, force: true });
});

test('Tasks.org\'s reminders are not the to-do: their text never reaches the notes', async () => {
  const { root, store, dav, sync } = await setup();
  const t = store.createTodo({ title: 'Wording for the newsletter', deadline: '2026-10-05', notes: 'Keep it short.' });
  await sync.sync();
  const href = [...dav.items.keys()][0];
  // as DAVx⁵ writes it back for Tasks.org, with two default reminders
  const back = (description, status) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:DAVx5/4.5.19-ose ical4j/4.3.0 (org.tasks)',
    'BEGIN:VTODO', `DESCRIPTION:${description}`, 'DUE;VALUE=DATE:20261005', `STATUS:${status}`, 'SUMMARY:Wording for the newsletter',
    `UID:${t.id}@dvarim`, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Default Tasks.org description', 'TRIGGER;RELATED=END:PT0S',
    'END:VALARM', 'BEGIN:VALARM', 'ACTION:EMAIL', 'SUMMARY:A reminder', 'DESCRIPTION:Default Tasks.org description',
    'TRIGGER;RELATED=END:P1D', 'END:VALARM', 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n');
  dav.items.set(href, back('Keep it short.', 'NEEDS-ACTION'));
  dav.etags.set(href, 'reminders added');
  await sync.sync();
  let obj = store.getTodo(t.id)[2];
  assert.equal(obj.title, 'Wording for the newsletter');
  assert.equal(obj.notes, 'Keep it short.');
  // where an earlier cycle had already sent it back as the to-do's own text
  dav.items.set(href, back('Default Tasks.org description', 'COMPLETED'));
  dav.etags.set(href, 'ticked');
  await sync.sync();
  await store.flush();
  obj = store.getTodo(t.id)[2];
  assert.equal(obj.status, 'done');
  assert.equal(obj.notes, 'Keep it short.');
  assert.ok(!Object.values(tree(root)).some((x) => x.includes('Default Tasks.org')), 'in no file');
  rmSync(root, { recursive: true, force: true });
});

test('a to-do another tool marked [/] is the same to-do to the mirror: ticked there, ticked here, not adopted again', async () => {
  const { root, store, dav, sync } = await setup();
  const t = store.createTodo({ title: 'Rename the shared folder', when: TODAY });
  await sync.sync();
  await store.flush();
  const path = join(root, store.getTodo(t.id)[0].path);
  writeFileSync(path, readFileSync(path, 'utf8').replace('- [ ] Rename', '- [/] Rename'));
  await store.scanChanges();
  const href = [...dav.items.keys()][0];
  dav.items.set(href, dav.items.get(href).replace('STATUS:NEEDS-ACTION', 'STATUS:COMPLETED'));
  dav.etags.set(href, 'ticked');
  const r = await sync.sync();
  await store.flush();
  assert.equal(r.adopted, 0);
  const mine = readFileSync(path, 'utf8').split('\n').filter((l) => l.includes(t.id));
  assert.equal(mine.length, 1, mine.join('\n'));
  assert.match(mine[0], /^- \[x\] Rename the shared folder /u);
  assert.equal([...store.openTodos()].length, 0, 'nothing new in the Inbox');
  rmSync(root, { recursive: true, force: true });
});
