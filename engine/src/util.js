// Python's ways of comparing and sorting, where the engine must order things
// exactly as the backend does.
import { Invalid } from './errors.js';

/** Strings by code point, as Python compares them. JavaScript's < compares
 *  UTF-16 units, which puts an emoji before U+E000–U+FFFF instead of after. */
export function cmpStr(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    const surrogate = (c) => c >= 0xD800 && c <= 0xDFFF;
    if (surrogate(x) || surrogate(y)) {
      const cx = a.codePointAt(i), cy = b.codePointAt(i);
      if (cx !== cy) return cx < cy ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** Python's comparison of sort keys: tuples element by element, numbers as
 *  numbers (a bool is 0 or 1), strings by code point. */
export function cmp(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'boolean') a = a ? 1 : 0;
  if (typeof b === 'boolean') b = b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return cmpStr(a, b);
  throw new TypeError(`cannot compare ${typeof a} with ${typeof b}`);
}

/** sorted(arr, key=key, reverse=reverse): stable either way, like Python's. */
export function sortBy(arr, key, reverse = false) {
  const keyed = arr.map((x, i) => [key(x), i, x]);
  keyed.sort((p, q) => (reverse ? cmp(q[0], p[0]) : cmp(p[0], q[0])) || p[1] - q[1]);
  return keyed.map((p) => p[2]);
}

/** Python's truthiness, for values that arrive in a request. */
export function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// What Python's repr() leaves as it is: everything printable. The rest —
// controls, format characters, separators other than the space — is escaped.
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const hex = (n, w) => n.toString(16).padStart(w, '0');

/** repr(v) of a value that arrived as JSON — what Python puts in an error
 *  message ("cannot parse 'every blue moon'"), quotes and escapes and all. */
export function pyRepr(v) {
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let out = q;
    for (const ch of v) {
      const c = ch.codePointAt(0);
      if (ch === '\\' || ch === q) out += '\\' + ch;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch !== ' ' && NOT_PRINTABLE.test(ch)) out += c <= 0xff ? `\\x${hex(c, 2)}` : c <= 0xffff ? `\\u${hex(c, 4)}` : `\\U${hex(c, 8)}`;
      else out += ch;
    }
    return out + q;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
  return pyStr(v);
}

/** str(v) for what arrives in a request: strings as they are, True/False,
 *  None, numbers, and a list or an object as Python would print it. */
export function pyStr(v) {
  if (typeof v === 'string') return v;
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'object') return pyRepr(v);
  return String(v);
}

/** list(v) for what arrives in a request: a list as it is, a string as its
 *  characters, an object as its keys; anything else is a TypeError there, and
 *  here. ("tags": "work" is four tags in Python, so it is here.) */
export function pyList(v) {
  if (Array.isArray(v)) return [...v];
  if (typeof v === 'string') return [...v];
  if (v !== null && typeof v === 'object') return Object.keys(v);
  throw new TypeError(`'${v === null || v === undefined ? 'NoneType' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : 'bool'}' object is not iterable`);
}

/** d.get(k, default) where Python would call it: only a dict has .get, so
 *  anything else is an AttributeError there — a TypeError here. */
export function pyGet(d, k, dflt = null) {
  if (d === null || typeof d !== 'object' || Array.isArray(d)) {
    throw new TypeError(`'${Array.isArray(d) ? 'list' : d === null ? 'NoneType' : typeof d === 'string' ? 'str' : typeof d}' object has no attribute 'get'`);
  }
  return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : dflt;
}

/** int(v): a number truncates, a string of digits parses; any other string is
 *  a ValueError there (Invalid here), anything else a TypeError. */
export function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    if (/^\s*[-+]?[0-9]+\s*$/u.test(v)) return parseInt(v, 10);
    throw new Invalid(`invalid literal for int() with base 10: ${pyRepr(v)}`);
  }
  throw new TypeError(`int() argument must be a string or a number, not ${v === null ? 'None' : typeof v}`);
}

/** urllib.parse.quote(s, safe=""): encodeURIComponent, and !'()* too. */
export function quote(s) {
  return encodeURIComponent(s).replace(/[!'()*]/gu, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** str.strip(chars) for one character: that character off both ends. */
export function stripChar(s, ch) {
  let a = 0, b = s.length;
  while (a < b && s[a] === ch) a++;
  while (b > a && s[b - 1] === ch) b--;
  return s.slice(a, b);
}
