'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {PersonalMemory}=require('../src/personal-memory');
const {AuthorityStore}=require('../src/authority-store');
const {AuthorityMemory}=require('../src/authority-memory');
const {EventLedger}=require('../src/event-ledger');
const erasure=require('../src/memory-erasure'),content=require('../src/memory-content-erasure');
const {canonicalHash}=require('../src/authority-hash');
function fixture(t) {
  const db=new DatabaseSync(':memory:'),store=new AuthorityStore(db),memory=new AuthorityMemory(store);new EventLedger(db);
  t.after(()=>db.close());
  const c=memory.ingest({session_id:'session-a',chunk_id:'chunk-a',timestamp:1,speaker:'operator',claim:'No micro-prompts. My personal canary violet.',kind:'personal_preference',subject_key:'workflow.micro_prompts',value:'forbidden'},store.operator);
  const m=memory.promote(c.id,{},store.operator),pack=memory.build({operator_id:store.operatorId,include_personal:true});
  return {db,store,memory,c,m,pack};
}
test('erasure removes content, source digests and observation plaintext from canonical rows',t=>{
  const f=fixture(t),before=f.db.prepare('SELECT id,observed_at,operator_id,source_hash FROM authority_observations').get();
  f.memory.erase(f.m.id,f.store.operator);
  const after=f.db.prepare('SELECT * FROM authority_observations').get();
  assert.equal(after.id,before.id);assert.equal(after.observed_at,before.observed_at);assert.equal(after.operator_id,before.operator_id);
  assert.equal(after.claim,'[erased]');assert.notEqual(after.source_hash,before.source_hash);
  for(const table of ['authority_memories','authority_memory_candidates','authority_context_pack_items','authority_context_pack_manifests','authority_observations']) {
    const serialized=JSON.stringify(f.db.prepare('SELECT * FROM '+table).all());
    assert.equal(serialized.includes('personal canary'),false);assert.equal(serialized.includes('forbidden'),false);
  }
  assert.equal(f.store.integrity().ok,true);assert.equal(content.verify(f.db).valid,true);
});
test('retained event identities and ordering survive; redaction event is immutable',t=>{
  const f=fixture(t),before=f.store.readLedger('authority:local').map(e=>[e.entry_id,e.sequence,e.timestamp,e.kind,e.actor_type]);
  f.memory.erase(f.m.id,f.store.operator);
  assert.deepEqual(f.store.readLedger('authority:local').filter(e=>e.kind!=='memory.redacted').map(e=>[e.entry_id,e.sequence,e.timestamp,e.kind,e.actor_type]),before);
  assert.throws(()=>f.db.exec('UPDATE event_ledger_events SET status=\'failed\' WHERE event_type=\'memory.content_redacted\''),/Immutable/);
  assert.throws(()=>f.db.exec('DELETE FROM event_ledger_events WHERE event_type=\'memory.content_redacted\''),/Immutable/);
  assert.throws(()=>f.db.exec('UPDATE authority_observations SET observed_at=0'),/Immutable|replay denied/);
});
test('context replay and direct payload rehydration are denied after erasure',t=>{
  const f=fixture(t),snapshot=f.db.prepare('SELECT snapshot_json FROM authority_context_pack_items').get().snapshot_json;
  f.memory.erase(f.m.id,f.store.operator);
  assert.throws(()=>f.db.prepare('UPDATE authority_context_pack_items SET snapshot_json=?').run(snapshot),/Immutable|replay denied/);
  assert.equal(f.memory.items(f.pack.id)[0].value,undefined);
  assert.equal(erasure.packetUsable(f.db,{context_pack:{records:[{memory_id:f.m.id,value:'forbidden'}]}}),false);
});
test('purge is idempotent and emits one content-free audit transition',t=>{
  const f=fixture(t);f.memory.erase(f.m.id,f.store.operator);const first=f.db.prepare("SELECT * FROM event_ledger_events WHERE event_type='memory.content_redacted'").all();
  f.memory.erase(f.m.id,f.store.operator);assert.deepEqual(f.db.prepare("SELECT * FROM event_ledger_events WHERE event_type='memory.content_redacted'").all(),first);
  assert.equal(JSON.stringify(first).includes('canary'),false);
});
test('audit store failure retains a durable failed generation and retry repairs it',t=>{
  const f=fixture(t);f.db.exec("CREATE TRIGGER injected_audit BEFORE INSERT ON event_ledger_events WHEN new.event_type='memory.content_redacted' BEGIN SELECT RAISE(ABORT,'private injected diagnostic');END");
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);
  assert.equal(f.db.prepare('SELECT state FROM memory_erasure_content_progress').get().state,'failed');
  assert.throws(()=>f.store.readLedger('authority:local'),/incomplete/);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM memory_erasure_content_progress').all()).includes('private injected'),false);
  f.db.exec('DROP TRIGGER injected_audit');new AuthorityMemory(f.store);assert.equal(content.verify(f.db).valid,true);content.assertReadable(f.db);
});
test('context failure is visible, unreadable and retryable without leaking error text',t=>{
  const f=fixture(t);f.db.exec("CREATE TRIGGER injected_context BEFORE UPDATE ON authority_context_pack_items BEGIN SELECT RAISE(ABORT,'personal diagnostic');END");
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);
  assert.throws(()=>f.memory.items(f.pack.id),/incomplete/);
  f.db.exec('DROP TRIGGER injected_context');f.memory.erase(f.m.id,f.store.operator);assert.equal(f.memory.items(f.pack.id)[0].value,undefined);
});
test('unknown schema field fails closed and cannot be silently retained',t=>{
  const f=fixture(t);f.db.exec("ALTER TABLE authority_observations ADD COLUMN unknown_copy TEXT");
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);
  assert.throws(()=>content.assertReadable(f.db),/incomplete/);
});
test('unregistered vector or cache store prevents a false complete receipt',t=>{
  const f=fixture(t);f.db.exec('CREATE TABLE unregistered_vectors(id TEXT PRIMARY KEY,embedding BLOB)');
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);
  assert.equal(f.db.prepare('SELECT state FROM memory_erasure_content_progress').get().state,'failed');
});
test('cross-operator erase is rejected before a generation or redaction is written',t=>{
  const f=fixture(t);assert.throws(()=>f.memory.erase(f.m.id,{type:'operator',id:'other'}),/scope denied/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);
  assert.equal(f.memory.get(f.m.id).value,'forbidden');
});
test('other scope primary memory survives a linked-context revocation',t=>{
  const f=fixture(t),c=f.memory.ingest({session_id:'other',chunk_id:'other',timestamp:1,speaker:'operator',claim:'No AI attribution.',kind:'personal_preference',subject_key:'git.ai_attribution',value:'forbidden'},f.store.operator),other=f.memory.promote(c.id,{},f.store.operator);
  f.memory.erase(f.m.id,f.store.operator);assert.equal(f.memory.get(other.id).value,'forbidden');
});
test('event ledger payload and metadata are redacted with fixed counters and no personal digest',t=>{
  const f=fixture(t),ledger=new EventLedger(f.db),event=ledger.record({eventType:'memory.example',payload:'private event canary',metadata:{memory_id:f.m.id,note:'private event canary'}});
  f.memory.erase(f.m.id,f.store.operator);const result=ledger.get(event.event_id);
  assert.equal(result.payload,null);assert.equal(result.payload_sha256,null);assert.equal(result.payload_byte_length,0);assert.equal(JSON.stringify(result).includes('private event canary'),false);
});
test('unreadable generation excludes stale packets for every runtime boundary',t=>{
  const f=fixture(t);f.db.exec('CREATE TABLE unsupported_cache(id TEXT PRIMARY KEY,payload TEXT)');
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator));
  for(const runtime of ['pi','work','claude_code','cursor','cloud'])assert.equal(erasure.packetUsable(f.db,{runtime,records:[{memory_id:f.m.id,value:'forbidden'}]}),false);
});
test('personal primary and FTS cannot return erased content during concurrent retained read',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const memory=new PersonalMemory({db});
  const item=memory.remember({domain:'personal',type:'fact',subject:'canary',content:'Personal erasure iris',source:'user_explicit'});
  memory.erase(item.memoryId);assert.equal(memory.get(item.memoryId),null);assert.equal(memory.search('iris').items.length,0);
});
test('tampered source chain fails closed before any legacy redaction attestation',t=>{
  const f=fixture(t);f.db.exec('DROP TRIGGER authority_ledger_entries_update');f.db.exec("UPDATE authority_ledger_entries SET entry_hash=printf('%064d',1) WHERE sequence=1");
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);assert.equal(f.db.prepare("SELECT count(*) n FROM event_ledger_events WHERE event_type='memory.content_redacted'").get().n,0);
});
test('metadata integrity references do not contain hashes of erased values',t=>{
  const f=fixture(t),digest=canonicalHash('forbidden');f.memory.erase(f.m.id,f.store.operator);
  for(const table of ['authority_memories','authority_memory_candidates','authority_ledger_entries','authority_observations'])assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM '+table).all()).includes(digest),false);
});
function copiedFixture(t) {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'retention-copy-')),db=new DatabaseSync(path.join(dir,'current.sqlite')),personal=new PersonalMemory({db});
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const item=personal.remember({domain:'personal',type:'fact',subject:'restore canary',content:'Restore canary sapphire',source:'user_explicit'});
  const copy=path.join(dir,'old.sqlite');db.prepare('VACUUM INTO ?').run(copy);const old=new DatabaseSync(copy);t.after(()=>old.close());
  return {db,personal,item,old,dir};
}
test('authoritative deletion newer than a backup removes primary, FTS and stale context on restore',t=>{
  const f=copiedFixture(t);f.old.exec('CREATE TABLE cp_context_packs(id TEXT PRIMARY KEY,mission_id TEXT,run_id TEXT,refs TEXT,selection TEXT,content_hash TEXT,created_at INTEGER)');
  f.old.prepare('INSERT INTO cp_context_packs VALUES(?,?,?,?,?,?,?)').run('pack','mission',null,JSON.stringify([{memory_id:f.item.memoryId}]),JSON.stringify({snippet:'Restore canary sapphire'}),canonicalHash('Restore canary sapphire'),1);
  f.personal.erase(f.item.memoryId);const restored=new PersonalMemory({db:f.old,restoreFromBackup:true,erasureSourceDb:f.db});
  assert.equal(restored.get(f.item.memoryId),null);assert.equal(restored.search('sapphire').items.length,0);
  assert.equal(JSON.stringify(f.old.prepare('SELECT * FROM cp_context_packs').all()).includes('sapphire'),false);
  assert.throws(()=>content.assertContext(f.old,'pack'),/replay denied/);
});
test('an erase after recovery invalidates stale restored reads and packets immediately',t=>{
  const f=copiedFixture(t),restored=new PersonalMemory({db:f.old,restoreFromBackup:true,erasureSourceDb:f.db});
  assert.equal(restored.get(f.item.memoryId).content,'Restore canary sapphire');f.personal.erase(f.item.memoryId);
  assert.throws(()=>restored.get(f.item.memoryId),/stale erasure generation/);assert.throws(()=>restored.search('sapphire'),/stale erasure generation/);
  assert.equal(erasure.packetUsable(f.old,{records:[{memoryId:f.item.memoryId}]}),false);
});
test('repeated recovery can refresh a stale generation while retaining non-resurrection',t=>{
  const f=copiedFixture(t);new PersonalMemory({db:f.old,restoreFromBackup:true,erasureSourceDb:f.db});f.personal.erase(f.item.memoryId);
  const restored=new PersonalMemory({db:f.old,restoreFromBackup:true,erasureSourceDb:f.db});
  assert.equal(restored.get(f.item.memoryId),null);assert.equal(content.verify(f.old).valid,true);
});
test('a missing independent current store never opens restored content',t=>{
  const f=copiedFixture(t);assert.throws(()=>new PersonalMemory({db:f.old,restoreFromBackup:true}),/independent/);
});
test('unsupported retention migration version fails before serving content',t=>{
  const f=fixture(t);f.db.exec('UPDATE memory_erasure_content_meta SET version=999');assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/Unsupported/);
});
test('crash midway through legacy context redaction rolls back rows and is safely resumable',t=>{
  const f=fixture(t),before=f.db.prepare('SELECT snapshot_json FROM authority_context_pack_items').get().snapshot_json;
  f.db.exec("CREATE TRIGGER migration_crash AFTER UPDATE ON authority_observations BEGIN SELECT RAISE(ABORT,'crash with private payload');END");
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);assert.equal(f.db.prepare('SELECT snapshot_json FROM authority_context_pack_items').get().snapshot_json,before);
  f.db.exec('DROP TRIGGER migration_crash');new AuthorityMemory(f.store);assert.equal(f.memory.items(f.pack.id)[0].value,undefined);assert.equal(content.verify(f.db).valid,true);
});
test('future candidate and context identities are opaque instead of personal-content digests',t=>{
  const f=fixture(t);assert.match(f.c.id,/^[a-f0-9-]{36}$/);assert.match(f.pack.id,/^[a-f0-9-]{36}$/);
  const again=f.memory.build({operator_id:f.store.operatorId,include_personal:true});assert.equal(again.id,f.pack.id);
});
test('task/session copies are removed and task identity/status remain',t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),TaskSessions=require('../src/task-session-model');
  const f=fixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'retained-task-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const tasks=new TaskSessions(dir,f.db),task=tasks.create('personal task canary');
  fs.writeFileSync(path.join(task.sessionDir,'old.jsonl'),'retained personal canary');
  task.context={memory_id:f.m.id,text:'retained personal canary'};tasks.save(task);
  f.memory.erase(f.m.id,f.store.operator);
  assert.equal(tasks.get(task.id).id,task.id);assert.equal(tasks.get(task.id).context,null);assert.equal(fs.readdirSync(task.sessionDir).length,0);
  assert.equal(fs.readFileSync(path.join(dir,'tasks',task.id,'task.json'),'utf8').includes('personal canary'),false);
});
test('an active task keeps file propagation failed until it can be retried',t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),TaskSessions=require('../src/task-session-model');
  const f=fixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'active-retention-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const tasks=new TaskSessions(dir,f.db),task=tasks.create('task');task.context={memory_id:f.m.id};tasks.save(task);tasks.isErasureActive=()=>true;
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);assert.equal(f.db.prepare('SELECT state FROM memory_erasure_content_progress').get().state,'failed');
  tasks.isErasureActive=()=>false;f.memory.erase(f.m.id,f.store.operator);content.assertReadable(f.db);
});
test('audit diagnostic copies retain only permitted metadata and no raw personal field',t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const f=fixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'audit-retention-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'audit.jsonl');fs.writeFileSync(file,JSON.stringify({event_id:'event',status:'allowed',prompt:'Audit canary personal'})+'\n');
  require('../src/retained-context-files').attachRetainedFiles(f.db,dir);f.memory.erase(f.m.id,f.store.operator);
  assert.equal(fs.readFileSync(file,'utf8').includes('Audit canary'),false);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).event_id,'event');
});
test('file redaction interruption remains retryable with safe progress only',t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const f=fixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'file-retention-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'audit.jsonl'),'invalid private diagnostic');require('../src/retained-context-files').attachRetainedFiles(f.db,dir);
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);assert.throws(()=>content.assertReadable(f.db),/incomplete/);
  fs.writeFileSync(path.join(dir,'audit.jsonl'),'');f.memory.erase(f.m.id,f.store.operator);content.assertReadable(f.db);
});
test('historical content-derived identifiers are explicitly unqualified after payload redaction',t=>{
  const f=fixture(t),row=f.db.prepare('SELECT * FROM authority_memory_candidates WHERE id=?').get(f.c.id);
  row.id='sha256:'+canonicalHash({subject:'private legacy identifier canary'});
  const keys=Object.keys(row);f.db.prepare('INSERT INTO authority_memory_candidates('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...Object.values(row));
  f.memory.erase(f.m.id,f.store.operator);
  const q=content.qualification(f.db);assert.equal(q.legacy_identifier_migration_required,true);assert.equal(q.legacy_content_identifiers,1);
  assert.equal(JSON.stringify(q).includes('legacy identifier canary'),false);
});
test('erase during recovery invalidates the isolation barrier before any restored service returns',t=>{
  const f=copiedFixture(t),prepare=f.db.prepare.bind(f.db);let checks=0;
  f.db.prepare=function(sql){if(sql==='SELECT store,identity,scope_hash,action,erased_at FROM memory_erasure_markers ORDER BY store,identity,action'&&++checks===2)f.personal.erase(f.item.memoryId);return prepare(sql);};
  assert.throws(()=>new PersonalMemory({db:f.old,restoreFromBackup:true,erasureSourceDb:f.db}),/generation changed during recovery/);
});
test('Pi rejects an erased packet before issuing a runtime prompt',async t=>{
  const f=fixture(t),{PiAdapter}=require('../src/pi-adapter');let calls=0;
  const pi=new PiAdapter({bridge:{_ensurePiRuntime:()=>{},controlStore:{db:f.db}}});f.memory.erase(f.m.id,f.store.operator);
  assert.throws(()=>pi.contextPacket({records:[{memory_id:f.m.id,value:'forbidden'}]}),/unavailable/);
  const marker=erasure.mark(f.db,{store:'personal',identity:'pending-opaque',scope_hash:erasure.scopeHash(['pending']),action:'operator_erasure'});
  assert.ok(marker);await assert.rejects(()=>pi.dispatch({runtime:{rpc:{sendCommand:()=>{calls++;}}},message:'stale payload'}),/incomplete/);assert.equal(calls,0);
});
test('retained-context migration events remain immutable and report a visible retry state',t=>{
  const f=fixture(t);f.db.exec("CREATE TRIGGER injected_context BEFORE UPDATE ON authority_context_pack_items BEGIN SELECT RAISE(ABORT,'injected');END");
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator));const progress=f.memory.erasureStatus(f.m.id,f.store.operator);
  assert.equal(progress[0].state,'failed');assert.equal(progress[0].safe_error_class,'content_propagation_failed');
  assert.throws(()=>f.memory.erasureStatus(f.m.id,{type:'operator',id:'another'}),/scope denied/);
});
test('a later legacy copy is redacted even when the generation previously completed',t=>{
  const f=fixture(t);f.memory.erase(f.m.id,f.store.operator);
  f.db.prepare('INSERT INTO authority_legacy_records VALUES(?,?,?,?,NULL,?)').run('fixture-copy','opaque-copy',canonicalHash('later private canary'),JSON.stringify({memory_id:f.m.id,content:'later private canary'}),'provenance_only');
  f.memory.erase(f.m.id,f.store.operator);
  assert.equal(f.db.prepare("SELECT record_json FROM authority_legacy_records WHERE source_id='opaque-copy'").get().record_json.includes('later private canary'),false);
  assert.equal(content.verify(f.db).valid,true);
});
test('a completed generation still rejects a newly introduced unclassified store',t=>{
  const f=fixture(t);f.memory.erase(f.m.id,f.store.operator);f.db.exec('CREATE TABLE new_unknown_cache(id TEXT PRIMARY KEY,payload TEXT)');
  assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);assert.throws(()=>content.assertReadable(f.db),/incomplete/);
});
test('a stale bundled context is scrubbed even if its copied row disposition says complete',t=>{
  const f=fixture(t),snapshot=f.db.prepare('SELECT snapshot_json FROM authority_context_pack_items').get().snapshot_json;
  f.memory.erase(f.m.id,f.store.operator);
  // Build a mixed-generation recovery fixture without passing through a normal
  // application write path; replay guards deny that path separately.
  f.db.exec('DROP TRIGGER authority_context_pack_items_update;DROP TRIGGER erased_content_authority_context_pack_items_update');
  f.db.prepare('UPDATE authority_context_pack_items SET snapshot_json=?').run(snapshot);
  f.memory.erase(f.m.id,f.store.operator);
  assert.equal(f.db.prepare('SELECT snapshot_json FROM authority_context_pack_items').get().snapshot_json.includes('forbidden'),false);
  assert.equal(content.verify(f.db).valid,true);
});
test('manifested Mission Review outcomes survive erasure as allowlisted metadata; unknown outcomes fail closed',t=>{
 for(const outcome of ['passed','failed','operator_review','synthetic_unknown']){
  const f=fixture(t),id=require('node:crypto').randomUUID();
  f.db.exec('CREATE TABLE cp_mission_reviews(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,verification_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,workspace_hash TEXT NOT NULL,result TEXT NOT NULL,evidence TEXT NOT NULL,created_at INTEGER NOT NULL)');
  f.db.prepare('INSERT INTO cp_mission_reviews VALUES(?,?,?,?,?,?,?,?)').run(id,require('node:crypto').randomUUID(),require('node:crypto').randomUUID(),canonicalHash('synthetic manifest'),canonicalHash('synthetic workspace'),outcome,JSON.stringify({context_pack_id:f.pack.id,canary:'personal canary violet'}),1);
  if(outcome==='synthetic_unknown'){assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);assert.throws(()=>content.assertReadable(f.db),/incomplete|denied/);continue;}
  f.memory.erase(f.m.id,f.store.operator);const row=f.db.prepare('SELECT result,evidence FROM cp_mission_reviews WHERE id=?').get(id);assert.equal(row.result,outcome);assert.doesNotMatch(row.evidence,/personal canary/);assert.equal(content.verify(f.db).valid,true);assert.throws(()=>f.db.prepare('UPDATE cp_mission_reviews SET result=? WHERE id=?').run('synthetic_unknown',id),/Immutable|replay denied/);
 }
});

