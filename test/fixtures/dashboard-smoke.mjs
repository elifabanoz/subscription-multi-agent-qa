import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { RunDashboard } from '../../src/dashboard.mjs';

const sample = {
  repository: 'example/subscription-qa-target', commit: '4a2695b70877d673', mode: 'live-team-qa', totalTurns: 5,
  tasks: {
    inventory: { provider: 'codex', state: 'completed', turns: 1, result: { summary: 'Architecture and trust boundaries mapped.', checks: [{ name: 'Inventory' }] } },
    'frontend-client': { provider: 'claude', state: 'running', turns: 2, result: { summary: 'Browser and Android flows are being checked.', checks: [] } },
    'backend-api': { provider: 'codex', state: 'waiting', turns: 2, result: { summary: 'Waiting for the client contract answer.', checks: [{ name: 'Ownership' }] } }
  },
  messages: [
    { id: 'm1', from: 'backend-api', to: 'frontend-client', kind: 'question', scenarioId: 'session-expiry', body: 'Which client state is shown after a 401 response?', acknowledged: true, replyId: 'm2' },
    { id: 'm2', from: 'frontend-client', to: 'backend-api', kind: 'answer', scenarioId: 'session-expiry', body: 'The login screen is shown and the protected stack is cleared.', acknowledged: false }
  ],
  live: { operations: [
    { id: 'live-1', agentId: 'frontend-client', tool: 'browser_screenshot', timestamp: new Date().toISOString(), artifact: '/private/login.png' },
    { id: 'live-2', agentId: 'frontend-client', tool: 'android_dump_ui', timestamp: new Date().toISOString(), artifact: null }
  ] }
};

const directory = await mkdtemp(join(tmpdir(), 'subscription-qa-dashboard-smoke-'));
const screenshot = join(directory, 'dashboard.png');
const dashboard = new RunDashboard(sample);
const url = await dashboard.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ url, title: await page.title(), agents: await page.locator('.agent').count(),
    messages: await page.locator('.message').count(), screenshot }, null, 2));
} finally {
  await browser.close();
  await dashboard.close();
}
