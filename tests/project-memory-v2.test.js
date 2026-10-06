'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const MemoryStore = require('../src/memory-store');
const { ProjectMemoryV2, MAX_CHECKPOINTS, MAX_RESUME_CHARS, repositoryFingerprint } = require('../src/project-memory-v2');

const modulePath = path.resolve(__dirname, '../src/project-memory-v2.js');
const storePath = path.resolve(__dirname, '../src/memory-store.js');
const resumeFixturePath = path.resolve(__dirname, '../fixtures/memory-v2/resume-fixture.cjs');

function timestamp() {
  let value = 1_790_000_000_000;
  return () => ++value;
}

function fixture({ dbPath = ':memory:' } = {}) {
  const now = timestamp();
  const store = new MemoryStore(dbPath);
  const memory = new ProjectMemoryV2({ db: store.db, now });
  const mission = memory.registerMission({
    missionId: 'memory-v2-mission',
    taskId: 'memory-v2-task',
    objective: 'Keep durable project state across a context reset',
    workspace: '/private/tmp/project-memory-v2-workspace',
    scope: { allowedPaths: ['src/project-memory-v2.js'], capabilities: ['read'] }
  });
  return { now, store, memory, mission };
}

function checkpoint(overrides = {}) {
  const state = {
    execution: {
      phase: 'implementation',
      currentStep: 'Add the isolated Memory V2 component',
      nextAction: 'Run the focused Memory V2 regression',
      completionState: 'in_progress'
    },
    verifiedFacts: [{
      fact: 'The focused regression was executed.',
      evidence: 'node --experimental-sqlite --test tests/project-memory-v2.test.js; exit 0',
      evidenceClass: 'test_receipt',
      verifiedAt: 1_790_000_000_001,
      taskId: 'memory-v2-task',
      sessionId: 'memory-v2-session'
    }],
    hypotheses: [{
      hypothesis: 'The isolated component can later be injected into the protected bridge lifecycle.',
      source: 'engineering assessment',
      recordedAt: 1_790_000_000_002
    }],
    decisions: [{
      decision: 'Reuse the existing local SQLite database.',
      rationale: 'It already persists bounded task memory without a cloud dependency.',
      constraints: ['No external memory service'],
      decidedAt: 1_790_000_000_003
    }],
    repository: {
      repositoryId: 'pi-chatgpt-bridge',
      branch: 'main',
      head: 'a34699fa868d8f61c9d2623ed21df388dce3439f',
      dirty: true,
      modifiedFiles: ['src/project-memory-v2.js'],
      worktree: 'main',
      observedAt: 1_790_000_000_004
    },
    files: {
      changed: ['src/project-memory-v2.js'],
      inspected: ['src/memory-store.js'],
      protectedPreExisting: ['src/bridge-controller.js'],
      components: ['MemoryStore', 'ProjectMemoryV2']
    },
    tests: [{
      identity: 'node --experimental-sqlite --test tests/project-memory-v2.test.js',
      executionStatus: 'COMPLETED',
      outcome: 'passed',
      exitCode: 0,
      counts: { passed: 1, failed: 0, skipped: 0 },
      observedAt: 1_790_000_000_005
    }],
    blockers: [{
      category: 'operator_authorization',
      action: 'restart bridge',
      approvalState: 'pending',
      approvalReference: 'approval-memory-v2',
      executionStatus: 'NOT_EXECUTED',
      recordedAt: 1_790_000_000_006
    }],
    failedApproaches: [{
      approach: 'Persist raw conversation transcripts',
      reason: 'They are not bounded or evidence classified.',
      recordedAt: 1_790_000_000_007
    }],
    constraints: ['Current safety policy remains authoritative.', 'No credentials in durable memory.']
  };
  const fingerprint = repositoryFingerprint(state.repository);
  state.verifiedFacts[0].sourceFingerprint = fingerprint;
  state.tests[0].sourceFingerprint = fingerprint;
  return merge(state, overrides);
}

function merge(base, overrides) {
  const copy = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) copy[key] = value;
  return copy;
}

function close(t, store) { t.after(() => store.close()); }

