// A folder on disk, for Node: the server, and tests. Writes go to a temporary
// name beside the file and are renamed over it, as the Python store does, so a
// reader never sees half a file.
import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { IGNORED_DIRS, StorageError, checkPath } from './storage.js';

const missing = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

export class NodeStorage {
  constructor(root) {
    this.root = root;
    this._chain = Promise.resolve();
  }

  /** One call at a time, in the order they came: two writes to one file would
   *  otherwise share its temporary name (storage.js: calls are carried out in
   *  the order sent). */
  _serial(fn) {
    const p = this._chain.then(fn);
    this._chain = p.catch(() => {});
    return p;
  }

  _abs(path) { return join(this.root, ...checkPath(path).split('/')); }

  async _exists(abs) {
    try { await fs.lstat(abs); return true; } catch (e) { if (missing(e)) return false; throw e; }
  }

  list() { return this._serial(() => this._list()); }

  async _list() {
    const files = [], dirs = [];
    const walk = async (dir) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        const rel = relative(this.root, p).split(sep).join('/');
        if (e.isDirectory()) {
          dirs.push(rel);
          // what is inside .git, .obsidian… is nobody's business here (storage.js)
          if (!(IGNORED_DIRS.has(e.name) && e.name !== '.dvarim')) await walk(p);
        } else if (e.isFile()) files.push(rel);
      }
    };
    await walk(this.root);
    return { files, dirs };
  }

  read(path) { return this._serial(() => this._read(path)); }

  async _read(path) {
    try {
      const abs = this._abs(path);
      const [text, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
      return { text, mtime: Number(st.mtimeMs) };
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  }

  readMany(paths) {
    return this._serial(() => Promise.all(paths.map((p) => this._read(p))));
  }

  write(path, text) { return this._serial(() => this._write(path, text)); }

  async _write(path, text) {
    const abs = this._abs(path);
    await fs.mkdir(dirname(abs), { recursive: true });
    const tmp = abs + '.dvarim-tmp';
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, abs);
    const st = await fs.stat(abs);
    return { mtime: Number(st.mtimeMs) };
  }

  remove(path) { return this._serial(() => this._remove(path)); }

  async _remove(path) {
    await fs.rm(this._abs(path), { force: true });
  }

  move(from, to) { return this._serial(() => this._move(from, to)); }

  async _move(from, to) {
    const src = this._abs(from), dst = this._abs(to);
    let srcStat;
    try { srcStat = await fs.lstat(src); } catch (e) { if (missing(e)) throw new StorageError('ENOENT', `not there: ${from}`); throw e; }
    if (await this._exists(dst)) {
      // rename() would put a file over one already there without a word; a
      // folder onto an empty folder is rename(2)'s own rule, and the store's
      const dstStat = await fs.lstat(dst);
      const empty = dstStat.isDirectory() && (await fs.readdir(dst)).length === 0;
      if (!(empty && srcStat.isDirectory())) throw new StorageError('EEXIST', `already there: ${to}`);
    }
    await fs.mkdir(dirname(dst), { recursive: true });
    await fs.rename(src, dst);
  }

  mkdir(path) { return this._serial(() => this._mkdir(path)); }

  async _mkdir(path) {
    await fs.mkdir(this._abs(path), { recursive: true });
  }

  removeDir(path) { return this._serial(() => this._removeDir(path)); }

  async _removeDir(path) {
    try {
      await fs.rmdir(this._abs(path));
      return true;
    } catch (e) {
      if (missing(e)) return true;
      if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') return false;
      throw e;
    }
  }
}
