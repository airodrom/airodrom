'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const {digest,DESCRIPTOR}=require('../src/qualified-coding-adapter');
function manifest(repo,files){return{mission:{id:'execution-v1',version:1,title:'Execution qualification',repository:{root:repo,branch:execFileSync('/usr/bin/git',['-C',repo,'branch','--show-current'],{encoding:'utf8'}).trim()},authority:{level:'Development'},duration:{expires_after:'1h'},scope:{repositories:[repo],include:files,exclude:[]},permissions:{filesystem:{read:true,write:true,delete:false},repository:{branch:false,commit:false,push:false,merge:false},runtime:{test:true,lint:true,typecheck:true,restart_local:false},network:{localhost:true,internet:false},providers:{local_reasoning:false,approved_external:false},memory:{read:true,search:true,write:false,delete:false}},evidence:{required:['tests','diff_check'],optional:[]},settlement:{review_required:true,merge_allowed:false,deploy_allowed:false},budget:{max_files_changed:10,max_commits:0,max_runtime_hours:1,max_external_reasoning_calls:0,max_memory_injections:0}}};}
function input(f,files={'fixture.txt':'beta\n'},automatic=true){return{allowed_files:Object.keys(files),criteria:Object.entries(files).map(([file,content],i)=>({id:'file-'+i,type:'exact_file',path:file,content})),manifest:manifest(f.repo,Object.keys(files)),coding_plan:{version:1,operations:Object.entries(files).map(([file,content])=>({name:'file_write',path:file,content,preimage_sha256:digest(path.join(f.repo,file))}))},...(automatic?{automatic_acceptance:true}:{})};}
test('Qualified multi-file coding uses typed receipts and automatically settles with independent evidence',async t=>{
 const f=await fixture(t),m=f.create(input(f,{'fixture.txt':'beta\n','second.txt':'second\n'}));
 assert.equal(m.envelope.coding_plan.adapter.id,DESCRIPTOR.id);f.bridge.missions.dispatch(m.id,{request_id:'execute'});
 const done=await f.settle(m.id,'completed');assert.equal(done.acceptance.length,1);assert.equal(done.program_contract.settlement.state,'settled');assert.equal(done.verifications[0].result,'passed');
 assert.equal(f.calls(),0);assert.equal(f.inference(),0);assert.ok(done.runs.some(r=>r.result?.coding_plan_hash));
 assert.equal(f.bridge.missions.acceptanceEngine.attempt(m.id).duplicate,true);
 await f.reopen();assert.equal(f.bridge.missions.acceptanceEngine.attempt(m.id).duplicate,true);assert.equal(f.bridge.missions.detail(m.id).acceptance.length,1);
});
test('Coding without explicit preauthorization remains awaiting Acceptance',async t=>{const f=await fixture(t),m=f.create(input(f,undefined,false));f.bridge.missions.dispatch(m.id,{request_id:'manual'});const done=await f.settle(m.id);assert.equal(done.acceptance.length,0);assert.equal(f.bridge.missions.acceptanceEngine.attempt(m.id).accepted,false);});
test('Coding registration rejects missing manifest, wrong preimage, protected inputs and nonobjective acceptance',async t=>{
 const f=await fixture(t),good=input(f);
 assert.throws(()=>f.create({...good,manifest:undefined}),/manifest/);
 assert.throws(()=>f.create({...good,coding_plan:{version:1,operations:[{...good.coding_plan.operations[0],preimage_sha256:null}]}}),/preimage/);
 assert.throws(()=>f.create({...good,criteria:[{id:'human',type:'semantic',description:'Looks good'}]}),/objective/);
 assert.throws(()=>f.create({...good,allowed_files:['tests/fixture.test.cjs']}),/protected/);
 assert.throws(()=>f.create({...good,preferred_agent:'claude_code'}),/fixed local route/);
 assert.throws(()=>f.create({...good,automatic_acceptance:false}),/must be true/);
});
test('Changed workspace cannot auto-accept passing old verification',async t=>{
 const f=await fixture(t),m=f.create(input(f));const engine=f.bridge.missions.acceptanceEngine,attempt=engine.attempt.bind(engine);engine.attempt=()=>({accepted:false});
 f.bridge.missions.dispatch(m.id,{request_id:'stale'});await f.settle(m.id);
 fs.writeFileSync(path.join(f.repo,'fixture.txt'),'stale\n');assert.equal(attempt(m.id).reason,'stale_workspace');assert.equal(f.bridge.missions.detail(m.id).acceptance.length,0);
});
test('Failed objective evidence never grants Acceptance',async t=>{const f=await fixture(t),good=input(f),m=f.create({...good,criteria:[{id:'wrong',type:'exact_file',path:'fixture.txt',content:'wrong\n'}]});f.bridge.missions.dispatch(m.id,{request_id:'fail'});const done=await f.settle(m.id,'needs_rework');assert.equal(done.acceptance.length,0);assert.equal(f.bridge.missions.acceptanceEngine.attempt(m.id).accepted,false);});
test('Unknown termination, pending approval and altered qualification deny automatic acceptance',async t=>{
 const f=await fixture(t),m=f.create(input(f)),engine=f.bridge.missions.acceptanceEngine,attempt=engine.attempt.bind(engine);engine.attempt=()=>({accepted:false});f.bridge.missions.dispatch(m.id,{request_id:'guards'});const done=await f.settle(m.id),run=done.verifications[0].run_id;
 const old=f.bridge.policy.list.bind(f.bridge.policy);f.bridge.policy.list=()=>[{status:'pending',taskId:m.task_id}];assert.equal(attempt(m.id).reason,'pending_approval');f.bridge.policy.list=old;
 f.bridge.memory.db.prepare('UPDATE cp_runs SET termination_verified=0 WHERE id=?').run(run);assert.equal(attempt(m.id).reason,'execution_not_qualified');
 assert.throws(()=>f.bridge.memory.db.prepare("UPDATE cp_execution_qualification SET policy='{}' WHERE mission_id=?").run(m.id),/Immutable/);
});
test('Same repository program advances automatically only after durable predecessor Acceptance',async t=>{
 const f=await fixture(t),first=f.create(input(f)),next={project_id:first.project_id,goal_id:first.goal_id,objective:'Create qualified second stage',workspace:f.repo,verification:first.envelope.verification,...input(f,{'second.txt':'second\n'})};
 const p=f.bridge.missions.program,g=p.create({request_id:'qualified-program',max_runtime_hours:1,stages:[{id:'first',mission_id:first.id,depends_on:[]},{id:'second',mission:next,depends_on:['first']}]});
 await f.settle(first.id,'completed');p.tick();const second=p.inspect(g.id).stages.find(s=>s.node_id==='second').mission_id;assert.ok(second);await f.settle(second,'completed');p.tick();assert.equal(p.inspect(g.id).state,'settled');
 assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'beta\n');assert.equal(fs.readFileSync(path.join(f.repo,'second.txt'),'utf8'),'second\n');assert.equal(f.calls(),0);
});
test('Paused acceptance recovers after restart without repeating coding effects',async t=>{
 const f=await fixture(t),m=f.create(input(f));f.bridge.missions.acceptanceEngine.attempt=()=>({accepted:false});f.bridge.missions.dispatch(m.id,{request_id:'recover'});await f.settle(m.id);
 await f.reopen();const done=await f.settle(m.id,'completed');assert.equal(done.acceptance.length,1);assert.equal(done.runs.filter(r=>r.result?.coding_plan_hash).length,1);
});
test('Immutable plan tampering is denied before dispatch',async t=>{
 const f=await fixture(t),m=f.create(input(f)),db=f.bridge.memory.db;const e=structuredClone(m.envelope);e.coding_plan.operations[0].content='tampered\n';e.dispatch_policy.native_actions[0].content='tampered\n';db.prepare('UPDATE cp_missions SET envelope=? WHERE id=?').run(JSON.stringify(e),m.id);
 assert.throws(()=>f.bridge.missions.codingAdapter.assert(f.bridge.controlStore.requireMission(m.id)),/Immutable coding/);assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');
});
test('Incomplete coding receipts and quarantined writers deny settlement',async t=>{
 const f=await fixture(t),m=f.create(input(f)),engine=f.bridge.missions.acceptanceEngine,attempt=engine.attempt.bind(engine);engine.attempt=()=>({accepted:false});f.bridge.missions.dispatch(m.id,{request_id:'receipt-guards'});const done=await f.settle(m.id),db=f.bridge.memory.db,run=f.bridge.controlStore.run(done.verifications[0].run_id);
 db.prepare("UPDATE cp_leases SET state='quarantined' WHERE run_id=?").run(run.id);assert.equal(attempt(m.id).reason,'workspace_writer');db.prepare("UPDATE cp_leases SET state='released' WHERE run_id=?").run(run.id);
 const result=structuredClone(run.result);result.native_execution_evidence.receipt_refs=[];db.prepare('UPDATE cp_runs SET result=? WHERE id=?').run(JSON.stringify(result),run.id);assert.equal(attempt(m.id).reason,'coding_receipts_incomplete');
});
test('Expired manifest prevents automatic settlement even with previously passing checks',async t=>{
 const f=await fixture(t),m=f.create(input(f)),engine=f.bridge.missions.acceptanceEngine,attempt=engine.attempt.bind(engine);engine.attempt=()=>({accepted:false});f.bridge.missions.dispatch(m.id,{request_id:'expiry'});await f.settle(m.id);
 const original=f.bridge.missions.program.now;f.bridge.missions.program.now=()=>m.envelope.manifest.expires_at;assert.equal(attempt(m.id).reason,'authority_or_adapter_invalid');f.bridge.missions.program.now=original;assert.equal(f.bridge.missions.detail(m.id).acceptance.length,0);
});
