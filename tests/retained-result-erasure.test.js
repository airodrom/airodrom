'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),{PersonalMemory}=require('../src/personal-memory');
const {attachRetainedFiles}=require('../src/retained-context-files'),content=require('../src/memory-content-erasure');
const digest=value=>createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'retained-result-proof-'))),data=path.join(dir,'source-data');fs.mkdirSync(data,{mode:0o700});
  const db=new DatabaseSync(path.join(dir,'source.sqlite')),personal=new PersonalMemory({db});
  new (require('../src/project-memory-v2').ProjectMemoryV2)({db});new (require('../src/authority-store').AuthorityStore)(db);new (require('../src/event-ledger').EventLedger)(db);new (require('../src/memory-store').MemoryStore)(':memory:',{db});
  db.exec('CREATE TABLE cp_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,mission_id TEXT NOT NULL,agent_id TEXT NOT NULL,state TEXT NOT NULL); CREATE TABLE task_states(id TEXT PRIMARY KEY,snapshot TEXT NOT NULL)');
  const records=[];
  for(const scope of ['affected','unrelated']) {
    const taskId=randomUUID(),runId=randomUUID(),missionId=randomUUID(),canary='Fixture '+scope+' retained result payload',hash=digest(canary),task={id:taskId,status:'completed',description:canary,context:{summary:canary},events:[],createdAt:1000,updatedAt:1000};
    db.prepare('INSERT INTO cp_runs VALUES(?,?,?,?,?)').run(runId,taskId,missionId,'codex','completed');db.prepare('INSERT INTO task_states VALUES(?,?)').run(taskId,JSON.stringify(task));
    const taskDir=path.join(data,'tasks',taskId),runDir=path.join(data,'codex-results',runId);fs.mkdirSync(taskDir,{recursive:true,mode:0o700});fs.mkdirSync(path.join(taskDir,'workspace'),{mode:0o700});fs.writeFileSync(path.join(taskDir,'workspace','preserved.txt'),'Fixture user workspace unchanged');fs.writeFileSync(path.join(taskDir,'task.json'),JSON.stringify(task),{mode:0o600});fs.mkdirSync(runDir,{recursive:true,mode:0o700});
    const envelope={schema_version:'codex-result-v1',mission_id:missionId,task_id:taskId,run_id:runId,request_id:randomUUID(),agent_id:'codex',transport:'handoff',result:{summary:canary,artifacts:['work-artifact:'+hash]},content_hash:hash};
    fs.writeFileSync(path.join(runDir,'consumed.json'),JSON.stringify(envelope),{mode:0o600});
    records.push({taskId,runId,missionId,canary,hash,taskDir,runDir,envelope});
  }
  const item=personal.remember({domain:'session',taskId:records[0].taskId,type:'fact',subject:'Fixture result owner',content:records[0].canary,source:'user_explicit'});
  const vaultDir=path.join(dir,'source-vault');fs.mkdirSync(vaultDir,{mode:0o700});const vault=new (require('../src/restricted-memory-vault').RestrictedMemoryVault)(vaultDir);vault.prepare();
  attachRetainedFiles(db,data);t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {db,personal,dir,data,item,vault,affected:records[0],unrelated:records[1]};
}
function read(record,file='consumed.json'){return fs.readFileSync(path.join(record.runDir,file),'utf8');}
function assertRedacted(f,record=f.affected){const value=read(record);assert.equal(value.includes(record.canary),false);assert.equal(value.includes(record.hash),false);const marker=JSON.parse(value);assert.equal(marker.content_state,'erased');assert.equal(marker.task_id,record.taskId);assert.equal(marker.run_id,record.runId);assert.equal(marker.authority,false);}
test('host identity port rewrites recognized interrupted Work JSON copies without persisting an alias map',t=>{
  const f=fixture(t),identity=require('../src/memory-identity'),attach=identity.attach;let port;
  t.mock.method(identity,'attach',(db,name,fn)=>{if(name==='files')port=fn;return attach(db,name,fn);});attachRetainedFiles(f.db,f.data);t.mock.restoreAll();
  const old='sha256:'+digest('Fixture legacy interrupted reference'),next=randomUUID(),file=path.join(f.affected.runDir,'work-return.tmp');fs.writeFileSync(file,JSON.stringify({...f.affected.envelope,context_pack_id:old}),{mode:0o600});
  require('../src/control-transaction').transaction(f.db,()=>port(new Map([[old,next]]),{generation:1,taskIds:[f.affected.taskId]}));
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).context_pack_id,next);assert.equal(fs.readdirSync(f.affected.runDir).some(name=>name.includes('.identity-')),false);assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM memory_identity_lineage').all()).includes(old),false);
});
test('scoped erasure redacts consumed, pending and interrupted Work result copies without changing another task or workspace',t=>{
  const f=fixture(t),before=read(f.unrelated);
  for(const file of ['completion.json','work-return.tmp','consumed.json.identity-'+randomUUID()+'.tmp'])fs.writeFileSync(path.join(f.affected.runDir,file),JSON.stringify(f.affected.envelope),{mode:0o600});
  f.personal.erase(f.item.memoryId);assertRedacted(f);for(const file of fs.readdirSync(f.affected.runDir)){const text=read(f.affected,file);assert.equal(text.includes(f.affected.canary),false);assert.equal(text.includes(f.affected.hash),false);}
  assert.equal(read(f.unrelated),before);assert.equal(fs.readFileSync(path.join(f.affected.taskDir,'workspace','preserved.txt'),'utf8'),'Fixture user workspace unchanged');assert.equal(f.db.prepare('SELECT state FROM memory_erasure_content_progress').get().state,'complete');content.assertReadable(f.db);
  const after=read(f.affected);f.personal.erase(f.item.memoryId);assert.equal(read(f.affected),after);
});
test('unknown retained result ownership fails closed and a repaired fixture retries without resurrection',t=>{
  const f=fixture(t),orphan=path.join(f.data,'codex-results',randomUUID());fs.mkdirSync(orphan,{mode:0o700});fs.writeFileSync(path.join(orphan,'consumed.json'),JSON.stringify(f.affected.envelope),{mode:0o600});
  assert.throws(()=>f.personal.erase(f.item.memoryId),/incomplete/);assert.throws(()=>content.assertReadable(f.db),/incomplete/);assert.equal(f.db.prepare('SELECT state FROM memory_erasure_content_progress').get().state,'failed');
  fs.rmSync(orphan,{recursive:true});f.personal.retryErasure();assertRedacted(f);content.assertReadable(f.db);
});
test('symlinked, hardlinked and unknown result copies cannot produce a complete erasure receipt',t=>{
  for(const kind of ['symlink','hardlink','unknown']) {
    const f=fixture(t),file=path.join(f.affected.runDir,kind==='unknown'?'unknown-copy.txt':'completion.json');
    if(kind==='symlink')fs.symlinkSync(path.join(f.unrelated.runDir,'consumed.json'),file);else if(kind==='hardlink')fs.linkSync(path.join(f.affected.runDir,'consumed.json'),file);else fs.writeFileSync(file,f.affected.canary,{mode:0o600});
    const other=read(f.unrelated);assert.throws(()=>f.personal.erase(f.item.memoryId),/incomplete/);assert.equal(read(f.unrelated),other);assert.equal(f.db.prepare('SELECT state FROM memory_erasure_content_progress').get().state,'failed');
  }
});
test('active task result cleanup is denied and later inactive retry applies the durable generation',t=>{
  const f=fixture(t);let active=true;attachRetainedFiles(f.db,f.data,{isActive:id=>active&&id===f.affected.taskId});
  assert.throws(()=>f.personal.erase(f.item.memoryId),/incomplete/);assert.throws(()=>content.assertReadable(f.db),/incomplete/);active=false;f.personal.retryErasure();assertRedacted(f);content.assertReadable(f.db);
});
test('crash during result replacement leaves reads denied and retry removes every retained payload',t=>{
  const f=fixture(t),file=path.join(f.affected.runDir,'completion.json');fs.writeFileSync(file,JSON.stringify(f.affected.envelope),{mode:0o600});
  const rename=fs.renameSync;let replacements=0;t.mock.method(fs,'renameSync',(from,to)=>{if(path.dirname(to)===f.affected.runDir&&++replacements===2)throw Error('Fixture replacement interrupted');return rename(from,to);});
  try{assert.throws(()=>f.personal.erase(f.item.memoryId),/incomplete/);assert.throws(()=>content.assertReadable(f.db),/incomplete/);assert.equal(f.db.prepare('SELECT state FROM memory_erasure_content_progress').get().state,'failed');}finally{t.mock.restoreAll();}
  assert.equal(fs.readdirSync(f.affected.runDir).some(name=>name.includes('.identity-')),false);f.personal.retryErasure();assertRedacted(f);assert.equal(fs.readFileSync(file,'utf8').includes(f.affected.canary),false);content.assertReadable(f.db);
});
test('a retained result that contradicts canonical run ownership prevents cross-scope cleanup',t=>{
  const f=fixture(t),other=read(f.unrelated),envelope={...f.affected.envelope,task_id:f.unrelated.taskId};fs.writeFileSync(path.join(f.affected.runDir,'consumed.json'),JSON.stringify(envelope),{mode:0o600});
  assert.throws(()=>f.personal.erase(f.item.memoryId),/incomplete/);assert.equal(read(f.unrelated),other);assert.throws(()=>content.assertReadable(f.db),/incomplete/);
});
test('a pre-erasure database and retained result snapshot are redacted before whole restore returns services',t=>{
  const f=fixture(t),recoveryData=path.join(f.dir,'recovery-data'),recoveryFile=path.join(f.dir,'recovery.sqlite'),recoveryVault=path.join(f.dir,'recovery-vault');
  fs.cpSync(f.data,recoveryData,{recursive:true});fs.mkdirSync(recoveryVault,{mode:0o700});new (require('../src/restricted-memory-vault').RestrictedMemoryVault)(recoveryVault).prepare();f.db.prepare('VACUUM INTO ?').run(recoveryFile);const recovered=new DatabaseSync(recoveryFile);t.after(()=>recovered.close());f.personal.erase(f.item.memoryId);
  const restore=()=>require('../src/memory-restore').prepareMemoryRestore({db:recovered,erasureSourceDb:f.db,erasureSourceVault:f.vault,vaultDirectory:recoveryVault,retainedDataDir:recoveryData});
  const restored=restore();assert.equal(restored.personal.get(f.item.memoryId),null);assert.equal(restored.personal.search('retained result payload',{taskId:f.affected.taskId,domain:'session'}).items.length,0);assertRedacted(f,{...f.affected,runDir:path.join(recoveryData,'codex-results',f.affected.runId)});content.assertReadable(recovered);
  assert.equal(restore().personal.get(f.item.memoryId),null);assert.equal(read({...f.unrelated,runDir:path.join(recoveryData,'codex-results',f.unrelated.runId)}),read(f.unrelated));
});
test('failed restore cleanup returns no services and a repaired fixture recovery remains retryable',t=>{
  const f=fixture(t),recoveryData=path.join(f.dir,'failed-recovery-data'),recoveryFile=path.join(f.dir,'failed-recovery.sqlite'),recoveryVault=path.join(f.dir,'failed-recovery-vault');
  fs.cpSync(f.data,recoveryData,{recursive:true});fs.mkdirSync(recoveryVault,{mode:0o700});new (require('../src/restricted-memory-vault').RestrictedMemoryVault)(recoveryVault).prepare();f.db.prepare('VACUUM INTO ?').run(recoveryFile);const recovered=new DatabaseSync(recoveryFile);t.after(()=>recovered.close());f.personal.erase(f.item.memoryId);
  const unsupported=path.join(recoveryData,'codex-results',f.affected.runId,'unknown-copy.txt');fs.writeFileSync(unsupported,f.affected.canary,{mode:0o600});
  const restore=()=>require('../src/memory-restore').prepareMemoryRestore({db:recovered,erasureSourceDb:f.db,erasureSourceVault:f.vault,vaultDirectory:recoveryVault,retainedDataDir:recoveryData});
  let services=null;assert.throws(()=>{services=restore();},/incomplete/);assert.equal(services,null);fs.rmSync(unsupported);services=restore();assert.equal(services.personal.get(f.item.memoryId),null);assertRedacted(f,{...f.affected,runDir:path.join(recoveryData,'codex-results',f.affected.runId)});
});
