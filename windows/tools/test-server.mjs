// A Dvarim server for windows/selftest.ps1: the real one (server/src/main.js) on a
// scratch folder, its password set from DVARIM_SELFTEST_PASSWORD so the self-test
// can sign in on its page as a person would, and listening on this PC only. The
// Windows app's copy mode is checked against it: the sign-in, the token, the sync
// both ways, signing out.
//
//   $env:DVARIM_ROOT = '…'; $env:PORT = '8421'; $env:DVARIM_SELFTEST_PASSWORD = '…'
//   node windows/tools/test-server.mjs
//
// (main.js starts itself only when its own path is the one node was given as a
// file:// URL, which a Windows path never is; so this imports it and starts it.)
import { Auth } from '../../server/src/auth.js';
import { start } from '../../server/src/main.js';

const root = process.env.DVARIM_ROOT;
const password = process.env.DVARIM_SELFTEST_PASSWORD;
if (!root || !password) {
  console.error('test-server: set DVARIM_ROOT and DVARIM_SELFTEST_PASSWORD');
  process.exit(2);
}
const auth = Auth.load(root, process.env.DVARIM_AUTH_FILE || undefined);
auth.setPassword(password);
auth.rotateSecret();
await start({ ...process.env, HOST: process.env.HOST || '127.0.0.1' });
