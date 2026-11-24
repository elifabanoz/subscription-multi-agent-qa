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
  assert.equal(snapshot.messages[0].inReplyTo, null);
  assert.deepEqual(snapshot.messageBudget, {
    messagesUsed: 1, repliesReserved: 1, effectiveUsed: 2, maxMessages: 20, maxMessagesPerAgent: 20,
    label: '1 message · 2/20 budget · 1 reply reserved · 20 sends/agent'
  });
  assert.equal(snapshot.operations[0].artifact, 'screen.png');
  assert.equal(snapshot.operations[0].verification, null);
  assert.equal(snapshot.activity[0].from, 'frontend');
  assert.deepEqual(snapshot.provenance, {
    version: null,
    dirtyCheckout: null,
    liveUiTestsExecuted: null,
    evidenceIndependentlyVerified: null
  });
});

test('dashboard snapshot exposes bounded run provenance without inventing missing booleans', () => {
  const snapshot = dashboardSnapshot({ ...record, version: '0.4.9', dirtyCheckout: false,
    liveUiTestsExecuted: true, evidenceIndependentlyVerified: false });
  assert.deepEqual(snapshot.provenance, {
    version: '0.4.9',
    dirtyCheckout: false,
    liveUiTestsExecuted: true,
    evidenceIndependentlyVerified: false
  });
});

test('dashboard snapshot preserves reply relationships for readable conversations', () => {
  const snapshot = dashboardSnapshot({ ...record, messages: [...record.messages, {
    id: 'm2', from: 'backend', to: 'frontend', kind: 'answer', scenarioId: 'login',
    body: 'The session is cleared.', inReplyTo: 'm1', acknowledged: false
  }] });
  assert.equal(snapshot.messages[1].inReplyTo, 'm1');
  assert.equal(snapshot.messages[1].kind, 'answer');
});

test('dashboard uses the configured per-agent message budget', () => {
  const snapshot = dashboardSnapshot({ ...record, limits: { maxMessages: 20, maxMessagesPerAgent: 3 } });
  assert.equal(snapshot.messageBudget.maxMessagesPerAgent, 3);
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

  const incomplete = dashboardSnapshot({ ...record, finishedAt: '2026-01-01T01:00:00Z' });
  assert.equal(incomplete.outcome.status, 'issues');
  assert.equal(incomplete.outcome.label, 'Run ended with incomplete agents');

  const malformedActivity = dashboardSnapshot({ ...record, activity: [{}] });
  assert.equal(malformedActivity.activity[0].type, 'unknown');
});

test('dashboard never reports success when checks failed, are suspected or were not executed', () => {
  const finished = { ...record, finishedAt: '2026-01-01T01:00:00Z' };
  const withChecks = checks => dashboardSnapshot({ ...finished, tasks: {
    frontend: { provider: 'claude', state: 'completed', turns: 2, result: { summary: 'Done', checks } }
  } });

  const failed = withChecks([{ name: 'Login', status: 'failed', evidence: ['[live:live-1]'] }]);
  assert.equal(failed.outcome.status, 'issues');
  assert.equal(failed.outcome.label, 'Completed with failed checks');
  assert.equal(failed.checkSummary.failed, 1);

  const suspected = withChecks([{ name: 'Login', status: 'suspected_issue', evidence: ['src/login.mjs:8'] }]);
  assert.equal(suspected.outcome.status, 'findings');
  assert.equal(suspected.outcome.label, 'Review completed with findings');

  const notTested = withChecks([{ name: 'Login', status: 'not_tested', evidence: [] }]);
  assert.equal(notTested.outcome.status, 'review');
  assert.equal(notTested.outcome.label, 'Review completed with gaps');

  const sourceOnly = withChecks([{ name: 'Input validation', status: 'source_observation', evidence: ['src/api.mjs:8'] }]);
  assert.equal(sourceOnly.outcome.status, 'review');
  assert.equal(sourceOnly.outcome.label, 'Source review completed');

  const passed = withChecks([{ name: 'Login', status: 'passed', evidence: ['[live:live-1]'] }]);
  assert.equal(passed.outcome.status, 'completed');
  assert.equal(passed.outcome.label, 'Completed successfully');
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
