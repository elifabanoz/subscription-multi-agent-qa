import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const clone = value => JSON.parse(JSON.stringify(value ?? {}));

const checkStatuses = ['passed', 'failed', 'source_observation', 'suspected_issue', 'not_tested'];

function summarizeChecks(checks = []) {
  const summary = { total: 0, passed: 0, failed: 0, sourceObservation: 0, suspectedIssue: 0, notTested: 0, unknown: 0 };
  const keys = { passed: 'passed', failed: 'failed', source_observation: 'sourceObservation', suspected_issue: 'suspectedIssue', not_tested: 'notTested' };
  for (const check of checks) {
    summary.total += 1;
    summary[keys[check?.status] ?? 'unknown'] += 1;
  }
  return summary;
}

export function dashboardSnapshot(record = {}) {
  const definitions = new Map((record.taskDefinitions ?? []).map(task => [task.id, task]));
  const taskIds = new Set([...definitions.keys(), ...Object.keys(record.tasks ?? {})]);
  const tasks = [...taskIds].map(id => {
    const state = record.tasks?.[id] ?? {};
    const checks = Array.isArray(state.result?.checks) ? state.result.checks : [];
    return {
      id,
      provider: state.provider ?? definitions.get(id)?.provider ?? null,
      role: definitions.get(id)?.role ?? null,
      focus: definitions.get(id)?.focus ?? null,
      state: state.state ?? 'pending',
      turns: state.turns ?? 0,
      reason: state.reason ?? null,
      followUpState: state.followUpState ?? null,
      followUpReason: state.followUpReason ?? null,
      summary: state.result?.summary ?? null,
      checks: checks.length,
      checkSummary: summarizeChecks(checks),
      checkDetails: checks.map(check => ({
        name: typeof check?.name === 'string' ? check.name : 'Unnamed check',
        status: checkStatuses.includes(check?.status) ? check.status : 'unknown'
      }))
    };
  });
  const messages = (record.messages ?? []).map(message => ({
    id: message.id,
    from: message.from,
    to: message.to,
    kind: message.kind,
    scenarioId: message.scenarioId,
    body: message.body,
    inReplyTo: message.inReplyTo ?? null,
    createdAt: message.createdAt ?? null,
    acknowledged: Boolean(message.acknowledged),
    replyId: message.replyId ?? null
  }));
  const maxMessages = Number.isInteger(record.limits?.maxMessages) && record.limits.maxMessages > 0 ? record.limits.maxMessages : null;
  const repliesReserved = messages.filter(message => ['question', 'task'].includes(message.kind) && !message.replyId).length;
  const messageLabel = `${messages.length} message${messages.length === 1 ? '' : 's'}`;
  const budgetLabel = maxMessages ? [messageLabel, `${messages.length + repliesReserved}/${maxMessages} budget`,
    repliesReserved ? `${repliesReserved} repl${repliesReserved === 1 ? 'y' : 'ies'} reserved` : null,
    tasks.length ? `${Math.max(1, Math.floor(maxMessages / tasks.length))} sends/agent` : null].filter(Boolean).join(' · ') : messageLabel;
  const messageBudget = {
    messagesUsed: messages.length,
    repliesReserved,
    effectiveUsed: messages.length + repliesReserved,
    maxMessages,
    maxMessagesPerAgent: maxMessages && tasks.length ? Math.max(1, Math.floor(maxMessages / tasks.length)) : null,
    label: budgetLabel
  };
  const operations = (record.live?.operations ?? []).map(operation => ({
    id: operation.id,
    agentId: operation.agentId,
    tool: operation.tool,
    timestamp: operation.timestamp,
    artifact: operation.artifact ? basename(operation.artifact) : null,
    verification: operation.verification ? {
      checkName: operation.verification.checkName,
      status: operation.verification.status,
      kind: operation.verification.kind
    } : null
  }));
  const activity = (record.activity ?? []).slice(-250).map(event => ({
    sequence: event.sequence ?? null,
    timestamp: event.timestamp ?? null,
    type: event.type ?? 'unknown',
    agentId: event.agentId ?? null,
    provider: event.provider ?? null,
    turn: event.turn ?? null,
    state: event.state ?? null,
    reason: event.reason ?? null,
    tool: event.tool ?? null,
    artifact: event.artifact ? basename(event.artifact) : null,
    from: event.from ?? null,
    to: event.to ?? null,
    kind: event.kind ?? null,
    scenarioId: event.scenarioId ?? null,
    body: event.body ?? null,
    messageCount: event.messageCount ?? null
  }));
  const failedTasks = tasks.filter(task => ['failed', 'blocked'].includes(task.state));
  const incompleteTasks = tasks.filter(task => !['completed', 'failed', 'blocked'].includes(task.state));
  const followUpGaps = tasks.filter(task => task.followUpState === 'blocked');
  const checkSummary = tasks.reduce((total, task) => {
    for (const key of Object.keys(total)) total[key] += task.checkSummary[key];
    return total;
  }, summarizeChecks());
  const stopReason = record.stopReason ?? null;
  const outcome = !record.finishedAt ? { status: 'running', label: 'In progress', message: 'No agent is in an active turn right now.' } :
    stopReason ? { status: 'interrupted', label: 'Run interrupted', message: `Run stopped: ${stopReason}.` } :
    failedTasks.length ? { status: 'issues', label: 'Completed with issues', message: `${failedTasks.length} agent${failedTasks.length === 1 ? '' : 's'} failed or were blocked.` } :
    incompleteTasks.length ? { status: 'issues', label: 'Run ended with incomplete agents', message: `${incompleteTasks.length} agent${incompleteTasks.length === 1 ? '' : 's'} did not reach a terminal state.` } :
    followUpGaps.length ? { status: 'issues', label: 'Completed with follow-up gaps', message: `${followUpGaps.length} follow-up${followUpGaps.length === 1 ? '' : 's'} could not be processed.` } :
    checkSummary.failed ? { status: 'issues', label: 'Completed with failed checks', message: `${checkSummary.failed} check${checkSummary.failed === 1 ? '' : 's'} failed.` } :
    checkSummary.suspectedIssue ? { status: 'findings', label: 'Review completed with findings', message: `${checkSummary.suspectedIssue} suspected issue${checkSummary.suspectedIssue === 1 ? '' : 's'} require review.` } :
    (checkSummary.notTested || checkSummary.unknown) ? { status: 'review', label: 'Review completed with gaps', message: `${checkSummary.notTested + checkSummary.unknown} check${checkSummary.notTested + checkSummary.unknown === 1 ? '' : 's'} were not tested or could not be classified.` } :
    checkSummary.sourceObservation ? { status: 'review', label: 'Source review completed', message: `${checkSummary.sourceObservation} source observation${checkSummary.sourceObservation === 1 ? '' : 's'} recorded; no runtime pass is implied.` } :
    { status: 'completed', label: 'Completed successfully', message: 'Run complete.' };
  return clone({
    repository: record.repository ?? null,
    commit: record.commit ?? null,
    mode: record.mode ?? null,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    totalTurns: record.totalTurns ?? tasks.reduce((sum, task) => sum + task.turns, 0),
    stopReason,
    outcome,
    checkSummary,
    tasks,
    messages,
    messageBudget,
    operations,
    activity
  });
}

