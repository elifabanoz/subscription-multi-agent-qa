import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { runProcess } from './core.mjs';

const empty = { type: 'object', properties: {}, additionalProperties: false };
const rawLiveTools = [
  { name: 'browser_open', description: 'Open a configured local or staging URL in your isolated browser session.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } }
  } },
  { name: 'browser_reset_context', description: 'Close and discard your isolated browser context, including cookies and local storage, before a fresh authentication scenario.', inputSchema: empty },
  { name: 'browser_snapshot', description: 'Read the current page URL, title, visible text and interactive controls.', inputSchema: empty },
  { name: 'browser_click', description: 'Click the first element matching a CSS selector.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['selector'], properties: { selector: { type: 'string' } }
  } },
  { name: 'browser_fill', description: 'Fill an input or textarea selected by CSS.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['selector', 'value'], properties: {
      selector: { type: 'string' }, value: { type: 'string' }
    }
  } },
  { name: 'browser_select', description: 'Select an option value in a select element.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['selector', 'value'], properties: {
      selector: { type: 'string' }, value: { type: 'string' }
    }
  } },
  { name: 'browser_press', description: 'Press a keyboard key on an element selected by CSS.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['selector', 'keyboardKey'], properties: {
      selector: { type: 'string' }, keyboardKey: { type: 'string' }
    }
  } },
  { name: 'browser_assert_text', description: 'Deterministically assert whether visible page text is present or absent. The check name must exactly match the reported check.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['check', 'text'], properties: {
      check: { type: 'string' }, text: { type: 'string' }, present: { type: 'boolean' }
    }
  } },
  { name: 'browser_assert_url', description: 'Deterministically assert the current URL against a configured-origin path. The check name must exactly match the reported check.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['check', 'path'], properties: {
      check: { type: 'string' }, path: { type: 'string' }, queryMode: { type: 'string', enum: ['exact', 'ignore'] }
    }
  } },
  { name: 'browser_screenshot', description: 'Save a full-page PNG in the run evidence directory.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } }
  } },
  { name: 'android_devices', description: 'List Android devices and emulators visible to the configured adb command.', inputSchema: empty },
  { name: 'android_start_app', description: 'Start the configured Android package on the selected device.', inputSchema: empty },
  { name: 'android_dump_ui', description: 'Read the current Android UI hierarchy from the selected device.', inputSchema: empty },
  { name: 'android_assert_text', description: 'Deterministically assert whether Android UI text is present or absent. The check name must exactly match the reported check.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['check', 'text'], properties: {
      check: { type: 'string' }, text: { type: 'string' }, present: { type: 'boolean' }
    }
  } },
  { name: 'android_tap', description: 'Tap an Android screen coordinate.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['x', 'y'], properties: {
      x: { type: 'integer', minimum: 0, maximum: 10000 }, y: { type: 'integer', minimum: 0, maximum: 10000 }
    }
  } },
  { name: 'android_swipe', description: 'Swipe between Android screen coordinates.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['x1', 'y1', 'x2', 'y2', 'durationMs'], properties: {
      x1: { type: 'integer', minimum: 0, maximum: 10000 }, y1: { type: 'integer', minimum: 0, maximum: 10000 },
      x2: { type: 'integer', minimum: 0, maximum: 10000 }, y2: { type: 'integer', minimum: 0, maximum: 10000 },
      durationMs: { type: 'integer', minimum: 50, maximum: 5000 }
    }
  } },
  { name: 'android_input_text', description: 'Type restricted safe text into the focused Android field.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } }
  } },
  { name: 'android_back', description: 'Press the Android back button.', inputSchema: empty },
  { name: 'android_screenshot', description: 'Save an Android PNG in the run evidence directory.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } }
  } }
];

const idempotencyKey = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_.:-]{1,100}$' };
export const liveTools = rawLiveTools.map(tool => ({ ...tool, inputSchema: {
  ...tool.inputSchema,
  required: [...(tool.inputSchema.required ?? []), 'key'],
  properties: { ...tool.inputSchema.properties, key: idempotencyKey }
} }));

const bounded = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const decodeXmlEntities = value => value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, code) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const normalized = code.toLowerCase();
  if (named[normalized]) return named[normalized];
  const point = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
});
const androidVisibleText = xml => [...xml.matchAll(/\b(?:text|content-desc)="([^"]*)"/g)]
  .map(match => decodeXmlEntities(match[1])).filter(Boolean).join('\n');
