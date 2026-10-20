// Repeat rules in the Obsidian Tasks vocabulary.
//
//     every day | every 3 days | every week | every 2 weeks on Monday, Thursday
//     every weekday | every Sunday | every month | every month on the 15th
//     every month on the last | every 2 months on the 2nd Tuesday | every month on the last Friday
//     every year | every year on January 5th | every year on 5 January
//     ... when done   (repeat after completion)
//     ... until 2026-12-31 | ... for 12 times   (Dvarim extensions)
//
// backend/dvarim/repeat.py line for line, except that the Python hands the
// schedule to dateutil's rrule and this cannot. So `occurrences` below is
// dateutil's algorithm for the rules this vocabulary can express, down to its
// quirks: every "by" rule must hold at once (the RFC's reading, and Obsidian
// Tasks' — "the 15th, the 2nd Tuesday" is a 15th that is a second Tuesday),
// weeks start on Monday for "every 2 weeks", the start day counts only if it
// fits the rule, and a rule that never fits is searched up to the year 9999
// and then has no next date. test/repeat.parity.test.js holds it to dateutil.
import { Day } from './day.js';
import { Invalid } from './errors.js';
import { pyRepr } from './util.js';

const WD_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const ORD = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4,
  fifth: 5, '5th': 5, last: -1 };
const MAXYEAR = 9999;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const isDigits = (s) => /^[0-9]+$/u.test(s);

/** A rule that cannot be read: an Invalid, as the Python's is a ValueError. */
export class RuleError extends Invalid {}

/**
 * @typedef {object} Rule
 * @property {'day'|'week'|'month'|'year'} freq
 * @property {number} interval
 * @property {Array<number|[number, number]>} byweekday  0..6 (Mon=0), or [weekday, n] for "2nd Tuesday"
 * @property {number[]} bymonthday  1..31, or -1 for the last
 * @property {number|null} bymonth
 * @property {boolean} whenDone
 * @property {string|null} until
 * @property {number|null} count
 */
function rule(freq, fields = {}) {
  return { freq, interval: 1, byweekday: [], bymonthday: [], bymonth: null,
    whenDone: false, until: null, count: null, ...fields };
}

function wdIndex(tok) {
  tok = tok.toLowerCase().replace(/,+$/u, '');
  if ([...tok].length < 3) return null;
  const i = WD_NAMES.findIndex((n) => n.startsWith(tok));
  return i >= 0 ? i : null;
}

const splitList = (s) => s.split(/,|\band\b/u);

/** @returns {Rule} — or throws RuleError for anything it cannot read. */
export function parseRule(text) {
  let s = text.trim().toLowerCase().replace(/\s+/gu, ' ');
  let whenDone = false, until = null, count = null;
  if (s.endsWith(' when done')) { whenDone = true; s = s.slice(0, -' when done'.length); }
  let m = /\s+until ([0-9]{4}-[0-9]{2}-[0-9]{2})$/su.exec(s);
  if (m) { until = m[1]; s = s.slice(0, m.index); }
  m = /\s+for ([0-9]+) times?$/su.exec(s);
  if (m) { count = parseInt(m[1], 10); s = s.slice(0, m.index); }
  if (s.endsWith(' when done')) { whenDone = true; s = s.slice(0, -' when done'.length); }
  if (!s.startsWith('every')) throw new RuleError(`repeat rule must start with 'every': ${pyRepr(text)}`);
  const rest = s.slice(5).trim();
  let r = null;

  const withN = /^([0-9]+)\s+(day|week|month|year)s?\b(.*)$/su.exec(rest);
  const without = withN ? null : /^(day|week|month|year)s?\b(.*)$/su.exec(rest);
  if (withN || without) {
    const [interval, unit, tailRaw] = withN ? [parseInt(withN[1], 10), withN[2], withN[3]] : [1, without[1], without[2]];
    r = rule(unit, { interval });
    const tail = tailRaw.trim();
    if (tail) {
      if (!tail.startsWith('on ')) throw new RuleError(`cannot parse ${pyRepr(text)}`);
      parseOn(r, tail.slice(3).trim(), text);
    }
  } else if (rest.startsWith('weekday')) {
    r = rule('week', { byweekday: [0, 1, 2, 3, 4] });
  } else {
    // "every Sunday", "every Monday, Wednesday", "every Mon and Wed"
    const parts = splitList(rest).filter((p) => p.trim());
    const idxs = parts.map((p) => wdIndex(p.trim()));
    if (parts.length && idxs.every((i) => i !== null)) r = rule('week', { byweekday: idxs });
    else throw new RuleError(`cannot parse repeat rule ${pyRepr(text)}`);
  }
  r.whenDone = whenDone;
  r.until = until;
  r.count = count;
  // "every 0 days" is not a schedule (dateutil never returns from one), nor is
  // "the 0th" (dateutil drops it and matches every day) — see repeat.py
  if (r.interval < 1) throw new RuleError(`a repeat needs an interval of at least 1: ${pyRepr(text)}`);
  if (r.bymonthday.some((d) => !(d >= 1 && d <= 31) && d !== -1)) {
    throw new RuleError(`a day of the month is 1 to 31: ${pyRepr(text)}`);
  }
  return r;
}

