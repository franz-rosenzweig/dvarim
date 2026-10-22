// The made-up vault the taste on stuffs opens with (demo/app/demo.js puts it
// into the browser's IndexedDB the first time, and again on "Reset the demo").
//
// Every to-do here is invented. It is written relative to the visitor's own
// today, so Today, Upcoming and the Logbook always look lived in: ten to-dos
// for today, a few days with something on them, a week of things done. The
// files are what a real vault holds, in the format of docs/FORMAT.md, plus the
// app's own tutorial project, "Meet Dvarim", and a .dvarim/state.json that
// only puts Today in a sensible order.
//
// Plain JavaScript with no imports but the engine's tutorial, so it runs in the
// page and in Node (tools/build_taste.py checks it with the engine).

import { tutorialText, TUTORIAL_PATH } from '../engine/src/tutorial.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A stable 🆔 for a title: the same vault every time it is made. */
function makeIds() {
  const used = new Set();
  return function id(title) {
    for (let salt = 0; ; salt++) {
      // FNV-1a, forwards and backwards, into eight characters of 0-9a-z
      const s = `${title}|${salt}`;
      let a = 0x811c9dc5, b = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0;
        b = Math.imul(b ^ s.charCodeAt(s.length - 1 - i), 0x01000193) >>> 0;
      }
      let out = '';
      for (let i = 0; i < 4; i++) { out += ALPHABET[a % 36] + ALPHABET[b % 36]; a = Math.floor(a / 36); b = Math.floor(b / 36); }
      if (!used.has(out)) { used.add(out); return out; }
    }
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** { path: text } for a vault as of `now` (a Date, local time). */
export function demoVault(now = new Date()) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const d = (n) => {
    const t = new Date(base);
    t.setDate(t.getDate() + n);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  };
  const id = makeIds();
  const ids = {};                              // title -> id, for state.json

  function todo(title, o = {}) {
    const box = o.done !== undefined ? 'x' : ' ';
    const parts = [`- [${box}] ${title}`];
    for (const t of o.tags || []) parts.push(`#${t}`);
    if (o.evening) parts.push('🌙');
    if (o.someday) parts.push('💤');
    if (o.reminder) parts.push(`⏰ ${o.reminder}`);
    const tid = id(title + (o.done !== undefined ? '|done' : ''));
    ids[title] = tid;
    parts.push(`🆔 ${tid}`);
    if (o.repeat) parts.push(`🔁 ${o.repeat}`);
    parts.push(`➕ ${d(o.created ?? -7)}`);
    if (o.when !== undefined) parts.push(`⏳ ${d(o.when)}`);
    if (o.deadline !== undefined) parts.push(`📅 ${d(o.deadline)}`);
    if (o.done !== undefined) parts.push(`✅ ${d(o.done)}`);
    const lines = [parts.join(' ')];
    for (const n of o.notes || []) lines.push(n ? `    ${n}` : '');
    for (const [text, ok] of o.checklist || []) lines.push(`    - [${ok ? 'x' : ' '}] ${text}`);
    return lines.join('\n');
  }

  function front(kv) {
    const out = ['---'];
    for (const [k, v] of Object.entries(kv)) {
      if (v === undefined || v === null) continue;
      out.push(`${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
    }
    out.push('---');
    return out.join('\n');
  }

  const files = {};
  const put = (path, lines) => { files[path] = lines.map((l) => l + '\n').join(''); };

  put('Inbox.md', [
    todo('Look up that podcast about lighthouses', { created: -2 }),
    todo('Gift idea: a teapot shaped like a cat', { tags: ['gifts'], created: -1 }),
    todo('Find a recipe for pumpkin soup', { created: 0 }),
  ]);

  put('Standalone.md', [
    todo('Pay the electricity bill', { tags: ['money'], created: -6, deadline: 0 }),
    todo('Call the vet about the cat\'s checkup', { tags: ['phone'], reminder: '11:30', created: -3, when: 0 }),
    todo('Weekly review', { tags: ['routine'], repeat: 'every week', created: -60, when: 0,
      notes: ['Empty the Inbox, look at Someday, plan the week in Upcoming.'] }),
    todo('Water the plants', { evening: true, repeat: 'every 3 days when done', created: -30, when: 0 }),
    todo('Read for half an hour', { tags: ['reading'], evening: true, created: -1, when: 0 }),
    todo('Return the library books', { tags: ['errand'], created: -10, deadline: 2 }),
    todo('Renew the bike insurance', { tags: ['money'], created: -12, when: 9 }),
    todo('Learn to juggle', { someday: true, created: -90 }),
    todo('Try a pottery class', { someday: true, created: -75 }),
    todo('Build a birdhouse', { someday: true, created: -50 }),
    todo('See the northern lights', { tags: ['travel'], someday: true, created: -40 }),
    todo('Back up the photos', { tags: ['computer'], created: -6, done: -1 }),
    todo('Book the car service', { tags: ['phone'], created: -4, done: -1 }),
    todo('Send the birthday card', { created: -7, done: -3 }),
    todo('Clean out the fridge', { created: -6, done: -4 }),
    todo('Cancel the old phone plan', { tags: ['phone'], created: -12, done: -5 }),
  ]);

  put('Trash.md', []);

  put('Areas/Home/Home.md', [
    front({ id: 'ahome001', type: 'area' }),
    'The flat, the cat, and everything that squeaks.',
    '',
    todo('Replace the smoke alarm batteries', { created: -4, when: 5 }),
    todo('Fix the squeaky bedroom door', { created: -15 }),
    todo('Hang the new mirror in the hall', { created: -9, done: -3 }),
  ]);

  put('Areas/Home/Plan the garden.md', [
    front({ id: 'pgarden1', type: 'project', status: 'open', deadline: d(40), tags: ['garden'], created: d(-14) }),
    'Raised beds along the fence, herbs by the kitchen door, and somewhere to sit when it\'s all done.',
    '',
    '## Plan',
    todo('Measure the beds', { created: -14, done: -6 }),
    todo('Sketch where everything goes', { created: -14, when: 0,
      notes: ['The sunny side is for the tomatoes. Keep the path wide enough for the wheelbarrow.'],
      checklist: [['Tomatoes along the fence', true], ['Herbs by the kitchen door', true], ['A bench in the corner', false]] }),
    '',
    '## Buy',
    todo('Get seeds: tomatoes, basil and sunflowers', { tags: ['errand'], created: -10, when: 1 }),
    todo('Order two raised beds', { created: -10, when: 2, deadline: 6 }),
    todo('Ask at the garden centre about compost', { tags: ['errand'], created: -10 }),
    '',
    '## Plant',
    todo('Sow the tomatoes indoors', { created: -10, when: 8 }),
    todo('Plant out the herbs', { created: -10 }),
    todo('Put up a bird feeder', { created: -10 }),
  ]);

  put('Areas/Work/Work.md', [
    front({ id: 'awork001', type: 'area', tags: ['work'] }),
    'Everything with a deadline somebody else picked.',
    '',
    todo('Answer the conference invitation', { created: -5, when: 0, deadline: 6 }),
  ]);

  put('Areas/Work/Launch the new website.md', [
    front({ id: 'pwebsite', type: 'project', status: 'open', deadline: d(12), created: d(-20) }),
    'Same pages, easier to read, and quicker on a phone.',
    '',
    '## Words',
    todo('Choose a new font', { created: -20, done: -4 }),
    todo('Write the new About page', { reminder: '10:00', created: -6, when: 0, notes: [
      'Short and friendly. Who we are, what we do, how to reach us.',
      '',
      '- **Tone:** plain words, no jargon',
      '- One photo of the whole team',
      '- The [old page](https://example.com/about) is there for reference',
    ] }),
    todo('Proofread the FAQ', { created: -6, when: 1 }),
    '',
    '## Launch',
    todo('Test the contact form', { tags: ['computer'], created: -6, when: 3 }),
    todo('Resize the photos for the gallery', { tags: ['computer'], created: -6 }),
    todo('Send the launch email', { created: -6, when: 11, deadline: 12 }),
  ]);

  put('Areas/Work/Team picnic.md', [
    front({ id: 'ppicnic1', type: 'project', status: 'open', created: d(-7) }),
    'In the park by the river, at the end of the month. Everyone brings one dish.',
    '',
    todo('Book the big table by the pond', { tags: ['phone'], created: -7, when: 4 }),
    todo('Make a sign-up sheet for the food', { created: -7, when: 1 }),
    todo('Buy a frisbee', { tags: ['errand'], created: -7 }),
    todo('Check the weather forecast', { created: -7, when: 10 }),
  ]);

  put('Projects/Learn the ukulele.md', [
    front({ id: 'pukulele', type: 'project', status: 'open', created: d(-30) }),
    'Four strings, a handful of chords, and a lot of patience from the neighbours.',
    '',
    todo('Practise for 15 minutes', { reminder: '19:00', repeat: 'every day', created: -30, when: 0 }),
    '',
    '## Chords',
    todo('Learn C, A minor and F', { created: -30, done: -10 }),
    todo('Learn G and E minor', { created: -10, checklist: [['G', true], ['E minor', false], ['Switch between them without looking', false]] }),
    '',
    '## Songs',
    todo('Play Happy Birthday without stopping', { created: -10, when: 3 }),
    todo('Find a beginner songbook', { tags: ['reading'], created: -10 }),
  ]);

  put('Projects/Weekend by the lake.md', [
    front({ id: 'plakewkd', type: 'project', status: 'open', deadline: d(19), tags: ['travel'], created: d(-12) }),
    'Two nights in a cabin. The train there, and bikes once we arrive.',
    '',
    '## Before we go',
    todo('Pick the dates', { created: -12, done: -5 }),
    todo('Book the train tickets', { created: -5, when: 0, deadline: 3 }),
    todo('Find a cabin with a wood stove', { created: -5, when: 2 }),
    todo('Ask the neighbours to feed the cat', { created: -5, when: 16 }),
    '',
    '## Packing',
    todo('Pack the bags', { created: -5, when: 18, notes: ['One bag each. The bikes go in the luggage car.'],
      checklist: [['Rain jackets', false], ['Swimsuits', false], ['Chargers', false], ['Books for the train', false], ['Marshmallows', false]] }),
    todo('Download the offline maps', { tags: ['computer'], created: -5, when: 17 }),
  ]);

  put('Projects/Bake a proper sourdough.md', [
    front({ id: 'psourdgh', type: 'project', status: 'open', someday: 'true', created: d(-40) }),
    'One loaf a week until one comes out right.',
    '',
    todo('Make a starter', { created: -40 }),
    todo('Buy a proving basket', { created: -40 }),
    todo('Bake a first loaf', { created: -40 }),
  ]);

  put('Projects/Repaint the bathroom.md', [
    front({ id: 'pbathrm1', type: 'project', status: 'done', created: d(-26), completed: d(-6) }),
    'White ceiling, pale green walls.',
    '',
    todo('Choose the colour', { created: -26, done: -9 }),
    todo('Buy the paint and the rollers', { created: -26, done: -8 }),
    todo('Paint the ceiling first', { created: -26, done: -7 }),
    todo('Paint the walls', { created: -26, done: -6 }),
  ]);

  files[TUTORIAL_PATH] = tutorialText(d(0));

  // Today in an order that reads like a day; everything else as the files have it.
  const todayOrder = [
    'Write the new About page', 'Call the vet about the cat\'s checkup', 'Answer the conference invitation',
    'Pay the electricity bill', 'Book the train tickets', 'Sketch where everything goes',
    'Practise for 15 minutes', 'Weekly review', 'Water the plants', 'Read for half an hour',
  ].map((t) => ids[t]);
  files['.dvarim/state.json'] = JSON.stringify({ todayOrder, areaOrder: ['ahome001', 'awork001'] }, null, 1) + '\n';

  return files;
}
