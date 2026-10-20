// The built-in sync's client (src/webdav.js) against a WebDAV server that is
// not Dvarim's: a strict one in the manner of Nextcloud. It refuses Depth:
// infinity, won't create folders for a PUT, gives opaque ETags, answers with
// absolute URLs under another namespace prefix, and lists what it could not find as 404
// propstats. The Dvarim server's own /dav, and devices in step through it,
// are server/test/dav.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Day } from '../src/day.js';
import { Store } from '../src/store.js';
import { MemoryStorage } from '../src/storage.js';
import { WebDavSync, SYNC_STATE } from '../src/webdav.js';

const BASE = 'https://cloud.example.com/remote.php/dav/files/nathan/Dvarim/';
const LOGIN = `Basic ${Buffer.from('nathan:app-password-1').toString('base64')}`;

class Nextcloudish {
  constructor() {
    this.root = new URL(BASE);
    this.files = new Map();       // rel -> { text, etag }
    this.dirs = new Set(['']);
    this.n = 0;
    this.requests = [];
    this.beforePut = null;         // (rel) => void: someone else writes first
    this.fetch = this.fetch.bind(this);
  }

  etag() { return `"5f${(++this.n).toString(16).padStart(6, '0')}e1"`; }

  put(rel, text) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    this.files.set(rel, { text, etag: this.etag() });
  }

  href(rel, dir) {
    const path = this.root.pathname + rel.split('/').filter(Boolean).map(encodeURIComponent).join('/') + (dir && rel ? '/' : '');
    return dir ? path : `https://cloud.example.com${path}`;
  }

  async fetch(url, init = {}) {
    const method = init.method || 'GET';
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    this.requests.push(`${method} ${url}`);
    const reply = (status, body = '', headers = {}) => new Response(status === 204 ? null : body, { status, headers });
    if (h.authorization !== LOGIN) return reply(401, 'no', { 'WWW-Authenticate': 'Basic realm="Nextcloud"' });
    const u = new URL(url);
    if (!u.pathname.startsWith(this.root.pathname)) return reply(404);
    const rel = decodeURIComponent(u.pathname.slice(this.root.pathname.length)).replace(/\/$/u, '');
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const f = this.files.get(rel);
    const ifMatch = h['if-match'], ifNone = h['if-none-match'];
    const precondition = () => !((ifMatch && (!f || ifMatch !== f.etag)) || (ifNone === '*' && f));
    switch (method) {
      case 'PROPFIND': {
        if (h.depth !== '0' && h.depth !== '1') return reply(403, 'Depth: infinity is not allowed');
        const resp = (href, props) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`
          + '<D:propstat><D:prop><oc:owner-id/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>';
        const out = [];
        if (f) out.push(resp(this.href(rel), `<D:resourcetype/><D:getetag>${f.etag}</D:getetag>`));
        else if (this.dirs.has(rel)) {
          out.push(resp(this.href(rel, true), '<D:resourcetype><D:collection/></D:resourcetype><D:getetag>"dir"</D:getetag>'));
          if (h.depth === '1') {
            const child = (p) => (rel === '' ? p !== '' && !p.includes('/') : p.startsWith(rel + '/') && !p.slice(rel.length + 1).includes('/'));
            for (const d of this.dirs) if (child(d)) out.push(resp(this.href(d, true), '<D:resourcetype><D:collection/></D:resourcetype>'));
            for (const [p, x] of this.files) if (child(p)) out.push(resp(this.href(p), `<D:resourcetype/><D:getetag>${x.etag}</D:getetag>`));
          }
        } else return reply(404);
        return reply(207, `<?xml version="1.0"?>\n<D:multistatus xmlns:D="DAV:" xmlns:oc="http://owncloud.org/ns">${out.join('')}</D:multistatus>`);
      }
      case 'GET': return f ? reply(200, f.text, { ETag: f.etag }) : reply(404);
      case 'PUT': {
        if (!this.dirs.has(parent)) return reply(409, 'parent missing');
        if (this.beforePut) this.beforePut(rel);
        const g = this.files.get(rel);
        if ((ifMatch && (!g || ifMatch !== g.etag)) || (ifNone === '*' && g)) return reply(412);
        this.files.set(rel, { text: String(init.body), etag: this.etag() });
        return reply(g ? 204 : 201, '', { ETag: this.files.get(rel).etag });
      }
      case 'MKCOL':
        if (this.dirs.has(rel) || f) return reply(405);
        if (!this.dirs.has(parent)) return reply(409);
        this.dirs.add(rel);
        return reply(201);
      case 'DELETE':
        if (!f) return reply(404);
        if (!precondition()) return reply(412);
        this.files.delete(rel);
        return reply(204);
      default: return reply(405);
    }
  }
}

async function device(name, cloud, files = {}, password = 'app-password-1', opts = {}) {
  const storage = new MemoryStorage(files);
  let n = 0;
  const store = await Store.open(storage, {
    today: () => Day.fromISO('2026-09-23'),
    newId: (p = '') => p + `${name}${(++n).toString(36)}`.padStart(8 - p.length, '0'),
    ...opts,
  });
  return { storage, store, sync: new WebDavSync(store, { url: BASE, user: 'nathan', password, fetch: cloud.fetch }) };
}

const notes = async (store) => Object.fromEntries([...await store.syncTexts()].filter(([p]) => p.endsWith('.md')).sort());

const VAULT = {
  'Inbox.md': '- [ ] Call Dana 🆔 inbx0001\n',
  'Areas/Personal/Personal.md': '---\ntype: area\nid: aper0001\n---\n',
  'Areas/Personal/Teaching Hebrew & Spanish.md': '---\ntype: project\nid: ptea0001\nstatus: open\ncreated: 2026-09-19\n---\n- [ ] Aleph-bet #1 🆔 teac0001\n',
  'Projects/שבת.md': '---\ntype: project\nid: pshb0001\nstatus: open\ncreated: 2026-09-19\n---\n- [ ] Candles 🆔 shab0001\n',
};

test('a vault sent to an empty folder, then fetched by a second device, folders and odd names included', async () => {
  const cloud = new Nextcloudish();
  cloud.put('notes.txt', 'not a note');
  cloud.put('.obsidian/workspace.md', 'not ours either');
  const A = await device('a', cloud, VAULT);
  const r = await A.sync.sync();
  assert.ok(r.sent.includes('Areas/Personal/Teaching Hebrew & Spanish.md'));
  assert.ok(cloud.files.has('Projects/שבת.md'));
  assert.ok(cloud.requests.some((q) => q.startsWith('MKCOL')), 'made the folders it needed');
  assert.ok(!cloud.requests.some((q) => q.startsWith('PROPFIND') && q.includes('.obsidian')), 'never looked inside .obsidian');
  const B = await device('b', cloud);
  await B.sync.sync();
  assert.deepEqual(await notes(B.store), await notes(A.store));
  assert.ok(!B.storage.files.has('notes.txt'));
  assert.ok(B.storage.files.has(SYNC_STATE), 'what was agreed is kept, on the device');
  assert.equal(cloud.files.get('notes.txt').text, 'not a note', 'what is not ours is left alone');
});

test('a new device\'s tutorial stays out of a vault that has notes, and goes from the device; anywhere else it is a note', async () => {
  const TUT = 'Projects/Meet Dvarim.md';
  const cloud = new Nextcloudish();
  const A = await device('a', cloud, VAULT);
  await A.sync.sync();
  const B = await device('b', cloud, {}, undefined, { tutorial: true });
  assert.ok(B.storage.files.has(TUT), 'a new vault starts with it');
  await B.sync.sync();
  await B.store.flush();
  assert.ok(!cloud.files.has(TUT), 'not sent into the vault');
  assert.ok(!B.storage.files.has(TUT), 'and gone from the device');
  assert.deepEqual(await notes(B.store), await notes(A.store));
  // into an empty folder it goes, like anything else
  const empty = new Nextcloudish();
  const C = await device('c', empty, {}, undefined, { tutorial: true });
  await C.sync.sync();
  assert.ok(empty.files.has(TUT));
  // and one already used is somebody's: sent, as any note is
  const D = await device('d', cloud, {}, undefined, { tutorial: true });
  D.store.completeTodo('meetdv02');
  await D.store.flush();
  await D.sync.sync();
  assert.ok(cloud.files.has(TUT));
});

test('changed on both: merged against what both last had; a write that lost a race waits for the next round', async () => {
  const cloud = new Nextcloudish();
  const A = await device('a', cloud, VAULT);
  await A.sync.sync();
  const B = await device('b', cloud);
  await B.sync.sync();
  A.store.completeTodo('inbx0001');
  B.store.createTodo({ title: 'Made on B', inbox: true });
  await B.sync.sync();
  // someone else writes the Inbox between A's look and A's write
  let once = true;
  cloud.beforePut = (rel) => {
    if (rel !== 'Inbox.md' || !once) return;
    once = false;
    const f = cloud.files.get(rel);
    cloud.files.set(rel, { text: f.text + '- [ ] Made in the Nextcloud web editor 🆔 webe0001\n', etag: cloud.etag() });
  };
  const r = await A.sync.sync();
  assert.deepEqual(r.waiting, ['Inbox.md']);
  const r2 = await A.sync.sync();
  assert.deepEqual(r2.merged, ['Inbox.md']);
  await B.sync.sync();
  for (const d of [A, B]) {
    const inbox = d.store._file('Inbox.md');
    assert.equal(inbox.sections[0].todos.find((x) => x.id === 'inbx0001').status, 'done');
    assert.ok([...inbox.allTodos()].some((x) => x.title === 'Made on B'));
    assert.ok(inbox.find('webe0001'));
  }
  assert.deepEqual(await notes(A.store), await notes(B.store));
});

test('a wrong password is said plainly, and changes nothing', async () => {
  const cloud = new Nextcloudish();
  const A = await device('a', cloud, VAULT, 'not-it');
  await assert.rejects(A.sync.sync(), /did not accept the name and password/u);
  assert.equal(cloud.files.size, 0);
});

test('pointed at another folder, a device starts again there and loses nothing', async () => {
  const cloud = new Nextcloudish();
  const A = await device('a', cloud, VAULT);
  await A.sync.sync();
  const other = new Nextcloudish();
  other.root = new URL(BASE.replace('Dvarim/', 'Elsewhere/'));
  other.put('Inbox.md', '- [ ] Already there 🆔 else0001\n');
  const moved = new WebDavSync(A.store, { url: other.root.href, user: 'nathan', password: 'app-password-1', fetch: other.fetch });
  await moved.sync();
  const ids = [...A.store._file('Inbox.md').allTodos()].map((x) => x.id).sort();
  assert.deepEqual(ids, ['else0001', 'inbx0001']);
  assert.equal(other.files.get('Inbox.md').text, A.storage.files.get('Inbox.md').text);
});
