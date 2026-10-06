'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,wait}=require('./fixtures/mission-fixture.cjs');
const {classifyCodexDispatchOutcome:classify,safeTransportUrl}=require('../src/transport-outcome');
const {redactText,safeValue}=require('../src/secret-observation');
const {McpTools}=require('../src/mcp-tools');
const {fingerprint}=require('../src/control-plane-store');
const cloud={max_attempts:1,fallback_after_attempts:1,privacy:'cloud_allowed',billing_classes:['subscription'],providers:['anthropic_subscription']};
const local={...cloud,privacy:'local_only',billing_classes:['local'],providers:['local'],task_category:'deterministic_files',native_actions:[{name:'file_write',path:'fixture.txt',content:'beta\n'}]};
async function setup(t,extra={}){const f=await fixture(t),m=f.create({preferred_agent:'codex',...extra}),h=f.bridge.codexAdapter.startTask(m.id,'dispatch-test');let now=Date.now();f.bridge.agentDispatch.now=()=>now;return{f,m,h,get d(){return f.bridge.agentDispatch;},get r(){return f.bridge.agentDispatch.list({run_id:h.run_id})[0];},advance:n=>{now+=n;},clock:()=>now};}
function claim(s){return s.d.claim({dispatch_id:s.r.dispatch_id});}
function report(s,c,outcome){return s.d.report({dispatch_id:s.r.dispatch_id,attempt_id:c.attempt_id,outcome});}
function n(s,table,where=''){return s.f.bridge.controlStore.db.prepare(`SELECT count(*) n FROM ${table} ${where}`).get().n;}
for(const [name,input,expected,effects]of [
 ['accepted',{accepted:true},'accepted',false],['rejected',{accepted:false,code:'rejected_by_transport'},'rejected_by_transport',true],['reasonless rejection',{accepted:false},'rejected_by_transport',true],['busy',{accepted:false,code:'busy'},'busy',true],['unavailable',{accepted:false,code:'temporarily_unavailable'},'temporarily_unavailable',true],['auth required',{accepted:false,code:'auth_required'},'auth_required',true],['quota limited',{accepted:false,code:'quota_limited'},'quota_limited',true],['unknown outcome',{},'unknown_outcome',false],['already active',{accepted:false,code:'already_active'},'already_active',false],['contradictory accepted',{accepted:true,code:'busy'},'unknown_outcome',false],['policy denied',{accepted:false,code:'policy_denied'},'policy_denied',true],['unproven busy',{code:'busy'},'unknown_outcome',false]])test(`transport classification: ${name}`,()=>{const x=classify(input);assert.equal(x.classification,expected);assert.equal(x.no_side_effects,effects);if(name==='reasonless rejection')assert.equal(x.reason_known,false);});
