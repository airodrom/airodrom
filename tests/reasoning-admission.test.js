'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Bridge = require('./fixtures/test-bridge.cjs');
const { McpTools } = require('../src/mcp-tools');
const { LOCAL_OLLAMA } = require('../src/local-ollama-broker');
async function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/reasoning-admission-');
  const profile = path.join(root,'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile,'settings.json'), JSON.stringify({ defaultProvider:'fixture', defaultModel:'fixture' }));
  const bridge = await new Bridge({ defaultRuntime: 'host', dataDir:path.join(root,'data'), sourceProfile:profile, allowFixtureWorker:true, executable:path.join(__dirname,'fixtures/host-worker.cjs') }).initialize();
  bridge.config.provider = 'ollama'; bridge.config.model = LOCAL_OLLAMA.model;
  t.after(async()=>{await bridge.shutdown();fs.rmSync(root,{recursive:true,force:true});});
  const task = bridge.tasks.get(bridge.createTask('bounded inference',{reasoningOnly:true}).id);
  return { bridge, task, root };
}
function fakeRequest(bridge, unavailable = false) {
  let calls = 0;
  bridge.localOllamaBroker.request = (_options, receive) => {
    calls++; const upstream = new EventEmitter(); upstream.setTimeout=()=>{}; upstream.destroy=()=>{};
    upstream.end=body=>queueMicrotask(()=>{
      const payload=JSON.parse(body); assert.equal(payload.tools,undefined); assert.equal(payload.messages.length,1);
      if(unavailable) return upstream.emit('error',Object.assign(Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'}));
      const response = new EventEmitter(); response.statusCode=200; response.headers={'content-type':'text/event-stream'};
      receive(response); response.emit('data',Buffer.from('data: {"choices":[{"delta":{"content":"Bounded reply"}}]}\n\ndata: [DONE]\n\n')); response.emit('end');
    }); return upstream;
  };
  return ()=>calls;
}
test('isolated bounded reasoning reaches available provider without a worker, context retrieval, tools or acceptance',async t=>{
  const {bridge,task}=await fixture(t);const calls=fakeRequest(bridge);
  bridge.ensureRuntime=()=>{throw Error('worker must not launch');}; bridge.memory.search=()=>{throw Error('memory expansion');};
  assert.equal((await bridge.prompt(task.id,'Consider a bounded plan')).text,'Bounded reply');
  assert.equal(calls(),1);assert.equal(task.status,'idle');assert.deepEqual(task.capabilityScopes,[]);assert.equal(task.mission.grantId,undefined);
  assert.equal(bridge.runtimes.size,0);assert.equal(bridge.leases.size,0);
  assert.equal(bridge.memory.db.prepare('SELECT count(*) n FROM cp_leases').get().n,0);
  assert.equal(bridge.memory.db.prepare('SELECT agent_id FROM cp_runs').get().agent_id,'reasoning_provider');assert.notEqual(task.mission.status,'completed');
  const record=bridge.memory.db.prepare('SELECT * FROM reasoning_admissions').get();assert.equal(record.state,'settled');assert.equal(record.mode,'reasoning_only');
  const events=bridge.ledger.listTaskEvents(task.id,{limit:100}).events;
  for(const kind of ['requested','granted','settled'])assert.ok(events.some(e=>e.event_type===`reasoning.admission.${kind}`));
  assert.equal(JSON.stringify(record).includes('Consider a bounded plan'),false);
});
test('valid reasoning admission with unavailable Ollama durably waits; request replay and automatic recovery never repeat inference',async t=>{
  const {bridge,task}=await fixture(t);const calls=fakeRequest(bridge,true);
  await assert.rejects(bridge.prompt(task.id,'Bounded unavailable probe'),/Local Ollama connection failed/);
  assert.equal(task.status,'waiting_for_provider');assert.equal(task.failureKind,'ollama_unavailable');assert.equal(calls(),1);assert.equal(bridge.leases.size,0);
  assert.ok(bridge.ledger.listTaskEvents(task.id,{limit:100}).events.some(e=>e.event_type==='reasoning.admission.provider_unavailable'));
  await assert.rejects(bridge.prompt(task.id,'Bounded unavailable probe'),/request_replay/);assert.equal(task.failureKind,'reasoning_admission_denied');assert.equal(calls(),1);
  await assert.rejects(bridge.prompt(task.id,'different',{recovery:true}),/recovery/);assert.equal(calls(),1);
});
test('missing, task/run/session/request/context mismatch, expiry and consumed admission fail closed',async t=>{
  const {bridge,task}=await fixture(t); const authority=bridge.reasoningAdmission;
  assert.equal(authority.authorize(task,{},'missing').kind,'reasoning_admission_denied');
  const lease=bridge.leases.acquire(task.id,{agentId:'reasoning_provider'});task.activeRunId=lease.runId;task.mission.status='active';
  const message='bounded context',requestId='exact-request',admissionId=authority.grant(task,lease,message,requestId);
  const runtime={admissionId,requestId,contextHash:require('node:crypto').createHash('sha256').update(message).digest('hex')};authority.active.set(task.id,runtime);
  for(const field of ['requestId','contextHash','admissionId']){const saved=runtime[field];runtime[field]='mismatch';assert.equal(authority.authorize(task,runtime,lease.runId).allow,false);runtime[field]=saved;}
  assert.equal(authority.authorize(task,runtime,'other-run').allow,false);
  const session=task.sessionId;task.sessionId='different';assert.equal(authority.authorize(task,runtime,lease.runId).allow,false);task.sessionId=session;
  const mission=task.mission.id;task.mission.id='other-mission';assert.equal(authority.authorize(task,runtime,lease.runId).allow,false);task.mission.id=mission;
  const now=authority.now;authority.now=()=>Date.now()+999999;assert.equal(authority.authorize(task,runtime,lease.runId).allow,false);authority.now=now;
  assert.equal(authority.authorize(task,runtime,lease.runId).allow,true);assert.equal(authority.authorize(task,runtime,lease.runId).allow,false);
  bridge.leases.releaseIfOwner(lease,{verified:true});authority.active.clear();
});
test('reasoning admission gives no broker or policy authority for files, shell, Git, Slack, connectors, secrets or privileged jobs',async t=>{
  const {bridge,task}=await fixture(t);
  for(const [toolName,input]of [['read',{path:'sample.txt'}],['write',{path:'sample.txt',content:'x'}],['bash',{command:'pwd'}],['run_job',{jobName:'git_status'}],['capability',{name:'git_status',input:{repo:'.'}}],['capability',{name:'slack_send_message',input:{}}],['capability',{name:'system_info',input:{}}],['web_fetch',{url:'https://example.com'}]]){
    assert.equal(bridge.policy.check(task.id,{toolName,input},{brokered:true}).allow,false);
    assert.equal((await bridge.capabilityBroker.execute(task.id,{toolName,input})).allow,false);
  }
  assert.throws(()=>bridge.createTask('escalation',{reasoningOnly:true,workspace:task.workspace}),/isolated/);
  assert.throws(()=>bridge.createTask('escalation',{reasoningOnly:true,capabilityScopes:['repo']}),/scopes/);
  assert.equal(bridge.missionAuthority.verify(task.mission,'read').allow,false);
  const mcp=new McpTools(bridge);await assert.rejects(mcp.call('create_task',{description:'bad',message:'x',request_id:'bad-request',mission_mode:'reasoning_only',workspace:'bridge'}),/isolated/);
});
test('restart reconciles consumed admission without reissuing or executing',async t=>{
  const {bridge,task}=await fixture(t);const a=bridge.reasoningAdmission;const lease=bridge.leases.acquire(task.id,{agentId:'reasoning_provider'});task.activeRunId=lease.runId;
  a.grant(task,lease,'context','request');bridge.memory.db.prepare("UPDATE reasoning_admissions SET state='consumed'").run();
  const recovered=new (require('../src/reasoning-admission').ReasoningAdmission)(bridge);
  assert.equal(bridge.memory.db.prepare('SELECT state FROM reasoning_admissions').get().state,'interrupted');assert.equal(recovered.active.size,0);
  assert.throws(()=>recovered.grant(task,lease,'context','request'),/request_replay/);bridge.leases.releaseIfOwner(lease,{verified:true});
});
test('explicit unavailable diagnostic uses the existing per-instance request seam without calling real provider or changing configuration',async t=>{
  const {bridge,task}=await fixture(t);task.reasoningProbe='ollama_unavailable';bridge.tasks.save(task);
  bridge.localOllamaBroker.request=()=>{throw Error('real provider must not be contacted');};
  const config=JSON.stringify(bridge.config);
  await assert.rejects(bridge.prompt(task.id,'A safe diagnostic'),/Local Ollama connection failed/);
  assert.equal(task.failureKind,'ollama_unavailable');assert.equal(task.status,'waiting_for_provider');assert.equal(JSON.stringify(bridge.config),config);
  assert.equal(bridge.memory.db.prepare('SELECT probe FROM reasoning_admissions').get().probe,'ollama_unavailable');
});
test('cancellation and reconciliation preserve inference ownership until broker settlement',async t=>{
  const {bridge,task}=await fixture(t);let reached;const ready=new Promise(resolve=>{reached=resolve;});
  bridge.localOllamaBroker.request=()=>{const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=()=>{};request.end=()=>reached();return request;};
  const running=bridge.prompt(task.id,'Wait for cancellation');running.catch(()=>{});await ready;
  bridge.leases.requestCancel(task.id);bridge.reconcileExecution();assert.equal(bridge.leases.has(task.id),true);
  await assert.rejects(running,/cancelled/);assert.equal(bridge.leases.size,0);assert.equal(bridge.reasoningAdmission.active.size,0);
});
test('provider context redacts secret-like strings without expanding memory or repository data',async t=>{
  const {bridge,task}=await fixture(t);const secret='sk-'+ 'A'.repeat(28);let captured;
  bridge.localOllamaBroker.request=(_options,receive)=>{const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=()=>{};request.end=body=>{captured=body;queueMicrotask(()=>request.emit('error',Error('ECONNREFUSED')));};return request;};
  await assert.rejects(bridge.prompt(task.id,`Consider ${secret}`));assert.equal(captured.includes(secret),false);assert.ok(captured.includes('redacted'));
});
