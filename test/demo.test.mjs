import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoRecord } from '../src/demo.mjs';
import { dashboardSnapshot } from '../src/dashboard.mjs';

test('synthetic demo is self-contained and clearly separated from a real QA run', () => {
  const record = createDemoRecord(Date.parse('2026-01-01T00:00:00Z'));
  const snapshot = dashboardSnapshot(record);
  assert.equal(snapshot.mode, 'synthetic-dashboard-demo');
  assert.equal(snapshot.repository, 'Synthetic QA workspace');
  assert.equal(snapshot.commit, null);
  assert.deepEqual(snapshot.liveCapabilities, { browser: true, android: true, androidScreenshots: false });
  assert.equal(snapshot.tasks.length, 3);
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.operations.length, 2);
  assert.ok(snapshot.operations.every(operation => !operation.artifact || !operation.artifact.includes('/synthetic/')));
});
