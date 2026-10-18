'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const visibility=require('../src/mission-visibility'),display=require('../src/product-observability'),ControlServer=require('../src/control-server');
const url=(filter,query='')=>new URL('http://local/api/product/missions?'+new URLSearchParams({filter,query,limit:'50'}));
const confirm=p=>({confirmed:true,request_id:randomUUID(),preview_id:p.preview_id,digest:p.digest});
function delivered(b) { b.controlStore.db.prepare("UPDATE cp_effect_outbox SET status='sent' WHERE status='pending'").run(); }
function synthetic(f,state,{settled=false,age=visibility.AUTO_ARCHIVE_AGE_MS+10000}={}) {
  const m=f.create({objective:state+' '+randomUUID()}),db=f.bridge.controlStore.db,at=Date.now()-age;
  db.prepare('UPDATE cp_missions SET state=?,updated_at=? WHERE id=?').run(state,at,m.id);
  if(settled)db.prepare("INSERT INTO cp_mission_settlements VALUES(?,NULL,'settled','Synthetic fixture',?)").run(m.id,at);
  delivered(f.bridge); return m;
}
function manifest(repo,changes=['fixture.txt']){return{mission:{id:'program-v1',version:1,title:'Bounded fixture',repository:{root:repo,branch:require('node:child_process').execFileSync('/usr/bin/git',['-C',repo,'branch','--show-current'],{encoding:'utf8'}).trim()},authority:{level:'Development'},duration:{expires_after:'1h'},scope:{repositories:[repo],include:changes,exclude:[]},permissions:{filesystem:{read:true,write:true,delete:false},repository:{branch:false,commit:false,push:false,merge:false},runtime:{test:true,lint:true,typecheck:true,restart_local:false},network:{localhost:true,internet:false},providers:{local_reasoning:false,approved_external:false},memory:{read:true,search:true,write:false,delete:false}},evidence:{required:['tests','diff_check'],optional:[]},settlement:{review_required:true,merge_allowed:false,deploy_allowed:false},budget:{max_files_changed:10,max_commits:0,max_runtime_hours:1,max_external_reasoning_calls:0,max_memory_injections:0}}};}
function canonical(db) {
  const names=['cp_missions','cp_grants','cp_runs','cp_dispatches','cp_leases','cp_verifications','cp_acceptances','cp_mission_reviews','cp_mission_settlements','cp_mission_budget_usage','cp_subscription_invocations','cp_mission_approvals','cp_mission_programs','cp_mission_program_nodes','cp_autonomous_claims','cp_decisions','cp_continuations','cp_artifacts','cp_global_autopilot'];
  return Object.fromEntries(names.map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
}

test('Active contains unfinished work; History searches archived records and keeps exact pagination counts',async t=>{
  const f=await fixture(t),b=f.bridge;
  const active=['draft','ready','dispatching','running','verifying','paused','blocked','needs_rework','waiting_for_operator','awaiting_acceptance'].map(s=>synthetic(f,s));
  const done=synthetic(f,'completed',{settled:true}),cancelled=synthetic(f,'cancelled');
  const archived=visibility.organizeHistory(b,confirm(visibility.previewOrganize(b)));
  assert.deepEqual(new Set(archived.archived),new Set([done.id,cancelled.id]));
  assert.deepEqual(new Set(display.missionHistory(b,url('Active')).missions.map(m=>m.id)),new Set(active.map(m=>m.id)));
  assert.equal(display.missionHistory(b,url('History')).total,2);
  const search=display.missionHistory(b,url('History',done.id));
  assert.equal(search.total,1);assert.equal(search.missions[0].archived,true);
  assert.equal(display.missionHistory(b,url('All')).total,12);
  assert.equal(display.missionHistory(b,url('Archived')).total,2);
});

test('cleanup never infers terminality from draft, rework, unread results, or missing settlement',async t=>{
  const f=await fixture(t),b=f.bridge;
  for(const state of ['draft','ready','blocked','needs_rework','paused','awaiting_acceptance','waiting_for_operator','completed'])synthetic(f,state);
  const conv=synthetic(f,'awaiting_acceptance');b.controlStore.db.prepare("UPDATE cp_missions SET envelope=json_set(envelope,'$.kind','conversation') WHERE id=?").run(conv.id);
  assert.equal(visibility.previewOrganize(b).total,0);
  assert.deepEqual(visibility.autoArchive(b).archived,[]);
  assert.equal(display.missionHistory(b,url('Active')).total,8);
});

test('automatic archive waits for terminal age, is bounded, survives restart and honors restore',async t=>{
  const f=await fixture(t),b=f.bridge;
  const old=synthetic(f,'completed',{settled:true}),recent=synthetic(f,'cancelled',{age:0}),held=synthetic(f,'cancelled');
  const run=b.controlStore.startRun({id:randomUUID(),missionId:held.id,taskId:held.task_id,agentId:'host'});
  const first=visibility.autoArchive(b,{limit:1});
  const all=[...first.archived];let after=first.after;
  while(after){const page=visibility.autoArchive(b,{after,limit:1});all.push(...page.archived);after=page.after;}
  assert.deepEqual(all,[old.id]);
  assert.equal(visibility.isArchived(b.controlStore.db,recent.id),false);
  assert.equal(visibility.isArchived(b.controlStore.db,held.id),false);
  assert.ok(run.id);
  visibility.restoreMission(b,{id:old.id,confirmed:true,request_id:randomUUID()});
  await f.reopen();
  assert.equal(visibility.isArchived(f.bridge.controlStore.db,old.id),false);
  assert.equal(visibility.autoArchive(f.bridge,{now:Date.now()+visibility.AUTO_ARCHIVE_AGE_MS+20000}).archived.includes(old.id),false);
});

test('bulk previews count eligible rows accurately and reject changed settlement atomically',async t=>{
  const f=await fixture(t),b=f.bridge;
  const a=synthetic(f,'completed',{settled:true}),c=synthetic(f,'cancelled'),d=synthetic(f,'cancelled');
  const small=visibility.previewOrganize(b,{limit:2});assert.equal(small.total,3);assert.equal(small.selected,2);assert.equal(small.truncated,true);
  const exact=visibility.previewOrganize(b,{limit:3});assert.equal(exact.truncated,false);
  b.controlStore.db.prepare("UPDATE cp_mission_settlements SET state='needs_rework' WHERE mission_id=?").run(a.id);
  assert.throws(()=>visibility.organizeHistory(b,confirm(exact)),/Stale/);
  for(const id of [a.id,c.id,d.id])assert.equal(visibility.isArchived(b.controlStore.db,id),false);
  const fresh=visibility.previewOrganize(b);assert.equal(fresh.total,2);
  assert.equal(visibility.organizeHistory(b,confirm(fresh)).archived.length,2);
  assert.throws(()=>visibility.organizeHistory(b,confirm(fresh)),/consumed/);
});

test('archive refuses unresolved processes, claims, decisions, leases, accounting and delivery',async t=>{
  const f=await fixture(t),b=f.bridge,db=b.controlStore.db;
  const m=synthetic(f,'cancelled');
  const denied=reason=>{assert.ok(visibility.archiveBlockers(b,b.missions.require(m.id)).includes(reason),reason);assert.equal(visibility.previewOrganize(b).total,0);};
  const r=b.controlStore.startRun({id:randomUUID(),missionId:m.id,taskId:m.task_id,agentId:'host'});
  db.prepare("UPDATE cp_runs SET state='completed',process_state='exited',termination_verified=0 WHERE id=?").run(r.id);denied('unverified_termination');
  db.prepare('UPDATE cp_runs SET termination_verified=1 WHERE id=?').run(r.id);
  db.prepare("INSERT INTO cp_leases VALUES(?,?,?,?,'write','quarantined',0,0,'{}')").run(randomUUID(),'/synthetic/unrelated-workspace',r.id,m.id);denied('active_or_quarantined_lease');
  db.prepare("UPDATE cp_leases SET state='released' WHERE mission_id=?").run(m.id);
  db.prepare("UPDATE cp_effect_outbox SET status='delivery_unknown' WHERE json_extract(correlation,'$.mission_id')=?").run(m.id);denied('unknown_external_delivery');
  db.prepare("UPDATE cp_effect_outbox SET status='sent'").run();
  db.prepare("INSERT INTO cp_subscription_invocations VALUES(?,?,?,'fixture',0,1,'reserved',NULL,NULL)").run(randomUUID(),randomUUID(),m.id);denied('unsettled_accounting');
  db.prepare("UPDATE cp_subscription_invocations SET state='settled'").run();
  db.prepare("INSERT INTO cp_autonomous_claims VALUES(?,?,?,?,'claimed',0)").run(randomUUID(),'work',m.id,randomUUID());denied('active_recovery');
  db.prepare("UPDATE cp_autonomous_claims SET state='abandoned'").run();
  db.prepare("INSERT INTO cp_decisions(id,mission_id,task_id,agent_id,question,options,free_text,state,nonce,created_at) VALUES(?,?,?,'host','Fixture','[]',0,'waiting_for_operator',?,0)").run(randomUUID(),m.id,m.task_id,randomUUID());denied('unresolved_owner_decision');
  db.prepare("UPDATE cp_decisions SET state='cancelled'").run();
  assert.equal(visibility.previewOrganize(b).total,1);
});

test('restored safety obligations override prior archive visibility without changing the record',async t=>{
  const f=await fixture(t),b=f.bridge,m=synthetic(f,'cancelled');
  visibility.organizeHistory(b,confirm(visibility.previewOrganize(b)));
  b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance' WHERE id=?").run(m.id);
  assert.equal(display.missionHistory(b,url('Active')).missions[0].id,m.id);
  assert.equal(display.missionHistory(b,url('Archived')).total,0);
  assert.equal(display.missionView(b,b.missions.require(m.id)).archived,false);
  assert.equal(visibility.isArchived(b.controlStore.db,m.id),true,'projection does not rewrite archived metadata');
});

test('verified Mission lifecycle and all canonical evidence survive archive and restore byte-for-byte',async t=>{
  const f=await fixture(t),b=f.bridge,m=f.create({task_type:'local_files',manifest:manifest(f.repo),dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'deterministic_files',native_actions:[{name:'file_write',path:'fixture.txt',content:'beta\n'}]}});
  b.missions.dispatch(m.id,{request_id:'cleanup-lifecycle'});
  const ready=await f.settle(m.id);
  b.missions.accept(m.id,{request_id:'cleanup-accept',verification_id:ready.verifications[0].id,decision:'accept',rationale:'Host fixture passed'});
  delivered(b);
  const before=canonical(b.controlStore.db),ledger=b.ledger.list({missionId:m.id,limit:200}).events;
  assert.equal(visibility.organizeHistory(b,confirm(visibility.previewOrganize(b))).archived.includes(m.id),true);
  visibility.restoreMission(b,{id:m.id,confirmed:true,request_id:randomUUID()});
  assert.deepEqual(canonical(b.controlStore.db),before);
  const after=b.ledger.list({missionId:m.id,limit:200}).events;
  for(const event of ledger)assert.deepEqual(after.find(e=>e.event_id===event.event_id),event);
  assert.equal(b.missions.require(m.id).state,'completed');
});

