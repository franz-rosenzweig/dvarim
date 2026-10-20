// The merge (src/merge.js, docs/SYNC.md): what a person expects when two
// devices changed one file, case by case; then a fuzzer that makes two random
// sessions of edits from real files and holds the merge to its promises —
// symmetric, nothing lost, nothing deleted that the other side changed, and
// settled (merging what is already merged changes nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeText, mergeLines, mergeOrder, sameContent } from '../src/merge.js';
import { parse, serialize } from '../src/mdformat.js';
import { Heading, Section, Todo, ChecklistItem } from '../src/model.js';
import { sampleVault } from './corpus.js';

const INBOX = [
  '- [ ] Call Dana 🆔 aaaaaaa1',
  '- [ ] Buy milk 🆔 aaaaaaa2 ⏳ 2026-09-23',
  '- [ ] Book the venue 🆔 aaaaaaa3',
  '',
].join('\n');
const merge = (b, o, t, path = 'Inbox.md') => mergeText(b, o, t, path).text;
const edit = (text, from, to) => { assert.ok(text.includes(from), from); return text.replace(from, to); };

test('one side ticks it, the other moves its date: both', () => {
  const ours = edit(INBOX, '- [ ] Buy milk 🆔 aaaaaaa2 ⏳ 2026-09-23', '- [x] Buy milk 🆔 aaaaaaa2 ⏳ 2026-09-23 ✅ 2026-09-23');
  const theirs = edit(INBOX, '⏳ 2026-09-23', '⏳ 2026-09-25');
  const m = merge(INBOX, ours, theirs);
  assert.match(m, /- \[x\] Buy milk 🆔 aaaaaaa2 ⏳ 2026-09-25 ✅ 2026-09-23/u);
  assert.equal(m, merge(INBOX, theirs, ours));
});

test('both change the same thing: the same rule on every device', () => {
  const a = edit(INBOX, '- [ ] Call Dana 🆔 aaaaaaa1', '- [x] Call Dana 🆔 aaaaaaa1 ✅ 2026-09-24');
  const b = edit(INBOX, '- [ ] Call Dana 🆔 aaaaaaa1', '- [x] Call Dana 🆔 aaaaaaa1 ✅ 2026-09-22');
  assert.match(merge(INBOX, a, b), /Call Dana 🆔 aaaaaaa1 ✅ 2026-09-22/u, 'done on both: the earlier day');
  const c = edit(INBOX, '- [ ] Call Dana 🆔 aaaaaaa1', '- [-] Call Dana 🆔 aaaaaaa1 ❌ 2026-09-24');
  assert.match(merge(INBOX, a, c), /- \[x\] Call Dana/u, 'done beats cancelled');
  const long = edit(INBOX, 'Call Dana 🆔', 'Call Dana about the contract 🆔');
  const short = edit(INBOX, 'Call Dana 🆔', 'Ring Dana 🆔');
  assert.match(merge(INBOX, long, short), /Call Dana about the contract/u, 'two titles: the longer');
  const later = edit(INBOX, '⏳ 2026-09-23', '⏳ 2026-09-30');
  const cleared = edit(INBOX, ' ⏳ 2026-09-23', '');
  const sooner = edit(INBOX, '⏳ 2026-09-23', '⏳ 2026-09-24');
  assert.match(merge(INBOX, later, sooner), /⏳ 2026-09-30/u, 'two dates: the later');
  assert.match(merge(INBOX, cleared, sooner), /⏳ 2026-09-24/u, 'a date set beats one cleared');
  for (const [x, y] of [[a, b], [a, c], [long, short], [later, sooner], [cleared, sooner]]) assert.equal(merge(INBOX, x, y), merge(INBOX, y, x));
});

test('added on both sides: both, each where it was put', () => {
  const ours = edit(INBOX, '- [ ] Book the venue', '- [ ] Pay the deposit 🆔 bbbbbbb1\n- [ ] Book the venue');
  const theirs = INBOX + '- [ ] Send invitations 🆔 ccccccc1\n';
  const m = merge(INBOX, ours, theirs);
  const titles = [...parse(m, 'Inbox.md').allTodos()].map((t) => t.title);
  assert.deepEqual(titles, ['Call Dana', 'Buy milk', 'Pay the deposit', 'Book the venue', 'Send invitations']);
});