test('claim/report accepted: one durable Run, duplicate claims/outcomes never issue another packet or release writer',async t=>{
 const s=await setup(t),c=claim(s);assert.equal(c.state,'dispatching');assert.equal(claim(s).state,'existing_dispatch');
 report(s,c,{accepted:true,receipt:{thread_id:'00000000-0000-0000-0000-000000000001'}});assert.equal(s.r.status,'accepted');assert.equal(claim(s).state,'existing_dispatch');
 assert.equal(report(s,c,{accepted:true,receipt:{thread_id:'00000000-0000-0000-0000-000000000001'}}).duplicate,true);assert.equal(s.r.attempt_count,1);assert.equal(n(s,'cp_result_inbox'),0);assert.equal(n(s,'cp_leases',"WHERE state='held'"),1);
 assert.throws(()=>report(s,c,{accepted:false}),/conflict/);assert.equal(s.f.bridge.codexAdapter.startTask(s.m.id,'dispatch-test').run_id,s.h.run_id);
});
test('bounded retry preserves logical Run, no immediate or concurrent tick replay, maximum budget ends in WAIT',async t=>{
 const s=await setup(t);s.d.schedule=()=>{};
 for(let attempt=1;attempt<=3;attempt++){
  const c=claim(s);assert.equal(c.state,'dispatching');report(s,c,{accepted:false});assert.equal(s.r.run_id,s.h.run_id);assert.equal(n(s,'cp_result_inbox'),0);assert.equal(n(s,'cp_leases',"WHERE state='held'"),0);
  if(attempt<3){assert.equal(s.r.status,'retry_wait');assert.equal(claim(s).state,'WAIT');await s.d.reconcile();assert.equal(s.r.attempt_count,attempt);s.advance(30000*2**(attempt-1));await Promise.all([s.d.reconcile(),s.d.reconcile()]);assert.equal(s.r.status,'dispatch_pending_external');}
 }
 await s.d.reconcile();assert.equal(s.r.status,'waiting');s.advance(3600000);await s.d.reconcile();assert.equal(s.r.attempt_count,3);assert.equal(claim(s).state,'WAIT');assert.equal(n(s,'cp_agent_dispatch_attempts'),3);
});
for(const state of ['before_dispatch','during_dispatch','accepted','retry_wait'])test(`restart recovery: ${state}`,async t=>{
 const s=await setup(t);s.d.schedule=()=>{};let c;
 if(state!=='before_dispatch')c=claim(s);
 if(state==='accepted')report(s,c,{accepted:true});if(state==='retry_wait')report(s,c,{accepted:false});
 const id=s.r.dispatch_id,run=s.h.run_id,next=s.r.next_attempt_at;await s.f.reopen();s.d.now=()=>s.clock();await s.d.reconcile();assert.equal(s.r.dispatch_id,id);assert.equal(s.r.run_id,run);
 if(state==='before_dispatch')assert.equal(claim(s).state,'dispatching');
 else if(state==='retry_wait'){assert.equal(s.r.next_attempt_at,next);assert.equal(s.r.status,'retry_wait');s.advance(30000);await s.d.reconcile();assert.equal(claim(s).state,'dispatching');}
 else{assert.ok(['accepted','running_unknown'].includes(s.r.status));assert.equal(claim(s).state,'existing_dispatch');assert.equal(s.r.attempt_count,1);assert.equal(n(s,'cp_leases',"WHERE state='quarantined'"),1);}
});
for(const code of ['auth_required','quota_limited'])test(`${code} waits without retries until a trusted availability observation, preserving budget`,async t=>{
 const s=await setup(t),c=claim(s);report(s,c,{accepted:false,code});await s.d.reconcile();assert.equal(s.r.status,'waiting');s.advance(300000);await s.d.reconcile();assert.equal(s.r.attempt_count,1);assert.equal(s.d.availability().availability,code);
 assert.throws(()=>s.d.observeAvailability({state:'available'},'worker'),/Operator/);s.d.observeAvailability({state:'available'});await s.d.reconcile();assert.equal(s.r.status,'retry_wait');s.advance(30000);await s.d.reconcile();assert.equal(claim(s).state,'dispatching');
});
test('circuit opens after rejection, skips new intents, permits one half-open probe and closes only on accepted transport',async t=>{
 const s=await setup(t);s.d.schedule=()=>{};for(let i=0;i<3;i++){const c=claim(s);report(s,c,{accepted:false});s.advance(i<2?30000*2**i:0);await s.d.reconcile();}assert.equal(s.d.circuit().state,'open');
 const m=s.f.create({objective:'Independent second fixture task',allowed_files:['second.txt'],criteria:[{id:'second',type:'exact_file',path:'second.txt',content:'second\n'}]});const h=s.f.bridge.codexAdapter.startTask(m.id,'second-intent'),r=s.d.get(h.run_id);assert.equal(s.d.claim({dispatch_id:r.dispatch_id}).state,'WAIT');assert.equal(s.d.get(r.dispatch_id).attempt_count,0);
 s.advance(120000);await s.d.reconcile();const probe=s.d.claim({dispatch_id:r.dispatch_id});assert.equal(probe.state,'dispatching');assert.equal(s.d.circuit().state,'half_open');assert.equal(s.d.claim({dispatch_id:r.dispatch_id}).state,'existing_dispatch');
 s.d.report({dispatch_id:r.dispatch_id,attempt_id:probe.attempt_id,outcome:{accepted:true}});assert.equal(s.d.circuit().state,'closed');
});
test('unknown transport never falls back, even after restart, availability changes and repeated ticks',async t=>{
 const s=await setup(t,{fallback_agents:['claude_code'],dispatch_policy:cloud}),c=claim(s);report(s,c,{});await s.d.reconcile();assert.equal(s.r.status,'running_unknown');assert.equal(s.f.calls(),0);assert.equal(n(s,'cp_dispatches'),0);s.advance(3600000);s.d.observeAvailability({state:'available'});await s.d.reconcile();assert.equal(claim(s).state,'existing_dispatch');
 await s.f.reopen();await s.d.reconcile();assert.equal(s.r.selected_fallback,null);assert.equal(s.f.calls(),0);
});
for(const [agent,policy]of [['claude_code',cloud],['pi',local]])test(`rejection automatically executes compatible ${agent} fallback with independent verification/fixture Acceptance`,async t=>{
 const f=await fixture(t),p=f.bridge.projects.listProjects()[0];f.bridge.fixtureAcceptance.register({project_id:p.projectId,workspace:f.repo,isolated:true,no_external_effects:true});const m=f.create({preferred_agent:'codex',fallback_agents:[agent],dispatch_policy:policy,fixture_auto_acceptance:true});
 const h=f.bridge.codexAdapter.startTask(m.id,'fallback-smoke'),d=f.bridge.agentDispatch,r=d.get(h.run_id),c=d.claim({dispatch_id:r.dispatch_id});d.report({dispatch_id:r.dispatch_id,attempt_id:c.attempt_id,outcome:{accepted:false}});
 const done=await f.settle(m.id,'completed');assert.equal(done.acceptance.length,1);assert.equal(done.verifications[0].result,'passed');assert.equal(d.get(h.run_id).selected_fallback,agent);assert.equal(f.bridge.resultInbox.list({agent:'codex'}).length,0);assert.equal(f.bridge.resultInbox.list({agent}).length,1);assert.equal(f.inference(),0);assert.equal(f.calls(),agent==='claude_code'?1:0);assert.equal(n({f},'cp_leases',"WHERE state IN ('held','quarantined')"),0);
 await Promise.all([d.reconcile(),d.reconcile()]);await f.reopen();await f.bridge.agentDispatch.reconcile();assert.equal(f.calls(),agent==='claude_code'?1:0);assert.equal(f.bridge.missions.detail(m.id).acceptance.length,1);
 if(process.env.DISPATCH_SMOKE_EVIDENCE_DIR){fs.writeFileSync(path.join(process.env.DISPATCH_SMOKE_EVIDENCE_DIR,`fallback-${agent}.json`),JSON.stringify({mode:agent==='pi'?'real_brokered_local_file_action':'real_local_process_with_injected_claude_fixture',live_work:false,manual_retry:false,selected_fallback:agent,mission_id:m.id,codex_run_id:h.run_id,dispatch_attempts:1,writer_duplicates:0,verification:'passed',fixture_acceptance:'accept',inference_calls:0},null,2));}
});
for(const [name,policy,fallback]of [['privacy',{...cloud,privacy:'local_only'},['claude_code']],['billing',{...cloud,billing_classes:[]},['claude_code']],['no candidates',cloud,[]],['unknown agent',cloud,['cursor']],['research',{...cloud,task_category:'research'},['claude_code']],['Pi without native plan',{...local,native_actions:[]},['pi']]])test(`fallback WAIT: ${name}`,async t=>{
 const s=await setup(t,{fallback_agents:fallback,dispatch_policy:policy}),c=claim(s);report(s,c,{accepted:false});await s.d.reconcile();assert.equal(s.r.status,'waiting');assert.equal(s.r.selected_fallback,null);assert.equal(s.f.calls(),0);assert.equal(n(s,'cp_dispatches'),0);
});
test('another writer lease blocks fallback and release wakes automatic routing without user retry',async t=>{
 const s=await setup(t,{fallback_agents:['pi'],dispatch_policy:local});s.d.schedule=()=>{};const c=claim(s);report(s,c,{accepted:false});const store=s.f.bridge.controlStore;store.startRun({id:'other-writer',taskId:s.m.task_id,missionId:s.m.id,agentId:'pi'});store.acquireLease({resource:s.f.repo,runId:'other-writer'});await s.d.reconcile();assert.equal(s.r.wait_reason,'workspace_writer');assert.equal(n(s,'cp_dispatches'),0);
 store.updateRun('other-writer',{state:'completed',processState:'not_started',verified:true});await s.d.reconcile();await s.f.settle(s.m.id);assert.equal(s.r.selected_fallback,'pi');
});
test('worker, Slack Decision and Memory cannot spoof transport acceptance or change immutable dispatch policy',async t=>{
 const s=await setup(t),c=claim(s);for(const actor of ['worker','slack','memory','codex'])assert.throws(()=>s.d.report({dispatch_id:s.r.dispatch_id,attempt_id:c.attempt_id,outcome:{accepted:true}},actor),/Trusted/);
 assert.throws(()=>s.d.report({dispatch_id:s.r.dispatch_id,attempt_id:c.attempt_id,outcome:{accepted:true},fallback_policy:cloud}),/Unexpected/);
 assert.throws(()=>s.d.report({dispatch_id:s.r.dispatch_id,attempt_id:'unknown',outcome:{accepted:true}}),/Unknown/);
 assert.equal(s.r.status,'dispatching');assert.equal(n(s,'cp_acceptances'),0);assert.equal(n(s,'cp_result_inbox'),0);
 const api=new McpTools(s.f.bridge);assert.equal((await api.call('claim_agent_dispatch',{dispatch_id:s.r.dispatch_id})).state,'existing_dispatch');assert.equal((await api.call('get_agent_dispatches',{run_id:s.h.run_id})).items.length,1);
});
test('transport URLs strip query, fragment, userinfo, encoded credentials and arbitrary credential paths before persistence',async t=>{
 const seed='syntheticOnlySecret789',url=`https://user:${seed}@chatgpt.com/c/00000000-0000-0000-0000-000000000001?token=${seed}#auth=${seed}`;
 for(const v of [safeTransportUrl(url),redactText(url),redactText(encodeURIComponent(url)),JSON.stringify(safeValue({receipt:url}))])assert.ok(!v.includes(seed));
 assert.ok(!safeTransportUrl(`https://chatgpt.com/${seed}`).includes(seed));
 const s=await setup(t),c=claim(s);report(s,c,{accepted:true,receipt:{url,argv:['--token',seed],env:{TOKEN:seed}},reason:seed});const exported=JSON.stringify(s.d.views());assert.ok(!exported.includes(seed));
 const rows=s.f.bridge.ledger.list({missionId:s.m.id,limit:100}).events;assert.ok(!JSON.stringify(rows).includes(seed));assert.equal(n(s,'cp_result_inbox'),0);
});
test('accepted dispatch integrates with exactly one relay and remains leased until independent termination/verification',async t=>{
 const s=await setup(t),c=claim(s);report(s,c,{accepted:true});fs.writeFileSync(path.join(s.f.repo,'fixture.txt'),'beta\n');const h=s.h.contract;
 const e={schema_version:'codex-result-v1',mission_id:h.mission_id,task_id:h.task_id,run_id:h.run_id,request_id:h.request_id,agent_id:'codex',transport:'handoff',relay_nonce:h.relay_nonce,result:{status:'completed',summary:'Fixture completed',changed_files:['fixture.txt'],tests:[],artifacts:[],limitations:[]},timestamps:{started_at:1,finished_at:2},publisher:{identity:'codex-work',mode:'artifact'}};e.content_hash=fingerprint(e);
 fs.writeFileSync(h.result_publication.path,JSON.stringify(e),{mode:0o600});s.f.bridge.codexRelay.consume(h.run_id);assert.equal(s.r.status,'completion_waiting');assert.equal(claim(s).state,'existing_dispatch');assert.equal(n(s,'cp_leases',"WHERE state='held'"),1);assert.equal(n(s,'cp_verifications'),0);
 fs.writeFileSync(h.result_publication.path,JSON.stringify(e),{mode:0o600});s.f.bridge.codexRelay.consume(h.run_id);assert.equal(n(s,'cp_result_inbox'),1);
 s.f.bridge.codexAdapter.reconcile({run_id:h.run_id,termination_verified:true});await s.f.settle(s.m.id);assert.equal(s.r.status,'completed_transport');assert.equal(n(s,'cp_verifications'),1);assert.equal(n(s,'cp_acceptances'),0);
});
test('injected transport retries automatically with bounded time and stable idempotency; accepted attempt is never replayed',async t=>{
 const s=await setup(t),calls=[];s.d.transport=async c=>{calls.push(c);return calls.length===1?{accepted:false,code:'busy'}:{accepted:true};};
 await Promise.all([s.d.reconcile(),s.d.reconcile()]);assert.equal(calls.length,1);assert.equal(s.r.status,'retry_wait');await s.d.reconcile();assert.equal(calls.length,1);
 s.advance(30000);await Promise.all([s.d.reconcile(),s.d.reconcile()]);assert.equal(calls.length,2);assert.equal(s.r.status,'accepted');assert.equal(calls[0].idempotency_key,calls[1].idempotency_key);assert.notEqual(calls[0].attempt_id,calls[1].attempt_id);
 s.advance(3600000);await s.d.reconcile();assert.equal(calls.length,2);
});
test('restart after fallback selection restores the queued native dispatch once',async t=>{
 const s=await setup(t,{fallback_agents:['pi'],dispatch_policy:local});s.f.bridge.missions.stopped=true;const c=claim(s);report(s,c,{accepted:false});await s.d.reconcile();
 assert.equal(s.r.status,'fallback_selected');assert.equal(n(s,'cp_dispatches'),1);assert.equal(fs.readFileSync(path.join(s.f.repo,'fixture.txt'),'utf8'),'alpha\n');
 await s.f.reopen();await s.f.settle(s.m.id);assert.equal(n(s,'cp_dispatches'),1);assert.equal(s.f.bridge.resultInbox.list({agent:'pi'}).length,1);
});
test('Next Action persists a Codex intent and advances through native fallback without another user command',async t=>{
 const f=await fixture(t),p=f.bridge.projects.listProjects()[0];f.bridge.projects.updateProject(p.projectId,{autonomyLevel:'auto_development'});f.bridge.fixtureAcceptance.register({project_id:p.projectId,workspace:f.repo,isolated:true,no_external_effects:true});
 const m=f.create({preferred_agent:'codex',fallback_agents:['pi'],dispatch_policy:local,fixture_auto_acceptance:true});f.bridge.boundedNextActions.register({id:'dispatch-chain',mode:'auto_development',mission_ids:[m.id],max_missions:1,max_runtime_ms:120000});
 await f.bridge.boundedNextActions.reconcile();const r=f.bridge.agentDispatch.list({mission_id:m.id})[0];assert.ok(r);const c=f.bridge.agentDispatch.claim({dispatch_id:r.dispatch_id});f.bridge.agentDispatch.report({dispatch_id:r.dispatch_id,attempt_id:c.attempt_id,outcome:{accepted:false}});
 await f.settle(m.id,'completed');await f.bridge.boundedNextActions.reconcile();assert.equal(f.bridge.boundedNextActions.inspect('dispatch-chain').state,'paused');assert.equal(f.inference(),0);
});
for(const code of ['invalid_request','policy_denied'])test(`${code} is terminal for this intent, never opens a circuit or bypasses policy via fallback`,async t=>{
 const s=await setup(t,{fallback_agents:['pi'],dispatch_policy:local}),c=claim(s);report(s,c,{accepted:false,code});await s.d.reconcile();assert.equal(s.r.status,'failed');assert.equal(s.r.selected_fallback,null);assert.equal(s.d.circuit().state,'closed');assert.equal(n(s,'cp_result_inbox'),0);assert.equal(n(s,'cp_dispatches'),0);
});
test('transport timeout is uncertainty, never an inferred rejection or a duplicate attempt',async t=>{
 const s=await setup(t);claim(s);s.advance(120001);await s.d.reconcile();assert.equal(s.r.status,'running_unknown');assert.equal(s.r.no_side_effects,false);assert.equal(claim(s).state,'existing_dispatch');assert.equal(n(s,'cp_agent_dispatch_attempts'),1);
});
test('immutable Mission policy tampering fails closed before fallback; caller cannot insert scopes through a report',async t=>{
 const s=await setup(t,{fallback_agents:['pi'],dispatch_policy:local});s.d.schedule=()=>{};const c=claim(s);report(s,c,{accepted:false});
 const m=s.f.bridge.controlStore.getMission(s.m.id);m.envelope.dispatch_policy.native_actions[0].content='tampered';s.f.bridge.controlStore.db.prepare('UPDATE cp_missions SET envelope=? WHERE id=?').run(JSON.stringify(m.envelope),m.id);await s.d.reconcile();assert.equal(s.r.wait_reason,'immutable_policy_changed');assert.equal(n(s,'cp_dispatches'),0);
});
test('safe receipt sanitizer handles twice encoded URLs and never exports argv/environment fields',()=>{
 const seed='fakeReceiptValue456',url=`https://user:${seed}@chatgpt.com/?state=${seed}#${seed}`;assert.ok(!redactText(encodeURIComponent(encodeURIComponent(url))).includes(seed));
 const out=classify({accepted:true,receipt:{url,thread_id:seed,work_ref:seed,argv:seed,env:seed}});assert.ok(!JSON.stringify(out).includes(seed));assert.ok(!Object.hasOwn(out.receipt,'argv'));
});
test('paused autonomy blocks retry/fallback until its existing explicit resume action',async t=>{
 const s=await setup(t,{fallback_agents:['pi'],dispatch_policy:local});s.d.schedule=()=>{};const c=claim(s);report(s,c,{accepted:false});
 const e=s.f.bridge.boundedNextActions;e.register({id:'paused-dispatch',mode:'auto_development',mission_ids:[s.m.id],max_missions:1,max_runtime_ms:120000});s.f.bridge.controlStore.db.prepare("INSERT INTO cp_autonomy_claims VALUES(?,?,?,'claimed')").run('paused-dispatch',s.m.id,'owned-claim');e.pause('paused-dispatch');await s.d.reconcile();assert.equal(s.r.wait_reason,'autonomy_paused_or_expired');assert.equal(n(s,'cp_dispatches'),0);e.resume('paused-dispatch');await s.d.reconcile();await s.f.settle(s.m.id);assert.equal(s.r.selected_fallback,'pi');
});
test('safe runtime diagnostics export only whitelisted health, refuse non-loopback discovery and never return private URLs',async t=>{
 const os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'safe-discovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const seed='syntheticLocalDiscovery123',write=url=>fs.writeFileSync(path.join(root,'ui.json'),JSON.stringify({url}),{mode:0o600});write(`http://127.0.0.1:1234/#token=${seed}`);
 const {status}=require('../scripts/harness-safe-status.cjs');let calls=0;const result=await status({runtime:root,request:async(url,options)=>{calls++;assert.equal(url,'http://127.0.0.1:1234/api/control-v2/health');assert.equal(options.redirect,'error');return{ok:true,json:async()=>({bridge:{healthy:true,mcp_ready:true,pid:123},secret:seed,url:`http://127.0.0.1/#token=${seed}`})};}});assert.equal(result.healthy,true);assert.ok(!JSON.stringify(result).includes(seed));write(`https://example.com/#token=${seed}`);await assert.rejects(()=>status({runtime:root,request:async()=>{calls++;}}),/Loopback/);assert.equal(calls,1);
});
test('accepted handoff after restart can publish, but only trusted termination reconciliation resumes verification',async t=>{
 const s=await setup(t),c=claim(s);report(s,c,{accepted:true});await s.f.reopen();fs.writeFileSync(path.join(s.f.repo,'fixture.txt'),'beta\n');const h=s.h.contract;
 const e={schema_version:'codex-result-v1',mission_id:h.mission_id,task_id:h.task_id,run_id:h.run_id,request_id:h.request_id,agent_id:'codex',transport:'handoff',relay_nonce:h.relay_nonce,result:{status:'completed',summary:'Recovered fixture',changed_files:['fixture.txt'],tests:[],artifacts:[],limitations:[]},timestamps:{started_at:1,finished_at:2},publisher:{identity:'codex-work',mode:'artifact'}};e.content_hash=fingerprint(e);fs.writeFileSync(h.result_publication.path,JSON.stringify(e),{mode:0o600});s.f.bridge.codexRelay.consume(h.run_id);assert.equal(n(s,'cp_verifications'),0);assert.equal(n(s,'cp_leases',"WHERE state='quarantined'"),1);
 s.f.bridge.codexAdapter.reconcile({run_id:h.run_id,termination_verified:true});await s.f.settle(s.m.id);assert.equal(n(s,'cp_verifications'),1);assert.equal(n(s,'cp_leases',"WHERE state IN ('held','quarantined')"),0);
});
test('another unresolved Codex transport prevents concurrent Work dispatch even across independent workspaces',async t=>{
 const s=await setup(t),c=claim(s);report(s,c,{accepted:true});const other=path.join(s.f.root,'second-repo');fs.cpSync(s.f.repo,other,{recursive:true});
 const m=s.f.create({objective:'Second independent workspace task',workspace:other,preferred_agent:'codex'}),h=s.f.bridge.codexAdapter.startTask(m.id,'other-workspace');const r=s.d.get(h.run_id),attempt=s.d.claim({dispatch_id:r.dispatch_id});assert.equal(attempt.state,'WAIT');assert.equal(s.d.get(r.dispatch_id).wait_reason,'codex_transport_busy');assert.equal(s.d.get(r.dispatch_id).attempt_count,0);
});
test('Mission cancellation revokes retry and keeps an accepted Work writer unverified through restart',async t=>{
 const s=await setup(t),c=claim(s);report(s,c,{accepted:true});s.f.bridge.missions.cancel(s.m.id,{request_id:'cancel-dispatch-mission'});assert.equal(s.r.status,'cancel_requested');assert.equal(s.f.bridge.controlStore.run(s.h.run_id).termination_verified,0);assert.equal(claim(s).state,'existing_dispatch');
 await s.f.reopen();await s.d.reconcile();assert.equal(s.r.status,'cancel_requested');assert.equal(n(s,'cp_leases',"WHERE state='quarantined'"),1);assert.equal(n(s,'cp_result_inbox'),0);
});
