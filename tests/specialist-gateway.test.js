'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {setup}=require('./fixtures/cursor-autonomy-fixture.cjs');
test('specialist graph returns each result to OpenCode and automatically accepts after final host checks',async t=>{
 const f=await setup(t),p=await f.ask();assert.ok(p.mission_id&&['DISPATCHED','RUNNING'].includes(p.state),JSON.stringify(p));
 const m=await f.settle(p.mission_id,'completed');assert.equal(m.specialists.assignments.length,2);assert.ok(m.specialists.assignments.every(a=>a.state==='ready'));
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].writable,[]);assert.equal(f.evaluations.length,2);
 assert.equal(f.evaluations[0].specialist_return.assignment.id,'implement');assert.equal(f.evaluations[1].specialist_return.assignment.id,'review');assert.equal(f.evaluations[1].specialist_return.prior_results.length,1);
 const e=require('../src/mission-evidence').evidencePackage(f.bridge,m.id);assert.equal(e.acceptance_status,'accepted');assert.equal(e.verification.result,'passed');assert.equal(e.cognitive.counts.execution,2);
 assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(m.id).n,0);
 await f.reopen();assert.equal(require('../src/mission-evidence').evidencePackage(f.bridge,m.id).acceptance_status,'accepted');
});
test('mixed Cursor and OpenCode tasks preserve worker identity and share one parent scope',async t=>{
 const f=await setup(t,{cursor:true,repairs:0,standing:false}),p=await f.ask();assert.equal(p.state,'WAIT',JSON.stringify(p));
 const a=await f.bridge.zeroSetupWork.approve({request_id:p.request_id,confirmed:true,channel:'control_center',subscription_execution:{provider:'cursor',acknowledge_unknown_cost:true,max_invocations:1,max_runtime_ms:120000}},'operator');
 const m=await f.settle(a.mission_id,'completed');assert.deepEqual(m.specialists.assignments.map(a=>a.worker),['cursor','opencode']);
 assert.deepEqual(f.evaluations.map(e=>e.worker.agent),['cursor','opencode']);assert.equal(m.acceptance.length,1);
});
test('final evaluator requests one bounded edit repair and completion remains automatic',async t=>{
 const f=await setup(t,{repairs:1});f.plan=f.plan.slice(0,1);
 f.evaluate=o=>({...o.coordination.result_contract,recommendation:f.evaluations.length===1?'repair':'ready',summary:'Bounded correction then re-evaluation.'});
 const p=await f.ask({review:false}),m=await f.settle(p.mission_id,'completed');
 assert.equal(f.calls[1].input.repair_context.summary,'Bounded correction then re-evaluation.');assert.ok(f.calls[1].input.repair_context.evaluation_run_id);assert.ok(f.calls[1].input.repair_context.host_checks.length);
 assert.equal(m.specialists.repair_attempts,1);assert.equal(m.specialists.assignments[0].attempts.length,2);assert.equal(f.evaluations.length,2);assert.equal(m.acceptance.length,1);
});
test('read-only reviewer returns a correction to the original editor and is re-run within the shared budget',async t=>{
 const f=await setup(t,{repairs:2});
 f.evaluate=o=>({...o.coordination.result_contract,...(f.evaluations.length===2?{recommendation:'repair',repair_assignment:'implement'}:{recommendation:'ready'}),summary:'Review the existing implementation.'});
 const p=await f.ask(),m=await f.settle(p.mission_id,'completed');
 const status=await new(require('../src/mcp-tools').McpTools)(f.bridge).call('get_mission_status',{mission_id:m.id});assert.equal(status.repair_attempts,2);assert.equal(status.specialists.assignments.length,2);
 const evidence=require('../src/mission-evidence').evidencePackage(f.bridge,m.id);assert.equal(evidence.repair_attempts,2);assert.equal(evidence.answers.attempts,4);assert.equal(evidence.answers.requires_owner.length,0);assert.equal(evidence.settlement_status,'settled');
 assert.equal(m.specialists.repair_attempts,2);assert.equal(f.evaluations.length,4);assert.ok(m.specialists.assignments.every(a=>a.attempts.length===2));assert.equal(m.acceptance.length,1);
});
test('repair ceiling stops repeated evaluator demands without another dispatch',async t=>{
 const f=await setup(t,{repairs:1});f.plan=f.plan.slice(0,1);
 f.evaluate=o=>({...o.coordination.result_contract,recommendation:'repair',summary:'Further correction requested.'});
 const p=await f.ask({review:false}),m=await f.settle(p.mission_id,'needs_rework');
 assert.equal(f.calls.length,2);assert.equal(m.acceptance.length,0);assert.equal(m.specialists.repair_attempts,1);
});
test('program cancellation during evaluation prevents final acceptance',async t=>{
 const f=await setup(t);f.plan=f.plan.slice(0,1);
 f.evaluate=o=>{f.bridge.missions.program.cancel(o.coordination.specialist_return.assignment.parent_mission_id,randomUUID());return {...o.coordination.result_contract,summary:'Cancellation was requested.'};};
 const p=await f.ask({review:false}),m=await f.settle(p.mission_id,'cancelled');assert.equal(m.acceptance.length,0);
});
test('pending protected action blocks automatic acceptance without discarding verified results',async t=>{
 const f=await setup(t);f.plan=f.plan.slice(0,1);
 const list=f.bridge.policy.list.bind(f.bridge.policy);
 f.evaluate=o=>{const m=f.bridge.controlStore.requireMission(o.coordination.specialist_return.assignment.parent_mission_id);f.bridge.policy.list=()=>[...list(),{status:'pending',taskId:m.task_id}];return {...o.coordination.result_contract,summary:'Verified result retained.'};};
 const p=await f.ask({review:false}),m=await f.settle(p.mission_id,'awaiting_acceptance');assert.equal(m.acceptance.length,0);
 assert.equal(require('../src/specialist-gateway').autoAccept(f.bridge,m.id).reason,'pending_protected_action');
 f.bridge.policy.list=list;assert.equal(require('../src/specialist-gateway').autoAccept(f.bridge,m.id).accepted,true);
});
test('planner cannot add unauthorized file scope, executable review, or an unqualified worker',async t=>{
 for(const change of [p=>p[0].paths.push('outside.txt'),p=>p[1].operation='edit',p=>p[0].worker='codex']){
  const f=await setup(t);change(f.plan);const p=await f.ask();assert.equal(p.state,'BLOCKED');assert.equal(f.calls.length,0);assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_subscription_invocations').get().n,0);
 }
});

