'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {PersonalMemory}=require('../src/personal-memory');
const {ProjectMemoryV2}=require('../src/project-memory-v2');
const {AuthorityStore}=require('../src/authority-store');
const {AuthorityMemory}=require('../src/authority-memory');
const {RestrictedMemoryVault}=require('../src/restricted-memory-vault');
const erasure=require('../src/memory-erasure');
const {prepareMemoryRestore}=require('../src/memory-restore');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erasure-life-'));let now=1000;
 const db=new DatabaseSync(path.join(dir,'current.sqlite')),personal=new PersonalMemory({db,now:()=>now}),project=new ProjectMemoryV2({db,now:()=>now}),store=new AuthorityStore(db,{now:()=>now}),governed=new AuthorityMemory(store);
 const vaultDir=path.join(dir,'current-vault');fs.mkdirSync(vaultDir,{mode:0o700});const vault=new RestrictedMemoryVault(vaultDir);vault.prepare();
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 const snapshot=()=>{const file=path.join(dir,randomUUID()+'.sqlite');db.prepare('VACUUM INTO ?').run(file);const restored=new DatabaseSync(file);t.after(()=>restored.close());return restored;};
 const input=extra=>({domain:'project',projectId:'project-a',type:'fact',subject:'note',content:'Erasure canary blue orchid',source:'user_explicit',...extra});
 return{dir,db,personal,project,store,governed,vault,vaultDir,snapshot,input,tick:n=>now+=n,now:()=>now};
}
function governedRecord(f,extra={}){const c=f.governed.ingest({session_id:'fixture-session',chunk_id:randomUUID(),timestamp:1,speaker:'operator',claim:'No micro-prompts.',kind:'personal_preference',subject_key:'workflow.micro_prompts',value:'forbidden',...extra},f.store.operator);return{candidate:c,memory:f.governed.promote(c.id,{},f.store.operator)};}
test('pre-delete PersonalMemory backup is suppressed before retrieval and index rebuild',t=>{
 const f=fixture(t),item=f.personal.remember(f.input()),backup=f.snapshot();f.personal.forget(item.memoryId);
 const restored=new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:f.db,now:f.now});
 assert.equal(restored.get(item.memoryId),null);assert.equal(restored.search('orchid',{projectId:'project-a'}).items.length,0);
 restored._ensureSearchIndex();assert.equal(restored.search('orchid').items.length,0);assert.equal(restored.get(item.memoryId,{includeInactive:true}).contentRemoved,true);
 assert.throws(()=>backup.prepare("UPDATE personal_memories SET status='active',content='Erasure canary blue orchid' WHERE memory_id=?").run(item.memoryId),/replay denied/);
 assert.throws(()=>backup.exec('DELETE FROM memory_erasure_markers'),/Durable/);
});
test('restore rejects missing, same-database, incompatible or unavailable erasure evidence',t=>{
 const f=fixture(t),backup=f.snapshot(),missing=new DatabaseSync(':memory:');t.after(()=>missing.close());
 for(const source of [null,backup,missing])assert.throws(()=>new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:source}));
 const alias=new DatabaseSync(path.join(f.dir,'current.sqlite'));t.after(()=>alias.close());assert.throws(()=>erasure.reconcile(f.db,alias),/independent/);
 missing.exec('CREATE TABLE memory_erasure_meta(id INTEGER,version INTEGER); INSERT INTO memory_erasure_meta VALUES(1,999)');assert.throws(()=>new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:missing}));
});
test('purge interruption keeps a durable marker, hides stale primary/FTS state and retries across reopen',t=>{
 const f=fixture(t),item=f.personal.remember(f.input());
 f.db.exec("CREATE TRIGGER fail_primary BEFORE UPDATE OF content ON personal_memories BEGIN SELECT RAISE(ABORT,'injected private diagnostic'); END");
 assert.throws(()=>f.personal.erase(item.memoryId),/purge incomplete/);
 assert.equal(f.personal.get(item.memoryId),null);assert.equal(f.personal.search('orchid').items.length,0);assert.equal(f.personal.recent().items.length,0);
 assert.equal(f.db.prepare('SELECT content FROM personal_memories').get().content,'Erasure canary blue orchid');
 const progress=f.db.prepare('SELECT * FROM memory_erasure_progress').get();assert.equal(progress.state,'retryable');assert.equal(JSON.stringify(progress).includes('private diagnostic'),false);
 f.db.exec('DROP TRIGGER fail_primary');new PersonalMemory({db:f.db,now:f.now});
 assert.equal(f.db.prepare('SELECT content,subject FROM personal_memories').get().content,null);assert.equal(f.db.prepare('SELECT subject FROM personal_memories').get().subject,'[erased]');
});
test('primary succeeds but index failure rolls back cleanup while suppression still wins',t=>{
 const f=fixture(t),item=f.personal.remember(f.input());
 f.db.exec('DROP TABLE personal_memory_fts');
 assert.throws(()=>f.personal.forget(item.memoryId),/purge incomplete/);assert.equal(f.personal.get(item.memoryId),null);
 // A new readable instance refuses to expose stale primary data until repair.
 new PersonalMemory({db:f.db});
 f.personal._ensureSearchIndex();f.personal.retryErasure();assert.equal(f.personal.search('orchid').items.length,0);
});
test('index-first failure never exposes a record after suppression; cleanup remains idempotent',t=>{
 const f=fixture(t),item=f.personal.remember(f.input());
 f.db.exec("CREATE TRIGGER fail_after_index AFTER UPDATE OF content ON personal_memories BEGIN SELECT RAISE(ABORT,'index-first crash'); END");
 assert.throws(()=>f.personal.forget(item.memoryId));assert.equal(f.personal.search('orchid').items.length,0);
 f.db.exec('DROP TRIGGER fail_after_index');f.personal.forget(item.memoryId);const before=f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n;f.personal.forget(item.memoryId);assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,before);
});
test('scope isolation survives deletion, pre-delete restore and search migration',t=>{
 const f=fixture(t),a=f.personal.remember(f.input()),b=f.personal.remember(f.input({projectId:'project-b'})),backup=f.snapshot();f.personal.erase(a.memoryId);
 const restored=new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:f.db});assert.equal(restored.get(a.memoryId),null);assert.equal(restored.get(b.memoryId).content,'Erasure canary blue orchid');
 backup.exec("UPDATE personal_memory_meta SET value='1' WHERE key='schema_version'; DROP TABLE personal_memory_fts");new PersonalMemory({db:backup});assert.deepEqual(restored.search('orchid',{projectId:'project-b'}).items.map(x=>x.memoryId),[b.memoryId]);
});
test('operator erasure removes subject/provenance payload; user forget remains a distinct policy action',t=>{
 const f=fixture(t),a=f.personal.remember(f.input()),b=f.personal.remember(f.input({subject:'second'}));f.personal.forget(a.memoryId);f.personal.erase(b.memoryId);
 assert.equal(f.personal.get(a.memoryId,{includeInactive:true}).subject,'note');assert.deepEqual(f.personal.get(b.memoryId,{includeInactive:true}),{memoryId:b.memoryId,status:'forgotten',contentRemoved:true,erased:true});
 assert.deepEqual(f.db.prepare('SELECT action FROM memory_erasure_markers ORDER BY generation').all().map(x=>x.action),['forget','operator_erasure']);
});
test('expired inactive corrections purge at the exact fixed deadline and restore cannot extend it',t=>{
 const f=fixture(t),first=f.personal.remember(f.input({expiresAt:1010})),backup=f.snapshot();f.personal.update(first.memoryId,{content:'Corrected canary',expiresAt:1010});f.tick(10);f.personal.purgeExpired();
 assert.equal(f.personal.get(first.memoryId,{includeInactive:true}).contentRemoved,true);
 const restored=new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:f.db,now:f.now});assert.equal(restored.get(first.memoryId),null);assert.equal(restored.search('orchid').items.length,0);
});
test('governed forgetting survives pre-delete backup, replay and ContextPack rebuild',t=>{
 const f=fixture(t),{candidate,memory}=governedRecord(f),input={operator_id:f.store.operatorId,include_personal:true},pack=f.governed.build(input),backup=f.snapshot();f.governed.forget(memory.id,f.store.operator);
 const store=new AuthorityStore(backup,{restoreFromBackup:true,erasureSourceDb:f.db}),m=new AuthorityMemory(store);assert.equal(m.build(input).items.length,0);assert.equal(m.validatePack(pack.id,input).valid,false);assert.equal(m.promote(candidate.id,{},store.operator).status,'forgotten');
 assert.throws(()=>backup.prepare("UPDATE authority_memories SET status='active' WHERE id=?").run(memory.id),/replay denied/);assert.equal(store.integrity().ok,true);
});
test('operator governed erasure removes personal snapshots while preserving immutable metadata',t=>{
 const f=fixture(t),{memory,candidate}=governedRecord(f),pack=f.governed.build({operator_id:f.store.operatorId,include_personal:true});
 assert.throws(()=>f.governed.erase(memory.id,{type:'agent',id:'host'}));assert.throws(()=>f.governed.erase(memory.id,{type:'operator',id:'other'}));
 const rawBefore=f.db.prepare('SELECT snapshot_json FROM authority_context_pack_items').get().snapshot_json;
 const receipt=f.governed.erase(memory.id,f.store.operator);assert.equal(receipt.immutableContentRetained,false);assert.equal(receipt.physicalErasure,false);
 assert.equal(f.governed.items(pack.id)[0].value,undefined);assert.equal(f.governed.provenance(memory.id,f.store.operator).observation,null);assert.equal(f.governed.candidate(candidate.id).value,undefined);
 assert.notEqual(f.db.prepare('SELECT snapshot_json FROM authority_context_pack_items').get().snapshot_json,rawBefore);assert.equal(f.db.prepare('SELECT claim FROM authority_observations').get().claim,'[erased]');assert.equal(f.store.integrity().ok,true);
});
test('governed failed purge stays suppressed and constructor retry completes mutable cleanup',t=>{
 const f=fixture(t),{memory}=governedRecord(f);f.db.exec("CREATE TRIGGER fail_governed BEFORE UPDATE OF value_json ON authority_memories BEGIN SELECT RAISE(ABORT,'outage'); END");
 assert.throws(()=>f.governed.erase(memory.id,f.store.operator),/incomplete/);assert.throws(()=>f.governed.build({operator_id:f.store.operatorId,include_personal:true}),/propagation incomplete/);assert.equal(f.governed.get(memory.id).value,undefined);
 f.db.exec('DROP TRIGGER fail_governed');new AuthorityMemory(f.store);assert.equal(JSON.parse(f.db.prepare('SELECT value_json FROM authority_memories').get().value_json).content_state,'erased');
});
test('vault restore unions independent tombstones before restored keys can be read',t=>{
 const f=fixture(t),id=randomUUID();f.vault.save({id,content:'private vault canary'});f.vault.snapshot({id});const restoredDir=path.join(f.dir,'restored-vault');fs.cpSync(f.vaultDir,restoredDir,{recursive:true});f.vault.forget({id});
 privateDirectories(restoredDir);const restored=new RestrictedMemoryVault(restoredDir,{restoreFromBackup:true,erasureSourceVault:f.vault});assert.throws(()=>restored.read({id}),/unavailable/);assert.equal(fs.existsSync(restored.file('keys',id)),false);assert.throws(()=>restored.save({id,content:'replayed canary'}),/forgotten/);
 assert.throws(()=>new RestrictedMemoryVault(restoredDir,{restoreFromBackup:true}),/independent/);
});
test('whole application restore returns no services until all canonical memory stores reconcile',t=>{
 const f=fixture(t),a=f.personal.remember(f.input()),g=governedRecord(f).memory,id=randomUUID();f.vault.save({id,content:'vault restore canary'});f.project.registerMission({missionId:'mission-a',taskId:'task-a',objective:'checkpoint canary',workspace:'/private/tmp/workspace-a',scope:{}});
 const backup=f.snapshot(),vaultDir=path.join(f.dir,'restore-all');fs.cpSync(f.vaultDir,vaultDir,{recursive:true});f.personal.erase(a.memoryId);f.governed.erase(g.id,f.store.operator);f.project.forgetMission('mission-a');f.vault.forget({id});
 privateDirectories(vaultDir);const restored=prepareMemoryRestore({db:backup,erasureSourceDb:f.db,vaultDirectory:vaultDir,erasureSourceVault:f.vault,now:f.now});
 assert.equal(restored.personal.get(a.memoryId),null);assert.equal(restored.governed.get(g.id).value,undefined);assert.throws(()=>restored.project.latest('mission-a'),/forgotten/);assert.throws(()=>restored.vault.read({id}));assert.equal(restored.authorityRestored,false);assert.equal(backup.prepare("SELECT count(*) n FROM memory_erasure_progress WHERE state='pending'").get().n,0);erasure.reconcile(backup,f.db);assert.equal(backup.prepare("SELECT count(*) n FROM memory_erasure_progress WHERE state='pending'").get().n,0);
});
function privateDirectories(dir){fs.chmodSync(dir,0o700);for(const child of fs.readdirSync(dir,{withFileTypes:true}))if(child.isDirectory())privateDirectories(path.join(dir,child.name));}
test('crash/restart mid-erasure carries suppression into a fresh process and backup',t=>{
 const f=fixture(t),item=f.personal.remember(f.input());erasure.mark(f.db,{store:'personal',identity:item.memoryId,scope_hash:erasure.scopeHash(['project','project-a',null,null]),action:'operator_erasure',erased_at:1000});
 const script="const {DatabaseSync}=require('node:sqlite');const {PersonalMemory}=require('./src/personal-memory');const db=new DatabaseSync(process.argv[1]);const m=new PersonalMemory({db});console.log(JSON.stringify({visible:m.get(process.argv[2])!==null,content:db.prepare('SELECT content FROM personal_memories').get().content}));db.close();";
 const child=spawnSync(process.execPath,['--experimental-sqlite','-e',script,path.join(f.dir,'current.sqlite'),item.memoryId],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});assert.equal(child.status,0);assert.deepEqual(JSON.parse(child.stdout),{visible:false,content:null});
});
test('erasure scope mismatch rejects restore and newer marker schema denies migration',t=>{
 const f=fixture(t),item=f.personal.remember(f.input()),backup=f.snapshot();f.personal.forget(item.memoryId);backup.prepare("UPDATE personal_memories SET project_id='other' WHERE memory_id=?").run(item.memoryId);
 assert.throws(()=>new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:f.db}),/scope mismatch/);
 const newer=new DatabaseSync(':memory:');t.after(()=>newer.close());newer.exec('CREATE TABLE memory_erasure_meta(id INTEGER,version INTEGER);INSERT INTO memory_erasure_meta VALUES(1,999)');assert.throws(()=>new PersonalMemory({db:newer}),/Unsupported erasure schema/);
});
test('recognized Cursor argv, URL and token secrets reject before PersonalMemory persistence',t=>{
 const f=fixture(t);for(const content of ['--api-key seededPrivateCredential','crsr_fixtureSecretNeverPersist123','https://service.invalid/?access_token=seededPrivateCredential'])assert.throws(()=>f.personal.remember(f.input({content})),/Secret-like/);assert.equal(f.db.prepare('SELECT count(*) n FROM personal_memories').get().n,0);
});
test('schema migration cannot promote a suppressed stale PersonalMemory record into governed truth',t=>{
 const f=fixture(t),item=f.personal.remember(f.input({domain:'personal',projectId:undefined}));
 erasure.mark(f.db,{store:'personal',identity:item.memoryId,scope_hash:erasure.scopeHash(['personal',null,null,null]),action:'operator_erasure',erased_at:1000});
 require('../src/authority-migration').migrateLegacy(f.store);
 assert.equal(f.governed.get(item.memoryId).value,undefined);assert.equal(f.governed.build({operator_id:f.store.operatorId,include_personal:true}).items.length,0);
 assert.equal(f.db.prepare("SELECT record_json FROM authority_legacy_records WHERE source_table='personal_memories'").get().record_json.includes('blue orchid'),false);
});

