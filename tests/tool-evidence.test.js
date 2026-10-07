'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Bridge=require('./fixtures/test-bridge.cjs');
const {toolCallEvidence}=require('../src/capability-broker');
async function fixture(t){const root=fs.mkdtempSync('/private/tmp/pi-tool-evidence-'),profile=path.join(root,'profile'),workspace=path.join(root,'workspace');fs.mkdirSync(profile);fs.mkdirSync(workspace);fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'fixture'}));fs.writeFileSync(path.join(workspace,'note.txt'),'harmless evidence fixture');const bridge=await new Bridge({ defaultRuntime: 'host',dataDir:path.join(root,'data'),sourceProfile:profile,executable:path.join(__dirname,'fixtures/host-worker.cjs'),allowFixtureWorker:true}).initialize();t.after(async()=>{await bridge.shutdown();fs.rmSync(root,{recursive:true,force:true});});const task=bridge.tasks.get(bridge.createTask('Tool evidence fixture',{workspace}).id);bridge.policy.registerTask(task);return{bridge,task};}
test('nested runtime IDs produce bounded correlation and reject private/path metadata',()=>{
 assert.deepEqual(toolCallEvidence('call-root/1/2'),{tool_call_id:'call-root/1/2',parent_tool_call_id:'call-root/1'});
 assert.deepEqual(toolCallEvidence('call-root'),{tool_call_id:'call-root',parent_tool_call_id:null});
 for(const value of ['/private/hidden','call/0','call/-1','call/1 trailing','x'.repeat(201),'password=dummy-private',null])assert.deepEqual(toolCallEvidence(value),{tool_call_id:null,parent_tool_call_id:null});
});
test('nested broker calls retain normal policy checks and digest evidence',async t=>{
 const{bridge,task}=await fixture(t);const read=await bridge.capabilityBroker.execute(task.id,{toolName:'read',input:{path:'note.txt'},toolCallId:'call-root/1'});assert.equal(read.allow,true);assert.match(read.output,/harmless evidence fixture/);const row=bridge.capabilityBroker.audit.at(-1);assert.equal(row.parentToolCallId,'call-root');assert.equal(row.executionStatus,'COMPLETED');assert.match(row.outputSha256,/^[a-f0-9]{64}$/);
 const denied=await bridge.capabilityBroker.execute(task.id,{toolName:'fabricated_tool',input:{},toolCallId:'call-root/2'});assert.equal(denied.allow,false);assert.equal(bridge.capabilityBroker.audit.at(-1).executionStatus,'NOT EXECUTED');assert.equal(bridge.capabilityBroker.audit.at(-1).parentToolCallId,'call-root');
});
test('a claimed parent cannot extend the broker request schema or grant execution',async t=>{
 const{bridge,task}=await fixture(t);const denied=await bridge.capabilityBroker.execute(task.id,{toolName:'read',input:{path:'note.txt'},toolCallId:'call-child',parentToolCallId:'approved-parent'});assert.equal(denied.allow,false);assert.equal(bridge.capabilityBroker.audit.at(-1).executionStatus,'NOT EXECUTED');
});
test('Pi lifecycle evidence preserves canonical parent correlation and ignores forged parent fields',async t=>{
 const{bridge,task}=await fixture(t);bridge.onWorkerEvent(task,{type:'tool_execution_end',toolName:'read',toolCallId:'call-root/1',parentToolCallId:'forged-parent',isError:false});const row=task.events.at(-1);assert.equal(row.tool_call_id,'call-root/1');assert.equal(row.parent_tool_call_id,'call-root');bridge.onWorkerEvent(task,{type:'tool_execution_start',toolName:'read',toolCallId:'/private/hidden'});assert.equal(task.events.at(-1).tool_call_id,null);assert.equal(task.events.at(-1).parent_tool_call_id,null);
});
