// Does a storage keep the contract in storage.js? Run against any of them — the
// memory and IndexedDB ones, a Node folder, and above all the native shells'
// folders over their bridges, on the device itself — and get a list of what
// held and what did not.
//
// It works only inside a scratch folder under .dvarim/ (which the store never
// reads as notes), so it can be pointed at a real vault, and it removes that
// folder when it is done. On a device: Settings → Data → "Check this folder",
// or window.__dvarimLocal.conformance() from the shell's selftest.
import { Store } from './store.js';
import { Day } from './day.js';

class Failure extends Error {}

function expect(cond, what) {
  if (!cond) throw new Failure(what);
}

function same(a, b, what) {
  if (a !== b) throw new Failure(`${what}: expected ${JSON.stringify(b)?.slice(0, 120)}, got ${JSON.stringify(a)?.slice(0, 120)}`);
}

async function refuses(fn, what) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  expect(threw, what);
}

/** The same storage, seen from inside one of its folders. */
export class ScopedStorage {
  constructor(inner, prefix) {
    this.inner = inner;
    this.prefix = prefix;
  }

  _in(p) { return `${this.prefix}/${p}`; }

  _out(p) { return p.slice(this.prefix.length + 1); }

  async list() {
    const { files, dirs } = await this.inner.list();
    const mine = (p) => p.startsWith(this.prefix + '/');
    return { files: files.filter(mine).map((p) => this._out(p)), dirs: dirs.filter(mine).map((p) => this._out(p)) };
  }

  read(p) { return this.inner.read(this._in(p)); }
  readMany(ps) { return this.inner.readMany ? this.inner.readMany(ps.map((p) => this._in(p))) : Promise.all(ps.map((p) => this.read(p))); }
  write(p, t) { return this.inner.write(this._in(p), t); }
  remove(p) { return this.inner.remove(this._in(p)); }
  move(a, b) { return this.inner.move(this._in(a), this._in(b)); }
  mkdir(p) { return this.inner.mkdir(this._in(p)); }
  removeDir(p) { return this.inner.removeDir(this._in(p)); }
}

const NAMES = ['plain.md', 'with space.md', 'שלום.md', 'Café.md', 'party 🎉.md', 'a & b #1 50%.md', "it's (really).md",
  '.hidden.md', 'no extension'];

/**
 * @param {object} storage  anything with the storage.js interface
 * @param {{prefix?: string, log?: (line: string) => void}} [opts]
 * @returns {Promise<{ok: boolean, results: {name: string, ok: boolean, ms: number, error?: string}[]}>}
 */