test('restart after a completed assignment advances from durable receipts without relaunching it',async t=>{
 const f=await setup(t);f.bridge.missions.program.tick=()=>{};
 const p=await f.ask();let ready=false;
 for(let i=0;i<100;i++){await f.bridge.missions.tick();const m=f.bridge.missions.detail(p.mission_id);if(m.specialists.assignments[0].state==='ready'){ready=true;break;}if(['blocked','needs_rework'].includes(m.state))assert.fail(m.reason);await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready);assert.equal(f.calls.length,1);assert.equal(f.evaluations.length,1);
 const previousClosed=process.env.AIRODROM_START_CLOSED;process.env.AIRODROM_START_CLOSED='1';
 try{await f.reopen({beforeResume:()=>f.bindAdapter()});}finally{if(previousClosed===undefined)delete process.env.AIRODROM_START_CLOSED;else process.env.AIRODROM_START_CLOSED=previousClosed;}
 const m=await f.settle(p.mission_id,'completed');assert.equal(f.calls.length,2);assert.equal(f.evaluations.length,2);assert.equal(m.specialists.assignments[0].attempts.length,1);assert.equal(m.acceptance.length,1);
});
test('modified historical receipt prevents successor dispatch',async t=>{
 const f=await setup(t);f.bridge.missions.program.tick=()=>{};
 const p=await f.ask();let m;
 for(let i=0;i<100;i++){await f.bridge.missions.tick();m=f.bridge.missions.detail(p.mission_id);if(m.specialists.assignments[0].state==='ready')break;if(['blocked','needs_rework'].includes(m.state))assert.fail(m.reason);await new Promise(r=>setTimeout(r,100));}
 assert.equal(m.specialists.assignments[0].state,'ready');
 const db=f.bridge.controlStore.db,row=db.prepare("SELECT input FROM cp_mission_program_nodes WHERE program_id=? AND node_id='implement'").get(m.id),record=JSON.parse(row.input);
 record.attempts[0].integrity_hash='0'.repeat(64);db.prepare("UPDATE cp_mission_program_nodes SET input=? WHERE program_id=? AND node_id='implement'").run(JSON.stringify(record),m.id);
 assert.throws(()=>f.bridge.missions.queue(m.id),/gateway_assignment_evidence_changed/);assert.equal(f.calls.length,1);assert.equal(m.acceptance.length,0);
});

