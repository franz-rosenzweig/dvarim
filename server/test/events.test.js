// A device's own calendar events (engine/src/events.js, from a shell's
// `events` op) become the same rows as the server's CalDAV ones (ical.js):
// the same events, generated both ways, must give Today and Upcoming the same
// rows, split across days alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceRows } from '../../engine/src/events.js';
import { parseVevents, expand } from '../src/ical.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let q = a; q = Math.imul(q ^ (q >>> 15), q | 1); q ^= q + Math.imul(q ^ (q >>> 7), q | 61); return ((q ^ (q >>> 14)) >>> 0) / 4294967296; };
}
const p2 = (n) => String(n).padStart(2, '0');
const DAY = 86400000;
const wall = (ms) => new Date(ms).toISOString().slice(0, 16);
const ics = (ms, date) => (date ? new Date(ms).toISOString().slice(0, 10).replace(/-/gu, '')
  : new Date(ms).toISOString().slice(0, 16).replace(/[-:]/gu, '') + '00');

const N = Number(process.env.DVARIM_FUZZ || 3000);

test(`a device's events make the rows the server's make (${N} generated)`, () => {
  const r = rng(Number(process.env.DVARIM_SEED || 1));
  const problems = [];
  for (let i = 0; i < N && problems.length < 3; i++) {
    const n = 1 + Math.floor(r() * 3);
    const occs = [], lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
    for (let k = 0; k < n; k++) {
      const allDay = r() < 0.3;
      const day = Date.UTC(2026, 8, 20) + Math.floor(r() * 10) * DAY;
      let start, end;
      if (allDay) { start = day; end = day + (1 + Math.floor(r() * 3)) * DAY; }
      else {
        start = day + Math.floor(r() * 96) * 15 * 60000;
        const len = [0, 30, 60, 90, 24 * 60, 15 * 60, (24 * 60) - (start - day) / 60000, 48 * 60][Math.floor(r() * 8)];
        end = start + len * 60000;
      }
      const title = `Event ${i}.${k}`;
      occs.push({ uid: `u${i}-${k}`, title, calendar: 'Home', color: '#5A9CF2', allDay,
        start: allDay ? wall(start).slice(0, 10) : wall(start), end: allDay ? wall(end).slice(0, 10) : wall(end) });
      lines.push('BEGIN:VEVENT', `UID:u${i}-${k}`, `SUMMARY:${title}`,
        allDay ? `DTSTART;VALUE=DATE:${ics(start, true)}` : `DTSTART:${ics(start)}`,
        allDay ? `DTEND;VALUE=DATE:${ics(end, true)}` : `DTEND:${ics(end)}`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    const from = `2026-09-${p2(20 + Math.floor(r() * 6))}`;
    const to = new Date(Date.parse(from) + Math.floor(r() * 8) * DAY).toISOString().slice(0, 10);
    // floating times (no zone): wall time, read the same in any zone
    const server = expand(parseVevents(lines.join('\r\n'), 'UTC'), from, to, 'Home', '#5A9CF2', 'UTC');
    const device = occurrenceRows(occs, from, to);
    try { assert.deepStrictEqual(device, server); } catch {
      problems.push(`${from}..${to} ${JSON.stringify(occs)}\n  device: ${JSON.stringify(device)}\n  server: ${JSON.stringify(server)}`);
    }
  }
  if (problems.length) assert.fail(`${problems.length} differ:\n${problems.join('\n\n')}`);
});

test('only the calendars chosen, and nothing malformed', () => {
  const occs = [
    { title: 'Kept', calendar: 'Work', start: '2026-09-24T09:00', end: '2026-09-24T10:00' },
    { title: 'Not chosen', calendar: 'Home', start: '2026-09-24T09:00', end: '2026-09-24T10:00' },
    { title: 'No start', calendar: 'Work' },
    { title: 'Bad start', calendar: 'Work', start: 'tomorrow' },
    null,
  ];
  assert.deepEqual(occurrenceRows(occs, '2026-09-24', '2026-09-24', ['Work']).map((x) => x.title), ['Kept']);
  assert.deepEqual(occurrenceRows(occs, '2026-09-24', '2026-09-24').map((x) => x.title), ['Kept', 'Not chosen']);
});