test('a fresh Node process restores the mission objective, current step, and next action', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memory-v2-'));
  const dbPath = path.join(directory, 'memory.sqlite');
  const { store, memory } = fixture({ dbPath });
  close(t, store);
  memory.checkpoint('memory-v2-mission', checkpoint());
  store.close();

  const script = [
    `const MemoryStore=require(${JSON.stringify(storePath)});`,
    `const {ProjectMemoryV2}=require(${JSON.stringify(modulePath)});`,
    'const store=new MemoryStore(process.argv[1]);',
    'const memory=new ProjectMemoryV2({db:store.db});',
    "const restored=memory.restore('memory-v2-mission',{currentRepository:{repositoryId:'pi-chatgpt-bridge',branch:'main',head:'a34699fa868d8f61c9d2623ed21df388dce3439f',dirty:true,modifiedFiles:['src/project-memory-v2.js'],worktree:'main',observedAt:1790000001000}});",
    'process.stdout.write(JSON.stringify({objective:restored.packet.mission.objective,currentStep:restored.packet.execution.currentStep,nextAction:restored.packet.execution.nextAction,repositoryStatus:restored.repositoryStatus}));',
    'store.close();'
  ].join('');
  const result = spawnSync(process.execPath, ['--experimental-sqlite', '-e', script, dbPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    objective: 'Keep durable project state across a context reset',
    currentStep: 'Add the isolated Memory V2 component',
    nextAction: 'Run the focused Memory V2 regression',
    repositoryStatus: 'current'
  });
});

test('two isolated processes reconstruct the deterministic resume fixture without conversational history', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memory-v2-resume-'));
  const databasePath = path.join(directory, 'memory.sqlite');
  const missionId = `fixture-${randomUUID()}`;
  const objective = `Recover immutable objective ${randomUUID()}`;
  const invoke = (...args) => spawnSync(process.execPath, [resumeFixturePath, ...args], { encoding: 'utf8' });

  const recorded = invoke('record', databasePath, missionId, objective);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.deepEqual(JSON.parse(recorded.stdout).syntheticTest, { status: 0, signal: null });

  // Session B receives only the durable database and mission identity. The original objective
  // is intentionally absent from this process invocation.
  const restored = invoke('restore', databasePath, missionId, 'current');
  assert.equal(restored.status, 0, restored.stderr);
  const packet = JSON.parse(restored.stdout);
  assert.equal(packet.objective, objective);
  assert.equal(packet.phase, 'implementation');
  assert.equal(packet.currentStep, 'Review the durable evidence from Session A');
  assert.equal(packet.nextAction, 'Resume from the recorded fixture action');
  assert.equal(packet.verifiedFactStatus, 'durable_verified');
  assert.equal(packet.hypothesisStatus, 'unverified_interpretation');
  assert.match(packet.decisionRationale, /prior conversational history is unavailable/);
  assert.equal(packet.testValidity, 'current');
  assert.equal(packet.repositoryStatus, 'current');
  assert.deepEqual(packet.changedFiles, ['src/example.js']);
  assert.deepEqual(packet.protectedFiles, ['src/bridge-controller.js']);
  assert.equal(packet.blockerExecutionStatus, 'NOT_EXECUTED');
  assert.equal(packet.blockerApprovalState, 'expired');
  assert.match(packet.failedApproach, /unavailable conversation/);
  assert.deepEqual(packet.constraints, ['The current safety policy remains authoritative.']);
  assert.equal(packet.authorizationsRestored, false);
  assert.equal(packet.approvalCredentialsStored, false);
  assert.ok(packet.bytes <= MAX_RESUME_CHARS);

  const stale = invoke('restore', databasePath, missionId, 'stale');
  assert.equal(stale.status, 0, stale.stderr);
  const stalePacket = JSON.parse(stale.stdout);
  assert.equal(stalePacket.repositoryStatus, 'stale');
  assert.equal(stalePacket.testValidity, 'historical_stale');
  assert.equal(stalePacket.verifiedFactStatus, 'historical_stale');
});

test('restore keeps facts, hypotheses, blocked actions, and failed approaches distinct', t => {
  const { store, memory } = fixture();
  close(t, store);
  const state = checkpoint();
  state.blockers.push(
    { ...state.blockers[0], action: 'issue a new grant', approvalState: 'expired', approvalReference: 'approval-memory-v2-expired' },
    { ...state.blockers[0], action: 'retry a denied action', approvalState: 'rejected', approvalReference: 'approval-memory-v2-rejected' },
    { ...state.blockers[0], action: 'reuse a consumed approval', approvalState: 'consumed', approvalReference: 'approval-memory-v2-consumed' }
  );
  memory.checkpoint('memory-v2-mission', state);
  const restored = memory.restore('memory-v2-mission', { currentRepository: checkpoint().repository });
  assert.equal(restored.packet.verifiedFacts[0].status, 'durable_verified');
  assert.equal(restored.packet.hypotheses[0].status, 'unverified_interpretation');
  assert.equal(restored.packet.blockers[0].executionStatus, 'NOT_EXECUTED');
  assert.equal(restored.packet.blockers[0].approvalState, 'pending');
  assert.deepEqual(restored.packet.blockers.slice(1).map(item => item.approvalState), ['expired', 'rejected', 'consumed']);
  assert.equal(restored.packet.restoration.authorizationsRestored, false);
  assert.equal(restored.packet.restoration.approvalCredentialsStored, false);
  assert.equal(restored.packet.failedApproaches[0].approach, 'Persist raw conversation transcripts');
  assert.throws(() => memory.checkpoint('memory-v2-mission', checkpoint({
    verifiedFacts: [{ ...checkpoint().verifiedFacts[0], taskId: 'another-task' }]
  })), /bound to the mission task/);
});

