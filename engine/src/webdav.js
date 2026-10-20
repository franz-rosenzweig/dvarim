// Built-in sync: this device's vault kept in step with a folder on a WebDAV
// server — the Dvarim server's own (/dav, server/src/dav.js), Nextcloud,
// Synology, any other (docs/SYNC.md, "Built-in sync"). Phase 5 of
// docs/ROADMAP.md.
//
// A sync tool that only moves files cannot know what either side started
// from, so a file both changed is a conflict copy, merged later without a
// base. This sync knows: for every file it keeps the text both sides last
// agreed on, so a file changed on both is merged against exactly that
// (merge.js). And every write it makes on the server is conditional on the
// server's file being the one it merged with (If-Match), so nothing written
// there in the meantime is overwritten: that file waits for the next round.
//
//   changed here only          → sent
//   changed there only         → taken
//   changed on both            → merged against the last agreed text, then both
//   deleted on one side,
//     untouched on the other   → deleted on both
//     changed on the other     → kept, with the change
//
// Settings and sort orders (.dvarim/state.json, stamps.json) merge by their
// stamps, as when a sync tool brings them (state-merge.js).
//
// What was last agreed lives in .dvarim/webdav.json, on this device only.
import { parseXml, findAll, find, findText } from './xml.js';
import { mergeText, sameContent } from './merge.js';
import { IGNORED_DIRS, STATE_PATH, STAMPS_PATH, syncable, readText } from './store.js';
import { TUTORIAL_PATH, isUntouchedTutorial } from './tutorial.js';

const DAV = 'DAV:';
export const SYNC_STATE = '.dvarim/webdav.json';
const STATE_FILES = [STATE_PATH, STAMPS_PATH];

