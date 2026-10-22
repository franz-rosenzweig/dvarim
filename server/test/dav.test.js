// The server's folder over WebDAV (src/dav.js) and the built-in sync that uses
// it (engine/src/webdav.js), over real HTTP: who may in, what is offered, that
// a write lands only on the version it was made from, and devices that each
// keep a vault of their own staying in step through the server — with the
// server's own app, and Obsidian on its folder, changing things too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from './fixture.js';
import { Auth } from '../src/auth.js';
import { Store } from '../../engine/src/store.js';
import { MemoryStorage } from '../../engine/src/storage.js';
import { WebDavSync } from '../../engine/src/webdav.js';
import { BridgeStorage } from '../../engine/src/storage-bridge.js';
import { Day } from '../../engine/src/day.js';
import { parse } from '../../engine/src/mdformat.js';

const PW = 'correct horse battery';

async function server(t) {
  const s = await serve({ password: PW }, {}, t);
  const token = s.app.auth.addToken('test device');
  const bearer = { Authorization: `Bearer ${token}` };
  const dav = (method, path, { headers = {}, raw } = {}) => s.call(method, '/dav/' + path, { headers: { ...bearer, ...headers }, raw });
  const api = (method, path, body) => s.call(method, '/api' + path, { headers: bearer, body });
  return { ...s, token, bearer, dav, api, url: `${s.base}/dav/` };
}

async function login(s) {
  const r = await s.call('POST', '/api/login', { body: { password: PW } });
  return r.headers.get('set-cookie').split(';')[0];
}

const hrefs = (xml) => [...xml.matchAll(/<d:href>([^<]*)<\/d:href>/gu)].map((m) => decodeURIComponent(m[1]));

test('WebDAV takes a token, as a bearer or as Basic auth\'s password; never the password; a preflight needs nothing', async (t) => {
  const s = await server(t);
  const pre = await s.call('OPTIONS', '/dav/', { headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'PROPFIND' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/u);
  assert.match(pre.headers.get('access-control-allow-methods'), /PROPFIND/u);

  const none = await s.call('PROPFIND', '/dav/', { headers: { Depth: '1' } });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /^Basic /u);
  const basic = (user, pass) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, Depth: '1' });
  assert.equal((await s.call('PROPFIND', '/dav/', { headers: basic('sam', PW) })).status, 401, 'the password is not a token');
  assert.equal((await s.call('PROPFIND', '/dav/', { headers: basic('anyone', s.token) })).status, 207);
  assert.equal((await s.dav('PROPFIND', '', { headers: { Depth: '1' } })).status, 207);

  // this site's own pages may use their cookie; a page elsewhere may not
  const cookie = await login(s);
  assert.equal((await s.call('PROPFIND', '/dav/', { headers: { Cookie: cookie, Depth: '1' } })).status, 207);
  assert.equal((await s.call('PROPFIND', '/dav/', { headers: { Cookie: cookie, Depth: '1', Origin: 'https://elsewhere.example' } })).status, 401);
});

