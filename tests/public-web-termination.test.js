'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
const {ResearchBrowser}=require('../src/research-browser');
const {ResearchNetwork}=require('../src/research-network');
const {bootEpochMs}=require('../src/os-boot-epoch');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const ORIGIN='https://research.example';

function directory(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'airo-web-term-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fakeBrowser({hangCloseMs=0,hangLaunch=false}={}){
 const events=[],options={},child={pid:45678,exitCode:null,signalCode:null,kill(sig){events.push('child.kill:'+sig);if(sig==='SIGKILL')child.exitCode=1;}};
 let releaseLaunch;const launchGate=hangLaunch?new Promise(r=>releaseLaunch=r):null;
 const page=new EventEmitter();page.url=()=>'about:blank';page.mainFrame=()=>({});page.waitForTimeout=async()=>{};page.close=async()=>{};page.setViewportSize=async()=>{};
 const context=new EventEmitter();context.setDefaultTimeout=()=>{};context.setDefaultNavigationTimeout=()=>{};context.addInitScript=async()=>{};context.routeWebSocket=async()=>{};context.route=async()=>{};context.newPage=async()=>page;
 context.close=async()=>{events.push('context.close');if(hangCloseMs)await new Promise(r=>setTimeout(r,hangCloseMs));};
 const browser={newContext:async opts=>{options.context=opts;return context;},close:async()=>{events.push('browser.close');}};
 const server={wsEndpoint:()=>'ws://127.0.0.1/owned-browser',process:()=>child,close:async()=>{events.push('server.close');child.exitCode=0;}};
 const playwright={chromium:{launchServer:async opts=>{options.launch=opts;if(launchGate)await launchGate;return server;},connect:async()=>browser}};
 return {playwright,events,options,child,context,server,releaseLaunch};
}
async function deadPid(){
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const pid=child.pid;child.kill('SIGKILL');
 for(let i=0;i<50;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return pid;}await new Promise(r=>setTimeout(r,20));}
 throw Error('fixture pid did not exit');
}
async function uncertainWebMission(t,{bootEpoch,now}={}){
 const f=await fixture(t),b=f.bridge;b.options.researchMission={workspace:f.repo,synthetic:true,baselineFiles:['docs/README.md'],maxPages:4,maxActions:30,timeoutMs:30000};
 let closes=0;b.missions.web.options={synthetic:true,bootEpoch,now,browserFactory:()=>({start:async()=>{},ownedProcessId:()=>null,execute:async()=>{throw Object.assign(Error('navigation_unavailable'),{code:'navigation_unavailable'});},close:async()=>++closes===1?{closed:false,termination_verified:false}:{closed:true,termination_verified:true,owned_process_termination:'verified'}})};
 const m=b.missions.web.createResearch({request_id:randomUUID(),objective:'Explore synthetic source.',mode:'on',entries:['https://example.com/'],confirmed:true});
 b.missions.dispatch(m.mission_id,{request_id:randomUUID()});
 const done=await f.settle(m.mission_id,'blocked');
 const run=done.runs.find(r=>r.agent_id==='host');
 b.missions.web.uncertainBrowsers.delete(m.mission_id);
 b.missions.web.active.delete(m.mission_id);
 const lease=b.controlStore.db.prepare("SELECT * FROM cp_leases WHERE run_id=? AND state='quarantined'").get(run.id);
 return {f,b,m,run,lease};
}

test('document fetches receive a reserved concurrency seat ahead of subresource saturation',async()=>{
 const n=new ResearchNetwork({scope:{origins:[ORIGIN]},testing:{lookup:async()=>[{address:'8.8.8.8',family:4}],request:(options,callback)=>{const req=new EventEmitter();req.end=()=>{};req.destroy=()=>{};queueMicrotask(()=>{});return req;}}});
 n.active=8;await n.acquireSlot(undefined,{priority:true});assert.equal(n.active,9);
 n.active=8;await assert.rejects(n.acquireSlot(AbortSignal.timeout(30),{priority:false}),/concurrency_bound|cancelled/);
});

