import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunDashboard, dashboardSnapshot } from '../src/dashboard.mjs';

const record = {
  repository: 'example/project', commit: '1234567890abcdef', mode: 'live-team-qa', totalTurns: 2,
  tasks: { frontend: { provider: 'claude', state: 'running', turns: 2, result: { summary: 'Checking UI', checks: [] }, history: ['private'] } },
  messages: [{ id: 'm1', from: 'frontend', to: 'backend', kind: 'question', scenarioId: 'login',
    body: '<script>alert(1)</script>', acknowledged: false }],
  live: { operations: [{ id: 'live-1', agentId: 'frontend', tool: 'browser_screenshot', timestamp: '2026-01-01T00:00:00Z', artifact: '/private/run/screen.png' }] }
};

test('dashboard snapshot exposes explicit collaboration data without task history or artifact paths', () => {
  const snapshot = dashboardSnapshot(record);
  assert.equal(snapshot.tasks[0].summary, 'Checking UI');
  assert.equal(snapshot.tasks[0].history, undefined);
  assert.equal(snapshot.messages[0].body, '<script>alert(1)</script>');
  assert.equal(snapshot.operations[0].artifact, 'screen.png');
});

test('dashboard is loopback-only, token-scoped and writes a safe static archive', async t => {
  const dashboard = new RunDashboard(record);
  const url = await dashboard.listen();
  t.after(() => dashboard.close());
  assert.match(url, /^http:\/\/127\.0\.0\.1:[0-9]+\/[a-f0-9]{48}\/$/);

  const html = await fetch(url);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('x-frame-options'), 'DENY');
  assert.match(await html.text(), /Canlı Agent Paneli/);

  const state = await fetch(new URL('state', url));
  assert.equal(state.status, 200);
  assert.equal((await state.json()).messages.length, 1);
  const denied = await fetch(new URL('/wrong/state', url));
  assert.equal(denied.status, 404);

  dashboard.update({ ...record, totalTurns: 3 });
  const updated = await (await fetch(new URL('state', url))).json();
  assert.equal(updated.totalTurns, 3);

  const directory = await mkdtemp(join(tmpdir(), 'subscription-qa-dashboard-'));
  const output = join(directory, 'dashboard.html');
  await dashboard.writeStatic(output);
  const archived = await readFile(output, 'utf8');
  assert.match(archived, /Tamamlanmış koşu/);
  assert.doesNotMatch(archived, /<script>alert\(1\)<\/script>/);
});
