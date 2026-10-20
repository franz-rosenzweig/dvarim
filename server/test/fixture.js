// A server on a scratch folder, over real HTTP, for the suites here.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { Auth } from '../src/auth.js';

export function fixture({ password = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dv-server-'));
  const staticDir = mkdtempSync(join(tmpdir(), 'dv-static-'));
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Dvarim</title>');
  writeFileSync(join(staticDir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(staticDir, 'sw.js'), '// sw');
  const authFile = join(mkdtempSync(join(tmpdir(), 'dv-secrets-')), 'auth.json');
  if (password) {
    const a = Auth.load(root, authFile);
    a.setPassword(password);
  }
  return { root, staticDir, authFile };
}

export async function serve(opts = {}, cfg = {}, t = null) {
  const f = fixture(opts);
  // the suites start from an empty folder, as they always have; people.test.js
  // asks for the tutorial a new server's folder starts with
  const app = await createApp({ root: f.root, staticDir: f.staticDir, authFile: f.authFile, log: () => {}, tutorial: false, ...cfg });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { body, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await app.close(); rmSync(f.root, { recursive: true, force: true }); };
  if (t) t.after(close);                     // closed whatever happens, so a failure fails instead of hanging
  return { ...f, app, base, call, close };
}
