// Parse and serialize the Dvarim Markdown format (docs/FORMAT.md).
//
// backend/dvarim/mdformat.py, line for line, and held to it byte for byte by
// test/parity.test.js. Round-trip guarantee: parse(serialize(f)) is f for any
// TaskFile, and serialize(parse(text)) is text for text already in canonical
// form.
//
// Every line pattern carries the `s` and `u` flags. `u` because the markers
// are emoji outside the Basic Multilingual Plane; `s` because Python's `.`
// matches a carriage return and JavaScript's does not, and without it a line
// from a CRLF file would stop being a to-do here while staying one there.
import * as frontmatter from './frontmatter.js';
import { ChecklistItem, Heading, Section, TaskFile, Todo } from './model.js';

// ---- markers ---------------------------------------------------------------
export const M_WHEN = '⏳', M_DEADLINE = '📅', M_REPEAT = '🔁', M_ID = '🆔';
export const M_CREATED = '➕', M_DONE = '✅', M_CANCELED = '❌', M_REMINDER = '⏰';
export const M_EVENING = '🌙', M_SOMEDAY = '💤', M_TRASHED = '🗑️', M_ORIGIN = '↩';

const VS = '️?';                // optional emoji variation selector
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const ALL = [M_WHEN, M_DEADLINE, M_REPEAT, M_ID, M_CREATED, M_DONE, M_CANCELED,
  M_REMINDER, M_EVENING, M_SOMEDAY, '🗑', M_ORIGIN];
const MARKER_ALT = ALL.map((m) => esc(m) + VS).join('|');
// a free-text value runs until the next marker, a tag, or the end of line
const STOP = `(?=\\s+(?:${MARKER_ALT}|#[^\\s#])|\\s*$)`;
const DATE = '\\d{4}-\\d{2}-\\d{2}';

export const RE_TASK = /^(?<indent>[ \t]*)[-*+] \[(?<st>[ xX-])\] ?(?<rest>.*)$/su;
// A to-do's own line takes more boxes than a checklist item: Obsidian Tasks'
// `[/]` (in progress), and on a line that carries a 🆔 — so is plainly a to-do
// — whatever status character another tool gave it. Either is an open to-do
// whose box is written back as it was (Todo.mark). A box like that without a
// 🆔 stays text, as it always was: `- [1] a footnote` is not a to-do.
const RE_BOX = /^(?<indent>[ \t]*)[-*+] \[(?<st>[^\]\r\n])\] ?(?<rest>.*)$/su;
const RE_HAS_ID = /🆔️?\s*[A-Za-z0-9_-]/u;

/** The match of a to-do line (indented or not), or null. */
export function taskMatch(line) {
  const m = RE_BOX.exec(line);
  if (!m) return null;
  return ' xX-/'.includes(m.groups.st) || RE_HAS_ID.test(m.groups.rest) ? m : null;
}
export const RE_HEADING = new RegExp(`^## (?<name>.*?)(?:\\s+✅${VS}\\s*(${DATE}))?\\s*$`, 'su');
// Obsidian's tag rule: letters, digits, underscore, hyphen and nested slashes, and
// never all digits — so "#256" in prose stays prose. Anything the rule rejects is
// left in the title untouched rather than silently swallowed.
const RE_TAG = /(?:(?<=\s)|^)#(?<tag>[A-Za-z0-9_/-]+)/gsu;

const isTag = (name) => !!name && !/^[0-9/_-]+$/su.test(name);

const FIELD_RES = {
  repeat: new RegExp(esc(M_REPEAT) + VS + '\\s*(?<v>.+?)' + STOP, 'su'),
  origin: new RegExp(esc(M_ORIGIN) + VS + '\\s*(?<v>.+?)' + STOP, 'su'),
  id: new RegExp(esc(M_ID) + VS + '\\s*(?<v>[A-Za-z0-9_\\-]+)', 'su'),
  when: new RegExp(esc(M_WHEN) + VS + `\\s*(?<v>${DATE})`, 'su'),
  deadline: new RegExp(esc(M_DEADLINE) + VS + `\\s*(?<v>${DATE})`, 'su'),
  created: new RegExp(esc(M_CREATED) + VS + `\\s*(?<v>${DATE})`, 'su'),
  done: new RegExp(esc(M_DONE) + VS + `\\s*(?<v>${DATE})`, 'su'),
  canceled: new RegExp(esc(M_CANCELED) + VS + `\\s*(?<v>${DATE})`, 'su'),
  trashed: new RegExp('🗑' + VS + `\\s*(?<v>${DATE})`, 'su'),
  reminder: new RegExp(esc(M_REMINDER) + VS + '\\s*(?<v>\\d{1,2}:\\d{2})', 'su'),
  evening: new RegExp(esc(M_EVENING) + VS, 'su'),
  someday: new RegExp(esc(M_SOMEDAY) + VS, 'su'),
};
const FIELD_ORDER = ['repeat', 'origin', 'id', 'when', 'deadline', 'created', 'done',
  'canceled', 'trashed', 'reminder', 'evening', 'someday'];

