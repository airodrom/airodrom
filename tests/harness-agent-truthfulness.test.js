'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {agentCapabilities}=require('../src/capability-connectors');
const caps=agentCapabilities();
const context=(claude={},connected=false)=>({devtools:{claudeStatus:async()=>claude,cursorStatus:async()=>({installed:true})},mcpConnected:()=>connected});
test('installed Cursor and Codex handoff do not imply executable agents',async()=>{
 const list=await caps.agent_list.perform(context({installed:true,logged_in:true,auth_mode:'subscription'}),{});
 assert.equal(list.agents.find(a=>a.id==='cursor').state,'unavailable');assert.equal(list.agents.find(a=>a.id==='cursor').editor_available,true);
 assert.equal(list.agents.find(a=>a.id==='codex').reason,'native_dispatch_unavailable');assert.equal(list.agents.find(a=>a.id==='claude_code').state,'available');
});
test('routing waits for semantic fit and respects auth, quota/busy and locality',async()=>{
 const run=(ctx,input)=>caps.agent_route_suggest.perform(ctx,input),coding={taskType:'large_multi_file_coding',size:'large'};
 assert.equal((await run(context({installed:true,logged_in:false}),coding)).state,'waiting');
 assert.equal((await run(context({installed:true,logged_in:true,auth_mode:'subscription',running_jobs:1}),coding)).state,'waiting');
 assert.equal((await run(context({installed:true,logged_in:true,auth_mode:'subscription',api_key_overrides_subscription:true}),coding)).suggested_agent,null);
 assert.equal((await run(context({installed:true,logged_in:true,auth_mode:'subscription'}),coding)).suggested_agent,'claude_code');
 assert.equal((await run(context({installed:true,logged_in:true,auth_mode:'subscription'}),{...coding,privacy:'local_only'})).state,'waiting');
 assert.equal((await run(context(),{taskType:'tests',privacy:'local_only'})).suggested_agent,'pi');
});
test('a selected different agent is never silently dispatched through Claude',async t=>{
 const {fixture}=require('./fixtures/mission-fixture.cjs');const f=await fixture(t),m=f.create();
 f.bridge.missions.agents.select=async()=>({selected:'codex',reason:'injected future availability'});
 f.bridge.missions.dispatch(m.id,{request_id:'dispatch-identity'});await f.settle(m.id,'blocked');
 assert.equal(f.calls(),0);assert.match(f.bridge.controlStore.getMission(m.id).reason,/handoff required/);assert.equal(f.inference(),0);
});
