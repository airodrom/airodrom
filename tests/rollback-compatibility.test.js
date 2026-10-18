'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const compatibility=require('../src/rollback-compatibility');
function newer(f,{state='ready',programState='running',version=3}={}){
 const old=f.create({objective:'Synthetic retained newer Mission'}),db=f.bridge.controlStore.db;
 const envelope={...old.envelope,cognitive:{envelope:{version},plan:{assignments:[]}},automatic_acceptance:true,risk_auto_acceptance:{authorized:true},fixture_auto_acceptance:{authorized:true},developer_autonomy:{grant_id:'retained-uninterpreted'}};
 db.prepare('UPDATE cp_missions SET envelope=?,state=? WHERE id=?').run(JSON.stringify(envelope),state,old.id);
 db.prepare('INSERT INTO cp_mission_programs(id,owner,graph,fingerprint,state,started_at,expires_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(old.id,'operator',JSON.stringify({kind:'cognitive_specialists_v1',parent_mission_id:old.id,assignments:[{id:'analysis',description:'private retained task'}]}),'fixture',programState,1,Date.now()+60000,randomUUID());
 db.prepare('INSERT INTO cp_mission_program_nodes(program_id,node_id,mission_id,input,state,record_id) VALUES(?,?,NULL,?,?,?)').run(old.id,'analysis','{"assignment":{"role":"analysis"},"attempts":[]}','pending',randomUUID());
 return f.bridge.controlStore.requireMission(old.id);
}
function snapshot(db,id){return JSON.stringify(Object.fromEntries(['cp_missions','cp_mission_programs','cp_mission_program_nodes','cp_dispatches','cp_run_results','cp_continuations','cp_runs','cp_acceptances','cp_mission_budget_usage','cp_mission_settlements'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])));}
function assertions(f,m){
 const s=f.bridge.missions,db=s.db,before=snapshot(db,m.id);
 assert.throws(()=>s.dispatch(m.id,{request_id:'rollback-dispatch'}),/unsupported_cognitive_source/);
 assert.throws(()=>s.queue(m.id),/unsupported_cognitive_source/);
 assert.throws(()=>s.accept(m.id,{request_id:'rollback-accept',decision:'accept',rationale:'Synthetic test'}),/unsupported_cognitive_source/);
 assert.throws(()=>s.program.guardTask(f.bridge.tasks.get(m.task_id),{toolName:'write',input:{path:'fixture.txt'}}),/unsupported_cognitive_source/);
 assert.throws(()=>s.program.resume(m.id),/unsupported_cognitive_source/);
 for(const attempt of [()=>s.acceptanceEngine.attempt(m.id),()=>s.riskAcceptance.attempt(m.id),()=>f.bridge.fixtureAcceptance.attempt(m.id),()=>f.bridge.expandedAutonomy.attemptDeveloperAutonomyAccept(m.id)])assert.equal(attempt().accepted,false);
 assert.equal(s.detail(m.id).next_action,'restore_compatible_source');
 assert.equal(s.program.inspect(m.id).compatibility.supported,false);
 const evidence=require('../src/mission-evidence').evidencePackage(f.bridge,m.id);assert.equal(evidence.status,'UNSUPPORTED_SOURCE');assert.equal(evidence.state,m.state);
 const view=require('../src/product-observability').missionView(f.bridge,m);assert.equal(view.actions.dispatch,false);assert.equal(view.actions.accept,false);assert.match(view.next_action,/compatible source/);
 assert.equal(snapshot(db,m.id),before);
}
for(const state of ['dispatching','verifying','awaiting_acceptance','completed','running','uncertain_evaluator'])test('rollback retains '+state+' V3 without invocation, Acceptance or result consumption',async t=>{
 const f=await fixture(t),m=newer(f,{state:state==='uncertain_evaluator'?'running':state,programState:state==='completed'?'settled':'running'}),s=f.bridge.missions,db=s.db;
 const dispatch=randomUUID(),run=randomUUID();
 if(state==='dispatching')db.prepare("INSERT INTO cp_dispatches VALUES(?,?,?,'queued',NULL,NULL,NULL,?,?)").run(dispatch,m.id,m.task_id,Date.now(),Date.now());
 if(['verifying','running','uncertain_evaluator'].includes(state)){
  s.store.startRun({id:run,taskId:m.task_id,missionId:m.id,agentId:'opencode',role:state==='uncertain_evaluator'?'reasoning':'worker'});
  s.store.updateRun(run,{state:state!=='verifying'?'interrupted':'completed',processState:state!=='verifying'?'unknown':'exited',verified:state==='verifying'});
  if(state==='verifying')db.prepare('INSERT INTO cp_run_results VALUES(?,?,?,0)').run(run,m.id,JSON.stringify({status:'completed',summary:'retained untrusted result'}));
  if(['running','uncertain_evaluator'].includes(state)){s.store.acquireLease({resource:f.repo,runId:run,missionId:m.id});db.prepare("UPDATE cp_leases SET state='quarantined' WHERE run_id=?").run(run);}
 }
 const mcp=new(require('../src/mcp-tools').McpTools)(f.bridge);assert.equal((await mcp.call('get_mission_status',{mission_id:m.id})).status,'UNSUPPORTED_SOURCE');assert.equal((await mcp.call('get_mission_evidence',{mission_id:m.id})).state,m.state);
 assertions(f,m);const before=snapshot(db,m.id);
 await assert.rejects(s.reverify(m.id,{request_id:'rollback-reverify'}),/unsupported_cognitive_source/);
 s.program.tick();s.recover();await s.tick();
 if(state==='dispatching')await s.launch(db.prepare('SELECT * FROM cp_dispatches WHERE id=?').get(dispatch));
 if(state==='verifying')await s.processResult(db.prepare('SELECT * FROM cp_run_results WHERE run_id=?').get(run));
 assert.equal(snapshot(db,m.id),before);assert.equal(f.calls(),0);assert.equal(f.inference(),0);
 if(state==='verifying'){await f.reopen();assert.equal(snapshot(f.bridge.controlStore.db,m.id),before);assert.equal(f.calls(),0);}
 if(['running','uncertain_evaluator'].includes(state)){f.bridge.lifecycle.drain();assert.throws(()=>f.bridge.lifecycle.resume(f.bridge.lifecycle.epoch),/unresolved/);assert.equal(db.prepare('SELECT state FROM cp_leases WHERE run_id=?').get(run).state,'quarantined');}
});
test('unsupported queued graph does not starve a supported Mission and STOP stays available',async t=>{
 const f=await fixture(t),m=newer(f,{state:'dispatching'}),s=f.bridge.missions,db=s.db;
 db.prepare("INSERT INTO cp_dispatches VALUES(?,?,?,'queued',NULL,NULL,NULL,?,?)").run(randomUUID(),m.id,m.task_id,1,1);
 const legacy=randomUUID();db.prepare('INSERT INTO cp_mission_programs(id,owner,graph,fingerprint,state,started_at,expires_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(legacy,'operator','[]','fixture','running',1,Date.now()+60000,randomUUID());s.program.tick();assert.equal(s.program.inspect(legacy).state,'settled');
 const ordinary=f.create({objective:'Supported old Mission continues'});s.dispatch(ordinary.id,{request_id:'ordinary'});const done=await f.settle(ordinary.id);assert.equal(done.state,'awaiting_acceptance');assert.equal(f.calls(),1);
 assert.equal(s.store.requireMission(m.id).state,'dispatching');assert.equal(db.prepare('SELECT state FROM cp_dispatches WHERE mission_id=?').get(m.id).state,'queued');
 s.cancel(m.id,{request_id:'rollback-stop'});assert.equal(s.store.requireMission(m.id).state,'cancelled');assert.equal(db.prepare('SELECT state FROM cp_dispatches WHERE mission_id=?').get(m.id).state,'cancelled');
});
test('future or malformed cognitive versions are denied while V1/V2 remain supported',()=>{
 for(const version of [3,4,'2',null,undefined])assert.equal(compatibility.unsupported({envelope:{cognitive:{envelope:{version}}}}),true);
 for(const version of [1,2])assert.equal(compatibility.unsupported({envelope:{cognitive:{envelope:{version}}}}),false);
 assert.equal(compatibility.unsupported({envelope:{}}),false);
});
