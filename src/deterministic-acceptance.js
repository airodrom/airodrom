'use strict';
const { fingerprint } = require('./control-plane-store');
const { transaction } = require('./control-transaction');
const { workspaceSnapshot } = require('./control-context');
// Preauthorization is mission-specific and persisted at creation by the operator.
class DeterministicAcceptance {
  constructor(service) {
    this.service=service;this.bridge=service.bridge;this.store=service.store;this.db=service.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_execution_qualification(mission_id TEXT PRIMARY KEY, envelope_hash TEXT NOT NULL, policy TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS execution_policy_immutable BEFORE UPDATE ON cp_execution_qualification BEGIN SELECT RAISE(ABORT,'Immutable execution qualification');END;
      CREATE TRIGGER IF NOT EXISTS execution_policy_no_delete BEFORE DELETE ON cp_execution_qualification BEGIN SELECT RAISE(ABORT,'Immutable execution qualification');END;`);
  }
  register(mission) {
    if (!mission.envelope.coding_plan) return;
    this.db.prepare('INSERT INTO cp_execution_qualification VALUES(?,?,?)').run(mission.id,fingerprint(mission.envelope),JSON.stringify({version:1,operator_preauthorized:mission.envelope.automatic_acceptance===true,inheritable:false}));
    this.store.event(mission.envelope.automatic_acceptance?'execution.auto_acceptance.authorized':'execution.coding_plan.registered',mission.id,{envelope_hash:fingerprint(mission.envelope),inheritable:false});
  }
  evaluate(id) {
    const m=this.store.requireMission(id);
    const deny=reason=>({accepted:false,reason});
    const p=this.db.prepare('SELECT * FROM cp_execution_qualification WHERE mission_id=?').get(id);
    if (!p || !m.envelope.automatic_acceptance || p.envelope_hash!==fingerprint(m.envelope)) return deny('preauthorization_missing_or_changed');
    if (m.state==='completed') return {accepted:true,duplicate:true};
    if (m.state!=='awaiting_acceptance') return deny('verification_not_ready');
    try { this.service.assertAuthority(m);this.service.codingAdapter.assert(m); } catch {return deny('authority_or_adapter_invalid');}
    if(this.store.decisions(id).some(d=>d.state==='waiting_for_operator'))return deny('waiting_decision');
    if(this.bridge.policy.list().some(a=>a.status==='pending'&&this.store.missionForTask(a.taskId)?.id===id))return deny('pending_approval');
    if(this.db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND state IN ('held','quarantined') AND mode='write'").get(m.envelope.workspace))return deny('workspace_writer');
    const v=this.db.prepare('SELECT * FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
    if(!v || v.result!=='passed' || v.checker!=='airodrom:host-verifier' || v.revision!==m.revision)return deny('independent_verification_required');
    const run=this.store.run(v.run_id),checks=JSON.parse(v.evidence);
    if(!run || run.mission_id!==id || run.task_id!==m.task_id || run.agent_id!=='host' || run.state!=='completed' || !run.termination_verified || !require('./execution-evidence').runSatisfied(run))return deny('execution_not_qualified');
    if(run.result?.coding_adapter?.descriptor_hash!==m.envelope.coding_plan.adapter.descriptor_hash || run.result?.coding_plan_hash!==fingerprint(m.envelope.coding_plan))return deny('adapter_evidence_mismatch');
    const execution=run.result.native_execution_evidence;
    if(execution.completed_invocations!==m.envelope.coding_plan.operations.length || !Array.isArray(execution.receipt_refs) || execution.receipt_refs.length!==execution.completed_invocations)return deny('coding_receipts_incomplete');
    const required=['protected_files','expected_changes','verification_workspace_stable',...m.envelope.criteria.map(c=>c.id)];
    if(checks.some(c=>c.status!=='passed') || required.some(id=>!checks.some(c=>c.id===id&&c.status==='passed')))return deny('objective_evidence_incomplete');
    const r=this.db.prepare('SELECT * FROM cp_mission_reviews WHERE mission_id=? AND verification_id=?').get(id,v.id);
    if(!r || r.result!=='passed' || r.workspace_hash!==v.workspace_hash || r.manifest_hash!==this.service.program.contract(id).manifest_hash)return deny('review_broker_required');
    if(workspaceSnapshot(m.envelope.workspace).hash!==v.workspace_hash)return deny('stale_workspace');
    return {accepted:true,verification_id:v.id,review_id:r.id,envelope_hash:p.envelope_hash};
  }
  attempt(id) {return transaction(this.db,()=>{
    const result=this.evaluate(id);
    if(!result.accepted || result.duplicate)return result;
    this.service.accept(id,{request_id:`execution-accept:${result.verification_id}`,verification_id:result.verification_id,decision:'accept',rationale:'Explicit mission preauthorization; qualified execution, independent objective verification and Review Broker passed',evidence:JSON.stringify(result)},'operator');
    this.store.event('execution.auto_acceptance.completed',id,result);
    return result;
  });}
  reconcile(){for(const {mission_id} of this.db.prepare("SELECT q.mission_id FROM cp_execution_qualification q JOIN cp_missions m ON m.id=q.mission_id WHERE m.state='awaiting_acceptance'").all())this.attempt(mission_id);}
}
module.exports={DeterministicAcceptance};
