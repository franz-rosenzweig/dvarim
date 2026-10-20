// Two devices, one vault, and a sync between them (docs/SYNC.md).
//
// Each device is a store on its own folder. Between the folders runs a small
// Syncthing: it copies a file across when only one side changed it since they
// last agreed, and when both did, keeps the newer (a coin toss here) and
// leaves the other beside it as name.sync-conflict-….md, on both sides — what
// the real one does. Sessions mix work on each device, edits "in Obsidian" on
// each folder, and syncs of some files at a time, each followed by the
// device noticing (scanChanges), as FSEvents would make it.
//
// Then everything is synced until nothing moves, and the promises are held:
// - the two folders end up the same, and get there in a few rounds (no two
//   devices passing a file back and forth);
// - every to-do either device made is still somewhere;
// - every to-do either device completed is done wherever it is.
// Moves between files concurrent with edits can leave a to-do in two files
// (docs/SYNC.md, "what it does not do yet"); that is counted, not failed. The
// copy that is then given an id of its own is still that to-do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Day } from '../src/day.js';
import { Store } from '../src/store.js';
import { MemoryStorage } from '../src/storage.js';
import { parse } from '../src/mdformat.js';
import { sampleVault } from './corpus.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const TODAY = Day.fromISO('2026-09-19');

// one clock for both devices, a tick a step: what "the later change" means here
const clock = { t: 1_000_000 };

async function device(name, files, opts = {}) {
  const storage = new MemoryStorage(files);
  let n = 0;
  const store = await Store.open(storage, {
    ...opts,
    today: () => TODAY,
    now: () => clock.t,
    // each device's own ids, so the two never invent the same one by chance
    newId: (p = '') => p + `${name}${(++n).toString(36)}`.padStart(8 - p.length, '0'),
  });
  // every id the repair gave a copy of its own (store.js, _repairIds): the
  // store keeps the last fifty of what it did, this keeps all of it
  const renamed = [];
  const log = store._logSync.bind(store);
  store._logSync = (e) => { if (e.ids) renamed.push(...Object.entries(e.ids)); log(e); };
  return { name, storage, store, renamed };
}

/** Syncthing, near enough: per file, what both sides last agreed on. With
 *  copies off, it is a sync that keeps only the newer file of two (iCloud
 *  Drive, a plain copy): the other is gone, and only the merge keeps it. */
class Sync {
  constructor(a, b, r, copies = true) {
    this.a = a; this.b = b; this.r = r; this.copies = copies;
    this.agreed = new Map(Object.entries(a.storage.snapshot()));
    this.conflicts = 0;
    this.stamp = 0;
  }

  paths() {
    return [...new Set([...this.a.storage.files.keys(), ...this.b.storage.files.keys(), ...this.agreed.keys()])].sort();
  }

  /** Bring one file into agreement. True if anything moved. */
  async file(path) {
    const [A, B] = [this.a.storage, this.b.storage];
    const x = A.files.has(path) ? A.files.get(path).text : null;
    const y = B.files.has(path) ? B.files.get(path).text : null;
    const s = this.agreed.has(path) ? this.agreed.get(path) : null;
    if (x === y) { if (x === null) this.agreed.delete(path); else this.agreed.set(path, x); return false; }
    const put = async (st, text) => { if (text === null) await st.remove(path); else await st.write(path, text); };
    if (x === s) { await put(A, y); this.agreed.set(path, y); return true; }          // only B changed it
    if (y === s) { await put(B, x); this.agreed.set(path, x); return true; }          // only A changed it
    // both changed it: a change beats a deletion; between two changes, the newer
    // wins and the other is kept beside it as a conflict copy
    let win, lose;
    if (x === null || y === null) win = x ?? y;
    else [win, lose] = this.r() < 0.5 ? [x, y] : [y, x];
    await put(A, win); await put(B, win);
    this.agreed.set(path, win);
    if (this.copies && lose != null) {
      this.conflicts++;
      const copy = path.replace(/(\.[^./]+)$/u, `.sync-conflict-20260919-${String(++this.stamp).padStart(6, '0')}-ABCDEFG$1`);
      await A.write(copy, lose); await B.write(copy, lose);
      this.agreed.set(copy, lose);
    }
    return true;
  }

