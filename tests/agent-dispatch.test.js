'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,wait}=require('./fixtures/mission-fixture.cjs');
const {classifyCodexDispatchOutcome:classify,safeTransportUrl}=require('../src/transport-outcome');
const {redactText,safeValue}=require('../src/secret-observation');
const {McpTools}=require('../src/mcp-tools');
const {fingerprint}=require('../src/control-plane-store');
for(const [name,input,expected,effects]of [
 ['accepted',{accepted:true},'accepted',false],['rejected',{accepted:false,code:'rejected_by_transport'},'rejected_by_transport',true],['reasonless rejection',{accepted:false},'rejected_by_transport',true],['busy',{accepted:false,code:'busy'},'busy',true],['unavailable',{accepted:false,code:'temporarily_unavailable'},'temporarily_unavailable',true],['auth required',{accepted:false,code:'auth_required'},'auth_required',true],['quota limited',{accepted:false,code:'quota_limited'},'quota_limited',true],['unknown outcome',{},'unknown_outcome',false],['already active',{accepted:false,code:'already_active'},'already_active',false],['contradictory accepted',{accepted:true,code:'busy'},'unknown_outcome',false],['policy denied',{accepted:false,code:'policy_denied'},'policy_denied',true],['unproven busy',{code:'busy'},'unknown_outcome',false]])test(`transport classification: ${name}`,()=>{const x=classify(input);assert.equal(x.classification,expected);assert.equal(x.no_side_effects,effects);if(name==='reasonless rejection')assert.equal(x.reason_known,false);});

