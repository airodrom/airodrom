'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {OpenCodeAdapter,version,authCategory,parseOutput,disposableEnv,runtimeConfig}=require('../src/opencode-adapter');
const {fixture}=require('./fixtures/mission-fixture.cjs');
const {runtime,manifest,qualifyCanonical}=require('./fixtures/opencode-fixture.cjs');
function event(result,sessionID='ses_fixture'){return JSON.stringify({type:'text',sessionID,part:{messageID:'m',text:JSON.stringify(result)}})+'\n';}
const result={summary:'observed',changed_files:[],tests:[],artifacts:[],limitations:[]};
test('OpenCode version/auth observation reports categories and fails closed on unknown formats',()=>{
 assert.equal(version('opencode v2.0.20\n'),'2.0.20');assert.equal(version('opencode v2.0.25\n'),'2.0.25');assert.equal(version('token=synthetic'),null);
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
 await assert.rejects(f.adapter.execute({...f.request,objective:'nonzero'}),error=>error.code==='opencode_process_exit_nonzero'&&!error.message.includes('syntheticFailureSecret'));
 for(const objective of ['malformed','escalation'])await assert.rejects(f.adapter.execute({...f.request,objective}),error=>!error.message.includes('syntheticFailureSecret'));
});
test('redaction drops raw runtime tools, credentials and self-attested tests; sessions must correlate',async()=>{
 const parsed=parseOutput(event({...result,summary:'Bearer syntheticResultSecret',tests:[{claimed:'passed'}]}),[]);assert.doesNotMatch(JSON.stringify(parsed),/syntheticResultSecret/);assert.deepEqual(parsed.result.tests,[]);
  // Unknown event types with a valid session are ignored; session mismatch still fails closed.
  assert.deepEqual(parseOutput(event(result)+'{"type":"error","sessionID":"ses_fixture"}\n',[]).result.changed_files,[]);
  assert.throws(()=>parseOutput(event(result)+event(result,'ses_wrong'),[]),/session_mismatch/);
  assert.throws(()=>parseOutput(event({...result,changed_files:['other.txt']}),[]),/malformed/);
  assert.deepEqual(parseOutput(event({summary:'unavailable'}),[]).result.changed_files,[]);
  assert.equal(parseOutput(event({summary:'azure',status:'success'}),[]).result.status,'completed');
  assert.throws(()=>parseOutput(event({summary:'azure',status:'ok'}),[]),/malformed/);
  assert.throws(()=>parseOutput(event({...result,limitations:'untrusted'}),[]),/malformed/);
  assert.equal(parseOutput(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'m',text:'Here is the result:\n'+JSON.stringify(result)+'\n'}})+'\n',[]).result.status,'completed');
});
test('host-observed allowlisted edits recover when worker JSON is malformed', async t => {
  const f = runtime(t);
  const recovered = await f.adapter.execute({ ...f.request, objective: 'edit-without-json', writable: ['fixture.txt'] });
  assert.equal(recovered.changes[0].content, 'beta\n');
  assert.match(recovered.result.summary, /Host observed allowlisted file changes/);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'fixture.txt'), 'utf8'), 'alpha\n');
  await assert.rejects(f.adapter.execute({ ...f.request, objective: 'malformed' }), /opencode_malformed_result/);
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
 const task=f.bridge.tasks.get(done.runs.find(run=>run.agent_id==='opencode').task_id);
 await assert.rejects(f.bridge.opencodeAdapter.dispatch({task,repo:f.repo,prompt:'read',context:{id:'unrelated-pack'}}),/mission_binding/);
 await assert.rejects(f.bridge.opencodeAdapter.dispatch({task,repo:r.workspace,prompt:'read',context:{id:task.contextPackId}}),/mission_binding/);
 const timeline=f.bridge.missions.detail(m.id).timeline;assert.ok(timeline.some(e=>e.event_type==='verification.completed'));
});
test('bounded context, changed executable and forged provenance cannot grant execution evidence',async t=>{
 const f=runtime(t);
 await assert.rejects(f.adapter.execute({...f.request,objective:'x'.repeat(12001)}),/context_bound/);
 assert.throws(()=>f.adapter.assertEvidence({agent_id:'opencode',state:'completed',termination_verified:true,result:{opencode_provenance:{authority:true}}}),/provenance_unavailable/);
 const output=await f.adapter.execute(f.request),run={agent_id:'opencode',state:'completed',termination_verified:true,result:{opencode_provenance:output.provenance}};
 f.adapter.assertEvidence(run);await assert.rejects(f.adapter.execute({...f.request,objective:'change-executable'}),/executable_changed/);fs.appendFileSync(f.options.executable,'\n// altered fixture\n');assert.throws(()=>f.adapter.assertEvidence(run),/provenance_unavailable/);
});


