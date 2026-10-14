'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {bootEpochMs}=require('../src/os-boot-epoch');
const {fixture}=require('./fixtures/mission-fixture.cjs');

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
function insertLedger(b,{runId,missionId,taskId,requestId,eventType,ts,metadata={}}){
 const eventId=randomUUID();
 b.controlStore.db.prepare("INSERT INTO event_ledger_events(event_id,idempotency_key,fingerprint,event_type,timestamp,timestamp_ms,run_id,mission_id,task_id,request_id,agent,direction,metadata,payload_byte_length,payload_stored_byte_length,payload_redacted,payload_truncated,protected) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(eventId,eventId,eventId,eventType,new Date(ts).toISOString(),ts,runId,missionId,taskId,requestId||null,'bridge','internal',JSON.stringify(metadata),0,0,0,0,0);
 return eventId;
}
function bridgeInvocationFixture(ctx,priorMs,{owned=true,missionCancelled=true}={}){
 const {b,m,run}=ctx;
 const bridgeId=randomUUID(),invocationId=randomUUID();
 b.controlStore.startRun({id:bridgeId,taskId:run.task_id,missionId:m.mission_id,agentId:'bridge'});
 b.controlStore.updateRun(bridgeId,{state:'interrupted',processState:'unknown',verified:false,resolution:'reconcile_process'});
 b.controlStore.db.prepare('UPDATE cp_runs SET updated_at=?,ended_at=? WHERE id=?').run(priorMs,priorMs,bridgeId);
 b.controlStore.beginInvocation(run.task_id,invocationId,'fixture-bridge-inv-hash');
 b.controlStore.db.prepare("UPDATE cp_invocations SET state='unknown',created_at=?,updated_at=? WHERE request_id=?").run(priorMs,priorMs,invocationId);
 if(owned){
  insertLedger(b,{runId:bridgeId,missionId:m.mission_id,taskId:run.task_id,requestId:invocationId,eventType:'orchestrator.capability.requested',ts:priorMs,metadata:{capability:'mission_web',request_id:invocationId}});
 }
 if(missionCancelled&&b.controlStore.getMission(m.mission_id).state!=='cancelled')b.controlStore.state(m.mission_id,'cancelled','fixture_stop');
 return {bridgeId,invocationId,bridge:()=>b.controlStore.run(bridgeId)};
}
function bridgeReconcile(ctx,prepared,bridgeId,invocationId,overrides={}){
 return {
  run_id:bridgeId,mission_id:ctx.m.mission_id,invocation_id:invocationId,
  boot_boundary_evidence_id:prepared.evidence_id,boot_boundary_sha256:prepared.sha256,
  termination_verified:true,request_id:randomUUID(),recovery_kind:'cold_os_reboot',...overrides
 };
}

test('bridge-invocation boot recovery: owned inv settles; host evidence and sibling host stay intact',async t=>{
 const {ctx,prepared,advance}=await preparedBootFixture(t,{priorOffsetSec:7_500,usec:11});
 const priorMs=ctx.run.updated_at;
 const {bridgeId,invocationId}=bridgeInvocationFixture(ctx,priorMs);
 assert.throws(()=>ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,invocationId)),/cold_os_reboot_not_observed/);
 advance();
 const hostBefore=ctx.b.controlStore.run(ctx.run.id);
 const leaseBefore=ctx.b.controlStore.db.prepare('SELECT state FROM cp_leases WHERE id=?').get(ctx.lease.id).state;
 const evidenceBefore=ctx.b.controlStore.db.prepare('SELECT state,sha256 FROM cp_mission_web_boot_recovery WHERE evidence_id=?').get(prepared.evidence_id);
 const ok=ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,invocationId));
 assert.equal(ok.recovery_not_execution,true);
 assert.equal(ok.recovery_kind,'cold_os_reboot');
 assert.equal(ok.boot_boundary_consumed,false);
 assert.equal(ok.invocation_id,invocationId);
 assert.equal(ctx.b.controlStore.run(bridgeId).termination_verified,1);
 assert.equal(ctx.b.controlStore.run(bridgeId).state,'cancelled');
 assert.equal(ctx.b.controlStore.invocation(invocationId).state,'settled');
 // Host / evidence untouched.
 assert.equal(ctx.b.controlStore.run(ctx.run.id).termination_verified,hostBefore.termination_verified);
 assert.equal(ctx.b.controlStore.run(ctx.run.id).state,hostBefore.state);
 assert.equal(ctx.b.controlStore.db.prepare('SELECT state FROM cp_leases WHERE id=?').get(ctx.lease.id).state,leaseBefore);
 const evidenceAfter=ctx.b.controlStore.db.prepare('SELECT state,sha256 FROM cp_mission_web_boot_recovery WHERE evidence_id=?').get(prepared.evidence_id);
 assert.equal(evidenceAfter.state,evidenceBefore.state);
 assert.equal(evidenceAfter.sha256,evidenceBefore.sha256);
 assert.equal(evidenceAfter.state,'prepared');
});

