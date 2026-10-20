// Front matter, kept exactly as it was written. This is
// backend/dvarim/frontmatter.py line for line — the reasons are there — and
// the two must agree: test/parity.test.js holds them to it.
//
// In short: the front matter is read into entries, one per top-level key with
// every line that belongs to it, and written back entry by entry. A key whose
// value is unchanged keeps its lines exactly; one Dvarim changed is rewritten
// in the style it was in; one it removed goes; one it added is appended in
// Obsidian's style. Only the YAML that Obsidian and Dvarim write is parsed,
// and the rest is carried as text, so there is no YAML library here.

/** The keys Dvarim reads and writes, in the order it writes a new file's. */
export const ORDER = ['id', 'type', 'status', 'when', 'evening', 'someday', 'reminder',
  'deadline', 'repeat', 'tags', 'created', 'completed'];
/** Written even when empty, because a project or area is not one without them. */
const ALWAYS = new Set(['id', 'type', 'status']);

const KEY = /^(?<key>[^\s#:][^:]*?)[ \t]*:(?:[ \t]+(?<rest>.*?))?[ \t]*$/su;
const ITEM = /^(?<indent>[ \t]*)-(?:[ \t]+(?<v>.*?))?[ \t]*$/su;

export class Entry {
  constructor(key, lines, value = null, style = 'plain', indent = '  ') {
    this.key = key;            // null: a blank line or a comment
    this.lines = lines;
    this.value = value;        // as read
    this.style = style;        // plain | block | flow | text
    this.indent = indent;      // a block list's item indent, as written
  }
}

export class FrontMatter {
  constructor(entries = [], close = '---', open = '---') {
    this.entries = entries;
    this.close = close;        // the closing fence, as written
    this.open = open;          // and the opening one (a CRLF file has "---\r")
  }
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const copy = (v) => (Array.isArray(v) ? v.slice() : v);

function isContinuation(line) {
  return line.slice(0, 1) === ' ' || line.slice(0, 1) === '\t' || line === '-' || line.startsWith('- ');
}

/**
 * The values and entries of a front matter block, or null if it is not a
 * mapping (a note that opens with a horizontal rule, say), in which case the
 * caller leaves the text alone as part of the body.
 * @param {string[]} rawLines
 * @returns {[object, Entry[]] | null}
 */
export function parse(rawLines) {
  const entries = [];
  let pending = [];            // blank lines not yet known to be inside an entry
  let current = null;
  const cont = new Map();
  for (const line of rawLines) {
    const bare = line.replace(/\r+$/, '');   // a CRLF file: match without the \r, keep it
    if (bare.trim() === '') {
      pending.push(line);
      continue;
    }
    if (isContinuation(bare)) {
      if (current === null) return null;
      current.lines.push(...pending, line);
      cont.get(current).push(...pending.map((x) => x.replace(/\r+$/, '')), bare);
      pending = [];
      continue;
    }
    for (const p of pending) entries.push(new Entry(null, [p]));
    pending = [];
    if (bare.startsWith('#')) {
      entries.push(new Entry(null, [line]));
      current = null;
      continue;
    }
    const m = KEY.exec(bare);
    if (!m) return null;
    current = new Entry(m.groups.key, [line]);
    current.value = m.groups.rest || '';
    cont.set(current, []);
    entries.push(current);
  }
  for (const p of pending) entries.push(new Entry(null, [p]));

  const values = {};
  for (const e of entries) {
    if (e.key === null) continue;
    [e.value, e.style, e.indent] = value(e.value, cont.get(e));
    // a copy, so that a list the store changes in place is not also changed in
    // the entry it is compared against — it would look untouched
    if (!has(values, e.key)) values[e.key] = copy(e.value);   // a repeated key: the first counts
  }
  return [values, entries];
}

function value(rest, cont) {
  rest = rest.trim();
  const body = cont.filter((ln) => ln.trim());
  if (rest.startsWith('[') && rest.endsWith(']') && !body.length) {
    return [splitFlow(rest.slice(1, -1)).map(scalarOf), 'flow', '  '];
  }
  if (rest === '' && !body.length) return [null, 'plain', '  '];
  if (rest === '' && body.every((ln) => ITEM.test(ln))) {
    const indent = ITEM.exec(body[0]).groups.indent;
    return [body.map((ln) => scalarOf(ITEM.exec(ln).groups.v || '')), 'block', indent];
  }
  if (!body.length) return [scalarOf(rest), 'plain', '  '];
  if (rest.slice(0, 1) === '|' || rest.slice(0, 1) === '>') {
    const lines = cont.map((ln) => ln.trim());
    return [lines.join(rest[0] === '|' ? '\n' : ' ').trim(), 'text', '  '];
  }
  return [[rest, ...body.map((ln) => ln.trim())].join(' '), 'text', '  '];
}

function splitFlow(s) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() || out.length) out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

function scalarOf(s) {
  s = s.trim();
  if (s === '') return null;
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(.)/gsu, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replaceAll("''", "'");
  s = s.replace(/[ \t]+#.*$/su, '');
  const low = s.toLowerCase();
  if (low === 'null' || low === '~') return null;
  if (low === 'true' || low === 'yes' || low === 'on') return true;
  if (low === 'false' || low === 'no' || low === 'off') return false;
  return s;
}

// ---- writing ---------------------------------------------------------------

const RESERVED = new Set(['null', '~', 'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n']);

function needsQuotes(s, flow = false) {
  if (s === '' || s !== s.trim() || RESERVED.has(s.toLowerCase())) return true;
  if ('-?:,[]{}#&*!|>\'"%@`'.includes(s[0])) return true;
  if (s.includes(': ') || s.includes(' #') || s.endsWith(':') || s.includes('\n')) return true;
  return flow && /[,[\]{}]/u.test(s);
}

function quote(s) {
  return '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n') + '"';
}

export function scalar(v, flow = false) {
  if (v === null || v === undefined) return '';
  if (v === true || v === false) return v ? 'true' : 'false';
  const s = String(v);
  return needsQuotes(s, flow) ? quote(s) : s;
}

export function render(key, v, style = 'new', indent = '  ') {
  if (v === null || v === undefined) return [`${key}:`];
  if (Array.isArray(v)) {
    if (style === 'flow') return [`${key}: [` + v.map((x) => scalar(x, true)).join(', ') + ']'];
    if (!v.length) return [`${key}: []`];
    return [`${key}:`, ...v.map((x) => `${indent}- ${scalar(x)}`.trimEnd())];
  }
  return [`${key}: ${scalar(v)}`];
}

function absent(key, v) {
  return !ALWAYS.has(key) && (v === null || v === undefined || v === false || v === ''
    || (Array.isArray(v) && v.length === 0));
}

function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  return a === b;
}

/**
 * The front matter to write. `fm` is what was read, or null for a file that
 * had none.
 * @param {object} values
 * @param {FrontMatter|null} fm
 */
export function dump(values, fm) {
  const keys = Object.keys(values);
  const extra = keys.filter((k) => !ORDER.includes(k));
  const lines = (arr) => arr.map((ln) => ln + '\n').join('');
  if (!fm) {
    if (!keys.length) return '';
    const out = [];
    for (const k of [...ORDER, ...extra]) {
      if (has(values, k) && !absent(k, values[k])) out.push(...render(k, values[k]));
    }
    return '---\n' + lines(out) + '---\n';
  }
  const out = [];
  const seen = new Set();
  for (const e of fm.entries) {
    if (e.key === null || seen.has(e.key)) {
      out.push(...e.lines);                    // blank, comment, or a repeated key
      continue;
    }
    seen.add(e.key);
    if (!has(values, e.key)) continue;         // removed
    const v = values[e.key];
    if (same(v, e.value)) out.push(...e.lines);            // untouched: exactly as written
    else if (!absent(e.key, v)) out.push(...render(e.key, v, e.style, e.indent));
  }
  for (const k of [...ORDER, ...extra]) {
    if (!seen.has(k) && has(values, k) && !absent(k, values[k])) out.push(...render(k, values[k]));
  }
  return fm.open + '\n' + lines(out) + fm.close + '\n';
}
