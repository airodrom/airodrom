'use strict';
const {randomUUID}=require('node:crypto');
const {transaction}=require('./control-transaction');
const {identifier,fingerprint,object}=require('./control-plane-store');
// Opt-in execution consumes an explicit immutable list. Suggestions confer no authority.
class BoundedNextAction {
 constructor(bridge,{enabled=false,now=Date.now}={}){
  this.bridge=bridge;this.store=bridge.controlStore;this.db=this.store.db;this.enabled=enabled===true;this.now=now;
  this.db.exec(`CREATE TABLE IF NOT EXISTS cp_autonomy_chains(id TEXT PRIMARY KEY,mode TEXT NOT NULL,plan TEXT NOT NULL,started_at INTEGER NOT NULL,max_runtime_ms INTEGER NOT NULL,max_missions INTEGER NOT NULL,max_failures INTEGER NOT NULL,state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cp_autonomy_claims(chain_id TEXT NOT NULL,mission_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,PRIMARY KEY(chain_id,mission_id));`);
 }
 register(input){
  object(input,['id','mode','mission_ids','max_missions','max_runtime_ms','max_failures']);identifier(input.id);
  if(!['observe','suggest','auto_safe','auto_development','paused'].includes(input.mode))throw Error('Unknown autonomy mode');
  if(!Array.isArray(input.mission_ids)||!input.mission_ids.length||input.mission_ids.length>10||new Set(input.mission_ids).size!==input.mission_ids.length)throw Error('Explicit unique Mission list required');
  const max=input.max_missions??2,runtime=input.max_runtime_ms??120000,failures=input.max_failures??1;
  if(!Number.isInteger(max)||max<1||max>10||!Number.isInteger(runtime)||runtime<1||runtime>1800000||!Number.isInteger(failures)||failures<1||failures>3)throw Error('Invalid autonomy budget');
  const plan=input.mission_ids.map(id=>{const m=this.store.requireMission(identifier(id));if(m.envelope.control_version!==2)throw Error('Only typed durable Missions can execute');return{id,hash:fingerprint(m.envelope)};});
  return transaction(this.db,()=>{const old=this.db.prepare('SELECT * FROM cp_autonomy_chains WHERE id=?').get(input.id);const encoded=JSON.stringify(plan);if(old){if(old.plan!==encoded||old.mode!==input.mode||old.max_missions!==max||old.max_runtime_ms!==runtime||old.max_failures!==failures)throw Error('Immutable autonomy plan conflict');return{id:input.id,duplicate:true};}
   this.db.prepare('INSERT INTO cp_autonomy_chains VALUES(?,?,?,?,?,?,?,?)').run(input.id,input.mode,encoded,this.now(),runtime,max,failures,'active');this.store.event('autonomy.chain.registered',null,{chain_id:input.id,mode:input.mode,max_missions:max});return{id:input.id,duplicate:false};});
 }
 inspect(id){identifier(id);const chain=this.db.prepare('SELECT * FROM cp_autonomy_chains WHERE id=?').get(id);if(!chain)throw Error('Autonomy chain not found');
  const claims=this.db.prepare('SELECT * FROM cp_autonomy_claims WHERE chain_id=?').all(id);return{...chain,plan:JSON.parse(chain.plan),claims,execution_enabled:this.enabled};
 }
 pause(id,reason='operator_pause'){identifier(id);return transaction(this.db,()=>{if(!this.db.prepare("UPDATE cp_autonomy_chains SET state='paused' WHERE id=?").run(id).changes)throw Error('Autonomy chain not found');this.store.event('autonomy.paused',null,{chain_id:id,reason});return this.inspect(id);});}
 resume(id){identifier(id);this.db.prepare("UPDATE cp_autonomy_chains SET state='active' WHERE id=? AND state='paused'").run(id);this.store.event('autonomy.resumed',null,{chain_id:id});this.bridge.missions.schedule();return this.inspect(id);}
 eligibility(chain){
  if(chain.state!=='active'||chain.mode==='paused')return{state:'waiting',reason:'paused'};
  if(this.now()-chain.started_at>=chain.max_runtime_ms)return{state:'pause',reason:'runtime_budget'};
  let completed=0,failures=0;
  for(const step of chain.plan){const m=this.store.getMission(step.id);if(!m||fingerprint(m.envelope)!==step.hash)return{state:'pause',reason:'immutable_scope_changed'};
   const claim=chain.claims.find(c=>c.mission_id===m.id);
   if(claim&&['needs_rework','blocked','cancelled'].includes(m.state))failures++;
   if(failures>=chain.max_failures)return{state:'pause',reason:'failure_budget'};
   if(m.state==='completed'){
    if(!this.db.prepare("SELECT 1 FROM cp_acceptances a JOIN cp_verifications v ON a.verification_id=v.id WHERE a.mission_id=? AND a.decision='accept' AND v.result IN ('passed','operator_review')").get(m.id))return{state:'waiting',reason:'acceptance_missing'};
    const acceptedRun=this.db.prepare("SELECT v.run_id FROM cp_acceptances a JOIN cp_verifications v ON a.verification_id=v.id WHERE a.mission_id=? AND a.decision='accept' ORDER BY a.created_at DESC LIMIT 1").get(m.id);
    if(!require('./execution-evidence').runSatisfied(this.store.run(acceptedRun.run_id)))return{state:'pause',reason:'native_tool_required'};
    completed++;continue;
   }
   if(chain.claims.length>=chain.max_missions&&!claim)return{state:'pause',reason:'mission_budget'};
   if(claim){const dispatch=this.bridge.agentDispatch?.list({mission_id:m.id})[0];return{state:'waiting',reason:dispatch?.wait_reason||'claimed_mission_requires_settlement',agent_dispatch:dispatch?{dispatch_id:dispatch.dispatch_id,status:dispatch.status,next_attempt_at:dispatch.next_attempt_at,selected_fallback:dispatch.selected_fallback}:null};}
   const project=this.bridge.projects.getProject(m.project_id);
   if(project.status!=='active')return{state:'waiting',reason:'project_inactive'};
   if(this.enabled&&chain.mode==='auto_development'&&project.autonomyLevel!=='auto_development')return{state:'waiting',reason:'project_automation_mode'};
   if(this.enabled&&chain.mode==='auto_development'&&(project.privacyPolicy||project.costPolicy))return{state:'waiting',reason:'project_policy_requires_review'};
   const task=this.bridge.tasks.get(m.task_id);if(task.safetyStop?.latched)return{state:'waiting',reason:'safety_stop'};
   if(m.state!=='ready')return{state:'waiting',reason:m.state};
   const decisions=this.store.decisions(m.id);if(decisions.some(d=>d.state==='waiting_for_operator'))return{state:'waiting',reason:'waiting_decision'};
   if(this.bridge.policy.list().some(a=>a.status==='pending'&&this.store.missionForTask(a.taskId)?.id===m.id))return{state:'waiting',reason:'protected_approval_required'};
   if(this.db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND mode='write' AND state IN ('held','quarantined')").get(m.envelope.workspace))return{state:'waiting',reason:'workspace_writer'};
   if(this.db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state IN ('queued','dispatching','running','unknown')").get(m.id))return{state:'waiting',reason:'unreconciled_dispatch'};
   const dependency=this.db.prepare("SELECT 1 FROM project_dependencies d LEFT JOIN project_missions p ON d.depends_on_type='mission' AND p.mission_id=d.depends_on_id WHERE d.owner_id=? AND d.status='active' AND (d.depends_on_type<>'mission' OR p.status<>'completed')").get(m.id);
   if(dependency)return{state:'waiting',reason:'dependency'};
   if(chain.mode==='auto_safe')return{state:'waiting',reason:'coding_requires_auto_development'};
   return{state:'candidate',mission_id:m.id,completed};
  }
  return{state:'pause',reason:'chain_complete'};
 }
 async reconcile(){if(this.reconciling||this.bridge.closed)return;this.reconciling=true;try{this.bridge.fixtureAcceptance?.reconcile();for(const row of this.db.prepare("SELECT id FROM cp_autonomy_chains WHERE state='active' ORDER BY started_at").all())await this.tick(row.id);}finally{this.reconciling=false;}}
 async tick(id){
  if(this.busy)return{state:'waiting',reason:'busy'};this.busy=true;
  try{const chain=this.inspect(id),choice=this.eligibility(chain);
   if(choice.state==='pause'){if(choice.reason==='failure_budget')for(const step of chain.plan){const m=this.store.getMission(step.id);if(m)this.bridge.projects.updateProject(m.project_id,{autonomyLevel:'observe'});}
    this.pause(id,choice.reason);return{state:'paused',reason:choice.reason};}
   if(choice.state!=='candidate')return choice;
   if(!this.enabled||['observe','suggest'].includes(chain.mode))return{...choice,state:'suggested',execution:'not_dispatched'};
   const mission=this.store.getMission(choice.mission_id),route=await this.bridge.missions.agents.select(mission.envelope);
   if(!route.selected)return{state:'waiting',reason:'agent_unavailable',route};
   // Every async availability observation is followed by a fresh transactional gate.
   return transaction(this.db,()=>{const current=this.inspect(id),fresh=this.eligibility(current);if(fresh.state!=='candidate'||fresh.mission_id!==mission.id)return fresh;
    const request=`autonomy:${randomUUID()}`;this.db.prepare("INSERT INTO cp_autonomy_claims VALUES(?,?,?,'claimed')").run(id,mission.id,request);
    this.store.event('autonomy.dispatch.selected',mission.id,{chain_id:id,route,request_id:request});
    const dispatch=this.bridge.missions.dispatch(mission.id,{request_id:request});return{state:'dispatched',...dispatch,route};});
  }finally{this.busy=false;}
 }
}
module.exports={BoundedNextAction};
