'use strict';
// Unified Autonomous Development V1: one derived recovery-phase projection.
// Phases are computed from canonical Mission states plus the Goal Plan's
// autonomous record. Nothing here is persisted as a second state machine and
// nothing here grants authority, Acceptance or Production mutation.

const PHASES = Object.freeze([
  'INITIAL_EXECUTION', 'INITIAL_VERIFICATION', 'VERIFICATION_FAILED', 'REPAIR_ELIGIBILITY_CHECK',
  'REPAIR_PENDING', 'REPAIR_CREATING', 'REPAIR_DISPATCHED', 'REPAIR_RUNNING', 'REPAIR_VERIFYING',
  'REPAIR_VERIFIED', 'REPAIR_BLOCKED', 'MISSION_VERIFIED', 'AWAITING_ACCEPTANCE', 'FAILED_TERMINAL',
  'CANCELLED', 'QUARANTINED', 'WAITING_OWNER',
]);

// Phases in which Terminal/MCP observers must keep following the same request identity.
const OBSERVING = new Set([
  'INITIAL_EXECUTION', 'INITIAL_VERIFICATION', 'VERIFICATION_FAILED', 'REPAIR_ELIGIBILITY_CHECK',
  'REPAIR_PENDING', 'REPAIR_CREATING', 'REPAIR_DISPATCHED', 'REPAIR_RUNNING', 'REPAIR_VERIFYING',
]);

// Block reasons that can clear on a later scheduler tick without owner action.
const TRANSIENT_REASONS = new Set([
  'workspace_writer', 'unreconciled_dispatch', 'run_not_terminal', 'missing_run',
  'repair_mission_name_conflict', 'repair_spawn_failed', 'admission_closed',
]);

// Reasons that mean the Mission can never be repaired automatically from here.
const PERMANENT_REASONS = new Set([
  'repair_budget', 'budget_expired', 'dispatch_budget', 'not_enabled', 'privacy_not_local',
  'worker_not_authorized', 'unsupported_kind', 'repair_scope_mismatch', 'dirty_outside_repair_scope',
  'no_host_verification_failure', 'repair_pending_timeout', 'approval_unavailable', 'approval_expired',
  'approval_revoked', 'external_disclosure_unauthorized', 'repeated_failure_signature', 'risk_policy_no_retry',
  'not_needs_rework', 'repair_already_spawned', 'failure_not_repairable',
]);

const QUARANTINE_REASONS = new Set(['unverified_termination', 'quarantined_lease', 'uncertain_execution']);

const EXPLANATIONS = Object.freeze({
  repair_budget: 'the authorized automatic repair budget is used up',
  budget_expired: 'the authorized time window for this Goal has expired',
  dispatch_budget: 'the authorized dispatch budget is used up',
  not_enabled: 'autonomous execution is paused or stopped for this Goal',
  privacy_not_local: 'the Mission is not restricted to local processing, which automatic repair requires',
  worker_not_authorized: 'the Mission\'s worker is not on the authorized worker list',
  unsupported_kind: 'this kind of Mission does not support automatic repair',
  repair_scope_mismatch: 'the corrective Mission would have left the approved scope',
  dirty_outside_repair_scope: 'the approved workspace now contains changes outside the approved files',
  no_host_verification_failure: 'the worker stopped without an independent verification result to repair against',
  repair_pending_timeout: 'the workspace never became safe to repair within the allowed waiting time',
  approval_unavailable: 'no valid owner approval covers a corrective Mission',
  approval_expired: 'the owner approval expired before the corrective Mission could start',
  approval_revoked: 'the owner approval was revoked',
  external_disclosure_unauthorized: 'the Mission would disclose workspace content to an external model without authorization',
  repeated_failure_signature: 'the same verification failure repeated without progress',
  risk_policy_no_retry: 'the Mission\'s risk class does not permit automatic retries',
  failure_not_repairable: 'the failure category is not one automatic repair may act on',
  workspace_writer: 'another writer still holds the approved workspace',
  unreconciled_dispatch: 'a previous dispatch has not been reconciled yet',
  run_not_terminal: 'the previous worker run has not finished',
  missing_run: 'no worker run was recorded for the failed attempt',
  repair_mission_name_conflict: 'a corrective Mission name collided and will be retried',
  repair_spawn_failed: 'the corrective Mission could not be created',
  unverified_termination: 'the previous worker process could not be proven to have stopped',
  quarantined_lease: 'the workspace is quarantined after an uncertain execution',
  uncertain_execution: 'prior effects or termination cannot be established',
  repair_already_spawned: 'one corrective Mission already exists for this step',
  not_needs_rework: 'the Mission is not in a repairable failed state',
  admission_closed: 'the service is closed for maintenance',
  blocked: 'the Mission was blocked by host policy',
});

