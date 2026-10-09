'use strict';
const crypto = require('node:crypto');
const { object, text, identifier } = require('./control-plane-store');
const { transaction } = require('./control-transaction');
const { officialInbound } = require('./assistant-connectors');

const PHONE = /^[0-9]{8,20}$/;
const MSG_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

// Host-owned official WhatsApp Business inbound. Messages are untrusted data.
// They never grant authority or auto-dispatch Missions.
class WhatsAppInbound {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.store = bridge.controlStore;
    this.db = this.store.db;
    this.options = options;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_whatsapp_inbound_config(
      id INTEGER PRIMARY KEY CHECK(id=1),
      enabled INTEGER NOT NULL,
      verify_token_reference TEXT,
      app_secret_reference TEXT,
      allowlist TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    );
    INSERT OR IGNORE INTO cp_whatsapp_inbound_config VALUES(1,0,NULL,NULL,'[]',0,'system');
    CREATE TABLE IF NOT EXISTS cp_whatsapp_inbox(
      message_id TEXT PRIMARY KEY,
      from_id TEXT,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      duplicate INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      authority INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cp_whatsapp_message_status(
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      observed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cp_whatsapp_inbox_received ON cp_whatsapp_inbox(received_at DESC, message_id);`);
  }

  config() {
    const row = this.db.prepare('SELECT * FROM cp_whatsapp_inbound_config WHERE id=1').get();
    return {
      enabled: row?.enabled === 1,
      verify_token_bound: Boolean(row?.verify_token_reference) || typeof this.options.verifyToken === 'string',
      app_secret_bound: Boolean(row?.app_secret_reference) || typeof this.options.appSecret === 'string',
      allowlist: JSON.parse(row?.allowlist || '[]'),
      updated_at: row?.updated_at || null,
      updated_by: row?.updated_by || null,
      public_ingress: false,
      auto_mission_execution: false
    };
  }

  configure(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may configure WhatsApp inbound');
    object(input, ['enabled', 'confirmed', 'verify_token_reference', 'app_secret_reference', 'allowlist', 'verify_token', 'app_secret']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (typeof input.enabled !== 'boolean') throw Error('enabled must be boolean');
    let allowlist = this.config().allowlist;
    if (input.allowlist !== undefined) {
      if (!Array.isArray(input.allowlist) || input.allowlist.length > 50 || input.allowlist.some(v => typeof v !== 'string' || !PHONE.test(v))) {
        throw Error('Allowlist requires up to 50 numeric sender IDs');
      }
      allowlist = [...new Set(input.allowlist)];
    }
    if (input.verify_token !== undefined) {
      text(input.verify_token, 'verify token', 200);
      this.options.verifyToken = input.verify_token;
    }
    if (input.app_secret !== undefined) {
      text(input.app_secret, 'app secret', 200);
      this.options.appSecret = input.app_secret;
    }
    const row = this.db.prepare('SELECT * FROM cp_whatsapp_inbound_config WHERE id=1').get();
    const verifyRef = input.verify_token_reference !== undefined ? input.verify_token_reference : row.verify_token_reference;
    const secretRef = input.app_secret_reference !== undefined ? input.app_secret_reference : row.app_secret_reference;
    for (const ref of [verifyRef, secretRef]) if (ref != null && (typeof ref !== 'string' || !/^[A-Za-z0-9_.:-]{8,200}$/.test(ref))) throw Error('Invalid vault reference');
    this.db.prepare('UPDATE cp_whatsapp_inbound_config SET enabled=?, verify_token_reference=?, app_secret_reference=?, allowlist=?, updated_at=?, updated_by=? WHERE id=1')
      .run(input.enabled ? 1 : 0, verifyRef, secretRef, JSON.stringify(allowlist), Date.now(), actor);
    this.store.event(input.enabled ? 'whatsapp.inbound.enabled' : 'whatsapp.inbound.disabled', null, {
      allowlist_count: allowlist.length,
      verify_token_bound: Boolean(verifyRef) || Boolean(this.options.verifyToken),
      app_secret_bound: Boolean(secretRef) || Boolean(this.options.appSecret)
    });
    return this.status();
  }

  #resolve(kind) {
    if (kind === 'verify') {
      if (typeof this.options.verifyToken === 'string' && this.options.verifyToken) return this.options.verifyToken;
      const ref = this.db.prepare('SELECT verify_token_reference FROM cp_whatsapp_inbound_config WHERE id=1').get()?.verify_token_reference;
      if (!ref) throw Error('WhatsApp verify token is not configured');
      return this.#vault(ref);
    }
    if (typeof this.options.appSecret === 'string' && this.options.appSecret) return this.options.appSecret;
    const ref = this.db.prepare('SELECT app_secret_reference FROM cp_whatsapp_inbound_config WHERE id=1').get()?.app_secret_reference;
    if (!ref) throw Error('WhatsApp app secret is not configured');
    return this.#vault(ref);
  }

  #vault(reference) {
    const vault = this.options.vault || (this.bridge.dataDir ? new (require('./secret-vault').SecretVault)(this.bridge.dataDir) : null);
    if (!vault) throw Error('Secret Vault unavailable for WhatsApp inbound');
    return vault.resolve(reference, 'whatsapp');
  }

  status() {
    const cfg = this.config();
    const counts = this.db.prepare("SELECT status, count(*) n FROM cp_whatsapp_inbox GROUP BY status").all();
    return {
      connector: 'whatsapp',
      protocol: 'WhatsApp Business Cloud API',
      state: cfg.enabled && cfg.verify_token_bound && cfg.app_secret_bound ? 'configured' : cfg.enabled ? 'incomplete' : 'disabled',
      ...cfg,
      inbox: Object.fromEntries(counts.map(r => [r.status, r.n])),
      recent: this.list({ limit: 10 }).items,
      retained: this.db.prepare('SELECT count(*) n FROM cp_whatsapp_inbox').get().n,
      authority: false,
      auto_mission_execution: false,
      note: 'Inbound text is untrusted. No Mission is dispatched from webhook receipt.'
    };
  }

  challenge(query = {}) {
    const cfg = this.config();
    if (!cfg.enabled) throw Error('WhatsApp inbound is disabled');
    if (query['hub.mode'] !== 'subscribe') throw Error('Invalid verification mode');
    const token = this.#resolve('verify');
    const provided = Buffer.from(String(query['hub.verify_token'] || ''));
    const expected = Buffer.from(token);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) throw Error('Invalid verification token');
    const challenge = String(query['hub.challenge'] || '');
    if (!/^[0-9A-Za-z_-]{1,256}$/.test(challenge)) throw Error('Invalid challenge');
    this.store.event('whatsapp.inbound.challenge_ok', null, { authority: false });
    return challenge;
  }

  ingest(raw, signatureHeader) {
    const cfg = this.config();
    if (!cfg.enabled) throw Error('WhatsApp inbound is disabled');
    if (!Buffer.isBuffer(raw)) throw Error('Raw body required');
    const appSecret = this.#resolve('secret');
    const parsed = this.#parse(raw, signatureHeader, appSecret);
    return transaction(this.db, () => {
      const accepted = [];
      const rejected = [];
      for (const message of parsed.messages) {
        const existing = this.db.prepare('SELECT message_id, status FROM cp_whatsapp_inbox WHERE message_id=?').get(message.id);
        if (existing) {
          rejected.push({ id: message.id, reason: 'duplicate' });
          this.store.event('whatsapp.inbound.duplicate', null, { message_id: message.id });
          continue;
        }
        if (cfg.allowlist.length && (!message.from || !cfg.allowlist.includes(message.from))) {
          this.db.prepare('INSERT INTO cp_whatsapp_inbox VALUES(?,?,?,?,?,?,?,0)')
            .run(message.id, message.from, message.text, 'unauthorized_sender', message.payload_hash, 0, Date.now());
          rejected.push({ id: message.id, reason: 'unauthorized_sender' });
          this.store.event('whatsapp.inbound.unauthorized_sender', null, { message_id: message.id });
          continue;
        }
        this.db.prepare('INSERT INTO cp_whatsapp_inbox VALUES(?,?,?,?,?,?,?,0)')
          .run(message.id, message.from, message.text, 'received', message.payload_hash, 0, Date.now());
        accepted.push({ id: message.id, from: message.from, status: 'received' });
        this.store.event('whatsapp.inbound.received', null, { message_id: message.id, authority: false, auto_mission: false });
      }
      for (const status of parsed.statuses) {
        const id = crypto.randomUUID();
        this.db.prepare('INSERT INTO cp_whatsapp_message_status VALUES(?,?,?,?)').run(id, status.id, status.status, Date.now());
        this.store.event('whatsapp.inbound.status', null, { message_id: status.id, status: status.status });
      }
      return {
        accepted: accepted.length,
        rejected: rejected.length,
        statuses: parsed.statuses.length,
        items: accepted,
        rejections: rejected,
        auto_mission_execution: false,
        authority: false
      };
    });
  }

  #parse(raw, signatureHeader, appSecret) {
    // Reuse HMAC boundary; enrich with sender and delivery statuses.
    const messages = officialInbound(raw, signatureHeader, appSecret).map(m => ({ ...m, from: null, payload_hash: null }));
    const data = JSON.parse(raw.toString('utf8'));
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const enriched = [];
    const statuses = [];
    for (const entry of data.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const m of value.messages || []) {
          if (m.type !== 'text' || !MSG_ID.test(m.id || '')) continue;
          const from = PHONE.test(String(m.from || '')) ? String(m.from) : null;
          const base = messages.find(x => x.id === m.id) || { id: m.id, text: '[Sensitive content withheld]' };
          enriched.push({ id: m.id, from, text: base.text, payload_hash: hash });
          if (enriched.length > 20) throw Error('Webhook bound exceeded');
        }
        for (const s of value.statuses || []) {
          if (!MSG_ID.test(s.id || '') || typeof s.status !== 'string' || !/^[a-z_]{2,40}$/.test(s.status)) continue;
          statuses.push({ id: s.id, status: s.status });
          if (statuses.length > 40) throw Error('Status bound exceeded');
        }
      }
    }
    return { messages: enriched.length ? enriched : messages.map(m => ({ ...m, from: null, payload_hash: hash })), statuses };
  }

  list({ limit = 50, status = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid inbox page');
    if (status != null && !['received', 'duplicate', 'unauthorized_sender'].includes(status)) throw Error('Invalid inbox status');
    const rows = status
      ? this.db.prepare('SELECT message_id, from_id, text, status, received_at, duplicate FROM cp_whatsapp_inbox WHERE status=? ORDER BY received_at DESC, message_id LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT message_id, from_id, text, status, received_at, duplicate FROM cp_whatsapp_inbox ORDER BY received_at DESC, message_id LIMIT ?').all(limit);
    return {
      items: rows.map(r => ({
        id: r.message_id,
        from: r.from_id,
        content: r.text,
        status: r.status,
        received_at: r.received_at,
        duplicate: r.duplicate === 1,
        untrusted: true,
        authority: false
      })),
      auto_mission_execution: false
    };
  }

  read({ id = null, query = null, limit = 10 } = {}) {
    if (id) {
      identifier(id);
      const row = this.db.prepare("SELECT message_id AS id, text FROM cp_whatsapp_inbox WHERE message_id=? AND status='received'").get(id);
      return row ? [{ id: row.id, text: row.text }] : [];
    }
    let rows = this.db.prepare("SELECT message_id AS id, text FROM cp_whatsapp_inbox WHERE status='received' ORDER BY received_at DESC LIMIT ?").all(limit);
    if (query) {
      text(query, 'query', 200);
      const q = query.toLowerCase();
      rows = rows.filter(r => r.text.toLowerCase().includes(q));
    }
    return rows.map(r => ({ id: r.id, text: r.text }));
  }

  statuses({ message_id = null, limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid status page');
    if (message_id != null) {
      if (!MSG_ID.test(message_id)) throw Error('Invalid message id');
      return {
        items: this.db.prepare('SELECT message_id, status, observed_at FROM cp_whatsapp_message_status WHERE message_id=? ORDER BY observed_at DESC LIMIT ?').all(message_id, limit)
      };
    }
    return {
      items: this.db.prepare('SELECT message_id, status, observed_at FROM cp_whatsapp_message_status ORDER BY observed_at DESC LIMIT ?').all(limit)
    };
  }
}

async function readRaw(req, max = 512_000) {
  const chunks = []; let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > max) throw Error('Request too large');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

function whatsappSource(bridge) {
  if (!bridge?.whatsappInbound) return {};
  return {
    whatsapp: {
      read: async ({ id, query, limit = 10 } = {}) => bridge.whatsappInbound.read({ id, query, limit })
    }
  };
}

module.exports = { WhatsAppInbound, readRaw, PHONE, whatsappSource };
