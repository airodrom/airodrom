'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {fixture}=require('./fixtures/mission-fixture.cjs');
function denied(f,view){
 assert.equal(view.state,'BLOCKED');assert.equal(view.code,'CURSOR_PLANNING_REQUIRED');
 assert.equal(view.execution_authorized,false);assert.equal(view.admission.standard_approval_supported,false);
 assert.equal(view.requested_specialist,'cursor');assert.equal(view.planner,'opencode');assert.equal(view.evaluator,'opencode');
 assert.equal(view.next_action,'prepare_planned_cursor_mission');assert.equal(f.bridge.controlStore.listMissions().length,0);
 assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_runs').get().n,0);
 assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_leases').get().n,0);
 assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');
}
test('legacy exact-work intake reports missing planning before offering an ineffective approval',async t=>{
 const f=await fixture(t),request_id=randomUUID(),instruction='In Fixture project change fixture.txt from alpha to beta.';
 denied(f,await f.bridge.zeroSetupWork.ask({request_id,instruction},'operator'));
 denied(f,await f.bridge.zeroSetupWork.ask({request_id,instruction},'operator'));
 assert.equal(f.bridge.zeroSetupWork.listPending().length,0);
 await assert.rejects(f.bridge.zeroSetupWork.approve({request_id,confirmed:true},'operator'),/not awaiting approval/);
});
test('pre-upgrade pending approval cannot allocate a Mission or register authority after upgrade',async t=>{
 const f=await fixture(t),request_id=randomUUID(),z=f.bridge.zeroSetupWork;
 z.write(request_id,'operator',{version:1,instruction:'Change fixture.txt from alpha to beta.',intent:{kind:'exact_file'},workspace:f.repo,proposal:{project:'legacy'},execution_enabled:false},'awaiting_approval');
 const before=f.bridge.workTemplates.list('operator');denied(f,await z.approve({request_id,confirmed:true},'operator'));
 assert.deepEqual(f.bridge.workTemplates.list('operator'),before);
});
test('bounded projectless requests do not seed files, issue spend approval or create an unplanned writer',async t=>{
 const f=await fixture(t),z=f.bridge.zeroSetupWork,request_id=randomUUID(),workspace=path.join(f.root,'unseeded-sandbox');fs.mkdirSync(workspace);
 const before=f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n;
 denied(f,z.startProjectless(request_id,'operator','Change fixture.txt from alpha to beta.',{kind:'exact_file'},{exact_fixture:true,workspace}));
 assert.deepEqual(fs.readdirSync(workspace),[]);assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n,before);
});
