import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { RunDashboard } from '../../src/dashboard.mjs';

const sample = {
  repository: 'example/subscription-qa-target', commit: '4a2695b70877d673', dirtyCheckout: false,
  version: '0.4.4', mode: 'live-team-qa', totalTurns: 5, liveUiTestsExecuted: true, evidenceIndependentlyVerified: false,
  limits: { maxMessages: 100 },
  taskDefinitions: [
    { id: 'inventory', provider: 'codex', role: 'architecture', focus: 'Map architecture, roles and trust boundaries.' },
    { id: 'frontend-client', provider: 'claude', role: 'client QA', focus: 'Exercise browser and Android login, navigation and error states.' },
    { id: 'backend-api', provider: 'codex', role: 'API QA', focus: 'Check ownership, validation and the client/server contract.' }
  ],
  tasks: {
    inventory: { provider: 'codex', state: 'completed', turns: 1, result: { summary: 'Architecture and trust boundaries mapped.', checks: [{ name: 'Inventory', status: 'source_observation' }] } },
    'frontend-client': { provider: 'claude', state: 'running', turns: 2, result: { summary: 'Browser and Android flows are being checked.', checks: [] } },
    'backend-api': { provider: 'codex', state: 'waiting', turns: 2, result: { summary: 'Waiting for the client contract answer.', checks: [{ name: 'Ownership', status: 'not_tested' }] } }
  },
  messages: [
    { id: 'm1', from: 'backend-api', to: 'frontend-client', kind: 'question', scenarioId: 'session-expiry', body: 'Which client state is shown after a 401 response?', createdAt: new Date(Date.now() - 9000).toISOString(), acknowledged: true, replyId: 'm2' },
    { id: 'm2', from: 'frontend-client', to: 'backend-api', kind: 'answer', scenarioId: 'session-expiry', body: 'The login screen is shown and the protected stack is cleared.', inReplyTo: 'm1', createdAt: new Date(Date.now() - 6000).toISOString(), acknowledged: false }
  ],
  activity: [
    { sequence: 1, timestamp: new Date(Date.now() - 12000).toISOString(), type: 'turn.started', agentId: 'frontend-client', provider: 'claude', turn: 2 },
    { sequence: 2, timestamp: new Date(Date.now() - 9000).toISOString(), type: 'message.sent', from: 'backend-api', to: 'frontend-client', kind: 'question', scenarioId: 'session-expiry', body: 'Which client state is shown after a 401 response?' },
    { sequence: 3, timestamp: new Date(Date.now() - 6000).toISOString(), type: 'message.sent', from: 'frontend-client', to: 'backend-api', kind: 'answer', scenarioId: 'session-expiry', body: 'The protected stack is cleared and login is shown.' },
    { timestamp: new Date(Date.now() - 3000).toISOString(), type: 'live.tool', agentId: 'frontend-client', tool: 'android_dump_ui', artifact: null }
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
  assert.equal(await page.locator('.agent').count(), 3);
  assert.equal(await page.locator('.chat-message').count(), 2);
  assert.equal(await page.locator('.reply-context').count(), 1);
  assert.equal(await page.locator('.check-badge').count(), 2);
  assert.match(await page.locator('.check-badge').first().textContent(), /Inventory: source observation/);
  assert.equal(await page.locator('.provenance-chip').count(), 4);
  assert.match(await page.locator('#provenance').textContent(), /checkout clean/);
  assert.match(await page.locator('#provenance').textContent(), /live UI yes/);
  assert.equal(await page.locator('h1').textContent(), 'Subscription QA');
  assert.equal(await page.locator('h2').count(), 4);
  assert.match(await page.locator('.reply-context').textContent(), /Reply to backend-api/);
  assert.equal(await page.locator('#conversationMeta').textContent(), '2 messages · 2/100 budget · 33 sends/agent');
  dashboard.update({ ...sample, finishedAt: new Date().toISOString(), stopReason: 'SMOKE_COMPLETE' });
  await page.waitForFunction(() => document.getElementById('connection')?.textContent === 'Run interrupted');
  assert.equal(await page.locator('#connection').textContent(), 'Run interrupted');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ url, title: await page.title(), agents: await page.locator('.agent').count(),
    messages: await page.locator('.chat-message').count(), activity: await page.locator('.event').count(), screenshot }, null, 2));
} finally {
  await browser.close();
  await dashboard.close();
}
