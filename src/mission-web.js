'use strict';
// ADR 0016: per-Mission signed grants inside the canonical SQLite control plane.
const fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {object,fingerprint,transaction}=require('./control-plane-store');
const {privateDirectory}=require('./local-bootstrap');
const policy=require('./mission-web-policy');
const {ResearchNetwork,error}=require('./research-network');
const {unsafeEvidenceText}=require('./research-baseline');
const hash=v=>createHash('sha256').update(v).digest('hex');
class MissionWeb{
 constructor(service){
  this.service=service;this.bridge=service.bridge;this.store=service.store;this.db=service.db;this.active=new Map();this.uncertainBrowsers=new Map();this.invocations=new Map();
  this.options=this.bridge.options.missionWeb||{};
  if(Object.keys(this.options).length&&!(process.env.NODE_ENV==='test'&&this.options.synthetic===true))throw error('synthetic_web_adapter_denied');
  this.db.exec(`CREATE TABLE IF NOT EXISTS cp_mission_web_grants(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,policy TEXT NOT NULL,policy_hash TEXT NOT NULL,seal TEXT NOT NULL,state TEXT NOT NULL,actions INTEGER NOT NULL DEFAULT 0,pages INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,requests INTEGER NOT NULL DEFAULT 0,visited_origins TEXT NOT NULL DEFAULT '[]');
   CREATE TABLE IF NOT EXISTS cp_mission_web_evidence(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,mission_id TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,sha256 TEXT NOT NULL,invocation_id TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS cp_mission_web_boot_recovery(
     evidence_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,mission_id TEXT NOT NULL,run_id TEXT NOT NULL,lease_id TEXT,
     boot_epoch TEXT NOT NULL,run_state TEXT NOT NULL,run_updated_at INTEGER NOT NULL,run_ended_at INTEGER,run_pid INTEGER,
     lease_state TEXT,captured_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','consumed')),
     created_at INTEGER NOT NULL,consumed_at INTEGER);
   CREATE UNIQUE INDEX IF NOT EXISTS cp_current_web_grant ON cp_mission_web_grants(mission_id) WHERE state='active';
   CREATE UNIQUE INDEX IF NOT EXISTS cp_web_boot_recovery_open_run ON cp_mission_web_boot_recovery(run_id) WHERE state='prepared';`);
 }
 binding(m){return fingerprint({mission_id:m.id,envelope:m.envelope,grant_id:m.grant_id});}
 qualify(m){
  if(this.db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND state='termination_unverified' AND termination_verified=0").get(m.id))throw error('web_termination_unverified');
  if(m.owner!=='operator'||!['coding','browser_research'].includes(m.envelope.kind)||!m.envelope.authority)throw error('qualified_work_mission_required');
  this.service.assertAuthority(m,{network:['internet'],data:['read']});
  if(m.envelope.worker_contract)this.bridge.workers.assertMission(m);else if(m.envelope.dispatch_policy?.privacy!=='local_only'||m.envelope.fallback_agents.length||!['host','opencode'].includes(m.envelope.preferred_agent))throw error('confined_local_worker_required');
  if(m.envelope.automatic_acceptance)throw error('web_evidence_requires_owner_acceptance');
  if(['completed','cancelled'].includes(m.state))throw error('mission_web_stopped');
  const task=this.bridge.tasks.get(m.task_id);if(!task||task.content_state==='erased'||task.cancelRequested||task.safetyStop?.latched||task.mission?.authorityRevoked)throw error('mission_web_stopped');
  if(m.envelope.manifest){const check=require('./mission-manifest').checkManifest(m.envelope.manifest,{toolName:'capability',input:{name:'mission_web',input:{}}},m.envelope.workspace);if(!check.allow)throw error('manifest_web_permission_denied');}
  return task;
 }
 configure(id,input,owner='operator'){
  if(owner!=='operator')throw error('operator_web_consent_required');object(input,['request_id','mode','entries','query','confirmed','duration_ms','permission_mode']);if(!policy.UUID.test(input.request_id||''))throw error('opaque_web_request_required');
  const m=this.store.requireMission(id);if(m.owner!=='operator')throw error('operator_mission_required');
  if(input.mode==='off')return this.store.request(owner,input.request_id,{op:'mission_web_off',id},()=>{this.db.prepare("UPDATE cp_mission_web_grants SET state='revoked' WHERE mission_id=? AND state='active'").run(id);this.cancel(id);this.store.event('mission.web.revoked',id,{actor:'operator'});return {kind:'mission_web',mission_id:id,mode:'off',message:'Web access stopped for this Mission.',authority:false};});
  const task=this.qualify(m),p=policy.normalize(inputPolicy(input),{expiresAt:Math.min(m.envelope.authority.expiresAt,m.envelope.manifest?.expires_at||Infinity)});
  if(m.envelope.manifest?.public_web){const sealed=m.envelope.manifest.public_web;if(p.mode!==sealed.mode||fingerprint(p.entries)!==fingerprint(sealed.entries)||p.query!==sealed.query)throw error('sealed_web_policy_required');}
  if(m.envelope.manifest?.permissions.network.origins&&!m.envelope.manifest.public_web&&p.origins.some(o=>!m.envelope.manifest.permissions.network.origins.includes(o)))throw error('manifest_origin_ceiling_denied');
  if(m.envelope.manifest?.permissions.network.origins&&!m.envelope.manifest.public_web&&p.mode==='all')throw error('manifest_origin_ceiling_denied');
  if(!this.bridge.missionAuthority.fixtureOnly)this.bridge.missionAuthority.initializeOperatorKey();
  return this.store.request(owner,input.request_id,{op:'mission_web_grant',id,...inputPolicy(input)},()=>{
   this.db.prepare("UPDATE cp_mission_web_grants SET state='revoked' WHERE mission_id=? AND state='active'").run(id);this.cancel(id);
   const grant={...p,id:randomUUID(),mission_binding:this.binding(m)},digest=fingerprint(grant),seal=this.bridge.missionAuthority.sealManifest({mission_id:id,manifest_hash:digest});if(!seal)throw error('signed_web_grant_required');
   this.db.prepare('INSERT INTO cp_mission_web_grants(id,mission_id,policy,policy_hash,seal,state) VALUES(?,?,?,?,?,?)').run(grant.id,id,JSON.stringify(grant),digest,JSON.stringify(seal),'active');
   this.store.event('mission.web.granted',id,{grant_id:grant.id,mode:p.mode,origins:p.origins,expires_at:p.expires_at,max_actions:p.max_actions,max_pages:p.max_pages,actor:'operator',public_only:true});
   return {kind:'mission_web',mission_id:id,mode:p.mode,grant_id:grant.id,message:'Public web access approved for this Mission within the displayed grant expiry. Login, private data, mutations and private downloads remain separately authorized.',authority:false};
  });
 }
 grant(m,{active=true}={}){
  const row=this.db.prepare("SELECT * FROM cp_mission_web_grants WHERE mission_id=? AND state='active'").get(m.id);if(!row)throw error('mission_web_approval_required');
  const p=JSON.parse(row.policy);if(fingerprint(p)!==row.policy_hash||p.mission_binding!==this.binding(m)||!this.bridge.missionAuthority.verifyManifestSeal(JSON.parse(row.seal),{mission_id:m.id,manifest_hash:row.policy_hash}))throw error('web_grant_integrity_denied');
  if(active&&Date.now()>=p.expires_at){this.cancel(m.id);throw error('web_grant_expired');}return {...row,policy:p};
 }
 status(id){const m=this.store.requireMission(id),request=policy.proposal(m.envelope.objective);let grant;try{grant=this.grant(m,{active:false});}catch{}
  return {needed:request.needed,permission_mode:grant?.policy.permission_mode||(grant?.policy.mode==='all'?'extended':'strict'),methods:['GET','HEAD'],purpose:'public_web_research',mode:grant?Date.now()>=grant.policy.expires_at?'expired':grant.policy.mode:'off',origins:grant?.policy.origins||[],expires_at:grant?.policy.expires_at||null,actions:grant?.actions||0,pages:grant?.pages||0,public_only:true,search_source:this.source(),authority:false};
 }
 source(){return this.options.searchSource??JSON.parse(fs.readFileSync(path.join(__dirname,'../config/mission-web-v1.json'),'utf8')).search_source;}
 bindInvocation(task,request){this.invocations.set(task.id,this.bridge.orchestrator.requestIdFor(task,request.toolCallId));}
 isActiveTask(id){return [...this.active.keys()].some(key=>this.store.getMission(key)?.task_id===id)||!!this.db.prepare("SELECT 1 FROM cp_runs WHERE task_id=? AND state='termination_unverified' AND termination_verified=0").get(id);}
 uncertain(m,runId,browser){this.uncertainBrowsers.set(m.id,browser);const pid=browser?.ownedProcessId?.()||this.store.run(runId)?.pid||null;this.store.updateRun(runId,{state:'termination_unverified',processState:'unknown',verified:false,resolution:'web_termination_unverified',pid});this.db.prepare("UPDATE cp_leases SET state='quarantined' WHERE run_id=? AND state='held'").run(runId);this.db.prepare("UPDATE cp_dispatches SET state='unknown' WHERE mission_id=? AND run_id=?").run(m.id,runId);this.store.event('mission.web.termination_unverified',m.id,{reconciliation_required:true,owned_process_id:pid},{runId});}
 async closeBrowser(m,runId,browser){try{const result=await browser.close();if(!result?.closed||!result.termination_verified||result.owned_process_termination!=='verified')throw error('web_termination_unverified');return result;}catch{this.uncertain(m,runId,browser);throw error('web_termination_unverified');}}
 processGone(pid){if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}}
 bootEpoch(){return require('./os-boot-epoch').readBootEpoch({testing:this.options.bootEpoch?{epoch:this.options.bootEpoch}:this.options.testing?.bootEpoch});}
 recoveryDir(){const root=path.resolve(this.bridge.dataDir,'recovery','web-termination');privateDirectory(path.dirname(root),true);return privateDirectory(root,true);}
 settleNamedRun(run,{resolution,owned_process_id=null,recovery_kind}){
  this.db.prepare("UPDATE cp_runs SET state='termination_unverified' WHERE id=? AND state='interrupted'").run(run.id);
  const mission=this.store.getMission(run.mission_id),outcome=mission?.state==='cancelled'||run.resolution==='reconcile_process'?'cancelled':'failed';
  this.store.updateRun(run.id,{state:outcome,processState:'exited',verified:true,resolution});
  this.db.prepare("UPDATE cp_leases SET state='released' WHERE run_id=? AND state='quarantined'").run(run.id);
  // Exact run-bound dispatch only; sibling/unrelated mission dispatches are untouched.
  this.db.prepare("UPDATE cp_dispatches SET state='blocked' WHERE mission_id=? AND run_id=?").run(run.mission_id,run.id);
  // Invocations settle only when canonical run-scoped web evidence binds invocation_id→run_id.
  // Never infer ownership from shared task/Mission, timestamps, or a separate dispatch row.
  for(const inv of this.db.prepare("SELECT invocation_id FROM cp_mission_web_evidence WHERE run_id=?").all(run.id)){
   const row=this.store.invocation(inv.invocation_id);if(row&&['running','unknown'].includes(row.state))this.store.finishInvocation(inv.invocation_id,{status:'failed',error:'web_reconciled',capability:'mission_web'});
  }
  this.active.delete(run.mission_id);
  this.store.event('mission.web.reconciled',run.mission_id,{run_id:run.id,actor:'operator',owned_process_id,recovery_kind,recovery_not_execution:true},{runId:run.id});
  return {run_id:run.id,mission_id:run.mission_id,reconciled:true,termination_verified:true,owned_process_id,recovery_kind,recovery_not_execution:true,authority:false};
 }
 assertRunReconcileGate(run,{requireLease=true}={}){
  if(!run)throw error('run_required');
  if(!['interrupted','termination_unverified'].includes(run.state)||run.termination_verified)throw error('web_reconcile_state_denied');
  const lease=this.db.prepare("SELECT * FROM cp_leases WHERE run_id=? AND state='quarantined'").get(run.id);
  if(requireLease&&!lease)throw error('quarantined_lease_required');
  if(this.uncertainBrowsers.has(run.mission_id))throw error('uncertain_browser_handle_retained');
  return lease||null;
 }
 reconcile(input){
  const {object,identifier}=require('./control-plane-store');object(input,['run_id','termination_verified','request_id']);identifier(input.run_id);identifier(input.request_id);
  if(input.termination_verified!==true)throw error('explicit_termination_confirmation_required');
  return this.store.request('operator',input.request_id,{op:'mission_web_reconcile',run_id:input.run_id,termination_verified:true},()=>{
   const run=this.store.run(input.run_id);this.assertBootRecoveryEligibility(run);this.assertRunReconcileGate(run);
   const pid=run.pid;if(!Number.isSafeInteger(pid)||pid<=0)throw error('owned_process_pid_required');
   // PID ESRCH is only meaningful for processes owned on the current boot.
   const boot=this.bootEpoch(),bootMs=require('./os-boot-epoch').bootEpochMs(boot),anchor=run.ended_at||run.updated_at;
   if(!Number.isSafeInteger(anchor)||anchor<bootMs)throw error('owned_process_cross_boot_use_boot_recovery');
   if(!this.processGone(pid))throw error('owned_process_still_alive');
   return this.settleNamedRun(run,{resolution:'operator_web_reconcile',owned_process_id:pid,recovery_kind:'owned_pid_esrch'});
  });
 }
 assertBootRecoveryEligibility(run){
  if(!run?.mission_id||!run.task_id)throw error('boot_recovery_run_binding_required');
  const m=this.store.getMission(run.mission_id);if(!m)throw error('boot_recovery_mission_required');
  if(m.task_id!==run.task_id)throw error('boot_recovery_task_mismatch');
  const task=this.bridge.tasks.get(m.task_id);
  if(!task||task.id!==run.task_id||task.controlPlaneMissionId!==m.id)throw error('boot_recovery_task_mismatch');
  if(task.reasoningOnly||task.missionMode==='reasoning_only'||m.envelope.kind==='conversation'||m.envelope.task_type==='reasoning')throw error('boot_recovery_reasoning_denied');
  const external=new Set(['codex','claude_code','cursor','opencode']);
  if(m.envelope.worker_contract||external.has(run.agent_id)||(m.envelope.preferred_agent&&external.has(m.envelope.preferred_agent))||(m.envelope.fallback_agents||[]).some(a=>external.has(a)))throw error('boot_recovery_external_worker_denied');
  if(!['browser_research','coding'].includes(m.envelope.kind))throw error('boot_recovery_mission_kind_denied');
  const webCapability=m.envelope.kind==='browser_research'
   ||(m.envelope.capability_scopes||[]).includes('web_read')
   ||!!this.db.prepare('SELECT 1 FROM cp_mission_web_grants WHERE mission_id=?').get(m.id)
   ||!!this.db.prepare('SELECT 1 FROM cp_mission_web_evidence WHERE mission_id=?').get(m.id);
  if(!webCapability)throw error('boot_recovery_web_capability_required');
  if(m.envelope.preferred_agent&&m.envelope.preferred_agent!=='host')throw error('boot_recovery_external_worker_denied');
  if(run.agent_id==='host'){
   if(!this.provenHostWebExecution(run,m))throw error('boot_recovery_web_execution_unproven');
   return {mission:m,task,relationship:'host_web'};
  }
  if(run.agent_id==='bridge'){
   // Sibling bridge runs require proof on this run_id; sharing a Mission with a host web run is not enough.
   if(!this.provenBridgeWebExecution(run,m))throw error('boot_recovery_bridge_web_unproven');
   return {mission:m,task,relationship:'bridge_web'};
  }
  throw error('boot_recovery_agent_denied');
 }
 provenHostWebExecution(run,m){
  if(this.db.prepare('SELECT 1 FROM cp_mission_web_evidence WHERE run_id=? AND mission_id=?').get(run.id,m.id))return true;
  if(this.db.prepare("SELECT 1 FROM event_ledger_events WHERE run_id=? AND mission_id=? AND event_type IN ('mission.web.termination_unverified','mission.web.evidence','research.browser_started','research.navigated','research.browser_closed')").get(run.id,m.id))return true;
  if(run.resolution==='web_termination_unverified'||run.resolution==='navigation_unavailable')return true;
  if(m.envelope.kind==='browser_research'&&this.db.prepare('SELECT 1 FROM cp_dispatches WHERE mission_id=? AND run_id=? AND task_id=?').get(m.id,run.id,run.task_id))return true;
  return false;
 }
 provenBridgeWebExecution(run,m){
  if(this.db.prepare('SELECT 1 FROM cp_mission_web_evidence WHERE run_id=? AND mission_id=?').get(run.id,m.id))return true;
  if(this.db.prepare("SELECT 1 FROM event_ledger_events WHERE run_id=? AND mission_id=? AND event_type IN ('mission.web.termination_unverified','mission.web.evidence','research.browser_started','research.navigated','research.browser_closed')").get(run.id,m.id))return true;
  return false;
 }
 assertNoPostBootContinuation(run,lease,currentBootMs){
  // Live Run states starting/running/verifying are current execution, not durable history.
  if(run.updated_at>=currentBootMs||(run.ended_at!=null&&run.ended_at>=currentBootMs)||['starting','running','verifying'].includes(run.state))throw error('post_boot_run_continuation');
  // Persisted dispatching/running alone is not post-boot proof: after a cold reboot the
  // durable row may remain running while all authoritative timestamps predate the boot.
  // Only timestamp advancement (or a post-boot-created row) is continuation.
  if(this.db.prepare('SELECT 1 FROM cp_dispatches WHERE mission_id=? AND run_id=? AND (updated_at>=? OR created_at>=?)').get(run.mission_id,run.id,currentBootMs,currentBootMs))throw error('post_boot_dispatch_continuation');
  // Unbound running/dispatching rows on this task are relationship drift, not historical ownership.
  if(this.db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND task_id=? AND state IN ('dispatching','running') AND run_id IS NULL").get(run.mission_id,run.task_id))throw error('post_boot_dispatch_relationship_denied');
  if(this.db.prepare("SELECT 1 FROM cp_invocations WHERE task_id=? AND (created_at>=? OR (updated_at>=? AND state IN ('running','unknown')))").get(run.task_id,currentBootMs,currentBootMs))throw error('post_boot_invocation_continuation');
  if(lease&&this.db.prepare("SELECT 1 FROM cp_leases WHERE id=? AND (state<>'quarantined' OR run_id<>?)").get(lease.id,run.id))throw error('post_boot_lease_continuation');
  if(this.db.prepare("SELECT 1 FROM cp_leases WHERE run_id=? AND state='held' AND acquired_at>=?").get(run.id,currentBootMs))throw error('post_boot_lease_continuation');
  const post=this.db.prepare("SELECT count(*) n FROM event_ledger_events WHERE run_id=? AND timestamp_ms>=? AND event_type IN ('research.browser_started','research.navigated','research.network_denied','research.browser_closed','mission.web.evidence','run.started','mission.running','mission.dispatching')").get(run.id,currentBootMs).n;
  if(post)throw error('post_boot_execution_observed');
 }
 prepareBootRecovery(input){
  const {object,identifier}=require('./control-plane-store');object(input,['run_id','request_id','lease_id']);identifier(input.run_id);identifier(input.request_id);
  return this.store.request('operator',input.request_id,{op:'mission_web_boot_recovery_prepare',run_id:input.run_id,lease_id:input.lease_id||null},()=>{
   const run=this.store.run(input.run_id);this.assertBootRecoveryEligibility(run);const lease=this.assertRunReconcileGate(run,{requireLease:!!input.lease_id||!!this.db.prepare("SELECT 1 FROM cp_leases WHERE run_id=? AND state='quarantined'").get(input.run_id)});
   if(Number.isSafeInteger(run.pid)&&run.pid>0)throw error('owned_process_pid_present_use_pid_reconcile');
   if(input.lease_id){if(!policy.UUID.test(input.lease_id))throw error('lease_binding_required');if(!lease||lease.id!==input.lease_id)throw error('lease_binding_mismatch');}
   else if(lease)throw error('lease_binding_required');
   if(this.db.prepare("SELECT 1 FROM cp_mission_web_boot_recovery WHERE run_id=? AND state='prepared'").get(run.id))throw error('boot_recovery_already_prepared');
   const boot=this.bootEpoch(),id=randomUUID(),capturedAt=typeof this.options.now==='function'?this.options.now():Date.now(),bootFp=require('./os-boot-epoch').fingerprint(boot);
   const packet={schema_version:'airodrom-web-boot-recovery-v1',evidence_id:id,mission_id:run.mission_id,run_id:run.id,lease_id:lease?.id||null,
    run:{state:run.state,process_state:run.process_state,termination_verified:!!run.termination_verified,pid:run.pid,updated_at:run.updated_at,ended_at:run.ended_at,resolution:run.resolution,agent_id:run.agent_id},
    lease:lease?{id:lease.id,state:lease.state,mode:lease.mode,resource:lease.resource}:null,
    boot_epoch:boot,captured_at:capturedAt,authority:false,browser_closed_receipt:false,
    purpose:'pre_cold_reboot_quarantine_evidence'};
   const bytes=Buffer.from(JSON.stringify(packet)+'\n'),digest=hash(bytes);
   fs.writeFileSync(path.join(this.recoveryDir(),id+'.json'),bytes,{mode:0o600,flag:'wx'});
   // Canonical SHA-256 is independently durable in SQLite; the file alone is not authority.
   this.db.prepare("INSERT INTO cp_mission_web_boot_recovery(evidence_id,sha256,mission_id,run_id,lease_id,boot_epoch,run_state,run_updated_at,run_ended_at,run_pid,lease_state,captured_at,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?)")
    .run(id,digest,run.mission_id,run.id,lease?.id||null,bootFp,run.state,run.updated_at,run.ended_at??null,run.pid??null,lease?.state||null,capturedAt,capturedAt);
   this.store.event('mission.web.boot_recovery_prepared',run.mission_id,{evidence_id:id,sha256:digest,boot_epoch:bootFp,lease_id:lease?.id||null},{runId:run.id});
   return {evidence_id:id,mission_id:run.mission_id,run_id:run.id,lease_id:lease?.id||null,boot_epoch:boot,sha256:digest,authority:false,recovery_not_execution:true,
    next:'Owner-authorized cold OS reboot required. After the new boot epoch differs, call web-reconcile-boot with this evidence_id and sha256. This packet is not a browser_closed receipt.'};
  });
 }
 // Boot-epoch witness for non-web recovery paths. Accepts prepared or consumed
 // host web-boot evidence, verifies digest integrity, and never mutates the row.
 verifyBootBoundaryWitness(input){
  const {object,identifier}=require('./control-plane-store');object(input,['evidence_id','sha256','mission_id','exclude_run_id']);
  identifier(input.mission_id);identifier(input.exclude_run_id);if(!policy.UUID.test(input.evidence_id||''))throw error('evidence_binding_required');
  if(typeof input.sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.sha256))throw error('evidence_sha256_required');
  const record=this.db.prepare('SELECT * FROM cp_mission_web_boot_recovery WHERE evidence_id=?').get(input.evidence_id);
  if(!record)throw error('recovery_evidence_unknown');
  if(!['prepared','consumed'].includes(record.state))throw error('recovery_evidence_state_denied');
  if(record.sha256!==input.sha256||record.mission_id!==input.mission_id)throw error('recovery_evidence_registry_mismatch');
  if(record.run_id===input.exclude_run_id)throw error('boot_boundary_witness_self_run_denied');
  const file=path.join(this.recoveryDir(),input.evidence_id+'.json');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let packet,bytes;try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||stat.mode&0o077||stat.size>65536)throw error('recovery_evidence_integrity_denied');bytes=fs.readFileSync(fd);packet=JSON.parse(bytes);}finally{fs.closeSync(fd);}
  if(hash(bytes)!==record.sha256||hash(bytes)!==input.sha256)throw error('recovery_evidence_digest_mismatch');
  if(packet.schema_version!=='airodrom-web-boot-recovery-v1'||packet.evidence_id!==input.evidence_id||packet.mission_id!==input.mission_id||packet.run_id!==record.run_id||(packet.lease_id||null)!==(record.lease_id||null)||packet.browser_closed_receipt!==false||packet.authority!==false)throw error('recovery_evidence_binding_denied');
  const bootFp=require('./os-boot-epoch').fingerprint(packet.boot_epoch);
  if(bootFp!==record.boot_epoch||packet.captured_at!==record.captured_at||packet.run.state!==record.run_state||packet.run.updated_at!==record.run_updated_at||(packet.run.ended_at??null)!==(record.run_ended_at??null)||(packet.run.pid??null)!==(record.run_pid??null)||(packet.lease?.state||null)!==(record.lease_state||null))throw error('recovery_evidence_registry_mismatch');
  const prior=packet.boot_epoch,current=this.bootEpoch(),boot=require('./os-boot-epoch');
  if(boot.sameBootEpoch(prior,current))throw error('cold_os_reboot_not_observed');
  const currentBootMs=boot.bootEpochMs(current),priorBootMs=boot.bootEpochMs(prior);
  if(!Number.isSafeInteger(packet.captured_at)||packet.captured_at<priorBootMs||currentBootMs<=packet.captured_at)throw error('boot_boundary_ordering_denied');
  return {record,packet,prior,current,currentBootMs,priorBootMs};
 }
 reconcileBootRecovery(input){
  const {object,identifier}=require('./control-plane-store');object(input,['run_id','mission_id','lease_id','evidence_id','sha256','termination_verified','request_id','recovery_kind']);
  identifier(input.run_id);identifier(input.request_id);identifier(input.mission_id);if(!policy.UUID.test(input.evidence_id||''))throw error('evidence_binding_required');
  if(typeof input.sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.sha256))throw error('evidence_sha256_required');
  if(input.termination_verified!==true)throw error('explicit_termination_confirmation_required');
  if(input.recovery_kind!=='cold_os_reboot')throw error('cold_os_reboot_required');
  return this.store.request('operator',input.request_id,{op:'mission_web_boot_recovery_reconcile',run_id:input.run_id,evidence_id:input.evidence_id,sha256:input.sha256,recovery_kind:'cold_os_reboot'},()=>{
   const record=this.db.prepare("SELECT * FROM cp_mission_web_boot_recovery WHERE evidence_id=?").get(input.evidence_id);
   if(!record)throw error('recovery_evidence_unknown');
   if(record.state!=='prepared')throw error('recovery_evidence_already_consumed');
   if(record.sha256!==input.sha256||record.mission_id!==input.mission_id||record.run_id!==input.run_id||(record.lease_id||null)!==(input.lease_id||null))throw error('recovery_evidence_registry_mismatch');
   const run=this.store.run(input.run_id);if(!run||run.mission_id!==input.mission_id)throw error('mission_run_binding_mismatch');
   this.assertBootRecoveryEligibility(run);
   const lease=this.assertRunReconcileGate(run,{requireLease:!!input.lease_id||!!this.db.prepare("SELECT 1 FROM cp_leases WHERE run_id=? AND state='quarantined'").get(run.id)});
   if(Number.isSafeInteger(run.pid)&&run.pid>0)throw error('owned_process_pid_present_use_pid_reconcile');
   if(input.lease_id){if(!policy.UUID.test(input.lease_id)||!lease||lease.id!==input.lease_id)throw error('lease_binding_mismatch');}
   else if(lease)throw error('lease_binding_required');
   const file=path.join(this.recoveryDir(),input.evidence_id+'.json');
   const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   let packet,bytes;try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||stat.mode&0o077||stat.size>65536)throw error('recovery_evidence_integrity_denied');bytes=fs.readFileSync(fd);packet=JSON.parse(bytes);}finally{fs.closeSync(fd);}
   if(hash(bytes)!==record.sha256||hash(bytes)!==input.sha256)throw error('recovery_evidence_digest_mismatch');
   if(packet.schema_version!=='airodrom-web-boot-recovery-v1'||packet.evidence_id!==input.evidence_id||packet.mission_id!==input.mission_id||packet.run_id!==input.run_id||(packet.lease_id||null)!==(input.lease_id||null)||packet.browser_closed_receipt!==false||packet.authority!==false)throw error('recovery_evidence_binding_denied');
   const bootFp=require('./os-boot-epoch').fingerprint(packet.boot_epoch);
   if(bootFp!==record.boot_epoch||packet.captured_at!==record.captured_at||packet.run.state!==record.run_state||packet.run.updated_at!==record.run_updated_at||(packet.run.ended_at??null)!==(record.run_ended_at??null)||(packet.run.pid??null)!==(record.run_pid??null)||(packet.lease?.state||null)!==(record.lease_state||null))throw error('recovery_evidence_registry_mismatch');
   if(packet.run.state!==run.state||packet.run.updated_at!==run.updated_at||packet.run.pid!==run.pid||!!packet.run.termination_verified!==!!run.termination_verified||(lease&&(packet.lease?.id!==lease.id||packet.lease?.state!==lease.state)))throw error('recovery_evidence_stale');
   const prior=packet.boot_epoch,current=this.bootEpoch(),boot=require('./os-boot-epoch');
   if(boot.sameBootEpoch(prior,current))throw error('cold_os_reboot_not_observed');
   const currentBootMs=boot.bootEpochMs(current),priorBootMs=boot.bootEpochMs(prior),anchor=run.ended_at||run.updated_at;
   if(!Number.isSafeInteger(packet.captured_at)||packet.captured_at<priorBootMs||currentBootMs<=packet.captured_at)throw error('boot_boundary_ordering_denied');
   if(!Number.isSafeInteger(anchor)||anchor>=currentBootMs)throw error('run_not_confined_to_prior_boot');
   this.assertNoPostBootContinuation(run,lease,currentBootMs);
   const settled=this.settleNamedRun(run,{resolution:'operator_web_boot_recovery',owned_process_id:null,recovery_kind:'cold_os_reboot'});
   const consumedAt=typeof this.options.now==='function'?this.options.now():Date.now();
   this.db.prepare("UPDATE cp_mission_web_boot_recovery SET state='consumed',consumed_at=? WHERE evidence_id=? AND state='prepared'").run(consumedAt,input.evidence_id);
   if(!this.db.prepare("SELECT 1 FROM cp_mission_web_boot_recovery WHERE evidence_id=? AND state='consumed'").get(input.evidence_id))throw error('recovery_evidence_consume_failed');
   return {...settled,evidence_id:input.evidence_id,sha256:input.sha256};
  });
 }
 assess(task,input,{budget=true}={}){
  const m=this.store.requireMission(input.mission_id),bound=this.qualify(m),g=this.grant(m);
  const dispatch=this.db.prepare("SELECT run_id FROM cp_dispatches WHERE mission_id=? AND task_id=? AND state='running'").get(m.id,task.id),run=dispatch?.run_id?this.store.run(dispatch.run_id):null;
  if(task.controlPlaneMissionId!==m.id||bound.id!==task.id||!run||run.state!=='running'||run.mission_id!==m.id||run.task_id!==task.id||dispatch?.run_id!==run.id||m.state!=='running')throw error('active_canonical_web_run_required');
  if(budget&&(g.actions>=g.policy.max_actions||g.pages>=g.policy.max_pages||g.bytes>=g.policy.max_bytes))throw error('mission_web_budget_exhausted');
  if(input.action.type==='search'&&!g.policy.query)throw error('sealed_public_query_required');
  if(input.action.type!=='search')this.destination(m,g,input.action);
  return {scope:{mission_id:m.id,grant_id:g.id,public_only:true},facts:{grant_id:g.id}};
 }
 directory(task){const session=path.resolve(this.bridge.dataDir,'tasks',task.id,'sessions');if(task.sessionDir!==session)throw error('web_evidence_scope_denied');privateDirectory(session);return privateDirectory(path.join(session,'web-evidence'),true);}
 read(row){const task=this.bridge.tasks.get(row.task_id);if(!task||task.content_state==='erased')throw error('web_evidence_erased');const file=path.join(this.directory(task),row.id+'.json'),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.nlink!==1||stat.mode&0o077||stat.size>1048576)throw error('web_evidence_integrity_denied');const bytes=fs.readFileSync(fd);if(hash(bytes)!==row.sha256)throw error('web_evidence_integrity_denied');return JSON.parse(bytes);}finally{fs.closeSync(fd);}
 }
 rows(m,runId){return this.db.prepare('SELECT * FROM cp_mission_web_evidence WHERE mission_id=?'+(runId?' AND run_id=?':'')+' ORDER BY created_at').all(...(runId?[m.id,runId]:[m.id]));}
 candidates(m,g){return this.rows(m).filter(r=>r.grant_id===g.id).flatMap(r=>this.read(r).links||[]);}
 destination(m,g,a){let url=a.url;if(a.type==='click'){const link=this.candidates(m,g).find(l=>l.id===a.link_id);if(!link)throw error('verified_current_link_required');url=link.url;}
  const known=g.policy.entries.includes(url)||this.candidates(m,g).some(l=>l.url===url);if(!known)throw error('operator_source_or_verified_link_required');
  const network=this.network(g);try{url=network.validate(url);}catch(e){this.store.event('mission.web.permission_needed',m.id,{grant_id:g.id,reason:e.code,origin:new URL(url).origin,public_only:true});throw e;}
  return url;
 }
 transportUsage(g,{origin,bytes=0}={}){transaction(this.db,()=>{const m=this.store.requireMission(g.mission_id),current=this.grant(m);if(current.id!==g.id||m.state!=='running'||this.bridge.tasks.get(m.task_id).cancelRequested)throw error('mission_web_stopped');const visited=JSON.parse(current.visited_origins);if(origin&&!visited.includes(origin)){require('./research-network').safeOrigin(origin);if(visited.length>=g.policy.max_origins)throw error('mission_web_domain_budget');visited.push(origin);}if(origin&&current.requests>=g.policy.max_requests||current.bytes+bytes>g.policy.max_bytes)throw error('mission_web_transport_budget');this.db.prepare('UPDATE cp_mission_web_grants SET requests=requests+?,bytes=bytes+?,visited_origins=? WHERE id=?').run(origin?1:0,bytes,JSON.stringify(visited),g.id);});}
 network(g,signal){const origins=g.policy.origins.length?g.policy.origins:['https://example.com'];return new ResearchNetwork({scope:{origins,publicDiscovery:g.policy.mode==='all',maxOrigins:g.policy.max_origins},signal,testing:this.options.testing,...(signal?{onRequest:origin=>this.transportUsage(g,{origin}),onBytes:bytes=>this.transportUsage(g,{bytes})}:{})});}
 async perform(task,input,signal){
  this.assess(task,input);const m=this.store.requireMission(input.mission_id),g=this.grant(m),runId=this.runFor(m,task).id;if(this.active.has(m.id))throw error('mission_web_busy');
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(abort,Math.max(0,g.policy.expires_at-Date.now()));this.active.set(m.id,controller);
  let browser,result,termination={closed:true,termination_verified:true,owned_process_termination:'verified'};
  transaction(this.db,()=>{const current=this.grant(m);if(current.id!==g.id)throw error('web_grant_changed');this.db.prepare('UPDATE cp_mission_web_grants SET actions=actions+1,pages=pages+1 WHERE id=?').run(g.id);});
  try{
   if(input.action.type==='search'){
    const source=await (this.options.search||require('./mission-web-search').search)({query:g.policy.query,source:this.source(),signal:controller.signal,testing:this.options.testing,onRequest:origin=>this.transportUsage(g,{origin}),onBytes:bytes=>this.transportUsage(g,{bytes})});
    result={classification:'documented',title:'Public web search',text:source.results.map(r=>r.title+' — '+r.url).join('\n'),source,links:source.results.map(r=>({id:randomUUID(),text:r.title,url:r.url})),bytes:source.bytes};
   }else{
    const url=this.destination(m,g,input.action);
    if(input.action.type==='document')result=await require('./mission-web-document').read({url,network:this.network(g,controller.signal),signal:controller.signal});
    else{
     const scope={origins:g.policy.origins.length?g.policy.origins:[new URL(url).origin],publicDiscovery:g.policy.mode==='all',maxOrigins:g.policy.max_origins,maxActions:10,allowDownloads:false};
     browser=this.options.browserFactory?this.options.browserFactory({scope,signal:controller.signal,evidenceDir:this.directory(task)}):new (require('./research-browser').ResearchBrowser)({scope,network:this.network(g,controller.signal),onEvidenceBytes:bytes=>this.transportUsage(g,{bytes}),signal:controller.signal,evidenceDir:this.directory(task),onEvent:e=>this.store.event(e.type,m.id,{grant_id:g.id,reason:e.reason||null},{runId})});
     if(typeof browser.start==='function')await browser.start();
     const pid=browser.ownedProcessId?.()||null;if(pid)this.store.updateRun(runId,{state:'running',processState:'alive',pid});
     await browser.execute({type:'navigate',url});const row=await browser.execute({type:input.action.type==='screenshot'||input.action.type==='explore'?'screenshot':'snapshot'});
     if(!browser.verify(row))throw error('web_evidence_integrity_denied');
     result={classification:row.classification,title:row.title,text:row.text,url:row.url,links:row.links||[],browser_evidence:row,bytes:Buffer.byteLength(JSON.stringify(row))+[row.evidence_ref,row.screenshot_ref].filter(Boolean).reduce((sum,ref)=>sum+fs.statSync(ref.path).size,0),...(input.action.type==='test'?{functionality:{navigation:row.classification==='observed'?'observed':'inaccessible',forms:'untested',mutations:'denied'}}:{})};
    }
   }
   if(controller.signal.aborted)throw error('cancelled');
   if(browser){termination=await this.closeBrowser(m,runId,browser);browser=null;}if(!termination.termination_verified)throw error('web_termination_unverified');
   this.assess(task,input,{budget:false});if(this.grant(m).id!==g.id)throw error('web_grant_changed');
   if(unsafeEvidenceText(result.text)||unsafeEvidenceText(result.title)||result.classification==='inaccessible'&&result.text)throw error('private_web_evidence_denied');
   const current=this.grant(m);if(!Number.isSafeInteger(result.bytes)||result.bytes<0||current.bytes+result.bytes>g.policy.max_bytes)throw error('mission_web_byte_budget');
   const invocation=this.invocations.get(task.id);if(!invocation||this.store.invocation(invocation)?.state!=='running')throw error('canonical_web_invocation_required');
   const id=randomUUID(),record={id,mission_id:m.id,task_id:task.id,run_id:runId,grant_id:g.id,action:input.action.type,...result,termination,untrusted:true,authority:false,captured_at:Date.now()},bytes=Buffer.from(JSON.stringify(record)+'\n');if(bytes.length>1048576)throw error('web_evidence_bound');if(current.bytes+result.bytes+bytes.length>g.policy.max_bytes)throw error('mission_web_byte_budget');
   const file=path.join(this.directory(task),id+'.json');fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});
   this.db.prepare('INSERT INTO cp_mission_web_evidence VALUES(?,?,?,?,?,?,?,?)').run(id,g.id,m.id,task.id,runId,hash(bytes),invocation,Date.now());this.db.prepare('UPDATE cp_mission_web_grants SET bytes=bytes+? WHERE id=?').run(result.bytes+bytes.length,g.id);
   this.store.event('mission.web.evidence',m.id,{evidence_id:id,grant_id:g.id,classification:record.classification,action:record.action,termination_verified:true},{runId});return this.project(record);
  }finally{
   clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();try{if(browser&&!this.uncertainBrowsers.has(m.id))await this.closeBrowser(m,runId,browser);}finally{if(!this.uncertainBrowsers.has(m.id))this.active.delete(m.id);}
  }
 }
 project(record){return {evidence_id:record.id,classification:record.classification,title:record.title,text:record.text,...(record.url?{url:record.url}:{}),links:record.links,source:record.source?{source_id:record.source.source_id,source_url:record.source.source_url,fetched_at:record.source.fetched_at}:undefined,functionality:record.functionality,untrusted:true,authority:false};}
 verify(m,run){
  const rows=this.rows(m,run.id);for(const row of rows){const e=this.read(row),invocation=this.store.invocation(row.invocation_id);if(invocation?.state!=='settled'||invocation.result?.status!=='completed'||invocation.result?.capability!=='mission_web'||invocation.task_id!==row.task_id)throw error('web_invocation_integrity_denied');if(e.mission_id!==m.id||e.task_id!==run.task_id||e.run_id!==run.id||e.grant_id!==row.grant_id||e.authority!==false||!e.untrusted||!e.termination.termination_verified||unsafeEvidenceText(e.text)||unsafeEvidenceText(e.title))throw error('web_evidence_integrity_denied');
   const historical=this.db.prepare('SELECT * FROM cp_mission_web_grants WHERE id=? AND mission_id=?').get(row.grant_id,m.id);if(!historical)throw error('web_grant_provenance_denied');const p=JSON.parse(historical.policy);if(fingerprint(p)!==historical.policy_hash||p.mission_binding!==this.binding(m)||!this.bridge.missionAuthority.verifyManifestSeal(JSON.parse(historical.seal),{mission_id:m.id,manifest_hash:historical.policy_hash}))throw error('web_grant_provenance_denied');
   if(e.browser_evidence){if(!require('./research-browser').verifyEvidence(e.browser_evidence,{evidenceDir:this.directory(this.bridge.tasks.get(run.task_id)),scope:{origins:p.origins.length?p.origins:[new URL(e.browser_evidence.url).origin],publicDiscovery:p.mode==='all',maxOrigins:p.max_origins}}))throw error('web_evidence_integrity_denied');}}
  return {evidence_count:rows.length,termination_verified:true,authority:false};
 }
 runFor(m,task){const dispatch=this.db.prepare("SELECT run_id FROM cp_dispatches WHERE mission_id=? AND task_id=? AND state='running'").get(m.id,task.id),run=dispatch?.run_id?this.store.run(dispatch.run_id):null;if(!run||run.task_id!==task.id||run.mission_id!==m.id||run.state!=='running')throw error('active_canonical_web_run_required');return run;}
 context(task){const m=this.store.requireMission(task.controlPlaneMissionId),run=this.runFor(m,task);if(!run||run.task_id!==task.id)throw error('web_context_run_required');this.verify(m,run);return this.rows(m,run.id).map(r=>this.project(this.read(r))).slice(0,8);}
 async preflight(m,task){
  const requested=policy.proposal(m.envelope.objective);let g;try{g=this.grant(m);}catch(e){if(requested.needed)throw e;return;}
  task.activeRunId=this.db.prepare("SELECT id FROM cp_runs WHERE task_id=? AND mission_id=? AND state='running' ORDER BY created_at DESC LIMIT 1").get(task.id,m.id)?.id;if(!task.activeRunId)throw error('active_canonical_web_run_required');
  const actions=g.policy.query?[{type:'search'}]:[];actions.push(...g.policy.entries.slice(0,3).map(url=>({type:/\.pdf$/i.test(new URL(url).pathname)?'document':'explore',url})));
  for(const action of actions){if(action.type==='search'&&!this.source())throw error('approved_search_provider_unavailable');await this.call(m,task,action);}
 }
 async call(m,task,action){
  const requestId=randomUUID();let response=await this.bridge.invokeCapability(task.id,{name:'mission_web',input:{mission_id:m.id,action},requestId});
  if(response.status==='pending'&&this.bridge.orchestrator.inflight.has(requestId))response=await this.bridge.orchestrator.inflight.get(requestId);
  if(this.uncertainBrowsers.has(m.id))throw error('web_termination_unverified');
  if(response.status==='completed')return response;
  // Preserve the authoritative broker/browser code instead of a generic preflight label.
  const reason=String(response.decision?.reason||response.error||'');
  const refused=/Public research network refused: ([a-z_]{1,80})/.exec(reason);
  if(refused)throw error(refused[1]);
  if(response.decision?.kind==='approval_required')throw error('capability_authorization_denied');
  if(response.status==='pending')throw error('capability_execution_unsettled');
  throw error('mission_web_preflight_stopped');
 }
 createResearch(input,owner='operator'){
  if(owner!=='operator')throw error('operator_web_consent_required');object(input,['objective','mode','entries','query','confirmed','request_id','duration_ms','permission_mode']);
  const p=policy.normalize(inputPolicy(input));
  return this.store.request(owner,'web-research:'+input.request_id,{op:'public_web_research',...input},()=>{
   const created=this.service.research.create({request_id:input.request_id,objective:input.objective,entry_url:p.entries[0]||'https://html.duckduckgo.com/html/',public_web:inputPolicy(input)});
   this.configure(created.mission_id,{...inputPolicy(input),request_id:randomUUID()});return created;
  });
 }
 async launchResearch(dispatch,m){
  const research=this.service.research,task=research.assertContract(m,{execution:true}),runId=randomUUID(),deadline=m.envelope.manifest.expires_at;
  let started=false;
  try{
   transaction(this.db,()=>{this.store.startRun({id:runId,taskId:task.id,missionId:m.id,agentId:'host'});this.store.acquireLease({resource:m.envelope.workspace,runId,missionId:m.id,mode:'read',baseline:m.envelope.baseline,ttlMs:Math.max(1,deadline-Date.now())});this.store.updateRun(runId,{state:'running',processState:'not_started'});this.db.prepare("UPDATE cp_dispatches SET state='running',run_id=? WHERE id=?").run(runId,dispatch.id);this.store.state(m.id,'running');task.activeRunId=runId;task.status='running';task.assignedAgent='host';task.mission.started=true;task.mission.status='active';require('./execution-evidence').begin(task,runId);this.bridge.tasks.save(task);started=true;});
   research.phase(m.id,'browser');await this.preflight(m,task);
   const grant=this.grant(m),records=this.rows(m,runId).map(r=>this.read(r));
   if(grant.policy.mode==='all'&&grant.policy.query){for(const link of records.flatMap(r=>r.links||[]).slice(0,2)){try{await this.call(m,task,{type:'explore',url:link.url});}catch{this.store.event('mission.web.source_inaccessible',m.id,{reason:'public_source_unavailable'});}}}
   this.verify(m,this.store.run(runId));const evidence=this.rows(m,runId).map(r=>this.read(r)),baseline=research.baseline(m.envelope.workspace,m),browserRows=evidence.filter(r=>r.browser_evidence).map(r=>r.browser_evidence),scope={origins:grant.policy.origins.length?grant.policy.origins:[new URL(m.envelope.manifest.entry_url).origin],publicDiscovery:grant.policy.mode==='all',maxOrigins:grant.policy.max_origins};
   const reporter=new (require('./research-report').ResearchReport)({baseline,evidenceStore:{verify:row=>require('./research-browser').verifyEvidence(row,{evidenceDir:this.directory(task),scope})}});
   const built=await reporter.build({competitor:m.envelope.manifest.entry_url,evidence:browserRows,baselineSnapshot:m.envelope.research_baseline});const report=JSON.parse(JSON.stringify(built));
   const sourceLines=evidence.filter(e=>e.source).flatMap(e=>e.links?.length?e.links.map(l=>'• Documented search result: '+l.text+' — '+l.url):['• Documented public source: '+e.url]);
   if(sourceLines.length)report.markdown+='\n\nPublic source provenance\n'+sourceLines.join('\n')+'\nSearch titles are source claims; website functionality has not been established by search.\n';
   report.digest=hash(report.markdown);if(report.markdown.length>12000)throw error('web_report_bound');
   const bytes=Buffer.from(JSON.stringify({mission_id:m.id,run_id:runId,baseline_digest:m.envelope.research_baseline.digest,report})+'\n');fs.writeFileSync(path.join(this.directory(task),runId+'.report.json'),bytes,{mode:0o600,flag:'wx'});
   this.db.prepare('INSERT INTO cp_artifacts VALUES(?,?,?,?,?,?,?)').run(runId,m.id,runId,'web_report',runId,JSON.stringify({sha256:hash(bytes)}),Date.now());
   this.store.updateRun(runId,{state:'completed',processState:'not_started',verified:true,result:{web_report:{sha256:hash(bytes)},native_execution_evidence:{...task.nativeExecutionEvidence}}});research.phase(m.id,'browser','completed');research.phase(m.id,'report','completed');
   const websiteOnly=m.envelope.manifest.research_mode==='website_only'||m.envelope.research_baseline?.project==='WebsiteOnly';
   this.service.captureResult(runId,{status:'completed',result:{text:JSON.stringify({summary:websiteOnly?'Public website research evidence prepared for owner review. No product repository comparison was performed.':'Public web research evidence and current Arecibo comparison prepared for owner review.',changed_files:[],tests:[],artifacts:[],limitations:['Account-only areas remain inaccessible. Recommendations require separate authorization.']})}});
  }catch(e){
   const uncertain=e.code==='web_termination_unverified'||this.uncertainBrowsers.has(m.id);if(started){this.store.updateRun(runId,{state:uncertain?'termination_unverified':'failed',processState:uncertain?'unknown':'not_started',verified:!uncertain,resolution:/^[a-z_]+$/.test(e.code||'')?e.code:'public_web_stopped'});}
   this.db.prepare("UPDATE cp_dispatches SET state=? WHERE id=?").run(uncertain?'unknown':'blocked',dispatch.id);if(this.store.getMission(m.id).state!=='cancelled')this.store.state(m.id,'blocked',e.code==='approved_search_provider_unavailable'?'No approved search provider is configured. No search results were invented.':e.code||'Public research stopped safely.');
  }finally{delete task.activeRunId;this.bridge.tasks.save(task);this.bridge.emit('change');}
 }
 researchArtifact(m,run){
  this.service.research.assertContract(m);this.verify(m,run);if(run.state!=='completed'||!run.termination_verified)throw error('verified_web_report_required');
  const artifact=this.db.prepare("SELECT * FROM cp_artifacts WHERE id=? AND mission_id=? AND run_id=? AND kind='web_report'").get(run.id,m.id,run.id);if(!artifact||JSON.parse(artifact.metadata).sha256!==run.result.web_report?.sha256)throw error('web_report_integrity_denied');
  const fd=fs.openSync(path.join(this.directory(this.bridge.tasks.get(run.task_id)),run.id+'.report.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.mode&0o077||stat.uid!==process.getuid?.()||stat.size>262144)throw error('web_report_integrity_denied');const bytes=fs.readFileSync(fd);if(hash(bytes)!==run.result.web_report.sha256)throw error('web_report_integrity_denied');const value=JSON.parse(bytes);if(value.mission_id!==m.id||value.run_id!==run.id||value.baseline_digest!==m.envelope.research_baseline.digest||value.report.digest!==hash(value.report.markdown))throw error('web_report_integrity_denied');return value;}finally{fs.closeSync(fd);}
 }
 verifyResearch(m,run){try{
  const result=this.researchArtifact(m,run),checks=[],add=(id,status,evidence)=>checks.push({id,status,evidence});
  add('web_evidence','passed',this.verify(m,run));add('browser_termination','passed',{termination_verified:true});add('artifact_integrity','passed',{immutable_artifacts_rehashed:true});
  add('native_execution',require('./execution-evidence').runSatisfied(run)?'passed':'failed',{completed_invocations:this.rows(m,run.id).length});
  const current=this.service.research.safeSnapshot(m);add('read_only_boundary',current.hash===m.envelope.baseline.hash?'passed':'failed',{approved_sources_unchanged:current.hash===m.envelope.baseline.hash});
  add('baseline_integrity','passed',{baseline_digest:result.baseline_digest});add('verification_workspace_stable',current.hash===m.envelope.baseline.hash?'passed':'failed',{scope:'approved_research_sources'});add('report','operator_review',{owner_review_required:true});
  return {status:checks.some(c=>c.status==='failed')?'failed':'operator_review',checks,workspace_hash:current.hash};
 }catch{return {status:'failed',checks:[{id:'web_evidence',status:'failed',evidence:{reason:'web_evidence_unavailable'}}],workspace_hash:'unavailable'};}}

 report(m){const run=this.db.prepare("SELECT id FROM cp_runs WHERE mission_id=? AND agent_id='host' AND state='completed' ORDER BY ended_at DESC").all(m.id).map(r=>this.store.run(r.id)).find(r=>r.result?.web_report);if(!run)throw error('web_report_unavailable');const value=this.researchArtifact(m,run),report=stripPaths(value.report);return {mission_id:m.id,markdown:report.markdown,report,screenshots:this.rows(m,run.id).map(r=>this.read(r).browser_evidence).filter(r=>r?.screenshot_ref).map(r=>({id:r.id,viewport:r.viewport,sha256:r.screenshot_ref.sha256})),accepted:m.state==='completed',authority:false};}
 evidence(m,id){if(!policy.UUID.test(id||''))throw error('web_evidence_scope_denied');this.report(m);const runRows=this.rows(m).map(r=>({row:r,value:this.read(r)})),found=runRows.find(r=>r.value.browser_evidence?.id===id&&r.value.browser_evidence?.screenshot_ref?.id===id);if(!found)throw error('web_screenshot_unavailable');this.researchArtifact(m,this.store.run(found.row.run_id));const ref=found.value.browser_evidence.screenshot_ref;if(ref.path!==path.join(this.directory(this.bridge.tasks.get(m.task_id)),id+'.png'))throw error('web_evidence_scope_denied');const fd=fs.openSync(ref.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.mode&0o077||stat.uid!==process.getuid?.()||stat.size>4194304)throw error('web_evidence_integrity_denied');const buffer=fs.readFileSync(fd);if(hash(buffer)!==ref.sha256)throw error('web_evidence_integrity_denied');return {buffer,mime:'image/png'};}finally{fs.closeSync(fd);}}
 cancel(id){this.active.get(id)?.abort();}
 async close(){for(const [id,browser] of this.uncertainBrowsers){try{const result=await browser.close();if(result?.closed&&result.termination_verified&&result.owned_process_termination==='verified'){this.uncertainBrowsers.delete(id);this.active.delete(id);}}catch{}}for(const c of this.active.values())c.abort();const until=Date.now()+15000;while(this.active.size&&Date.now()<until)await new Promise(r=>setTimeout(r,20));if(this.active.size)throw error('web_termination_unverified');}
}
function stripPaths(value){if(Array.isArray(value))return value.map(stripPaths);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k,v])=>k!=='evidence_dir'&&!(k==='path'&&typeof v==='string'&&path.isAbsolute(v))).map(([k,v])=>[k,stripPaths(v)]));return value;}
function inputPolicy(input){return Object.fromEntries(['mode','entries','query','confirmed','duration_ms','permission_mode'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));}
module.exports={MissionWeb};
