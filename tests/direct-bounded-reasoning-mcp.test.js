'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const Bridge=require('./fixtures/test-bridge.cjs');
const SafetyPolicy=require('../src/safety-policy');
const {McpTools,TOOLS,validate}=require('../src/mcp-tools');

const externalPolicy={providers:['anthropic_subscription'],data_class:'public',privacy:'approved_external',purpose:'synthetic_probe',max_output:64};
const localPolicy={providers:['ollama'],data_class:'public',privacy:'local_only',purpose:'synthetic_probe',max_output:64};

function fakeBridge(t){
  const root=fs.mkdtempSync(path.join(process.cwd(),'.tmp-direct-bounded-reasoning-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const tasks=new Map(),policy=new SafetyPolicy();
  let promptCalls=0,ledgerResumes=0;
  const bridge={
    closed:false,
    tasks:{
      list:()=>[...tasks.values()],
      get:id=>tasks.get(id),
      save:()=>{}
    },
    capabilityHost:{policy:{normalizeTaskScopes:value=>value===undefined?['repo','system_readonly']:value}},
    policy,
    leases:{
      size:0,
      has:()=>false,
      acquire:()=>{throw Error('writer lease must not be acquired for host reasoning')},
      releaseIfOwner:()=>{throw Error('writer lease must not be released for host reasoning')}
    },
    inFlight:new Map(),
    createTask(description,options={}){
      const id=randomUUID(),task={
        id,sessionId:randomUUID(),description,workspace:root,status:'pending',events:[],
        cancelRequested:false,safetyStop:null,continuationRequired:false,includeSharedMemory:false,
        mission:{id:randomUUID(),objective:null,objectiveSet:false,requireGrant:false,status:'pending',
          budget:{maxRuntimeMs:120000,maxActions:10,maxRetries:0,maxSpendMicros:0},used:{runtimeMs:0,actions:0,retries:0}},
        reasoningMode:options.reasoningOnly?'reasoning_only':null,
        reasoningGatewayPolicy:options.reasoningGatewayPolicy||null,
        reasoningProbe:options.reasoningProbe||null,
        capabilityScopes:options.reasoningOnly?[]:(options.capabilityScopes||['repo','system_readonly'])
      };
      tasks.set(id,task);policy.registerTask(task);return{id};
    },
    emit:()=>{},
    async prompt(id,message){
      const task=tasks.get(id);promptCalls++;
      task.status='idle';task.lastResult='4';task.failureKind=null;task.error=null;
      task.reasoningResult={status:'completed',error_class:null,verification:'unverified',accepted:false};
      task.providerRouting={selected_provider:task.reasoningGatewayPolicy.providers[0]};
      return{status:'completed',text:'4',provider_id:task.reasoningGatewayPolicy.providers[0],
        error_class:null,wait_reason:null,execution_authority:false,accepted:false};
    },
    _recordInstructionBeforeDispatch(task,message,{approvalResume}={}){
      assert.equal(approvalResume?.toolName,'host_reasoning');
      ledgerResumes++;
    }
  };
  bridge._executeApprovedHostReasoning=Bridge.prototype._executeApprovedHostReasoning;
  bridge._executeApprovedCapability=Bridge.prototype._executeApprovedCapability;
  bridge.resumeApproved=Bridge.prototype.resumeApproved;
  const mcp=new McpTools(bridge,{origin:()=> 'http://127.0.0.1:1/',authenticatedConnection:()=>({epoch:'e'.repeat(32),authenticatedAt:Date.now()})});
  return{bridge,mcp,policy,tasks,promptCalls:()=>promptCalls,ledgerResumes:()=>ledgerResumes};
}

test('create_task schema exposes explicit bounded reasoning policy without adding a new MCP tool',()=>{
  assert.equal(TOOLS.length,24);
  const schema=TOOLS.find(t=>t.name==='create_task').inputSchema;
  assert.equal(schema.properties.reasoning_policy.type,'object');
  const base={description:'reasoning',message:'Return exactly: 4',request_id:'reasoning-schema',mission_mode:'reasoning_only',reasoning_policy:externalPolicy};
  assert.doesNotThrow(()=>validate('create_task',base));
  assert.throws(()=>validate('create_task',{...base,mission_mode:'orchestrator'}),/reasoning_policy requires reasoning-only mode/);
  assert.throws(()=>validate('create_task',{...base,message:'sk-'+ 'Z'.repeat(30)}),/Host reasoning admission denied/);
  assert.throws(()=>validate('create_task',{...base,reasoning_policy:{...externalPolicy,data_class:'financial'}}),/Sensitive context requires local-only policy/);
});

test('local-only reasoning_policy executes directly with no approval or writer lease',async t=>{
  const f=fakeBridge(t);
  const receipt=await f.mcp.call('create_task',{
    description:'local reasoning',message:'Return exactly: 4',request_id:'local-reasoning-1',
    mission_mode:'reasoning_only',required_execution_kind:'reasoning',reasoning_policy:localPolicy
  },{name:'fixture',version:'1'});
  const task=f.tasks.get(receipt.task_id);
  assert.equal(f.promptCalls(),1);
  assert.equal(task.status,'idle');
  assert.equal(task.lastResult,'4');
  assert.equal(f.policy.list(task.id).length,0);
  assert.deepEqual(task.capabilityScopes,[]);
  const denied=f.policy.check(task.id,{toolName:'write',input:{path:'x',content:'x'}});
  assert.equal(denied.allow,false);
  assert.equal(denied.kind,'reasoning_execution_denied');
});

test('approved_external reasoning_policy creates exact one-shot approval and resumes directly without native writer lease',async t=>{
  const f=fakeBridge(t);
  const receipt=await f.mcp.call('create_task',{
    description:'external reasoning',message:'Return exactly: 4',request_id:'external-reasoning-1',
    mission_mode:'reasoning_only',required_execution_kind:'reasoning',reasoning_policy:externalPolicy
  },{name:'fixture',version:'1'});
  const task=f.tasks.get(receipt.task_id);
  assert.equal(receipt.status,'approval_required');
  assert.equal(receipt.approval.status,'pending');
  assert.equal(f.promptCalls(),0);
  const presented=await f.mcp.call('approve_once',{task_id:task.id,approval_id:receipt.approval.approval_id});
  assert.equal(presented.approved,false);
  assert.equal(f.policy.list(task.id)[0].status,'pending');

  const approved=f.policy.approve(receipt.approval.approval_id);
  const resumed=await f.bridge.resumeApproved(approved);
  assert.equal(resumed.allow,true);
  const output=JSON.parse(resumed.output);
  assert.equal(output.status,'completed');
  assert.equal(output.text,'4');
  assert.equal(output.provider,'anthropic_subscription');
  assert.equal(output.execution_authority,false);
  assert.equal(output.accepted,false);
  assert.equal(f.promptCalls(),1);
  assert.equal(f.ledgerResumes(),1);
  assert.equal(f.policy.approvals.get(approved.id).status,'consumed');
  assert.equal(task.status,'idle');
  await assert.rejects(f.mcp.call('continue_task',{task_id:task.id,message:'Again',request_id:'external-reasoning-2'}),/single-use/);
  assert.equal(f.promptCalls(),1);
});

test('approved host reasoning is fingerprint-bound to original task message and policy',async t=>{
  const f=fakeBridge(t);
  const receipt=await f.mcp.call('create_task',{
    description:'bound reasoning',message:'Return exactly: 4',request_id:'bound-reasoning-1',
    mission_mode:'reasoning_only',reasoning_policy:externalPolicy
  },{name:'fixture',version:'1'});
  const task=f.tasks.get(receipt.task_id);
  const approved=f.policy.approve(receipt.approval.approval_id);
  task.reasoningGatewayPolicy={...task.reasoningGatewayPolicy,providers:['ollama']};
  await assert.rejects(f.bridge.resumeApproved(approved),/no longer matches task/);
  assert.equal(f.promptCalls(),0);
  assert.equal(f.policy.approvals.get(approved.id).status,'approved');
});

test('secret-like text is rejected before task or approval creation',async t=>{
  const f=fakeBridge(t);
  const beforeTasks=f.tasks.size,beforeApprovals=f.policy.list().length;
  await assert.rejects(f.mcp.call('create_task',{
    description:'secret rejection',message:'sk-'+ 'Z'.repeat(30),request_id:'secret-reasoning-1',
    mission_mode:'reasoning_only',reasoning_policy:externalPolicy
  },{name:'fixture',version:'1'}),/Host reasoning admission denied/);
  assert.equal(f.tasks.size,beforeTasks);
  assert.equal(f.policy.list().length,beforeApprovals);
  assert.equal(f.promptCalls(),0);
});

test('SafetyPolicy consumes only the exact approved external reasoning fingerprint',t=>{
  const f=fakeBridge(t);
  const task=f.bridge.createTask('policy',{reasoningOnly:true,reasoningGatewayPolicy:externalPolicy});
  const live=f.tasks.get(task.id);
  const request={toolName:'host_reasoning',toolCallId:'host-policy-1',input:{
    request_id:'policy-reasoning-1',message:'Return exactly: 4',policy:externalPolicy
  }};
  const pending=f.policy.check(live.id,request);
  assert.equal(pending.allow,false);assert.equal(pending.kind,'approval_required');
  const approved=f.policy.approve(pending.approvalId);
  const altered=f.policy.check(live.id,{...request,toolCallId:'host-policy-2',input:{...request.input,message:'Return exactly: 5'}});
  assert.equal(altered.allow,false);assert.equal(altered.kind,'approval_required');
  assert.equal(f.policy.approvals.get(approved.id).status,'approved');
  const exact=f.policy.check(live.id,{...request,toolCallId:'host-policy-3'});
  assert.equal(exact.allow,true);
  assert.equal(f.policy.approvals.get(approved.id).status,'consumed');
});
