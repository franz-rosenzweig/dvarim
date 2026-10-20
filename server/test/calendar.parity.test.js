// Calendar events (src/ical.js) against the Python server's calendar.py:
// generated iCalendar — all-day and timed, multi-day, in named zones with
// daylight saving and in UTC and floating, repeating with exceptions and moved
// occurrences, cancelled, folded, escaped, and some plain broken — expanded
// into the rows Today and Upcoming show, by both, for random windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVevents, expand, EventCrash } from '../src/ical.js';
import { available, askAll } from '../../engine/test/oracle.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const p2 = (n) => String(n).padStart(2, '0');
const ZONES = ['America/Phoenix', 'America/New_York', 'Asia/Jerusalem', 'Europe/London', 'Europe/Berlin', 'Australia/Sydney', 'UTC'];
const RULES = ['FREQ=DAILY', 'FREQ=DAILY;INTERVAL=2;COUNT=10', 'FREQ=WEEKLY', 'FREQ=WEEKLY;BYDAY=MO,WE,FR', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH',
  'FREQ=MONTHLY', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;BYDAY=2TU', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'FREQ=YEARLY',
  'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'FREQ=WEEKLY;COUNT=5', 'FREQ=DAILY;UNTIL=20261001', 'FREQ=DAILY;UNTIL=20261001T120000Z',
  'FREQ=WEEKLY;BYDAY=XX', 'FREQ=MONTHLY;BYMONTHDAY=31', 'FREQ=WEEKLY;WKST=SU;BYDAY=SA,SU;INTERVAL=3', 'NOTARULE'];

// the clocks going back (a time that happens twice) and forward (one that
// never does), in the zones above: where a wrong choice shows
const TRANSITIONS = ['20261101T013000', '20260308T023000', '20261025T013000', '20260329T013000', '20261025T023000',
  '20260329T023000', '20260405T023000', '20261004T023000', '20261025T011500', '20260327T023000', '20261101T015959'];

function dt(r, allDay) {
  if (!allDay && r() < 0.25) return TRANSITIONS[Math.floor(r() * TRANSITIONS.length)];
  const y = 2026, mo = [3, 4, 8, 9, 10, 11, 12][Math.floor(r() * 7)], d = 1 + Math.floor(r() * 28);
  if (allDay) return `${y}${p2(mo)}${p2(d)}`;
  const h = Math.floor(r() * 24), mi = [0, 15, 30, 45][Math.floor(r() * 4)];
  return `${y}${p2(mo)}${p2(d)}T${p2(h)}${p2(mi)}00`;
}

function genEvent(r, n) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;
  const allDay = chance(0.3);
  const L = ['BEGIN:VEVENT', `UID:ev-${n}${chance(0.1) ? '' : '@example.com'}`];
  L.push(`SUMMARY:${pick(['Dentist', 'Stand-up', 'שיעור', 'Lunch\\, with Dana', 'Call\\nback', '', 'Trip 🎒 to the coast — a long title that will fold across the seventy-five octet line'])}`);
  const start = dt(r, allDay);
  const zone = chance(0.5) ? pick([...ZONES, 'Not/AZone', 'america/new_york']) : null;
  if (allDay) L.push(`DTSTART;VALUE=DATE:${start}`);
  else if (zone) L.push(`DTSTART;TZID=${zone}:${start}`);
  else L.push(`DTSTART:${start}${chance(0.5) ? 'Z' : ''}`);
  if (chance(0.7)) {
    const k = r();
    if (allDay) L.push(`DTEND;VALUE=DATE:${dt(r, true)}`);
    else if (k < 0.05) L.push(`DTEND;VALUE=DATE:${dt(r, true)}`);                     // mismatched: the fetch fails in Python
    else L.push(`DTEND${zone ? `;TZID=${zone}` : ''}:${start.slice(0, 9)}${p2(Math.min(23, Number(start.slice(9, 11)) + Math.floor(r() * 3)))}${start.slice(11)}${!zone && chance(0.5) ? 'Z' : ''}`);
  } else if (chance(0.3)) L.push('DURATION:PT1H');
  if (chance(0.4)) L.push(`RRULE:${pick(RULES)}`);
  if (chance(0.15)) L.push(`EXDATE${zone && !allDay ? `;TZID=${zone}` : ''}${allDay ? ';VALUE=DATE' : ''}:${dt(r, allDay)},${dt(r, allDay)}`);
  if (chance(0.05)) L.push('STATUS:CANCELLED');
  if (chance(0.05)) L.push('DTSTART:2026-09-30');                                    // broken: skipped
  if (chance(0.1)) L.push('BEGIN:VALARM', 'TRIGGER:-PT15M', 'DTSTART:20260101T000000', 'END:VALARM');
  L.push('END:VEVENT');
  // a moved occurrence of a repeating one
  if (chance(0.1)) L.push('BEGIN:VEVENT', `UID:ev-${n}@example.com`, `RECURRENCE-ID${allDay ? ';VALUE=DATE' : ''}:${dt(r, allDay)}`, 'SUMMARY:Moved', `DTSTART:${dt(r, allDay)}`, 'END:VEVENT');
  return L;
}

