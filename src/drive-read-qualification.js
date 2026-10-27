'use strict';
// Durable Drive read qualification. Synthetic/fixture reads never qualify.

const TABLE = `
CREATE TABLE IF NOT EXISTS drive_read_qualification (
  id TEXT PRIMARY KEY,
  qualified_at INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  account_email TEXT,
  evidence_hash TEXT NOT NULL,
  synthetic INTEGER NOT NULL
);
`;

function ensure(db) {
  if (!db || typeof db.exec !== 'function') return null;
  db.exec(TABLE);
  return db;
}

function hashEvidence(parts) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function recordReadQualification(db, {
  file_id,
  account_email = null,
  provider_confirmed = false,
  synthetic = false,
  content_length = null,
  now = Date.now(),
} = {}) {
  const store = ensure(db);
  if (!store) return { recorded: false, write_qualified: false };
  if (synthetic === true || provider_confirmed !== true || !file_id) {
    return { recorded: false, write_qualified: false, reason: 'synthetic_or_unconfirmed' };
  }
  const evidence_hash = hashEvidence({
    file_id, account_email, content_length, at: now, surface: 'drive_read',
  });
  store.prepare(`
    INSERT INTO drive_read_qualification(id, qualified_at, file_id, account_email, evidence_hash, synthetic)
    VALUES('default',?,?,?,?,0)
    ON CONFLICT(id) DO UPDATE SET
      qualified_at=excluded.qualified_at,
      file_id=excluded.file_id,
      account_email=excluded.account_email,
      evidence_hash=excluded.evidence_hash,
      synthetic=0
  `).run(now, file_id, account_email, evidence_hash);
  return { recorded: true, write_qualified: false, read_qualified: true, evidence_hash };
}

function status(db) {
  const store = ensure(db);
  if (!store) return { read_qualified: false };
  const row = store.prepare('SELECT * FROM drive_read_qualification WHERE id=?').get('default');
  if (!row || row.synthetic) return { read_qualified: false };
  return {
    read_qualified: true,
    qualified_at: row.qualified_at,
    file_id: row.file_id,
    account_email: row.account_email,
    evidence_hash: row.evidence_hash,
  };
}

module.exports = { recordReadQualification, status, ensure };
