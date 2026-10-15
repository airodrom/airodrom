'use strict';
// Bounded personal-ops automation preferences — Issue #112 (review hardening).
// Standing read-only account access and selected local tracker updates only.
// Never authorizes send, apply, invite, share, delete, or scope expansion.
const fs = require('node:fs');
const path = require('node:path');
const { NEVER_AUTO } = require('./personal-ops');

const ALLOWED_KEYS = Object.freeze([
  'standing_gmail_readonly',
  'standing_local_tracker_updates',
  'expires_at',
  'confirmed'
]);

const MAX_STANDING_MS = 30 * 864e5; // 30 days
const MIN_STANDING_MS = 60e3; // 1 minute

const DEFAULTS = Object.freeze({
  version: 1,
  standing_gmail_readonly: false,
  standing_local_tracker_updates: false,
  expires_at: null,
  never_auto: NEVER_AUTO,
  authority: false,
  active: false
});

function filePath(dataDir) {
  return path.join(dataDir, 'personal-ops-automation.json');
}

function assertExactBoolean(value, name) {
  if (typeof value !== 'boolean') {
    const err = Error(`${name} must be an exact boolean`);
    err.code = 'invalid_automation';
    throw err;
  }
  return value;
}

function assertExpiry(expires_at, { requiredWhenEnabled = false, enabled = false } = {}) {
  if (expires_at == null || expires_at === '') {
    if (requiredWhenEnabled && enabled) {
      const err = Error('expires_at is required when any standing grant is enabled');
      err.code = 'invalid_automation';
      throw err;
    }
    return null;
  }
  if (typeof expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(expires_at)) {
    const err = Error('expires_at must be an ISO-8601 timestamp with timezone');
    err.code = 'invalid_automation';
    throw err;
  }
  const ms = Date.parse(expires_at);
  if (!Number.isFinite(ms)) {
    const err = Error('expires_at is not a valid timestamp');
    err.code = 'invalid_automation';
    throw err;
  }
  const now = Date.now();
  if (ms <= now + MIN_STANDING_MS) {
    const err = Error('expires_at must be at least one minute in the future');
    err.code = 'invalid_automation';
    throw err;
  }
  if (ms > now + MAX_STANDING_MS) {
    const err = Error('expires_at must be within 30 days');
    err.code = 'invalid_automation';
    throw err;
  }
  return expires_at;
}

function inactive(extra = {}) {
  return { ...DEFAULTS, ...extra, standing_gmail_readonly: false, standing_local_tracker_updates: false, active: false };
}

function load(dataDir) {
  if (!dataDir) return inactive();
  const file = filePath(dataDir);
  try {
    if (!fs.existsSync(file)) return inactive();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Fail closed on unknown persisted schema keys beyond the allowlist (+ metadata).
    const allowedPersisted = new Set([...ALLOWED_KEYS, 'version', 'never_auto', 'updated_at', 'actor', 'authority', 'confirmed_at']);
    for (const key of Object.keys(raw)) {
      if (!allowedPersisted.has(key)) return inactive({ expired: false, invalid: true, reason: 'unknown_field' });
    }
    if (raw.standing_gmail_readonly !== true && raw.standing_gmail_readonly !== false) return inactive({ invalid: true, reason: 'invalid_boolean' });
    if (raw.standing_local_tracker_updates !== true && raw.standing_local_tracker_updates !== false) return inactive({ invalid: true, reason: 'invalid_boolean' });
    const enabled = raw.standing_gmail_readonly === true || raw.standing_local_tracker_updates === true;
    if (!enabled) return inactive({ expires_at: raw.expires_at || null });
    if (typeof raw.expires_at !== 'string') return inactive({ invalid: true, reason: 'missing_expiry', previous_expires_at: raw.expires_at || null });
    const ms = Date.parse(raw.expires_at);
    if (!Number.isFinite(ms)) return inactive({ invalid: true, reason: 'invalid_expiry', previous_expires_at: raw.expires_at });
    if (ms < Date.now()) return inactive({ expired: true, previous_expires_at: raw.expires_at });
    return {
      ...DEFAULTS,
      standing_gmail_readonly: raw.standing_gmail_readonly === true,
      standing_local_tracker_updates: raw.standing_local_tracker_updates === true,
      expires_at: raw.expires_at,
      active: true
    };
  } catch {
    return inactive({ invalid: true, reason: 'unreadable' });
  }
}

function save(dataDir, patch = {}, actor = 'operator') {
  if (!dataDir) throw Error('dataDir required');
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_KEYS.includes(key)) {
      const err = Error('Unknown personal-ops automation field: ' + key);
      err.code = 'invalid_automation';
      throw err;
    }
    if (NEVER_AUTO.includes(key) && patch[key]) {
      const err = Error('Action requires separate explicit confirmation and cannot be standing-authorized: ' + key);
      err.code = 'never_auto';
      throw err;
    }
  }
  if (patch.confirmed !== true) {
    const err = Error('Explicit confirmed:true required to save standing personal-ops automation');
    err.code = 'confirmation_required';
    throw err;
  }
  const current = load(dataDir);
  const standing_gmail_readonly = patch.standing_gmail_readonly === undefined
    ? current.standing_gmail_readonly
    : assertExactBoolean(patch.standing_gmail_readonly, 'standing_gmail_readonly');
  const standing_local_tracker_updates = patch.standing_local_tracker_updates === undefined
    ? current.standing_local_tracker_updates
    : assertExactBoolean(patch.standing_local_tracker_updates, 'standing_local_tracker_updates');
  const enabled = standing_gmail_readonly || standing_local_tracker_updates;
  const expires_at = assertExpiry(
    patch.expires_at === undefined ? current.expires_at : patch.expires_at,
    { requiredWhenEnabled: true, enabled }
  );
  const next = {
    version: 1,
    standing_gmail_readonly,
    standing_local_tracker_updates,
    expires_at,
    never_auto: NEVER_AUTO,
    updated_at: new Date().toISOString(),
    confirmed_at: new Date().toISOString(),
    actor,
    authority: false
  };
  const file = filePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return load(dataDir);
}

function requiresExplicitPermission(action) {
  return NEVER_AUTO.includes(action);
}

function allows(dataDir, capability) {
  const st = load(dataDir);
  if (!st.active) return false;
  if (capability === 'gmail_readonly') return st.standing_gmail_readonly === true;
  if (capability === 'local_tracker_updates') return st.standing_local_tracker_updates === true;
  return false;
}

module.exports = { load, save, requiresExplicitPermission, allows, DEFAULTS, NEVER_AUTO, ALLOWED_KEYS, MAX_STANDING_MS };
