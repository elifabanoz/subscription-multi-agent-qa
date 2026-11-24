import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { liveTools } from './live-runtime.mjs';

const BODY_MAX_LENGTH = 6000;
const KEY_MAX_LENGTH = 100;
const SCENARIO_ID_MAX_LENGTH = 100;
const SCENARIO_ID_PATTERN = '^[a-zA-Z0-9_.:-]{1,100}$';

export const teamTools = [
  { name: 'send_message', description: 'Immediately send a question, delegated task or finding to a teammate. Stable key makes retries idempotent. If waiting for an answer, finish your turn with decision=waiting instead of repeatedly polling.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['to', 'kind', 'scenarioId', 'body', 'key'], properties: {
      to: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['question', 'task', 'finding'] },
      scenarioId: { type: 'string', minLength: 1, maxLength: SCENARIO_ID_MAX_LENGTH, pattern: SCENARIO_ID_PATTERN },
      body: { type: 'string', minLength: 1, maxLength: BODY_MAX_LENGTH },
      key: { type: 'string', minLength: 1, maxLength: KEY_MAX_LENGTH }
    }
  } },
  { name: 'receive_messages', description: 'Read your unacknowledged messages during work, not only at task completion. Call at start, relevant checkpoints and before final output. Empty means continue your work; do not busy-poll.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'reply_message', description: 'Answer a received question/task. Automatically acknowledges the original and routes a correlated answer to its sender. Include evidence or explain a blocker.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['messageId', 'body', 'key'], properties: {
      messageId: { type: 'string', minLength: 1 }, body: { type: 'string', minLength: 1, maxLength: BODY_MAX_LENGTH },
      key: { type: 'string', minLength: 1, maxLength: KEY_MAX_LENGTH }
    }
  } },
  { name: 'ack_message', description: 'Acknowledge a received finding or answer after incorporating it. Questions/tasks must be answered with reply_message instead.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['messageId'], properties: { messageId: { type: 'string' } }
  } },
  { name: 'get_team_status', description: 'Read the shared task board, teammate identities, states and turn/message budgets.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ...liveTools
];
const liveToolNames = new Set(liveTools.map(tool => tool.name));
export const brokerTimeoutMs = name => liveToolNames.has(name) ? 120000 : 15000;

