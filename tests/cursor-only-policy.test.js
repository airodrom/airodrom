'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../src/cognitive-router'),P=require('../src/mission-worker-policy');
test('ordinary implementation and architecture narration select Cursor without special syntax',()=>{
 for(const text of ['Edit README.md.','Cursor should handle this: edit README.md.','OpenCode plans; edit README.md; OpenCode evaluates.','Edit only README.md and report READY.'])assert.equal(R.requestedWorker(text),'cursor');
 for(const text of ['Use OpenCode to edit README.md.','Edit README.md without Cursor.','Use host to edit README.md.'])assert.throws(()=>R.requestedWorker(text),/CURSOR_IMPLEMENTATION_REQUIRED/);
 assert.throws(()=>R.requestedWorker('Edit README.md.',{cursorDisabled:true}),/CURSOR_EXECUTION_DISABLED/);
});
test('all coding dispatch routes require Cursor and a sealed planning contract; read-only and noncoding remain allowed',()=>{
 const base={kind:'coding',preferred_agent:'cursor',fallback_agents:[],cognitive:{sealed:{},proposal:{tasks:[{operation:'edit',worker:'cursor'}]}}};P.assertImplementation(base);
 for(const worker of ['opencode','claude_code','codex','host'])assert.throws(()=>P.assertImplementation({...base,preferred_agent:worker}),/CURSOR_IMPLEMENTATION_REQUIRED/);
 assert.throws(()=>P.assertImplementation({...base,fallback_agents:['opencode']}),/CURSOR_IMPLEMENTATION_REQUIRED/);
 assert.throws(()=>P.assertImplementation({...base,cognitive:null}),/CURSOR_PLANNING_REQUIRED/);
 P.assertImplementation({kind:'coding',preferred_agent:'host',dispatch_policy:{native_actions:[{name:'file_read'}]}});
 assert.throws(()=>P.assertImplementation({kind:'coding',preferred_agent:'host',dispatch_policy:{native_actions:[{name:'file_write'}]}}),/CURSOR_IMPLEMENTATION_REQUIRED/);
 for(const preferred_agent of ['host','opencode','cursor','codex'])assert.throws(()=>P.assertImplementation({kind:'coding',preferred_agent,dispatch_policy:{native_actions:[{name:'file_read'}]}},{worker:'codex'}),/CURSOR_IMPLEMENTATION_REQUIRED/);
 P.assertImplementation({kind:'conversation'});
});
test('legacy routing cannot fall back when Cursor is unavailable or disabled',()=>{
 const e={version:2,requested_worker:'auto',eligible_workers:['host','cursor','opencode']},p={files:['README.md'],tasks:[{operation:'edit'}]};
 assert.equal(R.route(e,p,['cursor','opencode']),'cursor');
 assert.throws(()=>R.route(e,p,['opencode']),/cognitive_worker_unqualified:cursor/);
 assert.throws(()=>R.route(e,p,['cursor','opencode'],{cursorDisabled:true}),/CURSOR_EXECUTION_DISABLED/);
});

test('only passed evidence or ordinary registered failures permit another corrective worker',()=>{
 const allow=require('../src/specialist-gateway').repairVerificationAllows,m={envelope:{cognitive:{envelope:{verification:['fixture-test']}},criteria:[{id:'registered-checks',type:'registered_checks'}]}};
 assert.equal(allow(m,{status:'passed',checks:[{id:'scope',status:'passed'}]}),true);
 assert.equal(allow(m,{status:'failed',checks:[{id:'task:fixture-test',status:'failed'},{id:'registered-checks',status:'failed'},{id:'scope',status:'passed'}]}),true);
 for(const id of ['verifier_inputs_unchanged','protected_tests_unchanged','protected_files','requested_file_scope','runtime_provenance','security:secret_scan','task:unenrolled','unknown'])assert.equal(allow(m,{status:'failed',checks:[{id,status:'failed'}]}),false,id);
 assert.equal(allow(m,{status:'failed',checks:[{id:'task:fixture-test',status:'failed'},{id:'scope',status:'unavailable'}]}),false);
 assert.equal(allow(m,{status:'passed',checks:[]}),false);
});