/** Python's str.strip("\n"): only newlines, at either end. */
const stripNewlines = (s) => s.replace(/^\n+/u, '').replace(/\n+$/u, '');

function take(rest, key) {
  const m = FIELD_RES[key].exec(rest);
  if (!m) return [rest, null];
  const v = m.groups && m.groups.v !== undefined ? m.groups.v.trim() : true;
  return [rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length), v];
}

export function parseTaskLine(rest, statusChar) {
  const fields = {};
  for (const key of FIELD_ORDER) {
    let v;
    [rest, v] = take(rest, key);
    if (v !== null) fields[key] = v;
  }
  const tags = [...rest.matchAll(RE_TAG)].map((m) => m.groups.tag).filter(isTag);
  rest = rest.replace(RE_TAG, (m0, tag) => (isTag(tag) ? '' : m0));
  const title = rest.replace(/\s+/gu, ' ').trim();
  let status = statusChar === 'x' || statusChar === 'X' ? 'done' : (statusChar === '-' ? 'canceled' : 'open');
  const completed = fields.done || fields.canceled || null;
  if (status === 'open' && completed) status = fields.canceled ? 'canceled' : 'done';
  if (status === 'done' && fields.canceled && !fields.done) status = 'canceled';
  return new Todo({
    id: fields.id ?? null, title, status, tags,
    mark: status === 'open' && statusChar !== ' ' ? statusChar : null,
    when: fields.when ?? null, evening: !!fields.evening,
    someday: !!fields.someday, reminder: normTime(fields.reminder),
    deadline: fields.deadline ?? null, repeat: fields.repeat ?? null,
    created: fields.created ?? null, completed,
    trashed: fields.trashed ?? null, origin: fields.origin ?? null,
  });
}

// ---- notes that look like structure ------------------------------------------
// Inside notes, a line that would be read as a checklist item, a to-do or a
// project heading is written with a backslash in front, and read back without
// it (FORMAT.md, "Markdown in notes"; the reasons are in mdformat.py).

/** Would this line, under a to-do, be read as a checklist item? */
function todoStructural(line) {
  const m = RE_TASK.exec(line);
  return !!(m && !m.groups.indent);
}

/** Would this line, in a file's notes, end them as a heading or a to-do? An
 *  empty checkbox is not a to-do, so it needs no escaping, and gets none. */
function fileStructural(line) {
  if (RE_HEADING.test(line)) return true;
  const m = taskMatch(line);
  if (m && !m.groups.indent) {
    const t = parseTaskLine(m.groups.rest, m.groups.st);
    return !!(t.title || t.id);
  }
  return false;
}

const leadingBackslashes = (s) => s.replace(/^\\+/u, '');

export function escapeNoteLine(line, structural) {
  return structural(leadingBackslashes(line)) ? '\\' + line : line;
}

export function unescapeNoteLine(line, structural) {
  return line.startsWith('\\') && structural(leadingBackslashes(line)) ? line.slice(1) : line;
}

function normTime(t) {
  if (!t) return null;
  const [h, m] = t.split(':');
  return `${String(parseInt(h, 10)).padStart(2, '0')}:${m}`;
}

function dedent(line) {
  if (line.startsWith('\t')) return line.slice(1);
  let n = 0;
  while (n < 4 && n < line.length && line[n] === ' ') n++;
  return line.slice(n);
}

const isIndented = (line) => line.startsWith('\t') || line.startsWith('  ');

// ---- front matter --------------------------------------------------------------

/** [values, body, what was read] — the last null when there is no front
 *  matter, or what looks like it is not a mapping and so stays in the body. */
function splitFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return [{}, text, null];
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      const parsed = frontmatter.parse(lines.slice(1, i));
      if (parsed === null) return [{}, text, null];
      const [values, entries] = parsed;
      return [values, lines.slice(i + 1).join('\n'), new frontmatter.FrontMatter(entries, lines[i], lines[0])];
    }
  }
  return [{}, text, null];
}

// ---- parse ---------------------------------------------------------------------

