'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {EventLedger}=require('../src/event-ledger');
const {ControlPlaneStore}=require('../src/control-plane-store');
const {SlackGateway}=require('../src/slack-gateway');
function fixture(t,extra={}) {
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE project_missions(mission_id TEXT,status TEXT,updated_at INTEGER)');const store=new ControlPlaneStore({db,ledger:new EventLedger(db)});t.after(()=>db.close());
 store.registerMission({id:'m1',taskId:'t1',owner:'operator',envelope:{objective:'fixture'},ceiling:{}});
 const decision=store.createDecision('m1',{question:'Choose fixture output',options:[{id:'a',label:'A'}]});let connections=0,sends=0;
 const transport={connect:async()=>{connections++;return{team_id:'T1',user_id:'UBOT'};},close:async()=>{},send:async()=>{sends++;return{ok:true,channel:'C1',ts:'123.3'};}};
 const config={enabled:true,outboundEnabled:true,decisionsEnabled:true,teamId:'T1',botUserId:'UBOT',operatorIds:['U1'],channelIds:['C1'],appTokenRef:'fixture-app',botTokenRef:'fixture-bot'};
 const gateway=new SlackGateway({store,config,resolveCredential:async()=> 'fixture-value',transportFactory:()=>transport,...extra});
 if(gateway.config.enabled)gateway.bindThread('m1','C1','123.1');return{db,store,decision,gateway,transport,connections:()=>connections,sends:()=>sends};
}
test('disabled Slack never resolves credentials or creates a transport',async t=>{let touched=0;const f=fixture(t,{config:{enabled:false},resolveCredential:()=>{touched++;},transportFactory:()=>{touched++;}});await f.gateway.start();assert.equal(f.gateway.state,'disabled');assert.equal(touched,0);});
test('valid answer is durable before ack and duplicate delivery creates one continuation',async t=>{
 const f=fixture(t);await f.gateway.start();let acked=0;
 const incoming={envelope_id:'e1',body:{team_id:'T1',event_id:'ev1',event:{user:'U1',channel:'C1',thread_ts:'123.1',text:'Use the first output'}},ack:async()=>{assert.ok(f.db.prepare('SELECT 1 FROM cp_slack_inbox WHERE id=?').get('ev1'));acked++;}};
 await f.gateway.receive(incoming);await f.gateway.receive(incoming);assert.equal(acked,2);assert.equal(f.store.decision(f.decision.id).state,'answered');assert.equal(f.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,1);
});
test('unauthorized users and forged button nonce cannot answer',async t=>{const f=fixture(t);await f.gateway.start();const event={envelope_id:'e2',body:{team:{id:'T1'},user:{id:'U2'},channel:{id:'C1'},message:{thread_ts:'123.1'},actions:[{action_id:'decision_answer:0',value:JSON.stringify({decision_id:f.decision.id,nonce:f.decision.nonce,option_id:'a'})}]},ack:async()=>{}};await f.gateway.receive(event);event.body.user.id='U1';event.body.actions[0].value=JSON.stringify({decision_id:f.decision.id,nonce:'forged',option_id:'a'});await f.gateway.receive(event);assert.equal(f.store.decision(f.decision.id).state,'waiting_for_operator');});
test('button responses match generated action IDs and nonce',async t=>{const f=fixture(t);await f.gateway.start();const id=f.gateway.enqueueDecision(f.decision.id);const body=JSON.parse(f.db.prepare('SELECT body FROM cp_slack_outbox WHERE id=?').get(id).body);await f.gateway.receive({envelope_id:'button1',body:{team:{id:'T1'},user:{id:'U1'},channel:{id:'C1'},message:{thread_ts:'123.1'},actions:[body.blocks[1].elements[0]]},ack:async()=>{}});assert.equal(f.store.decision(f.decision.id).answer.option_id,'a');});
test('uncertain outbound delivery is never blindly resent; rate limits defer',async t=>{const f=fixture(t);await f.gateway.start();const id=f.gateway.enqueueDecision(f.decision.id);f.transport.send=async()=>{throw Error('network reset');};await f.gateway.flush();assert.equal(f.db.prepare('SELECT state FROM cp_slack_outbox WHERE id=?').get(id).state,'delivery_unknown');await f.gateway.flush();f.store.recover();assert.equal(f.db.prepare('SELECT state FROM cp_slack_outbox WHERE id=?').get(id).state,'delivery_unknown');});
test('identity failures are unavailable; retry backoff is bounded',async t=>{let delay;const f=fixture(t,{schedule:(_cb,ms)=>{delay=ms;return 1;},random:()=>1});f.transport.connect=async()=>{throw Object.assign(Error('auth'),{code:'invalid_auth'});};await f.gateway.start();assert.equal(f.gateway.state,'authentication_failed');assert.equal(delay,undefined);f.gateway.state='connected';f.gateway.attempt=100;await f.gateway.offline();assert.equal(delay,60000);});
test('missing credentials never constructs real transport',async t=>{let touched=0;const f=fixture(t,{resolveCredential:async()=>null,transportFactory:()=>{touched++;}});await f.gateway.start();assert.equal(f.gateway.state,'authentication_failed');assert.equal(touched,0);});
test('rate limit is deferred; sensitive free text never reaches durable inbox',async t=>{const f=fixture(t);await f.gateway.start();const id=f.gateway.enqueueDecision(f.decision.id);f.transport.send=async()=>{throw Object.assign(Error('rate limited'),{code:'slack_webapi_rate_limited_error',retryAfter:30});};await f.gateway.flush();assert.equal(f.db.prepare('SELECT state FROM cp_slack_outbox WHERE id=?').get(id).state,'queued');await f.gateway.receive({envelope_id:'secret',body:{team_id:'T1',event:{user:'U1',channel:'C1',thread_ts:'123.1',text:'token=sk-abcdefghijklmnopqrstuvwxyz1234567890'}},ack:async()=>{}});const records=f.db.prepare('SELECT * FROM cp_slack_inbox').all();assert.ok(!JSON.stringify(records).includes('sk-abcdefghijklmnopqrstuvwxyz1234567890'));});

