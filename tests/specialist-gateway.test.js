'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const {runtime,qualifyCanonical}=require('./fixtures/opencode-fixture.cjs');
async function setup(t,{cursor=false,repairs=2,manual=false}={}) {
 const f=await fixture(t,{opencode:runtime(t).options,settleTimeoutMs:30000}),b=f.bridge;
 b.missionAuthority.initializeOperatorKey();qualifyCanonical(b);
 if(!manual)b.expandedAutonomy.setMode({mode:'routine_auto',confirmed:true,request_id:randomUUID(),sync_risk_acceptance:false},'operator');
 if(cursor)b.cursorWorker=new(require('../src/cursor-worker').CursorWorker)(b,{fixtureExecutable:path.join(__dirname,'fixtures/cursor-agent-fixture.cjs')});
 const p=b.projects.listProjects({status:'active'})[0],g=b.projects.summary(p.projectId).goals[0];
 f.policy=b.developerAutonomy.enroll({alias:'specialist-fixture',repository:f.repo,project_id:p.projectId,goal_id:g.goalId,workflows:['routine_edit','test','repair'],workers:cursor?['opencode','cursor']:['opencode'],duration_days:1,confirmed:true,diff_check:'diff-check',default_tests:['fixture-test'],budgets:{max_repairs:repairs},cognitive:{version:3,files:['fixture.txt'],delegated_callers:[],planning_attempts:2,planning_ms:120000,execution_ms:120000,repair_attempts:repairs,max_assignments:3,acceptance:'automatic'}},'operator');
 f.plan=[{id:'implement',worker:cursor?'cursor':'opencode',role:'implementation',operation:'edit',paths:['fixture.txt'],description:'Change alpha to beta',depends_on:[],verification:[]},{id:'review',worker:'opencode',role:'review',operation:'read',paths:['fixture.txt'],description:'Review the implementation without modifying files',depends_on:['implement'],verification:[]}];
 f.calls=[];f.evaluations=[];
 f.evaluate=o=>({...o.coordination.result_contract,recommendation:o.coordination.host_checks.some(c=>c.status==='failed')?'repair':'ready',summary:'Reviewed host evidence and supplied files.'});
 f.bindAdapter=()=>{const adapter=f.bridge.opencodeAdapter;f.worker=adapter.execute.bind(adapter);adapter.execute=async o=>{
  if(o.planning)return{result:{summary:JSON.stringify({...o.planning,tasks:f.plan})},changes:[],provenance:{termination_verified:true}};
  if(o.coordination){f.evaluations.push(o.coordination);assert.deepEqual(o.writable,[]);return{result:{summary:JSON.stringify(await f.evaluate(o))},changes:[],provenance:{runtime_id:'opencode',sandbox:'fixture',termination_verified:true,authority:false}};}
  f.calls.push({files:o.files,writable:o.writable,input:JSON.parse(o.objective)});return f.worker(o.writable.length?o:{...o,objective:'Inspect current files without changes',objectiveProof:null});
 };};f.bindAdapter();
 f.ask=async()=>{const request_id=randomUUID(),instruction='In Fixture project change fixture.txt from alpha to beta and independently review it.';let view=await b.zeroSetupWork.ask({request_id,instruction},'operator');for(let i=0;i<200&&view.state==='PLANNING';i++){await new Promise(r=>setTimeout(r,20));view=await b.zeroSetupWork.ask({request_id,instruction},'operator');}return view;};
 return f;
}
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
 const f=await setup(t,{cursor:true,repairs:0}),p=await f.ask();assert.equal(p.state,'WAIT',JSON.stringify(p));
 const a=await f.bridge.zeroSetupWork.approve({request_id:p.request_id,confirmed:true,channel:'control_center',subscription_execution:{provider:'cursor',acknowledge_unknown_cost:true,max_invocations:1,max_runtime_ms:120000}},'operator');
 const m=await f.settle(a.mission_id,'completed');assert.deepEqual(m.specialists.assignments.map(a=>a.worker),['cursor','opencode']);
 assert.deepEqual(f.evaluations.map(e=>e.worker.agent),['cursor','opencode']);assert.equal(m.acceptance.length,1);
});
test('final evaluator requests one bounded edit repair and completion remains automatic',async t=>{
 const f=await setup(t,{repairs:1});f.plan=f.plan.slice(0,1);
 f.evaluate=o=>({...o.coordination.result_contract,recommendation:f.evaluations.length===1?'repair':'ready',summary:'Bounded correction then re-evaluation.'});
 const p=await f.ask(),m=await f.settle(p.mission_id,'completed');
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
 const p=await f.ask(),m=await f.settle(p.mission_id,'needs_rework');
 assert.equal(f.calls.length,2);assert.equal(m.acceptance.length,0);assert.equal(m.specialists.repair_attempts,1);
});
test('program cancellation during evaluation prevents final acceptance',async t=>{
 const f=await setup(t);f.plan=f.plan.slice(0,1);
 f.evaluate=o=>{f.bridge.missions.program.cancel(o.coordination.specialist_return.assignment.parent_mission_id,randomUUID());return {...o.coordination.result_contract,summary:'Cancellation was requested.'};};
 const p=await f.ask(),m=await f.settle(p.mission_id,'cancelled');assert.equal(m.acceptance.length,0);
});
test('pending protected action blocks automatic acceptance without discarding verified results',async t=>{
 const f=await setup(t);f.plan=f.plan.slice(0,1);
 const list=f.bridge.policy.list.bind(f.bridge.policy);
 f.evaluate=o=>{const m=f.bridge.controlStore.requireMission(o.coordination.specialist_return.assignment.parent_mission_id);f.bridge.policy.list=()=>[...list(),{status:'pending',taskId:m.task_id}];return {...o.coordination.result_contract,summary:'Verified result retained.'};};
 const p=await f.ask(),m=await f.settle(p.mission_id,'awaiting_acceptance');assert.equal(m.acceptance.length,0);
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
