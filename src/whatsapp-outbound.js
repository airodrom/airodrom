'use strict';
// Governed WhatsApp Cloud API outbound. Hard OFF for send. Drafts may queue for approval.
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { object, text } = require('./control-plane-store');
const { transaction } = require('./control-transaction');

const PHONE = /^[0-9]{8,20}$/;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function loadDefaults(root) {
  const file = path.join(root || path.resolve(__dirname, '..'), 'config/whatsapp-conversations-v1.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      outbound_enabled: false,
      auto_outbound: false,
      rate_limit_per_sender_per_hour: Number.isInteger(raw.rate_limit_per_sender_per_hour) ? raw.rate_limit_per_sender_per_hour : 30,
      max_response_chars: Number.isInteger(raw.max_response_chars) ? raw.max_response_chars : 1500
    };
  } catch {
    return { outbound_enabled: false, auto_outbound: false, rate_limit_per_sender_per_hour: 30, max_response_chars: 1500 };
  }
}

class WhatsAppOutbound {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.db = bridge.controlStore.db;
    this.store = bridge.controlStore;
    this.options = options;
    this.defaults = loadDefaults(options.root);
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_whatsapp_outbound(
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      conversation_turn_id TEXT,
      inbound_message_id TEXT,
      provider_message_id TEXT,
      safe_error_class TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      authorized_at INTEGER,
      sent_at INTEGER,
      authority INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS cp_whatsapp_outbound_state ON cp_whatsapp_outbound(state, updated_at);
    CREATE INDEX IF NOT EXISTS cp_whatsapp_outbound_recipient ON cp_whatsapp_outbound(recipient, created_at);`);
  }

  status() {
    const counts = this.db.prepare('SELECT state, count(*) n FROM cp_whatsapp_outbound GROUP BY state').all();
    return {
      outbound_enabled: false,
      auto_outbound: false,
      configured_flag: false,
      activation: 'off_until_operator_authorization',
      counts: Object.fromEntries(counts.map(r => [r.state, r.n])),
      pending: this.list({ state: 'pending', limit: 20 }).items,
      recent: this.list({ limit: 20 }).items,
      rate_limit_per_sender_per_hour: this.defaults.rate_limit_per_sender_per_hour,
      values_displayed: false,
      note: 'Outbound Cloud API sends remain unavailable until separately authorized. Pending drafts never auto-send.'
    };
  }

  list({ state = null, limit = 50 } = {}) {
    const n = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 50;
    const rows = state
      ? this.db.prepare('SELECT * FROM cp_whatsapp_outbound WHERE state=? ORDER BY created_at DESC LIMIT ?').all(state, n)
      : this.db.prepare('SELECT * FROM cp_whatsapp_outbound ORDER BY created_at DESC LIMIT ?').all(n);
    return { items: rows.map(r => this.#view(r)) };
  }

  /** System draft from an allowlisted conversation turn. Never sends. */
  draftFromConversation(input = {}) {
    object(input, ['recipient', 'body', 'idempotency_key', 'conversation_turn_id', 'inbound_message_id']);
    if (!PHONE.test(input.recipient || '')) throw Error('Allowlisted numeric recipient required');
    const allowlist = this.bridge.whatsappInbound?.config?.().allowlist || [];
    if (!allowlist.includes(input.recipient)) throw Error('Recipient is not on the WhatsApp sender allowlist');
    text(input.body, 'outbound body', this.defaults.max_response_chars);
    if (require('./assistant-intent').secret(input.body) || require('./provider-policy').secretLike(input.body)) {
      throw Error('Secret-like outbound body refused');
    }
    const key = String(input.idempotency_key || '');
    if (!ID.test(key)) throw Error('Idempotency key required');
    const existing = this.db.prepare('SELECT * FROM cp_whatsapp_outbound WHERE idempotency_key=?').get(key);
    if (existing) return this.#view(existing);
    const hourAgo = Date.now() - 3600000;
    const recent = this.db.prepare('SELECT count(*) n FROM cp_whatsapp_outbound WHERE recipient=? AND created_at>?').get(input.recipient, hourAgo).n;
    if (recent >= this.defaults.rate_limit_per_sender_per_hour) throw Error('Outbound rate limit reached for recipient');
    const id = crypto.randomUUID(), now = Date.now();
    this.db.prepare('INSERT INTO cp_whatsapp_outbound VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)')
      .run(id, input.recipient, input.body, 'pending', key, input.conversation_turn_id || null, input.inbound_message_id || null, null, null, now, now, null, null);
    this.store.event('whatsapp.outbound.drafted', null, {
      outbound_id: id,
      recipient_class: 'allowlisted',
      auto_outbound: false,
      outbound_enabled: false,
      authority: false
    });
    return this.#view(this.db.prepare('SELECT * FROM cp_whatsapp_outbound WHERE id=?').get(id));
  }

  enqueue(input = {}, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may enqueue WhatsApp outbound');
    object(input, ['recipient', 'body', 'idempotency_key', 'conversation_turn_id', 'inbound_message_id', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required to enqueue outbound');
    return this.draftFromConversation({
      recipient: input.recipient,
      body: input.body,
      idempotency_key: input.idempotency_key,
      conversation_turn_id: input.conversation_turn_id,
      inbound_message_id: input.inbound_message_id
    });
  }

  authorize(input = {}, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may authorize WhatsApp outbound');
    object(input, ['id', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (!ID.test(input.id || '')) throw Error('Outbound id required');
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM cp_whatsapp_outbound WHERE id=?').get(input.id);
      if (!row) throw Error('Outbound draft not found');
      if (row.state !== 'pending') throw Error('Outbound draft is not pending');
      const now = Date.now();
      this.db.prepare("UPDATE cp_whatsapp_outbound SET state='authorized', authorized_at=?, updated_at=? WHERE id=?").run(now, now, row.id);
      this.store.event('whatsapp.outbound.authorized', null, { outbound_id: row.id, outbound_enabled: false, authority: false });
      return this.#view(this.db.prepare('SELECT * FROM cp_whatsapp_outbound WHERE id=?').get(row.id));
    });
  }

  async send(input = {}, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may send WhatsApp outbound');
    object(input, ['id', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    throw Error('WhatsApp outbound sending is unavailable until separately authorized. Draft authorization does not send.');
  }

  cancel(input = {}, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may cancel WhatsApp outbound');
    object(input, ['id', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    const row = this.db.prepare('SELECT * FROM cp_whatsapp_outbound WHERE id=?').get(input.id);
    if (!row) throw Error('Outbound draft not found');
    if (!['pending', 'authorized'].includes(row.state)) throw Error('Outbound draft cannot be cancelled');
    const now = Date.now();
    this.db.prepare("UPDATE cp_whatsapp_outbound SET state='cancelled', updated_at=?, safe_error_class='cancelled' WHERE id=?").run(now, row.id);
    this.store.event('whatsapp.outbound.cancelled', null, { outbound_id: row.id, authority: false });
    return this.#view(this.db.prepare('SELECT * FROM cp_whatsapp_outbound WHERE id=?').get(row.id));
  }

  #view(row) {
    return {
      id: row.id,
      recipient: row.recipient,
      body: String(row.body || '').slice(0, 400),
      state: row.state,
      idempotency_key: row.idempotency_key,
      conversation_turn_id: row.conversation_turn_id,
      inbound_message_id: row.inbound_message_id,
      provider_message_id: row.provider_message_id,
      safe_error_class: row.safe_error_class,
      created_at: row.created_at,
      updated_at: row.updated_at,
      authorized_at: row.authorized_at,
      sent_at: row.sent_at,
      outbound_enabled: false,
      delivery_status: row.state === 'sent' ? 'sent' : row.state,
      authority: false
    };
  }
}

module.exports = { WhatsAppOutbound, loadDefaults };