test('result relay receipts retain only validated run identities through erasure',t=>{
 for(const valid of [true,false]){
  const f=fixture(t),run=require('node:crypto').randomUUID();
  f.db.exec('CREATE TABLE cp_result_receipts(event_key TEXT PRIMARY KEY,run_id TEXT NOT NULL,created_at INTEGER NOT NULL)');
  const key=valid?'result:'+run:'synthetic private receipt';f.db.prepare('INSERT INTO cp_result_receipts VALUES(?,?,?)').run(key,run,1);
  if(!valid){assert.throws(()=>f.memory.erase(f.m.id,f.store.operator),/incomplete/);assert.throws(()=>content.assertReadable(f.db),/incomplete/);continue;}
  f.memory.erase(f.m.id,f.store.operator);assert.equal(f.db.prepare('SELECT event_key FROM cp_result_receipts').get().event_key,key);assert.equal(content.verify(f.db).valid,true);
 }
});

test('canonical erasure preserves bounded activation states while erasing qualification content references',t=>{
 const f=fixture(t);f.db.prepare("UPDATE authority_activation SET memory_state='enabled',router_state='enabled',memory_receipt_id=? WHERE id=1").run(f.m.id);
 f.memory.erase(f.m.id,f.store.operator);const row=f.db.prepare('SELECT * FROM authority_activation').get();assert.equal(row.memory_state,'enabled');assert.equal(row.router_state,'enabled');assert.equal(row.memory_receipt_id,null);assert.equal(content.verify(f.db).valid,true);
});
