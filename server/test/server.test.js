// The server itself (src/app.js, main.js): what it does that the engine's
// router does not — signing in, refusing other sites, the event stream,
// writes on disk before the answer, the app's own files and their caching,
// Android's asset links — over real HTTP, as api.py did it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { start } from '../src/main.js';
import { fixture, serve } from './fixture.js';

test('with no password, everything is open, as before', async (t) => {
  const s = await serve({}, {}, t);
  assert.deepEqual((await s.call('GET', '/api/auth')).json, { required: false, authenticated: true });
  assert.equal((await s.call('GET', '/api/state')).status, 200);
  assert.deepEqual((await s.call('POST', '/api/login', { body: {} })).json, { authenticated: true, required: false });
  await s.close();
});

test('with a password: nothing without signing in; wrong ones slow down; a session cookie and a bot token let in', async (t) => {
  const s = await serve({ password: 'correct horse battery' }, {}, t);
  assert.equal((await s.call('GET', '/api/health')).status, 200);
  assert.deepEqual((await s.call('GET', '/api/auth')).json, { required: true, authenticated: false });
  assert.deepEqual((await s.call('GET', '/api/state')).json, { error: 'not signed in' });
  assert.equal((await s.call('GET', '/api/state')).status, 401);
  // three free tries, then a wait that doubles
  for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/api/login', { body: { password: 'nope' } })).status, 401);
  const fourth = await s.call('POST', '/api/login', { body: { password: 'nope' } });
  assert.equal(fourth.status, 401);
  assert.equal(fourth.headers.get('retry-after'), '3');
  const locked = await s.call('POST', '/api/login', { body: { password: 'correct horse battery' } });
  assert.equal(locked.status, 429);
  assert.match(locked.json.error, /too many attempts/u);
  // another address is not held up by that one
  const ok = await s.call('POST', '/api/login', { body: { password: 'correct horse battery' }, headers: { 'X-Forwarded-For': '10.0.0.2' } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /^dvarim_session=[^;]+; HttpOnly; Max-Age=2592000; Path=\/; SameSite=strict$/u);
  const session = cookie.split(';')[0];
  assert.equal((await s.call('GET', '/api/state', { headers: { Cookie: session } })).status, 200);
  assert.match((await s.call('POST', '/api/login', { body: { password: 'correct horse battery' }, headers: { 'X-Forwarded-For': '10.0.0.3', 'X-Forwarded-Proto': 'https' } })).headers.get('set-cookie'), /; Secure$/u);
  // a bot's token
  const auth = Auth.load(s.root, s.authFile);
  const token = auth.addToken('signal-bot');
  assert.equal((await s.call('GET', '/api/state', { headers: { Authorization: `Bearer ${token}` } })).status, 200, 'minted after the server read the file, and good at once');
  auth.removeToken('signal-bot');
  assert.equal((await s.call('GET', '/api/state', { headers: { Authorization: `Bearer ${token}` } })).status, 401, 'and revoked at once');
  await s.close();
});

test('a bot token and a changed password: the new secret signs every other device out', async () => {
  const f = fixture({ password: 'correct horse battery' });
  const auth = Auth.load(f.root, f.authFile);
  const token = auth.addToken('signal-bot');
  const app = await createApp({ root: f.root, staticDir: f.staticDir, authFile: f.authFile, log: () => {} });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const get = (h) => fetch(base + '/api/state', { headers: h }).then((r) => r.status);
  assert.equal(await get({ Authorization: `Bearer ${token}` }), 200);
  assert.equal(await get({ Authorization: 'Bearer dvt_wrong' }), 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery' }) });
  const old = login.headers.get('set-cookie').split(';')[0];
  const other = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.1.1.1' }, body: JSON.stringify({ password: 'correct horse battery' }) });
  const otherCookie = other.headers.get('set-cookie').split(';')[0];
  const bad = await fetch(base + '/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: old }, body: JSON.stringify({ currentPassword: 'no', newPassword: 'whatever else' }) });
  assert.equal(bad.status, 403);
  const short = await fetch(base + '/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: old }, body: JSON.stringify({ currentPassword: 'correct horse battery', newPassword: 'short' }) });
  assert.deepEqual([short.status, await short.json()], [400, { error: 'use at least 8 characters' }]);
  const changed = await fetch(base + '/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: old }, body: JSON.stringify({ currentPassword: 'correct horse battery', newPassword: 'a new passphrase' }) });
  assert.deepEqual(await changed.json(), { ok: true, signedOutOtherDevices: true });
  const fresh = changed.headers.get('set-cookie').split(';')[0];
  assert.equal(await get({ Cookie: otherCookie }), 401, 'the other device is signed out');
  assert.equal(await get({ Cookie: fresh }), 200, 'this one stays in');
  const saved = JSON.parse(readFileSync(f.authFile, 'utf8'));
  assert.equal(saved.password.algo, 'scrypt');
  const out = await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: fresh } });
  assert.match(out.headers.get('set-cookie'), /dvarim_session=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=\//u);
  await app.close();
});

test('another site cannot change anything, even signed in', async (t) => {
  const s = await serve({}, {}, t);
  const refused = await s.call('POST', '/api/todos', { body: { title: 'from evil.example', inbox: true }, headers: { Origin: 'https://evil.example' } });
  assert.deepEqual([refused.status, refused.json], [403, { error: 'cross-site request refused' }]);
  const host = new URL(s.base).host;
  const fine = await s.call('POST', '/api/todos', { body: { title: 'from here', inbox: true }, headers: { Origin: s.base } });
  assert.equal(fine.status, 200);
  const tunneled = await s.call('POST', '/api/todos', { body: { title: 'via the tunnel', inbox: true }, headers: { Origin: 'https://dvarim.example', 'X-Forwarded-Host': 'dvarim.example' } });
  assert.equal(tunneled.status, 200);
  assert.equal((await s.call('GET', '/api/state', { headers: { Origin: 'https://evil.example' } })).status, 200, 'reading is not a change');
  assert.ok(host);
  await s.close();
});

test('a change is in the file when the answer comes, and the stream says so', async (t) => {
  const s = await serve({}, {}, t);
  const res = await fetch(s.base + '/api/stream');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let seen = dec.decode((await reader.read()).value);
  assert.match(seen, /^event: hello\ndata: \{\}\n\n/u);
  const made = await s.call('POST', '/api/todos', { body: { title: 'Written before the answer', inbox: true } });
  assert.match(readFileSync(join(s.root, 'Inbox.md'), 'utf8'), new RegExp(`- \\[ \\] Written before the answer 🆔 ${made.json.id}`, 'u'));
  while (!seen.includes('event: changed')) seen += dec.decode((await reader.read()).value);
  assert.match(seen, /event: changed\ndata: \{"files":\["Inbox.md"\]\}/u);
  await reader.cancel();
  // a bad body is an empty one, as api.py read it
  assert.equal((await s.call('POST', '/api/quick-add', { raw: '{not json', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.deepEqual((await s.call('GET', '/api/nope')).json, { error: 'not found' });
  await s.close();
});

test('the app\'s files: the shell always asked for again, the bundles kept for ever, any other path the app', async (t) => {
  const s = await serve({}, { android: { package: 'xyz.tiresia.dvarim', fingerprints: ['AB:CD'] } }, t);
  const index = await s.call('GET', '/');
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  assert.match(index.text, /<title>Dvarim/u);
  assert.equal((await s.call('GET', '/project/p1234567')).text, index.text, 'a route of the app is the app');
  const doubled = await s.call('GET', '//');
  assert.equal(doubled.status, 200, 'a doubled slash is the app, not a 500');
  assert.equal(doubled.text, index.text);
  assert.deepEqual((await s.call('GET', '//api/health')).json, { ok: true });
  const bundle = await s.call('GET', '/assets/index-abc123.js');
  assert.equal(bundle.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(bundle.headers.get('content-type'), /text\/javascript/u);
  assert.equal((await s.call('GET', '/sw.js')).headers.get('cache-control'), 'no-cache');
  assert.equal((await s.call('GET', '/../../etc/passwd')).text, index.text, 'nothing outside the build');
  assert.equal((await s.call('GET', '/%2e%2e/%2e%2e/etc/passwd')).text, index.text);
  const links = await s.call('GET', '/.well-known/assetlinks.json');
  assert.deepEqual(links.json, [{ relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'xyz.tiresia.dvarim', sha256_cert_fingerprints: ['AB:CD'] } }]);
  assert.equal(links.headers.get('cache-control'), 'max-age=300');
  await s.close();
});

test('asset links name every package listed: an app that moved to a new id, beside the old', async (t) => {
  const s = await serve({}, { android: { package: 'xyz.example.old, xyz.example.new', fingerprints: ['AB:CD'] } }, t);
  const links = await s.call('GET', '/.well-known/assetlinks.json');
  assert.deepEqual(links.json.map((l) => [l.target.package_name, l.target.sha256_cert_fingerprints]),
    [['xyz.example.old', ['AB:CD']], ['xyz.example.new', ['AB:CD']]]);
  await s.close();
});

test('main: the environment the Python server read starts this one', async () => {
  const f = fixture({ password: 'correct horse battery' });
  writeFileSync(join(f.root, 'Inbox.md'), '- [ ] Already here 🆔 aa11bb22\n');
  const { app, watcher, reminders } = await start({ DVARIM_ROOT: f.root, DVARIM_STATIC: f.staticDir, DVARIM_AUTH_FILE: f.authFile,
    PORT: '0', HOST: '127.0.0.1', DVARIM_OBSIDIAN_VAULT: 'Synergathan', DVARIM_OBSIDIAN_PREFIX: 'Notes/Projects/Tasks', TZ: 'America/Phoenix' });
  assert.equal(app.auth.enabled, true);
  assert.ok(watcher, 'watching the folder');
  assert.deepEqual(app.api.services.reminders(), { configured: false, log: [] });
  assert.match(app.store.todoJson(app.store.getTodo('aa11bb22')[2]).obsidian, /^obsidian:\/\/advanced-uri\?vault=Synergathan&filepath=Notes%2FProjects%2FTasks%2FInbox\.md/u);
  // someone edits the folder: the watcher reads it
  writeFileSync(join(f.root, 'Inbox.md'), '- [ ] Already here 🆔 aa11bb22\n- [ ] Typed in Obsidian\n');
  for (let i = 0; i < 50 && ![...app.store.files.get('Inbox.md').allTodos()].some((t) => t.title === 'Typed in Obsidian'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok([...app.store.files.get('Inbox.md').allTodos()].some((t) => t.title === 'Typed in Obsidian'), 'the watcher noticed');
  assert.ok(reminders);
  watcher.close();
  await app.close();
});

test('an idle connection outlives the tunnel\'s own (so the tunnel never sends into one being closed)', async (t) => {
  const s = await serve({}, {}, t);
  assert.ok(s.app.server.keepAliveTimeout > 90000, `keepAliveTimeout ${s.app.server.keepAliveTimeout}`);
  assert.ok(s.app.server.headersTimeout > s.app.server.keepAliveTimeout);
  // and in fact: a connection left idle past Node's own default of 5 s is still there to use
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const get = () => new Promise((ok, fail) => {
    const req = request(`${s.base}/api/health`, { agent }, (res) => { res.resume(); res.on('end', () => ok({ status: res.statusCode, reused: req.reusedSocket })); });
    req.on('error', fail);
    req.end();
  });
  assert.equal((await get()).status, 200);
  await new Promise((ok) => setTimeout(ok, 6000));
  const second = await get();
  assert.equal(second.status, 200);
  assert.equal(second.reused, true, 'the same connection, still open after 6 s idle');
  agent.destroy();
});

