'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/mission-fixture.cjs'),display=require('../src/product-observability'),ControlServer=require('../src/control-server');
const visibility=require('../src/mission-visibility');
const url=q=>new URL('http://localhost/api/product/missions?'+q);
test('Mission activity searches all retained IDs/titles, paginates recent first and distinguishes canonical filters',async t=>{
 const f=await fixture(t,{opencode:require('./fixtures/opencode-fixture.cjs').runtime(t).options}),b=f.bridge,created=[];
 for(let i=0;i<31;i++){const m=f.create({objective:'Activity fixture '+i});created.push(m.id);b.controlStore.db.prepare('UPDATE cp_missions SET created_at=? WHERE id=?').run(1000+i,m.id);}
 const state=(n,s)=>b.controlStore.db.prepare('UPDATE cp_missions SET state=? WHERE id=?').run(s,created[n]);state(0,'running');state(1,'verifying');state(2,'awaiting_acceptance');state(3,'waiting_for_operator');state(4,'blocked');state(5,'needs_rework');state(6,'completed');
 const page=display.missionHistory(b,url(''));assert.equal(page.total,31);assert.equal(page.limit,15);assert.equal(page.missions.length,15);assert.equal(page.missions[0].id,created[30]);assert.equal(page.has_more,true);
 const older=display.missionHistory(b,url('offset=15'));assert.equal(older.missions.length,15);assert.equal(older.missions[0].id,created[15]);
 const last=display.missionHistory(b,url('offset=30'));assert.equal(last.missions.length,1);assert.equal(last.missions.at(-1).id,created[0]);
 assert.equal(display.missionHistory(b,url('query='+created[0].slice(0,12))).missions[0].id,created[0]);
 assert.equal(display.missionHistory(b,url('query=Activity%20fixture%200')).total,1);
 for(const [filter,n] of [['Active',2],['Awaiting Review',2],['Failed',2],['Completed',1],['Settled',0],['Needs Attention',2]])assert.equal(display.missionHistory(b,url('filter='+encodeURIComponent(filter))).total,n,filter);
 assert.equal(display.missionHistory(b,url('query=not-found')).total,0);
 assert.throws(()=>display.missionHistory(b,url('filter=invalid')));assert.throws(()=>display.missionHistory(b,url('offset=-1')));assert.throws(()=>display.missionHistory(b,url('limit=7')));
 const native=await display.nativeStatus(b);assert.equal(native.active_missions,2);assert.equal(native.review_missions,2);assert.equal(native.failed_missions,2);
 assert.equal(native.menu_tone,'working');assert.equal(native.connection_label,'CONNECTED');
 assert.equal(native.mission?.id,created[1],'featured Mission is newest live execution only');
 assert.doesNotMatch(JSON.stringify(native),/Activity fixture/);
 state(0,'awaiting_acceptance');state(1,'awaiting_acceptance');
 const reviewOnly=await display.nativeStatus(b);assert.equal(reviewOnly.active_missions,0);assert.equal(reviewOnly.review_missions,4);
 assert.equal(reviewOnly.menu_tone,'healthy');assert.equal(reviewOnly.connection_label,'CONNECTED');
 assert.equal((await display.overview(b)).mission_counts['Awaiting Review'],4);
 state(0,'running');state(1,'verifying');
 const overview=await display.overview(b);assert.equal(overview.mission_counts.Active,2);assert.equal(overview.mission_counts['Awaiting Review'],2);assert.equal(overview.counts.review,2);
 const requireMission=b.missions.require.bind(b.missions);b.missions.require=(id,owner)=>{const m=requireMission(id,owner);return id===created[0]?{...m,state:'paused'}:m;};assert.equal(display.missionCounts(b).Active,1,'canonical read overrides stale storage state');assert.equal(display.missionHistory(b,url('filter=Active')).total,1);assert.equal((await display.overview(b)).counts.active,1);
});
test('history remains operator authenticated; titles are bounded/redacted and worker claims never create verification or acceptance',async t=>{
 const f=await fixture(t),b=f.bridge,m=f.create({objective:'Inspect fixture'}),server=new ControlServer(b,{port:0});await server.start();t.after(()=>server.close());
 const title=display.operatorTitle(b,{...b.missions.require(m.id),envelope:{...b.missions.require(m.id).envelope,objective:'Inspect Bearer private-credential-canary'}});assert.doesNotMatch(title,/private-credential-canary/);assert.match(title,/redacted/);
 const route=server.origin+'/api/product/missions';assert.equal((await fetch(route)).status,401);
 const response=await fetch(route,{headers:{Authorization:'Bearer '+server.token}});assert.equal(response.status,200);const history=await response.json();assert.doesNotMatch(JSON.stringify(history),/private-credential-canary/);assert.equal(history.missions[0].label,'Inspect fixture');
 const v=history.missions.find(x=>x.id===m.id);assert.equal(v.verification.current,false);assert.equal(v.actions.accept,false);assert.equal(v.acceptance.status,'pending');assert.equal(v.settlement.status,'not_observed');
 assert.equal((await fetch(route,{headers:{Authorization:'Bearer wrong'}})).status,401);
});
test('notification cursor baselines history, advances through irrelevant events and returns only canonical typed transitions',async t=>{
 const f=await fixture(t),b=f.bridge,m=f.create();const initial=display.notificationEvents(b,null);assert.deepEqual(initial.events,[]);
 for(const eventType of ['agent.completed','mission.awaiting_acceptance','mission.needs_rework','mission.completed','approval.requested'])b.ledger.record({eventType,missionId:m.id,agent:'bridge',direction:'internal',metadata:{prompt:'PRIVATE_CANARY'}});
 const batch=display.notificationEvents(b,initial.cursor);assert.deepEqual(batch.events.map(e=>e.kind),['review','failed','completed','review']);assert.doesNotMatch(JSON.stringify(batch),/PRIVATE_CANARY|prompt/);assert.deepEqual(display.notificationEvents(b,batch.cursor).events,[]);assert.equal(display.notificationEvents(b,batch.cursor+100).reset,true);assert.throws(()=>display.notificationEvents(b,-1));
});
test('pagination limit variants stay bounded with stable newest-first ordering across 100 Missions',async t=>{
 const f=await fixture(t),b=f.bridge,ids=[];
 for(let i=0;i<100;i++){const m=f.create({objective:'Page fixture '+i});ids.push(m.id);b.controlStore.db.prepare('UPDATE cp_missions SET created_at=?,state=? WHERE id=?').run(10_000+i,i%10===0?'completed':'cancelled',m.id);}
 const first=display.missionHistory(b,url('filter=History&limit=15&offset=0'));
 assert.equal(first.limit,15);assert.equal(first.missions.length,15);assert.equal(first.total,100);assert.equal(first.page,1);assert.equal(first.pages,7);
 assert.equal(first.missions[0].id,ids[99]);assert.equal(first.missions.at(-1).id,ids[85]);
 const second=display.missionHistory(b,url('filter=History&limit=15&offset=15'));
 assert.equal(second.missions[0].id,ids[84]);assert.equal(second.page,2);
 const seen=new Set([...first.missions,...second.missions].map(m=>m.id));assert.equal(seen.size,30);
 const tiny=display.missionHistory(b,url('filter=History&limit=10&offset=90'));assert.equal(tiny.missions.length,10);assert.equal(tiny.has_more,false);
 assert.throws(()=>display.missionHistory(b,url('limit=100')));
});
test('archive and restore are presentation-only and refuse active or review Missions',async t=>{
 const f=await fixture(t),b=f.bridge;
 const done=f.create({objective:'Archive eligible fixture'});b.controlStore.db.prepare("UPDATE cp_missions SET state='completed' WHERE id=?").run(done.id);
 const live=f.create({objective:'Keep live'});b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(live.id);
 const review=f.create({objective:'Keep review'});b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance' WHERE id=?").run(review.id);
 const preview=visibility.previewArchive(b,{});assert.ok(preview.items.some(i=>i.id===done.id));assert.equal(preview.items.some(i=>i.id===live.id),false);assert.equal(preview.items.some(i=>i.id===review.id),false);
 assert.throws(()=>visibility.archiveMissions(b,{ids:[done.id],confirmed:false,request_id:'x'}));
 const archived=visibility.archiveMissions(b,{ids:[done.id,live.id,review.id],confirmed:true,request_id:require('node:crypto').randomUUID()});
 assert.deepEqual(archived.archived,[done.id]);assert.equal(archived.refused.length,2);
 assert.equal(b.missions.require(done.id).state,'completed');
 assert.equal(display.missionHistory(b,url('filter=All')).missions.some(m=>m.id===done.id),false);
 assert.equal(display.missionHistory(b,url('filter=Archived')).missions[0].id,done.id);
 visibility.restoreMission(b,{id:done.id,confirmed:true,request_id:require('node:crypto').randomUUID()});
 assert.equal(display.missionHistory(b,url('filter=All')).missions.some(m=>m.id===done.id),true);
});
test('draft Missions render as registered without inventing worker failure',async t=>{
 const f=await fixture(t),b=f.bridge,server={bridge:b};
 const receipt=await require('../src/assistant-missions').newMission(server,{objective:'Draft only fixture',workspace:f.repo,request_id:require('node:crypto').randomUUID(),explicit:true});
 assert.equal(receipt.state,'draft');
 const view=display.missionView(b,b.missions.require(receipt.mission_id,'operator'));
 assert.equal(view.state,'draft');
 assert.match(view.display.label,/Registered/);
 assert.equal(view.worker_assigned,false);
 assert.equal(view.runtime,null);
 assert.match(view.next_action,/template|cancel/i);
 assert.doesNotMatch(JSON.stringify(view),/"NaN"|Active work/);
});

