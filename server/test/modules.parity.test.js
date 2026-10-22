// The server's smaller modules against the Python's, question for question:
// VTODO both ways and the merge of what a CalDAV app changed (vtodo.js), the
// mirror's content hash that decides whether to write (tasksync.js — it must
// be the Python's, or the first cycle after the switch rewrites everything),
// passwords and session cookies in both directions (auth.js — nobody signed
// out by the switch), CalDAV's XML (xml.js, caldav.js) and the reminder text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vtodo from '../src/vtodo.js';
import { contentKey } from '../src/tasksync.js';
import { Auth, hashPassword, verifyPassword, b64 } from '../src/auth.js';
import { parsePropfind, parseReportCalendarData } from '../src/caldav.js';
import { formatReminder } from '../src/notify.js';
import { available, askAll, pythonHere } from '../../engine/test/oracle.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const skip = !available() && 'no Python here';
const TEXTS = ['Buy milk', '', 'Call Dana, re: contract; soon', 'Line one\nLine two', 'Back\\slash', 'שלום עולם', 'Party 🎉🎉🎉 ' + 'x'.repeat(90),
  'עברית ומילים ארוכות מאוד מאוד מאוד מאוד מאוד מאוד מאוד מאוד מאוד מאוד מאוד', '  spaced  ', 'Tab\there'];
const DATES = [null, '2026-09-23', '2026-12-31', '2027-02-28'];

// titles whose SUMMARY line lands either side of the 73-octet fold, some with
// a two-byte letter right where a line would be cut
const SWEEP = Array.from({ length: 16 }, (_, i) => 'T'.repeat(58 + i)).concat(Array.from({ length: 8 }, (_, i) => 'T'.repeat(60 + i) + 'שש'));

function genTodo(r, id) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;
  return {
    id, title: chance(0.3) ? pick(SWEEP) : pick(TEXTS), notes: pick(TEXTS), status: pick(['open', 'open', 'done', 'canceled']),
    when: pick(DATES), deadline: pick(DATES), created: pick(DATES), completed: pick(DATES),
    tags: chance(0.5) ? [...new Set([pick(['work', 'home', 'ש', 'z', 'Ä', '🎉', 'a,b', 'x;y'])])] : [],
    evening: chance(0.2), someday: chance(0.2), reminder: pick([null, '09:30', '18:00']),
    projectId: pick([null, 'p0000001']), projectName: pick([null, 'Launch', 'Home, sweet']), headingName: pick([null, 'Later', 'Why?']),
    repeat: pick([null, 'every week', 'every month on the 2nd Tuesday']),
    checklist: chance(0.3) ? [{ text: 'one', done: true }, { text: 'two', done: false }] : [],
  };
}

function genIcs(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const L = ['BEGIN:VCALENDAR', 'PRODID:-//tasks.org//EN', 'BEGIN:VTODO'];
  if (r() < 0.95) L.push(`${pick(['UID', 'uid'])}:${pick(['abcd1234@dvarim', 'external-uid-77', 'x@y@z'])}`);
  if (r() < 0.9) L.push(`SUMMARY:${pick(['Buy milk', 'Call\\, then write', 'a\\nb', ' trailing ', 'עברית'])}`);
  if (r() < 0.4) L.push(`DESCRIPTION:${pick(['note', 'two\\nlines', 'esc\\\\aped\\;'])}`);
  if (r() < 0.5) L.push(`DTSTART${pick([';VALUE=DATE', ';TZID=Europe/London', ''])}:${pick(['20260923', '20260923T090000', '20260923T090000Z', 'garbage'])}`);
  if (r() < 0.4) L.push(`DUE;VALUE=DATE:${pick(['20261001', '2026'])}`);
  if (r() < 0.6) L.push(`STATUS:${pick(['NEEDS-ACTION', 'COMPLETED', 'CANCELLED', 'IN-PROCESS', 'completed', 'WEIRD', ' COMPLETED '])}`);
  if (r() < 0.3) L.push(`PERCENT-COMPLETE:${pick(['100', '50', '0', 'x'])}`);
  if (r() < 0.3) L.push(`COMPLETED:${pick(['20260924T101010Z', '20260924'])}`);
  if (r() < 0.4) L.push(`CATEGORIES:${pick(['work', 'work,home', 'a\\,b,c', ' , x', ''])}`);
  if (r() < 0.2) L.push(`X-DVARIM-EVENING:${pick(['TRUE', 'true', 'FALSE'])}`);
  if (r() < 0.2) L.push(`X-DVARIM-REMINDER: ${pick(['09:30', '18:00'])} `);
  if (r() < 0.2) L.push(`X-DVARIM-HEADING:${pick(['Later', 'Why\\?'])}`);
  if (r() < 0.1) L.push('BEGIN:VALARM', 'TRIGGER:-PT15M', 'END:VALARM');
  L.push('END:VTODO', 'END:VCALENDAR');
  const text = L.join(pick(['\r\n', '\n']));
  return r() < 0.3 ? text.replace(/(.{20})/gu, '$1\r\n ') : text;
}

