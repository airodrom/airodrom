'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  version: 1,
  execution_timeout_ms: 600_000,
  worker_heartbeat_timeout_ms: 120_000,
  acceptance_review_presentation_ms: 86_400_000
});

function loadConfig(root = path.join(__dirname, '..')) {
  const file = path.join(root, 'config', 'wait-presentation-v1.json');
  let doc = {};
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* defaults */ }
  const pick = (key, fallback, min, max) => {
    const raw = doc[key]?.default ?? doc[key];
    const n = Number.isFinite(raw) ? raw : fallback;
    return Math.max(min, Math.min(max, n));
  };
  return {
    version: 1,
    execution_timeout_ms: pick('execution_timeout_ms', DEFAULTS.execution_timeout_ms, 30_000, 3_600_000),
    worker_heartbeat_timeout_ms: pick('worker_heartbeat_timeout_ms', DEFAULTS.worker_heartbeat_timeout_ms, 15_000, 600_000),
    acceptance_review_presentation_ms: pick('acceptance_review_presentation_ms', DEFAULTS.acceptance_review_presentation_ms, 60_000, 604_800_000),
    approval_expiry: {
      configurable: false,
      authority: true,
      note: 'SafetyPolicy owns approval TTL; wait presentation never extends it'
    }
  };
}

function status(bridge) {
  const waits = loadConfig();
  const policyTtl = Number.isFinite(bridge?.policy?.ttlMs) ? bridge.policy.ttlMs : null;
  return {
    ...waits,
    approval_expiry_ms: policyTtl,
    classes: {
      execution_timeout: 'worker/process bound',
      worker_heartbeat_timeout: 'liveness observation',
      acceptance_review_presentation: 'Control Center wait display only',
      approval_expiry: 'security approval TTL (immutable here)'
    }
  };
}

module.exports = { loadConfig, status, DEFAULTS };
