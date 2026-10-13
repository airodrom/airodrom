'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {fixture}=require('./fixtures/mission-fixture.cjs'),{runtime,qualifyCanonical}=require('./fixtures/opencode-fixture.cjs'),handoff=require('../src/mission-handoff');
async function setup(t){const f=await fixture(t,{opencode:runtime(t).options});f.bridge.missionAuthority.initializeOperatorKey();const seed=f.create();f.input={project:'fixture',workspace_alias:'local',project_id:seed.project_id,goal_id:seed.goal_id,workspace:f.repo,allowed_files:['fixture.txt'],diff_check:'diff-check',tests:['fixture-test'],duration_minutes:60,confirmed:true};return f;}
const packet=()=>({version:2,request_id:randomUUID(),objective:'Change fixture.txt from alpha to beta.',mission_class:'WORK',data_class:'public',privacy:'local_only',project:'fixture',workspace:'local',worker:'auto',model:'auto'});
test('owner-only immutable registration, exact scope and durable inspection',async t=>{const f=await setup(t),r=f.bridge.workTemplates;assert.throws(()=>r.register(f.input,'mcp:fixture'),/operator/);assert.throws(()=>r.register({...f.input,confirmed:false},'operator'),/consent/);const registered=r.register(f.input,'operator');assert.equal(registered.state,'active');assert.deepEqual(registered.workers,['opencode']);assert.throws(()=>r.register({...f.input,allowed_files:['other.txt']},'operator'));assert.throws(()=>r.register(f.input,'operator'));assert.equal(r.list('operator').length,1);await f.reopen();assert.equal(f.bridge.workTemplates.list('operator')[0].template_hash,registered.template_hash);});
test('path, project, verifier, input escalation and dirty overlap fail closed',async t=>{const f=await setup(t),r=f.bridge.workTemplates;for(const allowed_files of [['../outside'],['*'],['tests/fixture.test.cjs'],['.vscode/tasks.json'],['fixture.txt','fixture.txt']])assert.throws(()=>r.register({...f.input,allowed_files},'operator'));assert.throws(()=>r.register({...f.input,authority:{}},'operator'));const p=f.bridge.projects.createProject({name:'Other',repositories:[]});assert.throws(()=>r.register({...f.input,project_id:p.projectId},'operator'),/boundary/);fs.symlinkSync(path.join(f.repo,'fixture.txt'),path.join(f.repo,'linked.txt'));assert.throws(()=>r.register({...f.input,allowed_files:['linked.txt']},'operator'));fs.writeFileSync(path.join(f.repo,'fixture.txt'),'dirty\n');assert.throws(()=>r.register(f.input,'operator'),/dirty/);});
test('V2 local handoff independently verifies, remains unaccepted, and replays once',async t=>{const f=await setup(t),b=f.bridge;qualifyCanonical(b);b.workTemplates.register(f.input,'operator');const p=packet(),first=await handoff.submit(b,p,'mcp:local-fixture');assert.ok(first.mission_id,JSON.stringify(first));assert.equal(first.deferred_dispatch,true);assert.equal(first.next_action,'propose_goal_plan_then_owner_authorize');assert.equal(b.missions.require(first.mission_id).state,'ready');b.missions.dispatch(first.mission_id,{request_id:randomUUID()});const done=await f.settle(first.mission_id);assert.equal(done.state,'awaiting_acceptance');assert.equal(done.runs[0].agent_id,'opencode');assert.ok(done.verifications[0].evidence.some(c=>c.id==='task:fixture-test'&&c.status==='passed'));assert.equal(done.acceptance.length,0);const replay=await handoff.submit(b,p,'mcp:local-fixture');assert.equal(replay.mission_id,first.mission_id);assert.equal(replay.duplicate,true);await assert.rejects(handoff.submit(b,p,'mcp:other'));assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'beta\n');});
test('revocation, stale verifier, seal tamper, route and ceiling escalation deny',async t=>{const f=await setup(t),b=f.bridge,r=b.workTemplates,registered=r.register(f.input,'operator');const scope=r.template('fixture','local');const {privacy,data_class,workers,...input}=scope;assert.throws(()=>b.missions.create({...input,request_id:randomUUID(),objective:'Synthetic',preferred_agent:'opencode',capability_scopes:['host']},'operator'),/ceiling/);const denied=await handoff.submit(b,{...packet(),worker:'codex'},'mcp:local-fixture');assert.equal(denied.state,'WAIT');await assert.rejects(handoff.submit(b,{...packet(),capability_classes:['host']},'mcp:local-fixture'),/exceed/);const m=b.missions.create({...input,request_id:randomUUID(),objective:'Synthetic',preferred_agent:'opencode'},'operator');assert.throws(()=>r.revoke({project:'fixture',workspace_alias:'local',template_hash:registered.template_hash,confirmed:true},'mcp:x'),/operator/);r.revoke({project:'fixture',workspace_alias:'local',template_hash:registered.template_hash,confirmed:true},'operator');assert.throws(()=>b.missions.dispatch(m.id,{request_id:randomUUID()}),/revoked/);assert.equal((await handoff.submit(b,packet(),'mcp:local-fixture')).state,'WAIT');b.controlStore.db.prepare("UPDATE cp_work_templates SET record='{}'").run();assert.equal(r.list('operator')[0].state,'invalid');await assert.rejects(handoff.submit(b,packet(),'mcp:local-fixture'));});
test('verification definition drift invalidates registered templates',async t=>{const f=await setup(t),r=f.bridge.workTemplates;r.register(f.input,'operator');fs.appendFileSync(path.join(f.repo,'.vscode/tasks.json'),' ');assert.equal(r.list('operator')[0].state,'invalid');assert.throws(()=>r.template('fixture','local'),/verification/);});
test('expired consent and workspace replacement fail closed',async t=>{const f=await setup(t),r=f.bridge.workTemplates,record=r.register(f.input,'operator'),now=Date.now;try{Date.now=()=>record.expires_at+1;assert.equal(r.template('fixture','local'),null);assert.equal(r.list('operator')[0].state,'expired');}finally{Date.now=now;}fs.renameSync(f.repo,f.repo+'-original');fs.mkdirSync(f.repo);assert.throws(()=>r.template('fixture','local'),/identity/);});


