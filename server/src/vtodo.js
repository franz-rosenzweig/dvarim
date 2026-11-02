// To-dos as VTODO for a CalDAV collection, and what comes back
// (backend/dvarim/vtodo.py, ported). The files stay canonical: the collection
// is a projection other apps — Tasks.org, Reminders — can see and tick off.
// What VTODO can say is mapped and read back; what it cannot travels in
// X-DVARIM-* properties and is never inferred from what a client did;
// anything unrecognised is left alone.
export const PRODID = '-//Dvarim//Tasks//EN';
const STATUS = { open: 'NEEDS-ACTION', done: 'COMPLETED', canceled: 'CANCELLED' };
const STATUS_BACK = { 'NEEDS-ACTION': 'open', 'IN-PROCESS': 'open', COMPLETED: 'done', CANCELLED: 'canceled' };

const esc = (text) => text.replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n').replace(/,/gu, '\\,').replace(/;/gu, '\\;');

function unesc(text) {
  let out = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '\\' && i + 1 < chars.length) {
      const next = chars[i + 1];
      out += { n: '\n', N: '\n', ',': ',', ';': ';', '\\': '\\' }[next] ?? next;
      i += 1;
    } else out += c;
  }
  return out;
}

/** RFC 5545: lines under 75 octets, continued with a leading space, never
 *  splitting a character. */
function fold(line) {
  const raw = Buffer.from(line, 'utf8');
  if (raw.length <= 73) return line;
  const out = [];
  let start = 0, limit = 73;
  while (start < raw.length) {
    let end = Math.min(start + limit, raw.length);
    while (end < raw.length && (raw[end] & 0xc0) === 0x80) end -= 1;
    out.push(raw.subarray(start, end).toString('utf8'));
    start = end;
    limit = 72;
  }
  return out.join('\r\n ');
}

export function unfold(text) {
  const lines = [];
  for (const raw of text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n')) {
    if ((raw[0] === ' ' || raw[0] === '\t') && lines.length) lines[lines.length - 1] += raw.slice(1);
    else if (raw) lines.push(raw);
  }
  return lines;
}

const date = (value) => value.replace(/-/gu, '');
const stamp = (now = new Date()) => now.toISOString().replace(/[-:]/gu, '').replace(/\.\d+/u, '');

