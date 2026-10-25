'use strict';
// Explicit synthetic pre-upgrade OpenCode completion for recovery compatibility.
// Never substitutes for current Cursor coverage or invokes the Mission dispatcher.
// The local fixture adapter, capability broker, scope checks, result inbox,
// independent verification and Acceptance remain production implementations.
const assert=require('node:assert/strict'),path=require('node:path'),{randomUUID}=require('node:crypto');
async function completeHistoricalOpenCode(f,mission){
 const b=f.bridge,s=b.controlStore,db=s.db,m=s.requireMission(mission.id);
 if(process.env.NODE_ENV!=='test'||b.options.allowFixtureWorker!==true||!b.opencodeAdapter.options.fixtureExecutable)throw Error('historical_fixture_only');
 assert.throws(()=>b.missions.dispatch(m.id,{request_id:'denied-current:'+randomUUID()}),/CURSOR_IMPLEMENTATION_REQUIRED/);
 const runId=randomUUID(),dispatchId=randomUUID(),task=b.tasks.get(m.task_id),now=Date.now();
 s.startRun({id:runId,taskId:task.id,missionId:m.id,agentId:'opencode'});
 s.acquireLease({resource:m.envelope.workspace,runId,missionId:m.id,baseline:m.envelope.baseline});
 const pack=b.controlContext.build(m,runId);task.contextPackId=pack.id;task.assignedAgent='opencode';b.tasks.save(task);
 db.prepare('UPDATE cp_mission_tasks SET context_pack_id=? WHERE task_id=?').run(pack.id,task.id);
 db.prepare("INSERT INTO cp_dispatches(id,mission_id,task_id,state,decision_id,route,run_id,created_at,updated_at) VALUES(?,?,?,'running',NULL,?,?,?,?)").run(dispatchId,m.id,task.id,JSON.stringify({selected:'opencode',reason:'historical_fixture'}),runId,now,now);
 s.state(m.id,'dispatching');s.state(m.id,'running');s.updateRun(runId,{state:'running',processState:'alive'});
 try{
  const output=await b.opencodeAdapter.dispatch({task,repo:m.envelope.workspace,prompt:require('../../src/exact-file-prompt').opencodePrompt(m),context:{id:pack.id},requestId:'historical:'+runId});
  b.developerAutonomy.assertChanges(s.requireMission(m.id),output.changes);
  for(const [i,c]of output.changes.entries()){
   assert.ok(m.envelope.allowed_files.includes(c.path));assert.equal(require('../../src/qualified-coding-adapter').digest(path.join(m.envelope.workspace,c.path)),c.preimage_sha256);
   const response=await b.invokeCapability(task.id,{name:'file_write',input:{path:path.join(m.envelope.workspace,c.path),content:c.content},requestId:`historical-opencode:${runId}:${i}`});
   assert.equal(response.status,'completed',JSON.stringify(response));
  }
  s.updateRun(runId,{state:'completed',processState:'exited',verified:true,result:{opencode_provenance:output.provenance,artifacts:output.changes.map(({content,...rest})=>rest)}});
  b.missions.captureResult(runId,{status:'completed',result:{text:JSON.stringify(output.result)}});
 }catch(error){
  s.updateRun(runId,{state:'failed',processState:'exited',verified:true,result:{historical_fixture_error:error.message}});
  b.missions.captureResult(runId,{status:'failed',result:{text:JSON.stringify({summary:'Historical completion rejected',changed_files:[],tests:[],artifacts:[],limitations:[]})}});
 }
 return{run_id:runId,dispatch_id:dispatchId};
}
module.exports={completeHistoricalOpenCode};
