// What arrives on disk, and the conflict copies sync tools leave beside it
// (docs/SYNC.md, "When a file arrives"), from what went wrong on the server's
// first day on the engine (2026-09-23): a to-do deleted in Obsidian came back,
// and old Syncthing copies brought back to-dos long since trashed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Day } from '../src/day.js';
import { Store, copyTime } from '../src/store.js';
import { MemoryStorage } from '../src/storage.js';
import { parse } from '../src/mdformat.js';

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

async function open(files, opts = {}) {
  const storage = new MemoryStorage(files);
  let t = NOW, n = 0;
  const store = await Store.open(storage, {
    today: () => Day.fromISO('2026-09-23'),
    now: () => (t += 1000),
    newId: () => `new${(++n).toString(36).padStart(5, '0')}`,
    ...opts,
  });
  await store.scanChanges();        // what the watcher does first: conflict copies are a scan's
  await store.flush();
  return { storage, store };
}

const text = (storage, path) => storage.files.get(path).text;
const ids = (storage, path) => [...parse(text(storage, path), path).allTodos()].map((t) => t.id);
const drop = (s, id) => s.split('\n').filter((l) => !l.includes(id)).join('\n');

const INBOX = '---\ntype: inbox\n---\n- [ ] Keep me 🆔 keep0001\n';
const TRASH = '---\ntype: trash\n---\n- [ ] Trashed on Monday 🆔 gone0001 ➕ 2026-09-20 🗑️ 2026-09-22 ↩ Inbox.md\n';
const PROJECT = '---\nid: proj0001\ntype: project\nstatus: open\ntags: [personal, relationships]\ncreated: 2026-09-19\nupdated: 2026-09-21T11:47\n---\nNotes.\n\n- [ ] First 🆔 firs0001\n';

test('a to-do deleted in Obsidian stays deleted, though the app only just added it', async () => {
  const { storage, store } = await open({ 'Inbox.md': INBOX });
  const x = store.createTodo({ title: 'Added in the app', inbox: true });
  const y = store.createTodo({ title: 'Also added', inbox: true });
  await store.flush();
  await storage.write('Inbox.md', drop(text(storage, 'Inbox.md'), x.id));
  await store.scanChanges(); await store.flush();
  assert.deepEqual(ids(storage, 'Inbox.md'), ['keep0001', y.id]);
  // and a change undone there: the title back as it was
  store.updateTodo(y.id, { title: 'Renamed in the app' });
  await store.flush();
  await storage.write('Inbox.md', text(storage, 'Inbox.md').replace('Renamed in the app', 'Also added'));
  await store.scanChanges(); await store.flush();
  assert.match(text(storage, 'Inbox.md'), /Also added/u);
  assert.equal(store.syncLog.length, 0, 'nothing merged');
});

test('with mergeArrivals, a file made without this device\'s change is merged with it', async () => {
  const { storage, store } = await open({ 'Inbox.md': INBOX }, { mergeArrivals: true });
  const before = text(storage, 'Inbox.md');
  const x = store.createTodo({ title: 'Added here', inbox: true });
  await store.flush();
  // the other device, never having seen it, added its own: a plain copy puts that in place
  await storage.write('Inbox.md', before + '- [ ] Added there 🆔 ther0001\n');
  await store.scanChanges(); await store.flush();
  assert.deepEqual(ids(storage, 'Inbox.md').sort(), ['keep0001', x.id, 'ther0001'].sort());
  assert.equal(store.syncLog[0].kind, 'merged');
});

test('when a conflict copy was made, from its name', () => {
  assert.equal(copyTime('Inbox.sync-conflict-20260920-105958-K4MXQ7B.md'), Date.UTC(2026, 8, 20, 10, 59, 58));
  assert.equal(copyTime("Inbox (Robin's conflicted copy 2026-09-20).md"), Date.UTC(2026, 8, 21));
  assert.equal(copyTime('Inbox.md'), null);
});

