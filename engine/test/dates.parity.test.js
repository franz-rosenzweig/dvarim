// The engine's date grammar against the backend's: every prefix of every
// phrase, as it would arrive while being typed, on days chosen to be awkward —
// a leap day, year and month ends, a daylight-saving weekend — with the week
// starting on Monday and on Sunday; and fuzzed quick-entry lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Day } from '../src/day.js';
import { suggest, parseQuickAdd } from '../src/dates.js';
import { available, askAll } from './oracle.js';

const PHRASES = [
  'today', 'tonight', 'tomorrow', 'tmrw', 'someday', 'anytime', 'this evening', 'evening', 'eve',
  'next week', 'next month', 'next year', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday', 'next monday', 'next fri', 'in 3 days', 'in 2 weeks', 'in 1 month', 'in 4 years',
  'in four days', 'in t', 'in twelve weeks', '3d', '2w', '5mo', '1y', '10 days', '2026-10-01', '2026-02-30',
  '2028-02-29', '1/10', '31/2', '12.3.27', '29-2', '1/1/2030', 'oct 2', 'october 2nd', '2 oct',
  '2 of october', 'sept 31', 'au', 'ju', 'ma', 'dec', 'the 15th', 'the 31st', '17', '31st', 'the 2nd',
  'tomorrow 3pm', 'friday at 9:30', 'tonight 8pm', 'noon', 'midnight', '3pm', 'at 7', '12am', '12:30pm',
  '25:00', 'wed evening', 'next fri eve', 'today at noon', 'mon 8pm', 'in 3 weeks 9am', '  Tomorrow  ',
  // every hour boundary a time can sit on
  '11pm', '23:59', '11:30 pm', '0:00', '12pm', '12:00am', '1am', '13:00', '12:60', '9:5', 'at 23:00',
];
const TODAYS = ['2026-09-23', '2026-12-31', '2027-01-31', '2028-02-29', '2026-03-29', '2026-11-01',
  '2026-01-05', '2026-06-07', '2026-02-28'];
const QUICK = [
  'Call the plumber tomorrow 3pm #home !fri', 'Buy milk', 'Pay rent !1/10', 'Email Dana @9am',
  'Draft chapter 4 next week', 'Water plants every day', 'Read #books #256 someday', 'Gym tonight',
  'Tax forms !oct 2 #money', 'Dentist the 15th at 2:30pm', 'Meet @noon tomorrow', 'x !', '#only #tags',
  'Plan trip in 3 weeks', 'Book flights !next friday @7pm', 'Hebrew שלום tomorrow', 'Call Mum sunday eve',
  'Ship it 2026-10-01', 'Review 3pm', 'nothing to parse here at all',
];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function cases() {
  const out = [];
  for (const today of TODAYS) {
    for (const wso of [6, 0]) {
      for (const p of PHRASES) {
        for (let i = 1; i <= p.length; i++) out.push({ op: 'suggest', text: p.slice(0, i), today, wso, limit: 6 });
      }
    }
  }
  const r = rng(3);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const bits = ['Call', 'Dana', 'the', 'plumber', '#home', '#work', '!fri', '!tomorrow', '@9am', '@7:30 pm',
    'tomorrow', 'next week', 'in 2 days', 'someday', 'tonight', '3pm', 'at noon', 'oct 2', 'the 15th',
    'evening', 'mon', 'x', '!', '@', '#', '1/10', 'ju', 'in', 'next'];
  for (let k = 0; k < 6000; k++) {
    const text = Array.from({ length: 1 + Math.floor(r() * 7) }, () => pick(bits)).join(pick([' ', ' ', '  ']));
    out.push({ op: 'quick_add', text, today: pick(TODAYS), wso: pick([6, 0]) });
    out.push({ op: 'suggest', text, today: pick(TODAYS), wso: pick([6, 0]), limit: 6 });
  }
  for (const text of QUICK) for (const today of TODAYS) out.push({ op: 'quick_add', text, today, wso: 6 });
  return out;
}

function engine(req) {
  const today = Day.fromISO(req.today);
  if (req.op === 'suggest') return suggest(req.text, today, req.wso, req.limit);
  return parseQuickAdd(req.text, today, req.wso);
}

test('dates agree with the Python', { skip: !available() && 'no Python backend here' }, async () => {
  const reqs = cases();
  const answers = await askAll(reqs);
  const failures = [];
  reqs.forEach((req, i) => {
    const py = answers[i];
    let js, err = null;
    try { js = engine(req); } catch (e) { err = e; }
    if (py.error || err) {
      if (!(py.error && err)) failures.push({ req, py: py.error || py.ok, js: err ? String(err) : js });
      return;
    }
    try { assert.deepStrictEqual(js, py.ok); } catch { failures.push({ req, py: py.ok, js }); }
  });
  if (failures.length) {
    const shown = failures.slice(0, 5).map((f) => `${JSON.stringify(f.req)}\n  python: ${JSON.stringify(f.py)}\n  engine: ${JSON.stringify(f.js)}`);
    assert.fail(`${failures.length} of ${reqs.length} differ:\n${shown.join('\n')}`);
  }
});
