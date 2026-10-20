// RFC 5545 recurrence rules, for calendar events: dateutil's rrule and
// rrulestr (python-dateutil 2.9), ported — the same period-by-period masks,
// the same defaults, the same refusals — so a repeating event lands on the
// same days as it did for the Python server. test/calendar.parity.test.js
// asks dateutil the same questions and compares.
//
// Times are "wall" times: milliseconds since 1970 of the clock reading taken
// as if it were UTC. dateutil does its arithmetic on wall time too, and only
// the UNTIL of a rule in a time zone is an instant (compared through tz.js).
import { wallToUtc } from './tz.js';

export const YEARLY = 0, MONTHLY = 1, WEEKLY = 2, DAILY = 3, HOURLY = 4, MINUTELY = 5, SECONDLY = 6;
const FREQ = { YEARLY, MONTHLY, WEEKLY, DAILY, HOURLY, MINUTELY, SECONDLY };
const WEEKDAY = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
const DAY = 86400000;
const MAXYEAR = 9999;

/** What Python raises as ValueError or TypeError: the event is dropped.
 *  Raised while iterating instead, it takes the whole fetch down with it. */
export class RuleError extends Error {}
/** Kept for callers that tell the two apart; dateutil turns every bad part of
 *  a rule into a ValueError, so nothing raises this now. */
export class RuleCrash extends Error {}

// ---- masks, as dateutil builds them

const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const M366MASK = [...Array(31).fill(1), ...Array(29).fill(2), ...Array(31).fill(3), ...Array(30).fill(4), ...Array(31).fill(5),
  ...Array(30).fill(6), ...Array(31).fill(7), ...Array(31).fill(8), ...Array(30).fill(9), ...Array(31).fill(10),
  ...Array(30).fill(11), ...Array(31).fill(12), ...Array(7).fill(1)];
const M365MASK = [...M366MASK]; M365MASK.splice(59, 1);
const MDAY366MASK = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].flatMap((n) => range(1, n + 1)).concat(range(1, 8));
const MDAY365MASK = [...MDAY366MASK]; MDAY365MASK.splice(59, 1);
const NMDAY366MASK = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].flatMap((n) => range(-n, 0)).concat(range(-31, -24));
const NMDAY365MASK = [...NMDAY366MASK]; NMDAY365MASK.splice(31, 1);
const M366RANGE = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];
const M365RANGE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
const WDAYMASK = Array.from({ length: 7 * 55 }, (_, i) => i % 7);

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
/** Monday = 0, as Python's weekday(). */
const weekdayOf = (y, m, d) => (new Date(wall(y, m, d)).getUTCDay() + 6) % 7;
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const pymod = (a, b) => ((a % b) + b) % b;
const pydiv = (a, b) => Math.floor(a / b);

export function wallParts(ms) {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}
export const wall = (y, mo, d, h = 0, mi = 0, s = 0) => {
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, 0);
  return t.getTime();
};

class IterInfo {
  constructor(rr) {
    this.rr = rr;
    this.lastyear = null;
    this.lastmonth = null;
  }

