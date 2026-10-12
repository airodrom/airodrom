'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {opencodePrompt}=require('../src/exact-file-prompt');
const {TOOLS,validate,McpTools}=require('../src/mcp-tools');

test('exact-file OpenCode prompt states required bytes without changing criteria content',()=>{
  const mission={envelope:{objective:'Change fixture.txt from alpha to beta.',constraints:'Disposable only.',criteria:[{id:'expected_file',type:'exact_file',path:'fixture.txt',content:'beta\n'}]}};
  const prompt=opencodePrompt(mission);
  assert.match(prompt,/62 65 74 61 0a/);
  assert.match(prompt,/Do not write a second trailing LF/);
  assert.equal(mission.envelope.criteria[0].content,'beta\n');
});

test('MCP exposes discovery and CAE request tools without granting autonomous authority',async()=>{
  for(const name of ['list_authorized_scopes','list_work_templates','list_goal_plans','inspect_goal_plan','inspect_autonomous_goal','propose_goal_plan','request_autonomous_authorization']){
    assert.ok(TOOLS.some(t=>t.name===name),name);
  }
  assert.equal(TOOLS.find(t=>t.name==='request_autonomous_authorization').annotations.readOnlyHint,false);
  assert.throws(()=>validate('request_autonomous_authorization',{plan_id:randomUUID(),request_id:'x',workers:['opencode'],max_concurrent_missions:1,max_dispatches:3,max_repairs:1,confirmed:true}),/Unknown tool argument/);

  const plans=[];
  const bridge={
    projects:{listProjects:()=>[{projectId:'p1',name:'Fixture',status:'active',repositories:['/tmp/x']}],summary:()=>({goals:[{goalId:'g1',name:'Goal',status:'active'}]})},
    workTemplates:{list:()=>[{project:'fixture',workspace_alias:'local',state:'active',template_hash:'h',allowed_files:['fixture.txt'],privacy:'local_only',data_class:'public',workers:['opencode'],expires_at:Date.now()+1000,workspace:'/secret/path'}]},
    missions:{goalPlanner:{list:()=>[],inspect:id=>({id,state:'observing',execution_enabled:false,ready:[],blocked:[],authority:false}),create:(input)=>({id:'plan-1',state:'observing',execution_enabled:false,...input})}},
    autonomousExecution:{list:()=>[],inspect:id=>({id,state:'observing',execution_enabled:false,ready:[],blocked:[],stages:[],autonomous:{lifecycle:'created',enabled:false}})}
  };
  const mcp=new McpTools(bridge,{});
  mcp.handoffPrincipal='fixture-session';
  const scopes=await mcp.call('list_authorized_scopes',{},{name:'chatgpt',version:'1'});
  assert.equal(scopes.projects[0].project_id,'p1');
  assert.equal(scopes.goals[0].goal_id,'g1');
  assert.equal(scopes.authority,false);
  const templates=await mcp.call('list_work_templates',{},{name:'chatgpt',version:'1'});
  assert.equal(templates.items[0].workspace_alias,'local');
  assert.equal(templates.items[0].workspace,undefined);
  const wait=await mcp.call('request_autonomous_authorization',{plan_id:randomUUID(),request_id:'req-auth-1',workers:['opencode'],max_concurrent_missions:1,max_dispatches:3,max_repairs:1},{name:'chatgpt',version:'1'});
  assert.equal(wait.state,'WAIT');
  assert.equal(wait.authority,false);
  assert.match(wait.reason,/Control Center/);
  const proposed=await mcp.call('propose_goal_plan',{request_id:'req-plan-1',goal_id:randomUUID(),stages:[{id:randomUUID(),depends_on:[],mission_id:null,objective:'Disposable exact-file milestone',acceptance_criteria:['exact file'],verification_requirements:['fixture-test']}],max_runtime_hours:1,max_attempts:2},{name:'chatgpt',version:'1'});
  assert.equal(proposed.execution_enabled,false);
  assert.equal(proposed.authority,false);
});
