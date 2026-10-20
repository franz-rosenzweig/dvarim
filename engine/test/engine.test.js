// The engine on its own, with nothing else installed: what the parity suites
// prove against the Python, pinned here as plain facts, so a machine without
// the backend (the Mac, a phone's build) still tests the rules it ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Day } from '../src/day.js';
import { sha1 } from '../src/sha1.js';
import { parse, serialize } from '../src/mdformat.js';
import { suggest, parseQuickAdd } from '../src/dates.js';
import { parseRule, nextOccurrence, describe, advance, RuleError } from '../src/repeat.js';
import { Store, sanitizeName, lineId } from '../src/store.js';
import { MemoryStorage } from '../src/storage.js';
import * as views from '../src/views.js';
import { NotFound } from '../src/errors.js';
import { Api } from '../src/api.js';
import { pyList, pyRepr } from '../src/util.js';
import { isUntouchedTutorial } from '../src/tutorial.js';

const D = (s) => Day.fromISO(s);

test('a day is a day: weekdays, month ends, leap years, the clock change', () => {
  assert.equal(D('2026-09-23').weekday(), 2);                 // a Wednesday, Monday = 0
  assert.equal(D('2026-01-31').addDays(29).iso(), '2026-03-01');
  assert.equal(D('2028-02-28').addDays(1).iso(), '2028-02-29');
  assert.equal(D('2026-03-28').addDays(2).iso(), '2026-03-30'); // across Europe's change
  assert.equal(D('2026-11-01').minus(D('2026-10-31')), 1);    // across America's
  assert.throws(() => D('2026-02-30'), RangeError);
});