function page({ token = '', initial = null } = {}) {
  const encoded = initial ? Buffer.from(JSON.stringify(initial), 'utf8').toString('base64') : '';
  const prefix = token ? `/${token}` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subscription QA · Team workspace</title>
<style>
:root{color-scheme:light;--bg:#f5f6f8;--panel:#fff;--line:#e4e7ec;--text:#101828;--muted:#667085;--blue:#2e90fa;--green:#12b76a;--amber:#f79009;--red:#f04438;--purple:#7f56d9}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.topbar{height:66px;background:var(--panel);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 24px;position:sticky;top:0;z-index:5}.brand{display:flex;align-items:center;gap:12px}.logo{width:34px;height:34px;border-radius:9px;background:#101828;color:#fff;display:grid;place-items:center;font-weight:750}.brand-name{font-weight:700;font-size:15px}.run-name{color:var(--muted);font-size:12px}.connection{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--amber)}.status-dot.live{background:var(--green)}
.workspace{max-width:1480px;margin:0 auto;padding:18px;display:grid;grid-template-columns:260px minmax(420px,1fr) 330px;gap:14px;height:calc(100vh - 66px)}.pane{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.04);min-height:0}.pane-head{padding:15px 16px 12px;border-bottom:1px solid var(--line)}.pane-title{font-size:13px;font-weight:700}.pane-subtitle{font-size:11px;color:var(--muted);margin-top:2px}
.agents-pane{display:flex;flex-direction:column}.agents{padding:8px;overflow:auto}.agent{padding:11px;border-radius:9px;display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;border:1px solid transparent}.agent+.agent{margin-top:3px}.agent.active{background:#eff8ff;border-color:#dbeafe}.avatar{width:34px;height:34px;border-radius:10px;background:#eef2f6;color:#344054;display:grid;place-items:center;font-weight:700;font-size:12px;text-transform:uppercase}.avatar.codex{background:#eef2ff;color:#4338ca}.avatar.claude{background:#fff4ed;color:#c2410c}.agent-top{min-width:0}.agent-name{display:block;font-weight:650;overflow-wrap:anywhere}.agent-state{display:block;font-size:10px;text-transform:capitalize;color:var(--muted);margin-top:1px}.agent-state:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#98a2b3;margin-right:5px}.agent-state.running:before{background:var(--blue)}.agent-state.completed:before{background:var(--green)}.agent-state.waiting:before{background:var(--amber)}.agent-state.failed:before,.agent-state.blocked:before{background:var(--red)}.agent-meta{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.agent-focus{font-size:11px;color:#475467;margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.agent-checks{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}.check-badge{font-size:9px;border-radius:999px;padding:2px 6px;background:#f2f4f7;color:#475467}.check-badge.passed{background:#ecfdf3;color:#027a48}.check-badge.failed{background:#fef3f2;color:#b42318}.check-badge.suspected_issue{background:#fffaeb;color:#b54708}.check-badge.not_tested,.check-badge.unknown{background:#f2f4f7;color:#475467}.check-badge.source_observation{background:#eef4ff;color:#3538cd}
.chat-pane{display:flex;flex-direction:column}.chat-head{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}.chat-title{font-weight:700}.chat-meta{font-size:11px;color:var(--muted)}.current-work{margin:12px 16px 0;padding:10px 12px;border:1px solid #b2ddff;background:#eff8ff;border-radius:9px;color:#175cd3;font-size:12px;display:flex;gap:8px;align-items:flex-start}.pulse{width:7px;height:7px;border-radius:50%;background:var(--blue);margin-top:5px;flex:0 0 auto}.chat{padding:18px;overflow:auto;flex:1;scroll-behavior:smooth}.chat-empty{height:100%;display:grid;place-items:center;text-align:center;color:var(--muted)}.chat-empty b{display:block;color:#344054;margin-bottom:4px}.chat-message{display:grid;grid-template-columns:36px minmax(0,1fr);gap:10px;max-width:780px}.chat-message.reply{margin-left:44px;max-width:736px}.chat-message+.chat-message{margin-top:18px}.message-main{min-width:0}.message-head{display:flex;align-items:baseline;gap:6px;font-size:12px}.message-head b{font-size:13px}.message-to,.message-time{color:var(--muted)}.message-time{margin-left:auto;font-size:10px}.reply-context{margin-top:5px;padding-left:9px;border-left:2px solid #d0d5dd;color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bubble{display:inline-block;max-width:100%;margin-top:5px;padding:10px 12px;border:1px solid var(--line);border-radius:3px 12px 12px 12px;background:#f9fafb;white-space:pre-wrap;overflow-wrap:anywhere}.chat-message.answer .bubble{background:#ecfdf3;border-color:#d1fadf}.chat-message.question .bubble,.chat-message.task .bubble{background:#fffaeb;border-color:#fef0c7}.message-tags{display:flex;gap:6px;margin-top:6px}.tag{font-size:10px;color:var(--muted);background:#f2f4f7;border-radius:999px;padding:2px 7px}.tag.kind{text-transform:capitalize}
.side{display:grid;grid-template-rows:minmax(0,1fr) auto;gap:14px;min-height:0}.activity-pane{display:flex;flex-direction:column}.activity{padding:7px 14px 12px;overflow:auto}.event{display:grid;grid-template-columns:8px minmax(0,1fr);gap:9px;padding:10px 0;border-bottom:1px solid #f0f2f5}.event:last-child{border-bottom:0}.event-dot{width:7px;height:7px;border-radius:50%;background:#98a2b3;margin-top:6px}.event.message-sent .event-dot{background:var(--purple)}.event.live-tool .event-dot{background:var(--green)}.event.turn-started .event-dot{background:var(--blue)}.event.turn-finished .event-dot{background:var(--amber)}.event-title{font-size:12px;font-weight:650}.event-detail{font-size:11px;color:var(--muted);margin-top:2px;overflow-wrap:anywhere}.event-time{font-size:10px;color:#98a2b3;margin-top:3px}.evidence{padding:10px 14px 14px;max-height:260px;overflow:auto}.evidence-item{padding:9px 0;border-bottom:1px solid #f0f2f5}.evidence-item:last-child{border-bottom:0}.evidence-tool{font:600 11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:#344054}.evidence-meta{font-size:10px;color:var(--muted);margin-top:2px}.empty{padding:24px 12px;text-align:center;color:var(--muted);font-size:12px}.privacy{padding:10px 16px;border-top:1px solid var(--line);color:#98a2b3;font-size:10px}
@media(max-width:1080px){.workspace{grid-template-columns:220px minmax(400px,1fr)}.side{grid-column:1/-1;grid-template-columns:1fr 1fr;grid-template-rows:300px}.activity-pane,.evidence-pane{min-height:0}}@media(max-width:740px){.topbar{padding:0 14px}.workspace{display:block;height:auto;padding:10px}.pane{margin-bottom:10px}.agents-pane{max-height:320px}.chat-pane{height:650px}.chat-message.reply{margin-left:18px}.side{display:block}}
</style></head><body>
<header class="topbar"><div class="brand"><div class="logo">QA</div><div><div class="brand-name">Subscription QA</div><div id="runName" class="run-name">Local run</div></div></div><div class="connection"><span id="connectionDot" class="status-dot"></span><span id="connection">Connecting</span></div></header>
<div class="workspace"><aside class="pane agents-pane"><div class="pane-head"><div class="pane-title">Agents</div><div id="agentSummary" class="pane-subtitle">Waiting for team</div></div><div id="agents" class="agents"></div><div class="privacy">Local workspace · explicit team activity only</div></aside>
<main class="pane chat-pane"><div class="chat-head"><div><div class="chat-title">Team conversation</div><div id="conversationMeta" class="chat-meta">No messages yet</div></div><div id="mode" class="chat-meta"></div></div><div id="currentWork" class="current-work"><span class="pulse"></span><span>Waiting for the first agent turn…</span></div><div id="chat" class="chat"></div></main>
<aside class="side"><section class="pane activity-pane"><div class="pane-head"><div class="pane-title">What’s happening</div><div id="activitySummary" class="pane-subtitle">Live activity</div></div><div id="activity" class="activity"></div></section><section class="pane evidence-pane"><div class="pane-head"><div class="pane-title">Live evidence</div><div id="evidenceSummary" class="pane-subtitle">Browser and Android</div></div><div id="evidence" class="evidence"></div></section></aside></div>
<script>
const initialEncoded=${JSON.stringify(encoded)};const prefix=${JSON.stringify(prefix)};const el=id=>document.getElementById(id);const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n};
const initials=value=>value.split('-').map(part=>part[0]).join('').slice(0,2);const time=value=>value?new Date(value).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
function empty(title,detail=''){const box=node('div','empty');box.append(node('b','',title));if(detail)box.append(node('div','',detail));return box}
function eventCopy(item){if(item.type==='turn.started')return [item.agentId+' started a turn',(item.provider||'agent')+' · turn '+item.turn];if(item.type==='turn.finished')return [item.agentId+' finished a turn',[item.state,item.reason].filter(Boolean).join(' · ')];if(item.type==='message.sent')return [item.from+' messaged '+item.to,[item.kind,item.scenarioId].filter(Boolean).join(' · ')];if(item.type==='mailbox.read')return [item.agentId+' checked the inbox',(item.messageCount||0)+' pending message'+(item.messageCount===1?'':'s')];if(item.type==='message.acknowledged')return [item.agentId+' acknowledged a message','The message was incorporated'];if(item.type==='live.tool')return [item.agentId+' used '+item.tool,item.artifact||'Live QA evidence recorded'];return [item.agentId||'System',item.type]}
function render(data){
  const providers=new Map(data.tasks.map(task=>[task.id,task.provider]));el('runName').textContent=[data.repository,data.commit?.slice(0,10)].filter(Boolean).join(' · ')||'Local QA run';el('mode').textContent=data.mode||'';const running=data.tasks.filter(task=>task.state==='running'),waiting=data.tasks.filter(task=>task.state==='waiting');el('agentSummary').textContent=data.tasks.length+' agents · '+running.length+' active';
  const agents=el('agents');agents.replaceChildren();if(!data.tasks.length)agents.append(empty('No agents yet'));for(const task of data.tasks){const row=node('article','agent '+(task.state==='running'?'active':''));row.append(node('span','avatar '+(task.provider||''),initials(task.id)));const info=node('div');const top=node('div','agent-top');top.append(node('span','agent-name',task.id),node('span','agent-state '+task.state,task.state));info.append(top,node('div','agent-meta',[task.role,task.provider,task.turns+' turns',task.reason,task.followUpReason&&('follow-up: '+task.followUpReason)].filter(Boolean).join(' · ')));if(task.focus)info.append(node('div','agent-focus',task.focus));if(task.checkDetails?.length){const checks=node('div','agent-checks');for(const check of task.checkDetails){const badge=node('span','check-badge '+check.status,check.status.replaceAll('_',' '));badge.title=check.name;checks.append(badge)}info.append(checks)}row.append(info);agents.append(row)}
  const current=el('currentWork');current.replaceChildren(node('span','pulse'));const currentText=node('span');if(running.length)currentText.textContent=running.map(task=>task.id+' is working on: '+(task.focus||task.summary||'assigned review')).join(' · ');else if(waiting.length)currentText.textContent=waiting.map(task=>task.id+' is waiting for a teammate').join(' · ');else currentText.textContent=data.outcome?.message||'Run status unavailable.';current.append(currentText);
  const chat=el('chat'),messagesById=new Map(data.messages.map(item=>[item.id,item]));chat.replaceChildren();el('conversationMeta').textContent=data.messageBudget?.label||(data.messages.length+' messages');if(!data.messages.length)chat.append(empty('No team messages yet','Questions and answers between agents will appear here.'));for(const item of data.messages){const row=node('article','chat-message '+item.kind+(item.inReplyTo?' reply':''));row.append(node('span','avatar '+(providers.get(item.from)||''),initials(item.from)));const main=node('div','message-main');const head=node('div','message-head');head.append(node('b','',item.from),node('span','message-to','to '+item.to),node('time','message-time',time(item.createdAt)));main.append(head);if(item.inReplyTo){const original=messagesById.get(item.inReplyTo),excerpt=typeof original?.body==='string'?original.body.replace(/\s+/g,' ').slice(0,96):'';main.append(node('div','reply-context',original?('Reply to '+original.from+(excerpt?': '+excerpt:'')):'Reply to an earlier message'))}main.append(node('div','bubble',item.body));const tags=node('div','message-tags');tags.append(node('span','tag kind',item.kind),node('span','tag',item.scenarioId));if(item.acknowledged)tags.append(node('span','tag','acknowledged'));main.append(tags);row.append(main);chat.append(row)}if(data.messages.length)chat.scrollTop=chat.scrollHeight;
  const activity=el('activity');activity.replaceChildren();el('activitySummary').textContent=data.activity.length+' events';if(!data.activity.length)activity.append(empty('Nothing to show yet'));for(const item of data.activity.slice().reverse()){const copy=eventCopy(item),row=node('article','event '+item.type.replaceAll('.','-'));row.append(node('span','event-dot'));const body=node('div');body.append(node('div','event-title',copy[0]),node('div','event-detail',copy[1]),node('div','event-time',time(item.timestamp)));row.append(body);activity.append(row)}
  const evidence=el('evidence');evidence.replaceChildren();el('evidenceSummary').textContent=data.operations.length+' recorded';if(!data.operations.length)evidence.append(empty('No live evidence yet'));for(const item of data.operations.slice().reverse()){const row=node('article','evidence-item');row.append(node('div','evidence-tool',item.tool),node('div','evidence-meta',[item.agentId,item.verification&&item.verification.status,item.verification&&item.verification.checkName,item.artifact||item.id,time(item.timestamp)].filter(Boolean).join(' · ')));evidence.append(row)}
}
let stream=null,lastSnapshot=null;function connection(label,live=false){el('connection').textContent=label;el('connectionDot').classList.toggle('live',live)}async function refresh(){const response=await fetch(prefix+'/state',{cache:'no-store'});if(!response.ok)throw new Error('state');const data=await response.json();lastSnapshot=data;render(data);if(data.finishedAt&&stream){stream.close();stream=null;connection(data.outcome?.label||'Run finished',true)}return data}function decode(value){const bytes=Uint8Array.from(atob(value),character=>character.charCodeAt(0));return JSON.parse(new TextDecoder().decode(bytes))}if(initialEncoded){const data=decode(initialEncoded);render(data);connection(data.outcome?.label||'Archived snapshot',true)}else{refresh().then(data=>{if(!data.finishedAt)connection('Live',true)}).catch(()=>connection('Disconnected'));stream=new EventSource(prefix+'/events');stream.addEventListener('update',()=>refresh().catch(()=>connection('Disconnected')));stream.onerror=()=>{if(lastSnapshot?.finishedAt){stream?.close();stream=null;connection(lastSnapshot.outcome?.label||'Run finished',true)}else connection('Reconnecting')}}
</script></body></html>`;
}

export class RunDashboard {
  constructor(initial = {}) { this.token = randomBytes(24).toString('hex'); this.snapshot = dashboardSnapshot(initial); this.clients = new Set(); }
  securityHeaders(response) { response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"); }
  async listen() {
    const prefix = `/${this.token}`;
    this.server = createServer((request, response) => {
      this.securityHeaders(response);if(request.method!=='GET'||!request.url?.startsWith(prefix)){response.writeHead(404);response.end('Not found');return}
      if(request.url===`${prefix}/`){response.setHeader('Content-Type','text/html; charset=utf-8');response.end(page({token:this.token}));return}
      if(request.url===`${prefix}/state`){response.setHeader('Content-Type','application/json; charset=utf-8');response.end(JSON.stringify(this.snapshot));return}
      if(request.url===`${prefix}/events`){response.setHeader('Content-Type','text/event-stream');response.setHeader('Connection','keep-alive');response.write('event: update\ndata: ready\n\n');this.clients.add(response);request.on('close',()=>this.clients.delete(response));return}
      response.writeHead(404);response.end('Not found');
    });
    this.server.requestTimeout=10000;await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve)});const port=this.server.address().port;this.url=`http://127.0.0.1:${port}/${this.token}/`;return this.url;
  }
  update(record) { this.snapshot=dashboardSnapshot(record);for(const response of this.clients)response.write('event: update\ndata: changed\n\n'); }
  async writeStatic(path) { await writeFile(path,page({initial:this.snapshot}),{mode:0o600}); }
  async close() { for(const response of this.clients)response.end();this.clients.clear();if(this.server){this.server.closeAllConnections();await new Promise(resolve=>this.server.close(resolve));} }
}
