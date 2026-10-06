'use strict';

const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const erasure = require('./memory-erasure');
const { validateCheckpoint: validateLegacyCheckpoint } = require('./mission-checkpoint');

const MAX_CHECKPOINTS = 32;
const MAX_STATE_CHARS = 16_000;
const MAX_RESUME_CHARS = 6_000;
const MAX_RECORDS = 24;
const MAX_PATHS = 48;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/i;
const SECRET_ASSIGNMENT = /\b(api[ _-]?key|access[ _-]?token|token|password|secret|authorization|credential|cookie)\b\s*[:=]\s*([^\s,;]+)/gi;
const OPENAI_TOKEN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function stringify(value) { return JSON.stringify(stable(value)); }
function sha256(value) { return createHash('sha256').update(stringify(value)).digest('hex'); }
function nowValue(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}
function opaque(value, name, maximum = 128) {
  if (typeof value !== 'string' || !ID.test(value) || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function tracker() { return { redactions: 0 }; }
function text(value, name, maximum, state) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new Error(`Invalid ${name}`);
  let redacted = require('./transport-outcome').redactUrls(value).replace(/\b(?:xox[baprs]-|xapp-|sk-ant-|sk-proj-|crsr_)[A-Za-z0-9_-]+/g, '<redacted>').replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '<redacted>').replace(SECRET_ASSIGNMENT, (_match, label) => `${label}=<redacted>`).replace(OPENAI_TOKEN, '<redacted>');
  if (redacted !== value) state.redactions++;
  if (redacted.length > maximum) redacted = redacted.slice(0, maximum);
  return redacted;
}
function exact(value, keys, name) {
  if (!plainObject(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${name}`);
}
function list(value, name, maximum = MAX_RECORDS) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function optionalOpaque(value, name) {
  return value === undefined ? null : opaque(value, name);
}
function optionalFingerprint(value, name) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function safeValue(value, name, state, depth = 0) {
  if (depth > 4) throw new Error(`Invalid ${name}`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid ${name}`);
    return value;
  }
  if (typeof value === 'string') return text(value, name, 512, state);
  if (Array.isArray(value)) {
    if (value.length > 20) throw new Error(`Invalid ${name}`);
    return value.map((item, index) => safeValue(item, `${name}[${index}]`, state, depth + 1));
  }
  if (!plainObject(value) || Object.keys(value).length > 32) throw new Error(`Invalid ${name}`);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) throw new Error(`Invalid ${name}`);
    if (SENSITIVE_KEY.test(key)) { state.redactions++; continue; }
    output[key] = safeValue(value[key], `${name}.${key}`, state, depth + 1);
  }
  return output;
}

function normalizeMission(input, now) {
  exact(input, ['missionId', 'taskId', 'objective', 'workspace', 'scope'], 'Memory V2 mission');
  const state = tracker();
  if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace) || input.workspace.includes('\0')) throw new Error('Invalid Memory V2 workspace');
  return {
    missionId: opaque(input.missionId, 'missionId'),
    taskId: opaque(input.taskId, 'taskId'),
    objective: text(input.objective, 'objective', 1_000, state),
    workspace: path.resolve(input.workspace),
    scope: safeValue(input.scope, 'scope', state),
    createdAt: nowValue(now, 'timestamp'),
    redactions: state.redactions
  };
}

