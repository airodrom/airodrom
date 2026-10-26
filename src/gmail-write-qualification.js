'use strict';
// Durable Gmail write qualification. write_qualified becomes true only after a
// provider-confirmed send receipt is recorded. Never set from OAuth scope alone.
const { createHash } = require('node:crypto');

const TABLE = `
CREATE TABLE IF NOT EXISTS gmail_write_qualification (
  id TEXT PRIMARY KEY,
  qualified_at INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  account_email TEXT,
  evidence_hash TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0
);
`;

function tableExists(db) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gmail_write_qualification'").get();
  } catch {
    return false;
  }
}

function ensure(db) {
  if (!db || typeof db.exec !== 'function') return null;
  db.exec(TABLE);
  return db;
}

function evidenceHash(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Record a provider-confirmed send as write qualification evidence.
 * Synthetic/fixture receipts never qualify live write status.
 */
function recordSendQualification(db, {
  operation_id,
  preview_id,
  provider_message_id,
  account_email = null,
  synthetic = false,
  now = Date.now(),
} = {}) {
  const store = ensure(db);
  if (!store) return { recorded: false, reason: 'db_unavailable' };
  if (typeof operation_id !== 'string' || !operation_id) return { recorded: false, reason: 'missing_operation_id' };
  if (typeof preview_id !== 'string' || !preview_id) return { recorded: false, reason: 'missing_preview_id' };
  if (typeof provider_message_id !== 'string' || !provider_message_id || provider_message_id.length > 200) {
    return { recorded: false, reason: 'missing_provider_message_id' };
  }
  if (synthetic === true) return { recorded: false, reason: 'synthetic_not_qualifying', write_qualified: false };

  const hash = evidenceHash({
    operation_id, preview_id, provider_message_id, account_email: account_email || null,
  });
  store.prepare(`
    INSERT INTO gmail_write_qualification(id, qualified_at, operation_id, preview_id, provider_message_id, account_email, evidence_hash, synthetic)
    VALUES('default', ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      qualified_at=excluded.qualified_at,
      operation_id=excluded.operation_id,
      preview_id=excluded.preview_id,
      provider_message_id=excluded.provider_message_id,
      account_email=excluded.account_email,
      evidence_hash=excluded.evidence_hash,
      synthetic=0
  `).run(now, operation_id, preview_id, provider_message_id, account_email, hash);

  return {
    recorded: true,
    write_qualified: true,
    operation_id,
    preview_id,
    provider_message_id,
    account_email,
    qualified_at: now,
  };
}

function readQualification(db) {
  // Read path must not CREATE TABLE — schema mutations during status probes
  // leave unclassified stores that deny conversation/Memory reads.
  if (!db || typeof db.prepare !== 'function') return { write_qualified: false, reason: 'db_unavailable' };
  if (!tableExists(db)) return { write_qualified: false, reason: 'not_qualified' };
  const row = db.prepare('SELECT * FROM gmail_write_qualification WHERE id=?').get('default');
  if (!row || row.synthetic === 1) {
    return { write_qualified: false, reason: row ? 'synthetic' : 'not_qualified' };
  }
  if (!row.provider_message_id || !row.operation_id || !row.preview_id) {
    return { write_qualified: false, reason: 'incomplete_evidence' };
  }
  return {
    write_qualified: true,
    qualified_at: row.qualified_at,
    operation_id: row.operation_id,
    preview_id: row.preview_id,
    provider_message_id: row.provider_message_id,
    account_email: row.account_email || null,
  };
}

function isWriteQualified(db) {
  return readQualification(db).write_qualified === true;
}

module.exports = {
  recordSendQualification,
  readQualification,
  isWriteQualified,
  ensure,
};
