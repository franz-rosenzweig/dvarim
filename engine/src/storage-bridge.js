// A folder the app's native shell looks after, reached over a message channel.
//
// The page cannot open a folder on the Mac or on Android itself; the shell
// can. So the shell answers a small set of requests — the storage calls in
// storage.js, plus "which folder is this" and two for switching — and this
// turns them back into a storage the engine can use. docs/BRIDGE.md is the
// protocol, for the shells' side; this is the page's.
//
// Two transports carry the same messages:
//   macOS    window.webkit.messageHandlers.dvarimStorage.postMessage(msg)
//            → a Promise of the reply (WKScriptMessageHandlerWithReply)
//   Android  window.DvarimStorage.request(id, json), a @JavascriptInterface,
//            answered later by window.__dvarimStorageReply(id, json) — Android
//            has no promise across the bridge, so replies come back by id
// A shell that would rather hand over an object with the storage methods
// (a test, a future shell) sets window.dvarimStorage and is used as it is.
import { StorageError } from './storage.js';

export const PROTOCOL = 1;

export class BridgeStorage {
  /**
   * @param {(msg: {v: number, op: string, args: object}) => Promise<{ok?: any, error?: {code: string, message: string}}>} send
   * @param {string} [kind]
   */
  constructor(send, kind = 'device') {
    this._send = send;
    this.kind = kind;
  }

  async _call(op, args = {}) {
    let reply;
    try {
      reply = await this._send({ v: PROTOCOL, op, args });
    } catch (e) {
      // the transport itself failed: WebKit turns a native errorMessage into this
      throw new StorageError('EIO', `${op}: ${e && e.message ? e.message : e}`);
    }
    if (reply && typeof reply === 'object' && reply.error) {
      throw new StorageError(reply.error.code || 'EIO', `${op}: ${reply.error.message || reply.error.code}`);
    }
    return reply && typeof reply === 'object' ? reply.ok : undefined;
  }

  async list() {
    const r = (await this._call('list')) || {};
    return { files: [...(r.files || [])], dirs: [...(r.dirs || [])] };
  }

  async read(path) {
    const r = await this._call('read', { path });
    return r ? { text: r.text, mtime: r.mtime } : null;
  }

  async readMany(paths) {
    const r = await this._call('readMany', { paths });
    if (!Array.isArray(r) || r.length !== paths.length) throw new StorageError('EIO', 'readMany: the shell answered for the wrong files');
    return r.map((x) => (x ? { text: x.text, mtime: x.mtime } : null));
  }

  async write(path, text) {
    const r = await this._call('write', { path, text });
    return { mtime: r && r.mtime !== undefined ? r.mtime : Date.now() };
  }

  async remove(path) { await this._call('remove', { path }); }
  async move(from, to) { await this._call('move', { from, to }); }
  async mkdir(path) { await this._call('mkdir', { path }); }
  async removeDir(path) { return (await this._call('removeDir', { path })) !== false; }

  /** { name, detail?, canPick, canUseServer, pollSeconds? }: what Settings shows. */
  async info() {
    try { return (await this._call('info')) || {}; } catch { return {}; }
  }

  /**
   * A fetch() the shell makes for the page (op `http`, docs/BRIDGE.md), for a
   * shell whose `info` says `http: true`. No CORS stands in a native request's
   * way, so the built-in sync reaches WebDAV servers that answer no page from
   * another site (Nextcloud, most others).
   */
  httpFetch() {
    return async (url, init = {}) => {
      const r = await this._call('http', {
        url: String(url), method: init.method || 'GET',
        headers: init.headers || {}, body: init.body === undefined || init.body === null ? null : String(init.body),
        // the shell's own session cookie with it, for what a token may not do
        // (devices, people): honoured by the shell only for its own server
        ...(init.session ? { session: true } : {}),
      });
      const status = Number(r && r.status) || 0;
      if (!status) throw new TypeError('the request failed');
      const noBody = [101, 204, 205, 304].includes(status);
      return new Response(noBody ? null : String((r && r.body) ?? ''), { status, headers: (r && r.headers) || {} });
    };
  }

  /** An app's own copy of a server's vault (info.sync.app): the shell signs
   *  out of the server, forgets the copy and goes back to signing in. */
  signOut() {
    return this._call('signOut', {});
  }

  /**
   * The device's own calendars, for a shell whose `info` says `calendars:
   * true` (ops `calendars` and `events`, docs/BRIDGE.md): the router's
   * services, as the server's CalDAV ones are (engine/src/api.js).
   */
  calendarServices({ enabled = () => true } = {}) {
    // Until the person turns them on (Settings → Calendar), the shell is not
    // asked: its first answer is the system's permission prompt, which belongs
    // after a click on "Show this device's calendars", not on opening the app.
    return {
      calendars: async () => {
        if (!enabled()) return { configured: false, source: 'device', offered: true, calendars: [] };
        try {
          const cals = (await this._call('calendars')) || [];
          return { configured: true, source: 'device', calendars: cals.map((c) => ({ name: String(c.name), color: c.color || null, components: ['VEVENT'] })) };
        } catch (e) {
          return { configured: true, source: 'device', calendars: [], error: e && e.message ? e.message.replace(/^calendars: /u, '') : String(e) };
        }
      },
      events: async (from, to, names) => {
        if (!enabled()) return [];
        const { occurrenceRows } = await import('./events.js');
        return occurrenceRows(await this._call('events', { from, to, calendars: names }), from, to, names);
      },
    };
  }

  /** Tell a shell whose `info` says `changes: true` that the vault changed
   *  (op `changed`), so its menu bar, badge, reminders and widgets can ask
   *  again. Nothing waits on it, and a failure is nobody's business. */
  changed(paths) {
    this._call('changed', { paths }).catch(() => {});
  }

  /** Ask the shell to offer a different folder. It reloads the page if one is chosen. */
  async pick() { return this._call('pick'); }

  /** Ask the shell to go back to the server. It reloads the page from there. */
  async useServer() { return this._call('useServer'); }
}

/** macOS: a WKScriptMessageHandlerWithReply named dvarimStorage. */
export function webkitTransport(handler) {
  return (msg) => handler.postMessage(msg);
}

/** Android: a @JavascriptInterface with request(int id, String json), which
 *  answers through window.__dvarimStorageReply(id, json). */
export function androidTransport(iface, win = globalThis) {
  let next = 1;
  const waiting = new Map();
  const previous = win.__dvarimStorageReply;
  win.__dvarimStorageReply = (id, json) => {
    const w = waiting.get(id);
    if (!w) { if (previous) previous(id, json); return; }
    waiting.delete(id);
    try { w.resolve(typeof json === 'string' ? JSON.parse(json) : json); } catch (e) { w.reject(e); }
  };
  return (msg) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    try { iface.request(id, JSON.stringify(msg)); } catch (e) { waiting.delete(id); reject(e); }
  });
}

/** The storage this page's shell provides, or null in a browser. */
export function detectNativeStorage(win = globalThis) {
  if (!win) return null;
  const given = win.dvarimStorage;
  if (given && typeof given.list === 'function' && typeof given.write === 'function') return given;
  const wk = win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.dvarimStorage;
  if (wk && typeof wk.postMessage === 'function') return new BridgeStorage(webkitTransport(wk));
  const android = win.DvarimStorage;
  if (android && typeof android.request === 'function') return new BridgeStorage(androidTransport(android, win));
  return null;
}
