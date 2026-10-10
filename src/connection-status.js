'use strict';

/** Authoritative Control Center / menu connectivity — never conflate optional providers. */
const STATES = Object.freeze(['CONNECTED', 'RECONNECTING', 'DEGRADED', 'DISCONNECTED', 'MAINTENANCE', 'AUTHORIZATION_REQUIRED']);

function enumState(value) {
  return STATES.includes(value) ? value : 'DISCONNECTED';
}

/**
 * @param {object} input
 * @param {boolean} [input.authorized]
 * @param {boolean} [input.reachable] overview/native-status succeeded
 * @param {boolean} [input.paused]
 * @param {boolean} [input.maintenance] bridge intentionally closed / maintenance
 * @param {number} [input.failures] consecutive transport failures
 * @param {string|null} [input.overviewStatus] Ready|Degraded|Unavailable from product overview
 * @param {number|null} [input.lastOkAt]
 * @param {string|null} [input.endpoint]
 * @param {string|null} [input.error]
 */
function derive(input = {}) {
  const authorized = input.authorized !== false;
  const reachable = input.reachable === true;
  const paused = input.paused === true;
  const maintenance = input.maintenance === true;
  const failures = Number.isSafeInteger(input.failures) && input.failures > 0 ? input.failures : 0;
  const lastOkAt = Number.isSafeInteger(input.lastOkAt) ? input.lastOkAt : null;
  const endpoint = typeof input.endpoint === 'string' && input.endpoint.startsWith('http://127.0.0.1:') ? input.endpoint : null;
  const error = typeof input.error === 'string' && input.error.length && input.error.length <= 240 ? input.error : null;
  const overviewStatus = input.overviewStatus === 'Ready' || input.overviewStatus === 'Degraded' || input.overviewStatus === 'Unavailable'
    ? input.overviewStatus : null;

  if (!authorized) {
    return view('AUTHORIZATION_REQUIRED', {
      label: 'Authorization required',
      detail: 'Open Control Center from the local Airodrom menu.',
      lastOkAt, endpoint, error, reconnect_attempt: 0
    });
  }
  if (maintenance) {
    return view('MAINTENANCE', {
      label: 'Maintenance',
      detail: 'Service intentionally unavailable for work.',
      lastOkAt, endpoint, error, reconnect_attempt: 0
    });
  }
  if (paused && reachable) {
    return view('CONNECTED', {
      label: 'Updates paused',
      detail: 'Local service reachable; live updates paused.',
      lastOkAt, endpoint, error: null, reconnect_attempt: 0, health: overviewStatus || 'Ready'
    });
  }
  if (!reachable) {
    if (failures > 0) {
      return view('RECONNECTING', {
        label: 'Reconnecting',
        detail: error || 'Local service temporarily unreachable.',
        lastOkAt, endpoint, error, reconnect_attempt: failures
      });
    }
    return view('DISCONNECTED', {
      label: 'Disconnected',
      detail: error || 'Local service cannot be reached.',
      lastOkAt, endpoint, error, reconnect_attempt: 0
    });
  }
  if (overviewStatus === 'Degraded' || overviewStatus === 'Unavailable') {
    return view('DEGRADED', {
      label: 'Connected · degraded',
      detail: 'Service reachable; one or more required dependencies are unavailable.',
      lastOkAt, endpoint, error: null, reconnect_attempt: 0, health: overviewStatus
    });
  }
  return view('CONNECTED', {
    label: 'Connected',
    detail: 'Service reachable and authenticated.',
    lastOkAt, endpoint, error: null, reconnect_attempt: 0, health: overviewStatus || 'Ready'
  });
}

function view(state, extra) {
  return {
    state: enumState(state),
    label: extra.label,
    detail: extra.detail,
    health: extra.health || null,
    last_ok_at: extra.lastOkAt,
    endpoint: extra.endpoint,
    error: extra.error,
    reconnect_attempt: extra.reconnect_attempt || 0,
    // Provider / OpenCode / MCP are reported separately and never force DISCONNECTED here.
    separates_providers: true
  };
}

/** Menu icon semantic class from bridge + product aggregates.
 * Historical Mission review backlog (awaiting_acceptance / waiting_for_operator) stays
 * neutral/healthy — only new protected Approvals force the gold ACTION REQUIRED mark.
 * Review counts remain available to Control Center and menu text rows.
 */
function menuPresentation({ bridgeState, productStatus, activeMissions = 0, approvals = 0, reviewMissions = 0, missionState = null, reconnecting = false, lastError = null } = {}) {
  if (bridgeState === 'Stopped') return { tone: 'stopped', label: 'DISCONNECTED', accessibility: 'Airodrom stopped' };
  if (bridgeState === 'Error' || lastError) return { tone: 'disconnected', label: 'DISCONNECTED', accessibility: 'Airodrom disconnected' };
  if (bridgeState === 'Starting' || reconnecting) return { tone: 'reconnecting', label: 'RECONNECTING', accessibility: 'Airodrom reconnecting' };
  // New actionable protected Approvals only — not retained Mission review backlog.
  if (approvals > 0) {
    return { tone: 'approval', label: 'ACTION REQUIRED', accessibility: `Airodrom action required: ${approvals} approvals waiting` };
  }
  if (activeMissions > 0 || ['dispatching', 'running', 'verifying'].includes(missionState)) {
    return { tone: 'working', label: 'CONNECTED', accessibility: 'Airodrom mission executing' };
  }
  if (productStatus === 'Degraded' || productStatus === 'Unavailable') {
    return { tone: 'degraded', label: 'DEGRADED', accessibility: 'Airodrom degraded' };
  }
  if (bridgeState === 'Connected') {
    const reviewNote = reviewMissions > 0 ? ` · ${reviewMissions} historical reviews retained` : '';
    return { tone: 'healthy', label: 'CONNECTED', accessibility: `Airodrom connected and healthy${reviewNote}` };
  }
  return { tone: 'disconnected', label: 'DISCONNECTED', accessibility: 'Airodrom disconnected' };
}

module.exports = { STATES, derive, menuPresentation };