function normalizeExecution(value, state) {
  exact(value, ['phase', 'currentStep', 'nextAction', 'completionState'], 'execution state');
  return {
    phase: text(value.phase, 'execution phase', 256, state),
    currentStep: text(value.currentStep, 'execution currentStep', 1_000, state),
    nextAction: text(value.nextAction, 'execution nextAction', 1_000, state),
    completionState: text(value.completionState, 'execution completionState', 128, state)
  };
}
function normalizeFacts(value, state) {
  return list(value, 'verifiedFacts').map((item, index) => {
    exact(item, ['fact', 'evidence', 'evidenceClass', 'verifiedAt', 'taskId', 'sessionId', 'sourceFingerprint'], `verifiedFact ${index}`);
    for (const key of ['fact', 'evidence', 'evidenceClass', 'verifiedAt', 'taskId', 'sessionId']) if (!Object.hasOwn(item, key)) throw new Error(`Invalid verifiedFact ${index}`);
    if (!['operator_assertion', 'runtime_observation', 'test_receipt', 'repository_observation'].includes(item.evidenceClass)) throw new Error('Invalid verified fact evidence class');
    const normalized = {
      fact: text(item.fact, 'verified fact', 1_000, state), evidence: text(item.evidence, 'verified fact evidence', 2_000, state),
      evidenceClass: item.evidenceClass, verifiedAt: nowValue(item.verifiedAt, 'verified fact timestamp'),
      taskId: optionalOpaque(item.taskId, 'verified fact taskId'), sessionId: optionalOpaque(item.sessionId, 'verified fact sessionId')
    };
    if (Object.hasOwn(item, 'sourceFingerprint')) normalized.sourceFingerprint = optionalFingerprint(item.sourceFingerprint, 'verified fact source fingerprint');
    return normalized;
  });
}
function normalizeHypotheses(value, state) {
  return list(value, 'hypotheses').map((item, index) => {
    exact(item, ['hypothesis', 'source', 'recordedAt'], `hypothesis ${index}`);
    return { hypothesis: text(item.hypothesis, 'hypothesis', 1_500, state), source: text(item.source, 'hypothesis source', 128, state), recordedAt: nowValue(item.recordedAt, 'hypothesis timestamp') };
  });
}
function normalizeDecisions(value, state) {
  return list(value, 'decisions').map((item, index) => {
    exact(item, ['decision', 'rationale', 'constraints', 'decidedAt'], `decision ${index}`);
    return {
      decision: text(item.decision, 'decision', 1_000, state), rationale: text(item.rationale, 'decision rationale', 1_500, state),
      constraints: list(item.constraints, 'decision constraints', 12).map((constraint, constraintIndex) => text(constraint, `decision constraint ${constraintIndex}`, 500, state)),
      decidedAt: nowValue(item.decidedAt, 'decision timestamp')
    };
  });
}
function normalizePaths(value, name, state) {
  return list(value, name, MAX_PATHS).map((item, index) => {
    if (typeof item !== 'string' || !item || item.length > 1_000 || item.includes('\0') || path.isAbsolute(item) || item.split(/[\\/]/).some(part => part === '..')) throw new Error(`Invalid ${name} path`);
    return text(item, `${name}[${index}]`, 1_000, state);
  });
}
function normalizeRepository(value, state) {
  if (value === null) return null;
  exact(value, ['repositoryId', 'branch', 'head', 'dirty', 'modifiedFiles', 'worktree', 'observedAt'], 'repository state');
  if (typeof value.dirty !== 'boolean') throw new Error('Invalid repository dirty state');
  return {
    repositoryId: text(value.repositoryId, 'repository id', 512, state), branch: text(value.branch, 'repository branch', 256, state),
    head: text(value.head, 'repository HEAD', 256, state), dirty: value.dirty,
    modifiedFiles: normalizePaths(value.modifiedFiles, 'repository modifiedFiles', state),
    worktree: text(value.worktree, 'repository worktree', 1_000, state), observedAt: nowValue(value.observedAt, 'repository timestamp')
  };
}
function repositoryFingerprint(repository) {
  if (repository === null) return null;
  const { observedAt: _observedAt, ...stableRepository } = repository;
  return sha256(stableRepository);
}
function normalizeFiles(value, state) {
  exact(value, ['changed', 'inspected', 'protectedPreExisting', 'components'], 'file state');
  return {
    changed: normalizePaths(value.changed, 'changed files', state), inspected: normalizePaths(value.inspected, 'inspected files', state),
    protectedPreExisting: normalizePaths(value.protectedPreExisting, 'protected files', state),
    components: list(value.components, 'components', MAX_PATHS).map((item, index) => text(item, `component ${index}`, 512, state))
  };
}
function normalizeCounts(value) {
  if (value === null) return null;
  exact(value, ['passed', 'failed', 'skipped'], 'test counts');
  const counts = {};
  for (const key of ['passed', 'failed', 'skipped']) counts[key] = nowValue(value[key], `test ${key} count`);
  return counts;
}
function normalizeTests(value, state) {
  return list(value, 'test evidence').map((item, index) => {
    exact(item, ['identity', 'executionStatus', 'outcome', 'exitCode', 'counts', 'observedAt', 'sourceFingerprint'], `test evidence ${index}`);
    for (const key of ['identity', 'executionStatus', 'outcome', 'exitCode', 'counts', 'observedAt']) if (!Object.hasOwn(item, key)) throw new Error(`Invalid test evidence ${index}`);
    if (!['COMPLETED', 'NOT_EXECUTED'].includes(item.executionStatus) || !['passed', 'failed', 'not_executed'].includes(item.outcome)) throw new Error('Invalid test execution evidence');
    const exitCode = item.exitCode;
    if (item.executionStatus === 'NOT_EXECUTED') {
      if (item.outcome !== 'not_executed' || exitCode !== null || item.counts !== null) throw new Error('Not-executed tests cannot be represented as validation');
    } else {
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255 || item.counts === null) throw new Error('Completed tests require actual exit status and counts');
      if ((exitCode === 0) !== (item.outcome === 'passed')) throw new Error('Test outcome conflicts with actual exit status');
    }
    const normalized = {
      identity: text(item.identity, 'test identity', 1_000, state), executionStatus: item.executionStatus,
      outcome: item.outcome, exitCode, counts: normalizeCounts(item.counts),
      observedAt: nowValue(item.observedAt, 'test timestamp')
    };
    if (Object.hasOwn(item, 'sourceFingerprint')) normalized.sourceFingerprint = optionalFingerprint(item.sourceFingerprint, 'test source fingerprint');
    return normalized;
  });
}
function normalizeBlockers(value, state) {
  return list(value, 'blockers').map((item, index) => {
    exact(item, ['category', 'action', 'approvalState', 'approvalReference', 'executionStatus', 'recordedAt'], `blocker ${index}`);
    if (!['none', 'pending', 'rejected', 'expired', 'consumed', 'denied'].includes(item.approvalState) || item.executionStatus !== 'NOT_EXECUTED') throw new Error('Blocked action must remain NOT EXECUTED');
    return {
      category: text(item.category, 'blocker category', 128, state), action: text(item.action, 'blocked action', 1_000, state),
      approvalState: item.approvalState, approvalReference: item.approvalReference === null ? null : opaque(item.approvalReference, 'approval reference'),
      executionStatus: 'NOT_EXECUTED', recordedAt: nowValue(item.recordedAt, 'blocker timestamp')
    };
  });
}
function normalizeFailures(value, state) {
  return list(value, 'failedApproaches').map((item, index) => {
    exact(item, ['approach', 'reason', 'recordedAt'], `failed approach ${index}`);
    return { approach: text(item.approach, 'failed approach', 1_000, state), reason: text(item.reason, 'failed approach reason', 1_500, state), recordedAt: nowValue(item.recordedAt, 'failed approach timestamp') };
  });
}
function normalizeState(input) {
  exact(input, ['execution', 'verifiedFacts', 'hypotheses', 'decisions', 'repository', 'files', 'tests', 'blockers', 'failedApproaches', 'constraints'], 'Memory V2 state');
  const state = tracker();
  const repository = normalizeRepository(input.repository, state);
  const sourceFingerprint = repositoryFingerprint(repository);
  const normalized = {
    schemaVersion: 2,
    execution: normalizeExecution(input.execution, state), verifiedFacts: normalizeFacts(input.verifiedFacts, state),
    hypotheses: normalizeHypotheses(input.hypotheses, state), decisions: normalizeDecisions(input.decisions, state),
    repository, files: normalizeFiles(input.files, state),
    tests: normalizeTests(input.tests, state), blockers: normalizeBlockers(input.blockers, state),
    failedApproaches: normalizeFailures(input.failedApproaches, state), constraints: list(input.constraints, 'constraints', MAX_RECORDS).map((item, index) => text(item, `constraint ${index}`, 750, state))
  };
  normalized.repositoryFingerprint = sourceFingerprint;
  normalized.privacy = { redactions: state.redactions };
  if (Buffer.byteLength(stringify(normalized), 'utf8') > MAX_STATE_CHARS) throw new Error('Memory V2 checkpoint exceeds its bounded record size');
  return normalized;
}

