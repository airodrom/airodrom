'use strict';
const {randomUUID}=require('node:crypto');
const { transaction } = require('./control-transaction');
const { json, parse, safe, actor, LOCAL_PROJECT } = require('./authority-store');
const { canonicalHash } = require('./authority-hash');
const erasure = require('./memory-erasure');
const KINDS = new Set(['architecture','project_operational','personal_preference','mission_episodic']);
const PRIVACY = ['public','internal','restricted_security'];
const RETRIEVAL_POLICY = 'governed-memory-v1';
function exact(input,fields) { if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)))throw new Error('Malformed memory packet'); }
function string(value,max=500) { if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max||value.includes('\0'))throw new Error('Invalid bounded memory field');return value; }
function explicitPreference(key,value,claim) {
  if(key==='workflow.micro_prompts'&&value==='forbidden')return /no micro.prompts|micro.prompts.*forbidden|(?:avoid|do not|don't).*unnecessary confirmations|do not make me approve every safe step/i.test(claim);
  if(key==='workflow.auto_continue_safe_steps'&&value===true)return /continue automatically.*safe|auto.continue safe steps/i.test(claim);
  if(key==='git.ai_attribution'&&value==='forbidden')return /no ai.*attribution|(?:do not|don't).*ai.*attribution/i.test(claim);
  if(key==='infrastructure.cost_preference'&&value==='early_stage_cost_efficient')return /early.stage.cost.efficient/i.test(claim);
  return false;
}
class AuthorityMemory {
  constructor(store) {
    this.store=store;this.db=store.db;
    for(const row of this.db.prepare("SELECT identity FROM memory_erasure_markers WHERE store='governed' AND action='operator_erasure'").all())if(this.db.prepare('SELECT 1 FROM authority_memories WHERE id=?').get(row.identity))this.erase(row.identity,store.operator);
  }
  get(id) { require('./memory-identity').assertReadable(this.db);return this.store.one('memories',id); }
  candidate(id) { require('./memory-identity').assertReadable(this.db);return this.store.one('memory_candidates',id); }
  context(by,projectId=null) { return {by,projectId:projectId||LOCAL_PROJECT}; }
  ingest(packet,by) {
    actor(by,['operator']);exact(packet,['session_id','chunk_id','timestamp','speaker','claim','source_hash','project_id','scope','kind','subject_key','value','metadata']);safe(packet);
    string(packet.session_id,160);string(packet.chunk_id,160);string(packet.claim,4000);
    if(!Number.isSafeInteger(packet.timestamp)||packet.timestamp<0||packet.speaker!=='operator')throw new Error('Authenticated explicit operator observation required');
    if(packet.kind!=='personal_preference'||!explicitPreference(packet.subject_key,packet.value,packet.claim))throw new Error('Explicit supported preference required; use reviewed proposal for other claims');
    const source={session_id:packet.session_id,chunk_id:packet.chunk_id,timestamp:packet.timestamp,speaker:packet.speaker,claim:packet.claim};
    const sourceHash=canonicalHash(source);if(packet.source_hash&&packet.source_hash!==sourceHash)throw new Error('Observation hash mismatch');
    return transaction(this.db,()=>{
      const id='sha256:'+canonicalHash(['conversation-observation-v1',by.id,packet.session_id,packet.chunk_id]);
      const prior=this.store.one('observations',id);if(prior&&prior.source_hash!==sourceHash)throw new Error('Observation replay conflict');
      if(!prior){this.db.prepare('INSERT INTO authority_observations VALUES(?,?,?,?,?,?,?,?,?)').run(id,by.id,packet.session_id,packet.chunk_id,'operator',packet.timestamp,packet.claim,sourceHash,this.store.now());this.store.referenceEvent('observation.recorded',id,source,this.context(by,packet.project_id));}
      return this.propose({kind:'personal_preference',operator_id:by.id,project_id:packet.project_id||null,scope:packet.scope||'global',subject_key:packet.subject_key,value:packet.value,observation_id:id,source_hash:sourceHash,source_refs:[{observation_id:id,session_id:packet.session_id,chunk_id:packet.chunk_id}],metadata:{...(packet.metadata||{}),explicit_preference:true}},by);
    });
  }
  propose(input,by) {
    require('./memory-identity').assertReadable(this.db);
    actor(by,['operator','host','agent','provider']);safe(input);
    exact(input,['kind','operator_id','project_id','mission_id','run_id','scope','subject_key','value','observation_id','source_hash','source_refs','metadata']);
    if(input.operator_id!==this.store.operatorId)throw new Error('Wrong operator scope');
    if(!KINDS.has(input.kind)||!['global','project_specific'].includes(input.scope)||input.scope==='project_specific'&&!input.project_id)throw new Error('Invalid memory scope/type');
    string(input.subject_key,240);if(Buffer.byteLength(json(input.value))>12000)throw new Error('Memory claim too large');
    if(!/^[a-f0-9]{64}$/.test(input.source_hash))throw new Error('Source hash required');
    if(!Array.isArray(input.source_refs)||input.source_refs.length>12)throw new Error('Bounded source references required');
    if(by.type==='operator'&&input.operator_id!==by.id)throw new Error('Wrong operator preference');
    if(input.mission_id){const m=this.store.getMission(input.mission_id);if(!m||m.project_id!==input.project_id)throw new Error('Candidate mission scope mismatch');}
    // Idempotency compares the erasable payload while it exists. The immutable
    // identity is opaque; it must never be a digest of a personal claim.
    const replay=this.db.prepare('SELECT id FROM authority_memory_candidates WHERE kind=? AND operator_id=? AND project_id IS ? AND scope=? AND subject_key=? AND value_json=? AND source_hash=? AND source_refs_json=? AND metadata_json=? AND observation_id IS ? AND mission_id IS ? AND run_id IS ?').get(input.kind,input.operator_id,input.project_id||null,input.scope,input.subject_key,json(input.value),input.source_hash,json(input.source_refs),json(input.metadata||{}),input.observation_id||null,input.mission_id||null,input.run_id||null);
    const id=replay?.id||randomUUID();
    return transaction(this.db,()=>{
      const prior=this.candidate(id);if(prior)return prior;
      this.db.prepare("INSERT INTO authority_memory_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'candidate',NULL,?,?,NULL,NULL,?,NULL,?)").run(id,input.project_id||null,input.mission_id||null,input.run_id||null,input.observation_id||null,input.kind,input.operator_id,input.scope,input.subject_key,json(input.value),input.source_hash,json(input.source_refs),by.type,by.id,this.store.now(),json(input.metadata||{}));
      this.store.referenceEvent('memory.proposed',id,input,this.context(by,input.project_id));return this.candidate(id);
    });
  }
  promote(id,options={},by) {
    actor(by,['operator','host']);exact(options,['supersedes_id','privacy','assurance','canonical_priority','domains','expires_at','ttl_ms','reverify_task_classes','source_type','canonical_confirmation','acceptance_id']);safe(options);
    return transaction(this.db,()=>{
      const c=this.candidate(id);if(!c)throw new Error('Unknown candidate');
      if(by.type==='operator'&&c.operator_id!==by.id)throw new Error('Wrong operator preference');
      if(c.status==='promoted')return this.get(c.promoted_memory_id);
      if(c.status!=='candidate')throw new Error('Candidate is not promotable');
      const observation=c.observation_id?this.store.one('observations',c.observation_id):null;
      if(observation&&(observation.operator_id!==c.operator_id||observation.source_hash!==c.source_hash))throw new Error('Candidate provenance mismatch');
      const explicit=observation?.speaker==='operator'&&explicitPreference(c.subject_key,c.value,observation.claim);
      if(by.type==='host'&&!(c.kind==='personal_preference'&&explicit)&&!(c.kind==='mission_episodic'&&options.acceptance_id))throw new Error('Host promotion policy denied');
      if(c.kind==='architecture'&&(!options.canonical_confirmation||typeof options.canonical_confirmation!=='object'||!options.canonical_confirmation.reference||!/^[a-f0-9]{64}$/.test(options.canonical_confirmation.source_hash)||options.canonical_confirmation.source_hash!==c.source_hash))throw new Error('Canonical confirmation or operator Decision required');
      if(c.kind==='mission_episodic')this.acceptedEpisodeSource(options.acceptance_id,c.mission_id,c.run_id);
      if(options.ttl_ms!==undefined&&(!Number.isSafeInteger(options.ttl_ms)||options.ttl_ms<1)||options.expires_at!==undefined&&(!Number.isSafeInteger(options.expires_at)||options.expires_at<=this.store.now()))throw new Error('Invalid memory freshness boundary');
      if(options.reverify_task_classes!==undefined&&(!Array.isArray(options.reverify_task_classes)||options.reverify_task_classes.length>20||options.reverify_task_classes.some(x=>typeof x!=='string'||!x)))throw new Error('Typed reverification classes required');
      const privacy=options.privacy||'internal',assurance=options.assurance??(explicit?2:1);
      if(!PRIVACY.includes(privacy)||!Number.isInteger(assurance)||assurance<0||assurance>3)throw new Error('Invalid assurance/privacy');
      const active=this.db.prepare("SELECT * FROM authority_memories WHERE kind=? AND operator_id=? AND project_id IS ? AND scope=? AND subject_key=? AND status='active'").get(c.kind,c.operator_id,c.project_id,c.scope,c.subject_key);
      const domains=options.domains||c.metadata.domains||[c.subject_key.split('.')[0]];
      if(!Array.isArray(domains)||!domains.length||domains.some(d=>typeof d!=='string'||!d||d.length>80))throw new Error('Typed memory domains required');
      if(active&&options.supersedes_id!==active.id){
        const conflict=this.db.prepare('SELECT id FROM authority_memory_conflicts WHERE operator_id=? AND project_id IS ? AND subject_key=? AND memory_ids_json=? AND candidate_ids_json=? AND resolution_required=1').get(c.operator_id,c.project_id,c.subject_key,json([active.id]),json([c.id]));
        const conflictId=conflict?.id||randomUUID();
        this.db.prepare('INSERT OR IGNORE INTO authority_memory_conflicts VALUES(?,?,?,?,?,?,?,1,?,NULL,NULL)').run(conflictId,c.project_id,c.operator_id,c.subject_key,json([active.id]),json([c.id]),json(domains),this.store.now());
        this.store.referenceEvent('memory.conflict',conflictId,{candidate_id:c.id,memory_id:active.id},this.context(by,c.project_id));return {status:'conflict',conflict_id:conflictId};
      }
      if(options.supersedes_id&&!active)throw new Error('Supersession target is not current');
      const memoryId=randomUUID(),now=this.store.now();
      // Deactivate first to satisfy the one-active-record constraint. Deferred
      // back-reference is populated only after the replacement exists.
      if(active)this.db.prepare("UPDATE authority_memories SET status='superseded',effective_until=? WHERE id=?").run(now,active.id);
      const record={id:memoryId,kind:c.kind,project_id:c.project_id,operator_id:c.operator_id,scope:c.scope,subject_key:c.subject_key,value:c.value,source_hash:c.source_hash,source_refs:c.source_refs,privacy,assurance,domains};
      const cols={id:memoryId,kind:c.kind,project_id:c.project_id,operator_id:c.operator_id,scope:c.scope,subject_key:c.subject_key,value_json:json(c.value),source_type:options.source_type||'conversation_observation',source_hash:c.source_hash,source_refs_json:json(c.source_refs),candidate_id:c.id,assurance,privacy,status:'active',revision:(active?.revision||0)+1,effective_from:now,effective_until:null,last_verified_at:now,ttl_ms:options.ttl_ms||null,expires_at:options.expires_at||null,reverify_task_classes_json:json(options.reverify_task_classes||[]),domains_json:json(domains),canonical_priority:options.canonical_priority||0,supersedes_id:active?.id||null,superseded_by_id:null,created_by_actor_type:c.proposed_by_actor_type,created_by_actor_id:c.proposed_by_actor_id,approved_by_actor_type:by.type,approved_by_actor_id:by.id,created_at:now,content_hash:canonicalHash(record),metadata_json:json(c.metadata)};
      const fields=Object.keys(cols);this.db.prepare(`INSERT INTO authority_memories(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...Object.values(cols));
      if(active){this.db.prepare('UPDATE authority_memories SET superseded_by_id=? WHERE id=?').run(memoryId,active.id);this.store.referenceEvent('memory.superseded',active.id,{replacement:memoryId},this.context(by,c.project_id));}
      this.db.prepare("UPDATE authority_memory_candidates SET status='promoted',promoted_memory_id=?,reviewed_by_actor_type=?,reviewed_by_actor_id=?,reviewed_at=? WHERE id=?").run(memoryId,by.type,by.id,now,id);
      if(active)for(const conflict of this.db.prepare('SELECT * FROM authority_memory_conflicts WHERE operator_id=? AND project_id IS ? AND subject_key=? AND resolution_required=1').all(c.operator_id,c.project_id,c.subject_key)){
        this.db.prepare('UPDATE authority_memory_conflicts SET resolution_required=0,resolved_at=?,resolution_json=? WHERE id=?').run(now,json({superseded:active.id,replacement:memoryId}),conflict.id);
        this.store.referenceEvent('memory.conflict_resolved',conflict.id,{replacement:memoryId},this.context(by,c.project_id));
      }
      this.store.referenceEvent('memory.approved',memoryId,record,this.context(by,c.project_id));return this.get(memoryId);
    });
  }
  reject(id,by) { actor(by,['operator']);return transaction(this.db,()=>{const c=this.candidate(id);if(!c||c.operator_id!==by.id||c.status!=='candidate')throw new Error('Candidate rejection denied');this.db.prepare("UPDATE authority_memory_candidates SET status='rejected',reviewed_by_actor_type=?,reviewed_by_actor_id=?,reviewed_at=? WHERE id=?").run(by.type,by.id,this.store.now(),id);for(const conflict of this.db.prepare('SELECT * FROM authority_memory_conflicts WHERE operator_id=? AND resolution_required=1').all(by.id)){if(JSON.parse(conflict.candidate_ids_json).length===1&&JSON.parse(conflict.candidate_ids_json)[0]===id){this.db.prepare('UPDATE authority_memory_conflicts SET resolution_required=0,resolved_at=?,resolution_json=? WHERE id=?').run(this.store.now(),json({rejected_candidate:id}),conflict.id);this.store.referenceEvent('memory.conflict_resolved',conflict.id,{rejected_candidate:id},this.context(by,c.project_id));}}this.store.referenceEvent('memory.proposed',id,{rejected:true},this.context(by,c.project_id));return this.candidate(id);}); }
  forget(id,by) {
    actor(by,['operator']);const m=this.get(id);if(!m||m.operator_id!==by.id)throw new Error('Memory scope denied');
    erasure.mark(this.db,{store:'governed',identity:id,scope_hash:erasure.scopeHash([m.operator_id,m.project_id,m.scope]),erased_at:this.store.now()});
    return transaction(this.db,()=>{this.db.prepare("UPDATE authority_memories SET status='forgotten',effective_until=? WHERE id=?").run(this.store.now(),id);this.store.referenceEvent('memory.forgotten',id,{status:'forgotten'},this.context(by,m.project_id));erasure.progress(this.db,'governed',id,'suppressed_immutable_retention',this.store.now());return this.get(id);});
  }
  // Operator erasure preserves metadata, not personal historical payloads.
  erase(id,by) {
    actor(by,['operator']);const m=this.db.prepare('SELECT * FROM authority_memories WHERE id=?').get(id);
    if(!m||m.operator_id!==by.id)throw Error('Memory scope denied');
    const marker=erasure.mark(this.db,{store:'governed',identity:id,scope_hash:erasure.scopeHash([m.operator_id,m.project_id,m.scope]),action:'operator_erasure',erased_at:this.store.now()});
    try {
      require('./memory-content-erasure').propagate(this.db,marker,{now:this.store.now(),beforeApply:()=>{
        // A restored row may already have an authoritative replay disposition.
        // Only this host redaction transaction may apply its privacy transition.
        if(JSON.parse(m.value_json)?.content_state!=='erased'){
          this.db.prepare("UPDATE authority_memories SET status='forgotten',effective_until=?,value_json='null',subject_key='[erased]',source_refs_json='[]',metadata_json='{}' WHERE id=?").run(marker.erased_at,id);
          this.db.prepare("UPDATE authority_memory_candidates SET value_json='null',subject_key='[erased]',source_refs_json='[]',metadata_json='{}' WHERE promoted_memory_id=?").run(id);
        }else if(m.status!=='forgotten'||m.effective_until!==marker.erased_at)this.db.prepare("UPDATE authority_memories SET status='forgotten',effective_until=? WHERE id=?").run(marker.erased_at,id);
      }});
      erasure.progress(this.db,'governed',id,'purged',this.store.now());
    } catch { erasure.progress(this.db,'governed',id,'retryable',this.store.now());throw Error('Governed erasure incomplete; retrieval suppressed'); }
    return {id,authority:false,logicalSuppression:true,immutableContentRetained:false,physicalErasure:false};
  }
  provenance(id,by) {
    actor(by,['operator']);const m=this.get(id);if(!m||m.operator_id!==by.id)throw new Error('Memory scope denied');
    if(m.erased)return {memory:m,candidate:null,observation:null,authority:false,immutableContentRetained:false};
    const candidate=m.candidate_id?this.candidate(m.candidate_id):null,observation=candidate?.observation_id?this.store.one('observations',candidate.observation_id):null;
    return {memory:m,candidate,observation,authority:false};
  }
  erasureStatus(id,by) {
    actor(by,['operator']);const row=this.db.prepare('SELECT operator_id FROM authority_memories WHERE id=?').get(id);
    if(!row||row.operator_id!==by.id)throw Error('Memory scope denied');
    return this.db.prepare("SELECT p.generation,p.state,p.safe_error_class,p.updated_at FROM memory_erasure_content_progress p WHERE p.store='governed' AND p.identity=? ORDER BY p.generation").all(id);
  }
  eligibility(m,input,now) {
    if(m.operator_id!==input.operator_id)return 'wrong_operator';
    if(m.project_id&&m.project_id!==input.project_id)return 'cross_project';
    const marker=erasure.marker(this.db,'governed',m.id);if(marker)return marker.action==='expiry'?'expired':'forgotten';
    if(m.kind==='personal_preference'&&input.include_personal!==true)return 'personal_opt_in_required';
    if(m.status!=='active')return m.status;
    if(m.expires_at!==null&&m.expires_at<=now||m.ttl_ms!==null&&(!m.last_verified_at||m.last_verified_at+m.ttl_ms<=now))return 'expired';
    if(PRIVACY.indexOf(m.privacy)>PRIVACY.indexOf(input.privacy||'internal'))return 'privacy';
    if(m.assurance<(input.required_assurance||0))return 'assurance';
    if(!['canonical_doc','operator_decision','conversation_observation','accepted_mission','legacy_approved'].includes(m.source_type))return 'source_trust';
    if(m.reverify_task_classes.includes(input.task_class)&&(!input.verified_sources?.[m.id]||input.verified_sources[m.id]!==m.source_hash))return 'reverification_required';
    return null;
  }
  build(input,by=this.store.host) {
    require('./memory-identity').assertReadable(this.db);
    require('./memory-content-erasure').assertReadable(this.db);
    actor(by);safe(input);
    if(!PRIVACY.includes(input.privacy||'internal')||input.operator_id!==this.store.operatorId)throw new Error('Context owner/privacy denied');
    const now=this.store.now(),domains=input.domains||[],required=input.required_keys||[];
    if(input.mission_id){const mission=this.store.getMission(input.mission_id);if(!mission||mission.project_id!==(input.project_id||null)||mission.current_revision!==input.mission_revision)throw new Error('Context mission lineage mismatch');}
    if(input.run_id){const run=this.store.one('runs',input.run_id);if(!run||run.mission_id!==input.mission_id||run.mission_revision!==input.mission_revision)throw new Error('Context run lineage mismatch');}
    transaction(this.db,()=>{for(const m of this.db.prepare("SELECT * FROM authority_memories WHERE status='active' AND (expires_at<=? OR last_verified_at+ttl_ms<=?)").all(now,now)){
      erasure.mark(this.db,{store:'governed',identity:m.id,scope_hash:erasure.scopeHash([m.operator_id,m.project_id,m.scope]),action:'expiry',erased_at:now});
      this.db.prepare("UPDATE authority_memories SET status='expired',effective_until=? WHERE id=?").run(now,m.id);this.store.referenceEvent('memory.expired',m.id,{expired_at:now},this.context(this.store.host,m.project_id));
    }});
    const conflicts=this.db.prepare('SELECT * FROM authority_memory_conflicts WHERE operator_id=? AND resolution_required=1 AND (project_id IS NULL OR project_id=?)').all(input.operator_id,input.project_id||null).map(parse);
    const relevant=conflicts.filter(c=>required.includes(c.subject_key)||c.affected_domains.some(d=>domains.includes(d)));
    if(relevant.length)return {state:'WAIT',reason:'memory_conflict',conflict_ids:relevant.map(c=>c.id)};
    const all=this.db.prepare('SELECT * FROM authority_memories WHERE operator_id=? AND (project_id IS NULL OR project_id=?) ORDER BY subject_key,id').all(input.operator_id,input.project_id||null).map(parse);
    const excluded=[],eligible=[];
    for(const m of all){const reason=this.eligibility(m,input,now);if(reason)excluded.push({memory_id:m.id,subject_key:m.subject_key,reason});else eligible.push(m);}
    for(let i=eligible.length-1;i>=0;i--){const m=eligible[i];if(m.kind==='personal_preference'&&m.scope==='global'&&eligible.some(x=>x.kind===m.kind&&x.scope==='project_specific'&&x.subject_key===m.subject_key)){excluded.push({memory_id:m.id,subject_key:m.subject_key,reason:'project_preference_override'});eligible.splice(i,1);}}
    if(all.some(m=>m.kind==='project_operational'&&m.domains.some(d=>domains.includes(d))&&['expired','reverification_required'].includes(this.eligibility(m,input,now))))return {state:'WAIT',reason:'operational_memory_requires_reverification',excluded};
    if(required.some(key=>!eligible.some(m=>m.subject_key===key)))return {state:'WAIT',reason:'required_memory_ineligible',excluded};
    const terms=(input.query||'').toLowerCase().split(/\W+/).filter(x=>x.length>2);
    const rank=m=>[required.includes(m.subject_key)?1:0,m.kind==='architecture'?1:0,m.domains.filter(d=>domains.includes(d)).length,terms.filter(t=>(m.subject_key+' '+json(m.value)).toLowerCase().includes(t)).length,m.assurance,m.canonical_priority,m.last_verified_at||0];
    eligible.sort((a,b)=>{const x=rank(a),y=rank(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return y[i]-x[i];return a.id<b.id?-1:a.id>b.id?1:0;});
    let bytes=2;const items=[];const maxBytes=Math.min(input.max_bytes||8000,8000),maxItems=Math.min(input.max_items||20,20);
    for(const m of eligible){const item={memory_id:m.id,kind:m.kind,scope:m.scope,project_id:m.project_id,subject_key:m.subject_key,value:m.value,source_hash:m.source_hash,source_refs:m.source_refs,assurance:m.assurance,privacy:m.privacy,status:m.status,revision:m.revision,supersedes_id:m.supersedes_id,superseded_by_id:m.superseded_by_id,expires_at:m.expires_at,ttl_ms:m.ttl_ms,last_verified_at:m.last_verified_at,canonical_priority:m.canonical_priority,reverify_task_classes:m.reverify_task_classes,reverification_satisfied:!m.reverify_task_classes.includes(input.task_class)||input.verified_sources?.[m.id]===m.source_hash};
      const n=Buffer.byteLength(json(item))+1;if(items.length>=maxItems||bytes+n>maxBytes){excluded.push({memory_id:m.id,subject_key:m.subject_key,reason:'budget'});continue;}items.push(item);bytes+=n;
    }
    if(required.some(key=>!items.some(m=>m.subject_key===key)))return {state:'WAIT',reason:'required_memory_budget'};
    const content={version:1,project_id:input.project_id||null,mission_id:input.mission_id||null,mission_revision:input.mission_revision||null,operator_id:input.operator_id,retrieval_policy_version:RETRIEVAL_POLICY,privacy:input.privacy||'internal',items};
    const hash=canonicalHash(content),replay=this.db.prepare('SELECT id FROM authority_context_pack_manifests WHERE mission_id IS ? AND run_id IS ? AND context_hash=?').get(input.mission_id||null,input.run_id||null,hash),id=replay?.id||randomUUID();
    return transaction(this.db,()=>{
      const existing=this.store.one('context_pack_manifests',id);if(existing)return {state:'ready',...existing,items:this.items(id)};
      const manifest={...content,excluded,bytes,input:{...input,run_id:null},authority:false};
      this.db.prepare('INSERT INTO authority_context_pack_manifests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.project_id||null,input.mission_id||null,input.mission_revision||null,input.task_id||null,input.run_id||null,input.operator_id,content.privacy,RETRIEVAL_POLICY,hash,json(manifest),now);
      for(const [i,item]of items.entries())this.db.prepare('INSERT INTO authority_context_pack_items VALUES(?,?,?,?)').run(id,i,item.memory_id,json(item));
      this.store.referenceEvent('context.created',id,{context_hash:hash},this.context(by,input.project_id));return {state:'ready',...this.store.one('context_pack_manifests',id),items};
    });
  }
  items(id) { require('./memory-identity').assertReadable(this.db);require('./memory-content-erasure').assertReadable(this.db);return this.db.prepare('SELECT memory_id,snapshot_json FROM authority_context_pack_items WHERE context_pack_id=? ORDER BY ordinal').all(id).map(r=>this.store.privacyProjection({memory_id:r.memory_id,...JSON.parse(r.snapshot_json)})); }
  validatePack(id,input) {
    const pack=this.store.one('context_pack_manifests',id);if(!pack||pack.operator_id!==input.operator_id||pack.project_id!==(input.project_id||null))return {valid:false,reason:'context_scope'};
    const rebuilt=this.build({...pack.manifest.input,...input},this.store.host);return {valid:rebuilt.state==='ready'&&rebuilt.context_hash===pack.context_hash,reason:rebuilt.reason||'context_changed'};
  }
  diff(fromId,toId,by) {
    actor(by,['operator']);const from=this.store.one('context_pack_manifests',fromId),to=this.store.one('context_pack_manifests',toId);
    if(!from||!to||from.operator_id!==by.id||to.operator_id!==by.id||from.project_id!==to.project_id)throw new Error('Context diff scope denied');
    const key=m=>[m.kind,m.scope,m.project_id,m.subject_key].join(':'),a=new Map(this.items(fromId).map(m=>[key(m),m])),b=new Map(this.items(toId).map(m=>[key(m),m]));const changes=[];
    for(const k of [...new Set([...a.keys(),...b.keys()])].sort()){const old=a.get(k),current=b.get(k),fields=old&&current?Object.keys(current).filter(f=>json(old[f]??null)!==json(current[f]??null)):[];if(!old||!current||fields.length){const significant=[];if(fields.includes('privacy')||old?.privacy!==current?.privacy)significant.push('PRIVACY_SIGNIFICANT');if(/provider\..*activation|policy/.test((old||current).subject_key))significant.push('POLICY_SIGNIFICANT');if(/plaid|security|credential/.test((old||current).subject_key))significant.push('SECURITY_SIGNIFICANT');if(fields.some(f=>['assurance','source_hash','canonical_priority'].includes(f)))significant.push('AUTHORITY_SIGNIFICANT');changes.push({key:k,kind:!old?'added':!current?'removed':'changed',fields,from:old||null,to:current||null,significance:significant,exclusion:to.manifest.excluded.find(x=>x.subject_key===(old||current).subject_key)||null});}}
    return transaction(this.db,()=>{const prior=this.db.prepare('SELECT id FROM authority_context_pack_diffs WHERE from_pack_id=? AND to_pack_id=?').get(fromId,toId);if(prior)return this.store.one('context_pack_diffs',prior.id);const id=randomUUID();this.db.prepare('INSERT INTO authority_context_pack_diffs VALUES(?,?,?,?,?,?)').run(id,fromId,toId,json(changes),canonicalHash(changes),this.store.now());this.store.referenceEvent('context.diffed',id,changes,this.context(by,to.project_id));return this.store.one('context_pack_diffs',id);});
  }
  acceptedEpisodeSource(acceptanceId,missionId,runId) {
    const a=this.store.one('acceptance_records',acceptanceId),m=a&&this.store.getMission(a.mission_id),v=a&&this.store.getVerification(a.verification_id),r=v&&this.store.getResult(v.result_id);
    if(!a||a.decision!=='accepted'||a.mission_id!==missionId||m.current_revision!==a.mission_revision||!v||v.mission_revision!==a.mission_revision||!['passed','operator_review'].includes(v.status)||!r||r.status!=='completed'||r.run_id!==runId||!v.evidence_manifest_hash)throw new Error('Accepted verified episode lineage required');
    const run=this.store.one('runs',runId),evidence=this.db.prepare('SELECT e.metadata_json FROM authority_verification_evidence v JOIN authority_evidence_records e ON e.id=v.evidence_id WHERE v.verification_id=? AND e.mission_id=? AND e.mission_revision=? AND e.run_id=? ORDER BY v.ordinal').all(v.id,m.id,a.mission_revision,runId).map(x=>JSON.parse(x.metadata_json));
    if(!run||run.mission_id!==m.id||run.mission_revision!==a.mission_revision||!evidence.length||canonicalHash(evidence)!==v.evidence_manifest_hash||!this.store.one('verification_records',v.id))throw new Error('Episode evidence/coordinate binding missing');
    return {a,m,v,r,run};
  }
  distill(acceptanceId,by=this.store.host) {
    actor(by,['host']);const a=this.store.one('acceptance_records',acceptanceId),v=a&&this.store.getVerification(a.verification_id),r=v&&this.store.getResult(v.result_id);
    const source=this.acceptedEpisodeSource(acceptanceId,a?.mission_id,r?.run_id),revision=this.store.getMissionRevision(source.m.id,a.mission_revision);
    const episode={objective:revision.objective,agent:source.run.agent_id,provider:source.run.provider_id,model_registry_id:source.run.model_registry_id,changed_domains:r.result.changed_domains||[],evidence_hash:v.evidence_manifest_hash,key_accepted_decisions:r.result.accepted_decisions||[],limitations:r.result.limitations||[],follow_up_dependencies:r.result.follow_up_dependencies||[],accepted_at:a.created_at};
    const c=this.propose({kind:'mission_episodic',operator_id:this.store.operatorId,project_id:source.m.project_id,mission_id:source.m.id,run_id:r.run_id,scope:source.m.project_id?'project_specific':'global',subject_key:`episode.${acceptanceId}`,value:episode,source_hash:canonicalHash({project:source.m.project_id,mission:source.m.id,run:r.run_id,acceptance:acceptanceId,version:1,evidence:v.evidence_manifest_hash}),source_refs:[{acceptance_id:acceptanceId,verification_id:v.id,result_id:r.id}],metadata:{schema_version:1}},by);
    return this.promote(c.id,{acceptance_id:acceptanceId,source_type:'accepted_mission',assurance:2,domains:['mission_history']},by);
  }
}
module.exports={AuthorityMemory,RETRIEVAL_POLICY,explicitPreference};
