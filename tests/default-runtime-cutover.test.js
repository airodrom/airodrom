'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const {runtime,manifest,qualifyCanonical}=require('./fixtures/opencode-fixture.cjs');
const {DEFAULT_RUNTIME,defaultRuntime}=require('../src/default-runtime');
const {routeTask}=require('../src/agent-routing');
const native={task_category:'deterministic_files',privacy:'local_only',providers:['local'],billing_classes:['local'],native_actions:[{name:'file_write',path:'fixture.txt',content:'beta\n'}]};
function accept(f,m){const b=f.bridge,d=b.missions.detail(m.id);assert.equal(d.verifications[0].result,'passed');assert.equal(d.acceptance.length,0);assert.throws(()=>b.missions.program.settle(m.id,'accept'),/Settlement requires/);b.missions.accept(m.id,{request_id:'accept-'+m.id,verification_id:d.verifications[0].id,decision:'accept',rationale:'Independent synthetic checks passed'});assert.equal(b.missions.detail(m.id).program_contract.settlement.state,'settled');}
function reset(f){fs.writeFileSync(path.join(f.repo,'fixture.txt'),'alpha\n');}
test('canonical default and advisory route choose OpenCode; no implicit fallback or unknown rollback runtime',()=>{
 assert.equal(DEFAULT_RUNTIME,'opencode');assert.equal(defaultRuntime(),'opencode');assert.throws(()=>defaultRuntime('host'),/Invalid/);assert.throws(()=>defaultRuntime('cloud'),/Invalid/);
 for(const task_type of ['focused_refactor','broad_investigation','large_multi_file_coding','ide_diagnostics']){
  const agents={opencode:{available:true,capabilities:['coding']},host:{available:true},claude_code:{available:true}};
  assert.equal(routeTask({task_type},agents).selected,'opencode');agents.opencode.available=false;assert.equal(routeTask({task_type},agents).state,'WAIT');
 }
});
test('new default Mission freezes OpenCode through both routing paths and runtime-independent Acceptance/Settlement',async t=>{
 for(const governed of [false,true]){
  const r=runtime(t),f=await fixture(t,{opencode:r.options});if(governed)qualifyCanonical(f.bridge);
  assert.equal(f.bridge.defaultRuntime,'opencode');const m=f.create({preferred_agent:undefined,manifest:manifest(f.repo)});
  assert.equal(m.envelope.preferred_agent,'opencode');assert.equal(m.envelope.route_mode,'default');assert.deepEqual(m.envelope.fallback_agents,[]);assert.equal(m.envelope.dispatch_policy.privacy,'local_only');assert.equal(f.bridge.tasks.get(m.task_id).executionAgent,'opencode');
  f.bridge.missions.dispatch(m.id,{request_id:'default-dispatch'});const done=await f.settle(m.id),run=done.runs.find(r=>r.agent_id==='opencode');assert.equal(done.dispatches[0].route.selected,'opencode');assert.equal(run.result.opencode_provenance.runtime_id,'opencode');assert.equal(run.result.opencode_provenance.authority,false);assert.equal(run.result.opencode_provenance.session_state,'disposable');assert.equal(f.calls(),0);accept(f,m);
 }
});
test('OpenCode unavailable and incompatible policy cannot silently select available Pi or Claude',async t=>{
 for(const governed of [false,true]){
  const f=await fixture(t,{opencode:{enabled:false,executable:'/missing',model:'ollama/fixture'}});if(governed)qualifyCanonical(f.bridge);
  assert.throws(()=>f.create({preferred_agent:undefined,dispatch_policy:{privacy:'cloud_allowed',providers:['anthropic_subscription'],billing_classes:['subscription']}}),/local-only/);
  assert.throws(()=>f.create({preferred_agent:undefined,fallback_agents:['host']}),/no fallbacks/);
  const m=f.create({preferred_agent:undefined});f.bridge.missions.dispatch(m.id,{request_id:'unavailable'});const done=await f.settle(m.id,'blocked');assert.equal(done.dispatches[0].route.selected,null);assert.equal(done.runs.length,0);assert.equal(f.calls(),0);assert.equal(done.envelope.preferred_agent,'opencode');
 }
});
test('host typed plans have no inference runtime and survive restart with independent Settlement',async t=>{
 const f=await fixture(t),b=f.bridge;qualifyCanonical(b);
 const m=f.create({task_type:'local_files',dispatch_policy:native,manifest:manifest(f.repo),capability_scopes:['repo']});
 b.missions.dispatch(m.id,{request_id:'host-plan'});const done=await f.settle(m.id);assert.equal(done.dispatches[0].route.selected,'host');assert.equal(f.inference(),0);accept(f,m);
 await f.reopen();assert.equal(f.bridge.missions.detail(m.id).program_contract.settlement.state,'settled');
 assert.equal(f.bridge.defaultRuntime,'opencode');assert.throws(()=>defaultRuntime('host'),/Invalid/);
});
test('pre-identity tasks become non-executable historical provenance; new bare prompts cannot start an unbounded OpenCode session',async t=>{
 const f=await fixture(t),b=f.bridge,created=b.createTask('Synthetic historical identity',{executionAgent:'host'}),task=b.tasks.get(created.id);delete task.executionAgent;b.tasks.save(task);await f.reopen();assert.equal(f.bridge.tasks.get(created.id).executionAgent,require('../src/removed-runtime').REMOVED_RUNTIME);
 await assert.rejects(f.bridge.ensureRuntime(created.id),/Historical runtime removed/);
 const fresh=f.bridge.createTask('New default task');assert.equal(fresh.executionAgent,'opencode');
 // Fixture suppresses Pi inference; use the actual guarded method to verify admission.
 await assert.rejects(require('./fixtures/test-bridge.cjs').prototype.prompt.call(f.bridge,fresh.id,'Read the fixture'),/bounded registered Mission/);assert.equal(f.bridge.runtimes.size,0);
});
test('default Mission Memory V2 delivery uses minimum current truth; correction/erase denies old packs and Pi cannot resurrect them',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),b=f.bridge,a=qualifyCanonical(b),by=a.store.operator;
 const old=b.rememberPersonalMemory({domain:'personal',type:'preference',subject:'fixture.color',content:'Synthetic fixture color is azure.',source:'user_explicit',confidence:95,sensitivity:'normal'});

 let sequence=0;
 const dispatch=async(required=true)=>{const m=f.create({preferred_agent:undefined,objective:'Change alpha to beta DEFAULT_MEMORY '+(++sequence),target_domains:['fixture'],required_memory_keys:required?['fixture.color']:[],manifest:manifest(f.repo)});b.missions.dispatch(m.id,{request_id:'memory-'+m.id});const done=await f.settle(m.id);assert.equal(done.dispatches[0].route.selected,'opencode');const run=done.runs.find(r=>r.agent_id==='opencode'),pack=b.tasks.get(run.task_id).contextPackId;const summary=done.results.find(x=>x.run_id===run.id).result.summary;accept(f,m);reset(f);return{m,run,pack,summary};};
 const first=await dispatch();assert.equal(first.summary,'Synthetic fixture color is azure.');assert.equal(a.memory.items(first.pack).length,1);
 const forged={id:first.pack,records:[{subject:'fixture.color',content:'Synthetic fixture color is violet.'}]};assert.equal((await b.opencodeAdapter.execute({...r.request,objective:'memory',context:forged})).result.summary,'Synthetic fixture color is azure.');
 const current=b.updatePersonalMemory(old.id,{content:'Synthetic fixture color is amber.'});await assert.rejects(b.opencodeAdapter.execute({...r.request,objective:'memory',context:forged}),/context|erased|unavailable/i);
 const second=await dispatch();assert.equal(second.summary,'Synthetic fixture color is amber.');
 b.forgetPersonalMemory(current.id);a.memory.erase(old.id,by);a.memory.erase(current.id,by);
 assert.equal(b.tasks.get(second.run.task_id).executionAgent,'opencode');assert.equal(b.controlStore.run(second.run.id).agent_id,'opencode');assert.equal(b.controlStore.db.prepare('SELECT result FROM cp_mission_reviews WHERE mission_id=?').get(second.m.id).result,'passed');
 assert.equal(a.store.one('missions',second.m.id).current_revision,1);assert.deepEqual(b.controlStore.db.prepare('PRAGMA foreign_key_check').all(),[]);
 const third=await dispatch(false);assert.equal(third.summary,'unavailable');assert.ok(a.memory.items(third.pack).every(m=>m.subject_key!=='fixture.color'));await assert.rejects(b.opencodeAdapter.execute({...r.request,objective:'memory',context:{id:second.pack}}),/context|erased|unavailable/i);
 await assert.rejects(b.opencodeAdapter.execute({...r.request,objective:'memory',sessionId:'old-session'}),/session_reuse_denied/);
 // Host plans rebuild context through the canonical service without an agent.
 const pi=f.create({preferred_agent:'host',task_type:'local_files',dispatch_policy:native,manifest:manifest(f.repo),capability_scopes:['repo'],target_domains:['fixture']});b.missions.dispatch(pi.id,{request_id:'erased-pi'});const done=await f.settle(pi.id);assert.equal(done.dispatches[0].route.selected,'host');assert.ok(a.memory.items(b.tasks.get(pi.task_id).contextPackId).every(m=>m.subject_key!=='fixture.color'));assert.doesNotMatch(JSON.stringify(b.controlContext.inspect(b.tasks.get(pi.task_id).contextPackId)),/azure|amber/);accept(f,pi);
 assert.doesNotMatch(JSON.stringify(b.controlContext.inspect(second.pack)),/azure|amber/);assert.doesNotMatch(JSON.stringify(a.memory.get(current.id)),/azure|amber/);

 await f.reopen();assert.ok(f.bridge.authorityRuntime.memory.items(third.pack).every(m=>m.subject_key!=='fixture.color'));assert.doesNotMatch(JSON.stringify(f.bridge.personalMemoryContext({projectId:null},'fixture color')),/azure|amber/);
});
