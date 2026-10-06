'use strict';

const { ProjectMemoryV2, repositoryFingerprint } = require('../project-memory-v2');

const TRUSTED_EVIDENCE_SOURCES = new Set(['runtime', 'operator', 'test_runner', 'repository']);
const TERMINAL_STATES = new Set(['completed', 'cancelled', 'blocked', 'failed', 'interrupted']);
const MAX_RECORDS = 24;
const MAX_FILES = 48;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function safeNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid adapter timestamp');
  return value;
}
function appendUnique(items, item, limit = MAX_RECORDS) {
  if (items.some(existing => same(existing, item))) return false;
  items.push(item);
  while (items.length > limit) items.shift();
  return true;
}
function mergePaths(items, additions) {
  if (!Array.isArray(additions)) throw new Error('Changed files must be an array');
  for (const item of additions) if (!items.includes(item)) items.push(item);
  while (items.length > MAX_FILES) items.shift();
}
function initialState(repository, { phase = 'bootstrap', currentStep = 'Mission identity recorded.', nextAction = 'Await a verified lifecycle event.', completionState = 'in_progress' } = {}) {
  return {
    execution: { phase, currentStep, nextAction, completionState },
    verifiedFacts: [], hypotheses: [], decisions: [], repository,
    files: { changed: [], inspected: [], protectedPreExisting: [], components: [] },
    tests: [], blockers: [], failedApproaches: [], constraints: []
  };
}
function failure(error, { critical = false, terminal = false } = {}) {
  return {
    ok: false,
    disposition: critical ? 'needs_review' : 'degraded',
    failureClass: critical ? 'fail_closed' : 'degrade_safely',
    reason: error instanceof Error ? error.message : String(error),
    ...(terminal ? { safetyActionMustContinue: true } : {})
  };
}

class ProjectMemoryV2Adapter {
  constructor({ db, now = Date.now, memory = null } = {}) {
    this.now = now;
    this.memory = memory || new ProjectMemoryV2({ db, now });
  }

  _state(missionId) {
    const latest = this.memory.latest(missionId);
    if (!latest) throw new Error('Memory V2 mission has no durable bootstrap checkpoint');
    const state = clone(latest.state);
    delete state.schemaVersion;
    delete state.repositoryFingerprint;
    delete state.privacy;
    return state;
  }

  _checkpoint(missionId, state, options = {}) {
    try {
      const checkpoint = this.memory.checkpoint(missionId, state);
      return { ok: true, disposition: checkpoint.deduplicated ? 'deduplicated' : 'checkpointed', checkpoint };
    } catch (error) { return failure(error, options); }
  }

  initializeMission({ missionId, taskId, objective, workspace, scope, repository = null, execution = undefined } = {}) {
    const mission = this.memory.registerMission({ missionId, taskId, objective, workspace, scope });
    if (this.memory.latest(mission.missionId)) return { ok: true, disposition: 'already_initialized', mission };
    const saved = this._checkpoint(mission.missionId, initialState(repository, execution), { critical: true });
    if (!saved.ok) return saved;
    return { ok: true, disposition: 'initialized', mission, checkpoint: saved.checkpoint };
  }

  prepareResume({ missionId, currentRepository, automaticRecovery = false } = {}) {
    try {
      const restored = this.memory.restore(missionId, { currentRepository });
      if (automaticRecovery && restored.repositoryStatus !== 'current') {
        return {
          ok: false, disposition: 'needs_review', failureClass: 'fail_closed',
          reason: `Memory V2 repository evidence is ${restored.repositoryStatus}; automatic recovery is not trustworthy`,
          repositoryStatus: restored.repositoryStatus
        };
      }
      return {
        ok: true, disposition: 'ready', mission: restored.mission, packet: restored.packet,
        serialized: restored.serialized, bytes: restored.bytes, truncated: restored.truncated,
        repositoryStatus: restored.repositoryStatus, nextAction: restored.packet.execution.nextAction,
        blockers: restored.packet.blockers
      };
    } catch (error) { return failure(error, { critical: automaticRecovery }); }
  }

  _record(missionId, mutate, options = {}) {
    try {
      const state = this._state(missionId);
      mutate(state);
      return this._checkpoint(missionId, state, options);
    } catch (error) { return failure(error, options); }
  }

  recordVerifiedFinding({ missionId, finding } = {}) {
    if (!finding || !TRUSTED_EVIDENCE_SOURCES.has(finding.evidenceSource)) throw new Error('Verified findings require a trusted evidenceSource');
    if (finding.evidenceSource === 'test_runner' && finding.evidenceClass !== 'test_receipt') throw new Error('Test-runner evidence must be a test receipt');
    if (finding.evidenceSource === 'repository' && finding.evidenceClass !== 'repository_observation') throw new Error('Repository evidence must be a repository observation');
    return this._record(missionId, state => {
      const fact = {
        fact: finding.fact, evidence: finding.evidence, evidenceClass: finding.evidenceClass,
        verifiedAt: finding.verifiedAt === undefined ? safeNow(this.now) : finding.verifiedAt,
        taskId: finding.taskId, sessionId: finding.sessionId
      };
      if (['test_receipt', 'repository_observation'].includes(fact.evidenceClass)) fact.sourceFingerprint = finding.sourceFingerprint === undefined ? repositoryFingerprint(state.repository) : finding.sourceFingerprint;
      appendUnique(state.verifiedFacts, fact);
    });
  }

