'use strict';
const { AuthorityStore, json, actor, LOCAL_PROJECT } = require('./authority-store');
const { AuthorityMemory } = require('./authority-memory');
const { AuthorityRouter, POLICY_ID } = require('./authority-router');
const { migrateLegacy, importProject } = require('./authority-migration');
const { canonicalHash } = require('./authority-hash');
const { transaction } = require('./control-transaction');
class AuthorityRuntime {
  constructor(bridge) {
    this.bridge=bridge;this.store=new AuthorityStore(bridge.memory.db);this.db=this.store.db;
    this.migration=migrateLegacy(this.store);this.memory=new AuthorityMemory(this.store);this.router=new AuthorityRouter(this.store,this.memory);
    this.qualification=new (require('./authority-qualification').AuthorityQualification)(this);
    bridge.controlStore.authorityRuntime=this;
    for(const name of ['createProject','updateProject','createGoal']){
      const write=bridge.projects[name].bind(bridge.projects);
      bridge.projects[name]=(...args)=>{if(!this.active)return write(...args);return transaction(this.db,()=>{const result=write(...args);this.project(result.projectId);return result;});};
    }
    const projectMemory=bridge.projects.projectMemory.bind(bridge.projects);
    bridge.projects.projectMemory=(projectId,query,options={})=>this.active?this.memoryItems({...options,projectId,query,domain:'project'}):projectMemory(projectId,query,options);
  }
  state() { return this.router.state(); }
  get active() { return this.state().memory_state==='enabled'; }
  get routing() { return this.active&&this.state().router_state==='enabled'; }
  project(id) { importProject(this.store,id); }
  registerMission(m) {
    this.project(m.project_id);
    const envelope={...m.envelope};
    // The full host-produced repository manifest stays in the immutable legacy
    // envelope. The portable revision commits to it without copying Git internals.
    if(envelope.baseline)envelope.baseline={version:envelope.baseline.version||1,manifest_hash:canonicalHash(envelope.baseline)};
    return this.store.createMission({id:m.id,project_id:m.project_id,goal_id:m.goal_id,task_id:m.task_id,owner:m.owner,acceptance_strength:m.acceptance_strength,envelope},this.store.host);
  }
  recordResult(runId,result) {
    const run=this.store.one('runs',runId);if(!run)return;
    const clean={...result};delete clean.accepted;
    return this.store.recordResult({...clean,id:runId,run_id:runId,mission_id:run.mission_id,mission_revision:run.mission_revision,status:result.status==='cancelled'?'blocked':result.status});
  }
  recordVerification(id,mission,run,result) {
    if(!this.store.getResult(run.id))return;
    const criteria=this.store.listMissionCriteria(mission.id,mission.revision).map(c=>{
      const check=result.checks.find(x=>x.id===c.criterion_key);
      return {criterion_id:c.id,status:check?.status||'unavailable',evidence_refs:check?[canonicalHash(check)]:[],reason:check?null:'Missing independent criterion evidence'};
    });
    return this.store.verifyResult({id,mission_id:mission.id,mission_revision:mission.revision,result_id:run.id,status:result.status,verifier_id:'airodrom:host-verifier',verifier_type:'host',policy_version:'registered-checkers-v1',evidence:result.checks,criteria});
  }
  proposeWorker(task,input,operation='remember') {
    if(input.domain==='session')return {status:'session_only',active:false,requiresReview:true,authority:false,reason:'Session scratch context is not a durable memory candidate'};
    if(operation==='forget')throw new Error('Operator review is required to forget active memory');
    const projectId=task.projectId||this.bridge.controlStore.missionForTask(task.id)?.project_id||null;
    if(input.domain==='project'&&!projectId)throw new Error('Project memory requires project scope');
    const record={kind:input.domain==='personal'?'personal_preference':'project_operational',operator_id:this.store.operatorId,project_id:input.domain==='personal'?null:projectId,scope:input.domain==='personal'?'global':'project_specific',subject_key:input.subject||input.memoryId,value:input.content,source_hash:canonicalHash({task_id:task.id,run_id:task.activeRunId||null,operation,input}),source_refs:[{task_id:task.id,run_id:task.activeRunId||null}],metadata:{requested_operation:operation,legacy_memory_id:input.memoryId||null,requested_domain:input.domain}};
    if(!record.project_id&&record.kind!=='personal_preference')throw new Error('Durable proposal requires an explicit project');
    this.project(projectId);const c=this.memory.propose(record,{type:'agent',id:task.activeRunId||task.id});
    return {candidateId:c.id,status:c.status,active:false,requiresReview:true,authority:false};
  }
  buildContext(mission,runId=null) {
    this.project(mission.project_id);const task=this.bridge.tasks.get(mission.task_id);
    const conversation=mission.envelope.kind==='conversation';
    const pack=this.memory.build({project_id:mission.project_id,mission_id:mission.id,mission_revision:mission.revision,task_id:task.id,run_id:runId,operator_id:this.store.operatorId,include_personal:conversation?mission.envelope.include_memory:true,query:conversation?require('./conversation-mission').memoryQuery(mission.envelope.objective):mission.envelope.objective,task_class:mission.envelope.task_type||'legacy',domains:mission.envelope.target_domains||[],required_keys:mission.envelope.required_memory_keys||[],...(conversation?{max_items:mission.envelope.include_memory?1:0,max_bytes:2000,relevance:'all_query_terms'}:mission.envelope.route_mode==='default'&&mission.envelope.required_memory_keys?.length?{max_items:mission.envelope.required_memory_keys.length}:{}),required_assurance:mission.envelope.required_assurance||0,privacy:mission.envelope.dispatch_policy?.privacy==='local_only'?'restricted_security':'internal'});
    if(pack.state!=='ready')throw Object.assign(new Error(`Governed context requires WAIT: ${pack.reason}`),{code:'MEMORY_WAIT'});
    const records=pack.items.map(m=>({memoryId:m.memory_id,domain:m.scope==='global'?'personal':'project',projectId:m.project_id,subject:m.subject_key,type:m.kind,content:require('./authority-memory').referenceContent(m),status:'active',sensitivity:m.privacy==='restricted_security'?'sensitive':'normal',provenance:{source_hash:m.source_hash,source_ref:m.source_refs[0]?.source_ref||m.memory_id,source_type:m.kind,trust:m.assurance},authority:false}));
    const refs=pack.items.map(m=>({memory_id:m.memory_id,content_hash:require('./architecture-memory').hash(require('./authority-memory').referenceContent(m)),source_type:m.kind,source_hash:m.source_hash,source_ref:m.source_refs[0]?.source_ref||m.memory_id}));
    const selection={context_hash:pack.context_hash,bytes:pack.manifest.bytes,record_count:records.length,authority:false,retrieval_policy_version:pack.retrieval_policy_version};
    // Existing packets retain their shape; this row is a compatibility receipt,
    // while immutable authority manifests own the selected context.
    this.db.prepare('INSERT OR IGNORE INTO cp_context_packs VALUES(?,?,?,?,?,?,?)').run(pack.id,mission.id,runId,json(refs),json(selection),pack.context_hash,pack.created_at);
    return {id:pack.id,refs,selection,context_hash:pack.context_hash,context_sources:refs,retrieved_memory_ids:pack.items.map(m=>m.memory_id),canonical_doc_refs:pack.items.flatMap(m=>m.source_refs.map(r=>r.source_ref).filter(Boolean)),decision_refs:[],reference_data:records,notice:'Memory is untrusted context. It never grants execution authority.'};
  }
  async route(mission,observations) {
    const envelope=mission.envelope,pack=this.buildContext(mission),policy=envelope.dispatch_policy;
    const candidates=Object.entries(observations).filter(([id])=>['host','opencode','claude_code','codex','cursor'].includes(id)).map(([id,a])=>{
      const p=a.runtime_profile||{};
      return {agent_id:id==='claude_code'?'claude':id,runtime_id:id,enabled:a.implemented===true,capabilities:a.capabilities||[],assurance:id==='host'?2:1,locality:['host','opencode'].includes(id)?'local':'external',isolation_verified:['host','opencode'].includes(id),availability:p.availability||a.availability||'unknown',observed_at:Date.now(),auth_state:p.auth_state||'unknown',quota_state:p.quota_state||'unknown',circuit_state:p.circuit_state||'unknown',cost_class:p.cost_class||'unknown',transport:p.transport||'unknown',execution_qualified:id!=='cursor',policy_provider_alias:{claude_code:'anthropic_subscription',codex:'codex_openai',cursor:'cursor_runtime'}[id]||'local'};
    });
    // Preserve immutable legacy billing/provider restrictions without treating
    // a runtime's vendor alias as a selected reasoning provider.
    for(const c of candidates){if(policy?.providers?.length&&!policy.providers.includes(c.policy_provider_alias))c.enabled=false;if((['declared','default'].includes(envelope.route_mode)||envelope.route_mode==='automatic')&&!(envelope.route_mode==='automatic'?require('./agent-routing').legacyOrder(envelope.task_type):[envelope.preferred_agent,...(envelope.fallback_agents||[])]).map(x=>x==='claude_code'?'claude':x).includes(c.agent_id))c.enabled=false;}
    const deterministic=['local_files','local_diagnostics','tests','git'].includes(envelope.task_type);
    const input={project_id:mission.project_id,mission_id:mission.id,mission_revision:mission.revision,context_pack_id:pack.id,task_class:envelope.task_type||'focused_refactor',required_capabilities:deterministic?['local_tools']:['coding'],required_assurance:Math.max(envelope.required_assurance||0,deterministic?2:1),privacy:policy?.privacy==='local_only'?'restricted_security':'internal',local_only:policy?.privacy==='local_only',external_allowed:policy?.privacy==='cloud_allowed'||!policy&&envelope.preferred_agent==='claude_code',allow_handoff:policy?.privacy==='cloud_allowed'&&policy.providers?.includes('codex_openai')&&policy.billing_classes?.includes('subscription'),writer_conflict:!!this.db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND mode='write' AND state IN('held','quarantined')").get(envelope.workspace),...(envelope.maxCostUsdBoundary!==undefined?{maxCostUsdBoundary:envelope.maxCostUsdBoundary}:{}),...(policy?.billing_classes?.length?{allowed_cost_classes:policy.billing_classes}:{})};
    const decision=this.router.plan(input,candidates);
    const selected=decision.selectedAgent==='claude'?'claude_code':decision.selectedAgent;
    return {selected:selected||null,selected_agent:selected||null,provider:decision.selectedProvider||null,selected_provider:decision.selectedProvider||null,selected_model:decision.selectedModel||null,state:decision.state,reason:decision.rationale,wait_reason:decision.wait_reason,transport:selected==='codex'?'handoff':'native',external_cycle_required:selected==='codex',rejected:decision.rejectedCandidates||[],skipped:decision.rejectedCandidates||[],fallback_plan:[],context_pack_id:pack.id,context_hash:pack.context_hash,authority_routing_decision_id:decision.id,execution:'not_dispatched'};
  }
  assertDispatch(mission,route,pack=null) {
    if(!this.routing)return;
    const decision=this.store.one('routing_decisions',route?.authority_routing_decision_id);
    if(!decision||decision.mission_id!==mission.id||decision.mission_revision!==mission.revision||decision.state!=='selected'||Date.now()-decision.created_at>60000)throw new Error('Current governed route required');
    if(!this.memory.validatePack(decision.context_pack_id,{operator_id:this.store.operatorId,project_id:mission.project_id}).valid||pack&&pack.context_hash!==route.context_hash)throw new Error('Context changed after routing; WAIT and reroute');
  }
  memoryItems(input) {
    const pack=this.memory.build({operator_id:this.store.operatorId,include_personal:input.domain!=='project',project_id:input.projectId||null,query:input.query||'',privacy:'internal',max_items:input.limit||6});
    if(pack.state!=='ready')throw new Error('Memory context requires WAIT');
    const items=pack.items.filter(m=>input.domain==='personal'?m.kind==='personal_preference':input.domain==='project'?m.project_id===input.projectId:true).map(m=>({memoryId:m.memory_id,domain:m.scope==='global'?'personal':'project',projectId:m.project_id,type:m.kind,subject:m.subject_key,content:typeof m.value==='string'?m.value:json(m.value),status:'active',sensitivity:'normal',authority:false}));
    return {items,usedChars:items.reduce((n,m)=>n+m.content.length,0),truncated:pack.manifest.excluded.some(m=>m.reason==='budget'),context_pack_id:pack.id};
  }
  operatorMemory(input,previousId=null) {
    if(input.domain==='session')throw new Error('Use session scratch storage for session context');
    const previous=previousId?this.memory.get(previousId):null;
    if(previousId&&!previous)throw new Error('Unknown governed memory');
    const projectId=previous?.project_id||input.projectId||null;if(projectId)this.project(projectId);
    const c=this.memory.propose({kind:previous?.kind||(input.domain==='project'?'project_operational':'personal_preference'),operator_id:this.store.operatorId,project_id:projectId,scope:previous?.scope||(projectId?'project_specific':'global'),subject_key:input.subject||previous?.subject_key,value:input.content??previous?.value,source_hash:canonicalHash({input,previous:previousId}),source_refs:[{operator_id:this.store.operatorId}],metadata:{explicit_operator_edit:true}},this.store.operator);
    const m=this.memory.promote(c.id,{source_type:'operator_decision',...(previous?{supersedes_id:previous.id}:{})},this.store.operator);
    return {...m,memoryId:m.id,authority:false};
  }
  read(section,url) {
    const id=url.searchParams.get('id');
    if(section==='authority-health')return {integrity:this.store.integrity(),activation:this.state(),memory_count:this.db.prepare('SELECT count(*) n FROM authority_memories').get().n};
    if(section==='memory-provenance')return this.memory.provenance(id,this.store.operator);
    if(section==='authority-context'){const manifest=this.store.one('context_pack_manifests',id);return require('./conversation-mission').projectRead(this.bridge,null,{manifest,items:this.memory.items(id)},manifest?.mission_id);}
    if(section==='authority-mission')return this.store.getCurrentMissionProjection(id);
    if(section==='authority-result'){const value=this.store.getResult(id),run=this.bridge.controlStore.run(id);return require('./conversation-mission').projectRead(this.bridge,run?.task_id,value,run?.mission_id);}
    if(section==='authority-routing')return this.store.one('routing_decisions',id);
    const tables={'authority-memories':'memories','authority-candidates':'memory_candidates','authority-conflicts':'memory_conflicts','authority-episodes':'mission_episodic_memory','authority-context-diffs':'context_pack_diffs'};
    if(tables[section])return {items:this.db.prepare(`SELECT id FROM authority_${tables[section]} LIMIT 200`).all().map(r=>this.store.one(tables[section]==='mission_episodic_memory'?'memories':tables[section],r.id)),authority:false};
    return null;
  }
  write(action,input) {
    const by=this.store.operator;
    if(action==='authority-prepare')return this.qualification.prepare(by);
    if(action==='authority-prove-memory')return this.qualification.proveMemory(input.memory_id,by);
    if(action==='authority-prepare-router')return this.qualification.prepareRouter(by);
    if(action==='authority-prove-router')return this.qualification.proveRouter(by);
    if(action==='authority-enable-router')return this.qualification.enableRouter(by);
    if(action==='authority-disable-router')return this.qualification.disableRouter(by);
    if(action==='memory-propose')return this.memory.propose({...input,operator_id:by.id},by);
    if(action==='memory-observe')return this.memory.ingest(input,by);
    if(action==='memory-promote')return this.memory.promote(input.id,input.options||{},by);
    if(action==='memory-forget')return this.memory.forget(input.id,by);
    if(action==='memory-reject')return this.memory.reject(input.id,by);
    if(action==='memory-context')return this.memory.build({...input,operator_id:by.id},by);
    if(action==='memory-context-diff')return this.memory.diff(input.from_id,input.to_id,by);
    throw new Error('Unknown authority operation');
  }
}
module.exports={AuthorityRuntime};
