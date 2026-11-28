import test from 'node:test';
import assert from 'node:assert/strict';
import { executionFailure, parseFailureReason } from '../src/diagnostics.mjs';

test('provider parse failures are classified without persisting arbitrary model text', () => {
  assert.equal(parseFailureReason(new Error('Live result does not match a deterministic assertion for this check.')),
    'PROVIDER_RESULT_ASSERTION_MISMATCH');
  assert.equal(parseFailureReason(new Error('private token value')), 'INVALID_OR_FAILED_PROVIDER_RESULT');
});
import { MessageBus } from '../src/message-bus.mjs';
import { scheduleTeam } from '../src/team.mjs';

test('Claude model turn exhaustion is distinguishable from subscription rate limits', () => {
  const maxTurns = executionFailure('claude', { code: 1, stderr: '', stdout: JSON.stringify({
    is_error: true, subtype: 'error_max_turns', errors: ['Fixture: exceeded CLI turns.']
  }) });
  assert.equal(maxTurns.reason, 'CLAUDE_MAX_TURNS');
  assert.equal(maxTurns.diagnostic.classificationBasis, 'provider_result_subtype');
  const rate = executionFailure('claude', { code: 1, stderr: '', stdout: JSON.stringify({
    is_error: true, subtype: 'error_during_execution', errors: ['Rate limit exceeded: 429']
  }) });
  assert.equal(rate.reason, 'RATE_OR_USAGE_LIMIT_REPORTED');
});

test('diagnostics retain no error text, source text, tokens or unrecognized provider fields', () => {
  const failure = executionFailure('claude', { code: 1, stderr: 'Unauthorized secret-token-fixture', stdout: JSON.stringify({
    is_error: true, subtype: 'PRIVATE_SUBTYPE_VALUE', result: 'private-source-value', errors: ['user@example.test']
  }) });
  const saved = JSON.stringify(failure);
  for (const privateValue of ['secret-token-fixture', 'private-source-value', 'PRIVATE_SUBTYPE_VALUE', 'user@example.test'])
    assert.ok(!saved.includes(privateValue));
  assert.equal(failure.reason, 'AUTH_ERROR_REPORTED');
  assert.equal(failure.diagnostic.providerResultType, null);
  assert.ok(failure.diagnostic.stderrBytes > 0);
});

test('expired Claude OAuth is classified even when the envelope subtype says success', () => {
  const failure = executionFailure('claude', { code: 1, stderr: '', stdout: JSON.stringify({
    is_error: true, subtype: 'success', result: 'Failed to authenticate: OAuth session expired and could not be refreshed'
  }) });
  assert.equal(failure.reason, 'AUTH_ERROR_REPORTED');
  assert.equal(failure.diagnostic.classificationBasis, 'error_text_indicator');
  assert.ok(!JSON.stringify(failure).includes('OAuth session'));
});

test('successful model prose is not interpreted as an authentication or quota error', () => {
  const failure = executionFailure('claude', { code: 1, stderr: '', stdout: JSON.stringify({
    is_error: false, subtype: 'success', structured_output: { summary: 'Source checks unauthorized and rate limit responses.' }
  }) });
  assert.equal(failure.reason, 'CLI_NONZERO_EXIT');
  const interrupted = executionFailure('codex', { code: -1, aborted: true, exitSignal: 'SIGTERM', stderr: '', stdout: '' });
  assert.equal(interrupted.reason, 'INTERRUPTED');
  assert.equal(interrupted.diagnostic.exitSignal, 'SIGTERM');
});

test('task-local Claude max-turn metadata survives report/history while independent agents complete', async () => {
  const config = { maxParallel: 2, timeoutMs: 1000, providers: { codex: { command: 'codex' }, claude: { command: 'claude' } },
    tasks: ['counselor', 'org-admin', 'student'].map(id => ({ id, dependsOn: [], focus: 'Fixture', provider: id === 'student' ? 'codex' : 'claude' })) };
  const bus = new MessageBus(config.tasks);
  const outcome = await scheduleTeam(config, bus, async agent => {
    bus.call(agent.id, 'receive_messages', {});
    if (agent.id === 'counselor') return executionFailure('claude', { code: 1, stdout: '{"is_error":true,"subtype":"error_max_turns"}', stderr: '' });
    return { state: 'completed', result: { decision: 'done' } };
  });
  assert.equal(outcome.states.counselor.diagnostic.exitCode, 1);
  assert.equal(outcome.states.counselor.history[0].diagnostic.providerResultType, 'error_max_turns');
  assert.equal(outcome.states['org-admin'].state, 'completed');
  assert.equal(outcome.states['org-admin'].blockedBy, undefined);
  assert.equal(outcome.states.student.state, 'completed');
});
