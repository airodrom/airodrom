'use strict';

const { createHash } = require('node:crypto');
const EXPECTED = Object.freeze({
  humanTurnsAfterAuthorization: 0,
  manualStatusChecks: 0,
  manualNextActions: 0,
  piTasks: 2,
  piCompletionEvents: 2,
  realReasoningTurns: 2,
  automaticNextTaskDispatches: 1,
  missionStatus: 'completed'
});

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const OPAQUE = /^[A-Za-z0-9_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function evaluateAcceptance(actual) {
  const fields = Object.keys(EXPECTED);
  const differences = fields.filter(key => actual?.[key] !== EXPECTED[key]).map(key => ({ field: key, expected: EXPECTED[key], actual: actual?.[key] ?? null }));
  return { accepted: differences.length === 0, expected: { ...EXPECTED }, actual: Object.fromEntries(fields.map(key => [key, actual?.[key] ?? null])), differences };
}

/** Host-side append-only acceptance evidence. This module is not exposed as a Pi capability. */
class Level1AcceptanceRecorder {
  constructor(db, { now = Date.now, verifier = null } = {}) {
    if (!db || typeof db.exec !== 'function') throw new Error('Level 1 acceptance journal database required');
    this.db = db; this.now = now; this.verifier = verifier;
    db.exec(`
      CREATE TABLE IF NOT EXISTS level1_acceptance_missions (
        mission_id TEXT PRIMARY KEY, authorized_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE IF NOT EXISTS level1_acceptance_events (
        mission_id TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL,
        source_id TEXT NOT NULL, created_at INTEGER NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(mission_id,event_id), UNIQUE(mission_id,type,source_id),
        FOREIGN KEY(mission_id) REFERENCES level1_acceptance_missions(mission_id)
      );
      CREATE INDEX IF NOT EXISTS level1_acceptance_type ON level1_acceptance_events(mission_id,type);
    `);
    const columns = new Set(db.prepare('PRAGMA table_info(level1_acceptance_events)').all().map(column => column.name));
    if (!columns.has('payload_json')) db.exec("ALTER TABLE level1_acceptance_events ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'");
  }

  authorize(missionId, authorizationId, at = this.now()) {
    if (!OPAQUE.test(missionId) || !OPAQUE.test(authorizationId) || !Number.isSafeInteger(at) || at <= 0) throw new Error('Invalid Level 1 authorization receipt');
    this.db.prepare('INSERT INTO level1_acceptance_missions(mission_id,authorized_at,status) VALUES (?,?,?)').run(missionId, at, 'active');
    return { missionId, authorizedAt: at };
  }

  _record(missionId, { eventId, type, source, sourceId, payload = {}, at = this.now() }) {
    const mission = this.db.prepare('SELECT authorized_at,status FROM level1_acceptance_missions WHERE mission_id=?').get(missionId);
    if (!mission || mission.status !== 'active') throw new Error('Level 1 acceptance mission is not active');
    if (!UUID.test(eventId) || typeof type !== 'string' || typeof source !== 'string' || !OPAQUE.test(sourceId) || !Number.isSafeInteger(at) || at < mission.authorized_at) throw new Error('Invalid Level 1 acceptance event');
    this.db.prepare('INSERT INTO level1_acceptance_events(mission_id,event_id,type,source,source_id,created_at,payload_hash,payload_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(missionId, eventId, type, source, sourceId, at, hash(JSON.stringify(payload)), JSON.stringify(payload));
  }

  recordHumanTurn(missionId, eventId, sourceId, at = this.now()) { this._record(missionId, { eventId, type: 'human_turn', source: 'operator', sourceId, at }); }
  recordManualStatusCheck(missionId, eventId, sourceId, at = this.now()) { this._record(missionId, { eventId, type: 'manual_status_check', source: 'operator', sourceId, at }); }
  recordManualNextAction(missionId, eventId, sourceId, at = this.now()) { this._record(missionId, { eventId, type: 'manual_next_action', source: 'operator', sourceId, at }); }

  recordPiTaskStarted(missionId, { taskId, sessionId, at = this.now() }) {
    if (!OPAQUE.test(taskId) || !UUID.test(sessionId)) throw new Error('Invalid Pi task start evidence');
    this._record(missionId, { eventId: cryptoId(), type: 'pi_task_started', source: 'bridge', sourceId: taskId, payload: { sessionId }, at });
  }

  recordPiCompletion(missionId, { taskId, sessionId, completionEventId, resultHash, at = this.now() }) {
    if (!OPAQUE.test(taskId) || !UUID.test(sessionId) || !UUID.test(completionEventId) || !/^[a-f0-9]{64}$/.test(resultHash)) throw new Error('Invalid Pi completion evidence');
    const started = this.db.prepare("SELECT payload_json FROM level1_acceptance_events WHERE mission_id=? AND type='pi_task_started' AND source_id=?").get(missionId, taskId);
    if (!started || JSON.parse(started.payload_json).sessionId !== sessionId) throw new Error('Pi completion does not match a recorded task/session start');
    this._record(missionId, { eventId: completionEventId, type: 'pi_completion', source: 'bridge', sourceId: taskId, payload: { sessionId, resultHash }, at });
  }

  recordReasoningTurn(missionId, decision, { source = 'level1_provider_adapter', at = this.now() } = {}) {
    if (!this.verifier?.isVerified?.(decision) || decision.simulation === true || decision.authenticated !== true || !OPAQUE.test(decision.responseId || '') || !['select_task_b', 'complete_mission'].includes(decision.phase)) throw new Error('Only a verifier-authenticated live provider response can count as a real reasoning turn');
    if (typeof source !== 'string' || !OPAQUE.test(source)) throw new Error('Invalid Level 1 reasoning provider evidence source');
    const resultHash = decision.phase === 'select_task_b' ? decision.taskAResultHash : decision.taskBResultHash;
    if (!/^[a-f0-9]{64}$/.test(resultHash || '')) throw new Error('Verified provider response is not bound to a result hash');
    this._record(missionId, { eventId: cryptoId(), type: 'real_reasoning_turn', source, sourceId: decision.responseId, payload: { phase: decision.phase, resultHash }, at });
  }

  recordAutomaticDispatch(missionId, { dispatchId, taskId, decision, at = this.now() }) {
    if (!this.verifier?.isVerified?.(decision) || decision.simulation === true || decision.phase !== 'select_task_b' || decision.decision !== 'dispatch_task_b' || decision.taskBId !== taskId || !OPAQUE.test(dispatchId) || !OPAQUE.test(taskId)) throw new Error('Only an automatic dispatch of a verifier-authenticated decision counts');
    this._record(missionId, { eventId: cryptoId(), type: 'automatic_next_task_dispatch', source: 'level1_coordinator', sourceId: decision.decisionId, payload: { dispatchId, taskId }, at });
  }

  completeMission(missionId, decision, at = this.now()) {
    if (!this.verifier?.isVerified?.(decision) || decision.simulation === true || decision.phase !== 'complete_mission' || decision.decision !== 'complete' || !OPAQUE.test(decision.decisionId || '') || !OPAQUE.test(decision.responseId || '')) throw new Error('Mission completion requires a verifier-authenticated live provider completion decision');
    const current = this.snapshot(missionId);
    if (current.piTasks !== 2 || current.realReasoningTurns !== 2 || current.piCompletionEvents !== 2 || current.automaticNextTaskDispatches !== 1 || current.humanTurnsAfterAuthorization || current.manualStatusChecks || current.manualNextActions) throw new Error('Level 1 acceptance evidence is incomplete or contains manual activity');
    if (!this.db.prepare("SELECT 1 FROM level1_acceptance_events WHERE mission_id=? AND type='real_reasoning_turn' AND source_id=?").get(missionId, decision.responseId)) throw new Error('Mission completion response was not recorded as a real reasoning turn');
    this._record(missionId, { eventId: cryptoId(), type: 'mission_status', source: 'level1_coordinator', sourceId: decision.decisionId, payload: { status: 'completed', providerCompletionResponseId: decision.responseId }, at });
    this.db.prepare("UPDATE level1_acceptance_missions SET status='completed' WHERE mission_id=? AND status='active'").run(missionId);
    return this.evaluate(missionId);
  }

  cancel(missionId) {
    const result = this.db.prepare("UPDATE level1_acceptance_missions SET status='cancelled' WHERE mission_id=? AND status='active'").run(missionId);
    return result.changes === 1;
  }

  snapshot(missionId) {
    const mission = this.db.prepare('SELECT authorized_at,status FROM level1_acceptance_missions WHERE mission_id=?').get(missionId);
    if (!mission) throw new Error('Level 1 acceptance mission not found');
    const rows = this.db.prepare('SELECT type,source_id FROM level1_acceptance_events WHERE mission_id=?').all(missionId);
    const count = type => rows.filter(row => row.type === type).length;
    const taskCount = type => new Set(rows.filter(row => row.type === type).map(row => row.source_id)).size;
    return {
      humanTurnsAfterAuthorization: count('human_turn'),
      manualStatusChecks: count('manual_status_check'),
      manualNextActions: count('manual_next_action'),
      piTasks: taskCount('pi_task_started'),
      piCompletionEvents: count('pi_completion'),
      realReasoningTurns: count('real_reasoning_turn'),
      automaticNextTaskDispatches: count('automatic_next_task_dispatch'),
      missionStatus: mission.status
    };
  }

  evaluate(missionId) { return evaluateAcceptance(this.snapshot(missionId)); }
}

function cryptoId() { return require('node:crypto').randomUUID(); }

module.exports = { Level1AcceptanceRecorder, evaluateAcceptance, EXPECTED };
