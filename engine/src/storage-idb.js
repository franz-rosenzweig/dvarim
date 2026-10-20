// A vault kept in the browser, in IndexedDB: each file a record of its path
// and text. It is what the web app uses when it keeps its own copy instead of
// asking a server, and what the native apps can fall back to before they have
// been given a folder. The files are the same Markdown a folder would hold;
// only where they live differs.
import { StorageError, checkPath } from './storage.js';

const VERSION = 1;

function promised(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IdbStorage {
  /** @param {string} name  the database, one per vault */
  constructor(name = 'dvarim-vault') {
    this.name = name;
    this._db = null;
    this.clock = Date.now();
  }

  async _open() {
    if (this._db) return this._db;
    const req = indexedDB.open(this.name, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('dirs')) db.createObjectStore('dirs', { keyPath: 'path' });
    };
    this._db = await promised(req);
    return this._db;
  }

  async _tx(stores, mode, fn) {
    const db = await this._open();
    const tx = db.transaction(stores, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
    const out = await fn(...stores.map((s) => tx.objectStore(s)));
    await done;
    return out;
  }

  _mtime() {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  _parents(dirs, path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.put({ path: parts.slice(0, i).join('/') });
  }

  async list() {
    return this._tx(['files', 'dirs'], 'readonly', async (files, dirs) => ({
      files: await promised(files.getAllKeys()),
      dirs: await promised(dirs.getAllKeys()),
    }));
  }

  async read(path) {
    const rec = await this._tx(['files'], 'readonly', (files) => promised(files.get(checkPath(path))));
    return rec ? { text: rec.text, mtime: rec.mtime } : null;
  }

  /** Every file asked for, in one transaction. */
  async readMany(paths) {
    paths.forEach(checkPath);
    const recs = await this._tx(['files'], 'readonly', (files) => Promise.all(paths.map((p) => promised(files.get(p)))));
    return recs.map((rec) => (rec ? { text: rec.text, mtime: rec.mtime } : null));
  }

  async write(path, text) {
    checkPath(path);
    const mtime = this._mtime();
    await this._tx(['files', 'dirs'], 'readwrite', (files, dirs) => {
      files.put({ path, text, mtime });
      this._parents(dirs, path);
    });
    return { mtime };
  }

  async remove(path) {
    await this._tx(['files'], 'readwrite', (files) => { files.delete(checkPath(path)); });
  }

  async mkdir(path) {
    await this._tx(['dirs'], 'readwrite', (dirs) => { this._parents(dirs, checkPath(path) + '/x'); });
  }

  async move(from, to) {
    checkPath(from); checkPath(to);
    await this._tx(['files', 'dirs'], 'readwrite', async (files, dirs) => {
      if (await promised(files.get(to))) throw new StorageError('EEXIST', `already there: ${to}`);
      if (await promised(dirs.get(to))) {
        // an empty folder in the way is replaced, as rename(2) does; anything else is not
        const inTo = to + '/';
        const busy = (await promised(files.getAllKeys())).some((p) => p.startsWith(inTo))
          || (await promised(dirs.getAllKeys())).some((d) => d.startsWith(inTo));
        if (busy || !(await promised(dirs.get(from)))) throw new StorageError('EEXIST', `already there: ${to}`);
        dirs.delete(to);
      }
      const one = await promised(files.get(from));
      if (one) {
        files.delete(from);
        files.put({ ...one, path: to });
        this._parents(dirs, to);
        return;
      }
      const prefix = from + '/';
      for (const rec of await promised(files.getAll())) {
        if (rec.path.startsWith(prefix)) {
          files.delete(rec.path);
          const q = to + '/' + rec.path.slice(prefix.length);
          files.put({ ...rec, path: q });
          this._parents(dirs, q);
        }
      }
      for (const d of await promised(dirs.getAllKeys())) {
        if (d === from || d.startsWith(prefix)) {
          dirs.delete(d);
          dirs.put({ path: to + d.slice(from.length) });
        }
      }
      this._parents(dirs, to + '/x');
    });
  }

  async removeDir(path) {
    checkPath(path);
    return this._tx(['files', 'dirs'], 'readwrite', async (files, dirs) => {
      const prefix = path + '/';
      const busy = (await promised(files.getAllKeys())).some((p) => p.startsWith(prefix))
        || (await promised(dirs.getAllKeys())).some((d) => d.startsWith(prefix));
      if (busy) return false;
      dirs.delete(path);
      return true;
    });
  }

  /** Every file's text — for export, and for tests. */
  async snapshot() {
    const recs = await this._tx(['files'], 'readonly', (files) => promised(files.getAll()));
    return Object.fromEntries(recs.map((r) => [r.path, r.text]));
  }

  /** Remove the whole vault from this browser. */
  async destroy() {
    if (this._db) { this._db.close(); this._db = null; }
    await promised(indexedDB.deleteDatabase(this.name));
  }
}
