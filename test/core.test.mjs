import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateConfig, assertSubscriptionEnvironment, hasSubscriptionAuth, argumentsFor,
  hasActiveSubscriptionSession, doctor, parseOutput, schedule, runProcess, promptFor, providerEnvironment } from '../src/core.mjs';
import { reportRequiresAttention } from '../src/core.mjs';

const config = JSON.parse(await readFile(new URL('../qa.config.json', import.meta.url), 'utf8'));
const result = { summary: 'Kaynak incelemesi', handoff: 'UI henüz çalıştırılmadı.', checks: [
  { name: 'Öğrenci kaydı', status: 'not_tested', evidence: [] }
] };
const envelope = { structured_output: result, subtype: 'success', is_error: false };
const codexOutput = value => [
  { type: 'thread.started', thread_id: 'fixture' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
  { type: 'turn.completed' }
].map(JSON.stringify).join('\n');

test('default plan covers generic QA surfaces and both providers', () => {
  validateConfig(config);
  assert.deepEqual(config.tasks.map(t => t.id), [
    'inventory', 'identity-access', 'backend-api', 'frontend-client', 'data-privacy', 'cross-review'
  ]);
  assert.deepEqual([...new Set(config.tasks.map(t => t.provider))].sort(), ['claude', 'codex']);
});

test('invalid graph fails before any worker runs', () => {
  for (const mode of ['duplicate', 'cycle', 'missing']) {
    const c = structuredClone(config);
    if (mode === 'duplicate') c.tasks.push(c.tasks[0]);
    if (mode === 'cycle') c.tasks[0].dependsOn = ['cross-review'];
    if (mode === 'missing') c.tasks[0].dependsOn = ['nonexistent'];
    assert.throws(() => validateConfig(c));
  }
});

test('API/environment conflicts are refused without displaying values', () => {
  assert.doesNotThrow(() => assertSubscriptionEnvironment({ PATH: '/bin' }));
  assert.throws(() => assertSubscriptionEnvironment({ OPENAI_API_KEY: 'secret-do-not-print' }), error =>
    error.message.includes('OPENAI_API_KEY') && !error.message.includes('secret-do-not-print'));
});

test('provider environment keeps runtime and subscription paths but drops unrelated secrets', () => {
  const environment = providerEnvironment({ PATH: '/bin', HOME: '/home/qa', CODEX_HOME: '/home/qa/.codex',
    HTTPS_PROXY: 'http://proxy.test', LC_ALL: 'C.UTF-8', DECOY_SECRET: 'must-not-leak', DATABASE_URL: 'private' },
    { SUBSCRIPTION_QA_BUS_URL: 'http://127.0.0.1/tool', SUBSCRIPTION_QA_BUS_TOKEN: 'token' });
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.CODEX_HOME, '/home/qa/.codex');
  assert.equal(environment.LC_ALL, 'C.UTF-8');
  assert.equal(environment.SUBSCRIPTION_QA_BUS_TOKEN, 'token');
  assert.equal(environment.DECOY_SECRET, undefined);
  assert.equal(environment.DATABASE_URL, undefined);
  assert.throws(() => providerEnvironment({}, { UNRELATED: 'no' }), /Unsupported provider environment extra/);
});

test('CLI attention gate follows terminal state, follow-up gaps and actionable check statuses', () => {
  const task = checks => ({ state: 'completed', result: { checks } });
  assert.equal(reportRequiresAttention({ tasks: { qa: task([{ status: 'source_observation' }]) } }), false);
  assert.equal(reportRequiresAttention({ stopReason: 'TIMEOUT', tasks: {} }), true);
  assert.equal(reportRequiresAttention({ tasks: { qa: { ...task([]), followUpState: 'blocked' } } }), true);
  for (const status of ['failed', 'suspected_issue', 'not_tested']) {
    assert.equal(reportRequiresAttention({ tasks: { qa: task([{ status }]) } }), true);
  }
});