test('sha1 is the one Python has', () => {
  assert.equal(sha1(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(sha1('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});

test('a file comes back exactly as it was written', () => {
  const text = '---\ntags:\n  - x\ndue:\n---\nNotes **bold**\n\\## not a heading\n\n' +
    '- [ ] Call Dana #work ⏰ 09:30 🆔 aa11bb22 ⏳ 2026-09-23\n    - [ ] item\n\n## Later\n- [x] Done 🆔 bb22cc33 ✅ 2026-09-20\n';
  assert.equal(serialize(parse(text, 'Projects/P.md')), text);
});

test('a CRLF line is still a to-do', () => {
  const f = parse('- [ ] Windows line 🆔 aa11bb22\r\n', 'Inbox.md');
  assert.equal([...f.allTodos()][0].id, 'aa11bb22');
});

test('[/] is an open to-do, as any box is on a line with a 🆔, and each is written back as it was', () => {
  const text = '- [/] Under way 🆔 aa11bb22\n    a note\n- [>] Moved on by another tool 🆔 bb22cc33\n'
    + '- [ ] Plain 🆔 cc33dd44\n    - [/] under a to-do it is a line of notes, as before\n- [>] with no id, still text\n';
  const f = parse(text, 'Inbox.md');
  assert.deepEqual([...f.allTodos()].map((t) => [t.id, t.status, t.mark]),
    [['aa11bb22', 'open', '/'], ['bb22cc33', 'open', '>'], ['cc33dd44', 'open', null]]);
  assert.equal([...f.allTodos()][2].notes, '- [/] under a to-do it is a line of notes, as before');
  assert.deepEqual(f.sections[0].trailing, ['- [>] with no id, still text']);
  assert.equal(serialize(f), text);
  // in a file's own notes, a line that would now be read as a to-do is escaped
  const p = '---\nid: p1\ntype: project\n---\n\\- [/] not a to-do\n\n- [ ] T 🆔 aa11bb22\n';
  assert.equal(parse(p, 'Projects/P.md').notes, '- [/] not a to-do');
  assert.equal(serialize(parse(p, 'Projects/P.md')), p);
});

test('[/] stays [/] as the to-do is edited, and is [x] once ticked and [ ] if reopened', async () => {
  const { storage, store } = await vault({ 'Inbox.md': '- [/] Under way 🆔 aa11bb22\n' });
  store.updateTodo('aa11bb22', { title: 'Still under way', when: '2026-09-24' });
  await store.flush();
  assert.equal(storage.snapshot()['Inbox.md'], '- [/] Still under way 🆔 aa11bb22 ⏳ 2026-09-24\n');
  store.completeTodo('aa11bb22');
  await store.flush();
  assert.equal(storage.snapshot()['Inbox.md'], '- [x] Still under way 🆔 aa11bb22 ⏳ 2026-09-24 ✅ 2026-09-23\n');
  store.reopenTodo('aa11bb22');
  await store.flush();
  assert.equal(storage.snapshot()['Inbox.md'], '- [ ] Still under way 🆔 aa11bb22 ⏳ 2026-09-24\n');
});

test('dates read naturally', () => {
  const today = D('2026-09-23');
  assert.deepEqual(suggest('tom', today).map((s) => s.when), ['2026-09-24']);
  const q = parseQuickAdd('Call the plumber tomorrow 3pm #home !fri', today);
  assert.deepEqual([q.title, q.when, q.reminder, q.deadline, q.tags], ['Call the plumber', '2026-09-24', '15:00', '2026-09-25', ['home']]);
});

test('repeats: the next date, the sentence, and what cannot be one', () => {
  const r = parseRule('every 2 weeks on mon and thu');
  assert.equal(describe(r), 'every 2 weeks on Monday, Thursday');
  assert.equal(nextOccurrence(r, D('2026-09-23'), D('2026-09-23')).iso(), '2026-09-24');
  assert.equal(nextOccurrence(parseRule('every year on February 30'), D('2026-01-01'), D('2026-01-01')), null);
  assert.deepEqual(advance('every month when done', '2026-09-01', null, D('2026-09-23')), ['2026-10-23', null]);
  for (const bad of ['every 0 days', 'every month on the 0th', 'every month on the 6th Tuesday', 'daily']) {
    assert.throws(() => parseRule(bad), RuleError, bad);
  }
});

test('names fit on a disk', () => {
  assert.equal(sanitizeName('a/b: c?'), 'a-b- c-');
  const long = sanitizeName('א'.repeat(100));
  assert.ok(new TextEncoder().encode(long).length <= 120 && long.endsWith('…'));
});

async function vault(files = {}) {
  const storage = new MemoryStorage(files);
  let n = 0;
  const store = await Store.open(storage, {
    today: () => D('2026-09-23'),
    newId: (p = '') => p + String(++n).padStart(8 - p.length, '0'),
  });
  return { storage, store };
}

test('a new vault has its lists', async () => {
  const { storage, store } = await vault();
  await store.flush();
  assert.deepEqual(Object.keys(storage.snapshot()).sort(), ['Inbox.md', 'Standalone.md', 'Trash.md']);
  assert.deepEqual(views.state(store).counts, { inbox: 0, today: 0, todayDeadlines: 0 });
});

test('a to-do goes into the file, and a repeat makes the next one', async () => {
  const { storage, store } = await vault();
  const t = store.createTodo({ title: 'Water plants', inbox: true, when: '2026-09-23', repeat: 'every 3 days' });
  assert.equal(views.listToday(store).items[0].id, t.id);
  const done = store.completeTodo(t.id);
  assert.equal(done.next.when, '2026-09-26');
  await store.flush();
  assert.match(storage.snapshot()['Inbox.md'], /- \[x\] Water plants 🆔 00000001 🔁 every 3 days ➕ 2026-09-23 ⏳ 2026-09-23 ✅ 2026-09-23/u);
});

test('projects, headings and areas are files and folders', async () => {
  const { storage, store } = await vault();
  const a = store.createArea({ name: 'Work' });
  const p = store.createProject({ name: 'Launch', areaId: a.id });
  store.addHeading(p.id, 'Planning');
  store.createTodo({ title: 'Book venue', projectId: p.id, headingId: `${p.id}:Planning` });
  await store.flush();
  const snap = storage.snapshot();
  assert.ok(snap['Areas/Work/Work.md'].includes('type: area'));
  assert.ok(snap['Areas/Work/Launch.md'].includes('## Planning\n- [ ] Book venue'));
  assert.equal(views.areaDetail(store, a.id).area.projects[0].name, 'Launch');
});

test('a line typed in Obsidian is noticed, and keeps its place until it has an id', async () => {
  const { storage, store } = await vault({ 'Inbox.md': '- [ ] From before 🆔 aa11bb22\n' });
  await storage.write('Inbox.md', '- [ ] From before 🆔 aa11bb22\n- [ ] Typed in Obsidian\n');
  assert.deepEqual(await store.scanChanges(), ['Inbox.md']);
  const typed = views.listInbox(store).items[1];
  assert.equal(typed.title, 'Typed in Obsidian');
  assert.ok(typed.id.startsWith('tmp'));                      // not written yet: the file is left alone
});

test('a box ticked in Obsidian is dated here, and that write gives new lines their ids', async () => {
  const { storage, store } = await vault({ 'Inbox.md': '- [ ] From before 🆔 aa11bb22\n' });
  await storage.write('Inbox.md', '- [x] From before 🆔 aa11bb22\n- [ ] Typed in Obsidian\n');
  await store.scanChanges();
  assert.equal(store.getTodo('aa11bb22')[2].completed, '2026-09-23');
  await store.flush();
  // the id is made from the line, as the server makes it (store.py, line_id)
  const typed = lineId(`tmp${sha1('Inbox.md|None|Typed in Obsidian|1').slice(0, 9)}`, new Set(['aa11bb22']));
  assert.equal(storage.snapshot()['Inbox.md'],
    `- [x] From before 🆔 aa11bb22 ✅ 2026-09-23\n- [ ] Typed in Obsidian 🆔 ${typed}\n`);
});

test('a line typed elsewhere gets the same id on every device', async () => {
  const text = '- [ ] Already here 🆔 aa11bb22\n- [ ] Typed in Obsidian\n- [ ] Typed in Obsidian\n';
  const ids = [];
  for (let device = 0; device < 3; device++) {
    const { store } = await vault({ 'Inbox.md': text });
    store._write(store.files.get('Inbox.md'));
    ids.push([...store.files.get('Inbox.md').allTodos()].map((t) => t.id));
  }
  assert.deepEqual(ids[0], ids[1]);
  assert.deepEqual(ids[1], ids[2]);
  assert.notEqual(ids[0][1], ids[0][2]);
  assert.match(ids[0][1], /^[0-9a-z]{8}$/u);
});

test('a scan that was reading while the store wrote does not put back what it read', async () => {
  // Reading the folder takes a while, and the store goes on answering: a to-do
  // made then — and a project, in a file of its own — must come out of the
  // scan still there, and stay in the files. Put back, the next change to
  // Inbox.md wrote the old one over the new.
  const { storage, store } = await vault({ 'Inbox.md': '- [ ] From before 🆔 aa11bb22\n' });
  await store.flush();
  let reached, release;
  const reading = new Promise((r) => { reached = r; });
  const held = new Promise((r) => { release = r; });
  const readMany = storage.readMany.bind(storage);
  let first = true;
  storage.readMany = async (paths) => {
    const r = await readMany(paths);
    if (first) { first = false; reached(); await held; }
    return r;
  };
  const scanning = store.scanChanges();
  await reading;
  const t = store.createTodo({ title: 'Made meanwhile', inbox: true });
  const p = store.createProject({ name: 'Begun meanwhile' });
  release();
  await scanning;
  assert.equal(store.getTodo(t.id)[2].title, 'Made meanwhile');
  assert.equal(store.getFileById(p.id).frontmatter.id, p.id);
  store.completeTodo(t.id);
  await store.flush();
  const snap = storage.snapshot();
  assert.match(snap['Inbox.md'], /- \[ \] From before/);
  assert.match(snap['Inbox.md'], /- \[x\] Made meanwhile/);
  assert.ok(Object.keys(snap).some((f) => f.endsWith('Begun meanwhile.md')), Object.keys(snap).join(', '));
});

test('what is not there says so', async () => {
  const { store } = await vault();
  assert.throws(() => store.completeTodo('zzzzzzzz'), NotFound);
});

test('messages quote values the way Python prints them', () => {
  assert.equal(pyRepr('every blue moon'), "'every blue moon'");
  assert.equal(pyRepr("it's"), `"it's"`);
  assert.equal(pyRepr(`it's "x"`), `'it\\'s "x"'`);
  assert.equal(pyRepr('tab\there\nשלום‏'), "'tab\\there\\nשלום\\u200f'");
  assert.equal(pyRepr(['a', 1, null, true, { k: 'v' }]), "['a', 1, None, True, {'k': 'v'}]");
  assert.throws(() => parseRule('every blue moon'), { message: "cannot parse repeat rule 'every blue moon'" });
});

test('a value sent in the wrong shape is read as Python reads it', () => {
  assert.deepEqual(pyList('work'), ['w', 'o', 'r', 'k']);
  assert.deepEqual(pyList({ a: 1, b: 2 }), ['a', 'b']);
  assert.throws(() => pyList(null), TypeError);
});

test('the API answers as the server does: status, body and errors', async () => {
  const { storage, store } = await vault();
  const api = new Api(store);
  assert.deepEqual(await api.handle('GET', '/api/auth'), { status: 200, body: { required: false, authenticated: true } });
  const made = await api.handle('POST', '/api/quick-add', { text: 'Call Dana tomorrow 3pm #work', list: 'inbox' });
  assert.equal(made.status, 200);
  assert.deepEqual([made.body.when, made.body.reminder, made.body.tags, made.body.inbox], ['2026-09-24', '15:00', ['work'], false]);
  assert.deepEqual(await api.handle('POST', '/api/todos/nope/complete', {}), { status: 404, body: { error: "not found: 'nope'" } });
  assert.deepEqual(await api.handle('POST', '/api/quick-add', { text: '  ' }), { status: 400, body: { error: 'empty title' } });
  assert.equal((await api.handle('POST', '/api/parse-repeat', { repeat: 'every 0 days' })).body.ok, false);
  assert.equal((await api.handle('GET', '/api/file?path=.dvarim/x.md')).status, 400);
  const file = await api.handle('GET', '/api/file?path=Inbox.md');
  const stale = await api.handle('PUT', '/api/file?path=Inbox.md', { text: 'x', sha: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.text, file.body.text);                  // the current text comes back, nothing written
  const saved = await api.handle('PUT', '/api/file?path=Inbox.md', { text: '- [ ] Typed in the source editor', sha: file.body.sha });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.todos, 1);
  await store.flush();
  // saved as sent, with the newline it lacked; the line gets its id at the file's next write
  assert.equal(storage.snapshot()['Inbox.md'], '- [ ] Typed in the source editor\n');
  let heard = null;
  const stop = api.subscribe((paths) => { heard = paths; });
  await api.handle('POST', '/api/todos', { title: 'Heard', inbox: true });
  assert.deepEqual(heard, ['Inbox.md']);
  stop();
});

test('a setting changed, or an area folded, is heard like any other change: a copy\'s sync waits for it', async () => {
  const store = await Store.open(new MemoryStorage({ 'Inbox.md': '' }), { today: () => D('2026-09-23') });
  const api = new Api(store);
  let heard = 0;
  const stop = api.subscribe(() => { heard += 1; });
  await api.handle('PUT', '/api/settings', { logCompleted: 'daily' });
  assert.equal(heard, 1, 'a setting');
  await api.handle('PUT', '/api/view-state', { collapsed: ['aper0001'] });
  assert.equal(heard, 2, 'an area folded');
  await api.handle('POST', '/api/logbook/log-now', {});
  assert.equal(heard, 3, 'logged now: once');
  stop();
});

test('a new vault starts with "Meet Dvarim", one with notes does not, and Settings makes it again', async () => {
  let n = 0;
  const opts = { today: () => D('2026-09-23'), newId: (p = '') => p + String(++n).padStart(8 - p.length, '0'), tutorial: true };
  const fresh = new MemoryStorage({});
  const store = await Store.open(fresh, opts);
  await store.flush();
  assert.ok(isUntouchedTutorial(fresh.snapshot()['Projects/Meet Dvarim.md']));
  assert.deepEqual(store.projects().map((f) => f.name), ['Meet Dvarim']);
  assert.equal(store.getTodo('meetdv01')[2].status, 'done', 'the first one comes ticked');
  const old = await Store.open(new MemoryStorage({ 'Inbox.md': '- [ ] Here before 🆔 aa11bb22\n' }), opts);
  assert.deepEqual(old.projects(), [], 'a vault with notes is nobody\'s first look');
  // made again: while it is open, the one there is
  assert.equal(store.addTutorial().id, 'pmeetdvr');
  store.completeProject('pmeetdvr', true);
  const again = store.addTutorial();
  assert.notEqual(again.id, 'pmeetdvr');
  assert.ok(again.name.startsWith('Meet Dvarim'));
  const ids = [...store._file(store.fileIndex.get(again.id)).allTodos()].map((t) => t.id);
  assert.equal(ids.length, 13);
  assert.ok(!ids.some((id) => id.startsWith('meetdv')), 'ids of its own, not the first one\'s');
  // touched, it is not the untouched one any more
  await store.flush();
  assert.ok(!isUntouchedTutorial(fresh.snapshot()['Projects/Meet Dvarim.md']));
});

test('Today\'s own headings: in state.json, to-dos filed under them, the rest above them', async () => {
  const { storage, store } = await vault();
  const make = (title) => store.createTodo({ title, when: '2026-09-23' });
  const a = make('Answer Dana'), b = make('Buy stamps'), c = make('Call the bank');
  assert.equal(views.listToday(store).headings, undefined, 'none until one is made');
  const errands = store.addTodayHeading({ name: '  Errands ' });
  const morning = store.addTodayHeading({ name: 'Morning', position: 'top' });
  assert.equal(errands.name, 'Errands');
  const between = store.addTodayHeading({ name: 'Between', position: { after: morning.id } });
  assert.deepEqual(store.todayHeadings().map((h) => h.name), ['Morning', 'Between', 'Errands']);
  store.deleteTodayHeading(between.id);
  store.fileInToday([b.id, c.id], errands.id);
  store.fileInToday([c.id], morning.id);                      // under one heading at a time
  assert.deepEqual(views.listToday(store).headings.map((h) => [h.name, h.todos]), [['Morning', [c.id]], ['Errands', [b.id]]]);
  // the headings reordered and one renamed; a to-do new to Today is under none
  store.reorder('today-headings', [errands.id]);
  store.updateTodayHeading(morning.id, { name: 'First thing' });
  const d = make('New today');
  let today = views.listToday(store);
  assert.deepEqual(today.headings.map((h) => h.name), ['Errands', 'First thing']);
  assert.ok(!today.headings.some((h) => h.todos.includes(d.id)));
  // ticked by mistake and unticked: still under it. Done, it is let go when the headings next change
  store.completeTodo(b.id);
  store.reopenTodo(b.id);
  assert.deepEqual(views.listToday(store).headings[0].todos, [b.id]);
  store.completeTodo(b.id);
  store.fileInToday([d.id], errands.id);
  assert.deepEqual(store.todayHeadings()[0].todos, [d.id]);
  // a heading deleted leaves its to-dos in Today
  store.deleteTodayHeading(morning.id);
  today = views.listToday(store);
  assert.ok(today.items.some((t) => t.id === c.id));
  assert.deepEqual(today.headings.map((h) => h.id), [errands.id]);
  assert.throws(() => store.fileInToday([a.id], 'hnothere'), NotFound);
  // all of it in state.json, none of it in a note
  await store.flush();
  const snap = storage.snapshot();
  assert.deepEqual(JSON.parse(snap['.dvarim/state.json']).todayHeadings, [{ id: errands.id, name: 'Errands', todos: [d.id] }]);
  assert.ok(!Object.entries(snap).some(([p, t]) => p.endsWith('.md') && t.includes('Errands')));
});

test('Today\'s own headings over the API, as the app and its outbox use them', async () => {
  const { store } = await vault();
  const api = new Api(store);
  const t = (await api.handle('POST', '/api/todos', { title: 'Post the letter', when: '2026-09-23' })).body;
  const h = await api.handle('POST', '/api/today/headings', { name: 'Errands', id: 'herrand1' });
  assert.deepEqual(h, { status: 200, body: { id: 'herrand1', name: 'Errands', todos: [] } });
  // the outbox sends it again when it is unsure the first one arrived: still one
  await api.handle('POST', '/api/today/headings', { name: 'Errands', id: 'herrand1' });
  assert.equal(store.todayHeadings().length, 1);
  assert.equal((await api.handle('POST', '/api/today/headings', { id: 'not-an-id' })).status, 400);
  await api.handle('POST', '/api/today/file', { ids: [t.id], headingId: 'herrand1' });
  assert.deepEqual((await api.handle('GET', '/api/lists/today')).body.headings, [{ id: 'herrand1', name: 'Errands', todos: [t.id] }]);
  assert.equal((await api.handle('PATCH', '/api/today/headings/herrand1', { name: 'Out and about' })).body.name, 'Out and about');
  await api.handle('POST', '/api/today/file', { ids: [t.id], headingId: null });
  assert.deepEqual(store.todayHeadings()[0].todos, []);
  assert.equal((await api.handle('POST', '/api/today/file', { ids: [t.id], headingId: 'hnothere' })).status, 404);
  assert.deepEqual(await api.handle('DELETE', '/api/today/headings/herrand1'), { status: 200, body: { ok: true } });
  assert.equal((await api.handle('DELETE', '/api/today/headings/herrand1')).status, 404);
  assert.equal((await api.handle('GET', '/api/lists/today')).body.headings, undefined);
});

test('the same id twice: the copy gets one of its own, alike on every device, written once the file is quiet', async () => {
  // A project copied in Obsidian, or renamed on one device while another
  // edited it (the sync keeps both); a to-do in a project and, from before, in
  // Trash; a line pasted twice. The page draws its lists by id and drew none of
  // the page for a project that was there twice; and the index kept whichever
  // file it read last, so an edit could land on the copy in Trash.
  const project = (extra = '') => `---\nid: pdup00001\ntype: project\nstatus: open\n---\n- [ ] Shared step 🆔 st0001aa\n${extra}`;
  const files = {
    'Areas/Work/Work.md': '---\nid: awork0001\ntype: area\n---\n',
    'Areas/Work/Routine Review.md': project(),
    'Areas/Work/Routine.md': project('- [ ] Only in the old one 🆔 st0002aa\n'),
    'Trash/Old taxes.md': '---\nid: ptax00001\ntype: project\nstatus: open\n---\n- [ ] Live and trashed 🆔 lt0001aa\n',
    'Standalone.md': '- [ ] Live and trashed 🆔 lt0001aa\n- [ ] Pasted twice 🆔 pt0001aa\n- [ ] Pasted twice 🆔 pt0001aa\n',
  };
  const a = await vault(files), b = await vault(files);
  const projects = (s) => [...s.store.files.values()].filter((f) => f.kind === 'project').map((f) => [f.path, f.frontmatter.id]).sort();
  const todos = (s) => [...s.store.files.values()].flatMap((f) => [...f.allTodos()].map((t) => [f.path, t.title, t.id])).sort();
  assert.equal(new Set(projects(a).map(([, id]) => id)).size, projects(a).length, 'every project an id of its own');
  assert.equal(new Set(todos(a).map(([, , id]) => id)).size, todos(a).length, 'every to-do an id of its own');
  assert.equal(a.store.getFileById('pdup00001').path, 'Areas/Work/Routine Review.md', 'the first path keeps the id');
  assert.equal(a.store.getTodo('st0001aa')[0].path, 'Areas/Work/Routine Review.md');
  assert.equal(a.store.getTodo('lt0001aa')[0].path, 'Standalone.md', 'a live file keeps it over Trash');
  assert.deepEqual(projects(b), projects(a), 'two devices repair alike');
  assert.deepEqual(todos(b), todos(a));
  // edits land on the one that is seen
  a.store.completeTodo('lt0001aa');
  await a.store.flush();
  assert.match((await a.storage.read('Standalone.md')).text, /- \[x\] Live and trashed 🆔 lt0001aa/u);
  assert.match((await a.storage.read('Trash/Old taxes.md')).text, /- \[ \] Live and trashed/u);
  // nothing else written yet: a file being typed into in Obsidian is left alone
  assert.match((await a.storage.read('Areas/Work/Routine.md')).text, /id: pdup00001/u);
  // once the files are quiet, the repair is written, and settles
  a.store.normalizeQuietFiles(0);
  await a.store.flush();
  assert.doesNotMatch((await a.storage.read('Areas/Work/Routine.md')).text, /pdup00001|st0001aa/u);
  const again = await Store.open(a.storage, { today: () => D('2026-09-23') });
  assert.deepEqual([...again.files.values()].filter((f) => f.kind === 'project').map((f) => [f.path, f.frontmatter.id]).sort(), projects(a));
  assert.equal(again._repaired.size, 0, 'nothing left to repair');
});

test('a copy given an id of its own keeps the one it had if its double goes before the new one is written', async () => {
  // A to-do moved on one device is, for a while, in both files on another:
  // the old file's copy comes before the sync takes it away. The new id waits
  // to be written; with the double gone, it is not needed, and never written.
  const step = (id) => `---\ntype: project\nstatus: open\n---\n- [ ] Moved step 🆔 ${id}\n`;
  const { storage, store } = await vault({ 'Projects/Before.md': step('mv0001aa'), 'Projects/After.md': step('mv0001aa') });
  await store.flush();                             // the ids and dates it gives the two notes, first
  assert.equal(store.getTodo('mv0001aa')[0].path, 'Projects/After.md', 'the first path keeps it');
  const entry = store.syncLog.find((e) => e.kind === 'ids already held elsewhere given new ones');
  assert.deepEqual(Object.keys(entry.ids), ['mv0001aa'], 'the log says which ids were given new ones');
  const given = entry.ids.mv0001aa;
  assert.equal(store.getTodo(given)[0].path, 'Projects/Before.md');
  // the sync takes it out of After.md
  await storage.write('Projects/After.md', (await storage.read('Projects/After.md')).text.replace(/- \[ \] Moved step.*\n/u, ''));
  await store.scanChanges(); await store.flush();
  assert.equal(store.getTodo('mv0001aa')[0].path, 'Projects/Before.md', 'the one copy left has the id it had');
  assert.throws(() => store.getTodo(given), NotFound);
  assert.equal(store._repaired.size, 0, 'nothing left to write');
  // written for another reason, it keeps it
  store.createTodo({ title: 'Another', projectId: store.getTodo('mv0001aa')[0].frontmatter.id });
  await store.flush();
  assert.match((await storage.read('Projects/Before.md')).text, /Moved step 🆔 mv0001aa/u);
});

test('of two copies of a to-do, the one ticked keeps the id: a tick in the old place is not lost to a move', async () => {
  // moved on one device to After.md, ticked on another where it was
  const files = {
    'Projects/After.md': '---\ntype: project\nstatus: open\n---\n- [ ] Moved step 🆔 mv0001aa\n',
    'Projects/Before.md': '---\ntype: project\nstatus: open\n---\n- [x] Moved step 🆔 mv0001aa ✅ 2026-09-23\n',
  };
  const a = await vault(files), b = await vault(files);
  for (const { store } of [a, b]) {
    const [f, , t] = store.getTodo('mv0001aa');
    assert.equal(f.path, 'Projects/Before.md');
    assert.equal(t.status, 'done');
  }
  const ids = (s) => [...s.store.files.values()].flatMap((f) => [...f.allTodos()].map((t) => [f.path, t.id])).sort();
  assert.deepEqual(ids(b), ids(a), 'two devices repair alike');
});