export async function conformance(storage, opts = {}) {
  const prefix = opts.prefix || `.dvarim/conformance-${Date.now().toString(36)}`;
  const log = opts.log || (() => {});
  const at = (p) => `${prefix}/${p}`;
  const listed = async () => {
    const { files, dirs } = await storage.list();
    return { files: new Set(files), dirs: new Set(dirs) };
  };
  const results = [];

  const check = async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - t0 });
      log(`PASS  ${name}`);
    } catch (e) {
      const error = e instanceof Failure ? e.message : `${e && e.name}: ${e && e.message}`;
      results.push({ name, ok: false, ms: Date.now() - t0, error });
      log(`FAIL  ${name}: ${error}`);
    }
  };

  await check('a file comes back exactly as it was written', async () => {
    const texts = {
      'empty.md': '',
      'no-newline.md': 'no newline at the end',
      'crlf.md': 'Windows\r\nline endings\r\nkept\r\n',
      'bom.md': '\ufeffstarts with a byte-order mark\n',
      'unicode.md': '- [ ] שלום 🎉 Café ✅ 2026-09-23 🆔 aa11bb22\n\ttab and trailing space \n',
      'large.md': ('- [ ] line of a large file 🆔 aa11bb22\n').repeat(26000),     // about a megabyte
    };
    for (const [p, t] of Object.entries(texts)) await storage.write(at(p), t);
    for (const [p, t] of Object.entries(texts)) {
      const r = await storage.read(at(p));
      expect(r !== null, `${p} was written and then could not be read`);
      same(r.text.length, t.length, `${p}: length`);
      same(r.text, t, p);
      expect(typeof r.mtime === 'number' && Number.isFinite(r.mtime), `${p}: mtime should be a number`);
    }
  });

  await check('what is not there reads as null, one at a time or many', async () => {
    same(await storage.read(at('nope.md')), null, 'read of a missing file');
    same(await storage.read(at('no/such/folder.md')), null, 'read inside a missing folder');
    if (typeof storage.readMany === 'function') {
      await storage.write(at('many-1.md'), 'one');
      await storage.write(at('many-2.md'), 'two');
      const r = await storage.readMany([at('many-1.md'), at('nope.md'), at('many-2.md')]);
      expect(Array.isArray(r) && r.length === 3, 'readMany answers for each path asked, in order');
      same(r[0] && r[0].text, 'one', 'readMany[0]');
      same(r[1], null, 'readMany of a missing file');
      same(r[2] && r[2].text, 'two', 'readMany[2]');
      same((await storage.readMany([])).length, 0, 'readMany of nothing');
    }
  });

  await check('writing makes the folders it needs, and list shows them', async () => {
    await storage.write(at('deep/er/still/file.md'), 'x');
    const { files, dirs } = await listed();
    expect(files.has(at('deep/er/still/file.md')), 'the file is listed');
    for (const d of ['deep', 'deep/er', 'deep/er/still']) expect(dirs.has(at(d)), `the folder ${d} is listed`);
    expect(dirs.has(prefix), 'the scratch folder itself is listed');
  });

  await check('writing again replaces, and nothing is left beside it', async () => {
    await storage.write(at('again.md'), 'first, and longer than the second');
    await storage.write(at('again.md'), 'second');
    same((await storage.read(at('again.md'))).text, 'second', 'the second write');
    const { files } = await listed();
    const beside = [...files].filter((f) => f.startsWith(at('again')) && f !== at('again.md'));
    same(beside.length, 0, `no temporary file left beside it (${beside.join(', ')})`);
  });

  await check('names are kept exactly as they were written', async () => {
    for (const n of NAMES) await storage.write(at(`names/${n}`), n);
    const { files } = await listed();
    for (const n of NAMES) {
      // Café is written composed (NFC); a filesystem that hands it back
      // decomposed makes the store see a different file from the one it wrote
      expect(files.has(at(`names/${n}`)), `${JSON.stringify(n)} is listed under the name it was given`);
      same((await storage.read(at(`names/${n}`))).text, n, n);
    }
  });

  await check('remove takes a file away, and is quiet about one that is not there', async () => {
    await storage.write(at('gone.md'), 'x');
    await storage.remove(at('gone.md'));
    same(await storage.read(at('gone.md')), null, 'read after remove');
    expect(!(await listed()).files.has(at('gone.md')), 'not listed after remove');
    await storage.remove(at('gone.md'));
    await storage.remove(at('never/was.md'));
  });

  await check('move takes a file somewhere new, making folders', async () => {
    await storage.write(at('mv/from.md'), 'moving');
    await storage.move(at('mv/from.md'), at('mv/new/folder/to.md'));
    same(await storage.read(at('mv/from.md')), null, 'nothing left where it was');
    same((await storage.read(at('mv/new/folder/to.md'))).text, 'moving', 'the text where it went');
  });

  await check('move takes a whole folder, with everything in it', async () => {
    await storage.write(at('area/Area.md'), 'area');
    await storage.write(at('area/Project.md'), 'project');
    await storage.write(at('area/sub/deeper.md'), 'deeper');
    await storage.mkdir(at('area/empty'));
    await storage.move(at('area'), at('trash/area 2'));
    const { files, dirs } = await listed();
    for (const p of ['Area.md', 'Project.md', 'sub/deeper.md']) {
      expect(files.has(at(`trash/area 2/${p}`)), `${p} moved with its folder`);
      expect(!files.has(at(`area/${p}`)), `${p} is not left behind`);
    }
    expect(dirs.has(at('trash/area 2/empty')), 'an empty folder inside moved too');
    expect(!dirs.has(at('area')), 'the old folder is gone');
    same((await storage.read(at('trash/area 2/sub/deeper.md'))).text, 'deeper', 'the text inside');
  });

  await check('move will not put anything over what is already there', async () => {
    await storage.write(at('keep/a.md'), 'a');
    await storage.write(at('keep/b.md'), 'b');
    await refuses(() => storage.move(at('keep/a.md'), at('keep/b.md')), 'moving a file onto another is refused');
    same((await storage.read(at('keep/a.md'))).text, 'a', 'the one that was to move is still there');
    same((await storage.read(at('keep/b.md'))).text, 'b', 'the one in the way is untouched');
    await storage.write(at('keep2/c.md'), 'c');
    await refuses(() => storage.move(at('keep2'), at('keep')), 'moving a folder onto another is refused');
    same((await storage.read(at('keep/b.md'))).text, 'b', 'the folder in the way is untouched');
    same((await storage.read(at('keep2/c.md'))).text, 'c', 'the folder that was to move is still there');
    await refuses(() => storage.move(at('keep/a.md'), at('keep2')), 'moving a file onto a folder is refused');
    same((await storage.read(at('keep/a.md'))).text, 'a', 'and the file is still where it was');
  });

  await check('move puts a folder in place of an empty one, as rename does', async () => {
    // the store renames an area's folder onto one left empty by an earlier move
    await storage.write(at('rename/From/note.md'), 'from');
    await storage.mkdir(at('rename/To'));
    await storage.move(at('rename/From'), at('rename/To'));
    same((await storage.read(at('rename/To/note.md'))).text, 'from', 'the folder took the empty one\'s place');
    expect(!(await listed()).dirs.has(at('rename/From')), 'and is gone from where it was');
  });

  await check('mkdir makes a folder and its parents, and is quiet about one that is there', async () => {
    await storage.mkdir(at('made/by/mkdir'));
    await storage.mkdir(at('made/by/mkdir'));
    const { dirs } = await listed();
    for (const d of ['made', 'made/by', 'made/by/mkdir']) expect(dirs.has(at(d)), `${d} is listed, empty or not`);
  });

  await check('removeDir takes only an empty folder', async () => {
    await storage.write(at('full/x.md'), 'x');
    same(await storage.removeDir(at('full')), false, 'a folder with a file in it is kept, and says so');
    same((await storage.read(at('full/x.md'))).text, 'x', 'and the file in it is untouched');
    await storage.mkdir(at('empty-one'));
    same(await storage.removeDir(at('empty-one')), true, 'an empty folder goes');
    expect(!(await listed()).dirs.has(at('empty-one')), 'and is no longer listed');
    same(await storage.removeDir(at('never-was')), true, 'a folder that is not there is not there');
  });

  await check('paths that leave the folder are refused', async () => {
    for (const bad of ['../escape.md', '/etc/hosts', `${prefix}/../../escape.md`, `${prefix}//double.md`, `./${prefix}/dot.md`, '']) {
      await refuses(() => storage.read(bad), `read(${JSON.stringify(bad)})`);
    }
    await refuses(() => storage.write(`${prefix}/x/../y.md`, 'x'), 'write through ..');
    await refuses(() => storage.remove('../escape.md'), 'remove through ..');
  });

  await check('calls sent together are all carried out, in the order sent', async () => {
    const writes = [];
    for (let i = 0; i < 30; i++) writes.push(storage.write(at(`burst/${String(i).padStart(2, '0')}.md`), `n${i}`));
    await Promise.all(writes);
    const { files } = await listed();
    same([...files].filter((f) => f.startsWith(at('burst/'))).length, 30, 'files after 30 writes at once');
    const same5 = [];
    for (let i = 0; i < 5; i++) same5.push(storage.write(at('order.md'), `version ${i}`));
    await Promise.all(same5);
    same((await storage.read(at('order.md'))).text, 'version 4', 'the last of five writes to one file wins');
    await Promise.all([storage.write(at('order2.md'), 'x'), storage.remove(at('order2.md')), storage.write(at('order2.md'), 'back')]);
    same((await storage.read(at('order2.md'))).text, 'back', 'write, remove, write: in that order');
  });

  await check('the engine works on it: to-dos in, edits noticed', async () => {
    const scoped = new ScopedStorage(storage, at('vault'));
    let n = 0;
    const store = await Store.open(scoped, {
      today: () => Day.fromISO('2026-09-23'),
      newId: (p = '') => p + String(++n).padStart(8 - p.length, '0'),
    });
    const area = store.createArea({ name: 'Work' });
    const project = store.createProject({ name: 'Launch', areaId: area.id });
    store.createTodo({ title: 'Book the venue', projectId: project.id });
    store.createTodo({ title: 'Call Dana', inbox: true, when: '2026-09-23' });
    await store.flush();
    const projectFile = (await scoped.read('Areas/Work/Launch.md'));
    expect(projectFile && projectFile.text.includes('- [ ] Book the venue 🆔 '), 'the project file has its to-do');
    const inbox = await scoped.read('Inbox.md');
    // someone else — Obsidian, a sync — ticks it and adds a line
    await scoped.write('Inbox.md', inbox.text.replace('- [ ]', '- [x]') + '- [ ] Typed elsewhere\n');
    same(JSON.stringify(await store.scanChanges()), JSON.stringify(['Inbox.md']), 'the change is noticed');
    const todos = [...store.files.get('Inbox.md').allTodos()];
    same(todos[0].status, 'done', 'the tick is read');
    same(todos[1].title, 'Typed elsewhere', 'the new line is read');
    // an area folder holding something Dvarim does not own: deleting the area
    // moves its project out and the folder, with that thing, into Trash/
    await scoped.write('Areas/Work/someone else\'s.txt', 'not a note');
    await store.scanChanges();
    store.deleteArea(area.id);
    await store.flush();
    const { files } = await scoped.list();
    expect(files.includes('Projects/Launch.md'), 'the area\'s project moved out to Projects/');
    expect(files.includes('Trash/Work/someone else\'s.txt'), 'the folder, with what it held, went to Trash/');
    expect(!files.some((f) => f.startsWith('Areas/Work/')), 'nothing left where the area was');
  });

  if (typeof storage.info === 'function') {
    await check('it can say which folder it is', async () => {
      const info = await storage.info();
      expect(info && typeof info.name === 'string' && info.name, 'info().name names the folder');
    });
  }

  // leave nothing behind, whatever happened above
  try {
    const { files, dirs } = await storage.list();
    for (const f of files.filter((p) => p === prefix || p.startsWith(prefix + '/'))) await storage.remove(f);
    const mine = dirs.filter((d) => d === prefix || d.startsWith(prefix + '/')).sort((a, b) => b.split('/').length - a.split('/').length);
    for (const d of mine) await storage.removeDir(d);
  } catch (e) {
    log(`could not clear ${prefix}: ${e && e.message}`);
  }
  await check('and it leaves nothing behind', async () => {
    const { files, dirs } = await storage.list();
    same(files.filter((p) => p.startsWith(prefix + '/')).length, 0, 'files left in the scratch folder');
    expect(!dirs.includes(prefix), 'the scratch folder is gone');
  });

  return { ok: results.every((r) => r.ok), results };
}
