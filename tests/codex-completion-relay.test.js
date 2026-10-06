'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,wait}=require('./fixtures/mission-fixture.cjs');
const {fingerprint}=require('../src/control-plane-store');
const {publish}=require('../scripts/publish-agent-result.cjs');
const {McpTools}=require('../src/mcp-tools');
function envelope(h,result={}){const c=h.contract;const value={schema_version:'codex-result-v1',mission_id:c.mission_id,task_id:c.task_id,run_id:c.run_id,request_id:c.request_id,agent_id:'codex',transport:'handoff',relay_nonce:c.relay_nonce,result:{status:'completed',summary:'Fixture result',changed_files:['fixture.txt'],tests:[{name:'fixture',status:'passed',evidence_refs:[]}],artifacts:[],limitations:[],...result},timestamps:{started_at:1,finished_at:2},publisher:{identity:'codex-work',mode:'artifact'}};return seal(value);}
function seal(value){delete value.content_hash;value.content_hash=fingerprint(value);return value;}
function stage(f,h,value=envelope(h)){const file=path.join(f.root,'result.json');fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});return publish(file,{runtime:path.join(f.root,'data')});}
const count=(f,table)=>f.bridge.controlStore.db.prepare(`SELECT count(*) n FROM ${table}${table==='cp_effect_outbox'?" WHERE destination_type='result_relay'":""}`).get().n;
test('automatic artifact arrival reaches inbox/outbox/MCP, remains untrusted until independently verified, review does not accept',async t=>{
 const f=await fixture(t),m=f.create({preferred_agent:'codex'}),h=f.bridge.codexAdapter.startTask(m.id,'auto-relay');
 fs.writeFileSync(path.join(f.repo,'fixture.txt'),'beta\n');assert.equal(stage(f,h).state,'artifact_staged');
 for(let n=0;n<100&&!count(f,'cp_result_inbox');n++)await wait(10);
 assert.equal(count(f,'cp_result_inbox'),1);assert.equal(count(f,'cp_effect_outbox'),1);
 assert.equal(f.bridge.controlStore.run(h.run_id).termination_verified,0);
 assert.equal(count(f,'cp_verifications'),0);assert.equal(stage(f,h).duplicate,true);
 const api=new McpTools(f.bridge);const discovery=await api.call('get_agent_results',{agent:'codex',state:'unread',run_id:h.run_id});assert.equal(discovery.items.length,1);assert.equal(discovery.items[0].acceptance.length,0);
 f.bridge.resultInbox.review(h.run_id,'reviewed');assert.equal(count(f,'cp_acceptances'),0);
 f.bridge.codexAdapter.reconcile({run_id:h.run_id,termination_verified:true});await f.settle(m.id);assert.equal(count(f,'cp_verifications'),1);assert.equal(count(f,'cp_acceptances'),0);assert.equal(f.inference(),0);
});
test('restart consumes pending artifact once, preserves immutable result, repeated artifact creates no second intent',async t=>{
 const f=await fixture(t),m=f.create({preferred_agent:'codex'}),h=f.bridge.codexAdapter.startTask(m.id,'restart-relay');f.bridge.codexRelay.close();stage(f,h);
 await f.reopen();assert.equal(count(f,'cp_result_inbox'),1);assert.equal(count(f,'cp_effect_outbox'),1);
 fs.writeFileSync(h.contract.result_publication.path,JSON.stringify(envelope(h)),{mode:0o600});f.bridge.codexRelay.consume(h.run_id);
 assert.equal(count(f,'cp_result_inbox'),1);assert.equal(count(f,'cp_effect_outbox'),1);assert.equal(f.bridge.controlStore.run(h.run_id).termination_verified,0);
 const bad=envelope(h,{summary:'Conflicting result'});fs.writeFileSync(h.contract.result_publication.path,JSON.stringify(bad),{mode:0o600});assert.equal(f.bridge.codexRelay.consume(h.run_id).rejected,true);
 assert.equal(f.bridge.codexAdapter.getTask(h.run_id).relay.error_class,'conflict');assert.equal(count(f,'cp_result_inbox'),1);
});
test('unknown run, wrong correlation, nonce, transport, hash, authority injection and unsafe references fail closed',async t=>{
 const f=await fixture(t),m=f.create(),h=f.bridge.codexAdapter.startTask(m.id,'deny-relay');
 const changes=[{run_id:'unknown'},{mission_id:'wrong'},{task_id:'wrong'},{request_id:'wrong'},{relay_nonce:'wrong'},{agent_id:'pi'},{transport:'native'},{schema_version:'wrong'},{scopes:['all']},{accepted:true},{result:{...envelope(h).result,changed_files:['../outside']}},{result:{...envelope(h).result,artifacts:['/etc/passwd']}}];
 for(const delta of changes)assert.throws(()=>stage(f,h,seal({...envelope(h),...delta})));
 assert.throws(()=>stage(f,h,{...envelope(h),content_hash:'wrong'}));assert.equal(count(f,'cp_result_inbox'),0);assert.equal(count(f,'cp_acceptances'),0);
});
test('malformed/oversized/symlink artifacts and unsafe parent paths reject, remain unresolved and do not log raw content',async t=>{
 const f=await fixture(t),m=f.create(),h=f.bridge.codexAdapter.startTask(m.id,'paths-relay'),file=h.contract.result_publication.path;
 for(const content of ['{broken','x'.repeat(24001)]){fs.writeFileSync(file,content,{mode:0o600});assert.equal(f.bridge.codexRelay.consume(h.run_id).rejected,true);fs.unlinkSync(file);}
 const target=path.join(f.root,'outside');fs.writeFileSync(target,JSON.stringify(envelope(h)),{mode:0o600});fs.symlinkSync(target,file);assert.equal(f.bridge.codexRelay.consume(h.run_id).rejected,true);fs.unlinkSync(file);
 fs.chmodSync(path.dirname(file),0o755);fs.writeFileSync(file,JSON.stringify(envelope(h)),{mode:0o600});assert.equal(f.bridge.codexRelay.consume(h.run_id).rejected,true);
 assert.equal(count(f,'cp_result_inbox'),0);assert.equal(f.bridge.controlStore.run(h.run_id).termination_verified,0);
});
test('cancellation and partial/termination claims remain truthful and cannot release lease or self-accept',async t=>{
 for(const status of ['partial','termination_unverified','cancelled']){
  const f=await fixture(t),m=f.create(),h=f.bridge.codexAdapter.startTask(m.id,'state-'+status);stage(f,h,envelope(h,{status}));f.bridge.codexRelay.consume(h.run_id);
  assert.equal(f.bridge.resultInbox.latest({run:h.run_id}).result.status,status);assert.equal(f.bridge.controlStore.run(h.run_id).termination_verified,0);assert.equal(count(f,'cp_verifications'),0);assert.equal(count(f,'cp_acceptances'),0);
 }
 const f=await fixture(t),m=f.create(),h=f.bridge.codexAdapter.startTask(m.id,'cancel-before');f.bridge.codexAdapter.cancelTask(h.run_id);assert.throws(()=>stage(f,h),/Stale/);assert.equal(count(f,'cp_result_inbox'),0);
});
test('structured operator Decision, duplicate answer, exact new Codex continuation and result publication',async t=>{
 const f=await fixture(t),m=f.create({preferred_agent:'codex'}),h=f.bridge.codexAdapter.startTask(m.id,'decision-relay');
 stage(f,h,envelope(h,{status:'needs_operator',changed_files:[],needs_operator:{question:'A or B?',options:[{id:'A',label:'A',recommended:true},{id:'B',label:'B'}],allow_free_text:false}}));f.bridge.codexRelay.consume(h.run_id);
 const d=f.bridge.controlStore.decisions(m.id)[0];assert.equal(d.agent_id,'codex');assert.equal(count(f,'cp_decisions'),1);
 f.bridge.missions.answer(d.id,{request_id:'answer-A',option_id:'A'});f.bridge.missions.answer(d.id,{request_id:'answer-duplicate',option_id:'B'});await f.bridge.missions.tick();assert.equal(count(f,'cp_codex_handoffs'),1);
 f.bridge.codexAdapter.reconcile({run_id:h.run_id,termination_verified:true});await f.bridge.missions.tick();
 assert.equal(count(f,'cp_codex_handoffs'),2);assert.equal(count(f,'cp_continuations'),1);
 const next=f.bridge.controlStore.db.prepare('SELECT run_id FROM cp_codex_handoffs WHERE run_id<>?').get(h.run_id);const packet=f.bridge.codexAdapter.getTask(next.run_id);
 assert.equal(packet.contract.continuation.answer.option_id,'A');assert.equal(packet.contract.continuation.previous_run_id,h.run_id);assert.equal(packet.contract.mission_id,m.id);
 fs.writeFileSync(path.join(f.repo,'fixture.txt'),'beta\n');stage(f,{contract:packet.contract});f.bridge.codexRelay.consume(next.run_id);assert.equal(count(f,'cp_result_inbox'),2);
 f.bridge.codexAdapter.reconcile({run_id:next.run_id,termination_verified:true});await f.settle(m.id);assert.equal(count(f,'cp_verifications'),1);assert.equal(f.calls(),0);assert.equal(f.inference(),0);
});
test('secret-like evidence rejects before staging or ledger export and cannot change authority',async t=>{
 const f=await fixture(t),m=f.create(),h=f.bridge.codexAdapter.startTask(m.id,'secret-relay');
 const seed='xoxb-fixtureSecretOnly123456';assert.throws(()=>stage(f,h,envelope(h,{limitations:[seed]})),/Sensitive/);
 assert.equal(fs.existsSync(h.contract.result_publication.path),false);assert.equal(count(f,'cp_result_inbox'),0);
 const before=f.bridge.controlStore.getMission(m.id);assert.deepEqual(before.envelope.capability_scopes,m.envelope.capability_scopes);assert.equal(count(f,'cp_acceptances'),0);
});
test('publish rollback is atomic and retry creates one inbox/intent; independent failed checks deny Acceptance',async t=>{
 const f=await fixture(t),m=f.create(),h=f.bridge.codexAdapter.startTask(m.id,'atomic-relay');stage(f,h);
 const enqueue=f.bridge.controlStore.outbox.enqueue;f.bridge.controlStore.outbox.enqueue=()=>{throw Error('fixture database boundary');};
 assert.equal(f.bridge.codexRelay.consume(h.run_id).rejected,true);assert.equal(count(f,'cp_result_inbox'),0);assert.equal(count(f,'cp_codex_result_proposals'),0);
 f.bridge.controlStore.outbox.enqueue=enqueue;f.bridge.codexRelay.consume(h.run_id);assert.equal(count(f,'cp_result_inbox'),1);assert.equal(count(f,'cp_effect_outbox'),1);
 f.bridge.codexAdapter.reconcile({run_id:h.run_id,termination_verified:true});await f.settle(m.id,'needs_rework');assert.equal(count(f,'cp_acceptances'),0);
 assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:'try-forged',decision:'accept',verification_id:'not-real',rationale:'Agent claims success'}),/not awaiting/);
});
test('isolated simulated Work child invokes exact injected command, automatic relay/read surface, independent Pi verification and fixture Acceptance',async t=>{
 const f=await fixture(t),p=f.bridge.projects.listProjects()[0];f.bridge.fixtureAcceptance.register({project_id:p.projectId,workspace:f.repo,isolated:true,no_external_effects:true});
 const m=f.create({preferred_agent:'codex',fixture_auto_acceptance:true}),h=f.bridge.codexAdapter.startTask(m.id,'smoke-relay'),pub=h.contract.result_publication;
 const childFile=path.join(f.root,'simulated-work.cjs');fs.writeFileSync(path.join(f.root,'RESULT.json'),JSON.stringify(envelope(h)),{mode:0o600});
 fs.writeFileSync(childFile,`require('node:fs').writeFileSync(${JSON.stringify(path.join(f.repo,'fixture.txt'))},'beta\\n');require('node:child_process').execFileSync(${JSON.stringify(pub.executable)},${JSON.stringify(pub.argv)},{stdio:'pipe'});`);
 require('node:child_process').execFileSync(process.execPath,[childFile],{cwd:f.root,stdio:'pipe'});
 for(let n=0;n<100&&!count(f,'cp_result_inbox');n++)await wait(10);assert.equal(count(f,'cp_result_inbox'),1);
 // Trusted fixture runner observed exit of its actual child. A real Work handoff
 // has no such observation and must never substitute file arrival for this fact.
 f.bridge.codexAdapter.reconcile({run_id:h.run_id,termination_verified:true});const done=await f.settle(m.id,'completed');
 const api=new McpTools(f.bridge),read=await api.call('get_agent_results',{agent:'codex',run_id:h.run_id});assert.equal(read.items.length,1);assert.equal(read.items[0].verification[0].result,'passed');assert.equal(read.items[0].acceptance[0].decision,'accept');assert.equal(f.inference(),0);
 assert.deepEqual(f.bridge.controlStore.db.prepare('PRAGMA integrity_check').get(),Object.assign(Object.create(null),{integrity_check:'ok'}));assert.equal(f.bridge.controlStore.db.prepare('PRAGMA foreign_key_check').all().length,0);
 if(process.env.CODEX_RELAY_SMOKE_EVIDENCE)fs.writeFileSync(process.env.CODEX_RELAY_SMOKE_EVIDENCE,JSON.stringify({mode:'simulated_work_child',live_codex_work:false,manual_copy_paste:false,mission_id:m.id,task_id:m.task_id,run_id:h.run_id,schema_version:'codex-result-v1',command_invoked:true,artifact_auto_consumed:true,inbox_count:1,result_notification_intents:count(f,'cp_effect_outbox'),verification:done.verifications[0].result,acceptance:done.acceptance[0].decision,termination_evidence:'isolated runner observed child exit; operator API reconciliation invoked by fixture',inference_calls:f.inference(),db_integrity:'ok',foreign_key_violations:0},null,2));
});

test('Codex artifact preserves structural continuity claim through publication and host verification',async t=>{
 const f=await fixture(t),m=f.create({preferred_agent:'codex',continuity:'prior_context'}),h=f.bridge.codexAdapter.startTask(m.id,'structural-continuity-relay');
 assert.equal(h.contract.continuity_requirement,'prior_context');assert.throws(()=>stage(f,h,envelope(h,{continuity_claimed:'true'})),/continuity/);
 const input=envelope(h,{continuity_claimed:true});assert.equal(stage(f,h,input).state,'artifact_staged');f.bridge.codexRelay.consume(h.run_id);
 assert.equal(f.bridge.resultInbox.latest({run:h.run_id}).result.continuity_claimed,true);
 f.bridge.codexAdapter.reconcile({run_id:h.run_id,termination_verified:true});const result=await f.settle(m.id,'needs_rework');assert.match(result.reason,/continuity_unverified/);assert.equal(result.acceptance.length,0);
});
