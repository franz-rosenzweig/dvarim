// The server's folder over WebDAV, for the built-in sync (engine/src/webdav.js,
// docs/SYNC.md "Built-in sync"): a device that keeps its own copy of the vault
// keeps it in step with this one. Class 1 WebDAV, as much as a sync needs:
// OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL. No locks, no MOVE.
//
// Answered from the store, not the disk: a note written here goes through the
// store like any other change, so it cannot be lost under a write the app is
// making at the same moment, and the app's lists show it at once. A write is
// taken only if the device made it from the version here now (If-Match); the
// device merged it with that, so it is taken as it is.
//
// Only what a sync carries is here: the notes and the two state files
// (store.js, syncable). Never the rest of .dvarim/, where auth.json can live.
import { sha1 } from '../../engine/src/sha1.js';
import { STATE_PATH, STAMPS_PATH, syncable } from '../../engine/src/store.js';

export const DAV_PREFIX = '/dav/';
const STATE_FILES = new Set([STATE_PATH, STAMPS_PATH]);
const MAX_FILE = 8 * 1024 * 1024;

const etagOf = (text) => `"${sha1(text)}"`;
const esc = (s) => s.replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hrefOf = (rel, dir) => DAV_PREFIX + rel.split('/').filter(Boolean).map(encodeURIComponent).join('/') + (dir && rel ? '/' : '');

