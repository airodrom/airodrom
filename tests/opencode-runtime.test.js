'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {OpenCodeAdapter,version,authCategory,parseOutput,disposableEnv,runtimeConfig}=require('../src/opencode-adapter');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const {runtime,manifest,qualifyCanonical}=require('./fixtures/opencode-fixture.cjs');
function event(result,sessionID='ses_fixture'){return JSON.stringify({type:'text',sessionID,part:{messageID:'m',text:JSON.stringify(result)}})+'\n';}
const result={summary:'observed',changed_files:[],tests:[],artifacts:[],limitations:[]};
test('OpenCode version/auth observation reports categories and fails closed on unknown formats',()=>{
 assert.equal(version('opencode v2.0.20\n'),'2.0.20');assert.equal(version('token=synthetic'),null);
 assert.equal(authCategory('[]'),'auth_required');assert.equal(authCategory('[{"id":"fixture","connections":[{"type":"credential","label":"synthetic"}]}]'),'session_observed');assert.equal(authCategory('{}'),'unknown');
 assert.equal(JSON.stringify({category:authCategory('[{"id":"fixture","connections":[{"type":"credential","label":"synthetic"}]}]')}).includes('synthetic'),false);
});
test('unavailable, unsupported and unconfigured runtimes cannot dispatch',async()=>{
 for(const options of [{executable:'/missing'},{enabled:true,executable:'/missing',model:'anthropic/unapproved'},{}]){
  const a=new OpenCodeAdapter(null,options);assert.equal((await a.readiness()).ready,false);await assert.rejects(a.execute({}),/opencode_unavailable/);
 }
 assert.throws(()=>new OpenCodeAdapter(null,{fixtureExecutable:'/tmp/untrusted'}),/fixture_denied/);
});
test('read-only and one-file edit return bounded sanitized artifacts without writing the original repository',async t=>{
 const f=runtime(t),a=await f.adapter.execute(f.request);assert.equal(a.changes.length,0);assert.equal(a.provenance.authority,false);
 const b=await f.adapter.execute({...f.request,objective:'alpha to beta',writable:['fixture.txt']});assert.equal(b.changes[0].content,'beta\n');assert.equal(b.provenance.termination_verified,true);assert.equal(fs.readFileSync(path.join(f.workspace,'fixture.txt'),'utf8'),'alpha\n');
 assert.equal(b.provenance.session_state,'disposable');
});
test('workspace binding, undeclared write, continuation and secret context are denied',async t=>{
 const f=runtime(t);
 await assert.rejects(f.adapter.execute({...f.request,files:['../memory.sqlite']}),/file_scope/);
 await assert.rejects(f.adapter.execute({...f.request,workspace:'relative'}),/workspace_binding/);
 await assert.rejects(f.adapter.execute({...f.request,writable:['other.txt']}),/workspace_binding/);
 await assert.rejects(f.adapter.execute({...f.request,objective:'undeclared'}),/undeclared_write/);
 await assert.rejects(f.adapter.execute({...f.request,sessionId:'ses_old'}),/session_reuse_denied/);
 await assert.rejects(f.adapter.execute({...f.request,context:{content:'Bearer syntheticContextSecret'}}),/sensitive_context/);
 const link=path.join(f.workspace,'link.txt');fs.symlinkSync(path.join(f.workspace,'fixture.txt'),link);
 await assert.rejects(f.adapter.execute({...f.request,files:['link.txt']}),/file_boundary/);
});
test('timeout and cancellation kill the owned process group; nonzero/malformed results never become evidence',async t=>{
 const f=runtime(t);await assert.rejects(f.adapter.execute({...f.request,objective:'timeout',timeoutMs:100}),/opencode_timeout/);
 const controller=new AbortController(),pending=f.adapter.execute({...f.request,objective:'timeout',signal:controller.signal});setTimeout(()=>controller.abort(),100);
 await assert.rejects(pending,/opencode_cancelled/);
 for(const objective of ['nonzero','malformed','escalation'])await assert.rejects(f.adapter.execute({...f.request,objective}),error=>!error.message.includes('syntheticFailureSecret'));
});
test('redaction drops raw runtime tools, credentials and self-attested tests; sessions must correlate',async()=>{
 const parsed=parseOutput(event({...result,summary:'Bearer syntheticResultSecret',tests:[{claimed:'passed'}]}),[]);assert.doesNotMatch(JSON.stringify(parsed),/syntheticResultSecret/);assert.deepEqual(parsed.result.tests,[]);
 assert.throws(()=>parseOutput(event(result)+'{"type":"error"}\n',[]),/malformed/);
 assert.throws(()=>parseOutput(event(result)+event(result,'ses_wrong'),[]),/session_mismatch/);
 assert.throws(()=>parseOutput(event({...result,changed_files:['other.txt']}),[]),/malformed/);
 assert.deepEqual(parseOutput(event({summary:'unavailable'}),[]).result.changed_files,[]);
 assert.throws(()=>parseOutput(event({...result,limitations:'untrusted'}),[]),/malformed/);
});
test('child environment is isolated and tools deny memory, shell, network, subagents and MCP by default',async t=>{
 const f=runtime(t),e=disposableEnv('/tmp/fixture','/tmp/fixture/workspace',{});assert.equal(e.OPENAI_API_KEY,undefined);assert.equal(e.HOME,undefined);assert.equal(e.NODE_OPTIONS,undefined);
 const c=runtimeConfig('ollama/fixture','/tmp/work',['fixture.txt'],['fixture.txt']);assert.deepEqual(c.permissions[0],{action:'*',resource:'*',effect:'deny'});
 assert.deepEqual(c.permissions.slice(1),[{action:'read',resource:'fixture.txt',effect:'allow'},{action:'edit',resource:'fixture.txt',effect:'allow'}]);
 const value=await f.adapter.execute({...f.request,objective:'environment'});assert.doesNotMatch(value.result.summary,/OPENAI_API_KEY|GITHUB_TOKEN|NODE_OPTIONS|AIRODROM/);
});
test('OpenCode Mission runs through independent verifier, Acceptance and ordered Settlement; duplicate dispatch does not rerun',async t=>{
 const r=runtime(t),f=await fixture(t,{opencode:r.options}),canonical=qualifyCanonical(f.bridge);assert.equal(canonical.routing,true);
 assert.throws(()=>f.create({preferred_agent:'opencode'}),/local-only/);
 assert.throws(()=>f.create({fallback_agents:['opencode']}),/explicit preferred route/);
 const m=f.create({preferred_agent:'opencode',fallback_agents:[],dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'focused_coding'},manifest:manifest(f.repo)});
 assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:'early',verification_id:'unverified',decision:'accept',rationale:'No evidence'}));
 assert.throws(()=>f.bridge.missions.program.settle(m.id,'accept'),/Settlement requires/);
 const dispatch=f.bridge.missions.dispatch(m.id,{request_id:'opencode-dispatch'}),same=f.bridge.missions.dispatch(m.id,{request_id:'opencode-dispatch'});assert.equal(dispatch.dispatch_id,same.dispatch_id);
 const done=await f.settle(m.id);assert.equal(done.verifications[0].result,'passed');assert.equal(done.acceptance.length,0);assert.equal(done.program_contract.settlement.state,'waiting_acceptance');
 assert.equal(done.runs.filter(r=>r.agent_id==='opencode').length,1);assert.equal(done.dispatches[0].route.selected,'opencode');assert.ok(done.dispatches[0].route.authority_routing_decision_id);assert.equal(canonical.store.listAcceptancesForMission(m.id).length,0);assert.equal(f.calls(),0);
 f.bridge.missions.accept(m.id,{request_id:'verified-acceptance',verification_id:done.verifications[0].id,decision:'accept',rationale:'Independent fixture evidence passed'});
 assert.equal(f.bridge.missions.detail(m.id).program_contract.settlement.state,'settled');assert.equal(canonical.store.listAcceptancesForMission(m.id).length,1);assert.equal(canonical.store.integrity().ok,true);
 const timeline=f.bridge.missions.detail(m.id).timeline;assert.ok(timeline.some(e=>e.event_type==='verification.completed'));
});
test('bounded context, changed executable and forged provenance cannot grant execution evidence',async t=>{
 const f=runtime(t);
 await assert.rejects(f.adapter.execute({...f.request,objective:'x'.repeat(12001)}),/context_bound/);
 assert.throws(()=>f.adapter.assertEvidence({agent_id:'opencode',state:'completed',termination_verified:true,result:{opencode_provenance:{authority:true}}}),/provenance_unavailable/);
 const output=await f.adapter.execute(f.request),run={agent_id:'opencode',state:'completed',termination_verified:true,result:{opencode_provenance:output.provenance}};
 f.adapter.assertEvidence(run);fs.appendFileSync(f.options.executable,'\n// altered fixture\n');assert.throws(()=>f.adapter.assertEvidence(run),/provenance_unavailable/);
});
