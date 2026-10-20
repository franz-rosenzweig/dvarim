// Signing in (backend/dvarim/auth.py, ported): one password, a signed session
// cookie, and named bearer tokens for the bots. The same file, the same hash
// and the same cookie format as the Python server's, so moving from one to
// the other signs nobody out and needs no new password.
//
// That password is the owner's, as it always was. Other people the owner
// invites each have a record under `people` (docs/PEOPLE.md): a name, a
// password, their own tokens and their own folder (app.js). Their session
// cookies name them; the owner's name nobody, so every cookie made before
// there were other people is still the owner's.
//
// What it defends against, the app being on the public internet:
//   - guessing the password (scrypt, and per-address backoff on failures)
//   - reading or forging a session cookie (HMAC-SHA256 over the payload)
//   - a page on another site acting as you (SameSite=Strict, and a same-origin
//     check on every request that changes something: http.js)
//   - a stolen token living forever (expiry; rotating `secret` signs everyone out)
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCRYPT = { N: 2 ** 14, r: 8, p: 1 };
// A person's name, as they sign in with it: letters (any alphabet), digits,
// and a space, dot, dash or underscore inside. Their key, and their folder's
// name, is it in lower case.
export const PERSON_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,29}$/u;
export const personKey = (name) => String(name).trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
const NAME_RULE = 'a name is 2 to 30 letters or digits, and may have spaces, dots or dashes inside';
const RESERVED = new Set(['owner', 'admin', 'root', 'removed']);
export const INVITE_DAYS = 7;
export const SESSION_COOKIE = 'dvarim_session';
export const SESSION_DAYS = 30;
// Typos should not lock you out, but a script should die quickly: the first
// few tries are free, then each failure doubles the wait, per client address.
const LOCKOUT_FREE_ATTEMPTS = 3;
const LOCKOUT_BASE_SECONDS = 2.0;
const LOCKOUT_MAX_SECONDS = 300.0;

/** base64url without padding: Python's urlsafe_b64encode(...).rstrip("="). */
export const b64 = (buf) => Buffer.from(buf).toString('base64url');
export const unb64 = (s) => Buffer.from(s, 'base64url');

const scrypt = (password, salt, N, r, p) =>
  scryptSync(Buffer.from(password, 'utf8'), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });

export function hashPassword(password, salt = randomBytes(16)) {
  const dk = scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return { algo: 'scrypt', n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: b64(salt), hash: b64(dk) };
}

export function verifyPassword(password, record) {
  if (!record || record.algo !== 'scrypt') return false;
  let dk, want;
  try {
    dk = scrypt(password, unb64(record.salt), Number(record.n), Number(record.r), Number(record.p));
    want = unb64(record.hash);
  } catch {
    return false;
  }
  return dk.length === want.length && timingSafeEqual(dk, want);
}

const now = () => Date.now() / 1000;
// Which version of the file: every save renames a new one into place, so its
// inode tells even two saves in the same clock tick apart.
const mtimeOf = (path) => { try { const st = statSync(path); return `${st.ino}:${st.mtimeMs}:${st.size}`; } catch { return null; } };

export class Auth {
  /**
   * @param {string} path  the auth file: DVARIM_AUTH_FILE, or <root>/.dvarim/auth.json
   */
  constructor(path, data) {
    this.path = path;
    this.data = data;
  }

  static load(root, override = process.env.DVARIM_AUTH_FILE) {
    const path = override || join(root, '.dvarim', 'auth.json');
    const data = { password: null, secret: b64(randomBytes(32)), tokens: {} };
    if (existsSync(path)) {
      try {
        Object.assign(data, JSON.parse(readFileSync(path, 'utf8')));
      } catch { /* unreadable: start from the defaults, as the Python does */ }
    }
    const auth = new Auth(path, data);
    if (!existsSync(path)) auth.save();
    else auth._mtime = mtimeOf(path);
    return auth;
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path.replace(/\.json$/u, '') + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    this._mtime = mtimeOf(this.path);
  }

  /** Read the file again if someone else wrote it (cli.js, while the server
   *  runs): a token added there works at once, a password set there counts. */
  refresh() {
    const m = mtimeOf(this.path);
    if (m === null || m === this._mtime) return;
    try {
      this.data = { password: null, secret: this.data.secret, tokens: {}, ...JSON.parse(readFileSync(this.path, 'utf8')) };
      this._mtime = m;
    } catch { /* half-written: the next request reads it */ }
  }

