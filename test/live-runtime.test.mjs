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
  async screenshot(options) { this.screenshotOptions = options; }
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
    const stdout = args.includes('devices') ? 'emulator-5554          device product:sdk\r\n' :
      args.includes('dumpsys') ? 'mCurrentFocus=Window{ com.example.app/.MainActivity }' : 'ok';
    return { code: 0, stdout, stderr: '' };
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
  await runtime.call('qa', 'browser_press', { selector: '#continue', keyboardKey: 'Enter' });
  assert.ok(calls.some(item => Array.isArray(item) && item[0] === 'press' && item[1] === 'Enter'));
  const textAssertion = await runtime.call('qa', 'browser_assert_text', { check: 'Dashboard visible', text: 'Dashboard' });
  assert.equal(textAssertion.assertionStatus, 'passed');
  const urlAssertion = await runtime.call('qa', 'browser_assert_url', { check: 'Login URL', path: '/login' });
  assert.equal(urlAssertion.assertionStatus, 'passed');
  page.current = 'http://127.0.0.1:3000/login?next=%2Fdashboard';
  const ignoreQuery = await runtime.call('qa', 'browser_assert_url', { check: 'Login path', path: '/login', queryMode: 'ignore' });
  assert.equal(ignoreQuery.assertionStatus, 'passed');
  const exactQuery = await runtime.call('qa', 'browser_assert_url', { check: 'Exact login URL', path: '/login' });
  assert.equal(exactQuery.assertionStatus, 'failed');
  const failedAssertion = await runtime.call('qa', 'browser_assert_text', { check: 'Error shown', text: 'Missing text' });
  assert.equal(failedAssertion.assertionStatus, 'failed');
  const textAssertionId = textAssertion.evidenceRef.match(/\[live:(live-[0-9]+)\]/)[1];
  assert.deepEqual(runtime.evidenceFor('qa').get(textAssertionId), {
    checkName: 'Dashboard visible', status: 'passed', kind: 'text_present'
  });
  await assert.rejects(() => runtime.call('qa', 'browser_open', { path: 'https://example.com' }), /NOT_ALLOWED/);

  const devices = await runtime.call('qa', 'android_devices', {});
  assert.match(devices.output, /emulator-5554/);
  await runtime.call('qa', 'android_start_app', {});
  await runtime.call('qa', 'android_input_text', { text: 'qa user@example.com' });
  await assert.rejects(() => runtime.call('qa', 'android_input_text', { text: 'bad;command' }), /NOT_SAFE/);
  assert.ok(runtime.evidenceIds('qa').size >= 5);
  assert.ok(executed.some(args => args.includes('monkey')));
});

test('browser screenshots mask editable fields', async () => {
  page.current = 'http://127.0.0.1:3000/login';
  page.screenshotOptions = null;
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-mask', { browserType, execute: async () => ({ code: 0, stdout: 'ok', stderr: '' }) });
  await runtime.call('qa', 'browser_screenshot', { name: 'masked' });
  assert.equal(page.screenshotOptions.maskColor, '#000000');
  assert.equal(page.screenshotOptions.mask.length, 1);
  await runtime.close();
});

test('concurrent first browser calls share one Chromium launch', async () => {
  let launches = 0;
  const concurrentBrowser = { async launch() {
    launches += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return {
      async newContext() { return { async route() {}, async newPage() { return { ...page, current: 'about:blank' }; }, async close() {} }; },
      async close() {}
    };
  } };
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-launch', { browserType: concurrentBrowser, execute: async () => ({ code: 0, stdout: 'ok', stderr: '' }) });
  await Promise.all([
    runtime.call('qa', 'browser_open', { path: '/one' }),
    runtime.call('other-agent', 'browser_open', { path: '/two' })
  ]);
  assert.equal(launches, 1);
  await runtime.close();
});