test('actual test receipts are validated and become historical when repository evidence changes', t => {
  const { store, memory } = fixture();
  close(t, store);
  memory.checkpoint('memory-v2-mission', checkpoint());
  const changed = memory.restore('memory-v2-mission', {
    currentRepository: { ...checkpoint().repository, head: 'changed-source-snapshot' }
  });
  assert.equal(changed.repositoryStatus, 'stale');
  assert.equal(changed.packet.tests[0].validity, 'historical_stale');
  assert.equal(changed.packet.tests[0].sourceFingerprint, changed.packet.repository.saved ? memory.latest('memory-v2-mission').state.repositoryFingerprint : null);
  assert.equal(changed.packet.verifiedFacts[0].status, 'historical_stale');
  assert.throws(() => memory.checkpoint('memory-v2-mission', checkpoint({
    tests: [{ ...checkpoint().tests[0], executionStatus: 'COMPLETED', outcome: 'passed', exitCode: 1 }]
  })), /conflicts with actual exit status/);
  assert.throws(() => memory.checkpoint('memory-v2-mission', checkpoint({
    tests: [{ ...checkpoint().tests[0], executionStatus: 'NOT_EXECUTED', outcome: 'passed', exitCode: 0, counts: { passed: 1, failed: 0, skipped: 0 } }]
  })), /Not-executed tests/);
});

test('mission identity is immutable, duplicate checkpoints deduplicate, and history remains bounded', t => {
  const { store, memory } = fixture();
  close(t, store);
  const first = memory.checkpoint('memory-v2-mission', checkpoint());
  const duplicate = memory.checkpoint('memory-v2-mission', checkpoint());
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.id, first.id);
  assert.throws(() => memory.registerMission({
    missionId: 'memory-v2-mission', taskId: 'memory-v2-task', objective: 'Changed objective',
    workspace: '/private/tmp/project-memory-v2-workspace', scope: { allowedPaths: ['src/project-memory-v2.js'], capabilities: ['read'] }
  }), /identity or scope changed/);
  assert.throws(() => memory.registerMission({
    missionId: 'memory-v2-mission', taskId: 'memory-v2-task', objective: 'Keep durable project state across a context reset',
    workspace: '/private/tmp/project-memory-v2-workspace', scope: { allowedPaths: ['src/project-memory-v2.js'], capabilities: ['write'] }
  }), /identity or scope changed/);
  for (let index = 0; index < MAX_CHECKPOINTS + 8; index++) {
    memory.checkpoint('memory-v2-mission', checkpoint({ execution: { ...checkpoint().execution, nextAction: `Continue at bounded checkpoint ${index}` } }));
  }
  assert.equal(memory.count('memory-v2-mission'), MAX_CHECKPOINTS);
  assert.equal(memory.latest('memory-v2-mission').state.execution.nextAction, `Continue at bounded checkpoint ${MAX_CHECKPOINTS + 7}`);
});

test('secret values are redacted and resume packets are deterministically bounded', t => {
  const { store, memory } = fixture();
  close(t, store);
  const hypotheses = Array.from({ length: 24 }, (_unused, index) => ({
    hypothesis: `Hypothesis ${index}: ${'context '.repeat(58)}`,
    source: 'model interpretation',
    recordedAt: 1_790_000_100_000 + index
  }));
  memory.checkpoint('memory-v2-mission', checkpoint({
    hypotheses,
    verifiedFacts: [{ ...checkpoint().verifiedFacts[0], evidence: 'token=not-a-real-secret sk-abcdefghijklmnopqrstuvwxyz012345' }]
  }));
  const restored = memory.restore('memory-v2-mission', { currentRepository: checkpoint().repository });
  assert.ok(restored.bytes <= MAX_RESUME_CHARS);
  assert.equal(restored.truncated, true);
  assert.equal(restored.packet.tests[0].validity, 'current');
  assert.equal(restored.packet.verifiedFacts[0].status, 'durable_verified');
  assert.match(restored.serialized, /<redacted>/);
  assert.doesNotMatch(restored.serialized, /not-a-real-secret|sk-abcdefghijklmnopqrstuvwxyz012345/);
  const separatelyScoped = new ProjectMemoryV2({ db: store.db, now: timestamp() });
  const registered = separatelyScoped.registerMission({
    missionId: 'memory-v2-redacted-scope', taskId: 'memory-v2-task', objective: 'Redact secret scope values',
    workspace: '/private/tmp/project-memory-v2-workspace', scope: { apiKey: 'not-a-real-secret', capabilities: ['read'] }
  });
  assert.deepEqual(registered.scope, { capabilities: ['read'] });
});

