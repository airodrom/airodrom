'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { Level1AcceptanceRecorder } = require('./level1-acceptance');
const { Level1DecisionVerifier } = require('./level1-provider');
const { config, LEVEL1_PROFILE_ID, CANDIDATES, taskDefinition, selectExpectedTaskB, isExpectedTaskBResult } = require('./level1-profile');

const hash = value => createHash('sha256').update(value).digest('hex');
const OPAQUE = /^[A-Za-z0-9_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prepared Level 1 state machine. It creates no grants, provider, listener, or task by itself. */
class Level1MissionFlow {
  constructor(db, { now = Date.now, verifier = null, verifyGrant = null, dispatchTaskB = null, acceptance = null } = {}) {
    if (!db || typeof db.exec !== 'function') throw new Error('Level 1 mission journal database required');
    if (verifier !== null && !(verifier instanceof Level1DecisionVerifier)) throw new Error('Unsupported Level 1 decision verifier');
    this.db = db; this.now = now; this.verifier = verifier; this.verifyGrant = verifyGrant; this.dispatchTaskBCallback = dispatchTaskB;
    this.acceptance = acceptance || new Level1AcceptanceRecorder(db, { now, verifier });
    if (acceptance && verifier && acceptance.verifier !== verifier) throw new Error('Level 1 acceptance recorder must use the mission decision verifier');
    db.exec(`
      CREATE TABLE IF NOT EXISTS level1_missions (
        mission_id TEXT PRIMARY KEY, task_a_id TEXT NOT NULL, workspace TEXT NOT NULL,
        expires_at INTEGER NOT NULL, status TEXT NOT NULL, candidates_json TEXT NOT NULL, grant_id TEXT,
        selected_task_b_id TEXT, task_a_event_id TEXT, task_a_session_id TEXT, task_a_result TEXT, task_a_result_hash TEXT,
        task_b_event_id TEXT, task_b_session_id TEXT, task_b_result TEXT, task_b_result_hash TEXT,
        created_at INTEGER NOT NULL, activated_at INTEGER,
        usage_json TEXT NOT NULL DEFAULT '{"runtimeMs":0,"actions":0,"retries":0}'
      );
      CREATE TABLE IF NOT EXISTS level1_decisions (
        decision_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, phase TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE, result_hash TEXT NOT NULL, task_b_id TEXT NOT NULL,
        response_id TEXT NOT NULL UNIQUE, nonce TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
        simulation INTEGER NOT NULL, state TEXT NOT NULL,
        FOREIGN KEY(mission_id) REFERENCES level1_missions(mission_id)
      );
      CREATE TABLE IF NOT EXISTS level1_dispatches (
        dispatch_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL UNIQUE, decision_id TEXT NOT NULL UNIQUE,
        task_b_id TEXT NOT NULL, state TEXT NOT NULL, task_b_session_id TEXT, created_at INTEGER NOT NULL,
        FOREIGN KEY(mission_id) REFERENCES level1_missions(mission_id),
        FOREIGN KEY(decision_id) REFERENCES level1_decisions(decision_id)
      );
      CREATE TABLE IF NOT EXISTS level1_preflight_checkpoints (
        checkpoint_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, provider_mode TEXT NOT NULL, code TEXT NOT NULL, reason TEXT NOT NULL,
        paused_at INTEGER NOT NULL, resumed_at INTEGER,
        FOREIGN KEY(mission_id) REFERENCES level1_missions(mission_id)
      );
    `);
    const missionColumns = new Set(db.prepare('PRAGMA table_info(level1_missions)').all().map(column => column.name));
    if (!missionColumns.has('usage_json')) db.exec("ALTER TABLE level1_missions ADD COLUMN usage_json TEXT NOT NULL DEFAULT '{\"runtimeMs\":0,\"actions\":0,\"retries\":0}'");
  }

  register({ missionId, taskAId = config.taskA.id, workspace, expiresAt, grantId = null }) {
    if (!OPAQUE.test(missionId) || taskAId !== config.taskA.id || workspace !== require('./level1-profile').WORKSPACE || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) throw new Error('Invalid Level 1 mission template');
    if (grantId !== null && !OPAQUE.test(grantId)) throw new Error('Invalid Level 1 grant reference');
    const candidates = config.taskBCandidates.map(item => ({ taskId: item.taskId, route: item.route, objective: item.objective, readPaths: [...item.readPaths], expectedProof: item.expectedProof }));
    this.db.prepare('INSERT INTO level1_missions(mission_id,task_a_id,workspace,expires_at,status,candidates_json,grant_id,selected_task_b_id,created_at) VALUES (?,?,?,?,?,?,?,NULL,?)')
      .run(missionId, taskAId, workspace, expiresAt, 'prepared', JSON.stringify(candidates), grantId, this.now());
    return this.snapshot(missionId);
  }

  snapshot(missionId) {
    const row = this.db.prepare('SELECT * FROM level1_missions WHERE mission_id=?').get(missionId);
    if (!row) return null;
    return { ...row, candidates: JSON.parse(row.candidates_json), used: JSON.parse(row.usage_json), acceptance: this.acceptanceSnapshot(missionId) };
  }

  usage(missionId) { return JSON.parse(this._mission(missionId).usage_json); }

  recordUsage(missionId, used) {
    const mission = this._active(missionId), current = JSON.parse(mission.usage_json);
    const maximum = { runtimeMs: config.grant.maxRuntimeMs, actions: config.grant.maxActions, retries: config.grant.maxRetries };
    for (const field of Object.keys(maximum)) if (!Number.isSafeInteger(used?.[field]) || used[field] < current[field] || used[field] > maximum[field]) throw new Error(`Invalid cumulative Level 1 ${field} usage`);
    this.db.prepare("UPDATE level1_missions SET usage_json=? WHERE mission_id=? AND status='active'").run(JSON.stringify(used), missionId);
    return { ...used };
  }

  acceptanceSnapshot(missionId) {
    const exists = this.db.prepare('SELECT 1 FROM level1_acceptance_missions WHERE mission_id=?').get(missionId);
    return exists ? this.acceptance.snapshot(missionId) : null;
  }

  activate(missionId, { grantId, authorizationId, authorizedAt = this.now() } = {}) {
    const row = this._mission(missionId);
    if (row.status !== 'prepared') throw new Error('Level 1 mission is not in prepared state');
    if (typeof this.verifyGrant !== 'function') throw new Error('Trusted live mission grant verifier is not configured');
    if (!OPAQUE.test(grantId || '')) throw new Error('Level 1 activation requires a pre-issued read-only grant reference');
    const mission = this._grantScope(row, 'task_a', null, grantId);
    const result = this.verifyGrant(mission);
    if (!result?.allow || !Array.isArray(result.capabilities) || result.capabilities.length !== 1 || result.capabilities[0] !== 'read' || result.egress !== 'local-only') throw new Error('Level 1 activation requires a verified read-only, local-only grant');
    if (!OPAQUE.test(authorizationId) || !Number.isSafeInteger(authorizedAt) || authorizedAt > this.now() || authorizedAt < row.created_at) throw new Error('Invalid Level 1 authorization receipt');
    this.acceptance.authorize(missionId, authorizationId, authorizedAt);
    this.db.prepare("UPDATE level1_missions SET status='active',grant_id=?,activated_at=? WHERE mission_id=? AND status='prepared'").run(grantId, authorizedAt, missionId);
    return this.snapshot(missionId);
  }

  pausePreflight(missionId, { code, reason, providerMode } = {}) {
    const mission = this._mission(missionId);
    if (mission.status !== 'prepared' || !OPAQUE.test(providerMode || '') || !OPAQUE.test(code || '') || typeof reason !== 'string' || !reason || reason.length > 500) throw new Error('Invalid Level 1 provider preflight checkpoint');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE level1_missions SET status='paused' WHERE mission_id=? AND status='prepared'").run(missionId);
      this.db.prepare('INSERT INTO level1_preflight_checkpoints(checkpoint_id,mission_id,provider_mode,code,reason,paused_at,resumed_at) VALUES (?,?,?,?,?,?,NULL)').run(randomUUID(), missionId, providerMode, code, reason, this.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.snapshot(missionId);
  }

  resumePreflight(missionId) {
    const mission = this._mission(missionId);
    const checkpoint = this.db.prepare('SELECT * FROM level1_preflight_checkpoints WHERE mission_id=? AND resumed_at IS NULL ORDER BY paused_at DESC LIMIT 1').get(missionId);
    if (mission.status !== 'paused' || !checkpoint || checkpoint.resumed_at !== null || this.now() >= mission.expires_at) throw new Error('Level 1 preflight checkpoint cannot be resumed');
    this.db.prepare("UPDATE level1_missions SET status='prepared' WHERE mission_id=? AND status='paused'").run(missionId);
    this.db.prepare('UPDATE level1_preflight_checkpoints SET resumed_at=? WHERE checkpoint_id=? AND resumed_at IS NULL').run(this.now(), checkpoint.checkpoint_id);
    return this.snapshot(missionId);
  }

  _grantScope(row, phase = 'task_a', taskBId = null, grantId = row.grant_id) {
    const task = taskDefinition(phase, taskBId);
    return {
      id: row.mission_id, grantId, objective: config.missionObjective, criteria: [...config.acceptanceCriteria], workspace: row.workspace,
      scope: { workspace: row.workspace, readOnlyPaths: [...require('./level1-profile').ALL_READ_PATHS] },
      networkPolicy: { egress: 'local-only', webFetch: false },
      ...require('./level1-profile').createMissionFields(phase, taskBId)
    };
  }

  _mission(missionId) {
    const mission = this.db.prepare('SELECT * FROM level1_missions WHERE mission_id=?').get(missionId);
    if (!mission) throw new Error('Level 1 mission not found');
    return mission;
  }

  _active(missionId) {
    const mission = this._mission(missionId);
    if (mission.status !== 'active') throw new Error(`Level 1 mission is ${mission.status}`);
    if (this.now() >= mission.expires_at) { this.db.prepare("UPDATE level1_missions SET status='expired' WHERE mission_id=?").run(missionId); throw new Error('Level 1 mission expired'); }
    return mission;
  }

  recordTaskAStarted(missionId, { taskId, sessionId, simulation = false } = {}) {
    const mission = this._active(missionId);
    if (simulation && process.env.NODE_ENV !== 'test') throw new Error('Simulated Pi events are restricted to isolated tests');
    if (taskId !== mission.task_a_id || !UUID.test(sessionId) || mission.task_a_event_id) throw new Error('Invalid or duplicate Task A start evidence');
    if (!simulation) this.acceptance.recordPiTaskStarted(missionId, { taskId, sessionId });
  }

  recordTaskAResult({ missionId, taskId, sessionId, eventId, result, authenticated = false, simulation = false }) {
    const mission = this._active(missionId);
    if (authenticated !== true || taskId !== mission.task_a_id || !UUID.test(sessionId) || !UUID.test(eventId) || typeof result !== 'string' || !result.trim() || Buffer.byteLength(result) > 2048 || /[^\x00-\x7f]/.test(result)) throw new Error('Invalid or unauthenticated Level 1 Task A completion event');
    if (simulation && process.env.NODE_ENV !== 'test') throw new Error('Simulated Pi events are restricted to isolated tests');
    if (mission.task_a_event_id) throw new Error('Duplicate Task A completion event');
    const resultHash = hash(result);
    this.db.prepare('UPDATE level1_missions SET task_a_event_id=?,task_a_session_id=?,task_a_result=?,task_a_result_hash=? WHERE mission_id=? AND status=? AND task_a_event_id IS NULL')
      .run(eventId, sessionId, result, resultHash, missionId, 'active');
    if (!simulation) this.acceptance.recordPiCompletion(missionId, { taskId, sessionId, completionEventId: eventId, resultHash });
    return { missionId, taskId, sessionId, eventId, resultHash, selectedTaskBId: null };
  }

  async chooseAndDispatchTaskB(missionId, eventId, adapter) {
    const mission = this._active(missionId);
    if (!mission.task_a_event_id || mission.task_a_event_id !== eventId || mission.selected_task_b_id) throw new Error('Task B cannot be chosen before the latest Task A result or was already selected');
    const expectedTaskB = selectExpectedTaskB(mission.task_a_result);
    if (!this.verifier || !adapter || typeof adapter.reason !== 'function') throw new Error('Level 1 provider decision path is disabled');
    if (typeof this.dispatchTaskBCallback !== 'function') throw new Error('Automatic Level 1 Task B dispatcher is disabled');
    const simulation = adapter.status?.simulation === true;
    if (simulation && process.env.NODE_ENV !== 'test') throw new Error('Simulated provider reasoning is restricted to isolated tests');
    if (!simulation && adapter.status?.liveEnabled !== true) throw new Error('Live Level 1 provider remains disabled');
    const candidates = JSON.parse(mission.candidates_json);
    const envelope = await adapter.reason({
      phase: 'select_task_b', missionId,
      taskA: { taskId: mission.task_a_id, sessionId: mission.task_a_session_id, eventId: mission.task_a_event_id, result: mission.task_a_result, resultHash: mission.task_a_result_hash },
      candidates
    });
    const decision = this.verifier.verify(envelope);
    const current = this._active(missionId);
    if (decision.phase !== 'select_task_b' || decision.missionId !== missionId || decision.taskAId !== current.task_a_id || decision.taskASessionId !== current.task_a_session_id || decision.taskAEventId !== current.task_a_event_id || decision.taskAResultHash !== current.task_a_result_hash || decision.taskBEventId !== null || decision.decision !== 'dispatch_task_b') throw new Error('Level 1 Task B decision is stale or cross-mission');
    if (decision.taskBId !== expectedTaskB || !candidates.some(candidate => candidate.taskId === decision.taskBId)) throw new Error('Provider selected a Task B inconsistent with Task A evidence');
    if (this.db.prepare('SELECT 1 FROM level1_decisions WHERE decision_id=? OR event_id=? OR response_id=? OR nonce=?').get(decision.decisionId, eventId, decision.responseId, decision.nonce)) throw new Error('Duplicate Level 1 provider decision');
    const taskB = candidates.find(candidate => candidate.taskId === decision.taskBId);
    this.db.prepare('INSERT INTO level1_decisions(decision_id,mission_id,phase,event_id,result_hash,task_b_id,response_id,nonce,expires_at,simulation,state) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(decision.decisionId, missionId, decision.phase, eventId, decision.taskAResultHash, taskB.taskId, decision.responseId, decision.nonce, decision.expiresAt, decision.simulation ? 1 : 0, 'validated');
    this.db.prepare("UPDATE level1_missions SET selected_task_b_id=? WHERE mission_id=? AND status='active' AND selected_task_b_id IS NULL")
      .run(taskB.taskId, missionId);
    if (!decision.simulation) this.acceptance.recordReasoningTurn(missionId, decision, { source: adapter.status?.mode || 'level1_provider_adapter' });
    const dispatchId = randomUUID();
    const action = { missionId, grantId: current.grant_id, taskId: taskB.taskId, decisionId: decision.decisionId, dispatchId, instructions: taskB.objective, capabilityProfile: LEVEL1_PROFILE_ID, readOnlyPaths: [...taskB.readPaths], simulation: decision.simulation };
    this.db.prepare('INSERT INTO level1_dispatches(dispatch_id,mission_id,decision_id,task_b_id,state,created_at) VALUES (?,?,?,?,?,?)').run(dispatchId, missionId, decision.decisionId, taskB.taskId, 'dispatching', this.now());
    try {
      const receipt = await this.dispatchTaskBCallback(action);
      if (!receipt || receipt.accepted !== true || receipt.taskId !== taskB.taskId || !UUID.test(receipt.sessionId || '')) throw new Error('Task B dispatcher returned an invalid receipt');
      this.db.prepare("UPDATE level1_dispatches SET state='dispatched',task_b_session_id=? WHERE dispatch_id=? AND state='dispatching'").run(receipt.sessionId, dispatchId);
      this.db.prepare("UPDATE level1_decisions SET state='dispatched' WHERE decision_id=? AND state='validated'").run(decision.decisionId);
      if (!decision.simulation) {
        this.acceptance.recordAutomaticDispatch(missionId, { dispatchId, taskId: taskB.taskId, decision });
        this.acceptance.recordPiTaskStarted(missionId, { taskId: taskB.taskId, sessionId: receipt.sessionId });
      }
      return { dispatchId, missionId, taskId: taskB.taskId, sessionId: receipt.sessionId, decisionId: decision.decisionId, simulation: decision.simulation };
    } catch (error) {
      this.db.prepare("UPDATE level1_dispatches SET state='needs_review' WHERE dispatch_id=?").run(dispatchId);
      this.db.prepare("UPDATE level1_decisions SET state='needs_review' WHERE decision_id=?").run(decision.decisionId);
      this.db.prepare("UPDATE level1_missions SET status='needs_review' WHERE mission_id=?").run(missionId);
      throw error;
    }
  }

  /**
   * The host dispatcher must call this immediately before creating Task B.
   * An internal-looking action object is not authority: it must correspond to
   * an unconsumed, non-simulation, verifier-authenticated provider decision.
   */
  authorizeTaskBDispatch(action) {
    const expectedKeys = ['capabilityProfile', 'decisionId', 'dispatchId', 'grantId', 'instructions', 'missionId', 'readOnlyPaths', 'simulation', 'taskId'];
    if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).sort().join(',') !== expectedKeys.sort().join(',') || action.capabilityProfile !== LEVEL1_PROFILE_ID || action.simulation !== false || !OPAQUE.test(action.missionId) || !OPAQUE.test(action.grantId) || !OPAQUE.test(action.taskId) || !UUID.test(action.decisionId) || !UUID.test(action.dispatchId)) {
      throw new Error('Level 1 Task B dispatch requires a real provider decision');
    }
    const mission = this._active(action.missionId);
    const definition = taskDefinition('task_b', action.taskId);
    if (mission.grant_id !== action.grantId || mission.selected_task_b_id !== action.taskId || action.instructions !== definition.objective || JSON.stringify(action.readOnlyPaths) !== JSON.stringify(definition.readOnlyPaths)) throw new Error('Level 1 Task B dispatch action is not bound to the selected task');
    const dispatch = this.db.prepare('SELECT * FROM level1_dispatches WHERE dispatch_id=?').get(action.dispatchId);
    const decision = this.db.prepare('SELECT * FROM level1_decisions WHERE decision_id=?').get(action.decisionId);
    if (!dispatch || !decision || dispatch.mission_id !== mission.mission_id || dispatch.decision_id !== decision.decision_id || dispatch.task_b_id !== action.taskId || dispatch.state !== 'dispatching' || decision.mission_id !== mission.mission_id || decision.phase !== 'select_task_b' || decision.task_b_id !== action.taskId || decision.simulation !== 0 || decision.state !== 'validated' || this.now() >= decision.expires_at) {
      throw new Error('Level 1 Task B dispatch requires an active verified provider decision');
    }
    return Object.freeze({ missionId: mission.mission_id, taskId: action.taskId, decisionId: decision.decision_id, dispatchId: dispatch.dispatch_id });
  }

  recordTaskBResult({ missionId, taskId, sessionId, eventId, result, authenticated = false, simulation = false }) {
    const mission = this._active(missionId);
    if (simulation && process.env.NODE_ENV !== 'test') throw new Error('Simulated Pi events are restricted to isolated tests');
    const dispatch = this.db.prepare('SELECT task_b_session_id,state FROM level1_dispatches WHERE mission_id=?').get(missionId);
    if (!dispatch || dispatch.state !== 'dispatched' || taskId !== mission.selected_task_b_id || sessionId !== dispatch.task_b_session_id || !authenticated || !UUID.test(eventId) || typeof result !== 'string' || !result.trim() || Buffer.byteLength(result) > 2048 || /[^\x00-\x7f]/.test(result)) throw new Error('Invalid or unauthenticated Level 1 Task B completion event');
    if (mission.task_b_event_id) throw new Error('Duplicate Task B completion event');
    const resultHash = hash(result);
    this.db.prepare('UPDATE level1_missions SET task_b_event_id=?,task_b_session_id=?,task_b_result=?,task_b_result_hash=? WHERE mission_id=? AND status=? AND task_b_event_id IS NULL')
      .run(eventId, sessionId, result, resultHash, missionId, 'active');
    if (!simulation) this.acceptance.recordPiCompletion(missionId, { taskId, sessionId, completionEventId: eventId, resultHash });

    return { missionId, taskId, sessionId, eventId, resultHash };
  }

  async completeMission(missionId, eventId, adapter) {
    const mission = this._active(missionId);
    if (!mission.task_b_event_id || eventId !== mission.task_b_event_id) throw new Error('Mission cannot complete before the selected Task B result');
    if (!this.verifier || !adapter || typeof adapter.reason !== 'function') throw new Error('Level 1 provider decision path is disabled');
    const simulation = adapter.status?.simulation === true;
    if (simulation && process.env.NODE_ENV !== 'test') throw new Error('Simulated provider reasoning is restricted to isolated tests');
    if (!simulation && adapter.status?.liveEnabled !== true) throw new Error('Live Level 1 provider remains disabled');
    const candidates = JSON.parse(mission.candidates_json);
    const taskB = candidates.find(candidate => candidate.taskId === mission.selected_task_b_id);
    const envelope = await adapter.reason({
      phase: 'complete_mission', missionId,
      taskA: { taskId: mission.task_a_id, sessionId: mission.task_a_session_id, eventId: mission.task_a_event_id, result: mission.task_a_result, resultHash: mission.task_a_result_hash },
      taskB: { taskId: mission.selected_task_b_id, sessionId: mission.task_b_session_id, eventId: mission.task_b_event_id, result: mission.task_b_result, resultHash: mission.task_b_result_hash, expectedProof: taskB.expectedProof }
    });
    const decision = this.verifier.verify(envelope);
    const current = this._active(missionId);
    if (decision.phase !== 'complete_mission' || decision.missionId !== missionId || decision.taskAId !== current.task_a_id || decision.taskASessionId !== current.task_a_session_id || decision.taskAEventId !== current.task_a_event_id || decision.taskAResultHash !== current.task_a_result_hash || decision.taskBId !== current.selected_task_b_id || decision.taskBSessionId !== current.task_b_session_id || decision.taskBEventId !== current.task_b_event_id || decision.taskBResultHash !== current.task_b_result_hash || !['complete', 'incomplete'].includes(decision.decision)) throw new Error('Level 1 completion decision is stale or cross-mission');
    if (this.db.prepare('SELECT 1 FROM level1_decisions WHERE decision_id=? OR event_id=? OR response_id=? OR nonce=?').get(decision.decisionId, eventId, decision.responseId, decision.nonce)) throw new Error('Duplicate Level 1 provider decision');
    this.db.prepare('INSERT INTO level1_decisions(decision_id,mission_id,phase,event_id,result_hash,task_b_id,response_id,nonce,expires_at,simulation,state) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(decision.decisionId, missionId, decision.phase, eventId, decision.taskBResultHash, decision.taskBId, decision.responseId, decision.nonce, decision.expiresAt, decision.simulation ? 1 : 0, decision.decision === 'complete' ? 'validated' : 'rejected');
    if (decision.decision !== 'complete' || !isExpectedTaskBResult(decision.taskBId, current.task_b_result)) {
      this.db.prepare("UPDATE level1_missions SET status='failed' WHERE mission_id=?").run(missionId);
      throw new Error('Level 1 Task B evidence did not satisfy the completion decision');
    }
    if (!decision.simulation) this.acceptance.recordReasoningTurn(missionId, decision, { source: adapter.status?.mode || 'level1_provider_adapter' });
    if (decision.simulation) {
      this.db.prepare("UPDATE level1_missions SET status='completed' WHERE mission_id=? AND status='active'").run(missionId);
      return { missionId, status: 'completed', simulation: true, acceptance: null };
    }
    const acceptance = this.acceptance.completeMission(missionId, decision);
    if (!acceptance.accepted) throw new Error('Level 1 acceptance recorder rejected mission completion');
    this.db.prepare("UPDATE level1_missions SET status='completed' WHERE mission_id=? AND status='active'").run(missionId);
    return { missionId, status: 'completed', simulation: false, acceptance };
  }

  cancel(missionId) {
    const mission = this._mission(missionId);
    if (['cancelled', 'completed', 'failed'].includes(mission.status)) return false;
    this.db.prepare("UPDATE level1_missions SET status='cancelled' WHERE mission_id=?").run(missionId);
    this.db.prepare("UPDATE level1_decisions SET state='revoked' WHERE mission_id=? AND state='validated'").run(missionId);
    if (this.acceptanceSnapshot(missionId)?.missionStatus === 'active') this.acceptance.cancel(missionId);
    return true;
  }

  fail(missionId) {
    const mission = this._mission(missionId);
    if (['completed', 'cancelled'].includes(mission.status)) return false;
    if (mission.status !== 'failed') this.db.prepare("UPDATE level1_missions SET status='failed' WHERE mission_id=?").run(missionId);
    this.db.prepare("UPDATE level1_decisions SET state='revoked' WHERE mission_id=? AND state IN ('validated','dispatched')").run(missionId);
    if (this.acceptanceSnapshot(missionId)?.missionStatus === 'active') this.acceptance.cancel(missionId);
    return true;
  }
}

module.exports = { Level1MissionFlow, hash };
