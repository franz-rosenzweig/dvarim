// The engine's parser and writer against the backend's, on the same text:
// every file must parse to the same structure and write back to the same
// bytes. Runs where the Python does (see oracle.js); DVARIM_PARITY_VAULT names a
// folder of real notes to include — a COPY, and never committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from '../src/mdformat.js';
import { fileToPlain } from '../src/model.js';
import { available, askAll } from './oracle.js';
import { sampleVault, EDGE, fuzzFiles, vaultFiles } from './corpus.js';

const corpus = [
  ...sampleVault(),
  ...EDGE.map((text, i) => ({ path: ['Inbox.md', 'Projects/P.md', 'Areas/W/W.md'][i % 3], text })),
  ...fuzzFiles(Number(process.env.DVARIM_FUZZ || 3000), Number(process.env.DVARIM_SEED || 7)),
];
if (process.env.DVARIM_PARITY_VAULT) corpus.push(...vaultFiles(process.env.DVARIM_PARITY_VAULT));

test(`parse and write agree with the Python on ${corpus.length} files`,
  { skip: !available() && 'no Python backend here' }, async () => {
    const answers = await askAll(corpus.flatMap((f) => [
      { op: 'parse', text: f.text, path: f.path },
      { op: 'roundtrip', text: f.text, path: f.path },
    ]));
    const failures = [];
    corpus.forEach((f, i) => {
      const [p, rt] = [answers[2 * i], answers[2 * i + 1]];
      if (p.error || rt.error) { failures.push({ f, what: 'python raised', detail: p.error || rt.error }); return; }
      let js;
      try { js = parse(f.text, f.path); } catch (e) { failures.push({ f, what: 'engine raised', detail: e.stack }); return; }
      try { assert.deepStrictEqual(fileToPlain(js), p.ok); } catch (e) { failures.push({ f, what: 'parse differs', detail: e.message }); }
      const out = serialize(js);
      if (out !== rt.ok) failures.push({ f, what: 'written differently', detail: `python: ${JSON.stringify(rt.ok)}\nengine: ${JSON.stringify(out)}` });
    });
    if (failures.length) {
      const shown = failures.slice(0, 4).map((x) => `— ${x.what} (${x.f.path})\n${JSON.stringify(x.f.text)}\n${x.detail.slice(0, 1500)}`);
      assert.fail(`${failures.length} of ${corpus.length} files differ:\n\n${shown.join('\n\n')}`);
    }
  });
