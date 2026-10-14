'use strict';
// Governed cold-boot reconciliation for bridge invocation-lease Runs.
// Distinct from web-boot-recovery: no browser evidence, no quarantined host lease,
// and no settlement of sibling host/web ownership. Boot boundary is witnessed by
// an existing web-boot evidence packet (prepared or already consumed) without
// mutating that registry row.
const {object,identifier}=require('./control-plane-store');
const {error}=require('./research-network');
const policy=require('./mission-web-policy');

// Authoritative only: capability request events that bind exact request_id + capability
// on this run_id. lifecycle.lease_acquired is never sufficient — the orchestrator
// acquires the lease before assigning task.latestMcpRequestId, so that event can
// carry a previous invocation's request_id onto the new bridge Run.
const OWNERSHIP_EVENTS=new Set([
  'orchestrator.capability.requested',
  'capability.requested'
]);
const POST_BOOT_EXECUTION_EVENTS=new Set([
  'orchestrator.capability.requested',
  'capability.requested',
  'capability.completed',
  'capability.failed',
  'run.started',
  'mission.running',
  'mission.dispatching',
  'research.browser_started',
  'research.navigated',
  'research.network_denied',
  'research.browser_closed',
  'mission.web.evidence',
  'mission.web.termination_unverified',
  'shell.command.requested',
  'test.started',
  'agent.dispatch.requested'
]);
const POST_BOOT_OBSERVATIONAL=new Set([
  'approval.decision',
  'approval.denied',
  'task.phase_changed',
  'task.cancelled',
  'task.blocked',
  'task.interrupted',
  'mission.cancelled',
  'mission.blocked',
  'mission.paused'
]);

