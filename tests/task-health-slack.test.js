'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {EventLedger}=require('../src/event-ledger'),{ControlPlaneStore}=require('../src/control-plane-store'),{SlackRuntime}=require('../src/slack-runtime');
const {createHash}=require('node:crypto');
function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE project_missions(mission_id TEXT,status TEXT,updated_at INTEGER)');const store=new ControlPlaneStore({db,ledger:new EventLedger(db)});t.after(()=>db.close());
 const task={id:'task1',activeRunId:'run1',description:'secret task payload'},health={active:true,status:'Healthy',score:100,processState:'alive',leaseState:'held',elapsedMs:1000,budgetMs:300000};let sent=[];
 const bridge={controlStore:store,ledger:store.ledger,tasks:{list:()=>[task]},taskHealth:()=>health,missions:{schedule(){},cancel(){}}};
 const config={enabled:true,outboundEnabled:true,decisionsEnabled:false,teamId:'T1',botUserId:'UBOT',operatorIds:['U1'],channelIds:['C1'],appTokenRef:'fixture-app',botTokenRef:'fixture-bot'};
 const runtime=new SlackRuntime(bridge,{config,resolveCredential:async()=> 'fixture',transportFactory:()=>({connect:async()=>({team_id:'T1',user_id:'UBOT'}),close:async()=>{},send:async body=>{sent.push(body);return{ok:true,channel:'C1',ts:`123.${sent.length}`};}})});
 return{db,store,bridge,runtime,health,task,sent};
}
test('health alerts and healthy-again updates deliver once; routine readings stay quiet',async t=>{
 const f=fixture(t);await f.runtime.start();await f.runtime.tick();assert.equal(f.sent.length,0);
 f.health.status='Possibly Stalled';f.health.score=60;await f.runtime.tick();await f.runtime.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/<@U1> Task Health: Possibly Stalled/);assert.match(f.sent[0].text,/Score: 60%/);assert.doesNotMatch(f.sent[0].text,/secret task payload/);
 f.health.status='Stalled';await f.runtime.tick();assert.equal(f.sent.length,2);
 f.health.status='Healthy';await f.runtime.tick();assert.equal(f.sent.length,3);
 f.runtime.taskHealthNotifications=new(require('../src/task-health-slack').TaskHealthSlack)(f.runtime);await f.runtime.tick();assert.equal(f.sent.length,3);
});
test('verified inactive recovery is notified only after an alert for the same run',async t=>{
 const f=fixture(t);await f.runtime.start();f.health.active=false;f.health.status='Recovered';await f.runtime.tick();assert.equal(f.sent.length,0);
 f.health.active=true;f.health.status='Stalled';await f.runtime.tick();f.health.active=false;f.health.status='Recovered';await f.runtime.tick();await f.runtime.tick();assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/Recovered/);
});
test('new run resets health baseline; disabled outbound and connectors queue no notifications',async t=>{
 const f=fixture(t);await f.runtime.start();f.health.status='Stalled';f.runtime.gateway.config.outboundEnabled=false;await f.runtime.tick();assert.equal(f.db.prepare('SELECT count(*) n FROM cp_task_health_slack').get().n,0);
 f.runtime.gateway.config.outboundEnabled=true;f.runtime.gateway.config.connectorsEnabled=false;await f.runtime.tick();assert.equal(f.sent.length,0);
 f.runtime.gateway.config.connectorsEnabled=true;await f.runtime.tick();f.task.activeRunId='run2';f.health.status='Healthy';await f.runtime.tick();assert.equal(f.sent.length,1);
});
test('existing Mission thread is used and health notification grants no continuation',async t=>{
 const f=fixture(t);f.store.registerMission({id:'m1',taskId:'task1',owner:'operator',envelope:{objective:'fixture'},ceiling:{}});f.runtime.gateway.bindThread('m1','C1','123.9');await f.runtime.start();f.health.status='Stalled';await f.runtime.tick();assert.equal(f.sent[0].thread_ts,'123.9');assert.equal(f.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,0);
});
test('test notification is idempotent and cannot supply text or a new channel',async t=>{
 const f=fixture(t);await f.runtime.start();const a=f.runtime.healthTest({request_id:'test1'}),b=f.runtime.healthTest({request_id:'test1'});assert.equal(a.outbox_id,b.outbox_id);await f.runtime.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/Task Health notifications are enabled/);
 assert.match(a.outbox_id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 assert.notEqual(a.outbox_id,createHash('sha256').update(JSON.stringify('task-health-test:test1')).digest('hex'));
 assert.equal(f.db.prepare("SELECT id FROM cp_slack_health_outbox WHERE kind='task_health_test'").get().id,a.outbox_id);
 assert.equal(JSON.parse(f.db.prepare("SELECT result FROM cp_requests WHERE request_id='test1'").get().result).outbox_id,a.outbox_id,'stored request result provides replay identity');
 assert.equal(f.db.prepare("SELECT destination_ref,event_key FROM cp_effect_outbox WHERE destination_type='slack_message'").get().destination_ref,a.outbox_id);
 assert.throws(()=>f.runtime.healthTest({request_id:'test2',channel:'C2',text:'injected'}));f.runtime.gateway.config.outboundEnabled=false;assert.throws(()=>f.runtime.healthTest({request_id:'test3'}));
});
test('request-derived legacy health identifiers fail closed and no notification is queued',async t=>{
 const f=fixture(t);await f.runtime.start();const request=createHash('sha256').update('fixture erased health request').digest('hex');
 assert.throws(()=>f.runtime.healthTest({request_id:request}),/legacy|migration/i);
 assert.equal(f.db.prepare('SELECT count(*) n FROM cp_slack_health_outbox').get().n,0);assert.equal(f.sent.length,0);
});
test('health-test allocation rolls back with failed request persistence and retry records one UUID',async t=>{
 const f=fixture(t);await f.runtime.start();
 f.db.exec("CREATE TRIGGER fixture_health_request_failure BEFORE INSERT ON cp_requests BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END");
 assert.throws(()=>f.runtime.healthTest({request_id:'retry-health-test'}),/unavailable/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM cp_slack_health_outbox').get().n,0);
 f.db.exec('DROP TRIGGER fixture_health_request_failure');
 const receipt=f.runtime.healthTest({request_id:'retry-health-test'});assert.equal(f.runtime.healthTest({request_id:'retry-health-test'}).outbox_id,receipt.outbox_id);
 assert.equal(f.db.prepare('SELECT count(*) n FROM cp_slack_health_outbox').get().n,1);
});
test('unknown delivery is not resent on later health polls',async t=>{
 const f=fixture(t);await f.runtime.start();let calls=0;f.runtime.gateway.transport.send=async()=>{calls++;throw Error('network reset');};f.health.status='Stalled';await f.runtime.tick();await f.runtime.tick();assert.equal(calls,1);assert.equal(f.db.prepare("SELECT state FROM cp_slack_health_outbox WHERE kind='task_health'").get().state,'delivery_unknown');
});