function checkpointRow(row) {
  return { id: row.checkpoint_id, missionId: row.mission_id, sequence: row.sequence, stateHash: row.state_hash, createdAt: row.created_at };
}
function missionRow(row) {
  return { missionId: row.mission_id, taskId: row.task_id, objective: row.objective, workspace: row.workspace, scope: JSON.parse(row.scope_json), createdAt: row.created_at, updatedAt: row.updated_at };
}
function decodeCheckpoint(row) {
  let state;
  try { state = JSON.parse(row.state_json); } catch { throw new Error('Memory V2 checkpoint is corrupt'); }
  const expected = sha256(state);
  if (expected !== row.state_hash || state.schemaVersion !== 2) throw new Error('Memory V2 checkpoint integrity check failed');
  try {
    const normalized = normalizeState({
    execution: state.execution, verifiedFacts: state.verifiedFacts, hypotheses: state.hypotheses, decisions: state.decisions,
    repository: state.repository, files: state.files, tests: state.tests, blockers: state.blockers,
    failedApproaches: state.failedApproaches, constraints: state.constraints
    });
    if (!plainObject(state.privacy) || !Number.isSafeInteger(state.privacy.redactions) || state.privacy.redactions < 0 ||
      state.repositoryFingerprint !== normalized.repositoryFingerprint ||
      stringify({ ...normalized, privacy: state.privacy }) !== stringify(state)) {
      throw new Error('Memory V2 checkpoint is corrupt');
    }
    normalized.privacy = state.privacy;
    return normalized;
  } catch { throw new Error('Memory V2 checkpoint is corrupt'); }
}

