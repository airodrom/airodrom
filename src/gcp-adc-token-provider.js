'use strict';
// Narrow ADC/helper token provider. Fixed argv only — not a general gcloud runner.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GCLOUD_CANDIDATES = Object.freeze([
  '/opt/homebrew/share/google-cloud-sdk/bin/gcloud',
  '/opt/homebrew/bin/gcloud',
  '/usr/local/bin/gcloud',
  'gcloud',
]);

function resolveGcloudBin() {
  for (const candidate of GCLOUD_CANDIDATES) {
    if (candidate === 'gcloud') return candidate;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* continue */ }
  }
  return 'gcloud';
}

function helperEnv() {
  const home = process.env.HOME || '';
  const extras = [
    '/opt/homebrew/share/google-cloud-sdk/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, 'google-cloud-sdk', 'bin'),
  ].filter(Boolean);
  const pathValue = [...extras, process.env.PATH || ''].join(path.delimiter);
  return { ...process.env, PATH: pathValue };
}

function runGcloud(args, { timeout_ms = 20_000, spawnImpl = spawnSync, bin = null } = {}) {
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
  const result = spawnImpl(bin || resolveGcloudBin(), args, {
    encoding: 'utf8',
    timeout: timeout_ms,
    env: helperEnv(),
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
