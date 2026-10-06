'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/mission-fixture.cjs');
test('inbox filters survive reopen; reviewed cannot regress or confer acceptance',async t=>{
 const f=await fixture(t),m=f.create();f.bridge.missions.dispatch(m.id,{request_id:'inbox-filter'});await f.settle(m.id);
 const inbox=f.bridge.resultInbox,r=inbox.latest({mission:m.id,agent:'claude_code'});assert.ok(r);assert.equal(inbox.latest({mission:'absent'}),null);
 assert.equal(inbox.list({task:r.task_id,run:r.run_id}).length,1);assert.throws(()=>inbox.list({state:'accepted'}),/state/);
 inbox.review(r.run_id,'reviewed');assert.throws(()=>inbox.review(r.run_id,'read'),/regress/);assert.equal(inbox.review(r.run_id,'reviewed').acceptance_changed,false);
 await f.reopen();assert.equal(f.bridge.resultInbox.latest({run:r.run_id}).state,'reviewed');assert.equal(f.bridge.controlStore.getMission(m.id).state,'awaiting_acceptance');assert.equal(f.inference(),0);
});
test('hostile result collections and status contradictions fail before publication',async t=>{
 const f=await fixture(t),m=f.create(),h=f.bridge.codexAdapter.startTask(m.id,'invalid-result');
 f.bridge.controlStore.updateRun(h.run_id,{state:'failed',processState:'exited',verified:true});
 const base={run_id:h.run_id,mission_id:m.id,task_id:m.task_id,agent_id:'codex',request_id:'invalid-result',result:{status:'failed',summary:'Fixture failure'}};
 assert.throws(()=>f.bridge.resultInbox.publish({...base,result:{status:'completed',summary:'Forged success'}}),/contradicts/);
 assert.throws(()=>f.bridge.resultInbox.publish({...base,result:{...base.result,tests:'passed'}}),/collection/);
 assert.throws(()=>f.bridge.resultInbox.publish({...base,result:{...base.result,needs_operator:'true'}}),/operator/);
 assert.equal(f.bridge.resultInbox.latest({run:h.run_id}),null);
 f.bridge.resultInbox.publish(base);assert.equal(f.bridge.resultInbox.latest({run:h.run_id}).result.accepted,false);
});
test('malformed structured completion becomes durable failed evidence without inference or acceptance',async t=>{
 const f=await fixture(t),m=f.create(),store=f.bridge.controlStore,run='malformed-completion';
 store.state(m.id,'dispatching');store.state(m.id,'running');store.startRun({id:run,taskId:m.task_id,missionId:m.id,agentId:'claude_code'});store.updateRun(run,{state:'completed',processState:'exited',verified:true});
 f.bridge.missions.captureResult(run,{status:'completed',result:{text:JSON.stringify({needs_operator:true,question:42})}});
 await f.settle(m.id,'needs_rework');const inbox=f.bridge.resultInbox.latest({run});assert.equal(inbox.result.status,'failed');assert.equal(inbox.result.summary,'Invalid structured agent result');assert.equal(inbox.result.accepted,false);assert.equal(f.inference(),0);
});
