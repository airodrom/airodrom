'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),{EventLedger}=require('../src/event-ledger');
const {ControlPlaneStore,prepareInvocationIdentitySchema,prepareLegacyInvocationOrigins}=require('../src/control-plane-store');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fixture(t) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'invocation-origin-proof-'))),db=new DatabaseSync(path.join(dir,'source.sqlite')),ledger=new EventLedger(db,{now:()=>1000}),store=new ControlPlaneStore({db,ledger,now:()=>1000}),task=randomUUID();
  const personal=new (require('../src/personal-memory').PersonalMemory)({db});new (require('../src/project-memory-v2').ProjectMemoryV2)({db});new (require('../src/authority-store').AuthorityStore)(db);new (require('../src/memory-store').MemoryStore)(':memory:',{db});
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});return{dir,db,ledger,store,personal,task};
}
function legacy(f,{request='Fixture-private-caller-label',origin=null,events=1}={}) {
  let event=null;for(let i=0;i<events;i++)event=f.ledger.record({eventType:'orchestrator.invocation.persisted',agent:'bridge',direction:'internal',taskId:f.task,metadata:{request_id:request},protected:true});
  f.db.prepare('INSERT INTO cp_invocations(request_id,task_id,fingerprint,state,result,created_at,updated_at,origin_event_id) VALUES(?,?,?, ?,NULL,?,?,?)').run(request,f.task,'fixture-fingerprint','settled',1000,1000,origin);
  return{request,event};
}
test('new invocation uses an independent protected host event and preserves active caller-label dedupe',t=>{
  const f=fixture(t),request='Fixture-private-caller-label',row=f.store.beginInvocation(f.task,request,'fixture-fingerprint');assert.match(row.origin_event_id,UUID);assert.notEqual(row.origin_event_id,request);
  const event=f.db.prepare('SELECT event_type,task_id,protected FROM event_ledger_events WHERE event_id=?').get(row.origin_event_id);assert.equal(event.event_type,'orchestrator.invocation.persisted');assert.equal(event.task_id,f.task);assert.equal(event.protected,1);
  assert.equal(f.store.beginInvocation(f.task,request,'fixture-fingerprint').origin_event_id,row.origin_event_id);assert.equal(f.db.prepare("SELECT count(*) n FROM event_ledger_events WHERE event_type='orchestrator.invocation.persisted'").get().n,1);assert.throws(()=>f.store.beginInvocation(f.task,request,'different-fingerprint'),/Idempotency/);
  f.store.finishInvocation(request,{summary:'Fixture invocation result'});assert.equal(f.store.invocation(request).state,'settled');
});
test('invocation and origin event insertion roll back together on storage failure',t=>{
  const f=fixture(t);f.db.exec("CREATE TRIGGER fixture_invocation_failure BEFORE INSERT ON cp_invocations BEGIN SELECT RAISE(ABORT,'fixture storage unavailable');END");
  assert.throws(()=>f.store.beginInvocation(f.task,'Fixture-call','fixture-fingerprint'));assert.equal(f.db.prepare('SELECT count(*) n FROM cp_invocations').get().n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM event_ledger_events WHERE event_type='orchestrator.invocation.persisted'").get().n,0);
});
test('legacy invocation preparation derives a unique archived host origin and is idempotent',t=>{
  const f=fixture(t),old=legacy(f);const result=prepareLegacyInvocationOrigins(f.db);assert.equal(result.assigned_records,1);assert.equal(result.verified_origins,1);assert.equal(f.db.prepare('SELECT origin_event_id FROM cp_invocations').get().origin_event_id,old.event.event_id);assert.equal(prepareLegacyInvocationOrigins(f.db).assigned_records,0);assert.equal(result.authority,false);
});
test('DDL-only preparation never invents origins for an unavailable legacy event',t=>{
  const f=fixture(t);legacy(f,{events:0});prepareInvocationIdentitySchema(f.db);assert.equal(f.db.prepare('SELECT origin_event_id FROM cp_invocations').get().origin_event_id,null);assert.throws(()=>prepareLegacyInvocationOrigins(f.db),/unique archived origin/);assert.equal(f.db.prepare('SELECT origin_event_id FROM cp_invocations').get().origin_event_id,null);
});
test('ambiguous or foreign archived invocation origins fail closed without partial assignments',t=>{
  for(const kind of ['ambiguous','foreign']) {
    const f=fixture(t),old=legacy(f,{events:kind==='ambiguous'?2:1});
    if(kind==='foreign'){f.db.exec('DROP TRIGGER control_ledger_no_update');f.db.prepare('UPDATE event_ledger_events SET task_id=? WHERE event_id=?').run(randomUUID(),old.event.event_id);}
    assert.throws(()=>prepareLegacyInvocationOrigins(f.db),/unique archived origin|scope/);assert.equal(f.db.prepare('SELECT origin_event_id FROM cp_invocations').get().origin_event_id,null);
  }
});
test('recovery origin preparation verifies current source identity and never writes to that source',t=>{
  const f=fixture(t),old=legacy(f),copy=path.join(f.dir,'copy.sqlite');f.db.prepare('VACUUM INTO ?').run(copy);const target=new DatabaseSync(copy);t.after(()=>target.close());prepareLegacyInvocationOrigins(f.db);
  const before=f.db.prepare('SELECT * FROM cp_invocations').all();assert.equal(prepareLegacyInvocationOrigins(target,{sourceDb:f.db}).assigned_records,1);assert.equal(target.prepare('SELECT origin_event_id FROM cp_invocations').get().origin_event_id,old.event.event_id);assert.deepEqual(f.db.prepare('SELECT * FROM cp_invocations').all(),before);
});
test('missing or changed current source invocation origin denies recovery',t=>{
  for(const kind of ['missing','changed']) {
    const f=fixture(t);legacy(f);prepareLegacyInvocationOrigins(f.db);const copy=path.join(f.dir,'copy.sqlite');f.db.prepare('VACUUM INTO ?').run(copy);const target=new DatabaseSync(copy);t.after(()=>target.close());
    if(kind==='missing')f.db.prepare('DELETE FROM cp_invocations').run();else f.db.prepare('UPDATE cp_invocations SET origin_event_id=?').run(randomUUID());
    assert.throws(()=>prepareLegacyInvocationOrigins(target,{sourceDb:f.db}),/Current invocation origin scope/);
  }
});
test('scoped erasure removes arbitrary invocation caller labels while retaining opaque replay identity',t=>{
  const f=fixture(t),label='Fixture-private-personal-label',row=f.store.beginInvocation(f.task,label,'fixture-fingerprint');f.store.finishInvocation(label,{summary:label});
  const memory=f.personal.remember({domain:'session',taskId:f.task,type:'note',subject:'Fixture invocation erasure',content:label,source:'user_explicit'});f.personal.erase(memory.memoryId);
  const retained=f.db.prepare('SELECT * FROM cp_invocations').get();assert.equal(retained.origin_event_id,row.origin_event_id);assert.equal(retained.request_id,row.origin_event_id);assert.equal(JSON.stringify(retained).includes(label),false);assert.equal(f.store.invocation(label),null);
  assert.equal(JSON.stringify(f.db.prepare('SELECT metadata,request_id FROM event_ledger_events').all()).includes(label),false);assert.throws(()=>f.db.prepare('UPDATE cp_invocations SET result=? WHERE origin_event_id=?').run(JSON.stringify({summary:label}),row.origin_event_id),/replay denied/);
});
test('an older invocation copy binds archived origins before newer authoritative erasure and whole restore visibility',t=>{
  const f=fixture(t),label='Fixture-private-restore-label',memory=f.personal.remember({domain:'session',taskId:f.task,type:'note',subject:'Fixture restore owner',content:label,source:'user_explicit'}),old=legacy(f,{request:label}),copy=path.join(f.dir,'copy.sqlite');f.db.prepare('VACUUM INTO ?').run(copy);const target=new DatabaseSync(copy);t.after(()=>target.close());prepareLegacyInvocationOrigins(f.db);f.personal.erase(memory.memoryId);
  const {RestrictedMemoryVault}=require('../src/restricted-memory-vault'),sourceDir=path.join(f.dir,'source-vault'),targetDir=path.join(f.dir,'target-vault');fs.mkdirSync(sourceDir,{mode:0o700});fs.mkdirSync(targetDir,{mode:0o700});const sourceVault=new RestrictedMemoryVault(sourceDir);sourceVault.prepare();new RestrictedMemoryVault(targetDir).prepare();
  const restored=require('../src/memory-restore').prepareMemoryRestore({db:target,erasureSourceDb:f.db,erasureSourceVault:sourceVault,vaultDirectory:targetDir});assert.equal(restored.personal.get(memory.memoryId),null);assert.equal(target.prepare('SELECT origin_event_id FROM cp_invocations').get().origin_event_id,old.event.event_id);assert.equal(JSON.stringify(target.prepare('SELECT * FROM cp_invocations').all()).includes(label),false);assert.equal(JSON.stringify(target.prepare('SELECT metadata,request_id FROM event_ledger_events').all()).includes(label),false);
});