test('only the notes and the two state files are offered: never auth.json, the app\'s own files or anything else', async (t) => {
  const s = await server(t);
  mkdirSync(join(s.root, 'Areas', 'Home'), { recursive: true });
  writeFileSync(join(s.root, 'Areas', 'Home', 'Home.md'), '---\ntype: area\nid: ahome001\n---\n');
  mkdirSync(join(s.root, '.obsidian'), { recursive: true });
  mkdirSync(join(s.root, '.dvarim'), { recursive: true });
  writeFileSync(join(s.root, '.obsidian', 'workspace.md'), 'not a note');
  writeFileSync(join(s.root, '.dvarim', 'auth.json'), '{"password":"a decoy"}');
  writeFileSync(join(s.root, '.dvarim', 'vtodo.json'), '{}');
  writeFileSync(join(s.root, 'picture.png'), 'png');
  await s.api('PUT', '/settings', { weekStartsOn: 1 });

  const all = await s.dav('PROPFIND', '', { headers: { Depth: 'infinity' } });
  assert.equal(all.status, 207);
  const listed = hrefs(all.text);
  for (const want of ['/dav/', '/dav/Inbox.md', '/dav/Areas/', '/dav/Areas/Home/Home.md', '/dav/.dvarim/', '/dav/.dvarim/state.json', '/dav/.dvarim/stamps.json']) {
    assert.ok(listed.includes(want), `${want} is listed`);
  }
  for (const not of ['auth.json', 'vtodo.json', '.obsidian', 'picture.png']) assert.ok(!listed.some((h) => h.includes(not)), `${not} is not listed`);
  const one = hrefs((await s.dav('PROPFIND', 'Areas', { headers: { Depth: '1' } })).text);
  assert.deepEqual(one, ['/dav/Areas/', '/dav/Areas/Home/']);

  assert.equal((await s.dav('GET', '.dvarim/auth.json')).status, 404);
  assert.equal((await s.dav('GET', '.dvarim/vtodo.json')).status, 404);
  assert.equal((await s.dav('GET', '..%2Fauth.json')).status, 400);
  assert.equal((await s.dav('PUT', '.dvarim/auth.json', { raw: '{}' })).status, 403);
  assert.equal((await s.dav('PUT', '.obsidian/x.md', { raw: 'x' })).status, 403);
  assert.equal((await s.dav('PUT', 'notes.txt', { raw: 'x' })).status, 403);
  assert.equal(readFileSync(join(s.root, '.dvarim', 'auth.json'), 'utf8'), '{"password":"a decoy"}');
});

test('a write lands only on the version it was made from, and the app sees it at once', async (t) => {
  const s = await server(t);
  const got = await s.dav('GET', 'Inbox.md');
  assert.equal(got.status, 200);
  const etag = got.headers.get('etag');
  const next = got.text + '- [ ] Sent over WebDAV 🆔 dav00001\n';
  assert.equal((await s.dav('PUT', 'Inbox.md', { raw: next, headers: { 'If-Match': '"not it"' } })).status, 412);
  assert.equal((await s.dav('PUT', 'Inbox.md', { raw: next, headers: { 'If-None-Match': '*' } })).status, 412);
  const put = await s.dav('PUT', 'Inbox.md', { raw: next, headers: { 'If-Match': etag } });
  assert.equal(put.status, 204);
  assert.ok(put.headers.get('etag'));
  assert.ok((await s.api('GET', '/lists/inbox')).text.includes('Sent over WebDAV'), 'in the app at once');
  assert.equal(readFileSync(join(s.root, 'Inbox.md'), 'utf8'), next, 'and on disk');

  // a new project, where there was none
  const made = await s.dav('PUT', 'Projects/From a phone.md', { raw: '---\ntype: project\nid: pdav0001\nstatus: open\ncreated: 2026-09-23\n---\n', headers: { 'If-None-Match': '*' } });
  assert.equal(made.status, 201);
  assert.ok((await s.api('GET', '/state')).text.includes('From a phone'));

  // a project with no id is given one here: then the answer claims no etag,
  // as what is kept is not what was sent
  const bare = await s.dav('PUT', 'Projects/Bare.md', { raw: '---\ntype: project\n---\n', headers: { 'If-None-Match': '*' } });
  assert.equal(bare.status, 201);
  assert.equal(bare.headers.get('etag'), null);
  assert.match((await s.dav('GET', 'Projects/Bare.md')).text, /^id: p\S+$/mu);

  // deleting, likewise
  const p = await s.dav('GET', 'Projects/From a phone.md');
  assert.equal((await s.dav('DELETE', 'Projects/From a phone.md', { headers: { 'If-Match': '"stale"' } })).status, 412);
  assert.equal((await s.dav('DELETE', 'Projects/From a phone.md', { headers: { 'If-Match': p.headers.get('etag') } })).status, 204);
  assert.ok(!existsSync(join(s.root, 'Projects', 'From a phone.md')));
  assert.equal((await s.dav('DELETE', '.dvarim/state.json')).status, 403);
});