test('bridge-invocation boot recovery: works after host web-boot consume (witness accepts consumed)',async t=>{
 const {ctx,prepared,advance}=await preparedBootFixture(t,{priorOffsetSec:8_100,usec:12});
 const priorMs=ctx.run.updated_at;
 const {bridgeId,invocationId}=bridgeInvocationFixture(ctx,priorMs);
 advance();
 const hostOk=ctx.b.missions.web.reconcileBootRecovery(bootReconcile(ctx,prepared));
 assert.equal(hostOk.recovery_not_execution,true);
 assert.equal(ctx.b.controlStore.db.prepare("SELECT state FROM cp_mission_web_boot_recovery WHERE evidence_id=?").get(prepared.evidence_id).state,'consumed');
 const ok=ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,invocationId));
 assert.equal(ok.recovery_not_execution,true);
 assert.equal(ok.boot_boundary_state,'consumed');
 assert.equal(ctx.b.controlStore.run(bridgeId).termination_verified,1);
 assert.equal(ctx.b.controlStore.invocation(invocationId).state,'settled');
 assert.equal(ctx.b.controlStore.db.prepare("SELECT state FROM cp_mission_web_boot_recovery WHERE evidence_id=?").get(prepared.evidence_id).state,'consumed');
});

test('bridge-invocation boot recovery: unproven same-task inv stays unknown',async t=>{
 const {ctx,prepared,advance}=await preparedBootFixture(t,{priorOffsetSec:8_700,usec:13});
 const priorMs=ctx.run.updated_at;
 const {bridgeId,invocationId}=bridgeInvocationFixture(ctx,priorMs,{owned:false});
 advance();
 assert.throws(()=>ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,invocationId)),/invocation_run_ownership_unproven/);
 assert.equal(ctx.b.controlStore.run(bridgeId).termination_verified,0);
 assert.equal(ctx.b.controlStore.invocation(invocationId).state,'unknown');
});

