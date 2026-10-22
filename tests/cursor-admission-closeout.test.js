'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const R = require('../src/cognitive-router');
const sandbox = require('../src/projectless-sandbox');

const LIVE =
  'For the enrolled Airodrom chatgpt-handoff disposable repository, use OpenCode as planner and evaluator and Cursor as the explicitly requested implementation specialist. Perform a single small authorized fixture edit to recovery-proof.txt with exactly AIRODROM-CHATGPT-HANDOFF-PASS followed by one LF newline.';

test('historical ChatGPT Cursor phrasing preserves planner/specialist/evaluator roles', () => {
  assert.equal(sandbox.explicitlyRequestsCursor(LIVE), true);
  assert.equal(R.requestedWorker(LIVE, { cursorDisabled: false }), 'cursor');
  const roles = R.resolveWorkerRoles(LIVE, { cursorDisabled: false });
  assert.equal(roles.planner, 'opencode');
  assert.equal(roles.specialist, 'cursor');
  assert.equal(roles.evaluator, 'opencode');
  assert.throws(() => R.requestedWorker(LIVE, { cursorDisabled: true }), /CURSOR_EXECUTION_DISABLED/);
});

test('idle needs_rework grants do not occupy concurrent Mission capacity', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  const project = f.bridge.projects.listProjects({ status: 'active' })[0];
  const goal = f.bridge.projects.summary(project.projectId).goals[0];
  const enrolled = f.bridge.developerAutonomy.enroll({
    alias: 'capacity-idle-' + randomUUID().slice(0, 8),
    repository: f.repo,
    project_id: project.projectId,
    goal_id: goal.goalId,
    workflows: ['routine_edit', 'test', 'repair'],
    workers: ['opencode'],
    duration_days: 1,
    confirmed: true,
    diff_check: 'diff-check',
    default_tests: ['fixture-test'],
    budgets: { max_repairs: 2, max_concurrent_missions: 1, grant_ttl_minutes: 60, max_files: 8, max_worktrees: 4, max_runtime_hours: 2, max_disk_mb: 512 }
  }, 'operator');
  const policy = f.bridge.developerAutonomy.inspect(enrolled.policy_id);
  const da = f.bridge.developerAutonomy;
  assert.equal(da.reservations(policy.policy_id), 0);
  const auth = da.authorizeRoutine({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    objective: 'Synthetic unchanged implementation',
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit',
    repair_budget: 2,
    criteria: [{ id: 'expected-file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }]
  }, 'operator');
  assert.equal(da.reservations(policy.policy_id), 1);
  // Bind Mission without dispatch so no auto-repair writer appears — mirrors live idle hang.
  const mission = f.bridge.missions.create(auth.mission_input, 'operator');
  const authority = f.bridge.controlStore.authorityRuntime;
  if (authority?.active) authority.store.setState(mission.id, 'needs_rework');
  f.bridge.controlStore.db.prepare("UPDATE cp_missions SET state='needs_rework', reason=? WHERE id=?")
    .run('Verification failed', mission.id);
  assert.equal(da.workspaceIdle(auth.workspace.path), true);
  assert.equal(da.reservations(policy.policy_id), 0,
    'idle needs_rework must free concurrent admission while preserving the grant for repair');
  assert.equal(da.inspectGrant(auth.grant.grant_id).state, 'active');
  const second = da.authorizeRoutine({
    policy_id: policy.policy_id,
    request_id: randomUUID(),
    objective: 'Second Mission after idle needs_rework',
    allowed_files: ['fixture.txt'],
    workflow: 'routine_edit',
    repair_budget: 0
  }, 'operator');
  assert.ok(second.grant.grant_id);
  assert.notEqual(second.grant.grant_id, auth.grant.grant_id);
});

test('standing DA with Cursor request does not present Local OpenCode when Cursor disabled', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  assert.equal(f.bridge.hostExecutionPolicy.cursorDisabled(), true);
  const project = f.bridge.projects.listProjects({ status: 'active' })[0];
  const goal = f.bridge.projects.summary(project.projectId).goals[0];
  f.bridge.developerAutonomy.enroll({
    alias: 'cursor-admit-' + randomUUID().slice(0, 8),
    repository: f.repo, project_id: project.projectId, goal_id: goal.goalId,
    workflows: ['routine_edit'], workers: ['opencode'], duration_days: 1, confirmed: true,
    diff_check: 'diff-check', default_tests: ['fixture-test'], budgets: { max_repairs: 0 }
  }, 'operator');
  f.bridge.globalAutopilot?.enable?.({ confirmed: true, request_id: randomUUID() }, 'operator');
  const view = await f.bridge.zeroSetupWork.ask({
    request_id: 'cursor_admit_' + randomUUID().replace(/-/g, '').slice(0, 12),
    instruction: 'In Fixture project use OpenCode as planner and evaluator and Cursor as the explicitly requested implementation specialist. Change fixture.txt from alpha to beta.'
  }, 'mcp:' + randomUUID());
  assert.equal(view.state, 'BLOCKED');
  assert.ok(view.blockers.includes('CURSOR_EXECUTION_DISABLED'));
  assert.equal(view.requested_specialist, 'cursor');
  assert.equal(view.planner, 'opencode');
  assert.equal(view.evaluator, 'opencode');
  assert.notEqual(view.presentation?.worker, 'Local OpenCode');
});

test('cognitive enrollment without Cursor worker returns precise allowlist gate', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  f.bridge.hostExecutionPolicy.enableCursor({ confirmed: true, request_id: randomUUID() }, 'operator');
  assert.equal(f.bridge.hostExecutionPolicy.cursorDisabled(), false);
  const project = f.bridge.projects.listProjects({ status: 'active' })[0];
  const goal = f.bridge.projects.summary(project.projectId).goals[0];
  f.bridge.developerAutonomy.enroll({
    alias: 'cursor-allowlist-' + randomUUID().slice(0, 8),
    repository: f.repo, project_id: project.projectId, goal_id: goal.goalId,
    workflows: ['routine_edit'], workers: ['opencode'], duration_days: 1, confirmed: true,
    diff_check: 'diff-check', default_tests: ['fixture-test'], budgets: { max_repairs: 0 },
    cognitive: {
      version: 3, files: ['fixture.txt'], delegated_callers: [], planning_attempts: 1,
      planning_ms: 120000, execution_ms: 120000, repair_attempts: 0, max_assignments: 1,
      acceptance: 'automatic'
    }
  }, 'operator');
  f.bridge.globalAutopilot?.enable?.({ confirmed: true, request_id: randomUUID() }, 'operator');
  const view = await f.bridge.zeroSetupWork.ask({
    request_id: 'cursor_allow_' + randomUUID().replace(/-/g, '').slice(0, 12),
    instruction: 'In Fixture project use OpenCode as planner and evaluator and Cursor as the explicitly requested implementation specialist. Change fixture.txt from alpha to beta.'
  }, 'mcp:' + randomUUID());
  assert.equal(view.state, 'BLOCKED');
  assert.deepEqual(view.blockers, ['standing_cursor_worker_not_enrolled']);
  assert.equal(view.requested_specialist, 'cursor');
  assert.equal(view.presentation?.worker, 'cursor');
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_runs WHERE agent_id='cursor'").get().n, 0);
});
