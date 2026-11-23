import { createInterface } from 'node:readline';
import { teamTools } from './message-bus.mjs';

// MCP stdio JSON-RPC. stdout is protocol only; all state lives in the authenticated broker.
const endpoint = process.env.SUBSCRIPTION_QA_BUS_URL;
const token = process.env.SUBSCRIPTION_QA_BUS_TOKEN;
try {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/tool' || !token) throw new Error();
} catch { console.error('Invalid local QA broker configuration.'); process.exit(2); }

const reply = object => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...object }) + '\n');
async function handle(line) {
  let request;
  try { request = JSON.parse(line); }
  catch { reply({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    reply({ id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); return;
  }
  if (request.id === undefined) return; // notifications/initialized and cancellation
  const id = request.id;
  if (request.method === 'initialize') {
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
    const requested = request.params?.protocolVersion;
    reply({ id, result: { protocolVersion: supported.includes(requested) ? requested : '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'subscription-qa-team', version: '0.3.5' },
      instructions: 'Use these tools DURING work to communicate. Check inbox at checkpoints. Yield with decision=waiting when a reply is required; never busy-poll.' } }); return;
  }
  if (request.method === 'ping') { reply({ id, result: {} }); return; }
  if (request.method === 'tools/list') { reply({ id, result: { tools: teamTools } }); return; }
  if (request.method !== 'tools/call') { reply({ id, error: { code: -32601, message: 'Method not found' } }); return; }
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.params), signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    reply({ id, result: { content: [{ type: 'text', text: JSON.stringify(data.result ?? data) }], isError: !response.ok } });
  } catch { reply({ id, result: { content: [{ type: 'text', text: 'QA_BROKER_UNAVAILABLE' }], isError: true } }); }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on('line', line => {
  if (line.length > 100000) { console.error('MCP input limit exceeded.'); process.exit(2); }
  queue = queue.then(() => handle(line)).catch(() => { console.error('MCP protocol failure.'); process.exitCode = 2; });
});