class BridgeInvocationRecovery{
 constructor(service){
  this.service=service;this.bridge=service.bridge;this.store=service.store;this.db=service.db;
  this.options=this.bridge.options.bridgeInvocationRecovery||{};
 }
 bootEpoch(){
  const web=this.service._web?.options;
  return require('./os-boot-epoch').readBootEpoch({testing:this.options.bootEpoch?{epoch:this.options.bootEpoch}:web?.bootEpoch?{epoch:web.bootEpoch}:web?.testing?.bootEpoch||this.options.testing?.bootEpoch});
 }
 assertBridgeRun(run,missionId){
  if(!run)throw error('run_required');
  if(run.agent_id!=='bridge')throw error('bridge_invocation_agent_denied');
  if(!run.mission_id||!run.task_id)throw error('bridge_invocation_run_binding_required');
  if(run.mission_id!==missionId)throw error('mission_run_binding_mismatch');
  if(!['interrupted','termination_unverified'].includes(run.state)||run.termination_verified)throw error('bridge_invocation_reconcile_state_denied');
  if(Number.isSafeInteger(run.pid)&&run.pid>0)throw error('owned_process_pid_present_use_pid_reconcile');
  const m=this.store.getMission(run.mission_id);if(!m)throw error('bridge_invocation_mission_required');
  if(m.task_id!==run.task_id)throw error('bridge_invocation_task_mismatch');
  if(m.state!=='cancelled')throw error('bridge_invocation_mission_not_cancelled');
  // Web-proven bridge runs must use web-boot-recovery; this path is invocation-lease only.
  if(this.db.prepare('SELECT 1 FROM cp_mission_web_evidence WHERE run_id=?').get(run.id))throw error('bridge_web_evidence_use_web_boot_recovery');
  if(this.db.prepare("SELECT 1 FROM event_ledger_events WHERE run_id=? AND event_type IN ('mission.web.termination_unverified','mission.web.evidence','research.browser_started','research.navigated','research.browser_closed')").get(run.id))throw error('bridge_web_evidence_use_web_boot_recovery');
  if(this.db.prepare("SELECT 1 FROM cp_leases WHERE run_id=? AND state IN ('held','quarantined')").get(run.id))throw error('bridge_invocation_lease_present_use_web_or_pid_path');
  if(this.db.prepare('SELECT 1 FROM cp_dispatches WHERE run_id=?').get(run.id))throw error('bridge_invocation_dispatch_bound_denied');
  return m;
 }
 proveInvocationOwnership(run,invocationId){
  const inv=this.store.invocation(invocationId);
  if(!inv)throw error('invocation_required');
  if(inv.task_id!==run.task_id)throw error('invocation_task_mismatch');
  if(!['running','unknown'].includes(inv.state))throw error('invocation_state_denied');
  // Exact durable bind: authoritative capability-request event on this run_id
  // with matching request_id and a declared capability. Never infer from shared
  // Mission/task, timestamps, or lifecycle.lease_acquired.
  const rows=this.db.prepare('SELECT event_id,event_type,request_id,metadata,timestamp_ms FROM event_ledger_events WHERE run_id=?').all(run.id);
  const owned=[];
  for(const row of rows){
   if(!OWNERSHIP_EVENTS.has(row.event_type))continue;
   let meta={};
   try{meta=JSON.parse(row.metadata||'{}');}catch{throw error('invocation_ownership_metadata_denied');}
   const columnId=row.request_id||null;
   const metaId=typeof meta.request_id==='string'?meta.request_id:null;
   if(columnId&&metaId&&columnId!==metaId)throw error('invocation_ownership_contradiction');
   const boundId=columnId||metaId;
   if(boundId!==invocationId)continue;
   const capability=typeof meta.capability==='string'?meta.capability.trim():'';
   if(!capability)throw error('invocation_ownership_capability_required');
   owned.push({event_id:row.event_id,event_type:row.event_type,capability});
  }
  if(!owned.length)throw error('invocation_run_ownership_unproven');
  // Multiple authoritative binds for the same request on this run must agree on capability.
  if(new Set(owned.map(o=>o.capability)).size!==1)throw error('invocation_ownership_contradiction');
  return {invocation:inv,ownership_event_id:owned[0].event_id,ownership_event_type:owned[0].event_type,capability:owned[0].capability};
 }
 assertNoPostBootContinuation(run,invocationId,currentBootMs){
  if(run.updated_at>=currentBootMs||(run.ended_at!=null&&run.ended_at>=currentBootMs)||['starting','running','verifying'].includes(run.state))throw error('post_boot_run_continuation');
  if(this.db.prepare('SELECT 1 FROM cp_dispatches WHERE mission_id=? AND run_id=? AND (updated_at>=? OR created_at>=?)').get(run.mission_id,run.id,currentBootMs,currentBootMs))throw error('post_boot_dispatch_continuation');
  if(this.db.prepare("SELECT 1 FROM cp_leases WHERE run_id=? AND state='held' AND acquired_at>=?").get(run.id,currentBootMs))throw error('post_boot_lease_continuation');
  const inv=this.store.invocation(invocationId);
  if(!inv||inv.created_at>=currentBootMs||(inv.updated_at>=currentBootMs&&['running','unknown'].includes(inv.state)))throw error('post_boot_invocation_continuation');
  // Other same-task unknown/running invocations with post-boot timestamps block this settle.
  if(this.db.prepare("SELECT 1 FROM cp_invocations WHERE task_id=? AND request_id<>? AND (created_at>=? OR (updated_at>=? AND state IN ('running','unknown')))").get(run.task_id,invocationId,currentBootMs,currentBootMs))throw error('post_boot_sibling_invocation_continuation');
  const post=this.db.prepare('SELECT event_type FROM event_ledger_events WHERE run_id=? AND timestamp_ms>=?').all(run.id,currentBootMs);
  for(const row of post){
   if(POST_BOOT_EXECUTION_EVENTS.has(row.event_type))throw error('post_boot_execution_observed');
   if(!POST_BOOT_OBSERVATIONAL.has(row.event_type))throw error('post_boot_execution_observed');
  }
 }
 verifyBootBoundaryWitness(input){
  // Reuse the sealed web-boot packet as an OS boot-epoch witness only.
  // Never consume or rewrite that row from this path.
  return this.service.web.verifyBootBoundaryWitness({
   evidence_id:input.boot_boundary_evidence_id,
   sha256:input.boot_boundary_sha256,
   mission_id:input.mission_id,
   exclude_run_id:input.run_id
  });
 }
 settle(run,invocationId,{ownership_event_id,ownership_event_type}){
  this.db.prepare("UPDATE cp_runs SET state='termination_unverified' WHERE id=? AND state='interrupted'").run(run.id);
  this.store.updateRun(run.id,{state:'cancelled',processState:'not_started',verified:true,resolution:'operator_bridge_invocation_boot_recovery'});
  const inv=this.store.invocation(invocationId);
  if(inv&&['running','unknown'].includes(inv.state)){
   this.store.finishInvocation(invocationId,{status:'failed',error:'bridge_invocation_reconciled',recovery_not_execution:true,capability:null});
  }
  this.store.event('mission.bridge_invocation.reconciled',run.mission_id,{
   run_id:run.id,invocation_id:invocationId,actor:'operator',recovery_kind:'cold_os_reboot',
   recovery_not_execution:true,ownership_event_id,ownership_event_type
  },{runId:run.id,taskId:run.task_id});
  return {
   run_id:run.id,mission_id:run.mission_id,invocation_id:invocationId,
   reconciled:true,termination_verified:true,recovery_kind:'cold_os_reboot',
   recovery_not_execution:true,authority:false,
   ownership_event_id,ownership_event_type
  };
 }
 reconcileBoot(input){
  object(input,['run_id','mission_id','invocation_id','boot_boundary_evidence_id','boot_boundary_sha256','termination_verified','request_id','recovery_kind']);
  identifier(input.run_id);identifier(input.mission_id);identifier(input.invocation_id);identifier(input.request_id);
  if(!policy.UUID.test(input.boot_boundary_evidence_id||''))throw error('evidence_binding_required');
  if(typeof input.boot_boundary_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.boot_boundary_sha256))throw error('evidence_sha256_required');
  if(input.termination_verified!==true)throw error('explicit_termination_confirmation_required');
  if(input.recovery_kind!=='cold_os_reboot')throw error('cold_os_reboot_required');
  return this.store.request('operator',input.request_id,{
   op:'bridge_invocation_boot_recovery_reconcile',
   run_id:input.run_id,mission_id:input.mission_id,invocation_id:input.invocation_id,
   boot_boundary_evidence_id:input.boot_boundary_evidence_id,sha256:input.boot_boundary_sha256,recovery_kind:'cold_os_reboot'
  },()=>{
   const run=this.store.run(input.run_id);
   this.assertBridgeRun(run,input.mission_id);
   const owned=this.proveInvocationOwnership(run,input.invocation_id);
   const witness=this.verifyBootBoundaryWitness(input);
   const boot=require('./os-boot-epoch');
   const currentBootMs=boot.bootEpochMs(witness.current),anchor=run.ended_at||run.updated_at;
   if(!Number.isSafeInteger(anchor)||anchor>=currentBootMs)throw error('run_not_confined_to_prior_boot');
   this.assertNoPostBootContinuation(run,input.invocation_id,currentBootMs);
   const settled=this.settle(run,input.invocation_id,owned);
   // Host / web sibling ownership must remain untouched.
   return {
    ...settled,
    boot_boundary_evidence_id:input.boot_boundary_evidence_id,
    boot_boundary_sha256:input.boot_boundary_sha256,
    boot_boundary_state:witness.record.state,
    boot_boundary_consumed:false
   };
  });
 }
}
module.exports={BridgeInvocationRecovery};