test('missing or corrupt durable checkpoints fail closed and legacy V1 stays readable as unverified context', t => {
  const { store, memory } = fixture();
  close(t, store);
  assert.throws(() => memory.restore('memory-v2-mission'), /no durable checkpoint/);
  const saved = memory.checkpoint('memory-v2-mission', checkpoint());
  store.db.prepare('UPDATE project_memory_v2_checkpoints SET state_json=? WHERE checkpoint_id=?').run('{"schemaVersion":2}', saved.id);
  assert.throws(() => memory.restore('memory-v2-mission'), /integrity check failed/);

  const legacy = {
    objective: 'Preserve V1 records',
    verifiedFacts: [{ fact: 'A V1 fact', evidence: 'old source' }],
    hypotheses: ['A V1 hypothesis'], decisions: ['Keep the record'], completedGates: ['old-gate'],
    failedApproaches: ['Repeat no-longer-useful work'], gitReferences: ['HEAD abc'], nextStep: 'Re-verify before continuing'
  };
  const entry = store.saveCheckpoint('legacy-memory-v1', legacy, { sessionId: 'legacy-session' });
  const draft = ProjectMemoryV2.legacyDraft(entry, { recordedAt: 1_790_000_000_009 });
  assert.deepEqual(draft.verifiedFacts, []);
  assert.match(draft.hypotheses[1].hypothesis, /requiring re-verification/);
  assert.equal(store.latestCheckpoint('legacy-memory-v1').content, entry.content);
});

test('explicit V2 forgetting removes payloads, survives reopening and blocks mission replay', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-forget-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'memory.sqlite');
  const { store, memory, mission } = fixture({ dbPath });
  memory.checkpoint(mission.missionId, checkpoint());
  const receipt = memory.forgetMission(mission.missionId);
  assert.equal(receipt.authority, false);
  assert.deepEqual(memory.forgetMission(mission.missionId), receipt);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_memory_v2_checkpoints').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_memory_v2_missions').get().n, 0);
  store.close();
  const reopenedStore = new MemoryStore(dbPath);
  const reopened = new ProjectMemoryV2({ db: reopenedStore.db });
  assert.throws(() => reopened.restore(mission.missionId), /forgotten/);
  assert.throws(() => reopened.checkpoint(mission.missionId, checkpoint()), /forgotten/);
  assert.throws(() => reopened.registerMission({ missionId: mission.missionId, taskId: mission.taskId, objective: mission.objective, workspace: mission.workspace, scope: mission.scope }), /forgotten/);
  assert.throws(() => reopened.forgetMission('unknown'), /not found/);
  assert.equal(reopenedStore.db.prepare('SELECT count(*) AS n FROM project_memory_v2_forgotten').get().n, 1);
  const { ProjectMemoryV2Adapter } = require('../src/project-memory-v2-adapter');
  const adapter = new ProjectMemoryV2Adapter({ memory: reopened });
  assert.equal(adapter.prepareForRecovery({ missionId: mission.missionId }).disposition, 'needs_review');
  reopenedStore.close();
});

test('V2 purge failure rolls back payload deletion but keeps durable suppression until retry', () => {
  const { store, memory, mission } = fixture();
  memory.checkpoint(mission.missionId, checkpoint());
  store.db.exec("CREATE TRIGGER deny_memory_delete BEFORE DELETE ON project_memory_v2_missions BEGIN SELECT RAISE(ABORT, 'fixture denial'); END");
  assert.throws(() => memory.forgetMission(mission.missionId), /fixture denial/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_memory_v2_forgotten').get().n, 0);
  assert.throws(() => memory.latest(mission.missionId), /forgotten/);
  assert.equal(store.db.prepare("SELECT state FROM memory_erasure_progress WHERE store='project_v2'").get().state, 'retryable');
  store.db.exec('DROP TRIGGER deny_memory_delete');
  memory.forgetMission(mission.missionId);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_memory_v2_missions').get().n, 0);
  store.close();
});
