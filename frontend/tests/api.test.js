// What api.js makes of each kind of answer, which is what decides whether an
// edit is kept for later or refused. fetch is stubbed; there is no IndexedDB
// here, so nothing can be kept and a queued write rethrows what it would have
// kept — which is exactly what these look at.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/lib/api.js';

let reach = [];
api.setReachabilityHandler((ok) => reach.push(ok));
beforeEach(() => { reach = []; });

const answer = (status, body = '{}') => { globalThis.fetch = async () => new Response(body, { status }); };
const statusOf = (p) => p.then(() => 'answered', (e) => e.status);

test('no network at all is unreachable', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await statusOf(api.patchTodo('t1', { title: 'x' })), 0);
  // a read with no copy to fall back on is what reports it; a write reports
  // it once it has been kept, and here there is nowhere to keep it
  assert.equal(await statusOf(api.getState()), 0);
  assert.deepEqual(reach, [false]);
});

for (const code of [502, 503, 504]) {
  test(`a ${code} from the tunnel is unreachable too, not the server saying no`, async () => {
    answer(code, 'error code: ' + code);
    assert.equal(await statusOf(api.patchTodo('t1', { title: 'x' })), 0);
    assert.equal(await statusOf(api.getState()), 0);
    assert.ok(!reach.includes(true), 'it never counts as the server answering');
  });
}

test('a real refusal is the server speaking, and goes through as it is', async () => {
  answer(404, JSON.stringify({ error: 'not found: t1' }));
  await assert.rejects(api.patchTodo('t1', { title: 'x' }), (e) => e.status === 404 && e.message === 'not found: t1');
  assert.deepEqual(reach, [true]);
});

test('an answer is an answer', async () => {
  answer(200, JSON.stringify({ id: 't1', title: 'x' }));
  assert.deepEqual(await api.patchTodo('t1', { title: 'x' }), { id: 't1', title: 'x' });
  assert.deepEqual(reach, [true]);
});
