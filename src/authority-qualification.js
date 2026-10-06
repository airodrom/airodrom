'use strict';
const assert=require('node:assert/strict');
const {transaction}=require('./control-transaction');
const {canonicalHash}=require('./authority-hash');
const {json,actor}=require('./authority-store');
const {randomUUID}=require('node:crypto');
const {evaluateRouting,POLICY_ID}=require('./authority-router');
class AuthorityQualification {
  constructor(runtime){for(const name of ['prepareRouter','proveRouter','enableRouter','disableRouter']){const operation=this[name].bind(this);this[name]=(...args)=>transaction(runtime.db,()=>operation(...args));}this.runtime=runtime;this.bridge=runtime.bridge;this.store=runtime.store;this.db=runtime.db;this.memory=runtime.memory;}
  source(){const current=require('./runtime-fingerprint').sourceFingerprint().source_sha256;if(current!==this.bridge.runtimeFingerprint.source_sha256)throw new Error('Source/live fingerprint mismatch');return current;}
  receipt(kind,evidence){const digest=canonicalHash(evidence),prior=this.db.prepare('SELECT id FROM authority_qualification_receipts WHERE kind=? AND source_hash=? AND evidence_hash=?').get(kind,this.source(),digest),id=prior?.id||randomUUID();this.db.prepare('INSERT OR IGNORE INTO authority_qualification_receipts VALUES(?,?,?,?,?,?,?,?)').run(id,kind,this.source(),1,kind==='memory'?'governed-memory-v1':POLICY_ID,json(evidence),digest,this.store.now());return id;}
  assertIdle(){if(this.db.prepare("SELECT 1 FROM cp_leases WHERE state IN('held','quarantined')").get()||this.bridge.leases?.size||this.bridge.inFlight?.size)throw new Error('Qualification requires an idle bridge');}
  prepare(by){actor(by,['operator']);this.assertIdle();const integrity=this.store.integrity();if(!integrity.ok)throw new Error('Authority integrity gate failed');return transaction(this.db,()=>{this.db.prepare("UPDATE authority_activation SET memory_state='qualifying',router_state='disabled',source_hash=?,updated_at=? WHERE id=1").run(this.source(),this.store.now());this.store.referenceEvent('activation.changed','memory-qualification',{source_hash:this.source(),state:'qualifying'});return this.runtime.state();});}
  proveMemory(memoryId,by){
    actor(by,['operator']);this.assertIdle();if(this.runtime.state().memory_state!=='qualifying')throw new Error('Memory qualification not prepared');
    return transaction(this.db,()=>{
      const provenance=this.memory.provenance(memoryId,by),m=provenance.memory;
      assert.equal(m.kind,'personal_preference');assert.equal(m.subject_key,'workflow.micro_prompts');assert.equal(m.value,'forbidden');assert.equal(m.scope,'global');assert.equal(m.status,'active');assert.equal(provenance.candidate.promoted_memory_id,m.id);assert.equal(provenance.observation.speaker,'operator');
      const packInput={operator_id:by.id,include_personal:true,required_keys:['workflow.micro_prompts'],privacy:'internal',domains:['workflow']};
      const first=this.memory.build(packInput),second=this.memory.build(packInput);assert.equal(first.state,'ready');assert.equal(first.context_hash,second.context_hash);assert.equal(first.items.find(x=>x.memory_id===m.id).value,'forbidden');
      const project=this.store.createProject({id:'authority:qualification',name:'Authority qualification fixtures',status:'active'});
      const mission=this.store.createMission({project_id:project.id,envelope:{objective:'Deliver governed context to a deterministic in-process fixture',task_type:'local_diagnostics',criteria:[],capability_scopes:[],fixture:true}});
      const run=this.store.startRun({mission_id:mission.id,mission_revision:1,agent_id:'host',runtime_id:'host:context-fixture',adapter_type:'in_process_fixture'});
      const delivery=this.memory.build({...packInput,project_id:project.id,mission_id:mission.id,mission_revision:1,run_id:run.id});
      // Deliberately an in-process fixture with no tools, shell, credentials or
      // provider. It consumes the persisted pack, not a repeated preference.
      const actual={value:delivery.items.find(x=>x.subject_key==='workflow.micro_prompts')?.value,context_hash:delivery.context_hash,execution_authority:false};
      const result=this.store.recordResult({run_id:run.id,mission_id:mission.id,mission_revision:1,status:'completed',summary:'Context fixture consumed the saved workflow preference',fixture_output:actual});
      const observed=this.store.getResult(result.id).result.fixture_output;
      const verification=this.store.verifyResult({mission_id:mission.id,mission_revision:1,result_id:result.id,status:observed.value==='forbidden'&&observed.context_hash===delivery.context_hash?'passed':'failed',verifier_type:'host',verifier_id:'context-fixture-independent-checker',evidence:[{expected_memory_hash:m.content_hash,observed_output_hash:canonicalHash(observed)}]});
      assert.equal(verification.status,'passed');
      this.store.setState(mission.id,'awaiting_acceptance');
      const acceptance=this.store.accept({mission_id:mission.id,mission_revision:1,verification_id:verification.id,reason:'Operator-authorized isolated memory qualification fixture'},by);
      const episode=this.memory.distill(acceptance.id),replay=this.memory.distill(acceptance.id);assert.equal(episode.id,replay.id);
      assert.throws(()=>this.memory.distill('missing-acceptance'));
      const worker={type:'agent',id:run.id},provider={type:'provider',id:'fixture'};
      assert.throws(()=>this.memory.promote(provenance.candidate.id,{},worker));assert.throws(()=>this.memory.promote(provenance.candidate.id,{},provider));assert.throws(()=>this.memory.forget(m.id,worker));assert.throws(()=>this.store.accept({mission_id:mission.id},worker));
      const before=this.db.prepare('SELECT count(*) n FROM authority_execution_grants').get().n;
      for(const field of ['shell','scope_expansion','approval','provider_activation','deploy','credentials','lease_override','acceptance'])assert.throws(()=>this.memory.ingest({session_id:'abuse',chunk_id:field,timestamp:1,speaker:'operator',claim:'No micro-prompts.',kind:'personal_preference',subject_key:'workflow.micro_prompts',value:'forbidden',[field]:true},by));
      assert.equal(this.db.prepare('SELECT count(*) n FROM authority_execution_grants').get().n,before);
      const evidence={memory_id:m.id,candidate_id:provenance.candidate.id,observation_id:provenance.observation.id,source_hash:provenance.observation.source_hash,context_pack_id:delivery.id,context_hash:delivery.context_hash,later_context_pack_hash:second.context_hash,fixture_mission_id:mission.id,fixture_run_id:run.id,result_id:result.id,verification_id:verification.id,acceptance_id:acceptance.id,episode_id:episode.id,episode_replay_id:replay.id,authority_denials:12,execution_kind:'in_process_fixture',integrity:this.store.integrity()};
      assert.equal(evidence.integrity.ok,true);const receipt=this.receipt('memory',evidence);
      this.db.prepare("UPDATE authority_activation SET memory_state='enabled',router_state='disabled',memory_receipt_id=?,source_hash=?,updated_at=? WHERE id=1").run(receipt,this.source(),this.store.now());this.store.referenceEvent('activation.changed',receipt,{memory_state:'enabled',router_state:'disabled',source_hash:this.source()});return {receipt_id:receipt,...evidence};
    });
  }
  prepareRouter(by){actor(by,['operator']);this.assertIdle();const state=this.runtime.state(),receipt=state.memory_receipt_id&&this.store.one('qualification_receipts',state.memory_receipt_id);if(state.memory_state!=='enabled'||receipt?.source_hash!==this.source()||receipt?.schema_version!==1)throw new Error('Live memory qualification required');this.db.prepare("UPDATE authority_activation SET router_state='qualifying',updated_at=? WHERE id=1").run(this.store.now());this.store.referenceEvent('activation.changed','router-qualification',{router_state:'qualifying',source_hash:this.source()});return this.runtime.state();}
  proveRouter(by){
    actor(by,['operator']);const prior=this.runtime.state().router_receipt_id&&this.store.one('qualification_receipts',this.runtime.state().router_receipt_id);if(prior?.source_hash===this.source())return {receipt_id:prior.id,...prior.evidence};if(this.runtime.state().router_state!=='qualifying')throw new Error('Router qualification not prepared');
    const memoryReceipt=this.store.one('qualification_receipts',this.runtime.state().memory_receipt_id),original=this.store.one('context_pack_manifests',memoryReceipt.evidence.context_pack_id),pack=this.memory.build(original.manifest.input);
    if(pack.state!=='ready')throw new Error('Router fixture context is not current');
    const candidate={agent_id:'host',runtime_id:'host',enabled:true,capabilities:['local_tools'],assurance:2,locality:'local',isolation_verified:true,availability:'available',observed_at:this.store.now(),auth_state:'not_required',quota_state:'unknown',circuit_state:'closed',cost_class:'local',transport:'in_process_fixture'};
    const input={project_id:pack.project_id,mission_id:pack.mission_id,mission_revision:pack.mission_revision,context_pack_id:pack.id,task_class:'local_diagnostics',required_capabilities:['local_tools'],required_assurance:2,privacy:'internal',local_only:true,external_allowed:false,allow_handoff:false,writer_conflict:false};
    const route=this.runtime.router.plan(input,[candidate],this.store.host,{fixture:true});assert.equal(route.selectedAgent,'host');assert.equal(route.selectedProvider,null);
    const base={...input,memory_state:'ready',context_current:true};
    const denials={writer:evaluateRouting({...base,writer_conflict:true},[candidate],this.store.now()),stale_context:evaluateRouting({...base,context_current:false},[candidate],this.store.now()),unknown_cost:evaluateRouting({...base,maxCostUsdBoundary:0},[candidate],this.store.now()),deepseek:evaluateRouting(base,[{...candidate,provider_id:'deepseek'}],this.store.now()),quota:evaluateRouting(base,[{...candidate,availability:'quota_limited'}],this.store.now())};
    for(const r of Object.values(denials))assert.equal(r.state,'WAIT');
    const costInput={...original.manifest.input,project_id:'authority:qualification',mission_id:null,mission_revision:null,run_id:null,domains:['infrastructure'],required_keys:[],query:'cost preference',max_bytes:8000};
    const packA=this.memory.build(costInput);
    const preference=this.memory.ingest({session_id:'authority-router-fixture',chunk_id:'cost-preference-v1',timestamp:1,speaker:'operator',claim:'Fixture preference: early-stage-cost-efficient.',kind:'personal_preference',subject_key:'infrastructure.cost_preference',value:'early_stage_cost_efficient',project_id:'authority:qualification',scope:'project_specific'},by);
    this.memory.promote(preference.id,{},by);const packB=this.memory.build(costInput),diff=this.memory.diff(packA.id,packB.id,by);
    const coding=[{...candidate,capabilities:['coding']},{...candidate,agent_id:'claude',runtime_id:'claude',capabilities:['coding'],locality:'external',isolation_verified:false,cost_class:'subscription'}];
    const costRoute={...input,mission_id:null,mission_revision:null,required_capabilities:['coding'],task_class:'focused_refactor',external_allowed:true,local_only:false};
    const routeA=this.runtime.router.plan({...costRoute,context_pack_id:packA.id},coding,this.store.host,{fixture:true});
    // The old pack deliberately becomes stale after promotion and must WAIT.
    assert.equal(routeA.state,'WAIT');
    const routeB=this.runtime.router.plan({...costRoute,context_pack_id:packB.id},coding,this.store.host,{fixture:true});assert.equal(routeB.selectedAgent,'host');
    const withoutPreference=evaluateRouting({...costRoute,memory_state:'ready',context_current:true},coding,this.store.now());assert.equal(withoutPreference.selectedAgent,'claude');
    const restricted=this.memory.build({...costInput,privacy:'restricted_security'}),security=this.runtime.router.plan({...costRoute,privacy:'restricted_security',context_pack_id:restricted.id},coding,this.store.host,{fixture:true});assert.equal(security.selectedAgent,'host');assert(security.rejectedCandidates.some(c=>c.reason==='privacy_isolation'));
    const evidence={context_diff_id:diff.id,cost_route_before:withoutPreference.selectedAgent,cost_route_after:routeB.selectedAgent,stale_route_id:routeA.id,cost_route_id:routeB.id,security_route_id:security.id,routing_decision_id:route.id,selected_agent:route.selectedAgent,selected_provider:route.selectedProvider,selected_model:route.selectedModel,context_pack_id:pack.id,negative_cases:Object.keys(denials),fixture:true,integrity:this.store.integrity()};
    const id=this.receipt('router',evidence);this.db.prepare('UPDATE authority_activation SET router_receipt_id=?,updated_at=? WHERE id=1').run(id,this.store.now());return {receipt_id:id,...evidence};
  }
  enableRouter(by){actor(by,['operator']);this.assertIdle();const state=this.runtime.state(),receipt=state.router_receipt_id&&this.store.one('qualification_receipts',state.router_receipt_id);if(state.memory_state!=='enabled'||state.router_state!=='qualifying'||receipt?.source_hash!==this.source()||!this.store.integrity().ok)throw new Error('Router qualification receipt required');this.db.prepare("UPDATE authority_activation SET router_state='enabled',updated_at=? WHERE id=1").run(this.store.now());this.store.referenceEvent('activation.changed','router-v2-enabled',{source_hash:this.source(),receipt_id:receipt.id});return this.runtime.state();}
  disableRouter(by){actor(by,['operator']);this.db.prepare("UPDATE authority_activation SET router_state='disabled',updated_at=? WHERE id=1").run(this.store.now());this.store.referenceEvent('activation.changed','router-v2-disabled',{source_hash:this.source()});return this.runtime.state();}
}
module.exports={AuthorityQualification};
