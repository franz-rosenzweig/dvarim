// The outbox's pure half: what a kept operation looks like laid over a kept
// copy of a list, what view is made for something made offline, and which API
// call an operation stands for. The phone checks in tools/phone/ drive the same
// code through a real WebView with the server gone; these pin down the rules
// themselves, and run in a second with `npm test` and nothing installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlay, synthesize, send, describe, newId } from '../src/lib/outbox.js';

const TODAY = '2026-09-22';
const todo = (id, extra = {}) => ({ id, title: `To-do ${id}`, status: 'open', tags: [], checklist: [], ...extra });
const today = () => ({ items: [todo('t1'), todo('t2'), todo('t3')] });

test('the kept copy is left as it was', () => {
  const data = today();
  const frozen = JSON.stringify(data);
  overlay('/lists/today', data, [{ kind: 'complete', id: 't1' }, { kind: 'delete', id: 't2' }], TODAY);
  assert.equal(JSON.stringify(data), frozen);
});

test('no operations means the copy itself', () => {
  const data = today();
  assert.equal(overlay('/lists/today', data, [], TODAY), data);
});

test('a patch changes the fields it names, wherever the row is', () => {
  const upcoming = { days: [{ date: '2026-09-23', items: [todo('t1')] }, { date: '2026-09-24', items: [todo('t2')] }] };
  const out = overlay('/lists/upcoming', upcoming, [{ kind: 'patch', id: 't2', patch: { title: 'Renamed', deadline: '2026-10-01' } }], TODAY);
  assert.equal(out.days[1].items[0].title, 'Renamed');
  assert.equal(out.days[1].items[0].deadline, '2026-10-01');
  assert.equal(out.days[0].items[0].title, 'To-do t1');
});

test('completing, canceling and reopening change the status, dated today', () => {
  const out = overlay('/lists/today', today(), [
    { kind: 'complete', id: 't1' }, { kind: 'cancel', id: 't2' },
    { kind: 'complete', id: 't3' }, { kind: 'reopen', id: 't3' },
  ], TODAY);
  assert.deepEqual(out.items.map((t) => [t.status, t.completed]), [['done', TODAY], ['canceled', TODAY], ['open', null]]);
});

test('a row stays where it is: a new date does not re-file it', () => {
  const out = overlay('/lists/today', today(), [{ kind: 'patch', id: 't1', patch: { when: '2026-10-05' } }], TODAY);
  assert.deepEqual(out.items.map((t) => t.id), ['t1', 't2', 't3']);
  assert.equal(out.items[0].when, '2026-10-05');
});

test('a deleted to-do leaves the list', () => {
  const out = overlay('/lists/today', today(), [{ kind: 'delete', id: 't2' }], TODAY);
  assert.deepEqual(out.items.map((t) => t.id), ['t1', 't3']);
});

test('a to-do made offline shows in the list it was made in, and only there', () => {
  const op = { kind: 'create', id: 'new00001', list: '/lists/inbox', body: { title: 'Made on the plane', inbox: true } };
  const inbox = overlay('/lists/inbox', { items: [todo('i1')] }, [op], TODAY);
  assert.deepEqual(inbox.items.map((t) => t.id), ['i1', 'new00001']);
  assert.equal(inbox.items[1].title, 'Made on the plane');
  assert.equal(inbox.items[1].created, TODAY);
  assert.deepEqual(overlay('/lists/today', today(), [op], TODAY).items.map((t) => t.id), ['t1', 't2', 't3']);
});

test('a line added offline shows as typed until the server has parsed it', () => {
  const op = { kind: 'quick-add', id: 'qa000001', text: 'Call the plumber tomorrow #home', target: 'today', list: '/lists/today' };
  const out = overlay('/lists/today', today(), [op], TODAY);
  const row = out.items.at(-1);
  assert.equal(row.title, 'Call the plumber tomorrow #home');
  assert.equal(row.when, TODAY);
  assert.equal(row.inbox, false);
});

test('a reorder applies to its own list; anything it does not name goes last', () => {
  const op = { kind: 'reorder', context: 'today', ids: ['t3', 't1'], list: '/lists/today' };
  assert.deepEqual(overlay('/lists/today', today(), [op], TODAY).items.map((t) => t.id), ['t3', 't1', 't2']);
  assert.deepEqual(overlay('/lists/inbox', today(), [op], TODAY).items.map((t) => t.id), ['t1', 't2', 't3']);
});

