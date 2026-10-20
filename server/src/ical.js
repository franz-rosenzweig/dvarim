// Calendar events from iCalendar text, for Today and Upcoming
// (backend/dvarim/calendar.py's parse_vevents and expand, ported). Times end
// up as wall times in the server's zone, as the Python's did (tz.js); repeats
// through rrule.js. Where the Python dropped an event (a bad date, a rule it
// could not read) this drops it too; where the Python's whole fetch failed (a
// KeyError, a date minus a datetime) this throws EventCrash, and the page
// shows no events, as it did.
import { convert, localZone, validZone, utcToWall } from './tz.js';
import { rrulestr, RuleError, RuleCrash, wall, wallParts, daysIn } from './rrule.js';
// rows sorted (date, all-day first, time), stably, as Python sorted
import { sortRows } from '../../engine/src/events.js';

export { sortRows };

const DAY = 86400000;

export class EventCrash extends Error {}

/** Lines, with folded continuations joined (RFC 5545 3.1). */
export function unfold(text) {
  const lines = [];
  for (const raw of text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n')) {
    if ((raw[0] === ' ' || raw[0] === '\t') && lines.length) lines[lines.length - 1] += raw.slice(1);
    else if (raw) lines.push(raw);
  }
  return lines;
}

/** calendar.py's _unescape: the same replacements, in the same order. */
export const unescapeText = (s) => s.split('\\n').join('\n').split('\\N').join('\n').split('\\,').join(',')
  .split('\\;').join(';').split('\\\\').join('\\');

/** 'DTSTART;TZID=Asia/Jerusalem:20260922T100000' → [name, params, value], or null. */
export function parseProp(line) {
  const m = /^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/su.exec(line);
  if (!m) return null;
  const params = {};
  for (const p of m[2].split(';').filter(Boolean)) {
    const i = p.indexOf('=');
    if (i >= 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"+|"+$/gu, '');
  }
  return [m[1].toUpperCase(), params, m[3]];
}

class Bad extends Error {}
/** int() of part of a date, and date(...)'s refusals. */
const num = (s) => {
  if (!/^\s*[+-]?[0-9]+\s*$/u.test(s)) throw new Bad(`invalid literal for int(): ${s}`);
  return parseInt(s, 10);
};
function makeDate(y, m, d) {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) throw new Bad('date out of range');
  return wall(y, m, d);
}

/** A zone name as ZoneInfo would take it: case exact, but aliases welcome. */
function zoneFor(name) {
  if (!validZone(name)) return null;
  const resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  return resolved !== name && resolved.toLowerCase() === name.toLowerCase() ? null : name;
}

/** → { ms: wall ms in `tz` (midnight for a date), date: boolean } */
export function parseDt(value, params, tz) {
  if (params.VALUE === 'DATE' || /^[0-9]{8}$/u.test(value)) {
    return { ms: makeDate(num(value.slice(0, 4)), num(value.slice(4, 6)), num(value.slice(6, 8))), date: true };
  }
  const m = /^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})?(Z?)$/u.exec(value);
  if (!m) throw new Bad(`bad datetime ${value}`);
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const s = Number(m[6] || 0);
  makeDate(y, mo, d);
  if (h > 23 || mi > 59 || s > 59) throw new Bad('time out of range');
  const naive = wall(y, mo, d, h, mi, s);
  if (m[7] === 'Z') return { ms: utcToWall(naive, tz), date: false };
  if (params.TZID) return { ms: convert(naive, zoneFor(params.TZID) || tz, tz), date: false };
  return { ms: naive, date: false };
}