test('hung context.close cannot strand Mission ownership past the bounded close budget',async t=>{
 const dir=directory(t),fake=fakeBrowser({hangCloseMs:60000});
 const b=new ResearchBrowser({scope:{origins:[ORIGIN],maxActions:5},evidenceDir:dir,network:{fetch:async()=>({url:ORIGIN+'/',status:200,contentType:'text/html',body:Buffer.from('ok')})},playwright:fake.playwright});
 await b.qualify();const started=Date.now();const result=await b.close();
 assert.ok(Date.now()-started<20000);assert.equal(result.termination_verified,true);assert.equal(fake.child.exitCode,0);
 assert.equal(fake.events.includes('child.kill:SIGTERM')||fake.events.includes('server.close'),true);
});

test('hung startPromise cannot block close past its deadline and fails closed without verification',async t=>{
 const dir=directory(t),fake=fakeBrowser({hangLaunch:true});
 const b=new ResearchBrowser({scope:{origins:[ORIGIN],maxActions:5},evidenceDir:dir,network:{fetch:async()=>({url:ORIGIN+'/',status:200,contentType:'text/html',body:Buffer.from('ok')})},playwright:fake.playwright});
 const starting=b.qualify();await new Promise(r=>setTimeout(r,20));
 const started=Date.now();await assert.rejects(b.close(),/termination_unverified/);assert.ok(Date.now()-started<20000);
 fake.releaseLaunch();await starting.catch(()=>{});
});

test('close signals only through the owned ChildProcess handle, never process.kill(pid)',async t=>{
 const dir=directory(t),fake=fakeBrowser();
 let signaled=null;const original=process.kill;process.kill=function(pid,sig){if(sig&&sig!==0)signaled={pid,sig};return original.apply(this,arguments);};
 t.after(()=>{process.kill=original;});
 fake.server.close=async()=>{fake.events.push('server.close');/* leave child alive so handle.kill runs */};
 const b=new ResearchBrowser({scope:{origins:[ORIGIN],maxActions:5},evidenceDir:dir,network:{fetch:async()=>({url:ORIGIN+'/',status:200,contentType:'text/html',body:Buffer.from('ok')})},playwright:fake.playwright});
 await b.qualify();
 assert.equal((await b.close()).termination_verified,true);
 assert.equal(signaled,null);
 assert.equal(fake.events.includes('child.kill:SIGTERM'),true);
 assert.equal(fake.events.includes('child.kill:SIGKILL'),true);
});

test('PID reconcile requires same-boot recorded PID ESRCH and never verifies siblings',async t=>{
 const boot={sec:Math.floor(Date.now()/1000)-60,usec:0,source:'kern.boottime'};
 const {b,m,run}=await uncertainWebMission(t,{bootEpoch:boot});
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID()}),/owned_process_pid_required/);
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID(),orphan_attestation:'no_owned_browser_process'}),/Unexpected input fields|owned_process_pid_required/);
 const sibling=randomUUID();
 b.controlStore.startRun({id:sibling,taskId:run.task_id,missionId:m.mission_id,agentId:'bridge'});
 b.controlStore.updateRun(sibling,{state:'interrupted',processState:'unknown',verified:false,resolution:'reconcile_process'});
 const pid=await deadPid();
 b.controlStore.db.prepare('UPDATE cp_runs SET pid=?,updated_at=?,ended_at=? WHERE id=?').run(pid,bootEpochMs(boot)+1000,bootEpochMs(boot)+1000,run.id);
 const receipt=b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID()});
 assert.equal(receipt.recovery_kind,'owned_pid_esrch');
 assert.equal(receipt.recovery_not_execution,true);
 assert.equal(b.controlStore.run(sibling).termination_verified,0);
 assert.equal(b.controlStore.run(sibling).state,'interrupted');
});

