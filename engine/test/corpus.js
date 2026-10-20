// Markdown to hold the engine to: the sample vault, hand-made edge cases, and a
// seeded fuzzer that builds files out of every construct the format has, in
// combinations nobody would write on purpose. Seeded, so a failure reproduces.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO } from './oracle.js';

/** Every .md file under `root`, as { path, text }. */
export function vaultFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md')) out.push({ path: relative(root, p).split('\\').join('/'), text: readFileSync(p, 'utf8') });
    }
  };
  walk(root);
  return out;
}

export const sampleVault = () => vaultFiles(join(REPO, 'sample-vault'));

export const EDGE = [
  '',
  '\n',
  '- [ ] Just one 🆔 aa11bb22\n',
  '- [ ]\n',
  '- [ ] \n- [x]\n',
  '---\n---\n',
  '---\nid: p1\ntype: project\nstatus: open\ntags: [a, b]\n---\nNotes\n\n- [ ] T 🆔 aa11bb22\n',
  '---\nJust prose after a rule\n---\nMore\n',
  '---\r\nid: p1\r\ntype: project\r\n---\r\n- [ ] CRLF line 🆔 aa11bb22\r\n    notes line\r\n',
  '---\ntags:\n  - x\n  - "[[Link]]"\n  - \ndue:\ncreated: 2026-05-13T15:21\n# comment\npriority: false\nreminder: 18:30\n---\n',
  '## Heading only\n',
  '## Archived ✅ 2026-09-01\n- [x] Done 🆔 aa11bb22 ✅ 2026-09-01\n',
  '### Not a heading\n- [ ] Under it 🆔 aa11bb22\n',
  '- [ ] Tagged #work #a/b #256 #-x mid#word 🆔 aa11bb22\n',
  '- [ ] Every marker 🌙 💤 ⏰ 9:05 🆔 aa11bb22 🔁 every week when done ➕ 2026-09-01 ⏳ 2026-09-22 📅 2026-10-01\n',
  '- [x] Done then canceled ❌ 2026-09-02 🆔 aa11bb22\n',
  '- [ ] Open but dated done ✅ 2026-09-02 🆔 aa11bb22\n',
  '- [-] In trash 🆔 aa11bb22 🗑️ 2026-09-03 ↩ Projects/P.md#Some heading\n',
  '- [ ] With notes 🆔 aa11bb22\n    First\n\n    Second after a blank\n    \\- [ ] escaped task\n    - [ ] checklist\n    - [x] done item\n        - [ ] nested stays notes\n',
  '- [ ] Tab notes 🆔 aa11bb22\n\tTabbed note\n\t- [ ] tab checklist\n',
  'Notes first\n\\## Escaped heading\n\\\\- [ ] two backslashes\n\n- [ ] Real 🆔 aa11bb22\n',
  'Trailing text after\n- [ ] A 🆔 aa11bb22\nnot indented, so trailing\n\n## H\nmore trailing\n',
  '- [ ] Hebrew שלום עולם #עברית 🆔 aa11bb22\n',
  '- [ ] Emoji title 🎉 party 🆔 aa11bb22\n',
  '* [X] Star bullet capital X 🆔 aa11bb22\n+ [ ] Plus bullet 🆔 bb22cc33\n',
  '- [ ] No id at all\n- [ ] 🆔 idonly01\n',
  '- [ ] Repeat with a tag after 🔁 every 2 weeks on Monday, Thursday #x 🆔 aa11bb22\n',
];

// ---- the fuzzer ------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['Call', 'Dana', 'about', 'the', 'draft', 'שלום', 'לכולם', 'café', '🎉', 'x', '**bold**',
  '==mark==', '`code`', 'mid#word', 'a:b', '#', '##', '[[Link]]', 'http://x.org', '\\', '-', '[ ]'];
const DATES = ['2026-09-22', '2026-10-01', '2027-02-28', '2026-13-40'];

export function fuzzFiles(count, seed = 1) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const chance = (p) => r() < p;
  const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const id = () => Array.from({ length: 8 }, () => pick('0123456789abcdefghijklmnopqrstuvwxyz'.split(''))).join('');
  const task = (indent = '') => {
    const parts = [words(1 + Math.floor(r() * 4))];
    if (chance(0.3)) parts.push('#' + pick(['work', 'a/b', '256', 'x_y', 'שלום']));
    if (chance(0.15)) parts.push('🌙');
    if (chance(0.1)) parts.push('💤');
    if (chance(0.15)) parts.push('⏰ ' + pick(['9:05', '18:30', '7:5']));
    if (chance(0.8)) parts.push('🆔 ' + id());
    if (chance(0.15)) parts.push('🔁 ' + pick(['every week', 'every 2 days when done', 'every month on the 1st']));
    if (chance(0.3)) parts.push('➕ ' + pick(DATES));
    if (chance(0.3)) parts.push('⏳ ' + pick(DATES));
    if (chance(0.2)) parts.push('📅 ' + pick(DATES));
    if (chance(0.15)) parts.push('✅ ' + pick(DATES));
    if (chance(0.05)) parts.push('❌ ' + pick(DATES));
    if (chance(0.05)) parts.push('🗑️ ' + pick(DATES));
    if (chance(0.05)) parts.push('↩ Projects/P.md#H');
    // shuffle the markers a little: order is not guaranteed in hand-written files
    for (let i = parts.length - 1; i > 1; i--) if (chance(0.3)) [parts[i], parts[i - 1]] = [parts[i - 1], parts[i]];
    return `${indent}${pick(['-', '-', '-', '*', '+'])} [${pick([' ', ' ', 'x', 'X', '-'])}] ${parts.join(' ')}`;
  };
  const fmBlock = () => pick([
    '---\nid: p1\ntype: project\nstatus: open\n---\n',
    '---\ntags:\n  - a\n  - "[[L]]"\n  - \ndue:\n---\n',
    '---\ntags: [x, "y, z"]\nwhen: 2026-09-22\nsomeday: true\n# c\n---\n',
    '---\nprose that is not yaml\n---\n',
    '---\n---\n',
    '---\ntype: area\nid: a1\nlist:\n- flush\n- items\ntext: |\n  block\n  scalar\n---\n',
  ]);
  const files = [];
  for (let f = 0; f < count; f++) {
    const lines = [];
    const n = 1 + Math.floor(r() * 14);
    for (let i = 0; i < n; i++) {
      const k = r();
      if (k < 0.35) lines.push(task());
      else if (k < 0.5) lines.push(pick(['    ', '\t', '  ', '      ']) + pick([words(3), task('').slice(0), '\\- [ ] esc', '']));
      else if (k < 0.6) lines.push(pick(['## ', '## ', '### ', '#']) + words(2) + (chance(0.2) ? ' ✅ ' + pick(DATES) : ''));
      else if (k < 0.72) lines.push(words(3));
      else if (k < 0.8) lines.push('');
      else if (k < 0.86) lines.push(pick(['- [ ]', '- [ ] ', '- [x]']));
      else if (k < 0.92) lines.push('\\' + pick(['## x', '- [ ] y', '\\- [ ] z', 'plain']));
      else lines.push(task() + (chance(0.5) ? '\r' : ''));
    }
    let text = lines.join('\n') + (chance(0.8) ? '\n' : '');
    if (chance(0.4)) text = fmBlock() + text;
    files.push({ path: pick(['Inbox.md', 'Projects/P.md', 'Areas/Work/Work.md', 'Areas/Work/Proj.md', 'Trash.md']), text });
  }
  return files;
}
