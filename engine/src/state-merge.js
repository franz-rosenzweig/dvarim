// .dvarim/state.json — sort orders, collapsed areas, settings — when two
// devices changed it (docs/SYNC.md). Unlike a note, nobody edits it by hand,
// so it merges the simplest way that always settles: every setting and every
// list's order carries the time it was last changed (in .dvarim/stamps.json,
// beside it, so state.json itself stays what the server writes), and the
// newer wins, key by key. A setting changed on the Mac reaches the phone and
// stays changed there.
import { sha1 } from './sha1.js';

const json = (v) => JSON.stringify(v === undefined ? null : v);

// A stamp is { t: when, v: which value } — the value's fingerprint, because the
// two files travel separately: a sync can bring the stamps of a change whose
// state lost a conflict, and a stamp must never lend its time to a value it
// was not made for.
const print = (value) => sha1(json(value)).slice(0, 12);
const at = (stamps, p, value) => {
  const e = stamps[p];
  return e && typeof e === 'object' && e.v === print(value) ? e.t : 0;
};

/** What is stamped one entry at a time rather than as a whole. */
const PER_ENTRY = new Set(['settings', 'projectOrder', 'upcomingOrder']);

/** The state as { "settings.logCompleted": "daily", "todayOrder": [...], ... }. */
export function statePaths(state) {
  const out = new Map();
  for (const [k, v] of Object.entries(state || {})) {
    if (PER_ENTRY.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [s, x] of Object.entries(v)) out.set(`${k}.${s}`, x);
      if (!Object.keys(v).length) out.set(`${k}.`, null);           // present, and empty
    } else out.set(k, v);
  }
  return out;
}

function fromPaths(paths, order) {
  const out = {};
  const keys = [...new Set([...order, ...[...paths.keys()].map((p) => (p.includes('.') ? p.slice(0, p.indexOf('.')) : p))])];
  for (const k of keys) {
    if (PER_ENTRY.has(k)) {
      const entries = [...paths].filter(([p]) => p.startsWith(`${k}.`));
      if (!entries.length) continue;
      out[k] = {};
      for (const [p, v] of entries) if (p !== `${k}.`) out[k][p.slice(k.length + 1)] = v;
    } else if (paths.has(k)) out[k] = paths.get(k);
  }
  return out;
}

/**
 * @param {object} a
 * @param {object} a.base        what this device last read or wrote
 * @param {object} a.ours        this device's state now
 * @param {object} a.oursStamps  { path: ms }
 * @param {object} a.theirs      what arrived
 * @param {object} a.theirsStamps
 * @returns {{state: object, stamps: object}}
 *
 * The newer stamp wins. Two equal stamps (the usual case when the other
 * writer does not stamp — the server — or its stamps have not arrived yet)
 * go to whichever side changed the value since this device last saw it; if
 * both did, a fixed pick.
 */
export function mergeState({ base, ours, oursStamps, theirs, theirsStamps }) {
  const pb = statePaths(base), po = statePaths(ours), pt = statePaths(theirs);
  const merged = new Map(), stamps = {};
  for (const p of new Set([...po.keys(), ...pt.keys()])) {
    const o = po.get(p), t = pt.get(p), b = pb.get(p);
    const os = po.has(p) ? at(oursStamps, p, o) : 0, ts = pt.has(p) ? at(theirsStamps, p, t) : 0;
    let win;
    if (json(o) === json(t)) win = po.has(p) ? 'o' : 't';
    else if (!po.has(p)) win = 't';
    else if (!pt.has(p)) win = 'o';
    else if (os !== ts) win = os > ts ? 'o' : 't';
    else if (json(o) === json(b)) win = 't';
    else if (json(t) === json(b)) win = 'o';
    else win = json(o) <= json(t) ? 'o' : 't';                  // both, at the same moment: a fixed pick
    const value = win === 'o' ? o : t;
    merged.set(p, value);
    const when = Math.max(at(oursStamps, p, value), at(theirsStamps, p, value));
    if (when) stamps[p] = { t: when, v: print(value) };
  }
  return { state: fromPaths(merged, Object.keys(theirs)), stamps };
}

/** Two stamps files as one: the later stamp for each (its value decides later
 *  whether it counts). */
export function mergeStamps(a, b) {
  const out = { ...a };
  for (const [k, e] of Object.entries(b)) {
    if (!e || typeof e !== 'object') continue;
    if (!out[k] || typeof out[k] !== 'object' || out[k].t < e.t) out[k] = e;
  }
  return out;
}

/** Stamp what changed between two states. */
export function stampChanges(before, after, stamps, now) {
  const pa = statePaths(before), pb = statePaths(after);
  let changed = false;
  for (const p of new Set([...pa.keys(), ...pb.keys()])) {
    if (json(pa.get(p)) !== json(pb.get(p))) { stamps[p] = { t: now, v: print(pb.get(p)) }; changed = true; }
  }
  return changed;
}