test('browser context reset closes and discards only that agent session', async () => {
  let contexts = 0;
  let closes = 0;
  const isolatedBrowser = { async launch() { return {
    async newContext() {
      const id = ++contexts;
      return {
        async route() {},
        async newPage() { return { ...page, current: 'about:blank', contextId: id }; },
        async close() { closes += 1; }
      };
    },
    async close() {}
  }; } };
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-reset', { browserType: isolatedBrowser });
  await runtime.call('qa', 'browser_open', { path: '/first' });
  await runtime.call('other-agent', 'browser_open', { path: '/other' });
  const reset = await runtime.call('qa', 'browser_reset_context', {});
  assert.equal(reset.reset, true);
  assert.equal(closes, 1);
  assert.equal(runtime.pages.has('qa'), false);
  assert.equal(runtime.pages.has('other-agent'), true);
  await runtime.call('qa', 'browser_open', { path: '/fresh' });
  assert.equal(contexts, 3);
  assert.equal(runtime.pages.get('qa').page.contextId, 3);
  await runtime.close();
});

test('browser evidence denies non-http schemes and foreign origins by default', async t => {
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-scheme-guard', { browserType });
  t.after(async () => { page.current = 'about:blank'; await runtime.close(); });
  const allowedPage = { url: () => 'http://127.0.0.1:3000/dashboard' };
  assert.doesNotThrow(() => runtime.assertPageAllowed(allowedPage));
  for (const url of ['https://example.com/', 'data:text/html,fixture', 'blob:http://127.0.0.1:3000/id',
    'file:///tmp/fixture.html', 'about:blank']) {
    assert.throws(() => runtime.assertPageAllowed({ url: () => url }), /NAVIGATION_NOT_ALLOWED/);
  }
  page.current = 'data:text/html,fixture';
  await assert.rejects(() => runtime.call('qa', 'browser_snapshot', {}), /NAVIGATION_NOT_ALLOWED/);
  assert.equal(runtime.operations.length, 0);
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
    if (args.includes('dumpsys')) return { code: 0, stdout: 'mCurrentFocus=Window{ com.example.app/.MainActivity }', stderr: '' };
    assert.ok(args.includes('exec-out'));
    assert.equal(options.binaryStdout, true);
    return { code: 0, stdout: png, stderr: '' };
  };
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-binary', { browserType, execute, onOperation: item => observed.push(item) });
  const result = await runtime.call('qa', 'android_screenshot', { name: 'screen' });
  assert.deepEqual(await readFile(result.artifact), png);
  assert.deepEqual(observed.map(item => [item.agentId, item.tool]), [['qa', 'android_screenshot']]);
});

test('Android operations are device-serialized and reject capture outside the configured app', async () => {
  let active = 0, maxActive = 0;
  const execute = async (_command, args) => {
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return { code: 0, stdout: args.includes('dumpsys') ? 'mCurrentFocus=Window{ com.example.app/.MainActivity }' : 'ok', stderr: '' };
  };
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-serialized', { browserType, execute });
  await Promise.all([
    runtime.call('qa', 'android_tap', { x: 10, y: 20 }),
    runtime.call('other-agent', 'android_tap', { x: 30, y: 40 })
  ]);
  assert.equal(maxActive, 1);

  const foreign = new LiveQaRuntime(baseConfig, '/tmp/live-foreign', { browserType, execute: async () => ({
    code: 0, stdout: 'mCurrentFocus=Window{ com.other.app/.MainActivity }', stderr: ''
  }) });
  await assert.rejects(() => foreign.call('qa', 'android_dump_ui', {}), /NOT_FOREGROUND/);
  assert.equal(foreign.operations.length, 0);

  const prefixCollision = new LiveQaRuntime(baseConfig, '/tmp/live-prefix', { browserType, execute: async () => ({
    code: 0, stdout: 'mCurrentFocus=Window{ com.example.app.evil/.MainActivity }', stderr: ''
  }) });
  await assert.rejects(() => prefixCollision.call('qa', 'android_dump_ui', {}), /NOT_FOREGROUND/);
});