test('Today\'s own headings made, filed into, renamed, reordered and deleted offline show in Today only', () => {
  const ops = [
    { kind: 'today-heading-create', id: 'herrand1', name: 'Errands', position: null },
    { kind: 'today-heading-create', id: 'hmorni01', name: 'Morning', position: 'top' },
    { kind: 'today-heading-create', id: 'hbetwe01', name: 'Between', position: { after: 'hmorni01' } },
    { kind: 'today-file', ids: ['t2', 't3'], headingId: 'herrand1' },
    { kind: 'today-file', ids: ['t3'], headingId: 'hmorni01' },
    { kind: 'today-heading-patch', id: 'herrand1', patch: { name: 'Out' }, name: 'Out' },
    { kind: 'today-heading-delete', id: 'hbetwe01', name: 'Between' },
    { kind: 'reorder', context: 'today-headings', ids: ['herrand1', 'hmorni01'], list: '/lists/today' },
  ];
  const out = overlay('/lists/today', today(), ops, TODAY);
  assert.deepEqual(out.headings, [{ id: 'herrand1', name: 'Out', todos: ['t2'] }, { id: 'hmorni01', name: 'Morning', todos: ['t3'] }]);
  assert.deepEqual(out.items.map((t) => t.id), ['t1', 't2', 't3'], 'reordering headings leaves the to-dos alone');
  assert.equal(overlay('/lists/inbox', today(), ops, TODAY).headings, undefined);
  assert.match(describe(ops[0]), /Errands/u);
});

test('a duplicate goes beside the one it was made from', () => {
  const out = overlay('/lists/today', today(), [{ kind: 'duplicate', id: 't1', copyId: 'copy0001' }], TODAY);
  assert.deepEqual(out.items.map((t) => t.id), ['t1', 'copy0001', 't2', 't3']);
  assert.equal(out.items[1].title, 'To-do t1');
});

test('a to-do converted offline leaves its list and becomes a project in the sidebar', () => {
  const op = { kind: 'convert', id: 't1', projectId: 'pconv001', checklist: ['c0000001'],
               body: { name: 'To-do t1', areaId: 'a0000001' }, items: [] };
  assert.deepEqual(overlay('/lists/today', today(), [op], TODAY).items.map((t) => t.id), ['t2', 't3']);
  const state = { areas: [{ id: 'a0000001', name: 'Home', projects: [] }], looseProjects: [] };
  const sidebar = overlay('/state', state, [op], TODAY);
  assert.equal(sidebar.areas[0].projects[0].id, 'pconv001');
  assert.equal(sidebar.areas[0].projects[0].areaName, 'Home');
});

test('projects and areas made offline are in the sidebar', () => {
  const state = { areas: [{ id: 'a0000001', name: 'Home', projects: [] }], looseProjects: [] };
  const out = overlay('/state', state, [
    { kind: 'area-create', id: 'a0000002', body: { name: 'Work' } },
    { kind: 'project-create', id: 'p0000001', body: { name: 'Paint the hall', areaId: 'a0000001' } },
    { kind: 'project-create', id: 'p0000002', body: { name: 'Loose' } },
  ], TODAY);
  assert.deepEqual(out.areas.map((a) => a.name), ['Home', 'Work']);
  assert.deepEqual(out.areas[0].projects.map((p) => p.name), ['Paint the hall']);
  assert.deepEqual(out.looseProjects.map((p) => p.name), ['Loose']);
});

test('closing or deleting a project takes it out of the sidebar', () => {
  const state = { areas: [{ id: 'a1', projects: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] }], looseProjects: [] };
  const out = overlay('/state', state, [{ kind: 'project-complete', id: 'p1' }, { kind: 'project-delete', id: 'p3' }], TODAY);
  assert.deepEqual(out.areas[0].projects.map((p) => p.id), ['p2']);
});

test('an area deleted offline sends its projects loose, as the server would', () => {
  const state = { areas: [{ id: 'a1', name: 'Gone', projects: [{ id: 'p1', areaId: 'a1', areaName: 'Gone' }] }], looseProjects: [] };
  const out = overlay('/state', state, [{ kind: 'area-delete', id: 'a1' }], TODAY);
  assert.equal(out.areas.length, 0);
  assert.deepEqual(out.looseProjects, [{ id: 'p1', areaId: null, areaName: null }]);
});

