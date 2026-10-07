'use strict';
// Host-owned privacy markers in the canonical SQLite store. No runtime port,
// retrieval authority, content, or model-supplied restore evidence is accepted.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { transaction } = require('./control-transaction');
const STORES = new Set(['personal', 'governed', 'project_v2', 'vault', 'scratch']);
const ACTIONS = new Set(['forget', 'expiry', 'operator_erasure']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const restoreWitnesses = new WeakMap();
function disposition(db) {
  const identities={};
  for(const table of ['memory_identity_meta','memory_identity_progress','memory_identity_lineage'])if(exists(db,table)) {
    const order=table==='memory_identity_lineage'?'record_class,anchor_id':'id';
    identities[table]=db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  }
  const provenance=db.prepare('SELECT generation,source_event_id,source_provenance FROM memory_erasure_markers ORDER BY generation').all();
  const retained=exists(db,'memory_erasure_content_rows')?db.prepare('SELECT * FROM memory_erasure_content_rows ORDER BY table_name,row_key').all():[];
  const supersession={};
  if(exists(db,'personal_memories'))supersession.personal=db.prepare('SELECT memory_id,domain,project_id,task_id,session_id,status,superseded_by,expires_at FROM personal_memories ORDER BY memory_id').all();
  if(exists(db,'authority_memories'))supersession.governed=db.prepare('SELECT id,operator_id,project_id,scope,status,superseded_by_id,effective_until,expires_at,ttl_ms,last_verified_at FROM authority_memories ORDER BY id').all();
  return scopeHash({markers:db.prepare('SELECT store,identity,scope_hash,action,erased_at FROM memory_erasure_markers ORDER BY store,identity,action').all(),provenance,identities,retained,supersession});
}
function assertCurrent(db,seen=new Set()) {
  if(seen.has(db))throw Error('Cyclic recovery authority requires independent current evidence');
  seen.add(db);
  const witness=restoreWitnesses.get(db);
  if(witness) {
    assertCurrent(witness.source,seen);
    if(disposition(witness.source)!==witness.hash)throw Error('Restored state has stale erasure generation; recovery required');
  }
}
function exists(db, table) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table); }
function scopeHash(parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function validate(row) {
  if (!STORES.has(row.store) || typeof row.identity !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(row.identity) ||
      !/^[a-f0-9]{64}$/.test(row.scope_hash) || !ACTIONS.has(row.action) || !Number.isSafeInteger(row.erased_at) || row.erased_at < 0) throw Error('Invalid erasure marker');
  if (row.source_event_id != null && !UUID.test(row.source_event_id)) throw Error('Invalid erasure source identity');
  if (row.source_provenance !== undefined && !['none','verified','unverified'].includes(row.source_provenance)) throw Error('Invalid erasure source provenance');
  if (row.source_provenance === 'verified' && !row.source_event_id || row.source_event_id && row.source_provenance !== 'verified') throw Error('Invalid erasure source provenance');
}
// PersonalMemory has one local owner and explicit project/task/session scopes.
// A source event with additional or unverifiable owner scope cannot authorize
// erasure of another record. Capture this relation before removing its payload.
function personalSourceEvent(db,row) {
  if (!row.source_event_id) return {source_event_id:null,source_provenance:'none'};
  if (!UUID.test(row.source_event_id) || !exists(db,'event_ledger_events')) throw Error('Personal memory source provenance unavailable');
  const event=db.prepare('SELECT * FROM event_ledger_events WHERE event_id=?').get(row.source_event_id);
  let metadata;try{metadata=event&&JSON.parse(event.metadata);}catch{}
  if (!event || !metadata || typeof metadata!=='object' || Array.isArray(metadata) || event.event_type==='architecture.identity_origin') throw Error('Personal memory source provenance unavailable');
  for (const key of ['task_id','session_id']) if ((event[key]||null)!==(row[key]||null) || metadata[key]!=null&&metadata[key]!==row[key]) throw Error('Personal memory source scope mismatch');
  if ((metadata.project_id||null)!==(row.project_id||null) || event.mission_id&&!row.task_id || metadata.operator_id!=null) throw Error('Personal memory source scope mismatch');
  if(event.mission_id){
    const missions=[];
    for(const table of ['cp_missions','authority_missions'])if(exists(db,table)){
      const mission=db.prepare(`SELECT task_id,project_id FROM ${table} WHERE id=?`).get(event.mission_id);if(mission)missions.push(mission);
    }
    if(!missions.length||missions.some(m=>(m.task_id||null)!==(row.task_id||null)||(m.project_id||null)!==(row.project_id||null)))throw Error('Personal memory source mission scope mismatch');
  }
  return {source_event_id:event.event_id,source_provenance:'verified'};
}
function migrate(db) {
  if (exists(db, 'memory_erasure_meta') && db.prepare('SELECT version FROM memory_erasure_meta WHERE id=1').get()?.version !== 1) throw Error('Unsupported erasure schema');
  transaction(db, () => {db.exec(`
    CREATE TABLE IF NOT EXISTS memory_erasure_meta(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
    INSERT OR IGNORE INTO memory_erasure_meta VALUES(1,1);
    CREATE TABLE IF NOT EXISTS memory_erasure_markers(
      generation INTEGER PRIMARY KEY AUTOINCREMENT, store TEXT NOT NULL, identity TEXT NOT NULL,
      scope_hash TEXT NOT NULL, action TEXT NOT NULL, erased_at INTEGER NOT NULL,
      source_event_id TEXT,source_provenance TEXT NOT NULL DEFAULT 'unverified',UNIQUE(store,identity,action));
    CREATE TRIGGER IF NOT EXISTS memory_erasure_immutable BEFORE UPDATE ON memory_erasure_markers BEGIN SELECT RAISE(ABORT,'Immutable erasure marker'); END;
    CREATE TRIGGER IF NOT EXISTS memory_erasure_no_delete BEFORE DELETE ON memory_erasure_markers BEGIN SELECT RAISE(ABORT,'Durable erasure marker'); END;
    CREATE TABLE IF NOT EXISTS memory_erasure_progress(store TEXT NOT NULL,identity TEXT NOT NULL,state TEXT NOT NULL,
      safe_error_class TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(store,identity));
  `);const columns=new Set(db.prepare('PRAGMA table_info(memory_erasure_markers)').all().map(c=>c.name));
    if(!columns.has('source_event_id'))db.exec('ALTER TABLE memory_erasure_markers ADD COLUMN source_event_id TEXT');
    if(!columns.has('source_provenance'))db.exec("ALTER TABLE memory_erasure_markers ADD COLUMN source_provenance TEXT NOT NULL DEFAULT 'unverified'");
  });
  require('./memory-content-erasure').install(db);
  require('./memory-identity').install(db);
}
function marker(db, store, identity) {
  assertCurrent(db);
  if (!exists(db, 'memory_erasure_markers')) return null;
  return db.prepare("SELECT * FROM memory_erasure_markers WHERE store=? AND identity=? ORDER BY CASE action WHEN 'operator_erasure' THEN 0 WHEN 'forget' THEN 1 ELSE 2 END,generation LIMIT 1").get(store, identity) || null;
}
function mark(db, { store, identity, scope_hash, action = 'forget', erased_at = Date.now(),source_event_id=null,source_provenance='none' }) {
  const row = { store, identity, scope_hash, action, erased_at,source_event_id,source_provenance }; validate(row); migrate(db);
  return transaction(db, () => {
    const prior = marker(db, store, identity);
    if (prior && prior.scope_hash !== scope_hash) throw Error('Erasure scope mismatch');
    const inserted = db.prepare('INSERT OR IGNORE INTO memory_erasure_markers(store,identity,scope_hash,action,erased_at,source_event_id,source_provenance) VALUES(?,?,?,?,?,?,?)').run(store, identity, scope_hash, action, erased_at,source_event_id,source_provenance);
    if (inserted.changes) db.prepare("INSERT INTO memory_erasure_progress VALUES(?,?,'pending',NULL,?) ON CONFLICT(store,identity) DO UPDATE SET state='pending',safe_error_class=NULL,updated_at=excluded.updated_at").run(store, identity, erased_at);
    else db.prepare("INSERT OR IGNORE INTO memory_erasure_progress VALUES(?,?,'pending',NULL,?)").run(store, identity, erased_at);
    return marker(db, store, identity);
  });
}
function progress(db, store, identity, state, now = Date.now()) {
  if (!['pending', 'retryable', 'purged', 'suppressed_immutable_retention'].includes(state)) throw Error('Invalid erasure progress');
  db.prepare('UPDATE memory_erasure_progress SET state=?,safe_error_class=?,updated_at=? WHERE store=? AND identity=?').run(state, state === 'retryable' ? 'store_purge_failed' : null, now, store, identity);
}
function reconcile(db, source) {
  if (!source || source === db || !exists(source, 'memory_erasure_meta') || source.prepare('SELECT version FROM memory_erasure_meta WHERE id=1').get()?.version !== 1) throw Error('Restore requires current independent erasure database');
  assertCurrent(source,new Set([db]));
  const targetFile = db.prepare('PRAGMA database_list').all().find(r => r.name === 'main')?.file;
  const sourceFile = source.prepare('PRAGMA database_list').all().find(r => r.name === 'main')?.file;
  if (targetFile && sourceFile) {
    const a = fs.statSync(targetFile), b = fs.statSync(sourceFile);
    if (a.dev === b.dev && a.ino === b.ino) throw Error('Restore requires current independent erasure database');
  }
  const sourceHash=disposition(source);
  const rows = source.prepare('SELECT store,identity,scope_hash,action,erased_at,source_event_id,source_provenance FROM memory_erasure_markers ORDER BY generation').all();
  rows.forEach(validate); migrate(db);
  const priorWitness=restoreWitnesses.get(db);restoreWitnesses.delete(db);
  let retained;
  try { transaction(db, () => { for (const row of rows) mark(db, row);retained=require('./memory-content-erasure').reconcileRetainedRows(db,source);if(disposition(source)!==sourceHash)throw Error('Erasure generation changed during recovery'); }); }
  catch(error){if(priorWitness)restoreWitnesses.set(db,priorWitness);throw error;}
  restoreWitnesses.set(db,{source,hash:sourceHash});
  return { reconciled: rows.length,...retained,physicalErasure: false, authority: false };
}
function redacted(value) {
  if (!value) return value;
  return { id: value.id || value.memory_id || value.memoryId, memory_id: value.memory_id || value.id || value.memoryId,
    status: 'forgotten', contentRemoved: true, erased: true, authority: false };
}
function packetUsable(db, packet) {
  if(!require('./memory-identity').packetUsable(db,packet))return false;
  try { require('./memory-content-erasure').assertReadable(db); } catch { return false; }
  const pack = packet?.context_pack || packet;
  if (pack?.content_state === 'erased' || pack?.privacy_state === 'revoked') return false;
  const ids = new Set([...(pack?.retrieved_memory_ids || []), ...(pack?.refs || []).map(x => x.memory_id), ...(pack?.records || []).map(x => x.memory_id || x.memoryId)].filter(Boolean));
  return [...ids].every(id => !marker(db, 'personal', id) && !marker(db, 'governed', id));
}
module.exports = { migrate, marker, mark, progress, reconcile, scopeHash, exists, redacted, packetUsable, assertCurrent, personalSourceEvent };
