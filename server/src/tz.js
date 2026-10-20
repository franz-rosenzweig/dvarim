// Time zones, the way Python's zoneinfo sees them, through the IANA database
// Node carries (Intl). A "wall" time is milliseconds of the clock reading
// taken as UTC (rrule.js); an instant is ordinary UTC milliseconds.
const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Whether the zone is one this Node knows (ZoneInfo(name) would load). */
export function validZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The wall time in `tz` at an instant. */
export function utcToWall(ms, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  let year = Number(parts.year);
  if (parts.era === 'BC' || parts.era === 'B') year = 1 - year;
  const t = new Date(0);
  t.setUTCFullYear(year, Number(parts.month) - 1, Number(parts.day));
  t.setUTCHours(Number(parts.hour) % 24, Number(parts.minute), Number(parts.second), 0);
  return t.getTime() + (ms % 1000 + 1000) % 1000;
}

/** The zone's offset from UTC at an instant, in ms. */
export const offsetAt = (ms, tz) => utcToWall(ms, tz) - ms;

/**
 * The instant a wall time in `tz` names, with fold=0, as
 * naive.replace(tzinfo=ZoneInfo(tz)) means it: a time that happens twice (the
 * clocks going back) is the first of the two; a time that never happens (the
 * clocks going forward) is read with the offset from before the change.
 */
export function wallToUtc(wallMs, tz) {
  if (!tz) return wallMs;
  const before = offsetAt(wallMs - 86400000, tz);
  const after = offsetAt(wallMs + 86400000, tz);
  if (before === after) return wallMs - before;
  const a = wallMs - before, b = wallMs - after;
  const aOk = offsetAt(a, tz) === before, bOk = offsetAt(b, tz) === after;
  if (aOk && bOk) return Math.min(a, b);            // twice: the first
  if (aOk) return a;
  if (bOk) return b;
  return a;                                          // never: the offset before the change
}

/** A wall time in one zone as a wall time in another (astimezone). */
export const convert = (wallMs, from, to) => utcToWall(wallToUtc(wallMs, from), to);

/** The local zone: TZ, as the Python read it (default Asia/Jerusalem, else UTC). */
export function localZone(env = process.env) {
  const tz = env.TZ || 'Asia/Jerusalem';
  return validZone(tz) ? tz : 'UTC';
}