test('bridge-invocation boot recovery: refuses host run, web-proven bridge, wrong bindings, tamper, wrong epoch',async t=>{
 const {ctx,prepared,advance}=await preparedBootFixture(t,{priorOffsetSec:9_300,usec:14});
 const priorMs=ctx.run.updated_at;
 const {bridgeId,invocationId}=bridgeInvocationFixture(ctx,priorMs);
 advance();
 // Host run is not a bridge invocation lease.
 assert.throws(()=>ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,ctx.run.id,invocationId)),/bridge_invocation_agent_denied|boot_boundary_witness_self_run_denied/);
 // Wrong mission.
 assert.throws(()=>ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,invocationId,{mission_id:randomUUID()})),/recovery_evidence_registry_mismatch|mission_run_binding_mismatch/);
 // Wrong invocation id with no ledger bind.
 const otherInv=randomUUID();
 ctx.b.controlStore.beginInvocation(ctx.run.task_id,otherInv,'other-hash');
 ctx.b.controlStore.db.prepare("UPDATE cp_invocations SET state='unknown',created_at=?,updated_at=? WHERE request_id=?").run(priorMs,priorMs,otherInv);
 assert.throws(()=>ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,otherInv)),/invocation_run_ownership_unproven/);
 // Tampered witness digest.
 const file=path.join(ctx.b.dataDir,'recovery','web-termination',prepared.evidence_id+'.json');
 const original=fs.readFileSync(file);
 fs.writeFileSync(file,Buffer.concat([original,Buffer.from(' ')]));
 assert.throws(()=>ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,invocationId)),/recovery_evidence_digest_mismatch/);
 fs.writeFileSync(file,original,{mode:0o600});
 // Incorrect sha256.
 assert.throws(()=>ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,invocationId,{boot_boundary_sha256:'0'.repeat(64)})),/recovery_evidence_registry_mismatch/);
 // Web-proven bridge sibling must use web path.
 const webBridge=randomUUID();
 ctx.b.controlStore.startRun({id:webBridge,taskId:ctx.run.task_id,missionId:ctx.m.mission_id,agentId:'bridge'});
 ctx.b.controlStore.updateRun(webBridge,{state:'interrupted',processState:'unknown',verified:false,resolution:'reconcile_process'});
 ctx.b.controlStore.db.prepare('UPDATE cp_runs SET updated_at=?,ended_at=? WHERE id=?').run(priorMs,priorMs,webBridge);
 ctx.b.controlStore.db.prepare('INSERT INTO cp_mission_web_evidence VALUES(?,?,?,?,?,?,?,?)')
  .run(randomUUID(),randomUUID(),ctx.m.mission_id,ctx.run.task_id,webBridge,'a'.repeat(64),invocationId,priorMs);
 assert.throws(()=>ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,webBridge,invocationId)),/bridge_web_evidence_use_web_boot_recovery/);
});

test('bridge-invocation boot recovery: post-boot execution and observational approval decision',async t=>{
 const execCase=await preparedBootFixture(t,{priorOffsetSec:9_900,usec:15});
 const priorMs=execCase.ctx.run.updated_at;
 const owned=bridgeInvocationFixture(execCase.ctx,priorMs);
 const next=execCase.advance();
 const ts=bootEpochMs(next)+500;
 insertLedger(execCase.ctx.b,{runId:owned.bridgeId,missionId:execCase.ctx.m.mission_id,taskId:execCase.ctx.run.task_id,requestId:owned.invocationId,eventType:'capability.completed',ts,metadata:{request_id:owned.invocationId}});
 assert.throws(()=>execCase.ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(execCase.ctx,execCase.prepared,owned.bridgeId,owned.invocationId)),/post_boot_execution_observed/);

 const obs=await preparedBootFixture(t,{priorOffsetSec:10_500,usec:16});
 const priorObs=obs.ctx.run.updated_at;
 const o=bridgeInvocationFixture(obs.ctx,priorObs);
 const nextObs=obs.advance();
 insertLedger(obs.ctx.b,{runId:o.bridgeId,missionId:obs.ctx.m.mission_id,taskId:obs.ctx.run.task_id,requestId:null,eventType:'approval.decision',ts:bootEpochMs(nextObs)+400,metadata:{reason:'Mission authority expired'}});
 const ok=obs.ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(obs.ctx,obs.prepared,o.bridgeId,o.invocationId));
 assert.equal(ok.recovery_not_execution,true);
 assert.equal(obs.ctx.b.controlStore.run(o.bridgeId).termination_verified,1);
});