export class SyncError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** UTF-8 text as base64, for Basic auth (btoa takes only Latin-1). */
function base64(text) {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A vault path as the last part of a URL: each segment escaped, the slashes kept. */
const encodePath = (rel) => rel.split('/').map(encodeURIComponent).join('/');

/**
 * @param {string} url   the folder on the server, e.g. https://cloud.example.com/remote.php/dav/files/me/Dvarim/
 * @param {object} cred  { user, password } for Basic, or { token } for a Dvarim server's bearer token;
 *   { credentials: 'same-origin' } for none of those, but the page's own cookie, which only the
 *   server's own page syncing with itself may use (the mirror). Otherwise a cookie never goes.
 */
export function davClient(url, cred = {}, fetchFn = globalThis.fetch.bind(globalThis), timeoutMs = 30000) {
  const root = new URL(url.endsWith('/') ? url : url + '/');
  const auth = cred.token ? `Bearer ${cred.token}`
    : cred.user || cred.password ? `Basic ${base64(`${cred.user || ''}:${cred.password || ''}`)}` : null;

  async function request(method, rel, { headers = {}, body } = {}) {
    const target = new URL(encodePath(rel), root);
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetchFn(target.href, {
        method, body,
        headers: { ...(auth ? { Authorization: auth } : {}), ...headers },
        ...(ctl ? { signal: ctl.signal } : {}),
        credentials: cred.credentials === 'same-origin' ? 'same-origin' : 'omit',
      });
    } catch (e) {
      throw new SyncError(`could not reach ${root.host}: ${e && e.message ? e.message : e}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = method === 'HEAD' ? '' : await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new SyncError(res.status === 401 ? 'the server did not accept the name and password (or token)' : 'the server refused access to that folder', res.status);
    }
    return { status: res.status, etag: res.headers.get('etag'), text };
  }

  /** Every file below the folder: path -> etag. A collection at a time
   *  (Depth: 1), which every server allows; Nextcloud refuses Depth: infinity. */
  async function list() {
    const files = new Map();
    const body = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>';
    const queue = [''];
    const seen = new Set();
    while (queue.length) {
      const dir = queue.shift();
      if (seen.has(dir)) continue;
      seen.add(dir);
      const r = await request('PROPFIND', dir, { headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body });
      if (r.status === 404 && dir === '') throw new SyncError(`there is no folder at ${root.href}`, 404);
      if (r.status !== 207) throw new SyncError(`listing ${dir || 'the folder'} failed (HTTP ${r.status})`, r.status);
      let doc;
      try { doc = parseXml(r.text); } catch (e) { throw new SyncError(`the server's listing was not readable XML: ${e.message}`); }
      for (const resp of findAll(doc, DAV, 'response')) {
        let path;
        try { path = decodeURIComponent(new URL(findText(resp, DAV, 'href'), root).pathname); } catch { continue; }
        const base = decodeURIComponent(root.pathname);
        if (!path.startsWith(base)) continue;
        const rel = path.slice(base.length).replace(/\/+$/u, '');
        if (rel === dir) continue;                       // the collection itself
        let isDir = false, etag = null;
        for (const ps of findAll(resp, DAV, 'propstat')) {
          if (!/\s2\d\d\s/u.test(` ${findText(ps, DAV, 'status')} `)) continue;
          const prop = find(ps, DAV, 'prop');
          const rt = find(prop, DAV, 'resourcetype');
          if (rt && find(rt, DAV, 'collection')) isDir = true;
          const e = findText(prop, DAV, 'getetag', null);
          if (e) etag = e.trim();
        }
        if (isDir) {
          const name = rel.split('/').pop();
          if (rel === '.dvarim' || (!name.startsWith('.') && !IGNORED_DIRS.has(name))) queue.push(rel);
        } else if (syncable(rel)) files.set(rel, etag);
      }
    }
    return files;
  }

  async function get(rel) {
    const r = await request('GET', rel);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new SyncError(`fetching ${rel} failed (HTTP ${r.status})`, r.status);
    return { text: readText({ text: r.text }).text, etag: r.etag };
  }

  /** Write, only if the server's file is still `etag` (null: only if it has none).
   *  → the new etag (null if the server did not say), or false if it had changed. */
  async function put(rel, text, etag) {
    const headers = { 'Content-Type': rel.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8' };
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';
    let r = await request('PUT', rel, { headers, body: text });
    if (r.status === 409 && rel.includes('/')) {             // its folder is not there yet
      const parts = rel.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const m = await request('MKCOL', parts.slice(0, i).join('/') + '/');
        if (![201, 405].includes(m.status)) throw new SyncError(`making the folder ${parts.slice(0, i).join('/')} failed (HTTP ${m.status})`, m.status);
      }
      r = await request('PUT', rel, { headers, body: text });
    }
    if (r.status === 412) return false;
    if (r.status < 200 || r.status >= 300) throw new SyncError(`sending ${rel} failed (HTTP ${r.status})`, r.status);
    return r.etag || null;
  }

  /** Delete, only if the server's file is still `etag`. → false if it had changed. */
  async function remove(rel, etag) {
    const r = await request('DELETE', rel, { headers: etag ? { 'If-Match': etag } : {} });
    if (r.status === 412) return false;
    if (r.status === 404 || (r.status >= 200 && r.status < 300)) return true;
    throw new SyncError(`deleting ${rel} failed (HTTP ${r.status})`, r.status);
  }

  return { root: root.href, list, get, put, remove };
}

/**
 * Keeps a store's vault in step with a WebDAV folder.
 * @param {import('./store.js').Store} store
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.user]
 * @param {string} [opts.password]
 * @param {string} [opts.token]
 * @param {typeof fetch} [opts.fetch]  a shell's own, which no CORS stands in the way of
 */
export class WebDavSync {
  constructor(store, opts) {
    this.store = store;
    this.url = opts.url;
    this.client = davClient(opts.url, opts, opts.fetch || globalThis.fetch.bind(globalThis), opts.timeoutMs);
    this.running = null;
  }

  async _loadState() {
    const r = await this.store.storage.read(SYNC_STATE);
    try {
      const v = r ? JSON.parse(r.text) : null;
      if (v && v.url === this.client.root && v.files && typeof v.files === 'object') return v;
    } catch { /* unreadable: start again, which loses nothing (below) */ }
    return { url: this.client.root, files: {} };
  }

  async _saveState(state) {
    const sorted = Object.fromEntries(Object.entries(state.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    await this.store.storage.write(SYNC_STATE, JSON.stringify({ url: state.url, at: state.at, files: sorted }));
  }

  /** One round, or the one already running. */
  sync() {
    if (!this.running) this.running = this._round().finally(() => { this.running = null; });
    return this.running;
  }

  async _round() {
    const store = this.store, dav = this.client;
    const out = { sent: [], taken: [], merged: [], deleted: [], waiting: [], at: store.now() };
    await store.scanChanges();                            // what Obsidian or another app changed here
    const local = await store.syncTexts();
    const remote = await dav.list();
    const state = await this._loadState();
    const agreed = state.files;
    const now = (rel) => (store._disk.has(rel) ? store._disk.get(rel).text : undefined);

    // A device's first round with a vault that already has notes: the only
    // thing it brings of its own is the tutorial it started with (Store.open),
    // and left untouched that stays out of the vault, and goes from here too.
    // If the vault has a tour of its own, that one comes down as it is: merged
    // with no common ancestor, two wordings of one note would be kept side by
    // side, line after line.
    if (!Object.keys(agreed).length && [...remote.keys()].some((p) => syncable(p))
        && local.has(TUTORIAL_PATH) && isUntouchedTutorial(local.get(TUTORIAL_PATH))) {
      store.receive(TUTORIAL_PATH, null);
      local.delete(TUTORIAL_PATH);
    }
    const paths = [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(agreed)])]
      .filter((p) => syncable(p) && !STATE_FILES.includes(p)).sort();
    for (const rel of paths) {
      const L = local.get(rel), R = remote.get(rel), S = agreed[rel];
      const here = S ? L !== S.base : L !== undefined;
      const there = S ? R !== S.etag : R !== undefined;
      if (!here && !there) continue;
      // Whatever is decided below was decided on L. If the page changed the
      // file while the server was being asked, it waits for the next round.
      const unchanged = () => now(rel) === L;

      if (here && !there) {
        if (L === undefined) {
          if (R === undefined || await dav.remove(rel, R)) { delete agreed[rel]; out.deleted.push(rel); } else out.waiting.push(rel);
        } else {
          const etag = await dav.put(rel, L, R ?? null);
          if (etag === false) out.waiting.push(rel);
          else { agreed[rel] = { etag, base: L }; out.sent.push(rel); }
        }
        continue;
      }
      if (!here && there) {
        if (R === undefined) {
          if (!unchanged()) { out.waiting.push(rel); continue; }
          if (L !== undefined) store.receive(rel, null);
          delete agreed[rel];
          out.deleted.push(rel);
        } else {
          const got = await dav.get(rel);
          if (!got || !unchanged()) { out.waiting.push(rel); continue; }
          // taken even when it says the same in another order: the order is the change
          store.receive(rel, got.text);
          agreed[rel] = { etag: got.etag || R, base: got.text };
          out.taken.push(rel);
        }
        continue;
      }
      // changed on both sides
      if (L === undefined && R === undefined) { delete agreed[rel]; continue; }
      if (R === undefined) {                                     // deleted there, changed here: kept
        const etag = await dav.put(rel, L, null);
        if (etag === false) out.waiting.push(rel);
        else { agreed[rel] = { etag, base: L }; out.sent.push(rel); }
        continue;
      }
      const got = await dav.get(rel);
      if (!got || !unchanged()) { out.waiting.push(rel); continue; }
      if (L === undefined) {                                     // deleted here, changed there: kept
        store.receive(rel, got.text);
        agreed[rel] = { etag: got.etag || R, base: got.text };
        out.taken.push(rel);
        continue;
      }
      const merged = mergeText(S ? S.base : '', L, got.text, rel).text;
      if (merged === got.text || sameContent(merged, got.text, rel)) {
        store.receive(rel, got.text);
        agreed[rel] = { etag: got.etag || R, base: got.text };
        out.taken.push(rel);
        continue;
      }
      store.receive(rel, merged);
      await store.flush();
      const mine = now(rel);                                     // as the store keeps it (it may have named a line)
      const etag = await dav.put(rel, mine, got.etag || R);
      if (etag === false) { out.waiting.push(rel); continue; }   // changed there again: merged next round, from the same base
      agreed[rel] = { etag, base: mine };
      out.merged.push(rel);
    }

    // settings and sort orders: merged by their stamps, whichever side changed
    const stateThere = STATE_FILES.filter((p) => remote.get(p) !== (agreed[p] && agreed[p].etag) && remote.has(p));
    if (stateThere.length) {
      const got = {};
      for (const p of STATE_FILES) got[p] = remote.has(p) ? await dav.get(p) : null;
      store.receiveState(got[STATE_PATH] ? got[STATE_PATH].text : null, got[STAMPS_PATH] ? got[STAMPS_PATH].text : null);
      for (const p of STATE_FILES) if (got[p]) agreed[p] = { etag: got[p].etag || remote.get(p), base: got[p].text };
      out.taken.push(...stateThere);
    }
    const after = await store.syncTexts();
    for (const p of [STAMPS_PATH, STATE_PATH]) {                 // the stamps first: the state is read with them
      const mine = after.get(p);
      if (mine === undefined || (agreed[p] && agreed[p].base === mine)) continue;
      const etag = await dav.put(p, mine, (agreed[p] && agreed[p].etag) || remote.get(p) || null);
      if (etag === false) out.waiting.push(p);
      else { agreed[p] = { etag, base: mine }; out.sent.push(p); }
    }

    await store.flush();
    state.at = out.at;
    await this._saveState(state);
    return out;
  }
}
