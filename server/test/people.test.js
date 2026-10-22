// Other people on the owner's server (docs/PEOPLE.md): invited by a link that
// works once, each with a folder, sessions, devices and a download of their
// own, and none of them able to see anyone else's to-dos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serve, fixture } from './fixture.js';
import { createApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { crc32 } from '../src/zip.js';

const PW = 'correct horse battery';
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const as = (cookie, extra = {}) => ({ ...extra, headers: { Cookie: cookie, ...(extra.headers || {}) } });
/** Who, without the account's id, which is random. */
const plain = (p) => p && { name: p.name, owner: p.owner };
const titles = async (s, cookie, list = 'inbox') => (await s.call('GET', `/api/lists/${list}`, as(cookie))).json.items.map((t) => t.title);

async function signIn(s, body) {
  const r = await s.call('POST', '/api/login', { body });
  return { r, cookie: cookieOf(r) };
}
async function invite(s, owner, note = '') {
  return (await s.call('POST', '/api/people/invites', as(owner, { body: { note } }))).json;
}
async function join_(s, code, name, password) {
  const r = await s.call('POST', '/api/join', { body: { code, name, password } });
  return { r, cookie: cookieOf(r) };
}
/** The owner signed in, and Dana, invited and joined. */
async function household(t) {
  const s = await serve({ password: PW }, {}, t);
  const owner = (await signIn(s, { password: PW })).cookie;
  const dana = (await join_(s, (await invite(s, owner, 'Dana')).code, 'Dana', 'dana password')).cookie;
  return { s, owner, dana, folder: join(dirname(s.authFile), 'people', 'dana') };
}

test('an invitation works once, and makes a folder of their own, beside the owner\'s and not in it, with the tutorial', async (t) => {
  const s = await serve({ password: PW }, {}, t);
  const owner = (await signIn(s, { password: PW })).cookie;
  const inv = await invite(s, owner, 'Dana');
  assert.match(inv.link, /^http:\/\/127\.0\.0\.1:\d+\/join\/[A-Za-z0-9_-]{20,}$/u);
  assert.deepEqual((await s.call('GET', `/api/join/${inv.code}`)).json, { ok: true, note: 'Dana', expires: inv.expires });
  assert.equal((await s.call('GET', '/api/join/notacodeatall')).status, 404);
  // a name or password that will not do leaves the link good
  assert.equal((await join_(s, inv.code, 'x', 'long enough')).r.status, 400);
  assert.equal((await join_(s, inv.code, 'Dana', 'short')).r.status, 400);
  assert.equal((await join_(s, inv.code, 'admin', 'long enough')).r.status, 409);
  const { r, cookie } = await join_(s, inv.code, 'Dana', 'dana password');
  assert.equal(r.status, 200);
  assert.deepEqual(plain(r.json.person), { name: 'Dana', owner: false });
  assert.match(r.json.person.uid, /^[A-Za-z0-9_-]{12}$/u);
  const me = (await s.call('GET', '/api/auth', as(cookie))).json;
  assert.deepEqual({ ...me, person: plain(me.person) }, { required: true, authenticated: true, person: { name: 'Dana', owner: false } });
  assert.equal(me.person.uid, r.json.person.uid, 'the same account, the same id');
  assert.equal((await join_(s, inv.code, 'Eli', 'eli password')).r.status, 404, 'used up');
  const folder = join(dirname(s.authFile), 'people', 'dana');
  assert.ok(existsSync(join(folder, 'Inbox.md')));
  assert.match(readFileSync(join(folder, 'Projects', 'Meet Dvarim.md'), 'utf8'), /^- \[x\] Find the tutorial 🆔 meetdv01 ✅ \d{4}-\d\d-\d\d$/mu);
  assert.deepEqual((await s.call('GET', '/api/state', as(cookie))).json.looseProjects.map((p) => p.name), ['Meet Dvarim']);
  assert.ok(!readdirSync(s.root, { recursive: true }).some((p) => String(p).includes('people')), 'nothing in the owner\'s folder');
  const list = (await s.call('GET', '/api/people', as(owner))).json;
  assert.deepEqual([list.people.map((p) => p.display), list.invites], [['Dana'], []]);
  // an invitation can be taken back before it is used
  const other = await invite(s, owner, 'Eli');
  assert.deepEqual((await s.call('DELETE', `/api/people/invites/${other.id}`, as(owner))).json, { removed: true });
  assert.equal((await join_(s, other.code, 'Eli', 'eli password')).r.status, 404);
});

test('each person sees only their own to-dos: in the lists, the files and over WebDAV', async (t) => {
  const { s, owner, dana, folder } = await household(t);
  await s.call('POST', '/api/todos', as(owner, { body: { title: 'The owner\'s own', inbox: true } }));
  await s.call('POST', '/api/todos', as(dana, { body: { title: 'Dana\'s own', inbox: true } }));
  assert.deepEqual(await titles(s, owner), ['The owner\'s own']);
  assert.deepEqual(await titles(s, dana), ['Dana\'s own']);
  assert.match(readFileSync(join(s.root, 'Inbox.md'), 'utf8'), /The owner's own/u);
  assert.doesNotMatch(readFileSync(join(s.root, 'Inbox.md'), 'utf8'), /Dana/u);
  assert.match(readFileSync(join(folder, 'Inbox.md'), 'utf8'), /Dana's own/u);
  // a device of Dana's: her token, her folder
  const dev = (await s.call('POST', '/api/tokens', as(dana, { body: { name: 'Dana\'s phone' } }))).json;
  const dav = await fetch(`${s.base}/dav/Inbox.md`, { headers: { Authorization: `Bearer ${dev.token}` } });
  assert.match(await dav.text(), /Dana's own/u);
  assert.deepEqual((await s.call('GET', '/api/tokens', as(owner))).json.tokens, [], 'not among the owner\'s devices');
  assert.deepEqual((await s.call('GET', '/api/tokens', as(dana))).json.tokens.map((x) => x.name), ['Dana\'s phone']);
  // and only the owner says who uses the server
  assert.equal((await s.call('GET', '/api/people', as(dana))).status, 403);
  assert.equal((await s.call('POST', '/api/people/invites', as(dana, { body: {} }))).status, 403);
});

test('signing in by name, or with none for the owner; a changed password signs out only that person', async (t) => {
  const { s, owner, dana } = await household(t);
  assert.deepEqual(plain((await signIn(s, { name: ' DANA ', password: 'dana password' })).r.json.person), { name: 'Dana', owner: false });
  assert.equal((await signIn(s, { name: 'Dana', password: PW })).r.status, 401, 'her name, the owner\'s password');
  assert.deepEqual((await signIn(s, { password: PW })).r.json.person, { name: null, owner: true });
  // a name nobody has is the owner's password, as before there was anyone else
  assert.equal((await signIn(s, { name: 'Sam', password: PW })).r.json.person.owner, true);
  // the owner's own name, once given, is nobody else's to take
  assert.deepEqual((await s.call('PUT', '/api/people/owner', as(owner, { body: { name: 'Sam' } }))).json, { name: 'Sam', owner: true });
  assert.equal((await join_(s, (await invite(s, owner)).code, 'sam', 'long enough')).r.status, 409);

  const changed = await s.call('POST', '/api/password', as(dana, { body: { currentPassword: 'dana password', newPassword: 'a new one for dana' } }));
  assert.equal(changed.status, 200);
  const dana2 = cookieOf(changed);
  assert.equal((await s.call('GET', '/api/state', as(dana))).status, 401, 'her other devices are signed out');
  assert.equal((await s.call('GET', '/api/state', as(dana2))).status, 200);
  assert.equal((await s.call('GET', '/api/state', as(owner))).status, 200, 'the owner is not');
  const mine = await s.call('POST', '/api/password', as(owner, { body: { currentPassword: PW, newPassword: 'the owner\'s new one' } }));
  assert.equal((await s.call('GET', '/api/state', as(owner))).status, 401);
  assert.equal((await s.call('GET', '/api/state', as(cookieOf(mine)))).status, 200);
  assert.equal((await s.call('GET', '/api/state', as(dana2))).status, 200, 'and Dana is not signed out by the owner');
  // she forgets it: the owner sets one to pass on, and she is signed out until she uses it
  const reset = await s.call('POST', '/api/people/dana/password', as(cookieOf(mine), { body: { password: 'tell dana this' } }));
  assert.deepEqual(reset.json, { ok: true });
  assert.equal((await s.call('GET', '/api/state', as(dana2))).status, 401);
  const dana3 = await signIn(s, { name: 'Dana', password: 'tell dana this' });
  assert.equal(dana3.r.status, 200);
  assert.equal((await s.call('POST', '/api/people/dana/password', as(dana3.cookie, { body: { password: 'by herself?' } }))).status, 403, 'only the owner');
});

test('removing someone signs them out everywhere and puts their folder aside, never deleting it', async (t) => {
  const { s, owner, dana, folder } = await household(t);
  const dev = (await s.call('POST', '/api/tokens', as(dana, { body: { name: 'laptop' } }))).json;
  assert.equal((await s.call('DELETE', '/api/people/dana', as(dana))).status, 403);
  const out = (await s.call('DELETE', '/api/people/dana', as(owner))).json;
  assert.match(out.keptAt, /^\.removed\/dana \d{4}-\d\d-\d\d$/u);
  assert.ok(!existsSync(folder));
  assert.ok(existsSync(join(dirname(s.authFile), 'people', out.keptAt, 'Projects', 'Meet Dvarim.md')));
  assert.equal((await s.call('GET', '/api/state', as(dana))).status, 401);
  assert.equal((await fetch(`${s.base}/dav/Inbox.md`, { headers: { Authorization: `Bearer ${dev.token}` } })).status, 401);
  assert.equal((await signIn(s, { name: 'Dana', password: 'dana password' })).r.status, 401);
  assert.equal((await s.call('DELETE', '/api/people/dana', as(owner))).status, 404);
  // someone new who chooses the same name: a new folder, and the old cookie is no key to it
  const again = await join_(s, (await invite(s, owner)).code, 'Dana', 'another dana');
  assert.equal(again.r.status, 200);
  assert.equal((await s.call('GET', '/api/state', as(dana))).status, 401);
  assert.equal((await s.call('GET', '/api/state', as(again.cookie))).status, 200);
});

/** The files in a zip, each checked against its CRC. */
function unzip(buf) {
  const out = {};
  for (let at = 0; buf.readUInt32LE(at) === 0x04034b50;) {
    const size = buf.readUInt32LE(at + 18), nameLen = buf.readUInt16LE(at + 26), extra = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const data = buf.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    assert.equal(crc32(data), buf.readUInt32LE(at + 14), `${name}: its CRC`);
    out[name] = data.toString('utf8');
    at += 30 + nameLen + extra + size;
  }
  return out;
}

test('"Download my files": a zip of one\'s own folder, and nobody else\'s', async (t) => {
  const { s, owner, dana } = await household(t);
  await s.call('POST', '/api/todos', as(dana, { body: { title: 'שבת שלום', inbox: true } }));
  const res = await fetch(`${s.base}/api/export`, { headers: { Cookie: dana } });
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="Dvarim \d{4}-\d\d-\d\d\.zip"$/u);
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.ok(files['Dvarim/Projects/Meet Dvarim.md']);
  assert.match(files['Dvarim/Inbox.md'], /שבת שלום/u);
  const mine = unzip(Buffer.from(await (await fetch(`${s.base}/api/export`, { headers: { Cookie: owner } })).arrayBuffer()));
  assert.ok(!mine['Dvarim/Projects/Meet Dvarim.md'] && !Object.values(mine).some((x) => x.includes('שבת')));
  assert.equal((await fetch(`${s.base}/api/export`)).status, 401);
});

test('asking for an account: the owner hears and answers; bots and floods get nowhere', async (t) => {
  const heard = [];
  const s = await serve({ password: PW }, { onRequest: (r) => heard.push(r.email) }, t);
  assert.deepEqual((await s.call('GET', '/api/requests')).json, { open: true });
  const ask = (body, ip = '203.0.113.7') => s.call('POST', '/api/requests', { body, headers: { 'CF-Connecting-IP': ip } });
  assert.equal((await ask({ name: ' ', email: 'dana@example.com' })).status, 400);
  assert.equal((await ask({ name: 'Dana', email: 'not an email' })).status, 400);
  assert.deepEqual((await ask({ name: 'Dana', email: 'Dana@Example.com', message: 'Sam said to ask' })).json, { ok: true });
  // a bot fills in the field people never see: told yes, and nothing kept
  assert.deepEqual((await ask({ name: 'Bot', email: 'bot@example.com', website: 'http://spam.example' }, '198.51.100.1')).json, { ok: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(heard, ['dana@example.com'], 'the owner hears of Dana, not of the bot');
  const owner = (await signIn(s, { password: PW })).cookie;
  assert.equal((await s.call('GET', '/api/auth', as(owner))).json.requests, 1);
  let waiting = (await s.call('GET', '/api/people', as(owner))).json.requests;
  assert.deepEqual(waiting.map((r) => [r.name, r.email, r.message]), [['Dana', 'dana@example.com', 'Sam said to ask']]);
  // asked again from the same email: the same request, brought up to date
  await ask({ name: 'Dana L.', email: 'dana@example.com' });
  assert.equal((await ask({ name: 'Eli', email: 'eli@example.com' })).status, 200);
  assert.equal((await ask({ name: 'Flood', email: 'flood@example.com' })).status, 429, 'a few a day from one address');
  waiting = (await s.call('GET', '/api/people', as(owner))).json.requests;
  assert.deepEqual(waiting.map((r) => [r.name, r.message]), [['Dana L.', 'Sam said to ask'], ['Eli', '']]);
  // answered with an invitation in their name, and the request goes
  const inv = (await s.call('POST', `/api/people/requests/${waiting[0].id}/invite`, as(owner))).json;
  assert.match(inv.link, /\/join\//u);
  assert.deepEqual([inv.name, inv.email], ['Dana L.', 'dana@example.com']);
  assert.equal((await s.call('GET', `/api/join/${inv.code}`)).json.note, 'Dana L.');
  assert.equal((await s.call('POST', `/api/people/requests/${waiting[0].id}/invite`, as(owner))).status, 404, 'answered already');
  assert.deepEqual((await s.call('DELETE', `/api/people/requests/${waiting[1].id}`, as(owner))).json, { removed: true });
  assert.deepEqual((await s.call('GET', '/api/people', as(owner))).json.requests, []);
  assert.equal((await s.call('GET', '/api/auth', as(owner))).json.requests, undefined);
  // kept beside auth.json, for the server's eyes only, and never answered by anyone but the owner
  assert.equal(statSync(join(dirname(s.authFile), 'requests.json')).mode & 0o777, 0o600);
  const dana = (await join_(s, inv.code, 'Dana L', 'dana password')).cookie;
  assert.equal((await s.call('DELETE', `/api/people/requests/${waiting[1].id}`, as(dana))).status, 403);
  // and with no password set, nobody can ask
  const open = await serve({}, {}, t);
  assert.deepEqual((await open.call('GET', '/api/requests')).json, { open: false });
  assert.equal((await open.call('POST', '/api/requests', { body: { name: 'X', email: 'x@example.com' } })).status, 404);
});

test('a new server\'s empty folder starts with "Meet Dvarim"; Settings makes it again', async (t) => {
  const s = await serve({}, { tutorial: true }, t);
  const names = async () => (await s.call('GET', '/api/state')).json.looseProjects.map((p) => p.name);
  assert.deepEqual(await names(), ['Meet Dvarim']);
  assert.ok(existsSync(join(s.root, 'Projects', 'Meet Dvarim.md')));
  assert.equal((await s.call('POST', '/api/tutorial', { body: {} })).json.id, 'pmeetdvr', 'still open: the one there is');
  await s.call('DELETE', '/api/projects/pmeetdvr');
  const again = (await s.call('POST', '/api/tutorial', { body: {} })).json;
  assert.notEqual(again.id, 'pmeetdvr');
  assert.deepEqual(await names(), ['Meet Dvarim']);
});

test('nobody else can be invited without a password, or without a folder for them outside the owner\'s', async (t) => {
  const open = await serve({}, {}, t);
  assert.equal((await open.call('POST', '/api/people/invites', { body: {} })).status, 403);
  // no DVARIM_AUTH_FILE: its folder is inside the owner's, and so would theirs be
  const f = fixture();
  Auth.load(f.root, join(f.root, '.dvarim', 'auth.json')).setPassword(PW);
  const app = await createApp({ root: f.root, staticDir: f.staticDir, authFile: join(f.root, '.dvarim', 'auth.json'), log: () => {} });
  t.after(() => app.close());
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const owner = cookieOf(await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) }));
  const list = await (await fetch(`${base}/api/people`, { headers: { Cookie: owner } })).json();
  assert.equal(list.enabled, false);
  assert.match(list.reason, /DVARIM_PEOPLE/u);
  const inv = await fetch(`${base}/api/people/invites`, { method: 'POST', headers: { Cookie: owner, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(inv.status, 400);
});