test('cross-boot recorded PID refuses PID reconcile and requires boot recovery',async t=>{
 const oldBoot={sec:1_700_000_000,usec:0,source:'kern.boottime'},current={sec:1_700_000_200,usec:0,source:'kern.boottime'};
 const {b,run}=await uncertainWebMission(t,{bootEpoch:current});
 const pid=await deadPid();
 b.controlStore.db.prepare('UPDATE cp_runs SET pid=?,updated_at=?,ended_at=? WHERE id=?').run(pid,bootEpochMs(oldBoot)+10,bootEpochMs(oldBoot)+10,run.id);
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID()}),/owned_process_cross_boot_use_boot_recovery/);
});

function bootReconcile(ctx,prepared,overrides={}){
 return {run_id:ctx.run.id,mission_id:ctx.m.mission_id,lease_id:ctx.lease.id,evidence_id:prepared.evidence_id,sha256:prepared.sha256,
  termination_verified:true,request_id:randomUUID(),recovery_kind:'cold_os_reboot',...overrides};
}
async function preparedBootFixture(t,{priorOffsetSec=7_200,usec=1}={}){
 const nowSec=Math.floor(Date.now()/1000);
 const prior={sec:nowSec-priorOffsetSec,usec,source:'kern.boottime'};
 let clock=bootEpochMs(prior)+60_000;
 const ctx=await uncertainWebMission(t,{bootEpoch:prior,now:()=>clock});
 ctx.b.controlStore.db.prepare('UPDATE cp_runs SET updated_at=?,ended_at=? WHERE id=?').run(clock,clock,ctx.run.id);
 Object.assign(ctx.run,ctx.b.controlStore.run(ctx.run.id));
 const prepared=ctx.b.missions.web.prepareBootRecovery({run_id:ctx.run.id,lease_id:ctx.lease.id,request_id:randomUUID()});
 const advance=()=>{const nextBoot={sec:nowSec+120+usec,usec:0,source:'kern.boottime'};ctx.b.missions.web.options.bootEpoch=nextBoot;clock=bootEpochMs(nextBoot)+1_000;return nextBoot;};
 return {ctx,prepared,advance,nowSec,clock:()=>clock,setClock:v=>{clock=v;}};
}

test('boot-epoch recovery: valid transition, same-boot refusal, sibling isolation, exact lease/dispatch identity',async t=>{
 const {ctx,prepared,advance}=await preparedBootFixture(t);
 const {b,m,run,lease}=ctx;
 assert.equal(prepared.recovery_not_execution,true);
 assert.match(prepared.sha256,/^[a-f0-9]{64}$/);
 assert.equal(b.controlStore.db.prepare("SELECT state,sha256 FROM cp_mission_web_boot_recovery WHERE evidence_id=?").get(prepared.evidence_id).sha256,prepared.sha256);
 assert.throws(()=>b.missions.web.prepareBootRecovery({run_id:run.id,request_id:randomUUID()}),/lease_binding_required/);
 assert.throws(()=>b.missions.web.reconcileBootRecovery(bootReconcile(ctx,prepared)),/cold_os_reboot_not_observed/);
 advance();
 assert.throws(()=>b.missions.web.reconcileBootRecovery(bootReconcile(ctx,prepared,{mission_id:randomUUID()})),/recovery_evidence_registry_mismatch/);
 assert.throws(()=>b.missions.web.reconcileBootRecovery(bootReconcile(ctx,prepared,{lease_id:randomUUID()})),/recovery_evidence_registry_mismatch/);
 assert.throws(()=>b.missions.web.reconcile({run_id:run.id,termination_verified:true,request_id:randomUUID()}),/owned_process_pid_required/);
 const sibling=randomUUID();
 b.controlStore.startRun({id:sibling,taskId:run.task_id,missionId:m.mission_id,agentId:'bridge'});
 b.controlStore.updateRun(sibling,{state:'interrupted',processState:'unknown',verified:false,resolution:'reconcile_process'});
 const ok=b.missions.web.reconcileBootRecovery(bootReconcile(ctx,prepared));
 assert.equal(ok.recovery_kind,'cold_os_reboot');
 assert.equal(ok.recovery_not_execution,true);
 assert.equal(ok.sha256,prepared.sha256);
 assert.equal(b.controlStore.run(run.id).termination_verified,1);
 assert.equal(b.controlStore.db.prepare('SELECT state FROM cp_leases WHERE id=?').get(lease.id).state,'released');
 assert.equal(b.controlStore.db.prepare("SELECT state FROM cp_dispatches WHERE mission_id=? AND run_id=?").get(m.mission_id,run.id).state,'blocked');
 assert.equal(b.controlStore.run(sibling).termination_verified,0);
 assert.equal(b.controlStore.run(sibling).state,'interrupted');
 assert.equal(b.controlStore.db.prepare("SELECT state FROM cp_mission_web_boot_recovery WHERE evidence_id=?").get(prepared.evidence_id).state,'consumed');
 assert.throws(()=>b.missions.web.reconcileBootRecovery(bootReconcile(ctx,prepared)),/recovery_evidence_already_consumed/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(b.dataDir,'recovery','web-termination',prepared.evidence_id+'.json'),'utf8')).browser_closed_receipt,false);
});