test('API enforces authentication, exact preview confirmation, validation and history lookup',async t=>{
  const f=await fixture(t),b=f.bridge,m=synthetic(f,'cancelled',{age:0}),server=new ControlServer(b,{port:0});
  await server.start();t.after(()=>server.close());
  const post=async(route,body,auth=true)=>fetch(server.origin+'/api/product/'+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:server.origin,...(auth?{Authorization:'Bearer '+server.token}:{})},body:JSON.stringify(body)});
  assert.equal((await post('organize-missions-preview',{},false)).status,401);
  assert.equal((await post('organize-missions-preview',{older_than_ms:-1})).status,400);
  assert.equal((await post('archive-missions',{ids:[m.id,randomUUID()],confirmed:true,request_id:randomUUID()})).status,400);
  const p=await (await post('organize-missions-preview',{limit:1})).json();
  assert.equal(p.total,1);assert.equal(p.truncated,false);
  assert.equal((await post('organize-missions',{...confirm(p),digest:'0'.repeat(64)})).status,400);
  assert.equal((await post('organize-missions',confirm(p))).status,200);
  const history=await (await fetch(server.origin+url('History',m.id).pathname+url('History',m.id).search,{headers:{Authorization:'Bearer '+server.token}})).json();
  assert.equal(history.total,1);assert.equal(history.missions[0].id,m.id);
});

