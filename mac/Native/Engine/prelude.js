// What a page has and JavaScriptCore does not, for the engine (engine/src) as
// Dvarim Native runs it. Evaluated before the engine's bundle, so anything the
// engine's modules touch while loading is already here. Each one is the least
// the engine uses; where the work is better done by the Mac (randomness,
// timers, the network, parsing a URL) it is handed to __native, which
// EngineHost.swift installs.
(() => {
  const N = globalThis.__native;

  // ---- console --------------------------------------------------------------
  const say = (level) => (...a) => N.log(level, a.map((x) => {
    if (typeof x === 'string') return x;
    if (x instanceof Error) return `${x.name}: ${x.message}\n${x.stack || ''}`;
    try { return JSON.stringify(x); } catch { return String(x); }
  }).join(' '));
  globalThis.console = { log: say('log'), info: say('info'), warn: say('warn'), error: say('error'), debug: say('debug') };

  // ---- timers: the Mac's, on the engine's own thread -------------------------
  let nextTimer = 0;
  const timers = new Map();
  const intervals = new Set();
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++nextTimer;
    timers.set(id, () => fn(...args));
    N.timer(id, Math.max(0, Number(ms) || 0));
    return id;
  };
  globalThis.clearTimeout = (id) => { intervals.delete(id); if (timers.delete(id)) N.cancelTimer(id); };
  globalThis.setInterval = (fn, ms = 0, ...args) => {
    const id = ++nextTimer;
    const tick = () => { if (!timers.has(id)) return; fn(...args); N.timer(id, Math.max(1, Number(ms) || 1)); };
    timers.set(id, tick);
    intervals.add(id);
    N.timer(id, Math.max(1, Number(ms) || 1));
    return id;
  };
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.__fireTimer = (id) => {
    const fn = timers.get(id);
    if (!fn) return;
    // an interval puts itself back; a timeout is done
    if (!intervals.has(id)) timers.delete(id);
    try { fn(); } catch (e) { console.error('timer', e); }
  };
  globalThis.queueMicrotask = globalThis.queueMicrotask || ((fn) => Promise.resolve().then(fn));

  // ---- randomness -----------------------------------------------------------
  globalThis.crypto = {
    getRandomValues(arr) {
      const bytes = N.random(arr.byteLength);
      new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(bytes);
      return arr;
    },
  };

  // ---- text -----------------------------------------------------------------
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(s = '') {
      s = String(s);
      const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
          const d = s.charCodeAt(i + 1);
          if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
          else c = 0xfffd;
        } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  }
  class TextDecoder {
    decode(bytes) { return N.utf8(Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []))); }
  }
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  globalThis.btoa = (s) => {
    s = String(s);
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error('btoa: not Latin-1');
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  };
  globalThis.atob = (s) => {
    s = String(s).replace(/[\s=]+/g, '');
    let out = '';
    for (let i = 0; i < s.length; i += 4) {
      const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
      out += String.fromCharCode((n >> 16) & 255);
      if (i + 2 < s.length) out += String.fromCharCode((n >> 8) & 255);
      if (i + 3 < s.length) out += String.fromCharCode(n & 255);
    }
    return out;
  };

  // ---- URL: parsed by the Mac (URLComponents), the parts the engine reads ----
  class URLSearchParams {
    constructor(init = '') {
      this._ = [];
      if (typeof init === 'string') {
        for (const part of init.replace(/^\?/, '').split('&')) {
          if (!part) continue;
          const i = part.indexOf('=');
          const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
          this._.push(i < 0 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]);
        }
      } else if (init && typeof init === 'object') {
        for (const [k, v] of (Symbol.iterator in init ? init : Object.entries(init))) this._.push([String(k), String(v)]);
      }
    }
    get(k) { const hit = this._.find(([x]) => x === k); return hit ? hit[1] : null; }
    getAll(k) { return this._.filter(([x]) => x === k).map(([, v]) => v); }
    has(k) { return this._.some(([x]) => x === k); }
    set(k, v) { this.delete(k); this._.push([String(k), String(v)]); }
    append(k, v) { this._.push([String(k), String(v)]); }
    delete(k) { this._ = this._.filter(([x]) => x !== k); }
    forEach(fn) { for (const [k, v] of this._) fn(v, k, this); }
    entries() { return this._[Symbol.iterator](); }
    keys() { return this._.map(([k]) => k)[Symbol.iterator](); }
    values() { return this._.map(([, v]) => v)[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return this._.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }
  }
  class URL {
    constructor(input, base) {
      const p = N.parseURL(String(input), base === undefined ? null : String(base instanceof URL ? base.href : base));
      if (!p) throw new TypeError(`Invalid URL: ${input}`);
      Object.assign(this, p);
      this.searchParams = new URLSearchParams(this.search);
    }
    get origin() { return `${this.protocol}//${this.host}`; }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }
  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;

  // ---- fetch: URLSession, for the built-in sync's WebDAV requests ------------
  class Headers {
    constructor(init = {}) {
      this._ = new Map();
      for (const [k, v] of Object.entries(init || {})) this._.set(k.toLowerCase(), String(v));
    }
    get(k) { const v = this._.get(String(k).toLowerCase()); return v === undefined ? null : v; }
    has(k) { return this._.has(String(k).toLowerCase()); }
    forEach(fn) { for (const [k, v] of this._) fn(v, k, this); }
  }
  let nextFetch = 0;
  const fetches = new Map();
  globalThis.Headers = Headers;
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const id = ++nextFetch;
    fetches.set(id, { resolve, reject });
    const headers = {};
    const h = init.headers || {};
    if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
    else Object.assign(headers, h);
    N.fetch(id, String(url instanceof URL ? url.href : url), String(init.method || 'GET'),
      JSON.stringify(headers), init.body === undefined || init.body === null ? null : String(init.body));
  });
  globalThis.__fetchDone = (id, status, headersJSON, body, error) => {
    const f = fetches.get(id);
    if (!f) return;
    fetches.delete(id);
    if (error) return f.reject(new TypeError(error));
    const text = body == null ? '' : body;
    f.resolve({
      status, ok: status >= 200 && status < 300, statusText: '',
      headers: new Headers(JSON.parse(headersJSON || '{}')),
      text: async () => text,
      json: async () => JSON.parse(text),
    });
  };
})();
