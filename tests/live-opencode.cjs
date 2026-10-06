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
 const f=await fixture(t,{opencode:options}),a=f.bridge.opencodeAdapter,canonical=qualifyCanonical(f.bridge);assert.equal(canonical.routing,true);
 assert.equal((await a.readiness()).version,'2.0.20');assert.equal((await a.readiness()).auth_state,'local_not_required');
 const read=await a.execute({workspace:f.repo,files:['fixture.txt'],objective:'Read fixture.txt and return JSON with summary equal to its trimmed content, changed_files:[],tests:[],artifacts:[],limitations:[]',timeoutMs:90000});
 assert.equal(read.result.summary,'alpha');assert.equal(read.changes.length,0);
 const m=f.create({preferred_agent:'opencode',fallback_agents:[],dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'focused_coding'},manifest:manifest(f.repo)});
 f.bridge.missions.dispatch(m.id,{request_id:'live-opencode-fixture'});
 const deadline=Date.now()+120000;let done;
 while(Date.now()<deadline){await f.bridge.missions.tick();done=f.bridge.missions.detail(m.id);if(['awaiting_acceptance','needs_rework','blocked'].includes(done.state))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(done.state,'awaiting_acceptance',JSON.stringify({state:done.state,reason:done.reason,checks:done.verifications[0]?.checks}));assert.equal(done.verifications[0].result,'passed');assert.equal(done.dispatches[0].route.selected,'opencode');assert.ok(done.dispatches[0].route.authority_routing_decision_id);assert.equal(canonical.store.listAcceptancesForMission(m.id).length,0);
 const implementation=done.runs.find(r=>r.agent_id==='opencode');assert.equal(implementation.termination_verified,1);assert.equal(implementation.result.artifacts[0].path,'fixture.txt');assert.equal(done.acceptance.length,0);
 assert.throws(()=>f.bridge.missions.program.settle(m.id,'accept'),/Settlement requires/);
 f.bridge.missions.accept(m.id,{request_id:'live-opencode-accept',verification_id:done.verifications[0].id,decision:'accept',rationale:'Independent synthetic repository checks passed'});
 assert.equal(f.bridge.missions.detail(m.id).program_contract.settlement.state,'settled');assert.equal(canonical.store.listAcceptancesForMission(m.id).length,1);assert.equal(canonical.store.integrity().ok,true);
 console.log(JSON.stringify({runtime_version:read.provenance.runtime_version,executable_sha256:read.provenance.executable_sha256,model:options.model,read_only:true,edit:true,artifact_return:true,registered_test:true,independent_verification:true,acceptance:true,settlement:true,private_memory_inspected:false}));qualification=true;
});
test('LIVE canonical synthetic personal Memory V2 delivery, correction, forget/erase and no session override',async t=>{
 assert.equal(qualification,true,'Runtime qualification must precede memory qualification');
 const f=await fixture(t,{opencode:options}),b=f.bridge,a=b.authorityRuntime,by=a.store.operator,runtime=b.opencodeAdapter;
 a.qualification.prepare(by);const c=a.memory.ingest({session_id:'synthetic-live',chunk_id:'synthetic-preference',timestamp:1,speaker:'operator',claim:'No micro-prompts.',kind:'personal_preference',subject_key:'workflow.micro_prompts',value:'forbidden'},by),seed=a.memory.promote(c.id,{},by);a.qualification.proveMemory(seed.id,by);
 const old=b.rememberPersonalMemory({domain:'personal',type:'preference',subject:'fixture.color',content:'Synthetic fixture color is azure.',source:'user_explicit',confidence:95,sensitivity:'normal'});
 const retrieve=()=>a.memory.build({operator_id:a.store.operatorId,include_personal:true,required_keys:['fixture.color'],domains:['fixture'],privacy:'internal',max_items:1,max_bytes:2000});
 const run=context=>runtime.execute({workspace:f.repo,files:[],objective:'Return one JSON object with summary equal to ONLY the current fixture color word (azure or amber). If current_context has no fixture color, summary must be unavailable. changed_files:[],tests:[],artifacts:[],limitations:[]',context,timeoutMs:90000});
 const first=retrieve();assert.equal(first.items.length,1);assert.equal((await run({id:first.id})).result.summary,'azure');
 // A supplied fabricated cache cannot change canonical content.
 assert.equal((await run({id:first.id,records:[{subject:'fixture.color',content:'Synthetic fixture color is violet.'}]})).result.summary,'azure');
 const current=b.updatePersonalMemory(old.id,{content:'Synthetic fixture color is amber.'});await assert.rejects(run({id:first.id}),/unavailable|erased|context/i);
 const second=retrieve();assert.equal((await run({id:second.id})).result.summary,'amber');
 b.forgetPersonalMemory(current.id);assert.equal(retrieve().state,'WAIT');await assert.rejects(run({id:second.id}),/unavailable|erased|context/i);
 assert.equal((await run(null)).result.summary,'unavailable');
 await assert.rejects(runtime.execute({workspace:f.repo,files:[],objective:'Recover cached memory',sessionId:'ses_previous',timeoutMs:1000}),/session_reuse_denied/);
 // Independent OS canary: direct SQLite bytes cannot enter the runtime boundary.
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencode-memory-denial-')));
 try{for(const d of ['workspace','config','state'])fs.mkdirSync(path.join(root,d));const executable=fs.realpathSync('/usr/bin/sqlite3'),profile=sandboxProfile(root,executable,[]),db=path.join(f.root,'data/memory.sqlite');
 const probe=cp.spawnSync('/usr/bin/sandbox-exec',['-p',profile,executable,'-readonly',db,'SELECT value_json FROM authority_memories'],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin'}});assert.equal(probe.status,1);assert.equal(probe.stdout,'');assert.match(probe.stderr,/unable to open database|permission|authorization/i);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
 a.memory.erase(old.id,by);a.memory.erase(current.id,by);b.forgetPersonalMemory(seed.id);assert.equal(a.memory.get(current.id).status,'forgotten');assert.doesNotMatch(JSON.stringify(a.memory.get(current.id)),/azure|amber/);assert.equal(retrieve().state,'WAIT');await assert.rejects(run({id:second.id}),/unavailable|erased|context/i);assert.equal((await run(null)).result.summary,'unavailable');
 console.log(JSON.stringify({canonical_memory_v2:true,synthetic_only:true,remember:true,bounded_retrieve:true,minimum_context_delivery:true,live_correct_answer:true,db_access_denied:true,correction:true,forget:true,canonical_erasure:true,erased_context_denied:true,cache_override_denied:true,session_reuse_denied:true,cleanup:true,real_private_memory_inspected:false}));
});
test('LIVE timeout/cancel terminate the private runtime without changing the original fixture',async t=>{
 const f=await fixture(t,{opencode:options}),a=f.bridge.opencodeAdapter,request={workspace:f.repo,files:['fixture.txt'],objective:'Read fixture.txt and answer with the full bounded result JSON',timeoutMs:100};
 await assert.rejects(a.execute(request),/opencode_timeout/);
 const controller=new AbortController(),pending=a.execute({...request,timeoutMs:90000,signal:controller.signal});setTimeout(()=>controller.abort(),500);await assert.rejects(pending,/opencode_cancelled/);
 assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');
});
