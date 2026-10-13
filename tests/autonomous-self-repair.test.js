'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { manifest } = require('./fixtures/opencode-fixture.cjs');
const { diagnose, repairInput } = require('../src/autonomous-repair');

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
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const failed = await f.settle(m.id, 'needs_rework');
  assert.equal(failed.state, 'needs_rework');
  const d = diagnose(f.bridge.controlStore.requireMission(m.id), f.bridge.controlStore);
  assert.equal(d.ok, true);
  assert.match(d.summary, /expected_file|task:fixture-test/);
});

test('one owner-authorized failure yields exactly one corrective Mission then verified resume', async t => {
  const f = await fixture(t), parent = failingNative(f), g = plan(f, [stage(parent)]);
  authorize(f, g.id, { max_repairs: 1 });
  await f.bridge.autonomousExecution.tick();
  // Failure and the single in-scope repair often settle inside the same Mission tick.
  let repairId = null, sawParentFail = false;
  for (let i = 0; i < 400 && !repairId; i++) {
    await f.bridge.missions.tick();
    if (f.bridge.missions.detail(parent.id).state === 'needs_rework') sawParentFail = true;
    const view = f.bridge.autonomousExecution.inspect(g.id);
    repairId = view.autonomous.repair_lineage?.one?.repair_mission_id || null;
    if (!repairId) await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(sawParentFail, true);
  assert.ok(repairId, 'exactly one repair Mission must be created');
  assert.notEqual(repairId, parent.id);
  assert.equal(f.bridge.autonomousExecution.inspect(g.id).autonomous.repair_counts.one, 1);
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").get(parent.id).n, 1);

  const repaired = await f.settle(repairId, 'awaiting_acceptance');
  assert.equal(repaired.state, 'awaiting_acceptance');
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'beta\n');
  assert.equal(Buffer.from(fs.readFileSync(path.join(f.repo, 'fixture.txt'))).toString('hex'), '626574610a');
  assert.ok(repaired.verifications[0].evidence.some(c => c.id === 'expected_file' && c.status === 'passed'));
  assert.ok(repaired.verifications[0].evidence.some(c => c.id === 'task:fixture-test' && c.status === 'passed'));
  assert.equal(repaired.acceptance.length, 0);
  assert.equal(repaired.envelope.repair_of, parent.id);
  // Parent retains the controlled failure evidence.
  assert.equal(f.bridge.missions.detail(parent.id).state, 'needs_rework');
  assert.ok(f.bridge.missions.detail(parent.id).verifications.some(v => v.result === 'failed'));

  // Goal stage follows the repair Mission; original Goal identity preserved.
  const stages = f.bridge.missions.goalPlanner.inspect(g.id).stages;
  assert.equal(stages[0].mission_id, repairId);
  assert.equal(stages[0].state, 'waiting_approval');
  assert.equal(stages[0].reason, 'acceptance_required');

  // No second repair after success path; unauthorized files untouched.
  assert.equal(fs.existsSync(path.join(f.repo, 'outside.txt')), false);
  const before = f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_missions").get().n;
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_missions").get().n, before);
});

test('uncertain or budget-exhausted failure does not spawn a repair', async t => {
  const f = await fixture(t), m = failingNative(f), g = plan(f, [stage(m)]);
  authorize(f, g.id, { max_repairs: 1 });
  await f.bridge.autonomousExecution.tick();
  f.bridge.controlStore.db.prepare("UPDATE cp_missions SET state='needs_rework' WHERE id=?").run(m.id);
  // No verification row / unverified termination → fail closed.
  await f.bridge.autonomousExecution.tick();
  const view = f.bridge.autonomousExecution.inspect(g.id);
  assert.equal(view.autonomous.repair_lineage?.one?.repair_mission_id || null, null);
  assert.equal(view.autonomous.last_action, 'repair_blocked');
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
});

test('parent-baseline pre-existing dirty outside allowed_files does not block repair create', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.repo, 'README-OWNER-ACCEPTANCE.txt'), 'owner notes\n');
  const parent = failingNative(f);
  assert.deepEqual(parent.envelope.baseline.dirty, ['README-OWNER-ACCEPTANCE.txt']);
  const g = plan(f, [stage(parent)]);
  authorize(f, g.id, { max_repairs: 1 });
  await f.bridge.autonomousExecution.tick();
  let repairId = null;
  for (let i = 0; i < 400 && !repairId; i++) {
    await f.bridge.missions.tick();
    repairId = f.bridge.autonomousExecution.inspect(g.id).autonomous.repair_lineage?.one?.repair_mission_id || null;
    if (!repairId) await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(repairId, 'repair must spawn despite pre-existing owner README dirt');
  const repair = f.bridge.controlStore.requireMission(repairId);
  assert.equal(repair.envelope.repair_of, parent.id);
  assert.deepEqual(repair.envelope.allowed_files, parent.envelope.allowed_files);
  assert.equal(fs.existsSync(path.join(f.repo, 'README-OWNER-ACCEPTANCE.txt')), true);
});

test('new dirty outside allowed_files still blocks repair create', async t => {
  const f = await fixture(t), parent = failingNative(f);
  f.bridge.missions.dispatch(parent.id, { request_id: randomUUID() });
  await f.settle(parent.id, 'needs_rework');
  fs.writeFileSync(path.join(f.repo, 'outside.txt'), 'leak\n');
  const diagnosis = diagnose(f.bridge.controlStore.requireMission(parent.id), f.bridge.controlStore);
  assert.equal(diagnosis.ok, true);
  const input = repairInput(f.bridge.controlStore.requireMission(parent.id), diagnosis);
  assert.throws(() => f.bridge.missions.create(input, 'operator'), /dirty_outside_repair_scope/);
});
