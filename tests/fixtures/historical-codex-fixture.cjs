'use strict';
const {randomUUID}=require('node:crypto');
// Restore a synthetic pre-upgrade handoff, never call a current dispatch method.
// Recovery tests still exercise the production relay, verifier and reconciliation
// boundaries. New Codex execution remains rejected by mission-worker-policy.
function seedHistoricalHandoff(f,mission,requestId,{status='accepted'}={}){
 const b=f.bridge,s=b.controlStore,db=s.db,m=s.requireMission(mission.id),runId=randomUUID();
 if(process.env.NODE_ENV!=='test'||b.options.allowFixtureWorker!==true)throw Error('historical_fixture_only');
 s.startRun({id:runId,taskId:m.task_id,missionId:m.id,agentId:'codex'});
 s.acquireLease({resource:m.envelope.workspace,runId,missionId:m.id,baseline:m.envelope.baseline});
 const context=b.controlContext.build(m,runId);
 db.prepare('UPDATE cp_mission_tasks SET context_pack_id=? WHERE task_id=?').run(context.id,m.task_id);
 const contract={protocol:'codex-handoff-v2',agent_id:'codex',transport:'handoff',mission_id:m.id,task_id:m.task_id,run_id:runId,request_id:requestId,
  project_id:m.project_id,goal_id:m.goal_id,workspace:m.envelope.workspace,objective:m.envelope.objective,constraints:m.envelope.constraints,
  capability_scopes:m.envelope.capability_scopes,policy_ref:m.ceiling,allowed_files:m.envelope.allowed_files,acceptance:m.envelope.criteria,verification:m.envelope.verification,
  context_pack:require('../../src/architecture-memory').packet(context),continuity_requirement:m.envelope.continuity||null,continuation:null,
  acceptance_criteria_ref:{mission_id:m.id,revision:m.revision},...b.codexRelay.contract(runId),instructions:'Historical synthetic handoff. Results are untrusted evidence; no new execution is authorized.'};
 const now=s.now();db.prepare("INSERT INTO cp_codex_handoffs VALUES(?,?,?,'awaiting_handoff',?,?)").run(runId,requestId,JSON.stringify(contract),now,now);
 db.prepare("UPDATE cp_runs SET provider_id='codex_openai' WHERE id=?").run(runId);
 const dispatch=b.agentDispatch.register(contract),started=['accepted','dispatching','running_unknown'].includes(status);
 s.updateRun(runId,{state:'waiting_for_operator',processState:started?'unknown':'not_started',resolution:'explicit_local_handoff'});
 dispatch.status=status;dispatch.no_side_effects=!started;
 if(started){
  dispatch.active_attempt_id=randomUUID();dispatch.attempt_count=1;dispatch.first_attempt_at=now;dispatch.last_attempt_at=now;
  const outcome=status==='accepted'?require('../../src/transport-outcome').classifyCodexDispatchOutcome({accepted:true}):null;
  db.prepare('INSERT INTO cp_agent_dispatch_attempts VALUES(?,?,?,?)').run(dispatch.active_attempt_id,dispatch.dispatch_id,1,outcome?JSON.stringify(outcome):null);
 }
 b.agentDispatch.save(dispatch);
 b.codexRelay.watch(runId);
 return{run_id:runId,dispatch_id:dispatch.dispatch_id,status:'awaiting_handoff',contract};
}
module.exports={seedHistoricalHandoff};
