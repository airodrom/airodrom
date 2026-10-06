'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const MemoryStore = require('../src/memory-store');
const { ProjectMemoryV2Adapter } = require('../src/project-memory-v2-adapter');
const { MAX_RESUME_CHARS } = require('../src/project-memory-v2');

const fixturePath = path.resolve(__dirname, '../fixtures/memory-v2/adapter-lifecycle-fixture.cjs');

function clock() { let value = 1_790_300_000_000; return () => ++value; }
function repository(head = 'adapter-head-a') {
  return { repositoryId: 'adapter-repository', branch: 'main', head, dirty: true, modifiedFiles: ['src/adapter-target.js'], worktree: 'adapter-worktree', observedAt: 1_790_300_000_100 };
}
function setup({ dbPath = ':memory:' } = {}) {
  const store = new MemoryStore(dbPath);
  const adapter = new ProjectMemoryV2Adapter({ db: store.db, now: clock() });
  const missionId = 'adapter-mission';
  const initialized = adapter.initializeMission({
    missionId, taskId: 'adapter-task', objective: 'Maintain durable adapter state',
    workspace: '/private/tmp/project-memory-v2-adapter', scope: { capabilities: ['read'], allowedPaths: ['src/adapter-target.js'] }, repository: repository()
  });
  assert.equal(initialized.ok, true);
  return { store, adapter, missionId };
}
function close(t, store) { t.after(() => store.close()); }
function finding() {
  return {
    fact: 'The trusted runtime observed a bounded result.', evidence: 'runtime:adapter-test', evidenceClass: 'runtime_observation',
    evidenceSource: 'runtime', taskId: 'adapter-task', sessionId: 'adapter-session', verifiedAt: 1_790_300_000_001
  };
}
function receipt() {
  return {
    identity: 'node -e process.exit(0)', evidenceSource: 'test_runner', executionStatus: 'COMPLETED', outcome: 'passed',
    exitCode: 0, counts: { passed: 1, failed: 0, skipped: 0 }, observedAt: 1_790_300_000_002
  };
}
function blocker(state = 'expired') {
  return { category: 'operator_authorization', action: 'restart bridge', approvalState: state, approvalReference: `adapter-${state}`, executionStatus: 'NOT_EXECUTED', recordedAt: 1_790_300_000_003 };
}

test('adapter mission initialization is idempotent and immutable', t => {
  const { store, adapter, missionId } = setup();
  close(t, store);
  const again = adapter.initializeMission({
    missionId, taskId: 'adapter-task', objective: 'Maintain durable adapter state',
    workspace: '/private/tmp/project-memory-v2-adapter', scope: { capabilities: ['read'], allowedPaths: ['src/adapter-target.js'] }, repository: repository()
  });
  assert.equal(again.disposition, 'already_initialized');
  assert.throws(() => adapter.initializeMission({
    missionId, taskId: 'adapter-task', objective: 'Mutated objective',
    workspace: '/private/tmp/project-memory-v2-adapter', scope: { capabilities: ['read'], allowedPaths: ['src/adapter-target.js'] }
  }), /identity or scope changed/);
  assert.throws(() => adapter.initializeMission({
    missionId, taskId: 'adapter-task', objective: 'Maintain durable adapter state',
    workspace: '/private/tmp/project-memory-v2-adapter', scope: { capabilities: ['write'], allowedPaths: ['src/adapter-target.js'] }
  }), /identity or scope changed/);
});

