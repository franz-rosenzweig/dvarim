// The Dvarim server on the engine: what backend/dvarim/api.py was, in Node.
//
// Every route the app calls is the engine's router (engine/src/api.js),
// already held to the Python answer for answer. What only a server does is
// here: signing in, the event stream, the app's own files, Android's asset
// links, and the services the router is handed (calendars, reminders, the
// to-do mirror). Writes reach the disk before a request is answered, as they
// did before.
//
// The owner's folder is DVARIM_ROOT, as it always was. People the owner
// invites each get a folder of their own (people.js), and every request goes
// to the folder of whoever made it: a session or a token says who.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { Store } from '../../engine/src/store.js';
import { NodeStorage } from '../../engine/src/storage-node.js';
import { Api } from '../../engine/src/api.js';
import { Auth, SESSION_COOKIE, SESSION_DAYS, Throttle, personKey } from './auth.js';
import { Dav, DAV_PREFIX } from './dav.js';
import { Household, Requests, Refused } from './people.js';
import { zip, folderEntries } from './zip.js';

// Endpoints that must work before you are signed in. /api/join/<code> too.
const PUBLIC_API = new Set(['/api/login', '/api/auth', '/api/health', '/api/join', '/api/requests']);
const MAX_BODY = 8 * 1024 * 1024;
export const KEEP_ALIVE_MS = 120000;

// index.html names the hashed bundles, so a stale copy of it pins the whole
// app to an old build: the shell, the service worker and the manifest are
// always asked for again, and the bundles, whose names change whenever they
// do, never need asking about again (as api.py).
const REVALIDATE = { 'Cache-Control': 'no-cache' };
const FOREVER = { 'Cache-Control': 'public, max-age=31536000, immutable' };
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json', '.wasm': 'application/wasm',
};

function send(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers });
  res.end(data);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim().replace(/^"|"$/gu, ''));
  }
  return out;
}

/** The name the browser used. cloudflared sets these; only the tunnel and the
 *  tailnet reach this process, so trusting them is fine. */
const effectiveHost = (req) => String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';