// Only codes from the fixed vocabulary may ever appear in owner-facing text.
const KNOWN_CODES = new Set(Object.keys(EXPLANATIONS));

function classifyReason(reason) {
  const raw = typeof reason === 'string' && reason ? reason.split(':')[0] : 'blocked';
  const code = KNOWN_CODES.has(raw) ? raw : 'blocked';
  if (QUARANTINE_REASONS.has(code)) return { code, kind: 'quarantine', terminal: true, raw };
  if (TRANSIENT_REASONS.has(code)) return { code, kind: 'transient', terminal: false, raw };
  return { code, kind: 'permanent', terminal: true, raw };
}

function explainReason(reason) {
  const { code } = classifyReason(reason);
  const detail = typeof reason === 'string' && reason.includes(':') ? reason.split(':').slice(1).join(':') : '';
  const base = EXPLANATIONS[code] || 'a host policy stopped automatic repair';
  return base + (detail && KNOWN_CODES.has(detail) ? ' (' + detail.replaceAll('_', ' ') + ')' : '');
}

/**
 * Owner-facing sentence for a terminal or pending block. Never includes secrets:
 * only reason codes from the fixed vocabulary above are interpolated.
 */
function blockerMessage(reason, { repaired = false } = {}) {
  const { code, kind } = classifyReason(reason);
  const why = explainReason(reason);
  if (kind === 'quarantine') {
    return 'Automatic repair is on hold because ' + why + ' (' + code + '). The workspace is quarantined until an operator reconciles it. No additional changes were made.';
  }
  if (kind === 'transient') {
    return 'Automatic repair is waiting because ' + why + ' (' + code + '). Airodrom keeps observing the same task.';
  }
  const prefix = repaired ? 'The corrective attempt did not pass and automatic repair stopped because ' : 'Automatic repair could not start because ';
  return prefix + why + ' (' + code + '). No additional changes were made. Independent verification did not pass.';
}

function repairMissionPhase(state) {
  switch (state) {
    case 'ready':
    case 'dispatching': return 'REPAIR_DISPATCHED';
    case 'running':
    case 'waiting_for_operator': return 'REPAIR_RUNNING';
    case 'verifying': return 'REPAIR_VERIFYING';
    case 'awaiting_acceptance': return 'REPAIR_VERIFIED';
    case 'completed': return 'MISSION_VERIFIED';
    case 'cancelled': return 'CANCELLED';
    default: return null;
  }
}

/**
 * Derive the recovery phase for one Goal stage.
 * @param {object} input
 * @param {object} input.mission canonical Mission currently bound to the stage (parent or repair)
 * @param {object} input.autonomous Goal Plan autonomous record
 * @param {string} input.stageId
 * @param {object|null} [input.repair] corrective Mission when lineage names one and it differs from `mission`
 * @param {boolean} [input.quarantined] durable quarantine evidence (lease/run) for the stage Mission
 */
