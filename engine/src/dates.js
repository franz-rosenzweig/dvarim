// Natural-language dates for the When popover and quick entry.
//
// backend/dvarim/dates.py, line for line; test/dates.parity.test.js holds the
// two to the same answers. suggest(text, today) returns ranked suggestions the
// UI shows as rows; parseQuickAdd(text, today) splits one line of quick-entry
// text into a title and fields.
//
// `today` is a Day (day.js). weekStartsOn counts Python's way: 0 = Monday …
// 6 = Sunday. Digits are 0-9 only — Python's \d also takes other scripts'
// digits, which the format never meant.
import { Day } from './day.js';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Suggestions follow the typing, so "in fou" already offers "in four days": a
// number can arrive as a word, and as a prefix of one.
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** Python's %: never negative. */
const mod = (a, n) => ((a % n) + n) % n;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const isDigits = (s) => /^[0-9]+$/u.test(s);

export function suggestion(label, { when = null, evening = false, someday = false, reminder = null, hint = '' } = {}) {
  return { label, when, evening, someday, reminder, hint };
}

export function hintFor(d, today) {
  const n = d.minus(today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  let s = `${DOW_SHORT[d.weekday()]} ${d.day} ${MON_SHORT[d.month - 1]}`;
  if (d.year !== today.year) s += ` ${d.year}`;
  return s;
}

export function labelFor(d, today) {
  const n = d.minus(today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n > 1 && n < 7) return cap(WEEKDAYS[d.weekday()]);
  return `${d.day} ${MON_SHORT[d.month - 1]}` + (d.year !== today.year ? ` ${d.year}` : '');
}

const TIME_RE = /^(?:at\s+)?(?:(?<h>[0-9]{1,2})(?::(?<m>[0-9]{2}))?\s*(?<ap>am|pm)?|(?<word>noon|midnight))$/su;

export function parseTime(tok) {
  const m = TIME_RE.exec(tok.trim().toLowerCase());
  if (!m) return null;
  if (m.groups.word) return m.groups.word === 'noon' ? '12:00' : '00:00';
  let h = parseInt(m.groups.h, 10);
  const mi = parseInt(m.groups.m || '0', 10);
  const ap = m.groups.ap;
  if (ap === undefined && m.groups.m === undefined) return null;   // a bare number is not a time
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** Split a trailing time expression off a phrase. */
function splitTime(text) {
  const m = /(?:^|\s)(?:at\s+)?((?:[0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm))|(?:[0-9]{1,2}:[0-9]{2})|noon|midnight)$/su.exec(text);
  if (!m) return [text, null];
  const t = parseTime(m[1]);
  if (t === null) return [text, null];
  return [text.slice(0, m.index).trim(), t];
}

export function nextWeekday(today, wd, allowToday = true) {
  let n = mod(wd - today.weekday(), 7);
  if (n === 0 && !allowToday) n = 7;
  return today.addDays(n);
}

/** weekStartsOn uses Python weekday numbering: 0=Mon ... 6=Sun. */
export function weekStart(today, weekStartsOn) {
  return today.addDays(-mod(today.weekday() - weekStartsOn, 7));
}

export function addMonths(d, n) {
  const m0 = d.month - 1 + n;
  const y = d.year + Math.floor(m0 / 12);
  const m = mod(m0, 12) + 1;
  return new Day(y, m, Math.min(d.day, Day.daysInMonth(y, m)));
}

function ordinalDay(tok) {
  const m = /^(?:the\s+)?([0-9]{1,2})(?:st|nd|rd|th)?$/su.exec(tok);
  if (m && parseInt(m[1], 10) >= 1 && parseInt(m[1], 10) <= 31) return parseInt(m[1], 10);
  return null;
}

function monthIndex(tok) {
  tok = tok.toLowerCase().replace(/\.+$/u, '');
  if ([...tok].length < 3) return null;
  const i = MONTHS.findIndex((m) => m.startsWith(tok));
  return i >= 0 ? i + 1 : null;
}

/** Every month the token could be the start of. "au" is only August; "ju" is
 *  June and July, and the tour's caption shows both offered. */
function monthIndices(tok, minLen = 3) {
  tok = tok.toLowerCase().replace(/\.+$/u, '');
  if ([...tok].length < minLen) return [];
  return MONTHS.flatMap((m, i) => (m.startsWith(tok) ? [i + 1] : []));
}

/** A Day, or null where Python's date() would have raised ValueError. */
function tryDay(y, m, d) {
  try { return new Day(y, m, d); } catch { return null; }
}

function suffix(n) {
  if (n % 100 >= 10 && n % 100 <= 20) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
}

/** Interpret a phrase with no time in it. strict demands unambiguous words (quick-add). */
function datePhrase(text, today, weekStartsOn, strict) {
  const s = text.trim().toLowerCase();
  const out = [];
  if (!s) return out;
  const len = [...s].length;
  const minPrefix = strict ? 3 : 2;
  const kw = (word) => (!strict
    ? word.startsWith(s) && len >= Math.min(minPrefix, word.length)
    : s === word || (len >= 3 && word.startsWith(s)));

  if (kw('today') || s === 'tod' || s === 'tdy') {
    out.push(suggestion('Today', { when: today.iso(), hint: DOW_SHORT[today.weekday()] }));
  }
  if (kw('tonight') || kw('this evening') || kw('evening') || s === 'eve') {
    out.push(suggestion('This Evening', { when: today.iso(), evening: true }));
  }
  if (kw('tomorrow') || ['tom', 'tmr', 'tmrw'].includes(s)) {
    const d = today.addDays(1);
    out.push(suggestion('Tomorrow', { when: d.iso(), hint: hintFor(d, today) }));
  }
  if (kw('someday')) out.push(suggestion('Someday', { someday: true }));
  if (kw('anytime')) out.push(suggestion('Anytime'));
  // "in fou(r days)": a number written as a word, or the start of one. Only
  // when it can mean one number — "in t" is two, three, ten and twelve.
  let sn = s;
  if (!strict) {
    const mw = /^in\s+([a-z]+)(\s.*)?$/su.exec(s);
    if (mw) {
      const hit = new Set(Object.entries(NUMBER_WORDS).filter(([w]) => w.startsWith(mw[1])).map(([, n]) => n));
      if (hit.size === 1) sn = `in ${[...hit][0]}${mw[2] || ''}`;
    }
  }
  let m = /^(?:in\s+)?([0-9]+)\s*(d|w|mo|m|y|day|days|week|weeks|month|months|year|years)?$/su.exec(sn);
  if (m && (sn.startsWith('in ') || m[2])) {
    const n = parseInt(m[1], 10);
    const unit = (m[2] || 'd')[0];
    const units = m[2] ? [unit] : ['d', 'w', 'm'];
    for (const u of units) {
      let d, lab;
      const s1 = n !== 1 ? 's' : '';
      if (u === 'd') { d = today.addDays(n); lab = `in ${n} day${s1}`; }
      else if (u === 'w') { d = today.addDays(7 * n); lab = `in ${n} week${s1}`; }
      else if (u === 'm') { d = addMonths(today, n); lab = `in ${n} month${s1}`; }
      else { d = new Day(today.year + n, today.month, Math.min(today.day, 28)); lab = `in ${n} year${s1}`; }
      out.push(suggestion(lab, { when: d.iso(), hint: hintFor(d, today) }));
    }
  }

  m = /^(next\s+)?([a-z]+)$/su.exec(s);
  if (m && m[2].length >= (strict ? 3 : 2)) {
    const w = m[2];
    WEEKDAYS.forEach((name, i) => {
      if (!name.startsWith(w)) return;
      if (m[1]) {
        const d = nextWeekday(weekStart(today, weekStartsOn).addDays(7), i);
        out.push(suggestion(`Next ${cap(name)}`, { when: d.iso(), hint: hintFor(d, today) }));
      } else {
        const d = nextWeekday(today, i, true);
        out.push(suggestion(!d.equals(today) ? cap(name) : `${cap(name)} (today)`, { when: d.iso(), hint: hintFor(d, today) }));
        if (d.equals(today)) {
          const d2 = d.addDays(7);
          out.push(suggestion(`Next ${cap(name)}`, { when: d2.iso(), hint: hintFor(d2, today) }));
        }
      }
    });
  }

  if (kw('next week')) {
    const d = weekStart(today, weekStartsOn).addDays(7);
    out.push(suggestion('Next week', { when: d.iso(), hint: hintFor(d, today) }));
  }
  if (kw('next month')) {
    const d = addMonths(today.replace({ day: 1 }), 1);
    out.push(suggestion('Next month', { when: d.iso(), hint: hintFor(d, today) }));
  }
  if (kw('next year')) {
    const d = new Day(today.year + 1, 1, 1);
    out.push(suggestion('Next year', { when: d.iso(), hint: hintFor(d, today) }));
  }

  // ISO date
  m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/su.exec(s);
  if (m) {
    const d = tryDay(+m[1], +m[2], +m[3]);
    if (d) out.push(suggestion(labelFor(d, today), { when: d.iso(), hint: hintFor(d, today) }));
  }
  // D/M, D.M, D-M or D/M/YYYY (day first: Israeli/European region format)
  m = /^([0-9]{1,2})[./-]([0-9]{1,2})(?:[./-]([0-9]{2,4}))?$/su.exec(s);
  if (m) {
    const dd = +m[1], mm = +m[2], yy = m[3];
    const y = !yy ? today.year : (yy.length === 2 ? +yy + 2000 : +yy);
    let d = tryDay(y, mm, dd);
    if (d && d.compare(today) < 0 && !yy) d = tryDay(y + 1, mm, dd);
    if (d) out.push(suggestion(labelFor(d, today), { when: d.iso(), hint: hintFor(d, today) }));
  }
  // "oct 2", "october 2nd", "2 oct", "2 october"
  m = /^([a-z]{3,})\.?\s*([0-9]{1,2})(?:st|nd|rd|th)?$/su.exec(s)
    || /^([0-9]{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,})\.?$/su.exec(s);
  if (m) {
    const [a, b] = [m[1], m[2]];
    const mon = !isDigits(a) ? monthIndex(a) : monthIndex(b);
    const day = !isDigits(a) ? parseInt(b, 10) : parseInt(a, 10);
    if (mon && day >= 1 && day <= 31) {
      let d = tryDay(today.year, mon, day);
      if (d && d.compare(today) < 0) d = tryDay(today.year + 1, mon, day);
      if (d) out.push(suggestion(`${d.day} ${MON_SHORT[mon - 1]}`, { when: d.iso(), hint: hintFor(d, today) }));
    }
  }
  // bare month name → the 1st
  if (!strict) {
    const mons = /^[a-z]{2,}$/su.test(s) ? monthIndices(s, 2) : [];
    if (mons.length && !out.some((o) => o.when)) {
      for (const mon of mons) {
        let d = new Day(today.year, mon, 1);
        if (d.compare(today) <= 0) d = new Day(today.year + 1, mon, 1);
        out.push(suggestion(`${cap(MONTHS[mon - 1])} 1`, { when: d.iso(), hint: hintFor(d, today) }));
      }
    }
  }
  // "the 15th", and — while typing, where there is nothing else it could be —
  // a bare "17".
  const od = ordinalDay(s);
  if (od && (s.startsWith('the') || ['st', 'nd', 'rd', 'th'].some((x) => s.endsWith(x))
             || (!strict && /^[0-9]{1,2}$/su.test(s)))) {
    let d = today;
    for (let k = 0; k < 3; k++) {
      const last = Day.daysInMonth(d.year, d.month);
      if (od <= last && new Day(d.year, d.month, od).compare(today) > 0) {
        d = new Day(d.year, d.month, od);
        break;
      }
      d = addMonths(d.replace({ day: 1 }), 1);
    }
    out.push(suggestion(`the ${od}${suffix(od)}`, { when: d.iso(), hint: hintFor(d, today) }));
  }
  return out;
}

export function suggest(text, today, weekStartsOn = 6, limit = 6) {
  const s = text.trim().toLowerCase().replace(/\s+/gu, ' ');
  if (!s) return [];
  let [phrase, time] = splitTime(s);
  let eveningWords = false;
  if ([' evening', ' eve', ' tonight'].some((x) => phrase.endsWith(x)) && phrase !== 'this evening') {
    phrase = phrase.replace(/\s+(evening|eve|tonight)$/su, '');
    eveningWords = true;
  }
  const out = [];
  if (!phrase && time) {
    out.push(suggestion('Today', { when: today.iso(), reminder: time, hint: time }));
    const d = today.addDays(1);
    out.push(suggestion('Tomorrow', { when: d.iso(), reminder: time, hint: time }));
    return out.slice(0, limit);
  }
  for (const sug of datePhrase(phrase, today, weekStartsOn, false)) {
    if (time) {
      sug.reminder = time;
      sug.hint = (sug.hint ? sug.hint + ' · ' : '') + time;
    }
    if (eveningWords && sug.when) {
      sug.evening = true;
      if (sug.label === 'Today') sug.label = 'This Evening';
    }
    out.push(sug);
  }
  // de-duplicate by (when, evening, someday, reminder)
  const seen = new Set();
  const uniq = [];
  for (const sug of out) {
    const key = JSON.stringify([sug.when, sug.evening, sug.someday, sug.reminder]);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(sug);
  }
  return uniq.slice(0, limit);
}

// ---- quick add -------------------------------------------------------------------

const squash = (s) => s.replace(/\s+/gu, ' ').trim();

/**
 * 'Call the plumber tomorrow 3pm #home !fri' →
 * { title, tags, when, evening, someday, reminder, deadline }.
 * Rules: #tag anywhere; !<phrase> = deadline (1–3 words); @<time> = reminder;
 * a trailing date phrase (1–4 words, unambiguous) sets When.
 */
export function parseQuickAdd(text, today, weekStartsOn = 6) {
  let s = text.trim().replace(/\s+/gu, ' ');
  const tags = [...s.matchAll(/(?:(?<=\s)|^)#([^\s#]+)/gsu)].map((m) => m[1]).filter((t) => !isDigits(t));
  // each thing taken out leaves its space behind; close it up, or a tag at
  // the end hides the date before it ("tomorrow 3pm #work" ends in "")
  s = squash(s.replace(/(?:(?<=\s)|^)#[^\s#]+/gsu, ''));
  const out = { title: '', tags, when: null, evening: false, someday: false, reminder: null, deadline: null };
  // deadline: try 3, 2, 1 words after '!'
  let m = /(?:(?<=\s)|^)!(\S.*)$/su.exec(s);
  if (m) {
    const words = m[1].split(' ');
    for (const n of [3, 2, 1]) {
      const cand = words.slice(0, n).join(' ');
      const sug = datePhrase(cand.toLowerCase(), today, weekStartsOn, true).filter((x) => x.when);
      if (sug.length) {
        out.deadline = sug[0].when;
        s = squash(s.slice(0, m.index) + ' ' + words.slice(n).join(' '));
        break;
      }
    }
  }
  // reminder: @3pm
  m = /(?:(?<=\s)|^)@(\S+(?:\s?(?:am|pm))?)/isu.exec(s);
  if (m) {
    const t = parseTime(m[1]);
    if (t) {
      out.reminder = t;
      s = squash(s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length));
    }
  }
  // trailing date phrase (1-4 words), possibly with a time
  let words = s.split(' ');
  for (const n of [4, 3, 2, 1]) {
    if (words.length <= n) continue;      // never consume the whole title
    const cand = words.slice(-n).join(' ').toLowerCase();
    let [phrase, time] = splitTime(cand);
    let ev = false;
    if ([' evening', ' eve', ' tonight'].some((x) => phrase.endsWith(x))) {
      phrase = phrase.replace(/\s+(evening|eve|tonight)$/su, '');
      ev = true;
    }
    if (!phrase && time) {
      out.when = today.iso();
      out.reminder = out.reminder || time;
      words = words.slice(0, -n);
      break;
    }
    const sugs = datePhrase(phrase, today, weekStartsOn, true);
    if (sugs.length) {
      const sug = sugs[0];
      out.when = sug.when;
      out.evening = sug.evening || ev;
      out.someday = sug.someday;
      if (time) out.reminder = out.reminder || time;
      words = words.slice(0, -n);
      break;
    }
  }
  out.title = words.join(' ').replace(/\s+/gu, ' ').trim();
  if (out.reminder && !out.when && !out.someday) out.when = today.iso();
  return out;
}
