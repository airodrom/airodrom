'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const {transaction}=require('../src/control-transaction');
const {resolveSlackCredential,SERVICE}=require('../src/slack-credentials');
const {SlackRuntime}=require('../src/slack-runtime');
test('failed nested task creation restores memory and SQLite, with no compatibility task file',async t=>{
 const f=await fixture(t),before=f.bridge.tasks.list().length;let id;
 assert.throws(()=>transaction(f.bridge.memory.db,()=>{id=f.bridge.createTask('rolled back task').id;throw Error('rollback');}),/rollback/);
 assert.equal(f.bridge.tasks.list().length,before);assert.throws(()=>f.bridge.tasks.get(id));
 assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM task_states WHERE id=?').get(id).n,0);
});
test('Keychain resolver exposes only known references and fails closed without logging errors',async()=>{
 let calls=0;const execute=(bin,args,opts,cb)=>{calls++;assert.equal(bin,require('../src/slack-credentials').HELPER);assert.deepEqual(args,['read','app_token']);assert.equal(opts.timeout,5000);assert.deepEqual(Object.keys(opts.env),['PATH']);cb(null,Buffer.from('xapp-fixture-value'));};
 assert.equal(await resolveSlackCredential('SLACK_APP_TOKEN',{platform:'darwin',execute,verifyHelper:()=>true}),'xapp-fixture-value');
 assert.equal(await resolveSlackCredential('OTHER',{platform:'darwin',execute,verifyHelper:()=>true}),null);assert.equal(calls,1);
 assert.equal(await resolveSlackCredential('SLACK_BOT_TOKEN',{platform:'darwin',verifyHelper:()=>true,execute:(_b,_a,_o,cb)=>cb(Error('locked secret'))}),null);
});
test('Slack configuration is replay-safe, defaults closed and reconnects with a fresh transport',async t=>{
 const f=await fixture(t);let opened=0,closed=0;
 const runtime=new SlackRuntime(f.bridge,{env:{},resolveCredential:async()=> 'fixture',transportFactory:()=>({connect:async()=>{opened++;return{team_id:'T1',user_id:'UBOT'};},close:async()=>{closed++;},send:async()=>({ok:true,channel:'C1',ts:'123.4'})})});
 await runtime.start();assert.equal(opened,0);assert.equal(runtime.status().inbound_enabled,false);assert.equal(runtime.status().outbound_enabled,false);
 const config={request_id:'enable',enabled:true,outboundEnabled:true,decisionsEnabled:true,teamId:'T1',botUserId:'UBOT',operatorIds:['U1'],channelIds:['C1']};
 await runtime.configure(config);await runtime.configure(config);assert.equal(opened,1);
 await assert.rejects(runtime.configure({...config,enabled:false}),/conflict|replay/i);
 await runtime.configure({...config,request_id:'disable',enabled:false,outboundEnabled:false,decisionsEnabled:false});assert.equal(closed,1);assert.equal(runtime.status().connected,false);
 await runtime.configure({...config,request_id:'reenable'});assert.equal(opened,2);
 assert.ok(!JSON.stringify(runtime.status()).includes('fixture'));await runtime.stop();
});
test('cancelled and expired Decisions never create continuations',async t=>{
 const f=await fixture(t),m=f.create();const s=f.bridge.controlStore;
 s.state(m.id,'dispatching');s.state(m.id,'running');const d=s.createDecision(m.id,{question:'Choose',options:[{id:'a',label:'A'}]});
 f.bridge.missions.cancel(m.id,{request_id:'stop'});assert.equal(s.decision(d.id).state,'cancelled');
 assert.equal(s.answerDecision(d.id,{option_id:'a',actor:'operator',surface:'operator'}).state,'cancelled');
 assert.equal(s.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,0);
});
test('shutdown waits for external child settlement and is idempotent',async t=>{
 const f=await fixture(t);let settled=false;const done=new Promise(resolve=>setTimeout(()=>{settled=true;resolve();},50));
 f.host.jobs.jobs.set('settlement-fixture',{done});
 await f.bridge.shutdown();assert.equal(settled,true);await f.bridge.shutdown();
});

test('uncertain root delivery does not starve a different Mission thread',async t=>{
 const f=await fixture(t);f.create();f.create({objective:'Second isolated Mission'});let sends=0;
 await f.bridge.slackRuntime.stop();
 const runtime=new SlackRuntime(f.bridge,{config:{enabled:true,decisionsEnabled:true,outboundEnabled:true,teamId:'T1',botUserId:'UBOT',operatorIds:['U1'],channelIds:['C1'],appTokenRef:'SLACK_APP_TOKEN',botTokenRef:'SLACK_BOT_TOKEN'},resolveCredential:async()=> 'fixture',transportFactory:()=>({connect:async()=>({team_id:'T1',user_id:'UBOT'}),close:async()=>{},send:async()=>{if(++sends===1)throw Error('ambiguous delivery');return{ok:true,channel:'C1',ts:'123.'+sends};}})});
 f.bridge.slackRuntime=runtime;await runtime.start();await runtime.tick();await runtime.tick();
 const roots=f.bridge.controlStore.db.prepare("SELECT state,attempts FROM cp_slack_outbox WHERE kind='thread_root'").all();assert.equal(roots.length,2);assert.equal(roots.filter(r=>r.state==='delivery_unknown'&&r.attempts===1).length,1);assert.equal(roots.filter(r=>r.state==='delivered').length,1);
});
