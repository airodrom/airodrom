'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const {BoundedNextAction}=require('../src/bounded-next-action');
function register(e,missions,extra={}){for(const m of missions)e.bridge.projects.updateProject(m.project_id,{autonomyLevel:'auto_development'});const id=randomUUID();e.register({id,mode:'auto_development',mission_ids:missions.map(m=>m.id),...extra});return id;}
function accept(f,m){const d=f.bridge.missions.detail(m.id);return f.bridge.missions.accept(m.id,{request_id:randomUUID(),verification_id:d.verifications[0].id,decision:'accept',rationale:'Independent exact-file and registered checks passed'});}
test('execution defaults off; immutable plan and conservative coding mode fail closed',async t=>{
 const f=await fixture(t),m=f.create(),e=new BoundedNextAction(f.bridge),id=register(e,[m]);
 assert.equal((await e.tick(id)).execution,'not_dispatched');assert.equal(f.calls(),0);
 assert.throws(()=>e.register({id,mode:'auto_development',mission_ids:[m.id],max_missions:3}),/conflict/);
 const safe=register(e,[m],{mode:'auto_safe'});assert.equal((await e.tick(safe)).reason,'coding_requires_auto_development');
});
test('two Mission chain dispatches once, waits for acceptance and Decision, preserves restart and stops at budget',async t=>{
 const f=await fixture(t),a=f.create(),b=f.create({objective:'DECISION before updating the fixture.',allowed_files:['fixture.txt','strategy.txt'],criteria:[{id:'strategy',type:'exact_file',path:'strategy.txt',content:'A\n'}]});
 const e=new BoundedNextAction(f.bridge,{enabled:true}),id=register(e,[a,b]);
 const first=await Promise.all([e.tick(id),e.tick(id)]);assert.equal(first.filter(v=>v.state==='dispatched').length,1);
 await f.settle(a.id);assert.equal((await e.tick(id)).state,'waiting');assert.equal(f.calls(),1);accept(f,a);
 assert.equal((await e.tick(id)).state,'dispatched');await f.settle(b.id,'waiting_for_operator');
 assert.equal((await e.tick(id)).state,'waiting');const decision=f.bridge.controlStore.decisions(b.id)[0];
 await f.reopen();const reopened=new BoundedNextAction(f.bridge,{enabled:true});assert.equal((await reopened.tick(id)).state,'waiting');assert.equal(f.calls(),2);
 f.bridge.missions.answer(decision.id,{request_id:'chain-answer',option_id:'A'});f.bridge.missions.answer(decision.id,{request_id:'chain-answer-duplicate',option_id:'B'});
 await f.settle(b.id);accept(f,b);assert.equal((await reopened.tick(id)).reason,'chain_complete');
 assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_continuations WHERE decision_id=?').get(decision.id).n,1);assert.equal(f.calls(),3);assert.equal(f.inference(),0);
});
test('lease, unavailable agent, immutable scope, runtime and mission budgets block hidden dispatch',async t=>{
 const f=await fixture(t),m=f.create(),e=new BoundedNextAction(f.bridge,{enabled:true}),id=register(e,[m]);
 f.bridge.controlStore.acquireLease({resource:f.repo,runId:'fixture-writer'});assert.equal((await e.tick(id)).reason,'workspace_writer');
 f.bridge.memory.db.prepare("UPDATE cp_leases SET state='released' WHERE run_id='fixture-writer'").run();
 const select=f.bridge.missions.agents.select;f.bridge.missions.agents.select=async()=>({selected:null,reason:'auth_required'});assert.equal((await e.tick(id)).reason,'agent_unavailable');f.bridge.missions.agents.select=select;
 const envelope={...m.envelope,capability_scopes:['repo']};f.bridge.memory.db.prepare('UPDATE cp_missions SET envelope=? WHERE id=?').run(JSON.stringify(envelope),m.id);assert.equal((await e.tick(id)).reason,'immutable_scope_changed');assert.equal(f.calls(),0);
 const later=f.create({objective:'Later fixture budget check'}),timed=new BoundedNextAction(f.bridge,{enabled:true,now:()=>1000}),timer=register(timed,[later],{max_runtime_ms:1});timed.now=()=>1002;assert.equal((await timed.tick(timer)).reason,'runtime_budget');
});
test('failed claimed Mission pauses with no automatic retry; another chain cannot duplicate dispatch',async t=>{
 const f=await fixture(t),m=f.create(),e=new BoundedNextAction(f.bridge,{enabled:true}),id=register(e,[m]);
 const other=register(e,[m]);await e.tick(id);assert.equal((await e.tick(other)).state,'waiting');
 await f.settle(m.id);f.bridge.missions.accept(m.id,{request_id:'rework-budget',verification_id:f.bridge.missions.detail(m.id).verifications[0].id,decision:'rework',rationale:'Explicit fixture rejection'});
 assert.equal((await e.tick(id)).reason,'failure_budget');assert.equal(f.calls(),1);
});
test('project automation policy and protected approval are independent gates',async t=>{
 const f=await fixture(t),m=f.create(),e=new BoundedNextAction(f.bridge,{enabled:true}),id=register(e,[m]);
 f.bridge.projects.updateProject(m.project_id,{autonomyLevel:'suggest'});assert.equal((await e.tick(id)).reason,'project_automation_mode');
 f.bridge.projects.updateProject(m.project_id,{autonomyLevel:'auto_development',privacyPolicy:'Local only; requires explicit runtime qualification'});assert.equal((await e.tick(id)).reason,'project_policy_requires_review');
 f.bridge.projects.updateProject(m.project_id,{privacyPolicy:null});const list=f.bridge.policy.list;f.bridge.policy.list=()=>[{status:'pending',taskId:m.task_id}];assert.equal((await e.tick(id)).reason,'protected_approval_required');f.bridge.policy.list=list;
 assert.equal(f.calls(),0);
});
