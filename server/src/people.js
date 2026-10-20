// The people besides the owner who use this server (docs/PEOPLE.md). Each has
// a folder of their own under DVARIM_PEOPLE, opened the first time they need
// it and kept open, with a store, a router and a WebDAV of its own. None of
// the owner's services: the calendars, Signal reminders and the to-do mirror
// are wired to the owner's own accounts, so a person's Settings say they are
// not set up, which is true.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Store } from '../../engine/src/store.js';
import { NodeStorage } from '../../engine/src/storage-node.js';
import { Api } from '../../engine/src/api.js';
import { Dav } from './dav.js';

export class Household {
  /**
   * @param {string} root  DVARIM_PEOPLE: one folder per person, by key
   * @param {{now?: () => number, today?: () => Day, onWriteError?: Function}} [opts]
   */
  constructor(root, opts = {}) {
    this.root = resolve(root);
    this.opts = opts;
    this.open = new Map();                 // key -> Promise<{folder, store, api, dav}>
  }

  folder(key) {
    const f = resolve(this.root, key);
    if (!f.startsWith(this.root + sep)) throw new Error(`not a name for a folder: ${key}`);
    return f;
  }

  /** A newcomer's folder. New, it starts with the tutorial (Store.open); one
   *  already there (made by hand, say) is kept as it is. */
  async create(key) {
    return this.get(key);
  }

  /** Their store, router and WebDAV. */
  get(key) {
    if (!this.open.has(key)) {
      this.open.set(key, this._open(key).catch((e) => { this.open.delete(key); throw e; }));
    }
    return this.open.get(key);
  }

  async _open(key) {
    const folder = this.folder(key);
    mkdirSync(folder, { recursive: true });
    const store = await Store.open(new NodeStorage(folder), {
      now: this.opts.now, today: this.opts.today, onWriteError: this.opts.onWriteError, tutorial: true,
    });
    await store.flush();
    return { folder, store, api: new Api(store, {}), dav: new Dav(store) };
  }

  /** Their folder put aside, never deleted: <root>/.removed/<key> <date>.
   *  Returns where it went, or null if there was none. */
  async remove(key) {
    const was = this.open.get(key);
    this.open.delete(key);
    if (was) { try { await (await was).store.flush(); } catch { /* nothing more to write */ } }
    const folder = this.folder(key);
    if (!existsSync(folder)) return null;
    const base = join(this.root, '.removed', `${key} ${new Date().toISOString().slice(0, 10)}`);
    let away = base;
    for (let n = 2; existsSync(away); n++) away = `${base} ${n}`;
    mkdirSync(dirname(away), { recursive: true });
    renameSync(folder, away);
    return away;
  }

  async close() {
    for (const p of this.open.values()) {
      try { await (await p).store.flush(); } catch { /* closing anyway */ }
    }
  }
}

// ---- asking for an account, from the sign-in page

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/u;
export const MAX_WAITING = 30;          // requests kept at once
export const PER_ADDRESS = 3;           // from one address, in a day

/** A request someone could not make, and why, said to them. */
export class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Requests for an account: a name, an email and a line, left on the sign-in
 * page for the owner to answer (Settings → Account → People). Kept in their own
 * file beside auth.json, so nothing anyone types there goes near a password,
 * and capped, so the page cannot be used to fill a disk.
 */
export class Requests {
  constructor(path) {
    this.path = path;
    this.recent = new Map();              // address -> [ms], what it asked lately
  }

  _read() {
    try {
      const v = JSON.parse(readFileSync(this.path, 'utf8'));
      return Array.isArray(v.requests) ? v.requests : [];
    } catch {
      return [];
    }
  }

  _write(list) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path.replace(/\.json$/u, '') + '.tmp';
    writeFileSync(tmp, JSON.stringify({ requests: list }, null, 1), 'utf8');
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Oldest first: [{id, name, email, message, created}]. */
  list() {
    return this._read().sort((a, b) => a.created - b.created);
  }

  get(id) {
    return this._read().find((r) => r.id === id) || null;
  }

  /** Someone asking. Throws Refused for what will not do; asked again from the
   *  same email, it is the same request, brought up to date. */
  add({ name, email, message }, address, now = Date.now()) {
    name = String(name ?? '').trim().replace(/\s+/gu, ' ').slice(0, 60);
    email = String(email ?? '').trim().toLowerCase();
    message = String(message ?? '').trim().slice(0, 500);
    if (!name) throw new Refused(400, 'Say who you are.');
    if (email.length > 254 || !EMAIL.test(email)) throw new Refused(400, "That doesn't look like an email address.");
    const lately = (this.recent.get(address) || []).filter((t) => now - t < 86400000);
    if (lately.length >= PER_ADDRESS) throw new Refused(429, "You've asked a few times today already. Try again tomorrow.");
    const list = this._read();
    let r = list.find((x) => x.email === email);
    if (!r && list.length >= MAX_WAITING) throw new Refused(429, 'Too many requests are waiting. Try again in a few days.');
    lately.push(now);
    this.recent.set(address, lately);
    if (r) Object.assign(r, { name, ...(message ? { message } : {}), updated: Math.floor(now / 1000) });
    else list.push(r = { id: randomBytes(6).toString('hex'), name, email, message, created: Math.floor(now / 1000) });
    this._write(list);
    return r;
  }

  remove(id) {
    const list = this._read();
    const rest = list.filter((r) => r.id !== id);
    if (rest.length === list.length) return false;
    this._write(rest);
    return true;
  }
}