test('boot-epoch recovery: fail closed on tampered, replaced, stale, wrong digest, and post-boot continuation',async t=>{
 // Tampered packet bytes vs durable registry SHA-256.
 const a=await preparedBootFixture(t,{priorOffsetSec:8_100,usec:3});
 a.advance();
 const fileA=path.join(a.ctx.b.dataDir,'recovery','web-termination',a.prepared.evidence_id+'.json');
 const original=fs.readFileSync(fileA);
 fs.writeFileSync(fileA,Buffer.concat([original,Buffer.from(' ')]));
 assert.throws(()=>a.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(a.ctx,a.prepared)),/recovery_evidence_digest_mismatch/);
 fs.writeFileSync(fileA,original,{mode:0o600});

 // Replaced packet (same evidence_id filename, different body) without registry rewrite.
 const replaced=JSON.parse(original.toString());
 replaced.purpose='substituted';
 fs.writeFileSync(fileA,Buffer.from(JSON.stringify(replaced)+'\n'),{mode:0o600});
 assert.throws(()=>a.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(a.ctx,a.prepared)),/recovery_evidence_digest_mismatch/);
 fs.writeFileSync(fileA,original,{mode:0o600});
 assert.throws(()=>a.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(a.ctx,a.prepared,{sha256:'0'.repeat(64)})),/recovery_evidence_registry_mismatch/);

 // Stale snapshot after prepare (run timestamps diverged).
 const bfx=await preparedBootFixture(t,{priorOffsetSec:9_000,usec:4});
 bfx.advance();
 bfx.ctx.b.controlStore.db.prepare('UPDATE cp_runs SET updated_at=updated_at+1 WHERE id=?').run(bfx.ctx.run.id);
 Object.assign(bfx.ctx.run,bfx.ctx.b.controlStore.run(bfx.ctx.run.id));
 assert.throws(()=>bfx.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(bfx.ctx,bfx.prepared)),/recovery_evidence_stale/);

 // Post-boot event evidence.
 const c=await preparedBootFixture(t,{priorOffsetSec:10_800,usec:5});
 const next=c.advance();
 const eventId=randomUUID(),ts=bootEpochMs(next)+500;
 c.ctx.b.controlStore.db.prepare("INSERT INTO event_ledger_events(event_id,idempotency_key,fingerprint,event_type,timestamp,timestamp_ms,run_id,mission_id,agent,direction,metadata,payload_byte_length,payload_stored_byte_length,payload_redacted,payload_truncated,protected) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(eventId,eventId,eventId,'research.browser_started',new Date(ts).toISOString(),ts,c.ctx.run.id,c.ctx.m.mission_id,'bridge','internal','{}',0,0,0,0,0);
 assert.throws(()=>c.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(c.ctx,c.prepared)),/post_boot_execution_observed/);

 // Post-boot dispatch / run continuation surfaces.
 const d=await preparedBootFixture(t,{priorOffsetSec:11_400,usec:6});
 const nextD=d.advance();
 d.ctx.b.controlStore.db.prepare('UPDATE cp_dispatches SET updated_at=? WHERE mission_id=? AND run_id=?').run(bootEpochMs(nextD)+10,d.ctx.m.mission_id,d.ctx.run.id);
 assert.throws(()=>d.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(d.ctx,d.prepared)),/post_boot_dispatch_continuation/);
});