test('direct and continuation Codex handoffs cannot bypass Cursor policy or allocate ownership',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t),b=f.bridge;
 for(const preferred_agent of ['codex','host','opencode']){
  const m=f.create({objective:'Read fixture.txt with '+preferred_agent+' label',preferred_agent,dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],native_actions:[{name:'file_read',path:'fixture.txt'}]}});
  const before=JSON.stringify(b.controlStore.requireMission(m.id).envelope);
  for(const start of [()=>b.codexAdapter.startTask(m.id,'direct-'+preferred_agent),()=>b.codexAdapter.continueTask(m.id,'continue-'+preferred_agent)])
   assert.throws(start,/CURSOR_IMPLEMENTATION_REQUIRED/);
  assert.equal(JSON.stringify(b.controlStore.requireMission(m.id).envelope),before);
 }
 for(const table of ['cp_runs','cp_leases','cp_codex_handoffs','cp_agent_dispatch_intents'])
  assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM '+table).get().n,0,table);
});

test('historical pending handoff cannot claim a new attempt or select another implementation worker',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t),b=f.bridge,m=f.create({preferred_agent:'codex',fallback_agents:['claude_code']});
 // Seed the pre-upgrade pending record; no adapter execution or authority is granted.
 const runId=require('node:crypto').randomUUID();
 b.controlStore.startRun({id:runId,taskId:m.task_id,missionId:m.id,agentId:'codex'});
 const r=b.agentDispatch.register({mission_id:m.id,task_id:m.task_id,run_id:runId,request_id:'historical-pending'});
 const before=JSON.stringify(b.controlStore.requireMission(m.id).envelope);
 const view=b.agentDispatch.claim({dispatch_id:r.dispatch_id});
 assert.equal(view.state,'WAIT');assert.equal(view.wait_reason,'CURSOR_IMPLEMENTATION_REQUIRED');
 assert.deepEqual(b.agentDispatch.fallbackChoice(r,{}),{selected:null,reason:'CURSOR_IMPLEMENTATION_REQUIRED'});
 assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_agent_dispatch_attempts').get().n,0);
 assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches').get().n,0);
 assert.equal(JSON.stringify(b.controlStore.requireMission(m.id).envelope),before);
});

test('historical unknown handoff retains its quarantined writer without retry or fallback',async t=>{
 const f=await require('./fixtures/mission-fixture.cjs').fixture(t),b=f.bridge,m=f.create({preferred_agent:'codex'}),db=b.controlStore.db;
 const runId=require('node:crypto').randomUUID();
 b.controlStore.startRun({id:runId,taskId:m.task_id,missionId:m.id,agentId:'codex'});
 const lease=b.controlStore.acquireLease({resource:f.repo,runId,missionId:m.id});
 const r=b.agentDispatch.register({mission_id:m.id,task_id:m.task_id,run_id:runId,request_id:'historical-unknown'});
 r.no_side_effects=false;r.status='running_unknown';b.agentDispatch.save(r);
 db.prepare("UPDATE cp_leases SET state='quarantined' WHERE id=?").run(lease);
 assert.equal(b.agentDispatch.claim({dispatch_id:r.dispatch_id}).state,'existing_dispatch');
 assert.deepEqual(b.agentDispatch.fallbackChoice(r,{}),{selected:null,reason:'reconcile_unknown_outcome'});
 assert.equal(db.prepare('SELECT state FROM cp_leases WHERE id=?').get(lease).state,'quarantined');
 assert.equal(db.prepare('SELECT count(*) n FROM cp_agent_dispatch_attempts').get().n,0);
 // Teardown only: settle this synthetic ownership after the safety assertions.
 b.controlStore.updateRun(runId,{state:'failed',processState:'not_started',verified:true});
 db.prepare("UPDATE cp_leases SET state='released' WHERE id=?").run(lease);
});
