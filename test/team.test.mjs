import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { MessageBus, teamTools, brokerTimeoutMs } from '../src/message-bus.mjs';
import { scheduleTeam, teamArguments, publicActivity, teamLimits } from '../src/team.mjs';
import { runProcess } from '../src/core.mjs';

const task = (id, provider, dependsOn = []) => ({ id, provider, dependsOn, focus: 'Test fixture' });
const tasks = [task('student', 'codex'), task('parent', 'claude')];
const config = (items = tasks, team = {}) => ({ tasks: items, maxParallel: 2, timeoutMs: 1000,
  providers: { codex: { command: 'codex' }, claude: { command: 'claude' } },
  team: { maxDurationMs: 3000, ...team } });
const done = (decision = 'done') => ({ state: 'completed', result: { decision, summary: 'Fixture',
  checks: [{ name: 'Runtime', status: 'not_tested', evidence: [] }], handoff: '' } });
const ask = (bus, from = 'student', to = 'parent', key = 'question-1') => bus.call(from, 'send_message', {
  to, kind: 'question', scenarioId: 'parent-child-isolation', body: 'Can you check the recipient?', key
});

test('configured per-agent message limit is validated and preserved', () => {
  assert.equal(teamLimits(config(tasks, { maxMessages: 20, maxMessagesPerAgent: 3 })).maxMessagesPerAgent, 3);
  assert.throws(() => teamLimits(config(tasks, { maxMessages: 2, maxMessagesPerAgent: 3 })), /maxMessagesPerAgent/);
});
function handleInbox(bus, id) {
  const { messages } = bus.call(id, 'receive_messages', {});
  for (const message of messages) {
    if (['question', 'task'].includes(message.kind)) bus.call(id, 'reply_message', {
      messageId: message.id, body: 'Checked source fixture; runtime not tested.', key: 'reply-' + message.id
    });
    else bus.call(id, 'ack_message', { messageId: message.id });
  }
  return messages;
}

test('dashboard activity keeps explicit team actions and drops unsupported event fields', () => {
  const message = publicActivity({ sequence: 4, timestamp: '2026-01-01T00:00:00Z', type: 'message.sent',
    message: { from: 'student', to: 'parent', kind: 'question', scenarioId: 'scope', body: 'Check ownership.', secret: 'drop' } });
  assert.deepEqual(message, { sequence: 4, timestamp: '2026-01-01T00:00:00Z', type: 'message.sent',
    from: 'student', to: 'parent', kind: 'question', scenarioId: 'scope', body: 'Check ownership.' });
  assert.equal(publicActivity({ type: 'unknown', raw: 'drop' }), null);
});

test('mailboxes correlate replies, enforce recipients and deduplicate retries', () => {
  const bus = new MessageBus(tasks);
  const first = ask(bus);
  assert.match(first.createdAt, /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T/);
  assert.equal(ask(bus).id, first.id);
  assert.equal(bus.messages.length, 1);
  assert.throws(() => bus.call('student', 'reply_message', { messageId: first.id, body: 'no', key: 'no' }), /YOUR_MAILBOX/);
  assert.throws(() => bus.call('parent', 'ack_message', { messageId: first.id }), /ANSWER_REQUIRED/);
  assert.throws(() => bus.call('student', 'send_message', { ...first, body: 'changed', key: 'question-1' }), /KEY_CONFLICT/);
  handleInbox(bus, 'parent');
  const answer = bus.pending('student')[0];
  assert.equal(answer.inReplyTo, first.id);
  assert.equal(answer.scenarioId, first.scenarioId);
  assert.equal(bus.outstanding('student').length, 0);
  assert.equal(bus.pending('parent').length, 0);
  handleInbox(bus, 'student');
  assert.equal(bus.pending('student').length, 0);
});