function shrink(packet) {
  const discard = (items, predicate = () => true) => {
    const index = items.findIndex(predicate);
    if (index < 0) return false;
    items.splice(index, 1);
    return true;
  };
  // Keep identity, execution state, active blockers, repository state, constraints, and
  // restoration flags. Stale evidence leaves first; current validation is last to leave.
  const candidates = [
    () => discard(packet.tests, item => item.validity !== 'current'),
    () => discard(packet.verifiedFacts, item => item.status === 'historical_stale'),
    () => discard(packet.hypotheses),
    () => discard(packet.failedApproaches),
    () => discard(packet.decisions),
    () => discard(packet.files.inspected),
    () => discard(packet.files.components),
    () => discard(packet.verifiedFacts),
    () => discard(packet.files.changed),
    () => discard(packet.tests)
  ];
  let truncated = false;
  while (Buffer.byteLength(JSON.stringify(packet), 'utf8') > MAX_RESUME_CHARS) {
    if (!candidates.some(remove => remove())) throw new Error('Memory V2 resume packet cannot fit its safety bound');
    truncated = true;
  }
  return truncated;
}

class ProjectMemoryV2 {
  constructor({ db, now = Date.now, maxCheckpoints = MAX_CHECKPOINTS, restoreFromBackup = false, erasureSourceDb = null } = {}) {
    if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new Error('Memory V2 requires the existing SQLite database');
    if (!Number.isSafeInteger(maxCheckpoints) || maxCheckpoints < 1 || maxCheckpoints > 128) throw new Error('Invalid Memory V2 checkpoint limit');
    if (typeof restoreFromBackup !== 'boolean') throw new Error('Invalid restore policy');
    if (restoreFromBackup && (!erasureSourceDb || erasureSourceDb === db)) throw new Error('Backup restore requires current independent erasure evidence');
    this.db = db; this.now = now; this.maxCheckpoints = maxCheckpoints;
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_memory_v2_retention (
        mission_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, policy_version INTEGER NOT NULL CHECK(policy_version=1)
      );
      CREATE TABLE IF NOT EXISTS project_memory_v2_forgotten (
        mission_id TEXT PRIMARY KEY, forgotten_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_memory_v2_missions (
        mission_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, objective TEXT NOT NULL, workspace TEXT NOT NULL,
        scope_json TEXT NOT NULL, identity_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_memory_v2_checkpoints (
        checkpoint_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, sequence INTEGER NOT NULL, state_json TEXT NOT NULL,
        state_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(mission_id, sequence), UNIQUE(mission_id, state_hash),
        FOREIGN KEY(mission_id) REFERENCES project_memory_v2_missions(mission_id)
      );
      CREATE INDEX IF NOT EXISTS project_memory_v2_checkpoint_latest ON project_memory_v2_checkpoints(mission_id, sequence DESC);
    `);
    erasure.migrate(db);
    if (restoreFromBackup) this.reconcileErasureFrom(erasureSourceDb);
  }

  registerMission(input) {
    const mission = normalizeMission(input, this.now());
    this._assertNotForgotten(mission.missionId);
    this._expireMission(mission.missionId);
    const identityHash = sha256({ taskId: mission.taskId, objective: mission.objective, workspace: mission.workspace, scope: mission.scope });
    const existing = this.db.prepare('SELECT * FROM project_memory_v2_missions WHERE mission_id=?').get(mission.missionId);
    if (existing) {
      if (existing.identity_hash !== identityHash) throw new Error('Memory V2 mission identity or scope changed');
      return { ...missionRow(existing), created: false, redactions: mission.redactions };
    }
    this.db.prepare('INSERT INTO project_memory_v2_missions(mission_id,task_id,objective,workspace,scope_json,identity_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(mission.missionId, mission.taskId, mission.objective, mission.workspace, stringify(mission.scope), identityHash, mission.createdAt, mission.createdAt);
    return { missionId: mission.missionId, taskId: mission.taskId, objective: mission.objective, workspace: mission.workspace, scope: mission.scope, createdAt: mission.createdAt, updatedAt: mission.createdAt, created: true, redactions: mission.redactions };
  }

  _assertNotForgotten(missionId) {
    opaque(missionId, 'missionId');
    if (erasure.marker(this.db, 'project_v2', missionId)) throw new Error('Memory V2 mission was forgotten');
    if (this.db.prepare('SELECT 1 FROM project_memory_v2_forgotten WHERE mission_id=?').get(missionId)) throw new Error('Memory V2 mission was forgotten');
  }

  // Fixed absolute deadlines cannot be extended by checkpoint activity or replay.
  setRetention(missionId, options = {}) {
    exact(options, ['expiresAt'], 'retention policy');
    const { expiresAt } = options;
    this._mission(missionId);
    nowValue(expiresAt, 'retention deadline');
    if (expiresAt <= this.now()) throw new Error('Retention deadline must be in the future');
    const prior = this.db.prepare('SELECT expires_at FROM project_memory_v2_retention WHERE mission_id=?').get(missionId);
    if (prior && expiresAt > prior.expires_at) throw new Error('Retention deadline cannot be extended');
    this.db.prepare('INSERT INTO project_memory_v2_retention VALUES (?,?,1) ON CONFLICT(mission_id) DO UPDATE SET expires_at=excluded.expires_at').run(missionId, expiresAt);
    return { missionId, expiresAt, policyVersion: 1, deletion: 'logical_payload_purge', authority: false };
  }

  _expireMission(missionId) {
    const policy = this.db.prepare('SELECT expires_at FROM project_memory_v2_retention WHERE mission_id=?').get(missionId);
    if (policy && policy.expires_at <= this.now()) {
      this.forgetMission(missionId);
      throw new Error('Memory V2 retention expired');
    }
  }

  purgeExpired() {
    const ids = this.db.prepare('SELECT mission_id FROM project_memory_v2_retention WHERE expires_at<=? ORDER BY mission_id').all(nowValue(this.now(), 'timestamp'));
    this.db.exec('SAVEPOINT memory_retention_purge');
    try {
      for (const row of ids) this.forgetMission(row.mission_id);
      this.db.exec('RELEASE SAVEPOINT memory_retention_purge');
      return { purged: ids.length, physicalErasure: false, authority: false };
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT memory_retention_purge; RELEASE SAVEPOINT memory_retention_purge');
      throw error;
    }
  }

  // Host-only restore preparation: source must be the current trusted erasure
  // database, retained independently of the older backup. Never take agent input.
  reconcileErasureFrom(sourceDb) {
    if (!sourceDb || sourceDb === this.db) throw new Error('Independent current erasure database required');
    const rows = sourceDb.prepare('SELECT mission_id,forgotten_at FROM project_memory_v2_forgotten').all();
    const policies = sourceDb.prepare('SELECT mission_id,expires_at,policy_version FROM project_memory_v2_retention').all();
    for (const row of policies) { opaque(row.mission_id, 'missionId'); nowValue(row.expires_at, 'retention deadline'); if (row.policy_version !== 1) throw new Error('Unknown retention policy'); }
    for (const row of rows) { opaque(row.mission_id, 'missionId'); nowValue(row.forgotten_at, 'erasure timestamp'); }
    this.db.exec('SAVEPOINT memory_restore_erasure');
    try {
      if (erasure.exists(sourceDb, 'memory_erasure_meta')) erasure.reconcile(this.db, sourceDb);
      // Check scope while restored rows still exist, before legacy tombstones
      // purge them. Otherwise an ID collision could erase another workspace.
      for (const marker of this.db.prepare("SELECT * FROM memory_erasure_markers WHERE store='project_v2'").all()) {
        const restored = this.db.prepare('SELECT * FROM project_memory_v2_missions WHERE mission_id=?').get(marker.identity);
        if (restored && erasure.scopeHash([restored.task_id,restored.workspace,restored.scope_json]) !== marker.scope_hash) throw Error('Restore erasure scope mismatch');
      }
      for (const row of rows) {
        this.db.prepare('INSERT INTO project_memory_v2_forgotten VALUES (?,?) ON CONFLICT(mission_id) DO UPDATE SET forgotten_at=min(forgotten_at,excluded.forgotten_at)').run(row.mission_id, row.forgotten_at);
        this.forgetMission(row.mission_id);
      }
      for (const marker of this.db.prepare("SELECT * FROM memory_erasure_markers WHERE store='project_v2'").all()) {
        const restored = this.db.prepare('SELECT * FROM project_memory_v2_missions WHERE mission_id=?').get(marker.identity);
        if (restored && erasure.scopeHash([restored.task_id,restored.workspace,restored.scope_json]) !== marker.scope_hash) throw Error('Restore erasure scope mismatch');
        this.db.prepare('INSERT OR IGNORE INTO project_memory_v2_forgotten VALUES (?,?)').run(marker.identity, marker.erased_at);
        this.forgetMission(marker.identity);
      }
      for (const row of policies) {
        if (this.db.prepare('SELECT 1 FROM project_memory_v2_missions WHERE mission_id=?').get(row.mission_id)) this.db.prepare('INSERT INTO project_memory_v2_retention VALUES (?,?,1) ON CONFLICT(mission_id) DO UPDATE SET expires_at=min(expires_at,excluded.expires_at)').run(row.mission_id, row.expires_at);
      }
      this.purgeExpired();
      this.db.exec('RELEASE SAVEPOINT memory_restore_erasure');
      return { reconciled: rows.length, authority: false, physicalErasure: false };
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT memory_restore_erasure; RELEASE SAVEPOINT memory_restore_erasure');
      throw error;
    }
  }

  // Host/operator maintenance only; no agent tool or authority is introduced.
  forgetMission(missionId) {
    opaque(missionId, 'missionId');
    const mission = this.db.prepare('SELECT * FROM project_memory_v2_missions WHERE mission_id=?').get(missionId);
    if (mission) erasure.mark(this.db, { store: 'project_v2', identity: missionId, scope_hash: erasure.scopeHash([mission.task_id,mission.workspace,mission.scope_json]), erased_at: this.now() });
    this.db.exec('SAVEPOINT project_memory_forget');
    try {
      const prior = this.db.prepare('SELECT forgotten_at FROM project_memory_v2_forgotten WHERE mission_id=?').get(missionId);
      if (!prior) {
        if (!this.db.prepare('SELECT 1 FROM project_memory_v2_missions WHERE mission_id=?').get(missionId)) throw new Error('Memory V2 mission not found');
        this.db.prepare('INSERT INTO project_memory_v2_forgotten VALUES (?,?)').run(missionId, nowValue(this.now(), 'timestamp'));
      }
      this.db.prepare('DELETE FROM project_memory_v2_retention WHERE mission_id=?').run(missionId);
      this.db.prepare('DELETE FROM project_memory_v2_checkpoints WHERE mission_id=?').run(missionId);
      this.db.prepare('DELETE FROM project_memory_v2_missions WHERE mission_id=?').run(missionId);
      const receipt = this.db.prepare('SELECT forgotten_at FROM project_memory_v2_forgotten WHERE mission_id=?').get(missionId);
      this.db.exec('RELEASE SAVEPOINT project_memory_forget');
      if (erasure.marker(this.db, 'project_v2', missionId)) erasure.progress(this.db, 'project_v2', missionId, 'purged', this.now());
      return { missionId, forgottenAt: receipt.forgotten_at, forgotten: true, authority: false };
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT project_memory_forget; RELEASE SAVEPOINT project_memory_forget');
      if (erasure.marker(this.db, 'project_v2', missionId)) erasure.progress(this.db, 'project_v2', missionId, 'retryable', this.now());
      throw error;
    }
  }

  _mission(missionId) {
    this._assertNotForgotten(missionId);
    this._expireMission(missionId);
    const row = this.db.prepare('SELECT * FROM project_memory_v2_missions WHERE mission_id=?').get(opaque(missionId, 'missionId'));
    if (!row) throw new Error('Memory V2 mission not found');
    return row;
  }

  checkpoint(missionId, input) {
    const mission = this._mission(missionId);
    const state = normalizeState(input);
    if (state.verifiedFacts.some(fact => fact.taskId !== null && fact.taskId !== mission.task_id)) {
      throw new Error('Memory V2 verified facts must remain bound to the mission task');
    }
    const stateHash = sha256(state);
    const timestamp = nowValue(this.now(), 'timestamp');
    this.db.exec('SAVEPOINT project_memory_initialize');
    let committed = false;
    try {
      const existing = this.db.prepare('SELECT * FROM project_memory_v2_checkpoints WHERE mission_id=? AND state_hash=?').get(mission.mission_id, stateHash);
      if (existing) {
        this.db.exec('RELEASE SAVEPOINT project_memory_initialize');
        committed = true;
        return { ...checkpointRow(existing), deduplicated: true, redactions: state.privacy.redactions };
      }
      const latest = this.db.prepare('SELECT sequence FROM project_memory_v2_checkpoints WHERE mission_id=? ORDER BY sequence DESC LIMIT 1').get(mission.mission_id);
      const sequence = (latest?.sequence || 0) + 1;
      const row = { checkpointId: randomUUID(), sequence };
      this.db.prepare('INSERT INTO project_memory_v2_checkpoints(checkpoint_id,mission_id,sequence,state_json,state_hash,created_at) VALUES (?,?,?,?,?,?)').run(row.checkpointId, mission.mission_id, sequence, stringify(state), stateHash, timestamp);
      this.db.prepare('UPDATE project_memory_v2_missions SET updated_at=? WHERE mission_id=?').run(timestamp, mission.mission_id);
      const count = this.db.prepare('SELECT count(*) AS count FROM project_memory_v2_checkpoints WHERE mission_id=?').get(mission.mission_id).count;
      const excess = count - this.maxCheckpoints;
      if (excess > 0) this.db.prepare('DELETE FROM project_memory_v2_checkpoints WHERE checkpoint_id IN (SELECT checkpoint_id FROM project_memory_v2_checkpoints WHERE mission_id=? ORDER BY sequence ASC LIMIT ?)').run(mission.mission_id, excess);
      this.db.exec('RELEASE SAVEPOINT project_memory_initialize');
      committed = true;
      return { id: row.checkpointId, missionId: mission.mission_id, sequence, stateHash, createdAt: timestamp, deduplicated: false, redactions: state.privacy.redactions };
    } catch (error) {
      if (!committed) this.db.exec('ROLLBACK TO SAVEPOINT project_memory_initialize; RELEASE SAVEPOINT project_memory_initialize');
      throw error;
    }
  }

  latest(missionId) {
    const mission = this._mission(missionId);
    const row = this.db.prepare('SELECT * FROM project_memory_v2_checkpoints WHERE mission_id=? ORDER BY sequence DESC LIMIT 1').get(mission.mission_id);
    if (!row) return null;
    return { ...checkpointRow(row), state: decodeCheckpoint(row) };
  }

  restore(missionId, { currentRepository = undefined } = {}) {
    const mission = missionRow(this._mission(missionId));
    const latest = this.latest(mission.missionId);
    if (!latest) throw new Error('Memory V2 has no durable checkpoint for this mission');
    const current = currentRepository === undefined ? undefined : normalizeRepository(currentRepository, tracker());
    const repositoryStatus = current === undefined || latest.state.repository === null
      ? 'unknown'
      : current === null || latest.state.repositoryFingerprint !== repositoryFingerprint(current) ? 'stale' : 'current';
    const currentFingerprint = current === undefined ? undefined : repositoryFingerprint(current);
    const testEvidence = latest.state.tests.map(item => ({
      ...item,
      validity: item.executionStatus === 'NOT_EXECUTED' ? 'not_execution_evidence'
        : item.sourceFingerprint !== undefined
          ? currentFingerprint !== null && currentFingerprint !== undefined && item.sourceFingerprint === currentFingerprint ? 'current' : 'historical_stale'
          : repositoryStatus === 'current' ? 'current' : 'historical_stale'
    }));
    const packet = {
      schemaVersion: 2,
      mission: { missionId: mission.missionId, taskId: mission.taskId, objective: mission.objective, workspace: mission.workspace, scope: mission.scope },
      execution: latest.state.execution,
      verifiedFacts: latest.state.verifiedFacts.map(item => ({
        ...item,
        status: ['repository_observation', 'test_receipt'].includes(item.evidenceClass) &&
          (item.sourceFingerprint !== undefined
            ? currentFingerprint === null || currentFingerprint === undefined || item.sourceFingerprint !== currentFingerprint
            : repositoryStatus !== 'current')
          ? 'historical_stale' : 'durable_verified'
      })),
      hypotheses: latest.state.hypotheses.map(item => ({ ...item, status: 'unverified_interpretation' })),
      decisions: latest.state.decisions,
      repository: { saved: latest.state.repository, current: current === undefined ? null : current, status: repositoryStatus },
      files: latest.state.files,
      tests: testEvidence,
      blockers: latest.state.blockers,
      failedApproaches: latest.state.failedApproaches,
      constraints: latest.state.constraints,
      restoration: { checkpointId: latest.id, sequence: latest.sequence, authorizationsRestored: false, approvalCredentialsStored: false }
    };
    const truncated = shrink(packet);
    const serialized = JSON.stringify(packet);
    return { mission, checkpoint: { id: latest.id, sequence: latest.sequence, createdAt: latest.createdAt, stateHash: latest.stateHash }, repositoryStatus, packet, serialized, bytes: Buffer.byteLength(serialized, 'utf8'), truncated };
  }

  count(missionId) {
    const mission = this._mission(missionId);
    return this.db.prepare('SELECT count(*) AS count FROM project_memory_v2_checkpoints WHERE mission_id=?').get(mission.mission_id).count;
  }

  static legacyDraft(entry, { recordedAt = Date.now() } = {}) {
    if (!entry || typeof entry.content !== 'string') throw new Error('Legacy Memory V1 checkpoint entry is required');
    let legacy;
    try { legacy = validateLegacyCheckpoint(JSON.parse(entry.content)); } catch { throw new Error('Legacy Memory V1 checkpoint is invalid'); }
    const state = tracker();
    return {
      objective: text(legacy.objective, 'legacy objective', 1_000, state),
      hypotheses: [
        ...legacy.hypotheses.map(hypothesis => ({ hypothesis: text(hypothesis, 'legacy hypothesis', 1_500, state), source: 'legacy_v1', recordedAt: nowValue(recordedAt, 'legacy timestamp') })),
        ...legacy.verifiedFacts.map(fact => ({ hypothesis: text(`Legacy V1 claim requiring re-verification: ${fact.fact}; evidence: ${fact.evidence}`, 'legacy verified claim', 1_500, state), source: 'legacy_v1', recordedAt: nowValue(recordedAt, 'legacy timestamp') }))
      ],
      decisions: legacy.decisions.map(decision => ({ decision: text(decision, 'legacy decision', 1_000, state), rationale: 'Imported as historical context; revalidate against current evidence.', constraints: [], decidedAt: nowValue(recordedAt, 'legacy timestamp') })),
      failedApproaches: legacy.failedApproaches.map(approach => ({ approach: text(approach, 'legacy failed approach', 1_000, state), reason: 'Imported historical failure; do not retry without current review.', recordedAt: nowValue(recordedAt, 'legacy timestamp') })),
      constraints: legacy.gitReferences.map(reference => text(`Historical Git reference: ${reference}`, 'legacy Git reference', 750, state)),
      nextAction: text(legacy.nextStep, 'legacy next action', 1_000, state),
      verifiedFacts: [], completedGates: [], redactions: state.redactions
    };
  }
}

module.exports = { ProjectMemoryV2, MAX_CHECKPOINTS, MAX_STATE_CHARS, MAX_RESUME_CHARS, repositoryFingerprint };
