import test from 'node:test';
import assert from 'node:assert/strict';
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
});

test('browser and Android tools produce agent-bound evidence', async t => {
  const execute = async (_command, args) => ({ code: 0, stdout: args.includes('devices') ? 'emulator-5554\tdevice product:sdk\n' : 'ok', stderr: '' });
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-fixture', { browserType, execute });
  t.after(() => runtime.close());

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