test('a conflict copy more than two days old is put away unmerged', async () => {
  const stale = INBOX + '- [ ] Drag test item 🆔 drag0001 ➕ 2026-09-20\n';
  const { storage, store } = await open({ 'Inbox.md': INBOX, 'Inbox.sync-conflict-20260920-105958-K4MXQ7B.md': stale });
  assert.deepEqual(ids(storage, 'Inbox.md'), ['keep0001']);
  assert.ok(!storage.files.has('Inbox.sync-conflict-20260920-105958-K4MXQ7B.md'));
  assert.equal(text(storage, '.dvarim/conflicts/Inbox.sync-conflict-20260920-105958-K4MXQ7B.md'), stale, 'kept, not deleted');
  assert.equal(store.syncLog[0].kind, 'old conflict copy, put away unmerged');
});

test('a conflict copy made today is merged', async () => {
  const copy = INBOX + '- [ ] Only in the copy 🆔 copy0001 ➕ 2026-09-23\n';
  const { storage } = await open({ 'Inbox.md': INBOX, 'Inbox.sync-conflict-20260923-102155-K4MXQ7B.md': copy });
  assert.deepEqual(ids(storage, 'Inbox.md'), ['keep0001', 'copy0001']);
});

test('a conflict copy does not bring back a to-do that has gone to Trash or another file', async () => {
  const copy = INBOX + '- [ ] Trashed on Monday 🆔 gone0001 ➕ 2026-09-20\n- [ ] Moved to a project 🆔 moved001\n- [ ] Only in the copy 🆔 copy0001\n';
  const project = PROJECT + '- [ ] Moved to a project 🆔 moved001\n';
  const { storage, store } = await open({
    'Inbox.md': INBOX, 'Trash.md': TRASH, 'Projects/P.md': project,
    'Inbox.sync-conflict-20260923-102155-K4MXQ7B.md': copy,
  });
  assert.deepEqual(ids(storage, 'Inbox.md'), ['keep0001', 'copy0001']);
  assert.deepEqual(ids(storage, 'Trash.md'), ['gone0001']);
  assert.deepEqual(store.syncLog[0].leftOut, ['gone0001', 'moved001']);
});

test('a conflict copy leaves its file\'s front matter as it is', async () => {
  const older = PROJECT.replace('tags: [personal, relationships]', 'tags:\n  - personal\n  - relationships')
    .replace('updated: 2026-09-21T11:47', 'updated: 2026-09-20T11:23') + '- [ ] From the copy 🆔 copy0001\n';
  const { storage } = await open({ 'Projects/P.md': PROJECT, 'Projects/P.sync-conflict-20260923-102155-K4MXQ7B.md': older });
  const now = text(storage, 'Projects/P.md');
  assert.equal(now.slice(0, now.indexOf('\n---\n') + 5), PROJECT.slice(0, PROJECT.indexOf('\n---\n') + 5));
  assert.deepEqual(ids(storage, 'Projects/P.md'), ['firs0001', 'copy0001']);
});

test('a conflict copy that changed a to-do since moved elsewhere keeps the change', async () => {
  const copy = INBOX + '- [x] Moved to a project 🆔 moved001 ✅ 2026-09-23\n';
  const project = PROJECT + '- [ ] Moved to a project 🆔 moved001\n';
  const { storage } = await open({
    'Inbox.md': INBOX, 'Projects/P.md': project,
    'Inbox.sync-conflict-20260923-102155-K4MXQ7B.md': copy,
  });
  assert.deepEqual(ids(storage, 'Inbox.md'), ['keep0001', 'moved001'], 'done where the copy had it, and still in the project');
});

// ---- someone typing in Obsidian (2026-09-24): the server's own writes, made
// between two of Obsidian's saves, lost to the next one and came back as
// conflict copies, whose merges were more writes. A loop, and notes that
// gained a second copy of lines that had moved out of them.

