import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RunDashboard } from './dashboard.mjs';

export function createDemoRecord(now = Date.now()) {
  const at = offset => new Date(now + offset).toISOString();
  return {
    repository: 'example/subscription-qa-target', commit: '4a2695b70877d673', dirtyCheckout: false,
    version: '0.5.3', mode: 'synthetic-dashboard-demo', totalTurns: 5,
    liveUiTestsExecuted: true, evidenceIndependentlyVerified: false,
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
      { id: 'm1', from: 'backend-api', to: 'frontend-client', kind: 'question', scenarioId: 'session-expiry', body: 'Which client state is shown after a 401 response?', createdAt: at(-9000), acknowledged: true, replyId: 'm2' },
      { id: 'm2', from: 'frontend-client', to: 'backend-api', kind: 'answer', scenarioId: 'session-expiry', body: 'The login screen is shown and the protected stack is cleared.', inReplyTo: 'm1', createdAt: at(-6000), acknowledged: false }
    ],
    activity: [
      { sequence: 1, timestamp: at(-12000), type: 'turn.started', agentId: 'frontend-client', provider: 'claude', turn: 2 },
      { sequence: 2, timestamp: at(-9000), type: 'message.sent', from: 'backend-api', to: 'frontend-client', kind: 'question', scenarioId: 'session-expiry', body: 'Which client state is shown after a 401 response?' },
      { sequence: 3, timestamp: at(-6000), type: 'message.sent', from: 'frontend-client', to: 'backend-api', kind: 'answer', scenarioId: 'session-expiry', body: 'The protected stack is cleared and login is shown.' },
      { sequence: 4, timestamp: at(-3000), type: 'live.tool', agentId: 'frontend-client', tool: 'android_dump_ui', artifact: null }
    ],
    live: { capabilities: { browser: true, android: true, androidScreenshots: false }, operations: [
      { id: 'live-1', agentId: 'frontend-client', tool: 'browser_screenshot', timestamp: at(-2000), artifact: '/synthetic/login.png' },
      { id: 'live-2', agentId: 'frontend-client', tool: 'android_dump_ui', timestamp: at(-1000), artifact: null }
    ] }
  };
}

export async function startDemo() {
  const dashboard = new RunDashboard(createDemoRecord());
  const url = await dashboard.listen();
  console.log(`Synthetic dashboard demo: ${url}`);
  console.log('No agents, subscriptions or target applications are used. Press Ctrl+C to stop.');
  const stop = async () => { await dashboard.close(); process.exitCode = 0; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { dashboard, url };
}

const main = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (main) startDemo().catch(error => { console.error(error.message); process.exitCode = 1; });