  /** Some files, then each device notices. */
  async some(fraction) {
    await this.a.store.flush(); await this.b.store.flush();
    let moved = false;
    for (const p of this.paths()) if (this.r() < fraction && await this.file(p)) moved = true;
    await this.a.store.scanChanges(); await this.b.store.scanChanges();
    await this.a.store.flush(); await this.b.store.flush();
    return moved;
  }
}

const TITLES = ['Call Dana', 'Buy milk', 'Pay rent', 'Book flights', 'Water plants', 'Email the editor'];
const DATES = ['2026-09-19', '2026-09-20', '2026-09-25', '2026-10-02', null];

/** Something a person does on one device. */
function work(dev, r, made, completed, settings) {
  const s = dev.store;
  const pick = (a) => a[Math.floor(r() * a.length)];
  const open = [...s.files.values()].filter((f) => f.path !== 'Trash.md').flatMap((f) => [...f.allTodos()])
    .filter((t) => t.status === 'open' && !t.id.startsWith('tmp'));
  const projects = [...s.files.values()].filter((f) => f.kind === 'project' && !f.path.startsWith('Trash/')).map((f) => f.frontmatter.id);
  const k = r();
  try {
    if (k < 0.3 || !open.length) {
      const where = r() < 0.5 || !projects.length ? { inbox: true } : { projectId: pick(projects) };
      made.add(s.createTodo({ title: `${pick(TITLES)} (${dev.name})`, ...where }).id);
    } else if (k < 0.5) {
      const t = pick(open);
      s.completeTodo(t.id);
      completed.add(t.id);
    } else if (k < 0.65) s.updateTodo(pick(open).id, { when: pick(DATES) });
    else if (k < 0.75) s.updateTodo(pick(open).id, { notes: `${pick(TITLES)} — noted on ${dev.name}` });
    else if (k < 0.82) s.updateTodo(pick(open).id, { title: `${pick(TITLES)}, again (${dev.name})` });
    else if (k < 0.88 && projects.length) s.moveTodo(pick(open).id, { projectId: pick(projects) });
    else if (k < 0.9) s.deleteTodo(pick(open).id);
    else if (k < 0.94) {
      // a setting, changed on this device: the later change must win everywhere
      const [key, value] = pick([['logCompleted', pick(['immediately', 'daily', 'manually'])], ['weekStartsOn', pick([0, 1, 6])],
        ['eveningStartsAt', pick(['18:00', '19:30'])], ['badgeCount', pick(['today', 'inbox'])]]);
      // choosing what is already chosen changes nothing, and is not a change
      if (JSON.stringify(s.getSettings()[key]) !== JSON.stringify(value)) settings.set(key, value);
      s.putSettings({ [key]: value });
    } else if (k < 0.97) s.reorder('inbox', open.filter((t) => s.todoIndex.get(t.id) === 'Inbox.md').map((t) => t.id).sort(() => r() - 0.5));
    else s.updateTodo(pick(open).id, { tags: [pick(['work', 'home', 'errand'])] });
  } catch (e) {
    if (!/NotFound|Conflict|Invalid/u.test(e.constructor.name)) throw e;
  }
}

/** Someone editing the folder in Obsidian on one device, then the device noticing. */
async function obsidian(dev, r, completed) {
  await dev.store.flush();
  const files = [...dev.storage.files.keys()].filter((p) => p.endsWith('.md') && !p.startsWith('.') && !p.includes('sync-conflict'));
  const path = files[Math.floor(r() * files.length)];
  const text = dev.storage.files.get(path).text;
  let next;
  const hit = /- \[ \] .*🆔 ([0-9a-z]{8})/u.exec(text);
  if (r() < 0.5 && hit) {
    next = text.replace(hit[0], hit[0].replace('- [ ]', '- [x]'));
    completed.add(hit[1]);
  } else next = text + (text.endsWith('\n') || !text ? '' : '\n') + `- [ ] Typed on ${dev.name} ${Math.floor(r() * 1000)}\n`;
  await dev.storage.write(path, next);
  await dev.store.scanChanges();
  await dev.store.flush();
}

function vault(storage) {
  const ids = new Map();
  for (const [path, f] of storage.files) {
    if (!path.endsWith('.md') || path.startsWith('.')) continue;
    for (const t of parse(f.text, path).allTodos()) {
      if (!t.id) continue;
      if (!ids.has(t.id)) ids.set(t.id, []);
      ids.get(t.id).push({ path, status: t.status });
    }
  }
  return ids;
}