test('adapter records distinct lifecycle evidence and restores it from a fresh session', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memory-v2-adapter-'));
  const dbPath = path.join(directory, 'memory.sqlite');
  const first = setup({ dbPath });
  assert.equal(first.adapter.recordVerifiedFinding({ missionId: first.missionId, finding: finding() }).ok, true);
  assert.equal(first.adapter.recordHypothesis({ missionId: first.missionId, hypothesis: 'A model interpretation remains unverified.', source: 'model', recordedAt: 1_790_300_000_004 }).ok, true);
  assert.equal(first.adapter.recordDecision({ missionId: first.missionId, decision: 'Keep state local.', rationale: 'No external memory dependency is authorized.', constraints: ['Local only'], decidedAt: 1_790_300_000_005 }).ok, true);
  assert.equal(first.adapter.recordTestResult({ missionId: first.missionId, test: receipt() }).ok, true);
  assert.equal(first.adapter.recordFailedApproach({ missionId: first.missionId, approach: 'Rebuild unavailable chat history', reason: 'Only durable state is safe.', recordedAt: 1_790_300_000_006 }).ok, true);
  assert.equal(first.adapter.recordBlocker({ missionId: first.missionId, blocker: blocker() }).ok, true);
  assert.equal(first.adapter.setNextAction({ missionId: first.missionId, phase: 'review', currentStep: 'Review trustworthy durable state.', nextAction: 'Run fresh validation before completion.' }).ok, true);
  first.store.close();

  const reopened = new MemoryStore(dbPath);
  close(t, reopened);
  const adapter = new ProjectMemoryV2Adapter({ db: reopened.db, now: clock() });
  const resumed = adapter.prepareResume({ missionId: first.missionId, currentRepository: repository() });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.packet.execution.phase, 'review');
  assert.equal(resumed.nextAction, 'Run fresh validation before completion.');
  assert.equal(resumed.packet.verifiedFacts[0].status, 'durable_verified');
  assert.equal(resumed.packet.hypotheses[0].status, 'unverified_interpretation');
  assert.equal(resumed.packet.decisions[0].rationale, 'No external memory dependency is authorized.');
  assert.equal(resumed.packet.tests[0].validity, 'current');
  assert.equal(resumed.packet.blockers[0].executionStatus, 'NOT_EXECUTED');
  assert.equal(resumed.packet.blockers[0].approvalState, 'expired');
  assert.equal(resumed.packet.failedApproaches[0].approach, 'Rebuild unavailable chat history');
  assert.equal(resumed.packet.restoration.authorizationsRestored, false);
  assert.equal(resumed.packet.restoration.approvalCredentialsStored, false);
});

test('duplicate findings and test receipts deduplicate, while source changes invalidate old test evidence', t => {
  const { store, adapter, missionId } = setup();
  close(t, store);
  assert.equal(adapter.recordVerifiedFinding({ missionId, finding: finding() }).disposition, 'checkpointed');
  assert.equal(adapter.recordVerifiedFinding({ missionId, finding: finding() }).disposition, 'deduplicated');
  assert.equal(adapter.recordTestResult({ missionId, test: receipt() }).disposition, 'checkpointed');
  assert.equal(adapter.recordTestResult({ missionId, test: receipt() }).disposition, 'deduplicated');
  assert.equal(adapter.recordSourceChange({ missionId, repository: repository('adapter-head-b'), changedFiles: ['src/adapter-target.js'], inspectedFiles: ['src/project-memory-v2-adapter.js'] }).ok, true);
  const resumed = adapter.prepareResume({ missionId, currentRepository: repository('adapter-head-b') });
  assert.equal(resumed.repositoryStatus, 'current');
  assert.equal(resumed.packet.tests[0].validity, 'historical_stale');
  const staleRecovery = adapter.prepareForRecovery({ missionId, currentRepository: repository('adapter-head-c') });
  assert.equal(staleRecovery.ok, false);
  assert.equal(staleRecovery.disposition, 'needs_review');
});

test('approvals remain historical blockers and cannot revive execution', t => {
  const { store, adapter, missionId } = setup();
  close(t, store);
  for (const state of ['expired', 'rejected', 'consumed']) assert.equal(adapter.recordBlocker({ missionId, blocker: blocker(state) }).ok, true);
  const resumed = adapter.prepareResume({ missionId, currentRepository: repository() });
  assert.deepEqual(resumed.blockers.map(item => item.approvalState), ['expired', 'rejected', 'consumed']);
  assert.ok(resumed.blockers.every(item => item.executionStatus === 'NOT_EXECUTED'));
  assert.equal(resumed.packet.restoration.authorizationsRestored, false);
  assert.throws(() => adapter.recordVerifiedFinding({ missionId, finding: { ...finding(), evidenceSource: 'model' } }), /trusted evidenceSource/);
});

test('optional missing memory degrades safely while corrupt automatic recovery fails closed', t => {
  const missing = new MemoryStore(':memory:');
  t.after(() => missing.close());
  const absent = new ProjectMemoryV2Adapter({ db: missing.db, now: clock() });
  assert.equal(absent.prepareResume({ missionId: 'missing-mission', currentRepository: repository() }).disposition, 'degraded');
  assert.equal(absent.prepareResume({ missionId: 'missing-mission', currentRepository: repository(), automaticRecovery: true }).disposition, 'needs_review');

  const { store, adapter, missionId } = setup();
  close(t, store);
  const id = adapter.memory.latest(missionId).id;
  store.db.prepare('UPDATE project_memory_v2_checkpoints SET state_json=? WHERE checkpoint_id=?').run('{"schemaVersion":2}', id);
  const blocked = adapter.prepareForRecovery({ missionId, currentRepository: repository() });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.disposition, 'needs_review');
  assert.equal(blocked.failureClass, 'fail_closed');
});

