'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { DecisionCallbackVerifier, ProviderDecisionAdapter } = require('./mission-provider');

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nowValue = value => Number.isSafeInteger(value) && value > 0;

/** Durable local decision gate. There is intentionally no provider adapter here. */
class MissionCoordinator {
  constructor(db, { now = Date.now, provider = null, callbackVerifier = null, dispatchTaskB = null } = {}) {
    if (!db || typeof db.exec !== 'function') throw new Error('Mission journal database required');
    if (callbackVerifier !== null && !(callbackVerifier instanceof DecisionCallbackVerifier)) throw new Error('Unsupported provider callback verifier');
    this.db = db; this.now = now; this.provider = provider; this.callbackVerifier = callbackVerifier; this.dispatchTaskB = dispatchTaskB;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_missions (
        mission_id TEXT PRIMARY KEY, task_a_id TEXT NOT NULL, task_b_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
        cancelled_at INTEGER, latest_event_id TEXT
      );
      CREATE TABLE IF NOT EXISTS autonomy_events (
        event_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, task_id TEXT NOT NULL,
        session_id TEXT NOT NULL, result TEXT NOT NULL, result_hash TEXT NOT NULL,
        received_at INTEGER NOT NULL, FOREIGN KEY(mission_id) REFERENCES autonomy_missions(mission_id)
      );
      CREATE TABLE IF NOT EXISTS autonomy_decisions (
        decision_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
        result_hash TEXT NOT NULL, task_b_instructions TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, state TEXT NOT NULL, simulation INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(event_id) REFERENCES autonomy_events(event_id)
      );
      CREATE TABLE IF NOT EXISTS autonomy_outbox (
        action_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, decision_id TEXT NOT NULL UNIQUE,
        task_b_id TEXT NOT NULL, instructions TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, dispatched_at INTEGER,
        FOREIGN KEY(decision_id) REFERENCES autonomy_decisions(decision_id)
      );
      CREATE INDEX IF NOT EXISTS autonomy_events_mission ON autonomy_events(mission_id, received_at);
    `);
    const decisionColumns = new Set(this.db.prepare('PRAGMA table_info(autonomy_decisions)').all().map(row => row.name));
    if (!decisionColumns.has('simulation')) this.db.exec('ALTER TABLE autonomy_decisions ADD COLUMN simulation INTEGER NOT NULL DEFAULT 0');
  }

  register({ missionId, taskAId, taskBId, expiresAt }) {
    if (![missionId, taskAId, taskBId].every(value => typeof value === 'string' && value.length >= 8 && value.length <= 128) || taskAId === taskBId || !nowValue(expiresAt) || expiresAt <= this.now()) throw new Error('Invalid autonomy mission');
    this.db.prepare('INSERT INTO autonomy_missions(mission_id,task_a_id,task_b_id,expires_at,state,created_at) VALUES (?,?,?,?,?,?)').run(missionId, taskAId, taskBId, expiresAt, 'active', this.now());
    return this.getMission(missionId);
  }

  getMission(missionId) { return this.db.prepare('SELECT * FROM autonomy_missions WHERE mission_id=?').get(missionId) || null; }

  _active(missionId) {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error('Mission not found');
    if (mission.state !== 'active') throw new Error('Mission is cancelled or inactive');
    if (this.now() >= mission.expires_at) throw new Error('Mission expired');
    return mission;
  }

  /** Called only by the trusted local bridge after it correlates a settled Task A. */
  receiveTaskAResult({ missionId, taskId, sessionId, eventId, result, authenticated = false }) {
    if (authenticated !== true) throw new Error('Authenticated bridge event required');
    const mission = this._active(missionId);
    if (taskId !== mission.task_a_id) throw new Error('Cross-mission or non-Task-A event');
    if (![sessionId, eventId].every(value => typeof value === 'string' && value.length >= 8 && value.length <= 128) || typeof result !== 'string' || !result.trim() || result.length > 24_000) throw new Error('Invalid Task A result');
    const resultHash = hash(result);
    const old = this.db.prepare('SELECT mission_id,task_id,session_id,result_hash FROM autonomy_events WHERE event_id=?').get(eventId);
    if (old) throw new Error('Duplicate Task A event');
    this.db.prepare('INSERT INTO autonomy_events(event_id,mission_id,task_id,session_id,result,result_hash,received_at) VALUES (?,?,?,?,?,?,?)').run(eventId, missionId, taskId, sessionId, result, resultHash, this.now());
    this.db.prepare('UPDATE autonomy_missions SET latest_event_id=? WHERE mission_id=?').run(eventId, missionId);
    return { eventId, missionId, taskId, sessionId, result, resultHash };
  }

  async decide(eventId) {
    if (!this.provider || this.provider.kind !== 'fixture' || typeof this.provider.decide !== 'function') throw new Error('Reasoning provider disabled; only a labeled fixture adapter is accepted here');
    if (process.env.NODE_ENV !== 'test') throw new Error('Fixture provider decisions are restricted to isolated test runs');
    const event = this.db.prepare('SELECT * FROM autonomy_events WHERE event_id=?').get(eventId);
    if (!event) throw new Error('Task A event not found');
    const mission = this._active(event.mission_id);
    if (mission.latest_event_id !== event.event_id) throw new Error('Stale Task A event');
    const existing = this.db.prepare('SELECT decision_id FROM autonomy_decisions WHERE event_id=?').get(eventId);
    if (existing) throw new Error('Duplicate mission decision');
    const answer = await this.provider.decide({
      simulation: true,
      mission: { missionId: mission.mission_id, taskBId: mission.task_b_id },
      taskA: { eventId: event.event_id, taskId: event.task_id, sessionId: event.session_id, result: event.result, resultHash: event.result_hash }
    });
    if (!object(answer) || answer.simulation !== true || answer.missionId !== mission.mission_id || answer.eventId !== event.event_id || answer.resultHash !== event.result_hash || answer.taskBId !== mission.task_b_id || typeof answer.instructions !== 'string' || !answer.instructions.trim() || answer.instructions.length > 4000) throw new Error('Provider decision is not bound to the current Task A result');
    this._active(mission.mission_id);
    if (this.getMission(mission.mission_id).latest_event_id !== event.event_id) throw new Error('Task A event became stale during reasoning');
    return this._storeDecision(mission, event, answer, { simulation: true });
  }

  _storeDecision(mission, event, answer, { simulation, expiresAt = this.now() + 30_000 } = {}) {
    this._active(mission.mission_id);
    if (this.getMission(mission.mission_id).latest_event_id !== event.event_id) throw new Error('Task A event became stale during decision validation');
    if (answer.missionId !== mission.mission_id || answer.eventId !== event.event_id || answer.resultHash !== event.result_hash || answer.taskBId !== mission.task_b_id || typeof answer.instructions !== 'string' || !answer.instructions.trim() || answer.instructions.length > 4000) throw new Error('Decision is not bound to the current Task A result');
    const decisionId = answer.decisionId || randomUUID();
    if (typeof decisionId !== 'string' || decisionId.length < 8 || decisionId.length > 128 || this.db.prepare('SELECT 1 FROM autonomy_decisions WHERE decision_id=?').get(decisionId) || this.db.prepare('SELECT 1 FROM autonomy_decisions WHERE event_id=?').get(event.event_id)) throw new Error('Duplicate or invalid mission decision');
    const boundedExpiry = Math.min(mission.expires_at, expiresAt, this.now() + 30_000);
    if (boundedExpiry <= this.now()) throw new Error('Mission decision expired');
    this.db.prepare('INSERT INTO autonomy_decisions(decision_id,mission_id,event_id,result_hash,task_b_instructions,created_at,expires_at,state,simulation) VALUES (?,?,?,?,?,?,?,?,?)').run(decisionId, mission.mission_id, event.event_id, event.result_hash, answer.instructions, this.now(), boundedExpiry, 'validated', simulation ? 1 : 0);
    return { decisionId, missionId: mission.mission_id, eventId: event.event_id, resultHash: event.result_hash, taskBId: mission.task_b_id, expiresAt: boundedExpiry, state: 'validated', simulation };
  }

  acceptProviderCallback(envelope) {
    if (!this.callbackVerifier) throw new Error('Live provider callback validation is disabled');
    const callback = this.callbackVerifier.verify(envelope);
    const event = this.db.prepare('SELECT * FROM autonomy_events WHERE event_id=?').get(callback.eventId);
    if (!event) throw new Error('Provider callback references an unknown Task A event');
    const mission = this._active(callback.missionId);
    if (mission.latest_event_id !== event.event_id || event.mission_id !== mission.mission_id || callback.taskAId !== event.task_id || callback.sessionId !== event.session_id || callback.resultHash !== event.result_hash || callback.taskBId !== mission.task_b_id) throw new Error('Provider callback is stale or cross-mission');
    return this._storeDecision(mission, event, {
      missionId: callback.missionId, eventId: callback.eventId, resultHash: callback.resultHash,
      taskBId: callback.taskBId, decisionId: callback.decisionId, instructions: callback.instructions
    }, { simulation: false, expiresAt: callback.expiresAt });
  }

  /**
   * Adapter seam for an authenticated provider round trip. It returns a
   * validated decision only; Task B remains undispatched until dispatch().
   */
  async requestProviderDecision(adapter, eventId) {
    if (!(adapter instanceof ProviderDecisionAdapter) || !adapter.status.requestEnabled || adapter.verifier !== this.callbackVerifier) throw new Error('Provider decision adapter is disabled or not bound to this callback verifier');
    const event = this.db.prepare('SELECT * FROM autonomy_events WHERE event_id=?').get(eventId);
    if (!event) throw new Error('Task A event not found');
    const mission = this._active(event.mission_id);
    if (mission.latest_event_id !== event.event_id) throw new Error('Stale Task A event');
    const request = adapter.buildRequest({ mission: { missionId: mission.mission_id, taskBId: mission.task_b_id }, event: { eventId: event.event_id, taskId: event.task_id, sessionId: event.session_id, result: event.result, resultHash: event.result_hash } });
    const envelope = await adapter.requestDecision(request);
    this._active(mission.mission_id);
    if (this.getMission(mission.mission_id).latest_event_id !== event.event_id) throw new Error('Task A event became stale during provider reasoning');
    const callback = this.callbackVerifier.verify(envelope);
    return this._storeDecision(mission, event, {
      missionId: callback.missionId, eventId: callback.eventId, resultHash: callback.resultHash,
      taskBId: callback.taskBId, decisionId: callback.decisionId, instructions: callback.instructions
    }, { simulation: adapter.status.simulation, expiresAt: callback.expiresAt });
  }

  async dispatch(decisionId) {
    if (typeof this.dispatchTaskB !== 'function') throw new Error('Task dispatcher disabled');
    const decision = this.db.prepare('SELECT * FROM autonomy_decisions WHERE decision_id=?').get(decisionId);
    if (!decision) throw new Error('Validated mission decision not found');
    const mission = this._active(decision.mission_id);
    const event = this.db.prepare('SELECT * FROM autonomy_events WHERE event_id=?').get(decision.event_id);
    if (!event || mission.latest_event_id !== event.event_id || event.result_hash !== decision.result_hash) throw new Error('Stale mission decision');
    if (this.now() >= decision.expires_at) throw new Error('Mission decision expired');
    if (decision.state !== 'validated') throw new Error('Mission decision is duplicate or already consumed');
    const actionId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Recheck every time-sensitive binding while holding the journal write lock.
      // A cancellation, newer Task A result, or expiry between the outer read and
      // this transaction must revoke dispatch too.
      const current = this.db.prepare('SELECT * FROM autonomy_decisions WHERE decision_id=?').get(decisionId);
      const currentMission = this.getMission(decision.mission_id);
      const currentEvent = this.db.prepare('SELECT * FROM autonomy_events WHERE event_id=?').get(decision.event_id);
      if (!current || current.state !== 'validated') throw new Error('Mission decision is duplicate or already consumed');
      if (!currentMission || currentMission.state !== 'active' || this.now() >= currentMission.expires_at) throw new Error('Mission is cancelled or expired');
      if (this.now() >= current.expires_at) throw new Error('Mission decision expired');
      if (!currentEvent || currentEvent.mission_id !== currentMission.mission_id || currentMission.latest_event_id !== currentEvent.event_id || current.result_hash !== currentEvent.result_hash) throw new Error('Cross-mission or stale Task B decision');
      this.db.prepare('UPDATE autonomy_decisions SET state=? WHERE decision_id=? AND state=?').run('dispatching', decisionId, 'validated');
      this.db.prepare('INSERT INTO autonomy_outbox(action_id,mission_id,decision_id,task_b_id,instructions,state,created_at) VALUES (?,?,?,?,?,?,?)').run(actionId, mission.mission_id, decisionId, mission.task_b_id, decision.task_b_instructions, 'dispatching', this.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const action = { actionId, missionId: mission.mission_id, decisionId, taskId: mission.task_b_id, instructions: decision.task_b_instructions, simulation: decision.simulation === 1 };
    try {
      const receipt = await this.dispatchTaskB(action);
      this.db.prepare('UPDATE autonomy_outbox SET state=?,dispatched_at=? WHERE action_id=? AND state=?').run('dispatched', this.now(), actionId, 'dispatching');
      this.db.prepare('UPDATE autonomy_decisions SET state=? WHERE decision_id=? AND state=?').run('dispatched', decisionId, 'dispatching');
      return { ...action, receipt };
    } catch (error) {
      // An uncertain dispatch is deliberately not replayed automatically.
      this.db.prepare('UPDATE autonomy_outbox SET state=? WHERE action_id=?').run('needs_review', actionId);
      this.db.prepare('UPDATE autonomy_decisions SET state=? WHERE decision_id=?').run('needs_review', decisionId);
      throw error;
    }
  }

  cancel(missionId) {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error('Mission not found');
    if (mission.state === 'cancelled') return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE autonomy_missions SET state=?,cancelled_at=? WHERE mission_id=? AND state=?').run('cancelled', this.now(), missionId, 'active');
      this.db.prepare("UPDATE autonomy_decisions SET state='revoked' WHERE mission_id=? AND state='validated'").run(missionId);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

module.exports = { MissionCoordinator, hash };