test('a token made on the command line works at once, and one revoked stops working at once', async (t) => {
  const s = await server(t);
  const cli = Auth.load(s.root, s.authFile);
  const token = cli.addToken('made on the command line');
  assert.equal((await s.call('PROPFIND', '/dav/', { headers: { Authorization: `Bearer ${token}`, Depth: '0' } })).status, 207);
  cli.removeToken('made on the command line');
  assert.equal((await s.call('PROPFIND', '/dav/', { headers: { Authorization: `Bearer ${token}`, Depth: '0' } })).status, 401);
});

test('devices are added and removed only by someone signed in with the password', async (t) => {
  const s = await server(t);
  assert.equal((await s.api('POST', '/tokens', { name: 'Phone' })).status, 403, 'a token cannot make another');
  const cookie = await login(s);
  const as = (method, path, body) => s.call(method, '/api' + path, { headers: { Cookie: cookie }, body });
  const made = await as('POST', '/tokens', { name: 'Phone' });
  assert.equal(made.status, 200);
  assert.match(made.json.token, /^dvt_/u);
  assert.deepEqual((await as('GET', '/tokens')).json.tokens.map((x) => x.name), ['Phone', 'test device']);
  assert.ok(!(await as('GET', '/tokens')).text.includes('hash'), 'no hashes handed out');
  assert.equal((await as('POST', '/tokens', { name: 'Phone' })).status, 409);
  assert.equal((await as('POST', '/tokens', { name: '' })).status, 400);
  assert.equal((await s.call('PROPFIND', '/dav/', { headers: { Authorization: `Bearer ${made.json.token}`, Depth: '0' } })).status, 207);
  assert.deepEqual((await as('DELETE', '/tokens/Phone')).json, { removed: true });
  assert.equal((await s.call('PROPFIND', '/dav/', { headers: { Authorization: `Bearer ${made.json.token}`, Depth: '0' } })).status, 401);
});

// ---- devices with vaults of their own, in step through the server

const TODAY = Day.fromISO('2026-09-23');

async function device(name, s) {
  const storage = new MemoryStorage({});
  let n = 0;
  const store = await Store.open(storage, {
    today: () => TODAY,
    newId: (p = '') => p + `${name}${(++n).toString(36)}`.padStart(8 - p.length, '0'),
  });
  return { name, storage, store, sync: new WebDavSync(store, { url: s.url, token: s.token }) };
}

/** Every id the repair gave a copy of its own (store.js, _repairIds), from
 *  here on: the store keeps the last fifty of what it did, this all of it. */
function renames(store) {
  const out = [];
  const log = store._logSync.bind(store);
  store._logSync = (e) => { if (e.ids) out.push(...Object.entries(e.ids)); log(e); };
  return out;
}

/** Every note as a device (or the server) has it. */
async function notes(store) {
  const all = await store.syncTexts();
  return Object.fromEntries([...all].filter(([p]) => p.endsWith('.md')).sort());
}

const titles = (store, path = 'Inbox.md') => [...store._file(path).allTodos()].map((x) => x.title);

