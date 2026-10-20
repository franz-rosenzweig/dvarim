// Two versions of one file, and the version both started from, made into one
// (docs/SYNC.md). A to-do is matched by its 🆔, so the merge is to-do by to-do
// and field by field rather than line by line: one device ticking a to-do and
// another moving its date keeps both. Front matter merges key by key, notes
// line by line, headings and the order of things as sequences.
//
// Symmetric by construction — merge(base, a, b) is merge(base, b, a) — so two
// devices merging the same pair write the same bytes, and the sync that
// brought them together has nothing left to disagree about. Where both sides
// changed the same thing differently, a rule picks, and every rule is a
// function of the two values, never of which side is "ours".
import { parse, serialize } from './mdformat.js';
import * as frontmatter from './frontmatter.js';
import { ChecklistItem, Heading, Section, TaskFile, Todo } from './model.js';
import { lineId } from './ids.js';
import { sha1 } from './sha1.js';
import { pyStr } from './util.js';

const json = (v) => JSON.stringify(v === undefined ? null : v);
const eq = (a, b) => json(a) === json(b);

/** The one of two values that sorts first as JSON: an arbitrary but symmetric pick. */
const canonical = (a, b) => (json(a) <= json(b) ? a : b);

// ---- lines ---------------------------------------------------------------------

/** Pairs [i, j] of a longest common subsequence of two arrays of lines. */
function lcs(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return null;             // too big to compare line by line
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return pairs;
}

/** Every line of `a`, in order, somewhere in `b`. */
function within(a, b) {
  let j = 0;
  for (const line of a) {
    while (j < b.length && b[j] !== line) j++;
    if (j === b.length) return false;
    j++;
  }
  return true;
}

/** Both versions of a stretch both sides changed: the one that already holds
 *  the other, else the shortest run of lines holding both (their common lines
 *  once), in a fixed order — so merging it again with either side changes
 *  nothing. */
function both(x, y) {
  if (within(x, y)) return [...y];
  if (within(y, x)) return [...x];
  [x, y] = json(x) <= json(y) ? [x, y] : [y, x];
  const pairs = lcs(x, y) || [];
  const out = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [x.length, y.length]]) {
    out.push(...x.slice(i, pi), ...y.slice(j, pj));
    if (pi < x.length) out.push(x[pi]);
    i = pi + 1; j = pj + 1;
  }
  return out;
}

/**
 * Three versions of a list of lines, merged: what only one side changed is
 * that side's, what both changed alike is kept once, and where they changed
 * the same stretch differently both versions are kept (both(), above).
 * @returns {{lines: string[], conflicts: number}}
 */
export function mergeLines(base, ours, theirs) {
  if (eq(ours, base)) return { lines: [...theirs], conflicts: 0 };
  if (eq(theirs, base) || eq(ours, theirs)) return { lines: [...ours], conflicts: 0 };
  const po = lcs(base, ours), pt = lcs(base, theirs);
  if (!po || !pt) return { lines: both(ours, theirs), conflicts: 1 };
  const mo = new Map(po), mt = new Map(pt);
  const out = [];
  let conflicts = 0, i = 0, o = 0, t = 0;
  const chunk = (bb, oo, tt) => {
    if (eq(oo, bb)) out.push(...tt);
    else if (eq(tt, bb) || eq(oo, tt)) out.push(...oo);
    else {
      conflicts++;
      out.push(...both(oo, tt));
    }
  };
  for (;;) {
    // the next base line both sides kept: a stable point between changes
    let k = i;
    while (k < base.length && !(mo.has(k) && mt.has(k) && mo.get(k) >= o && mt.get(k) >= t)) k++;
    if (k >= base.length) {
      chunk(base.slice(i), ours.slice(o), theirs.slice(t));
      break;
    }
    chunk(base.slice(i, k), ours.slice(o, mo.get(k)), theirs.slice(t, mt.get(k)));
    out.push(base[k]);
    i = k + 1; o = mo.get(k) + 1; t = mt.get(k) + 1;
  }
  return { lines: out, conflicts };
}

function mergeTextBlock(b, o, t) {
  const split = (s) => (s ? s.split('\n') : []);
  const r = mergeLines(split(b), split(o), split(t));
  return { text: r.lines.join('\n'), conflicts: r.conflicts };
}

