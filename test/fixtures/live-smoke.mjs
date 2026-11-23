import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveQaRuntime } from '../../src/live-runtime.mjs';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node test/fixtures/live-smoke.mjs CONFIG_PATH');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const out = await mkdtemp(join(tmpdir(), 'subscription-qa-live-'));
const runtime = new LiveQaRuntime(config, out);

try {
  const doctor = await runtime.doctor();
  if (!doctor.browser.ready) throw new Error(`Browser not ready: ${doctor.browser.reason}`);
  const opened = await runtime.call('smoke', 'browser_open', { path: '/' });
  await runtime.call('smoke', 'browser_fill', { selector: 'input[name="email"]', value: 'qa@example.test' });
  const snapshot = await runtime.call('smoke', 'browser_snapshot', {});
  const screenshot = await runtime.call('smoke', 'browser_screenshot', { name: 'browser-smoke' });
  console.log(JSON.stringify({ doctor, opened, snapshot: { evidenceRef: snapshot.evidenceRef, title: snapshot.title,
    hasExpectedText: snapshot.text.includes('Live QA Ready') }, screenshot }, null, 2));
} finally {
  await runtime.close();
}