// ADR 0065 retires automatic Codex dispatch/retry/fallback. Historical receipt,
// uncertainty, secrecy and reconciliation coverage remains active below.
const {seedHistoricalHandoff}=require('./fixtures/historical-codex-fixture.cjs');
async function setup(t,status='dispatching',extra={}){
 const f=await fixture(t),m=f.create({preferred_agent:'codex',...extra}),h=seedHistoricalHandoff(f,m,'historical-dispatch',{status});
 let now=Date.now();f.bridge.agentDispatch.now=()=>now;
 return{f,m,h,get d(){return f.bridge.agentDispatch;},get r(){return f.bridge.agentDispatch.get(h.run_id);},advance:n=>{now+=n;},clock:()=>now};
}
const n=(s,table,where='')=>s.f.bridge.controlStore.db.prepare('SELECT count(*) n FROM '+table+' '+where).get().n;
const claim=s=>s.d.claim({dispatch_id:s.r.dispatch_id});
const report=(s,outcome)=>s.d.report({dispatch_id:s.r.dispatch_id,attempt_id:s.r.active_attempt_id,outcome});
for(const fallback_agents of [[],['claude_code'],['host'],['cursor']])test('new Codex handoff cannot dispatch or fall back: '+fallback_agents.join(','),async t=>{
 const f=await fixture(t),m=f.create({preferred_agent:'codex',fallback_agents});
 for(const start of [()=>f.bridge.missions.dispatch(m.id,{request_id:'mission'}),()=>f.bridge.codexAdapter.startTask(m.id,'handoff')])assert.throws(start,/CURSOR_IMPLEMENTATION_REQUIRED/);
 for(const table of ['cp_runs','cp_leases','cp_codex_handoffs','cp_agent_dispatch_intents'])assert.equal(n({f},table),0);
 assert.equal(f.calls(),0);
});
for(const status of ['dispatch_pending_external','retry_wait','waiting'])test('historical '+status+' cannot allocate a new attempt after upgrade or restart',async t=>{
 const s=await setup(t,status),id=s.r.dispatch_id,policy=s.r.policy_hash;
 await s.d.reconcile();assert.equal(s.r.wait_reason,'CURSOR_IMPLEMENTATION_REQUIRED');assert.equal(claim(s).state,'WAIT');
 s.advance(3600000);s.d.observeAvailability({state:'available'});await s.d.reconcile();assert.equal(n(s,'cp_agent_dispatch_attempts'),0);
 await s.f.reopen();await s.d.reconcile();assert.equal(s.r.dispatch_id,id);assert.equal(s.r.policy_hash,policy);assert.equal(claim(s).state,'WAIT');
 assert.equal(n(s,'cp_dispatches'),0);assert.equal(s.r.selected_fallback,null);assert.equal(s.f.calls(),0);
});
for(const [name,outcome] of [['accepted',{accepted:true}],['rejected',{accepted:false}],['busy',{accepted:false,code:'busy'}],['unavailable',{accepted:false,code:'temporarily_unavailable'}],['auth',{accepted:false,code:'auth_required'}],['quota',{accepted:false,code:'quota_limited'}],['unknown',{}],['invalid',{accepted:false,code:'invalid_request'}],['policy',{accepted:false,code:'policy_denied'}]])test('late historical '+name+' receipt is immutable and cannot authorize another attempt',async t=>{
 const s=await setup(t),attempt=s.r.active_attempt_id;report(s,outcome);assert.equal(report(s,outcome).duplicate,true);
 assert.throws(()=>report(s,outcome.accepted?{accepted:false,code:'policy_denied'}:{accepted:true}),/conflict/);
 await Promise.all([s.d.reconcile(),s.d.reconcile()]);s.advance(3600000);await s.d.reconcile();
 assert.equal(n(s,'cp_agent_dispatch_attempts'),1);assert.equal(s.r.active_attempt_id,attempt);assert.equal(s.r.selected_fallback,null);assert.notEqual(claim(s).state,'dispatching');
 assert.equal(n(s,'cp_dispatches'),0);assert.equal(n(s,'cp_result_inbox'),0);assert.equal(s.f.calls(),0);
 if(classify(outcome).no_side_effects)assert.equal(n(s,'cp_leases',"WHERE state IN ('held','quarantined')"),0);
 else assert.equal(n(s,'cp_leases',"WHERE state IN ('held','quarantined')"),1);
});
for(const status of ['dispatching','accepted','running_unknown'])test('historical '+status+' survives restart without releasing uncertain ownership',async t=>{
 const s=await setup(t,status),id=s.r.dispatch_id;await s.f.reopen();await s.d.reconcile();
 assert.equal(s.r.dispatch_id,id);assert.equal(claim(s).state,'existing_dispatch');assert.equal(n(s,'cp_leases',"WHERE state='quarantined'"),1);
 assert.equal(n(s,'cp_agent_dispatch_attempts'),1);assert.equal(s.r.selected_fallback,null);assert.equal(s.f.calls(),0);
});
test('worker, Slack and memory cannot spoof a historical transport report or change immutable policy',async t=>{
 const s=await setup(t),id=s.r.dispatch_id,attempt=s.r.active_attempt_id;
 for(const actor of ['worker','slack','memory','codex'])assert.throws(()=>s.d.report({dispatch_id:id,attempt_id:attempt,outcome:{accepted:true}},actor),/Trusted/);
 assert.throws(()=>s.d.report({dispatch_id:id,attempt_id:attempt,outcome:{accepted:true},fallback_policy:{}}),/Unexpected/);
 assert.throws(()=>s.d.report({dispatch_id:id,attempt_id:'unknown',outcome:{accepted:true}}),/Unknown/);
 assert.equal(s.r.status,'dispatching');assert.equal(n(s,'cp_acceptances'),0);assert.equal(n(s,'cp_result_inbox'),0);
 const api=new McpTools(s.f.bridge);assert.equal((await api.call('claim_agent_dispatch',{dispatch_id:id})).state,'existing_dispatch');assert.equal((await api.call('get_agent_dispatches',{run_id:s.h.run_id})).items.length,1);
});
test('historical transport receipts remove credentials, process arguments and environment before persistence',async t=>{
 const seed='syntheticOnlySecret789',url=`https://user:${seed}@chatgpt.com/c/00000000-0000-0000-0000-000000000001?token=${seed}#auth=${seed}`;
 for(const value of [safeTransportUrl(url),redactText(url),redactText(encodeURIComponent(url)),JSON.stringify(safeValue({receipt:url}))])assert.ok(!value.includes(seed));
 assert.ok(!safeTransportUrl(`https://chatgpt.com/${seed}`).includes(seed));
 const s=await setup(t);report(s,{accepted:true,receipt:{url,argv:['--token',seed],env:{TOKEN:seed}},reason:seed});
 assert.ok(!JSON.stringify(s.d.views()).includes(seed));assert.ok(!JSON.stringify(s.f.bridge.ledger.list({missionId:s.m.id,limit:100}).events).includes(seed));
});
test('historical accepted handoff publishes once; only trusted termination resumes independent verification',async t=>{
 const s=await setup(t,'accepted');await s.f.reopen();fs.writeFileSync(path.join(s.f.repo,'fixture.txt'),'beta\n');const h=s.h.contract;
 const e={schema_version:'codex-result-v1',mission_id:h.mission_id,task_id:h.task_id,run_id:h.run_id,request_id:h.request_id,agent_id:'codex',transport:'handoff',relay_nonce:h.relay_nonce,result:{status:'completed',summary:'Recovered fixture',changed_files:['fixture.txt'],tests:[],artifacts:[],limitations:[]},timestamps:{started_at:1,finished_at:2},publisher:{identity:'codex-work',mode:'artifact'}};e.content_hash=fingerprint(e);
 for(let i=0;i<2;i++){fs.writeFileSync(h.result_publication.path,JSON.stringify(e),{mode:0o600});s.f.bridge.codexRelay.consume(h.run_id);}
 assert.equal(n(s,'cp_result_inbox'),1);assert.equal(n(s,'cp_verifications'),0);assert.equal(n(s,'cp_leases',"WHERE state='quarantined'"),1);
 s.f.bridge.codexAdapter.reconcile({run_id:h.run_id,termination_verified:true});s.f.ensureAdmission();await s.f.settle(s.m.id);
 assert.equal(n(s,'cp_verifications'),1);assert.equal(n(s,'cp_acceptances'),0);assert.equal(s.r.status,'completed_transport');assert.equal(n(s,'cp_leases',"WHERE state IN ('held','quarantined')"),0);
});
test('missing historical transport receipt becomes uncertainty; timeout never implies rejection',async t=>{
 const s=await setup(t);s.advance(120001);await s.d.reconcile();assert.equal(s.r.status,'running_unknown');assert.equal(s.r.no_side_effects,false);assert.equal(claim(s).state,'existing_dispatch');assert.equal(n(s,'cp_agent_dispatch_attempts'),1);
});
test('cancellation preserves the historical writer until observed termination, including restart',async t=>{
 const s=await setup(t,'accepted');s.f.bridge.missions.cancel(s.m.id,{request_id:'cancel-historical'});assert.equal(s.r.status,'cancel_requested');assert.equal(s.f.bridge.controlStore.run(s.h.run_id).termination_verified,0);
 await s.f.reopen();await s.d.reconcile();assert.equal(s.r.status,'cancel_requested');assert.equal(n(s,'cp_leases',"WHERE state='quarantined'"),1);assert.equal(n(s,'cp_result_inbox'),0);
});
test('safe receipt sanitizer handles twice encoded URLs and never exports argv/environment fields',()=>{
 const seed='fakeReceiptValue456',url=`https://user:${seed}@chatgpt.com/?state=${seed}#${seed}`;assert.ok(!redactText(encodeURIComponent(encodeURIComponent(url))).includes(seed));
 const out=classify({accepted:true,receipt:{url,thread_id:seed,work_ref:seed,argv:seed,env:seed}});assert.ok(!JSON.stringify(out).includes(seed));assert.ok(!Object.hasOwn(out.receipt,'argv'));
});
test('safe runtime diagnostics export only whitelisted health, refuse non-loopback discovery and never return private URLs',async t=>{
 const os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'safe-discovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const seed='syntheticLocalDiscovery123',write=url=>fs.writeFileSync(path.join(root,'ui.json'),JSON.stringify({url}),{mode:0o600});write(`http://127.0.0.1:1234/#token=${seed}`);
 const {status}=require('../scripts/harness-safe-status.cjs');let calls=0;const result=await status({runtime:root,request:async(url,options)=>{calls++;assert.equal(url,'http://127.0.0.1:1234/api/control-v2/health');assert.equal(options.redirect,'error');return{ok:true,json:async()=>({bridge:{healthy:true,mcp_ready:true,pid:123},secret:seed,url:`http://127.0.0.1/#token=${seed}`})};}});assert.equal(result.healthy,true);assert.ok(!JSON.stringify(result).includes(seed));write(`https://example.com/#token=${seed}`);await assert.rejects(()=>status({runtime:root,request:async()=>{calls++;}}),/Loopback/);assert.equal(calls,1);
});
