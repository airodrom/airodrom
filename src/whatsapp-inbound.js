'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { object, text, identifier } = require('./control-plane-store');
const { transaction } = require('./control-transaction');
const { officialInbound } = require('./assistant-connectors');

const PHONE = /^[0-9]{8,20}$/;
const MSG_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const META_ID = /^[0-9]{5,32}$/;
const PUBLICATION = new Set(['unknown', 'development', 'live']);
const WEBHOOK_SUB = new Set(['inactive', 'pending', 'active']);
const MAX_BODY = 512_000;

function loadMetaDefaults(root) {
  const file = path.join(root || path.resolve(__dirname, '..'), 'config/whatsapp-inbound-v1.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.version !== 1) throw Error('Unsupported WhatsApp inbound config');
    return {
      meta_app_id: typeof raw.meta_app_id === 'string' && META_ID.test(raw.meta_app_id) ? raw.meta_app_id : null,
      business_portfolio_id: typeof raw.business_portfolio_id === 'string' && META_ID.test(raw.business_portfolio_id) ? raw.business_portfolio_id : null,
      waba_id: typeof raw.waba_id === 'string' && META_ID.test(raw.waba_id) ? raw.waba_id : null,
      phone_number_id: typeof raw.phone_number_id === 'string' && META_ID.test(raw.phone_number_id) ? raw.phone_number_id : null,
      app_publication_status: PUBLICATION.has(raw.app_publication_status) ? raw.app_publication_status : 'unknown',
      webhook_subscription_status: WEBHOOK_SUB.has(raw.webhook_subscription_status) ? raw.webhook_subscription_status : 'inactive',
      required_permissions: Array.isArray(raw.required_permissions) ? raw.required_permissions.filter(p => typeof p === 'string' && /^[a-z_]{3,80}$/.test(p)).slice(0, 20) : ['whatsapp_business_messaging', 'whatsapp_business_management'],
      callback_path: raw.callback_path === '/webhooks/whatsapp' ? '/webhooks/whatsapp' : '/webhooks/whatsapp',
      max_body_bytes: Number.isInteger(raw.max_body_bytes) && raw.max_body_bytes > 0 && raw.max_body_bytes <= MAX_BODY ? raw.max_body_bytes : MAX_BODY
    };
  } catch {
    return {
      meta_app_id: '1625559252697626',
      business_portfolio_id: '1791528208560099',
      waba_id: null,
      phone_number_id: null,
      app_publication_status: 'unknown',
      webhook_subscription_status: 'inactive',
      required_permissions: ['whatsapp_business_messaging', 'whatsapp_business_management'],
      callback_path: '/webhooks/whatsapp',
      max_body_bytes: MAX_BODY
    };
  }
}

