'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {EventLedger}=require('../src/event-ledger');
const {ControlPlaneStore}=require('../src/control-plane-store');
const {ServiceLifecycle}=require('../src/service-lifecycle');
function fixture(t){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE project_missions(mission_id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER)');const store=new ControlPlaneStore({db,ledger:new EventLedger(db)}),bridge={controlStore:store,leases:{size:0}};const gate=new ServiceLifecycle(bridge);bridge.lifecycle=gate;store.lifecycle=gate;t.after(()=>db.close());gate.finishRecovery();gate.resume(gate.epoch);return {db,store,bridge,gate};}
test('atomic drain closes canonical run and invocation admissions',t=>{const {gate,store}=fixture(t);assert.equal(gate.state(),'open');gate.drain();assert.throws(()=>store.startRun({id:'r',taskId:'t'}),/admission/);assert.throws(()=>store.beginInvocation('t','i','h'),/admission/);assert.equal(store.run('r'),null);gate.prepareStop();assert.equal(gate.state(),'stopping');assert.throws(()=>gate.resume(gate.epoch));});
test('in-flight request prevents stop until handler settles; timeout never reopens',t=>{const {gate}=fixture(t);gate.requests++;gate.drain();assert.throws(()=>gate.prepareStop(),/not idle/);assert.throws(()=>gate.resume(gate.epoch),/unresolved/);assert.equal(gate.state(),'draining');gate.requests--;assert.equal(gate.prepareStop().state,'stopping');});
test('uncertain worker remains fail-closed through canonical recovery and fresh epoch',t=>{const {store,bridge,gate}=fixture(t);store.startRun({id:'r',taskId:'t'});gate.drain();assert.throws(()=>gate.prepareStop());const next=new ServiceLifecycle(bridge);store.lifecycle=next;store.recover();next.finishRecovery();assert.equal(next.state(),'booting');assert.throws(()=>next.resume(gate.epoch),/epoch/);assert.throws(()=>next.resume(next.epoch),/unresolved/);assert.equal(store.run('r').process_state,'unknown');});
test('clean planned restart retains closed admission until current-epoch operator resume',t=>{const {bridge,store,gate}=fixture(t);gate.drain();gate.prepareStop();const next=new ServiceLifecycle(bridge);store.lifecycle=next;store.recover();next.finishRecovery();assert.equal(next.state(),'booting');assert.throws(()=>next.resume(gate.epoch));assert.equal(next.resume(next.epoch).state,'open');});
test('drain and run acquisition serialize on same connection in both orders',t=>{const {gate,store}=fixture(t);store.startRun({id:'first',taskId:'t'});gate.drain();assert.equal(gate.status().blockers.runs,1);assert.throws(()=>store.startRun({id:'second',taskId:'t'}));store.updateRun('first',{state:'failed',processState:'not_started',verified:true});assert.equal(gate.prepareStop().idle,true);});
test('unverified terminal run still blocks shutdown',t=>{const {gate,store}=fixture(t);store.startRun({id:'r',taskId:'t'});store.updateRun('r',{state:'failed',processState:'unknown',verified:false});gate.drain();assert.throws(()=>gate.prepareStop());});
test('database failure cannot report readiness or reopen admissions',t=>{const {gate,db}=fixture(t);gate.drain();db.exec('DROP TABLE cp_runs');assert.throws(()=>gate.prepareStop());assert.throws(()=>gate.resume(gate.epoch));assert.equal(gate.state(),'draining');});
test('HTTP drain waits for request body race and permits recovery with original authentication',async()=>{
 const ControlServer=require('../src/control-server');let release;const waiting=new Promise(r=>release=r);const gate={requests:0,state:()=>state,assertOpen(){if(state!=='open')throw Error('closed');}};let state='open',calls=0;
 const server={bridge:{lifecycle:gate},origin:'http://127.0.0.1:1',json:(_r,s)=>s,handleRequest:async()=>{calls++;await waiting;return 200;}};
 const call=(url,method='POST')=>ControlServer.prototype.handle.call(server,{url,method},{});
 const pending=call('/api/assistant/submit');assert.equal(gate.requests,1);state='draining';assert.equal(await call('/api/assistant/submit'),503);const cancel=call('/api/assistant/conversation/cancel');assert.equal(gate.requests,2);release();assert.equal(await pending,200);assert.equal(await cancel,200);assert.equal(gate.requests,0);assert.equal(calls,2);
});
test('real disposable Bridge enforces operator auth, drain, resume and clean restart without inference',async t=>{
 const fs=require('node:fs'),path=require('node:path'),Bridge=require('../src/bridge-controller'),ControlServer=require('../src/control-server');
 const dir=fs.mkdtempSync('/private/tmp/ad-drain-'),data=path.join(dir,'data'),profile=path.join(dir,'profile');fs.mkdirSync(profile,{mode:0o700});fs.writeFileSync(path.join(profile,'settings.json'),'{}');
 let bridge,server;const token='a'.repeat(64);
 const boot=async()=>{bridge=await new Bridge({dataDir:data,sourceProfile:profile,webEnabled:false,slack:{env:{}}}).initialize();server=new ControlServer(bridge,{port:0,mcpToken:token});server.localShutdown=async()=>{};await server.start();};
 const call=async(route,body,key=server.token)=>{const r=await fetch(server.origin+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
 t.after(async()=>{await server?.close();await bridge?.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
 await boot();assert.equal(bridge.lifecycle.state(),'booting');
 assert.equal(bridge.lifecycle.reconciled,true);
 assert.equal((await call('/api/assistant/conversation',{})).status,503);
 assert.equal((await call('/api/mcp/health',undefined,token)).body.ready,false);
 assert.throws(()=>bridge.controlStore.startRun({id:'before-resume',taskId:'fixture'}),/admission/);
 assert.equal((await call('/api/interactive/resume-admission',{epoch:bridge.lifecycle.epoch},token)).status,401);
 assert.equal(bridge.lifecycle.state(),'booting');
 assert.equal((await call('/api/interactive/resume-admission',{epoch:'stale'})).status,400);
 assert.equal((await call('/api/interactive/resume-admission',{epoch:bridge.lifecycle.epoch})).body.state,'open');
 assert.equal((await call('/api/interactive/lifecycle',undefined,token)).status,401);
 assert.equal((await call('/api/interactive/drain',{},token)).status,401);
 assert.equal((await call('/api/interactive/drain',{})).body.state,'draining');
 assert.equal((await call('/api/mcp/health',undefined,token)).body.ready,false);
 assert.equal((await call('/api/assistant/conversation',{})).status,503);
 assert.equal((await call('/api/assistant/conversation/cancel',{},token)).status,401);
 assert.equal((await call('/api/interactive/resume-admission',{epoch:'old'})).status,400);
 const epoch=bridge.lifecycle.epoch;assert.equal((await call('/api/interactive/resume-admission',{epoch})).body.state,'open');
 await call('/api/interactive/drain',{});bridge.lifecycle.prepareStop();await server.close();await bridge.shutdown();
 await boot();assert.equal(bridge.lifecycle.state(),'booting');assert.notEqual(bridge.lifecycle.epoch,epoch);assert.equal(server.mcpToken,token);
 assert.equal((await call('/api/interactive/resume-admission',{epoch:bridge.lifecycle.epoch})).body.state,'open');
});
test('previously open epoch reopens only after canonical recovery and no blockers',t=>{
 const {bridge,store}=fixture(t),next=new ServiceLifecycle(bridge);store.lifecycle=next;
 assert.equal(next.state(),'booting');assert.throws(()=>next.resume(next.epoch),/reconciled/);
 next.finishRecovery();assert.equal(next.state(),'open');
});
test('prompt entry denies before task lookup or reasoning routing during maintenance',async()=>{
 const Bridge=require('../src/bridge-controller');let touched=false;
 await assert.rejects(()=>Bridge.prototype.prompt.call({options:{},lifecycle:{assertOpen(){throw Error('admission closed');}},tasks:{get(){touched=true;}}},'fixture','hello'),/admission closed/);assert.equal(touched,false);
});
test('event delivery stays closed before first epoch and drain waits for in-flight receipt',async t=>{
 const {ChatGPTEvents}=require('../src/chatgpt-events'),{randomUUID}=require('node:crypto');
 const {bridge,gate,db}=fixture(t);let sends=0,release;
 const pending=new Promise(r=>release=r);
 const events=new ChatGPTEvents(db,{route:{trigger_id:'agtch_fixture',access_token:'fixture'},canDeliver:()=>bridge.lifecycle?.state()==='open',fetchImpl:async()=>{sends++;await pending;return new Response(JSON.stringify({conversation_url:'https://chatgpt.com/c/fixture'}),{status:202});}});bridge.chatgptEvents=events;
 const task={id:randomUUID(),sessionId:randomUUID(),latestMcpRequestId:randomUUID(),source:{transport:'mcp'}};
 events.publishLifecycle(task,'completed');
 const saved=bridge.lifecycle;bridge.lifecycle=undefined;await events.flush();await events.deliver();assert.equal(sends,0);bridge.lifecycle=saved;
 gate.drain();await events.flush();assert.equal(sends,0);assert.equal(db.prepare('SELECT attempts FROM chatgpt_events').get().attempts,0);
 gate.resume(gate.epoch);const flight=events.flush();assert.equal(sends,1);gate.drain();assert.equal(gate.status().blockers.chatgpt_delivery,1);assert.throws(()=>gate.prepareStop(),/not idle/);
 release();await flight;assert.equal(events.running,false);assert.equal(gate.prepareStop().state,'stopping');
});
test('unresolved event delivery prevents recovery resume even without a configured route',t=>{
 const {ChatGPTEvents}=require('../src/chatgpt-events'),{randomUUID}=require('node:crypto'),{bridge,gate,db}=fixture(t);
 const events=new ChatGPTEvents(db);bridge.chatgptEvents=events;
 events.publishLifecycle({id:randomUUID(),sessionId:randomUUID(),latestMcpRequestId:randomUUID(),source:{transport:'mcp'}},'completed');
 assert.equal(gate.status().blockers.chatgpt_uncertain,0);
 db.exec("UPDATE chatgpt_events SET delivery='pending',attempts=1");gate.drain();assert.equal(gate.status().blockers.chatgpt_uncertain,1);assert.throws(()=>gate.resume(gate.epoch),/unresolved/);assert.throws(()=>gate.prepareStop(),/not idle/);
 db.exec("UPDATE chatgpt_events SET delivery='needs_review',attempts=5");assert.equal(gate.status().blockers.chatgpt_uncertain,1);
});
