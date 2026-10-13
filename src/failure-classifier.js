'use strict';
// ADR 0051. Failure classification with an explicit recovery policy per category.
// Classification reads canonical host records only (runs, dispatches, verifications,
// leases). Worker prose never changes the category. Only VERIFICATION failures with a
// proven-terminated worker are eligible for bounded automatic repair.
const { createHash } = require('node:crypto');

const CATEGORIES = Object.freeze([
  'TRANSPORT', 'WORKER_START', 'WORKER_EXECUTION', 'WORKER_RESULT', 'VERIFICATION',
  'AUTHORITY', 'WORKSPACE', 'SCHEDULER', 'BUDGET', 'UNKNOWN',
]);

// policy: repair (bounded corrective Mission) | hold (owner inspects, no rerun) |
// quarantine (fail closed until reconciled) | owner (new authorization required) |
// reconnect (transport only; observe the same Mission).
const POLICY = Object.freeze({
  TRANSPORT: 'reconnect',
  WORKER_START: 'hold',
  WORKER_EXECUTION: 'hold',
  WORKER_RESULT: 'hold',
  VERIFICATION: 'repair',
  AUTHORITY: 'owner',
  WORKSPACE: 'hold',
  SCHEDULER: 'hold',
  BUDGET: 'hold',
  UNKNOWN: 'quarantine',
});

const START_CODES = /^(?:opencode|worker|cursor)_(?:spawn_failed|not_installed|auth_unavailable|executable_unavailable|sandbox_launch_failed)$/;
const RESULT_CODES = /^(?:opencode|worker|cursor)_(?:malformed_result|unsupported_output|missing_fields|incomplete_stream|output_overflow|result_schema)$/;
const EXECUTION_CODES = /^(?:opencode|worker|cursor)_(?:timeout|cancelled|execution_stopped|nonzero_exit|process_failed|web_request_bound)$/;
const UNCERTAIN_CODES = /^(?:opencode|worker|cursor|web)_(?:termination_unverified|apply_not_completed)$/;
const WORKSPACE_CODES = /^(?:opencode_workspace_changed|opencode_preimage_changed|dirty_outside_repair_scope|protected_baseline_changed|symlink_escape|workspace_changed)$/;
const AUTHORITY_CODES = /approval|authority|expired|revoked|scope mismatch|unqualified|not authorized|denied/i;

