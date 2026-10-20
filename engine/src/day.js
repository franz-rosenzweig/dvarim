// Calendar days, and nothing else.
//
// The Python this replaces used datetime.date: a day with no time and no zone.
// JavaScript's Date is an instant, and a date built from "2026-03-29" in local
// time is a different day on either side of a clock change. So a Day here is a
// count of days since 1970-01-01, turned into year, month and day through UTC,
// where there are no clock changes — the same arithmetic datetime.date does.
// Weekdays count Python's way, 0 = Monday … 6 = Sunday, because the rules being
// ported were written against it.

const MS = 86400000;

export class Day {
  /** @param {number} y @param {number} m 1–12 @param {number} d 1–31 */
  constructor(y, m, d) {
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)
        || y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > Day.daysInMonth(y, m)) {
      throw new RangeError(`not a date: ${y}-${m}-${d}`);
    }
    this.year = y;
    this.month = m;
    this.day = d;
  }

  static daysInMonth(y, m) {
    return [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
            31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }

  /** "2026-09-23" → Day; throws on anything else. */
  static fromISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    if (!m) throw new RangeError(`not an ISO date: ${s}`);
    return new Day(+m[1], +m[2], +m[3]);
  }

  static fromOrdinal(n) {
    const t = new Date(n * MS);
    return new Day(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }

  /** Today where this code runs, as the calendar there shows it. */
  static today(now = new Date()) {
    return new Day(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  /** Days since 1970-01-01. setUTCFullYear, not Date.UTC: Date.UTC reads a
   *  year under 100 as 1900 + it. */
  get ordinal() {
    const t = new Date(0);
    t.setUTCFullYear(this.year, this.month - 1, this.day);
    return Math.round(t.getTime() / MS);
  }

  /** 0 = Monday … 6 = Sunday, as Python's date.weekday(). */
  weekday() {
    return (((this.ordinal + 3) % 7) + 7) % 7;      // 1970-01-01 was a Thursday
  }

  addDays(n) {
    return Day.fromOrdinal(this.ordinal + n);
  }

  /** Days from `other` to this one. */
  minus(other) {
    return this.ordinal - other.ordinal;
  }

  replace({ year = this.year, month = this.month, day = this.day } = {}) {
    return new Day(year, month, day);
  }

  iso() {
    return `${String(this.year).padStart(4, '0')}-${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`;
  }

  toString() { return this.iso(); }
  equals(o) { return !!o && this.ordinal === o.ordinal; }
  compare(o) { return this.ordinal - o.ordinal; }
}

/** A Day or null from something that may be an ISO string. */
export function parseDay(s) {
  try { return s ? Day.fromISO(s) : null; } catch { return null; }
}
