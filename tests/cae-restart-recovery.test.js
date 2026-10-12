'use strict';
/** Controlled isolated-service restart scenarios for CAE V1 (fixture workers). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { manifest } = require('./fixtures/opencode-fixture.cjs');

function native(f, extra = {}) {
  return f.create({
    objective: 'Synthetic CAE restart step ' + randomUUID(),
    task_type: 'local_files',
    manifest: manifest(f.repo),
    dispatch_policy: {
      privacy: 'local_only', providers: ['local'], billing_classes: ['local'],
      task_category: 'deterministic_files',
      native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'beta\n' }]
    },
    ...extra
  });
}
function stage(m, id = 'one', deps = []) {
  return {
    id, depends_on: deps, mission_id: m?.id, objective: 'Synthetic bounded step',
    acceptance_criteria: ['Registered file criterion passes'],
    verification_requirements: ['Independent registered tests'], human_checkpoint: false
  };
}
function plan(f, stages) {
  const m = f.bridge.controlStore.listMissions()[0];
  return f.bridge.missions.goalPlanner.create({
    request_id: randomUUID(), goal_id: m.goal_id, stages, max_runtime_hours: 1, max_attempts: 3
  });
}
function authorize(f, id, extra = {}) {
  return f.bridge.autonomousExecution.authorize(id, {
    request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1,
    max_dispatches: 20, max_repairs: 3, confirmed: true, ...extra
  });
}
async function accept(f, missionId, tag) {
  const done = await f.settle(missionId);
  return f.bridge.missions.accept(missionId, {
    request_id: tag + '-accept', verification_id: done.verifications[0].id,
    decision: 'accept', rationale: 'Synthetic host verification reviewed'
  });
}

test('A restart before dispatch preserves authorization and then dispatches once', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  await f.reopen(); f.ensureAdmission();
  assert.equal(f.bridge.autonomousExecution.inspect(g.id).execution_enabled, true);
  // Monitor may dispatch during reopen settle; force at most one claim/dispatch.
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n, 1);
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n, 1);
  await accept(f, m.id, 'a');
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
});

test('B restart during waiting dependency does not dispatch dependent Mission', async t => {
  const f = await fixture(t), a = native(f), b = native(f);
  const g = plan(f, [stage(a, 'a'), stage(b, 'b', ['a'])]);
  authorize(f, g.id);
  await f.bridge.autonomousExecution.tick();
  await f.reopen(); f.ensureAdmission();
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(b.id).n, 0);
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).stages.find(s => s.id === 'b').reason, 'dependency_unverified');
});

test('C restart after verified completion does not redispatch', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  await f.bridge.autonomousExecution.tick();
  await accept(f, m.id, 'c');
  const n = f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n;
  await f.reopen(); f.ensureAdmission();
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n, n);
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
});

test('D restart with quarantined lease blocks autonomous dispatch', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  const now = Date.now(), runId = randomUUID();
  f.bridge.controlStore.db.prepare("INSERT INTO cp_leases(id,resource,run_id,mission_id,mode,state,acquired_at,expires_at,baseline) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), m.envelope.workspace, runId, m.id, 'write', 'quarantined', now, now + 60000, '{}');
  // Quarantine is an admission blocker; reopen must not force-open over it.
  await f.reopen();
  assert.equal(f.bridge.lifecycle.status().idle, false);
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n, 0);
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).stages[0].reason, 'uncertain_execution');
});

test('E restart with uncertain dispatch never auto-retries', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id, { workers: ['host', 'opencode'] });
  f.bridge.controlStore.db.prepare("INSERT INTO cp_dispatches VALUES(?,?,?,'unknown',NULL,NULL,NULL,?,?)")
    .run(randomUUID(), m.id, m.task_id, Date.now(), Date.now());
  await f.reopen();
  // Uncertain dispatch closes admission; scheduler must still not invent a second dispatch.
  assert.equal(f.bridge.lifecycle.status().idle, false);
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=? AND state!='unknown'").get(m.id).n, 0);
  assert.throws(() => f.bridge.autonomousExecution.switchWorker(g.id, {
    request_id: randomUUID(), from_worker: 'host', to_worker: 'opencode', confirmed: true
  }), /Uncertain|dispatch|lease/i);
});

test('F restart with expired authorization stops scheduling', async t => {
  const f = await fixture(t), m = native(f), g = plan(f, [stage(m)]);
  authorize(f, g.id);
  f.bridge.controlStore.db.prepare('UPDATE cp_mission_programs SET expires_at=0 WHERE id=?').run(g.id);
  await f.reopen(); f.ensureAdmission();
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n, 0);
});

test('G restart mid multi-stage goal resumes only verified-ready work', async t => {
  const f = await fixture(t), a = native(f);
  const bs = stage(null, 'b', ['a']); delete bs.mission_id;
  const g = plan(f, [stage(a, 'a'), bs]);
  authorize(f, g.id);
  await f.bridge.autonomousExecution.tick();
  await accept(f, a.id, 'g1');
  await f.reopen(); f.ensureAdmission();
  assert.deepEqual(f.bridge.missions.goalPlanner.inspect(g.id).ready, []);
  const b = native(f, {
    objective: 'Second synthetic file', allowed_files: ['second.txt'],
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'second.txt', content: 'beta\n' }],
    dispatch_policy: {
      privacy: 'local_only', providers: ['local'], billing_classes: ['local'],
      task_category: 'deterministic_files',
      native_actions: [{ name: 'file_write', path: 'second.txt', content: 'beta\n' }]
    },
    manifest: (() => { const mf = manifest(f.repo); mf.mission.scope.include = ['second.txt']; return mf; })()
  });
  f.bridge.missions.goalPlanner.bind(g.id, 'b', b.id, 'bind-b');
  await f.bridge.autonomousExecution.tick();
  await accept(f, b.id, 'g2');
  assert.equal(f.bridge.missions.goalPlanner.inspect(g.id).state, 'completed');
});
