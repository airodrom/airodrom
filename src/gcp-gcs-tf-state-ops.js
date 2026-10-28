'use strict';
// Durable preview/confirm/claim for exact-scope GCS Terraform state-backend CREATE.
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const TTL_MS = 15 * 60 * 1000;
const MAX_PENDING = 8;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATUSES = new Set(['pending', 'creating', 'uncertain', 'completed', 'denied']);

function bindingKey(operator, conversation_id) {
  if (operator !== 'operator') {
    const err = Error('GCP tf-state ops are operator-local only');
    err.code = 'gcp_tf_state_forbidden';
    throw err;
  }
  if (typeof conversation_id !== 'string' || !conversation_id.trim()) {
    const err = Error('GCP tf-state ops require an authenticated Terminal conversation session.');
    err.code = 'gcp_tf_state_session_required';
    throw err;
  }
  if (!UUID.test(conversation_id)) {
    const err = Error('GCP tf-state ops require a valid conversation session identity.');
    err.code = 'gcp_tf_state_session_invalid';
    throw err;
  }
  return operator + '\0' + conversation_id;
}

function openDb(db) {
  if (db && typeof db.exec === 'function' && typeof db.prepare === 'function') return db;
  return new DatabaseSync(':memory:');
}

class GcpGcsTfStateOps {
  constructor({ db = null, now = () => Date.now() } = {}) {
    this.db = openDb(db);
    this.now = now;
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gcp_gcs_tf_state_ops (
        preview_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        operator TEXT NOT NULL,
        account_email TEXT,
        approval_id TEXT,
        approval_status TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        scope_sha256 TEXT NOT NULL,
        proposal_json TEXT NOT NULL,
        receipt_json TEXT,
        claim_token TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gcp_gcs_tf_state_ops_status
        ON gcp_gcs_tf_state_ops(status, expires_at);
      CREATE INDEX IF NOT EXISTS gcp_gcs_tf_state_ops_conversation
        ON gcp_gcs_tf_state_ops(conversation_id, operator, status);
    `);
  }

  #sweep(now = this.now()) {
    this.db.prepare(`
      DELETE FROM gcp_gcs_tf_state_ops
      WHERE expires_at <= ? AND status IN ('pending','creating','uncertain','denied')
    `).run(now);
    this.db.prepare(`
      DELETE FROM gcp_gcs_tf_state_ops WHERE expires_at <= ? AND status = 'completed'
    `).run(now);
  }

  #rowToProposal(row) {
    const proposal = JSON.parse(row.proposal_json);
    return {
      ...proposal,
      id: row.preview_id,
      preview_id: row.preview_id,
      operation_id: row.operation_id,
      approval_id: row.approval_id,
      approval_status: row.approval_status,
      conversation_id: row.conversation_id,
      operator: row.operator,
      account_email: row.account_email || null,
      status: row.status,
      idempotency_key: row.idempotency_key,
      scope_sha256: row.scope_sha256,
      claim_token: row.claim_token || null,
      expires_at: row.expires_at,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
    };
  }

  #countActive() {
    return this.db.prepare(`
      SELECT COUNT(*) AS n FROM gcp_gcs_tf_state_ops
      WHERE status IN ('pending','creating','uncertain')
    `).get().n;
  }

  createPreview({
    conversation_id,
    operator = 'operator',
    account_email = null,
    proposal,
    idempotency_key,
    scope_sha256,
    approval_id = null,
    ttl_ms = TTL_MS,
  }) {
    bindingKey(operator, conversation_id);
    if (!idempotency_key || typeof idempotency_key !== 'string' || idempotency_key.length > 200) {
      const err = Error('idempotency_key required');
      err.code = 'gcp_tf_state_idempotency_required';
      throw err;
    }
    if (!scope_sha256 || !/^[a-f0-9]{64}$/.test(scope_sha256)) {
      const err = Error('scope_sha256 required');
      err.code = 'gcp_tf_state_scope_required';
      throw err;
    }
    this.#sweep();
    const existing = this.db.prepare(`
      SELECT * FROM gcp_gcs_tf_state_ops WHERE idempotency_key=?
    `).get(idempotency_key);
    if (existing) {
      if (existing.status === 'completed') {
        const err = Error('Idempotency key already completed; replay refused.');
        err.code = 'gcp_tf_state_replay_completed';
        err.receipt = existing.receipt_json ? JSON.parse(existing.receipt_json) : null;
        throw err;
      }
      return this.#rowToProposal(existing);
    }
    if (this.#countActive() >= MAX_PENDING) {
      const err = Error('Too many pending GCP tf-state operations.');
      err.code = 'gcp_tf_state_capacity';
      throw err;
    }
    const now = this.now();
    const preview_id = randomUUID();
    const operation_id = randomUUID();
    this.db.prepare(`
      INSERT INTO gcp_gcs_tf_state_ops(
        preview_id, operation_id, conversation_id, operator, account_email,
        approval_id, approval_status, status, idempotency_key, scope_sha256,
        proposal_json, receipt_json, claim_token, created_at, updated_at, expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)
    `).run(
      preview_id,
      operation_id,
      conversation_id,
      operator,
      account_email,
      approval_id,
      'pending',
      'pending',
      idempotency_key,
      scope_sha256,
      JSON.stringify(proposal),
      now,
      now,
      now + ttl_ms,
    );
    return this.get(preview_id);
  }

  get(preview_id) {
    this.#sweep();
    const row = this.db.prepare(`SELECT * FROM gcp_gcs_tf_state_ops WHERE preview_id=?`).get(preview_id);
    return row ? this.#rowToProposal(row) : null;
  }

  getByIdempotency(idempotency_key) {
    this.#sweep();
    const row = this.db.prepare(`SELECT * FROM gcp_gcs_tf_state_ops WHERE idempotency_key=?`).get(idempotency_key);
    return row ? this.#rowToProposal(row) : null;
  }

  claim(preview_id, {
    conversation_id,
    operator = 'operator',
    account_email = null,
    ack_uncertain = false,
  } = {}) {
    bindingKey(operator, conversation_id);
    this.#sweep();
    const row = this.db.prepare(`SELECT * FROM gcp_gcs_tf_state_ops WHERE preview_id=?`).get(preview_id);
    if (!row) {
      const err = Error('Preview not found or expired.');
      err.code = 'gcp_tf_state_preview_missing';
      throw err;
    }
    if (row.conversation_id !== conversation_id || row.operator !== operator) {
      const err = Error('Preview is bound to a different conversation.');
      err.code = 'gcp_tf_state_binding_mismatch';
      throw err;
    }
    if (row.status === 'completed') {
      const err = Error('Operation already completed; confirm replay refused.');
      err.code = 'gcp_tf_state_replay_completed';
      err.receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null;
      throw err;
    }
    if (row.status === 'creating') {
      const err = Error('Operation already claimed by another confirm.');
      err.code = 'gcp_tf_state_concurrent_claim';
      throw err;
    }
    if (row.status === 'uncertain' && !ack_uncertain) {
      const err = Error('Prior GCP outcome is uncertain. Inspect provider metadata first, then /gcp confirm <id> --ack-uncertain only if CREATE did not commit. Blind retry is refused.');
      err.code = 'gcp_tf_state_ack_uncertain_required';
      throw err;
    }
    if (row.status !== 'pending' && row.status !== 'uncertain') {
      const err = Error(`Operation status ${row.status} cannot be confirmed.`);
      err.code = 'gcp_tf_state_status_invalid';
      throw err;
    }
    if (row.account_email && account_email
        && String(row.account_email).toLowerCase() !== String(account_email).toLowerCase()) {
      const err = Error('Confirm identity does not match the preview-bound GCP account.');
      err.code = 'gcp_tf_state_account_mismatch';
      throw err;
    }
    if (row.expires_at <= this.now()) {
      const err = Error('Approval/preview expired.');
      err.code = 'gcp_tf_state_expired';
      throw err;
    }
    const claim_token = randomUUID();
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE gcp_gcs_tf_state_ops
      SET status='creating', claim_token=?, updated_at=?, approval_status='approved'
      WHERE preview_id=? AND status IN ('pending','uncertain') AND claim_token IS NULL
    `).run(claim_token, now, preview_id);
    if (result.changes !== 1) {
      const err = Error('Exclusive operation lease unavailable.');
      err.code = 'gcp_tf_state_lease_unavailable';
      throw err;
    }
    return this.get(preview_id);
  }