test('expired previews and audit failures roll back visibility; host maintenance is throttled',async t=>{
  const f=await fixture(t),b=f.bridge,m=synthetic(f,'cancelled'),db=b.controlStore.db;
  const expired=visibility.previewOrganize(b);
  db.prepare('UPDATE cp_mission_archive_previews SET expires_at=0 WHERE preview_id=?').run(expired.preview_id);
  assert.throws(()=>visibility.organizeHistory(b,confirm(expired)),/expired/);
  const preview=visibility.previewOrganize(b);
  const record=b.controlStore.event.bind(b.controlStore);
  const failedAudit=t.mock.method(b.controlStore,'event',(type,...args)=>{if(type==='product.mission.visibility_archived')throw Error('Synthetic audit failure');return record(type,...args);});
  assert.throws(()=>visibility.organizeHistory(b,confirm(preview)),/audit failure/);
  assert.equal(visibility.isArchived(db,m.id),false);
  assert.equal(db.prepare('SELECT used_at FROM cp_mission_archive_previews WHERE preview_id=?').get(preview.preview_id).used_at,null);
  failedAudit.mock.restore();
  b.supervisor.nextArchiveAt=0;
  await b.supervisor.tick();
  assert.equal(visibility.isArchived(db,m.id),true);
  const second=synthetic(f,'cancelled');
  await b.supervisor.tick();assert.equal(visibility.isArchived(db,second.id),false);
  await b.supervisor.tick(Date.now()+visibility.AUTO_ARCHIVE_INTERVAL_MS+1);
  assert.equal(visibility.isArchived(db,second.id),true);
});