const SESSIONS = Number(process.env.DVARIM_SESSIONS || 40);
const STEPS = Number(process.env.DVARIM_STEPS || 40);

for (const [copies, kind] of [[true, 'a sync that leaves conflict copies (Syncthing)'], [false, 'a sync that keeps only the newer file']]) {
test(`two devices and ${kind} agree, and lose nothing, over ${SESSIONS} sessions of ${STEPS} steps`, async () => {
  const problems = [];
  const tally = { conflictCopies: 0, merges: 0, rounds: 0, twoFiles: 0 };
  for (let session = 0; session < SESSIONS && problems.length < 3; session++) {
    const r = rng(Number(process.env.DVARIM_SEED || 1) * 1000 + session);
    const files = Object.fromEntries(sampleVault().map((f) => [f.path, f.text]));
    // a sync with no conflict copies can put a stale file in place: merged (docs/SYNC.md)
    const opts = { mergeArrivals: !copies };
    const A = await device('a', files, opts), B = await device('b', files, opts);
    await A.store.flush(); await B.store.flush();
    const sync = new Sync(A, B, r, copies);
    await sync.some(1);
    const made = new Set(), completed = new Set(), settings = new Map();
    for (let step = 0; step < STEPS; step++) {
      clock.t += 1000;
      const k = r();
      if (k < 0.55) work(r() < 0.5 ? A : B, r, made, completed, settings);
      else if (k < 0.65) await obsidian(r() < 0.5 ? A : B, r, completed);
      else await sync.some(r() < 0.3 ? 1 : 0.4);
    }
    // everything, until nothing moves
    let rounds = 0;
    while (rounds < 12 && await sync.some(1)) rounds++;
    tally.rounds = Math.max(tally.rounds, rounds);
    tally.conflictCopies += sync.conflicts;
    tally.merges += A.store.syncLog.length + B.store.syncLog.length;
    const where = `session ${session}`;
    try {
      assert.ok(rounds < 12, 'the two never settled: something passes a file back and forth');
      const sa = A.storage.snapshot(), sb = B.storage.snapshot();
      const notes = (snap) => Object.fromEntries(Object.entries(snap).filter(([p]) => p.endsWith('.md') && !p.startsWith('.dvarim/')));
      assert.deepEqual(notes(sa), notes(sb), 'the two folders differ');
      const left = Object.keys(sa).filter((p) => p.includes('.sync-conflict-') && !p.startsWith('.dvarim/conflicts/'));
      assert.deepEqual(left, [], 'a conflict copy was left lying in the vault');
      const state = (snap) => (snap['.dvarim/state.json'] === undefined ? null : JSON.parse(snap['.dvarim/state.json']));
      assert.deepEqual(state(sa), state(sb), 'the two devices\' settings and orders differ');
      assert.deepEqual(A.store.state.settings, B.store.state.settings, 'the two devices hold different settings');
      for (const [key, value] of settings) assert.deepEqual(A.store.state.settings[key], value, `${key}: the last change made, ${value}, did not stick`);
      const ids = vault(A.storage);
      // a to-do's places: under its id, and under the ids its copies were given
      const renames = [...A.renamed, ...B.renamed];
      const places = (id) => {
        const all = new Set([id]);
        for (let grew = true; grew;) {
          grew = false;
          for (const [from, to] of renames) if (all.has(from) && !all.has(to)) { all.add(to); grew = true; }
        }
        return [...all].filter((x) => ids.has(x)).flatMap((x) => ids.get(x));
      };
      for (const id of made) assert.ok(places(id).length, `${id}, made on a device, is gone`);
      for (const id of completed) {
        const where = places(id);
        if (!where.length) continue;                 // made and removed by someone: not ours to judge here
        assert.ok(where.some((c) => c.status === 'done'), `${id}, completed on a device, is not done anywhere: ${JSON.stringify(where)}`);
      }
      tally.twoFiles += [...ids.values()].filter((c) => new Set(c.map((x) => x.path)).size > 1).length;
    } catch (e) {
      problems.push(`${where}: ${e.message.slice(0, 1500)}`);
    }
  }
  if (process.env.DVARIM_TALLY) console.log(`SYNC ${kind} ` + JSON.stringify(tally));
  if (problems.length) assert.fail(`${problems.length} sessions broke a promise:\n${problems.join('\n\n')}`);
});
}