test('deleted on one side: gone if the other left it alone, kept with the change if not', () => {
  const deleted = edit(INBOX, '- [ ] Call Dana 🆔 aaaaaaa1\n', '');
  assert.ok(!merge(INBOX, deleted, INBOX + '').includes('Call Dana'));
  const other = edit(INBOX, '- [ ] Book the venue 🆔 aaaaaaa3', '- [ ] Book the venue 🆔 aaaaaaa3 #party');
  assert.ok(!merge(INBOX, deleted, other).includes('Call Dana'), 'untouched on the other side: deleted');
  const changed = edit(INBOX, 'Call Dana 🆔 aaaaaaa1', 'Call Dana 🆔 aaaaaaa1 ⏰ 09:30 ⏳ 2026-09-24');
  assert.match(merge(INBOX, deleted, changed), /Call Dana .*🆔 aaaaaaa1/u, 'changed on the other side: kept');
});

test('tags and checklists: added anywhere is added, removed anywhere is removed', () => {
  const base = '- [ ] Pack 🆔 aaaaaaa1 #trip #home\n    - [ ] passport\n    - [ ] charger\n';
  const ours = '- [ ] Pack 🆔 aaaaaaa1 #trip #urgent\n    - [x] passport\n    - [ ] charger\n    - [ ] socks\n';
  const theirs = '- [ ] Pack 🆔 aaaaaaa1 #trip #home #abroad\n    - [ ] passport\n    - [ ] adapter\n';
  const t = [...parse(merge(base, ours, theirs), 'Inbox.md').allTodos()][0];
  assert.deepEqual(t.tags.sort(), ['abroad', 'trip', 'urgent']);
  assert.deepEqual(t.checklist.map((c) => [c.text, c.done]).sort(), [['adapter', false], ['passport', true], ['socks', false]]);
});

test('notes: lines changed on each side are both kept; the same line changed twice keeps both versions', () => {
  const base = '- [ ] Draft 🆔 aaaaaaa1\n    one\n    two\n    three\n';
  const ours = '- [ ] Draft 🆔 aaaaaaa1\n    ONE\n    two\n    three\n';
  const theirs = '- [ ] Draft 🆔 aaaaaaa1\n    one\n    two\n    three\n    four\n';
  assert.equal([...parse(merge(base, ours, theirs), 'Inbox.md').allTodos()][0].notes, 'ONE\ntwo\nthree\nfour');
  const other = '- [ ] Draft 🆔 aaaaaaa1\n    uno\n    two\n    three\n';
  const notes = [...parse(merge(base, ours, other), 'Inbox.md').allTodos()][0].notes.split('\n');
  assert.ok(notes.includes('ONE') && notes.includes('uno') && notes.includes('two'), notes.join('|'));
  assert.deepEqual(mergeLines(['a', 'b', 'c'], ['a', 'B', 'c'], ['a', 'b', 'c', 'd']).lines, ['a', 'B', 'c', 'd']);
});

test('a project file: front matter key by key, headings, and the file\'s own notes', () => {
  const base = '---\nid: p0000001\ntype: project\nstatus: open\n---\nThe plan.\n\n- [ ] First 🆔 aaaaaaa1\n\n## Later\n- [ ] Second 🆔 aaaaaaa2\n';
  const ours = base.replace('status: open\n', 'status: open\ndeadline: 2026-10-01\n').replace('## Later\n', '## Later\n- [ ] Third 🆔 aaaaaaa3\n');
  const theirs = base.replace('type: project\n', 'type: project\ntags:\n  - work\n').replace('The plan.', 'The plan, revised.')
    + '\n## Someday\n- [ ] Fourth 🆔 aaaaaaa4\n';
  const m = parse(merge(base, ours, theirs, 'Projects/P.md'), 'Projects/P.md');
  assert.equal(m.frontmatter.deadline, '2026-10-01');
  assert.deepEqual(m.frontmatter.tags, ['work']);
  assert.equal(m.notes, 'The plan, revised.');
  assert.deepEqual(m.sections.map((s) => s.heading && s.heading.name), [null, 'Later', 'Someday']);
  assert.deepEqual(m.sections[1].todos.map((t) => t.title), ['Third', 'Second']);
});

test('a line typed without an id keeps its place; a pasted duplicate id keeps both lines', () => {
  const ours = edit(INBOX, '- [ ] Call Dana 🆔 aaaaaaa1', '- [x] Call Dana 🆔 aaaaaaa1 ✅ 2026-09-23');
  const theirs = edit(INBOX, '- [ ] Book the venue', '- [ ] Typed in Obsidian\n- [ ] Book the venue');
  const titles = [...parse(merge(INBOX, ours, theirs), 'Inbox.md').allTodos()].map((t) => t.title);
  assert.deepEqual(titles, ['Call Dana', 'Buy milk', 'Typed in Obsidian', 'Book the venue']);
  const pasted = INBOX + '- [ ] Call Dana 🆔 aaaaaaa1\n';
  const m = merge(INBOX, pasted, edit(INBOX, 'Book the venue', 'Book the hall'));
  assert.equal((m.match(/Call Dana/gu) || []).length, 2);
});

