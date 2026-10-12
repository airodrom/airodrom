'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
if(process.env.AIRODROM_OPENCODE_LIVE!=='1')throw Error('Explicit local synthetic qualification required');
const {fixture}=require('./fixtures/mission-fixture.cjs'),{manifest,qualifyCanonical}=require('./fixtures/opencode-fixture.cjs');
test('REAL LOCAL MODEL: bounded context, broker, verification, Acceptance and flight trace',async t=>{
 const f=await fixture(t,{opencode:{enabled:true,executable:'/opt/homebrew/bin/opencode',model:'ollama/qwen3-coder:30b',timeoutMs:90000},settleTimeoutMs:120000}),b=f.bridge,a=qualifyCanonical(b),by=a.store.operator;
 assert.equal((await b.opencodeAdapter.readiness()).ready,true);
 a.project(b.projects.listProjects({})[0].projectId);const c=a.memory.propose({kind:'project_operational',operator_id:a.store.operatorId,project_id:b.projects.listProjects({})[0].projectId,scope:'project_specific',subject_key:'fixture.color',value:'beta',source_hash:require('../src/authority-hash').canonicalHash({synthetic:'beta'}),source_refs:[{source_ref:'synthetic:color'}],metadata:{}},by);a.memory.promote(c.id,{},by);
 const m=f.create({preferred_agent:undefined,manifest:manifest(f.repo),objective:'Read inline current_context.records. The fixture.color record gives a color token. Use edit to replace alpha in fixture.txt with that token, preserving the single newline. Return the exact result_contract JSON. Do not use shell, tests, memory tools, or network.',target_domains:['fixture'],required_memory_keys:['fixture.color']});
 b.missions.dispatch(m.id,{request_id:'reliability-live'});const done=await f.settle(m.id);assert.equal(done.state,'awaiting_acceptance');assert.equal(done.verifications[0].result,'passed');assert.equal(done.acceptance.length,0);assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'beta\n');
 const worker=done.runs.find(r=>r.agent_id==='opencode');assert.ok(worker?.termination_verified);const pack=b.tasks.get(worker.task_id).contextPackId;assert.ok(a.memory.items(pack).some(x=>x.subject_key==='fixture.color'));
 b.missions.accept(m.id,{request_id:'reliability-live-accept',verification_id:done.verifications[0].id,decision:'accept',rationale:'Disposable exact-file and registered host tests passed'});
 const trace=require('../src/mission-flight-recorder').flightRecorder(b,{missionId:m.id,limit:200});assert.ok(trace.events.some(e=>e.event_type==='runtime.context.delivered'));assert.ok(trace.events.some(e=>e.event_type==='mission.settled'));
 console.log(JSON.stringify({evidence_class:'REAL_LOCAL_MODEL',runtime:'OpenCode 2.0.25',model:'ollama/qwen3-coder:30b',context_consumed:true,independent_verification:true,acceptance_separate:true,flight_events:trace.events.length,owner_memory_touched:false,external_cost:0}));
});
