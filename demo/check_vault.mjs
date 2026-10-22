// Opens the taste's demo vault (demo/vault.js) with the engine, as the page
// will, and checks it reads the way the taste page says it does. Run by
// tools/build_taste.py before it builds anything:
//
//     node demo/check_vault.mjs            # exits 1 and says why, if not
//
// Every file must be read without the engine wanting to change it (a to-do
// it would have to give an id, a date it can't read), Today must hold the ten
// to-dos the vault means it to, and Upcoming, Anytime, Someday, the Logbook and
// the Inbox must each have something in them.
import { demoVault } from './vault.js';
import { Store, MemoryStorage } from '../engine/src/index.js';
import { Api } from '../engine/src/api.js';

const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); };

const files = demoVault();
const storage = new MemoryStorage();
for (const [path, text] of Object.entries(files)) await storage.write(path, text);

const store = await Store.open(storage, { tutorial: true });
const api = new Api(store, {});
const get = async (p) => {
  const r = await api.handle('GET', p);
  if (r.status !== 200) throw new Error(`GET ${p}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

await store.flush();
const after = await storage.snapshot();
for (const [path, text] of Object.entries(files)) {
  if (path.startsWith('.dvarim/')) continue;
  check(after[path] === text, `the engine rewrote ${path} on opening it`);
}

const count = (body) => JSON.stringify(body).match(/"title":/g)?.length || 0;
const state = await get('/state');
check(state.counts.today === 10, `Today has ${state.counts.today} to-dos, not 10`);
check(state.areas.length === 2, `${state.areas.length} areas, not 2 (Home and Work)`);
check(state.areas[0].name === 'Home', `the first area is ${state.areas[0] && state.areas[0].name}, not Home`);
for (const list of ['inbox', 'upcoming', 'anytime', 'someday', 'logbook']) {
  const body = await get(`/lists/${list}`);
  check(count(body) > 0, `${list} is empty`);
}
const today = await get('/lists/today');
const titles = JSON.stringify(today);
check(titles.indexOf('Write the new About page') < titles.indexOf('Pay the electricity bill'), 'Today is not in the order state.json gives it');
check(titles.includes('This Evening') || /evening/i.test(titles), 'Today has no This Evening');
check(Object.keys(files).includes('Projects/Meet Dvarim.md'), 'the tutorial project is missing');

if (problems.length) {
  console.error('demo vault: ' + problems.join('; '));
  process.exit(1);
}
console.log(`demo vault: ${Object.keys(files).length} files, ${state.counts.today} for today, all read as written`);
