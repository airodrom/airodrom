'use strict';
const { createHash } = require('node:crypto');
const { transaction } = require('./control-transaction');
const { canonicalHash } = require('./authority-hash');
const { json, LOCAL_PROJECT } = require('./authority-store');
const erasure = require('./memory-erasure');
const SOURCES = {
  projects:'project_id',project_goals:'goal_id',project_missions:'mission_id',project_task_links:null,
  cp_missions:'id',cp_runs:'id',cp_grants:'id',cp_decisions:'id',cp_verifications:'id',cp_acceptances:'id',
  cp_result_inbox:'run_id',cp_result_receipts:'event_key',cp_run_results:'run_id',cp_context_packs:'id',cp_candidates:'id',
  cp_artifacts:'id',cp_approval_refs:'id',personal_memories:'memory_id',architecture_memory_versions:'memory_id',
  architecture_memory_bootstraps:'project_id',project_memory_v2_missions:'mission_id',project_memory_v2_checkpoints:'checkpoint_id'
};
const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function inventory(db) {
  const result={};
  for(const name of Object.keys(SOURCES).concat(['event_ledger_events','cp_effect_outbox'])){
    if(!exists(db,name))continue;
    const h=createHash('sha256');let count=0;
    for(const row of db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).iterate()){h.update(json(row));h.update('\n');count++;}
    result[name]={count,sha256:h.digest('hex')};
  }
  return result;
}
function importProject(store,id) {
  if(!id)return;
  const db=store.db,p=exists(db,'projects')&&db.prepare('SELECT * FROM projects WHERE project_id=?').get(id);
  if(!p)throw new Error('Missing legacy project');
  const old=store.getProject(id);
  db.prepare('INSERT INTO authority_projects VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,updated_at=excluded.updated_at').run(id,id,p.name,p.status,p.created_at,p.updated_at);
  if(!old||old.name!==p.name||old.status!==p.status)store.referenceEvent('registry.updated',id,{name:p.name,status:p.status},{projectId:id});
  if(exists(db,'project_goals'))for(const g of db.prepare('SELECT * FROM project_goals WHERE project_id=?').all(id)){
    const added=db.prepare('INSERT OR IGNORE INTO authority_goals VALUES(?,?,NULL,?,?,?,1,?,?)').run(g.goal_id,id,g.name,g.description||'',g.status,g.created_at,g.updated_at);
    if(added.changes)store.referenceEvent('registry.updated',g.goal_id,{title:g.name,status:g.status},{projectId:id});
  }
}
function migrateLegacy(store) {
  const db=store.db;
  if(db.prepare("SELECT 1 FROM authority_legacy_records WHERE source_table='migration_manifest' AND source_id='v1'").get())return {migrated:false};
  const before=inventory(db);
  return transaction(db,()=>{
    if(exists(db,'projects'))for(const p of db.prepare('SELECT project_id FROM projects').all())importProject(store,p.project_id);
    // Preserve old records as source evidence, without fabricating revision/run
    // bindings or converting permission ceilings into executable grants.
    for(const [table,key]of Object.entries(SOURCES)){
      if(!exists(db,table))continue;
      const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);
      for(const r of db.prepare(`SELECT rowid AS _source_rowid,* FROM ${table} ORDER BY rowid`).all()){
        const rowid=r._source_rowid;delete r._source_rowid;
        const id=key&&columns.includes(key)?String(r[key]):String(rowid);
        const marker=table==='personal_memories'?erasure.marker(db,'personal',id):null;
        const snapshot=marker?{memory_id:id,status:'forgotten',contentRemoved:true}:r;
        db.prepare('INSERT INTO authority_legacy_records VALUES(?,?,?,?,?,?)').run(table,id,canonicalHash(r),json(snapshot),table==='cp_missions'?id:null,table==='cp_missions'?'legacy_snapshot':'provenance_only');
      }
    }
    if(exists(db,'cp_missions'))for(const m of db.prepare('SELECT * FROM cp_missions').all()){
      importProject(store,m.project_id);
      db.prepare('INSERT INTO authority_missions VALUES(?,?,?,?,?,?,?,?,?,?)').run(m.id,m.project_id,m.goal_id,m.task_id,m.owner,m.revision,m.state,m.acceptance_strength,m.created_at,m.updated_at);
      store.insertRevision(m.id,m.revision,JSON.parse(m.envelope),store.host,'legacy_snapshot');
      store.append('mission.state_changed',{version:1,mission_id:m.id,state:m.state,previous:'legacy_snapshot'},{projectId:m.project_id||LOCAL_PROJECT,missionId:m.id,revision:m.revision});
    }
    if(exists(db,'personal_memories'))for(const m of db.prepare('SELECT * FROM personal_memories ORDER BY created_at,memory_id').all()){
      // Session scratch memory remains in its original store. It is not silently
      // elevated into global or project authority memory.
      if(m.domain==='session')continue;
      const marker=erasure.marker(db,'personal',m.memory_id);
      if(marker){m.content=null;m.status='forgotten';if(marker.action==='operator_erasure'){m.subject='[erased]';m.source_event_id=null;}}
      const arch=exists(db,'architecture_memory_versions')&&db.prepare('SELECT * FROM architecture_memory_versions WHERE memory_id=?').get(m.memory_id);
      if(m.project_id)importProject(store,m.project_id);
      const values={id:m.memory_id,kind:arch?'architecture':m.domain==='personal'?'personal_preference':'project_operational',project_id:m.project_id,operator_id:store.operatorId,scope:m.domain==='personal'?'global':'project_specific',subject_key:arch?.subject_key||m.subject,value_json:json(m.content),source_type:arch?'canonical_doc':'legacy_approved',source_hash:arch?.source_hash||m.content_hash,source_refs_json:json(arch?[{source_ref:arch.source_ref,source_hash:arch.source_hash,version_hash:arch.version_hash}]:[{legacy_memory_id:m.memory_id,source_event_id:m.source_event_id}]),candidate_id:null,assurance:arch?3:1,privacy:m.sensitivity==='normal'?'internal':'restricted_security',status:m.status,revision:1,effective_from:m.created_at,effective_until:m.status==='active'?null:m.updated_at,last_verified_at:arch?.indexed_at||m.updated_at,ttl_ms:null,expires_at:m.expires_at,reverify_task_classes_json:'[]',domains_json:arch?arch.tags:json(['legacy']),canonical_priority:arch?100:0,supersedes_id:null,superseded_by_id:null,created_by_actor_type:'host',created_by_actor_id:'legacy-import',approved_by_actor_type:'host',approved_by_actor_id:'legacy-import',created_at:m.created_at,content_hash:m.content_hash,metadata_json:json({legacy_source:m.source,legacy_superseded_by:m.superseded_by,legacy_version_hash:arch?.version_hash||null,hash_algorithm:'legacy_sha256'})};
      const fields=Object.keys(values);db.prepare(`INSERT INTO authority_memories(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...Object.values(values));
      if(marker)erasure.mark(db,{store:'governed',identity:m.memory_id,scope_hash:erasure.scopeHash([store.operatorId,m.project_id,m.domain==='personal'?'global':'project_specific']),action:marker.action,erased_at:marker.erased_at});
    }
    const after=inventory(db);if(canonicalHash(before)!==canonicalHash(after))throw new Error('Legacy state changed during authority migration');
    db.prepare('INSERT INTO authority_legacy_records VALUES(?,?,?,?,NULL,?)').run('migration_manifest','v1',canonicalHash(before),json(before),'provenance_only');
    store.referenceEvent('migration.imported','authority-database-v1',before,{projectId:LOCAL_PROJECT});
    for(const marker of db.prepare("SELECT * FROM memory_erasure_markers WHERE action='operator_erasure' ORDER BY generation").all())require('./memory-content-erasure').propagate(db,marker,{now:store.now()});
    const integrity=store.integrity();if(!integrity.ok)throw new Error('Authority migration integrity failed');
    return {migrated:true,before,after,integrity};
  });
}
module.exports={migrateLegacy,inventory,importProject};
