// Two-way sync between the Markdown files and a CalDAV VTODO collection
// (backend/dvarim/tasksync.py, ported): use the to-dos in an app that is not
// Dvarim — Tasks.org, Reminders — and have what you do there come back.
//
//   pull   what changed over there since we last looked, applied to the files
//   adopt  anything created over there lands in the Inbox
//   bury   anything deleted over there goes to our Trash, which is recoverable
//   push   every publishable to-do whose content moved is written back
//   prune  anything no longer publishable (done, parked, deleted) is removed
//
// The files stay canonical: the collection is a projection and can be
// deleted at any time without losing anything. State lives in
// <root>/.dvarim/vtodo.json, the same file the Python kept, so moving from one
// server to the other costs no writes at all.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NotFound } from '../../engine/src/errors.js';
import { cmpStr } from '../../engine/src/util.js';
import * as vtodo from './vtodo.js';

export const COLLECTION = 'dvarim';
export const DISPLAY = 'Dvarim';

const hash = (text) => createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);

/** json.dumps(value, sort_keys=True, ensure_ascii=False): the Python's bytes. */
function pyJson(v) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  return '{' + Object.keys(v).sort().map((k) => `${JSON.stringify(k)}: ${pyJson(v[k])}`).join(', ') + '}';
}

/** Everything published, so a PUT happens only when something moved. The same
 *  hash as the Python's, so its vtodo.json carries straight over. */
export function contentKey(todo) {
  return hash(pyJson([
    todo.title ?? null, todo.notes ?? null, todo.status ?? null, todo.when ?? null,
    todo.deadline ?? null, [...(todo.tags || [])].sort(cmpStr), todo.completed ?? null,
    todo.evening ?? null, todo.someday ?? null, todo.reminder ?? null,
    todo.projectId ?? null, todo.headingName ?? null, todo.repeat ?? null,
    (todo.checklist || []).map((c) => [c.text ?? null, c.done ?? null]),
  ]));
}

