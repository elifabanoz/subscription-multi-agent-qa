import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveQaRuntime } from '../../src/live-runtime.mjs';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node test/fixtures/android-smoke.mjs CONFIG_PATH');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const out = await mkdtemp(join(tmpdir(), 'subscription-qa-android-'));
const runtime = new LiveQaRuntime(config, out);

try {
  const doctor = await runtime.doctor();
  if (!doctor.android.ready) throw new Error(`Android not ready: ${doctor.android.reason}`);
  const devices = await runtime.call('smoke', 'android_devices', {});
  const started = await runtime.call('smoke', 'android_start_app', {});
  const ui = await runtime.call('smoke', 'android_dump_ui', {});
  const screenshot = await runtime.call('smoke', 'android_screenshot', { name: 'android-smoke' });
  console.log(JSON.stringify({ doctor, devices: { evidenceRef: devices.evidenceRef,
    hasConfiguredDevice: devices.output.includes(config.live.android.serial) }, started,
    ui: { evidenceRef: ui.evidenceRef, hasHierarchy: ui.xml.includes('<hierarchy') }, screenshot }, null, 2));
} finally {
  await runtime.close();
}