  /** Tokens as a list, without their hashes: the owner's, or (who) a person's. */
  tokenList(who = null) {
    return Object.entries(this._tokens(who)).map(([name, rec]) => ({ name, created: (rec && rec.created) || null }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  _tokens(who) {
    if (who === null) return (this.data.tokens = this.data.tokens || {});
    const p = this.person(who);
    if (!p) throw new Error(`no such person: ${who}`);
    return (p.tokens = p.tokens || {});
  }

  /** No password set means no login. Fine on a tailnet, not on the internet. */
  get enabled() {
    return !!this.data.password;
  }

  setPassword(password) {
    if ([...password].length < 8) throw new Error('use at least 8 characters');
    this.data.password = hashPassword(password);
    this.save();
  }

  clearPassword() {
    this.data.password = null;
    this.save();
  }

  /** Invalidates every session cookie in existence. */
  rotateSecret() {
    this.data.secret = b64(randomBytes(32));
    this.save();
  }

  /** Signs the owner out everywhere, and nobody else. */
  endOwnerSessions() {
    this.data.ownerEpoch = (this.data.ownerEpoch || 0) + 1;
    this.save();
  }

  // ---- other people

  /** The name the owner signs in with, if they gave one: nobody else may take it. */
  get ownerName() {
    return this.data.ownerName || null;
  }

  setOwnerName(name) {
    name = String(name || '').trim();
    if (name && !PERSON_NAME.test(name)) throw new Error(NAME_RULE);
    if (name && this.person(personKey(name))) throw new Error(`${name} is already someone else's name`);
    this.data.ownerName = name || null;
    this.save();
  }

  person(key) {
    const people = this.data.people || {};
    return Object.prototype.hasOwnProperty.call(people, key) ? people[key] : null;
  }

  /** Everyone but the owner: [{name, display, created}]. */
  people() {
    return Object.entries(this.data.people || {}).map(([name, p]) => ({ name, display: p.display || name, created: p.created || null }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** A new person, from the name they chose. Returns their key, the name in
   *  lower case, which is also their folder's name. */
  addPerson(display, password) {
    display = String(display || '').trim().replace(/\s+/gu, ' ');
    if (!PERSON_NAME.test(display)) throw new Error(NAME_RULE);
    const key = personKey(display);
    if (RESERVED.has(key) || this.person(key) || (this.ownerName && personKey(this.ownerName) === key)) {
      throw Object.assign(new Error(`the name ${display} is taken`), { taken: true });
    }
    if ([...String(password)].length < 8) throw new Error('use at least 8 characters');
    this.data.people = this.data.people || {};
    // `uid` is this account and no other: a cookie of someone removed names
    // the same key as the next person to choose that name, and must not let
    // them in
    this.data.people[key] = { display, uid: b64(randomBytes(9)), password: hashPassword(password), created: Math.floor(now()), epoch: 0, tokens: {} };
    this.save();
    return key;
  }

  removePerson(key) {
    if (!this.person(key)) return false;
    delete this.data.people[key];
    this.save();
    return true;
  }

  verifyPerson(key, password) {
    const p = this.person(key);
    return !!p && verifyPassword(password, p.password);
  }

  /** A person's new password signs them out everywhere else, and nobody else. */
  setPersonPassword(key, password) {
    const p = this.person(key);
    if (!p) throw new Error(`no such person: ${key}`);
    if ([...String(password)].length < 8) throw new Error('use at least 8 characters');
    p.password = hashPassword(password);
    p.epoch = (p.epoch || 0) + 1;
    this.save();
  }

  // ---- invitations: a link the owner hands someone, good once, for a week

  addInvite(note = '', days = INVITE_DAYS) {
    const code = b64(randomBytes(18));
    const id = createHash('sha256').update(code).digest('hex');
    const created = Math.floor(now());
    this.data.invites = this.data.invites || {};
    this.data.invites[id] = { note: String(note || '').trim().slice(0, 60), created, expires: created + days * 86400 };
    this.save();
    return { id: id.slice(0, 12), code, expires: created + days * 86400 };
  }

  /** The ones still good, without what would let anyone use them. */
  invites() {
    const t = now();
    return Object.entries(this.data.invites || {}).filter(([, r]) => r.expires > t)
      .map(([id, r]) => ({ id: id.slice(0, 12), note: r.note || '', created: r.created, expires: r.expires }))
      .sort((a, b) => a.created - b.created);
  }

  /** The invitation a code is, if it is still good: {note, expires}, or null. */
  findInvite(code) {
    const id = createHash('sha256').update(String(code || '')).digest('hex');
    const r = (this.data.invites || {})[id];
    return r && r.expires > now() ? { note: r.note || '', expires: r.expires } : null;
  }

  /** Used up: gone, along with any that have lapsed. */
  useInvite(code) {
    const id = createHash('sha256').update(String(code || '')).digest('hex');
    const t = now();
    for (const [k, r] of Object.entries(this.data.invites || {})) if (k === id || r.expires <= t) delete this.data.invites[k];
    this.save();
  }

  cancelInvite(shortId) {
    const k = Object.keys(this.data.invites || {}).find((x) => x.slice(0, 12) === shortId);
    if (!k) return false;
    delete this.data.invites[k];
    this.save();
    return true;
  }

  // ---- tokens, for bots

  /** A bearer token for a bot or a device: the owner's, or (who) a person's.
   *  Returned once; only its hash is kept. */
  addToken(name, who = null) {
    const token = 'dvt_' + b64(randomBytes(32));
    const digest = createHash('sha256').update(token).digest('hex');
    this._tokens(who)[name] = { hash: digest, created: Math.floor(now()) };
    this.save();
    return token;
  }

  removeToken(name, who = null) {
    const tokens = this._tokens(who);
    if (!(name in tokens)) return false;
    delete tokens[name];
    this.save();
    return true;
  }

  tokenNames() {
    return Object.keys(this.data.tokens || {}).sort();
  }

  /** The owner's token's name, or null. */
  checkToken(token) {
    const hit = this.tokenWho(token);
    return hit && hit.who === null ? hit.name : null;
  }

  /** Whose a token is: {who: null for the owner or a person's key, name}, or null. */
  tokenWho(token) {
    const digest = Buffer.from(createHash('sha256').update(token).digest('hex'));
    const match = (tokens) => {
      for (const [name, rec] of Object.entries(tokens || {})) {
        const want = Buffer.from(String((rec && rec.hash) || ''));
        if (want.length === digest.length && timingSafeEqual(digest, want)) return name;
      }
      return null;
    };
    const own = match(this.data.tokens);
    if (own !== null) return { who: null, name: own };
    for (const [key, p] of Object.entries(this.data.people || {})) {
      const name = match(p.tokens);
      if (name !== null) return { who: key, name };
    }
    return null;
  }

  // ---- sessions

  _secret() {
    return unb64(this.data.secret);
  }

  /** The owner's (who null) or a person's. The owner's says nobody, as every
   *  cookie did before there were other people, so those are still good. */
  issueSession(days = SESSION_DAYS, who = null) {
    const iat = Math.floor(now());
    const payload = { iat, exp: iat + days * 86400 };
    if (who !== null) Object.assign(payload, { who, uid: this.person(who).uid, ep: this.person(who).epoch || 0 });
    else if (this.data.ownerEpoch) payload.ep = this.data.ownerEpoch;
    // json.dumps(payload, separators=(",", ":")): the Python's bytes, exactly
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = createHmac('sha256', this._secret()).update(raw).digest();
    return `${b64(raw)}.${b64(sig)}`;
  }

  /** Whose a session cookie is: null for the owner, a person's key, or
   *  undefined when it is no good (forged, expired, signed out, removed). */
  sessionWho(cookie) {
    if (!cookie || !cookie.includes('.')) return undefined;
    const i = cookie.indexOf('.');
    const body = cookie.slice(0, i), sig = cookie.slice(i + 1);
    try {
      const raw = unb64(body);
      const expected = createHmac('sha256', this._secret()).update(raw).digest();
      const given = unb64(sig);
      if (given.length !== expected.length || !timingSafeEqual(expected, given)) return undefined;
      const payload = JSON.parse(raw.toString('utf8'));
      if (!(Number(payload.exp || 0) > now())) return undefined;
      if (payload.who) {
        const p = this.person(String(payload.who));
        return p && payload.uid === p.uid && Number(payload.ep || 0) === (p.epoch || 0) ? String(payload.who) : undefined;
      }
      return Number(payload.ep || 0) === (this.data.ownerEpoch || 0) ? null : undefined;
    } catch {
      return undefined;
    }
  }

  /** The owner's session, still good. */
  checkSession(cookie) {
    return this.sessionWho(cookie) === null;
  }

  verify(password) {
    return verifyPassword(password, this.data.password || {});
  }
}

/** Per-client backoff on failed logins. In memory: a restart forgives, which
 *  is right for a single-user app that must not lock its owner out. */
export class Throttle {
  constructor() {
    this.state = new Map();
  }

  retryAfter(key) {
    const [, until] = this.state.get(key) || [0, 0];
    return Math.max(0, until - now());
  }

  recordFailure(key) {
    let [fails] = this.state.get(key) || [0, 0];
    fails += 1;
    const over = fails - LOCKOUT_FREE_ATTEMPTS;
    const delay = over <= 0 ? 0 : Math.min(LOCKOUT_MAX_SECONDS, LOCKOUT_BASE_SECONDS * 2 ** (over - 1));
    this.state.set(key, [fails, now() + delay]);
    return delay;
  }

  clear(key) {
    this.state.delete(key);
  }
}
