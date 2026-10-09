'use strict';
// ADR 0032 DeepSeek reserve provider. OFF by default and never selected automatically:
// every request needs a single-use operator approval bound to its exact task, model,
// content, data class and spend ceiling. DeepSeek supplies inference only; Airodrom
// keeps Mission authority, permissions, Memory, verification, Acceptance and Settlement.
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const pricing = require('./deepseek-pricing');
const { secretLike } = require('./provider-policy');
const { ProviderSecrets } = require('./provider-secrets');
const { OpenAICompatibleProvider } = require('./openai-compatible-provider');
const { initialProfiles } = require('./provider-profiles');
const CONFIG = require('../config/deepseek-reserve-v1.json');

const OPEN_CLASSES = new Set(['public', 'internal']);
// These leave the Mac only with explicit authorization of the stated scope.
const SCOPED_CLASSES = new Set(['private', 'financial', 'sensitive']);
// The provider refused before inference: nothing billable happened.
const NO_CHARGE = new Set(['auth_required', 'credential_unavailable', 'quota_limited', 'invalid_request', 'policy_reject']);
const FIELDS = ['task_id', 'model', 'thinking', 'reason', 'data_class', 'scope', 'messages', 'max_output', 'personal_memory', 'memory_refs', 'attachment_refs', 'context_refs'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const usdToNano = usd => Math.round(usd * 1e9);
const fail = code => { throw Object.assign(Error(code), { code }); };

function validate(request, config) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(k => !FIELDS.includes(k))) fail('invalid_request');
  if (typeof request.task_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(request.task_id)) fail('invalid_request');
  if (!config.models.includes(request.model)) fail('model_not_reserve');
  if (request.thinking !== undefined && !['disabled', 'enabled'].includes(request.thinking)) fail('invalid_request');
  if (typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 500) fail('reason_required');
  if (typeof request.scope !== 'string' || !request.scope.trim() || request.scope.length > 1000) fail('scope_required');
  if (request.data_class === 'credentials') fail('credentials_prohibited');
  if (!OPEN_CLASSES.has(request.data_class) && !SCOPED_CLASSES.has(request.data_class)) fail('unknown_data_class');
  // Personal Memory and referenced material are never transmitted by this provider.
  if (request.personal_memory === true || request.memory_refs?.length) fail('personal_memory_prohibited');
  if (request.attachment_refs?.length || request.context_refs?.length) fail('references_not_transmitted');
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.length > 32 || request.messages.some(m => !m || Object.keys(m).some(k => !['role', 'content'].includes(k)) || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) fail('invalid_request');
  if (secretLike(request.messages) || secretLike(request.scope) || secretLike(request.reason)) fail('secrets_prohibited');
  if (!Number.isSafeInteger(request.max_output) || request.max_output < 1 || request.max_output > config.max_output_tokens) fail('output_limit');
}

// Everything that changes what is sent, to which model, for whom or why.
function material(request) {
  const { task_id, model, thinking = 'disabled', reason, data_class, scope, messages, max_output } = request;
  return { task_id, model, thinking, reason, data_class, scope, messages: messages.map(m => ({ role: m.role, content: m.content })), max_output };
}

// macOS Keychain lookup; the value reaches only this process through a pipe.
function keychain(reference, reveal) {
  const m = /^keychain:([A-Za-z0-9_.-]{1,80})\/([A-Za-z0-9_.-]{1,80})$/.exec(reference || '');
  if (!m) throw Error('Unsupported secret reference');
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', m[1], '-a', m[2], ...(reveal ? ['-w'] : [])], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
  if (r.status !== 0) throw Error('Keychain item unavailable');
  return reveal ? r.stdout.replace(/\n$/, '') : true;
}