function parseOn(r, on, text) {
  const parts = splitList(on).map((p) => p.trim()).filter((p) => p);
  if (r.freq === 'week') {
    const idxs = parts.map(wdIndex);
    if (!idxs.every((i) => i !== null)) throw new RuleError(`cannot parse ${pyRepr(text)}`);
    r.byweekday = idxs;
  } else if (r.freq === 'month') {
    for (let p of parts) {
      p = p.replace(/^the\s+/u, '');
      let m = /^([0-9]{1,2})(?:st|nd|rd|th)?$/su.exec(p);
      if (m) { r.bymonthday.push(parseInt(m[1], 10)); continue; }
      if (p === 'last') { r.bymonthday.push(-1); continue; }
      m = /^(first|second|third|fourth|fifth|last|[0-9](?:st|nd|rd|th))\s+([a-z]+)$/su.exec(p);
      if (m && wdIndex(m[2]) !== null && Object.prototype.hasOwnProperty.call(ORD, m[1])) {
        r.byweekday.push([wdIndex(m[2]), ORD[m[1]]]);
        continue;
      }
      throw new RuleError(`cannot parse ${pyRepr(text)}`);
    }
  } else if (r.freq === 'year') {
    const p = (parts[0] ?? '').replace(/^the\s+/u, '');
    const m = /^([a-z]+)\s+([0-9]{1,2})(?:st|nd|rd|th)?$/su.exec(p)
      || /^([0-9]{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)$/su.exec(p);
    if (!m) throw new RuleError(`cannot parse ${pyRepr(text)}`);
    const [a, b] = [m[1], m[2]];
    const [monTok, day] = !isDigits(a) ? [a, parseInt(b, 10)] : [b, parseInt(a, 10)];
    const i = MONTHS.findIndex((n) => n.startsWith(monTok.slice(0, 3)));
    if (i < 0) throw new RuleError(`cannot parse ${pyRepr(text)}`);
    r.bymonth = i + 1;
    r.bymonthday = [day];
  } else {
    throw new RuleError(`'on' is not valid for daily rules: ${pyRepr(text)}`);
  }
}

// ---- the schedule ------------------------------------------------------------

/** The day of the month that is the nth `wd` of y-m, or null (n < 0 counts from the end). */
function nthWeekday(y, m, wd, n) {
  const last = Day.daysInMonth(y, m);
  if (n > 0) {
    const first = new Day(y, m, 1).weekday();
    const d = 1 + ((wd - first + 7) % 7) + 7 * (n - 1);
    return d <= last ? d : null;
  }
  const lastWd = new Day(y, m, last).weekday();
  const d = last - ((lastWd - wd + 7) % 7) - 7 * (-n - 1);
  return d >= 1 ? d : null;
}

/**
 * Every date on the schedule from `dtstart` on, in order: dateutil's rrule for
 * the rules parseRule can produce.
 * @param {Rule} r @param {Day} dtstart
 */
export function* occurrences(r, dtstart) {
  // dateutil's defaults, decided on what was given rather than what survives
  let bymonth = r.bymonth ? [r.bymonth] : [];
  let monthdays = [...r.bymonthday];
  let plain = [];
  const nth = [];
  for (const w of r.byweekday) {
    if (Array.isArray(w)) {
      if (r.freq === 'month' || r.freq === 'year') nth.push(w);
      else plain.push(w[0]);
    } else plain.push(w);
  }
  if (!r.bymonthday.length && !r.byweekday.length) {
    if (r.freq === 'year') { if (!bymonth.length) bymonth = [dtstart.month]; monthdays = [dtstart.day]; }
    else if (r.freq === 'month') monthdays = [dtstart.day];
    else if (r.freq === 'week') plain = [dtstart.weekday()];
  }
  if (nth.length && r.freq === 'year') throw new RuleError('an ordinal weekday in a yearly rule is not supported');
  const pos = monthdays.filter((d) => d > 0);
  const neg = monthdays.filter((d) => d < 0);
  let until = null;
  if (r.until) {
    try { until = Day.fromISO(r.until); } catch { throw new RuleError(`not a date: until ${r.until}`); }
  }
  let left = r.count;             // null: no limit

  // Whether y-m-day (weekday wd, dim days in the month) fits every "by" rule:
  // dateutil's masks, all of which must hold.
  const fits = (m, day, wd, dim, nthDays) => {
    if (bymonth.length && !bymonth.includes(m)) return false;
    if (plain.length && !plain.includes(wd)) return false;
    if (nthDays && !nthDays.has(day)) return false;
    if ((pos.length || neg.length) && !pos.includes(day) && !neg.includes(day - dim - 1)) return false;
    return true;
  };
  const nthOf = (y, m) => new Set(nth.map(([wd, n]) => nthWeekday(y, m, wd, n)).filter((x) => x !== null));

  // Days are walked as numbers and only made into Days when they fit: a rule
  // that never fits is walked all the way to 9999, three million days or so.
  let stop = false;
  function* offer(y, m, from, to) {
    const dim = Day.daysInMonth(y, m);
    const w1 = new Day(y, m, 1).weekday();
    const nthDays = nth.length ? nthOf(y, m) : null;
    for (let day = from; day <= to; day++) {
      if (!fits(m, day, (w1 + day - 1) % 7, dim, nthDays)) continue;
      const d = new Day(y, m, day);
      if (until && d.compare(until) > 0) { stop = true; return; }
      if (d.compare(dtstart) >= 0) {
        if (left !== null) {
          left -= 1;
          if (left < 0) { stop = true; return; }
        }
        yield d;
      }
    }
  }

  // One period at a time, as dateutil walks them.
  let period = dtstart;
  for (;;) {
    if (period.year > MAXYEAR) return;
    if (r.freq === 'day') {
      yield* offer(period.year, period.month, period.day, period.day);
    } else if (r.freq === 'week') {
      // from the period's first day up to the next Monday, which may be in
      // the next month or year
      let d = period;
      for (let k = 0; k < 7 && !stop; k++) {
        yield* offer(d.year, d.month, d.day, d.day);
        const next = d.addDays(1);
        if (next.weekday() === 0) break;
        d = next;
      }
    } else if (r.freq === 'month') {
      yield* offer(period.year, period.month, 1, Day.daysInMonth(period.year, period.month));
    } else {
      // a year; only its bymonth months can fit, so only they are walked
      const months = bymonth.length ? [...bymonth].sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      for (const m of months) {
        if (stop) break;
        yield* offer(period.year, m, 1, Day.daysInMonth(period.year, m));
      }
    }
    if (stop) return;
    // the next period
    try {
      if (r.freq === 'day') period = period.addDays(r.interval);
      else if (r.freq === 'week') period = period.addDays(-period.weekday() + 7 * r.interval);
      else if (r.freq === 'month') {
        const m0 = period.month - 1 + r.interval;
        const y = period.year + Math.floor(m0 / 12);
        if (y > MAXYEAR) return;
        period = new Day(y, (m0 % 12) + 1, 1);
      } else {
        const y = period.year + r.interval;
        if (y > MAXYEAR) return;
        period = new Day(y, 1, 1);
      }
    } catch {
      return;                                              // past the last representable day
    }
  }
}

/**
 * Next date strictly after `after`, on the schedule anchored at `anchor`. For
 * a when-done rule pass the completion date as both. Monthly and yearly rules
 * with no "on" keep the anchor's day of the month.
 * @param {Rule} r @param {Day} anchor @param {Day} after @returns {Day|null}
 */
export function nextOccurrence(r, anchor, after) {
  if ((r.freq === 'month' || r.freq === 'year') && !r.bymonthday.length && !r.byweekday.length) {
    r = r.freq === 'month'
      ? { ...r, bymonthday: [anchor.day < 29 ? anchor.day : -1] }
      : { ...r, bymonth: anchor.month, bymonthday: [anchor.day] };
  }
  for (const d of occurrences(r, anchor)) if (d.compare(after) > 0) return d;
  return null;
}

function sfx(n) {
  if (n % 100 >= 10 && n % 100 <= 20) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[((n % 10) + 10) % 10] || 'th';
}

/** The rule as a sentence, the way it is written into a file. */
export function describe(r) {
  let s = 'every ' + (r.interval !== 1 ? `${r.interval} ${r.freq}s` : r.freq);
  if (r.freq === 'week' && r.byweekday.length) {
    if (r.interval === 1 && r.byweekday.length === 5 && [0, 1, 2, 3, 4].every((d, i) => r.byweekday[i] === d)) {
      s = 'every weekday';
    } else {
      s += ' on ' + r.byweekday.map((i) => cap(WD_NAMES[i])).join(', ');
    }
  } else if (r.freq === 'month' && (r.bymonthday.length || r.byweekday.length)) {
    const parts = [];
    for (const d of r.bymonthday) parts.push(d === -1 ? 'the last' : `the ${d}${sfx(d)}`);
    for (const [wd, n] of r.byweekday) parts.push((n === -1 ? 'the last ' : `the ${n}${sfx(n)} `) + cap(WD_NAMES[wd]));
    s += ' on ' + parts.join(', ');
  } else if (r.freq === 'year' && r.bymonth) {
    const d = r.bymonthday[0];
    s += ` on ${cap(MONTHS[r.bymonth - 1])} ${d}${sfx(d)}`;
  }
  if (r.whenDone) s += ' when done';
  if (r.until) s += ` until ${r.until}`;
  if (r.count) s += ` for ${r.count} times`;
  return s;
}

/**
 * A repeating to-do was completed: its next When and Deadline, as ISO dates,
 * or null if the rule has ended. Throws RuleError for a rule it cannot read.
 * @param {string} repeatText @param {string|null} when @param {string|null} deadline @param {Day} today
 */
export function advance(repeatText, when, deadline, today) {
  const r = parseRule(repeatText);
  const w = when ? Day.fromISO(when) : null;
  const d = deadline ? Day.fromISO(deadline) : null;
  const anchor = w || d || today;
  // Copies are made on schedule whenever they are completed, so a late
  // completion yields the next scheduled date even if it has already passed.
  const nxt = r.whenDone ? nextOccurrence(r, today, today) : nextOccurrence(r, anchor, anchor);
  if (nxt === null) return null;
  const delta = nxt.minus(anchor);
  let newWhen = w ? w.addDays(delta).iso() : (d ? null : nxt.iso());
  if (w === null && d !== null) newWhen = null;
  const newDeadline = d ? d.addDays(delta).iso() : null;
  if (w === null && d === null) newWhen = nxt.iso();
  return [newWhen, newDeadline];
}
