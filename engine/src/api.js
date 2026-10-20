// The API, answered by the engine: every route in docs/API.md that the app
// calls, as backend/dvarim/api.py answers it, but without a server. The page's
// request function hands its (method, path, body) here when there is no server
// to ask — each device with its own copy of the vault — and the Node server
// (phase 5) will put this same router behind HTTP.
//
// What only a server can do is handed in, and has a quiet answer when it is
// not: signing in (there is nobody to keep out of a vault on your own device),
// calendars from CalDAV, the VTODO mirror, reminders over Signal.
import { Conflict, Invalid, NotFound } from './errors.js';
import * as dates from './dates.js';
import * as repeat from './repeat.js';
import * as views from './views.js';
import { Day } from './day.js';
import { obsidianUrl, readText } from './store.js';
import { sha1 } from './sha1.js';
import { pyInt, pyList, pyRepr, pyStr, truthy } from './util.js';

const get = (o, k, d = null) => (o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);

/** A reply: what a server would have sent, status and all. */
const reply = (status, body) => ({ status, body });
const ok = (body) => reply(200, body);


export class Api {
  /**
   * @param {import('./store.js').Store} store
   * @param {object} [services]
   * @param {(from: string, to: string, calendars: string[]|null) => Promise<object[]>} [services.events]
   * @param {() => Promise<object>} [services.calendars]   the answer to GET /calendars
   * @param {() => object} [services.reminders]              the answer to GET /reminders/log
   * @param {{enabled: boolean, status: () => object, run: () => Promise<object>}} [services.tasksync]
   */
  constructor(store, services = {}) {
    this.store = store;
    this.services = services;
  }

  /** Every route, as the server's: an answer, never a throw. */
  async handle(method, path, body) {
    const url = new URL(path, 'http://local');
    const p = url.pathname.replace(/^\/api(?=\/)/u, '');
    const query = Object.fromEntries(url.searchParams);
    const data = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
    try {
      return await this.route(method.toUpperCase(), p, query, data);
    } catch (e) {
      if (e instanceof NotFound) return reply(404, { error: `not found: ${pyRepr(e.message)}` })   // str(KeyError(x)) is repr(x);
      if (e instanceof Conflict) return reply(409, { error: e.message });
      if (e instanceof Invalid || e instanceof RangeError) return reply(400, { error: e.message });
      return reply(500, { error: `${e.name}: ${e.message}` });
    }
  }

  _weekStart() {
    // Settings count weeks the JavaScript way (0 = Sunday); the dates code, Python's.
    return (pyInt(get(this.store.getSettings(), 'weekStartsOn', 0)) + 6) % 7;
  }

  async _events(from, to) {
    const settings = this.store.getSettings();
    if (!get(settings, 'showCalendarEvents', true) || !this.services.events) return [];
    try {
      return await this.services.events(from, to, get(settings, 'calendars'));
    } catch {
      return [];
    }
  }