test('message schemas and runtime reject malformed or oversized fields consistently', () => {
  const sendSchema = teamTools.find(tool => tool.name === 'send_message').inputSchema.properties;
  assert.equal(sendSchema.body.maxLength, 6000);
  assert.equal(sendSchema.key.maxLength, 100);
  assert.equal(sendSchema.scenarioId.maxLength, 100);
  assert.equal(sendSchema.scenarioId.pattern, '^[a-zA-Z0-9_.:-]{1,100}$');
  for (const [scenarioId, key] of [[undefined, 'missing'], [null, 'null'], [123, 'number'], [['scope'], 'array']]) {
    const bus = new MessageBus(tasks);
    assert.throws(() => bus.call('student', 'send_message', {
      to: 'parent', kind: 'finding', scenarioId, body: 'Fixture', key
    }), /INVALID_SCENARIO_ID/);
  }
  const bus = new MessageBus(tasks);
  assert.throws(() => bus.call('student', 'send_message', {
    to: 'parent', kind: 'finding', scenarioId: 'scope', body: 'x'.repeat(6001), key: 'oversized-body'
  }), /INVALID_BODY/);
  for (const tool of teamTools.filter(item => item.name.startsWith('browser_') || item.name.startsWith('android_'))) {
    assert.ok(tool.inputSchema.required.includes('key'), `${tool.name} must require an idempotency key`);
  }
  const press = teamTools.find(item => item.name === 'browser_press').inputSchema;
  assert.ok(press.required.includes('keyboardKey'));
  assert.ok(press.required.includes('key'));
  const urlAssertion = teamTools.find(item => item.name === 'browser_assert_url').inputSchema;
  assert.deepEqual(urlAssertion.properties.queryMode.enum, ['exact', 'ignore']);
  assert.equal(brokerTimeoutMs('browser_open'), 120000);
  assert.equal(brokerTimeoutMs('receive_messages'), 15000);
});

test('live tool retries share one operation and reject key reuse for a different action', async () => {
  let calls = 0;
  const bus = new MessageBus(tasks, { toolHandler: async (_agentId, name, args) => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 15));
    return { name, args, calls };
  } });
  const args = { path: '/login', key: 'open-login' };
  const [first, retry] = await Promise.all([
    bus.call('student', 'browser_open', args),
    bus.call('student', 'browser_open', args)
  ]);
  assert.deepEqual(retry, first);
  assert.equal(calls, 1);
  await assert.rejects(() => bus.call('student', 'browser_open', { path: '/other', key: 'open-login' }), /KEY_CONFLICT/);
});

test('message budgets reserve accepted replies and classify duplicate answers before exhaustion', () => {
  const bus = new MessageBus(tasks, { maxMessages: 2, maxMessagesPerAgent: 2 });
  const first = ask(bus);
  assert.equal(ask(bus).id, first.id);
  assert.throws(() => ask(bus, 'student', 'parent', 'another'), /BUDGET/);
  const answer = bus.call('parent', 'reply_message', { messageId: first.id, body: 'Checked.', key: 'answer-1' });
  assert.equal(bus.messages.length, 2);
  assert.equal(bus.outstanding('student').length, 0);
  assert.equal(bus.call('student', 'get_team_status').messageBudgetUsed, 2);
  assert.throws(() => bus.call('parent', 'reply_message', {
    messageId: first.id, body: 'Different retry.', key: 'answer-2'
  }), /ALREADY_ANSWERED/);
  assert.equal(bus.call('parent', 'reply_message', {
    messageId: first.id, body: 'Checked.', key: 'answer-1'
  }).id, answer.id);
});

test('per-agent quotas prevent one sender from consuming every ordinary message slot', () => {
  const bus = new MessageBus(tasks, { maxMessages: 8, maxMessagesPerAgent: 2 });
  const finding = (from, to, key) => bus.call(from, 'send_message', {
    to, kind: 'finding', scenarioId: 'fairness', body: 'Fixture', key
  });
  finding('student', 'parent', 'student-1');
  finding('student', 'parent', 'student-2');
  assert.throws(() => finding('student', 'parent', 'student-3'), /AGENT_MESSAGE_BUDGET_EXHAUSTED/);
  assert.equal(finding('parent', 'student', 'parent-1').from, 'parent');
  assert.equal(bus.messages.length, 3);
});

test('broker refuses unauthorized/browser calls and binds identity to capability token', async t => {
  const bus = new MessageBus(tasks);
  const url = await bus.listen(); t.after(() => bus.close());
  const token = bus.issueToken('student');
  const post = (headers = {}, payload = { name: 'receive_messages', arguments: {} }) => fetch(url, {
    method: 'POST', headers, body: JSON.stringify(payload)
  });
  assert.equal((await post()).status, 403);
  assert.equal((await post({ Authorization: `Bearer ${token}`, Origin: 'https://example.com' })).status, 403);
  const sent = await post({ Authorization: `Bearer ${token}` }, { name: 'send_message', agentId: 'parent', arguments: {
    to: 'parent', kind: 'finding', scenarioId: 'scope', body: 'Fixture', key: 'identity', from: 'parent'
  } });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).result.from, 'student');
  bus.revokeToken(token);
  assert.equal((await post({ Authorization: `Bearer ${token}` })).status, 403);
});