  recordHypothesis({ missionId, hypothesis, source = 'model_interpretation', recordedAt = safeNow(this.now) } = {}) {
    return this._record(missionId, state => appendUnique(state.hypotheses, { hypothesis, source, recordedAt }));
  }

  recordDecision({ missionId, decision, rationale, constraints = [], decidedAt = safeNow(this.now) } = {}) {
    return this._record(missionId, state => appendUnique(state.decisions, { decision, rationale, constraints, decidedAt }));
  }

  recordSourceChange({ missionId, repository, changedFiles = [], inspectedFiles = [] } = {}) {
    if (repository === null || repository === undefined) return failure(new Error('Repository snapshot is unavailable'), { critical: false });
    return this._record(missionId, state => {
      state.repository = repository;
      mergePaths(state.files.changed, changedFiles);
      mergePaths(state.files.inspected, inspectedFiles);
    });
  }

  recordTestResult({ missionId, test } = {}) {
    if (!test || test.evidenceSource !== 'test_runner' || test.executionStatus !== 'COMPLETED') throw new Error('Test results require an actually executed test-runner receipt');
    return this._record(missionId, state => {
      const sourceFingerprint = repositoryFingerprint(state.repository);
      if (sourceFingerprint === null) throw new Error('Test receipt requires a repository/source snapshot');
      const receipt = {
        identity: test.identity, executionStatus: 'COMPLETED', outcome: test.outcome,
        exitCode: test.exitCode, counts: test.counts, observedAt: test.observedAt === undefined ? safeNow(this.now) : test.observedAt,
        sourceFingerprint
      };
      appendUnique(state.tests, receipt);
    });
  }

  recordBlocker({ missionId, blocker } = {}) {
    if (!blocker || blocker.executionStatus !== 'NOT_EXECUTED') throw new Error('Blockers must remain NOT_EXECUTED');
    return this._record(missionId, state => appendUnique(state.blockers, {
      category: blocker.category, action: blocker.action, approvalState: blocker.approvalState,
      approvalReference: blocker.approvalReference === undefined ? null : blocker.approvalReference,
      executionStatus: 'NOT_EXECUTED', recordedAt: blocker.recordedAt === undefined ? safeNow(this.now) : blocker.recordedAt
    }));
  }

  recordFailedApproach({ missionId, approach, reason, recordedAt = safeNow(this.now) } = {}) {
    return this._record(missionId, state => appendUnique(state.failedApproaches, { approach, reason, recordedAt }));
  }

  setNextAction({ missionId, nextAction, phase = undefined, currentStep = undefined } = {}) {
    return this._record(missionId, state => {
      state.execution.nextAction = nextAction;
      if (phase !== undefined) state.execution.phase = phase;
      if (currentStep !== undefined) state.execution.currentStep = currentStep;
    });
  }

  prepareForRecovery({ missionId, currentRepository } = {}) {
    try {
      const durable = this._checkpoint(missionId, this._state(missionId), { critical: true });
      if (!durable.ok) return durable;
      return this.prepareResume({ missionId, currentRepository, automaticRecovery: true });
    } catch (error) { return failure(error, { critical: true }); }
  }

  checkpointForContextPressure({ missionId, signal } = {}) {
    if (!signal) return { ok: true, disposition: 'no_action', reason: 'No caller-supplied context-pressure signal' };
    if (signal.source !== 'bridge_context_pressure' || typeof signal.warning !== 'boolean' || typeof signal.continuation !== 'boolean' || !Number.isSafeInteger(signal.observedAt)) {
      return { ok: false, disposition: 'no_action', failureClass: 'degrade_safely', reason: 'Untrusted or malformed context-pressure signal' };
    }
    if (!signal.warning && !signal.continuation) return { ok: true, disposition: 'no_action', reason: 'Context pressure is below the caller threshold' };
    try { return this._checkpoint(missionId, this._state(missionId), { critical: false }); } catch (error) { return failure(error); }
  }

  recordTerminalState({ missionId, status, nextAction = undefined } = {}) {
    if (!TERMINAL_STATES.has(status)) throw new Error('Invalid terminal state');
    try {
      return this._record(missionId, state => {
        state.execution.phase = 'terminal';
        state.execution.currentStep = `Terminal state recorded: ${status}`;
        state.execution.nextAction = nextAction === undefined ? 'No automatic action. Follow current safety policy.' : nextAction;
        state.execution.completionState = status;
      }, { terminal: true });
    } catch (error) { return failure(error, { terminal: true }); }
  }
}

module.exports = { ProjectMemoryV2Adapter, TRUSTED_EVIDENCE_SOURCES, TERMINAL_STATES };
