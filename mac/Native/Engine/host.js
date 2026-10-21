// Dvarim's engine as Dvarim Native runs it: the one set of rules every device
// shares (engine/src), opened on a folder on this Mac and answering the same
// API the server does, so the native screens ask it exactly what the web app
// asks. esbuild bundles this file with the engine into one script
// (build-native.sh), which EngineHost.swift evaluates after prelude.js.
//
// The Mac's side is __native (EngineHost.swift); the Mac calls __dvarim.
import { Store, Day } from '../../../engine/src/index.js';
import { Api } from '../../../engine/src/api.js';
import { WebDavSync } from '../../../engine/src/webdav.js';
import { StorageError } from '../../../engine/src/storage.js';
import { conformance } from '../../../engine/src/storage-conformance.js';

const N = globalThis.__native;

/** The storage contract (engine/src/storage.js) on the Mac's folder: each op
 *  is FolderFiles.swift's, answered at once on the engine's thread. */
class FolderStorage {
  constructor() { this.kind = 'device'; }
  _op(op, args = {}) {
    const reply = N.files(op, args);
    if (reply.error) throw new StorageError(reply.error.code, reply.error.message);
    return reply.ok;
  }
  async list() { return this._op('list'); }
  async read(path) { return this._op('read', { path }); }
  async readMany(paths) { return this._op('readMany', { paths }); }
  async write(path, text) { return this._op('write', { path, text }); }
  async remove(path) { this._op('remove', { path }); }
  async move(from, to) { this._op('move', { from, to }); }
  async mkdir(path) { this._op('mkdir', { path }); }
  async removeDir(path) { return this._op('removeDir', { path }); }
}

let store = null, api = null, sync = null;

// ---- the built-in sync, scheduled as the web app schedules it (lib/davsync.js)
const AFTER_OPEN = 1500, AFTER_CHANGE = 4000, EVERY = 5 * 60 * 1000;
const status = { state: 'off', at: null, error: null, offline: false, result: null };
let timer = null, changedDuring = false, rebuildAfter = false;

function tell() { N.syncStatus(JSON.stringify(status)); }

async function syncNow() {
  if (!sync) return null;
  clearTimeout(timer);
  status.state = 'syncing';
  tell();
  changedDuring = false;
  try {
    const result = await sync.sync();
    Object.assign(status, { state: 'idle', at: Date.now(), result, error: null, offline: false });
    // a copy's first round: read it again, so its lists order as a fresh open would
    if (rebuildAfter) { rebuildAfter = false; store.rebuild(); store.notify([]); }
    return result;
  } catch (e) {
    const offline = !e || !e.status || [502, 503, 504].includes(e.status);
    Object.assign(status, { state: 'error', error: e && e.message ? e.message : String(e), offline });
    throw e;
  } finally {
    tell();
    if (changedDuring) soon();
  }
}

function soon() {
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, AFTER_CHANGE);
}

async function startSync(cfg) {
  const url = String(cfg.address || '').replace(/\/+$/u, '').replace(/\/dav$/u, '') + '/dav/';
  sync = new WebDavSync(store, { url, token: cfg.token, fetch: globalThis.fetch });
  rebuildAfter = !Object.keys((await sync._loadState()).files).length;
  status.state = 'idle';
  tell();
  setTimeout(() => { syncNow().catch(() => {}); }, AFTER_OPEN);
  setInterval(() => { if (N.inFront()) syncNow().catch(() => {}); }, EVERY);
}

async function openStore(opts) {
  store = await Store.open(new FolderStorage(), {
    tutorial: !!opts.tutorial,
    // today as the Mac's calendar says, in its time zone
    today: () => Day.fromISO(N.today()),
    onWriteError: (e, op) => N.log('error', `could not write (${op}): ${e && e.message}`),
  });
  api = new Api(store, {});
  api.subscribe((paths) => {
    N.changed(JSON.stringify(paths || []));
    if (sync) { if (status.state === 'syncing') changedDuring = true; else soon(); }
  });
  if (opts.sync && opts.sync.address && opts.sync.token) await startSync(opts.sync);
}

globalThis.__dvarim = {
  /** Open the folder, answered by N.reply(id, …). opts: {tutorial, sync: {address, token} | null}. */
  open(id, optsJSON) {
    openStore(JSON.parse(optsJSON || '{}'))
      .then(() => N.reply(id, '{"status":200,"body":null}'))
      .catch((e) => N.reply(id, JSON.stringify({ status: 500, body: { error: String(e && e.message || e) } })));
  },


  /** One API request, answered by N.reply(id, {status, body}). */
  request(id, method, path, bodyJSON) {
    const body = bodyJSON ? JSON.parse(bodyJSON) : undefined;
    api.handle(method, path, body)
      .then(async (out) => { await store.flush(); N.reply(id, JSON.stringify(out)); })
      .catch((e) => N.reply(id, JSON.stringify({ status: 500, body: { error: String(e && e.message || e) } })));
  },

  /** Someone else changed the folder (FSEvents): read what changed. */
  scan(id) {
    store.scanChanges().then(() => N.reply(id, '{"status":200,"body":null}'))
      .catch((e) => N.reply(id, JSON.stringify({ status: 500, body: { error: String(e && e.message || e) } })));
  },

  /** A sync round now (the window came forward, the network came back, Sync now). */
  syncNow(id) {
    if (!sync) return N.reply(id, '{"status":200,"body":null}');
    syncNow().then((r) => N.reply(id, JSON.stringify({ status: 200, body: r })))
      .catch((e) => N.reply(id, JSON.stringify({ status: 503, body: { error: String(e && e.message || e), offline: status.offline } })));
  },

  /** Everything written, for a clean quit. */
  flush(id) { store.flush().then(() => N.reply(id, '{"status":200,"body":null}')); },

  /** The storage contract's own checks on this folder (the self-test). */
  conformance(id) {
    conformance(new FolderStorage(), {})
      .then((r) => N.reply(id, JSON.stringify({ status: 200, body: r })))
      .catch((e) => N.reply(id, JSON.stringify({ status: 500, body: { error: String(e && e.message || e) } })));
  },
};
