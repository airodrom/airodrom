'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { completeHistoricalNative } = require('./fixtures/historical-native-fixture.cjs');
const { manifest } = require('./fixtures/opencode-fixture.cjs');
const { diagnose, repairInput, repairAuthority } = require('../src/autonomous-repair');

function failingNative(f, extra = {}) {
  return f.create({
    objective: 'Change fixture.txt from alpha to beta. Make its test pass.',
    task_type: 'local_files',
    manifest: manifest(f.repo),
    dispatch_policy: {
      privacy: 'local_only', providers: ['local'], billing_classes: ['local'],
      task_category: 'deterministic_files',
      // Intentionally wrong content so host verification fails once.
      native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'gamma\n' }],
    },
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }],
    ...extra,
  });
}

function stage(m, id = 'one') {
  return {
    id,
    depends_on: [],
    mission_id: m.id,
    objective: 'Bounded exact-file step',
    acceptance_criteria: ['Exact file criterion passes'],
    verification_requirements: ['Independent registered tests'],
    human_checkpoint: false,
  };
}

function plan(f, stages) {
  const m = f.bridge.controlStore.requireMission(stages[0].mission_id);
  return f.bridge.missions.goalPlanner.create({
    request_id: randomUUID(), goal_id: m.goal_id, stages, max_runtime_hours: 1, max_attempts: 3,
  });
}

function authorize(f, id, extra = {}) {
  return f.bridge.autonomousExecution.authorize(id, {
    request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1,
    max_dispatches: 10, max_repairs: 1, confirmed: true, ...extra,
  });
}

test('diagnose requires host verification failure and verified termination', async t => {
  const f = await fixture(t), m = failingNative(f);
  assert.equal(diagnose(f.bridge.controlStore.requireMission(m.id), f.bridge.controlStore).ok, false);
  await completeHistoricalNative(f,m);
  const failed = await f.settle(m.id, 'needs_rework');
  assert.equal(failed.state, 'needs_rework');
  const d = diagnose(f.bridge.controlStore.requireMission(m.id), f.bridge.controlStore);
  assert.equal(d.ok, true);
  assert.match(d.summary, /expected_file|task:fixture-test/);
});

test('one authorized failure yields one distinct Cursor correction within the original Mission',async t=>{
 const f=await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{repairs:1,manual:true});f.plan=f.plan.slice(0,1);f.wrongFirst=true;
 const p=await f.ask({review:false}),done=await f.settle(p.mission_id),attempts=done.specialists.assignments[0].attempts;
 assert.equal(attempts.length,2);assert.notEqual(attempts[0].run_id,attempts[1].run_id);assert.equal(attempts[0].verification.status,'failed');assert.equal(attempts[1].verification.status,'passed');assert.equal(done.specialists.repair_attempts,1);
 assert.equal(fs.readFileSync(path.join(done.envelope.workspace,'fixture.txt'),'utf8'),'beta\n');assert.equal(done.acceptance.length,0);
 assert.equal(f.bridge.controlStore.listMissions().length,1);await f.bridge.missions.tick();assert.equal(f.calls.length,2);
});

test('historical uncertainty cannot authorize a corrective implementation',async t=>{
 const f=await fixture(t),m=failingNative(f),run=randomUUID();
 f.bridge.controlStore.startRun({id:run,taskId:m.task_id,missionId:m.id,agentId:'host'});f.bridge.controlStore.updateRun(run,{state:'interrupted',processState:'unknown',verified:false});
 f.bridge.controlStore.db.prepare("UPDATE cp_missions SET state='needs_rework' WHERE id=?").run(m.id);
 assert.equal(diagnose(f.bridge.controlStore.requireMission(m.id),f.bridge.controlStore).ok,false);
 assert.throws(()=>f.bridge.missions.dispatch(m.id,{request_id:randomUUID()}));assert.equal(f.bridge.controlStore.listMissions().length,1);assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'alpha\n');
});

test('historical repair scope preserves pre-existing owner dirt without authorizing a new writer',async t=>{
 const f=await fixture(t);fs.writeFileSync(path.join(f.repo,'README-OWNER-ACCEPTANCE.txt'),'owner notes\n');const parent=failingNative(f);
 assert.deepEqual(parent.envelope.baseline.dirty,['README-OWNER-ACCEPTANCE.txt']);await completeHistoricalNative(f,parent);await f.settle(parent.id,'needs_rework');
 const failed=f.bridge.controlStore.requireMission(parent.id),d=diagnose(failed,f.bridge.controlStore);assert.equal(d.ok,true);
 const repair=f.bridge.missions.create(repairInput(failed,d),'operator');assert.equal(repair.envelope.repair_of,parent.id);assert.deepEqual(repair.envelope.allowed_files,parent.envelope.allowed_files);
 assert.throws(()=>f.bridge.missions.dispatch(repair.id,{request_id:randomUUID()}),/CURSOR_IMPLEMENTATION_REQUIRED/);assert.equal(fs.readFileSync(path.join(f.repo,'README-OWNER-ACCEPTANCE.txt'),'utf8'),'owner notes\n');
});

