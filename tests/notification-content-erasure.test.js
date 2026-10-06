'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {macCapabilities,clearNotificationCache}=require('../src/capability-mac');
function fixture(t,{sent=[],run=async()=>({exitCode:0})}={}) {
  let at=1000;const state={sent},cap=macCapabilities({notificationState:state,now:()=>at}).notification_send;
  const ctx={exec:{run}},input={title:'Fixture',message:'Notification privacy canary'};
  t.after(clearNotificationCache);return {state,cap,ctx,input,advance:ms=>{at+=ms;}};
}
test('notification dedupe uses an opaque identity and an erasable payload',async t=>{
  const f=fixture(t);await f.cap.perform(f.ctx,f.input);
  assert.match(f.state.sent[0].key,/^[0-9a-f-]{36}$/);
  const legacy=createHash('sha256').update(f.input.title+'\n'+f.input.message).digest('hex');
  assert.equal(JSON.stringify(f.state).includes(legacy),false);
  assert.equal(f.cap.assess(f.ctx,f.input).dynamic.reason,'Duplicate notification suppressed');
  assert.equal(f.cap.assess(f.ctx,{...f.input,message:'Other text'}).dynamic,undefined);
});
test('host erasure removes notification payloads while preserving the rate limit',async t=>{
  const f=fixture(t);for(let i=0;i<5;i++)await f.cap.perform(f.ctx,{...f.input,message:f.input.message+i});
  clearNotificationCache();assert.deepEqual(f.state.sent,[]);assert.equal(JSON.stringify(f.state).includes(f.input.message),false);
  assert.equal(f.cap.assess(f.ctx,f.input).dynamic.reason,'Notification rate limit reached');
  f.advance(60_001);assert.equal(f.cap.assess(f.ctx,f.input).dynamic,undefined);
});
test('notification payload dedupe expires deterministically after its TTL',async t=>{
  const f=fixture(t);await f.cap.perform(f.ctx,f.input);f.advance(600_000);
  assert.equal(f.cap.assess(f.ctx,f.input).dynamic,undefined);assert.deepEqual(f.state.sent,[]);
  assert.equal(JSON.stringify(f.state).includes(f.input.message),false);
});
test('notification completion racing erasure cannot repopulate an erased cache',async t=>{
  let resolve;const pending=new Promise(done=>{resolve=done;});const f=fixture(t,{run:()=>pending});
  const sent=f.cap.perform(f.ctx,f.input);clearNotificationCache();resolve({exitCode:0});await sent;
  assert.deepEqual(f.state.sent,[]);assert.equal(f.state.recent.length,1);
});
test('legacy notification fingerprints are discarded without resetting rate metadata',t=>{
  const f=fixture(t,{sent:Array.from({length:5},()=>({key:'a'.repeat(64),at:1000}))});
  assert.deepEqual(f.state.sent,[]);assert.equal(JSON.stringify(f.state).includes('a'.repeat(64)),false);
  assert.equal(f.cap.assess(f.ctx,f.input).dynamic.reason,'Notification rate limit reached');
});
