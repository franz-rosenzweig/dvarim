// What the Python server answered (tools/parity/oracle.py, at the tag
// python-final: backend/ has left the tree), kept in test/golden/: one file
// per batch of questions, named by their hash. The parity suites hold the
// engine and the server to it, as long as they ask what they asked when the
// answers were recorded, which is how they run by default. With other seeds
// or sizes they skip, unless the Python is at hand (engine/README.md):
//
//   DVARIM_ORACLE=…/oracle.py   a checkout of python-final's oracle, to ask live
//   DVARIM_GOLDEN=record        ask it, and keep its answers (the suite's old ones go)
//   DVARIM_GOLDEN=replay        use the recorded answers even where it is
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..', '..');
const ORACLE = process.env.DVARIM_ORACLE || join(REPO, 'tools', 'parity', 'oracle.py');
const GOLDEN = join(here, 'golden');
// what changes the questions a suite asks
const SIZES = ['DVARIM_SEED', 'DVARIM_FUZZ', 'DVARIM_SESSIONS', 'DVARIM_STEPS', 'DVARIM_PARITY_VAULT'];

/** A Python for the oracle: the one named, or any python3 on the PATH. */
function python() {
  const candidates = [process.env.DVARIM_PYTHON, ...(process.env.PATH || '').split(':').map((d) => join(d, 'python3'))].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

/** The Python itself is here: for what only a live answer can check. */
export const pythonHere = () => !!python() && existsSync(ORACLE) && process.env.DVARIM_GOLDEN !== 'replay';

/** Answers can be had: from the Python, or recorded, for the suites as they run by default. */
export const available = () => pythonHere() || (existsSync(GOLDEN) && SIZES.every((k) => !process.env[k]));

/** Which suite is asking: the test file on the stack. */
function suite() {
  const m = /\/(engine|server)\/test\/([\w.-]+)\.test\.js/u.exec(new Error().stack || '');
  return m ? `${m[1]}-${m[2]}` : 'unknown';
}

const cleared = new Set();

/** Send every request, get every answer, in order. */
export async function askAll(requests) {
  const key = createHash('sha1').update(JSON.stringify(requests)).digest('hex').slice(0, 20);
  const dir = join(GOLDEN, suite());
  const file = join(dir, `${key}.json.gz`);
  if (pythonHere()) {
    const answers = await askPython(requests);
    if (process.env.DVARIM_GOLDEN === 'record') {
      if (!cleared.has(dir)) { rmSync(dir, { recursive: true, force: true }); cleared.add(dir); }
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, gzipSync(JSON.stringify(answers), { level: 9 }));
    }
    return answers;
  }
  if (!existsSync(file)) {
    const kept = existsSync(dir) ? readdirSync(dir).length : 0;
    throw new Error(`no recorded Python answers for these ${requests.length} questions (${suite()}/${key}; ${kept} recorded for this suite). `
      + 'The questions changed since they were recorded: record them again where the Python runs, with DVARIM_GOLDEN=record.');
  }
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
}

function askPython(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(python(), [ORACLE], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const answers = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        answers.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    });
    child.on('error', reject);
    child.on('close', () => {
      if (answers.length !== requests.length) reject(new Error(`oracle answered ${answers.length} of ${requests.length}`));
      else resolve(answers);
    });
    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
    child.stdin.end();
  });
}
