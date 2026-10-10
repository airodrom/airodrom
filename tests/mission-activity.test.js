'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/mission-fixture.cjs'),display=require('../src/product-observability'),ControlServer=require('../src/control-server');
const url=q=>new URL('http://localhost/api/product/missions?'+q);
test('Mission activity searches all retained IDs/titles, paginates recent first and distinguishes canonical filters',async t=>{
 const f=await fixture(t),b=f.bridge,created=[];
 for(let i=0;i<31;i++){const m=f.create({objective:'Activity fixture '+i});created.push(m.id);b.controlStore.db.prepare('UPDATE cp_missions SET created_at=? WHERE id=?').run(1000+i,m.id);}
 const state=(n,s)=>b.controlStore.db.prepare('UPDATE cp_missions SET state=? WHERE id=?').run(s,created[n]);state(0,'running');state(1,'verifying');state(2,'awaiting_acceptance');state(3,'waiting_for_operator');state(4,'blocked');state(5,'needs_rework');state(6,'completed');
 const page=display.missionHistory(b,url(''));assert.equal(page.total,31);assert.equal(page.missions.length,25);assert.equal(page.missions[0].id,created[30]);assert.equal(page.has_more,true);
 const older=display.missionHistory(b,url('offset=25'));assert.equal(older.missions.length,6);assert.equal(older.missions.at(-1).id,created[0]);
 assert.equal(display.missionHistory(b,url('query='+created[0].slice(0,12))).missions[0].id,created[0]);
 assert.equal(display.missionHistory(b,url('query=Activity%20fixture%200')).total,1);
 for(const [filter,n] of [['Active',2],['Awaiting Review',2],['Failed',2],['Completed',1],['Settled',0]])assert.equal(display.missionHistory(b,url('filter='+encodeURIComponent(filter))).total,n,filter);
 assert.equal(display.missionHistory(b,url('query=not-found')).total,0);
 assert.throws(()=>display.missionHistory(b,url('filter=invalid')));assert.throws(()=>display.missionHistory(b,url('offset=-1')));
 const native=await display.nativeStatus(b);assert.equal(native.active_missions,2);assert.equal(native.review_missions,2);assert.equal(native.failed_missions,2);
 // Live execution wins over historical review; review backlog alone does not force gold.
 assert.equal(native.menu_tone,'working');assert.equal(native.connection_label,'CONNECTED');
 assert.equal(native.mission?.id,created[1],'featured Mission is newest live execution only');
 assert.doesNotMatch(JSON.stringify(native),/Activity fixture/);
 // Review-only backlog remains healthy while Control Center still reports review counts.
 state(0,'awaiting_acceptance');state(1,'awaiting_acceptance');
 const reviewOnly=await display.nativeStatus(b);assert.equal(reviewOnly.active_missions,0);assert.equal(reviewOnly.review_missions,4);
 assert.equal(reviewOnly.menu_tone,'healthy');assert.equal(reviewOnly.connection_label,'CONNECTED');
 assert.equal((await display.overview(b)).mission_counts['Awaiting Review'],4);
 // Restore live pair for canonical Active override proof (paused storage must not count as Active).
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