/** A request that changes something, made for you by a page on another site,
 *  is refused. SameSite=Strict already keeps the cookie off it; this is the
 *  belt to those braces. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                          // not a browser, or a same-origin GET
  try {
    return new URL(origin).host.toLowerCase() === effectiveHost(req);
  } catch {
    return false;
  }
}

function clientKey(req) {
  const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '';
  const ip = fwd ? String(fwd).split(',')[0].trim() : (req.socket && req.socket.remoteAddress);
  return ip || '?';
}

function sessionCookie(value, req) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Max-Age=${SESSION_DAYS * 86400}; Path=/; SameSite=strict${isHttps(req) ? '; Secure' : ''}`;
}

function readRaw(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readBody = async (req) => (await readRaw(req)).toString('utf8');

// WebDAV answers any page that holds a token: a device's own copy of the app
// (the Mac's, Android's) is another origin. No cookie crosses sites (SameSite
// =Strict, and a cookie is taken only from this site's own pages), so a page
// elsewhere can reach nothing without one.
const DAV_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'ETag, DAV, Content-Length',
};
const DAV_PREFLIGHT = {
  ...DAV_CORS,
  'Access-Control-Allow-Methods': 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, If-Match, If-None-Match',
  'Access-Control-Max-Age': '600',
};

/** body(): the request's JSON object, or {} for anything else (api.py). */
function jsonObject(text) {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * @param {object} cfg
 * @param {string} cfg.root          the data folder
 * @param {string} [cfg.staticDir]   the built app
 * @param {string} [cfg.authFile]    DVARIM_AUTH_FILE
 * @param {{vault: string, prefix: string}|null} [cfg.obsidian]
 * @param {object} [cfg.services]    for the router: events, calendars, reminders, tasksync
 * @param {{package: string, fingerprints: string[]}} [cfg.android] `package` may
 *   name several, comma-separated: an app that moved to a new id, beside the old
 * @param {boolean} [cfg.mergeArrivals]  DVARIM_MERGE_ARRIVALS: see Store
 * @param {(r: {name: string, email: string, message: string}) => any} [cfg.onRequest]
 *   someone asked for an account: tell the owner (main.js: over Signal)
 * @param {boolean} [cfg.tutorial]  an empty folder starts with "Meet Dvarim" (default yes)
 * @param {string} [cfg.peopleRoot]  DVARIM_PEOPLE: other people's folders, beside
 *   the auth file unless said; never inside the owner's folder
 * @param {(e: Error) => void} [cfg.log]
 */
export async function createApp(cfg) {
  const log = cfg.log || ((...a) => console.error(...a));
  const storage = new NodeStorage(cfg.root);
  const store = await Store.open(storage, {
    obsidian: cfg.obsidian || null,
    mergeArrivals: !!cfg.mergeArrivals,
    // Obsidian saves every couple of seconds while someone types: the server
    // writes on its own account only into files quiet this long (Store.quietMs)
    quietMs: cfg.quietMs ?? 30000,
    tutorial: cfg.tutorial ?? true,         // a new server's empty folder starts with "Meet Dvarim"
    now: cfg.now,
    today: cfg.today,
    onWriteError: (e, op) => log(`could not write ${op.path || op.from}: ${e && e.message}`),
  });
  await store.flush();
  const auth = Auth.load(cfg.root, cfg.authFile);
  const throttle = new Throttle();
  const services = cfg.services || {};
  const api = new Api(store, services);
  const staticDir = cfg.staticDir ? resolve(cfg.staticDir) : null;
  const streams = new Set();

  const dav = new Dav(store);
  const owner = { folder: resolve(cfg.root), store, api, dav };

  // Other people's folders: beside the auth file (outside the owner's folder,
  // which Syncthing and Obsidian see), unless DVARIM_PEOPLE says otherwise.
  // Inside the owner's folder there are none, rather than their to-dos
  // landing on the owner's devices.
  const peopleRoot = resolve(cfg.peopleRoot || join(dirname(auth.path), 'people'));
  const household = peopleRoot === owner.folder || peopleRoot.startsWith(owner.folder + sep) ? null
    : new Household(peopleRoot, { now: cfg.now, today: cfg.today, onWriteError: (e, op) => log(`could not write ${op.path || op.from}: ${e && e.message}`) });
  const peopleOff = () => (!auth.enabled ? 'set a password first: other people need you to have one'
    : !household ? 'other people need a folder outside yours: set DVARIM_PEOPLE' : null);
  // Requests for an account, from the sign-in page: beside auth.json, apart from it
  const requests = new Requests(join(dirname(auth.path), 'requests.json'));
  const heard = cfg.onRequest || null;

  /** Whose request this is: null for the owner, a person's key, or undefined
   *  for nobody signed in. A token or a session says; with no password set
   *  there are no other people, and everyone is the owner. */
  const identify = (req) => {
    auth.refresh();
    if (!auth.enabled) return null;
    const header = String(req.headers.authorization || '');
    if (header.toLowerCase().startsWith('bearer ')) {
      const hit = auth.tokenWho(header.slice(7).trim());
      if (hit) return known(hit.who);
    }
    return known(auth.sessionWho(cookies(req)[SESSION_COOKIE]));
  };
  /** A person counts only while there is somewhere to keep their to-dos. */
  const known = (who) => (who === null || who === undefined ? who : household ? who : undefined);
  /** Signed in with a password, not a token: a token cannot make more. */
  const sessionOf = (req) => { auth.refresh(); return !auth.enabled ? null : known(auth.sessionWho(cookies(req)[SESSION_COOKIE])); };
  const contextOf = (who) => (who === null ? owner : household.get(who));
  // a person's uid names their account, and no other (a name can be taken again)
  const personInfo = (who) => (who === null
    ? { name: auth.ownerName, owner: true }
    : { name: (auth.person(who) || {}).display || who, owner: false, uid: (auth.person(who) || {}).uid });

  /** WebDAV: a token, as a bearer or as Basic auth's password (the name is
   *  not asked about), or this site's own cookie. Never the password itself.
   *  Whose, as identify() says, or undefined. */
  const davWho = (req) => {
    auth.refresh();
    if (!auth.enabled) return null;
    const header = String(req.headers.authorization || '');
    const lower = header.toLowerCase();
    const token = (t) => { const hit = auth.tokenWho(t); return hit ? known(hit.who) : undefined; };
    if (lower.startsWith('bearer ')) return token(header.slice(7).trim());
    if (lower.startsWith('basic ')) {
      const pair = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      return token(pair.slice(pair.indexOf(':') + 1));
    }
    return sameOrigin(req) ? known(auth.sessionWho(cookies(req)[SESSION_COOKIE])) : undefined;
  };

  async function serveDav(req, res, path, method) {
    if (method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, DAV_PREFLIGHT);
      return res.end();
    }
    const key = clientKey(req);
    const wait = throttle.retryAfter(key);
    if (wait > 0) {
      res.writeHead(429, { ...DAV_CORS, 'Retry-After': String(Math.floor(wait) + 1), 'Content-Type': 'text/plain' });
      return res.end('too many attempts');
    }
    const who = davWho(req);
    if (who === undefined) {
      if (req.headers.authorization) throttle.recordFailure(key);
      res.writeHead(401, { ...DAV_CORS, 'WWW-Authenticate': 'Basic realm="Dvarim", charset="UTF-8"', 'Content-Type': 'text/plain' });
      return res.end('a token is needed: Settings → Sync on the server makes one');
    }
    let rel;
    try { rel = decodeURIComponent(path.slice(DAV_PREFIX.length)); } catch { rel = null; }
    if (rel === null) { res.writeHead(400, DAV_CORS); return res.end(); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    const out = await (await contextOf(who)).dav.handle(method, rel, headers, () => readRaw(req));
    const body = out.body === undefined ? null : Buffer.from(out.body, 'utf8');
    res.writeHead(out.status, {
      ...DAV_CORS, 'Cache-Control': 'no-store', ...(out.headers || {}),
      ...(body ? { 'Content-Length': body.length } : out.length !== undefined ? { 'Content-Length': out.length } : {}),
      ...(body && !(out.headers && out.headers['Content-Type']) ? { 'Content-Type': 'text/plain; charset=utf-8' } : {}),
    });
    return res.end(body || undefined);
  }

  /** Tokens for the devices that sync with this server, made and revoked
   *  from Settings, each person their own. Only a signed-in person may: a
   *  token cannot make more. */
  async function tokens(req, res, path, method) {
    const who = sessionOf(req);
    if (who === undefined) return send(res, 403, { error: 'sign in with the password to manage devices' });
    if (path === '/api/tokens' && method === 'GET') return send(res, 200, { tokens: auth.tokenList(who) });
    if (path === '/api/tokens' && method === 'POST') {
      const name = String(jsonObject(await readBody(req)).name ?? '').trim();
      if (!/^[\p{L}\p{N} ._'’()-]{1,40}$/u.test(name)) return send(res, 400, { error: 'give the device a name: letters, digits and spaces, up to 40' });
      if (auth.tokenList(who).some((t) => t.name === name)) return send(res, 409, { error: `there is already a device called ${name}` });
      return send(res, 200, { name, token: auth.addToken(name, who) });
    }
    const m = /^\/api\/tokens\/(.+)$/u.exec(path);
    if (m && method === 'DELETE') {
      let name;
      try { name = decodeURIComponent(m[1]); } catch { return send(res, 400, { error: 'bad name' }); }
      return send(res, 200, { removed: auth.removeToken(name, who) });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  // ---- other people: the owner invites them, and can remove them

  /** The page's own address, for a link to send someone. */
  const origin = (req) => `${isHttps(req) ? 'https' : 'http'}://${effectiveHost(req)}`;

  async function people(req, res, path, method) {
    if (sessionOf(req) !== null || !auth.enabled) {
      return send(res, 403, { error: auth.enabled ? 'only the owner can manage who uses this server' : peopleOff() });
    }
    const off = peopleOff();
    if (path === '/api/people' && method === 'GET') {
      return send(res, 200, { enabled: !off, ...(off ? { reason: off } : {}), owner: personInfo(null), people: auth.people(),
        invites: auth.invites(), requests: requests.list() });
    }
    let r = /^\/api\/people\/requests\/([0-9a-f]{12})(\/invite)?$/u.exec(path);
    if (r && method === 'DELETE' && !r[2]) return send(res, 200, { removed: requests.remove(r[1]) });
    if (r && method === 'POST' && r[2]) {
      if (off) return send(res, 400, { error: off });
      const ask = requests.get(r[1]);
      if (!ask) return send(res, 404, { error: 'that request has been answered already' });
      const inv = auth.addInvite(ask.name);
      requests.remove(ask.id);
      return send(res, 200, { ...inv, link: `${origin(req)}/join/${inv.code}`, name: ask.name, email: ask.email });
    }
    if (path === '/api/people/owner' && method === 'PUT') {
      try { auth.setOwnerName(jsonObject(await readBody(req)).name); } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 200, personInfo(null));
    }
    if (off) return send(res, 400, { error: off });
    if (path === '/api/people/invites' && method === 'POST') {
      const inv = auth.addInvite(jsonObject(await readBody(req)).note);
      return send(res, 200, { ...inv, link: `${origin(req)}/join/${inv.code}` });
    }
    let m = /^\/api\/people\/invites\/([0-9a-f]{12})$/u.exec(path);
    if (m && method === 'DELETE') return send(res, 200, { removed: auth.cancelInvite(m[1]) });
    // a forgotten password: the owner sets one to pass on, which signs them out everywhere
    m = /^\/api\/people\/([^/]+)\/password$/u.exec(path);
    if (m && method === 'POST') {
      let key;
      try { key = decodeURIComponent(m[1]); } catch { return send(res, 400, { error: 'bad name' }); }
      if (!auth.person(key)) return send(res, 404, { error: `nobody called ${key}` });
      try { auth.setPersonPassword(key, String(jsonObject(await readBody(req)).password ?? '')); } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 200, { ok: true });
    }
    m = /^\/api\/people\/([^/]+)$/u.exec(path);
    if (m && method === 'DELETE') {
      let key;
      try { key = decodeURIComponent(m[1]); } catch { return send(res, 400, { error: 'bad name' }); }
      if (!auth.person(key)) return send(res, 404, { error: `nobody called ${key}` });
      auth.removePerson(key);                            // signed out at once: their cookies name nobody now
      const away = await household.remove(key);
      return send(res, 200, { removed: true, keptAt: away ? away.slice(household.root.length + 1) : null });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  /** Joining with an invitation: GET says whether the link is still good,
   *  POST makes the account, its folder and a session, in one go. */
  async function acceptInvite(req, res, path, method) {
    const key = clientKey(req);
    const wait = throttle.retryAfter(key);
    if (wait > 0) return send(res, 429, { error: `too many attempts; try again in ${Math.floor(wait) + 1}s` }, { 'Retry-After': String(Math.floor(wait) + 1) });
    const off = peopleOff();
    const gone = () => { throttle.recordFailure(key); return send(res, 404, { error: 'this invitation has been used or has expired; ask for a new one' }); };
    const m = /^\/api\/join\/([A-Za-z0-9_-]{8,64})$/u.exec(path);
    if (m && method === 'GET') {
      if (off) return send(res, 400, { error: off });
      const inv = auth.findInvite(m[1]);
      return inv ? send(res, 200, { ok: true, note: inv.note, expires: inv.expires }) : gone();
    }
    if (path !== '/api/join' || method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    if (off) return send(res, 400, { error: off });
    const data = jsonObject(await readBody(req));
    const code = String(data.code ?? '');
    if (!auth.findInvite(code)) return gone();
    let who;
    try {
      who = auth.addPerson(String(data.name ?? ''), String(data.password ?? ''));
    } catch (e) {
      return send(res, e.taken ? 409 : 400, { error: e.message });
    }
    auth.useInvite(code);
    await household.create(who);
    return send(res, 200, { authenticated: true, required: true, person: personInfo(who) },
      { 'Set-Cookie': sessionCookie(auth.issueSession(SESSION_DAYS, who), req) });
  }

  /** Asking for an account, signed out: GET says whether one can, POST asks.
   *  A bot that fills the field people never see is told yes, and nothing is
   *  kept. The owner hears through cfg.onRequest (Signal, when it is set up),
   *  and in the app. */
  async function askForAccount(req, res, method) {
    const open = !peopleOff();
    if (method === 'GET') return send(res, 200, { open });
    if (method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    if (!open) return send(res, 404, { error: 'this server is not taking requests' });
    const data = jsonObject(await readBody(req));
    if (String(data.website ?? '').trim()) return send(res, 200, { ok: true });
    let made;
    try {
      made = requests.add(data, clientKey(req));
    } catch (e) {
      if (e instanceof Refused) return send(res, e.status, { error: e.message });
      throw e;
    }
    if (heard) Promise.resolve().then(() => heard(made)).catch((e) => log(`could not pass on a request: ${e && e.message}`));
    return send(res, 200, { ok: true });
  }

  /** Everything in one's own folder, as a .zip. */
  async function exportFiles(res, who) {
    const ctx = await contextOf(who);
    await ctx.store.flush();
    const data = zip(folderEntries(ctx.folder, 'Dvarim'));
    const day = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/zip', 'Content-Length': data.length, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="Dvarim ${day}.zip"`,
    });
    res.end(data);
  }

  // ---- signing in

  async function login(req, res) {
    if (!auth.enabled) return send(res, 200, { authenticated: true, required: false });
    const key = clientKey(req);
    const wait = throttle.retryAfter(key);
    if (wait > 0) {
      return send(res, 429, { error: `too many attempts; try again in ${Math.floor(wait) + 1}s` }, { 'Retry-After': String(Math.floor(wait) + 1) });
    }
    const data = jsonObject(await readBody(req));
    // A name someone has is theirs to sign in with. No name, the owner's own,
    // or a name nobody has: the owner's password, as it was before there was
    // anyone else.
    const name = personKey(String(data.name ?? ''));
    const password = String(data.password ?? '');
    let who;
    if (name && household && auth.person(name)) who = auth.verifyPerson(name, password) ? name : undefined;
    else who = auth.verify(password) ? null : undefined;
    if (who === undefined) {
      const delay = throttle.recordFailure(key);
      return send(res, 401, { error: name ? 'wrong name or password' : 'wrong password' }, { 'Retry-After': String(Math.floor(delay) + 1) });
    }
    throttle.clear(key);
    return send(res, 200, { authenticated: true, required: true, person: personInfo(who) },
      { 'Set-Cookie': sessionCookie(auth.issueSession(SESSION_DAYS, who), req) });
  }

  /** Change one's password from the app: one's other devices are signed
   *  out, nobody else's, and this one gets a fresh cookie so the person
   *  doing it stays in. */
  async function changePassword(req, res, who) {
    if (!auth.enabled) return send(res, 400, { error: 'no password is set; use the command line to set one' });
    const data = jsonObject(await readBody(req));
    const key = clientKey(req);
    const wait = throttle.retryAfter(key);
    if (wait > 0) return send(res, 429, { error: `too many attempts; try again in ${Math.floor(wait) + 1}s` });
    const current = String(data.currentPassword ?? '');
    if (!(who === null ? auth.verify(current) : auth.verifyPerson(who, current))) {
      throttle.recordFailure(key);
      return send(res, 403, { error: 'that is not the current password' });
    }
    try {
      if (who === null) auth.setPassword(String(data.newPassword ?? ''));
      else auth.setPersonPassword(who, String(data.newPassword ?? ''));
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    throttle.clear(key);
    if (who === null) auth.endOwnerSessions();
    return send(res, 200, { ok: true, signedOutOtherDevices: true }, { 'Set-Cookie': sessionCookie(auth.issueSession(SESSION_DAYS, who), req) });
  }

  // ---- the event stream: what the Python pushed from its watcher

  function stream(req, res, ctx) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('event: hello\ndata: {}\n\n');
    const stop = ctx.api.subscribe((paths) => res.write(`event: changed\ndata: ${JSON.stringify({ files: paths })}\n\n`));
    const alive = setInterval(() => res.write(': keepalive\n\n'), 20000);
    const entry = { res, stop, alive };
    streams.add(entry);
    req.on('close', () => { clearInterval(alive); stop(); streams.delete(entry); });
  }

  // ---- the app's own files

  function serveStatic(req, res, pathname) {
    const head = req.method === 'HEAD';
    if (!staticDir) return send(res, 404, { error: 'frontend not built; run frontend/build.sh' });
    let rel;
    try { rel = decodeURIComponent(pathname).replace(/^\/+/u, ''); } catch { rel = ''; }
    const file = (p, headers) => {
      const st = statSync(p);
      res.writeHead(200, { 'Content-Type': TYPES[extname(p).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, ...headers });
      if (head) return res.end();
      createReadStream(p).pipe(res);
      return undefined;
    };
    if (rel) {
      const target = resolve(staticDir, rel);
      let isFile = false;
      try { isFile = statSync(target).isFile(); } catch { /* not there */ }
      if (isFile && target.startsWith(staticDir + sep)) return file(target, rel.startsWith('assets/') ? FOREVER : REVALIDATE);
    }
    const index = join(staticDir, 'index.html');
    try {
      if (statSync(index).isFile()) return file(index, REVALIDATE);
    } catch { /* fall through */ }
    return send(res, 404, { error: 'frontend not built; run frontend/build.sh' });
  }

  /** Digital Asset Links: how Android checks that the installed app belongs
   *  to this site (android/README.md). */
  function assetlinks(res) {
    const a = cfg.android || {};
    const names = String(a.package || '').split(',').map((n) => n.trim()).filter(Boolean);
    if (!names.length || !(a.fingerprints || []).length) return send(res, 200, [], { 'Cache-Control': 'no-store' });
    return send(res, 200, names.map((name) => ({
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: name, sha256_cert_fingerprints: a.fingerprints },
    })), { 'Cache-Control': 'max-age=300' });
  }

  // ---- every request

  async function handle(req, res) {
    // "//" first would be read as the start of a host name, and throw
    const url = new URL(String(req.url || '/').replace(/^\/{2,}/u, '/'), 'http://local');
    const path = url.pathname;
    const method = (req.method || 'GET').toUpperCase();
    if (path.startsWith('/api/')) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !sameOrigin(req)) {
        return send(res, 403, { error: 'cross-site request refused' });
      }
      if (path === '/api/join' || path.startsWith('/api/join/')) return acceptInvite(req, res, path, method);
      if (path === '/api/requests') return askForAccount(req, res, method);
      const who = identify(req);
      if (!PUBLIC_API.has(path) && who === undefined) return send(res, 401, { error: 'not signed in' });
      if (path === '/api/auth' && method === 'GET') {
        const waiting = who === null && auth.enabled ? requests.list().length : 0;
        return send(res, 200, { required: auth.enabled, authenticated: who !== undefined,
          ...(auth.enabled && who !== undefined ? { person: personInfo(who) } : {}), ...(waiting ? { requests: waiting } : {}) });
      }
      if (path === '/api/login' && method === 'POST') return login(req, res);
      if (path === '/api/logout' && method === 'POST') {
        return send(res, 200, { authenticated: false }, { 'Set-Cookie': `${SESSION_COOKIE}=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/` });
      }
      if (path === '/api/password' && method === 'POST') return changePassword(req, res, who);
      if (path === '/api/tokens' || path.startsWith('/api/tokens/')) return tokens(req, res, path, method);
      if (path === '/api/people' || path.startsWith('/api/people/')) return people(req, res, path, method);
      if (path === '/api/export' && method === 'GET') return exportFiles(res, who);
      const ctx = await contextOf(who === undefined ? null : who);   // nobody: only what is public, /api/health
      if (path === '/api/stream' && method === 'GET') return stream(req, res, ctx);
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? jsonObject(await readBody(req)) : undefined;
      const out = await ctx.api.handle(method, path + url.search, body);
      await ctx.store.flush();              // on disk before the answer, as the Python wrote
      if (out.status >= 500) log(`${method} ${path}: ${out.body && out.body.error}`);
      return send(res, out.status, out.body);
    }
    if (path === '/dav' || path.startsWith(DAV_PREFIX)) return serveDav(req, res, path === '/dav' ? DAV_PREFIX : path, method);
    if (path === '/.well-known/assetlinks.json' && (method === 'GET' || method === 'HEAD')) return assetlinks(res);
    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, path);
    return send(res, 405, { error: 'method not allowed' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`${req.method} ${req.url}:`, e);
      if (!res.headersSent) send(res, e.status || 500, { error: e.status === 413 ? 'request too large' : 'internal error' });
      else res.end();
    });
  });
  // An idle connection is kept longer than the tunnel in front keeps its own
  // (cloudflared: 90 s). With Node's 5 s, the tunnel sometimes sent a request
  // down a connection being closed and answered 502, which the app takes for
  // being offline: an edit waited in the outbox for no reason.
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 5000;

  return {
    server, store, auth, api, household,
    listen(port, host) {
      return new Promise((ok) => server.listen(port, host, () => ok(server.address())));
    },
    async close() {
      for (const s of streams) { clearInterval(s.alive); s.stop(); s.res.end(); }
      streams.clear();
      await new Promise((ok) => server.close(() => ok()));
      await store.flush();
      if (household) await household.close();
    },
  };
}
