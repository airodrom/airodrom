'use strict';
// Operator- and conversation-bound Gmail write previews with durable operation state.
// Atomic claim prevents concurrent confirms from double-dispatching. Uncertain
// provider outcomes never auto-retry without explicit operator acknowledgement.
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const TTL_MS = 15 * 60 * 1000;
const MAX_PENDING = 16;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATUSES = new Set(['pending', 'sending', 'uncertain', 'completed']);

function bindingKey(operator, conversation_id) {
  if (operator !== 'operator') {
    const err = Error('Gmail write continuation is operator-local only');
    err.code = 'gmail_write_session_forbidden';
    throw err;
  }
  if (typeof conversation_id !== 'string' || !conversation_id.trim()) {
    const err = Error('Gmail writes require an authenticated Terminal conversation session.');
    err.code = 'gmail_write_session_required';
    throw err;
  }
  if (!UUID.test(conversation_id)) {
    const err = Error('Gmail writes require a valid conversation session identity.');
    err.code = 'gmail_write_session_invalid';
    throw err;
  }
  return operator + '\0' + conversation_id;
}

function openDb(db) {
  if (db && typeof db.exec === 'function' && typeof db.prepare === 'function') return db;
  return new DatabaseSync(':memory:');
}

class GmailWriteSessions {
  constructor({ db = null, now = () => Date.now() } = {}) {
    this.db = openDb(db);
    this.now = now;
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gmail_write_ops (
        preview_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        operator TEXT NOT NULL,
        account_email TEXT,
        oauth_mode TEXT,
        oauth_scope TEXT,
        approval_id TEXT,
        approval_status TEXT NOT NULL,
        status TEXT NOT NULL,
        proposal_json TEXT NOT NULL,
        receipt_json TEXT,
        claim_token TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gmail_write_ops_status ON gmail_write_ops(status, expires_at);
      CREATE INDEX IF NOT EXISTS gmail_write_ops_conversation ON gmail_write_ops(conversation_id, operator, status);
    `);
  }

  #sweep(now = this.now()) {
    // Never delete completed receipts while still within TTL — they are the
    // host-local anti-replay evidence after restart.
    this.db.prepare(`
      DELETE FROM gmail_write_ops
      WHERE expires_at <= ? AND status IN ('pending','sending','uncertain')
    `).run(now);
    // Cap completed rows by expiry only.
    this.db.prepare(`DELETE FROM gmail_write_ops WHERE expires_at <= ? AND status = 'completed'`).run(now);
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
      oauth_mode: row.oauth_mode || null,
      oauth_scope: row.oauth_scope || null,
      status: row.status,
      claim_token: row.claim_token || null,
      expires_at: row.expires_at,
    };
  }

  #countActive() {
    return this.db.prepare(`
      SELECT count(*) AS n FROM gmail_write_ops
      WHERE status IN ('pending','sending','uncertain') AND expires_at > ?
    `).get(this.now()).n;
  }

  stageWrite(proposal, {
    conversation_id = null,
    operator = 'operator',
    account_email = null,
    oauth_mode = null,
    oauth_scope = null,
  } = {}) {
    this.#sweep();
    bindingKey(operator, conversation_id);
    while (this.#countActive() >= MAX_PENDING) {
      const oldest = this.db.prepare(`
        SELECT preview_id FROM gmail_write_ops
        WHERE status IN ('pending','sending','uncertain') AND expires_at > ?
        ORDER BY created_at ASC LIMIT 1
      `).get(this.now());
      if (!oldest) break;
      this.db.prepare(`DELETE FROM gmail_write_ops WHERE preview_id = ? AND status IN ('pending','uncertain')`).run(oldest.preview_id);
      if (this.#countActive() >= MAX_PENDING) break;
      // Do not delete in-flight sending rows to make room.
      break;
    }
    const id = randomUUID();
    const approval_id = proposal.destructive || proposal.sensitive_forward || proposal.bulk_recipients
      ? randomUUID()
      : null;
    const needsApproval = !!approval_id;
    const now = this.now();
    const row = {
      ...proposal,
      // Strip fields we store separately
    };
    delete row.id;
    delete row.preview_id;
    delete row.operation_id;
    delete row.approval_id;
    delete row.approval_status;
    this.db.prepare(`
      INSERT INTO gmail_write_ops(
        preview_id, operation_id, conversation_id, operator, account_email, oauth_mode, oauth_scope,
        approval_id, approval_status, status, proposal_json, receipt_json, claim_token,
        created_at, updated_at, expires_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,NULL,NULL,?,?,?)
    `).run(
      id, id, conversation_id, operator,
      account_email || null, oauth_mode || null, oauth_scope || null,
      approval_id, needsApproval ? 'pending' : 'not_required',
      JSON.stringify(row),
      now, now, now + TTL_MS,
    );
    return { preview_id: id, approval_id, operation_id: id };
  }

  approveWrite(approval_id, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    bindingKey(operator, conversation_id);
    if (typeof approval_id !== 'string' || !UUID.test(approval_id)) {
      const err = Error('Gmail write approval id is invalid or expired.');
      err.code = 'gmail_write_approval_invalid';
      throw err;
    }
    const row = this.db.prepare(`
      SELECT * FROM gmail_write_ops WHERE approval_id = ? AND expires_at > ?
    `).get(approval_id, this.now());
    if (!row) {
      const err = Error('Gmail write approval expired or was not found. Request the action again.');
      err.code = 'gmail_write_approval_expired';
      throw err;
    }
    if (row.conversation_id !== conversation_id || row.operator !== operator) {
      const err = Error('Gmail write approval belongs to a different conversation.');
      err.code = 'gmail_write_approval_forbidden';
      throw err;
    }
    if (row.approval_status === 'not_required') {
      const err = Error('This Gmail preview does not require independent approval.');
      err.code = 'gmail_write_approval_not_required';
      throw err;
    }
    if (row.status === 'completed') {
      return { preview_id: row.preview_id, approval_id: row.approval_id, approval_status: 'approved', status: 'completed' };
    }
    const now = this.now();
    this.db.prepare(`
      UPDATE gmail_write_ops SET approval_status = 'approved', updated_at = ?, expires_at = ?
      WHERE preview_id = ? AND conversation_id = ? AND operator = ?
    `).run(now, now + TTL_MS, row.preview_id, conversation_id, operator);
    return { preview_id: row.preview_id, approval_id: row.approval_id, approval_status: 'approved' };
  }

  peekWrite(id, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    bindingKey(operator, conversation_id);
    if (typeof id !== 'string' || !UUID.test(id)) {
      const err = Error('Gmail write preview expired or invalid.');
      err.code = 'gmail_write_preview_invalid';
      throw err;
    }
    const row = this.db.prepare(`SELECT * FROM gmail_write_ops WHERE preview_id = ?`).get(id);
    if (!row || (row.status !== 'completed' && row.expires_at <= this.now())) {
      const err = Error('Gmail write preview expired. Request the change again.');
      err.code = 'gmail_write_preview_expired';
      throw err;
    }
    if (row.conversation_id !== conversation_id || row.operator !== operator) {
      const err = Error('Gmail write preview belongs to a different conversation.');
      err.code = 'gmail_write_preview_forbidden';
      throw err;
    }
    return this.#rowToProposal(row);
  }

  getCompleted(preview_id, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    if (typeof preview_id !== 'string' || !UUID.test(preview_id)) return null;
    const row = this.db.prepare(`SELECT * FROM gmail_write_ops WHERE preview_id = ? AND status = 'completed'`).get(preview_id);
    if (!row || row.expires_at <= this.now()) return null;
    if (conversation_id != null) {
      bindingKey(operator, conversation_id);
      if (row.conversation_id !== conversation_id || row.operator !== operator) return null;
    }
    try {
      return JSON.parse(row.receipt_json);
    } catch {
      return null;
    }
  }

  /**
   * Atomically claim a preview for provider dispatch.
   * Only one concurrent confirm wins. Uncertain ops require ack_uncertain.
   */
  claimWrite(id, {
    conversation_id = null,
    operator = 'operator',
    account_email = null,
    oauth_mode = null,
    oauth_scope = null,
    ack_uncertain = false,
  } = {}) {
    this.#sweep();
    bindingKey(operator, conversation_id);
    if (typeof id !== 'string' || !UUID.test(id)) {
      const err = Error('Gmail write preview expired or invalid.');
      err.code = 'gmail_write_preview_invalid';
      throw err;
    }

    const existing = this.db.prepare(`SELECT * FROM gmail_write_ops WHERE preview_id = ?`).get(id);
    if (!existing) {
      const err = Error('Gmail write preview expired. Request the change again.');
      err.code = 'gmail_write_preview_expired';
      throw err;
    }
    if (existing.conversation_id !== conversation_id || existing.operator !== operator) {
      const err = Error('Gmail write preview belongs to a different conversation.');
      err.code = 'gmail_write_preview_forbidden';
      throw err;
    }
    if (existing.status === 'completed') {
      return { kind: 'completed', receipt: JSON.parse(existing.receipt_json), row: this.#rowToProposal(existing) };
    }
    if (existing.expires_at <= this.now()) {
      const err = Error('Gmail write preview expired. Request the change again.');
      err.code = 'gmail_write_preview_expired';
      throw err;
    }
    if (existing.status === 'sending') {
      const err = Error('This Gmail write is already in progress. Wait for the provider result; do not confirm again.');
      err.code = 'gmail_write_in_flight';
      throw err;
    }
    if (existing.status === 'uncertain' && !ack_uncertain) {
      const err = Error('Prior Gmail write outcome is uncertain. Verify Sent/mailbox state first, then /gmail confirm <id> --ack-uncertain only if nothing was delivered. Blind retry is refused.');
      err.code = 'gmail_write_uncertain_ack_required';
      throw err;
    }
    if (existing.approval_status !== 'not_required' && existing.approval_status !== 'approved') {
      const err = Error(`This Gmail write requires independent approval first: /gmail approve ${existing.approval_id}.`);
      err.code = 'gmail_write_approval_required';
      err.approval_id = existing.approval_id;
      throw err;
    }
    if (existing.account_email && account_email && existing.account_email !== account_email) {
      const err = Error('Gmail write preview is bound to a different Google account. Re-stage after reconnecting the authorized account.');
      err.code = 'gmail_write_account_mismatch';
      throw err;
    }
    if (existing.oauth_scope && oauth_scope) {
      // Bound scope string must remain compatible — exact mode drift fails closed.
      const needSend = /\bgmail\.send\b/.test(existing.oauth_scope) || existing.oauth_mode === 'send' || existing.oauth_mode === 'manage';
      const needModify = /\bgmail\.modify\b/.test(existing.oauth_scope) || existing.oauth_mode === 'manage';
      if (needModify && !/\bgmail\.modify\b/.test(oauth_scope)) {
        const err = Error('Gmail write preview requires manage (gmail.modify) consent that is no longer present.');
        err.code = 'gmail_write_scope_mismatch';
        throw err;
      }
      if (needSend && !/\bgmail\.send\b/.test(oauth_scope) && !/\bgmail\.modify\b/.test(oauth_scope)) {
        const err = Error('Gmail write preview requires send consent that is no longer present.');
        err.code = 'gmail_write_scope_mismatch';
        throw err;
      }
    }

    const claim_token = randomUUID();
    const now = this.now();
    const fromStatuses = existing.status === 'uncertain' ? "('uncertain')" : "('pending')";
    const result = this.db.prepare(`
      UPDATE gmail_write_ops
      SET status = 'sending',
          claim_token = ?,
          account_email = COALESCE(account_email, ?),
          oauth_mode = COALESCE(oauth_mode, ?),
          oauth_scope = COALESCE(oauth_scope, ?),
          updated_at = ?,
          expires_at = ?
      WHERE preview_id = ?
        AND conversation_id = ?
        AND operator = ?
        AND status IN ${fromStatuses}
        AND approval_status IN ('approved','not_required')
        AND expires_at > ?
    `).run(
      claim_token,
      account_email || null,
      oauth_mode || null,
      oauth_scope || null,
      now,
      now + TTL_MS,
      id,
      conversation_id,
      operator,
      now,
    );

    if (result.changes !== 1) {
      const again = this.db.prepare(`SELECT * FROM gmail_write_ops WHERE preview_id = ?`).get(id);
      if (again?.status === 'completed') {
        return { kind: 'completed', receipt: JSON.parse(again.receipt_json), row: this.#rowToProposal(again) };
      }
      if (again?.status === 'sending') {
        const err = Error('This Gmail write is already in progress. Wait for the provider result; do not confirm again.');
        err.code = 'gmail_write_in_flight';
        throw err;
      }
      const err = Error('Could not claim Gmail write preview (lost race or state changed).');
      err.code = 'gmail_write_claim_failed';
      throw err;
    }

    const claimed = this.db.prepare(`SELECT * FROM gmail_write_ops WHERE preview_id = ? AND claim_token = ?`).get(id, claim_token);
    return { kind: 'claimed', claim_token, row: this.#rowToProposal(claimed) };
  }

  markUncertain(preview_id, claim_token, { conversation_id = null, operator = 'operator' } = {}) {
    bindingKey(operator, conversation_id);
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE gmail_write_ops
      SET status = 'uncertain', claim_token = NULL, updated_at = ?, expires_at = ?
      WHERE preview_id = ?
        AND claim_token = ?
        AND conversation_id = ?
        AND operator = ?
        AND status = 'sending'
    `).run(now, now + TTL_MS, preview_id, claim_token, conversation_id, operator);
    if (result.changes !== 1) {
      const err = Error('Could not mark Gmail write as uncertain (claim mismatch).');
      err.code = 'gmail_write_uncertain_claim_mismatch';
      throw err;
    }
    return { preview_id, status: 'uncertain' };
  }

