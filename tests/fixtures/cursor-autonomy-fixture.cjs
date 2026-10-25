'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {fixture}=require('./mission-fixture.cjs');
const {runtime,qualifyCanonical}=require('./opencode-fixture.cjs');
async function setup(t,{cursor=true,repairs=2,manual=false,standing=true,caller='operator',assignments=3}={}) {
 const f=await fixture(t,{opencode:runtime(t).options,settleTimeoutMs:60000}),b=f.bridge;
 b.missionAuthority.initializeOperatorKey();qualifyCanonical(b);
 if(!manual)b.expandedAutonomy.setMode({mode:'routine_auto',confirmed:true,request_id:randomUUID(),sync_risk_acceptance:false},'operator');
 if(cursor)b.hostExecutionPolicy.enableCursor({confirmed:true,request_id:randomUUID()},'operator');
 if(cursor)b.cursorWorker=new(require('../../src/cursor-worker').CursorWorker)(b,{fixtureExecutable:path.join(__dirname,'cursor-agent-fixture.cjs')});
 const p=b.projects.listProjects({status:'active'})[0],g=b.projects.summary(p.projectId).goals[0];
 f.policy=b.developerAutonomy.enroll({alias:'specialist-fixture',repository:f.repo,project_id:p.projectId,goal_id:g.goalId,workflows:['routine_edit','test','repair'],workers:cursor?['opencode','cursor']:['opencode'],duration_days:1,confirmed:true,diff_check:'diff-check',default_tests:['fixture-test'],budgets:{max_repairs:repairs},cognitive:{version:3,files:['fixture.txt'],delegated_callers:caller==='operator'?[]:[caller],planning_attempts:2,planning_ms:120000,execution_ms:120000,repair_attempts:repairs,max_assignments:assignments,acceptance:'automatic'}},'operator');
 if(standing)f.grant=b.hostExecutionPolicy.enrollStandingCursorDevelopment({request_id:randomUUID(),confirmed:true,repository:f.repo,policy_id:f.policy.policy_id,acknowledge_unknown_cost:true,max_invocations_per_mission:1+repairs,max_runtime_ms:120000,max_missions:10,path_allowlist:['fixture.txt']},'operator').standing_cursor_development_active;
 f.plan=[{id:'implement',worker:cursor?'cursor':'opencode',role:'implementation',operation:'edit',paths:['fixture.txt'],description:'Change alpha to beta',depends_on:[],verification:[]},{id:'review',worker:'opencode',role:'review',operation:'read',paths:['fixture.txt'],description:'Review the implementation without modifying files',depends_on:['implement'],verification:[]}];
 f.calls=[];f.evaluations=[];
 f.evaluate=o=>({...o.coordination.result_contract,recommendation:o.coordination.host_checks.some(c=>c.status==='failed')?'repair':'ready',summary:'Reviewed host evidence and supplied files.'});
 f.bindAdapter=()=>{
 const cw=f.bridge.cursorWorker=new(require('../../src/cursor-worker').CursorWorker)(f.bridge,{fixtureExecutable:path.join(__dirname,'cursor-agent-fixture.cjs')});
 const executeCursor=cw.execute.bind(cw);cw.execute=async o=>{f.calls.push({files:o.files,writable:o.writable,input:JSON.parse(o.objective),worker:'cursor'});
 const previous=process.env.AIRODROM_CURSOR_FIXTURE_MODE;
 try{if(f.wrongFirst&&f.calls.filter(c=>c.worker==='cursor').length===1)process.env.AIRODROM_CURSOR_FIXTURE_MODE='wrong';else if(f.cursorMode)process.env.AIRODROM_CURSOR_FIXTURE_MODE=f.cursorMode;else delete process.env.AIRODROM_CURSOR_FIXTURE_MODE;return await executeCursor(o);}finally{if(previous===undefined)delete process.env.AIRODROM_CURSOR_FIXTURE_MODE;else process.env.AIRODROM_CURSOR_FIXTURE_MODE=previous;}
 };
 const adapter=f.bridge.opencodeAdapter;f.worker=adapter.execute.bind(adapter);adapter.execute=async o=>{
  if(o.planning)return{result:{summary:JSON.stringify({...o.planning,tasks:f.plan})},changes:[],provenance:{termination_verified:true}};
  if(o.coordination){f.evaluations.push(o.coordination);assert.deepEqual(o.writable,[]);return{result:{summary:JSON.stringify(await f.evaluate(o))},changes:[],provenance:{runtime_id:'opencode',sandbox:'fixture',termination_verified:true,authority:false}};}
  f.calls.push({files:o.files,writable:o.writable,input:JSON.parse(o.objective),worker:'opencode'});return f.worker(o.writable.length?o:{...o,objective:'Inspect current files without changes',objectiveProof:null});
 };};f.bindAdapter();
 f.ask=async({review=true}={})=>{const request_id=randomUUID(),instruction='In Fixture project change fixture.txt from alpha to beta'+(review?' and independently review fixture.txt.':'.');f.request={request_id,instruction};let view=await b.zeroSetupWork.ask(f.request,caller);for(let i=0;i<200&&view.state==='PLANNING';i++){await new Promise(r=>setTimeout(r,20));view=await b.zeroSetupWork.ask({request_id,instruction},caller);}return view;};
 f.caller=caller;return f;
}
module.exports={setup};