// ---- sequences -----------------------------------------------------------------

/**
 * An order for the union of three sequences of unique keys. The side that
 * reordered what all three share sets the order (if both did, the canonical
 * one does); what else either side added goes in after whatever preceded it
 * there.
 */
export function mergeOrder(base, ours, theirs) {
  const inAll = new Set(base.filter((k) => ours.includes(k) && theirs.includes(k)));
  const shared = (s) => s.filter((k) => inAll.has(k));
  const oursMoved = !eq(shared(ours), shared(base)), theirsMoved = !eq(shared(theirs), shared(base));
  let primary, secondary;
  if (oursMoved !== theirsMoved) [primary, secondary] = oursMoved ? [ours, theirs] : [theirs, ours];
  else [primary, secondary] = json(ours) <= json(theirs) ? [ours, theirs] : [theirs, ours];
  const out = [...primary];
  const placed = new Set(out);
  let after = -1;                                  // where the last key of `secondary` sits in `out`
  for (const k of [...secondary, ...base]) {
    if (placed.has(k)) { after = out.indexOf(k); continue; }
    out.splice(after + 1, 0, k);
    placed.add(k);
    after += 1;
  }
  return out;
}

// ---- fields --------------------------------------------------------------------

/** Three versions of one value: the side that changed it, or the rule's pick. */
function merge3(b, o, t, rule, conflicts, what) {
  if (eq(o, b)) return t;
  if (eq(t, b) || eq(o, t)) return o;
  conflicts.push(what);
  return rule(o, t);
}

const RANK = { done: 2, canceled: 1, open: 0 };

/** Done beats cancelled beats open; done on both sides, the earlier day. */
function statusRule([so, co], [st, ct]) {
  if (RANK[so] !== RANK[st]) return RANK[so] > RANK[st] ? [so, co] : [st, ct];
  if (co && ct) return co <= ct ? [so, co] : [st, ct];
  return co ? [so, co] : [st, ct];
}

/** Something set beats nothing; between two, the later. */
const laterRule = (a, b) => (a == null ? b : b == null ? a : (json(a) >= json(b) ? a : b));

/** The longer title, and between equals the canonical one. */
const titleRule = (a, b) => (a.length !== b.length ? (a.length > b.length ? a : b) : canonical(a, b));

/** Kept if both kept it, or either added it; gone if either removed it. */
function mergeSet(b, o, t) {
  const B = new Set(b), O = new Set(o), T = new Set(t);
  const keep = (k) => (O.has(k) && T.has(k)) || (O.has(k) && !B.has(k)) || (T.has(k) && !B.has(k));
  return mergeOrder(b, o, t).filter(keep);
}

/** Checklist items by their text (and which of the same text they are). */
function mergeChecklist(b, o, t, conflicts, what) {
  const keyed = (items) => {
    const seen = new Map();
    return items.map((c) => {
      const n = (seen.get(c.text) || 0) + 1;
      seen.set(c.text, n);
      return [`${n}\u0000${c.text}`, c];
    });
  };
  const B = new Map(keyed(b)), O = new Map(keyed(o)), T = new Map(keyed(t));
  const keys = mergeSet([...B.keys()], [...O.keys()], [...T.keys()]);
  return keys.map((k) => {
    const done = merge3(B.get(k)?.done, O.get(k)?.done ?? T.get(k)?.done, T.get(k)?.done ?? O.get(k)?.done,
      (x, y) => x || y, conflicts, what);
    return new ChecklistItem(k.slice(k.indexOf('\u0000') + 1), !!done);
  });
}

const SCALARS = [
  ['when', laterRule], ['deadline', laterRule], ['reminder', laterRule], ['repeat', laterRule],
  ['created', laterRule], ['trashed', laterRule], ['origin', laterRule],
  ['evening', (a, b) => a || b], ['someday', (a, b) => a || b],
  ['heading', canonical], ['mark', laterRule],
];

