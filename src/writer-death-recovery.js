'use strict';
// Reconcile an interrupted in-process host or bridge run after the owning
// writer process is gone. This does not attest successful execution.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const READ_ONLY=new Set(['git_status','git_diff','git_diff_check','git_log','git_show','git_branch','git_head','git_ls_files','git_grep']);
const EXTERNAL_EVENT=/opencode|cursor|claude|codex|sandbox|worker_spawn|process_started/i;

function fail(code){const error=Error(code);error.code=code;throw error;}
function identifier(value){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value||''))fail('recovery_identifier_invalid');}

function observeWriter({pid,resource}){
  if(!Number.isInteger(pid)||pid<=1||pid===process.pid)fail('writer_pid_unusable');
  try{process.kill(pid,0);fail('writer_still_alive');}
  catch(error){if(error.code!=='ESRCH')fail('writer_liveness_unknown');}
  if(typeof resource!=='string'||!resource.startsWith('/'))fail('workspace_resource_required');
  const root=fs.realpathSync(resource);
  let text;
  try{text=execFileSync('/usr/sbin/lsof',['-n','-P','-a','-d','cwd','-F','pn'],{encoding:'utf8',timeout:8000,maxBuffer:8_000_000});}
  catch(error){if(error.status==1)text='';else fail('workspace_observation_unavailable');}
  let current=null,holders=0;
  for(const line of text.split('\n')){
    if(line.startsWith('p'))current=Number(line.slice(1));
    else if(line.startsWith('n')&&current&&current!==process.pid){
      const cwd=line.slice(1);
      if(cwd===root||cwd.startsWith(root+'/'))holders++;
      current=null;
    }
  }
  if(holders)fail('workspace_process_still_present');
  return {writer_alive:false,workspace_holders:0,method:'esrch_and_lsof_cwd'};
}

function events(db,runId){
  return db.prepare('SELECT event_type,metadata FROM event_ledger_events WHERE run_id=? ORDER BY seq').all(runId).map(row=>{
    let metadata={};try{metadata=JSON.parse(row.metadata||'{}');}catch{fail('recovery_event_unreadable');}
    return {event_type:row.event_type,metadata};
  });
}

function assertInProcess(run,rows){
  if(!['host','bridge'].includes(run.agent_id))fail('external_worker_recovery_denied');
  if(run.pid!=null)fail('recorded_pid_requires_process_reconciliation');
  if(run.state!=='interrupted'||run.termination_verified||run.process_state!=='unknown'||run.resolution!=='reconcile_process')fail('writer_death_state_denied');
  for(const row of rows){
    if(EXTERNAL_EVENT.test(row.event_type))fail('external_execution_event_present');
    if(row.metadata.pid!=null||row.metadata.owned_process_id!=null)fail('recorded_process_identity_present');
  }
}

function capabilities(rows){
  return rows.filter(row=>row.event_type==='capability.requested'||row.event_type==='orchestrator.capability.requested').map(row=>row.metadata.capability).filter(Boolean);
}

function reconcileRun(store,run,observation){
  const rows=events(store.db,run.id);
  assertInProcess(run,rows);
  const caps=[...new Set(capabilities(rows))];
  if(caps.some(cap=>!READ_ONLY.has(cap)))fail('uncertain_capability_preserved');
  const started=rows.some(row=>row.event_type==='capability.requested'&&row.metadata&&row.metadata.request_id);
  if(run.agent_id==='bridge'&&!started)fail('bridge_invocation_bind_required');
  const previous={state:run.state,process_state:run.process_state,termination_verified:run.termination_verified,resolution:run.resolution};
  const settled=store.updateRun(run.id,{
    state:'interrupted',processState:'exited',liveness:'settled',verified:true,
    resolution:'writer_death_in_process',
    result:{recovery_not_execution:true,accepted:false,writer_alive:false,observation:observation.method}
  });
  const leases=store.db.prepare("SELECT id,state FROM cp_leases WHERE run_id=? AND state='quarantined'").all(run.id);
  for(const lease of leases){
    const changed=store.db.prepare("UPDATE cp_leases SET state='released' WHERE id=? AND run_id=? AND state='quarantined'").run(lease.id,run.id);
    if(changed.changes!==1)fail('quarantined_lease_not_reconciled');
    store.event('workspace.lease_reconciled',run.mission_id,{lease_id:lease.id,previous_state:'quarantined',state:'released',reason:'writer_death_in_process',recovery_not_execution:true},{runId:run.id,taskId:run.task_id});
  }
  const invocations=[];
  for(const row of rows.filter(item=>item.event_type==='capability.requested'&&item.metadata.request_id)){
    const requestId=row.metadata.request_id;
    const invocation=store.invocation(requestId);
    if(!invocation||invocation.task_id!==run.task_id)fail('invocation_bind_mismatch');
    if(invocation.state==='settled')continue;
    if(!['unknown','running'].includes(invocation.state))fail('invocation_state_unreconcilable');
    store.finishInvocation(requestId,{status:'failed',outcome:'incomplete',accepted:false,recovery:'writer_death_in_process',capability:row.metadata.capability||null});
    invocations.push({request_id:requestId,previous_state:invocation.state,state:'settled',outcome:'incomplete'});
  }
  store.event('run.writer_death_reconciled',run.mission_id,{
    run_id:run.id,previous_state:previous.state,state:'interrupted',process_state:'exited',termination_verified:true,
    previous_resolution:previous.resolution,resolution:'writer_death_in_process',recovery_not_execution:true,
    lease_ids:leases.map(lease=>lease.id),invocation_count:invocations.length,observation:observation.method
  },{runId:run.id,taskId:run.task_id});
  return {run_id:run.id,agent_id:run.agent_id,previous,state:settled.state,process_state:settled.process_state,termination_verified:settled.termination_verified===1,resolution:settled.resolution,leases:leases.map(lease=>lease.id),invocations,recovery_not_execution:true,accepted:false};
}

function reconcile(store,input,observe=observeWriter){
  identifier(input.mission_id);identifier(input.request_id);
  if(input.recovery_kind!=='writer_process_death'||input.termination_verified!==true)fail('writer_death_attestation_denied');
  const mission=store.requireMission(input.mission_id);
  const resource=input.workspace_resource||store.db.prepare("SELECT resource FROM cp_leases WHERE mission_id=? ORDER BY acquired_at DESC LIMIT 1").get(mission.id)?.resource;
  return store.request('operator',input.request_id,{action:'writer-death-reconcile',mission_id:input.mission_id,writer_pid:input.writer_pid,recovery_kind:input.recovery_kind},()=>{
    const observation=observe({pid:input.writer_pid,resource});
    const runs=store.db.prepare("SELECT id FROM cp_runs WHERE mission_id=? AND state='interrupted' AND termination_verified=0 AND resolution='reconcile_process'").all(mission.id);
    if(!runs.length)fail('writer_death_runs_absent');
    const dispositions=runs.map(row=>reconcileRun(store,store.run(row.id),observation));
    return {mission_id:mission.id,recovery_not_execution:true,accepted:false,observation,dispositions,authority:false};
  });
}

module.exports={reconcile,observeWriter,READ_ONLY};
