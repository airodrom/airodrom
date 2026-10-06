'use strict';
const {randomUUID}=require('node:crypto');
const { transaction } = require('./control-transaction');
const { canonicalHash } = require('./authority-hash');
const { actor, safe, json, LOCAL_PROJECT } = require('./authority-store');
const POLICY_ID='deterministic-router-v2';
const HEALTH_TTL=60000;
const COST_ORDER=['local','free/local','low','subscription','medium','high','unknown'];
const POLICY=Object.freeze({version:2,health_ttl_ms:HEALTH_TTL,hard_gate_order:['authority','privacy','capabilities','assurance','memory','availability','lease','auth_quota_circuit','cost'],ranking:['observed_reliability','observed_latency','personal_cost_preference','task_taxonomy','stable_identity'],unknown_cost:'WAIT',unknown_health:'WAIT',memory_authority:false});
const candidateKey=c=>[c.agent_id,c.runtime_id,c.provider_id||'',c.model_id||''].join(':');
function taxonomy(taskClass) { return ['local_diagnostics','local_files','tests','git'].includes(taskClass)?['pi']:taskClass==='ide_diagnostics'?['cursor','claude','codex']:['broad_investigation','large_multi_file_coding'].includes(taskClass)?['codex','claude','pi']:['claude','codex','pi']; }
// Pure selection. Input observations must be collected by the host service;
// persisting or selecting a route does not authorize an execution operation.
function evaluateRouting(input,candidates,now) {
  const rejected=[],eligible=[];
  for(const c of [...candidates].sort((a,b)=>candidateKey(a).localeCompare(candidateKey(b),'en'))){
    let gate=0,reason=null;
    const reject=(n,r)=>{gate=n;reason=r;};
    if(input.unknown_side_effects||input.execution_started)reject(1,'reconcile_unknown_side_effects');
    else if(c.provider_id==='deepseek'||c.agent_id==='cursor'&&!c.execution_qualified)reject(1,c.provider_id==='deepseek'?'provider_disabled_auth_required':'cursor_execution_unqualified');
    else if(c.enabled!==true||input.allowed_agents&&!input.allowed_agents.includes(c.agent_id)||c.provider_id&&input.allowed_providers&&!input.allowed_providers.includes(c.provider_id))reject(1,'authority_policy');
    else if((input.local_only||input.privacy==='restricted_security')&&(c.locality!=='local'||input.privacy==='restricted_security'&&c.isolation_verified!==true))reject(2,'privacy_isolation');
    else if(c.locality==='external'&&input.external_allowed!==true)reject(2,'external_not_approved');
    else if((input.required_capabilities||[]).some(k=>!c.capabilities?.includes(k)))reject(3,'required_capability');
    else if((c.assurance??-1)<(input.required_assurance||0))reject(4,'assurance');
    else if(input.memory_state!=='ready'||input.context_current!==true)reject(5,input.memory_reason||'stale_or_ineligible_context');
    else if(!['available','handoff_only'].includes(c.availability)||c.availability==='handoff_only'&&!input.allow_handoff||!Number.isFinite(c.observed_at)||c.observed_at>now||now-c.observed_at>HEALTH_TTL)reject(6,c.availability==='available'?'stale_health':c.availability||'unknown_health');
    else if(input.writer_conflict)reject(7,'workspace_writer');
    else if(c.auth_state==='auth_required'||c.quota_state==='quota_limited'||c.circuit_state==='open'||c.circuit_state==='OPEN')reject(8,c.auth_state==='auth_required'?'auth_required':c.quota_state==='quota_limited'?'quota_limited':'circuit_open');
    else if(input.allowed_cost_classes&&!input.allowed_cost_classes.includes(c.cost_class))reject(9,'cost_class_boundary');
    else if(input.maxCostUsdBoundary!==undefined&&(!Number.isFinite(input.maxCostUsdBoundary)||input.maxCostUsdBoundary<0||!Number.isFinite(c.enforced_max_cost_usd)||!c.cost_bound_evidence||c.enforced_max_cost_usd>input.maxCostUsdBoundary))reject(9,'cost_bound_unknown_or_exceeded');
    if(reason){rejected.push({candidate_key:candidateKey(c),agent_id:c.agent_id,provider_id:c.provider_id||null,model_id:c.model_id||null,gate,reason});continue;}
    const order=taxonomy(input.task_class),preference=input.preferences?.['infrastructure.cost_preference']==='early_stage_cost_efficient';
    const costRank=COST_ORDER.indexOf(c.cost_class||'unknown');
    const rank=[Number.isFinite(c.observed_failure_rate)?c.observed_failure_rate:1,Number.isFinite(c.observed_latency_ms)?c.observed_latency_ms:Number.MAX_SAFE_INTEGER,preference?(costRank<0?COST_ORDER.length:costRank):0,order.includes(c.agent_id)?order.indexOf(c.agent_id):order.length];
    eligible.push({...c,candidate_key:candidateKey(c),rank});
  }
  eligible.sort((a,b)=>{for(let i=0;i<a.rank.length;i++)if(a.rank[i]!==b.rank[i])return a.rank[i]-b.rank[i];return a.candidate_key<b.candidate_key?-1:a.candidate_key>b.candidate_key?1:0;});
  const winner=eligible[0];
  return {state:winner?'selected':'WAIT',selectedAgent:winner?.agent_id||null,selectedProvider:winner?.provider_id||null,selectedModel:winner?.model_id||null,selectedRuntime:winner?.runtime_id||null,transport:winner?.transport||null,eligibleCandidates:eligible.map(c=>({candidate_key:c.candidate_key,agent_id:c.agent_id,provider_id:c.provider_id||null,model_id:c.model_id||null,rank:c.rank})),rejectedCandidates:rejected,wait_reason:winner?null:rejected[0]?.reason||'no_compatible_agent',rationale:winner?'hard_gates_then_observed_performance_then_governed_preferences_and_taxonomy':'no_eligible_candidate',influencing_memory_ids:input.influencing_memory_ids||[],execution_authority:false};
}
class AuthorityRouter {
  constructor(store,memory) {
    this.store=store;this.memory=memory;this.db=store.db;
    transaction(this.db,()=>{const added=this.db.prepare('INSERT OR IGNORE INTO authority_routing_policy_versions VALUES(?,NULL,2,?,?,0,?)').run(POLICY_ID,json(POLICY),canonicalHash(POLICY),store.now());if(added.changes)this.store.referenceEvent('registry.updated',POLICY_ID,POLICY);});
  }
  state() { return this.db.prepare('SELECT * FROM authority_activation WHERE id=1').get(); }
  plan(input,candidates,by=this.store.host,{fixture=false}={}) {
    require('./memory-identity').assertReadable(this.db);
    actor(by,['host']);safe(input);safe(candidates);
    const state=this.state();if(state.router_state!=='enabled'&&!(state.router_state==='qualifying'&&fixture))return {state:'disabled',execution_authority:false};
    const pack=input.context_pack_id?this.store.one('context_pack_manifests',input.context_pack_id):null;
    if(pack&&((pack.mission_id||null)!==(input.mission_id||null)||(pack.mission_revision||null)!==(input.mission_revision||null)))throw new Error('Routing/context lineage mismatch');
    const check=pack?this.memory.validatePack(pack.id,{operator_id:this.store.operatorId,project_id:input.project_id||null}):{valid:false};
    const items=pack?this.memory.items(pack.id):[];
    // Only structured, approved preference keys are consumed, never free prose.
    const preferences=Object.fromEntries(items.filter(m=>m.kind==='personal_preference'&&m.subject_key==='infrastructure.cost_preference').map(m=>[m.subject_key,m.value]));
    const effective={...input,preferences,influencing_memory_ids:items.filter(m=>Object.hasOwn(preferences,m.subject_key)).map(m=>m.memory_id),memory_state:check.valid?'ready':'WAIT',context_current:check.valid,privacy:input.privacy==='restricted_security'||pack?.privacy==='restricted_security'?'restricted_security':pack?.privacy||input.privacy};
    const now=this.store.now(),result=evaluateRouting(effective,candidates,now);
    const recorded={input:effective,candidates,observed_at:now,policy:POLICY_ID};
    return transaction(this.db,()=>{
      const prior=this.db.prepare('SELECT id FROM authority_routing_decisions WHERE input_json=? AND decision_json=?').get(json(recorded),json(result));
      if(prior)return {id:prior.id,...result};
      const id=randomUUID();
      for(const c of candidates){
        this.db.prepare('INSERT OR IGNORE INTO authority_runtime_registry VALUES(?,?,?,?,?,?,?, ?,?)').run(c.runtime_id,c.agent_id,c.transport||'existing',c.agent_id,c.enabled?1:0,c.assurance||0,'observed-v1',now,now);
        for(const capability of c.capabilities||[]){const observationId=randomUUID();this.db.prepare('INSERT INTO authority_runtime_capability_observations VALUES(?,?,NULL,?,?,NULL,NULL,0,NULL,NULL,?,?)').run(observationId,c.runtime_id,capability,'host_declared',c.observed_at,id);}
      }
      this.db.prepare('INSERT INTO authority_routing_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.mission_id||null,input.mission_revision||null,pack?.id||null,POLICY_ID,result.state,result.selectedAgent,result.selectedProvider,result.selectedModel,json(recorded),json(result),canonicalHash({recorded,result}),now);
      for(const c of result.eligibleCandidates)this.db.prepare('INSERT INTO authority_routing_candidates VALUES(?,?,1,?)').run(id,c.candidate_key,json(c.rank));
      for(const c of result.rejectedCandidates){this.db.prepare("INSERT INTO authority_routing_candidates VALUES(?,?,0,'[]')").run(id,c.candidate_key);this.db.prepare('INSERT INTO authority_routing_rejections VALUES(?,?,?,?)').run(id,c.candidate_key,c.gate,c.reason);}
      this.store.referenceEvent('routing.decided',id,result,{projectId:input.project_id||LOCAL_PROJECT,by});return {id,...result};
    });
  }
}
module.exports={AuthorityRouter,evaluateRouting,POLICY_ID,POLICY,HEALTH_TTL};