class DeepSeekReserve {
  constructor({ db, config = CONFIG, secretReader = ({ reference }) => keychain(reference, true), keyPresent = () => { try { return keychain(config.secret_reference, false); } catch { return false; } }, request = fetch, adapter = null, now = Date.now } = {}) {
    this.db = db; this.config = config; this.now = now; this.request = request; this.keyPresent = keyPresent;
    this.profile = initialProfiles().find(p => p.id === 'deepseek');
    this.secret = new ProviderSecrets({ references: { deepseek: config.secret_reference }, read: secretReader }).forProvider('deepseek');
    this.adapter = adapter || new OpenAICompatibleProvider({ profile: this.profile, baseUrl: config.base_url, secret: this.secret, request, timeoutMs: config.request_timeout_ms });
    this.inflight = new Map(); this.connectivity = { state: 'unknown', checked_at: null }; this.last = null;
    db.exec(`CREATE TABLE IF NOT EXISTS deepseek_reserve_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,monthly_budget_nano INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deepseek_reserve_approvals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,request_hash TEXT NOT NULL,request TEXT NOT NULL,record TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,decided_at INTEGER,consumed_at INTEGER);
      CREATE TABLE IF NOT EXISTS deepseek_reserve_spend(approval_id TEXT PRIMARY KEY,month TEXT NOT NULL,reserved_nano INTEGER NOT NULL,actual_nano INTEGER,state TEXT NOT NULL,usage TEXT,created_at INTEGER NOT NULL,settled_at INTEGER);
      CREATE TABLE IF NOT EXISTS deepseek_reserve_events(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,record TEXT NOT NULL);`);
    // A dispatch interrupted by a restart has unknown usage; hold its reservation.
    db.prepare("UPDATE deepseek_reserve_spend SET state='unreconciled',actual_nano=reserved_nano,settled_at=? WHERE state='reserved'").run(this.now());
    db.prepare('INSERT OR IGNORE INTO deepseek_reserve_settings VALUES(1,0,?,?)').run(usdToNano(config.default_monthly_budget_usd), this.now());
  }