  async route(method, p, query, data) {
    const s = this.store;
    const GET = method === 'GET', POST = method === 'POST', PUT = method === 'PUT', PATCH = method === 'PATCH', DELETE = method === 'DELETE';
    let m;

    // ---- no server, so nobody to sign in: the answers a server with no password gives
    if (GET && p === '/health') return ok({ ok: true });
    if (GET && p === '/auth') return ok({ required: false, authenticated: true });
    if (POST && p === '/login') return ok({ authenticated: true, required: false });
    if (POST && p === '/logout') return ok({ authenticated: false });
    if (POST && p === '/password') return reply(400, { error: 'this vault is on this device; it has no password to change' });

    // ---- read
    if (GET && p === '/state') return ok(views.state(s));
    if (GET && (m = /^\/lists\/([a-z-]+)$/u.exec(p))) {
      const t = s.today();
      switch (m[1]) {
        case 'inbox': return ok(views.listInbox(s));
        case 'today': return ok(views.listToday(s, await this._events(t.iso(), t.iso())));
        case 'upcoming': return ok(views.listUpcoming(s, await this._events(t.addDays(1).iso(), t.addDays(365).iso())));
        case 'anytime': return ok(views.listAnytime(s));
        case 'someday': return ok(views.listSomeday(s));
        case 'logbook': {
          const limit = query.limit !== undefined ? pyInt(query.limit) : 200;
          return ok(views.listLogbook(s, limit, query.before || null));
        }
        case 'trash': return ok(views.listTrash(s));
        case 'tomorrow': {
          const d = t.addDays(1).iso();
          return ok(views.listTomorrow(s, await this._events(d, d)));
        }
        case 'deadlines': return ok(views.listDeadlines(s));
        case 'repeating': return ok(views.listRepeating(s));
        case 'projects': return ok(views.listProjects(s));
        case 'logged-projects': return ok(views.listProjects(s, true));
        default: return reply(404, { error: 'not found' });
      }
    }
    if (GET && (m = /^\/projects\/([^/]+)$/u.exec(p))) return ok(views.projectDetail(s, decodeURIComponent(m[1])));
    if (GET && (m = /^\/areas\/([^/]+)$/u.exec(p))) return ok(views.areaDetail(s, decodeURIComponent(m[1])));
    if (GET && p === '/tags') return ok(views.tags(s));
    if (GET && p === '/search') return ok(views.search(s, query.q || ''));
    if (GET && p === '/calendar') {
      const t = s.todayIso();
      return ok(await this._events(query.from_ || t, query.to || t));
    }
    // reminders and the to-do mirror are the server's (server/src): handed in, or quiet
    if (GET && p === '/reminders/log') {
      return ok(this.services.reminders ? this.services.reminders() : { configured: false, log: [] });
    }
    if (GET && p === '/tasksync') {
      if (this.services.tasksync) return ok(this.services.tasksync.status());
      return ok({ enabled: false, configured: false, reason: 'the to-do mirror runs on a server, and this vault is on this device' });
    }
    if (POST && p === '/tasksync') {
      if (this.services.tasksync && this.services.tasksync.enabled) return ok(await this.services.tasksync.run());
      return reply(400, { error: 'task sync is not enabled' });
    }
    if (GET && p === '/calendars') {
      if (this.services.calendars) return ok(await this.services.calendars());
      return ok({ configured: false, calendars: [] });
    }
    // what merging has done on this device (docs/SYNC.md): a local-mode route,
    // the server has no merging to report
    if (GET && p === '/sync') return ok({ log: [...s.syncLog].reverse() });
    if (GET && p === '/settings') return ok(s.getSettings());
    if (PUT && p === '/settings') return ok(s.putSettings(data));

    if (POST && p === '/parse-repeat') return ok(this._parseRepeat(data));
    if (POST && p === '/parse-date') {
      return ok(dates.suggest(pyStr(get(data, 'text', '')), s.today(), this._weekStart()));
    }

    // ---- to-dos
    if (POST && p === '/todos') return ok(s.createTodo(data));
    if ((m = /^\/todos\/([^/]+)(?:\/([a-z]+))?$/u.exec(p))) {
      const tid = decodeURIComponent(m[1]);
      const action = m[2];
      if (!action) {
        if (GET) { const [f, , t] = s.getTodo(tid); return ok(s.todoJson(t, f)); }
        if (PATCH) return ok(s.updateTodo(tid, data));
        if (DELETE) return ok(s.deleteTodo(tid));
      } else if (POST) {
        switch (action) {
          case 'complete': return ok(s.completeTodo(tid, get(data, 'on')));
          case 'cancel': return ok(s.cancelTodo(tid, get(data, 'on')));
          case 'reopen': return ok(s.reopenTodo(tid));
          case 'move': return ok(s.moveTodo(tid, data));
          case 'convert': return ok(s.convertTodo(tid, data));
          case 'duplicate': return ok(s.duplicateTodo(tid, data));
          case 'restore': return ok(s.restoreTodo(tid));
          default: break;
        }
      }
    }
    if (POST && p === '/reorder') {
      s.reorder(pyStr(get(data, 'context', '')), pyList(get(data, 'ids', [])));
      return ok({ ok: true });
    }
    if (POST && p === '/quick-add') return ok(this._quickAdd(data));

    // ---- projects and headings
    if (POST && p === '/projects') return ok(s.createProject(data));
    if ((m = /^\/projects\/([^/]+)(?:\/([a-z]+))?$/u.exec(p))) {
      const pid = decodeURIComponent(m[1]);
      const action = m[2];
      if (!action) {
        if (PATCH) return ok(s.updateProject(pid, data));
        if (DELETE) return ok(s.deleteProject(pid));
      } else if (POST) {
        switch (action) {
          case 'complete': return ok(s.completeProject(pid, truthy(get(data, 'completeOpenTodos'))));
          case 'cancel': return ok(s.completeProject(pid, truthy(get(data, 'completeOpenTodos')), 'canceled'));
          case 'reopen': return ok(s.reopenProject(pid));
          case 'restore': return ok(s.restoreProject(pid));
          case 'headings': return ok(s.addHeading(pid, pyStr(get(data, 'name', '')), get(data, 'position')));
          default: break;
        }
      }
    }
    if ((m = /^\/headings\/(.+)$/u.exec(p))) {
      const hid = decodeURIComponent(m[1]);
      if (PATCH) {
        if (truthy(get(data, 'projectId'))) return ok(s.moveHeading(hid, data.projectId));
        return ok(s.updateHeading(hid, data));
      }
      if (DELETE) return ok(s.deleteHeading(hid));
    }

    // ---- the tutorial project, again (Store.addTutorial)
    if (POST && p === '/tutorial') return ok(s.addTutorial());

    // ---- Today's own headings, kept in state.json (Store.addTodayHeading)
    if (POST && p === '/today/headings') return ok(s.addTodayHeading(data));
    if (POST && p === '/today/file') {
      return ok(s.fileInToday(pyList(get(data, 'ids', [])).map(pyStr), truthy(get(data, 'headingId')) ? pyStr(data.headingId) : null));
    }
    if ((m = /^\/today\/headings\/([^/]+)$/u.exec(p))) {
      const hid = decodeURIComponent(m[1]);
      if (PATCH) return ok(s.updateTodayHeading(hid, data));
      if (DELETE) return ok(s.deleteTodayHeading(hid));
    }

    // ---- areas
    if (POST && p === '/areas') return ok(s.createArea(data));
    if ((m = /^\/areas\/([^/]+)$/u.exec(p))) {
      const aid = decodeURIComponent(m[1]);
      if (PATCH) return ok(s.updateArea(aid, data));
      if (DELETE) return ok(s.deleteArea(aid));
    }

    // ---- logbook, trash, view state
    if (GET && p === '/logbook/pending') return ok(this._pending());
    if (POST && p === '/logbook/log-now') {
      s.putSettings({ logCutoff: s._onDay(get(data, 'cutoff')) });
      return ok(this._pending());
    }
    if (POST && p === '/trash/empty') return ok(s.emptyTrash());
    if (PUT && p === '/view-state') {
      if (Object.prototype.hasOwnProperty.call(data, 'collapsed')) {
        s.state.collapsed = pyList(data.collapsed);
        s.saveState();
        s.notify([]);
      }
      return ok({ ok: true });
    }

    // ---- the raw note, for the source editor
    if (GET && p === '/file') return ok(await this._readFile(query.path));
    if (PUT && p === '/file') return await this._writeFile(query.path, data);

    return reply(404, { error: 'not found' });
  }