test('task scratch checkpoints survive pre-delete restore only as durable suppression, with shared scope denied',t=>{
 const f=fixture(t),{MemoryStore}=require('../src/memory-store');const scratch=new MemoryStore(':memory:',{db:f.db});
 const a=scratch.save({taskId:'task-a',kind:'note',content:'Scratch erasure orchid',provenance:{source:'operator'},shared:true});
 const b=scratch.save({taskId:'task-b',kind:'note',content:'Separate scratch orchid',provenance:{source:'operator'}}),backup=f.snapshot();
 const receipt=scratch.eraseTask('task-a');assert.equal(receipt.retryable,0);assert.equal(scratch.list({taskId:'task-a'}).length,0);
 const restored=new MemoryStore(':memory:',{db:backup,restoreFromBackup:true,erasureSourceDb:f.db});
 assert.equal(restored.search('orchid',{taskId:'task-b',includeShared:true}).items.length,1);assert.equal(restored.list({taskId:'task-b'})[0].id,b.id);
 backup.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");assert.equal(restored.search('orchid',{taskId:'task-a'}).items.length,0);
 assert.throws(()=>backup.prepare('INSERT INTO memory_entries SELECT ?,task_id,kind,content,source,provenance,shared,?,created_at,updated_at FROM memory_entries WHERE id=?').run(a.id,'replay-dedupe',b.id),/replay denied/);
});
test('task scratch purge failure suppresses stale shared index and retries after crash',t=>{
 const f=fixture(t),{MemoryStore}=require('../src/memory-store'),scratch=new MemoryStore(':memory:',{db:f.db});scratch.save({taskId:'task-a',kind:'note',content:'Interrupted scratch orchid',provenance:{source:'operator'},shared:true});
 f.db.exec("CREATE TRIGGER fail_scratch BEFORE DELETE ON memory_entries BEGIN SELECT RAISE(ABORT,'private failure'); END");
 assert.equal(scratch.eraseTask('task-a').retryable,1);assert.equal(scratch.search('orchid',{taskId:'task-b',includeShared:true}).items.length,0);assert.equal(scratch.list({taskId:'task-a'}).length,0);
 f.db.exec('DROP TRIGGER fail_scratch');const reopened=new MemoryStore(':memory:',{db:f.db});assert.equal(reopened.retryErasure().retryable,0);assert.equal(f.db.prepare('SELECT count(*) n FROM memory_entries').get().n,0);
});