/** One VCALENDAR holding one VTODO; `todo` is the API's to-do. */
export function toIcs(todo, now = new Date()) {
  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'BEGIN:VTODO',
    `UID:${todo.id}@dvarim`, `DTSTAMP:${stamp(now)}`, `SUMMARY:${esc(todo.title || '')}`,
  ];
  if (todo.notes) L.push(`DESCRIPTION:${esc(todo.notes)}`);
  if (todo.when) L.push(`DTSTART;VALUE=DATE:${date(todo.when)}`);
  if (todo.deadline) L.push(`DUE;VALUE=DATE:${date(todo.deadline)}`);
  if (todo.created) L.push(`CREATED:${date(todo.created)}T000000Z`);
  if (todo.tags && todo.tags.length) L.push('CATEGORIES:' + todo.tags.map(esc).join(','));
  const status = STATUS[todo.status ?? 'open'] || 'NEEDS-ACTION';
  L.push(`STATUS:${status}`);
  if (status === 'COMPLETED') {
    L.push('PERCENT-COMPLETE:100');
    if (todo.completed) L.push(`COMPLETED:${date(todo.completed)}T000000Z`);
  }
  // a checklist is the nearest thing VTODO has to nothing: counted, not lost silently
  if (todo.checklist && todo.checklist.length) {
    L.push(`X-DVARIM-CHECKLIST:${todo.checklist.filter((c) => c.done).length}/${todo.checklist.length}`);
  }
  if (todo.evening) L.push('X-DVARIM-EVENING:TRUE');
  if (todo.someday) L.push('X-DVARIM-SOMEDAY:TRUE');
  if (todo.reminder) L.push(`X-DVARIM-REMINDER:${todo.reminder}`);
  if (todo.projectId) {
    L.push(`X-DVARIM-PROJECT:${todo.projectId}`);
    if (todo.projectName) L.push(`X-DVARIM-PROJECT-NAME:${esc(todo.projectName)}`);
  }
  if (todo.headingName) L.push(`X-DVARIM-HEADING:${esc(todo.headingName)}`);
  if (todo.repeat) L.push(`X-DVARIM-REPEAT:${esc(todo.repeat)}`);
  L.push('END:VTODO', 'END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

const isoDate = (value) => {
  const m = /^([0-9]{4})([0-9]{2})([0-9]{2})/u.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
/** Python's str.strip(): whitespace at both ends. */
const strip = (s) => s.replace(/^\s+|\s+$/gu, '');

// What Tasks.org (through DAVx⁵) writes as the text of every reminder it adds.
// Read as the to-do's notes it went into the Markdown and came back as the
// to-do's own DESCRIPTION; it is never the notes, wherever it turns up.
export const TASKS_ORG_FILLER = 'Default Tasks.org description';

/** The first VTODO's fields, as the API names them; null if there is none. */
export function fromIcs(text) {
  let inside = false, nested = 0;
  const out = { tags: [], checklist_summary: null };
  for (const line of unfold(text)) {
    const upper = line.toUpperCase();
    if (!inside) {
      if (upper.startsWith('BEGIN:VTODO')) inside = true;
      continue;
    }
    // a VALARM inside the VTODO has a DESCRIPTION (and may have a SUMMARY) of
    // its own: the reminder's, not the to-do's
    if (upper.startsWith('BEGIN:')) { nested += 1; continue; }
    if (upper.startsWith('END:')) {
      if (!nested) break;                                  // END:VTODO
      nested -= 1;
      continue;
    }
    if (nested) continue;
    const m = /^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/su.exec(line);
    if (!m) continue;
    const name = m[1].toUpperCase(), value = m[3];
    if (name === 'UID') { out.uid = value; out.id = value.split('@')[0]; }
    else if (name === 'SUMMARY') out.title = strip(unesc(value));
    else if (name === 'DESCRIPTION') out.notes = unesc(value);
    else if (name === 'DTSTART') out.when = isoDate(value);
    else if (name === 'DUE') out.deadline = isoDate(value);
    else if (name === 'STATUS') out.status = STATUS_BACK[strip(value).toUpperCase()] || 'open';
    else if (name === 'COMPLETED') out.completed = isoDate(value);
    else if (name === 'PERCENT-COMPLETE') out.percent = /^[0-9]+$/u.test(value) ? parseInt(value, 10) : null;
    else if (name === 'CATEGORIES') out.tags = value.split(',').filter((t) => strip(t)).map((t) => strip(unesc(t)));
    else if (name === 'X-DVARIM-EVENING') out.evening = strip(value).toUpperCase() === 'TRUE';
    else if (name === 'X-DVARIM-SOMEDAY') out.someday = strip(value).toUpperCase() === 'TRUE';
    else if (name === 'X-DVARIM-REMINDER') out.reminder = strip(value);
    else if (name === 'X-DVARIM-PROJECT') out.projectId = strip(value);
    else if (name === 'X-DVARIM-HEADING') out.headingName = strip(unesc(value));
    else if (name === 'X-DVARIM-REPEAT') out.repeat = strip(unesc(value));
  }
  if ('notes' in out) {
    const notes = out.notes.split('\n').filter((l) => strip(l) !== TASKS_ORG_FILLER).join('\n');
    if (strip(notes)) out.notes = notes;
    else if (strip(out.notes)) delete out.notes;          // only the filler: no opinion about the notes
  }
  if (!('uid' in out)) return null;
  // a client that ticks the box may set PERCENT-COMPLETE without STATUS
  if (out.percent === 100 && out.status === 'open') out.status = 'done';
  return out;
}

// What a CalDAV client may change. Everything else is ours: a client that
// cannot express a field must never be read as having cleared it.
export const CLIENT_OWNED = ['title', 'notes', 'status', 'completed', 'when', 'deadline', 'tags'];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sorted = (tags) => [...(tags || [])].sort();

/** Of what fromIcs read, the fields a client may change. */
export const said = (fields) => Object.fromEntries(CLIENT_OWNED.filter((f) => f in fields).map((f) => [f, fields[f]]));

/** A to-do as a client reads it once we have sent it: what its next write is
 *  compared with, to see what it changed. */
export const shown = (todo) => said(fromIcs(toIcs(todo)));

/** Does the copy there say what our to-do does, as far as a client can tell? */
export function agrees(theirs, todo) {
  const a = said(theirs), b = shown(todo);
  return CLIENT_OWNED.every((f) => (f === 'tags' ? same(sorted(a.tags), sorted(b.tags)) : same(a[f], b[f])));
}

/** Written by Apple's Reminders, which keeps one date, the due date: its
 *  DTSTART is only ever a copy of DUE, and a to-do with a start date and no
 *  due date comes back from it with neither. */
export const startless = (text) => /^PRODID:-\/\/Apple Inc\.\/\//imu.test(text);

/**
 * The patch to apply to our to-do, given what the CalDAV side now says.
 *
 * `base` is that copy as we last wrote it, as a client reads it (shown): only
 * what the client changed from it is taken. On 1 November 2026 Reminders saved
 * its whole list again unedited, and read against our to-dos instead, every
 * copy undid what had been done here since it went: a to-do ticked a minute
 * before was open again, and to-dos with a start date and no due date lost it.
 * Without a base, ours stands in for it, as the Python's rule was.
 * `startless`: the copy is Reminders' (above).
 */
export function mergeFromClient(ours, theirs, base = ours, { startless: noStart = false } = {}) {
  const patch = {};
  for (const field of CLIENT_OWNED) {
    // a start date from Reminders is a copy of the due date: believed only of a
    // to-do whose start was its due date when it went
    if (field === 'when' && noStart && !(base.when && base.when === base.deadline)) continue;
    let next;
    if (field in theirs) next = theirs[field];
    else if (field === 'when' || field === 'deadline') next = null;    // dropping a date is how CalDAV clears it
    else continue;                                                     // the client dropped it: no opinion
    if (field === 'tags') {
      if (!same(sorted(next), sorted(base.tags)) && !same(sorted(next), sorted(ours.tags))) patch.tags = next;
      continue;
    }
    if (!same(next, base[field]) && !same(next, ours[field])) patch[field] = next;
  }
  // completing there should not silently also move the date around
  if (patch.status === 'done' && !('completed' in patch)) patch.completed = theirs.completed ?? null;
  return patch;
}

/** What goes to the collection: open work, and by default not the parked kind. */
export function publishable(todo, includeSomeday = false) {
  if (todo.status !== 'open') return false;
  if (todo.someday && !includeSomeday) return false;
  return true;
}
