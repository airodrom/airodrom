'use strict';
// Operator- and conversation-bound Gmail write previews.
// Durable operation IDs prevent duplicate sends on uncertain retries.
const { randomUUID } = require('node:crypto');

const TTL_MS = 15 * 60 * 1000;
const MAX_PENDING = 16;
const MAX_COMPLETED = 64;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

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

class GmailWriteSessions {
  #pending = new Map();
  /** preview_id → completed send/draft receipt (host-local dedupe; not Google idempotency) */
  #completed = new Map();

  #sweep(now = Date.now()) {
    for (const [id, row] of this.#pending) {
      if (row.expires_at <= now) this.#pending.delete(id);
    }
    for (const [id, row] of this.#completed) {
      if (row.expires_at <= now) this.#completed.delete(id);
    }
    while (this.#completed.size > MAX_COMPLETED) {
      const oldest = this.#completed.keys().next().value;
      this.#completed.delete(oldest);
    }
  }

  stageWrite(proposal, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const key = bindingKey(operator, conversation_id);
    while (this.#pending.size >= MAX_PENDING) {
      const oldest = this.#pending.keys().next().value;
      this.#pending.delete(oldest);
    }
    const id = randomUUID();
    const approval_id = proposal.destructive || proposal.sensitive_forward || proposal.bulk_recipients
      ? randomUUID()
      : null;
    const needsApproval = !!approval_id;
    const row = {
      ...proposal,
      id,
      operation_id: id,
      approval_id,
      approval_status: needsApproval ? 'pending' : 'not_required',
      conversation_id,
      operator,
      binding_key: key,
      expires_at: Date.now() + TTL_MS,
    };
    this.#pending.set(id, row);
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
    for (const row of this.#pending.values()) {
      if (row.approval_id !== approval_id) continue;
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
      row.approval_status = 'approved';
      row.expires_at = Date.now() + TTL_MS;
      return { preview_id: row.id, approval_id: row.approval_id, approval_status: 'approved' };
    }
    const err = Error('Gmail write approval expired or was not found. Request the action again.');
    err.code = 'gmail_write_approval_expired';
    throw err;
  }

  peekWrite(id, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    bindingKey(operator, conversation_id);
    if (typeof id !== 'string' || !UUID.test(id)) {
      const err = Error('Gmail write preview expired or invalid.');
      err.code = 'gmail_write_preview_invalid';
      throw err;
    }
    const row = this.#pending.get(id);
    if (!row) {
      const err = Error('Gmail write preview expired. Request the change again.');
      err.code = 'gmail_write_preview_expired';
      throw err;
    }
    if (row.conversation_id !== conversation_id || row.operator !== operator) {
      const err = Error('Gmail write preview belongs to a different conversation.');
      err.code = 'gmail_write_preview_forbidden';
      throw err;
    }
    return row;
  }

  commitWrite(id, { conversation_id = null, operator = 'operator' } = {}) {
    const row = this.peekWrite(id, { conversation_id, operator });
    this.#pending.delete(id);
    return row;
  }

  getCompleted(preview_id, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const row = this.#completed.get(preview_id);
    if (!row || row.expires_at <= Date.now()) {
      this.#completed.delete(preview_id);
      return null;
    }
    if (conversation_id != null) {
      bindingKey(operator, conversation_id);
      if (row.conversation_id !== conversation_id || row.operator !== operator) return null;
    }
    return row.receipt;
  }

  markCompleted(preview_id, receipt, { conversation_id = null, operator = 'operator' } = {}) {
    bindingKey(operator, conversation_id);
    this.#completed.set(preview_id, {
      receipt: {
        ...receipt,
        host_dedupe: true,
        google_idempotent: false,
        message: (receipt.message || '')
          + ' (host-local replay of a completed Gmail write preview; Google send is not idempotent).',
      },
      conversation_id,
      operator,
      expires_at: Date.now() + TTL_MS,
    });
  }
}

module.exports = { GmailWriteSessions, TTL_MS, bindingKey, UUID };
