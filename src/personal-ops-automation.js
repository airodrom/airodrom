'use strict';
// Bounded personal-ops automation preferences — Issue #112.
// Standing read-only account access and selected local tracker updates only.
// Never authorizes send, apply, invite, share, delete, or scope expansion.
const fs = require('node:fs');
const path = require('node:path');
const { NEVER_AUTO } = require('./personal-ops');

const DEFAULTS = Object.freeze({
  version: 1,
  standing_gmail_readonly: false,
  standing_local_tracker_updates: false,
  expires_at: null,
  never_auto: NEVER_AUTO,
  authority: false
});

function filePath(dataDir) {
  return path.join(dataDir, 'personal-ops-automation.json');
}

function load(dataDir) {
  if (!dataDir) return { ...DEFAULTS };
  const file = filePath(dataDir);
  try {
    if (!fs.existsSync(file)) return { ...DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expires = raw.expires_at ? Date.parse(raw.expires_at) : null;
    if (expires && Number.isFinite(expires) && expires < Date.now()) {
      return { ...DEFAULTS, expired: true, previous_expires_at: raw.expires_at };
    }
    return {
      ...DEFAULTS,
      standing_gmail_readonly: raw.standing_gmail_readonly === true,
      standing_local_tracker_updates: raw.standing_local_tracker_updates === true,
      expires_at: raw.expires_at || null
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(dataDir, patch = {}, actor = 'operator') {
  if (!dataDir) throw Error('dataDir required');
  for (const key of Object.keys(patch)) {
    if (NEVER_AUTO.includes(key) && patch[key]) {
      const err = Error('Action requires separate explicit confirmation and cannot be standing-authorized: ' + key);
      err.code = 'never_auto';
      throw err;
    }
  }
  const current = load(dataDir);
  const next = {
    version: 1,
    standing_gmail_readonly: patch.standing_gmail_readonly === undefined ? current.standing_gmail_readonly : !!patch.standing_gmail_readonly,
    standing_local_tracker_updates: patch.standing_local_tracker_updates === undefined ? current.standing_local_tracker_updates : !!patch.standing_local_tracker_updates,
    expires_at: patch.expires_at === undefined ? current.expires_at : patch.expires_at,
    never_auto: NEVER_AUTO,
    updated_at: new Date().toISOString(),
    actor,
    authority: false
  };
  const file = filePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return next;
}

function requiresExplicitPermission(action) {
  return NEVER_AUTO.includes(action);
}

module.exports = { load, save, requiresExplicitPermission, DEFAULTS, NEVER_AUTO };
