'use strict';
const { randomUUID } = require('node:crypto');
const { transaction } = require('./control-transaction');
const { migrateAuthority, VERSION } = require('./authority-schema');
const { canonicalHash, canonicalSerialize, genesisHash, ledgerEnvelope, verifyLedgerChain } = require('./authority-hash');
const { containsSecret } = require('./personal-memory');
const { sensitiveKey } = require('./secret-observation');
const LOCAL_PROJECT = 'authority:local';
const erasure = require('./memory-erasure');
const REF_EVENTS = new Set(['instruction.added','constraint.added','decision.recorded','checkpoint.created','evidence.received','verification.completed','acceptance.recorded','memory.proposed','memory.approved','memory.superseded','memory.forgotten','memory.expired','memory.conflict','memory.conflict_resolved','context.created','context.diffed','routing.decided','activation.changed','migration.imported','grant.issued','grant.revoked','nonce.consumed','observation.recorded','runtime.updated','result.received','registry.updated']);
const json = value => Buffer.from(canonicalSerialize(value)).toString('utf8');
// Arbitrary content addressing is no longer an identity API. Kept only as a
// denied compatibility symbol; personal records use host-assigned UUIDs.
const hashId = () => { throw Error('Content-derived identity helper deprecated; use an opaque UUID'); };
function coordinateId(kind,coordinates) {
  const criterion=kind==='criterion'&&coordinates.length===3&&typeof coordinates[0]==='string'&&Number.isSafeInteger(coordinates[1])&&coordinates[1]>0&&Number.isSafeInteger(coordinates[2])&&coordinates[2]>=0;
  const nonce=kind==='nonce'&&coordinates.length===2&&coordinates.every(x=>typeof x==='string'&&x.length>0&&x.length<=160);
  if(criterion||nonce)return 'sha256:'+canonicalHash(coordinates);
  throw Error('Invalid non-content identity coordinates');
}
function parse(row) {
  if (!row) return null;
  const out = { ...row };
  for (const k of Object.keys(out)) if (k.endsWith('_json') && out[k] !== null) { out[k.slice(0,-5)] = JSON.parse(out[k]); delete out[k]; }
  return out;
}
function safe(value) {
  canonicalSerialize(value);
  // Validated digest fields are not payment-card numbers. Keep scanning all
  // free text and values; only typed digests and opaque coordinates are exempt.
  const inspection=(x,parent)=>Array.isArray(x)?x.map(v=>inspection(v,parent)):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>parent==='permissions'&&k==='secrets'&&Array.isArray(v)&&v.every(flag=>['use','production'].includes(flag))?['restricted_permission_dimension',v]:[k,typeof v==='string'&&((/(?:^|_)hash$/.test(k)&&/^[a-f0-9]{64}$/.test(v))||(/(?:^|_)(?:id|ref)$|^memoryId$|^taskId$|^runId$/.test(k)&&/^(?:sha256:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(v))||(x===value&&x.kind==='mission_episodic'&&k==='subject_key'&&/^episode\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)))?'[opaque coordinate]':inspection(v,k)])):x;
  const secret=x=>typeof x==='string'?(/^(?:(?:sha256|arch):)?[a-f0-9]{64}$/.test(x)?false:containsSecret(x)||/\b(?:xox[baprs]-|xapp-|sk-ant-|sk-proj-|sk-|crsr_)[A-Za-z0-9_-]{8,}/.test(x)||/\b(?:--(?:token|password)|[A-Z_]*(?:TOKEN|PASSWORD|API_KEY))\s+\S+/.test(x)||[...x.matchAll(/https?:\/\/[^\s<>"']+/g)].some(([u])=>{try{const url=new URL(u);return !!url.username||!!url.password||[...url.searchParams.keys()].some(sensitiveKey)||/token|secret|signature|credential/i.test(url.hash);}catch{return true;}})):Array.isArray(x)?x.some(secret):x&&typeof x==='object'?Object.entries(x).some(([k,v])=>sensitiveKey(k)||secret(v)):false;
  if (secret(inspection(value))) throw new Error('Sensitive authority data rejected');
  return value;
}
function actor(value, allowed = ['operator','host']) {
  if (!value || !allowed.includes(value.type) || typeof value.id !== 'string' || !value.id) throw new Error('Authority actor denied');
  return value;
}
function payload(kind, value) {
  if (value?.version !== 1) throw new Error('Unsupported ledger payload version');
  let fields;
  if (REF_EVENTS.has(kind)) fields=['version','reference_id','content_hash'];
  else if (['mission.created','mission.revised'].includes(kind)) fields=['version','mission_id','revision','content_hash'];
  else if (kind === 'mission.state_changed') fields=['version','mission_id','state','previous'];
  else if (kind === 'acceptance.requested') fields=['version','mission_id','revision'];
  else if (kind === 'runtime.started') fields=['version','run_id','agent_id'];
  else if (['runtime.failed','runtime.cancelled'].includes(kind)) fields=['version','run_id','reason'];
  else throw new Error('Unknown authority event');
  if (Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value,k))) throw new Error('Invalid typed ledger payload');
  for (const k of fields.filter(k => !['version','revision'].includes(k))) if (typeof value[k] !== 'string' || !value[k] || value[k].length > 500) throw new Error('Invalid ledger field');
  if (Object.hasOwn(value,'revision') && (!Number.isSafeInteger(value.revision) || value.revision < 1)) throw new Error('Invalid ledger revision');
  if (value.content_hash && !/^[a-f0-9]{64}$/.test(value.content_hash)) throw new Error('Invalid ledger digest');
  return safe(value);
}
class AuthorityStore {
  constructor(db, { now = Date.now, operatorId = 'local-operator', restoreFromBackup = false, erasureSourceDb = null } = {}) {
    this.db=db; this.now=now; this.operatorId=operatorId;
    this.operator=Object.freeze({type:'operator',id:operatorId}); this.host=Object.freeze({type:'host',id:'authority-plane'});
    migrateAuthority(db,this.now());
    if (typeof restoreFromBackup !== 'boolean') throw Error('Invalid restore policy');
    erasure.migrate(db);
    for (const row of db.prepare("SELECT * FROM authority_memories WHERE status IN ('forgotten','expired')").all()) if (!erasure.marker(db,'governed',row.id)) {
      erasure.mark(db,{store:'governed',identity:row.id,scope_hash:erasure.scopeHash([row.operator_id,row.project_id,row.scope]),action:row.status==='expired'?'expiry':'forget',erased_at:row.effective_until||this.now()});
      erasure.progress(db,'governed',row.id,'suppressed_immutable_retention',this.now());
    }
    if (restoreFromBackup) {
      erasure.reconcile(db, erasureSourceDb);
      for(const restored of db.prepare("SELECT * FROM authority_memories WHERE status='active'").all()) {
        if(erasure.marker(db,'governed',restored.id))continue;
        const prior=erasureSourceDb.prepare('SELECT * FROM authority_memories WHERE id=?').get(restored.id);
        if(!prior)throw Error('Restore requires current authoritative memory identity');
        if(restored.operator_id!==prior.operator_id||restored.project_id!==prior.project_id||restored.scope!==prior.scope)throw Error('Restore supersession scope mismatch');
        if(['kind','subject_key','value_json','content_hash','source_type','source_hash','source_refs_json','candidate_id','metadata_json','privacy','assurance','domains_json','reverify_task_classes_json','canonical_priority'].some(key=>restored[key]!==prior[key]))throw Error('Restore memory identity content mismatch');
        const successor=prior.superseded_by_id&&db.prepare('SELECT 1 FROM authority_memories WHERE id=?').get(prior.superseded_by_id)?prior.superseded_by_id:null;
        if(prior.status==='superseded')db.prepare("UPDATE authority_memories SET status='superseded',superseded_by_id=?,effective_until=? WHERE id=? AND status='active'").run(successor,prior.effective_until,prior.id);
      }
      for (const prior of erasureSourceDb.prepare('SELECT id,operator_id,project_id,scope,expires_at,ttl_ms,last_verified_at FROM authority_memories').all()) {
        const restored = db.prepare('SELECT * FROM authority_memories WHERE id=?').get(prior.id);
        if (!restored) continue;
        if (erasure.scopeHash([prior.operator_id,prior.project_id,prior.scope]) !== erasure.scopeHash([restored.operator_id,restored.project_id,restored.scope])) throw Error('Restore governed scope mismatch');
        if(erasure.marker(db,'governed',prior.id)?.action==='operator_erasure')continue;
        const deadlines = [prior.expires_at,prior.ttl_ms === null ? null : prior.last_verified_at + prior.ttl_ms,restored.expires_at].filter(x => x !== null);
        if (deadlines.length) db.prepare('UPDATE authority_memories SET expires_at=? WHERE id=?').run(Math.min(...deadlines), prior.id);
      }
      for (const marker of db.prepare("SELECT * FROM memory_erasure_markers WHERE store='governed'").all()) {
        const restored = db.prepare('SELECT * FROM authority_memories WHERE id=?').get(marker.identity);
        if (!restored) continue;
        if (erasure.scopeHash([restored.operator_id,restored.project_id,restored.scope]) !== marker.scope_hash) throw Error('Restore governed erasure scope mismatch');
        // Operator payload purge and suppression run inside the canonical host
        // redaction transaction. Constructor writes must obey replay guards.
        // A later operator erasure dominates an earlier forget/expiry marker.
        // Its retained-row replay guard must remain intact; only canonical
        // host redaction may modify that row during restore.
        if(erasure.marker(db,'governed',marker.identity)?.action==='operator_erasure')continue;
        db.prepare("UPDATE authority_memories SET status='forgotten',effective_until=? WHERE id=?").run(marker.erased_at, marker.identity);
      }
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS governed_erased_insert BEFORE INSERT ON authority_memories
      WHEN new.status='active' AND EXISTS(SELECT 1 FROM memory_erasure_markers WHERE store='governed' AND identity=new.id)
      BEGIN SELECT RAISE(ABORT,'Erased governed replay denied'); END;
      CREATE TRIGGER IF NOT EXISTS governed_erased_update BEFORE UPDATE ON authority_memories
      WHEN new.status='active' AND EXISTS(SELECT 1 FROM memory_erasure_markers WHERE store='governed' AND identity=new.id)
      BEGIN SELECT RAISE(ABORT,'Erased governed replay denied'); END;`);
    this.db.prepare("INSERT OR IGNORE INTO authority_projects VALUES(?,?,'Local Harness authority','active',?,?)").run(LOCAL_PROJECT,LOCAL_PROJECT,this.now(),this.now());
  }
  one(table,id) {
    require('./memory-identity').assertReadable(this.db);
    if(!['memories','memory_candidates','observations'].includes(table))require('./memory-content-erasure').assertReadable(this.db);
    const result = parse(this.db.prepare(`SELECT * FROM authority_${table} WHERE id=?`).get(id));
    if (!result) return result;
    const marker = table === 'memories' ? erasure.marker(this.db, 'governed', id) : null;
    if (marker && marker.action !== 'operator_erasure') return { ...result, status: marker.action === 'expiry' ? 'expired' : 'forgotten' };
    if (marker?.action === 'operator_erasure') return { ...erasure.redacted(result), operator_id: result.operator_id, project_id: result.project_id, scope: result.scope };
    if (table === 'memory_candidates' && result.promoted_memory_id && erasure.marker(this.db, 'governed', result.promoted_memory_id)?.action === 'operator_erasure') return erasure.redacted(result);
    if (table === 'observations' && this.db.prepare("SELECT 1 FROM authority_memory_candidates c JOIN memory_erasure_markers e ON e.identity=c.promoted_memory_id AND e.store='governed' AND e.action='operator_erasure' WHERE c.observation_id=?").get(id)) return erasure.redacted(result);
    if (table === 'memory_conflicts' && (result.memory_ids || []).some(ref => erasure.marker(this.db,'governed',ref)?.action === 'operator_erasure')) return erasure.redacted(result);
    return this.privacyProjection(result);
  }
  privacyProjection(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => this.privacyProjection(v));
    const id = value.memory_id || value.memoryId;
    if (id && (erasure.marker(this.db, 'governed', id)?.action === 'operator_erasure' || erasure.marker(this.db, 'personal', id)?.action === 'operator_erasure')) return erasure.redacted(value);
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,this.privacyProjection(v)]));
  }
  rows(table,missionId) { require('./memory-identity').assertReadable(this.db);require('./memory-content-erasure').assertReadable(this.db);return this.db.prepare(`SELECT * FROM authority_${table} WHERE mission_id=? ORDER BY created_at,id`).all(missionId).map(parse); }
  getProject(id) { return this.one('projects',id); }
  getMission(id) { return this.one('missions',id); }
  getMissionRevision(id,revision) { require('./memory-identity').assertReadable(this.db);require('./memory-content-erasure').assertReadable(this.db);return parse(this.db.prepare('SELECT * FROM authority_mission_revisions WHERE mission_id=? AND revision=?').get(id,revision)); }
  listMissionCriteria(id,revision) { require('./memory-identity').assertReadable(this.db);return this.db.prepare('SELECT * FROM authority_acceptance_criteria WHERE mission_id=? AND mission_revision=? ORDER BY criterion_key').all(id,revision).map(parse); }
  listRunsForMission(id) { return this.withLegacy(this.rows('runs',id),'cp_runs',id); }
  getResult(id) { return this.one('results',id)||this.legacyOne('cp_run_results',id)||this.legacyOne('cp_result_inbox',id); }
  listResultsForMission(id) { return this.withLegacy(this.rows('results',id),'cp_run_results',id); }
  getVerification(id) { return this.one('verification_records',id)||this.legacyOne('cp_verifications',id); }
  listVerificationsForMission(id) { return this.withLegacy(this.rows('verification_records',id),'cp_verifications',id); }
  listAcceptancesForMission(id) { return this.withLegacy(this.rows('acceptance_records',id),'cp_acceptances',id); }
  getCheckpoint(id) { return this.one('checkpoints',id)||this.legacyOne('project_memory_v2_checkpoints',id); }
  legacyOne(table,id) {
    require('./memory-identity').assertReadable(this.db);
    const row=this.db.prepare('SELECT * FROM authority_legacy_records WHERE source_table=? AND source_id=?').get(table,id);
    return row?{id:row.source_id,source_table:table,binding_quality:'unresolved',execution_authority:false,legacy:JSON.parse(row.record_json),source_hash:row.source_hash}:null;
  }
  withLegacy(rows,table,missionId) {
    const historical=this.db.prepare("SELECT source_id FROM authority_legacy_records WHERE source_table=? AND json_extract(record_json,'$.mission_id')=? ORDER BY source_id").all(table,missionId);
    return [...rows,...historical.filter(r=>!rows.some(x=>x.id===r.source_id)).map(r=>this.legacyOne(table,r.source_id))];
  }
  checkpoint(input,by=this.host) {
    actor(by,['host']);safe(input);return transaction(this.db,()=>{
      const m=this.getMission(input.mission_id);if(!m||m.project_id!==input.project_id||m.current_revision!==input.mission_revision)throw new Error('Checkpoint lineage mismatch');
      for(const key of ['workspace_snapshot_hash','artifact_manifest_hash','context_pack_hash'])if(!/^[a-f0-9]{64}$/.test(input[key]))throw new Error('Checkpoint digest required');
      const projection=this.getCurrentMissionProjection(m.id),id=input.id||randomUUID(),cursor=this.db.prepare('SELECT max(sequence) n FROM authority_ledger_entries WHERE project_id=?').get(m.project_id).n||0;
      this.db.prepare('INSERT INTO authority_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,m.project_id,m.id,m.current_revision,input.run_id||null,cursor,canonicalHash(projection),input.workspace_snapshot_hash,input.artifact_manifest_hash,input.context_pack_hash,this.now(),by.type,by.id);
      this.referenceEvent('checkpoint.created',id,input,{projectId:m.project_id,missionId:m.id,revision:m.current_revision,by});return this.getCheckpoint(id);
    });
  }
  getRoutingPolicyVersion(id) { return this.one('routing_policy_versions',id); }
  getActiveArchitecture(projectId) { require('./memory-identity').assertReadable(this.db);return this.db.prepare("SELECT * FROM authority_memories WHERE kind='architecture' AND project_id=? AND status='active' ORDER BY subject_key,id").all(projectId).filter(r=>!erasure.marker(this.db,'governed',r.id)).map(parse); }
  listRuntimeCapabilities() { require('./memory-identity').assertReadable(this.db);return this.db.prepare('SELECT * FROM authority_runtime_capability_observations ORDER BY runtime_registry_id,capability_key,evaluated_at').all().map(parse); }
  readLedger(projectId,fromSequence=0,limit=100) {
    require('./memory-identity').assertReadable(this.db);
    require('./memory-content-erasure').assertReadable(this.db);
    if(!Number.isSafeInteger(fromSequence)||fromSequence<0||!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('Invalid ledger page');
    return this.db.prepare('SELECT * FROM authority_ledger_entries WHERE project_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(projectId,fromSequence,limit).map(parse);
  }
  append(kind, data, { projectId=LOCAL_PROJECT, missionId=null, revision=null, runId=null, by=this.host } = {}) {
    actor(by,['operator','host','agent','provider']); payload(kind,data);
    return transaction(this.db,()=>{
      const head=this.db.prepare('SELECT sequence,entry_hash FROM authority_ledger_entries WHERE project_id=? ORDER BY sequence DESC LIMIT 1').get(projectId);
      const entry={project_id:projectId,sequence:(head?.sequence||0)+1,entry_id:randomUUID(),mission_id:missionId,mission_revision:revision,run_id:runId,kind,actor_type:by.type,actor_id:by.id,payload_json:json(data),previous_hash:head?.entry_hash||genesisHash(projectId),timestamp:this.now()};
      entry.entry_hash=canonicalHash(ledgerEnvelope(entry));
      this.db.prepare('INSERT INTO authority_ledger_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(entry.project_id,entry.sequence,entry.entry_id,missionId,revision,runId,kind,by.type,by.id,entry.payload_json,entry.previous_hash,entry.entry_hash,entry.timestamp);
      this.db.prepare('INSERT INTO authority_ledger_heads VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET sequence=excluded.sequence,entry_hash=excluded.entry_hash').run(projectId,entry.sequence,entry.entry_hash);
      this.db.prepare('INSERT INTO authority_outbox_events(id,project_id,mission_id,event_type,payload_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?)').run(entry.entry_id,projectId,missionId,kind,json({entry_id:entry.entry_id,sequence:entry.sequence}),entry.entry_hash,this.now());
      return entry;
    });
  }
  referenceEvent(kind,id,value,context={}) { return this.append(kind,{version:1,reference_id:id,content_hash:canonicalHash({kind,reference_id:id})},context); }
  createProject(input,by=this.operator) {
    actor(by); safe(input);
    return transaction(this.db,()=>{
      const id=input.id||randomUUID(); const existing=this.getProject(id);if(existing)return existing;
      this.db.prepare('INSERT INTO authority_projects VALUES(?,?,?,?,?,?)').run(id,input.slug||id,input.name,input.status||'active',this.now(),this.now());
      this.referenceEvent('registry.updated',id,input,{projectId:id,by}); return this.getProject(id);
    });
  }
  createGoal(input,by=this.operator) {
    actor(by);safe(input);
    return transaction(this.db,()=>{
      const id=input.id||randomUUID();this.db.prepare('INSERT INTO authority_goals VALUES(?,?,?,?,?,?,?,?,?)').run(id,input.project_id,input.parent_goal_id||null,input.title,input.description||'',input.status||'active',1,this.now(),this.now());
      this.referenceEvent('registry.updated',id,input,{projectId:input.project_id,by});return this.one('goals',id);
    });
  }
  createMission(input,by=this.operator) {
    actor(by);safe(input);
    return transaction(this.db,()=>{
      const id=input.id||randomUUID();if(this.getMission(id))throw new Error('Mission already exists');
      this.db.prepare('INSERT INTO authority_missions VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,input.project_id||null,input.goal_id||null,input.task_id||null,input.owner||by.id,1,'ready',input.acceptance_strength||'criteria',this.now(),this.now());
      this.insertRevision(id,1,input.envelope,by,'exact'); return this.getMission(id);
    });
  }
  insertRevision(id,revision,envelope,by,quality) {
    // Historical envelopes are retained verbatim as non-authorizing snapshots.
    // Their repository manifests include secret-looking *filenames*, not secret
    // values. New requests still cross the strict admission boundary.
    if(quality==='legacy_snapshot')canonicalSerialize(envelope);else safe(envelope);
    const m=this.getMission(id),hash=canonicalHash(envelope);
    this.db.prepare('INSERT INTO authority_mission_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,revision,envelope.objective||'Legacy mission',envelope.task_type||'legacy',json(envelope),json(envelope.workspace_descriptor||{path:envelope.workspace||null}),json(envelope.context_manifest||{}),json(envelope.dispatch_policy||{}),json(envelope.capability_scopes||[]),json(envelope.constraints||''),envelope.policy_version||'legacy-v1',envelope.checkpoint_id||null,by.type,by.id,this.now(),hash,quality);
    for (const [i,criterion] of (envelope.criteria||[]).entries()) {
      const c=typeof criterion==='string'?{description:criterion}:criterion;
      this.db.prepare('INSERT INTO authority_acceptance_criteria VALUES(?,?,?,?,?,?,?,?,?,?)').run(coordinateId('criterion',[id,revision,i]),id,revision,c.key||c.id||String(i),c.type||'check',c.description||c.label||JSON.stringify(c),c.verification_method||'registered_verifier',c.target_hash||null,c.required===false?0:1,this.now());
    }
    this.append(revision===1?'mission.created':'mission.revised',{version:1,mission_id:id,revision,content_hash:hash},{projectId:m.project_id||LOCAL_PROJECT,missionId:id,revision,by});
  }
  reviseMission(id,envelope,expectedRevision,by=this.operator) {
    actor(by);return transaction(this.db,()=>{
      const m=this.getMission(id);if(!m||m.current_revision!==expectedRevision)throw new Error('Stale mission revision');
      if(this.db.prepare("SELECT 1 FROM authority_runs WHERE mission_id=? AND status IN('starting','running','verifying')").get(id))throw new Error('Active run prevents revision');
      this.insertRevision(id,expectedRevision+1,envelope,by,'exact');
      this.db.prepare("UPDATE authority_missions SET current_revision=?,current_state='ready',updated_at=? WHERE id=?").run(expectedRevision+1,this.now(),id);return this.getMission(id);
    });
  }
  setState(id,state,by=this.host) {
    actor(by);return transaction(this.db,()=>{
      const m=this.getMission(id);if(!m)throw new Error('Unknown mission');
      if(!['planned','dispatching','verifying','awaiting_acceptance','ready','running','waiting_for_operator','waiting_for_dependency','waiting_for_agent','verification','awaiting_orchestrator_acceptance','needs_rework','blocked','paused','cancelled','completed'].includes(state)||['completed','cancelled'].includes(m.current_state)&&m.current_state!==state)throw new Error('Invalid Mission state transition');
      if(state==='completed'&&!this.db.prepare("SELECT 1 FROM authority_acceptance_records WHERE mission_id=? AND mission_revision=? AND decision='accepted'").get(id,m.current_revision)&&this.getMissionRevision(id,m.current_revision).binding_quality!=='legacy_snapshot')throw new Error('Completion requires acceptance');
      this.db.prepare('UPDATE authority_missions SET current_state=?,updated_at=? WHERE id=?').run(state,this.now(),id);
      this.append('mission.state_changed',{version:1,mission_id:id,state,previous:m.current_state},{projectId:m.project_id||LOCAL_PROJECT,missionId:id,revision:m.current_revision,by});return this.getMission(id);
    });
  }
  startRun(input,by=this.host) {
    actor(by);safe(input);return transaction(this.db,()=>{
      const m=this.getMission(input.mission_id);if(!m||m.current_revision!==input.mission_revision)throw new Error('Run revision mismatch');
      const id=input.id||randomUUID(),agentId=input.agent_id==='claude_code'?'claude':input.agent_id;
      const runtimeId=input.runtime_id||agentId;
      this.db.prepare('INSERT OR IGNORE INTO authority_runtime_registry VALUES(?,?,?,?,1,0,?,?,?)').run(runtimeId,agentId,input.adapter_type||'existing',runtimeId,'1',this.now(),this.now());
      const instanceId=input.runtime_instance_id||`instance:${id}`;
      this.db.prepare("INSERT INTO authority_runtime_instances VALUES(?,?,NULL,'starting',NULL,?,NULL,NULL,'{}')").run(instanceId,runtimeId,this.now());
      this.db.prepare('INSERT INTO authority_runs(id,mission_id,mission_revision,task_id,agent_id,runtime_instance_id,model_registry_id,provider_id,status,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,m.id,m.current_revision,input.task_id||m.task_id,agentId,instanceId,input.model_registry_id||null,input.provider_id||null,'starting',this.now(),this.now(),this.now());
      this.append('runtime.started',{version:1,run_id:id,agent_id:agentId},{projectId:m.project_id||LOCAL_PROJECT,missionId:m.id,revision:m.current_revision,runId:id,by});return this.one('runs',id);
    });
  }
  recordResult(input,by=this.host) {
    actor(by);safe(input);return transaction(this.db,()=>{
      const run=this.one('runs',input.run_id);if(!run||run.mission_id!==input.mission_id||run.mission_revision!==input.mission_revision)throw new Error('Result lineage mismatch');
      const id=input.id||run.id, prior=this.getResult(id);const content={...input};delete content.id;
      if(Object.hasOwn(input,'accepted'))throw new Error('Acceptance is not a result field');
      if(prior){if(prior.content_hash!==canonicalHash(content))throw new Error('Result replay mismatch');return prior;}
      const runtime=this.one('runtime_instances',run.runtime_instance_id);
      this.db.prepare('INSERT INTO authority_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,run.mission_id,run.mission_revision,run.id,runtime.runtime_registry_id,run.model_registry_id,input.status,input.summary||'',input.checkpoint_id||null,canonicalHash(content),null,this.now(),json(content));
      this.db.prepare('UPDATE authority_runs SET status=?,finished_at=?,updated_at=? WHERE id=?').run(input.status==='completed'?'completed':'failed',this.now(),this.now(),run.id);
      const m=this.getMission(run.mission_id);this.referenceEvent('result.received',id,content,{projectId:m.project_id||LOCAL_PROJECT,missionId:m.id,revision:run.mission_revision,runId:run.id,by});return this.getResult(id);
    });
  }
  verifyResult(input,by=this.host) {
    actor(by);safe(input);return transaction(this.db,()=>{
      const result=this.one('results',input.result_id),m=result&&this.getMission(result.mission_id);
      if(!result||result.mission_id!==input.mission_id||result.mission_revision!==input.mission_revision||m.current_revision!==input.mission_revision)throw new Error('Verification lineage mismatch');
      const run=this.one('runs',result.run_id);if(input.verifier_id===run.id||input.verifier_type==='agent')throw new Error('Independent verifier required');
      const id=input.id||randomUUID(), evidence=input.evidence||[];
      if(!Array.isArray(evidence)||evidence.length>100||input.status==='passed'&&!evidence.length)throw new Error('Independent evidence required');
      const evidenceIds=new Map();
      for(const e of evidence){
        const digest=canonicalHash(e);if(evidenceIds.has(digest))throw new Error('Duplicate verification evidence');const eid=randomUUID();evidenceIds.set(digest,eid);
        this.db.prepare('INSERT INTO authority_evidence_records VALUES(?,?,?,?,?,NULL,NULL,?,?,?,NULL,?,NULL,NULL,NULL,NULL,?,?,?)').run(eid,m.project_id,m.id,m.current_revision,run.id,e.type||'independent_check',e.description||e.id||'Independent verification observation','host_verifier',digest,json(e),this.now(),this.now());
        this.referenceEvent('evidence.received',eid,e,{projectId:m.project_id||LOCAL_PROJECT,missionId:m.id,revision:m.current_revision,runId:run.id,by});
      }
      for(const c of input.criteria||[])if((c.evidence_refs||[]).some(h=>!evidenceIds.has(h)))throw new Error('Unknown criterion evidence');
      this.db.prepare('INSERT INTO authority_verification_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,m.id,m.current_revision,result.id,input.policy_version||'authority-v1',input.status,input.verifier_type||'host',input.verifier_id,this.now(),this.now(),input.summary||'',canonicalHash(evidence),this.now());
      for(const [i,eid]of [...evidenceIds.values()].entries())this.db.prepare('INSERT INTO authority_verification_evidence VALUES(?,?,?)').run(id,eid,i);
      for(const c of input.criteria||[])this.db.prepare('INSERT INTO authority_criterion_verifications VALUES(?,?,?,?,?,?,?)').run(id,c.criterion_id,m.id,m.current_revision,c.status,json((c.evidence_refs||[]).map(h=>evidenceIds.get(h))),c.reason||null);
      this.referenceEvent('verification.completed',id,input,{projectId:m.project_id||LOCAL_PROJECT,missionId:m.id,revision:m.current_revision,by});return this.getVerification(id);
    });
  }
  accept(input,by=this.operator,{transition=true}={}) {
    actor(by,['operator']);safe(input);return transaction(this.db,()=>{
      const m=this.getMission(input.mission_id),v=this.one('verification_records',input.verification_id);
      if(!m||!v||m.current_revision!==input.mission_revision||v.mission_id!==m.id||v.mission_revision!==m.current_revision)throw new Error('Stale or mismatched acceptance');
      if(m.current_state!=='awaiting_acceptance')throw new Error('Mission is not awaiting acceptance');
      if((!input.decision||input.decision==='accepted')&&(!['passed','operator_review'].includes(v.status)||v.status==='operator_review'&&!input.review_evidence?.length))throw new Error('Verification requires review');
      const criteria=this.listMissionCriteria(m.id,m.current_revision),checks=this.db.prepare('SELECT * FROM authority_criterion_verifications WHERE verification_id=?').all(v.id);
      if((!input.decision||input.decision==='accepted')&&criteria.some(c=>c.required&&!checks.some(v=>v.criterion_id===c.id&&(v.status==='passed'||v.status==='operator_review'&&input.review_evidence?.length))))throw new Error('Required criterion lacks verified evidence');
      const id=input.id||randomUUID();this.db.prepare('INSERT INTO authority_acceptance_records VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,m.id,m.current_revision,v.id,input.decision||'accepted',by.type,by.id,input.reason,json(input.review_evidence||[]),this.now());
      this.referenceEvent('acceptance.recorded',id,input,{projectId:m.project_id||LOCAL_PROJECT,missionId:m.id,revision:m.current_revision,by});
      if(transition)this.setState(m.id,(!input.decision||input.decision==='accepted')?'completed':input.decision==='rework_requested'?'needs_rework':'cancelled',by);return this.one('acceptance_records',id);
    });
  }
  issueGrant(input,by=this.host) {
    actor(by,['host']);const {signature_reference,...request}=input;safe(request);
    if(typeof signature_reference!=='string'||!/^broker:[A-Za-z0-9_.:-]{1,160}$/.test(signature_reference))throw new Error('Broker reference required');
    return transaction(this.db,()=>{
      if(!input.signature_reference||!input.capabilities?.length)throw new Error('Broker-bound grant required');
      const id=input.id||randomUUID();this.db.prepare('INSERT INTO authority_execution_grants VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,input.mission_id,input.mission_revision,input.run_id,by.id,input.policy_version,this.now(),input.expires_at,null,input.signature_reference,canonicalHash(input));
      for(const c of input.capabilities)this.db.prepare('INSERT INTO authority_execution_grant_capabilities VALUES(?,?,?)').run(id,c.capability,json(c.scope));
      this.referenceEvent('grant.issued',id,input);return this.one('execution_grants',id);
    });
  }
  revokeGrant(id,reason,by=this.host) {actor(by,['host']);safe({reason});return transaction(this.db,()=>{if(!this.one('execution_grants',id))throw new Error('Unknown grant');this.db.prepare('INSERT OR IGNORE INTO authority_grant_revocations VALUES(?,?,?)').run(id,this.now(),reason);this.referenceEvent('grant.revoked',id,{reason});return {revoked:true};});}
  consumeNonce(input,by=this.host) {
    actor(by,['host']);safe(input);return transaction(this.db,()=>{
      const g=this.one('execution_grants',input.grant_id),m=g&&this.getMission(g.mission_id);
      if(!g||g.run_id!==input.run_id||g.expires_at<=this.now()||g.revoked_at||this.db.prepare('SELECT 1 FROM authority_grant_revocations WHERE grant_id=?').get(g.id)||m.current_revision!==g.mission_revision)throw new Error('Grant expired or mismatched');
      this.db.prepare('INSERT INTO authority_consumed_nonces VALUES(?,?,?,?,?,?)').run(g.id,input.nonce,g.run_id,input.request_hash,this.now(),g.expires_at);
      this.referenceEvent('nonce.consumed',coordinateId('nonce',[g.id,input.nonce]),input);return {consumed:true};
    });
  }
  getCurrentMissionProjection(id) {
    const m=this.getMission(id);if(!m)throw new Error('Unknown mission');
    if(!this.getMissionRevision(id,m.current_revision))throw new Error('INTEGRITY_MISSING_REVISION');
    const events=this.db.prepare("SELECT kind,payload_json FROM authority_ledger_entries WHERE mission_id=? ORDER BY sequence").all(id);
    let projected=null,revision=null;
    for(const event of events){const p=JSON.parse(event.payload_json);if(['mission.created','mission.revised'].includes(event.kind)){revision=p.revision;projected='ready';}if(event.kind==='mission.state_changed')projected=p.state;}
    if(projected!==m.current_state||revision!==m.current_revision)throw new Error('INTEGRITY_PROJECTION_MISMATCH');
    return {...m,revision:this.getMissionRevision(id,m.current_revision),verification:this.listVerificationsForMission(id),acceptance:this.listAcceptancesForMission(id)};
  }
  integrity() {
    const sqlite=this.db.prepare('PRAGMA integrity_check').all().map(r=>Object.values(r)[0]);
    const foreignKeys=this.db.prepare('PRAGMA foreign_key_check').all();
    const ledger=verifyLedgerChain(this.db.prepare('SELECT * FROM authority_ledger_entries ORDER BY project_id,sequence').all());
    const heads=this.db.prepare('SELECT * FROM authority_ledger_heads').all(),headIntegrity=heads.every(h=>{const last=this.db.prepare('SELECT sequence,entry_hash FROM authority_ledger_entries WHERE project_id=? ORDER BY sequence DESC LIMIT 1').get(h.project_id);return last?.sequence===h.sequence&&last?.entry_hash===h.entry_hash;})&&heads.length===ledger.projects;
    return {ok:headIntegrity&&sqlite.length===1&&sqlite[0]==='ok'&&!foreignKeys.length&&ledger.valid,sqlite,foreign_key_violations:foreignKeys.length,head_integrity:headIntegrity,ledger,schema_version:VERSION};
  }
}
module.exports = { AuthorityStore, LOCAL_PROJECT, json, hashId, parse, safe, actor };