  rebuild(year, month) {
    const rr = this.rr;
    if (year !== this.lastyear) {
      this.yearlen = 365 + (isLeap(year) ? 1 : 0);
      this.nextyearlen = 365 + (isLeap(year + 1) ? 1 : 0);
      this.yearordinal = Math.round(wall(year, 1, 1) / DAY);
      this.yearweekday = weekdayOf(year, 1, 1);
      const wday = this.yearweekday;
      if (this.yearlen === 365) {
        this.mmask = M365MASK; this.mdaymask = MDAY365MASK; this.nmdaymask = NMDAY365MASK; this.mrange = M365RANGE;
      } else {
        this.mmask = M366MASK; this.mdaymask = MDAY366MASK; this.nmdaymask = NMDAY366MASK; this.mrange = M366RANGE;
      }
      this.wdaymask = WDAYMASK.slice(wday);
      if (!rr.byweekno) this.wnomask = null;
      else {
        this.wnomask = new Array(this.yearlen + 7).fill(0);
        let no1wkst = pymod(7 - this.yearweekday + rr.wkst, 7);
        const firstwkst = no1wkst;
        let wyearlen;
        if (no1wkst >= 4) { no1wkst = 0; wyearlen = this.yearlen + pymod(this.yearweekday - rr.wkst, 7); }
        else wyearlen = this.yearlen - no1wkst;
        const numweeks = pydiv(wyearlen, 7) + pydiv(pymod(wyearlen, 7), 4);
        for (let n of rr.byweekno) {
          if (n < 0) n += numweeks + 1;
          if (!(n > 0 && n <= numweeks)) continue;
          let i;
          if (n > 1) {
            i = no1wkst + (n - 1) * 7;
            if (no1wkst !== firstwkst) i -= 7 - firstwkst;
          } else i = no1wkst;
          for (let j = 0; j < 7; j++) {
            this.wnomask[i] = 1;
            i += 1;
            if (this.wdaymask[i] === rr.wkst) break;
          }
        }
        if (rr.byweekno.includes(1)) {
          let i = no1wkst + numweeks * 7;
          if (no1wkst !== firstwkst) i -= 7 - firstwkst;
          if (i < this.yearlen) {
            for (let j = 0; j < 7; j++) {
              this.wnomask[i] = 1;
              i += 1;
              if (this.wdaymask[i] === rr.wkst) break;
            }
          }
        }
        if (no1wkst) {
          let lnumweeks;
          if (!rr.byweekno.includes(-1)) {
            const lyearweekday = weekdayOf(year - 1, 1, 1);
            let lno1wkst = pymod(7 - lyearweekday + rr.wkst, 7);
            const lyearlen = 365 + (isLeap(year - 1) ? 1 : 0);
            if (lno1wkst >= 4) {
              lno1wkst = 0;
              lnumweeks = 52 + pydiv(pymod(lyearlen + pymod(lyearweekday - rr.wkst, 7), 7), 4);
            } else lnumweeks = 52 + pydiv(pymod(this.yearlen - no1wkst, 7), 4);
          } else lnumweeks = -1;
          if (rr.byweekno.includes(lnumweeks)) for (let i = 0; i < no1wkst; i++) this.wnomask[i] = 1;
        }
      }
    }
    if (rr.bynweekday && (month !== this.lastmonth || year !== this.lastyear)) {
      let ranges = [];
      if (rr.freq === YEARLY) {
        if (rr.bymonth) for (const m of rr.bymonth) ranges.push([this.mrange[m - 1], this.mrange[m]]);
        else ranges = [[0, this.yearlen]];
      } else if (rr.freq === MONTHLY) ranges = [[this.mrange[month - 1], this.mrange[month]]];
      if (ranges.length) {
        this.nwdaymask = new Array(this.yearlen).fill(0);
        for (let [first, last] of ranges) {
          last -= 1;
          for (const [wday, n] of rr.bynweekday) {
            let i;
            if (n < 0) {
              i = last + (n + 1) * 7;
              i -= pymod(this.wdaymask[i] - wday, 7);
            } else {
              i = first + (n - 1) * 7;
              i += pymod(7 - this.wdaymask[i] + wday, 7);
            }
            if (first <= i && i <= last) this.nwdaymask[i] = 1;
          }
        }
      }
    }
    this.lastyear = year;
    this.lastmonth = month;
  }

  ydayset() { return [range(0, this.yearlen), 0, this.yearlen]; }

  mdayset(year, month) {
    const set = new Array(this.yearlen).fill(null);
    const start = this.mrange[month - 1], end = this.mrange[month];
    for (let i = start; i < end; i++) set[i] = i;
    return [set, start, end];
  }

  wdayset(year, month, day) {
    const set = new Array(this.yearlen + 7).fill(null);
    let i = Math.round(wall(year, month, day) / DAY) - this.yearordinal;
    const start = i;
    for (let j = 0; j < 7; j++) {
      set[i] = i;
      i += 1;
      if (this.wdaymask[i] === this.rr.wkst) break;
    }
    return [set, start, i];
  }

  ddayset(year, month, day) {
    const set = new Array(this.yearlen).fill(null);
    const i = Math.round(wall(year, month, day) / DAY) - this.yearordinal;
    set[i] = i;
    return [set, i, i + 1];
  }

  htimeset(hour) {
    const out = [];
    for (const minute of this.rr.byminute) for (const second of this.rr.bysecond) out.push([hour, minute, second]);
    return out.sort(cmpTime);
  }

