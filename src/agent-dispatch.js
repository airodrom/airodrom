'use strict';
const {randomUUID}=require('node:crypto');
const {transaction,afterCommit}=require('./control-transaction');
const {object,identifier,fingerprint,text}=require('./control-plane-store');
const {workspaceSnapshot}=require('./control-context');
const {classifyCodexDispatchOutcome}=require('./transport-outcome');
const FINAL=new Set(['fallback_selected','completed_transport','cancel_requested','termination_unverified','failed']);
const UNCERTAIN=new Set(['dispatching','accepted','running_unknown','completion_waiting']);
function dispatchPolicy(input={}){
 object(input,['max_attempts','initial_backoff_ms','max_backoff_ms','cooldown_ms','fallback_after_attempts','task_category','privacy','billing_classes','providers','max_changed_files','native_actions']);
 const p={max_attempts:3,initial_backoff_ms:30000,max_backoff_ms:300000,cooldown_ms:120000,fallback_after_attempts:3,task_category:'focused_coding',privacy:'unspecified',billing_classes:[],providers:[],max_changed_files:10,native_actions:[],...input};
 for(const [k,min,max]of [['max_attempts',1,3],['initial_backoff_ms',30000,300000],['max_backoff_ms',30000,3600000],['cooldown_ms',30000,3600000],['fallback_after_attempts',1,3],['max_changed_files',1,40]])if(!Number.isInteger(p[k])||p[k]<min||p[k]>max)throw Error('Invalid dispatch policy bound');
 if(p.fallback_after_attempts>p.max_attempts)p.fallback_after_attempts=p.max_attempts;
 if(p.max_backoff_ms<p.initial_backoff_ms||!['focused_coding','large_coding','research','deterministic_files'].includes(p.task_category)||!['unspecified','local_only','cloud_allowed'].includes(p.privacy))throw Error('Invalid dispatch policy');
 for(const [key,allowed]of [['billing_classes',['local','subscription']],['providers',['local','anthropic_subscription','codex_openai']]])if(!Array.isArray(p[key])||p[key].length>3||p[key].some(v=>!allowed.includes(v)))throw Error('Invalid fallback policy');
 if(!Array.isArray(p.native_actions)||p.native_actions.length>10)throw Error('Invalid native action plan');
 for(const a of p.native_actions){object(a,['name','path','content']);if(a.name!=='file_write'||typeof a.path!=='string'||!a.path||a.path.split(/[\\/]/).some(s=>!s||s==='.'||s==='..')||typeof a.content!=='string'||Buffer.byteLength(a.content)>12000)throw Error('Invalid deterministic file action');if(a.content)text(a.content,'native action content',12000);}
 return p;
}
class AgentDispatch {
 constructor(bridge,{now=Date.now,transport=null}={}){
  if(transport&&!(process.env.NODE_ENV==='test'&&bridge.options.allowFixtureWorker))throw Error('Only an isolated injected transport is supported');
  this.bridge=bridge;this.store=bridge.controlStore;this.db=this.store.db;this.now=now;this.transport=transport;this.busy=false;
  this.db.exec(`CREATE TABLE IF NOT EXISTS cp_agent_dispatch_intents(dispatch_id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,mission_id TEXT NOT NULL,status TEXT NOT NULL,next_attempt_at INTEGER,record TEXT NOT NULL,updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS cp_agent_dispatch_attempts(attempt_id TEXT PRIMARY KEY,dispatch_id TEXT NOT NULL,ordinal INTEGER NOT NULL,outcome TEXT,UNIQUE(dispatch_id,ordinal),FOREIGN KEY(dispatch_id) REFERENCES cp_agent_dispatch_intents(dispatch_id));
   CREATE TABLE IF NOT EXISTS cp_agent_circuits(agent_id TEXT PRIMARY KEY,state TEXT NOT NULL,failures INTEGER NOT NULL,open_until INTEGER,probe_dispatch_id TEXT,updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS cp_agent_availability(agent_id TEXT PRIMARY KEY,state TEXT NOT NULL,observed_at INTEGER NOT NULL);
   INSERT OR IGNORE INTO cp_agent_availability VALUES('codex','unknown',0);
   INSERT OR IGNORE INTO cp_agent_circuits VALUES('codex','closed',0,NULL,NULL,0);`);
 }
 principal(actor){if(!['operator','mcp','fixture_transport'].includes(actor)||actor==='fixture_transport'&&!this.transport)throw Error('Trusted transport reporter required');}
 assertReadable(){require('./memory-content-erasure').assertReadable(this.db);}
 get(id){this.assertReadable();identifier(id);const r=this.db.prepare('SELECT record FROM cp_agent_dispatch_intents WHERE dispatch_id=? OR run_id=?').get(id,id);if(!r)throw Error('Dispatch intent not found');return JSON.parse(r.record);}
 list({mission_id=null,run_id=null}={}){this.assertReadable();for(const id of [mission_id,run_id])if(id!==null)identifier(id);return this.db.prepare('SELECT record FROM cp_agent_dispatch_intents WHERE (? IS NULL OR mission_id=?) AND (? IS NULL OR run_id=?) ORDER BY updated_at DESC LIMIT 100').all(mission_id,mission_id,run_id,run_id).map(r=>JSON.parse(r.record));}
 save(r){this.assertReadable();r.updated_at=this.now();this.db.prepare('UPDATE cp_agent_dispatch_intents SET status=?,next_attempt_at=?,record=?,updated_at=? WHERE dispatch_id=?').run(r.status,r.next_attempt_at,JSON.stringify(r),r.updated_at,r.dispatch_id);return r;}
 event(type,r,metadata={}){this.store.event(`agent.dispatch.${type}`,r.mission_id,{dispatch_id:r.dispatch_id,agent_id:'codex',...metadata},{runId:r.run_id});}
 register(contract){
  this.assertReadable();
  const old=this.db.prepare('SELECT record FROM cp_agent_dispatch_intents WHERE run_id=?').get(contract.run_id);if(old)return JSON.parse(old.record);
  const m=this.store.requireMission(contract.mission_id),p=dispatchPolicy(m.envelope.dispatch_policy||{}),now=this.now();
  const r={dispatch_id:randomUUID(),project_id:m.project_id,goal_id:m.goal_id,mission_id:m.id,task_id:contract.task_id,run_id:contract.run_id,request_id:contract.request_id,agent_id:'codex',transport:'handoff',workspace_ref:m.envelope.workspace,objective_ref:m.id,policy_ref:randomUUID(),policy_hash:fingerprint({version:2,envelope:m.envelope,ceiling:m.ceiling}),selected_reason:m.envelope.route_mode==='automatic'?'automatic_task_taxonomy':'preferred_explicit_handoff',selected_agent:'codex',selected_provider:'codex_openai',rejected_candidates:[],fallback_policy:p,fallback_agents:[...m.envelope.fallback_agents],status:'dispatch_pending_external',attempt_count:0,max_attempts:p.max_attempts,first_attempt_at:null,last_attempt_at:null,next_attempt_at:now,transport_receipt_ref:null,failure_class:null,safe_failure_reason:null,idempotency_key:fingerprint([m.id,contract.task_id,contract.run_id,'codex_handoff']),no_side_effects:true,active_attempt_id:null,selected_fallback:null,fallback_dispatch_id:null,wait_reason:'external_transport_required',created_at:now,updated_at:now};
  this.db.prepare('INSERT INTO cp_agent_dispatch_intents VALUES(?,?,?,?,?,?,?)').run(r.dispatch_id,r.run_id,m.id,r.status,r.next_attempt_at,JSON.stringify(r),now);return r;
 }
 circuit(){return this.db.prepare("SELECT * FROM cp_agent_circuits WHERE agent_id='codex'").get();}
 availability(){const c=this.circuit();const active=this.db.prepare("SELECT 1 FROM cp_agent_dispatch_intents i JOIN cp_runs r ON r.id=i.run_id WHERE i.status IN ('dispatching','accepted','running_unknown','completion_waiting','cancel_requested','termination_unverified') AND r.termination_verified=0 LIMIT 1").get();const last=this.list()[0],observed=this.db.prepare("SELECT state,observed_at FROM cp_agent_availability WHERE agent_id='codex'").get();return{adapter_implemented:true,transport:'handoff',native_dispatch:false,automatic_transport:!!this.transport,availability:active?'busy':['auth_required','quota_limited'].includes(observed.state)?observed.state:c.state==='open'&&c.open_until>this.now()?'unavailable':['auth_required','quota_limited'].includes(last?.failure_class)?last.failure_class:observed.state,circuit:c,observation:observed,external_cycle_required:!this.transport,last_safe_error_class:last?.failure_class||null,active_status:active?this.list().find(r=>UNCERTAIN.has(r.status)||['cancel_requested','termination_unverified'].includes(r.status))?.status||null:null};}
 observeAvailability(input,actor='operator'){
  if(actor!=='operator')throw Error('Operator availability observation required');object(input,['state']);
  if(!['available','busy','unavailable','auth_required','quota_limited','unknown'].includes(input.state))throw Error('Unknown agent availability');
  return transaction(this.db,()=>{
   this.db.prepare("UPDATE cp_agent_availability SET state=?,observed_at=? WHERE agent_id='codex'").run(input.state,this.now());
   if(input.state==='available'){
    this.db.prepare("UPDATE cp_agent_circuits SET state='open',open_until=?,probe_dispatch_id=NULL,updated_at=? WHERE agent_id='codex'").run(this.now(),this.now());
    for(const r of this.list())if(r.no_side_effects&&r.status==='waiting'&&r.attempt_count<r.max_attempts){r.failure_class=null;r.status='retry_wait';r.next_attempt_at=this.now()+r.fallback_policy.initial_backoff_ms;r.wait_reason='observed_availability_backoff';this.save(r);}
   }
   afterCommit(this.db,()=>this.schedule());return this.availability();
  });
 }
 views(filters={}){return this.list(filters).map(r=>{
  const child=r.fallback_dispatch_id?this.db.prepare('SELECT run_id,state FROM cp_dispatches WHERE id=?').get(r.fallback_dispatch_id):null,run=child?.run_id||r.run_id;
  return{...r,circuit:this.circuit(),fallback_run:child||null,relay:this.db.prepare('SELECT state,error_class FROM cp_codex_relay WHERE run_id=?').get(r.run_id)||null,result:this.bridge.resultInbox.latest({run}),verification:this.db.prepare('SELECT id,result FROM cp_verifications WHERE run_id=?').all(run),acceptance:this.db.prepare('SELECT id,decision FROM cp_acceptances WHERE mission_id=?').all(r.mission_id)};
 });}
 transportBusy(r){return !!this.db.prepare("SELECT 1 FROM cp_agent_dispatch_intents i JOIN cp_runs x ON x.id=i.run_id WHERE i.dispatch_id<>? AND i.status IN ('dispatching','accepted','running_unknown','completion_waiting','cancel_requested','termination_unverified') AND x.termination_verified=0 LIMIT 1").get(r.dispatch_id);}
 guard(r,{lease=true}={}){
  this.assertReadable();
  const ownLease=this.db.prepare("SELECT state,expires_at FROM cp_leases WHERE run_id=? AND state IN ('held','quarantined')").get(r.run_id);if(ownLease&&(ownLease.state==='quarantined'||ownLease.expires_at<=this.store.now()))return'unverified_workspace_lease';
  const m=this.store.requireMission(r.mission_id);if(['completed','cancelled','needs_rework','awaiting_acceptance','verifying'].includes(m.state))return'mission_not_dispatchable';
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(r.policy_ref||'')||fingerprint({version:2,envelope:m.envelope,ceiling:m.ceiling})!==r.policy_hash)return'immutable_policy_changed';
  const p=this.bridge.projects.getProject(m.project_id);if(p.status!=='active')return'project_inactive';
  if(this.bridge.tasks.get(r.task_id).safetyStop?.latched)return'safety_stop';
  if(this.store.decisions(m.id).some(d=>d.state==='waiting_for_operator'))return'waiting_decision';
  if(this.bridge.policy.list().some(a=>a.status==='pending'&&this.store.missionForTask(a.taskId)?.id===m.id))return'protected_approval_required';
  const chains=this.db.prepare('SELECT c.* FROM cp_autonomy_claims a JOIN cp_autonomy_chains c ON c.id=a.chain_id WHERE a.mission_id=?').all(m.id);if(chains.some(c=>c.state!=='active'||this.now()-c.started_at>=c.max_runtime_ms))return'autonomy_paused_or_expired';
  if(this.db.prepare("SELECT 1 FROM project_dependencies d LEFT JOIN project_missions p ON d.depends_on_type='mission' AND p.mission_id=d.depends_on_id WHERE d.owner_id=? AND d.status='active' AND (d.depends_on_type<>'mission' OR p.status<>'completed')").get(m.id))return'dependency';
  if(lease&&this.db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND mode='write' AND state IN ('held','quarantined') AND run_id<>?").get(r.workspace_ref,r.run_id))return'workspace_writer';
  if(this.bridge.resultInbox.latest({run:r.run_id}))return'completion_evidence_present';
  if(this.bridge.codexAdapter.getTask(r.run_id).memory_context_revoked)return'memory_context_revoked';
  if(!['awaiting_handoff'].includes(this.bridge.codexAdapter.getTask(r.run_id).state))return'handoff_not_dispatchable';
  return null;
 }
 wait(r,reason,next=null){if(reason==='unverified_workspace_lease'){r.no_side_effects=false;r.status='running_unknown';r.wait_reason=reason;r.next_attempt_at=null;this.save(r);return{state:'WAIT',...r};}if(r.no_side_effects)this.releaseUnstarted(r);const changed=r.status!=='waiting'||r.wait_reason!==reason;r.status='waiting';r.wait_reason=reason;r.next_attempt_at=next;this.save(r);if(changed)this.event('waiting',r,{reason});return{state:'WAIT',...r};}
 releaseUnstarted(r){const run=this.store.run(r.run_id);if(!r.no_side_effects||run.process_state!=='not_started')throw Error('Unknown transport cannot release writer');this.db.prepare("UPDATE cp_leases SET state='released' WHERE run_id=? AND state IN ('held','quarantined')").run(r.run_id);}
 claim(input,actor='operator'){
  this.principal(actor);this.assertReadable();object(input,['dispatch_id']);return transaction(this.db,()=>{
   const r=this.get(input.dispatch_id);if(UNCERTAIN.has(r.status)||FINAL.has(r.status)||!r.no_side_effects)return{state:'existing_dispatch',dispatch:r};
   if(r.status!=='dispatch_pending_external'||r.next_attempt_at>this.now())return{state:'WAIT',dispatch:r};
   const reason=this.guard(r);if(reason)return this.wait(r,reason);
   if(this.transportBusy(r))return this.wait(r,'codex_transport_busy');
   const observed=this.db.prepare("SELECT state FROM cp_agent_availability WHERE agent_id='codex'").get();if(['auth_required','quota_limited','busy','unavailable'].includes(observed.state))return this.wait(r,observed.state);
   const c=this.circuit();if(c.state==='open'&&c.open_until>this.now())return this.wait(r,'circuit_open',c.open_until);
   if(c.state==='half_open'&&c.probe_dispatch_id!==r.dispatch_id)return this.wait(r,'half_open_probe_active');
   if(c.state==='open')this.db.prepare("UPDATE cp_agent_circuits SET state='half_open',probe_dispatch_id=?,updated_at=? WHERE agent_id='codex'").run(r.dispatch_id,this.now());
   if(r.attempt_count>=r.max_attempts)return this.wait(r,'attempt_budget_exhausted');
   const m=this.store.getMission(r.mission_id),snapshot=workspaceSnapshot(r.workspace_ref);
   if(snapshot.hash!==m.envelope.baseline.hash)return this.wait(r,'workspace_changed_before_dispatch');
   if(!this.db.prepare("SELECT 1 FROM cp_leases WHERE run_id=? AND state='held'").get(r.run_id))this.store.acquireLease({resource:r.workspace_ref,runId:r.run_id,missionId:r.mission_id,baseline:m.envelope.baseline});
   this.store.updateRun(r.run_id,{state:'waiting_for_operator',processState:'unknown',resolution:'awaiting_transport_receipt'});
   const attempt=randomUUID();r.status='dispatching';r.attempt_count++;r.first_attempt_at??=this.now();r.last_attempt_at=this.now();r.next_attempt_at=null;r.active_attempt_id=attempt;r.no_side_effects=false;r.wait_reason=null;
   this.db.prepare('INSERT INTO cp_agent_dispatch_attempts VALUES(?,?,?,NULL)').run(attempt,r.dispatch_id,r.attempt_count);this.save(r);this.event('requested',r,{attempt:r.attempt_count});
   return{state:'dispatching',dispatch_id:r.dispatch_id,attempt_id:attempt,idempotency_key:r.idempotency_key,contract:this.bridge.codexAdapter.getTask(r.run_id).contract};
  });
 }
 report(input,actor='operator'){
  this.principal(actor);this.assertReadable();object(input,['dispatch_id','attempt_id','outcome']);const outcome=classifyCodexDispatchOutcome(input.outcome);
  return transaction(this.db,()=>{
   const r=this.get(input.dispatch_id),attempt=this.db.prepare('SELECT * FROM cp_agent_dispatch_attempts WHERE attempt_id=? AND dispatch_id=?').get(identifier(input.attempt_id),r.dispatch_id);
   if(!attempt)throw Error('Unknown dispatch attempt');
   if(attempt.outcome){if(fingerprint(JSON.parse(attempt.outcome))!==fingerprint(outcome))throw Error('Immutable transport outcome conflict');return{...r,duplicate:true};}
   if(r.active_attempt_id!==attempt.attempt_id||!['dispatching','running_unknown'].includes(r.status))throw Error('Stale dispatch attempt');
   this.db.prepare('UPDATE cp_agent_dispatch_attempts SET outcome=? WHERE attempt_id=?').run(JSON.stringify(outcome),attempt.attempt_id);
   r.last_outcome=outcome;r.transport_receipt_ref=outcome.receipt;r.no_side_effects=outcome.no_side_effects;r.failure_class=outcome.classification==='accepted'?null:outcome.classification;r.safe_failure_reason=outcome.safe_failure_reason;r.reason_known=outcome.reason_known;
   if(outcome.classification==='accepted'){
    this.db.prepare("UPDATE cp_agent_availability SET state='available',observed_at=? WHERE agent_id='codex'").run(this.now());
    r.status='accepted';r.wait_reason=null;this.save(r);this.event('accepted',r,{receipt:outcome.receipt});
    const c=this.circuit();if(c.state!=='closed')this.event('circuit_closed',r);this.db.prepare("UPDATE cp_agent_circuits SET state='closed',failures=0,open_until=NULL,probe_dispatch_id=NULL,updated_at=? WHERE agent_id='codex'").run(this.now());
   }else if(!outcome.no_side_effects){r.status='running_unknown';r.wait_reason='reconcile_unknown_outcome';this.save(r);this.event('waiting',r,{reason:r.wait_reason});}
   else{
    if(['auth_required','quota_limited'].includes(outcome.classification))this.db.prepare("UPDATE cp_agent_availability SET state=?,observed_at=? WHERE agent_id='codex'").run(outcome.classification,this.now());
    this.db.prepare("UPDATE cp_runs SET state='waiting_for_operator' WHERE id=? AND state='interrupted'").run(r.run_id);
    this.store.updateRun(r.run_id,{state:'waiting_for_operator',processState:'not_started',verified:true,resolution:'transport_refused_before_execution'});
    this.releaseUnstarted(r);this.event('rejected',r,{classification:outcome.classification,reason_known:outcome.reason_known});
    const breaker=['rejected_by_transport','busy','temporarily_unavailable','quota_limited','auth_required'].includes(outcome.classification),c=this.circuit();
    if(breaker){const failures=c.failures+1,open=failures>=3||c.state==='half_open'||['auth_required','quota_limited'].includes(outcome.classification);this.db.prepare("UPDATE cp_agent_circuits SET state=?,failures=?,open_until=?,probe_dispatch_id=NULL,updated_at=? WHERE agent_id='codex'").run(open?'open':'closed',failures,open?this.now()+r.fallback_policy.cooldown_ms:null,this.now());if(open&&c.state!=='open')this.event('circuit_open',r,{reason:outcome.classification});}
    if(['invalid_request','policy_denied'].includes(outcome.classification)){r.status='failed';r.wait_reason=outcome.classification;r.next_attempt_at=null;this.save(r);}
    else if(outcome.retryable&&r.attempt_count<r.max_attempts){r.status='retry_wait';r.next_attempt_at=this.now()+Math.min(r.fallback_policy.max_backoff_ms,r.fallback_policy.initial_backoff_ms*2**(r.attempt_count-1));r.wait_reason='bounded_backoff';this.save(r);this.event('retry_scheduled',r,{next_attempt_at:r.next_attempt_at});}
    else this.wait(r,outcome.classification==='auth_required'?'auth_required':outcome.classification==='quota_limited'?'quota_limited':'attempt_budget_exhausted');
   }
   afterCommit(this.db,()=>this.schedule());return this.get(r.dispatch_id);
  });
 }
 onCompletion(runId){const row=this.db.prepare('SELECT dispatch_id FROM cp_agent_dispatch_intents WHERE run_id=?').get(runId);if(!row)return;const r=this.get(row.dispatch_id);if(r.selected_fallback)throw Error('Late Codex result after fallback');r.status='completion_waiting';r.no_side_effects=false;r.wait_reason='termination_reconciliation_required';r.next_attempt_at=null;this.save(r);}
 onSettled(runId){const row=this.db.prepare('SELECT dispatch_id FROM cp_agent_dispatch_intents WHERE run_id=?').get(runId);if(row){const r=this.get(row.dispatch_id);r.status='completed_transport';r.next_attempt_at=null;this.save(r);const c=this.circuit();if(c.state==='half_open'&&c.probe_dispatch_id===r.dispatch_id)this.db.prepare("UPDATE cp_agent_circuits SET state='open',probe_dispatch_id=NULL,open_until=?,updated_at=? WHERE agent_id='codex'").run(this.now()+r.fallback_policy.cooldown_ms,this.now());}}
 onCancel(runId){const row=this.db.prepare('SELECT dispatch_id FROM cp_agent_dispatch_intents WHERE run_id=?').get(runId);if(row){const r=this.get(row.dispatch_id);r.status='cancel_requested';r.next_attempt_at=null;r.wait_reason='termination_reconciliation_required';this.save(r);}}
 fallbackChoice(r,observations){
  const p=r.fallback_policy,m=this.store.getMission(r.mission_id),project=this.bridge.projects.getProject(m.project_id);
  if(!r.no_side_effects)return{selected:null,reason:'reconcile_unknown_outcome'};
  if(project.privacyPolicy||project.costPolicy)return{selected:null,reason:'project_policy_requires_review'};
  if(m.envelope.allowed_files.length>p.max_changed_files)return{selected:null,reason:'edit_breadth'};
  if(['research','large_coding'].includes(p.task_category))return{selected:null,reason:'semantic_fallback_unproven'};
  const skipped=[];
  for(const agent of r.fallback_agents){let reason=null;const a=observations[agent];
   if(!a||a.available!==true)reason='agent_unavailable';
   else if(agent==='claude_code'){
    if(p.privacy!=='cloud_allowed')reason='privacy_policy';else if(!p.providers.includes('anthropic_subscription')||!p.billing_classes.includes('subscription'))reason='cost_or_provider_policy';else if(!a.capabilities?.includes('coding')||a.auth_mode!=='subscription')reason='semantic_or_billing_mismatch';
   }else if(agent==='host'){
    if(p.task_category!=='deterministic_files'||!p.native_actions.length)reason='native_plan_required';else if(!p.providers.includes('local')||!p.billing_classes.includes('local'))reason='cost_or_provider_policy';else if(p.native_actions.some(a=>!m.envelope.allowed_files.includes(a.path)))reason='action_outside_scope';
   }else reason='fallback_adapter_unimplemented';
   if(!reason)return{selected:agent,reason:'immutable_compatible_fallback',skipped};skipped.push({agent,reason});
  }
  return{selected:null,reason:skipped[0]?.reason||'no_compatible_fallback',skipped};
 }
 selectFallback(r,choice){return transaction(this.db,()=>{
  r=this.get(r.dispatch_id);if(!r.no_side_effects||UNCERTAIN.has(r.status)||FINAL.has(r.status))return;
  const reason=this.guard(r);if(reason)return this.wait(r,reason);
  const observations=Object.fromEntries(this.store.agents().map(a=>[a.id,a.observation]));if(this.fallbackChoice(r,observations).selected!==choice.selected)return this.wait(r,'fallback_observation_changed');
  const m=this.store.getMission(r.mission_id);if(workspaceSnapshot(r.workspace_ref).hash!==m.envelope.baseline.hash)return this.wait(r,'workspace_changed_before_fallback');
  this.releaseUnstarted(r);this.store.updateRun(r.run_id,{state:'cancelled',processState:'not_started',verified:true,resolution:'transport_refused_before_execution'});
  this.db.prepare("UPDATE cp_codex_handoffs SET state='settled',updated_at=? WHERE run_id=?").run(this.now(),r.run_id);
  r.selected_fallback=choice.selected;r.status='fallback_pending';r.next_attempt_at=null;this.save(r);
  this.db.prepare("UPDATE cp_dispatches SET state='completed',updated_at=? WHERE run_id=? AND state='running'").run(this.now(),r.run_id);
  const parent=this.store.getMission(r.mission_id);if(parent.state==='dispatching'){this.store.state(parent.id,'blocked','Refused automatic handoff before execution');}
  const queued=this.bridge.missions.queue(r.mission_id);r.status='fallback_selected';r.fallback_dispatch_id=queued.dispatch_id;r.wait_reason=null;this.save(r);this.event('fallback_selected',r,{selected_agent:choice.selected,reason:choice.reason});afterCommit(this.db,()=>this.bridge.missions.schedule());return r;
 });}
 fallbackFor(dispatchId){this.assertReadable();const row=this.db.prepare("SELECT record FROM cp_agent_dispatch_intents WHERE json_extract(record,'$.fallback_dispatch_id')=? AND status='fallback_selected'").get(dispatchId);return row?JSON.parse(row.record):null;}
 schedule(){if(this.pending)return;this.pending=true;queueMicrotask(()=>{this.pending=false;this.reconcile().catch(()=>{});});}
 async reconcile(){if(this.busy||this.bridge.closed)return;this.assertReadable();this.busy=true;
  try{for(const {record} of this.db.prepare("SELECT record FROM cp_agent_dispatch_intents WHERE status IN ('dispatch_pending_external','retry_wait','waiting','dispatching') ORDER BY updated_at LIMIT 50").all()){const item=JSON.parse(record);
   let r=this.get(item.dispatch_id);if(FINAL.has(r.status))continue;
   if(UNCERTAIN.has(r.status)){
    if(r.status==='dispatching'&&this.now()-r.last_attempt_at>=120000)transaction(this.db,()=>{r=this.get(r.dispatch_id);if(r.status==='dispatching'){r.status='running_unknown';r.wait_reason='transport_receipt_missing';this.save(r);this.event('waiting',r,{reason:r.wait_reason});}});continue;
   }
   const reason=this.guard(r);if(reason){transaction(this.db,()=>this.wait(r,reason));continue;}
   const transportBusy=this.transportBusy(r);const circuit=this.circuit(),open=circuit.state==='open'&&circuit.open_until>this.now(),currentAvailability=this.db.prepare("SELECT state FROM cp_agent_availability WHERE agent_id='codex'").get().state;
   if(r.no_side_effects&&(r.attempt_count>=r.fallback_policy.fallback_after_attempts||open||transportBusy||['busy','unavailable','auth_required','quota_limited'].includes(currentAvailability)||['auth_required','quota_limited'].includes(r.failure_class))){
    const observations=await this.bridge.missions.agents.refresh();const choice=this.fallbackChoice(this.get(r.dispatch_id),observations);
    if(choice.selected){this.selectFallback(r,choice);continue;}
    if(r.attempt_count>=r.max_attempts||['auth_required','quota_limited'].includes(r.failure_class)){transaction(this.db,()=>this.wait(this.get(r.dispatch_id),choice.reason));continue;}
   }
   r=this.get(r.dispatch_id);if(transportBusy){transaction(this.db,()=>this.wait(r,'codex_transport_busy'));continue;}const observed=this.db.prepare("SELECT state FROM cp_agent_availability WHERE agent_id='codex'").get();if(['auth_required','quota_limited','busy','unavailable'].includes(observed.state)){transaction(this.db,()=>this.wait(r,observed.state));continue;}if(open){transaction(this.db,()=>this.wait(r,'circuit_open',circuit.open_until));continue;}
   if(r.status==='retry_wait'&&r.next_attempt_at>this.now())continue;
   if(r.attempt_count>=r.max_attempts){transaction(this.db,()=>this.wait(r,'attempt_budget_exhausted'));continue;}
   if(r.status!=='dispatch_pending_external')transaction(this.db,()=>{r=this.get(r.dispatch_id);r.status='dispatch_pending_external';r.wait_reason='external_transport_required';r.next_attempt_at=this.now();this.save(r);});
   if(this.transport){const claim=this.claim({dispatch_id:r.dispatch_id},'fixture_transport');if(claim.state==='dispatching'){let result;try{result=await this.transport(claim);}catch{result={};}this.report({dispatch_id:r.dispatch_id,attempt_id:claim.attempt_id,outcome:result},'fixture_transport');}}
  }}finally{this.busy=false;}
 }
 recover(){transaction(this.db,()=>{for(const r of this.list()){
  if(FINAL.has(r.status))continue;const run=this.store.run(r.run_id);
  if(['completed','failed','cancelled'].includes(run.state)&&run.termination_verified){r.status='completed_transport';r.next_attempt_at=null;this.save(r);continue;}
  if(r.status==='dispatching'||r.no_side_effects&&run.process_state!=='not_started'){
   r.status='running_unknown';r.no_side_effects=false;r.wait_reason='restart_requires_reconciliation';r.next_attempt_at=null;this.save(r);this.event('waiting',r,{reason:r.wait_reason});
  }
 }});this.schedule();}

}
module.exports={AgentDispatch,dispatchPolicy,UNCERTAIN};
