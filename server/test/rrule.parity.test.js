// Repeat rules for calendar events (src/rrule.js) against dateutil's, which
// the Python server used: thousands of generated RRULEs — every frequency, the
// BY parts alone and together, ordinals, set positions, week numbers, counts,
// UNTIL as a date and as an instant, time zones with daylight saving, and
// rules dateutil refuses — each asked of both for the same window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rrulestr, RuleError, RuleCrash, wall, wallParts } from '../src/rrule.js';
import { available, askAll } from '../../engine/test/oracle.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const p2 = (n) => String(n).padStart(2, '0');
const isoWall = (ms) => { const p = wallParts(ms); return `${p.year}-${p2(p.month)}-${p2(p.day)}T${p2(p.hour)}:${p2(p.minute)}:${p2(p.second)}`; };
const parseIso = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u.exec(s); return wall(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]); };

const ZONES = [null, null, 'America/Phoenix', 'America/New_York', 'Asia/Jerusalem', 'Europe/London', 'UTC', 'Australia/Lord_Howe'];
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function genRule(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;
  const some = (xs, n) => [...new Set(Array.from({ length: 1 + Math.floor(r() * n) }, () => pick(xs)))];
  const freq = pick(['YEARLY', 'MONTHLY', 'MONTHLY', 'WEEKLY', 'WEEKLY', 'DAILY', 'DAILY', 'HOURLY', 'MINUTELY']);
  const parts = [`FREQ=${freq}`];
  if (chance(0.35)) parts.push(`INTERVAL=${pick([1, 2, 3, 4, 7])}`);
  if (chance(0.4)) parts.push(`BYDAY=${some(DAYS, 3).map((d) => (chance(0.35) ? `${pick(['', '+', '-'])}${pick([1, 2, 3, 4, 5])}${d}` : d)).join(',')}`);
  if (chance(0.25)) parts.push(`BYMONTHDAY=${some([1, 2, 13, 15, 28, 29, 30, 31, -1, -2, -7], 3).join(',')}`);
  if (chance(0.2)) parts.push(`BYMONTH=${some([1, 2, 3, 6, 9, 11, 12], 3).join(',')}`);
  if (chance(0.1)) parts.push(`BYSETPOS=${some([1, 2, -1, -2, 3], 2).join(',')}`);
  if (chance(0.07)) parts.push(`BYYEARDAY=${some([1, 60, 100, 200, 365, 366, -1, -100], 3).join(',')}`);
  if (chance(0.07)) parts.push(`BYWEEKNO=${some([1, 2, 20, 52, 53, -1], 3).join(',')}`);
  if (chance(0.15)) parts.push(`WKST=${pick(DAYS)}`);
  if (freq === 'DAILY' || freq === 'WEEKLY' || freq === 'HOURLY') {
    if (chance(0.15)) parts.push(`BYHOUR=${some([0, 8, 9, 13, 23], 2).join(',')}`);
  }
  if (freq === 'HOURLY' || freq === 'MINUTELY' || chance(0.05)) {
    if (chance(0.3)) parts.push(`BYMINUTE=${some([0, 15, 30, 45], 2).join(',')}`);
  }
  if (chance(0.25)) parts.push(`COUNT=${pick([1, 3, 5, 10, 25])}`);
  return { parts, freq };
}

