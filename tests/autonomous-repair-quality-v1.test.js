'use strict';
// ADR 0065 corrections are distinct Cursor assignments in the same sealed Mission.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {setup:base}=require('./fixtures/cursor-autonomy-fixture.cjs');
async function setup(t,options={}){const f=await base(t,{repairs:1,manual:true,...options});f.plan=f.plan.slice(0,1);return f;}
test('correction receives failed host checks as untrusted context and preserves both attempts',async t=>{
 const f=await setup(t);f.wrongFirst=true;const p=await f.ask({review:false}),m=await f.settle(p.mission_id),a=m.specialists.assignments[0].attempts;
 assert.equal(a.length,2);assert.notEqual(a[0].run_id,a[1].run_id);assert.equal(a[0].verification.status,'failed');assert.equal(a[1].verification.status,'passed');assert.equal(m.acceptance.length,0);
 const repair=f.calls[1].input.repair_context;assert.equal(repair.worker_run_id,a[0].run_id);assert.equal(repair.untrusted,true);assert.equal(repair.authority,false);assert.ok(repair.host_checks.some(c=>c.id==='task:fixture-test'&&c.status==='failed'));
 assert.deepEqual(f.calls[0].input.assignment.paths,f.calls[1].input.assignment.paths);assert.equal(f.calls[1].input.assignment.worker,'cursor');assert.equal(f.evaluations[1].specialist_return.remaining_repair_budget,0);
 await f.bridge.missions.tick();assert.equal(f.calls.length,2);assert.equal(f.bridge.controlStore.listMissions().length,1);
});
for(const repairs of [0,1])test('persistent incorrect Cursor result stops at repair ceiling '+repairs,async t=>{
 const f=await setup(t,{repairs});f.cursorMode='wrong';const p=await f.ask({review:false}),m=await f.settle(p.mission_id,'needs_rework');
 assert.equal(f.calls.length,repairs+1);assert.equal(m.specialists.repair_attempts,repairs);assert.equal(m.acceptance.length,0);assert.ok(m.specialists.assignments[0].attempts.every(a=>a.verification.status==='failed'));
 await f.bridge.missions.tick();await f.reopen({beforeResume:()=>f.bindAdapter()});await f.bridge.missions.tick();assert.equal(f.calls.length,repairs+1);
});
test('revocation after first failed verification prevents a corrective assignment',async t=>{
 const f=await setup(t);f.wrongFirst=true;const evaluate=f.evaluate;
 f.evaluate=o=>{f.bridge.developerAutonomy.revoke({policy_id:f.policy.policy_id,policy_hash:f.policy.policy_hash,confirmed:true},'operator');return evaluate(o);};
 const p=await f.ask({review:false});let m;for(let i=0;i<1000;i++){await f.bridge.missions.tick();m=f.bridge.missions.detail(p.mission_id);if(['blocked','needs_rework'].includes(m.state))break;await new Promise(r=>setTimeout(r,20));}
 assert.ok(['blocked','needs_rework'].includes(m.state),m.state);assert.equal(f.calls.length,1);assert.equal(m.acceptance.length,0);assert.equal(m.specialists.assignments[0].attempts.length,1);
});
test('worker attempts outside declared files cannot produce an accepted correction',async t=>{
 const f=await setup(t);f.cursorMode='outside';const p=await f.ask({review:false}),m=await f.settle(p.mission_id,'needs_rework');
 assert.equal(m.acceptance.length,0);assert.equal(f.calls.length,1);assert.equal(fs.existsSync(path.join(m.envelope.workspace,'escaped.txt')),false);assert.equal(fs.readFileSync(path.join(m.envelope.workspace,'fixture.txt'),'utf8'),'alpha\n');
});
