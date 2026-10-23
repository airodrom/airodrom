'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const G = require('../src/opencode-gateway');
async function setup(t, { repairs = 0, cursor = false } = {}) {
 const f = await fixture(t, { opencode: runtime(t).options, settleTimeoutMs: 20000 }), b = f.bridge;
 if(cursor)b.hostExecutionPolicy.enableCursor({confirmed:true,request_id:randomUUID()},'operator');
 if(cursor)b.cursorWorker=new(require('../src/cursor-worker').CursorWorker)(b,{fixtureExecutable:path.join(__dirname,'fixtures/cursor-agent-fixture.cjs')});
 b.missionAuthority.initializeOperatorKey(); qualifyCanonical(b);
 const project=b.projects.listProjects({status:'active'})[0],goal=b.projects.summary(project.projectId).goals[0];
 f.policy=b.developerAutonomy.enroll({alias:'gateway-fixture',repository:f.repo,project_id:project.projectId,goal_id:goal.goalId,workflows:['routine_edit','test','repair'],workers:cursor?['opencode','cursor']:['opencode'],duration_days:1,confirmed:true,diff_check:'diff-check',default_tests:['fixture-test'],budgets:{max_repairs:repairs},cognitive:{version:2,files:['fixture.txt'],delegated_callers:[],planning_attempts:2,planning_ms:120000,execution_ms:120000,repair_attempts:repairs}},'operator');
 f.worker=b.opencodeAdapter.execute.bind(b.opencodeAdapter);f.evaluations=[];
 f.evaluate=async o=>({...o.coordination.result_contract,recommendation:o.coordination.host_checks.some(c=>c.status==='failed')?'repair':'ready',summary:'Reviewed actual worker result and current file.'});
 b.opencodeAdapter.execute=async o=>{
  if(o.coordination){assert.deepEqual(o.writable,[]);assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_acceptances').get().n,0);f.evaluations.push(o.coordination);return{result:{summary:JSON.stringify(await f.evaluate(o))},changes:[],provenance:{runtime_id:'opencode',sandbox:'fixture',termination_verified:true,authority:false}};}
  if(!o.planning)return f.worker(o);
  return{result:{summary:JSON.stringify({...o.planning,tasks:[{id:'change',operation:'edit',paths:['fixture.txt'],description:'Replace alpha with beta and preserve LF',depends_on:[]}]})},changes:[],provenance:{termination_verified:true}};
 };
 f.ask=async(instruction='In Fixture project change fixture.txt from alpha to beta.')=>{const request_id=randomUUID();let view=await b.zeroSetupWork.ask({request_id,instruction},'operator');for(let i=0;i<200&&view.state==='PLANNING';i++){await new Promise(r=>setTimeout(r,20));view=await b.zeroSetupWork.ask({request_id,instruction},'operator');}return view;};return f;
}
test('worker result returns to read-only OpenCode before handoff and survives reconnect',async t=>{
 const f=await setup(t),p=await f.ask();assert.ok(p.mission_id&&['DISPATCHED','RUNNING'].includes(p.state),JSON.stringify(p));const m=await f.settle(p.mission_id);
 assert.equal(f.evaluations.length,1);assert.equal(f.evaluations[0].worker.agent,'opencode');assert.ok(f.evaluations[0].worker.summary);
 const evidence=require('../src/mission-evidence').evidencePackage(f.bridge,m.id);assert.equal(evidence.cognitive.counts.execution,1);assert.equal(evidence.gateway.evaluations[0].recommendation,'ready');assert.equal(evidence.gateway.evaluations[0].termination_verified,true);assert.equal(evidence.gateway.evaluations[0].provenance.sandbox,'fixture');
 const events=f.bridge.ledger.list({missionId:m.id,limit:200}).events.map(e=>e.event_type);assert.ok(events.indexOf('gateway.result_received')<events.indexOf('gateway.evaluated'));assert.ok(events.indexOf('gateway.evaluated')<events.indexOf('verification.completed'));
 assert.doesNotThrow(()=>G.assertAcceptance(f.bridge,f.bridge.controlStore.getMission(m.id),m.verifications[0]));await f.reopen();assert.deepEqual(require('../src/mission-evidence').evidencePackage(f.bridge,m.id).gateway,evidence.gateway);
});
test('OpenCode cannot add authority to evaluation',async t=>{
 const f=await setup(t);f.evaluate=async o=>({...o.coordination.result_contract,authorization:'approved'});const p=await f.ask(),m=await f.settle(p.mission_id,'blocked');assert.equal(m.verifications.length,1);assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_acceptances').get().n,0);assert.equal(G.receipt(f.bridge,m.id,m.runs.find(r=>r.result?.opencode_provenance).id).state,'failed');
});
test('Acceptance rejects a changed worker result',async t=>{
 const f=await setup(t),p=await f.ask(),m=await f.settle(p.mission_id),v=m.verifications[0];f.bridge.controlStore.db.prepare('UPDATE cp_run_results SET normalized=? WHERE run_id=?').run(JSON.stringify({summary:'forged replacement'}),v.run_id);assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:randomUUID(),verification_id:v.id,decision:'accept',rationale:'Reviewed',evidence:'Fixture only'}),/gateway_acceptance/);
});
test('unavailable evaluation preserves result and never replays on restart', async t => {
  const f = await setup(t);
  f.evaluate = async () => { throw Error('evaluator unavailable'); };
  const p = await f.ask(), m = await f.settle(p.mission_id, 'blocked');
  const worker = m.runs.find(r => r.result?.opencode_provenance), receipt = G.receipt(f.bridge, m.id, worker.id);
  assert.equal(receipt.state, 'failed'); assert.equal(f.evaluations.length, 1);
  const dispatches = () => f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n;
  assert.equal(dispatches(), 1);
  await f.reopen(); await f.bridge.missions.tick();
  assert.equal(G.receipt(f.bridge, m.id, worker.id).id, receipt.id);
  // Settlement accounting consumes the idle grant. Synchronize that transition
  // explicitly; its authority check precedes the single-attempt guard in queue.
  f.bridge.developerAutonomy.reservations(f.policy.policy_id);
  assert.equal(f.bridge.developerAutonomy.inspectGrant(m.envelope.developer_autonomy.grant_id).state, 'consumed');
  assert.throws(() => f.bridge.missions.queue(m.id), /Developer Autonomy grant expired, revoked or changed/);
  assert.equal(dispatches(), 1); assert.equal(f.evaluations.length, 1);
});
test('signed v2 repair ceiling reuses deterministic corrective dispatch',async t=>{
 const f=await setup(t,{repairs:1}),execute=f.worker;let calls=0;f.worker=async o=>execute(++calls===1?{...o,objective:'Inspect current file without changing it'}:o);
 const p=await f.ask();assert.ok(p.mission_id&&['DISPATCHED','RUNNING'].includes(p.state),JSON.stringify(p));await f.settle(p.mission_id,'needs_rework');const db=f.bridge.controlStore.db;let child;for(let i=0;i<80&&!child;i++){await f.bridge.missions.tick();child=db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").get(p.mission_id);if(!child)await new Promise(r=>setTimeout(r,25));}
 assert.ok(child);const done=await f.settle(child.id);assert.equal(done.envelope.cognitive.repair_binding.parent_mission_id,p.mission_id);assert.equal(require('../src/mission-evidence').evidencePackage(f.bridge,done.id).cognitive.counts.repair,1);assert.equal(f.evaluations.length,2);assert.equal(calls,2);assert.equal(fs.readFileSync(path.join(done.envelope.workspace,'fixture.txt'),'utf8'),'beta\n');require('../src/autonomous-repair').considerVerifiedRepair(f.bridge,p.mission_id);assert.equal(db.prepare("SELECT count(*) n FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").get(p.mission_id).n,1);
});
test('read-only worker choice cannot authorize edits',async t=>{
 const R=require('../src/cognitive-router');for(const worker of ['opencode','cursor'])assert.throws(()=>R.route({requested_worker:worker,eligible_workers:[worker]},{files:['fixture.txt'],tasks:[{operation:'read'}]},[worker]),/readonly_worker_unsupported/);
});

test('governed Cursor fixture returns to OpenCode and revocation blocks Acceptance',async t=>{
 const f=await setup(t,{cursor:true}),p=await f.ask('Use Cursor in Fixture project to change fixture.txt from alpha to beta.');assert.equal(p.state,'WAIT');
 await assert.rejects(f.bridge.zeroSetupWork.approve({request_id:p.request_id,confirmed:true,channel:'control_center'},'operator'),/SPEND/);
 const approved=await f.bridge.zeroSetupWork.approve({request_id:p.request_id,confirmed:true,channel:'control_center',subscription_execution:{provider:'cursor',acknowledge_unknown_cost:true,max_invocations:1,max_runtime_ms:120000}},'operator');const m=await f.settle(approved.mission_id),v=m.verifications[0];assert.equal(f.evaluations[0].worker.agent,'cursor');assert.equal(require('../src/mission-evidence').evidencePackage(f.bridge,m.id).worker.agent_id,'cursor');f.bridge.developerAutonomy.revoke({policy_id:f.policy.policy_id,policy_hash:f.policy.policy_hash,confirmed:true},'operator');assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:randomUUID(),verification_id:v.id,decision:'accept',rationale:'Reviewed',evidence:'Fixture only'}),/revoked/);
});
test('non-ready evaluation truthfully blocks handoff while retaining passed host checks',async t=>{
 const f=await setup(t);f.evaluate=async o=>({...o.coordination.result_contract,recommendation:'blocked',summary:'An expected requirement is missing.'});const p=await f.ask(),m=await f.settle(p.mission_id,'blocked');assert.match(m.reason,/OpenCode requested blocked/);assert.equal(m.verifications[0].result,'operator_review');
});
test('uncertain evaluator retains quarantine without repeating execution',async t=>{
 const f=await setup(t);f.evaluate=async()=>{throw Error('uncertain evaluator');};const execute=f.bridge.opencodeAdapter.execute.bind(f.bridge.opencodeAdapter);f.bridge.opencodeAdapter.execute=async o=>{if(o.coordination)o.onStart({pid:999999});return execute(o);};const p=await f.ask(),m=await f.settle(p.mission_id,'blocked');assert.equal(m.runs.find(r=>r.result?.gateway).state,'termination_unverified');assert.ok(f.bridge.controlStore.db.prepare("SELECT 1 FROM cp_leases WHERE mission_id=? AND state='quarantined'").get(m.id));assert.throws(()=>f.bridge.missions.queue(m.id));
});
test('named unsupported specialists never silently fall back',()=>{
 for(const name of ['Codex','Claude Code'])assert.throws(()=>require('../src/cognitive-router').requestedWorker('Use '+name+' for this change'),/named_worker_unavailable/);
});
test('unavailable host verification remains retrievable after failed evaluation and reconnect',async t=>{
 const f=await setup(t),verify=f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);
 f.bridge.missions.verifier.verify=async(...args)=>({...await verify(...args),status:'unavailable'});
 f.evaluate=async()=>{throw Error('evaluator unavailable');};
 const p=await f.ask(),m=await f.settle(p.mission_id,'needs_rework');
 const evidence=require('../src/mission-evidence').evidencePackage(f.bridge,m.id);
 assert.equal(evidence.cognitive.version,2);assert.equal(evidence.cognitive.verification.result,'unavailable');
 assert.equal(evidence.gateway.evaluations[0].state,'failed');assert.equal(evidence.acceptance_status,'owner_only_pending');
 await f.reopen();assert.equal(require('../src/mission-evidence').evidencePackage(f.bridge,m.id).cognitive.verification.result,'unavailable');
});