test('host-bound cognitive coordinates survive scanning while identical prose stays sensitive',async t=>{
 const C=require('../src/cognitive-contracts'),{createHash,randomUUID}=require('node:crypto'),{containsSecret}=require('../src/personal-memory');
 const digest=createHash('sha256').update('synthetic-policy-digest-fixture-508').digest('hex');assert.equal(containsSecret(digest),true);
 const eventOf=value=>JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'m',text:JSON.stringify(value)}})+'\n';
 const proposal={version:3,request_id:randomUUID(),envelope_hash:digest,files:['fixture.txt'],tasks:[{id:'inspect',worker:'opencode',role:'review',operation:'read',paths:['fixture.txt'],description:'Inspect supplied file',depends_on:[],verification:[]}],verification:['fixture-test'],complexity:'bounded'};
 const echo={kind:'planning',version:3,request_id:proposal.request_id,envelope_hash:digest};
 assert.equal(parseOutput(eventOf(proposal),[],{planning:true,echo}).result.summary,JSON.stringify(proposal));
 assert.throws(()=>parseOutput(eventOf(proposal),[],{planning:true}),/sensitive_context/);
 assert.throws(()=>parseOutput(eventOf(proposal),[],{planning:true,echo:{...echo,envelope_hash:'ab'.repeat(32)}}),/sensitive_context/);
 assert.throws(()=>parseOutput(eventOf({...proposal,tasks:[{...proposal.tasks[0],description:digest}]}),[],{planning:true,echo}),/sensitive_context/);
 assert.throws(()=>parseOutput(eventOf({...proposal,extra_hash:digest}),[],{planning:true,echo}),/sensitive_context/);
 const evaluation={version:1,binding_hash:digest,recommendation:'ready',summary:'Reviewed host evidence'};
 const evaluationEcho={kind:'evaluation',binding_hash:digest,specialist:true};
 assert.equal(parseOutput(eventOf(evaluation),[],{planning:true,echo:evaluationEcho}).result.summary,JSON.stringify(evaluation));
 assert.throws(()=>parseOutput(eventOf({...evaluation,summary:digest}),[],{planning:true,echo:evaluationEcho}),/sensitive_context/);
 assert.throws(()=>parseOutput(eventOf(evaluation),[],{planning:true,echo:{...evaluationEcho,binding_hash:'ab'.repeat(32)}}),/sensitive_context/);
 assert.equal(parseOutput(eventOf({summary:'Malformed planning reply'}),[],{planning:true,echo}).result.summary,JSON.stringify({summary:'Malformed planning reply'}));
 const f=runtime(t),runtimeFile=f.options.fixtureExecutable;
 fs.writeFileSync(runtimeFile,fs.readFileSync(runtimeFile,'utf8').replace("console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'message_fixture',text:JSON.stringify(result)}}));", "if(p.result_contract.envelope_hash||p.coordination)result=p.result_contract;console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'message_fixture',text:JSON.stringify(result)}}));"));
 const body={version:3,request_id:proposal.request_id,caller:'operator',delegation:{policy_id:randomUUID(),policy_hash:'ab'.repeat(32)},repository_id:'synthetic',workspace_id:randomUUID(),git_anchor:'ab'.repeat(20),integrity:{version:1,hash:'ab'.repeat(32),entries:1,bytes:6,exclusions:'host'},permitted_paths:['fixture.txt'],denied_paths:['.git'],operations:['read'],eligible_workers:['opencode'],verification:['fixture-test'],limits:{planning_attempts:2,execution_attempts:3,repair_attempts:2,planning_ms:1000,execution_ms:1000},requested_worker:'opencode',instruction_hash:'ab'.repeat(32),expires_at:Date.now()+60000};
 let envelope;for(let i=0;i<100000;i++){envelope=C.seal({...body,caller:'synthetic-'+i});if(containsSecret(envelope.hash))break;}assert.equal(containsSecret(envelope.hash),true);C.parse('RequestEnvelope',envelope);
 const planning={...proposal,envelope_hash:envelope.hash};
 const planned=await f.adapter.execute({...f.request,planning,planningEnvelope:envelope});assert.equal(JSON.parse(planned.result.summary).envelope_hash,envelope.hash);
 await assert.rejects(f.adapter.execute({...f.request,planning}),/sensitive_context/);
 await assert.rejects(f.adapter.execute({...f.request,planning:{...planning,tasks:[{...planning.tasks[0],description:digest}]},planningEnvelope:envelope}),/sensitive_context/);
 await assert.rejects(f.adapter.execute({...f.request,objectiveProof:{}}),/objective_binding/);
});

