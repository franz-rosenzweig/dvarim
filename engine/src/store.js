// The file-first store: the folder of Markdown is the database, and this
// keeps an index of it in memory and performs every change by rewriting the
// files it touches.
//
// backend/dvarim/store.py, method for method and in the same order of
// operations — the order ids are handed out in, the order files are indexed
// in and so the order lists come out in — and held to it by the differential
// suite in test/store.parity.test.js, which runs the same operations through
// both and compares every answer and every byte of every file.
//
// One difference of shape. The Python reads and writes the disk as it goes;
// here storage is asynchronous (the Mac's and Android's bridges are), so the
// store works on its own copy of the vault in memory, synchronously, as the
// Python does, and a queue carries each write to storage in order. `flush()`
// waits for the queue; `scanChanges()` reads what someone else changed. A
// mirror of the file tree answers "is there already a file called that?"
// without asking storage.
import { Day } from './day.js';
import { derivedId, lineId, newId as randomId } from './ids.js';
export { lineId };
import { Conflict, Invalid, Missing, NotFound } from './errors.js';
import { parse, serialize } from './mdformat.js';
import { ChecklistItem, Heading, Section, TaskFile, Todo } from './model.js';
import * as repeat from './repeat.js';
import { IGNORED_DIRS, readEach } from './storage.js';
import { conflictOriginal, hasSeen, mergeText, sameContent } from './merge.js';
import { mergeState, mergeStamps, stampChanges } from './state-merge.js';
import { sha1 } from './sha1.js';
import { TUTORIAL_ID, TUTORIAL_PATH, tutorialText } from './tutorial.js';
import { cmpStr, pyGet, pyInt, pyList, pyStr, quote, sortBy, stripChar, truthy } from './util.js';

export { IGNORED_DIRS };
export const INBOX = 'Inbox.md', STANDALONE = 'Standalone.md', TRASH = 'Trash.md';

// A conflict copy older than this is put away unmerged (Store._mergeCopy).
const OLD_COPY = 2 * 86400e3;

/** Two versions of a to-do that differ at most in where they are. */
function saysTheSame(a, b) {
  const plain = (t) => JSON.stringify({ ...t, line: 0, heading: null, trashed: null, origin: null,
    checklist: t.checklist.map((c) => [c.text, c.done]) });
  return plain(a) === plain(b);
}

/** When a sync tool made a conflict copy, from its name: Syncthing's
 *  .sync-conflict-20260923-101500-…, Dropbox's (… conflicted copy 2026-09-23).
 *  Read as UTC — the tools write local time, which two days' grace absorbs.
 *  Null if the name does not say. */
export function copyTime(name) {
  let m = /\.sync-conflict-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/u.exec(name);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  m = /conflicted copy[^()]*?(\d{4})-(\d{2})-(\d{2})/iu.exec(name);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) + 86400e3;     // some time that day: its end
  return null;
}
export const AREAS_DIR = 'Areas', PROJECTS_DIR = 'Projects', TRASH_DIR = 'Trash';
export const STATE_PATH = '.dvarim/state.json';
// when each setting and each list's order was last changed: how two devices'
// state.json merge (state-merge.js). Beside it, so state.json stays the server's.
export const STAMPS_PATH = '.dvarim/stamps.json';

/** What a sync the app runs itself (WebDAV, engine/src/webdav.js) carries,
 *  and what the server offers it (server/src/dav.js): every note the store
 *  reads, and the two state files. Never the rest of .dvarim/ (the server's
 *  password file can live there), nor a sync tool's conflict copy. */
export function syncable(path) {
  if (path === STATE_PATH || path === STAMPS_PATH) return true;
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  if (!name.endsWith('.md') || name.startsWith('.') || name.includes('.sync-conflict-')) return false;
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (parts.slice(0, -1).some((d) => IGNORED_DIRS.has(d) || d.startsWith('.'))) return false;
  return conflictOriginal(path) === null;
}

// calendars: null means "every calendar", a list means exactly those. They are
// different: an empty list is "none of them".
export const DEFAULT_SETTINGS = Object.freeze({
  logCompleted: 'immediately', weekStartsOn: 0, calendars: null, eveningStartsAt: '18:00',
  groupTodayByList: false, badgeCount: 'today', showCalendarEvents: true,
  // with logCompleted "manually", anything completed on or before this date
  // has been filed; Log Now moves it to today
  logCutoff: null,
  // {actionId: "Mod+Shift+K" | null}. Absent means the built-in binding; null
  // means the action has no key at all.
  keymap: {},
});

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, d = null) => (has(o, k) ? o[k] : d);

/** A link that opens the real note in Obsidian (see store.py). */
export function obsidianUrl(relPath, line, cfg) {
  if (!cfg || !cfg.vault) return null;
  const prefix = stripChar(cfg.prefix || '', '/');
  const path = prefix ? `${prefix}/${relPath}` : relPath;
  const vault = quote(cfg.vault), filepath = quote(path);
  if (line && line > 0) return `obsidian://advanced-uri?vault=${vault}&filepath=${filepath}&line=${line}`;
  return `obsidian://open?vault=${vault}&file=${filepath}`;
}

/** A project's or area's tags from its front matter, as Obsidian means them:
 *  a list or a single value, with empty items skipped (store.py, fm_tags). */
export function fmTags(fm) {
  let v = get(fm, 'tags');
  if (typeof v === 'string') v = [v];
  if (!Array.isArray(v)) return [];
  return v.filter((t) => t !== null && t !== undefined && typeof t !== 'boolean' && pyStr(t).trim()).map((t) => pyStr(t));
}

/** What the Python store reads: Path.read_text uses universal newlines, so a
 *  CRLF (or CR) file arrives with plain \n and is written back that way. */
export const readText = (r) => (r ? { ...r, text: r.text.replace(/\r\n?/gu, '\n') } : r);

// A name is at most 255 bytes on ext4 and APFS; cut well short of that, at a
// character boundary, with "…" to show it (store.py, NAME_BYTES).
export const NAME_BYTES = 120;
const utf8Len = (s) => new TextEncoder().encode(s).length;

/** The longest start of `s` whose UTF-8 fits in `n` bytes — Python's
 *  s.encode()[:n].decode("utf-8", "ignore"). */
function cutBytes(s, n) {
  let out = '', used = 0;
  for (const ch of s) {
    const b = utf8Len(ch);
    if (used + b > n) break;
    out += ch;
    used += b;
  }
  return out;
}