test('real official Socket Mode transport constructs without connecting',()=>{const {socketTransport}=require('../src/slack-gateway');const transport=socketTransport({appToken:'xapp-fixture',botToken:'xoxb-fixture'});assert.equal(typeof transport.connect,'function');assert.equal(typeof transport.send,'function');assert.equal(typeof transport.close,'function');});

test('disable during credential resolution never constructs a transport',async t=>{
 let release,created=0;const credentials=new Promise(r=>release=r);
 const f=fixture(t,{resolveCredential:()=>credentials,transportFactory:()=>{created++;throw Error('must not construct');}});
 const starting=f.gateway.start();await f.gateway.stop();release('fixture');await starting;assert.equal(created,0);assert.notEqual(f.gateway.state,'connected');
});
test('outbound disable admits no next message while one send settles',async t=>{
 const f=fixture(t);await f.gateway.start();let release,entered;const sending=new Promise(r=>entered=r);
 f.gateway.enqueueDecision(f.decision.id);f.gateway.db.prepare("INSERT INTO cp_slack_outbox(id,mission_id,kind,body,state,attempts,next_at,created_at,remote_ts) VALUES('second','m1','info',?,'queued',0,0,0,NULL)").run(JSON.stringify({channel:'C1',text:'second'}));
 let calls=0;f.transport.send=async()=>{calls++;entered();return new Promise(r=>release=r);};
 const flushing=f.gateway.flush();await sending;f.gateway.config.outboundEnabled=false;release({ok:true,channel:'C1',ts:'456.1'});await flushing;assert.equal(calls,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM cp_slack_outbox WHERE state='queued'").get().n,1);
});
test('expired and cancelled decisions return useful status without new continuation',async t=>{
 const f=fixture(t);await f.gateway.start();f.db.prepare("UPDATE cp_decisions SET expires_at=1 WHERE id=?").run(f.decision.id);f.store.expireDecisions();
 const action={action_id:'decision_answer:0',value:JSON.stringify({decision_id:f.decision.id,nonce:f.decision.nonce,option_id:'a'})};
 await f.gateway.receive({envelope_id:'expired',body:{team:{id:'T1'},user:{id:'U1'},channel:{id:'C1'},message:{thread_ts:'123.1'},actions:[action]},ack:async()=>{}});
 assert.equal(f.store.decision(f.decision.id).state,'expired');assert.equal(f.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,0);assert.match(f.db.prepare("SELECT body FROM cp_slack_outbox WHERE kind='decision_status'").get().body,/expired/);
});

test('superseded Decision stays immutable across Slack replay and its replacement answers once',async t=>{
 const f=fixture(t);await f.gateway.start();const next=f.store.supersedeDecision(f.decision.id,{question:'Revised question',options:[{id:'b',label:'B'}]},'operator');
 const event={envelope_id:'old-button',body:{team:{id:'T1'},user:{id:'U1'},channel:{id:'C1'},message:{thread_ts:'123.1'},actions:[{action_id:'decision_answer:0',value:JSON.stringify({decision_id:f.decision.id,nonce:f.decision.nonce,option_id:'a'})}]},ack:async()=>{}};
 await f.gateway.receive(event);assert.equal(f.store.decision(f.decision.id).state,'superseded');assert.equal(f.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,0);
 f.store.answerDecision(next.replacement.id,{option_id:'b',actor:'operator',surface:'operator'});f.store.answerDecision(next.replacement.id,{option_id:'b',actor:'operator',surface:'operator'});assert.equal(f.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,1);
});
test('Decision notifications mention operator and expected bot identity fails closed',async t=>{
 const f=fixture(t);f.gateway.config.botUserId='UEXPECTED';await f.gateway.start();assert.equal(f.gateway.state,'authentication_failed');assert.equal(f.sends(),0);
 const id=f.gateway.enqueueDecision(f.decision.id),body=JSON.parse(f.db.prepare('SELECT body FROM cp_slack_outbox WHERE id=?').get(id).body);assert.match(body.text,/<@U1>/);assert.ok(body.blocks.some(b=>b.elements?.some(e=>e.type==='mrkdwn'&&e.text.includes('<@U1>'))));
});
test('offline Decision survives reconnect; duplicate notification and answer have one effect',async t=>{
 let reconnect;const f=fixture(t,{schedule:cb=>{reconnect=cb;return 1;}});await f.gateway.start();
 const id=f.gateway.enqueueDecision(f.decision.id);await f.gateway.offline();await f.gateway.flush();assert.equal(f.sends(),0);assert.equal(f.store.decision(f.decision.id).state,'waiting_for_operator');
 await reconnect();assert.equal(f.gateway.state,'connected');assert.equal(f.gateway.enqueueDecision(f.decision.id),id);await f.gateway.flush();await f.gateway.flush();assert.equal(f.sends(),1);
 const event={envelope_id:'reconnect-answer',body:{team_id:'T1',event_id:'reconnect-event',event:{user:'U1',channel:'C1',thread_ts:'123.1',text:'A'}},ack:async()=>{}};
 await f.gateway.receive(event);await f.gateway.receive(event);assert.equal(f.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,1);assert.equal(f.store.decision(f.decision.id).surface,'slack');
});
test('missing or malformed remote receipts remain unresolved without resend',async t=>{
 for(const receipt of [null,{}, {ok:true}, {ok:true,channel:'C1',ts:123}]){
  const f=fixture(t);await f.gateway.start();const id=f.gateway.enqueueDecision(f.decision.id);let calls=0;f.transport.send=async()=>{calls++;return receipt;};
  await f.gateway.flush();await f.gateway.flush();assert.equal(calls,1);assert.equal(f.db.prepare('SELECT state FROM cp_slack_outbox WHERE id=?').get(id).state,'delivery_unknown');
 }
});
test('confirmed external send followed by local receipt rollback cannot resend',async t=>{
 const f=fixture(t);await f.gateway.start();const id=f.gateway.enqueueDecision(f.decision.id),event=f.store.event;let calls=0;
 f.transport.send=async()=>{calls++;return{ok:true,channel:'C1',ts:'987.1'};};f.store.event=function(type,...args){if(type==='slack.message.sent')throw Error('Injected ledger fault');return event.call(this,type,...args);};
 await f.gateway.flush();await f.gateway.flush();assert.equal(calls,1);assert.equal(f.db.prepare('SELECT state FROM cp_slack_outbox WHERE id=?').get(id).state,'delivery_unknown');assert.equal(f.db.prepare('SELECT remote_ts FROM cp_slack_outbox WHERE id=?').get(id).remote_ts,null);
});

for(const [name,patch] of [['wrong workspace',{team_id:'T2'}],['wrong operator',{user:'U2'}],['wrong channel',{channel:'C2'}],['missing workspace',{team_id:undefined}],['missing operator',{user:undefined}],['missing channel',{channel:undefined}],['missing event identity',{event_id:undefined,envelope_id:undefined}]])test(name+' fails closed',async t=>{
 const f=fixture(t);await f.gateway.start();const body={team_id:'T1',event_id:'validated',event:{user:'U1',channel:'C1',thread_ts:'123.1',text:'A'}};
 for(const [k,v] of Object.entries(patch))if(['user','channel'].includes(k))body.event[k]=v;else if(k!=='envelope_id')body[k]=v;
 await f.gateway.receive({envelope_id:Object.hasOwn(patch,'envelope_id')?patch.envelope_id:'envelope',body,ack:async()=>{}});
 assert.equal(f.store.decision(f.decision.id).state,'waiting_for_operator');assert.equal(f.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,0);
});
test('pinned startup and spoofed display names need no metadata scopes',async t=>{
 const f=fixture(t);await f.gateway.start();assert.equal(f.gateway.state,'connected');
 await f.gateway.receive({envelope_id:'names',body:{team_id:'T1',event_id:'names',event:{user:'U2',username:'operator',channel:'C1',thread_ts:'123.1',text:'A'}},ack:async()=>{}});
 assert.equal(f.store.decision(f.decision.id).state,'waiting_for_operator');
 await f.gateway.receive({envelope_id:'real',body:{team_id:'T1',event_id:'real',event:{user:'U1',username:'spoof',channel:'C1',thread_ts:'123.1',text:'A'}},ack:async()=>{}});
 assert.equal(f.store.decision(f.decision.id).state,'answered');
});
test('outbound wrong or missing channel remains delivery_unknown without resend',async t=>{
 for(const channel of ['C2',undefined]){const f=fixture(t);await f.gateway.start();const id=f.gateway.enqueueDecision(f.decision.id);let calls=0;f.transport.send=async()=>{calls++;return{ok:true,channel,ts:'999.1'};};await f.gateway.flush();await f.gateway.flush();assert.equal(calls,1);assert.equal(f.db.prepare('SELECT state FROM cp_slack_outbox WHERE id=?').get(id).state,'delivery_unknown');}
});
test('malformed pinned IDs prevent credential reads',async t=>{
 const f=fixture(t);f.gateway.config.operatorIds=['display-name'];let reads=0;f.gateway.resolveCredential=async()=>{reads++;};await f.gateway.start();assert.equal(f.gateway.state,'unconfigured');assert.equal(reads,0);
});
test('distinct valid Slack receipts for one Decision preserve the first answer and one continuation',async t=>{
 const f=fixture(t);await f.gateway.start();for(const [id,answer] of [['first','first answer'],['second','second answer']])await f.gateway.receive({envelope_id:id,body:{team_id:'T1',event_id:id,event:{user:'U1',channel:'C1',thread_ts:'123.1',text:answer}},ack:async()=>{}});
 assert.equal(f.store.decision(f.decision.id).answer.free_text,'first answer');assert.equal(f.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,1);
});