function quarantineSyntheticRun(b,{missionId,taskId,agentId,workspace,baseline,resolution='reconcile_process'}){
 const id=randomUUID();
 b.controlStore.startRun({id,taskId,missionId,agentId});
 b.controlStore.acquireLease({resource:workspace,runId:id,missionId,mode:'read',baseline,ttlMs:60_000});
 b.controlStore.updateRun(id,{state:'termination_unverified',processState:'unknown',verified:false,resolution});
 b.controlStore.db.prepare("UPDATE cp_leases SET state='quarantined' WHERE run_id=? AND state='held'").run(id);
 b.missions.web.uncertainBrowsers.delete(missionId);
 const run=b.controlStore.run(id),lease=b.controlStore.db.prepare("SELECT * FROM cp_leases WHERE run_id=? AND state='quarantined'").get(id);
 return {run,lease};
}
function webEvent(b,{runId,missionId,type='mission.web.termination_unverified'}){
 const eventId=randomUUID();
 b.controlStore.db.prepare("INSERT INTO event_ledger_events(event_id,idempotency_key,fingerprint,event_type,timestamp,timestamp_ms,run_id,mission_id,agent,direction,metadata,payload_byte_length,payload_stored_byte_length,payload_redacted,payload_truncated,protected) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(eventId,eventId,eventId,type,new Date().toISOString(),Date.now(),runId,missionId,'bridge','internal','{}',0,0,0,0,0);
}

test('boot-recovery eligibility rejects coding/reasoning/external workers and unproven bridge siblings',async t=>{
 // Unrelated coding Mission without web capability.
 const coding=await fixture(t);
 const codingMission=coding.create({preferred_agent:'host',fallback_agents:[],task_type:'local_files',dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'deterministic_files',native_actions:[{name:'file_write',path:'fixture.txt',content:'beta\n'}]}});
 const cm=coding.bridge.controlStore.requireMission(codingMission.id);
 const cq=quarantineSyntheticRun(coding.bridge,{missionId:cm.id,taskId:cm.task_id,agentId:'host',workspace:cm.envelope.workspace,baseline:cm.envelope.baseline});
 assert.throws(()=>coding.bridge.missions.web.prepareBootRecovery({run_id:cq.run.id,lease_id:cq.lease.id,request_id:randomUUID()}),/boot_recovery_web_capability_required/);

 // Reasoning / conversation Mission.
 const reason=await fixture(t);
 const conv=reason.bridge.missions.createConversation({request_id:randomUUID(),message:'Fixture reasoning probe.'});
 const rm=reason.bridge.controlStore.requireMission(conv.mission_id);
 const rq=quarantineSyntheticRun(reason.bridge,{missionId:rm.id,taskId:rm.task_id,agentId:'host',workspace:rm.envelope.workspace||reason.repo,baseline:rm.envelope.baseline||{hash:'fixture',files:{}}});
 assert.throws(()=>reason.bridge.missions.web.prepareBootRecovery({run_id:rq.run.id,lease_id:rq.lease.id,request_id:randomUUID()}),/boot_recovery_reasoning_denied/);

 // External-worker run identity.
 const {b,m,run,lease}=await uncertainWebMission(t,{bootEpoch:{sec:Math.floor(Date.now()/1000)-3_600,usec:0,source:'kern.boottime'}});
 const worker=quarantineSyntheticRun(b,{missionId:m.mission_id,taskId:run.task_id,agentId:'opencode',workspace:b.controlStore.requireMission(m.mission_id).envelope.workspace,baseline:b.controlStore.requireMission(m.mission_id).envelope.baseline});
 assert.throws(()=>b.missions.web.prepareBootRecovery({run_id:worker.run.id,lease_id:worker.lease.id,request_id:randomUUID()}),/boot_recovery_external_worker_denied/);

 // Bridge sibling without this-run web-execution proof (sharing Mission is insufficient).
 const unproven=quarantineSyntheticRun(b,{missionId:m.mission_id,taskId:run.task_id,agentId:'bridge',workspace:b.controlStore.requireMission(m.mission_id).envelope.workspace,baseline:b.controlStore.requireMission(m.mission_id).envelope.baseline});
 assert.throws(()=>b.missions.web.prepareBootRecovery({run_id:unproven.run.id,lease_id:unproven.lease.id,request_id:randomUUID()}),/boot_recovery_bridge_web_unproven/);
 assert.throws(()=>b.missions.web.reconcileBootRecovery({run_id:unproven.run.id,mission_id:m.mission_id,lease_id:unproven.lease.id,evidence_id:randomUUID(),sha256:'a'.repeat(64),termination_verified:true,request_id:randomUUID(),recovery_kind:'cold_os_reboot'}),/recovery_evidence_unknown|boot_recovery_bridge_web_unproven/);

 // Bridge sibling becomes eligible only after run-scoped web evidence.
 const proven=quarantineSyntheticRun(b,{missionId:m.mission_id,taskId:run.task_id,agentId:'bridge',workspace:b.controlStore.requireMission(m.mission_id).envelope.workspace,baseline:b.controlStore.requireMission(m.mission_id).envelope.baseline,resolution:'web_termination_unverified'});
 webEvent(b,{runId:proven.run.id,missionId:m.mission_id});
 const preparedBridge=b.missions.web.prepareBootRecovery({run_id:proven.run.id,lease_id:proven.lease.id,request_id:randomUUID()});
 assert.equal(preparedBridge.run_id,proven.run.id);
 assert.match(preparedBridge.sha256,/^[a-f0-9]{64}$/);
 // Host path remains independently eligible.
 const preparedHost=b.missions.web.prepareBootRecovery({run_id:run.id,lease_id:lease.id,request_id:randomUUID()});
 assert.equal(preparedHost.run_id,run.id);
});