/** @returns {TaskFile} */
export function parse(text, path = '') {
  const [fm, body, fmRaw] = splitFrontmatter(text);
  const fmLines = fmRaw === null ? 0 : (text.slice(0, text.length - body.length).match(/\n/gu) || []).length;
  const lines = body.split('\n');
  const f = new TaskFile(path, fm);
  f.fmRaw = fmRaw;
  const notes = [];
  let section = new Section(null);
  f.sections.push(section);
  let seenContent = false;   // a heading or to-do has been seen
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const lineno = fmLines + i + 1;
    const mh = RE_HEADING.exec(line);
    const mt = taskMatch(line);
    if (mh) {
      section = new Section(new Heading(mh.groups.name.trim(), mh[2] ?? null, lineno));
      f.sections.push(section);
      seenContent = true;
      i += 1;
      continue;
    }
    if (mt && !mt.groups.indent) {
      const todo = parseTaskLine(mt.groups.rest, mt.groups.st);
      if (!todo.title && !todo.id) {
        // A checkbox with no text is not a to-do: it is the empty bullet an
        // Obsidian template or a half-typed line leaves behind. Preserve the
        // line verbatim and never index it.
        if (seenContent || section.heading) section.trailing.push(line);
        else notes.push(line);
        i += 1;
        continue;
      }
      todo.line = lineno;
      todo.heading = section.heading ? section.heading.name : null;
      // gather the indented block
      const noteLines = [];
      let j = i + 1;
      while (j < n) {
        const nxt = lines[j];
        if (nxt.trim() === '') {
          // blank: continue only if a later indented line follows
          let k = j;
          while (k < n && lines[k].trim() === '') k++;
          if (k < n && isIndented(lines[k])) {
            for (let b = j; b < k; b++) noteLines.push('');
            j = k;
            continue;
          }
          break;
        }
        if (!isIndented(nxt)) break;
        const d = dedent(nxt);
        const mc = RE_TASK.exec(d);
        if (mc && !mc.groups.indent) {
          todo.checklist.push(new ChecklistItem(mc.groups.rest.trim(), mc.groups.st !== ' '));
        } else {
          noteLines.push(unescapeNoteLine(d, todoStructural));
        }
        j += 1;
      }
      todo.notes = stripNewlines(noteLines.join('\n'));
      section.todos.push(todo);
      seenContent = true;
      i = j;
      continue;
    }
    // anything else
    if (!seenContent && section.heading === null) notes.push(unescapeNoteLine(line, fileStructural));
    else section.trailing.push(line);
    i += 1;
  }
  f.notes = stripNewlines(notes.join('\n'));
  // drop an empty lead section when the file starts with a heading
  if (f.sections.length > 1 && f.sections[0].heading === null && !f.sections[0].todos.length
      && !f.sections[0].trailing.length) {
    f.sections.shift();
  }
  for (const s of f.sections) {
    // trailing blank lines are formatting, not content
    while (s.trailing.length && s.trailing[s.trailing.length - 1].trim() === '') s.trailing.pop();
    while (s.trailing.length && s.trailing[0].trim() === '') s.trailing.shift();
  }
  return f;
}

// ---- serialize -----------------------------------------------------------------

export function formatTaskLine(t) {
  const box = t.status === 'open' ? (t.mark || ' ') : { done: 'x', canceled: '-' }[t.status];
  const parts = [t.title.trim(), ...t.tags.map((tag) => `#${tag}`)];
  if (t.evening) parts.push(M_EVENING);
  if (t.someday) parts.push(M_SOMEDAY);
  if (t.reminder) parts.push(`${M_REMINDER} ${t.reminder}`);
  if (t.id) parts.push(`${M_ID} ${t.id}`);
  if (t.repeat) parts.push(`${M_REPEAT} ${t.repeat}`);
  if (t.created) parts.push(`${M_CREATED} ${t.created}`);
  if (t.when) parts.push(`${M_WHEN} ${t.when}`);
  if (t.deadline) parts.push(`${M_DEADLINE} ${t.deadline}`);
  if (t.status === 'done' && t.completed) parts.push(`${M_DONE} ${t.completed}`);
  if (t.status === 'canceled' && t.completed) parts.push(`${M_CANCELED} ${t.completed}`);
  if (t.trashed) parts.push(`${M_TRASHED} ${t.trashed}`);
  if (t.origin) parts.push(`${M_ORIGIN} ${t.origin}`);
  return `- [${box}] ` + parts.filter((p) => p).join(' ');
}

export function formatTodo(t) {
  const out = [formatTaskLine(t)];
  if (t.notes) {
    for (const ln of t.notes.split('\n')) out.push(ln.trim() ? '    ' + escapeNoteLine(ln, todoStructural) : '');
  }
  for (const c of t.checklist) out.push(`    - [${c.done ? 'x' : ' '}] ${c.text}`);
  return out;
}

export function formatHeading(h) {
  return `## ${h.name}` + (h.archived ? ` ${M_DONE} ${h.archived}` : '');
}

/** @param {TaskFile} f */
export function serialize(f) {
  const out = [];
  const fm = frontmatter.dump(f.frontmatter, f.fmRaw);
  if (f.notes) {
    out.push(...f.notes.split('\n').map((ln) => escapeNoteLine(ln, fileStructural)), '');
  }
  for (const s of f.sections) {
    if (s.heading !== null) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(formatHeading(s.heading));
    }
    for (const t of s.todos) out.push(...formatTodo(t));
    if (s.trailing.length) out.push(...s.trailing);
  }
  let body = out.join('\n').replace(/\n+$/u, '') + '\n';
  if (!out.length) body = '';
  return fm + body;
}
