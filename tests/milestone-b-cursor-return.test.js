'use strict';
// Milestone B: OpenCode → Cursor → OpenCode return path under Airodrom governance.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');

async function setup(t, { cursor = true, repairs = 1 } = {}) {
  const f = await fixture(t, { opencode: runtime(t).options, settleTimeoutMs: 30000 });
  const b = f.bridge;
  b.missionAuthority.initializeOperatorKey();
  qualifyCanonical(b);
  b.expandedAutonomy.setMode({ mode: 'routine_auto', confirmed: true, request_id: randomUUID(), sync_risk_acceptance: false }, 'operator');
  if (cursor) {
    b.hostExecutionPolicy.enableCursor({ confirmed: true, request_id: randomUUID() }, 'operator');
    b.cursorWorker = new (require('../src/cursor-worker').CursorWorker)(b, {
      fixtureExecutable: path.join(__dirname, 'fixtures/cursor-agent-fixture.cjs'),
    });
  }
  const project = b.projects.listProjects({ status: 'active' })[0];
  const goal = b.projects.summary(project.projectId).goals[0];
  f.policy = b.developerAutonomy.enroll({
    alias: 'milestone-b-fixture',
    repository: f.repo,
    project_id: project.projectId,
    goal_id: goal.goalId,
    workflows: ['routine_edit', 'test', 'repair'],
    workers: cursor ? ['opencode', 'cursor'] : ['opencode'],
    duration_days: 1,
    confirmed: true,
    diff_check: 'diff-check',
    default_tests: ['fixture-test'],
    budgets: { max_repairs: repairs },
    cognitive: {
      version: 3,
      files: ['fixture.txt'],
      delegated_callers: [],
      planning_attempts: 2,
      planning_ms: 120000,
      execution_ms: 120000,
      repair_attempts: repairs,
      max_assignments: 3,
      acceptance: 'automatic',
    },
  }, 'operator');
  f.plan = [
    {
      id: 'implement',
      worker: cursor ? 'cursor' : 'opencode',
      role: 'implementation',
      operation: 'edit',
      paths: ['fixture.txt'],
      description: 'Change alpha to beta',
      depends_on: [],
      verification: [],
    },
    {
      id: 'review',
      worker: 'opencode',
      role: 'review',
      operation: 'read',
      paths: ['fixture.txt'],
      description: 'Review without modifying files',
      depends_on: ['implement'],
      verification: [],
    },
  ];
  f.calls = [];
  f.evaluations = [];
  f.evaluate = (o) => ({
    ...o.coordination.result_contract,
    recommendation: o.coordination.host_checks.some((c) => c.status === 'failed') ? 'repair' : 'ready',
    summary: 'Reviewed host evidence and supplied files.',
  });
  f.bindAdapter = () => {
    const adapter = f.bridge.opencodeAdapter;
    f.worker = adapter.execute.bind(adapter);
    adapter.execute = async (o) => {
      if (o.planning) {
        return {
          result: { summary: JSON.stringify({ ...o.planning, tasks: f.plan }) },
          changes: [],
          provenance: { termination_verified: true },
        };
      }
      if (o.coordination) {
        f.evaluations.push(o.coordination);
        assert.deepEqual(o.writable, []);
        return {
          result: { summary: JSON.stringify(await f.evaluate(o)) },
          changes: [],
          provenance: { runtime_id: 'opencode', sandbox: 'fixture', termination_verified: true, authority: false },
        };
      }
      f.calls.push({ files: o.files, writable: o.writable, input: JSON.parse(o.objective) });
      return f.worker(o.writable.length ? o : { ...o, objective: 'Inspect current files without changes', objectiveProof: null });
    };
  };
  f.bindAdapter();
  f.ask = async () => {
    const request_id = randomUUID();
    const instruction = 'In Fixture project change fixture.txt from alpha to beta.'
      + (f.plan.some(task => task.operation === 'read') ? ' Then review fixture.txt.' : '');
    let view = await b.zeroSetupWork.ask({ request_id, instruction }, 'operator');
    for (let i = 0; i < 200 && view.state === 'PLANNING'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      view = await b.zeroSetupWork.ask({ request_id, instruction }, 'operator');
    }
    return view;
  };
  return f;
}

function packetFields(ret) {
  return [
    'mission_id', 'assignment_id', 'worker_id', 'cursor_run_id', 'dispatch_id', 'authorized_scope_hash',
    'workspace_identity', 'changed_files', 'before_hashes', 'after_hashes', 'diff_summary', 'test_results',
    'execution_status', 'termination_status', 'verification_results', 'errors', 'remaining_repair_budget',
  ].every((k) => Object.prototype.hasOwnProperty.call(ret, k));
}