test('when only one side changed, its text is taken exactly', () => {
  const odd = '- [ ]   Spaced   oddly 🆔 aaaaaaa1\n\n\n';
  assert.equal(merge(INBOX, INBOX, odd), odd);
  assert.equal(merge(INBOX, odd, INBOX), odd);
  assert.equal(merge(INBOX, odd, odd), odd);
});

test('[/] on one side and [ ] on the other: one to-do, in progress, with or without a base', () => {
  const started = edit(INBOX, '- [ ] Call Dana', '- [/] Call Dana');
  const noted = edit(INBOX, '- [ ] Book the venue 🆔 aaaaaaa3', '- [ ] Book the venue 🆔 aaaaaaa3\n    a note');
  for (const base of [INBOX, '']) {
    const m = merge(base, noted, started);
    assert.equal(m, merge(base, started, noted));
    assert.deepEqual(m.split('\n').filter((l) => l.includes('aaaaaaa1')), ['- [/] Call Dana 🆔 aaaaaaa1']);
    assert.match(m, /Book the venue 🆔 aaaaaaa3\n {4}a note/u);
  }
  // ticked on the other side: done beats in progress, and the box is [x]
  const ticked = edit(INBOX, '- [ ] Call Dana 🆔 aaaaaaa1', '- [x] Call Dana 🆔 aaaaaaa1 ✅ 2026-09-23');
  assert.match(merge(INBOX, ticked, started), /^- \[x\] Call Dana 🆔 aaaaaaa1 ✅ 2026-09-23$/mu);
  assert.match(merge('', started, ticked), /^- \[x\] Call Dana 🆔 aaaaaaa1 ✅ 2026-09-23$/mu);
});

test('renamed on both sides: the wording of the side further along, not the longer', () => {
  const ticked = edit(INBOX, '- [ ] Call Dana 🆔 aaaaaaa1', '- [x] Called Dana: all fine 🆔 aaaaaaa1 ✅ 2026-09-23');
  const started = edit(INBOX, '- [ ] Call Dana 🆔 aaaaaaa1', '- [/] Call Dana about the contract and the dates 🆔 aaaaaaa1');
  for (const base of [INBOX, '']) {
    const m = merge(base, started, ticked);
    assert.equal(m, merge(base, ticked, started));
    assert.deepEqual(m.split('\n').filter((l) => l.includes('aaaaaaa1')), ['- [x] Called Dana: all fine 🆔 aaaaaaa1 ✅ 2026-09-23']);
    assert.equal(merge(base, m, started), m, 'settled');
  }
  // as far along as each other: the longer, as before
  const other = edit(INBOX, 'Call Dana 🆔', 'Call Dana today 🆔');
  assert.match(merge(INBOX, started, other), /Call Dana about the contract and the dates/u);
});

test('orders: one side reordered, the other added', () => {
  assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['c', 'a', 'b'], ['a', 'b', 'x', 'c']), ['c', 'a', 'b', 'x']);
  assert.deepEqual(mergeOrder(['a', 'b'], ['a', 'x', 'b'], ['a', 'y', 'b']), mergeOrder(['a', 'b'], ['a', 'y', 'b'], ['a', 'x', 'b']));
});

// ---- the fuzzer -------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const DATES = ['2026-09-20', '2026-09-23', '2026-09-30', '2026-10-05', null];
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'שלום', 'party 🎉'];

