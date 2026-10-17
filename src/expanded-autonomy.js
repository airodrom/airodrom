'use strict';
/**
 * Expanded Autonomy Mode V1 — owner-controlled operating mode.
 * Composes Risk Acceptance, Deterministic Acceptance, Developer Autonomy,
 * Capability Broker, and SafetyPolicy. Does not create a parallel authority
 * engine. Defaults to MANUAL. High-impact domains stay inactive until
 * separately enrolled and independently qualified.
 */
const { randomUUID } = require('node:crypto');
const { object, identifier } = require('./control-plane-store');

const MODES = Object.freeze(['manual', 'routine_auto', 'expanded_auto']);
const DOMAIN_KEYS = Object.freeze([
  'credential_automation',
  'financial_automation',
  'production_automation',
  'destructive_automation',
  'broad_resource_access'
]);

const DEFAULT_FLAGS = Object.freeze({
  expanded_autonomy: false,
  manual_acceptance: true,
  credential_automation: false,
  financial_automation: false,
  production_automation: false,
  destructive_automation: false,
  broad_resource_access: false
});

function parseJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

class ExpandedAutonomy {
  constructor(bridge) {
    this.bridge = bridge;
    this.db = bridge.controlStore.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cp_expanded_autonomy(
        id INTEGER PRIMARY KEY CHECK(id=1),
        mode TEXT NOT NULL,
        flags TEXT NOT NULL,
        authorized_at INTEGER,
        expires_at INTEGER,
        emergency_stop INTEGER NOT NULL DEFAULT 0,
        emergency_stop_at INTEGER,
        emergency_stop_by TEXT,
        emergency_request_id TEXT,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        request_id TEXT
      );
      INSERT OR IGNORE INTO cp_expanded_autonomy
        (id, mode, flags, authorized_at, expires_at, emergency_stop, updated_at, updated_by)
        VALUES(1, 'manual', '${JSON.stringify(DEFAULT_FLAGS)}', NULL, NULL, 0, 0, 'system');
      CREATE TABLE IF NOT EXISTS cp_expanded_autonomy_policies(
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        policy TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        active INTEGER NOT NULL,
        qualified INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        created_by TEXT NOT NULL,
        request_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cp_expanded_autonomy_audit(
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        request_id TEXT,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cp_expanded_autonomy_audit_at ON cp_expanded_autonomy_audit(at DESC);
    `);
  }

  row() {
    return this.db.prepare('SELECT * FROM cp_expanded_autonomy WHERE id=1').get();
  }

  flagsOf(row = this.row()) {
    const parsed = parseJson(row?.flags || '{}', {});
    return { ...DEFAULT_FLAGS, ...parsed };
  }

  expired(row = this.row()) {
    return Number.isInteger(row?.expires_at) && row.expires_at > 0 && Date.now() > row.expires_at;
  }

  effective(owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated operator may inspect Expanded Autonomy');
    const row = this.row();
    const flags = this.flagsOf(row);
    const emergency = row.emergency_stop === 1;
    const expired = this.expired(row);
    let mode = MODES.includes(row.mode) ? row.mode : 'manual';
    if (emergency || expired || flags.manual_acceptance === true || flags.expanded_autonomy !== true) {
      mode = 'manual';
    }
    const policies = this.listPolicies();
    return {
      version: 1,
      mode,
      configured_mode: row.mode,
      flags,
      authorized_at: row.authorized_at || null,
      expires_at: row.expires_at || null,
      emergency_stop: emergency,
      emergency_stop_at: row.emergency_stop_at || null,
      expired,
      updated_at: row.updated_at || null,
      updated_by: row.updated_by || null,
      domains: Object.fromEntries(DOMAIN_KEYS.map(key => {
        const enrolled = policies.filter(p => p.domain === key && p.active && !p.revoked_at);
        const flagOn = flags[key] === true;
        const qualified = enrolled.some(p => p.qualified);
        return [key, {
          flag: flagOn,
          enrolled: enrolled.length,
          qualified,
          runnable: mode === 'expanded_auto' && flagOn && enrolled.length > 0 && qualified && !emergency && !expired,
          note: key === 'financial_automation' || key === 'production_automation'
            ? 'Disabled until provider/adapter is independently qualified and enrolled'
            : (enrolled.length ? 'Standing policy present' : 'No standing policy enrolled')
        }];
      })),
      scopes: {
        routine_auto_accept: mode === 'routine_auto' || mode === 'expanded_auto',
        coding_plan_auto_accept: mode === 'routine_auto' || mode === 'expanded_auto',
        high_impact: mode === 'expanded_auto',
        historical_missions: 'never_retroactive'
      },
      never_auto: [
        'self_authorize',
        'expand_own_authority',
        'credential_value_disclosure',
        'financial_without_qualified_provider',
        'production_without_qualified_adapter',
        'delete_audit_or_safety_records',
        'bypass_branch_protection',
        'force_merge'
      ],
      defaults_off: true,
      authority: false,
      note: mode === 'manual'
        ? 'MANUAL: new automated Acceptance and high-impact standing decisions are blocked. Existing mechanisms remain available for explicit operator action.'
        : mode === 'routine_auto'
          ? 'ROUTINE AUTO: eligible verified local work may auto-accept within Risk Acceptance and Deterministic Acceptance. High-impact domains stay gated.'
          : 'EXPANDED AUTO: routine auto-accept plus enrolled, qualified standing domain policies. Limits and emergency STOP still bind.'
    };
  }

  status(owner = 'operator') {
    return this.effective(owner);
  }

  audit(kind, detail, actor = 'operator', requestId = null) {
    this.db.prepare('INSERT INTO cp_expanded_autonomy_audit(id,at,kind,actor,request_id,detail) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), Date.now(), kind, actor, requestId, JSON.stringify(detail || {}).slice(0, 4000));
  }

  activity(limit = 50) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.db.prepare('SELECT id,at,kind,actor,request_id,detail FROM cp_expanded_autonomy_audit ORDER BY at DESC LIMIT ?')
      .all(n)
      .map(r => ({ ...r, detail: parseJson(r.detail, {}), authority: false }));
  }

  setMode(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may change Expanded Autonomy mode');
    object(input, ['mode', 'confirmed', 'request_id', 'flags', 'expires_at', 'sync_risk_acceptance']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    if (!MODES.includes(input.mode)) throw Error('Unknown Expanded Autonomy mode');
    const now = Date.now();
    const flags = { ...this.flagsOf() };
    if (input.mode === 'manual') {
      flags.manual_acceptance = true;
      flags.expanded_autonomy = false;
    } else {
      flags.manual_acceptance = false;
      flags.expanded_autonomy = true;
    }
    if (input.flags && typeof input.flags === 'object') {
      for (const key of Object.keys(DEFAULT_FLAGS)) {
        if (typeof input.flags[key] === 'boolean') flags[key] = input.flags[key];
      }
    }
    // High-impact flags cannot turn on outside expanded_auto.
    if (input.mode !== 'expanded_auto') {
      for (const key of DOMAIN_KEYS) flags[key] = false;
    }
    let expiresAt = null;
    if (input.expires_at !== undefined && input.expires_at !== null) {
      if (!Number.isInteger(input.expires_at) || input.expires_at <= now) throw Error('expires_at must be a future epoch ms');
      expiresAt = input.expires_at;
    }
    const authorizedAt = input.mode === 'manual' ? null : now;
    this.db.prepare(`UPDATE cp_expanded_autonomy SET mode=?, flags=?, authorized_at=?, expires_at=?,
      emergency_stop=0, emergency_stop_at=NULL, emergency_stop_by=NULL, emergency_request_id=NULL,
      updated_at=?, updated_by=?, request_id=? WHERE id=1`)
      .run(input.mode, JSON.stringify(flags), authorizedAt, expiresAt, now, owner, input.request_id);
    // Keep Risk Acceptance preference aligned with mode for routine auto-accept.
    try {
      if (input.mode === 'manual') {
        this.bridge.missions?.riskAcceptance?.setPreference({ enabled: false, confirmed: true }, owner);
      } else if (input.sync_risk_acceptance !== false) {
        this.bridge.missions?.riskAcceptance?.setPreference({ enabled: true, confirmed: true }, owner);
      }
    } catch { /* risk acceptance may be unavailable in partial fixtures */ }
    this.audit('mode_set', { mode: input.mode, flags, expires_at: expiresAt }, owner, input.request_id);
    this.bridge.controlStore.event('expanded_autonomy.mode_set', null, {
      mode: input.mode, request_id: input.request_id, authority: false
    });
    this.bridge.emit?.('change');
    return this.effective(owner);
  }

  setFlags(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may change Expanded Autonomy flags');
    object(input, ['flags', 'confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    if (!input.flags || typeof input.flags !== 'object') throw Error('flags object required');
    const row = this.row();
    const flags = this.flagsOf(row);
    for (const key of Object.keys(DEFAULT_FLAGS)) {
      if (typeof input.flags[key] === 'boolean') flags[key] = input.flags[key];
    }
    if (flags.manual_acceptance === true) {
      flags.expanded_autonomy = false;
      for (const key of DOMAIN_KEYS) flags[key] = false;
    }
    if (row.mode !== 'expanded_auto') {
      for (const key of DOMAIN_KEYS) flags[key] = false;
    }
    const mode = flags.manual_acceptance === true ? 'manual' : row.mode;
    const now = Date.now();
    this.db.prepare('UPDATE cp_expanded_autonomy SET mode=?, flags=?, updated_at=?, updated_by=?, request_id=? WHERE id=1')
      .run(mode, JSON.stringify(flags), now, owner, input.request_id);
    if (flags.manual_acceptance === true) {
      try { this.bridge.missions?.riskAcceptance?.setPreference({ enabled: false, confirmed: true }, owner); } catch { /* */ }
    }
    this.audit('flags_set', { mode, flags }, owner, input.request_id);
    this.bridge.controlStore.event('expanded_autonomy.flags_set', null, {
      mode, request_id: input.request_id, authority: false
    });
    this.bridge.emit?.('change');
    return this.effective(owner);
  }

  emergencyStop(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may emergency-stop Expanded Autonomy');
    object(input, ['confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    const now = Date.now();
    const flags = { ...DEFAULT_FLAGS, manual_acceptance: true, expanded_autonomy: false };
    this.db.prepare(`UPDATE cp_expanded_autonomy SET mode='manual', flags=?, emergency_stop=1,
      emergency_stop_at=?, emergency_stop_by=?, emergency_request_id=?, authorized_at=NULL,
      updated_at=?, updated_by=?, request_id=? WHERE id=1`)
      .run(JSON.stringify(flags), now, owner, input.request_id, now, owner, input.request_id);
    try { this.bridge.missions?.riskAcceptance?.setPreference({ enabled: false, confirmed: true }, owner); } catch { /* */ }
    try {
      if (this.bridge.globalAutopilot?.enabled?.()) {
        this.bridge.globalAutopilot.stop({ confirmed: true, request_id: randomUUID() }, owner);
      }
    } catch { /* */ }
    // Revoke active expanded domain policies so queued work cannot use old authority.
    for (const p of this.listPolicies().filter(x => x.active && !x.revoked_at)) {
      this.db.prepare('UPDATE cp_expanded_autonomy_policies SET active=0, revoked_at=? WHERE id=?').run(now, p.id);
    }
    this.audit('emergency_stop', { revoked_policies: true }, owner, input.request_id);
    this.bridge.controlStore.event('expanded_autonomy.emergency_stop', null, {
      request_id: input.request_id, authority: false
    });
    this.bridge.emit?.('change');
    return this.effective(owner);
  }

  clearEmergency(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may clear Expanded Autonomy emergency stop');
    object(input, ['confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    const now = Date.now();
    this.db.prepare(`UPDATE cp_expanded_autonomy SET emergency_stop=0, emergency_stop_at=NULL,
      emergency_stop_by=NULL, emergency_request_id=NULL, updated_at=?, updated_by=?, request_id=? WHERE id=1`)
      .run(now, owner, input.request_id);
    this.audit('emergency_cleared', {}, owner, input.request_id);
    this.bridge.emit?.('change');
    return this.effective(owner);
  }

  listPolicies(domain = null) {
    const rows = domain
      ? this.db.prepare('SELECT * FROM cp_expanded_autonomy_policies WHERE domain=? ORDER BY created_at DESC').all(domain)
      : this.db.prepare('SELECT * FROM cp_expanded_autonomy_policies ORDER BY created_at DESC').all();
    return rows.map(r => ({
      id: r.id,
      domain: r.domain,
      policy: parseJson(r.policy, {}),
      policy_hash: r.policy_hash,
      active: r.active === 1,
      qualified: r.qualified === 1,
      created_at: r.created_at,
      expires_at: r.expires_at || null,
      revoked_at: r.revoked_at || null,
      created_by: r.created_by,
      authority: false
    }));
  }

  enrollPolicy(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may enroll Expanded Autonomy policies');
    object(input, ['domain', 'policy', 'confirmed', 'request_id', 'qualified']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    if (!DOMAIN_KEYS.includes(input.domain)) throw Error('Unknown Expanded Autonomy domain');
    if (!input.policy || typeof input.policy !== 'object') throw Error('Standing policy object required');
    const eff = this.effective(owner);
    if (eff.mode !== 'expanded_auto') throw Error('Domain enrollment requires EXPANDED AUTO mode');
    if (eff.flags[input.domain] !== true) throw Error('Domain flag is off');
    if (eff.emergency_stop || eff.expired) throw Error('Expanded Autonomy is stopped or expired');
    // Financial and production remain unqualified until independent qualification records them.
    const qualified = input.qualified === true &&
      input.domain !== 'financial_automation' &&
      input.domain !== 'production_automation'
      ? true
      : input.domain === 'financial_automation' || input.domain === 'production_automation'
        ? false
        : input.qualified === true;
    if ((input.domain === 'financial_automation' || input.domain === 'production_automation') && input.qualified === true) {
      throw Error('Financial and production automation cannot be marked qualified until their adapters pass independent qualification');
    }
    this.assertPolicyShape(input.domain, input.policy);
    const id = randomUUID();
    const now = Date.now();
    const policyJson = JSON.stringify(input.policy);
    const policyHash = require('./control-plane-store').fingerprint(input.policy);
    let expiresAt = null;
    if (input.policy.expires_at != null) {
      if (!Number.isInteger(input.policy.expires_at) || input.policy.expires_at <= now) throw Error('policy.expires_at must be future epoch ms');
      expiresAt = input.policy.expires_at;
    }
    this.db.prepare(`INSERT INTO cp_expanded_autonomy_policies
      (id,domain,policy,policy_hash,active,qualified,created_at,expires_at,revoked_at,created_by,request_id)
      VALUES(?,?,?,?,1,?,?,?,?,?,?)`)
      .run(id, input.domain, policyJson, policyHash, qualified ? 1 : 0, now, expiresAt, null, owner, input.request_id);
    this.audit('policy_enrolled', { id, domain: input.domain, qualified }, owner, input.request_id);
    this.bridge.emit?.('change');
    return this.listPolicies(input.domain).find(p => p.id === id);
  }

  revokePolicy(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may revoke Expanded Autonomy policies');
    object(input, ['policy_id', 'confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    identifier(input.policy_id);
    const now = Date.now();
    const row = this.db.prepare('SELECT * FROM cp_expanded_autonomy_policies WHERE id=?').get(input.policy_id);
    if (!row) throw Error('Standing policy unavailable');
    this.db.prepare('UPDATE cp_expanded_autonomy_policies SET active=0, revoked_at=? WHERE id=?').run(now, input.policy_id);
    this.audit('policy_revoked', { id: input.policy_id, domain: row.domain }, owner, input.request_id);
    this.bridge.emit?.('change');
    return { revoked: true, policy_id: input.policy_id, authority: false };
  }

  assertPolicyShape(domain, policy) {
    if (domain === 'credential_automation') {
      if (typeof policy.credential_ref !== 'string' || !policy.credential_ref) throw Error('credential_ref required');
      if (typeof policy.application !== 'string' || !policy.application) throw Error('approved application required');
      if (typeof policy.purpose !== 'string' || !policy.purpose) throw Error('purpose required');
      if (!Array.isArray(policy.operations) || !policy.operations.length) throw Error('authorized operations required');
      if (policy.disclose_values === true) throw Error('Credential policies cannot authorize value disclosure');
    } else if (domain === 'financial_automation') {
      if (!Array.isArray(policy.accounts) || !policy.accounts.length) throw Error('authorized accounts required');
      if (!Array.isArray(policy.recipients) || !policy.recipients.length) throw Error('approved recipients required');
      if (!Number.isFinite(policy.per_transaction_limit) || policy.per_transaction_limit <= 0) throw Error('per_transaction_limit required');
      if (!Number.isFinite(policy.daily_limit) || policy.daily_limit <= 0) throw Error('daily_limit required');
      if (!Number.isFinite(policy.monthly_limit) || policy.monthly_limit <= 0) throw Error('monthly_limit required');
      if (typeof policy.currency !== 'string' || !policy.currency) throw Error('currency required');
    } else if (domain === 'production_automation') {
      if (!Array.isArray(policy.repositories) || !policy.repositories.length) throw Error('approved repositories required');
      if (!Array.isArray(policy.services) || !policy.services.length) throw Error('approved services required');
      if (!Array.isArray(policy.required_checks) || !policy.required_checks.length) throw Error('required checks required');
      if (policy.force_merge === true || policy.bypass_branch_protection === true) {
        throw Error('Force merge and branch-protection bypass are forbidden');
      }
    } else if (domain === 'destructive_automation') {
      if (!Array.isArray(policy.allowed_paths) || !policy.allowed_paths.length) throw Error('allowed_paths required');
      if (!Array.isArray(policy.deletion_types) || !policy.deletion_types.length) throw Error('deletion_types required');
      if (!Number.isInteger(policy.max_items) || policy.max_items < 1) throw Error('max_items required');
      if (policy.deletion_types.includes('permanent') && policy.require_recovery !== true) {
        throw Error('Permanent deletion requires explicit require_recovery:true in the standing policy');
      }
      if ((policy.allowed_paths || []).some(p => /(?:^|\/)(?:audit|approval|recovery|safety)(?:\/|$)/i.test(String(p)))) {
        throw Error('Destructive policies cannot target audit, approval, recovery, or safety records');
      }
    } else if (domain === 'broad_resource_access') {
      if (!Array.isArray(policy.resources) || !policy.resources.length) throw Error('resources required');
      if (policy.unrestricted === true || policy.wildcard === true) {
        throw Error('Unrestricted wildcards are forbidden');
      }
    }
  }

  /**
   * Whether new automated Acceptance decisions are permitted for this Mission.
   * Never retroactively authorizes Missions created before standing authorization.
   */
  mayAutoAccept(mission) {
    const eff = this.effective('operator');
    if (eff.mode === 'manual' || eff.emergency_stop || eff.expired) {
      return { allow: false, reason: 'expanded_autonomy_manual_or_stopped' };
    }
    if (eff.flags.manual_acceptance === true) {
      return { allow: false, reason: 'manual_acceptance_forced' };
    }
    if (!mission) return { allow: false, reason: 'mission_required' };
    // Per-mission automatic_acceptance remains an explicit operator preauth path.
    if (mission.envelope?.automatic_acceptance === true) {
      return { allow: true, reason: 'mission_preauthorized', mode: eff.mode };
    }
    if (mission.envelope?.risk_auto_acceptance?.authorized === true) {
      return { allow: true, reason: 'risk_preauthorized', mode: eff.mode };
    }
    // Standing mode must not authorize historical Missions.
    const authorizedAt = eff.authorized_at;
    if (!Number.isInteger(authorizedAt) || !Number.isInteger(mission.created_at) || mission.created_at < authorizedAt) {
      return { allow: false, reason: 'historical_mission_not_retroactive' };
    }
    return { allow: true, reason: 'standing_mode', mode: eff.mode };
  }

  /**
   * Capability Broker / SafetyPolicy gate for high-impact domains.
   * Fail closed unless EXPANDED AUTO + flag + enrolled qualified policy matches.
   */
  authorizeDomain(domain, context = {}) {
    const eff = this.effective('operator');
    if (eff.mode !== 'expanded_auto' || eff.emergency_stop || eff.expired) {
      return { allow: false, reason: 'expanded_autonomy_not_active', automatic: false };
    }
    if (eff.flags[domain] !== true) {
      return { allow: false, reason: 'domain_flag_off', automatic: false };
    }
    const now = Date.now();
    const active = this.listPolicies(domain).filter(p =>
      p.active && !p.revoked_at && p.qualified && (!p.expires_at || p.expires_at > now));
    if (!active.length) {
      return { allow: false, reason: 'no_qualified_standing_policy', automatic: false };
    }
    if (domain === 'financial_automation' || domain === 'production_automation') {
      return { allow: false, reason: 'domain_not_independently_qualified', automatic: false, policies: active.length };
    }
    if (domain === 'credential_automation') {
      const match = active.find(p =>
        p.policy.credential_ref === context.credential_ref &&
        p.policy.application === context.application &&
        p.policy.purpose === context.purpose &&
        Array.isArray(p.policy.operations) &&
        p.policy.operations.includes(context.operation));
      if (!match) return { allow: false, reason: 'credential_purpose_mismatch', automatic: false };
      if (context.disclose_values === true) return { allow: false, reason: 'credential_values_opaque', automatic: false };
      return { allow: true, reason: 'standing_credential_policy', automatic: true, policy_id: match.id };
    }
    if (domain === 'destructive_automation') {
      const match = active.find(p => {
        const pathOk = (p.policy.allowed_paths || []).some(prefix =>
          typeof context.path === 'string' && (context.path === prefix || context.path.startsWith(prefix.replace(/\/*$/, '') + '/')));
        const typeOk = (p.policy.deletion_types || []).includes(context.deletion_type);
        const countOk = !Number.isInteger(context.item_count) || context.item_count <= p.policy.max_items;
        return pathOk && typeOk && countOk;
      });
      if (!match) return { allow: false, reason: 'destructive_policy_mismatch', automatic: false };
      if (/audit|approval|recovery|safety/i.test(String(context.path || ''))) {
        return { allow: false, reason: 'protected_safety_records', automatic: false };
      }
      return { allow: true, reason: 'standing_destructive_policy', automatic: true, policy_id: match.id };
    }
    if (domain === 'broad_resource_access') {
      const match = active.find(p => (p.policy.resources || []).some(r =>
        r === context.resource || (typeof r === 'string' && typeof context.resource === 'string' && context.resource.startsWith(r))));
      if (!match) return { allow: false, reason: 'resource_not_enrolled', automatic: false };
      return { allow: true, reason: 'standing_resource_policy', automatic: true, policy_id: match.id };
    }
    return { allow: false, reason: 'domain_gate_default_deny', automatic: false };
  }
}

module.exports = {
  ExpandedAutonomy,
  MODES,
  DOMAIN_KEYS,
  DEFAULT_FLAGS
};
