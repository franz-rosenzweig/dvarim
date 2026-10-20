// Every storage against the contract (src/storage-conformance.js), and the
// bridge the native shells will answer, over both of its transports, with a
// stand-in for the native side that speaks the protocol in docs/BRIDGE.md.
// Then storages that are wrong in the ways a native one could be, to show the
// suite notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, StorageError } from '../src/storage.js';
import { NodeStorage } from '../src/storage-node.js';
import { BridgeStorage, androidTransport, detectNativeStorage, webkitTransport } from '../src/storage-bridge.js';
import { conformance } from '../src/storage-conformance.js';

const report = (r) => r.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.error}`).join('\n');

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dvarim-storage-'));
}

/** The native side, as docs/BRIDGE.md has it: one message in, one reply out,
 *  one at a time and in the order sent, errors as codes. Over a folder. */
function nativeSide(storage, calls = []) {
  let chain = Promise.resolve();
  const run = async (msg) => {
    calls.push(msg.op);
    if (msg.v !== 1) return { error: { code: 'EPROTO', message: `protocol ${msg.v}` } };
    const a = msg.args || {};
    try {
      switch (msg.op) {
        case 'list': return { ok: await storage.list() };
        case 'read': return { ok: await storage.read(a.path) };
        case 'readMany': return { ok: await Promise.all(a.paths.map((p) => storage.read(p))) };
        case 'write': return { ok: await storage.write(a.path, a.text) };
        case 'remove': await storage.remove(a.path); return { ok: null };
        case 'move': await storage.move(a.from, a.to); return { ok: null };
        case 'mkdir': await storage.mkdir(a.path); return { ok: null };
        case 'removeDir': return { ok: await storage.removeDir(a.path) };
        case 'info': return { ok: { name: 'Tasks', detail: '~/Vault/Tasks', canPick: true, canUseServer: true } };
        default: return { error: { code: 'ENOSYS', message: `no such operation: ${msg.op}` } };
      }
    } catch (e) {
      return { error: { code: e.code || 'EIO', message: e.message } };
    }
  };
  // whatever the transport does, the native side takes them in turn
  return (msg) => {
    const copy = JSON.parse(JSON.stringify(msg));      // what crosses a bridge is JSON
    const p = chain.then(() => run(copy)).then((r) => JSON.parse(JSON.stringify(r)));
    chain = p.catch(() => {});
    return p;
  };
}

test('memory storage keeps the contract', async () => {
  const r = await conformance(new MemoryStorage());
  assert.ok(r.ok, report(r));
});

test('a folder on disk keeps the contract', async () => {
  const dir = await tempDir();
  try {
    const r = await conformance(new NodeStorage(dir));
    assert.ok(r.ok, report(r));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the bridge, the Mac way: postMessage answers with a promise', async () => {
  const dir = await tempDir();
  try {
    const answer = nativeSide(new NodeStorage(dir));
    const win = { webkit: { messageHandlers: { dvarimStorage: { postMessage: (msg) => answer(msg) } } } };
    const storage = detectNativeStorage(win);
    assert.ok(storage instanceof BridgeStorage);
    const r = await conformance(storage);
    assert.ok(r.ok, report(r));
    assert.equal((await storage.info()).name, 'Tasks');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the bridge, the Android way: a request now, the reply later by id, out of order', async () => {
  const dir = await tempDir();
  try {
    const answer = nativeSide(new NodeStorage(dir));
    const win = {};
    let n = 0;
    win.DvarimStorage = {
      // a @JavascriptInterface takes strings and returns at once; the reply is
      // evaluateJavascript'd later, and here deliberately not in order
      request(id, json) {
        const msg = JSON.parse(json);
        answer(msg).then((reply) => setTimeout(() => win.__dvarimStorageReply(id, JSON.stringify(reply)), (n++ * 7) % 5));
      },
    };
    const storage = detectNativeStorage(win);
    assert.ok(storage instanceof BridgeStorage);
    const r = await conformance(storage);
    assert.ok(r.ok, report(r));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a native error arrives as a StorageError with its code', async () => {
  const storage = new BridgeStorage(async () => ({ error: { code: 'EACCES', message: 'the folder is no longer ours' } }));
  await assert.rejects(storage.write('Inbox.md', 'x'), (e) => e instanceof StorageError && e.code === 'EACCES' && /no longer ours/.test(e.message));
  const broken = new BridgeStorage(webkitTransport({ postMessage: () => Promise.reject(new Error('no handler')) }));
  await assert.rejects(broken.list(), (e) => e instanceof StorageError && e.code === 'EIO');
  assert.deepEqual(await broken.info(), {});                  // Settings still opens
});

test('android replies for someone else are passed on, not swallowed', async () => {
  const seen = [];
  const win = { __dvarimStorageReply: (id) => seen.push(id) };
  const send = androidTransport({ request: (id, json) => setTimeout(() => win.__dvarimStorageReply(id, JSON.stringify({ ok: JSON.parse(json).op })), 0) }, win);
  assert.equal(await send({ v: 1, op: 'list', args: {} }).then((r) => r.ok), 'list');
  win.__dvarimStorageReply(999, '{}');
  assert.deepEqual(seen, [999]);
});

test('no shell, no bridge', () => {
  assert.equal(detectNativeStorage({}), null);
  const given = new MemoryStorage();
  assert.equal(detectNativeStorage({ dvarimStorage: given }), given);
});

// ---- the suite notices what a native folder could get wrong -------------------

class Overwrites extends MemoryStorage {
  async move(from, to) { this.files.delete(to); this.dirs.delete(to); return super.move(from, to); }
}
class Translates extends MemoryStorage {
  async write(path, text) { return super.write(path, text.replace(/\r\n/gu, '\n')); }
}
class Decomposes extends MemoryStorage {
  async list() { const r = await super.list(); return { files: r.files.map((f) => f.normalize('NFD')), dirs: r.dirs }; }
}
class NoEmptyDirs extends MemoryStorage {
  async list() { const r = await super.list(); return { files: r.files, dirs: r.dirs.filter((d) => r.files.some((f) => f.startsWith(d + '/'))) }; }
}
class Escapes extends MemoryStorage {
  async read(path) { return path.includes('..') ? null : super.read(path); }
}
class Unordered extends MemoryStorage {
  // each call waits less than the one before (wrapping every ten), so calls
  // sent together finish backwards: however the suite's calls fall, one of
  // its ordering checks sees it
  _later() { this.n = (this.n || 0) + 1; return new Promise((r) => setTimeout(r, 30 - 3 * (this.n % 10))); }
  async write(path, text) { await this._later(); return super.write(path, text); }
  async remove(path) { await this._later(); return super.remove(path); }
}

for (const [Kind, name] of [[Overwrites, 'move overwrites'], [Translates, 'newlines translated'], [Decomposes, 'names decomposed'],
  [NoEmptyDirs, 'empty folders unlisted'], [Escapes, 'paths not checked'], [Unordered, 'calls reordered']]) {
  test(`the suite catches a storage whose ${name}`, async () => {
    const r = await conformance(new Kind());
    assert.equal(r.ok, false, `${name} passed the suite`);
  });
}