test('repairInput omits work_template and strips envelope-only authority fields', () => {
  const now = Date.now();
  const parent = {
    id: randomUUID(),
    project_id: randomUUID(),
    goal_id: randomUUID(),
    envelope: {
      objective: 'Change fixture.txt from alpha to beta.',
      workspace: '/tmp/fixture-workspace',
      allowed_files: ['fixture.txt'],
      criteria: [{ id: 'owner-review', type: 'operator_review', description: 'Review' }],
      verification: { tests: ['fixture-test'], syntax: [] },
      preferred_agent: 'opencode',
      fallback_agents: [],
      capability_scopes: ['repo', 'developer_environment'],
      task_type: 'focused_refactor',
      work_template: { project: 'self-repair', workspace: 'self-repair', hash: 'abc' },
      authority: {
        version: 1,
        level: 'development',
        label: 'Development',
        permissions: { repository: ['read', 'write'], runtime: ['diagnostic', 'test'], network: ['localhost'], secrets: [], data: ['read', 'workspace_write'] },
        filesystem: { read: ['/tmp/fixture-workspace'], write: ['/tmp/fixture-workspace'] },
        expiresAt: now + 48 * 60 * 60 * 1000,
      },
    },
  };
  const input = repairInput(parent, {
    ok: true,
    summary: 'task:fixture-test',
    objective: 'Repair failed verification (task:fixture-test). Restore the original approved outcome.',
  });
  assert.equal(input.repair_of, parent.id);
  assert.equal(input.work_template, undefined);
  assert.deepEqual(input.allowed_files, ['fixture.txt']);
  assert.equal(input.authority.version, undefined);
  assert.equal(input.authority.label, undefined);
  assert.equal(input.authority.level, 'development');
  assert.ok(input.authority.expiresAt > now && input.authority.expiresAt <= now + 24 * 60 * 60 * 1000);
  const refreshed = repairAuthority({ authority: { ...parent.envelope.authority, expiresAt: now - 1 } }, now);
  assert.equal(refreshed.expiresAt, now + 60 * 60 * 1000);
});

test('new dirty outside allowed_files still blocks repair create', async t => {
  const f = await fixture(t), parent = failingNative(f);
  await completeHistoricalNative(f,parent);
  await f.settle(parent.id, 'needs_rework');
  fs.writeFileSync(path.join(f.repo, 'outside.txt'), 'leak\n');
  const diagnosis = diagnose(f.bridge.controlStore.requireMission(parent.id), f.bridge.controlStore);
  assert.equal(diagnosis.ok, true);
  const input = repairInput(f.bridge.controlStore.requireMission(parent.id), diagnosis);
  assert.throws(() => f.bridge.missions.create(input, 'operator'), /dirty_outside_repair_scope/);
});

test('repair objectives include parent id before 180-char Mission name truncation', async t => {
  const f = await fixture(t), parent = failingNative(f);
  await completeHistoricalNative(f,parent);
  await f.settle(parent.id, 'needs_rework');
  const diagnosis = diagnose(f.bridge.controlStore.requireMission(parent.id), f.bridge.controlStore);
  assert.equal(diagnosis.ok, true);
  assert.match(diagnosis.objective, new RegExp('Repair \\[' + parent.id.slice(0, 8) + '\\]'));
  assert.ok(diagnosis.objective.indexOf(parent.id.slice(0, 8)) < 180);
  // Prior truncated names collided across parents on the same Goal; the parent marker prevents that.
  const legacy = 'Repair failed verification (' + diagnosis.summary + '). Restore the original approved outcome. Original objective: '
    + 'Change fixture.txt from alpha to beta. Preserve exactly one trailing newline. Do not commit, push, merge or deploy. [aaaaaaaa]';
  const legacyOther = 'Repair failed verification (' + diagnosis.summary + '). Restore the original approved outcome. Original objective: '
    + 'Change fixture.txt from alpha to beta. Preserve exactly one trailing newline. Do not commit, push, merge or deploy. [bbbbbbbb]';
  assert.equal(legacy.slice(0, 180), legacyOther.slice(0, 180));
  assert.notEqual(diagnosis.objective.slice(0, 180), legacy.slice(0, 180));
  const created = f.bridge.missions.create(repairInput(f.bridge.controlStore.requireMission(parent.id), diagnosis), 'operator');
  assert.equal(created.envelope.repair_of, parent.id);
  assert.match(created.envelope.objective, new RegExp('Repair \\[' + parent.id.slice(0, 8) + '\\]'));
});