test('Android UI dump cleanup runs even when uiautomator dump fails', async () => {
  const calls = [];
  const execute = async (_command, args) => {
    calls.push(args);
    if (args.includes('dumpsys')) return { code: 0, stdout: 'mCurrentFocus=Window{ com.example.app/.MainActivity }', stderr: '' };
    if (args.includes('uiautomator')) return { code: 1, stdout: '', stderr: 'failed' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-dump-cleanup', { browserType, execute });
  await assert.rejects(() => runtime.call('qa', 'android_dump_ui', {}), /ADB_COMMAND_FAILED/);
  assert.ok(calls.some(args => args.includes('rm') && args.includes('-f')));
});

test('Android text assertions inspect decoded visible labels, not raw resource identifiers', async () => {
  const xml = '<?xml version="1.0"?><hierarchy><node text="Welcome &amp; learn" resource-id="com.example.app:id/hidden_target" content-desc="Continue &#x2192;"/></hierarchy>';
  const execute = async (_command, args) => {
    if (args.includes('dumpsys')) return { code: 0, stdout: 'mCurrentFocus=Window{ com.example.app/.MainActivity }', stderr: '' };
    if (args.includes('cat')) return { code: 0, stdout: xml, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const runtime = new LiveQaRuntime(baseConfig, '/tmp/live-visible-text', { browserType, execute });
  const text = await runtime.call('qa', 'android_assert_text', { check: 'Welcome label', text: 'Welcome & learn' });
  const description = await runtime.call('qa', 'android_assert_text', { check: 'Continue action', text: 'Continue →' });
  const resourceId = await runtime.call('qa', 'android_assert_text', { check: 'Resource identifier hidden', text: 'hidden_target' });
  assert.equal(text.assertionStatus, 'passed');
  assert.equal(description.assertionStatus, 'passed');
  assert.equal(resourceId.assertionStatus, 'failed');
});

test('passed and failed claims require evidence created by that agent', () => {
  const report = { summary: 'Live check', handoff: 'None', checks: [
    { name: 'Login', status: 'passed', evidence: ['Observed dashboard [live:live-2]'] }
  ] };
  const output = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } }),
    JSON.stringify({ type: 'turn.completed' })
  ].join('\n');
  const matching = new Map([['live-2', { checkName: 'Login', status: 'passed', kind: 'text_present' }]]);
  assert.deepEqual(parseOutput('codex', output, { liveEvidence: matching }), report);
  assert.throws(() => parseOutput('codex', output, { liveEvidence: new Map([['live-9', { checkName: 'Login', status: 'passed' }]]) }), /runtime evidence/i);
  assert.throws(() => parseOutput('codex', output, { liveEvidence: new Map([['live-2', { checkName: 'Other', status: 'passed' }]]) }), /deterministic assertion/i);
  assert.throws(() => parseOutput('codex', output, { liveEvidence: new Map([['live-2', { checkName: 'Login', status: 'failed' }]]) }), /deterministic assertion/i);

  const mixedOwnership = structuredClone(report);
  mixedOwnership.checks[0].evidence[0] += ' plus foreign evidence [live:live-7]';
  const mixedOutput = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(mixedOwnership) } }),
    JSON.stringify({ type: 'turn.completed' })
  ].join('\n');
  assert.throws(() => parseOutput('codex', mixedOutput, { liveEvidence: matching }), /unique runtime evidence/i);

  const reused = structuredClone(report);
  reused.checks.push({ name: 'Other feature', status: 'failed', evidence: ['Reused the same operation [live:live-2]'] });
  const reusedOutput = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reused) } }),
    JSON.stringify({ type: 'turn.completed' })
  ].join('\n');
  assert.throws(() => parseOutput('codex', reusedOutput, { liveEvidence: matching }), /unique runtime evidence/i);
});