const fileName = value => {
  if (!bounded(value, 80) || !/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error('INVALID_ARTIFACT_NAME');
  return value.endsWith('.png') ? value : `${value}.png`;
};

export class LiveQaRuntime {
  constructor(config, out, { browserType = chromium, execute = runProcess, onOperation = () => {} } = {}) {
    this.config = config.live ?? {};
    this.out = out;
    this.browserType = browserType;
    this.execute = execute;
    this.browser = null;
    this.browserLaunch = null;
    this.closed = false;
    this.pages = new Map();
    this.operationQueues = new Map();
    this.operations = [];
    this.sequence = 0;
    this.onOperation = onOperation;
  }
  capabilities() {
    return { browser: Boolean(this.config.browser?.enabled), android: Boolean(this.config.android?.enabled) };
  }
  evidenceIds(agentId) {
    return new Set(this.operations.filter(item => item.agentId === agentId).map(item => item.id));
  }
  evidenceFor(agentId) {
    return new Map(this.operations.filter(item => item.agentId === agentId).map(item => [item.id, item.verification ?? null]));
  }
  summary() {
    return { capabilities: this.capabilities(), operations: this.operations.map(item => ({ ...item })) };
  }
  async doctor() {
    const result = {
      browser: { enabled: Boolean(this.config.browser?.enabled), ready: false, reason: 'DISABLED' },
      android: { enabled: Boolean(this.config.android?.enabled), ready: false, reason: 'DISABLED' }
    };
    if (result.browser.enabled) {
      try {
        const browser = await this.browserType.launch({ headless: this.config.browser.headless !== false });
        await browser.close();
        result.browser = { enabled: true, ready: true, reason: 'CHROMIUM_READY' };
      } catch { result.browser = { enabled: true, ready: false, reason: 'CHROMIUM_NOT_READY' }; }
    }
    if (result.android.enabled) {
      try {
        const output = await this.adb(['devices', '-l'], 20000, { useSerial: false });
        const serial = this.config.android.serial;
        const ready = output.split(/\r?\n/).some(line => {
          const [device, state] = line.trim().split(/\s+/);
          return state === 'device' && (!serial || device === serial);
        });
        result.android = { enabled: true, ready, reason: ready ? 'ANDROID_DEVICE_READY' : 'ANDROID_DEVICE_NOT_READY' };
      } catch { result.android = { enabled: true, ready: false, reason: 'ADB_NOT_READY' }; }
    }
    return result;
  }
  record(agentId, tool, data = {}) {
    const item = { id: `live-${++this.sequence}`, agentId, tool, timestamp: new Date().toISOString(), artifact: data.artifact ?? null,
      verification: data.verification ?? null };
    this.operations.push(item);
    this.onOperation({ ...item });
    return { evidenceRef: `[live:${item.id}]`, ...data };
  }
  async page(agentId) {
    if (!this.config.browser?.enabled) throw new Error('BROWSER_LIVE_QA_DISABLED');
    if (!this.browser) {
      if (!this.browserLaunch) this.browserLaunch = this.browserType.launch({ headless: this.config.browser.headless !== false })
        .then(browser => { this.browser = browser; return browser; })
        .finally(() => { this.browserLaunch = null; });
      await this.browserLaunch;
    }
    if (!this.pages.has(agentId)) {
      const context = await this.browser.newContext();
      const allowed = this.allowedOrigins();
      await context.route('**/*', route => {
        const requestUrl = new URL(route.request().url());
        if (!['http:', 'https:'].includes(requestUrl.protocol) || !allowed.has(requestUrl.origin))
          return route.abort('blockedbyclient');
        return route.continue();
      });
      this.pages.set(agentId, { context, page: await context.newPage() });
    }
    return this.pages.get(agentId).page;
  }
  target(path) {
    if (!bounded(path, 2000)) throw new Error('INVALID_BROWSER_PATH');
    const browser = this.config.browser;
    const url = new URL(path, browser.baseUrl);
    const allowed = this.allowedOrigins();
    if (!allowed.has(url.origin)) throw new Error('BROWSER_ORIGIN_NOT_ALLOWED');
    return url.href;
  }
  allowedOrigins() {
    const browser = this.config.browser;
    return new Set(browser.allowedOrigins ?? [new URL(browser.baseUrl).origin]);
  }
  assertPageAllowed(page) {
    const current = new URL(page.url());
    if (!['http:', 'https:'].includes(current.protocol) || !this.allowedOrigins().has(current.origin))
      throw new Error('BROWSER_REDIRECT_OR_NAVIGATION_NOT_ALLOWED');
  }
  verification(checkName, status, kind) {
    if (!bounded(checkName, 200)) throw new Error('INVALID_CHECK_NAME');
    return { checkName: checkName.trim(), status, kind };
  }
  async androidUiXml() {
    const remote = `/sdcard/subscription-qa-${process.pid}-${randomUUID()}.xml`;
    try {
      await this.adb(['shell', 'uiautomator', 'dump', remote]);
      return await this.adb(['shell', 'cat', remote]);
    }
    finally { await this.adb(['shell', 'rm', '-f', remote]).catch(() => {}); }
  }
  async assertAndroidAppForeground() {
    const output = await this.adb(['shell', 'dumpsys', 'window', 'windows']);
    const focused = output.split(/\r?\n/).filter(line => /mCurrentFocus|mFocusedApp/.test(line)).join('\n');
    const escaped = this.config.android.package.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?:^|[\\s{])${escaped}/`).test(focused)) throw new Error('ANDROID_APP_NOT_FOREGROUND');
  }
  selector(value) {
    if (!bounded(value, 500)) throw new Error('INVALID_SELECTOR');
    return value;
  }
  async adb(args, timeoutMs = 20000, { useSerial = true } = {}) {
    if (!this.config.android?.enabled) throw new Error('ANDROID_LIVE_QA_DISABLED');
    const android = this.config.android;
    const serial = useSerial && android.serial ? ['-s', android.serial] : [];
    const result = await this.execute(android.adbCommand ?? 'adb', [...serial, ...args], { timeoutMs });
    if (result.code !== 0 || result.timedOut || result.overflow) throw new Error('ADB_COMMAND_FAILED');
    return result.stdout;
  }
  async adbBinary(args, timeoutMs = 30000) {
    if (!this.config.android?.enabled) throw new Error('ANDROID_LIVE_QA_DISABLED');
    const android = this.config.android;
    const serial = android.serial ? ['-s', android.serial] : [];
    const result = await this.execute(android.adbCommand ?? 'adb', [...serial, ...args], { timeoutMs, binaryStdout: true });
    if (result.code !== 0 || result.timedOut || result.overflow || !Buffer.isBuffer(result.stdout)) throw new Error('ADB_COMMAND_FAILED');
    return result.stdout;
  }
  async artifactPath(agentId, name) {
    const directory = join(this.out, 'live-artifacts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return join(directory, `${agentId}-${fileName(name)}`);
  }
  call(agentId, name, args = {}) {
    if (this.closed) return Promise.reject(new Error('LIVE_QA_CLOSED'));
    const queueKey = name.startsWith('android_') ? 'android-device' : `browser:${agentId}`;
    const previous = this.operationQueues.get(queueKey) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.performCall(agentId, name, args));
    this.operationQueues.set(queueKey, operation);
    operation.finally(() => {
      if (this.operationQueues.get(queueKey) === operation) this.operationQueues.delete(queueKey);
    }).catch(() => {});
    return operation;
  }
  async performCall(agentId, name, args = {}) {
    if (name.startsWith('browser_')) {
      if (name === 'browser_reset_context') {
        if (!this.config.browser?.enabled) throw new Error('BROWSER_LIVE_QA_DISABLED');
        const existing = this.pages.get(agentId);
        if (existing) {
          try { await existing.context.close(); }
          finally { this.pages.delete(agentId); }
        }
        return this.record(agentId, name, { reset: true });
      }
      const page = await this.page(agentId);
      if (name === 'browser_open') {
        const url = this.target(args.path);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.browser.timeoutMs ?? 30000 });
        this.assertPageAllowed(page);
        return this.record(agentId, name, { url: page.url(), title: await page.title() });
      }
      this.assertPageAllowed(page);
      if (name === 'browser_snapshot') {
        const text = (await page.locator('body').innerText({ timeout: 10000 })).slice(0, 20000);
        const controls = await page.locator('a,button,input,select,textarea,[role]').evaluateAll(nodes => nodes.slice(0, 100).map(node => ({
          tag: node.tagName.toLowerCase(), role: node.getAttribute('role'), type: node.getAttribute('type'),
          name: node.getAttribute('aria-label') || node.getAttribute('name'), text: (node.innerText || '').slice(0, 200)
        })));
        return this.record(agentId, name, { url: page.url(), title: await page.title(), text, controls });
      }
      if (name === 'browser_assert_text') {
        if (!bounded(args.text, 1000)) throw new Error('INVALID_ASSERTION_TEXT');
        const visibleText = await page.locator('body').innerText({ timeout: 10000 });
        const matched = visibleText.includes(args.text);
        const passed = args.present === false ? !matched : matched;
        const status = passed ? 'passed' : 'failed';
        return this.record(agentId, name, { assertionStatus: status,
          verification: this.verification(args.check, status, args.present === false ? 'text_absent' : 'text_present') });
      }
      if (name === 'browser_assert_url') {
        const expected = this.target(args.path);
        const actualUrl = new URL(page.url());
        const expectedUrl = new URL(expected);
        const passed = args.queryMode === 'ignore' ?
          actualUrl.origin === expectedUrl.origin && actualUrl.pathname === expectedUrl.pathname && actualUrl.hash === expectedUrl.hash :
          actualUrl.href === expectedUrl.href;
        const status = passed ? 'passed' : 'failed';
        return this.record(agentId, name, { assertionStatus: status,
          verification: this.verification(args.check, status, args.queryMode === 'ignore' ? 'url_equals_ignoring_query' : 'url_equals') });
      }
      if (name === 'browser_screenshot') {
        const artifact = await this.artifactPath(agentId, args.name);
        await page.screenshot({ path: artifact, fullPage: true,
          mask: [page.locator('input,textarea,[contenteditable="true"]')], maskColor: '#000000' });
        return this.record(agentId, name, { artifact, url: page.url() });
      }
      const locator = page.locator(this.selector(args.selector)).first();
      if (name === 'browser_click') await locator.click({ timeout: 10000 });
      else if (name === 'browser_fill') {
        if (!bounded(args.value, 10000)) throw new Error('INVALID_FILL_VALUE');
        await locator.fill(args.value, { timeout: 10000 });
      } else if (name === 'browser_select') {
        if (!bounded(args.value, 500)) throw new Error('INVALID_SELECT_VALUE');
        await locator.selectOption(args.value, { timeout: 10000 });
      } else if (name === 'browser_press') {
        if (!bounded(args.keyboardKey, 80)) throw new Error('INVALID_KEY');
        await locator.press(args.keyboardKey, { timeout: 10000 });
      } else throw new Error('UNKNOWN_LIVE_TOOL');
      this.assertPageAllowed(page);
      return this.record(agentId, name, { url: page.url() });
    }
    if (name === 'android_devices') {
      const output = await this.adb(['devices', '-l'], 20000, { useSerial: false });
      return this.record(agentId, name, { output: output.slice(0, 10000) });
    }
    if (name === 'android_start_app') {
      const packageName = this.config.android.package;
      const activity = this.config.android.activity;
      if (activity) await this.adb(['shell', 'am', 'start', '-W', '-n', activity]);
      else await this.adb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1']);
      return this.record(agentId, name, { package: packageName, activity: activity ?? null });
    }
    if (name.startsWith('android_')) await this.assertAndroidAppForeground();
    if (name === 'android_dump_ui') {
      const xml = await this.androidUiXml();
      return this.record(agentId, name, { xml: xml.slice(0, 50000) });
    }
    if (name === 'android_assert_text') {
      if (!bounded(args.text, 1000)) throw new Error('INVALID_ASSERTION_TEXT');
      const xml = await this.androidUiXml();
      const matched = androidVisibleText(xml).includes(args.text);
      const passed = args.present === false ? !matched : matched;
      const status = passed ? 'passed' : 'failed';
      return this.record(agentId, name, { assertionStatus: status,
        verification: this.verification(args.check, status, args.present === false ? 'text_absent' : 'text_present') });
    }
    if (name === 'android_tap') {
      if (!integer(args.x, 0, 10000) || !integer(args.y, 0, 10000)) throw new Error('INVALID_ANDROID_COORDINATE');
      await this.adb(['shell', 'input', 'tap', String(args.x), String(args.y)]);
      return this.record(agentId, name, { x: args.x, y: args.y });
    }
    if (name === 'android_swipe') {
      if (![args.x1, args.y1, args.x2, args.y2].every(value => integer(value, 0, 10000)) || !integer(args.durationMs, 50, 5000))
        throw new Error('INVALID_ANDROID_SWIPE');
      await this.adb(['shell', 'input', 'swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2), String(args.durationMs)]);
      return this.record(agentId, name, { from: [args.x1, args.y1], to: [args.x2, args.y2] });
    }
    if (name === 'android_input_text') {
      if (!bounded(args.text, 500) || !/^[a-zA-Z0-9@._%+ -]+$/.test(args.text)) throw new Error('ANDROID_TEXT_NOT_SAFE');
      await this.adb(['shell', 'input', 'text', args.text.replaceAll(' ', '%s')]);
      return this.record(agentId, name);
    }
    if (name === 'android_back') {
      await this.adb(['shell', 'input', 'keyevent', '4']);
      return this.record(agentId, name);
    }
    if (name === 'android_screenshot') {
      const artifact = await this.artifactPath(agentId, args.name);
      const png = await this.adbBinary(['exec-out', 'screencap', '-p']);
      if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error('INVALID_ANDROID_SCREENSHOT');
      await writeFile(artifact, png, { mode: 0o600 });
      return this.record(agentId, name, { artifact });
    }
    throw new Error('UNKNOWN_LIVE_TOOL');
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.operationQueues.values()]);
    for (const { context } of this.pages.values()) await context.close().catch(() => {});
    this.pages.clear();
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}
