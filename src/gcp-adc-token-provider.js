'use strict';
// Narrow ADC/helper token provider. Fixed argv only — not a general gcloud runner.
const { spawnSync } = require('node:child_process');

function runGcloud(args, { timeout_ms = 20_000, spawnImpl = spawnSync } = {}) {
  if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== 'string')) {
    const err = Error('Invalid gcloud helper argv.');
    err.code = 'gcp_adc_argv_invalid';
    throw err;
  }
  // Absolute deny of mutable cloud verbs — this helper is auth-status only.
  const banned = /^(storage|compute|iam|projects|billing|sql|run|dns|secrets?|deployment|functions|app|container|builds?)$/i;
  if (banned.test(args[0])) {
    const err = Error('gcloud cloud mutation/resource verbs are refused by the ADC token helper.');
    err.code = 'gcp_adc_verb_forbidden';
    throw err;
  }
  const result = spawnImpl('gcloud', args, {
    encoding: 'utf8',
    timeout: timeout_ms,
    env: process.env,
  });
  if (result.error) {
    const err = Error('gcloud helper failed to start.');
    err.code = 'gcp_adc_helper_unavailable';
    throw err;
  }
  if (result.status !== 0) {
    const err = Error('gcloud helper exited non-zero.');
    err.code = 'gcp_adc_helper_failed';
    throw err;
  }
  return String(result.stdout || '').trim();
}

function createGcpAdcTokenProvider({ spawnImpl = spawnSync } = {}) {
  return async function gcpTokenProvider() {
    const account_email = runGcloud(
      ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
      { spawnImpl },
    ).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
    const accessToken = runGcloud(['auth', 'print-access-token'], { spawnImpl });
    if (!accessToken || accessToken.length < 8) {
      const err = Error('GCP access token unavailable from ADC helper.');
      err.code = 'gcp_credential_missing';
      throw err;
    }
    // Never return refresh tokens; access token stays in-process only.
    return { accessToken, account_email, project_id: null };
  };
}

module.exports = { createGcpAdcTokenProvider, runGcloud };
