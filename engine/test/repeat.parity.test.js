// The engine's repeat rules against the backend's — which is to say against
// dateutil's rrule, which the backend hands every schedule to. Thousands of
// rules built from the whole vocabulary, on awkward anchors (month ends, leap
// days, year ends, every weekday), each asked for its sentence and its next
// six dates; and "advance", which a completed to-do goes through, with every
// combination of When and Deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Day } from '../src/day.js';
import { parseRule, nextOccurrence, describe, advance } from '../src/repeat.js';
import { available, askAll } from './oracle.js';

const ANCHORS = ['2026-09-23', '2026-01-31', '2026-02-28', '2028-02-29', '2026-12-31', '2026-03-30',
  '2026-04-30', '2026-08-31', '2026-05-29', '2027-01-01', '2026-09-21', '2026-09-27', '2026-10-05'];
const WD = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'mon', 'fri', 'sun', 'thurs'];
const ORDS = ['1st', '2nd', '3rd', '4th', '5th', 'first', 'second', 'third', 'fourth', 'fifth', 'last'];
const MON = ['January', 'February', 'March', 'April', 'June', 'September', 'December', 'feb', 'dec'];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function rules(count, seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const n = () => 1 + Math.floor(r() * 6);
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = r();
    let s;
    if (k < 0.12) s = pick(['every day', `every ${n()} days`]);
    else if (k < 0.3) {
      s = pick(['every week', `every ${n()} weeks`]);
      if (r() < 0.7) s += ' on ' + Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(WD)).join(pick([', ', ' and ']));
    } else if (k < 0.38) s = pick(['every weekday', 'every ' + pick(WD), `every ${pick(WD)} and ${pick(WD)}`]);
    else if (k < 0.72) {
      s = pick(['every month', `every ${n()} months`]);
      const on = [];
      const m = r();
      if (m < 0.35) on.push(`the ${1 + Math.floor(r() * 31)}${pick(['st', 'nd', 'rd', 'th', ''])}`);
      else if (m < 0.5) on.push(pick(['the last', 'last']));
      else if (m < 0.8) on.push(`the ${pick(ORDS)} ${pick(WD)}`);
      else if (m < 0.9) on.push(`the ${1 + Math.floor(r() * 28)}`, `the ${1 + Math.floor(r() * 28)}`);
      if (on.length) s += ' on ' + on.join(', ');
    } else if (k < 0.92) {
      s = pick(['every year', `every ${n()} years`]);
      const m = r();
      if (m < 0.4) s += ` on ${pick(MON)} ${1 + Math.floor(r() * 31)}${pick(['', 'st', 'th'])}`;
      else if (m < 0.7) s += ` on ${1 + Math.floor(r() * 31)} ${pick(MON)}`;
      else if (m < 0.8) s += ` on the ${1 + Math.floor(r() * 28)}th of ${pick(MON)}`;
    } else {
      s = pick(['every', 'every blue moon', 'daily', 'every 0 days', 'every month on the 0th', 'every day on monday',
        'every month on the 6th Tuesday', 'every 2 weeks on', 'every year on Smarch 3', 'every mon and ']);
    }
    const tail = r();
    if (tail < 0.2) s += ' when done';
    else if (tail < 0.3) s += ` until 2027-0${1 + Math.floor(r() * 9)}-15`;
    else if (tail < 0.4) s += ` for ${1 + Math.floor(r() * 5)} times`;
    else if (tail < 0.45) s += ` for 3 times when done`;
    else if (tail < 0.48) s += ' until 2026-02-30';
    if (r() < 0.1) s = s.toUpperCase();
    out.push(s);
  }
  return out;
}

const COUNT = Number(process.env.DVARIM_FUZZ || 3000);

function engineRepeat(req) {
  const rule = parseRule(req.rule);
  const start = Day.fromISO(req.anchor);
  let cursor = start;
  const next = [];
  for (let i = 0; i < req.n; i++) {
    const nxt = nextOccurrence(rule, start, cursor);
    if (nxt === null) break;
    next.push(nxt.iso());
    cursor = nxt;
  }
  return { describe: describe(rule), next };
}

test('repeat rules agree with the Python (and so with dateutil)', { skip: !available() && 'no Python backend here' }, async () => {
  const r = rng(99);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const reqs = [];
  for (const rule of rules(COUNT, Number(process.env.DVARIM_SEED || 5))) {
    reqs.push({ op: 'repeat', rule, anchor: pick(ANCHORS), n: 6 });
    const when = r() < 0.6 ? pick(ANCHORS) : null;
    const deadline = r() < 0.4 ? pick(ANCHORS) : null;
    reqs.push({ op: 'advance', repeat: rule, when, deadline, today: pick(ANCHORS) });
  }
  const answers = await askAll(reqs);
  const failures = [];
  reqs.forEach((req, i) => {
    const py = answers[i];
    let js, err = null;
    try {
      js = req.op === 'repeat' ? engineRepeat(req)
        : advance(req.repeat, req.when, req.deadline, Day.fromISO(req.today));
    } catch (e) { err = e; }
    if (py.error || err) {
      if (!(py.error && err)) failures.push({ req, py: py.error || py.ok, js: err ? String(err) : js });
      return;
    }
    try { assert.deepStrictEqual(js, py.ok); } catch { failures.push({ req, py: py.ok, js }); }
  });
  if (failures.length) {
    const shown = failures.slice(0, 6).map((f) => `${JSON.stringify(f.req)}\n  python: ${JSON.stringify(f.py)}\n  engine: ${JSON.stringify(f.js)}`);
    assert.fail(`${failures.length} of ${reqs.length} differ:\n${shown.join('\n')}`);
  }
});