test('bridge-invocation boot recovery: refuses active mission, cross-capability replay, and leaves HOLD when partial',async t=>{
 const {ctx,prepared,advance}=await preparedBootFixture(t,{priorOffsetSec:11_100,usec:17});
 const priorMs=ctx.run.updated_at;
 const active=bridgeInvocationFixture(ctx,priorMs,{missionCancelled:false});
 // Force mission back to a non-cancelled durable state if cancel was not applied.
 if(ctx.b.controlStore.getMission(ctx.m.mission_id).state==='cancelled'){
  ctx.b.controlStore.db.prepare("UPDATE cp_missions SET state='blocked' WHERE id=?").run(ctx.m.mission_id);
 }
 advance();
 assert.throws(()=>ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,active.bridgeId,active.invocationId)),/bridge_invocation_mission_not_cancelled/);

 const hold=await preparedBootFixture(t,{priorOffsetSec:11_700,usec:18});
 const priorHold=hold.ctx.run.updated_at;
 const unproven=bridgeInvocationFixture(hold.ctx,priorHold,{owned:false});
 hold.advance();
 assert.throws(()=>hold.ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(hold.ctx,hold.prepared,unproven.bridgeId,unproven.invocationId)),/invocation_run_ownership_unproven/);
 // Host still unresolved + unproven inv => durable blockers remain (HOLD semantics).
 assert.equal(hold.ctx.b.controlStore.run(hold.ctx.run.id).termination_verified,0);
 assert.equal(hold.ctx.b.controlStore.invocation(unproven.invocationId).state,'unknown');
 const blockers=require('../src/run-settlement').durableBlockers(hold.ctx.b.controlStore.db);
 assert.ok(blockers.runs>=1);
 assert.ok(blockers.invocations>=1);
});

test('bridge-invocation boot recovery: exact run isolation — settling A does not settle B',async t=>{
 const {ctx,prepared,advance}=await preparedBootFixture(t,{priorOffsetSec:12_300,usec:19});
 const priorMs=ctx.run.updated_at;
 const a=bridgeInvocationFixture(ctx,priorMs);
 const b=bridgeInvocationFixture(ctx,priorMs);
 advance();
 const ok=ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,a.bridgeId,a.invocationId));
 assert.equal(ok.run_id,a.bridgeId);
 assert.equal(ctx.b.controlStore.run(a.bridgeId).termination_verified,1);
 assert.equal(ctx.b.controlStore.run(b.bridgeId).termination_verified,0);
 assert.equal(ctx.b.controlStore.invocation(b.invocationId).state,'unknown');
 assert.equal(ctx.b.controlStore.run(ctx.run.id).termination_verified,0);
});

test('bridge-invocation ownership: lease_acquired with previous request_id cannot settle; capability bind required',async t=>{
 // Reproduce the real orchestrator order: leases.acquire records lifecycle.lease_acquired
 // using the still-current task.latestMcpRequestId (previous invocation), then the new
 // request_id is assigned and orchestrator.capability.requested is recorded.
 const {ctx,prepared,advance}=await preparedBootFixture(t,{priorOffsetSec:12_900,usec:20});
 const {b,m,run}=ctx;
 const task=b.tasks.get(run.task_id);
 const previousId=randomUUID(), currentId=randomUUID();
 const priorMs=run.updated_at;
 b.controlStore.beginInvocation(task.id,previousId,'prev-bridge-hash');
 b.controlStore.db.prepare("UPDATE cp_invocations SET state='unknown',created_at=?,updated_at=? WHERE request_id=?").run(priorMs,priorMs,previousId);
 task.latestMcpRequestId=previousId; b.tasks.save(task);
 const lease=b.leases.acquire(task.id,{agentId:'bridge'});
 const bridgeId=lease.runId;
 const leaseEvt=b.controlStore.db.prepare("SELECT request_id FROM event_ledger_events WHERE run_id=? AND event_type='lifecycle.lease_acquired'").get(bridgeId);
 assert.equal(leaseEvt.request_id,previousId,'lease event must carry previous invocation id');
 task.latestMcpRequestId=currentId; task.activeRunId=bridgeId; b.tasks.save(task);
 b.controlStore.beginInvocation(task.id,currentId,'curr-bridge-hash');
 b.controlStore.db.prepare("UPDATE cp_invocations SET state='unknown',created_at=?,updated_at=? WHERE request_id=?").run(priorMs,priorMs,currentId);
 b._ledgerRecord({...b._ledgerContext(task),eventType:'orchestrator.capability.requested',agent:'chatgpt',direction:'incoming',status:'received',
  metadata:{capability:'mission_web',request_id:currentId},idempotencyKey:'ownership-order:'+currentId},{critical:true});
 b.controlStore.updateRun(bridgeId,{state:'interrupted',processState:'unknown',verified:false,resolution:'reconcile_process'});
 b.controlStore.db.prepare('UPDATE cp_runs SET updated_at=?,ended_at=? WHERE id=?').run(priorMs,priorMs,bridgeId);
 if(b.controlStore.getMission(m.mission_id).state!=='cancelled')b.controlStore.state(m.mission_id,'cancelled','fixture_stop');
 // Drop in-memory lease so fixture teardown is not blocked; durable ownership is what recovery inspects.
 b.leases.releaseIfOwner(lease,{verified:false});
 advance();
 const hostBefore=b.controlStore.run(run.id);
 // Previous inv: only lease_acquired binds it to this run — must fail closed.
 assert.throws(()=>b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,previousId)),/invocation_run_ownership_unproven/);
 assert.equal(b.controlStore.invocation(previousId).state,'unknown');
 assert.equal(b.controlStore.run(bridgeId).termination_verified,0);
 // Current inv: authoritative capability request bind — settles only that inv + run.
 const ok=b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,currentId));
 assert.equal(ok.recovery_not_execution,true);
 assert.equal(ok.invocation_id,currentId);
 assert.equal(b.controlStore.invocation(currentId).state,'settled');
 assert.equal(b.controlStore.invocation(previousId).state,'unknown');
 assert.equal(b.controlStore.run(bridgeId).termination_verified,1);
 assert.equal(b.controlStore.run(run.id).termination_verified,hostBefore.termination_verified);
 assert.equal(b.controlStore.db.prepare("SELECT state FROM cp_mission_web_boot_recovery WHERE evidence_id=?").get(prepared.evidence_id).state,'prepared');
});