function fold(line) {
  const out = [];
  let rest = line;
  while ([...rest].length > 60) {
    const chars = [...rest];
    out.push(chars.slice(0, 60).join(''));
    rest = chars.slice(60).join('');
  }
  out.push(rest);
  return out.join('\r\n ');
}

function genIcs(r) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fuzz//EN'];
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) lines.push(...genEvent(r, i));
  lines.push('END:VCALENDAR');
  return lines.map((l) => (r() < 0.3 ? fold(l) : l)).join(r() < 0.8 ? '\r\n' : '\n');
}

const N = Number(process.env.DVARIM_FUZZ || 1500);

test(`calendar events agree with the Python on ${N} generated calendars`, { skip: !available() && 'no Python here' }, async () => {
  const r = rng(Number(process.env.DVARIM_SEED || 1));
  const cases = Array.from({ length: N }, () => {
    const from = `2026-${p2([3, 4, 8, 9, 10, 10, 11, 12][Math.floor(r() * 8)])}-${p2(1 + Math.floor(r() * 28))}`;
    const days = Math.floor(r() * 60);
    const to = new Date(Date.parse(from) + days * 86400000).toISOString().slice(0, 10);
    return { ics: genIcs(r), tz: ZONES[Math.floor(r() * ZONES.length)], from, to, calendar: 'Home', color: '#5A9CF2' };
  });
  const answers = await askAll(cases.map((c) => ({ op: 'ics', ...c })));
  const problems = [];
  const tally = { rows: 0, crash: 0, slow: 0, sets: 0 };
  cases.forEach((c, i) => {
    const py = answers[i];
    if (py.error) { problems.push(`oracle failed: ${py.error}`); return; }
    if (py.ok.slow) { tally.slow += 1; return; }
    let got;
    try {
      got = { rows: expand(parseVevents(c.ics, c.tz), c.from, c.to, c.calendar, c.color, c.tz) };
    } catch (e) {
      if (!(e instanceof EventCrash)) throw e;
      got = { crash: true };
    }
    const want = py.ok.rows ? { rows: py.ok.rows } : { crash: true };
    if (want.rows) { tally.sets += 1; tally.rows += want.rows.length; } else tally.crash += 1;
    try { assert.deepStrictEqual(got, want); } catch {
      problems.push(`tz ${c.tz} ${c.from}..${c.to}\n${c.ics}\n  ours:   ${JSON.stringify(got).slice(0, 700)}\n  python: ${JSON.stringify(want).slice(0, 700)}`);
    }
  });
  if (process.env.DVARIM_TALLY) console.log('CAL ' + JSON.stringify(tally));
  if (problems.length) assert.fail(`${problems.length} of ${N} calendars differ:\n${problems.slice(0, 3).join('\n\n')}`);
});
