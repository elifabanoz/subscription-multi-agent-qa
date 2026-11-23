import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunDashboard, dashboardSnapshot } from '../src/dashboard.mjs';

const record = {
  repository: 'example/project', commit: '1234567890abcdef', mode: 'live-team-qa', totalTurns: 2,
  limits: { maxMessages: 20 },
  taskDefinitions: [{ id: 'frontend', provider: 'claude', role: 'client', focus: 'Check login and navigation behavior.' }],
  tasks: { frontend: { provider: 'claude', state: 'running', turns: 2, result: { summary: 'Checking UI', checks: [] }, history: ['private'] } },
  messages: [{ id: 'm1', from: 'frontend', to: 'backend', kind: 'question', scenarioId: 'login',
    body: '<script>alert(1)</script>', acknowledged: false }],
  activity: [{ sequence: 1, timestamp: '2026-01-01T00:00:00Z', type: 'message.sent', from: 'frontend', to: 'backend', kind: 'question', scenarioId: 'login', body: 'What does 401 return?' }],
  live: { operations: [{ id: 'live-1', agentId: 'frontend', tool: 'browser_screenshot', timestamp: '2026-01-01T00:00:00Z', artifact: '/private/run/screen.png' }] }
};

test('dashboard snapshot exposes explicit collaboration data without task history or artifact paths', () => {
  const snapshot = dashboardSnapshot(record);
  assert.equal(snapshot.tasks[0].summary, 'Checking UI');
  assert.equal(snapshot.tasks[0].focus, 'Check login and navigation behavior.');
  assert.equal(snapshot.tasks[0].history, undefined);
  assert.equal(snapshot.outcome.status, 'running');
  assert.equal(snapshot.messages[0].body, '<script>alert(1)</script>');
  assert.deepEqual(snapshot.messageBudget, {
    messagesUsed: 1, repliesReserved: 1, effectiveUsed: 2, maxMessages: 20, maxMessagesPerAgent: 20,
    label: '1 message · 2/20 budget · 1 reply reserved · 20 sends/agent'
  });
  assert.equal(snapshot.operations[0].artifact, 'screen.png');
  assert.equal(snapshot.activity[0].from, 'frontend');
});

test('dashboard outcome exposes failure, interruption and follow-up reasons', () => {
  const interrupted = dashboardSnapshot({ ...record, finishedAt: '2026-01-01T01:00:00Z', stopReason: 'INTERRUPTED',
    tasks: { frontend: { provider: 'claude', state: 'failed', turns: 2, reason: 'INTERRUPTED' } } });
  assert.deepEqual(interrupted.outcome, { status: 'interrupted', label: 'Run interrupted', message: 'Run stopped: INTERRUPTED.' });
  assert.equal(interrupted.tasks[0].reason, 'INTERRUPTED');

  const followUp = dashboardSnapshot({ ...record, finishedAt: '2026-01-01T01:00:00Z',
    tasks: { frontend: { provider: 'claude', state: 'completed', turns: 2, initialComplete: true,
      followUpState: 'blocked', followUpReason: 'TURN_BUDGET_EXHAUSTED' } } });
  assert.equal(followUp.outcome.status, 'issues');
  assert.equal(followUp.tasks[0].followUpReason, 'TURN_BUDGET_EXHAUSTED');

  const malformedActivity = dashboardSnapshot({ ...record, activity: [{}] });
  assert.equal(malformedActivity.activity[0].type, 'unknown');
});

test('dashboard is loopback-only, token-scoped and writes a safe static archive', async t => {
  const dashboard = new RunDashboard(record);
  const url = await dashboard.listen();
  t.after(() => dashboard.close());
  assert.match(url, /^http:\/\/127\.0\.0\.1:[0-9]+\/[a-f0-9]{48}\/$/);

  const html = await fetch(url);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('x-frame-options'), 'DENY');
  const htmlText = await html.text();
  assert.match(htmlText, /Team conversation/);

  const state = await fetch(new URL('state', url));
  assert.equal(state.status, 200);
  const stateJson = await state.json();
  assert.equal(stateJson.messages.length, 1);
  assert.equal(stateJson.messageBudget.label, '1 message · 2/20 budget · 1 reply reserved · 20 sends/agent');
  const denied = await fetch(new URL('/wrong/state', url));
  assert.equal(denied.status, 404);

  dashboard.update({ ...record, totalTurns: 3 });
  const updated = await (await fetch(new URL('state', url))).json();
  assert.equal(updated.totalTurns, 3);

  const directory = await mkdtemp(join(tmpdir(), 'subscription-qa-dashboard-'));
  const output = join(directory, 'dashboard.html');
  await dashboard.writeStatic(output);
  const archived = await readFile(output, 'utf8');
  assert.doesNotMatch(archived, /Completed run/);
  assert.doesNotMatch(archived, /<script>alert\(1\)<\/script>/);
});