function latestRun(mission, store) {
  // Prefer the implementation run the latest verification judged; verifier runs are host
  // bookkeeping and must not masquerade as the worker execution being classified.
  const judged = store.db.prepare('SELECT run_id FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
  if (judged?.run_id) {
    const run = store.db.prepare('SELECT * FROM cp_runs WHERE id=?').get(judged.run_id);
    if (run) return run;
  }
  return store.db.prepare("SELECT * FROM cp_runs WHERE mission_id=? AND agent_id<>'host' ORDER BY created_at DESC LIMIT 1").get(mission.id)
    || store.db.prepare('SELECT * FROM cp_runs WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
}

function latestVerification(mission, store) {
  const row = store.db.prepare('SELECT * FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
  if (!row) return null;
  let checks = [];
  try { checks = JSON.parse(row.evidence || '[]'); } catch { checks = []; }
  return { ...row, checks: Array.isArray(checks) ? checks : [] };
}

function runCode(run) {
  if (!run) return null;
  if (typeof run.resolution === 'string' && run.resolution) return run.resolution;
  try {
    const result = typeof run.result === 'string' ? JSON.parse(run.result) : run.result;
    if (result && typeof result.error_class === 'string') return result.error_class;
  } catch { /* opaque */ }
  return null;
}

/**
 * Classify why a Mission is not progressing.
 * @returns {{category:string, policy:string, reason:string|null, evidence:object}}
 */
function classifyMission(mission, store) {
  const out = (category, reason = null, evidence = {}) => ({ category, policy: POLICY[category], reason, evidence: { ...evidence, authority: false } });
  if (!mission) return out('UNKNOWN', 'mission_missing');
  const db = store.db;
  const run = latestRun(mission, store);
  const code = runCode(run);
  const uncertainDispatch = db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state='unknown'").get(mission.id);
  const quarantined = db.prepare("SELECT 1 FROM cp_leases WHERE mission_id=? AND state='quarantined'").get(mission.id);
  if (uncertainDispatch || quarantined || (run && (run.process_state === 'unknown' || (run.termination_verified !== 1 && !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)))) || (code && UNCERTAIN_CODES.test(code))) {
    return out('UNKNOWN', 'uncertain_execution', { run_id: run?.id || null, code });
  }
  if (mission.state === 'blocked') {
    const reason = String(mission.reason || '');
    if (/budget/i.test(reason)) return out('BUDGET', 'budget_exhausted', { mission_reason_class: 'budget' });
    if (/lease|dispatch|claim|reconcil/i.test(reason)) return out('SCHEDULER', 'scheduler_block', { mission_reason_class: 'scheduler' });
    if (AUTHORITY_CODES.test(reason)) return out('AUTHORITY', 'authority_block', { mission_reason_class: 'authority' });
    if (code && WORKSPACE_CODES.test(code)) return out('WORKSPACE', code, { run_id: run.id });
    if (code && START_CODES.test(code)) return out('WORKER_START', code, { run_id: run.id });
    return out('AUTHORITY', 'blocked', { mission_reason_class: 'blocked' });
  }
  const verification = latestVerification(mission, store);
  if (mission.state === 'needs_rework') {
    if (verification && verification.result === 'failed' && verification.checks.some(c => c && c.status === 'failed')) {
      if (run && run.termination_verified === 1 && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)) {
        const failed = verification.checks.filter(c => c.status === 'failed').map(c => c.id);
        return out('VERIFICATION', null, { verification_id: verification.id, run_id: run.id, failed_checks: failed.slice(0, 12) });
      }
      return out('UNKNOWN', 'unverified_termination', { verification_id: verification.id, run_id: run?.id || null });
    }
    if (verification && verification.result === 'unavailable') return out('VERIFICATION', 'verifier_unavailable', { verification_id: verification.id, repairable: false });
    if (/continuity_unverified/i.test(String(mission.reason || ''))) return out('WORKER_RESULT', 'continuity_unverified', { run_id: run?.id || null });
    if (code && RESULT_CODES.test(code)) return out('WORKER_RESULT', code, { run_id: run.id });
    if (code && START_CODES.test(code)) return out('WORKER_START', code, { run_id: run.id });
    if (code && EXECUTION_CODES.test(code)) return out('WORKER_EXECUTION', code, { run_id: run.id });
    if (code && WORKSPACE_CODES.test(code)) return out('WORKSPACE', code, { run_id: run.id });
    if (run && run.state === 'failed') return out('WORKER_EXECUTION', code || 'worker_run_failed', { run_id: run.id });
    return out('WORKER_RESULT', 'no_host_verification_failure', { run_id: run?.id || null });
  }
  if (['running', 'dispatching', 'verifying'].includes(mission.state)) return out('SCHEDULER', 'in_progress', {});
  return out('UNKNOWN', 'not_failed', {});
}

/** Stable signature of a verification failure: failed check ids + exit codes. Never includes output text. */
function failureSignature(verification) {
  if (!verification) return null;
  const failed = (verification.checks || []).filter(c => c && c.status === 'failed')
    .map(c => [String(c.id), Number.isInteger(c.evidence?.exit_code) ? c.evidence.exit_code : '', c.evidence?.timed_out === true ? 'timeout' : ''].join(':'))
    .sort();
  if (!failed.length) return null;
  return createHash('sha256').update(failed.join('|')).digest('hex').slice(0, 24);
}

/**
 * Detect a repeated identical failure for a stage. Returns the current signature so the
 * caller can persist it in repair lineage. Repeated means: the failed Mission is itself a
 * corrective Mission and its failure signature equals the signature it was created to fix.
 */
function repeatedSignature(store, failed, autonomous, stageId) {
  const verification = latestVerification(failed, store);
  const signature = failureSignature(verification);
  const lineage = autonomous?.repair_lineage?.[stageId] || null;
  const history = autonomous?.repair_signatures?.[stageId] || [];
  const prior = lineage && lineage.repair_mission_id === failed.id ? (lineage.failure_signature || history[history.length - 1] || null) : null;
  const repeated = !!(signature && prior && signature === prior);
  return { signature, prior, repeated, history };
}

const POLICY_DESCRIPTIONS = Object.freeze({
  reconnect: 'Reconnect and observe the same Mission. Nothing is re-executed.',
  hold: 'Hold for owner inspection. Host evidence is retained; the worker is not rerun because effects or outputs are not a verification failure.',
  repair: 'One bounded corrective Mission may be created inside the original approved scope and repair budget.',
  owner: 'Stop. New owner authorization is required before any further execution.',
  quarantine: 'Fail closed. Effects or termination cannot be established; the workspace stays quarantined until reconciled.',
});

module.exports = { CATEGORIES, POLICY, POLICY_DESCRIPTIONS, classifyMission, failureSignature, repeatedSignature, latestVerification, latestRun };
