'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Recovery = require('../src/limits-blockers-recovery');
const Registry = require('../src/limits-blockers-registry');

function tmpDbBridge() {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-recovery-'));
  const db = new DatabaseSync(path.join(dir, 'memory.sqlite'));
  const missions = new Map();
  const bridge = {
    controlStore: {
      db,
      requireMission(id) {
        const m = missions.get(id);
        if (!m) throw Error('mission_missing');
        return m;
      },
      getMission(id) { return missions.get(id) || null; },
      event() {},
    },
    hostExecutionPolicy: {
      cursorDisabled() { return false; },
      status() { return { standing_cursor_development: [] }; },
      diagnoseStandingCursorDevelopment(probe) {
        if (!probe?.data_class) {
          return { matched: false, code: 'STANDING_CURSOR_GRANT_DATA_CLASS_MISMATCH', reason: 'missing class' };
        }
        if (probe.data_class !== 'public') {
          return { matched: false, code: 'STANDING_CURSOR_GRANT_DATA_CLASS_MISMATCH', reason: 'not public' };
        }
        if (probe.repository && String(probe.repository).includes('match-me') && probe.files?.length) {
          return { matched: true, code: null, grant_id: 'grant-1', authority: false };
        }
        return { matched: false, code: 'STANDING_CURSOR_GRANT_MISSING', reason: 'no grant', next_action: 'enroll' };
      },
    },
    developerAutonomy: {
      list() { return this._policies || []; },
      _policies: [],
      occupiedWorktrees() { return 0; },
      reclaimIdleReadyWorkspaces() {},
      inspect() { return { cognitive: { execution_ms: 60000 } }; },
      ensureCognitiveDiscovery() { return { cognitive: { execution_ms: 120000 } }; },
    },
    _missions: missions,
    _dir: dir,
  };
  return bridge;
}

test('coverage: all 27 canonical operational blockers have auto-diagnosis', () => {
  const cov = Recovery.coverage();
  assert.equal(cov.canonical_operational_owner.required, 27);
  assert.equal(cov.canonical_operational_owner.covered, 27);
  assert.ok(cov.security_fail_closed >= 21);
});

test('security-critical: none of the 21 invent executable authority bypass', () => {
  const registry = Registry.loadRegistry();
  const sec = registry.entries.filter(e => e.category === 'security_critical');
  assert.equal(sec.length, 21);
  for (const entry of sec) {
    const plan = Recovery.planFor(entry);
    assert.equal(plan.operation === 'security_investigate_fail_closed' || plan.security_fail_closed === true
      || plan.operation === 'reject_cross_project_fallback'
      || plan.operation === 'reconcile_blocked_evaluation'
      || plan.operation === 'reconcile_writer_death_lease', true, entry.id + ' plan=' + plan.operation);
    // Generic standing mismatch must never auto-match.
    if (entry.id === 'standing_cursor_grant_mismatch') {
      assert.equal(plan.operation, 'security_investigate_fail_closed');
      assert.equal(!!plan.executable, false);
    }
    if (entry.id === 'writer_still_alive') {
      assert.equal(plan.operation, 'security_investigate_fail_closed');
      assert.equal(!!plan.executable, false);
    }
  }
});

test('A: repository resolution never selects solely because one repo is enrolled', () => {
  const bridge = tmpDbBridge();
  const only = path.join(bridge._dir, 'only-enrolled');
  fs.mkdirSync(only);
  bridge.developerAutonomy._policies = [{
    state: 'active', policy_id: 'pol-1', alias: 'only', repository: only,
  }];
  const entry = Registry.loadRegistry().byId.get('enrolled_repository_ambiguous');
  const plan = Recovery.planFor(entry);
  assert.equal(plan.executable, true);
  // No sealed mission identity → must not perform.
  const result = Recovery.dispatch(bridge, {
    codes: ['ENROLLED_REPOSITORY_AMBIGUOUS'],
    request_id: 'req-ambig-1',
    live: false,
  });
  assert.equal(result.recovery.performed, false);
  assert.ok(
    result.recovery.reason === 'requested_repository_identity_unbound'
    || result.owner_gate,
    JSON.stringify(result.recovery)
  );
});

test('A: repository resolution matches sealed identity to enrolled DA', () => {
  const bridge = tmpDbBridge();
  const repo = path.join(bridge._dir, 'bound-repo');
  fs.mkdirSync(repo);
  bridge.developerAutonomy._policies = [
    { state: 'active', policy_id: 'pol-a', alias: 'a', repository: repo },
    { state: 'active', policy_id: 'pol-b', alias: 'b', repository: path.join(bridge._dir, 'other') },
  ];
  fs.mkdirSync(path.join(bridge._dir, 'other'));
  const missionId = '11111111-1111-4111-8111-111111111111';
  bridge._missions.set(missionId, {
    id: missionId,
    state: 'blocked',
    envelope: {
      data_class: 'public',
      repository_binding: { repository_root: repo },
      allowed_files: ['README.md'],
      developer_autonomy_policy_id: 'pol-a',
    },
  });
  const result = Recovery.dispatch(bridge, {
    codes: ['ENROLLED_REPOSITORY_AMBIGUOUS'],
    mission_id: missionId,
    live: false,
  });
  assert.equal(result.recovery.performed, true);
  assert.equal(result.recovery.selected.policy_id, 'pol-a');
  assert.equal(result.verification.completed_repair, true);
});