test('VTODO, both ways, and what a CalDAV app changed, agree with the Python', { skip }, async () => {
  const r = rng(7);
  const now = '2026-09-23T10:11:12+00:00';
  const qs = [];
  for (let i = 0; i < 400; i++) qs.push({ op: 'vtodo', kind: 'to_ics', todo: genTodo(r, `t${String(i).padStart(7, '0')}`), now });
  for (let i = 0; i < 400; i++) qs.push({ op: 'vtodo', kind: 'from_ics', text: genIcs(r) });
  for (let i = 0; i < 400; i++) {
    const ours = genTodo(r, 'aaaaaaa1');
    const theirs = vtodo.fromIcs(genIcs(r)) || { tags: [] };
    qs.push({ op: 'vtodo', kind: 'merge', ours, theirs });
  }
  for (let i = 0; i < 400; i++) qs.push({ op: 'vtodo', kind: 'key', todo: genTodo(r, 'k0000001') });
  for (let i = 0; i < 100; i++) qs.push({ op: 'vtodo', kind: 'publishable', todo: genTodo(r, 'p1'), someday: r() < 0.5 });
  const answers = await askAll(qs);
  const problems = [];
  qs.forEach((q, i) => {
    const want = answers[i].ok;
    const got = q.kind === 'to_ics' ? vtodo.toIcs(q.todo, new Date(q.now)) : q.kind === 'from_ics' ? vtodo.fromIcs(q.text)
      : q.kind === 'merge' ? vtodo.mergeFromClient(q.ours, q.theirs) : q.kind === 'key' ? contentKey(q.todo) : vtodo.publishable(q.todo, q.someday);
    try { assert.deepStrictEqual(got, want); } catch {
      problems.push(`${q.kind} ${JSON.stringify(q).slice(0, 300)}\n  ours:   ${JSON.stringify(got).slice(0, 400)}\n  python: ${JSON.stringify(want).slice(0, 400)}`);
    }
  });
  if (problems.length) assert.fail(`${problems.length} differ:\n${problems.slice(0, 3).join('\n\n')}`);
});

/** A cookie with one character of its signature changed — in the middle: the
 *  last one's low bits are base64 padding, which every decoder ignores. */
const tamper = (cookie) => {
  const i = cookie.indexOf('.') + 10;
  return cookie.slice(0, i) + (cookie[i] === 'A' ? 'B' : 'A') + cookie.slice(i + 1);
};