test('broker rechecks a capability token after reading a request body', async t => {
  const bus = new MessageBus(tasks);
  const endpoint = new URL(await bus.listen()); t.after(() => bus.close());
  const token = bus.issueToken('student');
  const response = new Promise((resolve, reject) => {
    const request = httpRequest(endpoint, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'
    } }, result => {
      let body = '';
      result.on('data', chunk => { body += chunk; });
      result.on('end', () => resolve({ status: result.statusCode, body }));
    });
    request.on('error', reject);
    request.write('{"name":"receive_messages",');
    setImmediate(() => {
      bus.revokeToken(token);
      request.end('"arguments":{}}');
    });
  });
  assert.deepEqual(await response, { status: 403, body: '{"error":"FORBIDDEN"}' });
});

function mcpClient(t, endpoint, token) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/team-mcp.mjs', import.meta.url))], {
    env: { ...process.env, SUBSCRIPTION_QA_BUS_URL: endpoint, SUBSCRIPTION_QA_BUS_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map(); let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const data = JSON.parse(line); const entry = pending.get(data.id);
    if (entry) { pending.delete(data.id); clearTimeout(entry.timer); entry.resolve(data); }
  });
  t.after(async () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Client closed')); }
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed;
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP response timeout')); }, 2000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, request, call: async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args });
    assert.equal(response.result.isError, false);
    return JSON.parse(response.result.content[0].text);
  } };
}

test('two real MCP bridge processes exchange messages while both remain running', { timeout: 6000 }, async t => {
  const bus = new MessageBus(tasks);
  const endpoint = await bus.listen(); t.after(() => bus.close());
  const a = mcpClient(t, endpoint, bus.issueToken('student'));
  const b = mcpClient(t, endpoint, bus.issueToken('parent'));
  for (const client of [a, b]) {
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal((await client.request('tools/list')).result.tools.length, teamTools.length);
  }
  const question = await a.call('send_message', { to: 'parent', kind: 'task', scenarioId: 'scenario-42', body: 'Inspect recipient check.', key: 'delegate-42' });
  const inbox = await b.call('receive_messages');
  assert.equal(inbox.messages[0].id, question.id);
  await b.call('reply_message', { messageId: question.id, body: 'Source observation only.', key: 'answer-42' });
  const response = (await a.call('receive_messages')).messages[0];
  assert.equal(response.inReplyTo, question.id);
  assert.equal(response.scenarioId, 'scenario-42');
  await a.call('ack_message', { messageId: response.id });
  assert.equal(a.child.exitCode, null); assert.equal(b.child.exitCode, null);
  assert.equal(bus.pending('student').length + bus.pending('parent').length, 0);
});

test('idle responder wakes before sender finishes, even when its primary task depends on sender', async () => {
  const c = config([tasks[0], task('parent', 'claude', ['student'])]);
  const bus = new MessageBus(c.tasks); const order = [];
  let answered;
  const reply = new Promise(resolve => { answered = resolve; });
  const outcome = await scheduleTeam(c, bus, async (agent, context) => {
    handleInbox(bus, agent.id);
    if (agent.id === 'student') {
      order.push('student-start'); ask(bus); await reply;
      handleInbox(bus, agent.id); order.push('student-finish');
    } else if (!context.initialWorkAllowed) {
      order.push('parent-answer'); answered();
    } else order.push('parent-primary');
    return done();
  });
  assert.deepEqual(order, ['student-start', 'parent-answer', 'student-finish', 'parent-primary']);
  assert.ok(Object.values(outcome.states).every(s => s.state === 'completed'));
});

test('waiting yields a single provider slot and completed agents wake for follow-ups', async () => {
  const c = config([task('student', 'codex'), task('parent', 'codex')]);
  const bus = new MessageBus(c.tasks); const calls = [];
  const outcome = await scheduleTeam(c, bus, async agent => {
    calls.push(agent.id); const received = handleInbox(bus, agent.id);
    if (agent.id === 'student' && !received.length) { ask(bus); return done('waiting'); }
    if (agent.id === 'student' && received.some(m => m.kind === 'answer')) {
      bus.call('student', 'send_message', { to: 'parent', kind: 'finding', scenarioId: 'scope', body: 'Follow-up evidence.', key: 'finding' });
    }
    return done();
  });
  assert.deepEqual(calls, ['student', 'parent', 'student', 'parent']);
  assert.ok(Object.values(outcome.states).every(s => s.state === 'completed'));
  assert.equal(bus.pending('parent').length, 0);
});