/** A session of edits a person might make, on a parsed copy of the file. */
function session(text, path, r, side) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const f = parse(text, path);
  let made = 0;
  const steps = 1 + Math.floor(r() * 5);
  for (let i = 0; i < steps; i++) {
    const todos = [...f.allTodos()];
    const t = todos.length ? pick(todos) : null;
    const k = r();
    if (t && k < 0.15) { t.status = 'done'; t.completed = pick(DATES.slice(0, 4)); }
    else if (t && k < 0.25) t.when = pick(DATES);
    else if (t && k < 0.32) t.deadline = pick(DATES);
    else if (t && k < 0.4) t.title = `${t.title} ${pick(WORDS)}`;
    else if (t && k < 0.47) t.notes = t.notes ? `${t.notes}\n${pick(WORDS)}` : pick(WORDS);
    else if (t && k < 0.53) t.tags = r() < 0.5 ? [...new Set([...t.tags, pick(WORDS).split(' ')[0]])] : t.tags.slice(1);
    else if (t && k < 0.58) t.checklist = [...t.checklist, new ChecklistItem(pick(WORDS), r() < 0.3)];
    else if (k < 0.72) {
      const s = f.sections.length ? pick(f.sections) : f.lead();
      const n = new Todo({ id: `${side}${String(++made).padStart(3, '0')}${Math.floor(r() * 1e4).toString(36).padStart(4, '0')}`.slice(0, 8),
        title: `New ${pick(WORDS)}`, heading: s.heading ? s.heading.name : null });
      s.todos.splice(Math.floor(r() * (s.todos.length + 1)), 0, n);
    } else if (t && k < 0.8) {
      for (const s of f.sections) s.todos = s.todos.filter((x) => x !== t);
    } else if (t && k < 0.86) {
      for (const s of f.sections) s.todos = s.todos.filter((x) => x !== t);
      const s = pick(f.sections.length ? f.sections : [f.lead()]);
      t.heading = s.heading ? s.heading.name : null;
      s.todos.splice(Math.floor(r() * (s.todos.length + 1)), 0, t);
    } else if (k < 0.9) {
      const s = new Section(new Heading(`Heading ${side}${i}`));
      f.sections.push(s);
    } else if (k < 0.95) f.notes = f.notes ? `${f.notes}\n${pick(WORDS)}` : pick(WORDS);
    else if (f.kind === 'project') f.frontmatter = { ...f.frontmatter, deadline: pick(DATES.slice(0, 4)) };
    else if (t) f.lead().todos.push(new Todo({ title: `Typed ${pick(WORDS)}` }));
  }
  return serialize(f);
}

const FUZZ = Number(process.env.DVARIM_FUZZ || 3000);

test(`the merge keeps its promises on ${FUZZ} pairs of edit sessions`, () => {
  const r = rng(Number(process.env.DVARIM_SEED || 1));
  const files = sampleVault().filter((f) => f.path.endsWith('.md'));
  const problems = [];
  const keysOf = (text, path) => new Set([...parse(text, path).allTodos()].map((t) => t.id).filter(Boolean));
  const todo = (text, path, id) => [...parse(text, path).allTodos()].find((t) => t.id === id);
  for (let n = 0; n < FUZZ && problems.length < 5; n++) {
    const file = files[Math.floor(r() * files.length)];
    const base = serialize(parse(file.text, file.path));
    const ours = session(base, file.path, r, 'o');
    const theirs = session(base, file.path, r, 't');
    const m = mergeText(base, ours, theirs, file.path).text;
    const label = `${file.path} #${n}`;
    try {
      assert.equal(m, mergeText(base, theirs, ours, file.path).text, 'symmetric');
      assert.ok(sameContent(mergeText(base, m, m, file.path).text, m, file.path), 'merging the merged twice changes nothing');
      assert.ok(sameContent(mergeText(base, ours, m, file.path).text, m, file.path), 'ours, meeting the merge, settles on it');
      assert.ok(sameContent(mergeText(base, theirs, m, file.path).text, m, file.path), 'theirs, meeting the merge, settles on it');
      const mk = keysOf(m, file.path), bk = keysOf(base, file.path);
      for (const [side, text] of [['ours', ours], ['theirs', theirs]]) {
        const other = side === 'ours' ? theirs : ours;
        for (const id of keysOf(text, file.path)) {
          const added = !bk.has(id);
          const changed = !added && JSON.stringify({ ...todo(text, file.path, id), line: 0 }) !== JSON.stringify({ ...todo(base, file.path, id), line: 0 });
          const keptByOther = keysOf(other, file.path).has(id);
          if (added || changed || keptByOther) assert.ok(mk.has(id), `${side} ${added ? 'added' : changed ? 'changed' : 'kept'} ${id}, and it is gone`);
        }
      }
      for (const id of bk) {
        if (!keysOf(ours, file.path).has(id) && !keysOf(theirs, file.path).has(id)) assert.ok(!mk.has(id), `deleted on both, and ${id} is back`);
      }
      parse(m, file.path);
    } catch (e) {
      problems.push(`${label}: ${e.message}\n--- base\n${base}\n--- ours\n${ours}\n--- theirs\n${theirs}\n--- merged\n${m}`);
    }
  }
  if (problems.length) assert.fail(`${problems.length} broken promises; the first:\n${problems[0].slice(0, 4000)}`);
});
