'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const MemoryStore = require('../../src/memory-store');
const { ProjectMemoryV2Adapter } = require('../../src/project-memory-v2-adapter');

function repository(head) {
  return { repositoryId: 'adapter-fixture', branch: 'main', head, dirty: true, modifiedFiles: ['src/example.js'], worktree: 'fixture', observedAt: 1_790_200_000_000 };
}
function requireOk(result) { if (!result.ok) throw new Error(result.reason || 'Adapter operation failed'); }

function record(databasePath, missionId, objective) {
  const store = new MemoryStore(databasePath);
  try {
    const adapter = new ProjectMemoryV2Adapter({ db: store.db, now: () => 1_790_200_000_000 });
    requireOk(adapter.initializeMission({ missionId, taskId: `${missionId}-task`, objective, workspace: '/private/tmp/memory-v2-adapter-fixture', scope: { capabilities: ['read'], allowedPaths: ['src/example.js'] }, repository: repository('head-a') }));
    requireOk(adapter.recordVerifiedFinding({ missionId, finding: { fact: 'Fixture runtime evidence was observed.', evidence: 'fixture:runtime', evidenceClass: 'runtime_observation', evidenceSource: 'runtime', taskId: `${missionId}-task`, sessionId: 'session-a', verifiedAt: 1_790_200_000_001 } }));
    requireOk(adapter.recordHypothesis({ missionId, hypothesis: 'Session B must treat this as an interpretation.', source: 'fixture', recordedAt: 1_790_200_000_002 }));
    requireOk(adapter.recordDecision({ missionId, decision: 'Use bounded durable state.', rationale: 'Session B has no conversation history.', constraints: ['Local-only'], decidedAt: 1_790_200_000_003 }));
    const synthetic = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
    if (synthetic.status !== 0 || synthetic.error || synthetic.signal) throw new Error('Synthetic adapter test failed');
    requireOk(adapter.recordTestResult({ missionId, test: { identity: 'node -e process.exit(0)', evidenceSource: 'test_runner', executionStatus: 'COMPLETED', outcome: 'passed', exitCode: synthetic.status, counts: { passed: 1, failed: 0, skipped: 0 }, observedAt: 1_790_200_000_004 } }));
    requireOk(adapter.recordFailedApproach({ missionId, approach: 'Recover chat transcript', reason: 'Transcript is unavailable.', recordedAt: 1_790_200_000_005 }));
    requireOk(adapter.recordBlocker({ missionId, blocker: { category: 'operator_authorization', action: 'restart bridge', approvalState: 'expired', approvalReference: 'fixture-expired', executionStatus: 'NOT_EXECUTED', recordedAt: 1_790_200_000_006 } }));
    requireOk(adapter.setNextAction({ missionId, nextAction: 'Review Session A evidence before continuation.', phase: 'review', currentStep: 'Prepare durable handoff.' }));
    requireOk(adapter.recordSourceChange({ missionId, repository: repository('head-b'), changedFiles: ['src/example.js'], inspectedFiles: ['src/project-memory-v2-adapter.js'] }));
    const recovery = adapter.prepareForRecovery({ missionId, currentRepository: repository('head-b') });
    requireOk(recovery);
    process.stdout.write(JSON.stringify({ kind: 'MEMORY_V2_ADAPTER_FIXTURE_RECORDED', missionId, syntheticExitCode: synthetic.status, recoveryDisposition: recovery.disposition }));
  } finally { store.close(); }
}

function restore(databasePath, missionId, current) {
  const store = new MemoryStore(databasePath);
  try {
    const adapter = new ProjectMemoryV2Adapter({ db: store.db });
    const result = adapter.prepareResume({ missionId, currentRepository: repository(current === 'stale' ? 'head-c' : 'head-b') });
    if (!result.ok) throw new Error(result.reason || 'Adapter resume failed');
    const packet = result.packet;
    process.stdout.write(JSON.stringify({
      kind: 'MEMORY_V2_ADAPTER_FIXTURE_RESTORED', objective: packet.mission.objective, phase: packet.execution.phase,
      nextAction: packet.execution.nextAction, verifiedFactStatus: packet.verifiedFacts[0]?.status || null,
      hypothesisStatus: packet.hypotheses[0]?.status || null, testValidity: packet.tests[0]?.validity || null,
      blocker: packet.blockers[0] || null, failedApproach: packet.failedApproaches[0]?.approach || null,
      repositoryStatus: result.repositoryStatus, bytes: result.bytes,
      authorizationsRestored: packet.restoration.authorizationsRestored, approvalCredentialsStored: packet.restoration.approvalCredentialsStored
    }));
  } finally { store.close(); }
}

const [mode, databasePath, missionId, fourth] = process.argv.slice(2);
if (!['record', 'restore'].includes(mode) || !databasePath || !missionId || !fourth) throw new Error('Usage: adapter-lifecycle-fixture.cjs record <database> <mission> <objective> | restore <database> <mission> <current|stale>');
if (mode === 'record') record(path.resolve(databasePath), missionId, fourth);
else restore(path.resolve(databasePath), missionId, fourth);