  event(kind, record) { this.db.prepare('INSERT INTO deepseek_reserve_events(at,kind,record) VALUES(?,?,?)').run(this.now(), kind, JSON.stringify({ ...record, execution_authority: false })); }
  settings() { const r = this.db.prepare('SELECT enabled,monthly_budget_nano FROM deepseek_reserve_settings WHERE id=1').get(); return { enabled: r.enabled === 1, monthly_budget_nano: r.monthly_budget_nano }; }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') fail('invalid_request');
    this.db.prepare('UPDATE deepseek_reserve_settings SET enabled=?,updated_at=? WHERE id=1').run(enabled ? 1 : 0, this.now());
    // Turning the reserve off withdraws every approval not yet used.
    if (!enabled) this.db.prepare("UPDATE deepseek_reserve_approvals SET state='withdrawn',decided_at=? WHERE state IN ('proposed','approved')").run(this.now());
    this.event(enabled ? 'enabled' : 'disabled', {});
    return this.settings();
  }
  setBudget(usd) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > 1000) fail('invalid_budget');
    this.db.prepare('UPDATE deepseek_reserve_settings SET monthly_budget_nano=?,updated_at=? WHERE id=1').run(usdToNano(usd), this.now());
    this.event('budget_set', { monthly_budget_nano: usdToNano(usd) });
    return this.settings();
  }
  spend(month = pricing.month(this.now())) {
    const rows = this.db.prepare('SELECT state,reserved_nano,actual_nano FROM deepseek_reserve_spend WHERE month=?').all(month);
    const actual = rows.filter(r => ['settled', 'unreconciled'].includes(r.state)).reduce((n, r) => n + r.actual_nano, 0);
    const reserved = rows.filter(r => r.state === 'reserved').reduce((n, r) => n + r.reserved_nano, 0);
    return { month, actual_nano: actual, reserved_nano: reserved, unreconciled: rows.filter(r => r.state === 'unreconciled').length };
  }
  approval(id) { const r = typeof id === 'string' ? this.db.prepare('SELECT * FROM deepseek_reserve_approvals WHERE id=?').get(id) : null; return r ? { ...r, record: JSON.parse(r.record) } : null; }

  propose(request) {
    validate(request, this.config);
    if (!this.settings().enabled) fail('reserve_disabled');
    if (!this.secret.available() || !this.keyPresent()) fail('auth_required');
    const t = this.now(), canonical = material(request), tokens = pricing.inputTokenBound(canonical.messages);
    const current = pricing.rates(this.config, canonical.model, t);
    // Ceiling: every input token at cache-miss, full output, the highest rate the request could meet.
    const window = pricing.maxRates(this.config, canonical.model, t, t + this.config.approval_ttl_ms + this.config.request_timeout_ms, t);
    const usage = { input_cache_miss: tokens, output: canonical.max_output };
    const record = { model: canonical.model, thinking: canonical.thinking, reason: canonical.reason, data_class: canonical.data_class, scope: canonical.scope,
      sensitive_scope: SCOPED_CLASSES.has(canonical.data_class), message_count: canonical.messages.length, message_bytes: tokens - 16 * canonical.messages.length,
      estimated_input_tokens: tokens, estimated_output_tokens: canonical.max_output, period: current.billed_as, period_uncertain: current.uncertain,
      estimated_cost_nano: pricing.cost(usage, current), max_spend_nano: pricing.cost(usage, window), crosses_price_boundary: window.crosses_boundary };
    const id = randomUUID(), expires = t + this.config.approval_ttl_ms;
    this.db.prepare('INSERT INTO deepseek_reserve_approvals VALUES(?,?,?,?,?,?,?,?,NULL,NULL)').run(id, canonical.task_id, hash(canonical), JSON.stringify(canonical), JSON.stringify(record), 'proposed', t, expires);
    this.event('proposed', { approval_id: id, task_id: canonical.task_id, ...record, reason: undefined, scope: undefined });
    return this.approvalView(this.approval(id));
  }
  approve(id, { authorize_sensitive = false } = {}) {
    const a = this.approval(id);
    if (!a || a.state !== 'proposed') fail('approval_unavailable');
    if (a.expires_at <= this.now()) { this.mark(id, 'expired'); fail('approval_expired'); }
    if (a.record.sensitive_scope && authorize_sensitive !== true) fail('sensitive_scope_authorization_required');
    if (this.db.prepare("UPDATE deepseek_reserve_approvals SET state='approved',decided_at=? WHERE id=? AND state='proposed'").run(this.now(), id).changes !== 1) fail('approval_unavailable');
    this.event('approved', { approval_id: id, sensitive_scope_authorized: a.record.sensitive_scope });
    return this.approvalView(this.approval(id));
  }
  reject(id) { const a = this.approval(id); if (!a || !['proposed', 'approved'].includes(a.state)) fail('approval_unavailable'); this.mark(id, 'rejected'); return this.approvalView(this.approval(id)); }
  mark(id, state) { this.db.prepare('UPDATE deepseek_reserve_approvals SET state=?,decided_at=? WHERE id=?').run(state, this.now(), id); this.event(state, { approval_id: id }); }
  cancel(id) { const c = this.inflight.get(id); if (c) { c.abort(); return { cancelled: true, billing: 'usage_unknown' }; } const a = this.approval(id); if (a && ['proposed', 'approved'].includes(a.state)) { this.mark(id, 'cancelled'); return { cancelled: true, billing: 'none' }; } fail('approval_unavailable'); }

  // Dispatch the exact approved request once. `request` defaults to the stored request.
  async dispatch(id, request = undefined, { signal } = {}) {
    const a = this.approval(id);
    if (!a) fail('approval_unavailable');
    request ??= JSON.parse(a.request);
    validate(request, this.config);
    if (!this.settings().enabled) fail('reserve_disabled');
    if (['consumed', 'settled'].includes(a.state)) fail('approval_already_used');
    if (a.state !== 'approved') fail('approval_not_approved');
    if (a.expires_at <= this.now()) { this.mark(id, 'expired'); fail('approval_expired'); }
    // Approval is bound to its task and content; any material change invalidates it.
    if (hash(material(request)) !== a.request_hash) { this.mark(id, 'invalidated'); fail('approval_scope_mismatch'); }
    if (signal?.aborted) { this.mark(id, 'cancelled'); fail('cancelled'); }
    const month = pricing.month(this.now()), budget = this.settings().monthly_budget_nano, reserve = a.record.max_spend_nano;
    // Admission, single-use consumption and reservation commit together or not at all.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const s = this.spend(month);
      if (s.actual_nano + s.reserved_nano + reserve > budget) fail('budget_exhausted');
      if (this.db.prepare("UPDATE deepseek_reserve_approvals SET state='consumed',consumed_at=? WHERE id=? AND state='approved'").run(this.now(), id).changes !== 1) fail('approval_already_used');
      this.db.prepare('INSERT INTO deepseek_reserve_spend VALUES(?,?,?,NULL,?,NULL,?,NULL)').run(id, month, reserve, 'reserved', this.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.event('dispatched', { approval_id: id, reserved_nano: reserve, month });
    const controller = new AbortController(), started = this.now();
    this.inflight.set(id, controller);
    const canonical = material(request), model = this.profile.models.find(m => m.id === canonical.model && m.thinking_mode === canonical.thinking);
    const input = { request_id: id, run_id: 'deepseek-reserve:' + canonical.task_id, messages: canonical.messages, max_output: canonical.max_output, reasoning_mode: canonical.thinking,
      data_class: canonical.data_class, privacy: 'project_policy', project_policy: { approved_external: { [canonical.data_class]: ['deepseek'] } } };
    let outcome;
    // Exactly one attempt: a billable request is never retried or sent to another model.
    try { outcome = await this.adapter.execute(input, model, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal }); }
    catch { outcome = { status: 'failed', error_class: 'unknown_error' }; }
    finally { this.inflight.delete(id); }
    return this.settle(id, reserve, started, canonical.model, outcome);
  }

  settle(id, reserve, started, model, outcome) {
    const finished = this.now(), r = pricing.maxRates(this.config, model, started, Math.max(started, finished), started);
    let actual = reserve, state = 'unreconciled', billing = 'usage_unknown', metered = null;
    if (outcome.status === 'completed') {
      metered = pricing.metered(outcome.usage);
      if (metered) { actual = pricing.cost(metered, r); state = 'settled'; billing = r.crosses_boundary ? 'metered_boundary_max' : 'metered'; }
      else billing = 'usage_missing';
    } else if (NO_CHARGE.has(outcome.error_class)) { actual = 0; state = 'settled'; billing = 'provider_rejected'; }
    this.db.prepare('UPDATE deepseek_reserve_spend SET actual_nano=?,state=?,usage=?,settled_at=? WHERE approval_id=?').run(actual, state, JSON.stringify(metered), finished, id);
    this.db.prepare("UPDATE deepseek_reserve_approvals SET state='settled' WHERE id=?").run(id);
    this.last = { at: finished, status: outcome.status, error_class: outcome.error_class || null, billing, cost_nano: actual };
    this.event('settled', { approval_id: id, status: outcome.status, error_class: outcome.error_class || null, billing, cost_nano: actual, reserved_nano: reserve, tokens: metered });
    return { approval_id: id, status: outcome.status, error_class: outcome.error_class || null, text: outcome.status === 'completed' ? outcome.text : null,
      usage: metered, cost_nano: actual, cost_usd: pricing.usd(actual), billing, execution_authority: false, accepted: false };
  }

  // Authenticated GET of the model list: no prompt, memory or repository content leaves.
  async verify() {
    const t = this.now();
    if (!this.secret.available() || !this.keyPresent()) { this.connectivity = { state: 'auth_required', checked_at: t }; return this.connectivity; }
    try {
      const key = await this.secret.resolve();
      const response = await this.request(this.config.base_url + '/models', { headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      await response.body?.cancel?.();
      this.connectivity = { state: response.ok ? 'connected' : [401, 403].includes(response.status) ? 'auth_failed' : [402, 429].includes(response.status) ? 'quota_limited' : 'unavailable', checked_at: t };
    } catch { this.connectivity = { state: 'network_error', checked_at: t }; }
    this.event('verified', { state: this.connectivity.state });
    return this.connectivity;
  }

  approvalView(a) {
    const r = a.record;
    return { approval_id: a.id, task_id: a.task_id, state: a.state, model: r.model, thinking: r.thinking, reason: r.reason, data_class: r.data_class, scope: r.scope,
      sensitive_scope: r.sensitive_scope, message_count: r.message_count, message_bytes: r.message_bytes,
      estimated_input_tokens: r.estimated_input_tokens, estimated_output_tokens: r.estimated_output_tokens,
      period: r.period, period_uncertain: r.period_uncertain, estimated_cost_usd: pricing.usd(r.estimated_cost_nano), max_spend_usd: pricing.usd(r.max_spend_nano),
      crosses_price_boundary: r.crosses_price_boundary, expires_at: a.expires_at, expires_display: pricing.vancouver(a.expires_at) };
  }

  view() {
    const t = this.now(), s = this.settings(), line = pricing.timeline(this.config, t), spend = this.spend(pricing.month(t));
    const rate = model => { const r = pricing.rates(this.config, model, t); return { billed_as: r.billed_as, input_cache_hit: r.input_cache_hit / 1000, input_cache_miss: r.input_cache_miss / 1000, output: r.output / 1000 }; };
    const pending = this.db.prepare("SELECT * FROM deepseek_reserve_approvals WHERE state IN ('proposed','approved') AND expires_at>? ORDER BY created_at DESC LIMIT 20").all(t).map(r => this.approvalView({ ...r, record: JSON.parse(r.record) }));
    const remaining = s.monthly_budget_nano - spend.actual_nano - spend.reserved_nano;
    return { provider: 'deepseek', status: !s.enabled ? 'OFF' : this.inflight.size ? 'ACTIVE' : 'APPROVAL REQUIRED', enabled: s.enabled,
      key_configured: this.secret.available() && this.keyPresent() === true, automatic_fallback: false, execution_authority: false,
      period: line.period === 'peak' ? 'PEAK' : 'OFF-PEAK', period_uncertain: line.uncertain, period_reason: line.reason,
      rates_usd_per_million: { 'deepseek-flash': rate('deepseek-flash'), 'deepseek-v4-pro': rate('deepseek-v4-pro') },
      server_now: t, next_change_at: line.next_change_at, next_peak_start_at: line.next_peak_start_at, next_peak_end_at: line.next_peak_end_at,
      display: { timezone: pricing.ZONE, now: pricing.vancouver(t), next_change: pricing.vancouver(line.next_change_at), next_peak_start: pricing.vancouver(line.next_peak_start_at), next_peak_end: pricing.vancouver(line.next_peak_end_at) },
      budget: { month: spend.month, budget_usd: pricing.usd(s.monthly_budget_nano), actual_usd: pricing.usd(spend.actual_nano), reserved_usd: pricing.usd(spend.reserved_nano), remaining_usd: pricing.usd(Math.max(0, remaining)), unreconciled: spend.unreconciled, enforcement: 'local reservation ledger; not a provider-side ceiling' },
      connectivity: this.connectivity, last_request: this.last, pending,
      pricing: { source: this.config.pricing.source, verified_at: this.config.pricing.verified_at, stale: pricing.pricingStale(this.config, t), holiday_years_verified: this.config.holidays.verified_years } };
  }
}

const instances = new WeakMap();
function forBridge(bridge, options = {}) {
  if (!instances.has(bridge)) instances.set(bridge, new DeepSeekReserve({ db: bridge.controlStore.db, ...options }));
  return instances.get(bridge);
}

module.exports = { DeepSeekReserve, forBridge, validate, material, keychain, NO_CHARGE };

// Operator Control Center routes. Each action accepts only its own fields.
async function route(bridge, method, pathname, body) {
  const reserve = forBridge(bridge), action = pathname.slice('/api/providers/deepseek'.length);
  const only = keys => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k))) fail('invalid_request'); return body; };
  if (method === 'GET' && action === '') return reserve.view();
  if (method !== 'POST') fail('method_not_allowed');
  if (action === '/settings') { const b = only(['enabled', 'monthly_budget_usd', 'request_id']); if (b.enabled !== undefined) reserve.setEnabled(b.enabled); if (b.monthly_budget_usd !== undefined) reserve.setBudget(b.monthly_budget_usd); return reserve.view(); }
  if (action === '/verify') { only(['request_id']); return reserve.verify(); }
  if (action === '/propose') return reserve.propose(only(['request', 'request_id']).request);
  if (action === '/approve') { const b = only(['approval_id', 'authorize_sensitive', 'request_id']); return reserve.approve(b.approval_id, { authorize_sensitive: b.authorize_sensitive === true }); }
  if (action === '/reject') return reserve.reject(only(['approval_id', 'request_id']).approval_id);
  if (action === '/dispatch') return reserve.dispatch(only(['approval_id', 'request_id']).approval_id);
  if (action === '/cancel') return reserve.cancel(only(['approval_id', 'request_id']).approval_id);
  fail('not_found');
}
module.exports.route = route;
