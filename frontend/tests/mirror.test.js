// The mirror's two decisions (lib/backend.js): which requests only the server
// can answer, and whose copy a person's is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_ONLY, personKey } from '../src/lib/backend.js';

test('what only the server answers, and what the copy here does', () => {
  for (const p of ['/auth', '/login', '/logout', '/password', '/people', '/people/invites', '/tokens/Phone', '/requests',
    '/join/abc', '/export', '/calendar?from_=2026-10-17&to=2026-10-17', '/calendars', '/reminders/log', '/tasksync', '/health']) {
    assert.ok(SERVER_ONLY.test(p), p);
  }
  for (const p of ['/state', '/lists/today', '/todos', '/todos/abc/complete', '/projects/p1', '/settings', '/today/headings',
    '/tutorial', '/search?q=x', '/quick-add', '/reorder', '/file?path=Inbox.md', '/parse-repeat', '/authors', '/joined']) {
    assert.ok(!SERVER_ONLY.test(p), p);
  }
});

test('whose copy: the owner\'s has no name; anyone else\'s is their account\'s id, not their name', () => {
  assert.equal(personKey({ name: 'Sam', owner: true }), '');
  assert.equal(personKey(null), '');
  assert.equal(personKey({ name: 'Dana', owner: false, uid: 'Xy_12abCD-90' }), 'xy_12abcd-90');
  assert.equal(personKey({ name: ' Dana L ', owner: false }), 'dana l', 'a server without ids yet: the name');
});
