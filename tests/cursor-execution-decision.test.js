'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Decision = require('../src/cursor-execution-decision');
const Registry = require('../src/limits-blockers-registry');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');

function cursorReady() {
  return {
    installed: true, ready: true, available: true, availability: 'available',
    governed_worker: true, reason: null, auth_state: 'fixture',
    tiers: { installed: true, authenticated: true, qualified: true, available: true, executing: false },
  };
}

async function specialistCursorFixture(t) {
  const f = await fixture(t, { opencode: runtime(t).options, settleTimeoutMs: 45000 });
  const b = f.bridge;
  b.missionAuthority.initializeOperatorKey();
  qualifyCanonical(b);
  b.expandedAutonomy.setMode({
    mode: 'routine_auto', confirmed: true, request_id: randomUUID(), sync_risk_acceptance: false,
  }, 'operator');
  b.cursorWorker = new (require('../src/cursor-worker').CursorWorker)(b, {
    fixtureExecutable: path.join(__dirname, 'fixtures/cursor-agent-fixture.cjs'),
  });
  b.hostExecutionPolicy = {
    cursorDisabled: () => false,
    assertCursorAllowed: () => {},
  };
  const p = b.projects.listProjects({ status: 'active' })[0];
  const g = b.projects.summary(p.projectId).goals[0];
  b.developerAutonomy.enroll({
    alias: 'cursor-decision-fixture', repository: f.repo, project_id: p.projectId, goal_id: g.goalId,
    workflows: ['routine_edit', 'test'], workers: ['opencode', 'cursor'], duration_days: 1, confirmed: true,
    diff_check: 'diff-check', default_tests: ['fixture-test'], budgets: { max_repairs: 0 },
    cognitive: {
      version: 3, files: ['fixture.txt'], delegated_callers: [], planning_attempts: 2,
      planning_ms: 120000, execution_ms: 120000, repair_attempts: 0, max_assignments: 2, acceptance: 'automatic',
    },
  }, 'operator');
  f.plan = [
    {
      id: 'read-1', worker: 'cursor', role: 'analysis', operation: 'read', paths: ['fixture.txt'],
      description: 'Read fixture.txt', depends_on: [], verification: [],
    },
    {
      id: 'change-1', worker: 'cursor', role: 'implementation', operation: 'edit', paths: ['fixture.txt'],
      description: 'Change alpha to beta', depends_on: ['read-1'], verification: [],
    },
  ];
  f.evaluations = [];
  const adapter = b.opencodeAdapter;
  const worker = adapter.execute.bind(adapter);
  adapter.execute = async (o) => {
    if (o.planning) {
      return {
        result: { summary: JSON.stringify({ ...o.planning, tasks: f.plan }) },
        changes: [], provenance: { termination_verified: true },
      };
    }
    if (o.coordination) {
      f.evaluations.push(o.coordination);
      return {
        result: {
          summary: JSON.stringify({
            ...o.coordination.result_contract,
            recommendation: o.coordination.host_checks.some((c) => c.status === 'failed') ? 'blocked' : 'ready',
            summary: 'ok',
          }),
        },
        changes: [],
        provenance: { runtime_id: 'opencode', sandbox: 'fixture', termination_verified: true, authority: false },
      };
    }
    return worker(o.writable.length ? o : {
      ...o, objective: 'Inspect fixture.txt without changes', objectiveProof: null,
    });
  };
  return f;
}

test('registry normalizes cognitive_worker_unqualified:cursor', () => {
  const entry = Registry.resolve('cognitive_worker_unqualified:cursor');
  assert.equal(entry.id, 'cognitive_worker_unqualified');
  assert.equal(entry.registered, true);
  assert.equal(entry.recovery_dispatcher.operation, 'refresh_cursor_execution_decision');
});

test('registry maps cursor_runtime_not_ready codes', () => {
  assert.equal(Registry.resolve('cursor_runtime_not_ready').id, 'cursor_runtime_not_ready');
  assert.equal(Registry.resolve('cursor_version_unavailable').id, 'cursor_runtime_not_ready');
});

