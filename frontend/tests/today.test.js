import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crowdedProjects } from '../src/lib/today.js';

test('Today names the projects with more than one open to-do in it, and lets Agenda & Admin be', () => {
  const t = (projectId, projectName, status = 'open') => ({ projectId, projectName, status });
  const items = [
    t('p1', 'The Encrypted Bookshelf'), t('p2', 'Project Gamepad'), t('p1', 'The Encrypted Bookshelf'),
    t('p3', 'Agenda & Admin'), t('p3', 'Agenda & Admin'), t('p3', 'Agenda & Admin'),
    t('p2', 'Project Gamepad', 'done'),                       // done today: no longer a next step
    { projectId: null, areaId: 'a1', status: 'open' }, { projectId: null, status: 'open' },
    t('p4', 'Admin day'), t('p4', 'Admin day'),
  ];
  assert.deepEqual(crowdedProjects(items), [{ id: 'p1', name: 'The Encrypted Bookshelf', count: 2 }]);
  assert.deepEqual(crowdedProjects([]), []);
  assert.deepEqual(crowdedProjects(undefined), []);
});