test('same-boot web-reconcile rejects unrelated quarantined non-web executions',async t=>{
 const coding=await fixture(t);
 const codingMission=coding.create({preferred_agent:'host',fallback_agents:[],task_type:'local_files',dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'deterministic_files',native_actions:[{name:'file_write',path:'fixture.txt',content:'beta\n'}]}});
 const cm=coding.bridge.controlStore.requireMission(codingMission.id);
 const cq=quarantineSyntheticRun(coding.bridge,{missionId:cm.id,taskId:cm.task_id,agentId:'host',workspace:cm.envelope.workspace,baseline:cm.envelope.baseline});
 const boot={sec:Math.floor(Date.now()/1000)-60,usec:0,source:'kern.boottime'};
 coding.bridge.missions.web.options={synthetic:true,bootEpoch:boot};
 const pid=await deadPid();
 coding.bridge.controlStore.db.prepare('UPDATE cp_runs SET pid=?,updated_at=?,ended_at=? WHERE id=?').run(pid,bootEpochMs(boot)+1000,bootEpochMs(boot)+1000,cq.run.id);
 // Same-boot PID ESRCH would otherwise look viable; eligibility must refuse non-web quarantine.
 assert.throws(()=>coding.bridge.missions.web.reconcile({run_id:cq.run.id,termination_verified:true,request_id:randomUUID()}),/boot_recovery_web_capability_required/);
});