test('responder waiting for its prerequisite returns to primary work after the prerequisite completes', async () => {
  const c = config([task('inventory', 'codex'), task('parent', 'claude', ['inventory'])]);
  const bus = new MessageBus(c.tasks); const phases = [];
  let releaseInventory;
  const responseHandled = new Promise(resolve => { releaseInventory = resolve; });
  const outcome = await scheduleTeam(c, bus, async (agent, context) => {
    handleInbox(bus, agent.id);
    if (agent.id === 'inventory') {
      ask(bus, 'inventory', 'parent');
      await responseHandled;
      handleInbox(bus, agent.id);
      return done();
    }
    phases.push(context.initialWorkAllowed);
    if (!context.initialWorkAllowed) {
      releaseInventory();
      return done('waiting');
    }
    return done();
  });
  assert.equal(outcome.states.parent.state, 'completed');
  assert.equal(outcome.states.parent.initialComplete, true);
  assert.deepEqual(phases, [false, true]);
});

test('messages arriving after final inbox check trigger another turn', async () => {
  const bus = new MessageBus(tasks); let released;
  const ready = new Promise(resolve => { released = resolve; }); let parentTurns = 0;
  const outcome = await scheduleTeam(config(), bus, async agent => {
    const received = handleInbox(bus, agent.id);
    if (agent.id === 'student') {
      if (!received.length) { await ready; ask(bus); return done('waiting'); }
      return done();
    }
    if (++parentTurns === 1) { released(); await new Promise(resolve => setImmediate(resolve)); }
    return done();
  });
  assert.equal(parentTurns, 2);
  assert.ok(Object.values(outcome.states).every(s => s.state === 'completed'));
});

test('unanswered chatter reaches a finite turn budget and never passes', async () => {
  const c = config(tasks, { maxTurnsPerAgent: 2, maxTurns: 4 });
  const bus = new MessageBus(tasks);
  const outcome = await scheduleTeam(c, bus, async agent => {
    bus.call(agent.id, 'receive_messages', {});
    if (agent.id === 'student') ask(bus);
    return done('waiting');
  });
  assert.ok(outcome.totalTurns <= 4);
  assert.ok(Object.values(outcome.states).every(s => s.state === 'blocked'));
  assert.ok(bus.outstanding('student').length);
});

test('follow-up budget exhaustion never demotes completed work or blocks dependents', async () => {
  const items = [task('inventory', 'codex'), task('reviewer', 'claude'),
    task('dependent', 'codex', ['inventory', 'reviewer'])];
  const c = config(items, { maxTurnsPerAgent: 1, maxTurns: 4 });
  const bus = new MessageBus(items);
  let inventoryFinished;
  const ready = new Promise(resolve => { inventoryFinished = resolve; });
  const outcome = await scheduleTeam(c, bus, async agent => {
    handleInbox(bus, agent.id);
    if (agent.id === 'inventory') inventoryFinished();
    if (agent.id === 'reviewer') {
      await ready;
      bus.call('reviewer', 'send_message', { to: 'inventory', kind: 'finding', scenarioId: 'late-follow-up',
        body: 'No reply needed; preserve the completed dependency.', key: 'late-follow-up' });
    }
    return done();
  });
  assert.equal(outcome.states.inventory.state, 'completed');
  assert.equal(outcome.states.inventory.followUpState, 'blocked');
  assert.equal(outcome.states.inventory.followUpReason, 'TURN_BUDGET_EXHAUSTED');
  assert.equal(outcome.states.dependent.state, 'completed');
  assert.equal(bus.pending('inventory').length, 1);
});

test('an agent that never reads MCP inbox fails and stops its provider queue', async () => {
  const c = config([tasks[0], task('teacher', 'codex'), tasks[1]]);
  const bus = new MessageBus(c.tasks);
  const outcome = await scheduleTeam(c, bus, async agent => {
    if (agent.provider === 'claude') handleInbox(bus, agent.id);
    return done();
  });
  assert.equal(outcome.states.student.reason, 'MCP_MAILBOX_NOT_USED');
  assert.equal(outcome.states.teacher.state, 'blocked');
  assert.equal(outcome.states.parent.state, 'completed');
});