test('repair authority binds parent evidence and baseline and stops when the root is cancelled', {timeout:90000}, async t=>{
 const f=await setup(t,{repairs:1}),b=f.bridge,execute=f.worker,R=require('../src/cognitive-router');
 let calls=0,childSignal;
 f.worker=async o=>{
  calls++;
  if(calls===1)return execute({...o,objective:'Inspect current file without changing it'});
  childSignal=o.signal;
  return new Promise((resolve,reject)=>{
   const abort=()=>reject(Error('opencode_cancelled'));
   if(o.signal.aborted)abort();else o.signal.addEventListener('abort',abort,{once:true});
  });
 };
 const p=await f.ask();assert.ok(p.mission_id&&['DISPATCHED','RUNNING'].includes(p.state),JSON.stringify(p));
 // The existing scheduler must be free to advance the parent and launch the
 // child. Awaiting tick here would also await this deliberately held worker.
 for(let i=0;i<1800&&!childSignal;i++)await new Promise(r=>setTimeout(r,25));
 assert.ok(childSignal,'corrective worker started');
 const row=b.controlStore.db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").get(p.mission_id);
 assert.ok(row);const child=b.controlStore.requireMission(row.id),parent=b.controlStore.requireMission(p.mission_id);
 assert.equal(parent.state,'needs_rework');assert.doesNotThrow(()=>R.assertBound(b,child));
 for(const mutate of [
  m=>{m.envelope.cognitive.repair_binding.evaluation_run_id=randomUUID();},
  m=>{m.envelope.cognitive.repair_baseline.integrity.hash='0'.repeat(64);},
  m=>{m.envelope.baseline.hash='0'.repeat(64);},
 ]){
  const changed=structuredClone(child);mutate(changed);
  assert.throws(()=>R.assertBound(b,changed),/gateway_repair_binding_changed/);
 }
 const changedRoot=structuredClone(parent);
 changedRoot.envelope.cognitive.repair_baseline=structuredClone(child.envelope.cognitive.repair_baseline);
 assert.throws(()=>R.assertBound(b,changedRoot),/gateway_root_repair_binding_invalid/);
 b.missions.cancel(parent.id,{request_id:randomUUID()},'operator');
 assert.throws(()=>b.missions.assertAuthority(child),/gateway_parent_stopped/);
 for(let i=0;i<120&&!childSignal.aborted;i++)await new Promise(r=>setTimeout(r,25));
 assert.equal(childSignal.aborted,true,'root cancellation aborts an active corrective worker');
 await b.missions.tick();
 assert.equal(b.controlStore.requireMission(parent.id).state,'cancelled');
 assert.equal(calls,2);assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_acceptances').get().n,0);
});
