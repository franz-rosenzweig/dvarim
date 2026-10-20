// Calendar events as Today and Upcoming show them: a row per day an event
// touches, all-day rows first, then by time. The server makes them from CalDAV
// (server/src/ical.js); a shell with the device's own calendars (EventKit on
// the Mac, CalendarContract on Android: the bridge's `events` op,
// docs/BRIDGE.md) hands over occurrences, already expanded, and they become
// rows here, split across days the way the server splits them.

/** In date order; on one day, all-day first, then by time; otherwise as given. */
export function sortRows(rows) {
  const key = (r) => [r.date, r.allDay ? 0 : 1, r.time || ''];
  return rows.map((r, i) => [key(r), i, r]).sort((a, b) => {
    for (let k = 0; k < 3; k++) {
      if (a[0][k] < b[0][k]) return -1;
      if (a[0][k] > b[0][k]) return 1;
    }
    return a[1] - b[1];
  }).map((x) => x[2]);
}

const DAY = 86400000;
const dayNum = (iso) => Math.floor(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / DAY);
const isoOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/u, WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

/**
 * A shell's occurrences → rows, between `from` and `to` (both days included).
 *
 * @param {Array<{uid?: string, title?: string, calendar?: string, color?: string|null,
 *   allDay?: boolean, start: string, end?: string}>} occurrences
 *   start and end in the device's own wall time: "2026-09-24T09:30", or for an
 *   all-day event "2026-09-24", its end the day after its last, as iCalendar has it
 * @param {string} from
 * @param {string} to
 * @param {string[]|null} [calendars]  only these (null: every one)
 */
export function occurrenceRows(occurrences, from, to, calendars = null) {
  const d0 = dayNum(from), d1 = dayNum(to);
  const out = [];
  for (const o of occurrences || []) {
    if (!o || typeof o.start !== 'string') continue;
    const allDay = !!o.allDay || DATE.test(o.start);
    if (!allDay && !WALL.test(o.start)) continue;
    const calendar = o.calendar || '';
    if (calendars !== null && !calendars.includes(calendar)) continue;
    const end = typeof o.end === 'string' && (DATE.test(o.end) || WALL.test(o.end)) ? o.end : null;
    const first = dayNum(o.start);
    let last = first;
    let endTime = null;
    if (allDay) {
      if (end) last = Math.max(first, dayNum(end) - 1);          // the end is the day after
    } else if (end) {
      const endDay = dayNum(end), hhmm = end.length >= 16 ? end.slice(11, 16) : '00:00';
      // a second before the end: an event to midnight ends the day before
      last = Math.max(first, hhmm === '00:00' ? endDay - 1 : endDay);
      if (endDay === first) endTime = hhmm;
    }
    for (let d = Math.max(first, d0); d <= Math.min(last, d1); d++) {
      const row = { date: isoOf(d), allDay: allDay || d !== first, time: null, end: null,
        title: o.title || '(untitled)', calendar, color: o.color || null, uid: o.uid || '' };
      if (!allDay && d === first) {
        row.time = o.start.slice(11, 16);
        row.end = endTime;
        row.allDay = false;
      }
      out.push(row);
    }
  }
  return sortRows(out);
}
