'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {fixture}=require('./fixtures/mission-fixture.cjs');const ControlServer=require('../src/control-server');
test('operator Mission mutation/inspection API is separate from MCP and requires idempotent request IDs',async t=>{
 const f=await fixture(t),m=f.create();const server=new ControlServer(f.bridge,{port:0,token:'operator-fixture',mcpToken:'mcp-fixture'});await server.start();
 try{
 const post=(action,body,token='operator-fixture')=>fetch(server.origin+'/api/control-v2/'+action,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post('slack-configure',{},'mcp-fixture')).status,401);
 assert.equal((await post('slack-configure',{},'operator-fixture')).status,400);
 assert.equal((await post('dispatch-mission',{id:m.id,request_id:'api-denied'},'mcp-fixture')).status,401);assert.equal(f.calls(),0);assert.equal((await post('dispatch-mission',{id:m.id})).status,400);
 assert.equal((await post('dispatch-mission',{id:m.id,request_id:'api-dispatch'})).status,200);const done=await f.settle(m.id);assert.equal((await post('dispatch-mission',{id:m.id,request_id:'api-dispatch'})).status,200);assert.equal(f.calls(),1);
 const get=async path=>{const r=await fetch(server.origin+'/api/control-v2/'+path,{headers:{Authorization:'Bearer operator-fixture'}});assert.equal(r.status,200);return r.json();};
 assert.equal((await get('mission?id='+m.id)).state,'awaiting_acceptance');assert.equal((await get('task?id='+m.task_id)).mission_id,m.id);assert.equal((await get('run?id='+done.runs[0].id)).mission_id,m.id);
 assert.equal((await post('accept-mission',{id:m.id,request_id:'api-accept',verification_id:done.verifications[0].id,decision:'accept',rationale:'Independent fixture evidence'})).status,200);assert.equal(f.bridge.missions.detail(m.id).state,'completed');
 }finally{await new Promise(resolve=>server.server.close(resolve));}
});
