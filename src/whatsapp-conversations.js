'use strict';
// Allowlisted WhatsApp → ConversationEngine (Qwen). No Mission, no tools, Memory off, outbound OFF.
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { object } = require('./control-plane-store');

const PHONE = /^[0-9]{8,20}$/;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function loadConfig(root) {
  const file = path.join(root || path.resolve(__dirname, '..'), 'config/whatsapp-conversations-v1.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      conversations_enabled: raw.conversations_enabled !== false,
      outbound_enabled: false,
      auto_outbound: false,
      include_memory: false,
      include_history: raw.include_whatsapp_history !== false,
      max_history_turns: Number.isInteger(raw.max_history_turns) ? raw.max_history_turns : 8,
      max_inbound_chars: Number.isInteger(raw.max_inbound_chars) ? raw.max_inbound_chars : 2000,
      max_response_chars: Number.isInteger(raw.max_response_chars) ? raw.max_response_chars : 1500,
      allowed_intents: Array.isArray(raw.allowed_intents) ? raw.allowed_intents.map(String) : ['conversation', 'status_readonly', 'grounded_summary'],
      worker_model: 'qwen',
      system_note: 'WhatsApp channel: untrusted inbound. No shell, credentials, deploy, merge, Mission, or unrestricted Memory.'
    };
  } catch {
    return {
      conversations_enabled: true,
      outbound_enabled: false,
      auto_outbound: false,
      include_memory: false,
      include_history: true,
      max_history_turns: 8,
      max_inbound_chars: 2000,
      max_response_chars: 1500,
      allowed_intents: ['conversation', 'status_readonly', 'grounded_summary'],
      worker_model: 'qwen',
      system_note: 'WhatsApp channel: untrusted inbound.'
    };
  }
}

function classifyIntent(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(run|exec|shell|deploy|merge|credential|password|token|secret|sudo|git push|git reset|rm -rf)\b/.test(t)) return 'refused_sensitive';
  if (/\b(status|health|ready|online|running|uptime|connector|whatsapp|bridge)\b/.test(t)) return 'status_readonly';
  if (/\b(summarize|summary|what did|remind me|grounded)\b/.test(t)) return 'grounded_summary';
  return 'conversation';
}