function stagePhase({ mission, autonomous = {}, stageId, repair = null, quarantined = false }) {
  const lineage = autonomous.repair_lineage?.[stageId] || null;
  const blocked = autonomous.repair_blocked?.[stageId] || null;
  const pending = autonomous.repair_pending?.[stageId] || null;
  const reservation = autonomous.repair_reservations?.[stageId] || null;
  const isRepair = !!(mission?.envelope?.repair_of) || (lineage && lineage.repair_mission_id === mission?.id);
  const enabled = autonomous.enabled === true && autonomous.paused !== true;
  const result = (phase, extra = {}) => ({
    phase,
    observing: OBSERVING.has(phase),
    terminal: !OBSERVING.has(phase),
    repaired: isRepair || !!lineage?.repair_mission_id,
    reason: null,
    message: null,
    ...extra,
  });
  if (!mission) return result('WAITING_OWNER', { reason: 'bounded_mission_required' });
  if (quarantined) return result('QUARANTINED', { reason: 'uncertain_execution', message: blockerMessage('uncertain_execution') });
  const state = mission.state;
  if (state === 'cancelled') return result('CANCELLED');
  if (state === 'completed') return result('MISSION_VERIFIED');
  if (state === 'awaiting_acceptance') return result(isRepair ? 'REPAIR_VERIFIED' : 'AWAITING_ACCEPTANCE');
  if (state === 'blocked') {
    const reason = mission.reason && /^[a-z_]+$/.test(mission.reason) ? mission.reason : 'blocked';
    const cls = classifyReason(reason);
    if (cls.kind === 'quarantine') return result('QUARANTINED', { reason, message: blockerMessage(reason) });
    return result('FAILED_TERMINAL', { reason, message: blockerMessage(reason, { repaired: isRepair }) });
  }
  // A corrective Mission named by lineage drives the stage once it exists.
  if (repair && repair.id !== mission.id) {
    const nested = stagePhase({ mission: repair, autonomous, stageId, quarantined });
    return { ...nested, repaired: true };
  }
  if (isRepair) {
    const phase = repairMissionPhase(state);
    if (phase) return result(phase);
    if (state === 'needs_rework') {
      if (blocked) {
        const cls = classifyReason(blocked);
        if (cls.kind === 'quarantine') return result('QUARANTINED', { reason: blocked, message: blockerMessage(blocked) });
        if (cls.kind === 'transient') return result('REPAIR_PENDING', { reason: blocked, message: blockerMessage(blocked) });
        return result('REPAIR_BLOCKED', { reason: blocked, message: blockerMessage(blocked, { repaired: true }) });
      }
      const repairs = autonomous.repair_counts?.[stageId] || 0;
      if (!enabled || !Number.isSafeInteger(autonomous.max_repairs) || repairs >= autonomous.max_repairs) {
        const reason = enabled ? 'repair_budget' : 'not_enabled';
        return result('REPAIR_BLOCKED', { reason, message: blockerMessage(reason, { repaired: true }) });
      }
      return result('REPAIR_ELIGIBILITY_CHECK');
    }
  }
  if (['ready', 'dispatching', 'running', 'waiting_for_operator'].includes(state)) return result('INITIAL_EXECUTION');
  if (state === 'verifying') return result('INITIAL_VERIFICATION');
  if (state === 'needs_rework') {
    if (lineage?.repair_mission_id && lineage.repair_mission_id !== mission.id) {
      // Lineage exists but the caller did not resolve the repair Mission; report dispatch pending.
      return result('REPAIR_DISPATCHED');
    }
    if (blocked) {
      const cls = classifyReason(blocked);
      if (cls.kind === 'quarantine') return result('QUARANTINED', { reason: blocked, message: blockerMessage(blocked) });
      if (cls.kind === 'transient') return result('REPAIR_PENDING', { reason: blocked, message: blockerMessage(blocked) });
      return result('REPAIR_BLOCKED', { reason: blocked, message: blockerMessage(blocked) });
    }
    if (reservation && !reservation.repair_mission_id) return result('REPAIR_CREATING');
    if (pending) return result('REPAIR_PENDING', { reason: pending.reason || null, message: pending.reason ? blockerMessage(pending.reason) : null });
    if (!enabled) {
      return result('WAITING_OWNER', { reason: 'not_enabled', message: 'Independent verification did not pass. Automatic repair is not authorized for this task, so the owner must decide the next step. No additional changes were made.' });
    }
    const repairs = autonomous.repair_counts?.[stageId] || 0;
    if (Number.isSafeInteger(autonomous.max_repairs) && repairs >= autonomous.max_repairs) {
      return result('REPAIR_BLOCKED', { reason: 'repair_budget', message: blockerMessage('repair_budget') });
    }
    return result('REPAIR_ELIGIBILITY_CHECK');
  }
  return result('WAITING_OWNER', { reason: state });
}

function presentationFor(phase, { files = [] } = {}) {
  switch (phase) {
    case 'INITIAL_EXECUTION': return 'Working';
    case 'INITIAL_VERIFICATION': return 'Verification underway';
    case 'VERIFICATION_FAILED':
    case 'REPAIR_ELIGIBILITY_CHECK': return 'Verification failed; preparing automatic repair';
    case 'REPAIR_PENDING': return 'Verification failed; waiting for a safe moment to repair';
    case 'REPAIR_CREATING': return 'Verification failed; creating the corrective task';
    case 'REPAIR_DISPATCHED':
    case 'REPAIR_RUNNING': return 'Repairing failed verification';
    case 'REPAIR_VERIFYING': return 'Repair verification underway';
    case 'REPAIR_VERIFIED': return 'Repair completed. Verification passed';
    case 'MISSION_VERIFIED':
    case 'AWAITING_ACCEPTANCE': return 'Completed and verified';
    case 'REPAIR_BLOCKED': return 'Automatic repair blocked';
    case 'FAILED_TERMINAL': return 'Stopped safely';
    case 'CANCELLED': return 'Cancelled';
    case 'QUARANTINED': return 'On hold: uncertain execution';
    case 'WAITING_OWNER': return 'Waiting for owner decision';
    default: return files.length ? 'Working on ' + files.join(', ') : 'Working';
  }
}

module.exports = {
  PHASES, OBSERVING, TRANSIENT_REASONS, PERMANENT_REASONS, QUARANTINE_REASONS,
  classifyReason, explainReason, blockerMessage, stagePhase, presentationFor,
};
