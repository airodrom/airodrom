'use strict';
// Synthetic pre-upgrade native completion for durable verification/recovery tests.
// The current Mission dispatcher is asserted to reject the retired writer. This
// fixture arranges its old Run and result explicitly, using the real capability
// broker for scoped file effects and receipts. It does not mock policy, verifier,
// Acceptance, termination, leases, qualification, or a dispatch entry point.
const assert=require('node:assert/strict'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {fingerprint}=require('../../src/control-plane-store');
async function completeHistoricalNative(f,mission){
 const b=f.bridge,s=b.controlStore,db=s.db,m=s.requireMission(mission.id);
 if(process.env.NODE_ENV!=='test'||b.options.allowFixtureWorker!==true)throw Error('historical_fixture_only');
 assert.throws(()=>b.missions.dispatch(m.id,{request_id:'denied-current:'+randomUUID()}),/CURSOR_IMPLEMENTATION_REQUIRED/);
 const runId=randomUUID(),dispatchId=randomUUID(),task=b.tasks.get(m.task_id),now=Date.now();
 s.startRun({id:runId,taskId:m.task_id,missionId:m.id,agentId:'host',role:'worker'});
 s.acquireLease({resource:m.envelope.workspace,runId,missionId:m.id,baseline:m.envelope.baseline});
 const pack=b.controlContext.build(m,runId);task.contextPackId=pack.id;task.assignedAgent='host';b.tasks.save(task);
 db.prepare('UPDATE cp_mission_tasks SET context_pack_id=? WHERE task_id=?').run(pack.id,task.id);
 s.state(m.id,'dispatching');s.state(m.id,'running');
 db.prepare("INSERT INTO cp_dispatches(id,mission_id,task_id,state,decision_id,route,run_id,created_at,updated_at) VALUES(?,?,?,'running',NULL,?,?,?,?)").run(dispatchId,m.id,task.id,JSON.stringify({selected:'host',reason:'historical_fixture'}),runId,now,now);
 const receipts=[];
 for(const [i,a]of m.envelope.dispatch_policy.native_actions.entries()){
  b.missions.program.assert(s.requireMission(m.id));
  if(m.envelope.coding_plan)b.missions.codingAdapter.assert(s.requireMission(m.id),a);
  const requestId=`historical-native:${runId}:${i}`;
  const response=await b.invokeCapability(task.id,{name:a.name,input:{path:path.join(m.envelope.workspace,a.path),...(a.name==='file_write'?{content:a.content}:{})},requestId});
  assert.equal(response.status,'completed',JSON.stringify(response));receipts.push(requestId);
 }
 s.updateRun(runId,{state:'completed',processState:'not_started',verified:true,result:{...(m.envelope.coding_plan?{coding_adapter:m.envelope.coding_plan.adapter,coding_plan_hash:fingerprint(m.envelope.coding_plan)}:{}),native_execution_evidence:{run_id:runId,required_execution_kind:'native',completed_invocations:receipts.length,receipt_refs:receipts}}});
 b.missions.captureResult(runId,{status:'completed',result:{text:JSON.stringify({summary:'Historical synthetic native completion',changed_files:m.envelope.allowed_files,tests:[],artifacts:[],limitations:[]})}});
 return{run_id:runId,dispatch_id:dispatchId};
}
module.exports={completeHistoricalNative};
