'use strict';
// Bounded personal-ops automation preferences — Issue #112 (review hardening).
// Standing read-only account access and selected local tracker updates only.
// Never authorizes send, apply, invite, share, delete, or scope expansion.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { NEVER_AUTO } = require('./personal-ops');

const ALLOWED_KEYS = Object.freeze([
  'standing_gmail_readonly',
  'standing_local_tracker_updates',
  'expires_at',
  'confirmed'
]);

const MAX_STANDING_MS = 30 * 864e5; // 30 days
const MIN_STANDING_MS = 60e3; // 1 minute
const APPROVAL_TTL_MS = 5 * 60e3; // 5 minutes
const APPROVAL_ACTIONS = Object.freeze(['upsert', 'follow_up']);
const SCHEMA_VERSION = 1;

const DEFAULTS = Object.freeze({
  version: SCHEMA_VERSION,
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

function approvalsDir(dataDir) {
  return path.join(dataDir, 'personal-ops-approvals');
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

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    const err = Error('automation directory must not be a symlink');
    err.code = 'invalid_path';
    throw err;
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const body = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  const fd = fs.openSync(tmp, flags, 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* */ }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
}

function load(dataDir) {
  if (!dataDir) return inactive();
  const file = filePath(dataDir);
  try {
    if (!fs.existsSync(file)) return inactive();
    if (fs.lstatSync(file).isSymbolicLink()) return inactive({ invalid: true, reason: 'symlink' });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Fail closed on unknown persisted schema keys beyond the allowlist (+ metadata).
    const allowedPersisted = new Set([...ALLOWED_KEYS, 'version', 'never_auto', 'updated_at', 'actor', 'authority', 'confirmed_at']);
    for (const key of Object.keys(raw)) {
      if (!allowedPersisted.has(key)) return inactive({ expired: false, invalid: true, reason: 'unknown_field' });
    }
    if (raw.version !== SCHEMA_VERSION) return inactive({ invalid: true, reason: 'unsupported_version', previous_version: raw.version ?? null });
    if (raw.standing_gmail_readonly !== true && raw.standing_gmail_readonly !== false) return inactive({ invalid: true, reason: 'invalid_boolean' });
    if (raw.standing_local_tracker_updates !== true && raw.standing_local_tracker_updates !== false) return inactive({ invalid: true, reason: 'invalid_boolean' });
    const enabled = raw.standing_gmail_readonly === true || raw.standing_local_tracker_updates === true;
    if (!enabled) return inactive({ expires_at: raw.expires_at || null });
    if (typeof raw.expires_at !== 'string') return inactive({ invalid: true, reason: 'missing_expiry', previous_expires_at: raw.expires_at || null });
    const ms = Date.parse(raw.expires_at);
    if (!Number.isFinite(ms)) return inactive({ invalid: true, reason: 'invalid_expiry', previous_expires_at: raw.expires_at });
    const now = Date.now();
    if (ms < now) return inactive({ expired: true, previous_expires_at: raw.expires_at });
    // Fail closed when persisted expiry exceeds the 30-day ceiling from now or from updated_at.
    if (ms > now + MAX_STANDING_MS) return inactive({ invalid: true, reason: 'expiry_ceiling', previous_expires_at: raw.expires_at });
    if (typeof raw.updated_at === 'string') {
      const updated = Date.parse(raw.updated_at);
      if (Number.isFinite(updated) && ms > updated + MAX_STANDING_MS) {
        return inactive({ invalid: true, reason: 'expiry_ceiling_from_updated_at', previous_expires_at: raw.expires_at });
      }
    }
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
    version: SCHEMA_VERSION,
    standing_gmail_readonly,
    standing_local_tracker_updates,
    expires_at,
    never_auto: NEVER_AUTO,
    updated_at: new Date().toISOString(),
    confirmed_at: new Date().toISOString(),
    actor,
    authority: false
  };
  atomicWriteJson(filePath(dataDir), next);
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

function ensureApprovalsDir(dataDir) {
  const dir = approvalsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    const err = Error('approvals directory must not be a symlink');
    err.code = 'invalid_path';
    throw err;
  }
  return dir;
}

function issueApproval(dataDir, { action, actor = 'operator' } = {}) {
  if (!dataDir) throw Error('dataDir required');
  if (!APPROVAL_ACTIONS.includes(action)) {
    const err = Error('Unsupported tracker approval action');
    err.code = 'invalid_approval';
    throw err;
  }
  // Standing grant already authorizes mutations; still allow issuing for explicit binding.
  const id = crypto.randomUUID();
  const dir = ensureApprovalsDir(dataDir);
  const record = {
    version: 1,
    id,
    action,
    actor,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    consumed: false,
    authority: false
  };
  atomicWriteJson(path.join(dir, `${id}.json`), record);
  return {
    approval_id: id,
    action,
    expires_at: record.expires_at,
    standing_active: allows(dataDir, 'local_tracker_updates'),
    authority: false,
    message: 'Host per-action approval issued. Pass host_approval_id with the mutation. Standing grants remain optional.'
  };
}

function consumeApproval(dataDir, approvalId, action) {
  if (!dataDir) {
    const err = Error('dataDir required');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  if (typeof approvalId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approvalId)) {
    const err = Error('host_approval_id must be a UUID issued by the host');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  if (!APPROVAL_ACTIONS.includes(action)) {
    const err = Error('Unsupported tracker approval action');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  const file = path.join(approvalsDir(dataDir), `${approvalId}.json`);
  try {
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) {
      const err = Error('Host per-action approval not found');
      err.code = 'mutation_authorization_required';
      throw err;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.version !== 1 || raw.id !== approvalId || raw.consumed === true) {
      const err = Error('Host per-action approval invalid or already consumed');
      err.code = 'mutation_authorization_required';
      throw err;
    }
    if (raw.action !== action) {
      const err = Error('Host per-action approval action mismatch');
      err.code = 'mutation_authorization_required';
      throw err;
    }
    const exp = Date.parse(raw.expires_at);
    if (!Number.isFinite(exp) || exp < Date.now()) {
      const err = Error('Host per-action approval expired');
      err.code = 'mutation_authorization_required';
      throw err;
    }
    raw.consumed = true;
    raw.consumed_at = new Date().toISOString();
    atomicWriteJson(file, raw);
    return { ok: true, approval_id: approvalId, action, mode: 'host_approval' };
  } catch (e) {
    if (e.code === 'mutation_authorization_required' || e.code === 'invalid_path') throw e;
    const err = Error('Host per-action approval refused');
    err.code = 'mutation_authorization_required';
    throw err;
  }
}

function trackerPolicy(dataDir) {
  return {
    allowsLocalTrackerUpdates: () => allows(dataDir, 'local_tracker_updates'),
    consumeApproval: (approvalId, action) => consumeApproval(dataDir, approvalId, action),
    issueApproval: (action, actor) => issueApproval(dataDir, { action, actor })
  };
}

module.exports = {
  load,
  save,
  requiresExplicitPermission,
  allows,
  issueApproval,
  consumeApproval,
  trackerPolicy,
  DEFAULTS,
  NEVER_AUTO,
  ALLOWED_KEYS,
  MAX_STANDING_MS,
  APPROVAL_TTL_MS,
  APPROVAL_ACTIONS,
  SCHEMA_VERSION
};
