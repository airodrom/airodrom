'use strict';
/**
 * Authoritative Cursor execution decision.
 *
 * Separates technical readiness from Mission execution authority. Routing layers
 * (specialist select, Mission launch, recovery) must consume this decision rather
 * than inventing parallel "available" / "qualified" flags that can disagree.
 *
 * Dimensions (all must pass for allow=true):
 * 1. runtime_installed_operational
 * 2. worker_technically_qualified
 * 3. mission_worker_allowed
 * 4. repository_workspace_authorized
 * 5. external_disclosure_covered
 * 6. standing_or_mission_grant_covers
 * 7. budget_deadline_sufficient
 */
const ID = 'cursor';

function failClosed(code, dimensions, detail = null) {
  return {
    allow: false,
    worker: ID,
    code,
    detail: detail ? String(detail).slice(0, 200) : null,
    transient: isTransient(code),
    dimensions,
    authority: false,
  };
}

function isTransient(code) {
  return /cursor_runtime_not_ready|cursor_version_unavailable|cursor_agent_busy|cursor_sandbox_unavailable/i.test(String(code || ''));
}

function baseDimensions() {
  return {
    runtime_installed_operational: false,
    worker_technically_qualified: false,
    mission_worker_allowed: false,
    repository_workspace_authorized: false,
    external_disclosure_covered: false,
    standing_or_mission_grant_covers: false,
    budget_deadline_sufficient: false,
  };
}

/**
 * @param {object} bridge
 * @param {object} mission
 * Runtime availability is deliberately excluded from this synchronous check.
 */
function decideAuthority(bridge, mission) {
  const dimensions = baseDimensions();
  if (!mission) return failClosed('mission_missing', dimensions);
  if (mission.envelope?.preferred_agent !== ID && !specialistRequiresCursor(bridge, mission)) {
    return failClosed('cognitive_worker_unqualified:' + (mission.envelope?.preferred_agent || 'unknown'), dimensions);
  }

  const hep = bridge.hostExecutionPolicy;
  if (hep?.cursorDisabled?.()) {
    return failClosed('CURSOR_EXECUTION_DISABLED', dimensions);
  }

  if (!bridge.cursorWorker) return failClosed('worker_execution_unqualified', dimensions, 'cursor_worker_absent');

  // 3 Mission worker allowed by sealed scope / specialist graph.
  const contract = mission.envelope?.contract;
  if (!contract) {
    return failClosed('worker_execution_unqualified', dimensions, 'cursor_contract_missing');
  }
  dimensions.mission_worker_allowed = mission.envelope.preferred_agent === ID
    || specialistRequiresCursor(bridge, mission);
  if (!dimensions.mission_worker_allowed) {
    return failClosed('cognitive_worker_unqualified:cursor', dimensions);
  }

  // 4 Repository / workspace binding — contract + envelope must stay intact.
  try {
    require('./mission-contract').assertIntact(contract);
    dimensions.repository_workspace_authorized = true;
  } catch (error) {
    return failClosed('worker_execution_unqualified', dimensions, String(error.message || error).slice(0, 120));
  }

  // 5 External disclosure.
  const disclosure = contract.permissions?.external_disclosure;
  dimensions.external_disclosure_covered = !!(
    disclosure?.authorized && Array.isArray(disclosure.providers) && disclosure.providers.includes(ID)
  );
  if (!dimensions.external_disclosure_covered) {
    return failClosed('scoped_external_disclosure_required', dimensions);
  }

  // 6 Standing / Mission grant (approval_id bound at seal for Cursor spend).
  dimensions.standing_or_mission_grant_covers = !!mission.envelope.approval_id;
  if (!dimensions.standing_or_mission_grant_covers) {
    return failClosed('BLOCKED_SPEND_AUTHORIZATION', dimensions);
  }
  try {
    if (bridge.missionApprovals?.assertDispatch) bridge.missionApprovals.assertDispatch(mission);
  } catch (error) {
    const code = String(error.code || error.message || 'BLOCKED_SPEND_AUTHORIZATION').slice(0, 120);
    return failClosed(code, dimensions);
  }
  // This predicate checks the sealed worker contract only. Runtime observations
  // cannot revoke authority or prevent queueing a dependent assignment.
  if (!bridge.cursorWorker.qualifiedFor?.(mission)) {
    return failClosed('worker_execution_unqualified', dimensions, 'cursor_mission_unqualified');
  }

  return { allow: true, worker: ID, code: null, detail: null, transient: false, dimensions, authority: false };
}