test('a heading renamed offline is renamed everywhere the page reads it', () => {
  const view = { project: { id: 'p1', headings: [{ id: 'p1:Old', name: 'Old', archived: null }] },
                 items: [todo('t1', { headingId: 'p1:Old', headingName: 'Old' })] };
  const op = { kind: 'heading-patch', id: 'p1:Old', patch: { name: 'New' } };
  const out = overlay('/projects/p1', view, [op], TODAY);
  assert.deepEqual(out.project.headings[0], { id: 'p1:New', name: 'New', archived: null });
  assert.deepEqual([out.items[0].headingId, out.items[0].headingName], ['p1:New', 'New']);
  // the sidebar's copy too, or the move popover would offer the old name
  const state = { areas: [], looseProjects: [{ id: 'p1', headings: [{ id: 'p1:Old', name: 'Old' }] }] };
  assert.equal(overlay('/state', state, [op], TODAY).looseProjects[0].headings[0].id, 'p1:New');
});

test('a heading made at a to-do takes the rest of that section under it', () => {
  const view = { project: { id: 'p1', headings: [] }, items: [todo('t1'), todo('t2'), todo('t3')] };
  const out = overlay('/projects/p1', view, [{ kind: 'heading-create', projectId: 'p1', name: 'Later', position: { before: 't2' } }], TODAY);
  assert.deepEqual(out.items.map((t) => t.headingId || null), [null, 'p1:Later', 'p1:Later']);
});

test('a setting changed offline is in force', () => {
  const op = { kind: 'settings', patch: { logCompleted: 'daily' } };
  assert.equal(overlay('/settings', { logCompleted: 'immediately' }, [op], TODAY).logCompleted, 'daily');
  assert.equal(overlay('/state', { settings: { logCompleted: 'immediately' } }, [op], TODAY).settings.logCompleted, 'daily');
});

test('emptying the Trash empties the Trash and nothing else', () => {
  const op = { kind: 'empty-trash' };
  assert.deepEqual(overlay('/lists/trash', { items: [todo('x')], projects: [{ id: 'p' }] }, [op], TODAY), { items: [], projects: [] });
  assert.equal(overlay('/lists/today', today(), [op], TODAY).items.length, 3);
});

test('a view for something made offline is made from what it was made of', () => {
  const ops = [
    { kind: 'project-create', id: 'p0000001', body: { name: 'Offline project' } },
    { kind: 'convert', id: 't1', projectId: 'pconv001', body: { name: 'Was a to-do' },
      items: [{ id: 'c0000001', title: 'Measure', status: 'open' }] },
    { kind: 'area-create', id: 'a0000001', body: { name: 'Offline area' } },
  ];
  assert.equal(synthesize('/projects/p0000001', ops, TODAY).project.name, 'Offline project');
  const converted = synthesize('/projects/pconv001', ops, TODAY);
  assert.equal(converted.project.name, 'Was a to-do');
  assert.deepEqual(converted.items.map((t) => t.title), ['Measure']);
  assert.equal(synthesize('/areas/a0000001', ops, TODAY).area.name, 'Offline area');
  assert.equal(synthesize('/projects/nothere1', ops, TODAY), null);
  assert.equal(synthesize('/lists/today', ops, TODAY), null);
});

test('each operation is sent as the call it stands for', async () => {
  const calls = [];
  const api = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); } });
  await send(api, { kind: 'complete', id: 't1', on: '2026-09-17' });
  await send(api, { kind: 'quick-add', text: 'Line', target: 'today', list: '/lists/today' });
  await send(api, { kind: 'convert', id: 't1', projectId: 'p1', checklist: ['c1'] });
  await send(api, { kind: 'create', id: 'n1', body: { title: 'x' } });
  await send(api, { kind: 'today-heading-create', id: 'herrand1', name: 'Errands', position: null });
  await send(api, { kind: 'today-file', ids: ['t1'], headingId: 'herrand1' });
  assert.deepEqual(calls, [
    ['completeTodo', 't1', '2026-09-17'],
    ['quickAdd', 'Line', 'today'],
    ['convertTodo', 't1', { id: 'p1', checklist: ['c1'] }],
    ['createTodo', { title: 'x', id: 'n1' }],
    ['createTodayHeading', 'Errands', null, 'herrand1'],
    ['fileInToday', ['t1'], 'herrand1'],
  ]);
  await assert.rejects(send(api, { kind: 'nonsense' }), /unknown operation/);
});

test('a refused operation is described by name', () => {
  assert.equal(describe({ kind: 'patch', title: 'Buy milk' }), 'editing “Buy milk”');
  assert.equal(describe({ kind: 'project-delete' }), 'deleting a project');
  assert.equal(describe({ kind: 'empty-trash' }), 'emptying the Trash');
});

test('ids are made in the server\'s own shape', () => {
  for (let i = 0; i < 50; i++) {
    assert.match(newId(), /^[0-9a-z]{8}$/);
    assert.match(newId('p'), /^p[0-9a-z]{7}$/);
  }
});