test('whole-graph deadline uses immutable contract time and prevents a late host check',async()=>{
 const now=Date.now(),m={id:'test',created_at:now,envelope:{cognitive:{envelope:{version:3,expires_at:now+600000}},contract:{identity:{created_at:now-61000,expires_at:now+600000},budget:{max_wall_clock_ms:60000}}}};
 assert.ok(require('../src/specialist-gateway').deadline(m)<now);
 let calls=0;const b={invokeCapability:()=>{calls++;},capabilityHost:{jobs:{jobs:new Map()}}};
 const v=new(require('../src/mission-verifier').MissionVerifier)(b,{});
 await assert.rejects(v.invokeVerificationCapability({id:'test'},m,{id:'run'},'vscode_run_task',{timeoutSeconds:60}),/runtime_exhausted/);assert.equal(calls,0);
});

test('pending host check is cancelled synchronously when the graph deadline wins the recovery race',async()=>{
 const S=require('../src/specialist-gateway'),oldAssert=S.assertRoot,now=Date.now();
 const m={id:'synthetic-deadline',created_at:now,envelope:{cognitive:{envelope:{version:3,expires_at:now+600000}},contract:{identity:{created_at:now-58950,expires_at:now+600000},budget:{max_wall_clock_ms:60000}}}};
 let cancelled=0;const job={taskId:'synthetic-task'},inflight=new Map();
 const b={missions:{assertAuthority(){}},orchestrator:{inflight},capabilityHost:{jobs:{jobs:new Map([['synthetic-job',job]]),cancel(j){assert.equal(j,job);cancelled++;}}},invokeCapability:async(id,call)=>{inflight.set(call.requestId,new Promise(()=>{}));return{status:'pending'};}};
 const v=new(require('../src/mission-verifier').MissionVerifier)(b,{requireMission:()=>m});
 const keep=setTimeout(()=>{},3000);S.assertRoot=()=>{};
 try{await assert.rejects(v.invokeVerificationCapability({id:job.taskId},m,{id:'synthetic-run'},'vscode_run_task',{timeoutSeconds:60}),/deadline exceeded/);assert.ok(cancelled>0);}finally{S.assertRoot=oldAssert;clearTimeout(keep);}
});