/** Full launch decision: current Mission authority plus a fresh runtime probe. */
function decide(bridge, mission, opts = {}) {
  const authorization = decideAuthority(bridge, mission);
  if (!authorization.allow) return authorization;
  const dimensions = { ...authorization.dimensions };
  const readiness = opts.readiness
    || bridge.cursorWorker?.lastReadiness
    || null;
  // 1–2 technical readiness (never conflated with Mission authority).
  const installed = readiness?.installed === true;
  const ready = readiness?.ready === true;
  const reason = readiness?.reason || null;
  dimensions.runtime_installed_operational = installed && ready;
  dimensions.worker_technically_qualified = readiness?.tiers?.qualified === true
    || (ready && readiness?.governed_worker === true);
  if (!installed) return failClosed('cursor_agent_not_installed', dimensions, reason);
  if (readiness?.availability === 'busy' || (bridge.cursorWorker.active?.size > 0 && !ready)) {
    return failClosed('cursor_agent_busy', dimensions, reason);
  }
  if (!ready) {
    const code = reason && /^cursor_/.test(reason) ? reason : 'cursor_runtime_not_ready';
    return failClosed(code === 'cursor_execution_unqualified' ? 'cursor_runtime_not_ready' : code, dimensions, reason);
  }
  if (!dimensions.worker_technically_qualified) {
    return failClosed('cursor_runtime_not_ready', dimensions, reason || 'cursor_tiers_unqualified');
  }

  // 7 Budget / deadline.
  const now = opts.now || bridge.controlStore?.now?.() || Date.now();
  let deadline = Infinity;
  try {
    if (require('./specialist-gateway').enabled(mission)) {
      deadline = require('./specialist-gateway').deadline(mission);
    } else if (mission.envelope?.contract?.identity?.expires_at) {
      deadline = mission.envelope.contract.identity.expires_at;
    }
  } catch { /* non-specialist */ }
  dimensions.budget_deadline_sufficient = Number.isFinite(deadline) ? now < deadline : true;
  if (!dimensions.budget_deadline_sufficient) {
    return failClosed('cognitive_envelope_expired', dimensions);
  }

  return {
    allow: true,
    worker: ID,
    code: null,
    detail: null,
    transient: false,
    dimensions,
    transport: 'sandboxed_headless_cli',
    reason: 'authoritative_cursor_execution_decision',
    authority: false,
  };
}

function assertAllowed(decision) {
  if (decision.allow) return decision;
  const error = Error(decision.code);
  Object.assign(error, { code: decision.code, transient: decision.transient, dimensions: decision.dimensions, detail: decision.detail });
  throw error;
}

function specialistRequiresCursor(bridge, mission) {
  try {
    if (!require('./specialist-gateway').enabled(mission)) return false;
    const graph = require('./specialist-gateway').inspect(bridge, mission);
    return (graph.assignments || []).some((a) => a.worker === ID);
  } catch {
    return false;
  }
}

/**
 * Fresh readiness for dispatch — bypass short TTL so menu/status races cannot
 * leave a stale negative cache that blocks an authorized Mission.
 */
async function refreshReadiness(bridge, { fresh = true } = {}) {
  const worker = bridge.cursorWorker;
  if (!worker?.readiness) return null;
  if (fresh) worker._readinessCache = null;
  const readiness = await worker.readiness({ fresh });
  worker.lastReadiness = readiness;
  return readiness;
}

module.exports = {
  decide,
  decideAuthority,
  assertAllowed,
  refreshReadiness,
  isTransient,
  ID,
};