test('outcome-first never reports verified success without current verification and suppresses routine autonomous next actions',async t=>{
 const f=await fixture(t),b=f.bridge,m=f.create({objective:'Outcome fixture'});
 b.controlStore.db.prepare("UPDATE cp_missions SET state='completed' WHERE id=?").run(m.id);
 const view=display.missionView(b,b.missions.require(m.id,'operator'));
 assert.equal(view.outcome.success,false);
 assert.match(view.outcome.headline,/verification incomplete|Verified|Completed/i);
 assert.equal(view.next_action,null);
 const draft=await require('../src/assistant-missions').newMission({bridge:b},{objective:'Draft outcome',workspace:f.repo,request_id:require('node:crypto').randomUUID(),explicit:true});
 const d=display.missionView(b,b.missions.require(draft.mission_id,'operator'));
 assert.match(d.outcome.headline,/Registered/);
 assert.equal(d.outcome.success,false);
});
test('organize history archives only settled or cancelled presentation rows and preserves review Missions',async t=>{
 const f=await fixture(t),b=f.bridge,visibility=require('../src/mission-visibility');
 const settled=f.create({objective:'Settled organize'});b.controlStore.db.prepare("UPDATE cp_missions SET state='completed' WHERE id=?").run(settled.id);
 b.controlStore.db.prepare("INSERT INTO cp_mission_settlements(mission_id,review_id,state,recommendation,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(mission_id) DO UPDATE SET state=excluded.state,recommendation=excluded.recommendation,updated_at=excluded.updated_at").run(settled.id,null,'settled','Organized fixture settlement',Date.now());
 const review=f.create({objective:'Review keep'});b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance' WHERE id=?").run(review.id);
 const preview=visibility.previewOrganize(b,{});
 assert.ok(preview.preview_id);assert.ok(preview.digest);
 assert.ok(preview.items.some(i=>i.id===settled.id));
 assert.equal(preview.items.some(i=>i.id===review.id),false);
 assert.throws(()=>visibility.organizeHistory(b,{confirmed:true,request_id:require('node:crypto').randomUUID()}),/preview identity/i);
 const result=visibility.organizeHistory(b,{confirmed:true,request_id:require('node:crypto').randomUUID(),preview_id:preview.preview_id,digest:preview.digest});
 assert.ok(result.archived.includes(settled.id));
 assert.equal(b.missions.require(review.id).state,'awaiting_acceptance');
 assert.equal(display.missionHistory(b,url('filter=Archived')).missions.some(m=>m.id===settled.id),true);
});

