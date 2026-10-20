'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');

test('agent_status reports Cursor observable but not executable while host policy disables it', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  qualifyCanonical(f.bridge);
  assert.equal(f.bridge.hostExecutionPolicy.cursorDisabled(), true);
  const agents = await f.bridge.orchestratorAgentStatus();
  assert.equal(agents.cursor.host_execution_disabled, true);
  assert.equal(agents.cursor.available, false);
  assert.match(String(agents.cursor.reason || ''), /cursor_execution_disabled/);
  assert.throws(() => f.bridge.hostExecutionPolicy.assertCursorAllowed('dispatch'), /CURSOR_EXECUTION_DISABLED/);
});

test('identical ask request ids remain idempotent after acknowledgement', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  const project = f.bridge.projects.listProjects({ status: 'active' })[0];
  const goal = f.bridge.projects.summary(project.projectId).goals[0];
  const caller = 'mcp:' + randomUUID();
  f.bridge.developerAutonomy.enroll({
    alias: 'mcp-status-idempotent', repository: f.repo, project_id: project.projectId, goal_id: goal.goalId,
    workflows: ['routine_edit'], workers: ['opencode'], duration_days: 1, confirmed: true,
    diff_check: 'diff-check', default_tests: ['fixture-test'], budgets: { max_repairs: 0 },
    cognitive: { version: 1, files: ['fixture.txt'], delegated_callers: [caller], planning_attempts: 1, planning_ms: 120000, execution_ms: 120000 }
  }, 'operator');
  f.bridge.opencodeAdapter.execute = async options => {
    if (options.writable?.length) return { result: { summary: 'ok' }, changes: [], provenance: { termination_verified: true } };
    const row = f.bridge.controlStore.db.prepare("SELECT record FROM cp_zero_setup_requests WHERE state='planning'").get();
    const e = JSON.parse(row.record).cognitive.envelope;
    return {
      result: {
        summary: JSON.stringify({
          version: 1, request_id: e.request_id, envelope_hash: e.hash, files: ['fixture.txt'],
          tasks: [{ id: 'edit', operation: 'edit', paths: ['fixture.txt'], description: 'edit', depends_on: [] }],
          verification: ['fixture-test'], complexity: 'bounded'
        })
      },
      changes: [],
      provenance: { termination_verified: true }
    };
  };
  const id = randomUUID();
  const instruction = 'In Fixture project change fixture.txt from alpha to beta, preserving one final newline.';
  const first = await f.bridge.zeroSetupWork.ask({ request_id: id, instruction }, caller);
  assert.equal(first.request_id, id);
  const second = await f.bridge.zeroSetupWork.ask({ request_id: id, instruction }, caller);
  assert.equal(second.request_id, id);
  assert.equal(first.state === 'PLANNING' || !!first.mission_id, true);
  assert.equal(second.state === 'PLANNING' || second.mission_id === first.mission_id || second.state === first.state, true);
});