test('one ordinary request reuses standing authority and corrects actual wrong bytes with a separate Cursor run',async t=>{
 const fs=require('node:fs'),f=await setup(t,{repairs:1,caller:'mcp:'+randomUUID()});f.plan=f.plan.slice(0,1);f.wrongFirst=true;
 const snapshots=[];const evaluate=f.evaluate;f.evaluate=o=>{snapshots.push({bytes:fs.readFileSync(path.join(o.workspace,'fixture.txt')).toString('hex'),checks:o.coordination.host_checks});return evaluate(o);};
 assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt')).toString('hex'),'616c7068610a');
 const p=await f.ask({review:false});assert.ok(p.mission_id,JSON.stringify(p));
 const same=await f.bridge.zeroSetupWork.ask(f.request,f.caller);assert.equal(same.mission_id,p.mission_id);
 const m=await f.settle(p.mission_id,'completed'),e=require('../src/mission-evidence').evidencePackage(f.bridge,m.id);
 const attempts=m.specialists.assignments[0].attempts;
 assert.equal(attempts.length,2);assert.notEqual(attempts[0].run_id,attempts[1].run_id);
 assert.deepEqual(f.calls.map(c=>c.worker),['cursor','cursor']);
 assert.deepEqual(snapshots.map(s=>s.bytes),['67616d6d610a','626574610a']);
 assert.ok(snapshots[0].checks.some(c=>c.status==='failed'));assert.ok(snapshots[1].checks.every(c=>c.status==='passed'));
 assert.equal(attempts[0].verification.status,'failed');assert.equal(attempts[1].verification.status,'passed');
 assert.equal(e.acceptance_status,'accepted');assert.equal(e.settlement_status,'settled');assert.equal(m.acceptance.length,1);
 assert.equal(fs.readFileSync(path.join(m.envelope.workspace,'fixture.txt')).toString('hex'),'626574610a');
 const db=f.bridge.controlStore.db;
 assert.equal(db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(m.id).n,0);
 assert.equal(db.prepare('SELECT missions_used n FROM cp_standing_cursor_development WHERE id=?').get(f.grant.id).n,1);
 assert.ok(m.runs.every(r=>['completed','failed','cancelled','interrupted'].includes(r.state)));
 assert.ok(m.dispatches.every(d=>d.state==='settled'));
 for(const a of attempts){assert.equal(f.bridge.controlStore.run(a.run_id).termination_verified,1);assert.equal(f.bridge.controlStore.run(a.evaluation_run_id).termination_verified,1);}
 const proof={caller:f.caller,qualification:'isolated synthetic Cursor/OpenCode transports; production control plane, real child processes and host checks',request_id:p.request_id,mission_id:m.id,standing_grant_id:f.grant.id,standing_uses:1,initial_hex:'616c7068610a',observed_hex:snapshots.map(s=>s.bytes),attempts:attempts.map((a,i)=>({cursor_run_id:a.run_id,opencode_evaluation_run_id:a.evaluation_run_id,verification:a.verification.status,checks:snapshots[i].checks,cursor_termination_verified:f.bridge.controlStore.run(a.run_id).termination_verified===1,evaluator_termination_verified:f.bridge.controlStore.run(a.evaluation_run_id).termination_verified===1})),planner_run_ids:m.envelope.cognitive.planner_run_ids,acceptance:e.acceptance_status,settlement:e.settlement_status,active_leases:0,active_runs:0,dispatches_settled:true};
 await f.reopen({beforeResume:()=>f.bindAdapter()});
 const replay=await f.bridge.zeroSetupWork.ask(f.request,f.caller);assert.equal(replay.mission_id,m.id);assert.equal(f.calls.length,2);assert.equal(f.bridge.missions.detail(m.id).acceptance.length,1);
 proof.reconnect={same_mission:true,no_worker_replay:true,acceptance_count:1};
 if(process.env.AIRODROM_TEST_PROOF_OUTPUT)fs.writeFileSync(process.env.AIRODROM_TEST_PROOF_OUTPUT,JSON.stringify(proof,null,2)+'\n');
});

test('standing reservation is durable, idempotent, bounded and cannot move between grants',async t=>{
 const f=await setup(t),h=f.bridge.hostExecutionPolicy,db=f.bridge.controlStore.db,id=randomUUID();
 db.prepare('UPDATE cp_standing_cursor_development SET max_missions=1 WHERE id=?').run(f.grant.id);
 h.consumeStandingCursorDevelopment(f.grant.id,id);h.consumeStandingCursorDevelopment(f.grant.id,id);
 assert.equal(db.prepare('SELECT missions_used n FROM cp_standing_cursor_development WHERE id=?').get(f.grant.id).n,1);
 assert.equal(db.prepare('SELECT count(*) n FROM cp_runs').get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM cp_dispatches').get().n,0);
 assert.throws(()=>h.consumeStandingCursorDevelopment(f.grant.id,randomUUID()),/unavailable/);
 assert.throws(()=>h.consumeStandingCursorDevelopment(randomUUID(),id),/Idempotency conflict/);
 const query={repository:f.repo,policy_id:f.policy.policy_id,files:['fixture.txt'],max_invocations:1,max_runtime_ms:120000,data_class:'public'};
 assert.equal(h.matchStandingCursorDevelopment(query),null);
 await f.reopen({beforeResume:()=>f.bindAdapter()});
 f.bridge.hostExecutionPolicy.consumeStandingCursorDevelopment(f.grant.id,id);
 assert.equal(f.bridge.controlStore.db.prepare('SELECT missions_used n FROM cp_standing_cursor_development WHERE id=?').get(f.grant.id).n,1);
});

test('standing grant matches the source repository and exact policy, never another repository or file',async t=>{
 const f=await setup(t),h=f.bridge.hostExecutionPolicy;
 const q={repository:f.repo,policy_id:f.policy.policy_id,files:['fixture.txt'],max_invocations:1,max_runtime_ms:120000,data_class:'public'};
 assert.equal(h.matchStandingCursorDevelopment(q).id,f.grant.id);
 for(const delta of [{repository:f.root},{policy_id:randomUUID()},{files:['other.txt']},{max_invocations:99},{data_class:'private'}])assert.equal(h.matchStandingCursorDevelopment({...q,...delta}),null);
});

test('standing reservation failure cannot create or dispatch a Mission',async t=>{
 const f=await setup(t);f.bridge.hostExecutionPolicy.consumeStandingCursorDevelopment=()=>{throw Error('standing_reservation_unavailable');};
 const p=await f.ask();assert.equal(p.state,'BLOCKED');assert.equal(p.mission_id,null);assert.equal(f.calls.length,0);
 assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_subscription_invocations').get().n,0);
});

for(const failedAttempt of [1,2])test('evaluator failure on attempt '+failedAttempt+' retries evaluation without replaying Cursor',async t=>{
 const f=await setup(t,{repairs:1});f.plan=f.plan.slice(0,1);f.wrongFirst=true;
 const normal=f.evaluate;let malformed=false;
 f.evaluate=o=>{const count=f.calls.filter(c=>c.worker==='cursor').length;if(count===failedAttempt&&!malformed){malformed=true;return {unexpected:'malformed evaluator result'};}return normal(o);};
 const p=await f.ask({review:false});assert.ok(p.mission_id,JSON.stringify(p));
 let m;for(let n=0;n<800;n++){await f.bridge.missions.tick();m=f.bridge.missions.detail(p.mission_id);if(m.state==='completed')break;if(m.state==='needs_rework')assert.fail(m.reason);await new Promise(r=>setTimeout(r,50));}
 assert.equal(m.state,'completed',m.reason);assert.equal(f.calls.length,2);assert.equal(f.evaluations.length,3);
 const a=m.specialists.assignments[0].attempts;assert.equal(a.length,2);assert.notEqual(a[0].run_id,a[1].run_id);assert.equal(m.acceptance.length,1);
 assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(m.id).n,0);
});

