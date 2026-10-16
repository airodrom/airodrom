'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');

async function setup(t) {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  const project = f.bridge.projects.listProjects({ status: 'active' })[0];
  const goal = f.bridge.projects.summary(project.projectId).goals.find(g => g.status === 'active')
    || f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Repair quality ' + randomUUID() });
  f.seed = { project_id: project.projectId, goal_id: goal.goalId };
  f.policy = f.bridge.developerAutonomy.enroll({
    alias: 'repair-quality',
    repository: f.repo,
    project_id: f.seed.project_id,
    goal_id: f.seed.goal_id,
    workflows: ['routine_edit', 'repair'],
    budgets: { max_repairs: 1, max_concurrent_missions: 1, grant_ttl_minutes: 60, max_files: 4, max_worktrees: 8, max_runtime_hours: 1, max_disk_mb: 256 },
    workers: ['opencode'],
    duration_days: 7,
    confirmed: true,
    diff_check: 'diff-check',
    default_tests: ['fixture-test']
  }, 'operator');
  return f;
}

function authorize(f, extra = {}) {
  return f.bridge.developerAutonomy.authorizeRoutine({
    policy_id: f.policy.policy_id,
    request_id: randomUUID(),
    objective: 'Leave the approved fixture unchanged',
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit',
    criteria: [{ id: 'expected-file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }],
    repair_budget: 1,
    ...extra
  }, 'operator');
}

function release(f, ids) {
  for (const id of ids) {
    try { f.bridge.missions.cancel(id, { request_id: randomUUID() }); } catch { /* already terminal */ }
  }
}

function repairsOf(f, parentId) {
  return f.bridge.controlStore.db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").all(parentId);
}

test('one preauthorized repair passes host verification and leaves Acceptance pending', async t => {
  const f = await setup(t), b = f.bridge;
  const auth = authorize(f);
  const parent = b.missions.create(auth.mission_input, 'operator');
  b.missions.dispatch(parent.id, { request_id: randomUUID() });
  const failed = await f.settle(parent.id, 'needs_rework');
  assert.equal(failed.verifications[0].result, 'failed');
  assert.equal(failed.acceptance.length, 0);
  const parentVerification = failed.verifications[0].id;
  const rows = repairsOf(f, parent.id);
  assert.equal(rows.length, 1);
  const child = await f.settle(rows[0].id);
  assert.equal(child.state, 'awaiting_acceptance');
  assert.equal(child.acceptance.length, 0);
  assert.ok(['passed', 'operator_review'].includes(child.verifications[0].result));
  assert.match(child.envelope.objective, /REPAIR CONTEXT/);
  assert.match(child.envelope.objective, /diff check/);
  assert.match(child.envelope.objective, /Remaining automatic repair budget after this attempt: 0/);
  assert.equal(fs.readFileSync(child.envelope.workspace + '/fixture.txt', 'utf8'), 'beta\n');
  const again = require('../src/autonomous-repair').considerVerifiedRepair(b, parent.id);
  assert.equal(again.action, 'duplicate');
  assert.equal(again.reason, 'repair_already_dispatched');
  assert.equal(repairsOf(f, parent.id).length, 1);
  assert.equal(b.missions.detail(parent.id).verifications[0].id, parentVerification);
  assert.equal(b.missions.detail(parent.id).verifications[0].result, 'failed');
  assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_acceptances').get().n, 0);
});

test('budget zero, expired authority, duplicate dispatch, failed repair, and unauthorized writes stay closed', async t => {
  const f = await setup(t), b = f.bridge;
  const zero = authorize(f, { repair_budget: 0, objective: 'Leave the approved fixture unchanged for budget zero' });
  const blocked = b.missions.create(zero.mission_input, 'operator');
  b.missions.dispatch(blocked.id, { request_id: randomUUID() });
  const denied = await f.settle(blocked.id, 'needs_rework');
  assert.equal(denied.verifications[0].result, 'failed');
  assert.equal(repairsOf(f, blocked.id).length, 0);
  const skipped = require('../src/autonomous-repair').considerVerifiedRepair(b, blocked.id);
  assert.equal(skipped.reason, 'repair_budget');
  const withheld = b.ledger.list({ missionId: blocked.id, limit: 50 }).events.find(event => event.event_type === 'mission.repair_withheld');
  assert.equal(withheld.metadata.reason, 'repair_budget');
  assert.equal(withheld.metadata.authority, false);
  assert.equal(repairsOf(f, blocked.id).length, 0);
  release(f, [blocked.id]);

  const expiredAuth = authorize(f, { objective: 'Leave the approved fixture unchanged for expiry' });
  const originalVerify = b.missions.verifier.verify.bind(b.missions.verifier);
  b.missions.verifier.verify = async (...args) => {
    const result = await originalVerify(...args);
    b.controlStore.db.prepare('UPDATE cp_developer_autonomy_grants SET expires_at=? WHERE grant_id=?').run(1, expiredAuth.grant.grant_id);
    return result;
  };
  const expiring = b.missions.create(expiredAuth.mission_input, 'operator');
  b.missions.dispatch(expiring.id, { request_id: randomUUID() });
  const expired = await f.settle(expiring.id, 'needs_rework');
  b.missions.verifier.verify = originalVerify;
  assert.equal(expired.verifications[0].result, 'failed');
  assert.equal(repairsOf(f, expiring.id).length, 0);
  assert.equal(require('../src/autonomous-repair').considerVerifiedRepair(b, expiring.id).reason, 'authority_expired');
  release(f, [expiring.id]);

  const failedRepair = authorize(f, {
    objective: 'Leave the approved fixture unchanged',
    criteria: [{ id: 'expected-file', type: 'exact_file', path: 'fixture.txt', content: 'gamma\n' }]
  });
  const parent = b.missions.create(failedRepair.mission_input, 'operator');
  b.missions.dispatch(parent.id, { request_id: randomUUID() });
  const first = await f.settle(parent.id, 'needs_rework');
  const evidence = first.verifications[0].id;
  const childRows = repairsOf(f, parent.id);
  assert.equal(childRows.length, 1);
  const child = await f.settle(childRows[0].id, 'needs_rework');
  assert.equal(child.verifications[0].result, 'failed');
  assert.equal(child.acceptance.length, 0);
  assert.equal(repairsOf(f, child.id).length, 0);
  assert.equal(b.missions.detail(parent.id).verifications.find(v => v.id === evidence).result, 'failed');
  assert.equal(b.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=?").get(child.id).n, 1);
  release(f, [child.id, parent.id]);

  const originalDispatch = b.opencodeAdapter.dispatch.bind(b.opencodeAdapter);
  b.opencodeAdapter.dispatch = async (request) => {
    const output = await originalDispatch(request);
    const mission = b.controlStore.getMission(request.task.controlPlaneMissionId);
    if (mission?.envelope?.repair_of) output.changes.push({ path: 'outside.txt', content: 'no\n', preimage_sha256: '0'.repeat(64) });
    return output;
  };
  const outside = authorize(f, { objective: 'Leave the approved fixture unchanged for an unauthorized write' });
  const outsideParent = b.missions.create(outside.mission_input, 'operator');
  b.missions.dispatch(outsideParent.id, { request_id: randomUUID() });
  const outsideFailed = await f.settle(outsideParent.id, 'needs_rework');
  const outsideChild = repairsOf(f, outsideParent.id);
  assert.equal(outsideChild.length, 1);
  const stopped = await f.settle(outsideChild[0].id, 'needs_rework');
  assert.equal(fs.existsSync(stopped.envelope.workspace + '/outside.txt'), false);
  assert.equal(b.missions.detail(outsideParent.id).verifications[0].id, outsideFailed.verifications[0].id);
  assert.equal(b.missions.detail(outsideParent.id).acceptance.length, 0);
  assert.equal(stopped.acceptance.length, 0);
});

test('an interrupted repair dispatch leaves no mission and a retry dispatches once', async t => {
  const f = await setup(t), b = f.bridge;
  const repair = require('../src/autonomous-repair');
  let interrupt = true;
  const original = b.missions.dispatch.bind(b.missions);
  b.missions.dispatch = (id, input, owner) => {
    const mission = b.controlStore.getMission(id);
    if (interrupt && mission?.envelope?.repair_of) throw Error('dispatch_interrupted');
    return original(id, input, owner);
  };
  const auth = authorize(f);
  const parent = b.missions.create(auth.mission_input, 'operator');
  b.missions.dispatch(parent.id, { request_id: randomUUID() });
  const failed = await f.settle(parent.id, 'needs_rework');
  assert.equal(failed.verifications[0].result, 'failed');
  assert.equal(repairsOf(f, parent.id).length, 0);
  const denied = b.ledger.list({ missionId: parent.id, limit: 80 }).events.filter(event => event.event_type === 'mission.repair_withheld');
  assert.equal(denied.at(-1).metadata.reason, 'dispatch_interrupted');
  assert.equal(denied.at(-1).metadata.action, 'failed');
  interrupt = false;
  const retried = repair.considerVerifiedRepair(b, parent.id);
  assert.equal(retried.action, 'dispatched');
  assert.equal(repairsOf(f, parent.id).length, 1);
  const childId = repairsOf(f, parent.id)[0].id;
  assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(childId).n, 1);
  const repeated = repair.considerVerifiedRepair(b, parent.id);
  assert.equal(repeated.action, 'duplicate');
  assert.equal(b.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(childId).n, 1);
  assert.equal(b.ledger.list({ missionId: parent.id, limit: 80 }).events.filter(event => event.event_type === 'mission.repair_dispatched').length, 1);
  assert.equal(b.missions.detail(parent.id).verifications[0].id, failed.verifications[0].id);
  assert.equal(b.missions.detail(parent.id).acceptance.length, 0);
});