  _parseRepeat(data) {
    const s = this.store;
    const text = pyStr(get(data, 'repeat', '')).trim();
    const anchor = pyStr(get(data, 'when') || get(data, 'deadline') || s.todayIso());
    if (!text) return { ok: true, repeat: null, next: [], describes: '' };
    let rule;
    try {
      rule = repeat.parseRule(text);
    } catch (e) {
      if (e instanceof Invalid) return { ok: false, error: e.message };
      throw e;
    }
    let start;
    try { start = Day.fromISO(anchor); } catch { start = s.today(); }
    const next = [];
    let cursor = start;
    for (let i = 0; i < 4; i++) {
      const nxt = repeat.nextOccurrence(rule, start, cursor);
      if (nxt === null) break;
      next.push(nxt.iso());
      cursor = nxt;
    }
    return { ok: true, repeat: repeat.describe(rule), describes: repeat.describe(rule), next, whenDone: rule.whenDone };
  }

  _quickAdd(data) {
    const s = this.store;
    const parsed = dates.parseQuickAdd(pyStr(get(data, 'text', '')), s.today(), this._weekStart());
    if (!parsed.title) throw new Invalid('empty title');
    const payload = { ...parsed };
    if (pyStr(get(data, 'notes') || '').trim()) payload.notes = pyStr(data.notes).trim();
    if (truthy(get(data, 'id'))) payload.id = data.id;
    const target = get(data, 'list', 'inbox');
    if (target === 'today') payload.when = payload.when || s.todayIso();
    else if (target === 'inbox' && !payload.when && !payload.someday) payload.inbox = true;
    else if (target === 'inbox') payload.inbox = false;
    for (const k of ['projectId', 'areaId', 'headingId']) {
      if (truthy(get(data, k))) {
        payload[k] = data[k];
        payload.inbox = false;
      }
    }
    return s.createTodo(payload);
  }