/** Does an If-Match / If-None-Match header list this etag (or "*")? */
function listed(header, etag) {
  return String(header).split(',').map((s) => s.trim().replace(/^W\//u, '')).some((t) => t === '*' || t === etag);
}

export class Dav {
  /** @param {import('../../engine/src/store.js').Store} store */
  constructor(store) {
    this.store = store;
    this._scanned = 0;
  }

  /** Every file offered, as it is now: path -> text. A device lists a folder
   *  at a time, so listings share a scan a second; a write always scans. */
  async files(fresh = false) {
    if (fresh || Date.now() - this._scanned > 1000) {
      await this.store.scanChanges();
      this._scanned = Date.now();
    }
    return this.store.syncTexts();
  }

  /** The file as the store has it this moment: for a note, read with no
   *  await between it and the write that depends on it. */
  async current(rel) {
    await this.files(true);
    if (STATE_FILES.has(rel)) return (await this.store.syncTexts()).get(rel);
    const r = this.store._disk.get(rel);
    return r ? r.text : undefined;
  }

  /** The folders the files are in (and the vault's own, even empty). */
  static dirs(files, tree) {
    const out = new Set(['']);
    for (const rel of files.keys()) {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
    }
    for (const d of tree.dirs) if (syncable(`${d}/x.md`)) out.add(d);
    return out;
  }

  /**
   * @param {string} method
   * @param {string} rel      the path below /dav/, decoded, no leading slash
   * @param {object} headers  lower-case request headers
   * @param {() => Promise<Buffer>} readBody
   * @returns {Promise<{status: number, headers?: object, body?: string}>}
   */
  async handle(method, rel, headers, readBody) {
    rel = rel.replace(/\/+$/u, '');
    if (rel.split('/').some((p) => p === '..' || p === '.')) return { status: 400, body: 'bad path' };
    switch (method) {
      case 'OPTIONS': return { status: 200, headers: { DAV: '1', Allow: 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL' } };
      case 'PROPFIND': return this.propfind(rel, headers.depth);
      case 'GET': case 'HEAD': return this.get(rel, method === 'HEAD');
      case 'PUT': return this.put(rel, headers, readBody);
      case 'DELETE': return this.remove(rel, headers);
      case 'MKCOL': return this.mkcol(rel);
      default: return { status: 405, headers: { Allow: 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL' }, body: 'not supported here' };
    }
  }

  async propfind(rel, depthHeader) {
    const depth = depthHeader === '0' ? 0 : depthHeader === '1' ? 1 : Infinity;
    const files = await this.files(rel === '');       // a device's round starts at the top: what is here now
    const dirs = Dav.dirs(files, this.store.tree);
    const entries = [];
    const fileEntry = (p) => {
      const text = files.get(p);
      entries.push(`<d:response><d:href>${esc(hrefOf(p, false))}</d:href><d:propstat><d:prop>`
        + `<d:resourcetype/><d:getetag>${esc(etagOf(text))}</d:getetag>`
        + `<d:getcontentlength>${new TextEncoder().encode(text).length}</d:getcontentlength>`
        + `<d:getcontenttype>${p.endsWith('.json') ? 'application/json' : 'text/markdown'}</d:getcontenttype>`
        + `<d:displayname>${esc(p.split('/').pop())}</d:displayname>`
        + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
    };
    const dirEntry = (d) => {
      entries.push(`<d:response><d:href>${esc(hrefOf(d, true))}</d:href><d:propstat><d:prop>`
        + `<d:resourcetype><d:collection/></d:resourcetype><d:displayname>${esc(d.split('/').pop() || 'dav')}</d:displayname>`
        + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
    };
    if (files.has(rel)) fileEntry(rel);
    else if (dirs.has(rel)) {
      dirEntry(rel);
      if (depth > 0) {
        const under = (p) => (rel === '' ? p : p.startsWith(rel + '/') ? p.slice(rel.length + 1) : null);
        const within = (p) => { const u = under(p); return u !== null && u !== '' && (depth === Infinity || !u.includes('/')); };
        for (const d of [...dirs].sort()) if (within(d)) dirEntry(d);
        for (const p of [...files.keys()].sort()) if (within(p)) fileEntry(p);
      }
    } else return { status: 404, body: 'not found' };
    return {
      status: 207,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>\n`,
    };
  }

  async get(rel, head) {
    await this.store.flush();
    const text = syncable(rel) ? (await this.store.syncTexts()).get(rel) : undefined;
    if (text === undefined) return { status: 404, body: 'not found' };
    return {
      status: 200,
      headers: { 'Content-Type': rel.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', ETag: etagOf(text) },
      body: head ? undefined : text,
      length: new TextEncoder().encode(text).length,
    };
  }

  /** The check every write makes: is the file here the one the device had? */
  static precondition(current, headers) {
    const etag = current === undefined ? null : etagOf(current);
    if (headers['if-match'] !== undefined && (etag === null || !listed(headers['if-match'], etag))) return false;
    if (headers['if-none-match'] !== undefined && etag !== null && listed(headers['if-none-match'], etag)) return false;
    return true;
  }

  async put(rel, headers, readBody) {
    if (!syncable(rel)) return { status: 403, body: 'only the notes (.md) and .dvarim/state.json and stamps.json are kept here' };
    const raw = await readBody();
    if (raw.length > MAX_FILE) return { status: 413, body: 'too large for a note' };
    const text = new TextDecoder('utf-8', { fatal: false }).decode(raw).replace(/\r\n?/gu, '\n');
    const current = await this.current(rel);
    if (!Dav.precondition(current, headers)) return { status: 412, body: 'the file here changed; fetch it and merge again' };
    const store = this.store;
    if (STATE_FILES.has(rel)) {
      // merged by their stamps, as when a sync tool brings them; the device
      // sends its stamps first, so a state file is read with them
      if (rel === STATE_PATH) store.receiveState(text, store._stampsText());
      else store.receiveState(null, text);
    } else {
      store.receive(rel, text);
    }
    await store.flush();
    const now = (await store.syncTexts()).get(rel);
    // as it was sent, or as the store keeps it (a line typed without an id named): the etag
    // only if it is what the device sent, as a transformed write must not claim it (RFC 7231)
    return { status: current === undefined ? 201 : 204, headers: now === text ? { ETag: etagOf(text) } : {} };
  }

  async remove(rel, headers) {
    if (STATE_FILES.has(rel)) return { status: 403, body: 'the state files are merged, never deleted' };
    const current = syncable(rel) ? await this.current(rel) : undefined;
    if (current === undefined) {
      const files = await this.files();
      return Dav.dirs(files, this.store.tree).has(rel) ? { status: 403, body: 'folders are not deleted over WebDAV' } : { status: 404, body: 'not found' };
    }
    if (!Dav.precondition(current, headers)) return { status: 412, body: 'the file here changed; fetch it and merge again' };
    this.store.receive(rel, null);
    await this.store.flush();
    return { status: 204 };
  }

  async mkcol(rel) {
    if (rel === '' || !syncable(`${rel}/x.md`)) return { status: 403, body: 'not a folder notes can go in' };
    const files = await this.files();
    if (files.has(rel) || Dav.dirs(files, this.store.tree).has(rel)) return { status: 405, body: 'already there' };
    this.store.makeDirs(rel);
    await this.store.flush();
    return { status: 201 };
  }
}