test('with quietMs, what the store would write into a file being edited waits until it is quiet', async () => {
  let t = NOW;
  const { storage, store } = await open({ 'Inbox.md': INBOX }, { quietMs: 30000, now: () => t });
  const before = text(storage, 'Inbox.md');
  // Obsidian ticks the box: the store would date it at once
  await storage.write('Inbox.md', before.replace('- [ ]', '- [x]'));
  t += 1000;
  await store.scanChanges(); await store.flush();
  assert.equal(text(storage, 'Inbox.md'), before.replace('- [ ]', '- [x]'), 'nothing written while it is being edited');
  assert.equal(store._file('Inbox.md').find('keep0001')[0].todos[0].completed, '2026-09-23', 'though the app has it already');
  t += 10000;
  assert.deepEqual(store.writeHeld(), [], 'still not quiet');
  t += 30000;
  assert.deepEqual(store.writeHeld(), ['Inbox.md']);
  await store.flush();
  assert.match(text(storage, 'Inbox.md'), /- \[x\] Keep me 🆔 keep0001 ✅ 2026-09-23/u);
});

test('a copy of this device\'s own write, lost to an Obsidian save, is merged against the version before it', async () => {
  let t = NOW;
  const { storage, store } = await open({ 'Inbox.md': INBOX }, { now: () => t });
  const before = text(storage, 'Inbox.md');
  const made = store.createTodo({ title: 'Made in the web app', inbox: true });
  await store.flush();
  const own = text(storage, 'Inbox.md');
  // Obsidian saves what it had, plus a line and a note typed there, and wins
  await storage.write('Inbox.md', before.replace('Keep me 🆔 keep0001\n', 'Keep me 🆔 keep0001\n    typed in Obsidian\n') + '- [ ] Typed in Obsidian 🆔 obsd0001\n');
  await storage.write('Inbox.sync-conflict-20260923-120000-K4MXQ7B.md', own);
  t += 1000;
  await store.scanChanges(); await store.flush();
  const after = text(storage, 'Inbox.md');
  assert.deepEqual(ids(storage, 'Inbox.md').sort(), ['keep0001', made.id, 'obsd0001'].sort(), after);
  assert.equal(after.split('typed in Obsidian').length, 2, 'the note typed there once, not twice');
});

test('a copy of this device\'s work, beside a file made from an older version of it, keeps all that work', async () => {
  // Syncthing: the other device, out of touch since this one opened the
  // file, saved its own change and won; this device's version is the copy.
  // The file was made from the version this device opened, not from the one
  // just before the copy, so nothing done here since is a deletion there.
  let t = NOW;
  const { storage, store } = await open({ 'Inbox.md': INBOX }, { now: () => t });
  const opened = text(storage, 'Inbox.md');
  const a = store.createTodo({ title: 'Made here first', inbox: true });
  const b = store.createTodo({ title: 'Made here second', inbox: true });
  await store.flush();
  store.completeTodo(a.id);
  await store.flush();
  const ours = text(storage, 'Inbox.md');
  // what the other device saw, and deleted: a line this device had all along
  await storage.write('Inbox.md', opened.replace('- [ ] Keep me 🆔 keep0001\n', '') + '- [ ] From the other device 🆔 othr0001\n');
  await storage.write('Inbox.sync-conflict-20260923-120000-ABCDEFG.md', ours);
  t += 1000;
  await store.scanChanges(); await store.flush();
  const after = text(storage, 'Inbox.md');
  assert.deepEqual(ids(storage, 'Inbox.md').sort(), [a.id, b.id, 'othr0001'].sort(), after);
  assert.match(after, new RegExp(`- \\[x\\] Made here first 🆔 ${a.id}`, 'u'), 'still ticked');
  assert.ok(!storage.files.has('Inbox.sync-conflict-20260923-120000-ABCDEFG.md'));
});

test('a copy waits while its file is being edited, then merges', async () => {
  let t = NOW;
  const { storage, store } = await open({ 'Inbox.md': INBOX }, { quietMs: 30000, now: () => t });
  await storage.write('Inbox.md', INBOX + '- [ ] Typed 🆔 type0001\n');
  const copy = 'Inbox.sync-conflict-20260923-120000-ABCDEFG.md';
  await storage.write(copy, INBOX + '- [ ] From elsewhere 🆔 else0001\n');
  t += 1000;
  await store.scanChanges(); await store.flush();
  assert.ok(storage.files.has(copy), 'left where it is for now');
  t += 31000;
  await store.scanChanges(); await store.flush();
  assert.ok(!storage.files.has(copy));
  assert.deepEqual(ids(storage, 'Inbox.md'), ['keep0001', 'type0001', 'else0001']);
});

