#!/usr/bin/env node
// Setting the password and minting bot tokens (backend/dvarim/cli.py, ported).
//
//   node server/src/cli.js set-password
//   node server/src/cli.js add-token signal-bot
//   node server/src/cli.js list-tokens
//   node server/src/cli.js remove-token signal-bot
//   node server/src/cli.js clear-password
//   node server/src/cli.js logout-everywhere
//
// In the container: docker exec -it dvarim node server/src/cli.js set-password
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Auth } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));

/** A line from the terminal, not echoed. */
function secret(prompt) {
  return new Promise((ok) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(prompt); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); ok(answer); });
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let root = env.DVARIM_ROOT || resolve(here, '..', '..', 'data');
  const args = [...argv];
  const at = args.indexOf('--root');
  if (at >= 0) { root = args[at + 1]; args.splice(at, 2); }
  const [cmd, name] = args;
  const auth = Auth.load(root, env.DVARIM_AUTH_FILE || undefined);
  const out = (s) => process.stdout.write(s + '\n');

  switch (cmd) {
    case 'set-password': {
      const pw = await secret('New password: ');
      if (pw !== await secret('Again: ')) { console.error('they do not match'); return 1; }
      try { auth.setPassword(pw); } catch (e) { console.error(e.message); return 1; }
      out(`password set in ${auth.path}`);
      out('everyone is logged out; sign in again in the browser');
      auth.rotateSecret();
      return 0;
    }
    case 'clear-password':
      auth.clearPassword();
      out('password removed — the app is now open to anyone who can reach it');
      return 0;
    case 'add-token': {
      if (!name) { console.error('add-token NAME'); return 1; }
      const token = auth.addToken(name);
      out(`token for ${name}:\n\n  ${token}\n`);
      out('This is the only time it is shown. Use it as:');
      out('  Authorization: Bearer <token>');
      return 0;
    }
    case 'remove-token':
      out(auth.removeToken(name) ? 'removed' : 'no such token');
      return 0;
    case 'list-tokens': {
      const names = auth.tokenNames();
      out(names.length ? names.join('\n') : '(none)');
      return 0;
    }
    case 'logout-everywhere':
      auth.rotateSecret();
      out('every session cookie is now invalid');
      return 0;
    default:
      console.error('usage: cli.js [--root DIR] set-password | clear-password | add-token NAME | remove-token NAME | list-tokens | logout-everywhere');
      return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((code) => process.exit(code));
