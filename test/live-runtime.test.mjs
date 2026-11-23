import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LiveQaRuntime } from '../src/live-runtime.mjs';
import { validateConfig, parseOutput } from '../src/core.mjs';

const calls = [];
const locator = {
  first() { return this; },
  async innerText() { return 'Sign in\nDashboard'; },
  async evaluateAll() { return [{ tag: 'button', role: null, type: null, name: 'Continue', text: 'Continue' }]; },
  async click() { calls.push('click'); },
  async fill(value) { calls.push(['fill', value]); },
  async selectOption(value) { calls.push(['select', value]); },
  async press(key) { calls.push(['press', key]); }
};
const page = {
  current: 'about:blank',
  async goto(url) { this.current = url; },
  url() { return this.current; },
  async title() { return 'Fixture'; },
  locator() { return locator; },
  async screenshot() {}
};
const browserType = { async launch() { return {
  async newContext() { return { async route() {}, async newPage() { return page; }, async close() {} }; },
  async close() {}
}; } };

const baseConfig = {
  maxParallel: 2, timeoutMs: 10000,
  providers: { codex: { command: 'codex' }, claude: { command: 'claude' } },
  tasks: [{ id: 'qa', provider: 'codex', dependsOn: [], focus: 'Fixture' }],
  live: {
    browser: { enabled: true, baseUrl: 'http://127.0.0.1:3000', allowedOrigins: ['http://127.0.0.1:3000'] },
    android: { enabled: true, adbCommand: 'adb', serial: 'emulator-5554', package: 'com.example.app' }
  }
};

test('live config restricts browser origins and Android identifiers', () => {
  assert.doesNotThrow(() => validateConfig(structuredClone(baseConfig)));
  const origin = structuredClone(baseConfig); origin.live.browser.allowedOrigins = ['https://example.com'];
  assert.throws(() => validateConfig(origin), /origin/i);
  const packageConfig = structuredClone(baseConfig); packageConfig.live.android.package = 'bad package';
  assert.throws(() => validateConfig(packageConfig), /package/i);
  const activityConfig = structuredClone(baseConfig); activityConfig.live.android.activity = 'com.other.app/.MainActivity';
  assert.throws(() => validateConfig(activityConfig), /activity/i);
});

test('browser and Android tools produce agent-bound evidence', async t => {
  const executed = [];
  const execute = async (_command, args) => {
    executed.push(args);
    return { code: 0, stdout: args.includes('devices') ? 'emulator-5554          device product:sdk\r\n' : 'ok', stderr: '' };
  };
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-fixture', { browserType, execute });
  t.after(() => runtime.close());

  const doctor = await runtime.doctor();
  assert.equal(doctor.browser.ready, true);
  assert.equal(doctor.android.ready, true);

  const opened = await runtime.call('qa', 'browser_open', { path: '/login' });
  assert.equal(opened.url, 'http://127.0.0.1:3000/login');
  assert.match(opened.evidenceRef, /^\[live:live-[0-9]+\]$/);
  const snapshot = await runtime.call('qa', 'browser_snapshot', {});
  assert.match(snapshot.text, /Dashboard/);
  await assert.rejects(() => runtime.call('qa', 'browser_open', { path: 'https://example.com' }), /NOT_ALLOWED/);

  const devices = await runtime.call('qa', 'android_devices', {});
  assert.match(devices.output, /emulator-5554/);
  await runtime.call('qa', 'android_start_app', {});
  await runtime.call('qa', 'android_input_text', { text: 'qa user@example.com' });
  await assert.rejects(() => runtime.call('qa', 'android_input_text', { text: 'bad;command' }), /NOT_SAFE/);
  assert.ok(runtime.evidenceIds('qa').size >= 5);
  assert.ok(executed.some(args => args.includes('monkey')));
});

test('Android explicit activity starts through am without a shell', async () => {
  const config = structuredClone(baseConfig);
  config.live.android.activity = 'com.example.app/.MainActivity';
  const calls = [];
  const execute = async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: 'ok', stderr: '' }; };
  const runtime = new LiveQaRuntime(config, '/tmp/live-activity', { browserType, execute });
  const result = await runtime.call('qa', 'android_start_app', {});
  assert.equal(result.activity, 'com.example.app/.MainActivity');
  assert.deepEqual(calls[0], { command: 'adb', args: ['-s', 'emulator-5554', 'shell', 'am', 'start', '-W', '-n', 'com.example.app/.MainActivity'] });
});

test('Android screenshot is captured as binary stdout without host path translation', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const observed = [];
  const execute = async (_command, args, options) => {
    assert.ok(args.includes('exec-out'));
    assert.equal(options.binaryStdout, true);
    return { code: 0, stdout: png, stderr: '' };
  };
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-binary', { browserType, execute, onOperation: item => observed.push(item) });
  const result = await runtime.call('qa', 'android_screenshot', { name: 'screen' });
  assert.deepEqual(await readFile(result.artifact), png);
  assert.deepEqual(observed.map(item => [item.agentId, item.tool]), [['qa', 'android_screenshot']]);
});

test('passed and failed claims require evidence created by that agent', () => {
  const report = { summary: 'Live check', handoff: 'None', checks: [
    { name: 'Login', status: 'passed', evidence: ['Observed dashboard [live:live-2]'] }
  ] };
  const output = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } }),
    JSON.stringify({ type: 'turn.completed' })
  ].join('\n');
  assert.deepEqual(parseOutput('codex', output, { liveEvidence: new Set(['live-2']) }), report);
  assert.throws(() => parseOutput('codex', output, { liveEvidence: new Set(['live-9']) }), /runtime evidence/i);
});
