import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const clone = value => JSON.parse(JSON.stringify(value ?? {}));

export function dashboardSnapshot(record = {}) {
  const definitions = new Map((record.taskDefinitions ?? []).map(task => [task.id, task]));
  const taskIds = new Set([...definitions.keys(), ...Object.keys(record.tasks ?? {})]);
  const tasks = [...taskIds].map(id => {
    const state = record.tasks?.[id] ?? {};
    return ({
    id,
    provider: state.provider ?? definitions.get(id)?.provider ?? null,
    role: definitions.get(id)?.role ?? null,
    focus: definitions.get(id)?.focus ?? null,
    state: state.state ?? 'pending',
    turns: state.turns ?? 0,
    reason: state.reason ?? null,
    summary: state.result?.summary ?? null,
    checks: Array.isArray(state.result?.checks) ? state.result.checks.length : 0
  });
  });
  const messages = (record.messages ?? []).map(message => ({
    id: message.id,
    from: message.from,
    to: message.to,
    kind: message.kind,
    scenarioId: message.scenarioId,
    body: message.body,
    acknowledged: Boolean(message.acknowledged),
    replyId: message.replyId ?? null
  }));
  const operations = (record.live?.operations ?? []).map(operation => ({
    id: operation.id,
    agentId: operation.agentId,
    tool: operation.tool,
    timestamp: operation.timestamp,
    artifact: operation.artifact ? basename(operation.artifact) : null
  }));
  const activity = (record.activity ?? []).slice(-250).map(event => ({
    sequence: event.sequence ?? null,
    timestamp: event.timestamp ?? null,
    type: event.type,
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
  return clone({
    repository: record.repository ?? null,
    commit: record.commit ?? null,
    mode: record.mode ?? null,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    totalTurns: record.totalTurns ?? tasks.reduce((sum, task) => sum + task.turns, 0),
    stopReason: record.stopReason ?? null,
    tasks,
    messages,
    operations,
    activity
  });
}

function page({ token = '', initial = null } = {}) {
  const encoded = initial ? Buffer.from(JSON.stringify(initial), 'utf8').toString('base64') : '';
  const prefix = token ? `/${token}` : '';
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subscription QA · Canlı Agent Paneli</title>
<style>
:root{color-scheme:dark;--bg:#08111f;--panel:#0f1b2d;--line:#24334a;--text:#eef4ff;--muted:#93a4be;--blue:#60a5fa;--green:#34d399;--amber:#fbbf24;--red:#fb7185;--purple:#c084fc}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% -10%,#17315d 0,transparent 36%),var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:auto;padding:32px 20px 56px}header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:24px}h1{font-size:clamp(25px,4vw,42px);line-height:1.05;margin:0 0 8px}h2{font-size:18px;margin:0}.eyebrow{color:var(--blue);font-weight:800;letter-spacing:.12em;text-transform:uppercase;font-size:11px}.muted{color:var(--muted)}.connection{display:flex;align-items:center;gap:8px;color:var(--muted);white-space:nowrap}.dot{width:9px;height:9px;border-radius:50%;background:var(--amber);box-shadow:0 0 14px currentColor}.dot.live{background:var(--green)}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}.metric,.panel{background:linear-gradient(145deg,rgba(20,35,58,.96),rgba(12,24,42,.96));border:1px solid var(--line);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.18)}.metric{padding:16px}.metric b{display:block;font-size:25px;margin-top:3px}.metric span{color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:18px}.panel{padding:18px;min-width:0}.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.count{color:var(--muted);font-size:12px}
.agents{display:grid;gap:10px}.agent{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:13px;border:1px solid var(--line);border-radius:13px;background:rgba(5,12,24,.35)}.agent.running{border-color:#2866a7;box-shadow:inset 3px 0 #60a5fa}.agent-name{font-weight:800}.agent-meta{font-size:12px;color:var(--muted)}.agent-focus{font-size:13px;color:#c8d5e8;margin-top:7px}.badge{align-self:start;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:800;text-transform:uppercase;background:#24334a}.badge.running{background:#123d70;color:#93c5fd}.badge.completed{background:#0d473b;color:#6ee7b7}.badge.failed,.badge.blocked{background:#5b1d2c;color:#fda4af}.badge.waiting{background:#523b0d;color:#fde68a}
.timeline{display:grid;gap:12px;max-height:560px;overflow:auto;padding-right:4px}.message{position:relative;padding:13px 14px 13px 17px;border:1px solid var(--line);border-radius:13px;background:rgba(5,12,24,.35)}.message:before{content:"";position:absolute;left:0;top:13px;bottom:13px;width:3px;border-radius:3px;background:var(--purple)}.message.question:before,.message.task:before{background:var(--amber)}.message.answer:before{background:var(--green)}.route{font-weight:800;font-size:13px}.kind{float:right;color:var(--muted);font-size:11px;text-transform:uppercase}.scenario{color:var(--blue);font-size:11px;margin:3px 0 7px}.body{white-space:pre-wrap;overflow-wrap:anywhere}.empty{padding:28px 12px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:13px}
.wide{grid-column:1/-1}.now-panel{margin-bottom:18px}.now{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.now-card{padding:14px;border:1px solid #2866a7;border-radius:13px;background:linear-gradient(135deg,rgba(21,67,115,.38),rgba(5,12,24,.35))}.now-card b{display:block}.now-card span{display:block;color:var(--muted);font-size:12px;margin-top:4px}.activity-list{display:grid;gap:9px;max-height:520px;overflow:auto;padding-right:4px}.event{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:10px;align-items:start;padding:10px 0;border-bottom:1px solid rgba(36,51,74,.7)}.event:last-child{border-bottom:0}.event-dot{width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--blue)}.event.message-sent .event-dot{background:var(--purple)}.event.live-tool .event-dot{background:var(--green)}.event.turn-finished .event-dot{background:var(--amber)}.event-title{font-weight:750;font-size:13px}.event-detail{color:var(--muted);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.event-time{color:var(--muted);font-size:11px}.operations{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.operation{padding:12px;border:1px solid var(--line);border-radius:12px}.operation code{color:#bfdbfe}.operation small{display:block;color:var(--muted);margin-top:4px}footer{color:var(--muted);font-size:12px;margin-top:18px}.warning{color:var(--amber)}
@media(max-width:850px){.summary{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.now{grid-template-columns:1fr}.operations{grid-template-columns:1fr 1fr}}@media(max-width:520px){main{padding:22px 13px 40px}header{display:block}.connection{margin-top:12px}.summary{grid-template-columns:1fr 1fr}.operations{grid-template-columns:1fr}}
</style></head><body><main>
<header><div><div class="eyebrow">Yerel · Salt okunur görünüm</div><h1>Canlı Agent Paneli</h1><div id="repo" class="muted">QA koşusu hazırlanıyor…</div></div><div class="connection"><span id="dot" class="dot"></span><span id="connection">Bağlanıyor</span></div></header>
<section class="summary"><div class="metric"><span>Agent</span><b id="agentCount">0</b></div><div class="metric"><span>Mesaj</span><b id="messageCount">0</b></div><div class="metric"><span>Toplam tur</span><b id="turnCount">0</b></div><div class="metric"><span>Canlı kanıt</span><b id="operationCount">0</b></div></section>
<section class="panel now-panel"><div class="panel-head"><h2>Şu anda ne yapıyorlar?</h2><span class="count">Aktif görev ve bekleme durumu</span></div><div id="now" class="now"></div></section>
<div class="grid"><section class="panel"><div class="panel-head"><h2>Görev durumu</h2><span id="mode" class="count"></span></div><div id="agents" class="agents"></div></section>
<section class="panel"><div class="panel-head"><h2>Canlı hareket akışı</h2><span id="activityLabel" class="count"></span></div><div id="activity" class="activity-list"></div></section>
<section class="panel wide"><div class="panel-head"><h2>Kim kime ne dedi?</h2><span id="messageLabel" class="count"></span></div><div id="messages" class="timeline"></div></section>
<section class="panel wide"><div class="panel-head"><h2>Canlı test kanıtları</h2><span class="count">Tarayıcı ve Android işlemleri</span></div><div id="operations" class="operations"></div></section></div>
<footer><span class="warning">Bu panel gizli model düşüncelerini göstermez.</span> Yalnızca görev durumları, agentların açıkça gönderdiği ekip mesajları ve araç kanıtları görüntülenir. Son güncelleme: <span id="updated">—</span></footer>
</main><script>
const initialEncoded=${JSON.stringify(encoded)};const prefix=${JSON.stringify(prefix)};
const el=id=>document.getElementById(id);const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n};
function empty(text){return node('div','empty',text)}
function eventCopy(item){
  if(item.type==='turn.started')return [item.agentId+' çalışmaya başladı',(item.provider||'agent')+' · '+item.turn+'. tur'];
  if(item.type==='turn.finished')return [item.agentId+' turu tamamladı',[item.state,item.reason].filter(Boolean).join(' · ')];
  if(item.type==='message.sent')return [item.from+' → '+item.to,[item.kind,item.scenarioId,item.body].filter(Boolean).join(' · ')];
  if(item.type==='mailbox.read')return [item.agentId+' gelen kutusuna baktı',(item.messageCount||0)+' bekleyen mesaj'];
  if(item.type==='message.acknowledged')return [item.agentId+' mesajı işledi','Mesaj teslim alındı'];
  if(item.type==='live.tool')return [item.agentId+' canlı araç kullandı',[item.tool,item.artifact].filter(Boolean).join(' · ')];
  return [item.agentId||'Sistem',item.type];
}
function render(data){
  el('repo').textContent=[data.repository,data.commit?.slice(0,10)].filter(Boolean).join(' · ')||'Yerel QA koşusu';el('mode').textContent=data.mode||'';
  el('agentCount').textContent=data.tasks.length;el('messageCount').textContent=data.messages.length;el('turnCount').textContent=data.totalTurns||0;el('operationCount').textContent=data.operations.length;
  const now=el('now');now.replaceChildren();const active=data.tasks.filter(task=>['running','waiting'].includes(task.state));if(!active.length)now.append(empty(data.finishedAt?'Koşu tamamlandı.':'Şu anda aktif bir agent turu yok.'));
  for(const task of active){const card=node('article','now-card');card.append(node('b','',task.id+' · '+task.state),node('span','',task.focus||task.summary||'Görev ayrıntısı hazırlanıyor.'));now.append(card)}
  const agents=el('agents');agents.replaceChildren();if(!data.tasks.length)agents.append(empty('Agentlar henüz başlatılmadı.'));
  for(const task of data.tasks){const card=node('article','agent '+task.state);const info=node('div');info.append(node('div','agent-name',task.id));info.append(node('div','agent-meta',[task.role,task.provider,task.turns+' tur',task.checks+' kontrol'].filter(Boolean).join(' · ')));if(task.focus)info.append(node('div','agent-focus',task.focus));if(task.summary)info.append(node('div','muted',task.summary));if(task.reason)info.append(node('div','agent-meta','Neden: '+task.reason));card.append(info,node('span','badge '+task.state,task.state));agents.append(card)}
  const activity=el('activity');activity.replaceChildren();el('activityLabel').textContent=data.activity.length+' olay';if(!data.activity.length)activity.append(empty('Canlı hareket henüz başlamadı.'));
  for(const item of data.activity.slice().reverse()){const copy=eventCopy(item);const row=node('article','event '+item.type.replaceAll('.','-'));row.append(node('span','event-dot'),node('div','',undefined),node('time','event-time',item.timestamp?new Date(item.timestamp).toLocaleTimeString('tr-TR'):'—'));row.children[1].append(node('div','event-title',copy[0]),node('div','event-detail',copy[1]));activity.append(row)}
  const messages=el('messages');messages.replaceChildren();el('messageLabel').textContent=data.messages.length+' kayıt';if(!data.messages.length)messages.append(empty('Agentlar henüz mesaj göndermedi.'));
  for(const item of data.messages){const card=node('article','message '+item.kind);const kind=node('span','kind',item.kind+(item.acknowledged?' · işlendi':''));const route=node('div','route',item.from+' → '+item.to);route.append(kind);card.append(route,node('div','scenario',item.scenarioId),node('div','body',item.body));messages.append(card)}
  const operations=el('operations');operations.replaceChildren();if(!data.operations.length)operations.append(empty('Henüz canlı tarayıcı veya Android kanıtı yok.'));
  for(const item of data.operations){const card=node('article','operation');card.append(node('code','',item.tool),node('small','',item.agentId+' · '+(item.artifact||item.id)));operations.append(card)}
  el('updated').textContent=new Date().toLocaleTimeString('tr-TR');
}
async function refresh(){const response=await fetch(prefix+'/state',{cache:'no-store'});if(!response.ok)throw new Error('state');render(await response.json())}
function decode(value){const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));return JSON.parse(new TextDecoder().decode(bytes))}
if(initialEncoded){render(decode(initialEncoded));el('connection').textContent='Tamamlanmış koşu';el('dot').classList.add('live')}
else{refresh().then(()=>{el('connection').textContent='Canlı';el('dot').classList.add('live')}).catch(()=>{el('connection').textContent='Bağlantı yok'});const stream=new EventSource(prefix+'/events');stream.addEventListener('update',()=>refresh());stream.onerror=()=>{el('connection').textContent='Yeniden bağlanıyor';el('dot').classList.remove('live')}}
</script></body></html>`;
}

export class RunDashboard {
  constructor(initial = {}) {
    this.token = randomBytes(24).toString('hex');
    this.snapshot = dashboardSnapshot(initial);
    this.clients = new Set();
  }
  securityHeaders(response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  }
  async listen() {
    const prefix = `/${this.token}`;
    this.server = createServer((request, response) => {
      this.securityHeaders(response);
      if (request.method !== 'GET' || !request.url?.startsWith(prefix)) { response.writeHead(404); response.end('Not found'); return; }
      if (request.url === `${prefix}/`) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(page({ token: this.token })); return;
      }
      if (request.url === `${prefix}/state`) {
        response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(this.snapshot)); return;
      }
      if (request.url === `${prefix}/events`) {
        response.setHeader('Content-Type', 'text/event-stream'); response.setHeader('Connection', 'keep-alive');
        response.write('event: update\ndata: ready\n\n'); this.clients.add(response);
        request.on('close', () => this.clients.delete(response)); return;
      }
      response.writeHead(404); response.end('Not found');
    });
    this.server.requestTimeout = 10000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const port = this.server.address().port;
    this.url = `http://127.0.0.1:${port}/${this.token}/`;
    return this.url;
  }
  update(record) {
    this.snapshot = dashboardSnapshot(record);
    for (const response of this.clients) response.write('event: update\ndata: changed\n\n');
  }
  async writeStatic(path) {
    await writeFile(path, page({ initial: this.snapshot }), { mode: 0o600 });
  }
  async close() {
    for (const response of this.clients) response.end();
    this.clients.clear();
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
  }
}
