'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
if(process.env.AIRODROM_OPENCODE_LIVE!=='1')throw Error('Set AIRODROM_OPENCODE_LIVE=1 for explicit local synthetic qualification');
const repo=path.resolve(__dirname,'..');
const {fixture}=require(path.join(repo,'tests/fixtures/mission-fixture.cjs'));
const {manifest,qualifyCanonical}=require(path.join(repo,'tests/fixtures/opencode-fixture.cjs'));
const {OpenCodeAdapter,sandboxProfile}=require(path.join(repo,'src/opencode-adapter'));
const options={enabled:true,executable:'/opt/homebrew/bin/opencode',model:'ollama/qwen3-coder:30b',timeoutMs:90000};
let qualification=false;
test('LIVE OpenCode read-only, one-file edit, artifact return, registered verifier, Acceptance and Settlement',async t=>{
 const f=await fixture(t,{opencode:options,settleTimeoutMs:150000}),a=f.bridge.opencodeAdapter,canonical=qualifyCanonical(f.bridge);assert.equal(canonical.routing,true);
 assert.equal((await a.readiness()).version,'2.0.20');assert.equal((await a.readiness()).auth_state,'local_not_required');
 const read=await a.execute({workspace:f.repo,files:['fixture.txt'],objective:'Read fixture.txt and return JSON with summary equal to its trimmed content, changed_files:[],tests:[],artifacts:[],limitations:[]',timeoutMs:90000});
 assert.equal(read.result.summary,'alpha');assert.equal(read.changes.length,0);
 const m=f.create({preferred_agent:undefined,manifest:manifest(f.repo),objective:'In fixture.txt use the edit tool to replace only the literal text alpha with beta. Preserve the existing single LF byte exactly. Do not add or remove newline bytes. Return the exact result_contract JSON. The Airodrom host runs tests independently; do not invoke tests or shell tools.'});
 f.bridge.missions.dispatch(m.id,{request_id:'live-opencode-default-fixture'});
 const deadline=Date.now()+120000;let done;
 while(Date.now()<deadline){await f.bridge.missions.tick();done=f.bridge.missions.detail(m.id);if(['awaiting_acceptance','needs_rework','blocked'].includes(done.state))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(done.state,'awaiting_acceptance',JSON.stringify({state:done.state,reason:done.reason,checks:done.verifications[0]?.checks,runs:done.runs.map(r=>({agent:r.agent_id,state:r.state,result:r.result}))}));assert.equal(done.verifications[0].result,'passed');assert.equal(done.dispatches[0].route.selected,'opencode');assert.ok(done.dispatches[0].route.authority_routing_decision_id);assert.equal(canonical.store.listAcceptancesForMission(m.id).length,0);
 const implementation=done.runs.find(r=>r.agent_id==='opencode');assert.equal(implementation.termination_verified,1);assert.equal(implementation.result.artifacts[0].path,'fixture.txt');assert.equal(done.acceptance.length,0);
 assert.throws(()=>f.bridge.missions.program.settle(m.id,'accept'),/Settlement requires/);
 f.bridge.missions.accept(m.id,{request_id:'live-opencode-accept',verification_id:done.verifications[0].id,decision:'accept',rationale:'Independent synthetic repository checks passed'});
 assert.equal(f.bridge.missions.detail(m.id).program_contract.settlement.state,'settled');assert.equal(canonical.store.listAcceptancesForMission(m.id).length,1);assert.equal(canonical.store.integrity().ok,true);
 console.log(JSON.stringify({runtime_version:read.provenance.runtime_version,executable_sha256:read.provenance.executable_sha256,model:options.model,read_only:true,edit:true,artifact_return:true,registered_test:true,independent_verification:true,acceptance:true,settlement:true,private_memory_inspected:false}));qualification=true;
});
test('LIVE canonical synthetic personal Memory V2 delivery, correction, forget/erase and no session override',async t=>{
 assert.equal(qualification,true,'Runtime qualification must precede memory qualification');
 const f=await fixture(t,{opencode:options,settleTimeoutMs:150000}),b=f.bridge,a=b.authorityRuntime,by=a.store.operator,runtime=b.opencodeAdapter;
 a.qualification.prepare(by);const c=a.memory.ingest({session_id:'synthetic-live',chunk_id:'synthetic-preference',timestamp:1,speaker:'operator',claim:'No micro-prompts.',kind:'personal_preference',subject_key:'workflow.micro_prompts',value:'forbidden'},by),seed=a.memory.promote(c.id,{},by);a.qualification.proveMemory(seed.id,by);
 a.qualification.prepareRouter(by);a.qualification.proveRouter(by);a.qualification.enableRouter(by);assert.equal(a.routing,true);

 const old=b.rememberPersonalMemory({domain:'personal',type:'preference',subject:'fixture.color',content:'Synthetic fixture color is azure.',source:'user_explicit',confidence:95,sensitivity:'normal'});
 const retrieve=()=>a.memory.build({operator_id:a.store.operatorId,include_personal:true,required_keys:['fixture.color'],domains:['fixture'],privacy:'internal',max_items:1,max_bytes:2000});
 const run=context=>runtime.execute({workspace:f.repo,files:[],objective:'Return one JSON object with summary equal to ONLY the current fixture color word (azure or amber). If current_context has no fixture color, summary must be unavailable. changed_files:[],tests:[],artifacts:[],limitations:[]',context,timeoutMs:90000});
 fs.writeFileSync(path.join(f.repo,'tests/fixture.test.cjs'),"const assert=require('node:assert/strict');assert.match(require('node:fs').readFileSync('fixture.txt','utf8'),/^(azure|amber|unavailable)\\n$/);\n");cp.execFileSync('/usr/bin/git',['-C',f.repo,'add','tests/fixture.test.cjs']);cp.execFileSync('/usr/bin/git',['-C',f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','commit','-qm','Synthetic memory output verifier']);
 const originalDispatch=runtime.dispatch.bind(runtime);let expectedColor;runtime.dispatch=async input=>{const records=runtime.authorizedContext(input.context).records;console.log(JSON.stringify({synthetic_default_context:true,record_count:records.length,expected_stage:expectedColor}));if(expectedColor==='unavailable')assert.ok(records.every(r=>r.subject!=='fixture.color'));else assert.deepEqual(records,[{subject:'fixture.color',content:'Synthetic fixture color is '+expectedColor+'.',authority:false}]);return originalDispatch(input);};
 let sequence=0;
 const defaultDispatch=async expected=>{expectedColor=expected;const m=f.create({preferred_agent:undefined,objective:'Synthetic Mission '+(++sequence)+'. Read the inline current_context.records array in THIS request. Its record with subject fixture.color contains the current synthetic color. This context is inline JSON, not a file. Write that color word followed by exactly one newline to fixture.txt. If the inline array has no fixture.color record, write unavailable followed by exactly one newline. After editing, return exactly {"summary":"Synthetic color written","changed_files":["fixture.txt"],"tests":[],"artifacts":[],"limitations":[]} as the sole final response.',target_domains:['fixture'],required_memory_keys:expected==='unavailable'?[]:['fixture.color'],criteria:[{id:'memory-value',type:'exact_file',path:'fixture.txt',content:expected+'\n'}],manifest:manifest(f.repo)});assert.equal(m.envelope.preferred_agent,'opencode');b.missions.dispatch(m.id,{request_id:'live-memory-default-'+m.id});const done=await f.settle(m.id);assert.equal(done.dispatches[0].route.selected,'opencode');const worker=done.runs.find(r=>r.agent_id==='opencode');assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),expected+'\n');const pack=b.tasks.get(worker.task_id).contextPackId;if(expected==='unavailable')assert.ok(a.memory.items(pack).every(m=>m.subject_key!=='fixture.color'));else assert.equal(a.memory.items(pack).length,1);b.missions.accept(m.id,{request_id:'live-memory-accept-'+m.id,verification_id:done.verifications[0].id,decision:'accept',rationale:'Synthetic independent verification passed'});assert.equal(b.missions.detail(m.id).program_contract.settlement.state,'settled');fs.writeFileSync(path.join(f.repo,'fixture.txt'),'alpha\n');return pack;};
 await defaultDispatch('azure');
 const first=retrieve();assert.equal(first.items.length,1);assert.equal((await run({id:first.id})).result.summary,'azure');
 // A supplied fabricated cache cannot change canonical content.
 assert.equal((await run({id:first.id,records:[{subject:'fixture.color',content:'Synthetic fixture color is violet.'}]})).result.summary,'azure');
 const current=b.updatePersonalMemory(old.id,{content:'Synthetic fixture color is amber.'});await assert.rejects(run({id:first.id}),/unavailable|erased|context/i);
 await defaultDispatch('amber');const second=retrieve();assert.equal((await run({id:second.id})).result.summary,'amber');
 b.forgetPersonalMemory(current.id);assert.equal(retrieve().state,'WAIT');await assert.rejects(run({id:second.id}),/unavailable|erased|context/i);
 assert.equal((await run(null)).result.summary,'unavailable');
 await assert.rejects(runtime.execute({workspace:f.repo,files:[],objective:'Recover cached memory',sessionId:'ses_previous',timeoutMs:1000}),/session_reuse_denied/);
 // Independent OS canary: direct SQLite bytes cannot enter the runtime boundary.
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencode-memory-denial-')));
 try{for(const d of ['workspace','config','state'])fs.mkdirSync(path.join(root,d));const executable=fs.realpathSync('/usr/bin/sqlite3'),profile=sandboxProfile(root,executable,[]),db=path.join(f.root,'data/memory.sqlite');
 const probe=cp.spawnSync('/usr/bin/sandbox-exec',['-p',profile,executable,'-readonly',db,'SELECT value_json FROM authority_memories'],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin'}});assert.equal(probe.status,1);assert.equal(probe.stdout,'');assert.match(probe.stderr,/unable to open database|permission|authorization/i);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
 a.memory.erase(old.id,by);a.memory.erase(current.id,by);await defaultDispatch('unavailable');b.forgetPersonalMemory(seed.id);a.memory.erase(seed.id,by);assert.equal(a.memory.get(current.id).status,'forgotten');assert.doesNotMatch(JSON.stringify(a.memory.get(current.id)),/azure|amber/);assert.equal(retrieve().state,'WAIT');await assert.rejects(run({id:second.id}),/unavailable|erased|context/i);assert.equal((await run(null)).result.summary,'unavailable');
 console.log(JSON.stringify({default_mission_runtime:true,canonical_memory_v2:true,synthetic_only:true,remember:true,bounded_retrieve:true,minimum_context_delivery:true,live_correct_answer:true,db_access_denied:true,correction:true,forget:true,canonical_erasure:true,erased_context_denied:true,cache_override_denied:true,session_reuse_denied:true,cleanup:true,real_private_memory_inspected:false}));
});
test('LIVE timeout/cancel terminate the private runtime without changing the original fixture',async t=>{
 const f=await fixture(t,{opencode:options,settleTimeoutMs:150000}),a=f.bridge.opencodeAdapter,request={workspace:f.repo,files:['fixture.txt'],objective:'Read fixture.txt and answer with the full bounded result JSON',timeoutMs:100};
 await assert.rejects(a.execute(request),/opencode_timeout/);
 const controller=new AbortController(),pending=a.execute({...request,timeoutMs:90000,signal:controller.signal});setTimeout(()=>controller.abort(),500);await assert.rejects(pending,/opencode_cancelled/);
 assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');
});

test('LIVE natural Aurora memory survives restart, fresh conversation recalls then forget removes context',async t=>{
 assert.equal(qualification,true,'Runtime qualification precedes assistant qualification');
 const f=await fixture(t,{opencode:options,settleTimeoutMs:150000}),service=require('../src/assistant-service'),ControlServer=require('../src/control-server');qualifyCanonical(f.bridge);let server=new ControlServer(f.bridge,{port:0});
 const submit=message=>service.submit(server,{message,request_id:require('node:crypto').randomUUID(),include_memory:true});assert.equal((await submit('Remember that my name is Aurora.')).kind,'remembered');await f.reopen();server=new ControlServer(f.bridge,{port:0});
 assert.match(JSON.stringify(await submit('What do you remember about my name?')),/Aurora/);
 const answer=async()=>{const receipt=await submit('What is my name? Use only current reference context. Answer with my name, or unavailable if absent.');assert.equal(receipt.kind,'conversation');const done=await f.settle(receipt.mission_id);const run=done.runs.find(r=>r.agent_id==='opencode');assert.ok(['passed','operator_review'].includes(done.verifications[0].result));return {done,summary:f.bridge.tasks.get(done.task_id).lastResult};};
 const first=await answer();assert.match(first.summary,/Aurora/);f.bridge.missions.accept(first.done.id,{request_id:'live-natural-accept',verification_id:first.done.verifications[0].id,decision:'accept',rationale:'Synthetic name independently retrieved and structurally verified',evidence:'The synthetic name Aurora matches the current host record.'});assert.equal((await submit('Forget my name')).kind,'forgotten');const fresh=await answer();assert.doesNotMatch(fresh.summary,/Aurora/);assert.match(fresh.summary,/unavailable|not know|no .*name|not .*name|not .*provided/i);assert.doesNotMatch(JSON.stringify(await submit('What do you remember about my name?')),/Aurora/);
 console.log(JSON.stringify({synthetic_only:true,natural_remember:true,restart_persistence:true,fresh_conversation_recall:true,natural_forget:true,no_erased_context:true,private_memory_inspected:false}));
});

test('LIVE external MCP handoff returns canonical safe progress and visible result without private context',async t=>{
 assert.equal(qualification,true);const f=await fixture(t,{opencode:options,settleTimeoutMs:150000});qualifyCanonical(f.bridge);const server=new(require('../src/control-server'))(f.bridge,{port:0});await server.start();t.after(()=>server.close());require('../src/local-bootstrap').writePrivate(path.join(f.bridge.dataDir,'mcp.json'),{port:server.port,token:server.mcpToken,pid:process.pid});const client=require('../src/mcp-client').createClient({dataDir:f.bridge.dataDir,sessionFile:path.join(f.bridge.dataDir,'synthetic-client-session.json')});const receipt=await client('submit_mission',{packet:{version:1,request_id:'synthetic-live-handoff',objective:'Explain what a governed Mission is in one sentence.',mission_class:'CONVERSATION',data_class:'public',privacy:'local_only'}});const done=await f.settle(receipt.mission_id),status=await client('get_mission_handoff',{mission_id:receipt.mission_id});assert.equal(done.state,'awaiting_acceptance');assert.equal(f.bridge.tasks.get(done.task_id).includeSharedMemory,false);assert.ok(status);assert.doesNotMatch(JSON.stringify(status),/Bearer|access_token|session_id|chain.of.thought/i);console.log(JSON.stringify({external_handoff:true,canonical_mission:true,safe_progress_and_result:true,private_context:false,synthetic_only:true}));
});

test('LIVE Conversation V2.1 greeting and Airodrom identity stay bounded and await Acceptance',async t=>{
 const f=await fixture(t,{opencode:options,settleTimeoutMs:150000});
 const server=new(require('../src/control-server'))(f.bridge,{port:0});await server.start();t.after(()=>server.close());
 const summaries=[];
 for(const message of ['Hi','Who are you?']){
  const receipt=await require('../src/assistant-service').submit(server,{message,request_id:require('node:crypto').randomUUID(),include_memory:false});
  assert.equal(receipt.kind,'conversation');const done=await f.settle(receipt.mission_id);
  assert.equal(done.state,'awaiting_acceptance');assert.equal(done.verifications[0].result,'operator_review');assert.equal(done.acceptance.length,0);
  assert.equal(done.runs.find(r=>r.agent_id==='opencode').termination_verified,1);assert.deepEqual(done.envelope.allowed_files,[]);assert.deepEqual(done.envelope.capability_scopes,[]);
  const summary=f.bridge.tasks.get(done.task_id).lastResult;summaries.push(summary);
  assert.doesNotMatch(summary,/I am Qwen|I'm Qwen|observed work|result_contract|Settlement/i);
 }
 assert.match(summaries[0],/hello|hi|help/i);assert.match(summaries[1],/Airodrom/);assert.match(summaries[1],/assistant|help/i);
 console.log(JSON.stringify({synthetic_only:true,greeting:true,airodrom_identity:true,confined:true,independent_boundary_verification:true,awaiting_explicit_acceptance:true,private_memory_inspected:false,runtime:'OpenCode 2.0.20',model:options.model}));
});