const asks = message => message.kind === 'question' || message.kind === 'task';
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export class MessageBus {
  constructor(tasks, { maxMessages = 100, maxMessagesPerAgent, eventPath, onEvent = () => {}, toolHandler = null } = {}) {
    this.tasks = new Map(tasks.map(t => [t.id, t]));
    if (!Number.isInteger(maxMessages) || maxMessages < 1) throw new Error('INVALID_MESSAGE_BUDGET');
    const fairShare = Math.max(1, Math.floor(maxMessages / Math.max(1, this.tasks.size)));
    this.maxMessagesPerAgent = maxMessagesPerAgent ?? fairShare;
    if (!Number.isInteger(this.maxMessagesPerAgent) || this.maxMessagesPerAgent < 1) throw new Error('INVALID_AGENT_MESSAGE_BUDGET');
    this.messages = []; this.dedup = new Map(); this.liveDedup = new Map(); this.maxMessages = maxMessages;
    this.sentByAgent = new Map();
    this.eventPath = eventPath; this.onEvent = onEvent; this.closed = false;
    this.tokens = new Map(); this.board = () => ({}); this.counter = 0;
    this.events = new EventEmitter(); this.mailboxReads = new Map();
    this.toolHandler = toolHandler;
  }
  log(type, payload) {
    const event = { sequence: ++this.counter, timestamp: new Date().toISOString(), type, ...payload };
    if (this.eventPath) appendFileSync(this.eventPath, JSON.stringify(event) + '\n', { mode: 0o600 });
    this.onEvent(event);
    this.events.emit('event', event);
  }
  issueToken(agentId) {
    if (!this.tasks.has(agentId)) throw new Error('UNKNOWN_AGENT');
    const token = randomBytes(32).toString('hex'); this.tokens.set(token, agentId); return token;
  }
  revokeToken(token) { this.tokens.delete(token); }
  pending(agentId) { return this.messages.filter(m => m.to === agentId && !m.acknowledged); }
  outstanding(agentId) { return this.messages.filter(m => m.from === agentId && asks(m) && !m.replyId); }
  reservedReplies() { return this.messages.filter(m => asks(m) && !m.replyId).length; }
  budgetUsed() { return this.messages.length + this.reservedReplies(); }
  send(agentId, args, replyTo = null) {
    if (this.closed) throw new Error('RUN_CLOSED');
    if (!this.tasks.has(agentId) || !this.tasks.has(args.to)) throw new Error('UNKNOWN_AGENT');
    if (agentId === args.to) throw new Error('SELF_MESSAGE_NOT_ALLOWED');
    if (!text(args.body, BODY_MAX_LENGTH)) throw new Error('INVALID_BODY');
    if (!text(args.key, KEY_MAX_LENGTH)) throw new Error('INVALID_IDEMPOTENCY_KEY');
    if (typeof args.scenarioId !== 'string' || !new RegExp(SCENARIO_ID_PATTERN).test(args.scenarioId)) throw new Error('INVALID_SCENARIO_ID');
    if (!(replyTo ? args.kind === 'answer' : ['question', 'task', 'finding'].includes(args.kind))) throw new Error('INVALID_KIND');
    const dedupKey = agentId + ':' + args.key;
    const signature = JSON.stringify([args.to, args.kind, args.scenarioId, args.body, replyTo?.id ?? null]);
    const existing = this.dedup.get(dedupKey);
    if (existing) {
      if (existing.signature !== signature) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
      return { ...existing.message, duplicate: true };
    }
    if (replyTo?.replyId) throw new Error('ALREADY_ANSWERED');
    if (!replyTo && (this.sentByAgent.get(agentId) ?? 0) >= this.maxMessagesPerAgent) {
      throw new Error('AGENT_MESSAGE_BUDGET_EXHAUSTED');
    }
    const projectedBudget = this.budgetUsed() + (replyTo ? 0 : 1 + (asks(args) ? 1 : 0));
    if (projectedBudget > this.maxMessages) throw new Error('MESSAGE_BUDGET_EXHAUSTED');
    const message = { id: randomUUID(), from: agentId, to: args.to, kind: args.kind,
      scenarioId: args.scenarioId, body: args.body, inReplyTo: replyTo?.id ?? null,
      createdAt: new Date().toISOString(), acknowledged: false, replyId: null };
    this.log('message.sent', { message: { ...message } });
    this.messages.push(message); this.dedup.set(dedupKey, { signature, message });
    if (!replyTo) this.sentByAgent.set(agentId, (this.sentByAgent.get(agentId) ?? 0) + 1);
    if (replyTo) { replyTo.replyId = message.id; replyTo.acknowledged = true; }
    return { ...message };
  }
  callLive(agentId, name, args, { signal } = {}) {
    if (!text(args.key, KEY_MAX_LENGTH) || !new RegExp(SCENARIO_ID_PATTERN).test(args.key))
      return Promise.reject(new Error('INVALID_IDEMPOTENCY_KEY'));
    const key = `${agentId}:${args.key}`;
    const operationArgs = Object.fromEntries(Object.entries(args).filter(([field]) => field !== 'key').sort(([a], [b]) => a.localeCompare(b)));
    const signature = JSON.stringify([name, operationArgs]);
    const existing = this.liveDedup.get(key);
    if (existing) {
      if (existing.signature !== signature) return Promise.reject(new Error('IDEMPOTENCY_KEY_CONFLICT'));
      return existing.promise;
    }
    const promise = Promise.resolve().then(() => {
      if (signal?.aborted) throw new Error('LIVE_QA_CANCELLED');
      return this.toolHandler(agentId, name, operationArgs, { signal });
    });
    this.liveDedup.set(key, { signature, promise });
    return promise;
  }
  call(agentId, name, args = {}, { signal } = {}) {
    if (!this.tasks.has(agentId)) throw new Error('UNKNOWN_AGENT');
    if (this.closed) throw new Error('RUN_CLOSED');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_ARGUMENTS');
    if (name === 'send_message') return this.send(agentId, args);
    if (name === 'receive_messages') {
      this.mailboxReads.set(agentId, (this.mailboxReads.get(agentId) ?? 0) + 1);
      const messages = this.pending(agentId).map(m => ({ ...m }));
      this.log('mailbox.read', { agentId, ids: messages.map(m => m.id) });
      return { messages, outstandingRequests: this.outstanding(agentId).map(m => ({ id: m.id, to: m.to, scenarioId: m.scenarioId })),
        instruction: 'Messages remain pending until acknowledged or answered. If waiting on a teammate, yield your turn.' };
    }
    if (name === 'get_team_status') return { ...this.board(), messagesUsed: this.messages.length,
      repliesReserved: this.reservedReplies(), messageBudgetUsed: this.budgetUsed(),
      maxMessages: this.maxMessages, maxMessagesPerAgent: this.maxMessagesPerAgent };
    if (liveToolNames.has(name)) {
      if (!this.toolHandler) throw new Error('LIVE_QA_DISABLED');
      return this.callLive(agentId, name, args, { signal });
    }
    const message = this.messages.find(m => m.id === args.messageId);
    if (!message || message.to !== agentId) throw new Error('MESSAGE_NOT_IN_YOUR_MAILBOX');
    if (name === 'reply_message') {
      if (!asks(message)) throw new Error('ONLY_QUESTIONS_OR_TASKS_ACCEPT_REPLIES');
      return this.send(agentId, { to: message.from, kind: 'answer', scenarioId: message.scenarioId, body: args.body, key: args.key }, message);
    }
    if (name === 'ack_message') {
      if (asks(message) && !message.replyId) throw new Error('ANSWER_REQUIRED');
      if (!message.acknowledged) { this.log('message.acknowledged', { agentId, messageId: message.id }); message.acknowledged = true; }
      return { acknowledged: true, messageId: message.id };
    }
    throw new Error('UNKNOWN_TOOL');
  }
  async listen() {
    this.server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      // Only an internal loopback bridge speaks to this endpoint. Browser origins are refused.
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const agentId = this.tokens.get(token);
      if (req.headers.origin || !agentId) { res.writeHead(403); res.end('{"error":"FORBIDDEN"}'); return; }
      if (req.method !== 'POST' || req.url !== '/tool') { res.writeHead(404); res.end('{}'); return; }
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 20000) { res.writeHead(413); res.end('{"error":"REQUEST_TOO_LARGE"}'); return; }
        }
        if (this.tokens.get(token) !== agentId) { res.writeHead(403); res.end('{"error":"FORBIDDEN"}'); return; }
        const request = JSON.parse(body);
        const result = await this.call(agentId, request.name, request.arguments, { signal: controller.signal });
        if (res.destroyed) return;
        res.end(JSON.stringify({ result }));
      } catch (error) {
        if (res.destroyed) return;
        res.writeHead(400); res.end(JSON.stringify({ error: error instanceof SyntaxError ? 'INVALID_JSON' : error.message }));
      }
    });
    this.server.requestTimeout = 125000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${this.server.address().port}/tool`;
  }
  async close() {
    this.closed = true; this.tokens.clear();
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
  }
}