function insertUnknownInvocation(db,{requestId,taskId,fingerprint,at}){
 db.prepare("INSERT INTO cp_invocations(request_id,task_id,fingerprint,state,result,created_at,updated_at,origin_event_id) VALUES(?,?,?,'unknown',NULL,?,?,?)")
  .run(requestId,taskId,fingerprint,at,at,randomUUID());
}
function bindRunScopedWebEvidence(db,{run,missionId,invocationId,at}){
 // Canonical run-scoped web evidence is the only authoritative invocation→run bind.
 db.prepare('INSERT INTO cp_mission_web_evidence(id,grant_id,mission_id,task_id,run_id,sha256,invocation_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(randomUUID(),randomUUID(),missionId,run.task_id,run.id,'a'.repeat(64),invocationId,at);
}

test('boot-recovery: pre-boot running dispatch settles; only run-scoped web-evidence invocations finish',async t=>{
 const {ctx,prepared,advance}=await preparedBootFixture(t,{priorOffsetSec:12_000,usec:7});
 const {b,m,run,lease}=ctx,db=b.controlStore.db;
 const priorMs=run.ended_at||run.updated_at;
 // Historical durable running dispatch (updated_at still prior-boot) must not false-fail continuation.
 db.prepare("UPDATE cp_dispatches SET state='running',updated_at=? WHERE mission_id=? AND run_id=?").run(priorMs-1_000,m.mission_id,run.id);
 assert.equal(db.prepare('SELECT state FROM cp_dispatches WHERE mission_id=? AND run_id=?').get(m.mission_id,run.id).state,'running');
 const linkedInv=randomUUID(),sameTaskUnproven=randomUUID(),otherTaskInv=randomUUID(),otherTask=randomUUID();
 insertUnknownInvocation(db,{requestId:linkedInv,taskId:run.task_id,fingerprint:'fixture-linked',at:priorMs-500});
 insertUnknownInvocation(db,{requestId:sameTaskUnproven,taskId:run.task_id,fingerprint:'fixture-same-task-unproven',at:priorMs-400});
 insertUnknownInvocation(db,{requestId:otherTaskInv,taskId:otherTask,fingerprint:'fixture-other-task',at:priorMs-300});
 bindRunScopedWebEvidence(db,{run,missionId:m.mission_id,invocationId:linkedInv,at:priorMs-450});
 const sibling=randomUUID();
 b.controlStore.startRun({id:sibling,taskId:run.task_id,missionId:m.mission_id,agentId:'bridge'});
 b.controlStore.updateRun(sibling,{state:'interrupted',processState:'unknown',verified:false,resolution:'reconcile_process'});
 advance();
 const ok=b.missions.web.reconcileBootRecovery(bootReconcile(ctx,prepared));
 assert.equal(ok.recovery_kind,'cold_os_reboot');
 assert.equal(ok.recovery_not_execution,true);
 assert.equal(b.controlStore.run(run.id).termination_verified,1);
 assert.equal(db.prepare('SELECT state FROM cp_leases WHERE id=?').get(lease.id).state,'released');
 assert.equal(db.prepare('SELECT state FROM cp_dispatches WHERE mission_id=? AND run_id=?').get(m.mission_id,run.id).state,'blocked');
 assert.equal(b.controlStore.invocation(linkedInv).state,'settled');
 assert.equal(b.controlStore.invocation(sameTaskUnproven).state,'unknown');
 assert.equal(b.controlStore.invocation(otherTaskInv).state,'unknown');
 assert.equal(b.controlStore.run(sibling).state,'interrupted');
 assert.equal(b.controlStore.run(sibling).termination_verified,0);
 assert.throws(()=>b.missions.web.reconcileBootRecovery(bootReconcile(ctx,prepared)),/recovery_evidence_already_consumed/);
});

test('boot-recovery: same-task unproven invocations stay unknown without run-scoped web evidence',async t=>{
 const {ctx,prepared,advance}=await preparedBootFixture(t,{priorOffsetSec:12_300,usec:17});
 const {b,m,run}=ctx,db=b.controlStore.db;
 const priorMs=run.ended_at||run.updated_at;
 db.prepare("UPDATE cp_dispatches SET state='running',updated_at=? WHERE mission_id=? AND run_id=?").run(priorMs-2_000,m.mission_id,run.id);
 const a=randomUUID(),bridgeLike=randomUUID();
 insertUnknownInvocation(db,{requestId:a,taskId:run.task_id,fingerprint:'fixture-host-unproven',at:priorMs-800});
 insertUnknownInvocation(db,{requestId:bridgeLike,taskId:run.task_id,fingerprint:'fixture-bridge-unproven',at:priorMs-700});
 // No cp_mission_web_evidence bind for either invocation.
 advance();
 const ok=b.missions.web.reconcileBootRecovery(bootReconcile(ctx,prepared));
 assert.equal(ok.recovery_not_execution,true);
 assert.equal(b.controlStore.run(run.id).termination_verified,1);
 assert.equal(db.prepare('SELECT state FROM cp_dispatches WHERE mission_id=? AND run_id=?').get(m.mission_id,run.id).state,'blocked');
 assert.equal(b.controlStore.invocation(a).state,'unknown');
 assert.equal(b.controlStore.invocation(bridgeLike).state,'unknown');
});

test('boot-recovery: post-boot running dispatch, post-boot events, wrong relationship, and tamper still fail closed',async t=>{
 // Post-boot timestamp advancement on a running dispatch remains denied.
 const a=await preparedBootFixture(t,{priorOffsetSec:12_600,usec:8});
 const nextA=a.advance();
 a.ctx.b.controlStore.db.prepare("UPDATE cp_dispatches SET state='running',updated_at=? WHERE mission_id=? AND run_id=?")
  .run(bootEpochMs(nextA)+25,a.ctx.m.mission_id,a.ctx.run.id);
 assert.throws(()=>a.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(a.ctx,a.prepared)),/post_boot_dispatch_continuation/);

 // Post-boot execution event denied.
 const bfx=await preparedBootFixture(t,{priorOffsetSec:13_200,usec:9});
 const nextB=bfx.advance();
 const eventId=randomUUID(),ts=bootEpochMs(nextB)+40;
 bfx.ctx.b.controlStore.db.prepare("INSERT INTO event_ledger_events(event_id,idempotency_key,fingerprint,event_type,timestamp,timestamp_ms,run_id,mission_id,agent,direction,metadata,payload_byte_length,payload_stored_byte_length,payload_redacted,payload_truncated,protected) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(eventId,eventId,eventId,'research.navigated',new Date(ts).toISOString(),ts,bfx.ctx.run.id,bfx.ctx.m.mission_id,'bridge','internal','{}',0,0,0,0,0);
 assert.throws(()=>bfx.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(bfx.ctx,bfx.prepared)),/post_boot_execution_observed/);

 // Incorrect Run/dispatch relationship: unbound running dispatch on the task.
 const c=await preparedBootFixture(t,{priorOffsetSec:13_800,usec:10});
 c.advance();
 c.ctx.b.controlStore.db.prepare("UPDATE cp_dispatches SET run_id=NULL,state='running' WHERE mission_id=? AND run_id=?")
  .run(c.ctx.m.mission_id,c.ctx.run.id);
 assert.throws(()=>c.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(c.ctx,c.prepared)),/post_boot_dispatch_relationship_denied/);

 // Wrong run identity against sealed evidence.
 const d=await preparedBootFixture(t,{priorOffsetSec:14_400,usec:11});
 d.advance();
 const other=randomUUID();
 d.ctx.b.controlStore.startRun({id:other,taskId:d.ctx.run.task_id,missionId:d.ctx.m.mission_id,agentId:'host'});
 assert.throws(()=>d.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(d.ctx,d.prepared,{run_id:other})),/recovery_evidence_registry_mismatch/);

 // Tampered sealed evidence bytes.
 const e=await preparedBootFixture(t,{priorOffsetSec:15_000,usec:12});
 e.advance();
 const file=path.join(e.ctx.b.dataDir,'recovery','web-termination',e.prepared.evidence_id+'.json');
 const bytes=fs.readFileSync(file);
 fs.writeFileSync(file,Buffer.concat([bytes,Buffer.from('\n')]));
 assert.throws(()=>e.ctx.b.missions.web.reconcileBootRecovery(bootReconcile(e.ctx,e.prepared)),/recovery_evidence_digest_mismatch/);
});