test('Milestone B: OpenCode proposes Cursor; missing spend grant fails closed; results return with evidence packet', async (t) => {
  const f = await setup(t, { cursor: true, repairs: 0 });
  const pending = await f.ask();
  assert.equal(pending.state, 'WAIT', 'Cursor assignment waits for mission-scoped spend grant');
  await assert.rejects(
    () => f.bridge.zeroSetupWork.approve({ request_id: pending.request_id, confirmed: true, channel: 'control_center' }, 'operator'),
    /Subscription|BLOCKED_SPEND|Cursor|subscription/i,
  );
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_subscription_invocations').get().n, 0);

  const approved = await f.bridge.zeroSetupWork.approve({
    request_id: pending.request_id,
    confirmed: true,
    channel: 'control_center',
    subscription_execution: {
      provider: 'cursor',
      acknowledge_unknown_cost: true,
      max_invocations: 1,
      max_runtime_ms: 120000,
    },
  }, 'operator');
  const m = await f.settle(approved.mission_id, 'completed');
  assert.deepEqual(m.specialists.assignments.map((a) => a.worker), ['cursor', 'opencode']);
  assert.equal(f.evaluations.length, 2);
  const cursorReturn = f.evaluations[0].specialist_return;
  assert.ok(packetFields(cursorReturn), 'Cursor→OpenCode packet includes Milestone B host fields');
  assert.equal(cursorReturn.worker_id, 'cursor');
  assert.equal(cursorReturn.assignment_id, 'implement');
  assert.equal(cursorReturn.mission_id, m.id);
  assert.ok(cursorReturn.cursor_run_id);
  assert.ok(cursorReturn.dispatch_id);
  assert.equal(cursorReturn.authorized_scope_hash.length, 64);
  assert.ok(Array.isArray(cursorReturn.changed_files));
  assert.equal(cursorReturn.authority, false);
  assert.equal(cursorReturn.worker_claims.untrusted, true);
  assert.equal(f.evaluations[0].worker.agent, 'cursor');
  assert.equal(f.evaluations[1].worker.agent, 'opencode');
  assert.ok(f.evaluations[1].specialist_return.prior_results.length >= 1);
  assert.equal(m.specialists.lifecycle.stages.length, 5);
  assert.equal(m.specialists.lifecycle.stages[0].label, 'Planning — OpenCode');
  assert.equal(m.specialists.lifecycle.stages[2].label, 'Evaluating — OpenCode');
  assert.equal(m.specialists.lifecycle.stages[3].label, 'Verifying — Airodrom');
  assert.equal(m.specialists.lifecycle.current, 'settled');
  const evidence = require('../src/mission-evidence').evidencePackage(f.bridge, m.id);
  assert.equal(evidence.acceptance_status, 'accepted');
  assert.equal(evidence.verification.result, 'passed');
  assert.equal(evidence.settlement_status, 'settled');
  assert.equal(
    f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(m.id).n,
    0,
  );
});

test('Milestone B: unauthorized worker and path proposals are rejected without spend', async (t) => {
  for (const change of [
    (plan) => { plan[0].paths.push('outside.txt'); },
    (plan) => { plan[0].worker = 'codex'; },
  ]) {
    const f = await setup(t, { cursor: true, repairs: 0 });
    change(f.plan);
    const pending = await f.ask();
    assert.equal(pending.state, 'BLOCKED');
    assert.equal(f.evaluations.length, 0);
    assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_subscription_invocations').get().n, 0);
  }
});

test('Milestone B: evaluator ready cannot override failed host verification', async (t) => {
  const f = await setup(t, { cursor: false, repairs: 0 });
  f.plan = f.plan.slice(0, 1);
  f.evaluate = (o) => ({
    ...o.coordination.result_contract,
    recommendation: 'ready',
    summary: 'I fixed everything successfully.',
  });
  const adapter = f.bridge.opencodeAdapter;
  const prev = adapter.execute;
  adapter.execute = async (o) => {
    if (o.planning) return prev(o);
    if (o.coordination) {
      f.evaluations.push(o.coordination);
      assert.deepEqual(o.writable, []);
      return {
        result: { summary: JSON.stringify(await f.evaluate(o)) },
        changes: [],
        provenance: { runtime_id: 'opencode', sandbox: 'fixture', termination_verified: true, authority: false },
      };
    }
    // Claim an edit without host-observed changes — verification must fail.
    return {
      result: { summary: 'I fixed everything successfully.', tests: [], limitations: [] },
      changes: [],
      provenance: { runtime_id: 'opencode', sandbox: 'fixture', termination_verified: true, authority: false },
    };
  };
  const pending = await f.ask();
  assert.ok(pending.mission_id, JSON.stringify(pending));
  const m = await f.settle(pending.mission_id, 'needs_rework');
  assert.equal(m.acceptance.length, 0);
  // Empty host-observed edits may short-circuit before OpenCode evaluation; either way
  // evaluator "ready" must not produce Acceptance when host verification failed.
  if (f.evaluations.length) {
    assert.ok(packetFields(f.evaluations[0].specialist_return));
    assert.equal(f.evaluations[0].specialist_return.authority, false);
  } else {
    assert.match(m.reason || '', /no host-observed file changes|Host verification failed/i);
  }
  assert.equal(
    require('../src/specialist-gateway').autoAccept(f.bridge, m.id).accepted,
    false,
  );
});

test('Milestone B: bounded Cursor repair returns to OpenCode then exhausts cleanly', async (t) => {
  const f = await setup(t, { cursor: true, repairs: 1 });
  f.plan = f.plan.slice(0, 1);
  f.evaluate = (o) => ({
    ...o.coordination.result_contract,
    recommendation: 'repair',
    summary: 'Further correction requested.',
  });
  const pending = await f.ask();
  const approved = await f.bridge.zeroSetupWork.approve({
    request_id: pending.request_id,
    confirmed: true,
    channel: 'control_center',
    subscription_execution: {
      provider: 'cursor',
      acknowledge_unknown_cost: true,
      max_invocations: 2,
      max_runtime_ms: 120000,
    },
  }, 'operator');
  const m = await f.settle(approved.mission_id, 'needs_rework');
  assert.equal(m.acceptance.length, 0);
  assert.equal(m.specialists.repair_attempts, 1);
  assert.ok(f.evaluations.every((e) => packetFields(e.specialist_return)));
  assert.equal(f.evaluations.at(-1).specialist_return.remaining_repair_budget, 0);
  assert.equal(
    f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(m.id).n,
    0,
  );
});
