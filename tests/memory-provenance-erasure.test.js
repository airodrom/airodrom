'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{randomUUID}=require('node:crypto');
const {PersonalMemory}=require('../src/personal-memory'),{EventLedger}=require('../src/event-ledger');
const identity=require('../src/memory-identity'),content=require('../src/memory-content-erasure'),erasure=require('../src/memory-erasure');
const CANARY='Source provenance personal fixture iris';
function fixture(t,{memoryScope={},eventScope={},file=false}={}){
  const dir=file?fs.mkdtempSync(path.join(os.tmpdir(),'source-erasure-')):null;
  const db=new DatabaseSync(dir?path.join(dir,'current.sqlite'):':memory:'),memory=new PersonalMemory({db}),ledger=new EventLedger(db);
  const event=ledger.record({eventType:'operator.memory.source',agent:'chatgpt',direction:'incoming',payload:CANARY,protected:true,...eventScope});
  const item=memory.remember({domain:'personal',type:'fact',subject:'source fixture',content:CANARY,source:'user_explicit',sourceEventId:event.event_id,...memoryScope});
  const copies=[];t.after(()=>{copies.forEach(d=>d.close());db.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});});
  return{db,memory,ledger,event,item,backup(){const copy=path.join(dir,'archive-'+copies.length+'.sqlite');db.prepare('VACUUM INTO ?').run(copy);const result=new DatabaseSync(copy);copies.push(result);return result;}};
}
test('operator erasure removes original source event payload and personal digest through normal APIs',t=>{
  const f=fixture(t),original=f.db.prepare('SELECT * FROM event_ledger_events WHERE event_id=?').get(f.event.event_id);f.memory.erase(f.item.memoryId);
  const event=f.ledger.get(f.event.event_id),marker=erasure.marker(f.db,'personal',f.item.memoryId);
  assert.equal(event.payload,null);assert.equal(event.payload_sha256,null);assert.equal(event.payload_byte_length,0);assert.notEqual(f.db.prepare('SELECT fingerprint FROM event_ledger_events WHERE event_id=?').get(f.event.event_id).fingerprint,original.fingerprint);
  assert.equal(marker.source_event_id,f.event.event_id);assert.equal(marker.source_provenance,'verified');
  assert.equal(f.memory.get(f.item.memoryId),null);assert.equal(f.memory.search('iris').items.length,0);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM event_ledger_events').all()).includes(CANARY),false);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM event_ledger_events').all()).includes(original.payload_sha256),false);
  assert.throws(()=>f.db.prepare('UPDATE memory_erasure_markers SET source_event_id=?').run(randomUUID()),/Immutable/);
});
test('source provenance survives interrupted propagation, primary redaction, and deterministic retry',t=>{
  const f=fixture(t);f.db.exec("CREATE TRIGGER source_fault BEFORE UPDATE ON event_ledger_events WHEN old.event_type='operator.memory.source' BEGIN SELECT RAISE(ABORT,'fixture source unavailable');END");
  assert.throws(()=>f.memory.erase(f.item.memoryId),/incomplete/);
  assert.equal(f.db.prepare('SELECT source_event_id FROM personal_memories').get().source_event_id,null);
  assert.equal(erasure.marker(f.db,'personal',f.item.memoryId).source_event_id,f.event.event_id);
  assert.throws(()=>f.ledger.get(f.event.event_id),/incomplete/);
  f.db.exec('DROP TRIGGER source_fault');f.memory.retryErasure();assert.equal(f.ledger.get(f.event.event_id).payload,null);
  const events=f.db.prepare("SELECT * FROM event_ledger_events WHERE event_type='memory.content_redacted'").all();f.memory.erase(f.item.memoryId);assert.deepEqual(f.db.prepare("SELECT * FROM event_ledger_events WHERE event_type='memory.content_redacted'").all(),events);
});
test('pre-delete backup restores durable source erasure before source event readability',t=>{
  const f=fixture(t,{file:true}),archive=f.backup();identity.migrate(f.db);f.memory.erase(f.item.memoryId);identity.migrate(f.db);
  identity.migrate(archive,{sourceDb:f.db});const restored=new PersonalMemory({db:archive,restoreFromBackup:true,erasureSourceDb:f.db});
  assert.equal(restored.get(f.item.memoryId),null);assert.equal(new EventLedger(archive).get(f.event.event_id).payload,null);
  assert.equal(erasure.marker(archive,'personal',f.item.memoryId).source_event_id,f.event.event_id);
  assert.equal(identity.migrate(archive,{sourceDb:f.db}).migrated_records,0);new PersonalMemory({db:archive,restoreFromBackup:true,erasureSourceDb:f.db});
  assert.equal(new EventLedger(archive).get(f.event.event_id).payload_sha256,null);
});
for(const[scope,eventScope]of[
  ['task',{taskId:randomUUID()}],['session',{sessionId:randomUUID()}],['project',{metadata:{project_id:'foreign-project'}}],['operator',{metadata:{operator_id:'foreign-operator'}}]
])test('foreign '+scope+' source relation is denied before erasure marker creation',t=>{
  const f=fixture(t,{eventScope});assert.throws(()=>f.memory.erase(f.item.memoryId),/scope mismatch/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);assert.equal(f.memory.get(f.item.memoryId).content,CANARY);assert.equal(f.ledger.get(f.event.event_id).payload,CANARY);
});
test('matching project source scope can be erased and retried without reconstructive provenance',t=>{
  const f=fixture(t,{memoryScope:{domain:'project',projectId:'fixture-project'},eventScope:{metadata:{project_id:'fixture-project'}}});
  f.memory.erase(f.item.memoryId);f.memory.erase(f.item.memoryId);assert.equal(f.ledger.get(f.event.event_id).payload,null);assert.equal(f.ledger.get(f.event.event_id).payload_sha256,null);
});
test('matching session source scope can be erased without targeting another session',t=>{
  const taskId=randomUUID(),sessionId=randomUUID(),f=fixture(t,{memoryScope:{domain:'session',taskId,sessionId},eventScope:{taskId,sessionId}});
  const other=f.ledger.record({eventType:'operator.memory.source',agent:'chatgpt',direction:'incoming',taskId:randomUUID(),sessionId:randomUUID(),payload:'Other isolated session'});
  f.memory.erase(f.item.memoryId);assert.equal(f.ledger.get(f.event.event_id).payload,null);assert.equal(f.ledger.get(other.event_id).payload,'Other isolated session');
});
test('unknown or nonopaque legacy source cannot create a falsely complete erasure',t=>{
  const f=fixture(t);f.db.prepare('UPDATE personal_memories SET source_event_id=?').run('legacy-source-name');assert.throws(()=>f.memory.erase(f.item.memoryId),/provenance/);assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);
});
test('legacy COMPLETE disposition with unverified source provenance remains unreadable',t=>{
  const f=fixture(t);f.memory.erase(f.item.memoryId);f.db.exec('DROP TRIGGER memory_erasure_immutable');f.db.prepare("UPDATE memory_erasure_markers SET source_event_id=NULL,source_provenance='unverified'").run();
  assert.throws(()=>f.ledger.get(f.event.event_id),/provenance/);assert.throws(()=>f.memory.retryErasure(),/incomplete/);assert.equal(content.qualification(f.db).unverified_source_provenance,1);
});
function architectureFixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-key-')),root=fs.realpathSync(dir),ref='docs/harness/decisions.md';fs.mkdirSync(path.join(root,'docs/harness'),{recursive:true});fs.writeFileSync(path.join(root,ref),CANARY);
  const db=new DatabaseSync(':memory:'),memory=new PersonalMemory({db}),arch=require('../src/architecture-memory');db.exec('CREATE TABLE projects(project_id TEXT PRIMARY KEY,repositories TEXT,status TEXT)');db.prepare('INSERT INTO projects VALUES(?,?,?)').run('fixture-project',JSON.stringify([root]),'active');
  const key='personal-subject-key-iris',manifest={schema_version:1,sources:[{path:ref,source_hash:arch.hash(CANARY),source_type:'canonical_doc',trust:'canonical'}],facts:[{key,category:'invariant',source_ref:ref,content:CANARY,tags:['fixture']}]};arch.bootstrap({db,memory,root,manifest,projectId:'fixture-project',dryRun:false});const row=db.prepare('SELECT * FROM architecture_memory_versions').get();
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});return{db,memory,key,row};
}
test('architecture replay protection retains only opaque identity and denies changed-subject replay',t=>{
  const f=architectureFixture(t);f.memory.erase(f.row.memory_id);const tracked=f.db.prepare("SELECT row_key FROM memory_erasure_content_rows WHERE table_name='architecture_memory_versions'").get();assert.deepEqual(JSON.parse(tracked.row_key),[f.row.memory_id]);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM memory_erasure_content_rows').all()).includes(f.key),false);
  assert.throws(()=>f.db.prepare('UPDATE architecture_memory_versions SET subject_key=? WHERE memory_id=?').run('different-subject',f.row.memory_id),/replay denied/);f.memory.erase(f.row.memory_id);
});
test('explicit replay-key upgrade removes legacy erasable key component and is idempotent',t=>{
  const f=architectureFixture(t);f.memory.erase(f.row.memory_id);const legacy=JSON.stringify([f.row.project_id,f.key,f.row.version_hash]);f.db.prepare("UPDATE memory_erasure_content_rows SET row_key=? WHERE table_name='architecture_memory_versions'").run(legacy);
  assert.throws(()=>content.assertReadable(f.db),/explicit migration/);assert.equal(content.upgradeReplayKeys(f.db).upgraded_replay_keys,1);assert.equal(content.upgradeReplayKeys(f.db).upgraded_replay_keys,0);content.assertReadable(f.db);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM memory_erasure_content_rows').all()).includes(f.key),false);
});
test('unanchored legacy replay-key upgrade fails closed without erasing evidence or fabricating identity',t=>{
  const f=architectureFixture(t);f.memory.erase(f.row.memory_id);const legacy=JSON.stringify([f.row.project_id,f.key,randomUUID()]);f.db.prepare("UPDATE memory_erasure_content_rows SET row_key=? WHERE table_name='architecture_memory_versions'").run(legacy);
  assert.throws(()=>content.upgradeReplayKeys(f.db),/origin/);assert.equal(f.db.prepare("SELECT row_key FROM memory_erasure_content_rows WHERE table_name='architecture_memory_versions'").get().row_key,legacy);assert.throws(()=>content.assertReadable(f.db),/explicit migration/);
});
function history(f){const first=f.item,second=f.memory.update(first.memoryId,{content:'Corrected private fixture lotus',sensitivity:'private'}),third=f.memory.update(second.memoryId,{content:CANARY,sensitivity:'sensitive',subject:'renamed source fixture'});return[first,second,third];}
test('current erasure removes every connected inactive and sensitive historical version',t=>{
  const f=fixture(t),family=history(f);f.memory.erase(family[2].memoryId);
  for(const item of family){const historic=f.memory.get(item.memoryId,{includeInactive:true,includeSensitive:true});assert.equal(historic.erased,true);assert.equal(historic.content,undefined);}
  assert.equal(f.db.prepare('SELECT count(*) n FROM personal_memories WHERE content IS NOT NULL').get().n,0);assert.equal(f.memory.search('lotus',{includeSensitive:true}).items.length,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,3);assert.equal(f.ledger.get(f.event.event_id).payload,null);
});
test('ancestor erasure also reaches changed-subject descendants',t=>{
  const f=fixture(t),family=history(f);f.memory.erase(family[0].memoryId);for(const item of family)assert.equal(f.memory.get(item.memoryId,{includeInactive:true,includeSensitive:true}).erased,true);assert.equal(f.memory.search('iris',{includeSensitive:true}).items.length,0);
});
test('every family scope is validated before any marker is written',t=>{
  const f=fixture(t),other=f.memory.remember({domain:'project',projectId:'foreign-project',type:'fact',subject:'other',content:'Isolated foreign fixture',source:'user_explicit'});
  f.db.prepare("UPDATE personal_memories SET superseded_by=?,status='superseded' WHERE memory_id=?").run(other.memoryId,f.item.memoryId);
  assert.throws(()=>f.memory.erase(f.item.memoryId),/history scope mismatch/);assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);assert.equal(f.memory.get(other.memoryId).content,'Isolated foreign fixture');
});
test('invalid historical source scope rejects the whole family before markers or purge',t=>{
  const f=fixture(t,{eventScope:{taskId:randomUUID()}}),valid=f.ledger.record({eventType:'operator.memory.source',agent:'chatgpt',direction:'incoming',payload:CANARY});const current=f.memory.update(f.item.memoryId,{content:'Corrected',sourceEventId:valid.event_id});
  assert.throws(()=>f.memory.erase(current.memoryId),/source scope mismatch/);assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM personal_memories WHERE content IS NOT NULL').get().n,2);
});
test('all family markers survive interruption before later primary purge and retry erases remaining copies',t=>{
  const f=fixture(t),family=history(f);f.db.exec(`CREATE TRIGGER history_fault BEFORE UPDATE ON personal_memories WHEN old.memory_id='${family[1].memoryId}' BEGIN SELECT RAISE(ABORT,'fixture history unavailable');END`);
  assert.throws(()=>f.memory.erase(family[2].memoryId),/incomplete/);assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,3);
  for(const item of family)assert.equal(f.memory.get(item.memoryId),null);
  f.db.exec('DROP TRIGGER history_fault');f.memory.retryErasure();assert.equal(f.db.prepare('SELECT count(*) n FROM personal_memories WHERE content IS NOT NULL').get().n,0);content.assertReadable(f.db);
});
test('authoritative family markers prevent historical resurrection from a pre-delete backup',t=>{
  const f=fixture(t,{file:true}),family=history(f),archive=f.backup();f.memory.erase(family[2].memoryId);identity.migrate(f.db);identity.migrate(archive,{sourceDb:f.db});const restored=new PersonalMemory({db:archive,restoreFromBackup:true,erasureSourceDb:f.db});
  for(const item of family)assert.equal(restored.get(item.memoryId,{includeInactive:true,includeSensitive:true}).erased,true);assert.equal(archive.prepare('SELECT count(*) n FROM personal_memories WHERE content IS NOT NULL').get().n,0);
});
for(const shape of ['dangling','cyclic'])test('unknown '+shape+' history fails closed before markers',t=>{
  const f=fixture(t);f.db.prepare("UPDATE personal_memories SET superseded_by=?,status='superseded'").run(shape==='cyclic'?f.item.memoryId:randomUUID());assert.throws(()=>f.memory.erase(f.item.memoryId),/history provenance/);assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);
});
function requests(f,{duplicate=false,missing=false}={}){
  f.db.exec('CREATE TABLE cp_requests(owner TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,record_id TEXT,PRIMARY KEY(owner,request_id))');
  const ids=[randomUUID(),randomUUID()],label='external-personal-request-label-iris';
  if(!duplicate)f.db.exec('CREATE UNIQUE INDEX cp_request_record_identity ON cp_requests(record_id) WHERE record_id IS NOT NULL');
  for(let i=0;i<2;i++)f.db.prepare('INSERT INTO cp_requests VALUES(?,?,?,?,?,?)').run('owner-'+i,label,'fixture-content-commitment','settled',JSON.stringify({memory_id:f.item.memoryId,content:CANARY}),missing&&i===1?null:duplicate?ids[0]:ids[i]);
  return{ids,label};
}
test('request erasure uses validated opaque record IDs and removes external labels without PK collisions',t=>{
  const f=fixture(t),r=requests(f);f.memory.erase(f.item.memoryId);const rows=f.db.prepare('SELECT * FROM cp_requests ORDER BY record_id').all();
  assert.equal(rows.length,2);for(const row of rows){assert.equal(row.request_id,row.record_id);assert.equal(row.owner,'[erased]');assert.equal(JSON.stringify(row).includes(CANARY),false);}
  const tracked=f.db.prepare("SELECT row_key FROM memory_erasure_content_rows WHERE table_name='cp_requests'").all();assert.deepEqual(tracked.map(r=>JSON.parse(r.row_key)[0]).sort(),r.ids.sort());assert.equal(JSON.stringify(tracked).includes(r.label),false);
  assert.throws(()=>f.db.prepare('UPDATE cp_requests SET owner=?,request_id=? WHERE record_id=?').run('changed-owner','changed-label',r.ids[0]),/replay denied/);content.assertReadable(f.db);
});
for(const shape of ['missing','duplicate'])test('request '+shape+' record identity cannot produce COMPLETE erasure',t=>{
  const f=fixture(t);requests(f,{[shape]:true});assert.throws(()=>f.memory.erase(f.item.memoryId),/incomplete|origin|migration/);assert.throws(()=>content.assertReadable(f.db),/incomplete|origin|migration/);assert.equal(f.db.prepare("SELECT count(*) n FROM memory_erasure_content_progress WHERE state='failed'").get().n,1);
});
function verification(f,result){f.db.exec('CREATE TABLE cp_verifications(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,run_id TEXT NOT NULL,revision INTEGER NOT NULL,workspace_hash TEXT NOT NULL,result TEXT NOT NULL,evidence TEXT NOT NULL,checker TEXT NOT NULL,created_at INTEGER NOT NULL)');f.db.prepare('INSERT INTO cp_verifications VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),randomUUID(),randomUUID(),1,'fixture-personal-workspace-digest',result,JSON.stringify({memory_id:f.item.memoryId,detail:CANARY}),'pi:typed-capabilities',1);}
test('canonical verification outcome survives erasure while its evidence and workspace digest disappear',t=>{
  const f=fixture(t);verification(f,'passed');f.memory.erase(f.item.memoryId);const row=f.db.prepare('SELECT * FROM cp_verifications').get();assert.equal(row.result,'passed');assert.equal(JSON.stringify(row).includes(CANARY),false);assert.notEqual(row.workspace_hash,'fixture-personal-workspace-digest');content.assertReadable(f.db);
});
test('unknown verification outcome cannot be retained as non-content metadata',t=>{
  const f=fixture(t);verification(f,CANARY);assert.throws(()=>f.memory.erase(f.item.memoryId),/incomplete/);assert.throws(()=>content.assertReadable(f.db),/incomplete/);
});
function outbox(f){f.db.exec('CREATE TABLE cp_effect_outbox(id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,correlation TEXT NOT NULL,payload TEXT NOT NULL)');for(let i=0;i<2;i++)f.db.prepare('INSERT INTO cp_effect_outbox VALUES(?,?,?,?)').run(randomUUID(),'private-event-key-'+i,JSON.stringify({memory_id:f.item.memoryId}),JSON.stringify({text:CANARY}));}
test('uniquely constrained personal labels become independent opaque tombstones and remain stable on retry',t=>{
  const f=fixture(t);outbox(f);f.memory.erase(f.item.memoryId);const first=f.db.prepare('SELECT * FROM cp_effect_outbox ORDER BY id').all();assert.equal(new Set(first.map(r=>r.event_key)).size,2);for(const row of first){assert.match(row.event_key,/^erased:[0-9a-f-]{36}$/);assert.equal(JSON.stringify(row).includes(CANARY),false);assert.equal(row.event_key.includes(row.id),false);}f.memory.erase(f.item.memoryId);assert.deepEqual(f.db.prepare('SELECT * FROM cp_effect_outbox ORDER BY id').all(),first);assert.equal(identity.migrate(f.db).state,'complete');assert.deepEqual(f.db.prepare('SELECT * FROM cp_effect_outbox ORDER BY id').all(),first);
});
test('an incoming tombstone-looking personal label is replaced unless canonical erasure disposition proves its origin',t=>{
  const f=fixture(t);outbox(f);const original='erased:'+randomUUID();f.db.prepare('UPDATE cp_effect_outbox SET event_key=? WHERE id=(SELECT id FROM cp_effect_outbox LIMIT 1)').run(original);f.memory.erase(f.item.memoryId);assert.equal(f.db.prepare('SELECT count(*) n FROM cp_effect_outbox WHERE event_key=?').get(original).n,0);
});
function retainedOutbox(f){const{ControlPlaneStore}=require('../src/control-plane-store');return new ControlPlaneStore({db:f.db,ledger:f.ledger,now:()=>1000}).outbox;}
for(const boundary of ['payload','correlation'])test('real queued '+boundary+' reference is redacted by erasure and never reaches its registered transport',async t=>{
  const f=fixture(t),out=retainedOutbox(f);let delivered=0;out.register('fixture',()=>{delivered++;return{ok:true};});
  const id=out.enqueue({key:'payload-fixture',destination:'fixture',ref:'local',eventType:'fixture.result',correlation:boundary==='correlation'?{memory_id:f.item.memoryId}:{},payload:boundary==='payload'?{nested:{memory_id:f.item.memoryId,text:CANARY}}:{text:CANARY}});
  f.memory.erase(f.item.memoryId);await out.dispatch();const row=f.db.prepare('SELECT * FROM cp_effect_outbox WHERE id=?').get(id);
  assert.equal(delivered,0);assert.equal(JSON.parse(row.payload).content_state,'erased');assert.equal(JSON.stringify(row).includes(CANARY),false);assert.equal(row.receipt,null);
});
test('external request identity referencing erased memory is retired through its independent record UUID',t=>{
  const f=fixture(t),{ControlPlaneStore}=require('../src/control-plane-store'),store=new ControlPlaneStore({db:f.db,ledger:f.ledger});store.request('fixture-personal-owner',f.item.memoryId,{text:CANARY},()=>({text:CANARY}));
  f.memory.erase(f.item.memoryId);const row=f.db.prepare('SELECT * FROM cp_requests').get();assert.equal(row.request_id,row.record_id);assert.equal(row.owner,'[erased]');assert.equal(JSON.stringify(row).includes(CANARY),false);assert.equal(f.db.prepare('SELECT count(*) n FROM cp_requests WHERE request_id=?').get(f.item.memoryId).n,0);
});
test('structured ChatGPT payload-only memory references are erased without treating event-ledger raw text as JSON',t=>{
  const f=fixture(t),{ChatGPTEvents}=require('../src/chatgpt-events');new ChatGPTEvents(f.db);const task=randomUUID(),record=randomUUID();
  f.db.prepare('INSERT INTO chatgpt_events(task_id,event_id,fingerprint,payload,received_at,delivery,record_id) VALUES(?,?,?,?,?,?,?)').run(task,randomUUID(),'fixture-personal-commitment',JSON.stringify({memory_id:f.item.memoryId,text:CANARY}),1,'inbox_only',record);
  f.memory.erase(f.item.memoryId);const row=f.db.prepare('SELECT * FROM chatgpt_events').get();assert.equal(row.event_id,record);assert.equal(JSON.parse(row.payload).content_state,'erased');assert.equal(JSON.stringify(row).includes(CANARY),false);
});
test('authoritative retained-row dispositions erase a pre-delete backup even after its memory reference disappears',t=>{
  const f=fixture(t,{file:true}),out=retainedOutbox(f),id=out.enqueue({key:'archive-retained-fixture',destination:'fixture',ref:'local',eventType:'fixture.result',payload:{memory_id:f.item.memoryId,text:CANARY}}),archive=f.backup();
  archive.prepare('UPDATE cp_effect_outbox SET payload=? WHERE id=?').run(JSON.stringify({text:CANARY}),id);f.memory.erase(f.item.memoryId);identity.migrate(f.db);identity.migrate(archive,{sourceDb:f.db});new PersonalMemory({db:archive,restoreFromBackup:true,erasureSourceDb:f.db});
  const row=archive.prepare('SELECT * FROM cp_effect_outbox WHERE id=?').get(id);assert.equal(JSON.parse(row.payload).content_state,'erased');assert.equal(JSON.stringify(row).includes(CANARY),false);assert.equal(archive.prepare("SELECT count(*) n FROM memory_erasure_content_rows WHERE table_name='cp_effect_outbox'").get().n,1);
  new PersonalMemory({db:archive,restoreFromBackup:true,erasureSourceDb:f.db});content.assertReadable(archive);
});
test('recovery rejects a retained outbox row with changed protected task correlation',t=>{
  const f=fixture(t,{file:true}),out=retainedOutbox(f),task=randomUUID(),id=out.enqueue({key:'archive-scope-fixture',destination:'fixture',ref:'local',eventType:'fixture.result',correlation:{task_id:task},payload:{memory_id:f.item.memoryId,text:CANARY}}),archive=f.backup();
  f.memory.erase(f.item.memoryId);identity.migrate(f.db);identity.migrate(archive,{sourceDb:f.db});archive.prepare('UPDATE cp_effect_outbox SET correlation=? WHERE id=?').run(JSON.stringify({task_id:randomUUID()}),id);
  assert.throws(()=>new PersonalMemory({db:archive,restoreFromBackup:true,erasureSourceDb:f.db}),/scope mismatch/);assert.equal(archive.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);
  const scope=JSON.parse(f.db.prepare("SELECT scope_json FROM memory_erasure_content_rows WHERE table_name='cp_effect_outbox'").get().scope_json);assert.deepEqual(scope.correlation,{task_id:task});assert.equal(JSON.stringify(scope).includes(CANARY),false);
});
test('an unverified legacy erased outbox correlation cannot fabricate recovery ownership',t=>{
  const f=fixture(t,{file:true}),out=retainedOutbox(f);out.enqueue({key:'legacy-scope-fixture',destination:'fixture',ref:'local',eventType:'fixture.result',correlation:{task_id:randomUUID()},payload:{memory_id:f.item.memoryId,text:CANARY}});const archive=f.backup();f.memory.erase(f.item.memoryId);f.db.exec("UPDATE memory_erasure_content_rows SET scope_json=NULL WHERE table_name='cp_effect_outbox'");
  assert.throws(()=>erasure.reconcile(archive,f.db),/Unanchored erased correlation/);assert.equal(archive.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);
});
test('unknown correlation scope is denied and propagation remains retryable',t=>{
  const f=fixture(t),out=retainedOutbox(f);out.enqueue({key:'unknown-scope-fixture',destination:'fixture',ref:'local',eventType:'fixture.result',correlation:{task_id:'personal-scope-name-iris'},payload:{memory_id:f.item.memoryId,text:CANARY}});assert.throws(()=>f.memory.erase(f.item.memoryId),/incomplete/);assert.throws(()=>content.assertReadable(f.db),/incomplete/);
});
function dispatchCopies(f,{badId=false}={}){const dispatch=badId?CANARY:randomUUID(),attempt=randomUUID();f.db.exec('PRAGMA foreign_keys=ON;CREATE TABLE cp_agent_dispatch_intents(dispatch_id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,mission_id TEXT NOT NULL,status TEXT NOT NULL,next_attempt_at INTEGER,record TEXT NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE cp_agent_dispatch_attempts(attempt_id TEXT PRIMARY KEY,dispatch_id TEXT NOT NULL,ordinal INTEGER NOT NULL,outcome TEXT,UNIQUE(dispatch_id,ordinal),FOREIGN KEY(dispatch_id) REFERENCES cp_agent_dispatch_intents(dispatch_id))');f.db.prepare('INSERT INTO cp_agent_dispatch_intents VALUES(?,?,?,?,?,?,?)').run(dispatch,randomUUID(),randomUUID(),'failed',null,JSON.stringify({memory_id:f.item.memoryId,text:CANARY}),1);f.db.prepare('INSERT INTO cp_agent_dispatch_attempts VALUES(?,?,?,?)').run(attempt,dispatch,1,JSON.stringify({classification:'accepted',receipt:{url:'https://personal-fixture.invalid/'+CANARY}}));return{dispatch,attempt};}
test('dispatch envelope UUIDs and relations survive while provider receipt payload is erased',t=>{
  const f=fixture(t),r=dispatchCopies(f);f.memory.erase(f.item.memoryId);const parent=f.db.prepare('SELECT * FROM cp_agent_dispatch_intents').get(),child=f.db.prepare('SELECT * FROM cp_agent_dispatch_attempts').get();assert.equal(parent.dispatch_id,r.dispatch);assert.equal(child.attempt_id,r.attempt);assert.equal(child.dispatch_id,r.dispatch);assert.equal(JSON.parse(child.outcome).content_state,'erased');assert.equal(JSON.stringify(child).includes(CANARY),false);assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);assert.throws(()=>f.db.prepare('UPDATE cp_agent_dispatch_attempts SET outcome=?').run(JSON.stringify({receipt:CANARY})),/replay denied/);
});
test('unknown dispatch labels cannot be promoted to immutable metadata',t=>{const f=fixture(t);dispatchCopies(f,{badId:true});assert.throws(()=>f.memory.erase(f.item.memoryId),/incomplete/);assert.throws(()=>content.assertReadable(f.db),/dispatch envelope identity|incomplete/);});
test('recovery remaps authoritative retained dispositions by marker identity rather than copied generation number',t=>{
  const f=fixture(t,{file:true}),out=retainedOutbox(f),id=out.enqueue({key:'generation-remap-fixture',destination:'fixture',ref:'local',eventType:'fixture.result',payload:{memory_id:f.item.memoryId,text:CANARY}}),archive=f.backup();
  erasure.mark(archive,{store:'personal',identity:randomUUID(),scope_hash:erasure.scopeHash(['personal',null,null,null]),action:'forget',erased_at:1});f.memory.erase(f.item.memoryId);identity.migrate(f.db);identity.migrate(archive,{sourceDb:f.db});new PersonalMemory({db:archive,restoreFromBackup:true,erasureSourceDb:f.db});
  const marker=erasure.marker(archive,'personal',f.item.memoryId),tracked=archive.prepare("SELECT generation FROM memory_erasure_content_rows WHERE table_name='cp_effect_outbox' AND row_key=?").get(JSON.stringify([id]));assert.notEqual(marker.generation,erasure.marker(f.db,'personal',f.item.memoryId).generation);assert.equal(tracked.generation,marker.generation);assert.equal(archive.prepare('SELECT payload FROM cp_effect_outbox WHERE id=?').get(id).payload.includes(CANARY),false);
});
test('interrupted recovery disposition import rolls back atomically and can be retried',t=>{
  const f=fixture(t,{file:true}),out=retainedOutbox(f);out.enqueue({key:'interrupted-recovery-fixture',destination:'fixture',ref:'local',eventType:'fixture.result',payload:{memory_id:f.item.memoryId,text:CANARY}});const archive=f.backup();f.memory.erase(f.item.memoryId);identity.migrate(f.db);identity.migrate(archive,{sourceDb:f.db});
  archive.exec("CREATE TRIGGER disposition_fault BEFORE INSERT ON memory_erasure_content_rows BEGIN SELECT RAISE(ABORT,'fixture recovery unavailable');END");assert.throws(()=>new PersonalMemory({db:archive,restoreFromBackup:true,erasureSourceDb:f.db}),/fixture recovery unavailable/);assert.equal(archive.prepare('SELECT count(*) n FROM memory_erasure_content_rows').get().n,0);assert.equal(archive.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);
  archive.exec('DROP TRIGGER disposition_fault');new PersonalMemory({db:archive,restoreFromBackup:true,erasureSourceDb:f.db});assert.equal(archive.prepare('SELECT payload FROM cp_effect_outbox').get().payload.includes(CANARY),false);content.assertReadable(archive);
});
test('recovery cannot use a source whose propagation status is incomplete',t=>{
  const f=fixture(t,{file:true}),archive=f.backup();f.memory.erase(f.item.memoryId);f.db.prepare("UPDATE memory_erasure_content_progress SET state='failed'").run();assert.throws(()=>erasure.reconcile(archive,f.db),/incomplete/);assert.equal(archive.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);
});
test('unknown retained scope shape fails closed before recovered erasure authority is installed',t=>{
  const f=fixture(t,{file:true}),out=retainedOutbox(f);out.enqueue({key:'unknown-disposition-fixture',destination:'fixture',ref:'local',eventType:'fixture.result',payload:{memory_id:f.item.memoryId,text:CANARY}});const archive=f.backup();f.memory.erase(f.item.memoryId);f.db.prepare("UPDATE memory_erasure_content_rows SET scope_json=? WHERE table_name='cp_effect_outbox'").run(JSON.stringify({version:1,columns:{},correlation:{unknown:CANARY}}));assert.throws(()=>erasure.reconcile(archive,f.db),/scope shape/);assert.equal(archive.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);
});
for(const wrong of ['task','project','unknown'])test('source mission '+wrong+' relation is denied before any family marker',t=>{
  const task=randomUUID(),mission=randomUUID(),f=fixture(t,{memoryScope:{domain:'project',projectId:'fixture-project',taskId:task},eventScope:{taskId:task,missionId:mission,metadata:{project_id:'fixture-project'}}});f.db.exec('CREATE TABLE cp_missions(id TEXT PRIMARY KEY,task_id TEXT,project_id TEXT)');if(wrong!=='unknown')f.db.prepare('INSERT INTO cp_missions VALUES(?,?,?)').run(mission,wrong==='task'?randomUUID():task,wrong==='project'?'foreign-project':'fixture-project');assert.throws(()=>f.memory.erase(f.item.memoryId),/source mission scope mismatch/);assert.equal(f.db.prepare('SELECT count(*) n FROM memory_erasure_markers').get().n,0);assert.equal(f.ledger.get(f.event.event_id).payload,CANARY);
});
test('verified source mission relation erases within its canonical task and project scope',t=>{
  const task=randomUUID(),mission=randomUUID(),f=fixture(t,{memoryScope:{domain:'project',projectId:'fixture-project',taskId:task},eventScope:{taskId:task,missionId:mission,metadata:{project_id:'fixture-project'}}});f.db.exec('CREATE TABLE cp_missions(id TEXT PRIMARY KEY,task_id TEXT,project_id TEXT)');f.db.prepare('INSERT INTO cp_missions VALUES(?,?,?)').run(mission,task,'fixture-project');f.memory.erase(f.item.memoryId);assert.equal(f.ledger.get(f.event.event_id).payload,null);
});
test('caller-supplied event correlation labels and their content commitments disappear after source erasure',t=>{
  const labels={idempotencyKey:'private-idempotency-iris',traceId:'private-trace-iris',spanId:'private-span-iris',parentEventId:'private-parent-iris'},f=fixture(t,{eventScope:labels}),before=f.ledger.get(f.event.event_id);f.memory.erase(f.item.memoryId);const after=f.ledger.get(f.event.event_id),raw=f.db.prepare('SELECT * FROM event_ledger_events WHERE event_id=?').get(f.event.event_id);
  for(const field of ['idempotency_key','trace_id','span_id','parent_event_id'])assert.equal(raw[field],null);for(const label of Object.values(labels))assert.equal(JSON.stringify(raw).includes(label),false);
  assert.equal(after.event_id,before.event_id);assert.equal(after.event_type,before.event_type);assert.equal(after.timestamp_ms,before.timestamp_ms);assert.equal(after.payload,null);assert.equal(after.payload_sha256,null);assert.notEqual(raw.fingerprint,before.fingerprint);
  const audit=f.db.prepare("SELECT * FROM event_ledger_events WHERE event_type='memory.content_redacted'").get();assert.equal(audit.protected,1);assert.match(audit.idempotency_key,/^content-redaction:/);assert.throws(()=>f.db.prepare('UPDATE event_ledger_events SET idempotency_key=NULL WHERE event_id=?').run(audit.event_id),/Immutable/);assert.equal(content.verify(f.db).valid,true);
});