function deniedSameBoot(ctx,bridgeId,invocationId,overrides={}){
 return {
  run_id:bridgeId,mission_id:ctx.m.mission_id,invocation_id:invocationId,
  termination_verified:true,request_id:randomUUID(),recovery_kind:'denied_in_process_same_boot',...overrides
 };
}
function markDenied(ctx,bridgeId,invocationId,ts,{approved=false,capability='mission_web'}={}){
 insertLedger(ctx.b,{runId:bridgeId,missionId:ctx.m.mission_id,taskId:ctx.run.task_id,requestId:invocationId,eventType:'capability.requested',ts,metadata:{capability,request_id:invocationId,approved,automatic:true,origin:'orchestrator'}});
}

test('bridge-invocation same-boot denied: settles exact run/inv; preserves host quarantine and sibling',async t=>{
 const {ctx}=await preparedBootFixture(t,{priorOffsetSec:14_700,usec:23});
 const priorMs=ctx.run.updated_at;
 const a=bridgeInvocationFixture(ctx,priorMs);
 const b=bridgeInvocationFixture(ctx,priorMs);
 markDenied(ctx,a.bridgeId,a.invocationId,priorMs);
 markDenied(ctx,b.bridgeId,b.invocationId,priorMs);
 const hostBefore=ctx.b.controlStore.run(ctx.run.id);
 const leaseBefore=ctx.b.controlStore.db.prepare('SELECT state FROM cp_leases WHERE id=?').get(ctx.lease.id).state;
 const ok=ctx.b.missions.bridgeInvocation.reconcileDeniedSameBoot(deniedSameBoot(ctx,a.bridgeId,a.invocationId));
 assert.equal(ok.recovery_not_execution,true);
 assert.equal(ok.recovery_kind,'denied_in_process_same_boot');
 assert.equal(ok.run_id,a.bridgeId);
 assert.equal(ok.invocation_id,a.invocationId);
 assert.equal(ctx.b.controlStore.run(a.bridgeId).state,'cancelled');
 assert.equal(ctx.b.controlStore.run(a.bridgeId).termination_verified,1);
 assert.equal(ctx.b.controlStore.run(a.bridgeId).resolution,'operator_bridge_invocation_denied_same_boot');
 assert.equal(ctx.b.controlStore.invocation(a.invocationId).state,'settled');
 assert.equal(ctx.b.controlStore.run(b.bridgeId).termination_verified,0);
 assert.equal(ctx.b.controlStore.invocation(b.invocationId).state,'unknown');
 assert.equal(ctx.b.controlStore.run(ctx.run.id).termination_verified,hostBefore.termination_verified);
 assert.equal(ctx.b.controlStore.run(ctx.run.id).state,hostBefore.state);
 assert.equal(ctx.b.controlStore.db.prepare('SELECT state FROM cp_leases WHERE id=?').get(ctx.lease.id).state,leaseBefore);
});