test('two devices and the server stay in step: made, changed on all three at once, deleted, edited in Obsidian', async (t) => {
  const s = await server(t);
  const srv = s.app.store;
  const A = await device('a', s), B = await device('b', s);

  const x = srv.createTodo({ title: 'Made on the server', inbox: true });
  await srv.flush();
  await A.sync.sync();
  assert.deepEqual(titles(A.store), ['Made on the server']);
  const y = A.store.createTodo({ title: 'Made on A', inbox: true });
  const r = await A.sync.sync();
  assert.deepEqual(r.sent, ['Inbox.md']);
  assert.deepEqual(titles(srv), ['Made on the server', 'Made on A']);
  await B.sync.sync();
  assert.deepEqual(titles(B.store), ['Made on the server', 'Made on A']);

  // all three change the same file at once
  A.store.completeTodo(x.id);
  B.store.updateTodo(y.id, { title: 'Made on A, renamed on B' });
  const z = srv.createTodo({ title: 'Also made on the server', inbox: true });
  await srv.flush();
  const ra = await A.sync.sync();
  assert.deepEqual(ra.merged, ['Inbox.md'], 'A merged the server\'s change with its own');
  await B.sync.sync();
  await A.sync.sync();
  for (const st of [A.store, B.store, srv]) {
    const todos = [...st._file('Inbox.md').allTodos()];
    assert.equal(todos.find((q) => q.id === x.id).status, 'done');
    assert.equal(todos.find((q) => q.id === y.id).title, 'Made on A, renamed on B');
    assert.ok(todos.some((q) => q.id === z.id));
  }

  // deleted on B: gone everywhere, and in Trash everywhere
  B.store.deleteTodo(z.id);
  await B.sync.sync();
  await A.sync.sync();
  assert.ok(!A.store._file('Inbox.md').find(z.id));
  assert.ok(A.store._file('Trash.md').find(z.id));
  assert.ok(!srv._file('Inbox.md').find(z.id));

  // a whole file: a project deleted on A goes to Trash on B too
  const proj = A.store.createProject({ title: 'Short-lived' });
  await A.sync.sync();
  await B.sync.sync();
  assert.ok(B.store.fileIndex.has(proj.id));
  const before = B.store.fileIndex.get(proj.id);
  A.store.deleteProject(proj.id);
  await A.sync.sync();
  await B.sync.sync();
  assert.ok(!B.store.files.has(before), 'gone from where it was');
  assert.equal(B.store.fileIndex.get(proj.id), A.store.fileIndex.get(proj.id), 'and where A put it');

  // a new order only, made on the server, reaches the devices too
  const order = [...srv._file('Inbox.md').allTodos()].map((q) => q.id).reverse();
  srv.reorder('inbox', order);
  await srv.flush();
  await A.sync.sync();
  assert.equal(A.storage.files.get('Inbox.md').text, readFileSync(join(s.root, 'Inbox.md'), 'utf8'), 'the order is the change');

  // Obsidian on the server's folder
  const disk = join(s.root, 'Inbox.md');
  writeFileSync(disk, readFileSync(disk, 'utf8') + '- [ ] Typed in Obsidian on the server 🆔 obsd0001\n');
  await A.sync.sync();
  assert.ok(A.store._file('Inbox.md').find('obsd0001'));

  // settings travel too, by their stamps
  A.store.putSettings({ weekStartsOn: 1 });
  await A.sync.sync();
  await B.sync.sync();
  assert.equal(B.store.getSettings().weekStartsOn, 1);
  assert.equal(srv.getSettings().weekStartsOn, 1);

  await B.sync.sync();
  await A.sync.sync();
  assert.deepEqual(await notes(A.store), await notes(B.store));
  assert.deepEqual(await notes(A.store), await notes(srv));
  const quiet = await A.sync.sync();
  assert.deepEqual([quiet.sent, quiet.taken, quiet.merged, quiet.deleted], [[], [], [], []], 'a round with nothing to do does nothing');
});

test('deleted on a device while the server changed the same file: merged against what both had, so it stays deleted', async (t) => {
  const s = await server(t);
  const srv = s.app.store;
  const A = await device('a', s);
  const x = srv.createTodo({ title: 'Delete me on A', inbox: true });
  const y = srv.createTodo({ title: 'Change me on the server', inbox: true });
  await srv.flush();
  await A.sync.sync();
  A.store.deleteTodo(x.id);
  srv.updateTodo(y.id, { title: 'Changed on the server' });
  await srv.flush();
  const r = await A.sync.sync();
  assert.deepEqual(r.merged, ['Inbox.md']);
  for (const st of [A.store, srv]) {
    assert.ok(!st._file('Inbox.md').find(x.id), 'still deleted');
    assert.equal(st._file('Inbox.md').find(y.id)[0].todos[st._file('Inbox.md').find(y.id)[1]].title, 'Changed on the server');
  }
});