test('qualified Cursor with Mission grant allows dispatch', async (t) => {
  const f = await specialistCursorFixture(t);
  const view = await (async () => {
    const request_id = randomUUID();
    const instruction = 'In Fixture project, using Cursor, read fixture.txt then change alpha to beta.';
    let v = await f.bridge.zeroSetupWork.ask({
      request_id, instruction,
      // Force Cursor path through standing-style approve when WAIT.
    }, 'operator');
    for (let i = 0; i < 200 && v.state === 'PLANNING'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      v = await f.bridge.zeroSetupWork.ask({ request_id, instruction }, 'operator');
    }
    if (v.state === 'WAIT') {
      v = await f.bridge.zeroSetupWork.approve({
        request_id: v.request_id, confirmed: true, channel: 'control_center',
        subscription_execution: {
          provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 2, max_runtime_ms: 120000,
        },
      }, 'operator');
    }
    return v;
  })();
  assert.ok(view.mission_id, JSON.stringify(view));
  const m = f.bridge.controlStore.requireMission(view.mission_id);
  const readiness = cursorReady();
  f.bridge.cursorWorker.lastReadiness = readiness;
  const decision = Decision.decide(f.bridge, m, { readiness });
  assert.equal(decision.allow, true, JSON.stringify(decision));
  assert.equal(decision.dimensions.standing_or_mission_grant_covers, true);
  assert.equal(decision.dimensions.external_disclosure_covered, true);
});

test('Cursor available but grant missing blocks', async (t) => {
  const f = await specialistCursorFixture(t);
  const m = {
    id: randomUUID(),
    envelope: {
      preferred_agent: 'cursor',
      approval_id: null,
      contract: {
        permissions: {
          external_disclosure: { authorized: true, providers: ['cursor'] },
          network: { mode: 'allowlist', allow: ['api2.cursor.sh'] },
          personal_memory: { mode: 'none' },
          vault_access: { mode: 'none' },
        },
        execution: { mode: 'sandboxed_headless', sandbox: 'sandbox-exec' },
      },
    },
  };
  // Bypass assertIntact by stubbing
  const mc = require('../src/mission-contract');
  const prev = mc.assertIntact;
  mc.assertIntact = () => {};
  t.after(() => { mc.assertIntact = prev; });
  f.bridge.cursorWorker.qualifiedFor = () => false;
  const decision = Decision.decide(f.bridge, m, { readiness: cursorReady() });
  assert.equal(decision.allow, false);
  assert.ok(/BLOCKED_SPEND|worker_execution_unqualified|unqualified/i.test(decision.code), decision.code);
});

test('runtime not ready is transient and distinct from cognitive unqualified', () => {
  const bridge = {
    cursorWorker: {
      active: new Map(),
      qualifiedFor: () => true,
      lastReadiness: null,
    },
    hostExecutionPolicy: { cursorDisabled: () => false },
    controlStore: { now: () => Date.now() },
    missionApprovals: { assertDispatch: () => {} },
  };
  const m = {
    envelope: {
      preferred_agent: 'cursor',
      approval_id: randomUUID(),
      contract: {
        permissions: {
          external_disclosure: { authorized: true, providers: ['cursor'] },
          network: { mode: 'allowlist', allow: ['api2.cursor.sh'] },
          personal_memory: { mode: 'none' },
          vault_access: { mode: 'none' },
        },
        execution: { mode: 'sandboxed_headless', sandbox: 'sandbox-exec' },
      },
    },
  };
  const mc = require('../src/mission-contract');
  const prev = mc.assertIntact;
  mc.assertIntact = () => {};
  const decision = Decision.decide(bridge, m, {
    readiness: {
      installed: true, ready: false, available: false, reason: 'cursor_version_unavailable',
      governed_worker: true, tiers: { qualified: true },
    },
  });
  mc.assertIntact = prev;
  assert.equal(decision.allow, false);
  assert.equal(decision.transient, true);
  assert.notEqual(decision.code, 'cognitive_worker_unqualified:cursor');
  assert.ok(Decision.isTransient(decision.code));
});

test('unknown worker names never auto-qualify via registry', () => {
  const entry = Registry.resolve('cognitive_worker_unqualified:codex');
  assert.equal(entry.id, 'cognitive_worker_unqualified');
  assert.equal(entry.security_critical, false);
});

test('security-critical standing mismatch remains fail-closed', () => {
  const entry = Registry.resolve('STANDING_CURSOR_GRANT_MISMATCH');
  assert.equal(entry.category, 'security_critical');
  assert.equal(entry.security_critical, true);
});
