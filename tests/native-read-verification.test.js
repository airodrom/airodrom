'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,createReadMission}=require('./fixtures/read-mission-fixture.cjs');
test('a host read verifies unchanged bytes and still requires independent Acceptance',async t=>{
 const f=await fixture(t),m=createReadMission(f);f.bridge.missions.dispatch(m.id,{request_id:'read'});
 const done=await f.settle(m.id),check=done.verifications[0].evidence.find(c=>c.id==='expected_changes');
 assert.equal(check.status,'passed');assert.equal(check.evidence.read_only,true);assert.equal(done.acceptance.length,0);
 assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');
 assert.ok(done.verifications[0].evidence.some(c=>c.id==='task:fixture-test'&&c.status==='passed'));
});
test('an unexpected mutation during a host read fails verification even inside allowed files',async t=>{
 const f=await fixture(t),m=createReadMission(f),verify=f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);
 f.bridge.missions.verifier.verify=(...args)=>{fs.writeFileSync(path.join(f.repo,'fixture.txt'),'beta\n');return verify(...args);};
 f.bridge.missions.dispatch(m.id,{request_id:'read-mutation'});const done=await f.settle(m.id,'needs_rework');
 assert.ok(done.verifications[0].evidence.some(c=>c.id==='expected_changes'&&c.status==='failed'&&c.evidence.read_only));
 assert.equal(done.acceptance.length,0);
});
for(const actions of [[{name:'file_read',path:'fixture.txt'},{name:'file_write',path:'fixture.txt',content:'beta\n'}]])test('empty or mixed native plans cannot gain a read-only implementation exemption: '+actions.length,async t=>{
 const f=await fixture(t),m=createReadMission(f,{dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'deterministic_files',native_actions:actions}});
 assert.throws(()=>f.bridge.missions.dispatch(m.id,{request_id:'not-read-only'}),/CURSOR_IMPLEMENTATION_REQUIRED/);
 assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');assert.equal(f.bridge.missions.detail(m.id).runs.length,0);
});

test('empty native plans are rejected before a Mission can be dispatched',async t=>{
 const f=await fixture(t);
 assert.throws(()=>createReadMission(f,{dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'deterministic_files',native_actions:[]}}),/immutable native plan/);
 assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_runs').get().n,0);
});
