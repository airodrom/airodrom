'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture,wait}=require('./fixtures/mission-fixture.cjs');
const {redactText,safeValue,observeProcesses}=require('../src/secret-observation');
function authorize(f){const p=f.bridge.projects.listProjects()[0];f.bridge.fixtureAcceptance.register({project_id:p.projectId,workspace:f.repo,isolated:true,no_external_effects:true});f.bridge.projects.updateProject(p.projectId,{autonomyLevel:'auto_development'});return p;}
test('secret observation excludes argv and environment; redacts credential text before evidence export',async()=>{
 const seeds=['xoxb-seededSecret123','xapp-seededSecret456','plainToken789','bearerSeed123','envSeed456','cookieSeed789'];
 const raw=`${seeds[0]} ${seeds[1]} --token=${seeds[2]} Authorization: Bearer ${seeds[3]} SLACK_BOT_TOKEN=${seeds[4]} COOKIE=${seeds[5]}`;
 const redacted=redactText(raw);for(const seed of seeds)assert.ok(!redacted.includes(seed));
 assert.equal(redactText('--limit=3 status'),'--limit=3 status');
 const exported=JSON.stringify(safeValue({report:raw,argv:['--token',seeds[2]],env:{PRIVATE:seeds[3]},app_token_present:true}));for(const seed of seeds)assert.ok(!exported.includes(seed));assert.equal(safeValue({app_token_present:true}).app_token_present,true);
 let args;const rows=await observeProcesses({execute:(_file,a,_opts,cb)=>{args=a;cb(null,'123 1 501 S /bin/node\n');}});assert.ok(!args.join().includes('command'));assert.ok(args.join().includes('comm='));assert.equal(rows[0].pid,123);assert.ok(!('argv'in rows[0]));
 const ledger=require('../src/event-ledger').redactPayload(raw).value;for(const seed of seeds)assert.ok(!ledger.includes(seed));
});
test('fixture acceptance is explicit, independently verified, idempotent and recovered after restart',async t=>{
 const f=await fixture(t);authorize(f);const m=f.create({fixture_auto_acceptance:true});f.bridge.missions.dispatch(m.id,{request_id:randomUUID()});await f.settle(m.id,'completed');assert.equal(f.bridge.missions.detail(m.id).acceptance.length,1);assert.equal(f.bridge.fixtureAcceptance.attempt(m.id).duplicate,true);await f.reopen();f.bridge.fixtureAcceptance.reconcile();assert.equal(f.bridge.missions.detail(m.id).acceptance.length,1);assert.equal(f.inference(),0);
 const child=f.create({objective:'Child without explicit fixture policy',allowed_files:['child.txt'],criteria:[{id:'child',type:'exact_file',path:'child.txt',content:'child\n'}]});assert.equal(child.envelope.fixture_auto_acceptance,null);assert.equal(f.bridge.fixtureAcceptance.attempt(child.id).reason,'not_preauthorized_fixture');
});
test('ordinary missions, agent self-enablement, operator criteria, missing checkers and failed verification deny',async t=>{
 const f=await fixture(t);assert.throws(()=>f.create({fixture_auto_acceptance:true}),/preauthorization/);authorize(f);
 assert.throws(()=>f.bridge.fixtureAcceptance.register({project_id:'x',workspace:f.repo,isolated:true,no_external_effects:true},'agent'),/Only operator/);
 assert.throws(()=>f.create({fixture_auto_acceptance:true,criteria:[{id:'review',type:'operator_review',description:'Human review'}]}),/unsafe/);
 const m=f.create({fixture_auto_acceptance:true});const attempt=f.bridge.fixtureAcceptance.attempt.bind(f.bridge.fixtureAcceptance);f.bridge.fixtureAcceptance.attempt=()=>({accepted:false});f.bridge.missions.dispatch(m.id,{request_id:randomUUID()});await f.settle(m.id);f.bridge.fixtureAcceptance.attempt=attempt;
 const v=f.bridge.missions.detail(m.id).verifications[0];const db=f.bridge.memory.db;
 const list=f.bridge.policy.list;f.bridge.policy.list=()=>[{status:'pending',taskId:m.task_id}];assert.equal(attempt(m.id).reason,'pending_approval');f.bridge.policy.list=list;
 const decisions=f.bridge.controlStore.decisions;f.bridge.controlStore.decisions=()=>[{state:'waiting_for_operator'}];assert.equal(attempt(m.id).reason,'waiting_decision');f.bridge.controlStore.decisions=decisions;
 db.prepare('UPDATE cp_verifications SET evidence=? WHERE id=?').run('[]',v.id);assert.equal(attempt(m.id).reason,'missing_or_failed_checker');db.prepare("UPDATE cp_verifications SET result='failed' WHERE id=?").run(v.id);assert.equal(attempt(m.id).reason,'independent_verification_required');
});
test('real reconciliation loop advances bounded two missions with deterministic operator hinge and no manual next',async t=>{
 const f=await fixture(t);authorize(f);const a=f.create({fixture_auto_acceptance:true}),b=f.create({fixture_auto_acceptance:true,objective:'DECISION before fixture update',allowed_files:['fixture.txt','strategy.txt'],criteria:[{id:'strategy',type:'exact_file',path:'strategy.txt',content:'A\n'}]});
 const e=f.bridge.boundedNextActions,id=randomUUID();e.register({id,mode:'auto_development',mission_ids:[a.id,b.id],max_missions:2,max_runtime_ms:60000});
 await Promise.all([e.reconcile(),e.reconcile()]);await f.settle(a.id,'completed');await e.reconcile();await f.settle(b.id,'waiting_for_operator');assert.equal(f.calls(),2);await e.reconcile();assert.equal(f.calls(),2);
 const d=f.bridge.controlStore.decisions(b.id)[0];await f.reopen();await f.bridge.boundedNextActions.reconcile();assert.equal(f.calls(),2);f.bridge.missions.answer(d.id,{request_id:'deterministic-answer',option_id:'A'});f.bridge.missions.answer(d.id,{request_id:'duplicate-answer',option_id:'B'});await f.settle(b.id,'completed');await f.bridge.boundedNextActions.reconcile();assert.equal(f.calls(),3);assert.equal(f.bridge.boundedNextActions.inspect(id).state,'paused');assert.equal(f.inference(),0);
});
test('routing matrix separates deterministic agents, providers, handoff, fallback and WAIT',()=>{
 const {routeTask}=require('../src/agent-routing');const agents={host:{available:true},claude_code:{available:true},codex:{available:false,implemented:true,reason:'native_dispatch_unavailable'},cursor:{available:false,reason:'adapter_unimplemented'}};
 const r=(task_type,extra={})=>routeTask({task_type,candidate_order:['local_files','tests','git','local_diagnostics'].includes(task_type)?['host']:task_type==='ide_diagnostics'?['cursor','claude_code']:['broad_investigation','large_multi_file_coding'].includes(task_type)?['codex','claude_code']:['claude_code','codex'],...extra},agents);
 for(const type of ['local_files','tests','git','local_diagnostics'])assert.equal(r(type,{unavailable_providers:['ollama']}).selected,'host');
 assert.equal(r('focused_refactor').selected,'claude_code');assert.equal(r('broad_investigation',{allow_handoff:true}).transport,'handoff');assert.equal(r('broad_investigation').selected,'claude_code');assert.equal(r('ide_diagnostics').selected,'claude_code');
 for(const extra of [{privacy:'local_only'},{writer_conflict:true},{unknown_side_effects:true},{failed_agents:['claude_code']},{unavailable_providers:['anthropic_subscription']},{required_provider:'ollama'}])assert.equal(r('focused_refactor',extra).selected,null);
 agents.claude_code={available:false,reason:'auth_required'};assert.equal(r('broad_investigation').selected,null);assert.equal(r('unknown').reason,'unknown_task_type');
});
test('paused scheduler holds answered Decision continuation until explicit resume',async t=>{
 const f=await fixture(t);authorize(f);const m=f.create({fixture_auto_acceptance:true,objective:'DECISION before fixture update'}),e=f.bridge.boundedNextActions,id=randomUUID();e.register({id,mode:'auto_development',mission_ids:[m.id],max_runtime_ms:60000});await e.reconcile();await f.settle(m.id,'waiting_for_operator');e.pause(id);const d=f.bridge.controlStore.decisions(m.id)[0];f.bridge.missions.answer(d.id,{request_id:'pause-answer',option_id:'A'});await f.bridge.missions.tick();assert.equal(f.calls(),1);e.resume(id);await f.settle(m.id,'completed');assert.equal(f.calls(),2);
});