test('archive confirmation is bound to the exact preview set and rejects stale previews',async t=>{
 const f=await fixture(t),b=f.bridge,visibility=require('../src/mission-visibility'),{randomUUID}=require('node:crypto');
 const a=f.create({objective:'Preview A'});const c=f.create({objective:'Preview C'});
 b.controlStore.db.prepare("UPDATE cp_missions SET state='completed' WHERE id IN (?,?)").run(a.id,c.id);
 const preview=visibility.previewArchive(b,{});
 assert.ok(preview.items.some(i=>i.id===a.id));
 // Mutate eligibility after preview: put A into awaiting acceptance.
 b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance' WHERE id=?").run(a.id);
 assert.throws(()=>visibility.archiveMissions(b,{confirmed:true,request_id:randomUUID(),preview_id:preview.preview_id,digest:preview.digest}),/Stale archive preview rejected/);
 assert.equal(visibility.isArchived(b.controlStore.db,a.id),false);
 assert.equal(visibility.isArchived(b.controlStore.db,c.id),false);
 // Fresh preview archives only still-eligible C.
 const fresh=visibility.previewArchive(b,{});
 assert.equal(fresh.items.some(i=>i.id===a.id),false);
 assert.ok(fresh.items.some(i=>i.id===c.id));
 const archived=visibility.archiveMissions(b,{confirmed:true,request_id:randomUUID(),preview_id:fresh.preview_id,digest:fresh.digest});
 assert.deepEqual(archived.archived,[c.id]);
 // Consumed preview cannot be reused.
 assert.throws(()=>visibility.archiveMissions(b,{confirmed:true,request_id:randomUUID(),preview_id:fresh.preview_id,digest:fresh.digest}),/already consumed|Stale|not found/i);
});