const clock = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return { time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    stamp: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` };
};

export class TaskSync {
  /**
   * @param {import('../../engine/src/store.js').Store} store
   * @param {import('./caldav.js').CalDAV} client
   * @param {{includeSomeday?: boolean, adoptNew?: boolean, trashDeleted?: boolean, root?: string}} [opts]
   */
  constructor(store, client, opts = {}) {
    this.store = store;
    this.client = client;
    this.includeSomeday = !!opts.includeSomeday;
    this.adoptNew = opts.adoptNew ?? true;
    this.trashDeleted = opts.trashDeleted ?? true;
    this.root = opts.root || store.storage.root;
    this.collection = null;
    this.log = [];
    this.lastRun = null;
    this.lastError = null;
    this._chain = Promise.resolve();
  }

  _statePath() { return join(this.root, '.dvarim', 'vtodo.json'); }

  _loadState() {
    try { return JSON.parse(readFileSync(this._statePath(), 'utf8')); } catch { return {}; }
  }

  _saveState(state) {
    const p = this._statePath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p.replace(/\.json$/u, '.tmp');
    writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    renameSync(tmp, p);
  }

  _note(line) {
    this.log.push(`${clock().time} ${line}`);
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  status() {
    return { enabled: true, configured: true, collection: this.collection, lastRun: this.lastRun,
      lastError: this.lastError, log: this.log.slice(-30) };
  }

  /** One cycle; never two at once. */
  sync() {
    const run = this._chain.then(async () => {
      try {
        return await this._sync();
      } catch (e) {
        this.lastError = e && e.message ? e.message : String(e);
        this._note(`failed: ${this.lastError}`);
        return { ok: false, error: this.lastError };
      } finally {
        await this.store.flush();
      }
    });
    this._chain = run.catch(() => {});
    return run;
  }

  _ours(tid) {
    if (!tid) return null;
    try {
      const [, , t] = this.store.getTodo(tid);
      return this.store.todoJson(t);
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
  }

  async _sync() {
    const s = this.store;
    if (this.collection === null) this.collection = await this.client.ensureTaskCollection(COLLECTION, DISPLAY);
    const state = this._loadState();                       // { todo id: { href, etag, key } }
    const byHref = {};
    for (const [k, v] of Object.entries(state)) if (v && v.href) byHref[v.href] = k;
    const remote = await this.client.listEtags(this.collection);
    const counts = { pulled: 0, adopted: 0, buried: 0, pushed: 0, pruned: 0 };

    // ---- pull: things changed or created over there
    for (const [href, etag] of Object.entries(remote)) {
      let tid = byHref[href];
      const known = tid ? state[tid] : null;
      if (known && known.etag === etag) continue;         // untouched since our write
      let parsed;
      try {
        parsed = vtodo.fromIcs(await this.client.getText(href));
      } catch (e) {
        this._note(`could not read ${href}: ${e && e.message ? e.message : e}`);
        continue;
      }
      if (!parsed) continue;
      tid = tid || parsed.id;
      const ours = this._ours(tid);
      if (ours === null) {
        if (this.adoptNew && parsed.title) {
          const made = s.createTodo({
            title: parsed.title, notes: parsed.notes ?? '', when: parsed.when ?? null, deadline: parsed.deadline ?? null,
            tags: parsed.tags || [], inbox: !parsed.when,
          });
          state[made.id] = { href, etag, key: contentKey(made) };
          counts.adopted += 1;
          this._note(`adopted from CalDAV: ${[...parsed.title].slice(0, 50).join('')}`);
        }
        continue;
      }
      const patch = vtodo.mergeFromClient(ours, parsed);
      if (Object.keys(patch).length) {
        if (patch.status === 'done') s.completeTodo(tid);
        else if (patch.status === 'canceled') s.cancelTodo(tid);
        else if (patch.status === 'open' && ours.status !== 'open') s.reopenTodo(tid);
        delete patch.status;
        delete patch.completed;
        if (Object.keys(patch).length) s.updateTodo(tid, patch);
        counts.pulled += 1;
        this._note(`pulled ${JSON.stringify(Object.keys(patch).length ? Object.keys(patch) : ['status'])} for ${[...ours.title].slice(0, 40).join('')}`);
      }
      state[tid] = state[tid] || {};
      state[tid].href = href;
      state[tid].etag = etag;
    }

    // ---- deletions over there
    for (const [tid, rec] of Object.entries(state)) {
      if (rec.href && !(rec.href in remote)) {
        if (this.trashDeleted) {
          try {
            s.deleteTodo(tid);
            counts.buried += 1;
            this._note(`deleted in CalDAV, moved to Trash: ${tid}`);
          } catch (e) {
            if (!(e instanceof NotFound)) throw e;
          }
        }
        delete state[tid];
      }
    }

    // ---- push
    const wanted = new Map();
    for (const [f, t] of s.openTodos()) {
      const j = s.todoJson(t, f);
      if (vtodo.publishable(j, this.includeSomeday)) wanted.set(j.id, j);
    }
    for (const [tid, todo] of wanted) {
      const key = contentKey(todo);
      const rec = state[tid] || {};
      if (rec.key === key && rec.href) continue;
      const href = rec.href || `${this.collection}${tid}.ics`;
      let etag;
      try {
        etag = await this.client.putIcs(href, vtodo.toIcs(todo), null);
      } catch (e) {
        this._note(`could not write ${[...todo.title].slice(0, 40).join('')}: ${e && e.message ? e.message : e}`);
        continue;
      }
      state[tid] = { href, etag: etag || '', key };
      counts.pushed += 1;
    }

    // ---- prune what should no longer be there
    for (const tid of Object.keys(state).filter((k) => !wanted.has(k))) {
      const href = state[tid].href;
      if (href) {
        try {
          await this.client.delete(href);
          counts.pruned += 1;
        } catch (e) {
          this._note(`could not remove ${href}: ${e && e.message ? e.message : e}`);
          continue;
        }
      }
      delete state[tid];
    }

    this._saveState(state);
    this.lastRun = clock().stamp;
    this.lastError = null;
    const moved = Object.entries(counts).filter(([, v]) => v);
    if (moved.length) this._note('cycle: ' + moved.map(([k, v]) => `${v} ${k}`).join(', '));
    return { ok: true, ...counts, tracked: Object.keys(state).length };
  }
}

/** A TaskSync on a timer, never taking the server down with it. */
export class SyncLoop {
  constructor(sync, everySeconds = 300) {
    this.sync = sync;
    this.every = everySeconds * 1000;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    const tick = async () => {
      if (this.stopped) return;
      await this.sync.sync();
      if (!this.stopped) this.timer = setTimeout(tick, this.every);
    };
    tick();
    return this;
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