  _pending() {
    const s = this.store;
    const settings = s.getSettings();
    const today = s.todayIso();
    let n = 0;
    for (const f of s.files.values()) {
      if (s.isTrashedFile(f)) continue;
      for (const t of f.allTodos()) if (t.status !== 'open' && !views.isLogged(t.status, t.completed, settings, today)) n += 1;
    }
    return { pending: n, mode: get(settings, 'logCompleted', 'immediately') };
  }

  /** A vault-relative path the source editor may touch: inside, a .md, never
   *  the app's own state folder. */
  _safePath(rel) {
    rel = pyStr(rel || '').trim().replace(/^\/+/u, '');
    if (!rel) throw new Invalid('no path given');
    const parts = [];
    for (const part of rel.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (!parts.length) throw new Invalid('that path is outside the data folder');
        parts.pop();
      } else parts.push(part);
    }
    const clean = parts.join('/');
    if (!clean.toLowerCase().endsWith('.md')) throw new Invalid('only .md files can be edited here');
    if (parts.includes('.dvarim')) throw new Invalid("that is the app's own state, not your notes");
    return clean;
  }

  async _readFile(path) {
    const rel = this._safePath(path);
    await this.store.flush();
    // read as Python's read_text reads: a Windows line ending is a line ending
    const r = readText(await this.store.storage.read(rel));
    if (!r) throw new NotFound(path);
    const parsed = this.store.files.get(rel);
    return {
      path: rel, text: r.text, sha: sha1(r.text),
      kind: parsed ? parsed.kind : 'other',
      name: rel.split('/').pop().slice(0, -3),
      obsidian: obsidianUrl(rel, null, this.store.obsidian),
      bytes: new TextEncoder().encode(r.text).length,
    };
  }

  /** Replace a file wholesale — unless it moved on since the editor loaded it,
   *  in which case nothing is written and the current text comes back. */
  async _writeFile(path, data) {
    const rel = this._safePath(path);
    let text = get(data, 'text');
    if (typeof text !== 'string') throw new Invalid('text must be a string');
    const s = this.store;
    await s.flush();
    const current = readText(await s.storage.read(rel));
    if (current) {
      const currentSha = sha1(current.text);
      if (truthy(get(data, 'sha')) && data.sha !== currentSha) {
        return reply(409, { error: 'the file changed since you opened it', path: rel, text: current.text, sha: currentSha });
      }
    }
    if (!text.endsWith('\n')) text += '\n';
    await s.storage.write(rel, text);
    // an edit made here, from the version on disk: taken as it is, never merged
    s.adoptText(rel, text);
    await s.scanChanges();
    const parsed = s.files.get(rel);
    const warning = parsed ? null
      : 'Saved, but the app no longer recognises this as a project or area. Check the front matter still has its id and type.';
    return ok({
      path: rel, sha: sha1(text), kind: parsed ? parsed.kind : 'other',
      todos: parsed ? [...parsed.allTodos()].length : 0, warning,
    });
  }

  /** What the server's event stream says: call `onChanged(paths)` whenever the
   *  vault changes. Returns the way to stop. */
  subscribe(onChanged) {
    const cb = (paths) => onChanged(paths);
    this.store.listeners.push(cb);
    return () => {
      const i = this.store.listeners.indexOf(cb);
      if (i >= 0) this.store.listeners.splice(i, 1);
    };
  }
}
