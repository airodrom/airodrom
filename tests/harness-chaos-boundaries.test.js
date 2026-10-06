'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const {BoundedNextAction}=require('../src/bounded-next-action');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('expired writer lease remains quarantined on restart until termination is independently reconciled',async t=>{
 const f=await fixture(t),m=f.create(),h=f.bridge.codexAdapter.startTask(m.id,'stale-lease');
 f.bridge.memory.db.prepare('UPDATE cp_leases SET expires_at=1 WHERE run_id=?').run(h.run_id);await f.reopen();
 assert.equal(f.bridge.memory.db.prepare('SELECT state FROM cp_leases WHERE run_id=?').get(h.run_id).state,'quarantined');
 assert.throws(()=>f.bridge.controlStore.acquireLease({resource:f.repo,runId:'replacement'}),/writer/);assert.equal(f.calls(),0);
});
test('auth or quota loss after selection blocks before process start and pauses without hidden fallback',async t=>{
 for(const reason of ['auth_required','quota']){
  const f=await fixture(t),m=f.create();f.bridge.projects.updateProject(m.project_id,{autonomyLevel:'auto_development'});
  const e=new BoundedNextAction(f.bridge,{enabled:true}),id=randomUUID();e.register({id,mode:'auto_development',mission_ids:[m.id]});let selections=0;
  f.bridge.missions.agents.select=async()=>++selections===1?{selected:'claude_code',reason:'available_before_change'}:{selected:null,reason};
  assert.equal((await e.tick(id)).state,'dispatched');await f.settle(m.id,'blocked');assert.equal(f.calls(),0);assert.equal((await e.tick(id)).reason,'failure_budget');assert.equal(f.inference(),0);
 }
});
test('delayed verification cannot accept or dispatch the successor',async t=>{
 const f=await fixture(t),a=f.create(),b=f.create({objective:'Next independent fixture waits for verification.'});
 f.bridge.projects.updateProject(a.project_id,{autonomyLevel:'auto_development'});const e=new BoundedNextAction(f.bridge,{enabled:true}),id=randomUUID();e.register({id,mode:'auto_development',mission_ids:[a.id,b.id]});
 let release;const gate=new Promise(r=>release=r),verify=f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);f.bridge.missions.verifier.verify=async(...args)=>{await gate;return verify(...args);};
 try{await e.tick(id);for(let n=0;n<300&&f.bridge.controlStore.getMission(a.id).state!=='verifying';n++)await wait(10);
  assert.equal(f.bridge.controlStore.getMission(a.id).state,'verifying');assert.equal((await e.tick(id)).state,'waiting');assert.equal(f.calls(),1);assert.equal(f.bridge.controlStore.getMission(b.id).state,'ready');assert.equal(f.bridge.missions.detail(a.id).acceptance.length,0);
 }finally{release();}await f.settle(a.id);assert.equal((await e.tick(id)).state,'waiting');
});
test('publication rollback then control-plane reopen yields one inbox result and relay intent',async t=>{
 const f=await fixture(t),m=f.create(),h=f.bridge.codexAdapter.startTask(m.id,'publication-restart'),store=f.bridge.controlStore;
 store.updateRun(h.run_id,{state:'completed',processState:'exited',verified:true});
 const input={run_id:h.run_id,mission_id:m.id,task_id:m.task_id,agent_id:'codex',request_id:'publication-restart',result:{status:'completed',summary:'Local fixture evidence only'}};
 const enqueue=store.outbox.enqueue;store.outbox.enqueue=()=>{throw Error('Injected publication boundary failure');};
 assert.throws(()=>f.bridge.resultInbox.publish(input));assert.equal(f.bridge.resultInbox.latest({run:h.run_id}),null);store.outbox.enqueue=enqueue;
 await f.reopen();assert.equal(f.bridge.resultInbox.publish(input).duplicate,false);assert.equal(f.bridge.resultInbox.publish(input).duplicate,true);
 assert.equal(f.bridge.resultInbox.list({run:h.run_id}).length,1);assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_effect_outbox WHERE event_key=?').get('result:'+h.run_id).n,1);assert.equal(f.inference(),0);
});