test('evaluator scan coordinates require the matching durable host run',async t=>{
 const {randomUUID}=require('node:crypto'),{canonicalHash}=require('../src/authority-hash'),{containsSecret}=require('../src/personal-memory');
 const f=runtime(t),runtimeFile=f.options.fixtureExecutable;
 fs.writeFileSync(runtimeFile,fs.readFileSync(runtimeFile,'utf8').replace("console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'message_fixture',text:JSON.stringify(result)}}));", "if(p.coordination)result=p.result_contract;console.log(JSON.stringify({type:'text',sessionID:'ses_fixture',part:{messageID:'message_fixture',text:JSON.stringify(result)}}));"));
 const mission={id:randomUUID(),task_id:randomUUID()},worker={id:randomUUID(),mission_id:mission.id,task_id:mission.task_id};
 let binding;for(let i=0;i<100000;i++){binding={version:1,mission_id:mission.id,worker_run_id:worker.id,contract_hash:canonicalHash('synthetic-'+i)};if(containsSecret(canonicalHash(binding)))break;}const digest=canonicalHash(binding);assert.equal(containsSecret(digest),true);
 const run={id:randomUUID(),mission_id:mission.id,task_id:mission.task_id,agent_id:'opencode',state:'starting',result:{gateway:{worker_run_id:worker.id,binding,binding_hash:digest}}};
 const b={options:{allowFixtureWorker:true},controlStore:{run:id=>id===run.id?run:id===worker.id?worker:null,requireMission:id=>{assert.equal(id,mission.id);return mission;}}},a=new OpenCodeAdapter(b,f.options);
 const coordination={result_contract:{version:1,binding_hash:digest,recommendation:'ready',summary:'Reviewed host checks'},worker:{agent:'opencode',summary:'Observed supplied file',untrusted:true},tasks:[],host_checks:[]};
 const result=await a.execute({...f.request,coordination,evaluationRunId:run.id});assert.equal(JSON.parse(result.result.summary).binding_hash,digest);
 await assert.rejects(a.execute({...f.request,coordination}),/sensitive_context/);
 await assert.rejects(a.execute({...f.request,coordination,evaluationRunId:randomUUID()}),/evaluation_binding/);
 await assert.rejects(a.execute({...f.request,coordination:{...coordination,worker:{...coordination.worker,summary:digest}},evaluationRunId:run.id}),/sensitive_context/);
});