test('a shell that makes the requests itself (the bridge\'s http op) syncs the same, and says when it cannot', async (t) => {
  const s = await server(t);
  const asked = [];
  let down = false;
  // the shell's side of op http, as docs/BRIDGE.md has it: status, headers, body as text
  const shell = new BridgeStorage(async (msg) => {
    if (msg.op !== 'http') return { error: { code: 'ENOSYS', message: msg.op } };
    asked.push(msg.args.method);
    if (down) return { error: { code: 'EIO', message: `could not reach ${new URL(msg.args.url).host}` } };
    const r = await fetch(msg.args.url, { method: msg.args.method, headers: msg.args.headers, body: msg.args.body ?? undefined, redirect: 'manual' });
    return { ok: { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() } };
  });
  const A = await device('a', s);
  const viaShell = new WebDavSync(A.store, { url: s.url, token: s.token, fetch: shell.httpFetch() });
  A.store.createTodo({ title: 'Sent by the shell', inbox: true });
  await viaShell.sync();
  assert.ok(asked.includes('PROPFIND') && asked.includes('PUT'), asked.join(' '));
  assert.ok([...s.app.store._file('Inbox.md').allTodos()].some((q) => q.title === 'Sent by the shell'));
  const B = await device('b', s);
  await B.sync.sync();
  assert.deepEqual(await notes(B.store), await notes(A.store));
  down = true;
  await assert.rejects(viaShell.sync(), /could not reach/u);
});

test('a round cut off half way loses nothing: the next one finishes it', async (t) => {
  const s = await server(t);
  const A = await device('a', s);
  for (let i = 0; i < 5; i++) A.store.createProject({ title: `Project ${i}` });
  A.store.createTodo({ title: 'In the Inbox', inbox: true });
  let calls = 0;
  const flaky = new WebDavSync(A.store, {
    url: s.url, token: s.token,
    fetch: (url, init) => { if (++calls === 6) return Promise.reject(new Error('the network went away')); return fetch(url, init); },
  });
  await assert.rejects(flaky.sync(), /the network went away/u);
  const B = await device('b', s);
  await A.sync.sync();
  await B.sync.sync();
  assert.deepEqual(await notes(B.store), await notes(A.store));
  assert.equal(B.store.fileIndex.size, A.store.fileIndex.size);
});

// ---- random work everywhere

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let q = a; q = Math.imul(q ^ (q >>> 15), q | 1); q ^= q + Math.imul(q ^ (q >>> 7), q | 61); return ((q ^ (q >>> 14)) >>> 0) / 4294967296; };
}

const TITLES = ['Call Dana', 'Buy milk', 'Pay rent', 'Book flights', 'Water plants'];

function work(store, r, made, completed) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const open = [...store.files.values()].filter((f) => f.path !== 'Trash.md').flatMap((f) => [...f.allTodos()])
    .filter((q) => q.status === 'open' && !q.id.startsWith('tmp'));
  const projects = [...store.files.values()].filter((f) => f.kind === 'project' && !f.path.startsWith('Trash/')).map((f) => f.frontmatter.id);
  const k = r();
  try {
    if (k < 0.35 || !open.length) {
      const where = r() < 0.6 || !projects.length ? { inbox: true } : { projectId: pick(projects) };
      made.add(store.createTodo({ title: pick(TITLES), ...where }).id);
    } else if (k < 0.5) { const q = pick(open); store.completeTodo(q.id); completed.add(q.id); }
    else if (k < 0.65) store.updateTodo(pick(open).id, { when: pick(['2026-09-24', '2026-10-01', null]) });
    else if (k < 0.75) store.updateTodo(pick(open).id, { title: `${pick(TITLES)}, again` });
    else if (k < 0.82) store.createProject({ title: `${pick(TITLES)} project` });
    else if (k < 0.88 && projects.length) store.moveTodo(pick(open).id, { projectId: pick(projects) });
    else if (k < 0.9) store.deleteTodo(pick(open).id);
    else if (k < 0.92 && projects.length) store.deleteProject(pick(projects));
    else store.putSettings({ weekStartsOn: pick([0, 1, 6]) });
  } catch (e) {
    if (!/NotFound|Conflict|Invalid|Missing/u.test(e.constructor.name)) throw e;
  }
}