export function sanitizeName(name) {
  name = stripChar(name.replace(/[\\/:*?"<>|]/gu, '-').trim(), '.');
  name = name.replace(/\s+/gu, ' ');
  if (utf8Len(name) > NAME_BYTES) name = cutBytes(name, NAME_BYTES - 3).replace(/[ .]+$/u, '') + '…';
  return name || 'Untitled';
}

/** path.rsplit("/", 1)[0]: the folder — or, with no "/" in it, the path itself. */
const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(0, i);
};

const parentDirs = (path) => {
  const parts = path.split('/');
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

export class Store {
  /**
   * @param {object} storage  see storage.js
   * @param {object} [opts]
   * @param {() => Day} [opts.today]          what day it is (tests pin it)
   * @param {(prefix?: string) => string} [opts.newId]
   * @param {() => number} [opts.now]         milliseconds, for "left alone for a while"
   * @param {{vault: string, prefix?: string}} [opts.obsidian]
   * @param {(err: Error, op: object) => void} [opts.onWriteError]
   */
  constructor(storage, opts = {}) {
    this.storage = storage;
    this._todayFn = opts.today || (() => Day.today());
    this._newId = opts.newId || randomId;
    this.now = opts.now || (() => Date.now());
    this.obsidian = opts.obsidian || null;
    this.onWriteError = opts.onWriteError || null;
    // Whether a file that arrives changed may be one made from an older
    // version (docs/SYNC.md, "When a file arrives"). Off, what arrives is taken as
    // it is: right for a sync that leaves a conflict copy whenever two devices
    // changed a file (Syncthing, Dropbox, Nextcloud, OneDrive), where nothing
    // stale ever arrives in place, and for an edit made in Obsidian on this
    // device, which must win even when it undoes one of the app's own changes.
    // On, for a sync that keeps only the newer file of two: an arrival made
    // without one of this device's changes is merged with it, at the price
    // of an undo in Obsidian of something this device just did not sticking.
    this.mergeArrivals = !!opts.mergeArrivals;
    // How long a file must go unchanged on disk before this store writes into
    // it on its own account (a date for a box ticked elsewhere, a conflict
    // copy merged). 0: at once. Someone typing in Obsidian saves every couple
    // of seconds, and a write between two saves is a sync conflict: the
    // server holds its own changes in memory until the file is quiet.
    this.quietMs = opts.quietMs || 0;
    this._changedAt = new Map();  // path -> when someone else last changed it
    this._held = new Set();       // paths with changes of this store's, waiting for quiet
    this.files = new Map();       // path -> TaskFile
    this.meta = new Map();        // path -> { mtime, sha }
    this.todoIndex = new Map();   // to-do id -> path
    this._repaired = new Set();   // files whose copies were given ids of their own, not yet written (_repairIds)
    this.fileIndex = new Map();   // project/area id -> path
    this.listeners = [];
    this.tree = { files: new Set(), dirs: new Set() };
    this._disk = new Map();       // path -> { text, mtime }: every .md as last read or written
    // path -> every version this device has had, oldest first — read from
    // disk or written — as { text, own }: what a merge starts from (docs/SYNC.md)
    this._history = new Map();
    this.syncLog = [];            // what merging has done, newest last, for Settings → Data
    this._queue = [];
    this._writes = 0;             // every change sent to storage, counted: see scanChanges
    this._flushing = null;
    this.state = null;
  }

  /** Read the vault from storage and index it. */
  static async open(storage, opts = {}) {
    const store = new Store(storage, opts);
    const listing = await storage.list();
    store.tree = { files: new Set(listing.files), dirs: new Set(listing.dirs) };
    const paths = store._iterMd();
    const texts = await readEach(storage, paths);           // one round trip, over a bridge
    paths.forEach((rel, i) => {
      const r = readText(texts[i]);
      if (r) { store._disk.set(rel, r); store._history.set(rel, [{ text: r.text, own: false }]); }
    });
    const st = await storage.read(STATE_PATH);
    store.state = store._loadState(st ? st.text : null);
    store._stateText = st ? st.text : null;
    store._stateKnown = clone(store.state);          // as last read or written: what a change is measured from
    store.stamps = store._loadStamps(await storage.read(STAMPS_PATH));
    // A vault with no notes at all is new, and starts with the tutorial,
    // "Meet Dvarim" (tutorial.js). Only when whoever opens it asks: an empty
    // folder in a test, or a sync's before it has filled it, is nobody's
    // first look.
    if (opts.tutorial && !paths.length) store._putFile(TUTORIAL_PATH, tutorialText(store.todayIso()));
    store.ensureLayout();
    store.rebuild();
    return store;
  }

  /** "Meet Dvarim", from Settings → General: the one there is, while it is
   *  still open and out of the Trash, or else a new one with ids of its own. */
  addTutorial() {
    const at = this.fileIndex.get(TUTORIAL_ID);
    if (at !== undefined) {
      const f = this.files.get(at);
      if (f && !this.isTrashedFile(f) && get(f.frontmatter, 'status') === 'open') return this.projectJson(f);
    }
    const path = this._uniquePath(PROJECTS_DIR, 'Meet Dvarim');
    this._putFile(path, tutorialText(this.todayIso(), (prefix) => this.newId(prefix)));
    this._load(path);
    this.notify([path]);
    return this.projectJson(this._file(path));
  }

  // ------------------------------------------------------------------ basics
  /** self.files[path]: a file that must be indexed, or a KeyError. */
  _file(path) {
    const f = this.files.get(path);
    if (f === undefined) throw new Missing(path);
    return f;
  }

  today() { return this._todayFn(); }
  todayIso() { return this.today().iso(); }
  newId(prefix = '') { return this._newId(prefix); }

  _loadState(text) {
    const d = { todayOrder: [], anytimeOrder: [], somedayOrder: [], areaOrder: [], projectOrder: {},
      upcomingOrder: {}, collapsed: [], settings: clone(DEFAULT_SETTINGS) };
    if (text !== null) {
      try {
        const loaded = JSON.parse(text);
        if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
          Object.assign(d, loaded);
          d.settings = { ...clone(DEFAULT_SETTINGS), ...(loaded.settings || {}) };
        }
      } catch { /* json.JSONDecodeError: the defaults */ }
    }
    return d;
  }

  saveState() {
    // json.dumps(state, indent=1, ensure_ascii=False) and JSON.stringify(state,
    // null, 1) lay a document out alike
    const text = JSON.stringify(this.state, null, 1);
    this._enqueue({ op: 'write', path: STATE_PATH, text });
    this._stateText = text;
    if (stampChanges(this._stateKnown, this.state, this.stamps, this.now())) this._saveStamps();
    this._stateKnown = clone(this.state);
  }

  _loadStamps(r) {
    try {
      const v = r ? JSON.parse(r.text) : {};
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  /** In key order, so two devices with the same stamps write the same bytes. */
  _stampsText(stamps = this.stamps) {
    return JSON.stringify(Object.fromEntries(Object.entries(stamps).sort(([a], [b]) => cmpStr(a, b))), null, 1);
  }

  _saveStamps() {
    this._enqueue({ op: 'write', path: STAMPS_PATH, text: this._stampsText() });
  }

  /** state.json as it arrived, merged with this device's (state-merge.js). */
  _mergeStateFile(text, stampsText, { conflictCopy = false } = {}) {
    const theirs = this._loadState(text);
    const theirsStamps = stampsText === null ? {} : this._loadStamps({ text: stampsText });
    const merged = mergeState({ base: this._stateKnown, ours: this.state, oursStamps: this.stamps, theirs, theirsStamps });
    const state = this._loadState(JSON.stringify(merged.state));
    const same = JSON.stringify(state) === JSON.stringify(theirs);
    this.state = state;
    this.stamps = merged.stamps;
    this._stateKnown = clone(state);
    if (same && !conflictCopy) this._stateText = text;
    else {
      this._stateText = JSON.stringify(state, null, 1);
      this._enqueue({ op: 'write', path: STATE_PATH, text: this._stateText });
    }
    if (this._stampsText() !== this._stampsText(theirsStamps)) this._saveStamps();
  }

  ensureLayout() {
    for (const name of [INBOX, STANDALONE, TRASH]) {
      if (!this.tree.files.has(name)) this._putFile(name, '');
    }
    for (const d of [AREAS_DIR, PROJECTS_DIR, TRASH_DIR]) {
      if (!this.tree.dirs.has(d)) {
        this.tree.dirs.add(d);
        this._enqueue({ op: 'mkdir', path: d });
      }
    }
  }

  notify(paths) {
    for (const cb of [...this.listeners]) {
      try { cb(paths); } catch { /* listeners must never break a write */ }
    }
  }

  // ------------------------------------------------------------------ storage
  _enqueue(op) {
    this._writes++;
    this._queue.push(op);
    if (!this._flushing) this._flushing = Promise.resolve().then(() => this._drain());
  }

  async _drain() {
    while (this._queue.length) {
      const op = this._queue.shift();
      try {
        if (op.op === 'write') {
          const r = await this.storage.write(op.path, op.text);
          const m = this._disk.get(op.path);
          if (m && m.text === op.text && r && r.mtime !== undefined) m.mtime = r.mtime;
        } else if (op.op === 'remove') await this.storage.remove(op.path);
        else if (op.op === 'move') await this.storage.move(op.from, op.to);
        else if (op.op === 'removeDir') await this.storage.removeDir(op.path);
        else if (op.op === 'mkdir') { if (this.storage.mkdir) await this.storage.mkdir(op.path); }
      } catch (e) {
        if (this.onWriteError) this.onWriteError(e, op);
      }
    }
    this._flushing = null;
  }

  /** Resolves once every change made so far is in storage. */
  async flush() {
    while (this._flushing) await this._flushing;
  }

  /** A file into storage and into the mirrors, as a write would leave it. */
  _putFile(path, text) {
    this.tree.files.add(path);
    for (const d of parentDirs(path)) this.tree.dirs.add(d);
    this._disk.set(path, { text, mtime: this.now() });
    this._remember(path, text, true);
    this._enqueue({ op: 'write', path, text });
  }

  _remember(path, text, own) {
    const h = this._history.get(path);
    if (!h) this._history.set(path, [{ text, own }]);
    else if (h[h.length - 1].text !== text) {
      h.push({ text, own });
      if (h.length > 40) h.splice(0, h.length - 40);
    }
  }

  /**
   * What a version that arrived was made from (docs/SYNC.md): the newest of
   * the versions this device has had such that it carries every change up to
   * that one — its ancestor. That is the base to merge from; or, if it is this device's
   * current version, there is nothing to merge: someone edited what is here
   * (Obsidian), and the edit is taken as it is.
   *
   * Every version counts, not only this device's own writes: a box ticked in
   * Obsidian here is read from disk like a sync's arrival, but the other
   * device has not seen it, and an arrival from there must not undo it.
   *
   * @returns {string|null} the base ('' to merge without one), or null to
   *   take the arrival as it is
   */
  _mergeBase(rel, arrived) {
    const h = this._history.get(rel);
    if (!h || h.length < 2) return null;                // one version known: nothing here to lose
    const n = h.length - 1;
    // walk forward through them: the arrival descends from each one whose step
    // it carries, up to the first step it lacks
    let base = null;
    for (let i = 1; i <= n; i++) {
      if (!hasSeen(h[i - 1].text, h[i].text, arrived, rel)) { base = h[i - 1].text; break; }
    }
    if (base === null) return null;
    // An arrival that says exactly what one of our earlier versions said is
    // ambiguous: the other device may have undone our change after seeing it,
    // or never seen it and only written what we once had. Both devices meet
    // the same ambiguity from opposite ends, so neither can trust its own base
    // here: both merge without one — everything either side has, the rules for
    // the rest — and so reach the same file instead of undoing each other.
    for (let i = 0; i < n; i++) if (sameContent(arrived, h[i].text, rel)) return '';
    return base;
  }

  _removeFile(path) {
    this.tree.files.delete(path);
    this._disk.delete(path);
    this._enqueue({ op: 'remove', path });
  }

  _exists(path) {
    return this.tree.files.has(path) || this.tree.dirs.has(path);
  }

  // ------------------------------------------------------------------ scanning
  /** Every .md the index should read, as os.walk with the ignored folders pruned. */
  _iterMd(tree = this.tree) {
    const out = [];
    for (const path of tree.files) {
      const parts = path.split('/');
      const name = parts[parts.length - 1];
      if (parts.slice(0, -1).some((d) => IGNORED_DIRS.has(d) || d.startsWith('.'))) continue;
      if (!name.endsWith('.md') || name.includes('.sync-conflict-') || name.startsWith('.')) continue;
      if (conflictOriginal(path) !== null) continue;          // a sync tool's conflict copy: merged in, not a note
      out.push(path);
    }
    return out;
  }

  rebuild() {
    this.files = new Map();
    this.meta = new Map();
    this.todoIndex = new Map();
    this.fileIndex = new Map();
    this._repaired = new Set();
    for (const rel of this._iterMd().sort(cmpStr)) this._load(rel);
    this._repairIds();
    // areas whose folder exists but has no note
    const areaDirs = [...this.tree.dirs].filter((d) => d.startsWith(AREAS_DIR + '/') && d.split('/').length === 2).sort(cmpStr);
    for (const d of areaDirs) {
      const name = d.split('/')[1];
      if (!this.tree.files.has(`${d}/${name}.md`)) {
        const rel = `${AREAS_DIR}/${name}/${name}.md`;
        this._write(new TaskFile(rel, { id: this.newId('a'), type: 'area' }), false);
      }
    }
  }

  _classify(rel, f) {
    const parts = rel.split('/');
    const typed = ['project', 'area'].includes(f.frontmatter.type) ? f.frontmatter.type : null;
    if (parts.length === 1) {
      if ([INBOX, STANDALONE, TRASH].includes(rel)) return 'list';
      return typed;
    }
    if (parts[0] === AREAS_DIR && parts.length === 3) return parts[1] === parts[2].slice(0, -3) ? 'area' : 'project';
    if ((parts[0] === PROJECTS_DIR || parts[0] === TRASH_DIR) && parts.length === 2) return 'project';
    return typed;
  }

  _load(rel) {
    const r = this._disk.get(rel);
    if (!r) return null;
    const previous = new Map();
    if (this.files.has(rel)) for (const t of this.files.get(rel).allTodos()) previous.set(t.id, t.status);
    const f = parse(r.text, rel);
    const kind = this._classify(rel, f);
    if (kind === null) return null;
    let dirty = false;
    const fm = f.frontmatter;
    if (kind === 'project' || kind === 'area') {
      if (fm.type !== kind) { fm.type = kind; dirty = true; }
      if (!truthy(get(fm, 'id'))) { fm.id = this.newId(kind === 'project' ? 'p' : 'a'); dirty = true; }
      if (kind === 'project' && !truthy(get(fm, 'status'))) { fm.status = 'open'; dirty = true; }
      if (kind === 'project' && !truthy(get(fm, 'created'))) { fm.created = this.todayIso(); dirty = true; }
    }
    // Someone ticked a box in Obsidian: "- [x]" carries no date, so the Logbook
    // would have nowhere to file it. We saw it open a moment ago, so the
    // completion is now.
    for (const t of f.allTodos()) {
      if (t.status !== 'open' && !t.completed && previous.get(t.id) === 'open') {
        t.completed = this.todayIso();
        dirty = true;
      }
    }
    this.files.set(rel, f);
    this.meta.set(rel, { mtime: r.mtime, sha: sha1(r.text) });
    this._index(f);
    if (dirty) {
      if (this._busy(rel)) this._held.add(rel);
      else this._write(f, false);
    }
    return f;
  }

  _index(f) {
    for (const [tid, p] of [...this.todoIndex]) if (p === f.path) this.todoIndex.delete(tid);
    for (const [fid, p] of [...this.fileIndex]) if (p === f.path) this.fileIndex.delete(fid);
    const seen = new Map();
    for (const t of f.allTodos()) {
      if (!t.id) {
        const key = `${f.path}|${pyStr(t.heading)}|${t.title}`;
        seen.set(key, (seen.get(key) || 0) + 1);
        t.id = 'tmp' + sha1(`${key}|${seen.get(key)}`).slice(0, 9);
      }
      this.todoIndex.set(t.id, f.path);
    }
    if (truthy(get(f.frontmatter, 'id')) && (f.kind === 'project' || f.kind === 'area')) {
      this.fileIndex.set(f.frontmatter.id, f.path);
    }
  }

  _drop(rel) {
    this.files.delete(rel);
    this.meta.delete(rel);
    for (const [tid, p] of [...this.todoIndex]) if (p === rel) this.todoIndex.delete(tid);
    for (const [fid, p] of [...this.fileIndex]) if (p === rel) this.fileIndex.delete(fid);
  }

  /** Assign ids, serialize, write, reindex, notify. */
  _write(f, notify = true) {
    for (const t of f.allTodos()) {
      if (!t.id || t.id.startsWith('tmp')) {
        const old = t.id;
        t.id = old ? lineId(old, this.todoIndex) : this.newId();
        if (old) this.todoIndex.delete(old);
        this.todoIndex.set(t.id, f.path);
      }
    }
    const text = serialize(f);
    this._repaired.delete(f.path);
    this._putFile(f.path, text);
    const lines = {};
    text.split('\n').forEach((line, i) => {
      const hit = /🆔\s*([A-Za-z0-9_-]+)/u.exec(line);
      const lead = line.trimStart();
      if (hit && (lead.startsWith('- [') || lead.startsWith('* [') || lead.startsWith('+ ['))) lines[hit[1]] = i + 1;
    });
    for (const t of f.allTodos()) if (has(lines, t.id)) t.line = lines[t.id];
    this.files.set(f.path, f);
    this.meta.set(f.path, { mtime: this.now(), sha: sha1(text) });
    this._index(f);
    if (notify) this.notify([f.path]);
  }

  /**
   * Reload what someone else changed, drop what they deleted, load what is
   * new. Returns the changed paths.
   *
   * Reading the folder is asynchronous, and the store goes on answering while
   * it waits. Whatever it writes meanwhile is newer than what the scan read,
   * so a scan that saw the store write is stale: applied, it put the file back
   * as it was before that write — a to-do made then was gone, and the next
   * change to its file wrote the old text over the new. A stale scan is read
   * again instead. After a few in a row (someone typing quickly, each save
   * nudging a rescan) it gives up for now: those saves are about to nudge
   * another. The Python server holds a lock for the whole scan instead.
   */
  async scanChanges(tries = 3) {
    for (let attempt = 0; attempt < tries; attempt++) {
      await this.flush();                 // our own writes first, or they read as someone else's
      const seen = this._writes;
      const listing = await this.storage.list();
      const tree = { files: new Set(listing.files), dirs: new Set(listing.dirs) };
      const onDisk = new Map();
      const paths = this._iterMd(tree);
      // and any conflict copies a sync tool has left beside them
      const copies = [...tree.files].filter((p) => p.endsWith('.md') && conflictOriginal(p) !== null
        && !p.split('/').slice(0, -1).some((d) => d.startsWith('.')));
      const texts = await readEach(this.storage, [...paths, ...copies]);
      paths.forEach((rel, i) => { const r = readText(texts[i]); if (r) onDisk.set(rel, r); });
      const found = copies.map((path, i) => ({ path, original: conflictOriginal(path), r: readText(texts[paths.length + i]) }))
        .filter((c) => c.r);
      // and the state: sort orders and settings another device may have changed
      const stateCopies = [...tree.files].filter((p) => p.startsWith('.dvarim/state.sync-conflict-') && p.endsWith('.json'));
      const stampCopies = [...tree.files].filter((p) => p.startsWith('.dvarim/stamps.sync-conflict-') && p.endsWith('.json'));
      const extra = await readEach(this.storage, [STATE_PATH, STAMPS_PATH, ...stateCopies, ...stampCopies]);
      const copyOf = (list, from) => list.map((path, i) => ({ path, text: extra[from + i] ? extra[from + i].text : null })).filter((c) => c.text !== null);
      const state = {
        text: extra[0] ? extra[0].text : null, stamps: extra[1] ? extra[1].text : null,
        copies: copyOf(stateCopies, 2), stampCopies: copyOf(stampCopies, 2 + stateCopies.length),
      };
      if (this._writes !== seen) continue;
      return this.applyScan(tree, onDisk, found, state);
    }
    return [];
  }

  /** The synchronous half of scanChanges: what storage holds now → the index. */
  applyScan(tree, onDisk, copies = [], state = null) {
    const changed = [];
    this.tree = tree;
    for (const rel of [...this.files.keys()]) {
      if (!onDisk.has(rel)) {
        this._drop(rel);
        this._disk.delete(rel);
        changed.push(rel);
      }
    }
    for (const rel of [...onDisk.keys()].sort(cmpStr)) {
      const r = onDisk.get(rel);
      const m = this.meta.get(rel);
      // Deliberately no mtime shortcut: two writes can share a stamp, and
      // "- [ ]" -> "- [x]" leaves the size unchanged. Hash it.
      if (m && m.sha === sha1(r.text)) {
        this.meta.set(rel, { mtime: r.mtime, sha: m.sha });
        this._disk.set(rel, r);
        continue;
      }
      // Changed by someone else: taken as it is, unless arrivals may be stale
      // (mergeArrivals) and this one was made beside a change of this
      // device's rather than from it — then the two are merged (docs/SYNC.md).
      const mine = this._disk.get(rel);
      if (mine) this._changedAt.set(rel, this.now());
      const base = this.mergeArrivals && mine && mine.text !== r.text ? this._mergeBase(rel, r.text) : null;
      this._remember(rel, r.text, false);
      this._disk.set(rel, r);
      if (base !== null) {
        const merged = mergeText(base, mine.text, r.text, rel);
        if (!sameContent(merged.text, r.text, rel)) {
          this._putFile(rel, merged.text);
          this._logSync({ path: rel, kind: 'merged', conflicts: merged.conflicts });
        }
      }
      if (this._load(rel) !== null || this.files.has(rel)) changed.push(rel);
    }
    for (const c of copies) this._mergeCopy(c, changed);
    let stateChanged = false;
    if (state && state.text !== null && state.text !== this._stateText) {
      this._mergeStateFile(state.text, state.stamps);
      stateChanged = true;
    } else if (state && state.stamps !== null && state.stamps !== this._stampsText()) {
      // the stamps came on their own (a sync moves the two files separately)
      const theirs = this._loadStamps({ text: state.stamps });
      this.stamps = mergeStamps(this.stamps, theirs);
      if (this._stampsText() !== this._stampsText(theirs)) this._saveStamps();
    }
    const putAway = (path) => {
      const away = this._uniquePath('.dvarim/conflicts', path.split('/').pop().replace(/\.json$/u, '')).replace(/\.md$/u, '.json');
      this.tree.files.delete(path);
      this.tree.files.add(away);
      this._enqueue({ op: 'move', from: path, to: away });
    };
    for (const c of (state && state.copies) || []) {
      this._mergeStateFile(c.text, null, { conflictCopy: true });
      putAway(c.path);
      stateChanged = true;
    }
    for (const c of (state && state.stampCopies) || []) {
      const merged = mergeStamps(this.stamps, this._loadStamps({ text: c.text }));
      if (this._stampsText(merged) !== this._stampsText()) { this.stamps = merged; this._saveStamps(); }
      putAway(c.path);
    }
    for (const rel of this._repairIds()) if (!changed.includes(rel)) changed.push(rel);
    if (changed.length || stateChanged) this.notify(changed);
    return changed;
  }

  /**
   * The same id in two places, which the vault can hold and the app cannot:
   * a project copied in Obsidian, a file renamed on one device while another
   * edited it (the sync keeps both), a to-do copied rather than moved. The
   * index would keep whichever it read last, so an edit could land on the copy
   * in Trash, and the page, which draws its lists by id, would draw none.
   *
   * So the copy gets an id of its own. The one that keeps it is the one not
   * in Trash, then the first path in order, then the first in its file. The
   * new id is made from the old one and the copy's path (derivedId), so every
   * device that reads the same files repairs them the same way, and the sync
   * has nothing to disagree about. It is done in memory at once and written
   * when the file is next written, or once it has been left alone
   * (normalizeQuietFiles): writing into a file someone is typing into in
   * Obsidian only makes a conflict copy. Returns the files it changed.
   */
  _repairIds() {
    const rank = (rel) => [this._inTrash(rel) ? 1 : 0, rel];
    const before = (a, b) => {
      const x = rank(a), y = rank(b);
      return x[0] - y[0] || cmpStr(x[1], y[1]);
    };
    const paths = [...this.files.keys()].sort(before);
    const touched = new Set();
    // to-dos
    const holders = new Map();                     // id -> [{rel, t}], the keeper first
    for (const rel of paths) {
      for (const t of this.files.get(rel).allTodos()) {
        if (!t.id || t.id.startsWith('tmp')) continue;
        if (!holders.has(t.id)) holders.set(t.id, []);
        holders.get(t.id).push({ rel, t });
      }
    }
    const taken = new Set(holders.keys());
    for (const [id, list] of holders) {
      list.slice(1).forEach(({ rel, t }, i) => {
        t.id = derivedId(`${id}|${rel}|${i}`, taken);
        taken.add(t.id);
        touched.add(rel);
      });
    }
    // projects and areas
    const owners = new Map();                      // id -> [rel], the keeper first
    for (const rel of paths) {
      const f = this.files.get(rel);
      const fid = get(f.frontmatter, 'id');
      if (!truthy(fid) || (f.kind !== 'project' && f.kind !== 'area')) continue;
      if (!owners.has(fid)) owners.set(fid, []);
      owners.get(fid).push(rel);
    }
    const fileIds = new Set(owners.keys());
    for (const [fid, rels] of owners) {
      rels.slice(1).forEach((rel, i) => {
        const f = this.files.get(rel);
        f.frontmatter.id = derivedId(`${fid}|${rel}|${i}`, fileIds, f.kind === 'area' ? 'a' : 'p');
        fileIds.add(f.frontmatter.id);
        touched.add(rel);
      });
    }
    if (!touched.size) return [];
    for (const rel of touched) {
      this._repaired.add(rel);
      this._logSync({ path: rel, kind: 'ids already held elsewhere given new ones', conflicts: [] });
    }
    this.todoIndex = new Map();
    this.fileIndex = new Map();
    for (const rel of [...this.files.keys()].sort(before).reverse()) this._index(this.files.get(rel));
    return [...touched];
  }

  _inTrash(rel) { return rel === TRASH || rel.startsWith(TRASH_DIR + '/'); }

  /** A sync tool's conflict copy: merged into its file — without a base, as
   *  nothing says which version the copy was made from, so anything in either
   *  is kept — and then put away in .dvarim/conflicts/, never deleted.
   *
   *  The file is the version the sync tool chose, the copy the one it set
   *  aside, so the file's front matter stands as it is. A to-do only the copy
   *  has, and that is now in another file (Trash, a project it was moved to),
   *  stays where it went — unless the copy changed it, which is kept, as a
   *  to-do deleted on one side and changed on the other is (docs/SYNC.md).
   *  A copy more than two days old is put away unmerged:
   *  it was left before anything merged it, and what it held has long since
   *  been dealt with, or not, by hand. */
  _mergeCopy(copy, changed) {
    const target = this._disk.get(copy.original);
    const name = copy.path.split('/').pop();
    const at = copyTime(name);
    const history = this._history.get(copy.original) || [];
    // while its file is still being written elsewhere, a copy waits: merged
    // now, the merge would be the next conflict
    if (target && this._busy(copy.original)) return;
    if (at !== null && this.now() - at > OLD_COPY) {
      this._logSync({ path: copy.original, kind: 'old conflict copy, put away unmerged', copy: copy.path, conflicts: [] });
    } else if (target && history.map((v) => v.text).lastIndexOf(copy.r.text) > 0) {
      // A version this device itself had: usually its own write, which lost
      // to a save in Obsidian made from the version before it. So that one
      // is the base: this device's change goes onto what was typed, and
      // nothing is added twice, as a merge without a base would.
      const k = history.map((v) => v.text).lastIndexOf(copy.r.text);
      const merged = mergeText(history[k - 1].text, target.text, copy.r.text, copy.original);
      if (!sameContent(merged.text, target.text, copy.original)) {
        this._putFile(copy.original, merged.text);
        this._load(copy.original);
        if (!changed.includes(copy.original)) changed.push(copy.original);
      }
      this._logSync({ path: copy.original, kind: 'conflict copy', copy: copy.path, conflicts: merged.conflicts });
    } else if (target) {
      const ours = parse(target.text, copy.original), theirs = parse(copy.r.text, copy.original);
      const here = new Set([...ours.allTodos()].map((t) => t.id).filter(Boolean));
      const leftOut = [];
      for (const sec of theirs.sections) {
        sec.todos = sec.todos.filter((t) => {
          const rel = t.id && !here.has(t.id) ? this.todoIndex.get(t.id) : undefined;
          const hit = rel !== undefined && rel !== copy.original ? this._file(rel).find(t.id) : null;
          if (hit === null || !saysTheSame(t, hit[0].todos[hit[1]])) return true;
          leftOut.push(t.id);
          return false;
        });
      }
      theirs.frontmatter = ours.frontmatter;
      theirs.fmRaw = ours.fmRaw;
      // Without a base, every line of the copy's notes not in the file's
      // would be added. A line the file has anywhere (a note moved out to a
      // to-do of its own, say), or has a longer version of, adds nothing.
      const have = target.text;
      const known = (line) => {
        const bare = line.trim().replace(/^(?:[-*+•]|\d+[.)])\s+(?:\[[^\]\r\n]\]\s+)?/u, '').trim();
        return bare.length >= 4 && have.includes(bare);
      };
      const keepNew = (notes) => (notes || '').split('\n').filter((l) => !l.trim() || !known(l)).join('\n').replace(/\n{3,}/gu, '\n\n');
      theirs.notes = keepNew(theirs.notes);
      for (const t of theirs.allTodos()) t.notes = keepNew(t.notes);
      const merged = mergeText('', target.text, serialize(theirs), copy.original);
      if (!sameContent(merged.text, target.text, copy.original)) {
        this._putFile(copy.original, merged.text);
        this._load(copy.original);
        if (!changed.includes(copy.original)) changed.push(copy.original);
      }
      this._logSync({ path: copy.original, kind: 'conflict copy', copy: copy.path, conflicts: merged.conflicts, ...(leftOut.length ? { leftOut } : {}) });
    } else {
      this._logSync({ path: copy.original, kind: 'conflict copy of a missing file', copy: copy.path, conflicts: [] });
    }
    const away = this._uniquePath('.dvarim/conflicts', name.slice(0, -3));
    this.tree.files.delete(copy.path);
    this.tree.files.add(away);
    for (const d of parentDirs(away)) this.tree.dirs.add(d);
    this._enqueue({ op: 'move', from: copy.path, to: away });
  }

  // ------------------------------------------------------------------ built-in sync
  /** Every file a sync carries, as this device has it now: path -> text. */
  async syncTexts() {
    await this.flush();
    const out = new Map();
    for (const [rel, r] of this._disk) if (syncable(rel)) out.set(rel, r.text);
    for (const [rel, r] of [[STATE_PATH, await this.storage.read(STATE_PATH)], [STAMPS_PATH, await this.storage.read(STAMPS_PATH)]]) {
      if (r) out.set(rel, readText(r).text);
    }
    return out;
  }

  /** A note as another device has it, brought by a sync that has already
   *  merged it with this one's (webdav.js: against the version both last
   *  agreed on) or checked it was made from it (the server's If-Match), so
   *  taken as it is. null: deleted there. True if anything here changed. */
  receive(rel, text) {
    if (!syncable(rel) || rel === STATE_PATH || rel === STAMPS_PATH) throw new Invalid(`not a note a sync carries: ${rel}`);
    if (text === null) {
      if (!this._disk.has(rel) && !this.tree.files.has(rel)) return false;
      this._removeFile(rel);
      this._drop(rel);
      this.notify([rel]);
      return true;
    }
    const mine = this._disk.get(rel);
    if (mine && mine.text === text) return false;
    this._putFile(rel, text);
    this._load(rel);
    this.notify([rel]);
    return true;
  }

  /** A folder, and the ones it is in. */
  makeDirs(rel) {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!this.tree.dirs.has(d)) {
        this.tree.dirs.add(d);
        this._enqueue({ op: 'mkdir', path: d });
      }
    }
  }

  /** The state files as another device has them: merged with this one's by
   *  their stamps, as when they arrive on disk (applyScan). */
  receiveState(stateText, stampsText) {
    if (stateText !== null && stateText !== this._stateText) {
      this._mergeStateFile(stateText, stampsText);
      // Unlike a sync tool's, it came over the network, not onto the disk:
      // what the merge kept is written even where it is what arrived.
      this._enqueue({ op: 'write', path: STATE_PATH, text: this._stateText });
    } else if (stampsText !== null && stampsText !== this._stampsText()) {
      this.stamps = mergeStamps(this.stamps, this._loadStamps({ text: stampsText }));
    } else return false;
    this._saveStamps();
    this.notify([]);
    return true;
  }

  /** A text written to storage on this device by someone who had the current
   *  version in front of them (the source editor): the version everyone now
   *  starts from, so the next scan takes it as it is. */
  adoptText(rel, text) {
    if (this._disk.has(rel)) this._disk.set(rel, { ...this._disk.get(rel), text });
    this._remember(rel, text, false);
  }

  _logSync(entry) {
    this.syncLog.push({ at: this.now(), ...entry });
    if (this.syncLog.length > 50) this.syncLog.shift();
  }

  /** Someone else changed this file on disk less than quietMs ago. */
  _busy(rel) {
    const at = this._changedAt.get(rel);
    return this.quietMs > 0 && at !== undefined && this.now() - at < this.quietMs;
  }

  /** Write what was held back while its file was changing (quietMs), now that
   *  it is quiet. Called with each watcher pass. Returns the paths written. */
  writeHeld() {
    const out = [];
    for (const rel of [...this._held]) {
      if (this._busy(rel)) continue;
      this._held.delete(rel);
      const f = this.files.get(rel);
      if (!f) continue;
      this._write(f);
      out.push(rel);
    }
    return out;
  }

  /** Write real ids into files that carry temporary ones, or copies given ids
   *  of their own (_repairIds), and have been left alone for a while (typed in
   *  Obsidian, and then not touched). */
  normalizeQuietFiles(quietSeconds = 120) {
    const out = [];
    const now = this.now();
    for (const [rel, f] of [...this.files]) {
      if (this._repaired.has(rel) || [...f.allTodos()].some((t) => t.id.startsWith('tmp'))) {
        const m = this.meta.get(rel);
        if (m && (now - m.mtime) / 1000 >= quietSeconds) {
          this._write(f);
          out.push(rel);
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ lookups
  getTodo(tid) {
    const rel = this.todoIndex.get(tid);
    if (rel === undefined) throw new NotFound(tid);
    const f = this._file(rel);
    const hit = f.find(tid);
    if (hit === null) throw new NotFound(tid);
    const [sec, i] = hit;
    return [f, sec, sec.todos[i]];
  }

  getFileById(fid) {
    const rel = this.fileIndex.get(fid);
    if (rel === undefined) throw new NotFound(fid);
    return this._file(rel);
  }

  areaOf(f) {
    const parts = f.path.split('/');
    if (parts[0] === AREAS_DIR && parts.length === 3) return this.files.get(`${AREAS_DIR}/${parts[1]}/${parts[1]}.md`) || null;
    return null;
  }

  isTrashedFile(f) {
    return f.path.startsWith(TRASH_DIR + '/') || f.path === TRASH;
  }

  areas() {
    const arr = [...this.files.values()].filter((f) => f.kind === 'area');
    const order = new Map((this.state.areaOrder || []).map((aid, i) => [aid, i]));
    return sortBy(arr, (f) => [order.has(get(f.frontmatter, 'id')) ? order.get(get(f.frontmatter, 'id')) : 1e6, f.name.toLowerCase()]);
  }

  projects({ area = null, includeClosed = false, includeTrashed = false } = {}) {
    const out = [];
    for (const f of this.files.values()) {
      if (f.kind !== 'project') continue;
      if (!includeTrashed && this.isTrashedFile(f)) continue;
      if (!includeClosed && get(f.frontmatter, 'status', 'open') !== 'open') continue;
      if (area !== null) {
        const a = this.areaOf(f);
        if (a === null || a.path !== area.path) continue;
      }
      out.push(f);
    }
    const key = area === null ? '' : get(area.frontmatter, 'id', '');
    const order = new Map(((this.state.projectOrder || {})[key] || []).map((pid, i) => [pid, i]));
    return sortBy(out, (f) => [order.has(get(f.frontmatter, 'id')) ? order.get(get(f.frontmatter, 'id')) : 1e6, f.name.toLowerCase()]);
  }

  looseProjects(includeClosed = false) {
    return this.projects({ includeClosed }).filter((f) => this.areaOf(f) === null);
  }

  /** [file, to-do] for every open, non-trashed to-do. */
  *openTodos() {
    for (const f of this.files.values()) {
      if (this.isTrashedFile(f)) continue;
      if (f.kind === 'project' && get(f.frontmatter, 'status', 'open') !== 'open') continue;
      for (const t of f.allTodos()) if (t.status === 'open') yield [f, t];
    }
  }

  // ------------------------------------------------------------------ JSON
  todoJson(t, f = null) {
    if (f === null) f = this._file(this.todoIndex.get(t.id));
    const proj = f.kind === 'project' ? f : null;
    const area = f.kind === 'project' ? this.areaOf(f) : (f.kind === 'area' ? f : null);
    const sec = f.sectionFor(t.heading);
    const idx = sec && sec.todos.includes(t) ? sec.todos.indexOf(t) : 0;
    const pid = proj ? get(proj.frontmatter, 'id') : null;
    const todayOrder = this.state.todayOrder || [];
    return {
      id: t.id, title: t.title, notes: t.notes, status: t.status,
      inbox: f.path === INBOX, someday: t.someday, when: t.when, evening: t.evening,
      reminder: t.reminder, deadline: t.deadline, repeat: t.repeat, tags: [...t.tags],
      checklist: t.checklist.map((c) => ({ text: c.text, done: c.done })),
      created: t.created, completed: t.completed,
      projectId: pid, projectName: proj ? proj.name : null,
      areaId: area ? get(area.frontmatter, 'id') : null, areaName: area ? area.name : null,
      headingId: truthy(pid) && truthy(t.heading) ? `${pid}:${t.heading}` : null, headingName: t.heading,
      index: idx, todayIndex: todayOrder.includes(t.id) ? todayOrder.indexOf(t.id) : null,
      trashed: t.trashed, origin: t.origin,
      file: f.path, line: t.line,
      obsidian: obsidianUrl(f.path, t.line, this.obsidian),
    };
  }

  projectJson(f) {
    const fm = f.frontmatter;
    const todos = [...f.allTodos()];
    const done = todos.filter((t) => t.status !== 'open').length;
    const area = this.areaOf(f);
    return {
      id: get(fm, 'id'), name: f.name, notes: f.notes, status: get(fm, 'status', 'open'),
      when: get(fm, 'when'), evening: truthy(get(fm, 'evening')), someday: truthy(get(fm, 'someday')),
      deadline: get(fm, 'deadline'), repeat: get(fm, 'repeat'), tags: fmTags(fm),
      created: get(fm, 'created'), completed: get(fm, 'completed'),
      areaId: area ? get(area.frontmatter, 'id') : null, areaName: area ? area.name : null,
      progress: todos.length ? done / todos.length : 0,
      openCount: todos.length - done, doneCount: done,
      headings: f.sections.filter((s) => s.heading !== null)
        .map((s) => ({ id: `${pyStr(get(fm, 'id'))}:${s.heading.name}`, name: s.heading.name, archived: s.heading.archived })),
      trashed: f.path.startsWith(TRASH_DIR + '/'),
      file: f.path,
      obsidian: obsidianUrl(f.path, null, this.obsidian),
    };
  }

  areaJson(f, withProjects = true) {
    const fm = f.frontmatter;
    const d = {
      id: get(fm, 'id'), name: f.name, notes: f.notes, tags: fmTags(fm), file: f.path,
      obsidian: obsidianUrl(f.path, null, this.obsidian),
      openCount: [...f.allTodos()].filter((t) => t.status === 'open').length,
    };
    if (withProjects) {
      d.projects = this.projects({ area: f }).map((p) => this.projectJson(p));
      d.openCount += d.projects.reduce((n, p) => n + p.openCount, 0);
    }
    return d;
  }

  headingRef(hid) {
    const i = hid.indexOf(':');
    const [pid, name] = i < 0 ? [hid, ''] : [hid.slice(0, i), hid.slice(i + 1)];
    const f = this.getFileById(pid);
    const s = f.sectionFor(name);
    if (s === null || s.heading === null) throw new NotFound(hid);
    return [f, s];
  }

  // ------------------------------------------------------------------ helpers
  /** inbox / projectId+headingId / areaId / standalone → [file, heading name]. */
  _targetFile(data) {
    if (truthy(get(data, 'inbox'))) return [this._file(INBOX), null];
    if (truthy(get(data, 'projectId'))) {
      const f = this.getFileById(data.projectId);
      let heading = null;
      if (truthy(get(data, 'headingId'))) heading = this.headingRef(data.headingId)[1].heading.name;
      else if (truthy(get(data, 'headingName'))) heading = data.headingName;
      return [f, heading];
    }
    if (truthy(get(data, 'areaId'))) return [this.getFileById(data.areaId), null];
    return [this._file(STANDALONE), null];
  }

  _insert(f, heading, t, position = null) {
    let sec = f.sectionFor(heading);
    if (sec === null) {
      if (heading === null) sec = f.lead();
      else {
        sec = new Section(new Heading(heading));
        f.sections.push(sec);
      }
    }
    t.heading = heading;
    const isDict = position !== null && typeof position === 'object' && !Array.isArray(position);
    if (position === 'top') sec.todos.unshift(t);
    else if (isDict && truthy(get(position, 'after'))) {
      const hit = f.find(position.after);
      if (hit && hit[0] === sec) sec.todos.splice(hit[1] + 1, 0, t);
      else sec.todos.push(t);
    } else if (isDict && has(position, 'index')) {
      sec.todos.splice(Math.max(0, Math.min(sec.todos.length, pyInt(position.index))), 0, t);
    } else sec.todos.push(t);
  }

  _applyPatch(t, patch) {
    for (const k of ['title', 'notes']) {
      if (has(patch, k) && patch[k] !== null) t[k] = k === 'title' ? pyStr(patch[k]).trim() : pyStr(patch[k]);
    }
    if (has(patch, 'when')) {
      t.when = truthy(patch.when) ? patch.when : null;
      if (t.when) t.someday = false;
    }
    if (has(patch, 'evening')) t.evening = truthy(patch.evening);
    if (has(patch, 'someday')) {
      t.someday = truthy(patch.someday);
      if (t.someday) { t.when = null; t.evening = false; }
    }
    if (has(patch, 'reminder')) t.reminder = truthy(patch.reminder) ? patch.reminder : null;
    if (has(patch, 'deadline')) t.deadline = truthy(patch.deadline) ? patch.deadline : null;
    if (has(patch, 'repeat')) {
      t.repeat = truthy(patch.repeat) ? patch.repeat : null;
      if (t.repeat) t.repeat = repeat.describe(repeat.parseRule(t.repeat));
    }
    if (has(patch, 'tags')) {
      t.tags = pyList(truthy(patch.tags) ? patch.tags : []).filter((x) => pyStr(x).trim())
        .map((x) => pyStr(x).replace(/^#+/u, '').trim());
    }
    if (has(patch, 'checklist')) {
      t.checklist = pyList(truthy(patch.checklist) ? patch.checklist : [])
        .filter((c) => pyStr(pyGet(c, 'text', '')).trim())
        .map((c) => new ChecklistItem(pyStr(pyGet(c, 'text', '')).trim(), truthy(pyGet(c, 'done'))));
    }
    if (has(patch, 'status') && ['open', 'done', 'canceled'].includes(patch.status)) {
      if (patch.status !== t.status) t.mark = null;
      t.status = patch.status;
      t.completed = t.status === 'open' ? null : (t.completed || this.todayIso());
    }
  }

  // ------------------------------------------------------------------ client-minted ids
  /** The id a client brought with a create, checked, or null (see store.py). */
  static _clientId(data, prefix = '') {
    const cid = get(data, 'id');
    if (cid === null) return null;
    const n = 8 - prefix.length;
    if (typeof cid !== 'string' || !new RegExp(`^${prefix}[0-9a-z]{${n}}$`, 'u').test(cid)) {
      throw new Invalid(`id must be ${prefix ? prefix + '+' : ''}${n} characters of 0-9 and a-z`);
    }
    return cid;
  }

  /** A date a client asked for, or today; never the future. */
  _onDay(on) {
    if (typeof on === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(on) && cmpStr(on, this.todayIso()) <= 0) return on;
    return this.todayIso();
  }

  // ------------------------------------------------------------------ to-do mutations
  createTodo(data) {
    const tid = Store._clientId(data);
    if (tid !== null) {
      try {
        const [f0, , t0] = this.getTodo(tid);
        return this.todoJson(t0, f0);
      } catch (e) { if (!(e instanceof NotFound)) throw e; }
    }
    const [f, heading] = this._targetFile(data);
    const t = new Todo({ id: tid || this.newId(), title: pyStr(get(data, 'title', 'New To-Do')).trim() || 'New To-Do', created: this.todayIso() });
    this._applyPatch(t, data);
    this._insert(f, heading, t, get(data, 'position'));
    this._write(f);
    if (t.when && cmpStr(t.when, this.todayIso()) <= 0) this._todayOrderAdd(t.id);
    return this.todoJson(t, f);
  }

  updateTodo(tid, patch) {
    const [f, , t] = this.getTodo(tid);
    const wasToday = t.when && cmpStr(t.when, this.todayIso()) <= 0;
    this._applyPatch(t, patch);
    this._write(f);
    const nowToday = t.when && cmpStr(t.when, this.todayIso()) <= 0;
    if (nowToday && !wasToday) this._todayOrderAdd(t.id);
    return this.todoJson(t, f);
  }

  /** `on` is the day it was ticked, which is not always the day the store
   *  hears of it: the Logbook files it under the day it was done. */
  completeTodo(tid, on = null) {
    const [f, sec, t] = this.getTodo(tid);
    let nxt = null;
    if (t.status !== 'done') {
      t.status = 'done';
      t.mark = null;
      t.completed = this._onDay(on);
      if (t.repeat) {
        let adv = null;
        try {
          adv = repeat.advance(t.repeat, t.when, t.deadline, this.today());
        } catch (e) {
          if (!(e instanceof Invalid || e instanceof RangeError)) throw e;
          adv = null;
        }
        if (adv !== null) {
          const [newWhen, newDeadline] = adv;
          nxt = new Todo({ id: this.newId(), title: t.title, notes: t.notes, tags: [...t.tags], when: newWhen,
            evening: t.evening, reminder: t.reminder, deadline: newDeadline, repeat: t.repeat,
            created: this.todayIso(), checklist: t.checklist.map((c) => new ChecklistItem(c.text, false)),
            heading: t.heading });
          sec.todos.splice(sec.todos.indexOf(t), 0, nxt);
        }
      }
      this._write(f);
    }
    this._todayOrderRemove(t.id);
    return { todo: this.todoJson(t, f), next: nxt ? this.todoJson(nxt, f) : null };
  }

  cancelTodo(tid, on = null) {
    const [f, , t] = this.getTodo(tid);
    t.status = 'canceled';
    t.mark = null;
    t.completed = this._onDay(on);
    this._write(f);
    this._todayOrderRemove(t.id);
    return this.todoJson(t, f);
  }

  reopenTodo(tid) {
    const [f, , t] = this.getTodo(tid);
    t.status = 'open';
    t.completed = null;
    this._write(f);
    return this.todoJson(t, f);
  }

  moveTodo(tid, target) {
    const [src, sec, t] = this.getTodo(tid);
    const [dst, heading] = this._targetFile(target);
    sec.todos.splice(sec.todos.indexOf(t), 1);
    if (src.path !== dst.path) this._write(src);
    t.trashed = null;
    t.origin = null;
    this._insert(dst, heading, t, get(target, 'position'));
    this._write(dst);
    return this.todoJson(t, dst);
  }

  deleteTodo(tid) {
    const [src, sec, t] = this.getTodo(tid);
    if (src.path === TRASH) {
      sec.todos.splice(sec.todos.indexOf(t), 1);
      this._write(src);
      this.todoIndex.delete(tid);
      return this.todoJson(t, src);
    }
    sec.todos.splice(sec.todos.indexOf(t), 1);
    t.trashed = this.todayIso();
    t.origin = src.path + (t.heading ? `#${t.heading}` : '');
    this._write(src);
    const trash = this._file(TRASH);
    this._insert(trash, null, t, 'top');
    this._write(trash);
    this._todayOrderRemove(tid);
    return this.todoJson(t, trash);
  }

  restoreTodo(tid) {
    const [trash, sec, t] = this.getTodo(tid);
    if (trash.path !== TRASH) return this.todoJson(t, trash);
    const origin = t.origin || STANDALONE;
    const hash = origin.indexOf('#');
    const [path, heading] = hash < 0 ? [origin, ''] : [origin.slice(0, hash), origin.slice(hash + 1)];
    let dst = this.files.get(path) || this._file(STANDALONE);
    if (!['project', 'area', 'list'].includes(dst.kind) || this.isTrashedFile(dst)) dst = this._file(STANDALONE);
    sec.todos.splice(sec.todos.indexOf(t), 1);
    this._write(trash);
    t.trashed = null;
    t.origin = null;
    this._insert(dst, heading || null, t);
    this._write(dst);
    return this.todoJson(t, dst);
  }

  duplicateTodo(tid, data = null) {
    const cid = Store._clientId(data || {});
    if (cid !== null) {
      try {
        const [f0, , c0] = this.getTodo(cid);
        return this.todoJson(c0, f0);           // the copy is already here
      } catch (e) { if (!(e instanceof NotFound)) throw e; }
    }
    const [f, sec, t] = this.getTodo(tid);
    const c = new Todo({ id: cid || this.newId(), title: t.title, notes: t.notes, tags: [...t.tags], when: t.when,
      evening: t.evening, someday: t.someday, reminder: t.reminder, deadline: t.deadline, repeat: t.repeat,
      created: this.todayIso(), checklist: t.checklist.map((x) => new ChecklistItem(x.text, x.done)), heading: t.heading });
    sec.todos.splice(sec.todos.indexOf(t) + 1, 0, c);
    this._write(f);
    return this.todoJson(c, f);
  }

  /** A to-do becomes a project; its checklist items become its to-dos. */
  convertTodo(tid, data = null) {
    data = data || {};
    const pid = Store._clientId(data, 'p');
    if (pid !== null) {
      try { return this.projectJson(this.getFileById(pid)); } catch (e) { if (!(e instanceof NotFound)) throw e; }
    }
    const given = pyList(truthy(get(data, 'checklist')) ? data.checklist : []).filter((x) => typeof x === 'string');
    for (const x of given) Store._clientId({ id: x });      // the same shape, or refuse
    const [src, sec, t] = this.getTodo(tid);
    const area = src.kind === 'project' ? this.areaOf(src) : (src.kind === 'area' ? src : null);
    // a title too long to be a file name is cut there, so keep it whole in the notes
    let notes = t.notes;
    if (sanitizeName(t.title).endsWith('…') && utf8Len(t.title) > NAME_BYTES) notes = t.title + (t.notes ? '\n\n' + t.notes : '');
    const proj = this.createProject({ id: pid, name: t.title, areaId: area ? get(area.frontmatter, 'id') : null,
      notes, when: t.when, deadline: t.deadline, tags: t.tags, someday: t.someday });
    const pf = this.getFileById(proj.id);
    t.checklist.forEach((c, i) => {
      pf.lead().todos.push(new Todo({ id: i < given.length ? given[i] : this.newId(), title: c.text,
        status: c.done ? 'done' : 'open', completed: c.done ? this.todayIso() : null, created: this.todayIso() }));
    });
    this._write(pf);
    sec.todos.splice(sec.todos.indexOf(t), 1);
    this._write(src);
    this._todayOrderRemove(tid);
    return this.projectJson(pf);
  }

  // ------------------------------------------------------------------ ordering
  _todayOrderAdd(tid) {
    if (!has(this.state, 'todayOrder')) this.state.todayOrder = [];
    const o = this.state.todayOrder;
    if (!o.includes(tid)) {
      o.push(tid);
      this.saveState();
    }
  }

  _todayOrderRemove(tid) {
    if (!has(this.state, 'todayOrder')) this.state.todayOrder = [];
    const o = this.state.todayOrder;
    if (o.includes(tid)) {
      o.splice(o.indexOf(tid), 1);
      this.saveState();
    }
  }

  /** A day that has been and gone has no order worth keeping. */
  _pruneUpcomingOrder() {
    const orders = this.state.upcomingOrder;
    if (!truthy(orders)) return;
    const today = this.todayIso();
    for (const d of Object.keys(orders).filter((k) => cmpStr(k, today) < 0)) delete orders[d];
  }

  reorder(context, ids) {
    if (context.startsWith('upcoming:')) {
      const day = context.slice(9);
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(day)) throw new NotFound(context);
      if (!has(this.state, 'upcomingOrder')) this.state.upcomingOrder = {};
      this.state.upcomingOrder[day] = [...ids];
      this._pruneUpcomingOrder();
      this.saveState();
      this.notify([]);
      return;
    }
    if (context === 'today-headings') {
      const hs = this.state.todayHeadings || [];
      const named = new Set(ids);
      const byId = new Map(hs.map((h) => [h.id, h]));
      this.state.todayHeadings = [...ids.filter((i) => byId.has(i)).map((i) => byId.get(i)), ...hs.filter((h) => !named.has(h.id))];
      this.saveState();
      this.notify([]);
      return;
    }
    if (['today', 'anytime', 'someday'].includes(context)) {
      const key = { today: 'todayOrder', anytime: 'anytimeOrder', someday: 'somedayOrder' }[context];
      const rest = (this.state[key] || []).filter((i) => !ids.includes(i));
      this.state[key] = [...ids, ...rest];
      this.saveState();
      this.notify([]);
      return;
    }
    let f, heading;
    if (context === 'inbox') [f, heading] = [this._file(INBOX), null];
    else if (context === 'standalone') [f, heading] = [this._file(STANDALONE), null];
    else if (context.startsWith('project:')) [f, heading] = [this.getFileById(context.slice(8)), null];
    else if (context.startsWith('heading:')) {
      const [hf, hs] = this.headingRef(context.slice(8));
      [f, heading] = [hf, hs.heading.name];
    } else if (context.startsWith('area:')) [f, heading] = [this.getFileById(context.slice(5)), null];
    else if (context === 'areas') {
      this.state.areaOrder = [...ids];
      this.saveState(); this.notify([]); return;
    } else if (context.startsWith('projects:')) {
      if (!has(this.state, 'projectOrder')) this.state.projectOrder = {};
      this.state.projectOrder[context.slice(9)] = [...ids];
      this.saveState(); this.notify([]); return;
    } else throw new NotFound(context);
    const sec = f.sectionFor(heading) || f.lead();
    const byId = new Map(sec.todos.map((t) => [t.id, t]));
    const ordered = ids.filter((i) => byId.has(i)).map((i) => byId.get(i));
    const named = new Set(ids);
    sec.todos = [...ordered, ...sec.todos.filter((t) => !named.has(t.id))];
    this._write(f);
  }

  // ------------------------------------------------------------------ Today's own headings
  // Headings you make in Today to divide the day ("Morning", "Errands"). Today
  // is no file, so they are kept in .dvarim/state.json beside todayOrder, as
  // [{id, name, todos}] in the order shown: `todos` says which to-dos are under
  // each, and todayOrder still says their order. A to-do under none is in the
  // run above the first heading, which is where a to-do new to Today lands. A
  // to-do keeps its heading when it leaves Today and comes back, and when it is
  // ticked and unticked; it is let go once it is done, deleted or gone, the
  // next time the headings change.

  /** Today's headings, in order: [{id, name, todos}]. */
  todayHeadings() {
    return (this.state.todayHeadings || []).map((h) => ({ id: h.id, name: h.name, todos: [...(h.todos || [])] }));
  }

  _todayHeading(hid) {
    const h = (this.state.todayHeadings || []).find((x) => x.id === hid);
    if (!h) throw new NotFound(`no such heading in Today: ${hid}`);
    return h;
  }

  /** Save the headings, letting go of to-dos that are done, in Trash or gone. */
  _saveTodayHeadings() {
    const live = (tid) => {
      const rel = this.todoIndex.get(tid);
      if (rel === undefined || this._inTrash(rel)) return false;
      const hit = this._file(rel).find(tid);
      return !!hit && hit[0].todos[hit[1]].status === 'open';
    };
    for (const h of this.state.todayHeadings || []) h.todos = (h.todos || []).filter(live);
    this.saveState();
    this.notify([]);
  }

  addTodayHeading(data = {}) {
    const hid = Store._clientId(data, 'h');
    if (!has(this.state, 'todayHeadings')) this.state.todayHeadings = [];
    const hs = this.state.todayHeadings;
    const had = hid !== null ? hs.find((h) => h.id === hid) : null;
    if (had) return { id: had.id, name: had.name, todos: [...had.todos] };   // sent twice from an outbox
    const name = pyStr(get(data, 'name', '')).trim().replace(/\s+/gu, ' ') || 'New Heading';
    const h = { id: hid || this.newId('h'), name, todos: [] };
    const pos = get(data, 'position');
    const after = pos !== null && typeof pos === 'object' && !Array.isArray(pos) ? hs.findIndex((x) => x.id === get(pos, 'after')) : -1;
    if (pos === 'top') hs.unshift(h);
    else if (after >= 0) hs.splice(after + 1, 0, h);           // where the + button was let go
    else hs.push(h);
    this._saveTodayHeadings();
    return { id: h.id, name: h.name, todos: [] };
  }

  updateTodayHeading(hid, patch) {
    const h = this._todayHeading(hid);
    const name = has(patch, 'name') ? pyStr(patch.name).trim().replace(/\s+/gu, ' ') : '';
    if (name) h.name = name;
    this._saveTodayHeadings();
    return { id: h.id, name: h.name, todos: [...h.todos] };
  }

  /** Its to-dos stay in Today, in the run above the first heading. */
  deleteTodayHeading(hid) {
    this._todayHeading(hid);
    this.state.todayHeadings = this.state.todayHeadings.filter((h) => h.id !== hid);
    this._saveTodayHeadings();
    return { ok: true };
  }

  /** Put these to-dos under one of Today's headings, or (null) under none. */
  fileInToday(ids, hid) {
    const target = hid === null ? null : this._todayHeading(hid);
    const moving = new Set(ids.filter((tid) => this.todoIndex.has(tid)));
    const hs = this.state.todayHeadings || [];
    if (!target && !hs.some((h) => h.todos.some((tid) => moving.has(tid)))) return this.todayHeadings();
    for (const h of hs) h.todos = h.todos.filter((tid) => !moving.has(tid));
    if (target) target.todos.push(...moving);
    this._saveTodayHeadings();
    return this.todayHeadings();
  }

  // ------------------------------------------------------------------ projects
  _uniquePath(folder, name) {
    const base = sanitizeName(name);
    let cand = `${folder}/${base}.md`, n = 2;
    while (this._exists(cand)) { cand = `${folder}/${base} ${n}.md`; n += 1; }
    return cand;
  }

  _uniqueDir(folder, name) {
    let cand = `${folder}/${name}`, n = 2;
    while (this._exists(cand)) { cand = `${folder}/${name} ${n}`; n += 1; }
    return cand;
  }

  createProject(data) {
    const pid = Store._clientId(data, 'p');
    if (pid !== null) {
      try { return this.projectJson(this.getFileById(pid)); } catch (e) { if (!(e instanceof NotFound)) throw e; }
    }
    let folder = PROJECTS_DIR;
    if (truthy(get(data, 'areaId'))) {
      const area = this.getFileById(data.areaId);
      folder = dirOf(area.path);
    }
    const rel = this._uniquePath(folder, truthy(get(data, 'name')) ? data.name : 'New Project');
    const fm = { id: pid || this.newId('p'), type: 'project', status: 'open', created: this.todayIso() };
    for (const k of ['when', 'deadline', 'repeat']) if (truthy(get(data, k))) fm[k] = data[k];
    if (truthy(get(data, 'someday'))) fm.someday = true;
    if (truthy(get(data, 'evening'))) fm.evening = true;
    if (truthy(get(data, 'tags'))) fm.tags = pyList(data.tags).map((x) => pyStr(x).replace(/^#+/u, ''));
    const f = new TaskFile(rel, fm);
    f.notes = pyStr(truthy(get(data, 'notes')) ? data.notes : '').trim();
    this._write(f);
    return this.projectJson(f);
  }

  updateProject(pid, patch) {
    let f = this.getFileById(pid);
    const fm = f.frontmatter;
    if (has(patch, 'notes') && patch.notes !== null) f.notes = pyStr(patch.notes).trim();
    for (const k of ['when', 'deadline', 'repeat', 'reminder']) {
      if (has(patch, k)) {
        if (truthy(patch[k])) fm[k] = patch[k];
        else delete fm[k];
      }
    }
    for (const k of ['someday', 'evening']) {
      if (has(patch, k)) {
        if (truthy(patch[k])) fm[k] = true;
        else delete fm[k];
      }
    }
    if (truthy(get(fm, 'when'))) delete fm.someday;
    if (has(patch, 'tags')) {
      const tags = pyList(truthy(patch.tags) ? patch.tags : []).filter((x) => pyStr(x).trim())
        .map((x) => pyStr(x).replace(/^#+/u, '').trim());
      if (tags.length) fm.tags = tags;
      else delete fm.tags;
    }
    let newPath = null;
    if (has(patch, 'areaId')) {
      let folder = PROJECTS_DIR;
      if (truthy(patch.areaId)) {
        const a = this.getFileById(patch.areaId);
        folder = dirOf(a.path);
      }
      if (folder !== dirOf(f.path)) {
        newPath = this._uniquePath(folder, truthy(get(patch, 'name')) ? patch.name : f.name);
      }
    }
    if (truthy(get(patch, 'name')) && sanitizeName(patch.name) !== f.name && newPath === null) {
      newPath = this._uniquePath(dirOf(f.path), patch.name);
    }
    if (newPath) this._moveFile(f, newPath);
    else this._write(f);
    return this.projectJson(f);
  }

  _moveFile(f, newRel) {
    const oldRel = f.path;
    this._removeFile(oldRel);
    this._drop(oldRel);
    f.path = newRel;
    this._write(f, false);
    this.notify([oldRel, newRel]);
  }

  completeProject(pid, completeOpen = false, status = 'done') {
    const f = this.getFileById(pid);
    f.frontmatter.status = status;
    f.frontmatter.completed = this.todayIso();
    if (completeOpen) {
      for (const t of f.allTodos()) {
        if (t.status === 'open') {
          t.status = status;
          t.completed = this.todayIso();
          this._todayOrderRemove(t.id);
        }
      }
    }
    this._write(f);
    return this.projectJson(f);
  }

  reopenProject(pid) {
    const f = this.getFileById(pid);
    f.frontmatter.status = 'open';
    delete f.frontmatter.completed;
    this._write(f);
    return this.projectJson(f);
  }

  deleteProject(pid) {
    const f = this.getFileById(pid);
    if (f.path.startsWith(TRASH_DIR + '/')) {
      this._removeFile(f.path);
      this._drop(f.path);
      this.notify([f.path]);
      return this.projectJson(f);
    }
    f.frontmatter.origin = dirOf(f.path);
    this._moveFile(f, this._uniquePath(TRASH_DIR, f.name));
    return this.projectJson(f);
  }

  restoreProject(pid) {
    const f = this.getFileById(pid);
    let folder = has(f.frontmatter, 'origin') ? f.frontmatter.origin : PROJECTS_DIR;
    delete f.frontmatter.origin;
    if (!this.tree.dirs.has(folder)) folder = PROJECTS_DIR;
    this._moveFile(f, this._uniquePath(folder, f.name));
    return this.projectJson(f);
  }

  // headings
  addHeading(pid, name, position = null) {
    const f = this.getFileById(pid);
    name = name.trim().replace(/\s+/gu, ' ') || 'New Heading';
    if (f.sectionFor(name)) throw new Conflict(`heading exists: ${name}`);
    const sec = new Section(new Heading(name));
    const isDict = position !== null && typeof position === 'object' && !Array.isArray(position);
    if (position === 'top') {
      const idx = f.sections.length && f.sections[0].heading === null ? 1 : 0;
      f.sections.splice(idx, 0, sec);
    } else if (isDict && (truthy(get(position, 'before')) || truthy(get(position, 'after')))) {
      // At a to-do, which is where the + button gets dropped: the to-dos below
      // this point in their section come under it, as typing "## Name" would.
      const tid = truthy(get(position, 'before')) ? position.before : position.after;
      const hit = f.find(tid);
      if (!hit) throw new NotFound(`no such to-do in this project: ${tid}`);
      const [at, i] = hit;
      const cut = truthy(get(position, 'before')) ? i : i + 1;
      sec.todos = at.todos.slice(cut);
      at.todos = at.todos.slice(0, cut);
      // unrecognised lines stay at the end of the text they followed
      sec.trailing = at.trailing;
      at.trailing = [];
      for (const t of sec.todos) t.heading = name;
      f.sections.splice(f.sections.indexOf(at) + 1, 0, sec);
    } else if (isDict && truthy(get(position, 'beforeHeading'))) {
      const [, other] = this.headingRef(position.beforeHeading);
      if (!f.sections.includes(other)) throw new NotFound(`no such heading in this project: ${position.beforeHeading}`);
      f.sections.splice(f.sections.indexOf(other), 0, sec);
    } else f.sections.push(sec);
    this._write(f);
    return { id: `${pid}:${name}`, name, archived: null };
  }

  updateHeading(hid, patch) {
    const [f, sec] = this.headingRef(hid);
    if (truthy(get(patch, 'name')) && patch.name.trim() !== sec.heading.name) {
      const nw = patch.name.trim().replace(/\s+/gu, ' ');
      if (f.sectionFor(nw)) throw new Conflict(`heading exists: ${nw}`);
      sec.heading.name = nw;
      for (const t of sec.todos) t.heading = nw;
    }
    if (has(patch, 'archived')) {
      sec.heading.archived = truthy(patch.archived) ? this.todayIso() : null;
      if (truthy(patch.archived)) {
        for (const t of sec.todos) {
          if (t.status === 'open') {
            t.status = 'done';
            t.completed = this.todayIso();
            this._todayOrderRemove(t.id);
          }
        }
      }
    }
    this._write(f);
    return { id: `${pyStr(f.frontmatter.id)}:${sec.heading.name}`, name: sec.heading.name, archived: sec.heading.archived };
  }

  deleteHeading(hid) {
    const [f, sec] = this.headingRef(hid);
    const idx = f.sections.indexOf(sec);
    let prev = idx > 0 ? f.sections[idx - 1] : f.lead();
    if (idx === 0) prev = f.lead();
    for (const t of sec.todos) t.heading = prev.heading ? prev.heading.name : null;
    prev.todos.push(...sec.todos);
    f.sections.splice(f.sections.indexOf(sec), 1);
    this._write(f);
    return { ok: true };
  }

  moveHeading(hid, targetPid) {
    const [f, sec] = this.headingRef(hid);
    const dst = this.getFileById(targetPid);
    if (dst.sectionFor(sec.heading.name)) throw new Conflict('heading exists in target');
    f.sections.splice(f.sections.indexOf(sec), 1);
    dst.sections.push(sec);
    this._write(f);
    this._write(dst);
    return { id: `${targetPid}:${sec.heading.name}`, name: sec.heading.name, archived: sec.heading.archived };
  }

  // ------------------------------------------------------------------ areas
  createArea(data) {
    const aid = Store._clientId(data, 'a');
    if (aid !== null) {
      try { return this.areaJson(this.getFileById(aid)); } catch (e) { if (!(e instanceof NotFound)) throw e; }
    }
    let name = sanitizeName(truthy(get(data, 'name')) ? data.name : 'New Area');
    let n = 2;
    const base = name;
    while (this._exists(`${AREAS_DIR}/${name}`)) { name = `${base} ${n}`; n += 1; }
    const rel = `${AREAS_DIR}/${name}/${name}.md`;
    const fm = { id: aid || this.newId('a'), type: 'area' };
    if (truthy(get(data, 'tags'))) fm.tags = pyList(data.tags).map((x) => pyStr(x).replace(/^#+/u, ''));
    const f = new TaskFile(rel, fm);
    f.notes = pyStr(truthy(get(data, 'notes')) ? data.notes : '').trim();
    this._write(f);
    return this.areaJson(f);
  }

  updateArea(aid, patch) {
    let f = this.getFileById(aid);
    if (has(patch, 'notes') && patch.notes !== null) f.notes = pyStr(patch.notes).trim();
    if (has(patch, 'tags')) {
      const tags = pyList(truthy(patch.tags) ? patch.tags : []).filter((x) => pyStr(x).trim())
        .map((x) => pyStr(x).replace(/^#+/u, '').trim());
      if (tags.length) f.frontmatter.tags = tags;
      else delete f.frontmatter.tags;
    }
    if (truthy(get(patch, 'name')) && sanitizeName(patch.name) !== f.name) {
      const nw = sanitizeName(patch.name);
      if (this._exists(`${AREAS_DIR}/${nw}`)) throw new Conflict('area exists');
      const oldDir = `${AREAS_DIR}/${f.name}`, newDir = `${AREAS_DIR}/${nw}`;
      // The note becomes "<new>.md" inside the folder, so a project (or any
      // note) already called that would be written over. Without case, as the
      // Mac's disk compares (store.py, the same check).
      const want = `${nw}.md`.toLowerCase();
      const clash = [...this.tree.files, ...this.tree.dirs]
        .filter((x) => dirOf(x) === oldDir && x.slice(oldDir.length + 1).toLowerCase() === want
          && x.slice(oldDir.length + 1) !== `${f.name}.md`)
        .sort(cmpStr);
      if (clash.length) throw new Conflict(`this area already holds something called ${clash[0].slice(oldDir.length + 1, -3)}; rename that first`);
      const projs = this.projects({ area: f, includeClosed: true });
      this._write(f, false);
      for (const p of projs) this._drop(p.path);
      this._drop(f.path);
      this._moveDir(oldDir, newDir);
      for (const rel of this._iterMd().sort(cmpStr)) {
        if (rel.startsWith(`${newDir}/`) && !this.files.has(rel)) {
          let r = rel;
          if (rel.endsWith(`/${f.name}.md`)) {
            r = `${newDir}/${nw}.md`;
            this._renameFile(rel, r);
          }
          this._load(r);
        }
      }
      f = this.getFileById(aid);
      this.notify([f.path]);
      return this.areaJson(f);
    }
    this._write(f);
    return this.areaJson(f);
  }

  /** A whole folder, in storage and in the mirrors. */
  _moveDir(from, to) {
    const prefix = from + '/';
    for (const p of [...this.tree.files]) {
      if (p.startsWith(prefix)) {
        this.tree.files.delete(p);
        const q = to + '/' + p.slice(prefix.length);
        this.tree.files.add(q);
        if (this._disk.has(p)) { this._disk.set(q, this._disk.get(p)); this._disk.delete(p); }
      }
    }
    for (const d of [...this.tree.dirs]) {
      if (d === from || d.startsWith(prefix)) {
        this.tree.dirs.delete(d);
        this.tree.dirs.add(to + d.slice(from.length));
      }
    }
    for (const d of parentDirs(to + '/x')) this.tree.dirs.add(d);
    this._enqueue({ op: 'move', from, to });
  }

  /** One file renamed as it is, in storage and in the mirrors (os.replace). */
  _renameFile(from, to) {
    this.tree.files.delete(from);
    this.tree.files.add(to);
    if (this._disk.has(from)) { this._disk.set(to, this._disk.get(from)); this._disk.delete(from); }
    this._enqueue({ op: 'move', from, to });
  }

  deleteArea(aid) {
    const f = this.getFileById(aid);
    for (const p of this.projects({ area: f, includeClosed: true })) this._moveFile(p, this._uniquePath(PROJECTS_DIR, p.name));
    const loose = [...f.allTodos()];
    if (loose.length) {
      const std = this._file(STANDALONE);
      for (const t of loose) {
        t.heading = null;
        std.lead().todos.push(t);
      }
      this._write(std);
    }
    const dir = `${AREAS_DIR}/${f.name}`;
    this._drop(f.path);
    this._removeFile(f.path);
    let kept = null;
    if (this.tree.dirs.has(dir)) {
      const prefix = dir + '/';
      const inside = [...this.tree.files].some((p) => p.startsWith(prefix)) || [...this.tree.dirs].some((d) => d.startsWith(prefix));
      if (!inside) {
        this.tree.dirs.delete(dir);
        this._enqueue({ op: 'removeDir', path: dir });
      } else {
        // something Dvarim does not own is still in it: it goes to Trash/, whole
        kept = this._uniqueDir(TRASH_DIR, f.name);
        this._moveDir(dir, kept);
      }
    }
    this.notify([f.path]);
    return { ok: true, kept };
  }

  // ------------------------------------------------------------------ trash & settings
  emptyTrash() {
    const trash = this._file(TRASH);
    const ids = [...trash.allTodos()].map((t) => t.id);
    trash.sections = [];
    this._write(trash);
    for (const tid of ids) this.todoIndex.delete(tid);
    for (const f of [...this.files.values()].filter((x) => x.kind === 'project' && x.path.startsWith(TRASH_DIR + '/'))) {
      this._removeFile(f.path);
      this._drop(f.path);
    }
    this.notify([TRASH]);
    return { ok: true };
  }

  getSettings() {
    return { ...(has(this.state, 'settings') ? this.state.settings : clone(DEFAULT_SETTINGS)) };
  }

  putSettings(patch) {
    if (!has(this.state, 'settings')) this.state.settings = clone(DEFAULT_SETTINGS);
    const s = this.state.settings;
    for (const [k, v] of Object.entries(patch)) {
      if (!has(DEFAULT_SETTINGS, k)) continue;
      if (k === 'calendars') s[k] = v === null ? null : v.map((x) => pyStr(x));
      else if (k === 'logCutoff') s[k] = v === null ? null : pyStr(v);
      else if (k === 'keymap') {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
        s[k] = Object.fromEntries(Object.entries(v).map(([a, b]) => [a, b === null ? null : pyStr(b)]));
      } else s[k] = v;
    }
    this.saveState();
    // heard like any change: other tabs, and a copy's sync (the mirror's),
    // which would otherwise keep it until something else changed
    this.notify([]);
    return { ...s };
  }
}