  complete(preview_id, receipt, { claim_token } = {}) {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE gcp_gcs_tf_state_ops
      SET status='completed', receipt_json=?, claim_token=NULL, updated_at=?, approval_status='completed'
      WHERE preview_id=? AND status='creating' AND claim_token=?
    `).run(JSON.stringify(receipt), now, preview_id, claim_token);
    if (result.changes !== 1) {
      const err = Error('Unable to complete operation with provided claim.');
      err.code = 'gcp_tf_state_complete_failed';
      throw err;
    }
    return this.get(preview_id);
  }

  markUncertain(preview_id, receipt, { claim_token } = {}) {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE gcp_gcs_tf_state_ops
      SET status='uncertain', receipt_json=?, claim_token=NULL, updated_at=?
      WHERE preview_id=? AND status='creating' AND claim_token=?
    `).run(JSON.stringify(receipt), now, preview_id, claim_token);
    if (result.changes !== 1) {
      const err = Error('Unable to mark operation uncertain.');
      err.code = 'gcp_tf_state_uncertain_failed';
      throw err;
    }
    return this.get(preview_id);
  }

  deny(preview_id, reason) {
    const now = this.now();
    this.db.prepare(`
      UPDATE gcp_gcs_tf_state_ops
      SET status='denied', receipt_json=?, claim_token=NULL, updated_at=?, approval_status='denied'
      WHERE preview_id=? AND status IN ('pending','creating','uncertain')
    `).run(JSON.stringify({ denied: true, reason: String(reason || 'denied') }), now, preview_id);
    return this.get(preview_id);
  }
}

module.exports = { GcpGcsTfStateOps, TTL_MS, STATUSES };