test('Project V2 restore validates workspace scope before legacy tombstone cleanup can hide a collision',t=>{
 const f=fixture(t);f.project.registerMission({missionId:'scope-collision',taskId:'task-a',objective:'fixture',workspace:'/private/tmp/a',scope:{}});const backup=f.snapshot();
 f.project.forgetMission('scope-collision');
 backup.prepare('UPDATE project_memory_v2_missions SET workspace=? WHERE mission_id=?').run('/private/tmp/other','scope-collision');
 assert.throws(()=>new ProjectMemoryV2({db:backup,restoreFromBackup:true,erasureSourceDb:f.db}),/scope mismatch/);
 assert.equal(backup.prepare('SELECT count(*) n FROM project_memory_v2_missions').get().n,1);
});

test('pre-correction backups cannot revive superseded Personal or governed Memory after correction and forget',t=>{
 for(const forget of [false,true]){
  const f=fixture(t),old=f.personal.remember(f.input()),g=governedRecord(f),pack=f.governed.build({operator_id:f.store.operatorId,include_personal:true}),backup=f.snapshot();
  const replacement=f.personal.update(old.memoryId,{content:'Current synthetic amber'}),candidate=governedRecordCandidate(f,'allowed'),next=f.governed.promote(candidate.id,{supersedes_id:g.memory.id},f.store.operator);
  if(forget){f.personal.forget(replacement.memoryId);f.governed.forget(next.id,f.store.operator);}
  const restored=new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:f.db,now:f.now}),store=new AuthorityStore(backup,{restoreFromBackup:true,erasureSourceDb:f.db,now:f.now}),memory=new AuthorityMemory(store);
  assert.equal(restored.get(old.memoryId),null);assert.equal(restored.search('orchid').items.length,0);assert.equal(restored.get(old.memoryId,{includeInactive:true}).status,'superseded');
  assert.equal(memory.build({operator_id:store.operatorId,include_personal:true}).items.length,0);assert.equal(memory.validatePack(pack.id,{operator_id:store.operatorId,include_personal:true}).valid,false);assert.equal(memory.get(g.memory.id).status,'superseded');assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(),[]);
 }
});
function governedRecordCandidate(f,value){return f.governed.propose({kind:'personal_preference',operator_id:f.store.operatorId,project_id:null,scope:'global',subject_key:'workflow.micro_prompts',value,source_hash:'0'.repeat(64),source_refs:[{operator_id:f.store.operatorId}]},f.store.operator);}
test('later correction alone invalidates restored Memory freshness without a new erasure marker',t=>{
 for(const governed of [false,true]){
  const f=fixture(t),old=governed?governedRecord(f).memory:f.personal.remember(f.input()),backup=f.snapshot();
  const restored=governed?new AuthorityMemory(new AuthorityStore(backup,{restoreFromBackup:true,erasureSourceDb:f.db})):new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:f.db});
  const markers=f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n;
  if(governed){const c=governedRecordCandidate(f,'allowed');f.governed.promote(c.id,{supersedes_id:old.id},f.store.operator);}else f.personal.update(old.memoryId,{content:'Current synthetic amber'});
  assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,markers);
  assert.throws(()=>governed?restored.build({operator_id:f.store.operatorId,include_personal:true}):restored.get(old.memoryId),/stale erasure generation/);
 }
});
test('restore refuses unmarked Memory identities absent from the current independent source',t=>{
 for(const governed of [false,true]){
  const f=fixture(t),other=fixture(t);if(governed)governedRecord(f);else f.personal.remember(f.input());const backup=f.snapshot();
  assert.throws(()=>governed?new AuthorityStore(backup,{restoreFromBackup:true,erasureSourceDb:other.db}):new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:other.db}),/current authoritative memory identity/);
 }
});
test('current supersession cannot legitimize a copied record with changed scope',t=>{
 const f=fixture(t),old=f.personal.remember(f.input()),backup=f.snapshot();f.personal.update(old.memoryId,{content:'Current synthetic amber'});backup.prepare('UPDATE personal_memories SET project_id=? WHERE memory_id=?').run('different-project',old.memoryId);
 assert.throws(()=>new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:f.db}),/supersession scope mismatch/);
});
test('restore rejects changed payloads even when a copied stored hash is unchanged',t=>{
 for(const governed of [false,true]){
  const f=fixture(t),item=governed?governedRecord(f).memory:f.personal.remember(f.input()),backup=f.snapshot();
  if(governed){for(const row of backup.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='authority_memories'").all())backup.exec('DROP TRIGGER '+JSON.stringify(row.name));backup.prepare('UPDATE authority_memories SET value_json=? WHERE id=?').run(JSON.stringify('Tampered synthetic payload'),item.id);}
  else backup.prepare('UPDATE personal_memories SET content=? WHERE memory_id=?').run('Tampered synthetic payload',item.memoryId);
  assert.throws(()=>governed?new AuthorityStore(backup,{restoreFromBackup:true,erasureSourceDb:f.db}):new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:f.db}),/identity content mismatch/);
 }
});
test('restore cannot downgrade sensitivity or increase governed eligibility from copied policy fields',t=>{
 for(const governed of [false,true]){
  const f=fixture(t),item=governed?governedRecord(f).memory:f.personal.remember(f.input({sensitivity:'private'})),backup=f.snapshot();
  if(governed){for(const row of backup.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='authority_memories'").all())backup.exec('DROP TRIGGER '+JSON.stringify(row.name));backup.prepare('UPDATE authority_memories SET privacy=?,assurance=? WHERE id=?').run('public',3,item.id);}
  else backup.prepare('UPDATE personal_memories SET sensitivity=? WHERE memory_id=?').run('normal',item.memoryId);
  assert.throws(()=>governed?new AuthorityStore(backup,{restoreFromBackup:true,erasureSourceDb:f.db}):new PersonalMemory({db:backup,restoreFromBackup:true,erasureSourceDb:f.db}),/identity content mismatch/);
 }
});