// live only: a cookie is stamped with the time it was made, and a recorded one expires
test('passwords and session cookies pass between the two servers both ways', { skip: !pythonHere() && 'needs the Python itself' }, async () => {
  const salt = b64(Buffer.from('0123456789abcdef'));
  const secret = b64(Buffer.alloc(32, 7));
  const ours = new Auth('/nonexistent', { password: null, secret, tokens: {} });
  const jsCookie = ours.issueSession();
  const record = hashPassword('correct horse', Buffer.from('0123456789abcdef'));
  const [pyHash, pyCookie, pyChecksOurs, pyVerifiesOurs, pyTampered] = (await askAll([
    { op: 'auth', kind: 'hash', password: 'correct horse', salt },
    { op: 'auth', kind: 'issue', secret },
    { op: 'auth', kind: 'check', secret, cookie: jsCookie },
    { op: 'auth', kind: 'verify', password: 'correct horse', record },
    { op: 'auth', kind: 'check', secret, cookie: tamper(jsCookie) },
  ])).map((a) => a.ok);
  assert.deepEqual(record, pyHash, 'the same password and salt hash the same');
  assert.equal(pyVerifiesOurs, true, 'the Python accepts a hash made here');
  assert.equal(verifyPassword('correct horse', pyHash), true, 'and this accepts the Python\'s');
  assert.equal(verifyPassword('wrong horse', pyHash), false);
  assert.equal(pyChecksOurs, true, 'a cookie issued here signs in there');
  assert.equal(ours.checkSession(pyCookie), true, 'and one issued there signs in here');
  assert.equal(pyTampered, false);
  assert.equal(ours.checkSession(tamper(pyCookie)), false, 'a tampered cookie does not');
  const other = new Auth('/nonexistent', { password: null, secret: b64(Buffer.alloc(32, 8)), tokens: {} });
  assert.equal(other.checkSession(pyCookie), false, 'nor one signed with another secret');
  const token = 'dvt_abc';
  const [pyToken] = (await askAll([{ op: 'auth', kind: 'token', secret, token, tokens: { bot: { hash: '8f2a2bd37a97a0f5ae0f8bb2b9b3b5be4c2a3c2f7c3e1fd9d2f3f8d0d6d0a111' } } }])).map((a) => a.ok);
  assert.equal(pyToken, null);
  const withToken = new Auth('/nonexistent', { password: null, secret, tokens: {} });
  withToken.save = () => {};
  const minted = withToken.addToken('signal-bot');
  const [pyKnows] = (await askAll([{ op: 'auth', kind: 'token', secret, token: minted, tokens: withToken.data.tokens }])).map((a) => a.ok);
  assert.equal(pyKnows, 'signal-bot', 'a bot token minted here works there');
  assert.equal(withToken.checkToken(minted), 'signal-bot');
});

const PROPFIND = [
  `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/">
 <response><href>/me/</href><propstat><prop><resourcetype><collection/></resourcetype><displayname>me</displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response>
 <response><href>/me/work/</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname> Work &amp; Life </displayname>
  <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set><ICAL:calendar-color>#4CB35BFF</ICAL:calendar-color></prop>
  <status>HTTP/1.1 200 OK</status></propstat></response>
 <response><href>/me/dvarim/</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype>
  <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat>
  <propstat><prop><ICAL:calendar-color/><displayname/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>
 <response><href>http://radicale:5232/me/holidays/</href><propstat><prop><resourcetype><C:calendar/></resourcetype><displayname><![CDATA[Holidays <IL>]]></displayname></prop></propstat></response>
</multistatus>`,
  '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/</d:href></d:response></d:multistatus>',
  '<not xml',
];
const REPORT = [
  `<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/a.ics</href><propstat><prop>
  <C:calendar-data>BEGIN:VCALENDAR&#13;
BEGIN:VEVENT&#13;
SUMMARY:A &amp; B&#13;
END:VEVENT&#13;
END:VCALENDAR&#13;
</C:calendar-data></prop></propstat></response><response><href>/b.ics</href><propstat><prop><C:calendar-data><![CDATA[BEGIN:VCALENDAR
END:VCALENDAR]]></C:calendar-data></prop></propstat></response><response><href>/c.ics</href><propstat><prop><C:calendar-data/></prop></propstat></response></multistatus>`,
];

test('CalDAV answers are read the same', { skip }, async () => {
  const qs = [...PROPFIND.map((xml) => ({ op: 'caldav_xml', kind: 'propfind', xml, base: 'http://radicale:5232/me/' })),
    ...REPORT.map((xml) => ({ op: 'caldav_xml', kind: 'report', xml }))];
  const answers = await askAll(qs);
  qs.forEach((q, i) => {
    const want = answers[i].ok;
    let got;
    try {
      got = q.kind === 'propfind' ? parsePropfind(q.xml, q.base).map((c) => ({ ...c, components: [...c.components].sort() })) : parseReportCalendarData(q.xml);
    } catch {
      got = { crash: 'ParseError' };
    }
    assert.deepEqual(got, want, q.xml.slice(0, 80));
  });
});

test('reminders read the same', { skip }, async () => {
  const r = rng(3);
  const todos = Array.from({ length: 50 }, (_, i) => genTodo(r, `r${i}`));
  const answers = await askAll(todos.map((todo) => ({ op: 'reminder', todo })));
  todos.forEach((todo, i) => assert.equal(formatReminder(todo), answers[i].ok));
});