test('bridge-invocation same-boot denied: refuses missing denial, approved execution, detached/external uncertainty',async t=>{
 const missing=await preparedBootFixture(t,{priorOffsetSec:15_300,usec:24});
 const priorMissing=missing.ctx.run.updated_at;
 const owned=bridgeInvocationFixture(missing.ctx,priorMissing);
 assert.throws(()=>missing.ctx.b.missions.bridgeInvocation.reconcileDeniedSameBoot(deniedSameBoot(missing.ctx,owned.bridgeId,owned.invocationId)),/bridge_invocation_denial_unproven/);
 assert.equal(missing.ctx.b.controlStore.invocation(owned.invocationId).state,'unknown');

 const approved=await preparedBootFixture(t,{priorOffsetSec:15_900,usec:25});
 const priorApproved=approved.ctx.run.updated_at;
 const ap=bridgeInvocationFixture(approved.ctx,priorApproved);
 markDenied(approved.ctx,ap.bridgeId,ap.invocationId,priorApproved,{approved:true});
 assert.throws(()=>approved.ctx.b.missions.bridgeInvocation.reconcileDeniedSameBoot(deniedSameBoot(approved.ctx,ap.bridgeId,ap.invocationId)),/bridge_invocation_execution_not_denied/);

 const post=await preparedBootFixture(t,{priorOffsetSec:16_500,usec:26});
 const priorPost=post.ctx.run.updated_at;
 const p=bridgeInvocationFixture(post.ctx,priorPost);
 markDenied(post.ctx,p.bridgeId,p.invocationId,priorPost);
 insertLedger(post.ctx.b,{runId:p.bridgeId,missionId:post.ctx.m.mission_id,taskId:post.ctx.run.task_id,requestId:p.invocationId,eventType:'capability.completed',ts:priorPost+1,metadata:{request_id:p.invocationId}});
 assert.throws(()=>post.ctx.b.missions.bridgeInvocation.reconcileDeniedSameBoot(deniedSameBoot(post.ctx,p.bridgeId,p.invocationId)),/bridge_invocation_post_denial_execution/);

 const pid=await preparedBootFixture(t,{priorOffsetSec:17_100,usec:27});
 const priorPid=pid.ctx.run.updated_at;
 const pr=bridgeInvocationFixture(pid.ctx,priorPid);
 markDenied(pid.ctx,pr.bridgeId,pr.invocationId,priorPid);
 pid.ctx.b.controlStore.db.prepare('UPDATE cp_runs SET pid=? WHERE id=?').run(424242,pr.bridgeId);
 assert.throws(()=>pid.ctx.b.missions.bridgeInvocation.reconcileDeniedSameBoot(deniedSameBoot(pid.ctx,pr.bridgeId,pr.invocationId)),/owned_process_pid_present_use_pid_reconcile/);

 const external=await preparedBootFixture(t,{priorOffsetSec:17_700,usec:28});
 const priorExt=external.ctx.run.updated_at;
 const ex=bridgeInvocationFixture(external.ctx,priorExt);
 markDenied(external.ctx,ex.bridgeId,ex.invocationId,priorExt);
 if(external.ctx.b.controlStore.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cp_slack_outbox'").get()){
  external.ctx.b.controlStore.db.prepare("INSERT INTO cp_slack_outbox(id,mission_id,kind,body,state,attempts,next_at,created_at) VALUES(?,?,?,?,?,?,?,?)")
   .run(randomUUID(),external.ctx.m.mission_id,'notify','{}','delivery_unknown',0,priorExt,priorExt);
  assert.throws(()=>external.ctx.b.missions.bridgeInvocation.reconcileDeniedSameBoot(deniedSameBoot(external.ctx,ex.bridgeId,ex.invocationId)),/bridge_invocation_external_effect_uncertain/);
 }
});