test('Claude max-turn exhaustion stays task-local and independent Claude work continues', async () => {
  const c = config([task('counselor', 'claude'), task('org-admin', 'claude'), task('cross-review', 'claude', ['counselor'])]);
  const bus = new MessageBus(c.tasks); const calls = [];
  const outcome = await scheduleTeam(c, bus, async agent => {
    calls.push(agent.id); handleInbox(bus, agent.id);
    if (agent.id === 'counselor') return { state: 'failed', reason: 'CLAUDE_MAX_TURNS', diagnostic: { providerResultType: 'error_max_turns' } };
    return done();
  });
  assert.deepEqual(calls, ['counselor', 'org-admin']);
  assert.equal(outcome.states.counselor.state, 'failed');
  assert.equal(outcome.states.counselor.reason, 'CLAUDE_MAX_TURNS');
  assert.equal(outcome.states['org-admin'].state, 'completed');
  assert.equal(outcome.states['cross-review'].state, 'blocked');
  assert.equal(outcome.states['cross-review'].reason, 'DEPENDENCY_UNAVAILABLE');
});

test('subscription and usage failures still stop the provider queue', async () => {
  const c = config([task('counselor', 'claude'), task('org-admin', 'claude')]);
  const bus = new MessageBus(c.tasks);
  const outcome = await scheduleTeam(c, bus, async agent => {
    handleInbox(bus, agent.id);
    if (agent.id === 'counselor') return { state: 'failed', reason: 'RATE_OR_USAGE_LIMIT_REPORTED' };
    return done();
  });
  assert.equal(outcome.states.counselor.state, 'failed');
  assert.equal(outcome.states['org-admin'].state, 'blocked');
  assert.equal(outcome.states['org-admin'].reason, 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(outcome.states['org-admin'].blockedBy, { agentId: 'counselor', reason: 'RATE_OR_USAGE_LIMIT_REPORTED' });
});

test('team abort reaches native subprocess and preserves unfinished task status', async () => {
  const c = config([tasks[0]]); const bus = new MessageBus(c.tasks);
  const controller = new AbortController();
  const outcome = await scheduleTeam(c, bus, async (agent, context) => {
    handleInbox(bus, agent.id);
    const timer = setTimeout(() => controller.abort(), 60);
    try {
      const execution = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: context.signal });
      assert.equal(execution.aborted, true); assert.notEqual(execution.code, 0);
      return { state: 'failed', reason: 'INTERRUPTED' };
    } finally { clearTimeout(timer); }
  }, { signal: controller.signal });
  assert.equal(outcome.stopReason, 'INTERRUPTED');
  assert.equal(outcome.states.student.state, 'failed');
  assert.ok(outcome.elapsedMs < 2500);
});

test('native arguments expose only communication tools alongside source-reading permissions', () => {
  const env = { SUBSCRIPTION_QA_BUS_URL: 'http://127.0.0.1:1234/tool', SUBSCRIPTION_QA_BUS_TOKEN: 'fixture-token' };
  const codex = teamArguments('codex', '/schema.json', '/bridge.mjs', env);
  const claude = teamArguments('claude', '/schema.json', '/bridge.mjs', env, { claudeMaxTurns: 90 });
  assert.ok(codex.includes('mcp_servers.qa.required=true'));
  assert.ok(codex.includes('read-only'));
  assert.ok(codex.includes('--ephemeral'));
  assert.ok(!codex.join(' ').includes(env.SUBSCRIPTION_QA_BUS_TOKEN));
  assert.ok(claude.includes('--strict-mcp-config'));
  assert.ok(claude.includes('--restricted'));
  assert.ok(claude.includes('--no-session-persistence'));
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!claude.join(' ').includes(env.SUBSCRIPTION_QA_BUS_TOKEN));
  const mcpConfig = JSON.parse(claude[claude.indexOf('--mcp-config') + 1]);
  assert.equal(mcpConfig.mcpServers.qa.env, undefined);
  assert.equal(claude[claude.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(claude[claude.indexOf('--max-turns') + 1], '90');
  for (const tool of teamTools) assert.ok(claude.join(' ').includes('mcp__qa__' + tool.name));
  assert.ok(!claude.includes('--dangerously-skip-permissions'));
});