test('auth status must positively identify a subscription', () => {
  assert.equal(hasSubscriptionAuth('codex', { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' }), true);
  assert.equal(hasSubscriptionAuth('codex', { code: 0, stdout: 'Logged in using an API key', stderr: '' }), false);
  assert.equal(hasSubscriptionAuth('claude', { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', apiKeySource: null }) }), true);
  for (const auth of [{ loggedIn: true }, { loggedIn: true, authMethod: 'api_key', subscriptionType: 'max' },
    { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', apiKeySource: 'env' }]) {
    assert.equal(hasSubscriptionAuth('claude', { code: 0, stdout: JSON.stringify(auth) }), false);
  }
});

test('active doctor catches an expired Claude OAuth session without retaining provider text', async () => {
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === '--version') return { code: 0, stdout: 'fixture', stderr: '' };
    if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
    if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', apiKeySource: null
    }), stderr: '' };
    return { code: 1, stdout: JSON.stringify({ is_error: true, subtype: 'success',
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }), stderr: '' };
  };
  const status = await doctor(config, execute, { activeSession: true, environment: { PATH: '/bin' } });
  assert.equal(status.codex.ready, true);
  assert.deepEqual(status.claude, { ready: false, reason: 'SUBSCRIPTION_SESSION_EXPIRED_OR_UNAVAILABLE' });
  assert.ok(calls.some(([, args]) => args.includes('--no-session-persistence')));
  assert.ok(!JSON.stringify(status).includes('OAuth session'));
});

test('active Claude subscription probe accepts only a successful structured response', () => {
  assert.equal(hasActiveSubscriptionSession('claude', { code: 0, stdout: JSON.stringify({
    is_error: false, subtype: 'success', structured_output: { ok: true }
  }) }), true);
  assert.equal(hasActiveSubscriptionSession('claude', { code: 0, stdout: JSON.stringify({
    is_error: true, subtype: 'success', structured_output: { ok: true }
  }) }), false);
});

test('provider args retain permission checks and subscription-capable modes', () => {
  const codex = argumentsFor('codex', '/tmp/result.schema.json');
  const claude = argumentsFor('claude', '/tmp/result.schema.json');
  assert.ok(codex.includes('read-only'));
  assert.ok(codex.includes('--ephemeral'));
  assert.ok(codex.includes('forced_login_method="chatgpt"'));
  assert.ok(!claude.includes('--bare'));
  assert.ok(!claude.includes('--dangerously-skip-permissions'));
  assert.ok(claude.includes('Read,Glob,Grep'));
  assert.ok(claude.includes('--restricted'));
  assert.ok(claude.includes('--no-session-persistence'));
});

test('native provider output formats normalize to the same report', () => {
  assert.deepEqual(parseOutput('codex', codexOutput(result)), result);
  assert.deepEqual(parseOutput('claude', JSON.stringify(envelope)), result);
});

test('errors, truncated responses and unsupported pass claims cannot become success', () => {
  assert.throws(() => parseOutput('claude', JSON.stringify({ ...envelope, is_error: true })));
  assert.throws(() => parseOutput('codex', '{"type":"turn.failed"}'));
  assert.throws(() => parseOutput('codex', codexOutput(result).split('\n').slice(0, -1).join('\n')));
  const fakePass = structuredClone(result); fakePass.checks[0].status = 'passed';
  assert.equal(parseOutput('codex', codexOutput(fakePass)).checks[0].status, 'not_tested');
  const noEvidence = structuredClone(result); noEvidence.checks[0].status = 'source_observation';
  assert.throws(() => parseOutput('claude', JSON.stringify({ structured_output: noEvidence })));
  assert.throws(() => parseOutput('claude', JSON.stringify({ structured_output: { ...result, checks: [] } })));
});

test('scheduler respects dependencies, two global slots and one slot per provider', async () => {
  let total = 0, maxTotal = 0;
  const perProvider = { codex: 0, claude: 0 }, completed = new Set();
  const states = await schedule(config, async (task, dependencies) => {
    for (const dep of task.dependsOn) assert.ok(completed.has(dep));
    assert.deepEqual(Object.keys(dependencies), task.dependsOn);
    total++; maxTotal = Math.max(total, maxTotal); perProvider[task.provider]++;
    assert.ok(total <= 2); assert.equal(perProvider[task.provider], 1);
    await new Promise(resolve => setTimeout(resolve, task.provider === 'codex' ? 8 : 4));
    total--; perProvider[task.provider]--; completed.add(task.id);
    return { state: 'completed', result };
  });
  assert.equal(maxTotal, 2);
  assert.ok(Object.values(states).every(s => s.state === 'completed'));
});

test('provider failure stops its queue, blocks dependents and never switches provider', async () => {
  const calls = [];
  const states = await schedule(config, async task => {
    calls.push([task.id, task.provider]);
    if (task.id === 'backend-api') return { state: 'failed', reason: 'RATE_LIMIT' };
    return { state: 'completed', result };
  });
  assert.equal(states['backend-api'].state, 'failed');
  assert.equal(states['data-privacy'].state, 'blocked');
  assert.equal(states['cross-review'].state, 'blocked');
  assert.equal(states['identity-access'].state, 'completed');
  assert.equal(states['frontend-client'].state, 'completed');
  assert.deepEqual(calls.filter(([id]) => id === 'backend-api'), [['backend-api', 'codex']]);
});

test('handoffs are supplied to the next agent with explicit source-only boundaries', () => {
  const prompt = promptFor(config.tasks[1], { inventory: result });
  assert.ok(prompt.includes('SOURCE AUDIT'));
  assert.ok(prompt.includes('not_tested'));
  assert.ok(prompt.includes('Kaynak incelemesi'));
});

test('missing CLI returns a bounded failure', async () => {
  const r = await runProcess('subscription-qa-no-such-binary-for-test', [], { timeoutMs: 200 });
  assert.equal(r.code, -1); assert.equal(r.stderr, 'CLI_NOT_INSTALLED');
});

test('hung CLI is terminated and reported as timeout', async () => {
  const r = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 });
  assert.equal(r.timedOut, true); assert.notEqual(r.code, 0);
});

test('process arguments are literal and never interpreted by a shell', async () => {
  const literal = '$(printf SHOULD_NOT_RUN); `printf NO`';
  const r = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(r.stdout, literal); assert.equal(r.code, 0);
});