test('bridge-invocation same-boot denied: refuses wrong kind, uncancelled mission, previous request_id, and fabricated cold-boot fields',async t=>{
 const kind=await preparedBootFixture(t,{priorOffsetSec:18_300,usec:29});
 const priorKind=kind.ctx.run.updated_at;
 const k=bridgeInvocationFixture(kind.ctx,priorKind);
 markDenied(kind.ctx,k.bridgeId,k.invocationId,priorKind);
 assert.throws(()=>kind.ctx.b.missions.bridgeInvocation.reconcileDeniedSameBoot(deniedSameBoot(kind.ctx,k.bridgeId,k.invocationId,{recovery_kind:'cold_os_reboot'})),/denied_in_process_same_boot_required/);

 const ignored=await preparedBootFixture(t,{priorOffsetSec:18_600,usec:32});
 const priorIgnored=ignored.ctx.run.updated_at;
 const ig=bridgeInvocationFixture(ignored.ctx,priorIgnored);
 markDenied(ignored.ctx,ig.bridgeId,ig.invocationId,priorIgnored);
 // Fabricated cold-boot witness fields are refused (exact schema); same-boot never consumes a boot packet.
 assert.throws(()=>ignored.ctx.b.missions.bridgeInvocation.reconcileDeniedSameBoot({
  run_id:ig.bridgeId,mission_id:ignored.ctx.m.mission_id,invocation_id:ig.invocationId,termination_verified:true,
  request_id:randomUUID(),recovery_kind:'denied_in_process_same_boot',
  boot_boundary_evidence_id:randomUUID(),boot_boundary_sha256:'a'.repeat(64)
 }),/Unexpected input fields/);
 assert.equal(ignored.ctx.b.controlStore.run(ig.bridgeId).termination_verified,0);

 const blocked=await preparedBootFixture(t,{priorOffsetSec:18_900,usec:30});
 const priorBlocked=blocked.ctx.run.updated_at;
 const bl=bridgeInvocationFixture(blocked.ctx,priorBlocked,{missionCancelled:false});
 markDenied(blocked.ctx,bl.bridgeId,bl.invocationId,priorBlocked);
 if(blocked.ctx.b.controlStore.getMission(blocked.ctx.m.mission_id).state==='cancelled'){
  blocked.ctx.b.controlStore.db.prepare("UPDATE cp_missions SET state='blocked' WHERE id=?").run(blocked.ctx.m.mission_id);
 }
 assert.throws(()=>blocked.ctx.b.missions.bridgeInvocation.reconcileDeniedSameBoot(deniedSameBoot(blocked.ctx,bl.bridgeId,bl.invocationId)),/bridge_invocation_mission_not_cancelled/);

 const prev=await preparedBootFixture(t,{priorOffsetSec:19_500,usec:31});
 const {b,m,run}=prev.ctx;
 const task=b.tasks.get(run.task_id);
 const previousId=randomUUID(), currentId=randomUUID();
 const priorPrev=run.updated_at;
 b.controlStore.beginInvocation(task.id,previousId,'prev-same-boot-hash');
 b.controlStore.db.prepare("UPDATE cp_invocations SET state='unknown',created_at=?,updated_at=? WHERE request_id=?").run(priorPrev,priorPrev,previousId);
 task.latestMcpRequestId=previousId; b.tasks.save(task);
 const lease=b.leases.acquire(task.id,{agentId:'bridge'});
 const bridgePrev=lease.runId;
 task.latestMcpRequestId=currentId; task.activeRunId=bridgePrev; b.tasks.save(task);
 b.controlStore.beginInvocation(task.id,currentId,'curr-same-boot-hash');
 b.controlStore.db.prepare("UPDATE cp_invocations SET state='unknown',created_at=?,updated_at=? WHERE request_id=?").run(priorPrev,priorPrev,currentId);
 b._ledgerRecord({...b._ledgerContext(task),eventType:'orchestrator.capability.requested',agent:'chatgpt',direction:'incoming',status:'received',
  metadata:{capability:'mission_web',request_id:currentId},idempotencyKey:'same-boot-own:'+currentId},{critical:true});
 insertLedger(b,{runId:bridgePrev,missionId:m.mission_id,taskId:run.task_id,requestId:currentId,eventType:'capability.requested',ts:priorPrev,metadata:{capability:'mission_web',request_id:currentId,approved:false}});
 b.controlStore.updateRun(bridgePrev,{state:'interrupted',processState:'unknown',verified:false,resolution:'reconcile_process'});
 b.controlStore.db.prepare('UPDATE cp_runs SET updated_at=?,ended_at=? WHERE id=?').run(priorPrev,priorPrev,bridgePrev);
 if(b.controlStore.getMission(m.mission_id).state!=='cancelled')b.controlStore.state(m.mission_id,'cancelled','fixture_stop');
 b.leases.releaseIfOwner(lease,{verified:false});
 assert.throws(()=>b.missions.bridgeInvocation.reconcileDeniedSameBoot(deniedSameBoot(prev.ctx,bridgePrev,previousId)),/invocation_run_ownership_unproven/);
 const ok=b.missions.bridgeInvocation.reconcileDeniedSameBoot(deniedSameBoot(prev.ctx,bridgePrev,currentId));
 assert.equal(ok.recovery_not_execution,true);
 assert.equal(b.controlStore.invocation(currentId).state,'settled');
 assert.equal(b.controlStore.invocation(previousId).state,'unknown');
});

