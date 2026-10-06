'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const MemoryStore = require('../../src/memory-store');
const { ProjectMemoryV2, repositoryFingerprint } = require('../../src/project-memory-v2');

function repository(head) {
  return {
    repositoryId: 'memory-v2-fixture', branch: 'main', head, dirty: true,
    modifiedFiles: ['src/example.js'], worktree: 'fixture-worktree', observedAt: 1_790_100_000_004
  };
}

function state(missionId, syntheticTest) {
  const source = repository('fixture-head-a');
  const sourceFingerprint = repositoryFingerprint(source);
  return {
    execution: {
      phase: 'implementation',
      currentStep: 'Review the durable evidence from Session A',
      nextAction: 'Resume from the recorded fixture action',
      completionState: 'in_progress'
    },
    verifiedFacts: [{
      fact: 'The synthetic fixture validation completed.',
      evidence: `fixture-synthetic-test; exit:${syntheticTest.status}`,
      evidenceClass: 'test_receipt', verifiedAt: 1_790_100_000_001,
      taskId: `${missionId}-task`, sessionId: 'fixture-session-a', sourceFingerprint
    }],
    hypotheses: [{ hypothesis: 'Session B must review this interpretation.', source: 'fixture model interpretation', recordedAt: 1_790_100_000_002 }],
    decisions: [{
      decision: 'Use the durable SQLite record for Session B.', rationale: 'The prior conversational history is unavailable to Session B.',
      constraints: ['Local-only fixture'], decidedAt: 1_790_100_000_003
    }],
    repository: source,
    files: {
      changed: ['src/example.js'], inspected: ['src/memory-store.js'],
      protectedPreExisting: ['src/bridge-controller.js'], components: ['ProjectMemoryV2']
    },
    tests: [{
      identity: 'node -e process.exit(0)', executionStatus: 'COMPLETED', outcome: 'passed', exitCode: syntheticTest.status,
      counts: { passed: 1, failed: 0, skipped: 0 }, observedAt: 1_790_100_000_005, sourceFingerprint
    }],
    blockers: [{
      category: 'operator_authorization', action: 'restart bridge', approvalState: 'expired', approvalReference: 'fixture-expired-approval',
      executionStatus: 'NOT_EXECUTED', recordedAt: 1_790_100_000_006
    }],
    failedApproaches: [{ approach: 'Reconstruct an unavailable conversation', reason: 'Only bounded durable evidence may be restored.', recordedAt: 1_790_100_000_007 }],
    constraints: ['The current safety policy remains authoritative.']
  };
}

function record(databasePath, missionId, objective) {
  const syntheticTest = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  if (syntheticTest.error || syntheticTest.signal || syntheticTest.status !== 0) throw new Error('Synthetic fixture test did not complete successfully');
  const store = new MemoryStore(databasePath);
  try {
    const memory = new ProjectMemoryV2({ db: store.db, now: () => 1_790_100_000_000 });
    memory.registerMission({
      missionId, taskId: `${missionId}-task`, objective,
      workspace: '/private/tmp/memory-v2-resume-fixture', scope: { capabilities: ['read'], allowedPaths: ['src/example.js'] }
    });
    const saved = memory.checkpoint(missionId, state(missionId, syntheticTest));
    process.stdout.write(JSON.stringify({ kind: 'MEMORY_V2_FIXTURE_RECORDED', missionId, checkpointId: saved.id, syntheticTest: { status: syntheticTest.status, signal: syntheticTest.signal } }));
  } finally { store.close(); }
}

function restore(databasePath, missionId, current) {
  const store = new MemoryStore(databasePath);
  try {
    const memory = new ProjectMemoryV2({ db: store.db });
    const restored = memory.restore(missionId, { currentRepository: repository(current === 'stale' ? 'fixture-head-b' : 'fixture-head-a') });
    const packet = restored.packet;
    process.stdout.write(JSON.stringify({
      kind: 'MEMORY_V2_FIXTURE_RESTORED', missionId: packet.mission.missionId, objective: packet.mission.objective,
      phase: packet.execution.phase, currentStep: packet.execution.currentStep, nextAction: packet.execution.nextAction,
      verifiedFactStatus: packet.verifiedFacts[0]?.status || null, hypothesisStatus: packet.hypotheses[0]?.status || null,
      decisionRationale: packet.decisions[0]?.rationale || null, testValidity: packet.tests[0]?.validity || null,
      repositoryStatus: packet.repository.status, changedFiles: packet.files.changed, protectedFiles: packet.files.protectedPreExisting,
      blockerExecutionStatus: packet.blockers[0]?.executionStatus || null, blockerApprovalState: packet.blockers[0]?.approvalState || null,
      failedApproach: packet.failedApproaches[0]?.approach || null, constraints: packet.constraints,
      authorizationsRestored: packet.restoration.authorizationsRestored, approvalCredentialsStored: packet.restoration.approvalCredentialsStored,
      bytes: restored.bytes
    }));
  } finally { store.close(); }
}

const [mode, databasePath, missionId, fourth] = process.argv.slice(2);
if (!['record', 'restore'].includes(mode) || !databasePath || !missionId || (mode === 'record' && !fourth)) {
  throw new Error('Usage: resume-fixture.cjs record <databasePath> <missionId> <objective> | restore <databasePath> <missionId> <current|stale>');
}
if (mode === 'record') record(path.resolve(databasePath), missionId, fourth);
else restore(path.resolve(databasePath), missionId, fourth);