test('archive refuses uncertain leases, unknown process and pending Acceptance; recovery labels stay truthful',async t=>{
 const f=await fixture(t),b=f.bridge,visibility=require('../src/mission-visibility'),{randomUUID}=require('node:crypto');
 const live=f.create({objective:'Running archive deny'});b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(live.id);
 const review=f.create({objective:'Acceptance archive deny'});b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance' WHERE id=?").run(review.id);
 const unknown=f.create({objective:'Unknown process deny'});b.controlStore.db.prepare("UPDATE cp_missions SET state='completed' WHERE id=?").run(unknown.id);
 const unk=b.missions.require(unknown.id);
 b.controlStore.db.prepare("INSERT INTO cp_runs(id,mission_id,task_id,agent_id,generation,state,process_state,liveness_state,termination_verified,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
  .run(randomUUID(),unknown.id,unk.task_id,'host',1,'running','unknown','unknown',0,Date.now(),Date.now());
 assert.equal(visibility.archiveEligible(b.missions.require(live.id),b),false);
 assert.equal(visibility.archiveEligible(b.missions.require(review.id),b),false);
 assert.equal(visibility.archiveEligible(b.missions.require(unknown.id),b),false);
 assert.ok(visibility.archiveBlockers(b,b.missions.require(unknown.id)).includes('unknown_process_state')||visibility.archiveBlockers(b,b.missions.require(unknown.id)).includes('unverified_termination'));
 const blocked=f.create({objective:'Blocked recovery truth'});b.controlStore.db.prepare("UPDATE cp_missions SET state='blocked' WHERE id=?").run(blocked.id);
 const view=display.missionView(b,b.missions.require(blocked.id));
 assert.notEqual(view.outcome.headline,'Autonomous recovery');
 assert.doesNotMatch(view.outcome.detail||'',/will repair and retry/);
});