test('bridge-invocation ownership: contradictory or capability-less binds fail closed',async t=>{
 const {ctx,prepared,advance}=await preparedBootFixture(t,{priorOffsetSec:13_500,usec:21});
 const priorMs=ctx.run.updated_at;
 const {bridgeId,invocationId}=bridgeInvocationFixture(ctx,priorMs,{owned:false});
 // Column/metadata request_id mismatch on an otherwise matching event type.
 const eventId=randomUUID();
 ctx.b.controlStore.db.prepare("INSERT INTO event_ledger_events(event_id,idempotency_key,fingerprint,event_type,timestamp,timestamp_ms,run_id,mission_id,task_id,request_id,agent,direction,metadata,payload_byte_length,payload_stored_byte_length,payload_redacted,payload_truncated,protected) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(eventId,eventId,eventId,'orchestrator.capability.requested',new Date(priorMs).toISOString(),priorMs,bridgeId,ctx.m.mission_id,ctx.run.task_id,invocationId,'bridge','internal',JSON.stringify({capability:'mission_web',request_id:randomUUID()}),0,0,0,0,0);
 advance();
 assert.throws(()=>ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(ctx,prepared,bridgeId,invocationId)),/invocation_ownership_contradiction/);
 assert.equal(ctx.b.controlStore.invocation(invocationId).state,'unknown');
 assert.equal(ctx.b.controlStore.run(bridgeId).termination_verified,0);

 const missing=await preparedBootFixture(t,{priorOffsetSec:14_100,usec:22});
 const priorMissing=missing.ctx.run.updated_at;
 const fx=bridgeInvocationFixture(missing.ctx,priorMissing,{owned:false});
 insertLedger(missing.ctx.b,{runId:fx.bridgeId,missionId:missing.ctx.m.mission_id,taskId:missing.ctx.run.task_id,requestId:fx.invocationId,eventType:'orchestrator.capability.requested',ts:priorMissing,metadata:{request_id:fx.invocationId}});
 missing.advance();
 assert.throws(()=>missing.ctx.b.missions.bridgeInvocation.reconcileBoot(bridgeReconcile(missing.ctx,missing.prepared,fx.bridgeId,fx.invocationId)),/invocation_ownership_capability_required/);
 assert.equal(missing.ctx.b.controlStore.invocation(fx.invocationId).state,'unknown');
});
