'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ControlServer = require('../src/control-server');
const { ProjectMemoryV2 } = require('../src/project-memory-v2');
const { agentRuntimeProfile } = require('../src/agent-runtime-profile');
function fixture(t) {
 const db=new DatabaseSync(':memory:'); t.after(()=>db.close()); let now=100;
 const m=new ProjectMemoryV2({db,now:()=>now});
 const input={missionId:'mission',taskId:'task',objective:'fixture',workspace:'/tmp/fixture',scope:{paths:['file']}};
 m.registerMission(input); return {db,m,input,time:n=>{now=n;}};
}
test('legacy discovery adoption rejects public files and symlinks without persisting credentials',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'credential-fixture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'ui.json');fs.writeFileSync(file,JSON.stringify({url:'http://127.0.0.1:1234/#token='+ 'a'.repeat(64)}),{mode:0o644});
 assert.throws(()=>new ControlServer({dataDir:root}),/Unsafe/);
 assert.equal(fs.existsSync(path.join(root,'control-credential.json')),false);
 fs.chmodSync(file,0o600);fs.renameSync(file,path.join(root,'target'));fs.symlinkSync('target',file);
 assert.throws(()=>new ControlServer({dataDir:root}));assert.equal(fs.existsSync(path.join(root,'control-credential.json')),false);
});
test('private legacy adoption preserves fixture credential and private permissions',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'credential-fixture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'ui.json'),JSON.stringify({url:'http://127.0.0.1:1234/#token='+ 'a'.repeat(64)}),{mode:0o600});
 const server=new ControlServer({dataDir:root,conversationEngine:{close:async()=>{},start:()=>{throw Error('Credential fixture cannot call inference');}}});assert.equal(server.token,'a'.repeat(64));
 assert.equal(fs.statSync(path.join(root,'control-credential.json')).mode&0o077,0);
});
test('Memory V2 removes credential URL values before durable registration',t=>{
 const {db,m}=fixture(t); const seed='fixtureCredential';
 m.registerMission({missionId:'url',taskId:'task',objective:'Inspect http://localhost/#token='+seed,workspace:'/tmp/fixture',scope:{note:'https://example.test/?key='+seed}});
 assert.ok(!JSON.stringify(db.prepare('SELECT * FROM project_memory_v2_missions').all()).includes(seed));
});
test('absolute retention denies extensions and purges on read at exact deadline',t=>{
 const {m,db,time,input}=fixture(t);m.setRetention('mission',{expiresAt:200});assert.throws(()=>m.setRetention('mission',{expiresAt:201}),/extended/);
 time(200);assert.throws(()=>m.latest('mission'),/expired/);
 assert.equal(db.prepare('SELECT count(*) n FROM project_memory_v2_missions').get().n,0);
 assert.throws(()=>m.registerMission(input),/forgotten/);assert.equal(m.purgeExpired().purged,0);
});
test('restore reconciliation propagates tombstones and prevents old identity replay',t=>{
 const current=fixture(t),old=fixture(t);current.m.forgetMission('mission');
 assert.equal(old.m.reconcileErasureFrom(current.db).reconciled,1);
 assert.throws(()=>old.m.registerMission(old.input),/forgotten/);assert.equal(old.m.reconcileErasureFrom(current.db).reconciled,1);
});
test('restore reconciliation applies current deadline to old backup',t=>{
 const current=fixture(t),old=fixture(t);current.m.setRetention('mission',{expiresAt:200});old.time(201);
 old.m.reconcileErasureFrom(current.db);assert.throws(()=>old.m.latest('mission'),/forgotten/);
});
test('retention purge failure rolls back payload and tombstone; retry succeeds',t=>{
 const {m,db,time}=fixture(t);m.setRetention('mission',{expiresAt:200});time(200);
 db.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON project_memory_v2_missions BEGIN SELECT RAISE(ABORT,'fixture outage'); END");
 assert.throws(()=>m.purgeExpired(),/outage/);assert.equal(db.prepare('SELECT count(*) n FROM project_memory_v2_forgotten').get().n,0);
 db.exec('DROP TRIGGER fail_purge');assert.equal(m.purgeExpired().purged,1);
});
test('missing authoritative erasure source fails closed without changing restored database',t=>{
 const {m,db}=fixture(t);const missing=new DatabaseSync(':memory:');t.after(()=>missing.close());
 assert.throws(()=>m.reconcileErasureFrom(missing));assert.equal(db.prepare('SELECT count(*) n FROM project_memory_v2_missions').get().n,1);
});
test('cloud and Cursor health claims never qualify direct execution',()=>{
 for(const id of ['codex','cursor']) {const profile=agentRuntimeProfile(id,{available:true,availability:'available',runtime:{availability:'available',auth_state:'authenticated'}});assert.equal(profile.direct_dispatch,false);assert.equal(profile.available,false);assert.equal(profile.execution_authority,false);}
});
test('private parser errors never contain credential snippets',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'private-json-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'broken');fs.writeFileSync(file,'{"token":"fixtureCredential", broken}',{mode:0o600});
 assert.throws(()=>require('../src/private-json').readPrivateJSON(file),e=>e.message==='Unsafe or invalid private JSON file');
});
test('operator retention control rejects unknown fields and never exposes restore reconciliation',t=>{
 const {m}=fixture(t);const {controlPlaneWrite}=require('../src/control-plane-api');const bridge={projectMemoryV2:{memory:m}};
 assert.equal(controlPlaneWrite(bridge,'project-memory-retention',{mission_id:'mission',expires_at:200}).expiresAt,200);
 assert.throws(()=>controlPlaneWrite(bridge,'project-memory-retention',{mission_id:'mission',expires_at:150,extend:true}));
});
test('declared backup restore cannot open without independent current erasure evidence',t=>{
 const current=fixture(t),old=fixture(t);current.m.forgetMission('mission');
 assert.throws(()=>new ProjectMemoryV2({db:old.db,restoreFromBackup:true}),/erasure evidence/);
 const restored=new ProjectMemoryV2({db:old.db,restoreFromBackup:true,erasureSourceDb:current.db});
 assert.throws(()=>restored.latest('mission'),/forgotten/);
});
test('credential dangling symlinks fail closed instead of generating replacement',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'credential-fixture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.symlinkSync('missing',path.join(root,'control-credential.json'));
 assert.throws(()=>new ControlServer({dataDir:root}),/private JSON/);assert.ok(fs.lstatSync(path.join(root,'control-credential.json')).isSymbolicLink());
});
test('retention operator endpoint denies MCP credentials and invalid payloads',async t=>{
 const {m}=fixture(t),server=new ControlServer({projectMemoryV2:{memory:m},conversationEngine:{close:async()=>{},start:()=>{throw Error('Retention fixture cannot call inference');}}},{port:0,token:'operator-fixture',mcpToken:'mcp-fixture'});
 await server.start();t.after(()=>server.close());
 const post=(token,body)=>fetch(server.origin+'/api/control-v2/project-memory-retention',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post('mcp-fixture',{mission_id:'mission',expires_at:200})).status,401);
 assert.equal((await post('operator-fixture',{mission_id:'mission',expires_at:200,extra:true})).status,400);
 assert.equal((await post('operator-fixture',{mission_id:'mission',expires_at:200})).status,200);
});
test('failed restore reconciliation rolls back tombstone and preserves older payload until retry',t=>{
 const current=fixture(t),old=fixture(t);current.m.forgetMission('mission');
 old.db.exec("CREATE TRIGGER fail_restore BEFORE DELETE ON project_memory_v2_missions BEGIN SELECT RAISE(ABORT,'fixture outage'); END");
 assert.throws(()=>old.m.reconcileErasureFrom(current.db),/outage/);
 assert.equal(old.db.prepare('SELECT count(*) n FROM project_memory_v2_forgotten').get().n,0);
 assert.equal(old.db.prepare('SELECT count(*) n FROM project_memory_v2_missions').get().n,1);
 old.db.exec('DROP TRIGGER fail_restore');old.m.reconcileErasureFrom(current.db);assert.throws(()=>old.m.latest('mission'),/forgotten/);
});