  mtimeset(hour, minute) {
    return this.rr.bysecond.map((second) => [hour, minute, second]).sort(cmpTime);
  }

  stimeset(hour, minute, second) {
    return [[hour, minute, second]];
  }
}

const cmpTime = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export class RRule {
  /**
   * @param {object} o
   * @param {number} o.freq
   * @param {number} o.dtstart   wall ms
   * @param {string|null} [o.tz] the time zone dtstart is in, or null for a floating (naive) one
   * @param {{ms: number, utc: boolean}|null} [o.until]
   */
  constructor(o) {
    const dtstart = o.dtstart;
    const p = wallParts(dtstart);
    this.dtstart = dtstart;
    this.tz = o.tz || null;
    this.freq = o.freq;
    this.interval = o.interval ?? 1;
    this.count = o.count ?? null;
    this.until = o.until || null;
    if (this.until && (this.tz !== null) !== this.until.utc) {
      throw new RuleError('RRULE UNTIL values must be specified in UTC when DTSTART is timezone-aware');
    }
    // An interval of 0 repeats the first period: with a COUNT dateutil stops
    // when it runs out, and so does this; without one it loops for ever, and a
    // negative one walks back to the year 1. Here those are a rule with no dates.
    if (!(this.interval >= 1) && !(this.interval === 0 && this.count !== null)) throw new RuleError('interval must be at least 1');
    this.wkst = o.wkst ?? 0;
    const bysetpos = o.bysetpos ?? null;
    if (bysetpos !== null) {
      for (const pos of bysetpos) if (pos === 0 || !(pos >= -366 && pos <= 366)) throw new RuleError('bysetpos must be between 1 and 366, or between -366 and -1');
    }
    this.bysetpos = bysetpos && bysetpos.length ? bysetpos : null;
    let { bymonth = null, bymonthday = null, byyearday = null, byweekno = null, byweekday = null, byhour = null, byminute = null, bysecond = null } = o;
    if (byweekno === null && byyearday === null && bymonthday === null && byweekday === null) {
      if (this.freq === YEARLY) {
        if (bymonth === null) bymonth = [p.month];
        bymonthday = [p.day];
      } else if (this.freq === MONTHLY) bymonthday = [p.day];
      else if (this.freq === WEEKLY) byweekday = [{ wd: weekdayOf(p.year, p.month, p.day), n: null }];
    }
    const sortedSet = (a) => [...new Set(a)].sort((x, y) => x - y);
    this.bymonth = bymonth === null ? null : sortedSet(bymonth);
    this.byyearday = byyearday === null ? null : sortedSet(byyearday);
    if (bymonthday === null) { this.bymonthday = []; this.bynmonthday = []; }
    else {
      const s = sortedSet(bymonthday);
      this.bymonthday = s.filter((x) => x > 0);
      this.bynmonthday = s.filter((x) => x < 0);
    }
    this.byweekno = byweekno === null ? null : sortedSet(byweekno);
    if (byweekday === null) { this.byweekday = null; this.bynweekday = null; }
    else {
      const plain = new Set(), nth = [];
      for (const w of byweekday) {
        if (!w.n || this.freq > MONTHLY) plain.add(w.wd);
        else if (!nth.some(([a, b]) => a === w.wd && b === w.n)) nth.push([w.wd, w.n]);
      }
      this.byweekday = plain.size ? [...plain].sort((a, b) => a - b) : null;
      this.bynweekday = nth.length ? nth.sort((a, b) => a[0] - b[0] || a[1] - b[1]) : null;
    }
    const byset = (start, by, base) => {
      const set = new Set();
      for (const num of by) if (gcd(this.interval, base) === 1 || pymod(num - start, gcd(this.interval, base)) === 0) set.add(num);
      if (!set.size) throw new RuleError('Invalid rrule byxxx generates an empty set.');
      return set;
    };
    if (byhour === null) this.byhour = this.freq < HOURLY ? [p.hour] : null;
    else this.byhour = [...(this.freq === HOURLY ? byset(p.hour, byhour, 24) : new Set(byhour))].sort((a, b) => a - b);
    if (byminute === null) this.byminute = this.freq < MINUTELY ? [p.minute] : null;
    else this.byminute = [...(this.freq === MINUTELY ? byset(p.minute, byminute, 60) : new Set(byminute))].sort((a, b) => a - b);
    if (bysecond === null) this.bysecond = this.freq < SECONDLY ? [p.second] : null;
    else this.bysecond = [...(this.freq === SECONDLY ? byset(p.second, bysecond, 60) : new Set(bysecond))].sort((a, b) => a - b);
    if (this.freq >= HOURLY) this.timeset = null;
    else {
      this.timeset = [];
      for (const h of this.byhour) for (const mi of this.byminute) for (const s of this.bysecond) this.timeset.push([h, mi, s]);
      this.timeset.sort(cmpTime);
    }
  }

  /** res > until, the way Python compares: wall to wall if floating,
   *  instant to instant if in a zone. */
  _pastUntil(res) {
    if (!this.until) return false;
    if (!this.until.utc) return res > this.until.ms;
    return wallToUtc(res, this.tz) > this.until.ms;
  }

  _modDistance(value, byxxx, base) {
    let acc = 0;
    for (let i = 1; i <= base; i++) {
      const div = pydiv(value + this.interval, base);
      value = pymod(value + this.interval, base);
      acc += div;
      if (byxxx.includes(value)) return [acc, value];
    }
    return [acc, value];
  }

  *[Symbol.iterator]() { yield* this._iter(Infinity); }

  /** dateutil's _iter. `stopAfter`: a wall time past which nothing is wanted,
   *  so a rule that never matches need not walk to the year 9999 to say so. */
  *_iter(stopAfter) {
    let { year, month, day, hour, minute, second } = wallParts(this.dtstart);
    let weekday = weekdayOf(year, month, day);
    const { freq, interval, wkst, bymonth, byweekno, byyearday, byweekday, bymonthday, bynmonthday, bysetpos, byhour, byminute, bysecond } = this;
    const ii = new IterInfo(this);
    ii.rebuild(year, month);
    const getdayset = freq === YEARLY ? (y, m, d) => ii.ydayset(y, m, d) : freq === MONTHLY ? (y, m, d) => ii.mdayset(y, m, d)
      : freq === WEEKLY ? (y, m, d) => ii.wdayset(y, m, d) : (y, m, d) => ii.ddayset(y, m, d);
    let timeset;
    let gettimeset = null;
    if (freq < HOURLY) timeset = this.timeset;
    else {
      gettimeset = freq === HOURLY ? (h) => ii.htimeset(h) : freq === MINUTELY ? (h, mi) => ii.mtimeset(h, mi) : (h, mi, s) => ii.stimeset(h, mi, s);
      if ((freq >= HOURLY && byhour && !byhour.includes(hour)) || (freq >= MINUTELY && byminute && !byminute.includes(minute))
          || (freq >= SECONDLY && bysecond && !bysecond.includes(second))) timeset = [];
      else timeset = gettimeset(hour, minute, second);
    }
    let count = this.count;
    const combine = (i, t) => (ii.yearordinal + i) * DAY + ((t[0] * 60 + t[1]) * 60 + t[2]) * 1000;
    for (;;) {
      const [dayset, start, end] = getdayset(year, month, day);
      if (this.interval > 0 && (ii.yearordinal + start) * DAY > stopAfter) return;
      let filtered = false;
      for (let i = start; i < end; i++) {
        if (dayset[i] === null) continue;
        if ((bymonth && !bymonth.includes(ii.mmask[i]))
            || (byweekno && !ii.wnomask[i])
            || (byweekday && !byweekday.includes(ii.wdaymask[i]))
            || (ii.nwdaymask && this.bynweekday && !ii.nwdaymask[i])
            || ((bymonthday.length || bynmonthday.length) && !bymonthday.includes(ii.mdaymask[i]) && !bynmonthday.includes(ii.nmdaymask[i]))
            || (byyearday && ((i < ii.yearlen && !byyearday.includes(i + 1) && !byyearday.includes(-ii.yearlen + i))
              || (i >= ii.yearlen && !byyearday.includes(i + 1 - ii.yearlen) && !byyearday.includes(-ii.nextyearlen + i - ii.yearlen))))) {
          dayset[i] = null;
          filtered = true;
        }
      }
      if (bysetpos && timeset.length) {
        const poslist = [];
        const days = dayset.slice(start, end).filter((x) => x !== null);
        for (const pos of bysetpos) {
          let daypos, timepos;
          if (pos < 0) { daypos = pydiv(pos, timeset.length); timepos = pymod(pos, timeset.length); }
          else { daypos = pydiv(pos - 1, timeset.length); timepos = pymod(pos - 1, timeset.length); }
          const i = daypos < 0 ? days[days.length + daypos] : days[daypos];
          const time = timeset[timepos];
          if (i === undefined || time === undefined) continue;
          const res = combine(i, time);
          if (!poslist.includes(res)) poslist.push(res);
        }
        poslist.sort((a, b) => a - b);
        for (const res of poslist) {
          if (this._pastUntil(res)) return;
          if (res >= this.dtstart) {
            if (count !== null) { count -= 1; if (count < 0) return; }
            yield res;
          }
        }
      } else {
        for (let i = start; i < end; i++) {
          if (dayset[i] === null) continue;
          for (const time of timeset) {
            const res = combine(i, time);
            if (this._pastUntil(res)) return;
            if (res >= this.dtstart) {
              if (count !== null) { count -= 1; if (count < 0) return; }
              yield res;
            }
          }
        }
      }
      let fixday = false;
      if (freq === YEARLY) {
        year += interval;
        if (year > MAXYEAR) return;
        ii.rebuild(year, month);
      } else if (freq === MONTHLY) {
        month += interval;
        if (month > 12) {
          const div = pydiv(month, 12), mod = pymod(month, 12);
          month = mod; year += div;
          if (month === 0) { month = 12; year -= 1; }
          if (year > MAXYEAR) return;
        }
        ii.rebuild(year, month);
      } else if (freq === WEEKLY) {
        if (wkst > weekday) day += -(weekday + 1 + (6 - wkst)) + interval * 7;
        else day += -(weekday - wkst) + interval * 7;
        weekday = wkst;
        fixday = true;
      } else if (freq === DAILY) {
        day += interval;
        fixday = true;
      } else if (freq === HOURLY) {
        if (filtered) hour += pydiv(23 - hour, interval) * interval;
        let ndays;
        if (byhour) [ndays, hour] = this._modDistance(hour, byhour, 24);
        else { ndays = pydiv(hour + interval, 24); hour = pymod(hour + interval, 24); }
        if (ndays) { day += ndays; fixday = true; }
        timeset = gettimeset(hour, minute, second);
      } else if (freq === MINUTELY) {
        if (filtered) minute += pydiv(1439 - (hour * 60 + minute), interval) * interval;
        let valid = false;
        const rep = 24 * 60;
        for (let j = 0; j < pydiv(rep, gcd(interval, rep)); j++) {
          let nhours;
          if (byminute) [nhours, minute] = this._modDistance(minute, byminute, 60);
          else { nhours = pydiv(minute + interval, 60); minute = pymod(minute + interval, 60); }
          const div = pydiv(hour + nhours, 24);
          hour = pymod(hour + nhours, 24);
          if (div) { day += div; fixday = true; filtered = false; }
          if (!byhour || byhour.includes(hour)) { valid = true; break; }
        }
        if (!valid) throw new RuleError('Invalid combination of interval and byhour resulting in empty rule.');
        timeset = gettimeset(hour, minute, second);
      } else if (freq === SECONDLY) {
        if (filtered) second += pydiv(86399 - (hour * 3600 + minute * 60 + second), interval) * interval;
        const rep = 24 * 3600;
        let valid = false;
        for (let j = 0; j < pydiv(rep, gcd(interval, rep)); j++) {
          let nminutes;
          if (bysecond) [nminutes, second] = this._modDistance(second, bysecond, 60);
          else { nminutes = pydiv(second + interval, 60); second = pymod(second + interval, 60); }
          let div = pydiv(minute + nminutes, 60);
          minute = pymod(minute + nminutes, 60);
          if (div) {
            hour += div;
            div = pydiv(hour, 24);
            hour = pymod(hour, 24);
            if (div) { day += div; fixday = true; }
          }
          if ((!byhour || byhour.includes(hour)) && (!byminute || byminute.includes(minute)) && (!bysecond || bysecond.includes(second))) {
            valid = true;
            break;
          }
        }
        if (!valid) throw new RuleError('Invalid combination of interval, byhour and byminute resulting in empty rule.');
        timeset = gettimeset(hour, minute, second);
      }
      if (fixday && day > 28) {
        let dim = daysIn(year, month);
        if (day > dim) {
          while (day > dim) {
            day -= dim;
            month += 1;
            if (month === 13) {
              month = 1;
              year += 1;
              if (year > MAXYEAR) return;
            }
            dim = daysIn(year, month);
          }
          ii.rebuild(year, month);
        }
      }
    }
  }

  /** Every occurrence from lo to hi, both included (dateutil's between(inc=True)). */
  between(lo, hi) {
    const out = [];
    for (const t of this._iter(hi)) {
      if (t > hi) break;
      if (t >= lo) out.push(t);
    }
    return out;
  }
}