test('a copy\'s note lines the file already has, as to-dos or longer lines, are not added again', async () => {
  const file = '---\ntype: inbox\n---\n- [ ] Try a standing desk? 🆔 body0001\n    Would it help in the afternoons?\n'
    + '- [ ] is there a way to end every day with a tidy desk? 🆔 mind0001\n'
    + '- [ ] look for a SIMPLE routine for reading the news and books 🆔 medi0001\n';
  const copy = '---\ntype: inbox\n---\n- [ ] Try a standing desk? 🆔 body0001\n    Would it help in the afternoons?\n'
    + '    \\- [ ] is there a way to end every day with a tidy desk?\n'
    + '    \\- [ ] routine for reading the news and books\n'
    + '    A thought only the copy has\n';
  const { storage } = await open({ 'Inbox.md': file, 'Inbox.sync-conflict-20260923-120000-ABCDEFG.md': copy });
  const notes = parse(text(storage, 'Inbox.md'), 'Inbox.md').sections[0].todos[0].notes;
  assert.deepEqual(notes.split('\n').sort(), ['A thought only the copy has', 'Would it help in the afternoons?'], notes);
});

// A note from another tool, 5 October: a tool on the server marks a to-do [/] or
// ticks it, a save from another device wins in Syncthing, and the server's
// version comes back as a conflict copy. [/] was not a to-do then, so the
// copy's line was text the file did not have, and went in beside the to-do.
const SWEEP = '- [/] Font check: confirm every font is free to use 👤 Research 🆔 licsweep ➕ 2026-09-22\n';
const SWEPT = '- [x] Font check of build 42: every font is free to use 👤 Research 🆔 licsweep ➕ 2026-09-22 ✅ 2026-09-23\n';
const lines = (storage, id) => text(storage, 'Inbox.md').split('\n').filter((l) => l.includes(`🆔 ${id}`));

test('a copy that marked a to-do [/] merges into its line, not beside it', async () => {
  const file = INBOX + '- [ ] Check the proofs 👤 Robin 🆔 continu1 ➕ 2026-09-22 📅 2026-09-24\n';
  const copy = INBOX + '- [/] Check the proofs 👤 Robin 🆔 continu1 ➕ 2026-09-22 📅 2026-09-24\n    The full version is ready.\n';
  const { storage } = await open({ 'Inbox.md': file, 'Inbox.sync-conflict-20260923-102155-K4MXQ7B.md': copy });
  assert.deepEqual(lines(storage, 'continu1'), ['- [/] Check the proofs 👤 Robin 🆔 continu1 ➕ 2026-09-22 📅 2026-09-24']);
  assert.match(text(storage, 'Inbox.md'), /continu1.*\n {4}The full version is ready\.\n/u);
});

test('a to-do ticked here, lost to an older save, comes back as its one line, as it was ticked', async () => {
  let t = NOW;
  const { storage, store } = await open({ 'Inbox.md': INBOX + SWEEP }, { now: () => t });
  const before = text(storage, 'Inbox.md');
  const ticked = before.replace(SWEEP, SWEPT);
  await storage.write('Inbox.md', ticked);                       // a tool here ticks it
  t += 1000; await store.scanChanges(); await store.flush();
  // the phone's save, made from the version before, wins; ours is the copy
  await storage.write('Inbox.md', before + '- [ ] Typed on the phone 🆔 phon0001\n');
  await storage.write('Inbox.sync-conflict-20260923-120000-K4MXQ7B.md', ticked);
  t += 1000; await store.scanChanges(); await store.flush();
  assert.deepEqual(lines(storage, 'licsweep'), [SWEPT.trim()]);
  assert.deepEqual(ids(storage, 'Inbox.md'), ['keep0001', 'licsweep', 'phon0001']);
  // and with nothing to go on, a server just started: the same line
  const { storage: fresh } = await open({ 'Inbox.md': before + '- [ ] Typed on the phone 🆔 phon0001\n',
    'Inbox.sync-conflict-20260923-120000-K4MXQ7B.md': ticked });
  assert.deepEqual(lines(fresh, 'licsweep'), [SWEPT.trim()]);
});