function mergeTodo(b, o, t, conflicts) {
  const what = (field) => `${t.title || o.title}: ${field}`;
  const base = b || {};
  const out = new Todo({ id: o.id || t.id });           // a line named on one side only: named
  // Renamed on both sides: the wording of the side further along — done, then
  // in progress, then open — since a to-do is often reworded to say what came
  // of it as it is ticked; else the longer. On 5 October a conflict copy
  // without a base brought "Licence sweep: confirm …" back over the "Licence
  // sweep of 5d9d0c4: nothing …" it had been ticked off as.
  const along = (x) => 2 * RANK[x.status] + (x.status === 'open' && x.mark ? 1 : 0);
  out.title = merge3(base.title, o.title, t.title,
    (x, y) => (along(o) !== along(t) ? (along(o) > along(t) ? o.title : t.title) : titleRule(x, y)), conflicts, what('title'));
  [out.status, out.completed] = merge3(b ? [b.status, b.completed] : undefined, [o.status, o.completed],
    [t.status, t.completed], statusRule, conflicts, what('done'));
  const notes = b ? mergeTextBlock(b.notes, o.notes, t.notes)
    : (o.notes === t.notes ? { text: o.notes, conflicts: 0 } : mergeTextBlock('', o.notes, t.notes));
  out.notes = notes.text;
  if (notes.conflicts) conflicts.push(what('notes'));
  out.tags = mergeSet(base.tags || [], o.tags, t.tags);
  out.checklist = mergeChecklist(base.checklist || [], o.checklist, t.checklist, conflicts, what('checklist'));
  for (const [field, rule] of SCALARS) out[field] = merge3(b ? b[field] : undefined, o[field], t[field], rule, conflicts, what(field));
  if (out.status !== 'open') out.mark = null;           // a box ticked is [x], however it was marked
  return out;
}

/** The same to-do, whatever line it is on. */
function sameTodo(a, b) {
  const plain = (x) => ({ ...x, line: 0, checklist: x.checklist.map((c) => [c.text, c.done]) });
  return eq(plain(a), plain(b));
}

// ---- files ---------------------------------------------------------------------

const NONE = new Set();

/**
 * Every to-do of a file with the key it is matched by, in file order: its 🆔;
 * a second line carrying the same 🆔 (pasted in Obsidian) as a second key, so
 * neither is lost; and a line typed without one by the 🆔 it is about to be
 * given — made from its heading, title and place among its twins, the same on
 * every device (store.js, _index and _write) — so a line named on one side and
 * not yet on the other is one to-do, not a change on both.
 */
function keyed(f) {
  const seen = new Map(), twins = new Map();
  return [...f.allTodos()].map((t) => {
    let id = t.id;
    if (!id) {
      const key = `${f.path}|${pyStr(t.heading)}|${t.title}`;
      twins.set(key, (twins.get(key) || 0) + 1);
      id = lineId('tmp' + sha1(`${key}|${twins.get(key)}`).slice(0, 9), NONE);
    }
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    return [n === 1 ? id : `${id}\u0002${n}`, t];
  });
}

const sectionKey = (s) => (s.heading ? `#${s.heading.name}` : '');

function fmText(f) {
  return frontmatter.dump(f.frontmatter, f.fmRaw);
}

/**
 * Merge three versions of one file's text.
 * @param {string|null} base   the version both started from ('' or null if none)
 * @param {string} ours
 * @param {string} theirs
 * @param {string} path        the file's vault path (what kind of file it is depends on it)
 * @returns {{text: string, conflicts: string[]}}  conflicts: what both sides changed differently
 */