test('Work list filters before paging, searches archived results, and renders honest empty history',async t=>{
  const f=await fixture(t),b=f.bridge,done=synthetic(f,'cancelled'),draft=synthetic(f,'draft'),conv=synthetic(f,'awaiting_acceptance');
  b.controlStore.db.prepare("UPDATE cp_missions SET envelope=json_set(envelope,'$.kind','conversation') WHERE id=?").run(conv.id);
  visibility.organizeHistory(b,confirm(visibility.previewOrganize(b)));
  const list=require('../src/assistant-missions').list;
  assert.deepEqual(list({bridge:b},{filter:'Active'}).items.map(m=>m.id),[draft.id]);
  const history=list({bridge:b},{filter:'History',query:done.id});
  assert.equal(history.total,1);assert.equal(history.items[0].id,done.id);
  assert.equal(list({bridge:b},{filter:'All'}).total,2);
  assert.equal(list({bridge:b},{filter:'All',offset:50}).items.length,0);
  assert.throws(()=>list({bridge:b},{filter:'All',offset:'50'}),/Invalid/);
  assert.throws(()=>list({bridge:b},{filter:false}),/Invalid/);
  const receipt=require('../src/interactive-cli').missionReceipt({kind:'missions',filter:'History',total:0,items:[]});
  assert.match(receipt,/History.*0 matching/);assert.match(receipt,/No matching Missions/);
});