  markCompleted(preview_id, receipt, {
    conversation_id = null,
    operator = 'operator',
    claim_token = null,
  } = {}) {
    bindingKey(operator, conversation_id);
    const now = this.now();
    const payload = {
      ...receipt,
      host_dedupe: true,
      google_idempotent: false,
      message: (receipt.message || '')
        + ' (host-local replay of a completed Gmail write preview; Google send is not idempotent).',
    };
    let result;
    if (claim_token) {
      result = this.db.prepare(`
        UPDATE gmail_write_ops
        SET status = 'completed', receipt_json = ?, claim_token = NULL, updated_at = ?, expires_at = ?
        WHERE preview_id = ?
          AND claim_token = ?
          AND conversation_id = ?
          AND operator = ?
          AND status = 'sending'
      `).run(JSON.stringify(payload), now, now + TTL_MS, preview_id, claim_token, conversation_id, operator);
    } else {
      // Legacy / test path without claim token — only from pending.
      result = this.db.prepare(`
        UPDATE gmail_write_ops
        SET status = 'completed', receipt_json = ?, claim_token = NULL, updated_at = ?, expires_at = ?
        WHERE preview_id = ?
          AND conversation_id = ?
          AND operator = ?
          AND status IN ('pending','sending')
      `).run(JSON.stringify(payload), now, now + TTL_MS, preview_id, conversation_id, operator);
    }
    if (result.changes !== 1) {
      const err = Error('Could not complete Gmail write (claim mismatch or already settled).');
      err.code = 'gmail_write_complete_failed';
      throw err;
    }
    return payload;
  }

  /** @deprecated use claimWrite — kept for transitional callers */
  commitWrite(id, { conversation_id = null, operator = 'operator' } = {}) {
    const claimed = this.claimWrite(id, { conversation_id, operator });
    if (claimed.kind === 'completed') {
      const err = Error('Gmail write preview already completed.');
      err.code = 'gmail_write_already_completed';
      throw err;
    }
    return claimed.row;
  }

  /** Test/helper: reopen from the same durable db (simulates process restart). */
  static reopen(db, { now } = {}) {
    return new GmailWriteSessions({ db, now });
  }
}

module.exports = { GmailWriteSessions, TTL_MS, bindingKey, UUID, STATUSES };
