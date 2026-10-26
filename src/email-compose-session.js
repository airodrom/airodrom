'use strict';
// Conversation-bound local email drafts. Separate from Gmail provider state.
const { randomUUID } = require('node:crypto');

const TTL_MS = 30 * 60 * 1000;
const MAX_DRAFTS = 32;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function bindingKey(operator, conversation_id) {
  if (operator !== 'operator') {
    const err = Error('Email compose sessions are operator-local only');
    err.code = 'email_compose_forbidden';
    throw err;
  }
  if (typeof conversation_id !== 'string' || !UUID.test(conversation_id)) {
    const err = Error('Email compose requires an authenticated Terminal conversation session.');
    err.code = 'email_compose_session_required';
    throw err;
  }
  return operator + '\0' + conversation_id;
}

class EmailComposeSessions {
  #drafts = new Map();

  #sweep(now = Date.now()) {
    for (const [key, row] of this.#drafts) {
      if (row.expires_at <= now) this.#drafts.delete(key);
    }
    while (this.#drafts.size > MAX_DRAFTS) {
      const oldest = this.#drafts.keys().next().value;
      this.#drafts.delete(oldest);
    }
  }

  hasActive({ conversation_id = null, operator = 'operator' } = {}) {
    try {
      return !!this.get({ conversation_id, operator });
    } catch {
      return false;
    }
  }

  get({ conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const key = bindingKey(operator, conversation_id);
    const row = this.#drafts.get(key);
    if (!row || row.expires_at <= Date.now()) {
      this.#drafts.delete(key);
      return null;
    }
    if (row.conversation_id !== conversation_id || row.operator !== operator) {
      this.#drafts.delete(key);
      return null;
    }
    return row;
  }

  put(draft, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const key = bindingKey(operator, conversation_id);
    const row = {
      ...draft,
      id: draft.id || randomUUID(),
      conversation_id,
      operator,
      local_only: true,
      gmail_saved: false,
      gmail_sent: false,
      expires_at: Date.now() + TTL_MS,
    };
    this.#drafts.set(key, row);
    return row;
  }

  clear({ conversation_id = null, operator = 'operator' } = {}) {
    try {
      this.#drafts.delete(bindingKey(operator, conversation_id));
    } catch { /* */ }
  }
}

module.exports = { EmailComposeSessions, TTL_MS, bindingKey, UUID };