const SESSIONS = Number(process.env.DVARIM_SESSIONS || 12);
const STEPS = Number(process.env.DVARIM_STEPS || 30);

test(`two devices and the server, working at random and syncing now and then, end the same and lose nothing (${SESSIONS} sessions of ${STEPS} steps)`, async (t) => {
  const problems = [];
  const only = process.env.DVARIM_ONLY_SESSION;
  for (let session = only ? Number(only) : 0; session < (only ? Number(only) + 1 : SESSIONS) && problems.length < 3; session++) {
    const s = await server(null);
    try {
      const r = rng(Number(process.env.DVARIM_SEED || 1) * 1000 + session);
      const srv = s.app.store;
      const A = await device('a', s), B = await device('b', s);
      const renamed = [A.store, B.store, srv].map(renames);
      const made = new Set(), completed = new Set();
      for (let step = 0; step < STEPS; step++) {
        const k = r();
        if (k < 0.5) work([A.store, B.store, srv][Math.floor(r() * 3)], r, made, completed);
        else if (k < 0.55) {                                       // Obsidian, on the server's folder
          await srv.flush();
          const disk = join(s.root, 'Inbox.md');
          writeFileSync(disk, readFileSync(disk, 'utf8') + `- [ ] Typed in Obsidian ${step}\n`);
        } else await (r() < 0.5 ? A : B).sync.sync();
        await srv.flush();
      }
      for (let i = 0; i < 4; i++) { await A.sync.sync(); await B.sync.sync(); }
      const na = await notes(A.store), nb = await notes(B.store), ns = await notes(srv);
      assert.deepEqual(na, nb, 'the two devices differ');
      assert.deepEqual(na, ns, 'a device and the server differ');
      const ids = new Map();
      for (const [path, text] of Object.entries(na)) for (const q of parse(text, path).allTodos()) if (q.id) ids.set(q.id, [...(ids.get(q.id) || []), q.status]);
      // a to-do in two files (a project deleted on one device and changed on
      // another comes back, beside its copy in Trash) is still that to-do in
      // both, under the id the repair gave the copy
      const places = (id) => {
        const all = new Set([id]);
        for (let grew = true; grew;) {
          grew = false;
          for (const [from, to] of renamed.flat()) if (all.has(from) && !all.has(to)) { all.add(to); grew = true; }
        }
        return [...all].filter((x) => ids.has(x)).flatMap((x) => ids.get(x));
      };
      for (const id of made) assert.ok(places(id).length, `${id}, made somewhere, is gone`);
      for (const id of completed) if (places(id).length) assert.ok(places(id).includes('done'), `${id}, completed somewhere, is not done`);
      assert.deepEqual(A.store.getSettings(), srv.getSettings(), 'settings differ');
      assert.deepEqual(B.store.getSettings(), srv.getSettings(), 'settings differ');
    } catch (e) {
      problems.push(`session ${session}: ${e.message.slice(0, 2000)}`);
    } finally {
      await s.close();
    }
  }
  if (problems.length) assert.fail(`${problems.length} sessions broke a promise:\n${problems.join('\n\n')}`);
});