/**
 * rrulestr(value, dtstart=...) for one RRULE value, as dateutil reads it.
 * @param {string} text        "FREQ=WEEKLY;BYDAY=MO,WE" (or "RRULE:…")
 * @param {number} dtstart     wall ms
 * @param {string|null} tz     dtstart's zone, or null if it is floating
 */
export function rrulestr(text, dtstart, tz) {
  let s = String(text).toUpperCase();
  if (!s.trim()) throw new RuleError('empty string');
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length !== 2) throw new RuleError('too many values to unpack');
    if (parts[0] !== 'RRULE') throw new RuleError('unknown parameter name');
    s = parts[1];
  }
  const kw = {};
  const int = (v) => {
    if (!/^\s*[+-]?\d+\s*$/u.test(v)) throw new RuleError(`invalid literal for int(): ${v}`);
    return parseInt(v, 10);
  };
  for (const pair of s.split(';')) {
    const bits = pair.split('=');
    if (bits.length !== 2) throw new RuleError('not enough values to unpack');
    const [name, value] = bits;
    switch (name) {
      case 'INTERVAL': case 'COUNT': kw[name.toLowerCase()] = int(value); break;
      case 'BYSETPOS': case 'BYMONTH': case 'BYMONTHDAY': case 'BYYEARDAY': case 'BYWEEKNO': case 'BYHOUR': case 'BYMINUTE': case 'BYSECOND':
        kw[name.toLowerCase()] = value.split(',').map(int);
        break;
      case 'BYEASTER':
        // dateutil's own extension; no calendar sends it
        throw new RuleError('BYEASTER is not supported here');
      case 'FREQ':
        if (!(value in FREQ)) throw new RuleError(`invalid 'FREQ': ${value}`);
        kw.freq = FREQ[value];
        break;
      case 'UNTIL': kw.until = parseUntil(value); break;
      case 'WKST':
        if (!(value in WEEKDAY)) throw new RuleError(`invalid 'WKST': ${value}`);
        kw.wkst = WEEKDAY[value];
        break;
      case 'BYDAY': case 'BYWEEKDAY': {
        const list = [];
        for (const w of value.split(',')) {
          let wd, n = null;
          if (w.includes('(')) {
            const [a, b] = w.split('(');
            wd = a;
            n = int(b.slice(0, -1));
          } else if (w.length) {
            let i = 0;
            while (i < w.length && '+-0123456789'.includes(w[i])) i++;
            if (i === w.length) i = w.length - 1;       // Python leaves i on the last character
            n = w.slice(0, i) ? int(w.slice(0, i)) : null;
            wd = w.slice(i);
          } else throw new RuleError('Invalid (empty) BYDAY specification.');
          if (!(wd in WEEKDAY)) throw new RuleError(`invalid 'BYDAY': ${value}`);
          if (n === 0) throw new RuleError("Can't create weekday with n==0");
          list.push({ wd: WEEKDAY[wd], n });
        }
        kw.byweekday = list;
        break;
      }
      default: throw new RuleError(`unknown parameter '${name}'`);
    }
  }
  if (kw.freq === undefined) throw new RuleError("missing required argument 'freq'");
  return new RRule({ ...kw, dtstart, tz });
}

/** UNTIL, as dateutil's parser reads the forms calendars write. */
function parseUntil(v) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2})(?::?(\d{2}))?)?(Z)?$/u.exec(v.trim());
  if (!m) throw new RuleError('invalid until date');
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59) throw new RuleError('invalid until date');
  return { ms: wall(y, mo, d, h, mi, s), utc: !!m[7] };
}

export { daysIn, weekdayOf };
