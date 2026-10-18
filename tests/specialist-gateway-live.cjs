'use strict';
// Opt-in real local inference in disposable repositories. No external grant or
// installed-host authority is created by this isolated qualification.
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const {qualifyCanonical}=require('./fixtures/opencode-fixture.cjs');
if(process.env.AIRODROM_OPENCODE_LIVE!=='1')throw Error('Explicit local OpenCode live-test opt-in required');
test('real local specialist planning, implementation, review, result return and automatic completion', {timeout:600000},async t=>{
 const f=await fixture(t,{opencode:{enabled:true,executable:process.env.AIRODROM_OPENCODE_EXECUTABLE||'/opt/homebrew/bin/opencode',model:'ollama/qwen3-coder:30b',timeoutMs:120000},settleTimeoutMs:300000}),b=f.bridge;
 b.missionAuthority.initializeOperatorKey();qualifyCanonical(b);
 b.expandedAutonomy.setMode({mode:'routine_auto',confirmed:true,request_id:randomUUID(),sync_risk_acceptance:false},'operator');
 const project=b.projects.listProjects({status:'active'})[0],goal=b.projects.summary(project.projectId).goals[0];
 b.developerAutonomy.enroll({alias:'specialist-live-fixture',repository:f.repo,project_id:project.projectId,goal_id:goal.goalId,workflows:['routine_edit','test'],workers:['opencode'],duration_days:1,confirmed:true,diff_check:'diff-check',default_tests:['fixture-test'],budgets:{max_repairs:0},cognitive:{version:3,max_assignments:3,acceptance:'automatic',repair_attempts:0,files:['fixture.txt'],delegated_callers:[],planning_attempts:2,planning_ms:120000,execution_ms:120000}},'operator');
 const prepared=await b.zeroSetupWork.ask({request_id:randomUUID(),instruction:'In Fixture project, using OpenCode, perform exactly two dependent assignments: first implement the change in fixture.txt from alpha to beta, preserving exactly one final newline; then independently review fixture.txt without writing it. Make the registered test pass.'},'operator');
 assert.equal(prepared.state,'DISPATCHED',JSON.stringify(prepared));
 const done=await f.settle(prepared.mission_id,'completed'),evidence=require('../src/mission-evidence').evidencePackage(b,done.id);
 assert.equal(evidence.specialists.assignments.length,2);assert.equal(evidence.gateway.evaluations.length,2);assert.equal(evidence.acceptance_status,'accepted');assert.equal(evidence.verification.result,'passed');
 for(const e of evidence.gateway.evaluations){assert.equal(e.recommendation,'ready');assert.equal(e.termination_verified,true);assert.equal(e.provenance.runtime_version,'2.0.25');assert.equal(e.provenance.sandbox,'sandbox-exec');}
 assert.ok(evidence.cognitive.leases.every(l=>l.state==='released'));
 await f.reopen();const recovered=await new(require('../src/mcp-tools').McpTools)(f.bridge).call('get_mission_evidence',{mission_id:done.id});
 assert.equal(recovered.acceptance_status,'accepted');assert.equal(recovered.repair_attempts,0);
 console.log(JSON.stringify({live_local:true,installed_host:false,external_worker_verified:false,automatic_acceptance:true,durable_reopen:true,...recovered.cognitive,gateway:recovered.gateway}));
});
