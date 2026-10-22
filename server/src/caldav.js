// Calendars over CalDAV (backend/dvarim/calendar.py's client, ported): the
// events for Today and Upcoming, read-only and cached for a minute, and the
// few writes the to-do mirror needs (tasksync.js). Configured with
// DVARIM_CALDAV_URL (the user's collection root, e.g. http://radicale:5232/me/),
// DVARIM_CALDAV_USER and DVARIM_CALDAV_PASS; without them, no calendars and no
// errors.
import { parseXml, findAll, find, findText, iter } from '../../engine/src/xml.js';
import { parseVevents, expand, sortRows } from './ical.js';
import { localZone } from './tz.js';

const D = 'DAV:', C = 'urn:ietf:params:xml:ns:caldav', A = 'http://apple.com/ns/ical/';
export const PALETTE = ['#4CB35B', '#5A9CF2', '#E8A33D', '#B26CDB', '#E0565B', '#3FB4A6', '#C5A166'];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const origin = (url) => {
  const m = /^(https?:\/\/[^/]+)/u.exec(url);
  return m ? m[1] : '';
};

/** The calendars in a PROPFIND answer (calendar.py, parse_propfind). */
export function parsePropfind(xmlText, baseUrl) {
  const root = parseXml(xmlText);
  const cals = [];
  for (const resp of findAll(root, D, 'response')) {
    const href = findText(resp, D, 'href', '');
    if (!href) continue;
    let isCal = false, name = null, color = null, comps = new Set();
    for (const ps of findAll(resp, D, 'propstat')) {
      const prop = find(ps, D, 'prop');
      if (!prop) continue;
      const rt = find(prop, D, 'resourcetype');
      if (rt && find(rt, C, 'calendar')) isCal = true;
      const dn = find(prop, D, 'displayname');
      if (dn && dn.text) name = dn.text.trim();
      const cc = find(prop, A, 'calendar-color');
      if (cc && cc.text) color = [...cc.text.trim()].slice(0, 7).join('');
      const sc = find(prop, C, 'supported-calendar-component-set');
      if (sc) comps = new Set(findAll(sc, C, 'comp').map((c) => c.attrs.name ?? null));
    }
    if (!isCal) continue;
    const full = href.startsWith('http') ? href : (origin(baseUrl) ? origin(baseUrl) + href : href);
    cals.push({ href: full, name: name || href.replace(/\/+$/u, '').split('/').pop(), color, components: comps.size ? comps : new Set(['VEVENT', 'VTODO']) });
  }
  return cals;
}

/** Every calendar-data's text in a REPORT answer. */
export function parseReportCalendarData(xmlText) {
  return [...iter(parseXml(xmlText), C, 'calendar-data')].map((el) => el.text).filter(Boolean);
}

export class CalDAV {
  constructor(url, user, password, { timeout = 8000, tz = localZone(), fetchFn = fetch } = {}) {
    this.url = url.endsWith('/') ? url : url + '/';
    this.authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    this.timeout = timeout;
    this.tz = tz;
    this.fetch = fetchFn;
    this.calCache = null;
    this.evCache = new Map();
  }

  async _raw(method, url, body = null, headers = {}) {
    return this.fetch(url, {
      method, body: body === null ? undefined : body,
      headers: { Authorization: this.authHeader, ...headers },
      signal: AbortSignal.timeout(this.timeout),
    });
  }

