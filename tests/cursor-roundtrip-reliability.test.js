'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const R = require('../src/cognitive-router');
const sandbox = require('../src/projectless-sandbox');
const handoff = require('../src/mission-handoff');

const ROUNDTRIP =
  'Test the ChatGPT to Airodrom to OpenCode to Cursor to OpenCode to Airodrom to ChatGPT Mission path using only a disposable enrolled test workspace. Have Cursor change one harmless fixture and return actual host-observed evidence for OpenCode evaluation and durable ChatGPT retrieval. Honor current host execution policy; if Cursor is disabled, return the exact refusal without starting any worker.';

test('explicit Have Cursor change preserves specialist and fails closed when disabled', () => {
  assert.equal(sandbox.explicitlyRequestsCursor(ROUNDTRIP), true);
  assert.equal(R.requestedWorker(ROUNDTRIP, { cursorDisabled: false }), 'cursor');
  assert.throws(() => R.requestedWorker(ROUNDTRIP, { cursorDisabled: true }), /CURSOR_EXECUTION_DISABLED/);
  const roles = R.resolveWorkerRoles(ROUNDTRIP, { cursorDisabled: false });
  assert.equal(roles.planner, 'opencode');
  assert.equal(roles.specialist, 'cursor');
  assert.equal(roles.evaluator, 'opencode');
});

test('implicit implementation requires Cursor and fails closed while disabled', () => {
  const instruction='In Fixture project change fixture.txt from alpha to beta, preserving one final newline.';
  assert.equal(R.requestedWorker(instruction,{cursorDisabled:false}),'cursor');
  assert.throws(()=>R.requestedWorker(instruction,{cursorDisabled:true}),/CURSOR_EXECUTION_DISABLED/);
});

test('coercePlanningProposal never substitutes OpenCode for explicit Cursor when ineligible', () => {
  const envelope = require('../src/cognitive-contracts').seal({
    version: 3, request_id: '11111111-1111-4111-8111-111111111111', caller: 'operator',
    delegation: { policy_id: '22222222-2222-4222-8222-222222222222', policy_hash: 'a'.repeat(64) },
    repository_id: 'proj:policy', workspace_id: '33333333-3333-4333-8333-333333333333',
    git_anchor: 'b'.repeat(40),
    integrity: { version: 1, hash: 'c'.repeat(64), entries: 1, bytes: 1, exclusions: 'none' },
    permitted_paths: ['fixture.txt'], denied_paths: ['.git/**'],
    operations: ['read', 'edit'], eligible_workers: ['host', 'opencode'],
    verification: ['fixture-test'],
    limits: { planning_attempts: 1, execution_attempts: 1, repair_attempts: 0, planning_ms: 120000, execution_ms: 120000 },
    requested_worker: 'cursor', instruction_hash: 'd'.repeat(64), expires_at: Date.now() + 60000
  });
  assert.throws(
    () => R.coercePlanningProposal({
      version: 3, request_id: envelope.request_id, envelope_hash: envelope.hash,
      files: ['fixture.txt'],
      tasks: [{ id: 'edit', operation: 'edit', paths: ['fixture.txt'], description: 'edit', depends_on: [], worker: 'cursor', role: 'implementation', verification: [] }],
      verification: ['fixture-test'], complexity: 'bounded'
    }, envelope),
    /cognitive_worker_unqualified:cursor/
  );
});

test('standing DA enrollment blocks explicit Cursor while host policy disables execution', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  assert.equal(f.bridge.hostExecutionPolicy.cursorDisabled(), true);
  const project = f.bridge.projects.listProjects({ status: 'active' })[0];
  const goal = f.bridge.projects.summary(project.projectId).goals[0];
  const caller = 'mcp:' + randomUUID();
  f.bridge.developerAutonomy.enroll({
    alias: 'cursor-roundtrip-standing', repository: f.repo, project_id: project.projectId, goal_id: goal.goalId,
    workflows: ['routine_edit'], workers: ['opencode'], duration_days: 1, confirmed: true,
    diff_check: 'diff-check', default_tests: ['fixture-test'], budgets: { max_repairs: 0 }
  }, 'operator');
  f.bridge.globalAutopilot?.enable?.({ confirmed: true, request_id: randomUUID() }, 'operator');
  const id = 'cursor_roundtrip_gate_a_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const view = await f.bridge.zeroSetupWork.ask({
    request_id: id,
    instruction: 'In Fixture project have Cursor change fixture.txt from alpha to beta. If Cursor is disabled, return the exact refusal without starting any worker.'
  }, caller);
  assert.equal(view.state, 'BLOCKED');
  assert.deepEqual(view.blockers, ['CURSOR_EXECUTION_DISABLED']);
  assert.equal(view.requested_specialist, 'cursor');
  assert.equal(view.execution_authorized, false);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_runs WHERE agent_id='cursor'").get().n, 0);
});

test('MCP and operator role parsing agree on Have Cursor change', () => {
  const instruction = 'In Fixture project have Cursor change fixture.txt from alpha to beta.';
  assert.equal(sandbox.explicitlyRequestsCursor(instruction), true);
  assert.equal(R.requestedWorker(instruction, { cursorDisabled: false }), 'cursor');
  const roles = R.resolveWorkerRoles(instruction, { cursorDisabled: false });
  assert.equal(roles.planner, 'opencode');
  assert.equal(roles.specialist, 'cursor');
  assert.equal(roles.evaluator, 'opencode');
  assert.throws(() => R.requestedWorker(instruction, { cursorDisabled: true }), /CURSOR_EXECUTION_DISABLED/);
});

test('path narration cannot request an OpenCode implementation fallback', () => {
  const pathOnly =
    'Prove ChatGPT to Airodrom to OpenCode to Cursor to OpenCode to Airodrom to ChatGPT Mission path using local OpenCode only.';
  assert.equal(sandbox.explicitlyRequestsCursor(pathOnly), false);
  for (const cursorDisabled of [false,true])
    assert.throws(() => R.requestedWorker(pathOnly, { cursorDisabled }), /CURSOR_IMPLEMENTATION_REQUIRED/);
});

test('cancel_mission is durable and replay-safe for ask-origin Missions', async t => {
  const principal='mcp:'+randomUUID();
  const f=await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{caller:principal,repairs:0});
  f.plan=f.plan.slice(0,1);
  const view=await f.ask({review:false});
  const missionId=view.mission_id;
  assert.ok(missionId,JSON.stringify(view));
  const cancelId = 'cancel_req_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const first = handoff.cancel(f.bridge, missionId, principal, cancelId);
  assert.equal(first.cancellation_requested, true);
  assert.equal(first.request_id, cancelId);
  const replay = handoff.cancel(f.bridge, missionId, principal, cancelId);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.mission_id, missionId);
  assert.equal(first.cancellation_requested, true);
});