test('context-pressure and terminal operations preserve safety priority without inventing signals', t => {
  const { store, adapter, missionId } = setup();
  close(t, store);
  assert.equal(adapter.checkpointForContextPressure({ missionId }).disposition, 'no_action');
  assert.equal(adapter.checkpointForContextPressure({ missionId, signal: { source: 'untrusted', warning: true, continuation: true, observedAt: 1 } }).disposition, 'no_action');
  assert.equal(adapter.checkpointForContextPressure({ missionId, signal: { source: 'bridge_context_pressure', warning: true, continuation: false, observedAt: 1_790_300_000_007 } }).disposition, 'deduplicated');
  assert.equal(adapter.recordTerminalState({ missionId, status: 'cancelled' }).ok, true);
  assert.equal(adapter.recordTerminalState({ missionId, status: 'cancelled' }).disposition, 'deduplicated');
  const broken = new ProjectMemoryV2Adapter({ memory: { latest() { throw new Error('storage unavailable'); } } });
  const result = broken.recordTerminalState({ missionId: 'no-storage', status: 'cancelled' });
  assert.equal(result.ok, false);
  assert.equal(result.safetyActionMustContinue, true);
});

test('adapter redacts secrets, bounds resume packets, and rejects unexecuted test claims', t => {
  const { store, adapter, missionId } = setup();
  close(t, store);
  for (let index = 0; index < 24; index++) adapter.recordHypothesis({ missionId, hypothesis: `Low priority ${index}: ${'context '.repeat(58)}`, source: 'model', recordedAt: 1_790_300_001_000 + index });
  assert.equal(adapter.recordHypothesis({ missionId, hypothesis: 'authorization=Bearer-secret sk-abcdefghijklmnopqrstuvwxyz012345', source: 'model', recordedAt: 1_790_300_000_008 }).ok, true);
  assert.throws(() => adapter.recordTestResult({ missionId, test: { ...receipt(), executionStatus: 'NOT_EXECUTED', outcome: 'not_executed', exitCode: null, counts: null } }), /actually executed/);
  const unsafeBlocker = adapter.recordBlocker({ missionId, blocker: { ...blocker(), approvalReference: 'Bearer secret', recordedAt: 1_790_300_000_009 } });
  assert.equal(unsafeBlocker.ok, false);
  const resumed = adapter.prepareResume({ missionId, currentRepository: repository() });
  assert.ok(resumed.bytes <= MAX_RESUME_CHARS);
  assert.match(JSON.stringify(adapter.memory.latest(missionId).state), /<redacted>/);
  assert.doesNotMatch(resumed.serialized, /Bearer-secret|sk-abcdefghijklmnopqrstuvwxyz012345|Bearer secret/);
});

test('deterministic two-process adapter fixture restores only durable state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memory-v2-adapter-fixture-'));
  const dbPath = path.join(directory, 'memory.sqlite');
  const missionId = `adapter-fixture-${randomUUID()}`;
  const objective = `Adapter durable objective ${randomUUID()}`;
  const invoke = (...args) => spawnSync(process.execPath, [fixturePath, ...args], { encoding: 'utf8' });
  const recorded = invoke('record', dbPath, missionId, objective);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(JSON.parse(recorded.stdout).syntheticExitCode, 0);
  const current = invoke('restore', dbPath, missionId, 'current');
  assert.equal(current.status, 0, current.stderr);
  const packet = JSON.parse(current.stdout);
  assert.equal(packet.objective, objective);
  assert.equal(packet.phase, 'review');
  assert.equal(packet.verifiedFactStatus, 'durable_verified');
  assert.equal(packet.hypothesisStatus, 'unverified_interpretation');
  assert.equal(packet.testValidity, 'historical_stale');
  assert.equal(packet.blocker.executionStatus, 'NOT_EXECUTED');
  assert.equal(packet.blocker.approvalState, 'expired');
  assert.equal(packet.authorizationsRestored, false);
  assert.equal(packet.approvalCredentialsStored, false);
  assert.ok(packet.bytes <= MAX_RESUME_CHARS);
  const stale = invoke('restore', dbPath, missionId, 'stale');
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).repositoryStatus, 'stale');
});