function genCase(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const tz = pick(ZONES);
  const y = 2019 + Math.floor(r() * 8), mo = 1 + Math.floor(r() * 12), d = 1 + Math.floor(r() * 28);
  const allDay = tz === null && r() < 0.5;
  const [h, mi] = allDay ? [0, 0] : [Math.floor(r() * 24), pick([0, 0, 15, 30, 45])];
  const dtstart = wall(y, mo, d, h, mi, 0);
  const { parts, freq } = genRule(r);
  const k = r();
  if (k < 0.2) {
    // UNTIL: an instant (right for a zone), a date or a floating time (right for none), sometimes the wrong one
    const u = dtstart + Math.floor(r() * 400) * 86400000;
    const p = wallParts(u);
    const ds = `${p.year}${p2(p.month)}${p2(p.day)}`;
    parts.push(`UNTIL=${pick([`${ds}T${p2(p.hour)}${p2(p.minute)}00Z`, ds, `${ds}T235959`])}`);
  }
  if (r() < 0.04) parts.push(pick(['BYDAY=XX', 'BYDAY=0MO', 'FOO=1', 'BYMONTHDAY=', 'INTERVAL=0', 'BYSETPOS=0', 'COUNT=x', 'BYDAY=']));
  const rule = (r() < 0.1 ? 'RRULE:' : '') + parts.join(';') + (r() < 0.03 ? ';' : '');
  const span = freq === 'MINUTELY' ? 1 : freq === 'HOURLY' ? 5 : 20 + Math.floor(r() * 500);
  const lo = dtstart + Math.floor((r() - 0.2) * span) * 86400000;
  const hi = lo + (freq === 'MINUTELY' ? 0.2 : freq === 'HOURLY' ? 3 : 30 + Math.floor(r() * 400)) * 86400000;
  return { rule, tz, dtstart: isoWall(dtstart), lo: isoWall(lo), hi: isoWall(hi) };
}

function ours(c) {
  let rule;
  try {
    rule = rrulestr(c.rule, parseIso(c.dtstart), c.tz);
  } catch (e) {
    if (e instanceof RuleError) return { drop: true };
    if (e instanceof RuleCrash) return { crash: true };
    throw e;
  }
  try {
    return { dates: rule.between(parseIso(c.lo), parseIso(c.hi)).map(isoWall) };
  } catch (e) {
    if (e instanceof RuleError) return { crash: true };
    throw e;
  }
}

const N = Number(process.env.DVARIM_FUZZ || 4000);

test(`calendar repeat rules agree with dateutil on ${N} rules`, { skip: !available() && 'no Python here' }, async () => {
  const r = rng(Number(process.env.DVARIM_SEED || 1));
  const cases = Array.from({ length: N }, () => genCase(r));
  const answers = await askAll(cases.map((c) => ({ op: 'rrule', ...c })));
  const problems = [];
  const tally = { dates: 0, drop: 0, crash: 0, occurrences: 0 };
  cases.forEach((c, i) => {
    const py = answers[i];
    if (py.error) { problems.push(`${JSON.stringify(c)}: the oracle failed: ${py.error}`); return; }
    if (py.ok.slow) { tally.slow = (tally.slow || 0) + 1; return; }    // dateutil still walking to 9999
    const want = py.ok.dates ? { dates: py.ok.dates } : py.ok.drop ? { drop: true } : { crash: true };
    const got = ours(c);
    // INTERVAL=0 without a COUNT (RFC 5545 forbids it; no calendar writes it):
    // dateutil hangs or fails the whole fetch, this drops the one event. On purpose.
    if (/INTERVAL=0(;|$)/u.test(c.rule) && !/COUNT=/u.test(c.rule) && got.drop && (want.crash || want.drop)) {
      tally.intervalZero = (tally.intervalZero || 0) + 1;
      return;
    }
    tally[Object.keys(want)[0]] += 1;
    if (want.dates) tally.occurrences += want.dates.length;
    try { assert.deepStrictEqual(got, want); } catch {
      problems.push(`${JSON.stringify(c)}\n  ours:     ${JSON.stringify(got).slice(0, 400)}\n  dateutil: ${JSON.stringify(want).slice(0, 400)}`);
    }
  });
  if (process.env.DVARIM_TALLY) console.log('RRULE ' + JSON.stringify(tally));
  if (problems.length) assert.fail(`${problems.length} of ${N} rules differ:\n${problems.slice(0, 4).join('\n\n')}`);
});
