'use strict';
const fs=require('node:fs'),path=require('node:path');
const {transaction}=require('./control-transaction');
const {object,identifier,fingerprint}=require('./control-plane-store');
class FixtureAcceptance{
 constructor(bridge){this.bridge=bridge;this.store=bridge.controlStore;this.db=this.store.db;this.db.exec(`CREATE TABLE IF NOT EXISTS cp_fixture_projects(project_id TEXT PRIMARY KEY,workspace TEXT NOT NULL,policy TEXT NOT NULL);CREATE TRIGGER IF NOT EXISTS fixture_policy_immutable BEFORE UPDATE ON cp_fixture_projects BEGIN SELECT RAISE(ABORT,'Immutable fixture policy');END;CREATE TRIGGER IF NOT EXISTS fixture_policy_no_delete BEFORE DELETE ON cp_fixture_projects BEGIN SELECT RAISE(ABORT,'Immutable fixture policy');END;`);}
 register(input,actor='operator'){
  if(actor!=='operator')throw Error('Only operator may authorize fixture policy');object(input,['project_id','workspace','isolated','no_external_effects']);identifier(input.project_id);
  const workspace=fs.realpathSync(input.workspace),project=this.bridge.projects.getProject(input.project_id);
  if(input.isolated!==true||input.no_external_effects!==true||![require('node:os').tmpdir(),'/tmp'].some(root=>workspace.startsWith(fs.realpathSync(root)+path.sep))||!project.repositories.includes(workspace))throw Error('Explicit isolated temporary fixture workspace required');
  const policy=JSON.stringify({isolated:true,no_external_effects:true,workspace});const old=this.db.prepare('SELECT * FROM cp_fixture_projects WHERE project_id=?').get(input.project_id);if(old){if(old.policy!==policy)throw Error('Immutable fixture policy conflict');return{duplicate:true};}
  this.db.prepare('INSERT INTO cp_fixture_projects VALUES(?,?,?)').run(input.project_id,workspace,policy);return{authorized:true};
 }
 validateCreation(input,owner){
  if(input.fixture_auto_acceptance!==true)return null;
  const policy=this.db.prepare('SELECT * FROM cp_fixture_projects WHERE project_id=? AND workspace=?').get(input.project_id,input.workspace);
  if(owner!=='operator'||!policy)throw Error('Fixture auto acceptance requires operator preauthorization');
  if(input.criteria.some(c=>c.type!=='exact_file')||(input.capability_scopes||['repo','developer_environment']).some(s=>!['repo','developer_environment'].includes(s)))throw Error('Fixture criteria or side-effect scopes are unsafe');
  return{authorized:true,policy_hash:fingerprint(JSON.parse(policy.policy)),criteria_hash:fingerprint(input.criteria),inheritable:false};
 }
 attempt(id){return transaction(this.db,()=>{
  const m=this.store.requireMission(id),a=m.envelope.fixture_auto_acceptance;
  const deny=reason=>{this.store.event('fixture.auto_acceptance.denied',id,{reason});return{accepted:false,reason};};
  if(!a?.authorized)return deny('not_preauthorized_fixture');
  const policy=this.db.prepare('SELECT * FROM cp_fixture_projects WHERE project_id=? AND workspace=?').get(m.project_id,m.envelope.workspace);
  if(!policy||a.policy_hash!==fingerprint(JSON.parse(policy.policy))||a.criteria_hash!==fingerprint(m.envelope.criteria)||m.envelope.criteria.some(c=>c.type!=='exact_file')||m.envelope.capability_scopes.some(s=>!['repo','developer_environment'].includes(s)))return deny('fixture_policy_mismatch');
  if(m.state==='completed'){
   const v=this.db.prepare('SELECT * FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
   if(!v||!require('./execution-evidence').runSatisfied(this.store.run(v.run_id)))return deny('native_tool_required');
   return{accepted:true,duplicate:true};
  }
  if(m.state!=='awaiting_acceptance')return deny('verification_not_ready');
  if(this.store.decisions(id).some(d=>d.state==='waiting_for_operator'))return deny('waiting_decision');
  if(this.bridge.policy.list().some(p=>p.status==='pending'&&this.store.missionForTask(p.taskId)?.id===id))return deny('pending_approval');
  const v=this.db.prepare('SELECT * FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
  if(!v||v.result!=='passed'||v.checker!=='airodrom:host-verifier'||v.revision!==m.revision)return deny('independent_verification_required');
  const run=this.store.run(v.run_id),checks=JSON.parse(v.evidence);
  if(!require('./execution-evidence').runSatisfied(run))return deny('native_tool_required');
  if(!run||run.mission_id!==id||run.task_id!==m.task_id||run.state!=='completed'||!run.termination_verified)return deny('run_correlation');
  if(m.envelope.criteria.some(c=>!checks.some(x=>x.id===c.id&&x.status==='passed'))||checks.some(c=>c.status!=='passed'))return deny('missing_or_failed_checker');
  this.bridge.missions.accept(id,{request_id:`fixture-accept:${v.id}`,verification_id:v.id,decision:'accept',rationale:'Immutable isolated fixture policy; all independent Airodrom host checkers passed'});
  this.store.event('fixture.auto_acceptance.completed',id,{verification_id:v.id,run_id:v.run_id});return{accepted:true};
 });}
 reconcile(){for(const {id} of this.db.prepare("SELECT id FROM cp_missions WHERE state='awaiting_acceptance'").all())if(this.store.getMission(id).envelope.fixture_auto_acceptance?.authorized)this.attempt(id);}
}
module.exports={FixtureAcceptance};