test('queued authorized Cursor work protects its workspace until cancellation; settled work frees capacity',async t=>{
 const f=await setup(t,{repairs:0});f.bridge.missions.schedule=()=>{};f.bridge.missions.program.tick=()=>{};
 const p=await f.ask(),record=f.bridge.zeroSetupWork.read(p.request_id),id=record.cognitive.envelope.workspace_id,da=f.bridge.developerAutonomy;
 assert.ok(p.mission_id,JSON.stringify(p));
 assert.equal(da.cleanupWorkspace({workspace_id:id,confirmed:true},'operator').state,'held');
 f.bridge.missions.cancel(p.mission_id,{request_id:randomUUID()});
 assert.equal(f.calls.length,0);assert.equal(da.occupiedWorktrees(f.policy.policy_id),0);
 assert.equal(da.cleanupWorkspace({workspace_id:id,confirmed:true},'operator').state,'cleaned');
});

test('fabricated Cursor success without changes fails host verification and cannot accept or repair on prose',async t=>{
 const f=await setup(t,{repairs:1});f.plan=f.plan.slice(0,1);f.cursorMode='fabricate';
 const p=await f.ask({review:false}),m=await f.settle(p.mission_id,'needs_rework');
 assert.equal(f.calls.length,1);assert.equal(f.evaluations.length,0);assert.equal(m.acceptance.length,0);
 assert.equal(m.specialists.assignments[0].attempts[0].verification.status,'failed');
 assert.equal(require('node:fs').readFileSync(path.join(m.envelope.workspace,'fixture.txt'),'utf8'),'alpha\n');
});

test('protected verifier tampering blocks registered checks and acceptance on the Cursor path',async t=>{
 const fs=require('node:fs'),f=await setup(t,{repairs:1});f.plan=f.plan.slice(0,1);
 const verify=f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);let result;
 f.bridge.missions.verifier.verify=async(m,run,...args)=>{fs.writeFileSync(path.join(m.envelope.workspace,'tests/fixture.test.cjs'),'// assertions removed\n');result=await verify(m,run,...args);return result;};
 const p=await f.ask({review:false}),m=await f.settle(p.mission_id,'needs_rework');
 assert.equal(result.status,'failed');assert.equal(m.acceptance.length,0);assert.equal(f.calls.length,1);
 assert.ok(result.checks.some(c=>c.id==='verifier_inputs_unchanged'&&c.status==='failed'));
 assert.ok(!result.checks.some(c=>/^task:/.test(c.id)),'tampered registered checks must not run');
});