export function mergeText(base, ours, theirs, path) {
  base = base || '';
  if (ours === base || ours === theirs) return { text: theirs, conflicts: [] };
  if (theirs === base) return { text: ours, conflicts: [] };
  const B = parse(base, path), O = parse(ours, path), T = parse(theirs, path);
  const conflicts = [];

  // front matter: all of whichever side left it alone, else key by key
  const out = new TaskFile(path, {});
  const [fb, fo, ft] = [fmText(B), fmText(O), fmText(T)];
  if (fo === fb || fo === ft) { out.frontmatter = T.frontmatter; out.fmRaw = T.fmRaw; }
  else if (ft === fb) { out.frontmatter = O.frontmatter; out.fmRaw = O.fmRaw; }
  else {
    const keys = mergeOrder(Object.keys(B.frontmatter), Object.keys(O.frontmatter), Object.keys(T.frontmatter));
    for (const k of keys) {
      const v = merge3(B.frontmatter[k], O.frontmatter[k], T.frontmatter[k], canonical, conflicts, `front matter: ${k}`);
      if (v !== undefined) out.frontmatter[k] = v;
    }
    out.fmRaw = fo <= ft ? O.fmRaw : T.fmRaw;
  }

  const notes = mergeTextBlock(B.notes, O.notes, T.notes);
  out.notes = notes.text;
  if (notes.conflicts) conflicts.push('the file\'s notes');

  // to-dos: present, merged, or gone
  const tb = new Map(keyed(B)), to = new Map(keyed(O)), tt = new Map(keyed(T));
  const kept = new Map();
  for (const id of new Set([...tb.keys(), ...to.keys(), ...tt.keys()])) {       // ids, or keys standing in for them
    const b = tb.get(id), o = to.get(id), t = tt.get(id);
    if (o && t) kept.set(id, mergeTodo(b, o, t, conflicts));
    else if (o || t) {
      const one = o || t;
      // deleted on one side: gone if the other left it alone, kept if it changed it
      if (!b || !sameTodo(one, b)) kept.set(id, one);
    }
  }

  // headings, and what is under each
  const sb = new Map(B.sections.map((s) => [sectionKey(s), s]));
  const so = new Map(O.sections.map((s) => [sectionKey(s), s]));
  const st = new Map(T.sections.map((s) => [sectionKey(s), s]));
  const needed = new Set([...kept.values()].map((t) => (t.heading == null ? '' : `#${t.heading}`)));
  const order = mergeOrder([...sb.keys()], [...so.keys()], [...st.keys()]);
  const sections = new Map();
  for (const key of order) {
    const b = sb.get(key), o = so.get(key), t = st.get(key);
    let keep;
    if (o && t) keep = true;
    else if (!b) keep = true;                                   // added on one side
    else {
      const one = o || t;                                         // removed on the other
      keep = needed.has(key) || (one && !(eq(one.heading?.archived, b.heading?.archived) && eq(one.trailing, b.trailing)));
    }
    if (!keep && !needed.has(key)) continue;
    const any = o || t || b;
    // a side that removed the heading counts as agreeing with the side that kept it
    const oo = o || t, others = t || o;
    const heading = any.heading
      ? new Heading(any.heading.name, merge3(b ? b.heading.archived : undefined, oo ? oo.heading.archived : null,
        others ? others.heading.archived : null, laterRule, conflicts, `heading ${any.heading.name}`))
      : null;
    const s = new Section(heading);
    const trailing = mergeLines(b ? b.trailing : [], oo ? oo.trailing : [], others ? others.trailing : []);
    s.trailing = trailing.lines;
    if (trailing.conflicts) conflicts.push(`lines under ${heading ? heading.name : 'the top'}`);
    sections.set(key, s);
  }
  for (const key of needed) {
    if (!sections.has(key)) sections.set(key, new Section(key ? new Heading(key.slice(1)) : null));
  }
  // the lead section, if any, always first
  const keys = [...sections.keys()].sort((x, y) => (x === '' ? -1 : y === '' ? 1 : 0));

  // to-dos in one merged order across the file, then each under its heading
  const flat = (f) => keyed(f).map(([k]) => k);
  for (const id of mergeOrder(flat(B), flat(O), flat(T))) {
    const t = kept.get(id);
    if (t) sections.get(t.heading == null ? '' : `#${t.heading}`).todos.push(t);
  }
  out.sections = keys.map((k) => sections.get(k)).filter((s) => s.heading || s.todos.length || s.trailing.length);
  return { text: serialize(out), conflicts };
}

/**
 * Two texts of one file say the same things: the same front matter, notes and
 * headings, the same to-dos under the same headings with the same fields —
 * whatever lines they are on and whatever order they come in. The store takes
 * the version that arrived whenever the merge would differ from it only in
 * order: an order is the one thing not worth a write, and two devices each
 * insisting on their own would pass the file back and forth.
 */
