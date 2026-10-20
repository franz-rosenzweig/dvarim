#!/usr/bin/env node
// The Dvarim server: `node server/src/main.js`. Configured by the same
// environment as the Python server it replaces (docs/DEPLOY.md), so the
// container's settings carry over unchanged:
//
//   DVARIM_ROOT          the data folder                       (default ./data)
//   DVARIM_STATIC        the built app                         (default ./frontend/dist)
//   DVARIM_AUTH_FILE     password and session secret           (default <root>/.dvarim/auth.json)
//   DVARIM_PEOPLE        other people's folders (docs/PEOPLE.md) (default <auth file's folder>/people)
//   DVARIM_WATCH         0 to not watch the folder             (default on)
//   DVARIM_MERGE_ARRIVALS  1 if the folder's sync keeps only the newer file of two, no conflict copies (docs/SYNC.md)
//   DVARIM_CALDAV_URL, _USER, _PASS    calendars and the to-do mirror
//   DVARIM_TASKSYNC      1 to mirror to-dos to CalDAV; _EVERY seconds, _SOMEDAY 1 to include Someday
//   DVARIM_SIGNAL_URL / _CLI, _FROM, _TO               reminders over Signal
//   DVARIM_OBSIDIAN_VAULT, _PREFIX                     "Open in Obsidian" links
//   DVARIM_ANDROID_PACKAGE, _FINGERPRINT               Android's asset links (each may list several, comma-separated)
//   PORT, HOST           where to listen                       (default 8420, 0.0.0.0)
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { Watcher } from './watcher.js';
import { Reminders, makeSender } from './notify.js';
import { calendarServices } from './caldav.js';
import { TaskSync, SyncLoop } from './tasksync.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

export async function start(env = process.env) {
  const root = resolve(env.DVARIM_ROOT || resolve(repo, 'data'));
  const staticDir = resolve(env.DVARIM_STATIC || resolve(repo, 'frontend', 'dist'));
  const services = {};
  const cal = calendarServices(env);
  Object.assign(services, cal.services);
  // Reminders, and word of someone asking for an account, over Signal when it is set up
  const sender = makeSender(env);
  const app = await createApp({
    root, staticDir, authFile: env.DVARIM_AUTH_FILE || undefined, peopleRoot: env.DVARIM_PEOPLE || undefined, services,
    onRequest: sender ? (r) => sender(`🙋 ${r.name} (${r.email}) asked for a Dvarim account${r.message ? `: “${r.message}”` : ''}. Settings → Account → People.`) : null,
    mergeArrivals: env.DVARIM_MERGE_ARRIVALS === '1',
    obsidian: env.DVARIM_OBSIDIAN_VAULT ? { vault: env.DVARIM_OBSIDIAN_VAULT, prefix: env.DVARIM_OBSIDIAN_PREFIX || '' } : null,
    android: {
      package: env.DVARIM_ANDROID_PACKAGE || '',
      fingerprints: (env.DVARIM_ANDROID_FINGERPRINT || '').split(',').map((f) => f.trim().toUpperCase()).filter(Boolean),
    },
  });

  const reminders = new Reminders(app.store, sender);
  services.reminders = () => ({ configured: sender !== null, log: reminders.log.slice(-50) });

  let watcher = null;
  if ((env.DVARIM_WATCH ?? '1') !== '0') watcher = new Watcher(app.store, root, { reminders }).start();

  let loop = null;
  // what api.py said with the mirror off
  services.tasksync = { enabled: false, run: null,
    status: () => ({ enabled: false, configured: !!cal.client, reason: 'set DVARIM_TASKSYNC=1 with CalDAV configured' }) };
  if (env.DVARIM_TASKSYNC === '1' && cal.client) {
    const sync = new TaskSync(app.store, cal.client, { includeSomeday: env.DVARIM_TASKSYNC_SOMEDAY === '1' });
    services.tasksync = { enabled: true, status: () => sync.status(), run: () => sync.sync() };
    loop = new SyncLoop(sync, Number(env.DVARIM_TASKSYNC_EVERY || 300)).start();
  }

  const port = Number(env.PORT || 8420), host = env.HOST || '0.0.0.0';
  const where = await app.listen(port, host);
  console.error(`dvarim: serving ${root} on http://${where.address}:${where.port}` +
    `${app.auth.enabled ? '' : ' — NO PASSWORD SET'}${cal.client ? ', calendars on' : ''}${loop ? ', to-do mirror on' : ''}`);

  const stop = async () => {
    if (loop) loop.close();
    if (watcher) watcher.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return { app, watcher, reminders, loop };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    console.error('dvarim: could not start:', e);
    process.exit(1);
  });
}
