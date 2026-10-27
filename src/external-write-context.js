'use strict';
// Host external-write execution context. Separates synthetic test transports from
// live provider dispatch without disabling legitimate production sends.

function isTestProcess(env = process.env) {
  return env.NODE_ENV === 'test';
}

/**
 * Resolve Gmail/Calendar write execution mode.
 * - live: real provider transport (production / managed install only)
 * - synthetic: injected transport required; never qualifies live write status
 *
 * NODE_ENV=test always resolves to synthetic and refuses live mode.
 * A fixture label alone never grants live authority.
 */
function resolveExternalWriteMode({
  mode = null,
  request = null,
  env = process.env,
  surface = 'external_write',
} = {}) {
  const normalized = mode == null || mode === '' ? null : String(mode);
  if (normalized && normalized !== 'live' && normalized !== 'synthetic') {
    const err = Error(`${surface} mode must be live or synthetic.`);
    err.code = `${surface}_mode_invalid`;
    throw err;
  }
  if (normalized === 'live' || (!normalized && !isTestProcess(env))) {
    if (isTestProcess(env)) {
      const err = Error(`Live ${surface} provider dispatch is refused in test processes.`);
      err.code = `${surface}_live_refused_in_test`;
      throw err;
    }
    return 'live';
  }
  // synthetic (explicit or test default)
  if (typeof request !== 'function') {
    const err = Error(`Synthetic ${surface} requires an injected provider transport.`);
    err.code = `${surface}_synthetic_transport_required`;
    throw err;
  }
  return 'synthetic';
}

/** Refuse auto-wiring a live connector from OAuth inside test processes. */
function assertInjectableConnector(serverField, {
  env = process.env,
  surface = 'external_write',
} = {}) {
  if (!isTestProcess(env)) return;
  const err = Error(
    `Test processes must inject ${serverField}; auto-wiring a live provider connector is refused.`,
  );
  err.code = `${surface}_synthetic_connector_required`;
  throw err;
}

module.exports = {
  isTestProcess,
  resolveExternalWriteMode,
  assertInjectableConnector,
};