// Host-owned official WhatsApp Business inbound. Messages are untrusted data.
// They never grant authority or auto-dispatch Missions.
class WhatsAppInbound {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.store = bridge.controlStore;
    this.db = this.store.db;
    this.options = options;
    this.root = options.root || path.resolve(__dirname, '..');
    this.defaults = loadMetaDefaults(this.root);
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
    this.#migrate();
  }

  #migrate() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(cp_whatsapp_inbound_config)').all().map(c => c.name));
    const add = (name, sql) => { if (!cols.has(name)) this.db.exec(`ALTER TABLE cp_whatsapp_inbound_config ADD COLUMN ${name} ${sql}`); };
    add('meta_app_id', 'TEXT');
    add('business_portfolio_id', 'TEXT');
    add('waba_id', 'TEXT');
    add('phone_number_id', 'TEXT');
    add('app_publication_status', "TEXT NOT NULL DEFAULT 'unknown'");
    add('webhook_subscription_status', "TEXT NOT NULL DEFAULT 'inactive'");
    add('access_token_reference', 'TEXT');
    add('prepared_callback_url', 'TEXT');
    add('discovery_json', 'TEXT');
    const row = this.db.prepare('SELECT meta_app_id, business_portfolio_id FROM cp_whatsapp_inbound_config WHERE id=1').get();
    if (row && !row.meta_app_id && this.defaults.meta_app_id) {
      this.db.prepare('UPDATE cp_whatsapp_inbound_config SET meta_app_id=?, business_portfolio_id=? WHERE id=1')
        .run(this.defaults.meta_app_id, this.defaults.business_portfolio_id);
    }
  }

  #refOk(ref) {
    return ref == null || (typeof ref === 'string' && /^[A-Za-z0-9_.:-]{8,200}$/.test(ref));
  }

  config() {
    const row = this.db.prepare('SELECT * FROM cp_whatsapp_inbound_config WHERE id=1').get();
    return {
      enabled: row?.enabled === 1,
      verify_token_bound: Boolean(row?.verify_token_reference) || typeof this.options.verifyToken === 'string',
      app_secret_bound: Boolean(row?.app_secret_reference) || typeof this.options.appSecret === 'string',
      access_token_bound: Boolean(row?.access_token_reference) || typeof this.options.accessToken === 'string',
      allowlist: JSON.parse(row?.allowlist || '[]'),
      updated_at: row?.updated_at || null,
      updated_by: row?.updated_by || null,
      meta_app_id: row?.meta_app_id || this.defaults.meta_app_id,
      business_portfolio_id: row?.business_portfolio_id || this.defaults.business_portfolio_id,
      waba_id: row?.waba_id || this.defaults.waba_id,
      phone_number_id: row?.phone_number_id || this.defaults.phone_number_id,
      app_publication_status: PUBLICATION.has(row?.app_publication_status) ? row.app_publication_status : this.defaults.app_publication_status,
      webhook_subscription_status: 'inactive',
      prepared_callback_url: row?.prepared_callback_url || null,
      public_ingress: false,
      auto_mission_execution: false
    };
  }

  configure(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may configure WhatsApp inbound');
    object(input, ['enabled', 'confirmed', 'verify_token_reference', 'app_secret_reference', 'access_token_reference', 'allowlist', 'verify_token', 'app_secret', 'meta_app_id', 'business_portfolio_id', 'waba_id', 'phone_number_id', 'app_publication_status', 'public_ingress']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (typeof input.enabled !== 'boolean') throw Error('enabled must be boolean');
    if (input.public_ingress === true) throw Error('Public ingress activation requires separate owner authorization');
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
    const accessRef = input.access_token_reference !== undefined ? input.access_token_reference : row.access_token_reference;
    for (const ref of [verifyRef, secretRef, accessRef]) if (!this.#refOk(ref)) throw Error('Invalid vault reference');
    const metaApp = input.meta_app_id !== undefined ? input.meta_app_id : (row.meta_app_id || this.defaults.meta_app_id);
    const portfolio = input.business_portfolio_id !== undefined ? input.business_portfolio_id : (row.business_portfolio_id || this.defaults.business_portfolio_id);
    const waba = input.waba_id !== undefined ? input.waba_id : row.waba_id;
    const phone = input.phone_number_id !== undefined ? input.phone_number_id : row.phone_number_id;
    const publication = input.app_publication_status !== undefined ? input.app_publication_status : (row.app_publication_status || 'unknown');
    for (const [label, value] of [['meta_app_id', metaApp], ['business_portfolio_id', portfolio], ['waba_id', waba], ['phone_number_id', phone]]) {
      if (value != null && (typeof value !== 'string' || !META_ID.test(value))) throw Error('Invalid ' + label);
    }
    if (!PUBLICATION.has(publication)) throw Error('Invalid app publication status');
    this.db.prepare(`UPDATE cp_whatsapp_inbound_config SET enabled=?, verify_token_reference=?, app_secret_reference=?, access_token_reference=?, allowlist=?, updated_at=?, updated_by=?,
      meta_app_id=?, business_portfolio_id=?, waba_id=?, phone_number_id=?, app_publication_status=?, webhook_subscription_status='inactive' WHERE id=1`)
      .run(input.enabled ? 1 : 0, verifyRef, secretRef, accessRef, JSON.stringify(allowlist), Date.now(), actor,
        metaApp, portfolio, waba, phone, publication);
    this.store.event(input.enabled ? 'whatsapp.inbound.enabled' : 'whatsapp.inbound.disabled', null, {
      allowlist_count: allowlist.length,
      verify_token_bound: Boolean(verifyRef) || Boolean(this.options.verifyToken),
      app_secret_bound: Boolean(secretRef) || Boolean(this.options.appSecret),
      access_token_bound: Boolean(accessRef) || Boolean(this.options.accessToken),
      public_ingress: false
    });
    return this.status();
  }

  // Persist non-secret Graph/console discovery. Never accepts tokens.
  recordDiscovery(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may record Meta discovery');
    object(input, ['confirmed', 'app_name', 'graph_access', 'permission_prerequisite', 'business_verification', 'waba_id', 'phone_number_id', 'app_publication_status', 'permissions_granted', 'notes']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (input.graph_access !== undefined && !['unavailable', 'refused', 'authorized'].includes(input.graph_access)) {
      throw Error('Invalid graph_access');
    }
    const waba = input.waba_id === undefined ? undefined : input.waba_id;
    const phone = input.phone_number_id === undefined ? undefined : input.phone_number_id;
    for (const [label, value] of [['waba_id', waba], ['phone_number_id', phone]]) {
      if (value != null && (typeof value !== 'string' || !META_ID.test(value))) throw Error('Invalid ' + label);
    }
    if (input.app_publication_status !== undefined && !PUBLICATION.has(input.app_publication_status)) throw Error('Invalid app publication status');
    if (input.permissions_granted !== undefined) {
      if (!Array.isArray(input.permissions_granted) || input.permissions_granted.length > 40 || input.permissions_granted.some(p => typeof p !== 'string' || !/^[a-z_]{3,80}$/.test(p))) {
        throw Error('Invalid permissions_granted');
      }
    }
    if (input.app_name != null) text(input.app_name, 'app name', 120);
    if (input.permission_prerequisite != null) text(input.permission_prerequisite, 'permission prerequisite', 400);
    if (input.business_verification != null) text(input.business_verification, 'business verification', 400);
    if (input.notes != null) text(input.notes, 'discovery notes', 1000);
    const discovery = {
      recorded_at: Date.now(),
      meta_app_id: this.config().meta_app_id,
      business_portfolio_id: this.config().business_portfolio_id,
      app_name: input.app_name || null,
      graph_access: input.graph_access || 'unavailable',
      permission_prerequisite: input.permission_prerequisite || null,
      business_verification: input.business_verification || null,
      permissions_granted: input.permissions_granted || [],
      notes: input.notes || null,
      secrets_exported: false
    };
    const sets = ['discovery_json=?', 'updated_at=?', "webhook_subscription_status='inactive'"];
    const args = [JSON.stringify(discovery), Date.now()];
    if (waba !== undefined) { sets.push('waba_id=?'); args.push(waba); }
    if (phone !== undefined) { sets.push('phone_number_id=?'); args.push(phone); }
    if (input.app_publication_status !== undefined) { sets.push('app_publication_status=?'); args.push(input.app_publication_status); }
    args.push(1);
    this.db.prepare(`UPDATE cp_whatsapp_inbound_config SET ${sets.join(', ')} WHERE id=?`).run(...args);
    this.store.event('whatsapp.inbound.discovery_recorded', null, {
      graph_access: discovery.graph_access,
      waba_bound: Boolean(waba || this.config().waba_id),
      phone_bound: Boolean(phone || this.config().phone_number_id),
      secrets_exported: false
    });
    return this.liveConnectionReadiness();
  }

  // Store a candidate HTTPS callback URL without activating public ingress.
  preparePublicCallback(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may prepare public callback');
    object(input, ['confirmed', 'url']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (typeof input.url !== 'string' || input.url.length > 500) throw Error('Invalid callback URL');
    let parsed;
    try { parsed = new URL(input.url); } catch { throw Error('Invalid callback URL'); }
    if (parsed.protocol !== 'https:') throw Error('Callback URL must use HTTPS');
    if (parsed.username || parsed.password) throw Error('Callback URL must not embed credentials');
    if (parsed.pathname !== '/webhooks/whatsapp') throw Error('Callback path must be exactly /webhooks/whatsapp');
    if (parsed.search || parsed.hash) throw Error('Callback URL must not include query or fragment');
    // Refuse paths that would advertise control-plane surfaces.
    if (/\/api\/|\/mcp|\/hub|\/workspace/i.test(input.url)) throw Error('Callback URL must not expose control plane surfaces');
    const url = parsed.origin + '/webhooks/whatsapp';
    this.db.prepare("UPDATE cp_whatsapp_inbound_config SET prepared_callback_url=?, webhook_subscription_status='inactive', updated_at=? WHERE id=1")
      .run(url, Date.now());
    this.store.event('whatsapp.inbound.callback_prepared', null, { public_ingress: false, activated: false });
    return this.callbackReadiness();
  }

  credentialReadiness() {
    const cfg = this.config();
    const row = this.db.prepare('SELECT verify_token_reference, app_secret_reference, access_token_reference FROM cp_whatsapp_inbound_config WHERE id=1').get();
    return {
      verify_token: {
        bound: cfg.verify_token_bound,
        vault_reference_present: Boolean(row?.verify_token_reference),
        purpose: 'whatsapp',
        bind_command: 'airodrom secret put whatsapp'
      },
      app_secret: {
        bound: cfg.app_secret_bound,
        vault_reference_present: Boolean(row?.app_secret_reference),
        purpose: 'whatsapp',
        bind_command: 'airodrom secret put whatsapp'
      },
      access_token: {
        bound: cfg.access_token_bound,
        vault_reference_present: Boolean(row?.access_token_reference),
        purpose: 'whatsapp',
        bind_command: 'airodrom secret put whatsapp',
        note: 'System user / permanent token for Graph discovery and outbound Cloud API only. Never logged.'
      },
      plaintext_in_git: false,
      values_displayed: false,
      rotation_authorized: false
    };
  }

  metaReadiness() {
    const cfg = this.config();
    const row = this.db.prepare('SELECT discovery_json FROM cp_whatsapp_inbound_config WHERE id=1').get();
    let discovery = null;
    try { discovery = row?.discovery_json ? JSON.parse(row.discovery_json) : null; } catch { discovery = null; }
    return {
      meta_app_id: cfg.meta_app_id,
      business_portfolio_id: cfg.business_portfolio_id,
      waba_id: cfg.waba_id,
      phone_number_id: cfg.phone_number_id,
      app_publication_status: cfg.app_publication_status,
      webhook_subscription_status: 'inactive',
      required_permissions: this.defaults.required_permissions,
      secrets_bound: cfg.verify_token_bound && cfg.app_secret_bound,
      access_token_bound: cfg.access_token_bound,
      graph_live_query: discovery?.graph_access === 'authorized',
      discovery,
      note: 'WABA ID, Phone Number ID, publication and webhook subscription require Meta console or authorized Graph inspection. No credentials are exposed here.'
    };
  }

  callbackReadiness() {
    const cfg = this.config();
    return {
      path: this.defaults.callback_path,
      methods: ['GET', 'POST'],
      tls_required: true,
      host_binding: '127.0.0.1',
      public_ingress: false,
      public_url: null,
      prepared_callback_url: cfg.prepared_callback_url,
      verify_token_bound: cfg.verify_token_bound,
      app_secret_bound: cfg.app_secret_bound,
      signature_header: 'X-Hub-Signature-256',
      max_body_bytes: this.defaults.max_body_bytes,
      sender_allowlist: cfg.allowlist.length,
      durable_inbox: true,
      auto_mission_execution: false,
      exposes_control_plane: false,
      exposes_mcp: false,
      exposes_memory_apis: false,
      mcp_tunnel_suitable: false,
      activation: 'inactive_until_owner_authorization',
      note: 'Terminate TLS at a dedicated reverse proxy that forwards only /webhooks/whatsapp to 127.0.0.1. Do not reuse the ChatGPT MCP tunnel. Public activation requires separate owner authorization.'
    };
  }

  subscriptionPrep() {
    const cfg = this.config();
    const blockers = [];
    if (!cfg.verify_token_bound) blockers.push('verify_token_unbound');
    if (!cfg.app_secret_bound) blockers.push('app_secret_unbound');
    if (!cfg.waba_id) blockers.push('waba_id_unknown');
    if (!cfg.phone_number_id) blockers.push('phone_number_id_unknown');
    if (!cfg.prepared_callback_url) blockers.push('prepared_callback_url_missing');
    if (cfg.public_ingress !== true) blockers.push('public_ingress_inactive');
    return {
      execute_external_changes: false,
      callback_url: cfg.prepared_callback_url,
      verify_token: 'vault:whatsapp verify_token_reference',
      subscribed_fields: ['messages'],
      optional_fields: ['message_status'],
      waba_id: cfg.waba_id,
      phone_number_id: cfg.phone_number_id,
      meta_app_id: cfg.meta_app_id,
      steps: [
        'Bind Vault references for verify token, app secret, and Graph access token (purpose whatsapp).',
        'Record verified WABA ID and Phone Number ID via configure/recordDiscovery (non-secret).',
        'preparePublicCallback with the owner-chosen HTTPS URL ending at /webhooks/whatsapp.',
        'Owner-authorize public ingress separately (not available through ordinary configure).',
        'In Meta App → WhatsApp → Configuration, set Callback URL + Verify token and subscribe messages.',
        'Send one allowlisted test message; confirm inbox and zero Mission growth.'
      ],
      blockers,
      authority: false
    };
  }

  liveConnectionReadiness() {
    const cfg = this.config();
    const meta = this.metaReadiness();
    const credentials = this.credentialReadiness();
    const callback = this.callbackReadiness();
    const subscription = this.subscriptionPrep();
    const realTest = {
      authorized: false,
      executed: false,
      reason: 'Public HTTPS callback not owner-authorized; live Meta delivery deferred',
      mission_auto_execution: false
    };
    return {
      meta_app_id: cfg.meta_app_id,
      business_portfolio_id: cfg.business_portfolio_id,
      app_name: meta.discovery?.app_name || null,
      waba_id: cfg.waba_id,
      phone_number_id: cfg.phone_number_id,
      app_publication_status: cfg.app_publication_status,
      webhook_subscription_status: 'inactive',
      meta,
      credentials,
      callback,
      subscription,
      real_message_test: realTest,
      public_ingress: false,
      auto_mission_execution: false,
      authority: false
    };
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
      meta: this.metaReadiness(),
      callback: this.callbackReadiness(),
      credentials: this.credentialReadiness(),
      live_connection: this.liveConnectionReadiness(),
      lifecycle: ['received', 'verified', 'stored', 'available'],
      inbox: Object.fromEntries(counts.map(r => [r.status, r.n])),
      recent: this.list({ limit: 10 }).items,
      retained: this.db.prepare('SELECT count(*) n FROM cp_whatsapp_inbox').get().n,
      authority: false,
      auto_mission_execution: false,
      public_ingress: false,
      note: 'Inbound text is untrusted. No Mission is dispatched from webhook receipt. Public Meta callback remains inactive.'
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
    if (raw.length > this.defaults.max_body_bytes) throw Error('Request too large');
    this.store.event('whatsapp.inbound.received', null, { bytes: raw.length, authority: false, auto_mission: false });
    const appSecret = this.#resolve('secret');
    let parsed;
    try {
      parsed = this.#parse(raw, signatureHeader, appSecret);
    } catch (error) {
      this.store.event('whatsapp.inbound.rejected', null, { reason: 'signature_or_parse', authority: false });
      throw error;
    }
    this.store.event('whatsapp.inbound.verified', null, { messages: parsed.messages.length, statuses: parsed.statuses.length, authority: false });
    return transaction(this.db, () => {
      const accepted = [];
      const rejected = [];
      for (const message of parsed.messages) {
        const existing = this.db.prepare('SELECT message_id, status FROM cp_whatsapp_inbox WHERE message_id=?').get(message.id);
        if (existing) {
          rejected.push({ id: message.id, reason: 'duplicate', lifecycle: { received: true, verified: true, stored: true, available: existing.status === 'received' } });
          this.store.event('whatsapp.inbound.duplicate', null, { message_id: message.id });
          continue;
        }
        if (cfg.allowlist.length && (!message.from || !cfg.allowlist.includes(message.from))) {
          this.db.prepare('INSERT INTO cp_whatsapp_inbox VALUES(?,?,?,?,?,?,?,0)')
            .run(message.id, message.from, message.text, 'unauthorized_sender', message.payload_hash, 0, Date.now());
          rejected.push({ id: message.id, reason: 'unauthorized_sender', lifecycle: { received: true, verified: true, stored: true, available: false } });
          this.store.event('whatsapp.inbound.unauthorized_sender', null, { message_id: message.id });
          this.store.event('whatsapp.inbound.stored', null, { message_id: message.id, status: 'unauthorized_sender' });
          continue;
        }
        this.db.prepare('INSERT INTO cp_whatsapp_inbox VALUES(?,?,?,?,?,?,?,0)')
          .run(message.id, message.from, message.text, 'received', message.payload_hash, 0, Date.now());
        this.store.event('whatsapp.inbound.stored', null, { message_id: message.id, status: 'received' });
        this.store.event('whatsapp.inbound.available', null, { message_id: message.id, authority: false, auto_mission: false });
        accepted.push({
          id: message.id,
          from: message.from,
          status: 'received',
          lifecycle: { received: true, verified: true, stored: true, available: true }
        });
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
        lifecycle: ['received', 'verified', 'stored', 'available'],
        auto_mission_execution: false,
        public_ingress: false,
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
        lifecycle: {
          received: true,
          verified: true,
          stored: true,
          available: r.status === 'received'
        },
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

async function readRaw(req, max = MAX_BODY) {
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

module.exports = { WhatsAppInbound, readRaw, PHONE, whatsappSource, loadMetaDefaults, MAX_BODY };