test('B: standing probe refuses invented public data_class', () => {
  const bridge = tmpDbBridge();
  const repo = path.join(bridge._dir, 'match-me');
  fs.mkdirSync(repo);
  const missionId = '22222222-2222-4222-8222-222222222222';
  bridge._missions.set(missionId, {
    id: missionId,
    state: 'blocked',
    envelope: {
      repository_binding: { repository_root: repo },
      allowed_files: ['a.txt'],
      // intentionally no data_class
    },
  });
  const probe = Recovery.missionStandingProbe(bridge, { mission_id: missionId });
  assert.equal(probe.data_class, null);
  const result = Recovery.dispatch(bridge, {
    codes: ['BLOCKED_SPEND_AUTHORIZATION'],
    mission_id: missionId,
    live: false,
  });
  assert.equal(result.recovery.performed, false);
  assert.equal(result.recovery.diagnosis.code, 'STANDING_CURSOR_GRANT_DATA_CLASS_MISMATCH');
  assert.equal(result.verification.completed_repair, false);
});

test('B: standing match uses sealed public data_class only', () => {
  const bridge = tmpDbBridge();
  const repo = path.join(bridge._dir, 'match-me');
  fs.mkdirSync(repo);
  const missionId = '33333333-3333-4333-8333-333333333333';
  bridge._missions.set(missionId, {
    id: missionId,
    state: 'blocked',
    envelope: {
      data_class: 'public',
      repository_binding: { repository_root: repo },
      allowed_files: ['a.txt'],
      cognitive: { envelope: { limits: { max_invocations: 2, execution_ms: 120000 } } },
    },
  });
  const result = Recovery.dispatch(bridge, {
    codes: ['BLOCKED_SPEND_AUTHORIZATION'],
    mission_id: missionId,
    live: false,
  });
  assert.equal(result.recovery.matched, true);
  assert.equal(result.recovery.performed, true);
  assert.equal(result.verification.completed_repair, true);
});

test('diagnostic-only handlers never claim completed recovery', () => {
  const bridge = tmpDbBridge();
  for (const code of [
    'DA_FILESYSTEM_CAPACITY_EXHAUSTED',
    'Developer Autonomy repair budget exhausted',
    'SOURCE_REPOSITORY_NOT_ENROLLED',
  ]) {
    const result = Recovery.dispatch(bridge, { codes: [code], request_id: 'diag-' + code, live: false });
    assert.equal(result.recovery.performed, false, code);
    assert.notEqual(result.verification.completed_repair, true, code);
    assert.ok(result.owner_gate || result.recovery.performed === false, code);
  }
});

test('retry budget consolidates after max attempts', () => {
  const bridge = tmpDbBridge();
  const codes = ['OWNER_ACTION_REQUIRED'];
  const req = 'retry-budget-1';
  Recovery.dispatch(bridge, { codes, request_id: req, live: false });
  Recovery.dispatch(bridge, { codes, request_id: req, live: false });
  const third = Recovery.dispatch(bridge, { codes, request_id: req, live: false });
  assert.equal(third.recovery.skipped, true);
  assert.equal(third.recovery.reason, 'recovery_attempt_budget_exhausted');
  assert.ok(third.owner_gate);
});

test('C: security mismatch and alive-writer stay fail-closed without performed recovery', () => {
  const bridge = tmpDbBridge();
  for (const code of ['STANDING_CURSOR_GRANT_MISMATCH', 'writer_still_alive']) {
    const result = Recovery.dispatch(bridge, { codes: [code], request_id: 'sec-' + code, live: false });
    assert.equal(result.recovery.performed, false, code);
    assert.equal(result.recovery.fail_closed, true, code);
    assert.equal(result.verification.mode, 'fail_closed', code);
  }
});

test('verifyRecovery never marks diagnosis as completed repair', () => {
  const entry = { id: 'da_filesystem_capacity_exhausted', category: 'operational_owner' };
  const plan = { operation: 'diagnose_filesystem_capacity', executable: false };
  const v = Recovery.verifyRecovery({}, entry, plan, { performed: false }, {});
  assert.equal(v.verified, false);
  assert.equal(v.completed_repair, false);
  assert.equal(v.mode, 'diagnosis_only');
});
