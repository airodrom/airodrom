'use strict';
// Host-only identity migration on the existing memory/audit store. Literal
// aliases exist only in this synchronous call, never in durable migration data.
const {randomUUID}=require('node:crypto');
const {transaction}=require('./control-transaction');
const {canonicalHash,genesisHash,ledgerEnvelope,verifyLedgerChain}=require('./authority-hash');
const registry=require('../config/memory-retention-fields.json');
const states=new WeakMap();
// Cache only a successful validation stamp, never rows, refs or personal data.
// Transactions do not participate: rollback can reuse a schema number.
const readableStamps=new WeakMap();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY=/(?:sha256:|arch:|operator_text:)[0-9a-f]{64}|(?:^|[:/._-])[0-9a-f]{64}(?=$|[:/._-])/i;
const CONTENT_IDS={authority_memory_candidates:'id',authority_memories:'id',authority_context_pack_manifests:'id',authority_context_pack_diffs:'id',authority_memory_conflicts:'id',authority_routing_decisions:'id',authority_runtime_capability_observations:'id',authority_evidence_records:'id',authority_qualification_receipts:'id',personal_memories:'memory_id',architecture_memory_versions:'version_hash',cp_context_packs:'id',cp_candidates:'id',cp_artifacts:'id',authority_artifact_records:'id',chatgpt_events:'record_id',cp_requests:'record_id',cp_invocations:'origin_event_id',cp_provider_requests:'record_id',cp_mission_budget_usage:'record_id',cp_slack_outbox:'id',cp_slack_health_outbox:'id'};
const SLACK_INTENTS=['cp_slack_outbox','cp_slack_health_outbox'];
const exists=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const q=v=>'"'+v.replaceAll('"','""')+'"';
const tables=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name).filter(n=>!/_fts(?:_|$)/.test(n));
const legacy=v=>typeof v==='string'&&LEGACY.test(v);
const jsonColumn=(table,key)=>/^(record|snapshot|metadata|refs|selection|packet|envelope|manifest|proposal|correlation)$|_json$/.test(key)||key==='payload'&&['cp_effect_outbox','chatgpt_events'].includes(table);
const identifierKey=k=>/^(id|memoryId|contextPackId|requestId|candidateId|retrieved_memory_ids|influencing_memory_ids|decision_refs|memory_ids|candidate_ids)$|(?:_id|_ids|_ref|_refs)$/.test(k)&&!['observation_id','source_event_id'].includes(k);
const safeCorrelation=(table,row,column)=>table==='event_ledger_events'&&column==='idempotency_key'&&row.event_type==='memory.content_redacted'&&/^content-redaction:\d+:[a-f0-9]{64}$/.test(row.idempotency_key||'');
function hasLegacyIdentifiers(value,key='',allowed=new Set()) {
  if(typeof value==='string')return !allowed.has(value)&&(identifierKey(key)||key==='ref')&&legacy(value);
  if(Array.isArray(value))return value.some(v=>hasLegacyIdentifiers(v,key,allowed));
  if(value&&typeof value==='object')return Object.entries(value).some(([k,v])=>legacy(k)||hasLegacyIdentifiers(v,k,allowed));
  return false;
}
function install(db) {
  let s=states.get(db);if(!s){s={writing:false,ports:new Map()};states.set(db,s);db.function('memory_identity_migration',()=>s.writing?1:0);db.function('memory_identity_legacy',v=>legacy(v)?1:0);db.function('memory_identity_json_legacy',v=>{try{return hasLegacyIdentifiers(JSON.parse(v),'',nonContentIds(db))?1:0;}catch{return 1;}});}
  db.exec(`CREATE TABLE IF NOT EXISTS memory_identity_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,generation INTEGER NOT NULL);
    INSERT OR IGNORE INTO memory_identity_meta VALUES(1,1,0);
    CREATE TABLE IF NOT EXISTS memory_identity_progress(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL CHECK(state IN('pending','applying','failed','complete')),safe_error_class TEXT,updated_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO memory_identity_progress VALUES(1,'complete',NULL,0);
    CREATE TABLE IF NOT EXISTS memory_identity_lineage(record_class TEXT NOT NULL,anchor_id TEXT NOT NULL,identity TEXT NOT NULL,project_id TEXT,operator_id TEXT,generation INTEGER NOT NULL,PRIMARY KEY(record_class,anchor_id));
    CREATE TRIGGER IF NOT EXISTS memory_identity_lineage_no_update BEFORE UPDATE ON memory_identity_lineage BEGIN SELECT RAISE(ABORT,'Immutable opaque identity lineage');END;
    CREATE TRIGGER IF NOT EXISTS memory_identity_lineage_no_delete BEFORE DELETE ON memory_identity_lineage BEGIN SELECT RAISE(ABORT,'Durable opaque identity lineage');END;`);
  if(db.prepare('SELECT version FROM memory_identity_meta WHERE id=1').get()?.version!==1)throw Error('Unsupported identity migration version');
  return s;
}
function columns(db,t) {
  const r=registry[t];if(!r)throw Error('Identity migration incomplete: unclassified store');
  const cols=db.prepare(`PRAGMA table_xinfo(${q(t)})`).all();if(cols.some(c=>!r.fields.includes(c.name)))throw Error('Identity migration incomplete: unclassified field');return cols;
}
function rows(db) {
  const result=[];
  for(const t of tables(db)){columns(db,t);if(t.startsWith('memory_identity_'))continue;for(const r of db.prepare(`SELECT rowid _identity_rowid,* FROM ${q(t)} ORDER BY rowid`).all())result.push({table:t,row:r});}
  return result;
}
function linkedSlackIntent(db,row){return row.destination_type==='slack_message'&&row.event_type==='slack.notification'&&SLACK_INTENTS.some(t=>exists(db,t)&&db.prepare(`SELECT 1 FROM ${q(t)} WHERE id=?`).get(row.destination_ref));}
function roots(db,all) {
  const result=[];
  for(const {table,row}of all){const pk=CONTENT_IDS[table];
    if(pk&&legacy(row[pk]))result.push({table,column:pk,row,old:row[pk]});
    for(const [column,value]of Object.entries(row))if((column==='request_id'||column==='lifecycle_request_id'||column==='idempotency_key'||column==='event_key')&&legacy(value)&&!safeCorrelation(table,row,column)&&!(column==='event_key'&&table==='cp_effect_outbox'&&value==='slack:'+row.destination_ref&&linkedSlackIntent(db,row)))result.push({table,column,row,old:value});
    for(const [column,value]of Object.entries(row))if(typeof value==='string'&&jsonColumn(table,column)) {
      let obj;try{obj=JSON.parse(value);}catch{throw Error('Unknown legacy identity shape');}
      const visit=(x,key='')=>{if(typeof x==='string'&&x.startsWith('operator_text:')&&legacy(x))result.push({table,column,row,old:x});else if(Array.isArray(x))x.forEach(y=>visit(y,key));else if(x&&typeof x==='object')Object.entries(x).forEach(([k,v])=>visit(v,k));};visit(obj);
    }
  }
  for(const {table,row}of all.filter(r=>r.table==='cp_agent_dispatch_intents')){const record=JSON.parse(row.record);if(legacy(record.policy_ref)){if(!UUID.test(row.dispatch_id||''))throw Error('Unknown dispatch policy origin');const mission=db.prepare('SELECT project_id,task_id FROM cp_missions WHERE id=?').get(row.mission_id);if(!mission||mission.project_id!==record.project_id||mission.task_id!==record.task_id)throw Error('Dispatch policy scope mismatch');result.push({table,column:'policy_ref',row:{...row,...mission},old:record.policy_ref,identity_anchor:'dispatch-policy:'+row.dispatch_id});}}
  const requests=result.filter(r=>r.column==='request_id'&&UUID.test(r.row.task_id||''));
  for(const r of requests){const suffix=require('node:crypto').createHash('sha256').update(r.row.task_id+':'+r.old).digest('hex').slice(0,32);if(all.some(({row})=>Object.values(row).some(v=>typeof v==='string'&&(v.includes('orchestrator:'+suffix)||v.includes('orchestrator-capability:'+suffix))))){const origin=anchor(db,r,auditRows(db),null);result.push({table:'legacy_request_tool_calls',column:'correlation',row:r.row,old:suffix,identity_anchor:'tool-call:'+origin});}}
  for(const r of result.filter(r=>r.column==='request_id')){const old=require('node:crypto').createHash('sha256').update(JSON.stringify('task-health-test:'+r.old)).digest('hex');if(all.some(({row})=>Object.values(row).some(v=>typeof v==='string'&&v.includes(old)))){const origin=anchor(db,r,auditRows(db),null);result.push({table:'legacy_request_health_keys',column:'correlation',row:r.row,old,identity_anchor:'health-key:'+origin});}}
  if(exists(db,'chatgpt_events'))for(const {table,row}of all.filter(r=>r.table==='chatgpt_events')){const a='chatgpt-event:'+row.task_id+':'+row.seq;if((!exists(db,'memory_identity_lineage')||!db.prepare("SELECT 1 FROM memory_identity_lineage WHERE record_class='chatgpt_events.event_id' AND anchor_id=?").get(a))&&(!row.record_id||!row.lifecycle_type))result.push({table,column:'event_id',row,old:row.event_id,identity_anchor:a});}
  return result;
}
function auditRows(db){return exists(db,'authority_ledger_entries')?db.prepare('SELECT * FROM authority_ledger_entries ORDER BY project_id,sequence').all():[];}
function scope(root){return {project_id:root.row.project_id||null,operator_id:root.row.operator_id||root.row.task_id||null};}
function sourceState(db){const value={};for(const t of ['memory_identity_meta','memory_identity_progress','memory_identity_lineage','memory_erasure_markers','memory_erasure_content_rows','memory_erasure_content_progress'])if(exists(db,t))value[t]=db.prepare(`SELECT * FROM ${q(t)} ORDER BY rowid`).all();return canonicalHash(value);}
function architectureAnchor(db,origin,project,sourceDb){
  for(const target of [db,...(sourceDb?[sourceDb]:[])]){const e=target.prepare('SELECT event_type,metadata,payload FROM event_ledger_events WHERE event_id=?').get(origin);let m;try{m=e&&JSON.parse(e.metadata);}catch{}if(e?.event_type!=='architecture.identity_origin'||e.payload!==null||m?.version!==1||m.project_id!==project||m.record_class!=='architecture_memory_version'||Object.keys(m).some(k=>!['version','project_id','record_class'].includes(k)))throw Error('Unknown architecture origin evidence');}
  return 'architecture:'+origin;
}
function requestOrigin(db,row,sourceDb) {
  if(!UUID.test(row.record_id||''))throw Error('Request origin unavailable');
  if(!sourceDb)return null;
  if(!exists(sourceDb,'cp_requests'))throw Error('Request recovery origin mismatch');
  const current=sourceDb.prepare('SELECT * FROM cp_requests WHERE record_id=?').get(row.record_id);
  if(!current)throw Error('Request recovery origin mismatch');
  const erased=exists(sourceDb,'memory_erasure_content_rows')&&sourceDb.prepare("SELECT 1 FROM memory_erasure_content_rows WHERE table_name='cp_requests' AND row_key=?").get(JSON.stringify([row.record_id]));
  if(erased){let result;try{result=JSON.parse(current.result);}catch{}if(current.owner!==null&&current.owner!=='[erased]'&&!/^erased:[0-9a-f-]{36}$/i.test(current.owner)||current.request_id!==current.record_id||result?.content_state!=='erased')throw Error('Request redaction evidence unavailable');return current;}
  if(current.owner!==row.owner)throw Error('Request recovery owner scope mismatch');
  return null;
}
function opaqueOrigin(db,table,row,sourceDb){
  const key=table==='cp_invocations'?'origin_event_id':'record_id';if(!UUID.test(row[key]||''))throw Error('Retained request origin unavailable');
  if(!sourceDb)return;
  if(!exists(sourceDb,table))throw Error('Retained request origin mismatch');
  const current=sourceDb.prepare(`SELECT * FROM ${q(table)} WHERE ${q(key)}=?`).get(row[key]);
  const protectedKeys=table==='cp_invocations'?['task_id']:table==='cp_provider_requests'?['run_id']:['mission_id','kind'];
  if(!current||protectedKeys.some(k=>current[k]!==row[k]))throw Error('Retained request origin scope mismatch');
}
function anchor(db,root,events,sourceDb) {
  if(SLACK_INTENTS.includes(root.table)&&root.column==='id'){
    if(!exists(db,'cp_effect_outbox'))throw Error('Unanchored Slack identity requires quarantine');
    const effects=db.prepare("SELECT * FROM cp_effect_outbox WHERE destination_type='slack_message' AND event_type='slack.notification' AND destination_ref=?").all(root.old);
    if(effects.length!==1||!UUID.test(effects[0].id))throw Error('Unanchored Slack identity requires quarantine');
    const effect=effects[0],correlation=JSON.parse(effect.correlation);if(correlation.mission_id!==root.row.mission_id)throw Error('Slack identity scope mismatch');
    const origin='slack-effect:'+effect.id;
    if(sourceDb){
      const current=sourceDb.prepare('SELECT * FROM cp_effect_outbox WHERE id=?').get(effect.id);
      if(!current||['event_type','created_at'].some(k=>current[k]!==effect[k]))throw Error('Slack identity origin mismatch');
      const lineage=sourceDb.prepare('SELECT identity FROM memory_identity_lineage WHERE record_class=? AND anchor_id=?').get(root.table+'.id',origin);
      const intent=lineage&&sourceDb.prepare(`SELECT mission_id,kind,created_at FROM ${q(root.table)} WHERE id=?`).get(lineage.identity);
      if(!intent||['mission_id','kind','created_at'].some(k=>intent[k]!==root.row[k]))throw Error('Slack identity scope mismatch');
    }
    return origin;
  }
  if(['cp_invocations','cp_provider_requests','cp_mission_budget_usage'].includes(root.table)){opaqueOrigin(db,root.table,root.row,sourceDb);return root.table+':'+root.row[CONTENT_IDS[root.table]];}
  if(root.table==='cp_requests'){requestOrigin(db,root.row,sourceDb);return 'request-record:'+root.row.record_id;}
  if(root.table==='architecture_memory_versions'&&UUID.test(root.row.origin_event_id||''))return architectureAnchor(db,root.row.origin_event_id,root.row.project_id,sourceDb);
  if(root.table==='personal_memories'&&exists(db,'architecture_memory_versions')){const versions=db.prepare('SELECT origin_event_id,project_id FROM architecture_memory_versions WHERE memory_id=?').all(root.old);if(versions.length===1&&UUID.test(versions[0].origin_event_id||''))return architectureAnchor(db,versions[0].origin_event_id,versions[0].project_id,sourceDb);}
  const related=events.filter(e=>{try{return JSON.parse(e.payload_json).reference_id===root.old;}catch{return false;}});
  if(related.length){const e=related[0];if(!UUID.test(e.entry_id))throw Error('Legacy identity lacks opaque audit anchor');
    if(sourceDb){const current=sourceDb.prepare('SELECT * FROM authority_ledger_entries WHERE entry_id=?').get(e.entry_id);if(!current||['project_id','sequence','kind','mission_id','mission_revision','run_id','actor_type','actor_id','timestamp'].some(k=>current[k]!==e[k]))throw Error('Identity restore audit anchor mismatch');}
    return e.entry_id;
  }
  if(root.table==='authority_evidence_records'&&exists(db,'authority_verification_evidence')){
    const links=db.prepare('SELECT verification_id,ordinal FROM authority_verification_evidence WHERE evidence_id=? ORDER BY verification_id,ordinal').all(root.old);
    if(links.length!==1||!UUID.test(links[0].verification_id))throw Error('Ambiguous evidence identity anchor');
    return 'verification:'+links[0].verification_id+':'+links[0].ordinal;
  }
  if(root.table==='authority_runtime_capability_observations'){
    const event=events.find(e=>JSON.parse(e.payload_json).reference_id===root.row.evidence_ref);
    if(!event||!UUID.test(event.entry_id)||!/^[-a-z0-9_.]+$/i.test(root.row.capability_key))throw Error('Ambiguous capability identity anchor');
    return 'capability:'+event.entry_id+':'+root.row.runtime_registry_id+':'+root.row.capability_key;
  }
  if(root.identity_anchor){if(root.table==='cp_agent_dispatch_intents'&&sourceDb){const e=sourceDb.prepare('SELECT mission_id,run_id FROM cp_agent_dispatch_intents WHERE dispatch_id=?').get(root.row.dispatch_id);if(!e||e.mission_id!==root.row.mission_id||e.run_id!==root.row.run_id)throw Error('Policy origin mismatch');}if(root.table==='chatgpt_events'&&sourceDb){const e=sourceDb.prepare('SELECT task_id,received_at FROM chatgpt_events WHERE seq=?').get(root.row.seq);if(!e||e.task_id!==root.row.task_id||e.received_at!==root.row.received_at)throw Error('ChatGPT origin mismatch');}return root.identity_anchor;}
  if(['request_id','lifecycle_request_id'].includes(root.column)&&exists(db,'event_ledger_events')){const events=db.prepare('SELECT event_id,task_id,run_id,session_id,mission_id,request_id,timestamp_ms,agent,direction,metadata FROM event_ledger_events ORDER BY seq').all();const origin=events.find(e=>{try{return (e.request_id===root.old||JSON.parse(e.metadata)?.request_id===root.old)&&(!root.row.task_id||e.task_id===root.row.task_id);}catch{return false;}});if(origin&&UUID.test(origin.event_id)){if(sourceDb){const current=sourceDb.prepare('SELECT * FROM event_ledger_events WHERE event_id=?').get(origin.event_id);if(!current||['task_id','run_id','session_id','mission_id','timestamp_ms','agent','direction'].some(k=>current[k]!==origin[k]))throw Error('Request origin scope mismatch');}return 'request-event:'+origin.event_id;}}
  if(root.column==='event_key'&&root.table==='cp_effect_outbox'){if(!UUID.test(root.row.id||''))throw Error('Unknown outbox origin');if(sourceDb){const current=sourceDb.prepare('SELECT event_type,created_at FROM cp_effect_outbox WHERE id=?').get(root.row.id);if(!current||['event_type','created_at'].some(k=>current[k]!==root.row[k]))throw Error('Outbox origin mismatch');}return 'outbox-event:'+root.row.id;}
  if(root.column==='idempotency_key'&&UUID.test(root.row.event_id))return 'event:'+root.row.event_id;
  // Admission/request rows have an existing random record/run identity. This
  // is a content-free origin handle, never a digest of the old request key.
  if(['request_id','lifecycle_request_id'].includes(root.column)||root.old.startsWith('operator_text:')){
    const id=[root.row.id,root.row.event_id,root.row.run_id].find(x=>UUID.test(x||''));if(id)return 'request:'+id+':'+root.column;
  }
  throw Error('Legacy identity missing unique non-content origin anchor');
}
function rewrite(text,aliases) {let result=text;for(const [old,id]of aliases)result=result.split(old).join(id);return result;}
function protect(db,t,cols) {
  // Host-only migration can change identifiers, references and commitments.
  // Scope, actor, order, operation and timestamps cannot change.
  const protectedScope=new Set(['project_id','operator_id','task_id','mission_id','run_id','actor_id','created_by_actor_id','approved_by_actor_id','proposed_by_actor_id','reviewed_by_actor_id','scope']);
  const immutable=cols.filter(c=>protectedScope.has(c.name)||registry[t].classification[c.name]==='A'&&!identifierKey(c.name)&&c.name!=='idempotency_key'&&c.name!=='entry_hash'&&c.name!=='previous_hash').map(c=>`old.${q(c.name)} IS new.${q(c.name)}`).join(' AND ')||'1';
  for(const tr of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(t)){
    if(!/BEFORE UPDATE\s+ON/i.test(tr.sql)||!/SELECT RAISE\(ABORT,'(?:Immutable|Append-only)/.test(tr.sql))continue;
    db.exec(`DROP TRIGGER ${q(tr.name)};CREATE TRIGGER ${q(tr.name)} BEFORE UPDATE ON ${q(t)} WHEN NOT(memory_identity_migration()=1 AND (${immutable})) AND memory_content_redaction()=0 BEGIN SELECT RAISE(ABORT,'Immutable identity metadata');END;`);
  }
  if(t==='memory_erasure_markers'){
    db.exec(`DROP TRIGGER IF EXISTS memory_erasure_immutable;CREATE TRIGGER memory_erasure_immutable BEFORE UPDATE ON memory_erasure_markers WHEN NOT(memory_identity_migration()=1 AND old.generation IS new.generation AND old.store IS new.store AND old.scope_hash IS new.scope_hash AND old.action IS new.action AND old.erased_at IS new.erased_at AND old.source_event_id IS new.source_event_id AND old.source_provenance IS new.source_provenance) BEGIN SELECT RAISE(ABORT,'Immutable erasure marker');END;`);
  }
}
function guard(db,t,cols) {
  const candidates=cols.filter(c=>c.name===CONTENT_IDS[t]||['candidate_id','promoted_memory_id','context_pack_id','from_pack_id','to_pack_id'].includes(c.name)||c.name==='request_id'||c.name==='lifecycle_request_id'||c.name==='idempotency_key'||c.name==='event_key');
  for(const c of candidates)for(const op of ['INSERT','UPDATE']){
    const name='opaque_identity_'+t+'_'+c.name+'_'+op.toLowerCase();
    const safe= t==='event_ledger_events'&&c.name==='idempotency_key'?"AND new.event_type<>'memory.content_redacted'":'';
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${q(name)} BEFORE ${op} ON ${q(t)} WHEN memory_identity_migration()=0 AND memory_identity_legacy(new.${q(c.name)})=1 ${safe} BEGIN SELECT RAISE(ABORT,'Legacy content-derived identity denied');END;`);
  }
  if(t==='authority_ledger_entries')return; // known non-content observation references
  for(const c of cols.filter(c=>jsonColumn(t,c.name)))for(const op of ['INSERT','UPDATE']){
    const name='opaque_refs_'+t+'_'+c.name+'_'+op.toLowerCase();
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${q(name)} BEFORE ${op} ON ${q(t)} WHEN memory_identity_migration()=0 AND new.${q(c.name)} IS NOT NULL AND memory_identity_json_legacy(new.${q(c.name)})=1 BEGIN SELECT RAISE(ABORT,'Legacy or unknown identity reference denied');END;`);
  }
}
function nonContentIds(db){const allowed=new Set();for(const t of ['authority_observations','authority_acceptance_criteria'])if(exists(db,t))for(const r of db.prepare(`SELECT id FROM ${q(t)}`).all())allowed.add(r.id);return allowed;}
function rechain(db) {
  if(!exists(db,'authority_ledger_entries'))return;
  const heads=new Map();for(const e of auditRows(db)){e.previous_hash=heads.get(e.project_id)||genesisHash(e.project_id);e.entry_hash=canonicalHash(ledgerEnvelope(e));db.prepare('UPDATE authority_ledger_entries SET previous_hash=?,entry_hash=? WHERE entry_id=?').run(e.previous_hash,e.entry_hash,e.entry_id);heads.set(e.project_id,e.entry_hash);}
  for(const [p,h]of heads)db.prepare('UPDATE authority_ledger_heads SET entry_hash=? WHERE project_id=?').run(h,p);
}
function validateLineage(db) {
  for(const r of db.prepare('SELECT * FROM memory_identity_lineage').all())if(!UUID.test(r.identity)||legacy(r.anchor_id)||legacy(r.record_class))throw Error('Corrupted opaque identity lineage');
}
function migrationEvent(db,generation,count,now) {
  const {EventLedger}=require('./event-ledger');new EventLedger(db,{now:()=>now}).record({eventType:'memory.identity_migrated',agent:'bridge',direction:'internal',status:'applied',protected:true,idempotencyKey:'identity-migration:'+generation,metadata:{version:1,generation,record_count:count,prior_chain_valid:true}});
  db.exec(`CREATE TRIGGER IF NOT EXISTS identity_migration_event_immutable BEFORE UPDATE ON event_ledger_events WHEN old.event_type='memory.identity_migrated' BEGIN SELECT RAISE(ABORT,'Immutable opaque identity migration event');END;
    CREATE TRIGGER IF NOT EXISTS identity_migration_event_no_delete BEFORE DELETE ON event_ledger_events WHEN old.event_type='memory.identity_migrated' BEGIN SELECT RAISE(ABORT,'Durable identity migration event');END;`);
  if(exists(db,'authority_ledger_entries')){
    const project='authority:local',head=db.prepare('SELECT sequence,entry_hash FROM authority_ledger_entries WHERE project_id=? ORDER BY sequence DESC LIMIT 1').get(project);
    const e={project_id:project,sequence:(head?.sequence||0)+1,entry_id:randomUUID(),mission_id:null,mission_revision:null,run_id:null,kind:'memory.identity_migrated',actor_type:'host',actor_id:'memory-identity',payload_json:JSON.stringify({version:1,generation,record_count:count,prior_chain_valid:true,outcome:'applied'}),previous_hash:head?.entry_hash||genesisHash(project),timestamp:now};e.entry_hash=canonicalHash(ledgerEnvelope(e));
    db.prepare('INSERT INTO authority_ledger_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(e.project_id,e.sequence,e.entry_id,null,null,null,e.kind,e.actor_type,e.actor_id,e.payload_json,e.previous_hash,e.entry_hash,now);
    db.prepare('INSERT INTO authority_ledger_heads VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET sequence=excluded.sequence,entry_hash=excluded.entry_hash').run(project,e.sequence,e.entry_hash);
  }
}
function migrate(db,{sourceDb=null,now=Date.now(),beforeApply=null,beforeRewrite=null,afterRewrite=null}={}) {
  require('./memory-erasure').migrate(db);const state=install(db);require('./capability-mac').clearNotificationCache();
  if(sourceDb){require('./memory-content-erasure').assertReadable(sourceDb);if(exists(sourceDb,'memory_identity_meta')&&sourceDb.prepare('SELECT version FROM memory_identity_meta WHERE id=1').get()?.version!==1)throw Error('Unsupported authoritative identity version');}
  const sourceHash=sourceDb?sourceState(sourceDb):null;
  db.prepare("UPDATE memory_identity_progress SET state='pending',safe_error_class=NULL,updated_at=? WHERE id=1").run(now);
  const aliases=new Map();
  try {
    new (require('./event-ledger').EventLedger)(db,{now:()=>now});
    if(exists(db,'cp_leases')&&db.prepare("SELECT 1 FROM cp_leases WHERE mode='write' AND state IN('held','quarantined') LIMIT 1").get())throw Error('Active writer prevents identity migration');
    if(!sourceDb&&exists(db,'architecture_memory_versions')){state.writing=true;try{require('./architecture-memory').prepareIdentityMigration(db,{now});}finally{state.writing=false;}}
    if(exists(db,'chatgpt_events'))require('./chatgpt-events').prepareIdentitySchema(db);
    if(exists(db,'cp_invocations')){const prep=require('./control-plane-store');prep.prepareInvocationIdentitySchema(db);prep.prepareLegacyInvocationOrigins(db,{sourceDb});for(const row of db.prepare('SELECT * FROM cp_invocations').all())opaqueOrigin(db,'cp_invocations',row,sourceDb);}
    for(const [table,module,schema,prepare]of [['cp_provider_requests','./provider-gateway','prepareProviderRequestIdentitySchema','prepareLegacyProviderRequestIdentities'],['cp_mission_budget_usage','./mission-program','prepareBudgetIdentitySchema','prepareLegacyBudgetIdentities']])if(exists(db,table)){const prep=require(module);if(sourceDb)prep[schema](db);else prep[prepare](db);for(const row of db.prepare(`SELECT * FROM ${q(table)}`).all())opaqueOrigin(db,table,row,sourceDb);}
    if(exists(db,'cp_requests')){const prep=require('./control-plane-store');if(sourceDb)prep.prepareRequestIdentitySchema(db);else prep.prepareLegacyRequestIdentities(db);const requests=db.prepare('SELECT * FROM cp_requests').all();for(const row of requests)requestOrigin(db,row,sourceDb);}
    const all=rows(db),found=roots(db,all),events=auditRows(db);if(!verifyLedgerChain(events).valid)throw Error('Identity source audit integrity invalid');
    validateLineage(db);
    const plans=found.map(r=>({...r,anchor_id:anchor(db,r,events,sourceDb),...scope(r)}));
    const origins=new Map();for(const p of plans){const k=p.table+'.'+p.column+':'+p.anchor_id;const prior=origins.get(k);if(prior&&prior!==p.old)throw Error('Ambiguous content-reference origin');origins.set(k,p.old);}
    if(exists(db,'authority_memories')&&exists(db,'authority_memory_candidates'))for(const m of db.prepare('SELECT * FROM authority_memories WHERE candidate_id IS NOT NULL').all()){
      const c=db.prepare('SELECT operator_id,project_id,scope FROM authority_memory_candidates WHERE id=?').get(m.candidate_id);
      if(!c||c.operator_id!==m.operator_id||c.project_id!==m.project_id||c.scope!==m.scope)throw Error('Cross-scope candidate identity reference');
    }
    // Allocate randomness once against non-content origin anchors; no alias is
    // persisted. Crash/retry and partial filesystem writes reuse the UUID.
    transaction(db,()=>{
      const generation=db.prepare('SELECT generation FROM memory_identity_meta WHERE id=1').get().generation+(plans.length?1:0);
      for(const p of plans){const recordClass=p.table+'.'+p.column;
        let entry=db.prepare('SELECT * FROM memory_identity_lineage WHERE record_class=? AND anchor_id=?').get(recordClass,p.anchor_id);
        if(entry&&(entry.project_id!==p.project_id||entry.operator_id!==p.operator_id))throw Error('Identity scope mismatch');
        const authoritative=sourceDb&&exists(sourceDb,'memory_identity_lineage')?sourceDb.prepare('SELECT * FROM memory_identity_lineage WHERE record_class=? AND anchor_id=?').get(recordClass,p.anchor_id):null;
        if(sourceDb&&(!authoritative||authoritative.project_id!==p.project_id||authoritative.operator_id!==p.operator_id))throw Error('Identity restore mapping missing or cross-scope');
        if(entry&&authoritative&&entry.identity!==authoritative.identity)throw Error('Corrupted identity restore mapping');
        const prior=aliases.get(p.old),id=entry?.identity||authoritative?.identity||prior||randomUUID();
        if(prior&&prior!==id)throw Error('Ambiguous legacy identity scope');
        if(!UUID.test(id))throw Error('Corrupted identity allocation');
        if(!entry)db.prepare('INSERT INTO memory_identity_lineage VALUES(?,?,?,?,?,?)').run(recordClass,p.anchor_id,id,p.project_id,p.operator_id,generation);
        aliases.set(p.old,id);
      }
      db.prepare('UPDATE memory_identity_meta SET generation=? WHERE id=1').run(generation);
    });
    const generation=db.prepare('SELECT generation FROM memory_identity_meta WHERE id=1').get().generation;
    return transaction(db,()=>{
      db.exec('PRAGMA defer_foreign_keys=ON');state.writing=true;
      try {
        for(const table of tables(db))if(!table.startsWith('memory_identity_'))guard(db,table,columns(db,table));
        db.prepare("UPDATE memory_identity_progress SET state='applying' WHERE id=1").run();if(beforeApply)beforeApply();
        let count=0;const taskIds=new Set();
        for(const {table,row}of all){const cols=columns(db,table),changed={};
          if(table==='cp_requests'&&sourceDb){const erased=requestOrigin(db,row,sourceDb);if(erased)for(const c of cols)if(registry[table].classification[c.name]!=='A')changed[c.name]=erased[c.name];}
          for(const c of cols)if(typeof row[c.name]==='string'){const value=rewrite(row[c.name],aliases);if(value!==row[c.name]){
            if(['project_id','operator_id','task_id','mission_id','run_id','actor_id','scope'].includes(c.name))throw Error('Identity rewrite crosses protected scope');
            if(!(table==='cp_requests'&&sourceDb&&Object.hasOwn(changed,c.name)))changed[c.name]=value;
          }}
          if(table==='chatgpt_events'&&!row.record_id&&cols.some(c=>c.name==='record_id')){const entry=db.prepare("SELECT identity FROM memory_identity_lineage WHERE record_class='chatgpt_events.event_id' AND anchor_id=?").get('chatgpt-event:'+row.task_id+':'+row.seq);if(!entry)throw Error('Unknown ChatGPT record origin');changed.record_id=entry.identity;}
          if(!Object.keys(changed).length){guard(db,table,cols);continue;}
          if(row.task_id)taskIds.add(row.task_id);if(table==='task_states')taskIds.add(row.id);
          protect(db,table,cols);
          // Replace original content-dependent commitments for already-redacted
          // records; otherwise recompute their erasable commitments after refs.
          if(table==='chatgpt_events'&&!row.record_id&&changed.event_id)changed.record_id=changed.event_id;
          if(table==='chatgpt_events'&&!row.lifecycle_type){let event;try{event=JSON.parse(changed.payload||row.payload);}catch{}if(event?.version===1&&event.task_id===row.task_id&&UUID.test(event.session_id||'')&&typeof event.request_id==='string'&&!legacy(event.request_id)&&require('./chatgpt-events').properties.event_type.enum.includes(event.event_type)&&event.summary==='Pi task '+event.event_type.replaceAll('_',' ')+'.')Object.assign(changed,{lifecycle_session_id:event.session_id,lifecycle_request_id:event.request_id,lifecycle_type:event.event_type});}
          const next={...row,...changed},envelope=Object.fromEntries(cols.filter(c=>registry[table].classification[c.name]==='A').map(c=>[c.name,next[c.name]]));
          const erased=row.subject_key==='[erased]'||row.content===null&&row.status==='forgotten'||Object.values(row).some(v=>typeof v==='string'&&/"content_state"\s*:\s*"erased"/.test(v));
          if(erased||table==='event_ledger_events')for(const c of cols)if(registry[table].classification[c.name]==='D'&&!['previous_hash','entry_hash'].includes(c.name))changed[c.name]=c.notnull?canonicalHash({version:1,table,envelope}):null;
          if(table==='authority_ledger_entries'){
            const payload=JSON.parse(next.payload_json);
            if(payload.reference_id){payload.content_hash=canonicalHash({kind:row.kind,reference_id:payload.reference_id});changed.payload_json=JSON.stringify(payload);}
          }
          if(!erased&&table==='authority_memories')changed.content_hash=canonicalHash({id:next.id,kind:next.kind,project_id:next.project_id,operator_id:next.operator_id,scope:next.scope,subject_key:next.subject_key,value:JSON.parse(next.value_json),source_hash:next.source_hash,source_refs:JSON.parse(next.source_refs_json),privacy:next.privacy,assurance:next.assurance,domains:JSON.parse(next.domains_json)});
          if(!erased&&table==='authority_context_pack_manifests'){
            const manifest=JSON.parse(next.manifest_json);if(manifest.version!==1||!Array.isArray(manifest.items))throw Error('Unknown legacy ContextPack schema');
            changed.context_hash=canonicalHash(Object.fromEntries(['version','project_id','mission_id','mission_revision','operator_id','retrieval_policy_version','privacy','items'].map(k=>[k,manifest[k]])));
          }
          if(!erased&&table==='cp_agent_dispatch_intents'){const mission=db.prepare('SELECT envelope,ceiling FROM cp_missions WHERE id=?').get(row.mission_id);if(!mission)throw Error('Policy mission unavailable');const record=JSON.parse(changed.record||row.record);record.policy_hash=require('./control-plane-store').fingerprint({version:2,envelope:JSON.parse(mission.envelope),ceiling:JSON.parse(mission.ceiling)});changed.record=JSON.stringify(record);}
          if(!erased&&table==='cp_work_bindings'&&changed.policy_hash){const mission=db.prepare('SELECT envelope,ceiling FROM cp_missions WHERE id=?').get(row.mission_id);if(!mission)throw Error('Work policy mission unavailable');changed.policy_hash=require('./control-plane-store').fingerprint({version:2,envelope:JSON.parse(mission.envelope),ceiling:JSON.parse(mission.ceiling)});}
          if(!erased&&table==='authority_context_pack_diffs')changed.content_hash=canonicalHash(JSON.parse(next.diff_json));
          if(beforeRewrite)beforeRewrite({table,count});
          db.prepare(`UPDATE ${q(table)} SET ${Object.keys(changed).map(k=>q(k)+'=?').join(',')} WHERE rowid=?`).run(...Object.values(changed),row._identity_rowid);count++;guard(db,table,cols);
          if(afterRewrite)afterRewrite({table,count});
        }
        require('./memory-content-erasure').upgradeReplayKeys(db);
        if(aliases.size){protect(db,'authority_ledger_entries',exists(db,'authority_ledger_entries')?columns(db,'authority_ledger_entries'):[]);rechain(db);}
        for(const {table,row}of rows(db))for(const value of Object.values(row))if(typeof value==='string'&&[...aliases.keys()].some(old=>value.includes(old)))throw Error('Legacy identity reference rewrite incomplete');
        if(roots(db,rows(db)).length)throw Error('Unmigrated legacy identity');
        const allowed=nonContentIds(db);
        for(const {table,row}of rows(db))for(const [key,v]of Object.entries(row))if(typeof v==='string'&&jsonColumn(table,key)){
          let obj;try{obj=JSON.parse(v);}catch{throw Error('Unknown identity reference schema');}
          if(hasLegacyIdentifiers(obj,'',allowed))throw Error('Dangling legacy identity reference');
        }
        if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Identity migration referential integrity invalid');
        if(!verifyLedgerChain(auditRows(db)).valid)throw Error('Identity audit transition invalid');
        const files=state.ports.get('files');if(taskIds.size&&!files&&exists(db,'task_states'))throw Error('Retained identity files unavailable');if(files)files(aliases,{generation,taskIds:[...taskIds]});
        if(sourceDb&&sourceState(sourceDb)!==sourceHash)throw Error('Authoritative identity/erasure generation changed during recovery');
        if(aliases.size)migrationEvent(db,generation,found.length,now);
        db.prepare("UPDATE memory_identity_progress SET state='complete',safe_error_class=NULL,updated_at=? WHERE id=1").run(now);
        if(sourceDb)state.witness={sourceDb,sourceHash};
        return {version:1,generation,state:'complete',migrated_records:found.length,rewritten_records:count,authority:false};
      }finally{state.writing=false;}
    });
  }catch{db.prepare("UPDATE memory_identity_progress SET state='failed',safe_error_class='identity_migration_failed',updated_at=? WHERE id=1").run(now);throw Error('Opaque identity migration incomplete; reads and replay denied');}
  finally{aliases.clear();}
}
function qualification(db) {
  try{if(exists(db,'memory_identity_meta')&&db.prepare('SELECT version FROM memory_identity_meta WHERE id=1').get()?.version!==1)throw Error('Unsupported identity version');if(exists(db,'memory_identity_lineage'))validateLineage(db);const missingOrigins=exists(db,'cp_requests')?(!db.prepare('PRAGMA table_info(cp_requests)').all().some(c=>c.name==='record_id')?db.prepare('SELECT count(*) n FROM cp_requests').get().n:db.prepare('SELECT record_id FROM cp_requests').all().filter(r=>!UUID.test(r.record_id||'')).length):0;let otherOrigins=0;for(const table of ['cp_invocations','cp_provider_requests','cp_mission_budget_usage'])if(exists(db,table)){const key=CONTENT_IDS[table];otherOrigins+=db.prepare(`PRAGMA table_info(${q(table)})`).all().some(c=>c.name===key)?db.prepare(`SELECT ${q(key)} id FROM ${q(table)}`).all().filter(r=>!UUID.test(r.id||'')).length:db.prepare(`SELECT count(*) n FROM ${q(table)}`).get().n;}const all=rows(db),found=roots(db,all),progress=exists(db,'memory_identity_progress')?db.prepare('SELECT state FROM memory_identity_progress WHERE id=1').get():null;
    return {legacy_content_identifiers:found.length,unanchored_request_records:missingOrigins+otherOrigins,migration_required:found.length>0||missingOrigins+otherOrigins>0||!!progress&&progress.state!=='complete',state:progress?.state||'unmigrated',authority:false};
  }catch{return{legacy_content_identifiers:null,migration_required:true,state:'failed',safe_error_class:'unknown_identity_schema',authority:false};}
}
function readStamp(db) {
  // One SQLite statement samples the counters together. Bracket the schema
  // signature too: a foreign commit during stamp construction must not reuse
  // validity from the counter sampled before that commit.
  const counters=()=>db.prepare('SELECT total_changes() AS changes,(SELECT schema_version FROM pragma_schema_version) AS schema,(SELECT data_version FROM pragma_data_version) AS data').get();
  const before=counters();
  // An explicit schema_version reset can reuse the counters even in autocommit.
  // Retain only a digest of the table definitions, never their rows or payloads.
  const layout=canonicalHash(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all());
  const after=counters();
  if(before.schema!==after.schema||before.data!==after.data||before.changes!==after.changes)throw Error('Identity state changed during read validation');
  return {...after,layout};
}
function sameStamp(a,b){return !!a&&a.schema===b.schema&&a.data===b.data&&a.changes===b.changes&&a.layout===b.layout;}
function assertReadable(db) {
  if(exists(db,'memory_identity_meta')&&!states.has(db))install(db);
  const witness=states.get(db)?.witness;if(witness&&sourceState(witness.sourceDb)!==witness.sourceHash)throw Error('Stale identity/erasure generation requires recovery');
  const cacheable=db.isTransaction===false&&!states.get(db)?.writing;
  if(!cacheable)readableStamps.delete(db);
  const stamp=cacheable?readStamp(db):null;
  if(cacheable&&sameStamp(readableStamps.get(db),stamp)){
    if(witness&&sourceState(witness.sourceDb)!==witness.sourceHash)throw Error('Stale identity/erasure generation requires recovery');
    return;
  }
  // The schema map belongs to this validation only; payload is never retained.
  const tableColumns=new Map(tables(db).map(t=>[t,columns(db,t)])),present=t=>tableColumns.has(t);
  if(exists(db,'memory_identity_meta')){if(db.prepare('SELECT version FROM memory_identity_meta WHERE id=1').get()?.version!==1)throw Error('Unsupported identity migration version');validateLineage(db);if(db.prepare('SELECT state FROM memory_identity_progress WHERE id=1').get()?.state!=='complete')throw Error('Identity migration incomplete; retained reads denied');}
  // Never trust a copied COMPLETE disposition without examining identities.
  for(const table of ['cp_invocations','cp_provider_requests','cp_mission_budget_usage'])if(present(table)){const key=CONTENT_IDS[table],cols=tableColumns.get(table);if(!cols.some(c=>c.name===key)||db.prepare(`SELECT ${q(key)} id FROM ${q(table)}`).all().some(r=>!UUID.test(r.id||'')))throw Error('Retained request origin unavailable; explicit migration required');}
  if(present('cp_requests')){const cols=tableColumns.get('cp_requests');if(!cols.some(c=>c.name==='record_id')||db.prepare('SELECT record_id FROM cp_requests').all().some(r=>!UUID.test(r.record_id||'')))throw Error('Request origin unavailable; explicit source migration required');}
  for(const [table,column]of Object.entries(CONTENT_IDS))if(present(table))for(const row of db.prepare(`SELECT ${q(column)} value FROM ${q(table)}`).all())if(legacy(row.value))throw Error('Legacy content-derived identity requires migration');
  for(const [table,cols]of tableColumns){
    const keys=cols.map(c=>c.name).filter(k=>['request_id','lifecycle_request_id','idempotency_key','event_key'].includes(k));if(!keys.length)continue;
    const projection=[...keys,...(table==='event_ledger_events'?['event_type']:[])];
    for(const row of db.prepare(`SELECT ${projection.map(q).join(',')} FROM ${q(table)}`).all())if(keys.some(k=>legacy(row[k])&&!safeCorrelation(table,row,k)))throw Error('Legacy content-derived correlation requires migration');
  }
  const allowed=nonContentIds(db);
  for(const [t,cols]of tableColumns)if(!t.startsWith('memory_identity_'))for(const c of cols.map(c=>c.name).filter(k=>jsonColumn(t,k)))for(const r of db.prepare(`SELECT ${q(c)} value FROM ${q(t)} WHERE ${q(c)} IS NOT NULL`).all()){
    // Parse only possible legacy identifiers; normal payload reads stay bounded.
    if(!legacy(r.value))continue;
    let obj;try{obj=JSON.parse(r.value);}catch{throw Error('Unknown identity reference shape');}
    if(hasLegacyIdentifiers(obj,'',allowed))throw Error('Legacy retained reference requires migration');
  }
  if(witness&&sourceState(witness.sourceDb)!==witness.sourceHash)throw Error('Stale identity/erasure generation requires recovery');
  if(cacheable){const after=readStamp(db);if(!sameStamp(stamp,after))throw Error('Identity state changed during read validation');readableStamps.set(db,after);}
}
function packetUsable(db,packet){try{assertReadable(db);return !hasLegacyIdentifiers(packet);}catch{return false;}}
function attach(db,name,port){if(typeof port!=='function')throw Error('Host identity migration port required');install(db).ports.set(name,port);}
module.exports={install,migrate,assertReadable,packetUsable,hasLegacyIdentifiers,qualification,attach,CONTENT_IDS};