test('MCP packet cannot authorize template auto Acceptance or alter the approved file ceiling', async t => {
  const f = await setup(t), b = f.bridge;
  qualifyCanonical(b);
  b.workTemplates.register(f.input, 'operator');
  const auto = { file: 'fixture.txt', before: 'alpha\n', after: 'beta\n' };
  await assert.rejects(() => handoff.submit(b, packet(), 'mcp:fixture-auto', auto), /Preauthorized exact-file Acceptance scope required/);
  await assert.rejects(() => handoff.submit(b, packet(), 'operator', { ...auto, file: 'other.txt' }), /Preauthorized exact-file Acceptance scope required/);
  const manual = await handoff.submit(b, packet(), 'operator');
  assert.ok(manual.mission_id);
  const mission = b.missions.require(manual.mission_id);
  assert.equal(mission.envelope.criteria[0].type, 'operator_review');
  assert.equal(mission.envelope.risk_auto_acceptance, undefined);
});

test('template auto Acceptance refuses a changed preimage before Mission creation', async t => {
  const f = await setup(t), b = f.bridge;
  qualifyCanonical(b);
  b.workTemplates.register(f.input, 'operator');
  fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'gamma\n');
  await assert.rejects(() => handoff.submit(b, packet(), 'operator', {
    file: 'fixture.txt', before: 'alpha\n', after: 'beta\n'
  }), /baseline changed/);
});


test('trusted expected-file approval is part of idempotent handoff identity', async t => {
  const f = await setup(t), b = f.bridge;
  qualifyCanonical(b);
  b.workTemplates.register(f.input, 'operator');
  const request = packet();
  const expected = { file: 'fixture.txt', before: 'alpha\n', after: 'beta\n' };
  const first = await handoff.submit(b, request, 'operator', expected);
  assert.ok(first.mission_id);
  const mission = b.missions.require(first.mission_id);
  assert.equal(mission.envelope.criteria.length, 1);
  assert.equal(mission.envelope.criteria[0].type, 'exact_file');
  assert.equal(mission.envelope.risk_auto_acceptance.authorized, true);
  const replay = await handoff.submit(b, request, 'operator', expected);
  assert.equal(replay.mission_id, first.mission_id);
  assert.equal(replay.duplicate, true);
  await assert.rejects(() => handoff.submit(b, request, 'operator', {
    ...expected, after: 'gamma\n'
  }), /replay|conflict|request|changed/i);
});
