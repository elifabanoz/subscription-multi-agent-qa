import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { RunDashboard } from '../src/dashboard.mjs';
import { createDemoRecord } from '../src/demo.mjs';

const root = resolve(import.meta.dirname, '..');
const imageDirectory = join(root, 'docs', 'assets');
const videoDirectory = join(root, 'runs', 'linkedin');
await mkdir(imageDirectory, { recursive: true });
await mkdir(videoDirectory, { recursive: true });

const base = createDemoRecord();
const first = structuredClone(base);
first.tasks.inventory.state = 'running'; first.tasks.inventory.result = { summary: 'Reading source and mapping trust boundaries.', checks: [] };
first.tasks['frontend-client'].state = 'pending'; first.tasks['frontend-client'].turns = 0;
first.tasks['backend-api'].state = 'pending'; first.tasks['backend-api'].turns = 0;
first.messages = []; first.activity = first.activity.slice(0, 1); first.live.operations = [];

const dashboard = new RunDashboard(first);
const url = await dashboard.listen();
const temporaryVideo = await mkdtemp(join(tmpdir(), 'subscription-qa-demo-'));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 },
    recordVideo: { dir: temporaryVideo, size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);

  const second = structuredClone(base); second.messages = second.messages.slice(0, 1);
  second.activity = second.activity.slice(0, 2); second.live.operations = [];
  dashboard.update(second); await page.waitForTimeout(4500);

  dashboard.update(base); await page.waitForTimeout(5000);

  const finished = structuredClone(base);
  finished.finishedAt = new Date().toISOString();
  finished.tasks['frontend-client'] = { provider: 'claude', state: 'completed', turns: 2,
    result: { summary: 'Client flows reviewed.', checks: [{ name: 'Session expiry', status: 'passed' }] } };
  finished.tasks['backend-api'] = { provider: 'codex', state: 'completed', turns: 2,
    result: { summary: 'Ownership checks reviewed.', checks: [{ name: 'Ownership', status: 'source_observation' }] } };
  dashboard.update(finished); await page.waitForTimeout(5000);

  const video = page.video();
  await context.close();
  const videoPath = await video.path();
  const webm = join(videoDirectory, 'subscription-qa-dashboard-demo.webm');
  await copyFile(videoPath, webm);

  const screenshotContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const screenshotPage = await screenshotContext.newPage();
  await screenshotPage.goto(url, { waitUntil: 'networkidle' });
  const png = join(imageDirectory, 'dashboard-preview.png');
  await screenshotPage.screenshot({ path: png, fullPage: true });
  await screenshotContext.close();
  console.log(JSON.stringify({ url, png, webm, synthetic: true }, null, 2));
} finally {
  await browser.close();
  await dashboard.close();
}