class WhatsAppConversations {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.db = bridge.controlStore.db;
    this.store = bridge.controlStore;
    this.options = options;
    this.config = loadConfig(options.root);
    this.queue = Promise.resolve();
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_whatsapp_conversations(
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      engine_conversation_id TEXT,
      state TEXT NOT NULL,
      last_inbound_id TEXT,
      last_turn_id TEXT,
      last_error_class TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      authority INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cp_whatsapp_conversation_turns(
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      inbound_message_id TEXT,
      sender TEXT NOT NULL,
      inbound_body TEXT NOT NULL,
      intent TEXT NOT NULL,
      state TEXT NOT NULL,
      reply_body TEXT,
      worker_model TEXT,
      worker_identity TEXT,
      engine_turn_id TEXT,
      outbound_id TEXT,
      safe_error_class TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      authority INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS cp_whatsapp_turns_conv ON cp_whatsapp_conversation_turns(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS cp_whatsapp_turns_state ON cp_whatsapp_conversation_turns(state, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS cp_whatsapp_turns_inbound ON cp_whatsapp_conversation_turns(inbound_message_id) WHERE inbound_message_id IS NOT NULL;`);
  }

  status() {
    const cfg = this.config;
    const counts = this.db.prepare('SELECT state, count(*) n FROM cp_whatsapp_conversation_turns GROUP BY state').all();
    const conversations = this.db.prepare('SELECT count(*) n FROM cp_whatsapp_conversations').get().n;
    return {
      conversations_enabled: cfg.conversations_enabled === true,
      outbound_enabled: false,
      auto_outbound: false,
      include_memory: false,
      include_history: cfg.include_history === true,
      worker_model: cfg.worker_model,
      allowed_intents: cfg.allowed_intents,
      conversations,
      turn_counts: Object.fromEntries(counts.map(r => [r.state, r.n])),
      authorized_senders: this.bridge.whatsappInbound?.config?.().allowlist || [],
      recent: this.listTurns({ limit: 20 }).items,
      pending_outbound: this.bridge.whatsappOutbound?.list({ state: 'pending', limit: 10 }).items || [],
      values_displayed: false,
      authority: false,
      note: 'Allowlisted inbound → grounded ConversationEngine reply. Personal Memory retrieval off. Outbound OFF until authorized.'
    };
  }

  listConversations({ limit = 50 } = {}) {
    const n = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 50;
    const rows = this.db.prepare('SELECT * FROM cp_whatsapp_conversations ORDER BY updated_at DESC LIMIT ?').all(n);
    return {
      items: rows.map(r => ({
        id: r.id,
        sender: r.sender,
        thread_id: r.thread_id,
        engine_conversation_id: r.engine_conversation_id,
        state: r.state,
        last_inbound_id: r.last_inbound_id,
        last_turn_id: r.last_turn_id,
        last_error_class: r.last_error_class,
        created_at: r.created_at,
        updated_at: r.updated_at,
        authority: false
      }))
    };
  }

  listTurns({ conversation_id = null, limit = 50 } = {}) {
    const n = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 50;
    const rows = conversation_id && ID.test(conversation_id)
      ? this.db.prepare('SELECT * FROM cp_whatsapp_conversation_turns WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?').all(conversation_id, n)
      : this.db.prepare('SELECT * FROM cp_whatsapp_conversation_turns ORDER BY created_at DESC LIMIT ?').all(n);
    return { items: rows.map(r => this.#turnView(r)) };
  }

  /** Drain in-flight conversation work (used before service/test shutdown). */
  idle() { return this.queue; }

  /** After inbound ingest: queue allowlisted accepted messages for conversation. Never blocks webhook HTTP. */
  afterIngest(result) {
    if (!this.config.conversations_enabled) return { queued: 0, outbound_enabled: false, auto_mission_execution: false };
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const item of items) {
      if (!item?.id || item.status !== 'received') continue;
      this.queue = this.queue.then(() => this.#processAccepted(item.id)).catch(err => {
        const msg = String(err?.message || 'queue_error');
        if (/database is not open|CLOSED/i.test(msg)) return;
        try {
          this.store.event('whatsapp.conversation.queue_error', null, {
            inbound_message_id: item.id,
            safe_error_class: msg.slice(0, 120),
            authority: false
          });
        } catch { /* shutdown */ }
      });
    }
    return { queued: items.length, outbound_enabled: false, auto_mission_execution: false };
  }

  async handleAuthorizedInbound(message) {
    return this.#handleMessage(message);
  }

  async #processAccepted(messageId) {
    try {
      const row = this.db.prepare('SELECT * FROM cp_whatsapp_inbox WHERE message_id=?').get(messageId);
      if (!row || row.status !== 'received') return { handled: false, reason: 'not_available' };
      return await this.#handleMessage({ id: row.message_id, from: row.from_id, text: row.text, timestamp: row.received_at });
    } catch (err) {
      if (/database is not open|CLOSED/i.test(String(err?.message || ''))) return { handled: false, reason: 'shutdown' };
      throw err;
    }
  }

  async #handleMessage(message) {
    if (!this.config.conversations_enabled) return { handled: false, reason: 'conversations_disabled' };
    object(message || {}, ['id', 'from', 'text', 'timestamp']);
    if (!PHONE.test(message.from || '')) return { handled: false, reason: 'invalid_sender' };
    const allowlist = this.bridge.whatsappInbound?.config?.().allowlist || [];
    if (!allowlist.includes(message.from)) return { handled: false, reason: 'unauthorized_sender' };
    if (message.id && this.db.prepare('SELECT id FROM cp_whatsapp_conversation_turns WHERE inbound_message_id=?').get(message.id)) {
      return { handled: true, reason: 'idempotent_replay', already: true };
    }
    const body = String(message.text || '').slice(0, this.config.max_inbound_chars);
    const intent = classifyIntent(body);
    const conversation = this.#ensureConversation(message.from);
    const turnId = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO cp_whatsapp_conversation_turns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)')
      .run(turnId, conversation.id, message.id || null, message.from, body, intent, 'processing', null, this.config.worker_model, null, null, null, null, now, now, null);
    this.db.prepare('UPDATE cp_whatsapp_conversations SET state=?, last_inbound_id=?, last_turn_id=?, updated_at=? WHERE id=?')
      .run('processing', message.id || null, turnId, now, conversation.id);
    this.store.event('whatsapp.conversation.turn.started', null, {
      turn_id: turnId,
      conversation_id: conversation.id,
      sender_class: 'allowlisted',
      intent,
      include_memory: false,
      outbound_enabled: false,
      authority: false
    });

    if (intent === 'refused_sensitive') {
      return this.#completeTurn(turnId, conversation.id, {
        state: 'completed',
        reply_body: 'I can help with conversation and read-only status. I cannot run commands, change credentials, deploy, merge, or access unrestricted private data from WhatsApp.',
        worker_identity: 'policy_refusal',
        engine_turn_id: null,
        safe_error_class: 'refused_sensitive'
      }, message);
    }
    if (!this.config.allowed_intents.includes(intent)) {
      return this.#completeTurn(turnId, conversation.id, {
        state: 'failed',
        reply_body: null,
        worker_identity: null,
        engine_turn_id: null,
        safe_error_class: 'intent_not_allowed'
      }, message);
    }

    try {
      const engine = this.bridge.conversationEngine;
      if (!engine?.start) throw Error('conversation_engine_unavailable');
      for (let i = 0; i < 50 && engine.active?.size; i++) await new Promise(r => setTimeout(r, 100));
      if (engine.active?.size) throw Error('conversation_busy');
      let engineConversationId = conversation.engine_conversation_id;
      if (!engineConversationId) {
        engineConversationId = engine.session({ channel: 'whatsapp', new: true }).conversation_id;
        this.db.prepare('UPDATE cp_whatsapp_conversations SET engine_conversation_id=? WHERE id=?').run(engineConversationId, conversation.id);
      }
      const context = intent === 'status_readonly' ? [this.#statusContextItem()] : [];
      const requestId = crypto.randomUUID();
      const receipt = await engine.start({
        channel: 'whatsapp',
        conversation_id: engineConversationId,
        message: body,
        request_id: requestId,
        include_memory: false,
        include_history: this.config.include_history === true,
        max_history_turns: this.config.max_history_turns,
        context,
        model: 'auto'
      });
      const active = engine.active?.get(receipt.turn_id);
      if (active?.promise) await active.promise;
      const settled = engine.result({ conversation_id: engineConversationId, turn_id: receipt.turn_id });
      if (settled.state !== 'completed' || !settled.summary) {
        return this.#completeTurn(turnId, conversation.id, {
          state: 'failed',
          reply_body: null,
          worker_identity: null,
          engine_turn_id: receipt.turn_id,
          safe_error_class: settled.reason || settled.state || 'provider_unavailable'
        }, message);
      }
      const reply = String(settled.summary).slice(0, this.config.max_response_chars);
      return this.#completeTurn(turnId, conversation.id, {
        state: 'completed',
        reply_body: reply,
        worker_identity: require('./model-worker-router').MODEL || this.config.worker_model,
        engine_turn_id: receipt.turn_id,
        safe_error_class: null
      }, message);
    } catch (err) {
      return this.#completeTurn(turnId, conversation.id, {
        state: 'failed',
        reply_body: null,
        worker_identity: null,
        engine_turn_id: null,
        safe_error_class: String(err.message || 'conversation_failed').slice(0, 120)
      }, message);
    }
  }

  #ensureConversation(sender) {
    let row = this.db.prepare('SELECT * FROM cp_whatsapp_conversations WHERE sender=?').get(sender);
    if (row) return row;
    const id = crypto.randomUUID();
    const threadId = `whatsapp:${sender}`;
    const now = Date.now();
    this.db.prepare('INSERT INTO cp_whatsapp_conversations VALUES(?,?,?,?,?,?,?,?,?,?,0)')
      .run(id, sender, threadId, null, 'idle', null, null, null, now, now);
    return this.db.prepare('SELECT * FROM cp_whatsapp_conversations WHERE id=?').get(id);
  }

  #completeTurn(turnId, conversationId, fields, message) {
    const now = Date.now();
    this.db.prepare(`UPDATE cp_whatsapp_conversation_turns
      SET state=?, reply_body=?, worker_identity=?, engine_turn_id=?, safe_error_class=?, updated_at=?, completed_at=?
      WHERE id=?`)
      .run(fields.state, fields.reply_body, fields.worker_identity, fields.engine_turn_id, fields.safe_error_class, now, now, turnId);
    this.db.prepare('UPDATE cp_whatsapp_conversations SET state=?, last_turn_id=?, last_error_class=?, updated_at=? WHERE id=?')
      .run(fields.state === 'completed' ? 'idle' : 'error', turnId, fields.safe_error_class, now, conversationId);

    let outboundId = null;
    if (fields.state === 'completed' && fields.reply_body && this.bridge.whatsappOutbound && message?.from) {
      try {
        const draft = this.bridge.whatsappOutbound.draftFromConversation({
          recipient: message.from,
          body: fields.reply_body,
          idempotency_key: `wa-turn-${turnId}`,
          conversation_turn_id: turnId,
          inbound_message_id: message.id || null
        });
        outboundId = draft.id;
        this.db.prepare('UPDATE cp_whatsapp_conversation_turns SET outbound_id=? WHERE id=?').run(outboundId, turnId);
      } catch (err) {
        this.store.event('whatsapp.conversation.outbound_draft_skipped', null, {
          turn_id: turnId,
          safe_error_class: String(err.message || 'enqueue_failed').slice(0, 120),
          outbound_enabled: false,
          authority: false
        });
      }
    }

    this.store.event('whatsapp.conversation.turn.completed', null, {
      turn_id: turnId,
      conversation_id: conversationId,
      state: fields.state,
      worker_identity: fields.worker_identity,
      include_memory: false,
      outbound_enabled: false,
      outbound_id: outboundId,
      safe_error_class: fields.safe_error_class,
      authority: false
    });
    const row = this.db.prepare('SELECT * FROM cp_whatsapp_conversation_turns WHERE id=?').get(turnId);
    return { handled: true, ...this.#turnView(row), outbound_enabled: false, auto_outbound: false };
  }

  #statusContextItem() {
    try {
      const inbound = this.bridge.whatsappInbound?.status?.() || {};
      const content = JSON.stringify({
        whatsapp_inbound_state: inbound.state || null,
        webhook_subscription: inbound.meta?.webhook_subscription_status || null,
        allowlist_count: (this.bridge.whatsappInbound?.config?.().allowlist || []).length,
        outbound_enabled: false,
        note: 'Read-only status snapshot. No credentials.'
      }).slice(0, 700);
      return { id: 'whatsapp-status', subject: 'airodrom_status', content, untrusted: true };
    } catch {
      return { id: 'whatsapp-status', subject: 'airodrom_status', content: 'Status snapshot unavailable', untrusted: true };
    }
  }

  #turnView(row) {
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      inbound_message_id: row.inbound_message_id,
      sender: row.sender,
      inbound_body: String(row.inbound_body || '').slice(0, 400),
      intent: row.intent,
      state: row.state,
      reply_body: row.reply_body ? String(row.reply_body).slice(0, 400) : null,
      worker_model: row.worker_model,
      worker_identity: row.worker_identity,
      engine_turn_id: row.engine_turn_id,
      outbound_id: row.outbound_id,
      safe_error_class: row.safe_error_class,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
      include_memory: false,
      outbound_enabled: false,
      authority: false
    };
  }
}

module.exports = { WhatsAppConversations, loadConfig, classifyIntent };