  async _request(method, url, body, depth) {
    const r = await this._raw(method, url, body, { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' });
    const text = await r.text();
    if (r.status >= 400) throw new HttpError(r.status, `${method} ${url}: ${r.status}`);
    return text;
  }

  async calendars(ttl = 300000) {
    if (this.calCache && Date.now() - this.calCache[0] < ttl) return this.calCache[1];
    const body = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" '
      + 'xmlns:a="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/>'
      + '<c:supported-calendar-component-set/><a:calendar-color/></d:prop></d:propfind>';
    const cals = parsePropfind(await this._request('PROPFIND', this.url, body, '1'), this.url);
    this.calCache = [Date.now(), cals];
    return cals;
  }

  /** Events from dateFrom to dateTo, on every calendar (names null) or on those named. */
  async events(dateFrom, dateTo, names = null, ttl = 60000) {
    // null (every calendar) and [] (none) are different questions, and must not share an answer
    const key = JSON.stringify([dateFrom, dateTo, names === null ? null : [...names]]);
    const hit = this.evCache.get(key);
    if (hit && Date.now() - hit[0] < ttl) return hit[1];
    const day = (iso, add) => new Date(Date.parse(iso + 'T00:00:00Z') + add * 86400000).toISOString().slice(0, 10).replace(/-/gu, '');
    let out = [];
    const cals = await this.calendars();
    for (let i = 0; i < cals.length; i++) {
      const cal = cals[i];
      if (!cal.components.has('VEVENT')) continue;
      if (names !== null && !names.includes(cal.name)) continue;
      const start = `${day(dateFrom, -1)}T000000Z`, end = `${day(dateTo, 2)}T000000Z`;
      const body = '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        + '<d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
        + `<c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
      let xmlText;
      try {
        xmlText = await this._request('REPORT', cal.href, body, '1');
      } catch (e) {
        if (e instanceof HttpError || e.name === 'TypeError' || e.name === 'TimeoutError' || e.name === 'AbortError') continue;   // httpx.HTTPError
        throw e;
      }
      const events = [];
      for (const ics of parseReportCalendarData(xmlText)) events.push(...parseVevents(ics, this.tz));
      out.push(...expand(events, dateFrom, dateTo, cal.name, cal.color || PALETTE[i % PALETTE.length], this.tz));
    }
    out = sortRows(out);
    this.evCache.set(key, [Date.now(), out]);
    return out;
  }

  // ---- writing, for the to-do mirror

  /** The VTODO collection's URL, made if it is not there yet. */
  async ensureTaskCollection(name, display) {
    const url = this.url + name.replace(/^\/+|\/+$/gu, '') + '/';
    try {
      const r = await this._raw('PROPFIND', url, '', { Depth: '0' });
      await r.text();
      if (r.status < 400) return url;
    } catch { /* not reachable that way: try making it */ }
    const body = '<?xml version="1.0" encoding="utf-8"?>'
      + '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
      + '<D:set><D:prop>'
      + `<D:displayname>${display}</D:displayname>`
      + '<C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>'
      + '</D:prop></D:set></C:mkcalendar>';
    const r = await this._raw('MKCALENDAR', url, body, { 'Content-Type': 'application/xml; charset=utf-8' });
    const text = await r.text();
    if (r.status >= 400 && r.status !== 405) throw new Error(`could not create ${url}: ${r.status} ${text.slice(0, 200)}`);   // 405: already there
    return url;
  }

  /** { href: etag } for everything in the collection. */
  async listEtags(collection) {
    const body = '<?xml version="1.0" encoding="utf-8"?>'
      + '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>';
    const root = parseXml(await this._request('PROPFIND', collection, body, '1'));
    const out = {};
    const self = collection.replace(/\/+$/u, '').split('/').pop();
    for (const resp of findAll(root, D, 'response')) {
      const href = findText(resp, D, 'href', '');
      if (!href || href.replace(/\/+$/u, '').endsWith(self)) continue;
      let etag = '';
      for (const ps of findAll(resp, D, 'propstat')) {
        const prop = find(ps, D, 'prop');
        if (prop) {
          const tag = findText(prop, D, 'getetag', '');
          if (tag) etag = tag.replace(/^"+|"+$/gu, '');
        }
      }
      if (href.endsWith('.ics')) out[href] = etag;
    }
    return out;
  }

  async getText(href) {
    const r = await this._raw('GET', this._abs(href));
    const text = await r.text();
    if (r.status >= 400) throw new HttpError(r.status, `GET ${href}: ${r.status}`);
    return text;
  }

  /** PUT a calendar object; its new ETag, if the server gave one. */
  async putIcs(href, body, etag = null) {
    const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
    if (etag) headers['If-Match'] = `"${etag}"`;
    const r = await this._raw('PUT', this._abs(href), body, headers);
    const text = await r.text();
    if (r.status >= 400) throw new Error(`PUT ${href}: ${r.status} ${text.slice(0, 160)}`);
    return (r.headers.get('etag') || '').replace(/^"+|"+$/gu, '') || null;
  }

  async delete(href) {
    const r = await this._raw('DELETE', this._abs(href));
    await r.text();
    if (r.status >= 400 && r.status !== 404) throw new Error(`DELETE ${href}: ${r.status}`);
  }

  _abs(href) {
    if (href.startsWith('http')) return href;
    const o = origin(this.url);
    return o ? o + href : href;
  }
}

export const configured = (env = process.env) => !!env.DVARIM_CALDAV_URL;

/**
 * The client, and the router's calendar services (engine/src/api.js).
 * @returns {{client: CalDAV|null, services: object}}
 */
export function calendarServices(env = process.env, opts = {}) {
  if (!configured(env)) {
    return { client: null, services: { calendars: async () => ({ configured: false, calendars: [] }) } };
  }
  const client = new CalDAV(env.DVARIM_CALDAV_URL, env.DVARIM_CALDAV_USER || '', env.DVARIM_CALDAV_PASS || '', { tz: localZone(env), ...opts });
  return {
    client,
    services: {
      events: (from, to, names) => client.events(from, to, names),
      calendars: async () => {
        try {
          const cals = await client.calendars();
          return { configured: true, calendars: cals.map((x) => ({ name: x.name, color: x.color, components: [...x.components].sort() })) };
        } catch (e) {
          return { configured: true, calendars: [], error: e && e.message ? e.message : String(e) };
        }
      },
    },
  };
}
