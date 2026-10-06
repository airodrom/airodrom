'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const {fixture}=require('./fixtures/mission-fixture.cjs');
test('hosted-style Xcode alias admits real Git children only through canonical trusted roots', {skip:process.platform!=='darwin'}, async t=>{
 const {HostExecutor}=require('../src/host-exec');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(),'verifier-xcode-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const developer=path.join(root,'Xcode_1.app/Contents/Developer'),alias=path.join(root,'Xcode.app');
 for(const dir of ['usr/bin','usr/libexec'])fs.mkdirSync(path.join(developer,dir),{recursive:true});
 fs.symlinkSync(path.dirname(path.dirname(developer)),alias);
 const direct=path.join(developer,'usr/bin/git'),outside=path.join(root,'unapproved-git');
 const installed=require('../src/repository-verification').resolveGitExecutable();
 fs.copyFileSync(installed,direct);fs.copyFileSync(installed,outside);fs.chmodSync(direct,0o700);fs.chmodSync(outside,0o700);
 const map=file=>typeof file==='string'&&file.startsWith('/Applications/Xcode.app/Contents/Developer/usr/')?path.join(alias,file.slice('/Applications/Xcode.app/'.length)):file;
 const realpath=fs.realpathSync,stat=fs.statSync;let rootsUnavailable=false;
 t.mock.method(fs,'realpathSync',(file,...args)=>realpath(map(file),...args));
 t.mock.method(fs,'statSync',(file,...args)=>{if(rootsUnavailable&&map(file)!==file)throw Error('Synthetic unavailable developer root');return stat(map(file),...args);});
 const executor=new HostExecutor({allowed:[process.execPath,'/usr/bin/git'],home:root});
 const profile=executor.processBoundary(process.execPath,[]).args[1];
 assert.ok(profile.includes(`(subpath "${path.join(developer,'usr/bin')}")`));
 assert.ok(!profile.includes(`(subpath "${path.join(alias,'Contents/Developer/usr/bin')}")`));
 await assert.rejects(executor.run(outside,['--version']),/allowlisted/);
 const prior=process.env.FIXTURE_PRIVATE_SENTINEL;process.env.FIXTURE_PRIVATE_SENTINEL='synthetic-private-value';
 t.after(()=>{if(prior===undefined)delete process.env.FIXTURE_PRIVATE_SENTINEL;else process.env.FIXTURE_PRIVATE_SENTINEL=prior;});
 const code=`const cp=require('node:child_process');const good=cp.spawnSync(${JSON.stringify(direct)},['--version'],{encoding:'utf8'});const bad=cp.spawnSync(${JSON.stringify(outside)},['--version']);console.log(JSON.stringify({good:good.status,version:good.stdout,bad:bad.error?.code,privateEnv:process.env.FIXTURE_PRIVATE_SENTINEL||null}));`;
 const result=await executor.run(process.execPath,['-e',code],{cwd:root});
 assert.equal(result.exitCode,0,result.stderr);
 const observed=JSON.parse(result.stdout);
 assert.equal(observed.good,0);assert.match(observed.version,/^git version /);assert.equal(observed.bad,'EPERM');assert.equal(observed.privateEnv,null);
 rootsUnavailable=true;
 const unavailableProfile=executor.processBoundary(process.execPath,[]).args[1];
 assert.ok(!unavailableProfile.includes(`(subpath "${path.join(developer,'usr/bin')}")`));
 const unavailable=await executor.run(process.execPath,['-e',code],{cwd:root});
 assert.equal(unavailable.exitCode,0);assert.equal(JSON.parse(unavailable.stdout).good,null);
});
test('missing Git verifier stays fail closed; explicit rework requires real verification before Acceptance and Settlement',async t=>{
 const f=await fixture(t),m=f.create(),resolve=f.host.exec.resolveFirst.bind(f.host.exec);
 const unavailable=t.mock.method(f.host.exec,'resolveFirst',candidates=>candidates.includes('/usr/bin/git')?null:resolve(candidates));
 f.bridge.missions.dispatch(m.id,{request_id:'missing-verifier-dispatch'});
 const failed=await f.settle(m.id,'needs_rework'),v=failed.verifications[0];
 assert.equal(v.result,'unavailable');
 for(const id of ['repository_v2','creation_repository_v2','protected_files','expected_changes'])assert.ok(v.evidence.some(c=>c.id===id&&c.status==='passed'));
 assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_acceptances WHERE mission_id=?').get(m.id).n,0);
 assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:'missing-verifier-accept',verification_id:v.id,decision:'accept',rationale:'Cannot accept unavailable evidence'}));
 unavailable.mock.restore();const calls=f.calls();
 await assert.rejects(f.bridge.missions.reverify(m.id,{id:m.id,request_id:'unavailable-verifier-retry'}),/failed verification required/);
 await f.bridge.missions.tick();assert.equal(f.calls(),calls);
 f.bridge.missions.dispatch(m.id,{request_id:'restored-verifier-rework'});
 const ready=await f.settle(m.id),verified=ready.verifications.find(row=>row.result==='passed');
 assert.ok(verified);assert.equal(f.calls(),calls+1);
 assert.equal(ready.state,'awaiting_acceptance');
 for(const id of ['git_status','task_owned_diff','task:diff-check','task:fixture-test','verification_workspace_stable'])assert.ok(ready.verifications.find(row=>row.id===verified.id).evidence.some(c=>c.id===id&&c.status==='passed'));
 assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_acceptances WHERE mission_id=?').get(m.id).n,0);
 const accepted=f.bridge.missions.accept(m.id,{request_id:'restored-verifier-accept',verification_id:verified.id,decision:'accept',rationale:'Real registered tests and independent repository checks passed'});
 assert.equal(accepted.state,'completed');assert.equal(f.inference(),0);
});
test('a real failing registered verifier test blocks Acceptance despite passing exact-file evidence',async t=>{
 const f=await fixture(t);
 fs.writeFileSync(path.join(f.repo,'tests/fixture.test.cjs'),"require('node:assert/strict').equal(require('node:fs').readFileSync('fixture.txt','utf8'),'gamma\\n');\n");
 const m=f.create();f.bridge.missions.dispatch(m.id,{request_id:'negative-real-verifier'});
 const failed=await f.settle(m.id,'needs_rework'),v=failed.verifications[0];
 assert.equal(v.result,'failed');assert.ok(v.evidence.some(c=>c.id==='expected_file'&&c.status==='passed'));
 assert.ok(v.evidence.some(c=>c.id==='task:fixture-test'&&c.status==='failed'&&c.evidence.exit_code!==0));
 assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:'negative-real-accept',verification_id:v.id,decision:'accept',rationale:'Worker claims cannot replace failed real tests'}));
 assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_acceptances WHERE mission_id=?').get(m.id).n,0);
 assert.equal(f.inference(),0);
});
test('Mission → actual broker → Claude runner → Pi typed verification → explicit acceptance; zero inference',async t=>{
 const f=await fixture(t),m=f.create();assert.equal(f.calls(),0);assert.equal(m.state,'ready');f.bridge.missions.dispatch(m.id,{request_id:'dispatch-1'});const completed=await f.settle(m.id);assert.equal(f.inference(),0);assert.equal(f.calls(),1);assert.equal(completed.verifications[0].result,'passed');assert.ok(completed.verifications[0].evidence.some(c=>c.id==='task:fixture-test'&&c.status==='passed'));assert.equal(f.bridge.memory.db.prepare("SELECT count(*) n FROM cp_candidates WHERE state='pending'").get().n,1);
 const accepted=f.bridge.missions.accept(m.id,{request_id:'accept-1',verification_id:completed.verifications[0].id,decision:'accept',rationale:'Independent exact-file and registered test evidence passed'});assert.equal(accepted.state,'completed');assert.throws(()=>f.bridge.missions.dispatch(m.id,{request_id:'again'}),/cannot dispatch/);
});
test('declared Cursor fallback routes to Claude; stale evidence cannot accept changed files',async t=>{const f=await fixture(t),m=f.create({preferred_agent:'cursor',fallback_agents:['claude_code']});f.bridge.missions.dispatch(m.id,{request_id:'route'});const done=await f.settle(m.id);const dispatch=f.bridge.memory.db.prepare('SELECT route FROM cp_dispatches WHERE mission_id=?').get(m.id);assert.equal(JSON.parse(dispatch.route).selected,'claude_code');fs.writeFileSync(path.join(f.repo,'fixture.txt'),'tampered\n');assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:'stale',verification_id:done.verifications[0].id,decision:'accept',rationale:'reject stale'}),/stale/);});
const {SlackRuntime}=require('../src/slack-runtime');
const {MissionService}=require('../src/mission-service');
const {assertTransition}=require('../src/mission-lifecycle');
function fakeSlack(bridge){let messages=[],receive;const transport={connect:async handler=>{receive=handler;return{team_id:'T1',user_id:'UBOT'};},close:async()=>{},send:async body=>{messages.push(body);return{ok:true,channel:'C1',ts:`123.${messages.length}`};}};const runtime=new SlackRuntime(bridge,{config:{enabled:true,outboundEnabled:true,decisionsEnabled:true,teamId:'T1',botUserId:'UBOT',operatorIds:['U1'],channelIds:['C1'],appTokenRef:'SLACK_APP_TOKEN',botTokenRef:'SLACK_BOT_TOKEN'},resolveCredential:async()=> 'fixture-value',transportFactory:()=>transport});return{runtime,messages};}
test('Decision → fake Slack B → exactly one continuation → verification and acceptance; details do not answer',async t=>{
 const f=await fixture(t),m=f.create({objective:'DECISION: ask which strategy before changing alpha to beta.',allowed_files:['fixture.txt','strategy.txt'],criteria:[{id:'expected_file',type:'exact_file',path:'fixture.txt',content:'beta\n'},{id:'strategy',type:'exact_file',path:'strategy.txt',content:'B\n'}]});f.bridge.missions.dispatch(m.id,{request_id:'question'});const waiting=await f.settle(m.id,'waiting_for_operator');assert.equal(f.calls(),1);const d=waiting.decisions[0];
 const slack=fakeSlack(f.bridge);await slack.runtime.start();f.bridge.slackRuntime=slack.runtime;for(let i=0;i<4;i++)await slack.runtime.tick();assert.ok(slack.messages.some(m=>m.blocks));assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_slack_threads').get().n,1);
 const route=f.bridge.memory.db.prepare('SELECT * FROM cp_slack_threads').get();const interaction=(action,value,user='U1',id=action)=>({envelope_id:id,body:{team:{id:'T1'},user:{id:user},channel:{id:'C1'},message:{thread_ts:route.thread_ts},actions:[{action_id:action,value:JSON.stringify({decision_id:d.id,nonce:d.nonce,...value})}]},ack:async()=>{}});
 await slack.runtime.gateway.receive(interaction('show_details',{}));assert.equal(f.bridge.controlStore.decision(d.id).state,'waiting_for_operator');await slack.runtime.gateway.receive(interaction('decision_answer:1',{option_id:'B'},'U2','wrong'));assert.equal(f.bridge.controlStore.decision(d.id).state,'waiting_for_operator');
 await slack.runtime.gateway.receive(interaction('decision_answer:1',{option_id:'B'},'U1','answer'));f.bridge.missions.answer(d.id,{request_id:'hub-race',option_id:'A'});await slack.runtime.gateway.receive(interaction('decision_answer:1',{option_id:'B'},'U1','answer'));
 const done=await f.settle(m.id);assert.equal(done.decisions[0].answer.option_id,'B');assert.equal(f.calls(),2);assert.equal(f.inference(),0);assert.equal(done.tasks.length,2);assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_continuations').get().n,1);assert.equal(done.verifications[0].result,'passed');f.bridge.missions.accept(m.id,{request_id:'human-accept',verification_id:done.verifications[0].id,decision:'accept',rationale:'Independent checks passed'});assert.equal(f.bridge.missions.detail(m.id).state,'completed');
});
test('waiting Decision and answered undispatched intent survive restart; free text resumes once',async t=>{
 const f=await fixture(t),m=f.create({objective:'DECISION before edit'});f.bridge.missions.dispatch(m.id,{request_id:'start'});const w=await f.settle(m.id,'waiting_for_operator');await f.reopen();await f.bridge.missions.close();assert.equal(f.bridge.controlStore.decision(w.decisions[0].id).state,'waiting_for_operator');
 f.bridge.controlStore.answerDecision(w.decisions[0].id,{free_text:'Use beta, preserve tests',actor:'operator',surface:'operator'});await f.reopen();const done=await f.settle(m.id);assert.equal(f.calls(),2);await f.bridge.missions.tick();assert.equal(f.calls(),2);assert.equal(done.verifications[0].result,'passed');
});
test('worker claims cannot verify; failed exact criterion requires explicit rework with new task',async t=>{
 const f=await fixture(t),m=f.create({criteria:[{id:'expected',type:'exact_file',path:'fixture.txt',content:'gamma\n'}]});f.bridge.missions.dispatch(m.id,{request_id:'fail-criterion'});const failed=await f.settle(m.id,'needs_rework');assert.equal(failed.verifications[0].result,'failed');assert.equal(f.calls(),1);await f.bridge.missions.tick();assert.equal(f.calls(),1);f.bridge.missions.dispatch(m.id,{request_id:'explicit-rework'});await f.settle(m.id,'needs_rework');assert.equal(f.bridge.missions.detail(m.id).tasks.length,2);assert.equal(f.calls(),2);
});
test('unsupported criterion requires operator evidence; terminal transitions and undeclared routes fail closed',async t=>{
 const f=await fixture(t),m=f.create({criteria:[{id:'design',type:'review',description:'Operator reviews suitability'}]});f.bridge.missions.dispatch(m.id,{request_id:'review'});const done=await f.settle(m.id);assert.equal(done.verifications[0].result,'operator_review');assert.throws(()=>f.bridge.missions.accept(m.id,{request_id:'missing-evidence',verification_id:done.verifications[0].id,decision:'accept',rationale:'Looks good'}),/evidence/);const accepted=f.bridge.missions.accept(m.id,{request_id:'reviewed',verification_id:done.verifications[0].id,decision:'accept',rationale:'Reviewed exact diff',evidence:'Operator inspected fixture.txt and test receipt'});assert.equal(accepted.state,'completed');assert.throws(()=>assertTransition('completed','running'));assert.throws(()=>assertTransition('cancelled','running'));
});
test('expired and cancelled decisions never resume; no eligible agent blocks without inference',async t=>{
 const f=await fixture(t),m=f.create({preferred_agent:'cursor'});f.bridge.missions.dispatch(m.id,{request_id:'no-fallback'});const blocked=await f.settle(m.id,'blocked');assert.equal(blocked.reason,'no_compatible_available_agent');assert.equal(f.calls(),0);assert.throws(()=>f.bridge.controlStore.createDecision(m.id,{question:'Human decision'}),/Invalid Mission transition/);
 const q=f.create({objective:'DECISION before editing'});f.bridge.missions.dispatch(q.id,{request_id:'question-expiry'});const waiting=await f.settle(q.id,'waiting_for_operator');const d=waiting.decisions[0];f.bridge.memory.db.prepare('UPDATE cp_decisions SET expires_at=? WHERE id=?').run(Date.now()-1,d.id);assert.equal(f.bridge.missions.answer(d.id,{request_id:'expired',option_id:'A'}).state,'expired');assert.equal(f.calls(),1);f.bridge.missions.cancel(q.id,{request_id:'cancel'});assert.equal(f.bridge.missions.detail(q.id).state,'cancelled');await f.bridge.missions.tick();assert.equal(f.calls(),1);
});
test('independent verification catches tampering after worker settlement and protects test inputs',async t=>{
 const f=await fixture(t);assert.throws(()=>f.create({allowed_files:['fixture.txt','tests/fixture.test.cjs']}),/protected/);
 const original=f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);f.bridge.missions.verifier.verify=async(m,r)=>{fs.writeFileSync(path.join(f.repo,'fixture.txt'),'wrong\n');return original(m,r);};
 const m=f.create();f.bridge.missions.dispatch(m.id,{request_id:'tamper'});const failed=await f.settle(m.id,'needs_rework');assert.equal(failed.verifications[0].result,'failed');assert.ok(failed.verifications[0].evidence.some(c=>c.id==='expected_file'&&c.status==='failed'));assert.equal(f.calls(),1);
});
test('Mission write lease conflict blocks dispatch; explicit retry preserves prior task',async t=>{
 const f=await fixture(t),m=f.create(),store=f.bridge.controlStore;store.startRun({id:'other-run',taskId:m.task_id,missionId:m.id,agentId:'pi'});store.acquireLease({resource:f.repo,runId:'other-run'});f.bridge.missions.dispatch(m.id,{request_id:'conflict'});await f.settle(m.id,'blocked');assert.equal(f.calls(),0);store.updateRun('other-run',{state:'completed',processState:'not_started',verified:true});f.bridge.missions.dispatch(m.id,{request_id:'after-release'});await f.settle(m.id);assert.equal(f.calls(),1);
});
test('offline Slack retains decision; operator A answer resumes once',async t=>{
 const f=await fixture(t),m=f.create({objective:'DECISION before editing'});f.bridge.missions.dispatch(m.id,{request_id:'offline'});const w=await f.settle(m.id,'waiting_for_operator');assert.equal(f.bridge.slackRuntime.status().enabled,false);assert.equal(f.bridge.slackRuntime.status().connected,false);assert.equal(w.decisions[0].answer,null);f.bridge.missions.answer(w.decisions[0].id,{request_id:'operator-A',option_id:'A'});const done=await f.settle(m.id);assert.equal(done.decisions[0].answer.option_id,'A');assert.equal(f.calls(),2);
});
test('authorized fake Slack stop cancels Mission without deleting work or resuming',async t=>{
 const f=await fixture(t),m=f.create({objective:'DECISION before editing'});f.bridge.missions.dispatch(m.id,{request_id:'stop-fixture'});const w=await f.settle(m.id,'waiting_for_operator'),d=w.decisions[0];const slack=fakeSlack(f.bridge);f.bridge.slackRuntime=slack.runtime;await slack.runtime.start();for(let i=0;i<4;i++)await slack.runtime.tick();const route=f.bridge.memory.db.prepare('SELECT * FROM cp_slack_threads').get();await slack.runtime.gateway.receive({envelope_id:'stop',body:{team:{id:'T1'},user:{id:'U1'},channel:{id:'C1'},message:{thread_ts:route.thread_ts},actions:[{action_id:'stop_mission',value:JSON.stringify({decision_id:d.id,nonce:d.nonce})}]},ack:async()=>{}});assert.equal(f.bridge.missions.detail(m.id).state,'cancelled');assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');await f.bridge.missions.tick();assert.equal(f.calls(),1);
});
test('verification-only retry holds lease, preserves implementation, is idempotent and never accepts',async t=>{
 const f=await fixture(t),m=f.create();const invoke=f.bridge.invokeCapability.bind(f.bridge);let fail=true;
 f.bridge.invokeCapability=async(id,request)=>{if(fail&&request.name==='vscode_run_task'&&request.input.label==='fixture-test')return{status:'completed',result:{exit_code:1,timed_out:false,output:'fixture runtime unavailable'}};return invoke(id,request);};
 f.bridge.missions.dispatch(m.id,{request_id:'retry-test-dispatch'});await f.settle(m.id,'needs_rework');const calls=f.calls();fail=false;
 const result=await f.bridge.missions.reverify(m.id,{id:m.id,request_id:'retry-test-verify'});
 assert.equal(result.result,'passed');assert.equal(f.calls(),calls);assert.equal(f.bridge.missions.detail(m.id).state,'awaiting_acceptance');assert.equal(f.bridge.memory.db.prepare('SELECT count(*) n FROM cp_acceptances WHERE mission_id=?').get(m.id).n,0);
 const duplicate=await f.bridge.missions.reverify(m.id,{id:m.id,request_id:'retry-test-verify'});assert.equal(duplicate.duplicate,true);
 const fresh=f.create({objective:'Fresh verification guard',allowed_files:['new.txt'],criteria:[{id:'new',type:'exact_file',path:'new.txt',content:'new'}]});await assert.rejects(f.bridge.missions.reverify(fresh.id,{id:fresh.id,request_id:'invalid-ready'}),/verification/);
});