export function sameContent(a, b, path) {
  if (a === b) return true;
  const plain = (text) => {
    const f = parse(text, path);
    const sections = f.sections.map((s) => json({
      heading: s.heading ? [s.heading.name, s.heading.archived] : null,
      trailing: s.trailing,
      todos: s.todos.map((t) => json({ ...t, line: 0, checklist: t.checklist.map((c) => [c.text, c.done]) })).sort(),
    }));
    return { fm: f.frontmatter, notes: f.notes, sections: sections.sort() };
  };
  return eq(plain(a), plain(b));
}

/**
 * Was theirs made from ours — someone edited what this device wrote (Obsidian
 * here, or a sync that has already carried our change there and back) — or
 * beside it, by another device working from the base while this one worked?
 * Made from it if it carries every change ours made; one it lacks means it
 * was made without seeing ours (or, rarely, that ours was undone along with
 * something else — the store then reapplies it, which loses nothing).
 *
 * Made from ours, it is taken as it is, as the store always has: an edit in
 * Obsidian must win. Made beside ours, it is merged. The store asks this of
 * each of its own versions in turn (store.js, _mergeBase).
 */
export function hasSeen(base, ours, theirs, path) {
  if (ours === base || theirs === ours) return true;
  const B = parse(base, path), O = parse(ours, path), T = parse(theirs, path);
  const kb = new Map(keyed(B)), ko = new Map(keyed(O)), kt = new Map(keyed(T));
  let missing = 0;
  // A change of ours theirs lacks: theirs still holds what was there before it.
  // Theirs holding something else again is someone building on ours (or both
  // sides changing one field, which the merge would settle by rule anyway).
  const field = (b, o, t) => { if (!eq(o, b) && eq(t, b) && !eq(t, o)) missing++; };
  for (const k of new Set([...kb.keys(), ...ko.keys()])) {
    const b = kb.get(k), o = ko.get(k), t = kt.get(k);
    if (!b && o) { if (!t) missing++; continue; }                        // we added it
    if (b && !o) { if (t && sameTodo(t, b)) missing++; continue; }       // we removed it
    if (sameTodo(b, o)) continue;
    if (!t) { missing++; continue; }                                      // we changed it; theirs has none of it
    field([b.status, b.completed], [o.status, o.completed], [t.status, t.completed]);
    for (const f of ['title', 'notes', 'tags', 'when', 'evening', 'someday', 'reminder', 'deadline', 'repeat', 'created', 'trashed', 'origin', 'heading', 'mark']) {
      field(b[f], o[f], t[f]);
    }
    field(b.checklist.map((c) => [c.text, c.done]), o.checklist.map((c) => [c.text, c.done]), t.checklist.map((c) => [c.text, c.done]));
  }
  const sections = (f) => new Map(f.sections.map((x) => [sectionKey(x), json([x.heading && x.heading.archived, x.trailing])]));
  const sb = sections(B), so = sections(O), st = sections(T);
  for (const k of new Set([...sb.keys(), ...so.keys()])) {
    const b = sb.get(k), o = so.get(k), t = st.get(k);
    if (b === undefined && o !== undefined) { if (t === undefined) missing++; continue; }
    if (b !== undefined && o === undefined) { if (t === b) missing++; continue; }
    if (t !== undefined) field(b, o, t);
  }
  for (const k of new Set([...Object.keys(B.frontmatter), ...Object.keys(O.frontmatter)])) field(B.frontmatter[k], O.frontmatter[k], T.frontmatter[k]);
  field(B.notes, O.notes, T.notes);
  return missing === 0;
}

// Conflict copies sync tools leave beside a file both sides changed.
const SYNCTHING = /^(.*)\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}(\.[^./]+)$/u;      // name.sync-conflict-20260923-101500-ABCDEFG.md
const CONFLICTED = /^(.*) \([^()]*conflicted copy[^()]*\)(\.[^./]+)$/iu;             // name (Nathan's conflicted copy 2026-09-23).md

/** The file a conflict copy is a copy of, or null if it is not one. */
export function conflictOriginal(path) {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1), name = path.slice(slash + 1);
  const m = SYNCTHING.exec(name) || CONFLICTED.exec(name);
  return m ? dir + m[1] + m[2] : null;
}