/** Raw VEVENTs: { uid, summary, start, end, allDay, rrule, exdates, recurrenceId, status } */
export function parseVevents(ics, tz = localZone()) {
  const events = [];
  let cur = null, depth = 0;
  for (const line of unfold(ics)) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      cur = { uid: null, summary: '', start: null, end: null, allDay: false, rrule: null, exdates: new Set(), recurrenceId: null, status: null };
      depth = 1;
      continue;
    }
    if (cur === null) continue;
    if (upper.startsWith('BEGIN:')) { depth += 1; continue; }
    if (upper.startsWith('END:')) {
      depth -= 1;
      if (depth === 0 && upper === 'END:VEVENT') {
        if (cur.start !== null && cur.status !== 'CANCELLED') events.push(cur);
        cur = null;
      }
      continue;
    }
    if (depth !== 1) continue;
    const p = parseProp(line);
    if (!p) continue;
    const [name, params, value] = p;
    try {
      if (name === 'UID') cur.uid = value;
      else if (name === 'SUMMARY') cur.summary = unescapeText(value);
      else if (name === 'STATUS') cur.status = value.toUpperCase();
      else if (name === 'DTSTART') {
        const d = parseDt(value, params, tz);
        cur.start = d; cur.allDay = d.date;
      } else if (name === 'DTEND') cur.end = parseDt(value, params, tz);
      else if (name === 'RRULE') cur.rrule = value;
      else if (name === 'EXDATE') {
        for (const v of value.split(',')) {
          const d = parseDt(v.trim(), params, tz);
          cur.exdates.add(Math.floor(d.ms / DAY));
        }
      } else if (name === 'RECURRENCE-ID') {
        cur.recurrenceId = Math.floor(parseDt(value, params, tz).ms / DAY);
      }
    } catch (e) {
      if (!(e instanceof Bad)) throw e;             // ValueError: skip the property
    }
  }
  return events;
}

const iso = (day) => new Date(day * DAY).toISOString().slice(0, 10);
const hhmm = (ms) => { const p = wallParts(ms); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

/**
 * One row per day each event (and each repeat of it) touches in [from, to].
 * @param {ReturnType<parseVevents>} events
 * @param {string} dateFrom  YYYY-MM-DD
 * @param {string} dateTo
 */
export function expand(events, dateFrom, dateTo, calendar, color, tz = localZone()) {
  const d0 = Math.floor(Date.parse(dateFrom + 'T00:00:00Z') / DAY), d1 = Math.floor(Date.parse(dateTo + 'T00:00:00Z') / DAY);
  const out = [];
  const overrides = new Set(events.filter((e) => e.recurrenceId !== null).map((e) => `${e.uid}\u0000${e.recurrenceId}`));
  for (const e of events) {
    const start = e.start;
    let end = e.end;
    const allDay = e.allDay;
    if (end === null) end = { ms: start.ms + (allDay ? DAY : 0), date: start.date };
    // date minus datetime: a TypeError there, and the whole fetch with it
    if (end.date !== start.date) throw new EventCrash('unsupported operand: date and datetime');
    const span = end.ms - start.ms;
    const occurrences = [];
    if (e.rrule && e.recurrenceId === null) {
      let rule = null;
      try {
        rule = rrulestr(e.rrule, start.ms, start.date ? null : tz);
      } catch (err) {
        if (err instanceof RuleCrash) throw new EventCrash(err.message);
        if (!(err instanceof RuleError)) throw err;
      }
      if (rule !== null) {
        const spanDays = Math.floor(span / DAY);
        const lo = d0 * DAY - Math.max(1, spanDays + 1) * DAY;
        const hi = d1 * DAY + (23 * 3600 + 59 * 60 + 59) * 1000;
        let found;
        try {
          found = rule.between(lo, hi);
        } catch (err) {
          throw new EventCrash(err.message);         // raised while iterating: not caught there either
        }
        for (const occ of found) {
          const od = Math.floor(occ / DAY);
          if (e.exdates.has(od) || overrides.has(`${e.uid}\u0000${od}`)) continue;
          occurrences.push(allDay ? od * DAY : occ);
        }
      }
    } else occurrences.push(start.ms);
    for (const occ of occurrences) {
      const occEnd = occ + span;
      const first = Math.floor(occ / DAY);
      const last = occEnd > occ ? Math.floor((occEnd - (allDay ? DAY : 1000)) / DAY) : first;
      for (let d = Math.max(first, d0); d <= Math.min(last, d1); d++) {
        const row = { date: iso(d), allDay: allDay || d !== first, time: null, end: null,
          title: e.summary || '(untitled)', calendar, color, uid: e.uid };
        if (!allDay && d === first) {
          row.time = hhmm(occ);
          row.end = Math.floor(occEnd / DAY) === first ? hhmm(occEnd) : null;
          row.allDay = false;
        }
        out.push(row);
      }
    }
  }
  return sortRows(out);
}
