'use strict';
// Extension of the canonical erasure ledger, not a second memory/audit system.
// Only the host can enter the synchronous redaction transaction. Content columns
// can then change; envelope identity, ordering, scope and outcomes cannot.
const { transaction } = require('./control-transaction');
const {randomUUID}=require('node:crypto');
const { canonicalHash, genesisHash, ledgerEnvelope, verifyLedgerChain } = require('./authority-hash');
const fields = require('../config/memory-retention-fields.json');
const states = new WeakMap();
const EXCLUDED = new Set(['personal_memories','memory_entries','project_memory_v2_missions','project_memory_v2_checkpoints','project_memory_v2_retention','project_memory_v2_forgotten']);
const NON_CONTENT_ENUMS={authority_activation:{memory_state:new Set(['disabled','qualifying','enabled']),router_state:new Set(['disabled','qualifying','enabled'])},cp_mission_reviews:{result:new Set(['passed','failed','operator_review'])},cp_verifications:{result:new Set(['passed','failed','unavailable','operator_review'])}};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROTECTED_SCOPE=new Set(['project_id','operator_id','task_id','session_id','mission_id','run_id','dispatch_id','actor_id','actor_type','created_by_actor_id','approved_by_actor_id','proposed_by_actor_id','reviewed_by_actor_id','runtime_registry_id','runtime_id','runtime_class','agent_id','domain','scope','event_type']);
const CORRELATION_SCOPE=['task_id','mission_id','run_id'];
const JSON_PAYLOADS=new Set(['cp_effect_outbox','chatgpt_events']);
const UUID_REPLAY_KEYS={cp_requests:'record_id',cp_invocations:'origin_event_id',cp_provider_requests:'record_id',cp_mission_budget_usage:'record_id'};
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name);
const exists = (db,name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const quoted = name => '"'+name.replaceAll('"','""')+'"';
function install(db) {
  let state=states.get(db);
  if (!state) {
    state={writing:false,attachments:new Map()};states.set(db,state);
    db.function('memory_content_redaction',()=>state.writing?1:0);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS memory_erasure_content_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT OR IGNORE INTO memory_erasure_content_meta VALUES(1,1);
    CREATE TABLE IF NOT EXISTS memory_erasure_content_progress(generation INTEGER PRIMARY KEY,store TEXT NOT NULL,identity TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','applied','failed','retrying','complete')),safe_error_class TEXT,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_erasure_content_rows(table_name TEXT NOT NULL,row_key TEXT NOT NULL,generation INTEGER NOT NULL,scope_json TEXT,PRIMARY KEY(table_name,row_key));`);
  if(!db.prepare('PRAGMA table_info(memory_erasure_content_rows)').all().some(c=>c.name==='scope_json'))db.exec('ALTER TABLE memory_erasure_content_rows ADD COLUMN scope_json TEXT');
  if(db.prepare('SELECT version FROM memory_erasure_content_meta WHERE id=1').get()?.version!==1)throw Error('Unsupported content erasure schema');
  if(exists(db,'memory_erasure_markers'))db.prepare("INSERT OR IGNORE INTO memory_erasure_content_progress SELECT generation,store,identity,'pending',NULL,erased_at FROM memory_erasure_markers WHERE action='operator_erasure'").run();
  return state;
}
function status(db,generation,state,now) {
  db.prepare('UPDATE memory_erasure_content_progress SET state=?,safe_error_class=?,updated_at=? WHERE generation=?').run(state,state==='failed'?'content_propagation_failed':null,now,generation);
}
function metadataDigest(table,row) {
  const schema=fields[table];
  return canonicalHash({version:1,table,envelope:Object.fromEntries(Object.entries(row).filter(([k])=>schema?.classification[k]==='A'))});
}
function validateSchema(db,table) {
  const schema=fields[table];if(!schema)throw Error('Unclassified retained store');
  const actual=db.prepare(`PRAGMA table_xinfo(${quoted(table)})`).all();
  if(actual.some(c=>!schema.fields.includes(c.name)))throw Error('Unclassified retained field');
  if(table==='cp_agent_dispatch_intents'||table==='cp_agent_dispatch_attempts'){
    const keys=table==='cp_agent_dispatch_intents'?['dispatch_id']:['attempt_id','dispatch_id'];
    for(const row of db.prepare(`SELECT ${keys.map(quoted).join(',')} FROM ${quoted(table)}`).all())if(keys.some(k=>!UUID.test(row[k]||'')))throw Error('Unknown dispatch envelope identity');
  }
  if(table==='cp_autonomy_claims')for(const row of db.prepare('SELECT request_id FROM cp_autonomy_claims').all())if(!/^autonomy:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.request_id||''))throw Error('Unknown autonomy request identity');
  if(table==='cp_result_receipts')for(const row of db.prepare('SELECT event_key,run_id FROM cp_result_receipts').all())if(!UUID.test(row.run_id||'')||row.event_key!==`result:${row.run_id}`)throw Error('Unknown result receipt identity');
  return actual;
}
function permitRedaction(db,table) {
  const columns=validateSchema(db,table), mutable=columns.filter(c=>fields[table].classification[c.name]!=='A').map(c=>c.name);
  if(table==='authority_ledger_entries')mutable.push('previous_hash','entry_hash');
  const immutable=columns.filter(c=>!mutable.includes(c.name)).map(c=>`old.${quoted(c.name)} IS new.${quoted(c.name)}`).join(' AND ')||'1';
  const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table);
  for(const trigger of triggers) {
    // Only replace the canonical unconditional immutable-update triggers. Fault
    // injection, schema guards and unrelated behavior must continue to execute.
    if(!/BEFORE UPDATE\s+ON/i.test(trigger.sql)||!/SELECT RAISE\(ABORT,'(?:Immutable|Append-only)/.test(trigger.sql))continue;
    db.exec(`DROP TRIGGER ${quoted(trigger.name)}; CREATE TRIGGER ${quoted(trigger.name)} BEFORE UPDATE ON ${quoted(table)}
      WHEN NOT(memory_content_redaction()=1 AND (${immutable})) BEGIN SELECT RAISE(ABORT,'Immutable metadata record');END;`);
  }
}
function replayKeys(db,table) {
  const columns=validateSchema(db,table),primary=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
  if(UUID_REPLAY_KEYS[table]){
    const key=UUID_REPLAY_KEYS[table];
    if(!columns.some(c=>c.name===key)||fields[table].classification[key]!=='A')throw Error('Request replay identity requires explicit migration');
    const ids=db.prepare(`SELECT ${quoted(key)} FROM ${quoted(table)}`).all().map(r=>r[key]);
    if(ids.some(id=>!UUID.test(id||''))||new Set(ids).size!==ids.length)throw Error('Request replay identity requires explicit migration');
    return [key];
  }
  if(primary.length&&primary.every(k=>fields[table].classification[k]==='A'))return primary;
  // An erasable composite key cannot itself become immutable replay evidence.
  // Select an independently unique, retained non-content discriminator instead.
  for(const index of db.prepare(`PRAGMA index_list(${quoted(table)})`).all().filter(i=>i.unique&&!i.partial)){
    const keys=db.prepare(`PRAGMA index_info(${quoted(index.name)})`).all().map(c=>c.name);
    if(keys.length&&keys.every(k=>k&&fields[table].classification[k]==='A'&&columns.some(c=>c.name===k&&(c.notnull||c.pk))))return keys;
  }
  throw Error('Retained content lacks a unique non-content replay identity');
}
function replayGuards(db,table,keys,{replace=false}={}) {
  for(const operation of ['INSERT','UPDATE']) {
    const name='erased_content_'+table+'_'+operation.toLowerCase(),expr='json_array('+keys.map(k=>'new.'+quoted(k)).join(',')+')';
    if(replace)db.exec(`DROP TRIGGER IF EXISTS ${quoted(name)}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${quoted(name)} BEFORE ${operation} ON ${quoted(table)}
      WHEN memory_content_redaction()=0 AND memory_identity_migration()=0 AND EXISTS(SELECT 1 FROM memory_erasure_content_rows WHERE table_name='${table}' AND row_key=${expr})
      BEGIN SELECT RAISE(ABORT,'Erased retained content replay denied');END;`);
  }
}
function scopeEvidence(db,table,row,{stored=null}={}) {
  const columns=validateSchema(db,table).filter(c=>PROTECTED_SCOPE.has(c.name)&&fields[table].classification[c.name]==='A').map(c=>c.name).sort();
  const envelope=Object.fromEntries(columns.map(k=>[k,row[k]])),correlation={};
  if(Object.values(envelope).some(v=>v!==null&&typeof v!=='string'&&typeof v!=='number'))throw Error('Unknown retained scope shape');
  if(stored){
    const value=jsonValue(stored);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='columns,correlation,version'||value.version!==1||!value.columns||Array.isArray(value.columns)||!value.correlation||Array.isArray(value.correlation)||Object.keys(value.columns).sort().join(',')!==columns.join(',')||Object.keys(value.correlation).some(k=>!CORRELATION_SCOPE.includes(k))||Object.values(value.correlation).some(v=>!UUID.test(v||'')))throw Error('Unknown retained scope shape');
    if(columns.some(k=>value.columns[k]!==row[k]))throw Error('Retained scope mismatch');
    if(table!=='cp_effect_outbox'&&Object.keys(value.correlation).length)throw Error('Unknown retained scope shape');
    Object.assign(correlation,value.correlation);
  }
  if(table==='cp_effect_outbox'&&Object.hasOwn(row,'correlation')){
    const value=jsonValue(row.correlation);
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Unknown retained correlation shape');
    if(value.content_state==='erased'){
      if(!stored||!Number.isSafeInteger(value.erasure_generation)||!db.prepare("SELECT 1 FROM memory_erasure_markers WHERE generation=? AND action='operator_erasure'").get(value.erasure_generation))throw Error('Unanchored erased correlation scope');
    }else{
      const present={};
      for(const k of CORRELATION_SCOPE)if(value[k]!=null){if(!UUID.test(value[k]))throw Error('Unknown retained correlation scope');present[k]=value[k];}
      if(stored&&JSON.stringify(present)!==JSON.stringify(correlation))throw Error('Retained correlation scope mismatch');
      Object.assign(correlation,present);
    }
  }
  return JSON.stringify({version:1,columns:envelope,correlation});
}
function preventReplay(db,table,row,generation,scope) {
  const keys=replayKeys(db,table),rowKey=JSON.stringify(keys.map(k=>row[k]));
  db.prepare('INSERT OR IGNORE INTO memory_erasure_content_rows(table_name,row_key,generation,scope_json) VALUES(?,?,?,?)').run(table,rowKey,generation,scope);
  replayGuards(db,table,keys);
}
// Explicit maintenance, after opaque identity rewrite. Never resolve a stale
// key through its erased content components or persist a content-derived alias.
function upgradeReplayKeys(db) {
  if(!exists(db,'memory_erasure_content_rows'))return {upgraded_replay_keys:0,authority:false};
  return transaction(db,()=>{
    let count=0;
    for(const tracked of db.prepare('SELECT * FROM memory_erasure_content_rows ORDER BY table_name,row_key').all()){
      const table=tracked.table_name,keys=replayKeys(db,table),primary=validateSchema(db,table).filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
      const old=jsonValue(tracked.row_key);if(!Array.isArray(old))throw Error('Unknown retained replay key shape');
      if(keys.length===primary.length&&keys.every((k,i)=>k===primary[i])){if(old.length!==keys.length)throw Error('Unknown retained replay key shape');replayGuards(db,table,keys,{replace:true});continue;}
      if(old.length===keys.length){
        const current=db.prepare(`SELECT count(*) n FROM ${quoted(table)} WHERE ${keys.map(k=>quoted(k)+' IS ?').join(' AND ')}`).get(...old).n;
        if(current===1){replayGuards(db,table,keys,{replace:true});continue;}
        if(old.length!==primary.length)throw Error('Unanchored retained replay key');
      }
      if(old.length!==primary.length)throw Error('Unknown retained replay key shape');
      const retained=primary.filter(k=>fields[table].classification[k]==='A');if(!retained.length)throw Error('Unanchored retained replay key');
      const rows=db.prepare(`SELECT ${keys.map(quoted).join(',')} FROM ${quoted(table)} WHERE ${retained.map(k=>quoted(k)+' IS ?').join(' AND ')}`).all(...retained.map(k=>old[primary.indexOf(k)]));
      if(rows.length!==1)throw Error('Ambiguous retained replay origin');
      const next=JSON.stringify(keys.map(k=>rows[0][k]));
      db.prepare('DELETE FROM memory_erasure_content_rows WHERE table_name=? AND row_key=?').run(table,tracked.row_key);
      db.prepare('INSERT OR IGNORE INTO memory_erasure_content_rows(table_name,row_key,generation,scope_json) VALUES(?,?,?,?)').run(table,next,tracked.generation,tracked.scope_json);count++;
      replayGuards(db,table,keys,{replace:true});
    }
    return {upgraded_replay_keys:count,authority:false};
  });
}
function assertReplayKeys(db) {
  if(!exists(db,'memory_erasure_content_rows'))return;
  for(const row of db.prepare('SELECT table_name,row_key,scope_json FROM memory_erasure_content_rows').all()){
    const keys=replayKeys(db,row.table_name),value=jsonValue(row.row_key);
    if(!Array.isArray(value)||value.length!==keys.length)throw Error('Legacy replay identity requires explicit migration');
    const matches=db.prepare(`SELECT * FROM ${quoted(row.table_name)} WHERE ${keys.map(k=>quoted(k)+' IS ?').join(' AND ')}`).all(...value);
    if(matches.length!==1)throw Error('Unanchored replay identity requires explicit migration');
    if(row.scope_json)scopeEvidence(db,row.table_name,matches[0],{stored:row.scope_json});
  }
}
function reconcileRetainedRows(db,source) {
  assertReadable(source);
  if(!exists(source,'memory_erasure_content_rows'))return {reconciled_retained_rows:0,authority:false};
  return transaction(db,()=>{
    let count=0;
    for(const tracked of source.prepare('SELECT * FROM memory_erasure_content_rows ORDER BY table_name,row_key').all()){
      const table=tracked.table_name,keys=replayKeys(source,table),key=jsonValue(tracked.row_key);
      if(!Array.isArray(key)||key.length!==keys.length||keys.some(k=>fields[table].classification[k]!=='A'))throw Error('Unknown recovery replay identity');
      const sourceMarker=source.prepare("SELECT store,identity,action FROM memory_erasure_markers WHERE generation=? AND action='operator_erasure'").get(tracked.generation);
      if(!sourceMarker)throw Error('Unanchored recovery disposition');
      const targetMarker=db.prepare('SELECT generation FROM memory_erasure_markers WHERE store=? AND identity=? AND action=?').get(sourceMarker.store,sourceMarker.identity,sourceMarker.action);
      if(!targetMarker)throw Error('Missing recovery erasure generation');
      const original=source.prepare(`SELECT * FROM ${quoted(table)} WHERE ${keys.map(k=>quoted(k)+' IS ?').join(' AND ')}`).all(...key);
      if(original.length!==1)throw Error('Unanchored recovery disposition');
      const scope=scopeEvidence(source,table,original[0],{stored:tracked.scope_json});
      if(!exists(db,table))continue;
      const targetKeys=replayKeys(db,table);
      if(JSON.stringify(targetKeys)!==JSON.stringify(keys))throw Error('Recovery replay schema mismatch');
      const recovered=db.prepare(`SELECT * FROM ${quoted(table)} WHERE ${keys.map(k=>quoted(k)+' IS ?').join(' AND ')}`).all(...key);
      if(!recovered.length)continue;
      if(recovered.length!==1)throw Error('Ambiguous recovery disposition');
      scopeEvidence(db,table,recovered[0],{stored:scope});
      const prior=db.prepare('SELECT generation,scope_json FROM memory_erasure_content_rows WHERE table_name=? AND row_key=?').get(table,tracked.row_key);
      if(prior&&(prior.generation!==targetMarker.generation||prior.scope_json&&prior.scope_json!==scope))throw Error('Recovery disposition conflict');
      db.prepare('INSERT INTO memory_erasure_content_rows(table_name,row_key,generation,scope_json) VALUES(?,?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET scope_json=excluded.scope_json').run(table,tracked.row_key,targetMarker.generation,scope);
      replayGuards(db,table,keys);count++;
    }
    return {reconciled_retained_rows:count,authority:false};
  });
}
function jsonValue(text) {
  try{return JSON.parse(text);}catch{throw Error('Unknown retained content shape');}
}
function references(value,ids) {
  if(typeof value==='string')return ids.has(value);
  if(Array.isArray(value))return value.some(x=>references(x,ids));
  if(value&&typeof value==='object')return Object.values(value).some(x=>references(x,ids));
  return false;
}
function rowReferences(row,ids,table) {
  return Object.entries(row).some(([key,value])=>{
    if(typeof value!=='string')return false;
    const allowed=NON_CONTENT_ENUMS[table]?.[key];if(allowed){if(!allowed.has(value))throw Error('Unknown retained outcome shape');return false;}
    if(ids.has(value))return true;
    if(/_json$|^(snapshot|record|contract|packet|refs|selection|metadata|evidence|result|normalized|manifest|envelope|proposal|correlation|outcome)$/.test(key)||key==='payload'&&JSON_PAYLOADS.has(table))return references(jsonValue(value),ids);
    return false;
  });
}
function root(db,marker) {
  let row;
  if(marker.store==='personal')row=exists(db,'personal_memories')&&db.prepare('SELECT * FROM personal_memories WHERE memory_id=?').get(marker.identity);
  if(marker.store==='governed')row=exists(db,'authority_memories')&&db.prepare('SELECT * FROM authority_memories WHERE id=?').get(marker.identity);
  if(marker.store==='project_v2')row=exists(db,'project_memory_v2_missions')&&db.prepare('SELECT * FROM project_memory_v2_missions WHERE mission_id=?').get(marker.identity);
  if(marker.store==='scratch')row=exists(db,'memory_entries')&&db.prepare('SELECT * FROM memory_entries WHERE id=?').get(marker.identity);
  const scope=require('./memory-erasure').scopeHash;
  const actual=row&&(marker.store==='personal'?scope([row.domain,row.project_id,row.task_id,row.session_id]):marker.store==='governed'?scope([row.operator_id,row.project_id,row.scope]):marker.store==='project_v2'?scope([row.task_id,row.workspace,row.scope_json]):scope([row.task_id]));
  if(actual&&actual!==marker.scope_hash)throw Error('Content erasure scope mismatch');
  return row||null;
}
function targets(db,marker) {
  const primary=root(db,marker), ids=new Set([marker.identity]), missionIds=new Set(), taskIds=new Set();
  if(marker.store==='personal'&&marker.action==='operator_erasure'){
    if(!['none','verified'].includes(marker.source_provenance))throw Error('Personal memory source provenance migration required');
    if(marker.source_provenance==='verified'){
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker.source_event_id||'')||!exists(db,'event_ledger_events'))throw Error('Personal memory source provenance unavailable');
      const event=db.prepare('SELECT task_id,session_id,event_type FROM event_ledger_events WHERE event_id=?').get(marker.source_event_id);
      if(!event||event.event_type==='architecture.identity_origin'||primary&&['task_id','session_id'].some(k=>(event[k]||null)!==(primary[k]||null)))throw Error('Personal memory source scope mismatch');
      ids.add(marker.source_event_id);
    }
  }
  if(marker.store==='project_v2')missionIds.add(marker.identity);
  if(primary?.task_id)taskIds.add(primary.task_id);
  const rows=[],retired=new Set(db.prepare('SELECT table_name,row_key FROM memory_erasure_content_rows WHERE generation=?').all(marker.generation).map(r=>r.table_name+':'+r.row_key));
  for(const table of tables(db)) {
    if(EXCLUDED.has(table)||table.startsWith('memory_erasure_')||/_fts(?:_|$)/.test(table))continue;
    // Unknown extension stores cannot participate silently in the erase promise.
    if(!fields[table])throw Error('Unclassified retained store');
    validateSchema(db,table);
    const keys=[...retired].some(key=>key.startsWith(table+':'))?replayKeys(db,table):[];
    for(const row of db.prepare(`SELECT rowid AS _rowid,* FROM ${quoted(table)} ORDER BY rowid`).all()) {
      if(table==='event_ledger_events'&&row.event_type==='memory.content_redacted'||table==='authority_ledger_entries'&&row.kind==='memory.redacted')continue;
      rows.push({table,row,retired:retired.has(table+':'+JSON.stringify(keys.map(k=>row[k])))});
    }
  }
  const selected=new Map();let changed=true;
  while(changed) {
    changed=false;
    for(const target of rows) {
      const {table,row}=target,key=table+':'+row._rowid;if(selected.has(key))continue;
      const linked=target.retired||rowReferences(row,ids,table)||missionIds.has(row.mission_id)||(/missions$/.test(table)&&missionIds.has(row.id))||taskIds.has(row.task_id)||(table==='task_states'&&taskIds.has(row.id));
      if(!linked)continue;
      // Project IDs never enter the graph: unrelated memories in the same
      // project/operator remain intact. A whole delivered context is revoked.
      selected.set(key,target);changed=true;
      if(row.task_id)taskIds.add(row.task_id);
      if(table==='task_states')taskIds.add(row.id);
      for(const key of ['id','candidate_id','observation_id','context_pack_id','entry_id','event_id','verification_id','result_id','dispatch_id','attempt_id','record_id'])if(row[key])ids.add(row[key]);
      if(table==='cp_invocations'&&row.origin_event_id)ids.add(row.origin_event_id);
      if(/context_pack|handoff|work_binding/.test(table)){if(row.mission_id)missionIds.add(row.mission_id);if(row.task_id)taskIds.add(row.task_id);}
      if(/missions$/.test(table)){missionIds.add(row.id||row.mission_id);if(row.task_id)taskIds.add(row.task_id);}
    }
  }
  return {rows:[...selected.values()],taskIds,ids};
}
function redactRow(db,table,row,marker) {
  const columns=validateSchema(db,table), values={}, digest=metadataDigest(table,row);
  const keys=replayKeys(db,table),rowKey=JSON.stringify(keys.map(k=>row[k])),retired=db.prepare('SELECT scope_json FROM memory_erasure_content_rows WHERE table_name=? AND row_key=?').get(table,rowKey);
  const scope=scopeEvidence(db,table,row,{stored:retired?.scope_json});
  for(const [key,allowed]of Object.entries(NON_CONTENT_ENUMS[table]||{}))if(!allowed.has(row[key]))throw Error('Unknown retained outcome shape');
  for(const c of columns) {
    const kind=fields[table].classification[c.name];if(kind==='A')continue;
    if(kind==='D'){values[c.name]=c.notnull?digest:null;continue;}
    const old=row[c.name];if(old===null)continue;
    if(c.type==='INTEGER'||c.type==='REAL'){values[c.name]=0;continue;}
    if(/_json$|^(snapshot|record|contract|packet|selection|metadata|evidence|result|normalized|manifest|envelope|proposal|correlation|outcome)$/.test(c.name)||c.name==='payload'&&JSON_PAYLOADS.has(table)) {
      const decoded=jsonValue(old);values[c.name]=Array.isArray(decoded)?'[]':JSON.stringify({content_state:'erased',erasure_generation:marker.generation,authority:false});
    }else if(/^(refs|options|source_refs|domains|tags)$/.test(c.name)) {jsonValue(old);values[c.name]='[]';}
    else values[c.name]=c.notnull?'[erased]':null;
  }
  if(UUID_REPLAY_KEYS[table]){
    // Correlation is erasable external payload; preserve only the independent
    // record identity. This also prevents redacted composite-key collisions.
    values.request_id=row[UUID_REPLAY_KEYS[table]];
  }
  // A shared text marker cannot replace distinct UNIQUE payload coordinates.
  // Allocate independent randomness once; canonical replay disposition proves
  // when a previously allocated tombstone may be reused on retry/migration.
  const uniqueText=new Set();
  for(const index of db.prepare(`PRAGMA index_list(${quoted(table)})`).all().filter(i=>i.unique)){
    const indexKeys=db.prepare(`PRAGMA index_info(${quoted(index.name)})`).all().map(k=>k.name);
    const erased=indexKeys.filter(k=>k&&values[k]==='[erased]');if(!erased.length)continue;
    const retained=indexKeys.filter(k=>k&&fields[table].classification[k]==='A'||UUID_REPLAY_KEYS[table]&&k==='request_id').map(k=>UUID_REPLAY_KEYS[table]&&k==='request_id'?UUID_REPLAY_KEYS[table]:k);
    // A composite constraint with an independently unique retained coordinate
    // cannot collapse. Keep its ordinary content marker rather than inventing
    // a second tombstone identity for a subject/owner field.
    if(retained.length&&!db.prepare(`SELECT 1 FROM ${quoted(table)} GROUP BY ${retained.map(quoted).join(',')} HAVING count(*)>1 LIMIT 1`).get())continue;
    erased.forEach(k=>uniqueText.add(k));
  }
  if(uniqueText.size){
    for(const key of uniqueText)values[key]=retired&&/^erased:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row[key]||'')?row[key]:'erased:'+randomUUID();
  }
  if(table==='chatgpt_events'){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.record_id||''))throw Error('ChatGPT correlation identity requires host migration');values.event_id=row.record_id;values.payload=JSON.stringify({content_state:'erased',erasure_generation:marker.generation,authority:false});}
  // Counter/marker fields cannot reveal the erased payload's size or digest.
  if(table==='event_ledger_events'){Object.assign(values,{payload:null,payload_sha256:null,payload_byte_length:0,payload_stored_byte_length:0,payload_redacted:1});}
  if(table==='authority_ledger_entries') {
    delete values.previous_hash;delete values.entry_hash;
    const payload=jsonValue(row.payload_json),keep=['version','reference_id','mission_id','revision','run_id','agent_id','state','previous'];
    values.payload_json=JSON.stringify({...Object.fromEntries(Object.entries(payload).filter(([k])=>keep.includes(k))),content_state:'erased',erasure_generation:marker.generation});
  }
  if(table==='task_states') {
    const task=jsonValue(row.snapshot),keep=['id','sessionId','sessionDir','workspace','status','createdAt','updatedAt'];
    if(['opencode','pi','claude_code','codex','cursor'].includes(task.executionAgent))keep.push('executionAgent');
    values.snapshot=JSON.stringify({...Object.fromEntries(Object.entries(task).filter(([k])=>keep.includes(k))),description:'[erased]',context:null,lastResult:null,events:[],retrievedMemory:[],content_state:'erased',erasure_generation:marker.generation});
  }
  if(!Object.keys(values).length){if(columns.some(c=>fields[table].classification[c.name]!=='A'))preventReplay(db,table,row,marker.generation,scope);return false;}
  if(Object.entries(values).every(([key,value])=>row[key]===value)){preventReplay(db,table,row,marker.generation,scope);return false;}
  permitRedaction(db,table);
  db.prepare(`UPDATE ${quoted(table)} SET ${Object.keys(values).map(k=>quoted(k)+'=?').join(',')} WHERE rowid=?`).run(...Object.values(values),row._rowid);
  preventReplay(db,table,row,marker.generation,scope);
  return true;
}
function rechain(db) {
  if(!exists(db,'authority_ledger_entries'))return;
  permitRedaction(db,'authority_ledger_entries');
  const heads=new Map();
  for(const row of db.prepare('SELECT * FROM authority_ledger_entries ORDER BY project_id,sequence').all()) {
    row.previous_hash=heads.get(row.project_id)||genesisHash(row.project_id);row.entry_hash=canonicalHash(ledgerEnvelope(row));
    db.prepare('UPDATE authority_ledger_entries SET previous_hash=?,entry_hash=? WHERE entry_id=?').run(row.previous_hash,row.entry_hash,row.entry_id);
    heads.set(row.project_id,row.entry_hash);
  }
  for(const [project,hash]of heads)db.prepare('UPDATE authority_ledger_heads SET entry_hash=? WHERE project_id=?').run(hash,project);
}
function audit(db,marker,count,now,transition) {
  const {EventLedger}=require('./event-ledger'),ledger=new EventLedger(db,{now:()=>now});
  db.exec(`CREATE TRIGGER IF NOT EXISTS memory_redaction_event_immutable BEFORE UPDATE ON event_ledger_events WHEN old.event_type='memory.content_redacted' BEGIN SELECT RAISE(ABORT,'Immutable redaction event');END;
    CREATE TRIGGER IF NOT EXISTS memory_redaction_event_no_delete BEFORE DELETE ON event_ledger_events WHEN old.event_type='memory.content_redacted' BEGIN SELECT RAISE(ABORT,'Immutable redaction event');END;`);
  const prefix='content-redaction:'+marker.generation+':';
  if(count===0&&db.prepare('SELECT 1 FROM event_ledger_events WHERE idempotency_key LIKE ?').get(prefix+'%'))return;
  const idempotencyKey=prefix+canonicalHash(transition);
  if(db.prepare('SELECT 1 FROM event_ledger_events WHERE idempotency_key=?').get(idempotencyKey))return;
  ledger.record({eventType:'memory.content_redacted',agent:'bridge',direction:'internal',status:'applied',protected:true,idempotencyKey,
    metadata:{version:1,generation:marker.generation,scope_hash:marker.scope_hash,record_count:count,prior_chain_valid:true}});
  if(exists(db,'authority_ledger_entries')) {
    const primary=root(db,marker),project=primary?.project_id&&db.prepare('SELECT 1 FROM authority_projects WHERE id=?').get(primary.project_id)?primary.project_id:'authority:local';
    const head=db.prepare('SELECT sequence,entry_hash FROM authority_ledger_entries WHERE project_id=? ORDER BY sequence DESC LIMIT 1').get(project);
    const entry={project_id:project,sequence:(head?.sequence||0)+1,entry_id:randomUUID(),mission_id:null,mission_revision:null,run_id:null,kind:'memory.redacted',actor_type:'host',actor_id:'memory-erasure',
      payload_json:JSON.stringify({version:1,reference_id:marker.identity,generation:marker.generation,outcome:'applied',prior_chain_valid:true}),previous_hash:head?.entry_hash||genesisHash(project),timestamp:now};
    entry.entry_hash=canonicalHash(ledgerEnvelope(entry));
    db.prepare('INSERT INTO authority_ledger_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(entry.project_id,entry.sequence,entry.entry_id,null,null,null,entry.kind,entry.actor_type,entry.actor_id,entry.payload_json,entry.previous_hash,entry.entry_hash,now);
    db.prepare('INSERT INTO authority_ledger_heads VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET sequence=excluded.sequence,entry_hash=excluded.entry_hash').run(project,entry.sequence,entry.entry_hash);
  }
}
function propagate(db,marker,{now=Date.now(),beforeApply=null}={}) {
  const state=install(db);require('./capability-mac').clearNotificationCache();
  db.prepare("INSERT OR IGNORE INTO memory_erasure_content_progress VALUES(?,?,?,'pending',NULL,?)").run(marker.generation,marker.store,marker.identity,now);
  const prior=db.prepare('SELECT state FROM memory_erasure_content_progress WHERE generation=?').get(marker.generation);
  status(db,marker.generation,prior.state==='failed'?'retrying':'pending',now);
  try {
    const result=transaction(db,()=>{
      const affected=targets(db,marker);
      if(exists(db,'authority_ledger_entries')&&!verifyLedgerChain(db.prepare('SELECT * FROM authority_ledger_entries ORDER BY project_id,sequence').all()).valid)throw Error('Pre-redaction audit integrity invalid');
      state.writing=true;let count=0;
      try {
        if(beforeApply)beforeApply();
        const changed=[];
        for(const {table,row}of affected.rows){
          // Host privacy transitions may update primary envelope metadata.
          // Commitments must use that current envelope on the first pass so a
          // retry cannot manufacture a second redaction of unchanged content.
          const current=beforeApply?db.prepare(`SELECT rowid AS _rowid,* FROM ${quoted(table)} WHERE rowid=?`).get(row._rowid):row;
          if(!current)throw Error('Retained redaction target changed');
          if(redactRow(db,table,current,marker)){count++;changed.push([table,current._rowid]);}
        }
        if(count)rechain(db);
        audit(db,marker,count,now,changed);status(db,marker.generation,'applied',now);
      } finally {state.writing=false;}
      return {count,taskIds:[...affected.taskIds],legacyIdentifierRisk:affected.rows.some(({table,row})=>['authority_memory_candidates','authority_context_pack_manifests'].includes(table)&&/^sha256:/.test(row.id||''))};
    });
    // File/driver ports are host registrations. An absent port cannot claim
    // erasure of retained sessions/artifacts; applied remains unreadable.
    const auditCleanup=state.attachments.get('audit-files');if(auditCleanup)auditCleanup(result.taskIds,marker);
    for(const taskId of result.taskIds) {
      const cleanup=state.attachments.get('task-files');if(!cleanup&&exists(db,'task_states'))throw Error('Retained task files need host erasure port');
      if(cleanup)cleanup(taskId,marker);
    }
    status(db,marker.generation,'complete',now);
    return {generation:marker.generation,state:'complete',redacted_records:result.count,canonicalPayloadRedacted:true,legacyIdentifierRisk:result.legacyIdentifierRisk,physicalErasure:false,authority:false};
  } catch {
    status(db,marker.generation,'failed',now);
    throw Error('Content erasure propagation incomplete; retained reads denied');
  }
}
function attach(db,name,cleanup){const state=install(db);if(typeof cleanup!=='function')throw Error('Host erasure port required');state.attachments.set(name,cleanup);}
function assertContext(db,id) {
  assertReadable(db);
  if(require('./memory-identity').hasLegacyIdentifiers({context_pack_id:id}))throw Error('Legacy execution context identity requires migration');
  if(!id||!exists(db,'memory_erasure_content_rows'))return;
  for(const table of ['cp_context_packs','authority_context_pack_manifests'])if(db.prepare('SELECT 1 FROM memory_erasure_content_rows WHERE table_name=? AND row_key=?').get(table,JSON.stringify([id])))throw Error('Retained execution context erased; replay denied');
}
function qualification(db) {
  const unknown=exists(db,'memory_erasure_markers')?db.prepare("SELECT count(*) n FROM memory_erasure_markers WHERE store='personal' AND action='operator_erasure' AND source_provenance='unverified'").get().n:0;
  const pending=(exists(db,'memory_erasure_content_progress')?db.prepare("SELECT count(*) n FROM memory_erasure_content_progress WHERE state<>'complete'").get().n:0)+unknown;
  let legacyIdentifiers=0;
  for(const table of ['authority_memory_candidates','authority_context_pack_manifests'])if(exists(db,table))legacyIdentifiers+=db.prepare(`SELECT count(*) n FROM ${table} WHERE id LIKE 'sha256:%'`).get().n;
  return {pending_generations:pending,unverified_source_provenance:unknown,legacy_content_identifiers:legacyIdentifiers,legacy_identifier_migration_required:legacyIdentifiers>0,authority:false};
}
function assertReadable(db) {
  require('./memory-identity').assertReadable(db);
  require('./memory-erasure').assertCurrent(db);
  for(const table of ['cp_agent_dispatch_intents','cp_agent_dispatch_attempts'])if(exists(db,table))validateSchema(db,table);
  assertReplayKeys(db);
  if(exists(db,'memory_erasure_markers')&&db.prepare("SELECT 1 FROM memory_erasure_markers WHERE store='personal' AND action='operator_erasure' AND source_provenance='unverified'").get())throw Error('Personal memory source provenance migration required');
  if(!exists(db,'memory_erasure_content_progress')) {
    if(exists(db,'memory_erasure_markers')&&db.prepare("SELECT 1 FROM memory_erasure_markers WHERE action='operator_erasure'").get())throw Error('Content erasure propagation incomplete; retained reads denied');
    return;
  }
  if(db.prepare("SELECT 1 FROM memory_erasure_content_progress WHERE state<>'complete'").get())throw Error('Content erasure propagation incomplete; retained reads denied');
  if(exists(db,'memory_erasure_markers')&&db.prepare("SELECT 1 FROM memory_erasure_markers e WHERE e.action='operator_erasure' AND NOT EXISTS(SELECT 1 FROM memory_erasure_content_progress p WHERE p.generation=e.generation AND p.state='complete')").get())throw Error('Content erasure propagation incomplete; retained reads denied');
}
function verify(db) {
  const chain=exists(db,'authority_ledger_entries')?verifyLedgerChain(db.prepare('SELECT * FROM authority_ledger_entries ORDER BY project_id,sequence').all()):{valid:true};
  const events=exists(db,'event_ledger_events')?db.prepare("SELECT * FROM event_ledger_events WHERE event_type='memory.content_redacted' ORDER BY seq").all():[];
  return {valid:chain.valid&&events.every(r=>r.payload===null&&r.protected===1&&JSON.parse(r.metadata).prior_chain_valid===true),events:events.length};
}
module.exports={install,propagate,attach,assertReadable,assertContext,qualification,verify,fields,upgradeReplayKeys,reconcileRetainedRows};
