// Where the files are. The engine's store works on its own copy of the vault
// in memory and speaks to storage only to load it, to write what changed, and
// to notice what someone else changed. Every storage is this interface, and
// every call is asynchronous, because the Mac's and Android's bridges are.
//
//   list()            every file under the root, as POSIX paths, and every
//                     directory: { files: string[], dirs: string[] }. It may
//                     leave out what is inside IGNORED_DIRS other than .dvarim
//                     (.git, .obsidian…): nothing reads there.
//   read(path)        { text, mtime } or null if there is no such file
//   readMany(paths)   optional: [read(p) for each p], in one go — a folder
//                     scan is then one round trip over a bridge, not hundreds
//   write(path, text) atomically, making parent directories → { mtime }
//   remove(path)      a file; nothing if it is not there
//   move(from, to)    a file or a whole directory, making parents. Refuses
//                     (throws) if a file or a non-empty directory is at `to`,
//                     and loses nothing; a directory may replace an empty one,
//                     as rename(2) does (the store relies on that)
//   removeDir(path)   a directory, only if it is empty: true if there is none
//                     there afterwards, false if it had something in it
//   mkdir(path)       a directory and its parents; nothing if it is there
//
// A path is relative to the root, '/'-separated, with no '', '.' or '..'
// segment; anything else is refused (checkPath). Text is exactly what was
// written: no newline translation, no byte-order mark, no normalisation.
// mtime is a number that changes when the file does; nothing else reads it.
// docs/BRIDGE.md is this contract as the native shells implement it, and
// storage-conformance.js checks any storage against it.

/** Directories the store never reads inside (store.js has the same list). */
export const IGNORED_DIRS = new Set(['.dvarim', '.obsidian', '.trash', '.git', '.stfolder', '.stversions', 'node_modules']);

export class StorageError extends Error {
  /** @param {string} code  ENOENT, EEXIST, EINVAL, EACCES, ENOSPC, EIO… */
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

/** A path storage will take, or a StorageError. */
export function checkPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new StorageError('EINVAL', `not a path inside the vault: ${JSON.stringify(path)}`);
  }
  return path;
}

/** readMany for a storage that has only read. */
export async function readEach(storage, paths) {
  if (typeof storage.readMany === 'function') return storage.readMany(paths);
  const out = [];
  for (const p of paths) out.push(await storage.read(p));
  return out;
}

/** A vault in memory: for tests, and for the browser before it has a folder. */
export class MemoryStorage {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files).map(([p, text]) => [p, { text, mtime: 1 }]));
    this.dirs = new Set();
    for (const p of this.files.keys()) this._parents(p);
    this.clock = 1;
  }

  _parents(path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }

  async list() {
    return { files: [...this.files.keys()], dirs: [...this.dirs] };
  }

  async read(path) {
    const f = this.files.get(checkPath(path));
    return f ? { text: f.text, mtime: f.mtime } : null;
  }

  async readMany(paths) {
    return Promise.all(paths.map((p) => this.read(p)));
  }

  async write(path, text) {
    this._parents(checkPath(path));
    const mtime = ++this.clock;
    this.files.set(path, { text, mtime });
    return { mtime };
  }

  async remove(path) {
    this.files.delete(checkPath(path));
  }

  async move(from, to) {
    checkPath(from); checkPath(to);
    if (!this.files.has(from) && !this.dirs.has(from)) throw new StorageError('ENOENT', `not there: ${from}`);
    const toPrefix = to + '/';
    const emptyDir = this.dirs.has(to) && ![...this.files.keys()].some((p) => p.startsWith(toPrefix))
      && ![...this.dirs].some((d) => d.startsWith(toPrefix));
    if (this.files.has(to) || (this.dirs.has(to) && !(emptyDir && this.dirs.has(from)))) {
      throw new StorageError('EEXIST', `already there: ${to}`);
    }
    if (emptyDir) this.dirs.delete(to);          // rename(2): an empty folder in the way is replaced
    if (this.files.has(from)) {
      this._parents(to);
      this.files.set(to, this.files.get(from));
      this.files.delete(from);
      return;
    }
    const prefix = from + '/';
    for (const [p, f] of [...this.files]) {
      if (p.startsWith(prefix)) {
        this.files.delete(p);
        const q = to + '/' + p.slice(prefix.length);
        this._parents(q);
        this.files.set(q, f);
      }
    }
    for (const d of [...this.dirs]) {
      if (d === from || d.startsWith(prefix)) {
        this.dirs.delete(d);
        this.dirs.add(to + d.slice(from.length));
      }
    }
    this._parents(to + '/x');
  }

  async mkdir(path) {
    this._parents(checkPath(path) + '/x');
  }

  /** True when there is no directory there afterwards, false when it was not empty. */
  async removeDir(path) {
    const prefix = checkPath(path) + '/';
    if ([...this.files.keys()].some((p) => p.startsWith(prefix))) return false;
    if ([...this.dirs].some((d) => d.startsWith(prefix))) return false;
    this.dirs.delete(path);
    return true;
  }

  /** Every file's text, for tests: { path: text }. */
  snapshot() {
    return Object.fromEntries([...this.files].map(([p, f]) => [p, f.text]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}
