import { createInterface } from 'node:readline';
import { teamTools, brokerTimeoutMs } from './message-bus.mjs';

// MCP stdio JSON-RPC. stdout is protocol only; all state lives in the authenticated broker.
const endpoint = process.env.SUBSCRIPTION_QA_BUS_URL;
const token = process.env.SUBSCRIPTION_QA_BUS_TOKEN;
let exposedTools;
try {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/tool' || !token) throw new Error();
  const names = JSON.parse(process.env.SUBSCRIPTION_QA_TOOL_NAMES);
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !teamTools.some(tool => tool.name === name)) ||
    new Set(names).size !== names.length) throw new Error();
  exposedTools = teamTools.filter(tool => names.includes(tool.name));
} catch { console.error('Invalid local QA broker configuration.'); process.exit(2); }

const reply = object => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...object }) + '\n');
async function handle(line) {
  let request;
  try { request = JSON.parse(line); }
  catch { reply({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    reply({ id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); return;
  }
  if (request.method === '$/cancelRequest') {
    inFlight.get(request.params?.id)?.abort();
    return;
  }
  if (request.id === undefined) return; // notifications/initialized
  const id = request.id;
  if (request.method === 'initialize') {
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
    const requested = request.params?.protocolVersion;
    reply({ id, result: { protocolVersion: supported.includes(requested) ? requested : '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'subscription-qa-team', version: '0.5.2' },
      instructions: 'Use these tools DURING work to communicate. Check inbox at checkpoints. Yield with decision=waiting when a reply is required; never busy-poll.' } }); return;
  }
  if (request.method === 'ping') { reply({ id, result: {} }); return; }
  if (request.method === 'tools/list') { reply({ id, result: { tools: exposedTools } }); return; }
  if (request.method !== 'tools/call') { reply({ id, error: { code: -32601, message: 'Method not found' } }); return; }
  if (!exposedTools.some(tool => tool.name === request.params?.name)) {
    reply({ id, error: { code: -32602, message: 'Tool is not enabled for this run' } }); return;
  }
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(brokerTimeoutMs(request.params?.name));
  try {
    inFlight.set(id, controller);
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.params), signal: AbortSignal.any([controller.signal, timeout]) });
    const data = await response.json();
    reply({ id, result: { content: [{ type: 'text', text: JSON.stringify(data.result ?? data) }], isError: !response.ok } });
  } catch {
    if (controller.signal.aborted) reply({ id, error: { code: -32800, message: 'Request cancelled' } });
    else reply({ id, result: { content: [{ type: 'text', text: timeout.aborted ? 'QA_BROKER_TIMEOUT' : 'QA_BROKER_UNAVAILABLE' }], isError: true } });
  }
  finally { inFlight.delete(id); }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const inFlight = new Map();
input.on('line', line => {
  if (line.length > 100000) { console.error('MCP input limit exceeded.'); process.exit(2); }
  handle(line).catch(() => { console.error('MCP protocol failure.'); process.exitCode = 2; });
});
