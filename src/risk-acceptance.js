'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fingerprint, object, identifier } = require('./control-plane-store');
const { transaction } = require('./control-transaction');
const { workspaceSnapshot } = require('./control-context');
const { safeOrigin } = require('./research-network');

// Host-owned Trusted Autonomy / risk-based automatic Acceptance for low-risk local WORK.
// Default ON for fresh installs and upgrades. Explicit owner OFF is permanent and never
// reset by migration. Untrusted packets cannot set automatic_acceptance. Historical
// Missions are never silently accepted without authorizeExisting.
// Standing public origins authorize fresh per-Mission grants only; website content cannot expand them.
const SAFE_SCOPES = new Set(['repo', 'developer_environment']);
const TRUSTED_AUTONOMY_CONFIG = path.join(__dirname, '../config/trusted-autonomy-v1.json');
const RESEARCH_DELEGATED_EVIDENCE =
  'Trusted Autonomy owner-delegated completion: host mechanical checks passed (web evidence integrity, browser termination, read-only boundary, artifact/baseline integrity). Factual website claims were not personally reviewed by a human. human_acceptance=false.';

function loadTrustedAutonomyConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(TRUSTED_AUTONOMY_CONFIG, 'utf8'));
    const origins = Array.isArray(raw.standing_public_origins) ? raw.standing_public_origins : [];
    return {
      standing_public_origins: origins.map(o => safeOrigin(o)).filter(Boolean),
      public_research: raw.public_research || {}
    };
  } catch {
    return { standing_public_origins: [], public_research: {} };
  }
}

function trustedAutonomyStatus(enabled) {
  return {
    enabled: enabled === true,
    persistence: 'permanent',
    routine_approvals: 'automatic',
    public_research: 'always_allow_approved_origins',
    local_reasoning: 'automatic',
    approved_workspace_operations: 'automatic',
    safe_local_development: 'automatic',
    verified_mission_completion: enabled === true ? 'automatic' : 'manual',
    owner_notifications: 'enabled'
  };
}

class RiskAcceptance {
  constructor(service) {
    this.service = service;
    this.bridge = service.bridge;
    this.store = service.store;
    this.db = this.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_risk_acceptance(
      mission_id TEXT PRIMARY KEY,
      envelope_hash TEXT NOT NULL,
      policy TEXT NOT NULL,
      review_reason TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cp_risk_acceptance_preference(
      id INTEGER PRIMARY KEY CHECK(id=1),
      enabled INTEGER NOT NULL,
      privacy TEXT NOT NULL,
      data_class TEXT NOT NULL,
      workers TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      owner_set INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cp_trusted_autonomy_origins(
      origin TEXT PRIMARY KEY,
      approved_at INTEGER NOT NULL,
      approved_by TEXT NOT NULL,
      source TEXT NOT NULL,
      revoked_at INTEGER
    );`);
    // Existing installs may predate owner_set; add the column before any INSERT that names it.
    this.#ensureOwnerSetColumn();
    this.db.prepare(`INSERT OR IGNORE INTO cp_risk_acceptance_preference(id,enabled,privacy,data_class,workers,updated_at,updated_by,owner_set)
      VALUES(1,1,'local_only','public','["opencode"]',0,'system',0)`).run();
    this.#applyTrustedAutonomyDefault();
    this.#ensureStandingOrigins();
  }

  #ensureStandingOrigins() {
    const cfg = loadTrustedAutonomyConfig();
    const now = Date.now();
    for (const origin of cfg.standing_public_origins) {
      this.db.prepare(`INSERT OR IGNORE INTO cp_trusted_autonomy_origins(origin,approved_at,approved_by,source,revoked_at)
        VALUES(?,?,?,?,NULL)`).run(origin, now, 'system', 'trusted_autonomy_config');
    }
  }

  standingOrigins() {
    return this.db.prepare('SELECT origin FROM cp_trusted_autonomy_origins WHERE revoked_at IS NULL ORDER BY origin')
      .all().map(r => r.origin);
  }

  originsApproved(origins) {
    if (!Array.isArray(origins) || !origins.length) return false;
    const standing = new Set(this.standingOrigins());
    return origins.every(o => {
      try { return standing.has(safeOrigin(o)); } catch { return false; }
    });
  }

  approveStandingOrigin(origin, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may approve standing public research origins');
    const normalized = safeOrigin(origin);
    const now = Date.now();
    this.db.prepare(`INSERT INTO cp_trusted_autonomy_origins(origin,approved_at,approved_by,source,revoked_at)
      VALUES(?,?,?,?,NULL)
      ON CONFLICT(origin) DO UPDATE SET approved_at=excluded.approved_at, approved_by=excluded.approved_by,
        source=excluded.source, revoked_at=NULL`).run(normalized, now, actor, 'owner_authorization');
    this.store.event('trusted_autonomy.origin_approved', null, {
      origin: normalized,
      automated: false,
      owner_policy: 'trusted_autonomy'
    });
    return this.standingOrigins();
  }

  revokeStandingOrigin(origin, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may revoke standing public research origins');
    const normalized = safeOrigin(origin);
    this.db.prepare('UPDATE cp_trusted_autonomy_origins SET revoked_at=? WHERE origin=? AND revoked_at IS NULL')
      .run(Date.now(), normalized);
    this.store.event('trusted_autonomy.origin_revoked', null, {
      origin: normalized,
      owner_policy: 'trusted_autonomy'
    });
    return this.standingOrigins();
  }

  #ensureOwnerSetColumn() {
    const cols = this.db.prepare('PRAGMA table_info(cp_risk_acceptance_preference)').all();
    if (!cols.some(c => c.name === 'owner_set')) {
      this.db.exec('ALTER TABLE cp_risk_acceptance_preference ADD COLUMN owner_set INTEGER NOT NULL DEFAULT 0');
      // Any prior operator write is an explicit owner choice and must never be upgraded away.
      this.db.prepare("UPDATE cp_risk_acceptance_preference SET owner_set=1 WHERE updated_by='operator'").run();
    }
  }

  // Upgrade path: system-default OFF → ON once. Never touch owner_set=1 rows.
  #applyTrustedAutonomyDefault() {
    const row = this.db.prepare('SELECT * FROM cp_risk_acceptance_preference WHERE id=1').get();
    if (!row || row.owner_set === 1 || row.enabled === 1) return;
    const now = Date.now();
    this.db.prepare('UPDATE cp_risk_acceptance_preference SET enabled=1, updated_at=?, updated_by=? WHERE id=1 AND owner_set=0')
      .run(now, 'system');
    this.store.event('risk.auto_acceptance.default_enabled', null, {
      enabled: true,
      source: 'trusted_autonomy_default',
      persistence: 'permanent',
      owner_set: false,
      automated: true
    });
  }

  preference() {
    const row = this.db.prepare('SELECT * FROM cp_risk_acceptance_preference WHERE id=1').get();
    const enabled = row?.enabled === 1;
    return {
      enabled,
      privacy: row?.privacy || 'local_only',
      data_class: row?.data_class || 'public',
      workers: JSON.parse(row?.workers || '["opencode"]'),
      updated_at: row?.updated_at || null,
      updated_by: row?.updated_by || null,
      owner_set: row?.owner_set === 1,
      persistence: 'permanent',
      inheritable: false,
      applies_to: 'new_eligible_opencode_work',
      historical_missions: 'require_authorize_existing',
      trusted_autonomy: trustedAutonomyStatus(enabled),
      standing_public_origins: this.standingOrigins()
    };
  }

  setPreference(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may change risk auto acceptance preference');
    object(input, ['enabled', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (typeof input.enabled !== 'boolean') throw Error('enabled must be boolean');
    this.db.prepare('UPDATE cp_risk_acceptance_preference SET enabled=?, privacy=?, data_class=?, workers=?, updated_at=?, updated_by=?, owner_set=1 WHERE id=1')
      .run(input.enabled ? 1 : 0, 'local_only', 'public', JSON.stringify(['opencode']), Date.now(), actor);
    if (input.enabled) this.#ensureStandingOrigins();
    this.store.event(input.enabled ? 'risk.auto_acceptance.preference_enabled' : 'risk.auto_acceptance.preference_disabled', null, {
      enabled: input.enabled,
      privacy: 'local_only',
      data_class: 'public',
      owner_set: true,
      persistence: 'permanent',
      trusted_autonomy: trustedAutonomyStatus(input.enabled),
      standing_public_origins: this.standingOrigins()
    });
    return this.preference();
  }

  status() {
    const preference = this.preference();
    return {
      preference,
      trusted_autonomy: preference.trusted_autonomy,
      standing_public_origins: preference.standing_public_origins,
      waits: require('./wait-presentation').status(this.bridge),
      eligibility: {
        privacy: 'local_only',
        data_class: 'public',
        workers: ['opencode'],
        scopes: [...SAFE_SCOPES],
        verification: 'airodrom:host-verifier passed at current revision',
        pending_approvals: 'block',
        historical: 'authorizeExisting with confirmed operator consent only',
        public_research: 'always_allow_approved_origins',
        protected_operations: [
          'email_or_messaging_send',
          'payments_or_purchases',
          'credential_disclosure',
          'destructive_operations',
          'production_deployments',
          'privileged_system_changes',
          'unapproved_external_services',
          'uncertain_external_side_effects'
        ]
      }
    };
  }

  // Fresh per-Mission grant from standing approved origins when Trusted Autonomy is ON.
  // Does not expand origins; unapproved origins remain denied.
  authorizeStandingGrant(missionId, input = {}) {
    if (!this.preference().enabled) return { granted: false, reason: 'trusted_autonomy_off' };
    let m;
    try { m = this.store.requireMission(missionId); }
    catch { return { granted: false, reason: 'mission_unavailable' }; }
    const web = this.service.web || this.bridge.missions?.web;
    if (!web) return { granted: false, reason: 'mission_web_unavailable' };
    let entries = input.entries;
    let mode = input.mode || 'on';
    if (!entries?.length) {
      const sealed = m.envelope.manifest?.public_web;
      if (sealed?.entries?.length) {
        entries = sealed.entries;
        mode = sealed.mode || 'on';
      } else {
        const proposed = require('./mission-web-policy').proposal(m.envelope.objective);
        entries = proposed.entries;
        mode = proposed.mode === 'on' ? 'on' : null;
      }
    }
    if (mode !== 'on' || !entries?.length) return { granted: false, reason: 'standing_grant_requires_exact_origins' };
    const origins = [...new Set(entries.map(v => safeOrigin(new URL(v).origin)))];
    if (!this.originsApproved(origins)) return { granted: false, reason: 'unapproved_origin' };
    if (m.envelope.manifest?.account_authorization || m.envelope.manifest?.session_authorization) {
      return { granted: false, reason: 'account_or_session_research_denied' };
    }
    try { web.grant(m, { active: false }); return { granted: true, duplicate: true, origins }; } catch { /* need grant */ }
    const { randomUUID } = require('node:crypto');
    const result = web.configure(missionId, {
      request_id: input.request_id || randomUUID(),
      mode: 'on',
      entries,
      confirmed: true,
      permission_mode: 'strict',
      duration_ms: input.duration_ms || 180000
    }, 'operator');
    this.store.event('trusted_autonomy.standing_grant', missionId, {
      grant_id: result.grant_id,
      origins,
      automated: true,
      owner_policy: 'trusted_autonomy',
      completion_type: 'automatic'
    });
    return { granted: true, grant_id: result.grant_id, origins, automated: true };
  }

  evaluatePublicResearch(id) {
    const deny = reason => ({ accepted: false, reason });
    if (!this.preference().enabled) return deny('trusted_autonomy_off');
    const m = this.store.requireMission(id);
    if (m.state === 'completed') return { accepted: true, duplicate: true };
    if (m.state !== 'awaiting_acceptance') return deny('verification_not_ready');
    if (m.envelope.kind !== 'browser_research' && !m.envelope.manifest?.public_web) return deny('not_public_research');
    if (m.envelope.manifest?.account_authorization || m.envelope.manifest?.session_authorization) {
      return deny('account_or_session_research_denied');
    }
    if (m.envelope.coding_plan) return deny('high_risk_mission_kind');
    const web = this.service.web || this.bridge.missions?.web;
    if (!web) return deny('mission_web_unavailable');
    let grant;
    try { grant = web.grant(m, { active: false }); } catch { return deny('mission_web_approval_required'); }
    const origins = grant.policy.origins || [];
    if (grant.policy.mode !== 'on' || !this.originsApproved(origins)) return deny('unapproved_origin');
    if (grant.policy.private_accounts || grant.policy.downloads) return deny('protected_research_capabilities');
    if (this.store.decisions(id).some(d => d.state === 'waiting_for_operator')) return deny('waiting_decision');
    if (this.bridge.policy.list().some(p => p.status === 'pending' && this.store.missionForTask(p.taskId)?.id === id)) {
      return deny('pending_approval');
    }
    if (web.uncertainBrowsers?.has(id)) return deny('browser_termination_uncertain');
    const v = this.db.prepare('SELECT * FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
    if (!v || v.result !== 'operator_review' || v.revision !== m.revision) return deny('operator_review_verification_required');
    const checks = JSON.parse(v.evidence);
    const mechanical = ['web_evidence', 'browser_termination', 'artifact_integrity', 'native_execution', 'read_only_boundary', 'baseline_integrity', 'verification_workspace_stable'];
    for (const idCheck of mechanical) {
      const row = checks.find(c => c.id === idCheck);
      if (row && row.status === 'failed') return deny('mechanical_check_failed:' + idCheck);
    }
    if (!checks.some(c => c.id === 'report' && c.status === 'operator_review')) return deny('report_review_marker_required');
    if (checks.some(c => c.status === 'failed')) return deny('verification_failed');
    const run = this.store.run(v.run_id);
    if (!run || run.mission_id !== id || run.state !== 'completed' || !run.termination_verified) return deny('run_termination_required');
    if (!require('./execution-evidence').runSatisfied(run)) return deny('native_tool_required');
    try { web.verify(m, run); } catch { return deny('web_evidence_integrity_denied'); }
    const snap = m.envelope.kind === 'browser_research'
      ? this.service.research.safeSnapshot(m)
      : workspaceSnapshot(m.envelope.workspace);
    if (snap.hash !== v.workspace_hash) return deny('stale_workspace');
    return {
      accepted: true,
      verification_id: v.id,
      origins,
      completion_type: 'automatic',
      human_acceptance: false,
      owner_policy: 'trusted_autonomy'
    };
  }

  attemptPublicResearch(id) {
    return transaction(this.db, () => {
      const result = this.evaluatePublicResearch(id);
      if (!result.accepted) return result;
      if (result.duplicate) return result;
      this.service.accept(id, {
        request_id: `trusted-autonomy-research:${result.verification_id}`,
        verification_id: result.verification_id,
        decision: 'accept',
        rationale: 'Trusted Autonomy: owner-delegated automatic completion for standing approved-origin public research after mechanical host verification. Not human Acceptance of factual claims.',
        evidence: RESEARCH_DELEGATED_EVIDENCE
      }, 'operator');
      this.store.event('trusted_autonomy.public_research.completed', id, {
        ...result,
        automated: true,
        acceptance_kind: 'owner_delegated_mechanical',
        human_acceptance: false,
        completion_type: 'automatic',
        owner_policy: 'trusted_autonomy'
      });
      return result;
    });
  }

  validateCreation(input, owner) {
    // A signed owner-registered WORK template never inherits the standing preference.
    // Only one explicit, already owner-approved exact-file Mission may opt in.
    if (input.work_template && input.risk_auto_acceptance !== true) return null;
    if (input.work_template &&
       (input.criteria?.length !== 1 || input.criteria[0]?.type !== 'exact_file'))
      throw Error('Template auto Acceptance requires one owner-preauthorized exact-file criterion');
    const explicit = input.risk_auto_acceptance;
    const preferenceOn = this.preference().enabled === true;
    const opted = explicit === true || (explicit !== false && preferenceOn);
    if (!opted) return null;
    // Standing preference only attaches to eligible low-risk OpenCode WORK.
    // Ineligible shapes skip silently unless the Mission explicitly requested auto Acceptance.
    const require = (ok, message) => {
      if (ok) return;
      if (explicit === true) throw Error(message);
      return 'skip';
    };
    if (owner !== 'operator') {
      if (explicit === true) throw Error('Risk auto acceptance requires operator authorization');
      return null;
    }
    if (input.automatic_acceptance === true) {
      if (explicit === true) throw Error('Risk auto acceptance cannot combine with coding-plan automatic Acceptance');
      return null;
    }
    if (input.fixture_auto_acceptance === true) {
      if (explicit === true) throw Error('Risk auto acceptance cannot combine with fixture auto acceptance');
      return null;
    }
    const preferred = input.preferred_agent || 'claude_code';
    if (require(preferred === 'opencode', 'Risk auto acceptance requires OpenCode only') === 'skip') return null;
    if (require(!(input.fallback_agents || []).length, 'Risk auto acceptance forbids fallback workers') === 'skip') return null;
    const scopes = input.capability_scopes || ['repo', 'developer_environment'];
    if (require(!scopes.some(s => !SAFE_SCOPES.has(s)), 'Risk auto acceptance scopes exceed repo/developer_environment') === 'skip') return null;
    const privacy = input.dispatch_policy?.privacy || (preferred === 'opencode' ? 'local_only' : null);
    const dataClass = input.data_class || 'public';
    if (require(privacy === 'local_only' && dataClass === 'public', 'Risk auto acceptance requires privacy local_only and data_class public') === 'skip') return null;
    if (require(!(input.criteria || []).some(c => c.type === 'operator_review'), 'Risk auto acceptance forbids operator_review criteria') === 'skip') return null;
    if (require(!input.coding_plan, 'Risk auto acceptance does not cover high-risk coding-plan Missions') === 'skip') return null;
    return {
      authorized: true,
      privacy: 'local_only',
      data_class: 'public',
      workers: ['opencode'],
      scopes: [...scopes],
      criteria_hash: fingerprint(input.criteria || []),
      source: explicit === true || input.work_template ? 'mission_mark' : 'operator_preference',
      inheritable: false,
      automated: true,
      acceptance_kind: 'automatic_verified'
    };
  }

  register(mission, policy) {
    if (!policy?.authorized) return;
    this.db.prepare('INSERT OR REPLACE INTO cp_risk_acceptance VALUES(?,?,?,?,?)')
      .run(mission.id, fingerprint(mission.envelope), JSON.stringify(policy), null, Date.now());
    this.store.event('risk.auto_acceptance.authorized', mission.id, {
      privacy: policy.privacy,
      data_class: policy.data_class,
      source: policy.source || 'mission_mark',
      automated: true,
      acceptance_kind: 'automatic_verified'
    });
  }

  // Fresh evaluation for an existing awaiting Mission. Never silent from preference alone.
  authorizeExisting(id, input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may authorize risk auto acceptance on an existing Mission');
    object(input, ['request_id', 'confirmed']);
    identifier(input.request_id);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    // Bind policy inside the request; attempt Acceptance outside so missions.accept is not nested.
    this.store.request(actor, input.request_id, { op: 'risk_authorize_existing', id }, () => {
      const m = this.store.requireMission(id);
      if (m.state !== 'awaiting_acceptance') throw Error('Mission must be awaiting acceptance for fresh risk authorization');
      const policy = this.validateCreation({
        risk_auto_acceptance: true,
        preferred_agent: m.envelope.preferred_agent,
        fallback_agents: m.envelope.fallback_agents || [],
        capability_scopes: m.envelope.capability_scopes,
        dispatch_policy: m.envelope.dispatch_policy,
        data_class: m.envelope.data_class || 'public',
        criteria: m.envelope.criteria,
        coding_plan: m.envelope.coding_plan,
        automatic_acceptance: m.envelope.automatic_acceptance,
        fixture_auto_acceptance: false
      }, actor);
      if (!policy) throw Error('Mission is not eligible for risk auto acceptance');
      const envelope = { ...m.envelope, risk_auto_acceptance: policy, data_class: policy.data_class };
      this.db.prepare('UPDATE cp_missions SET envelope=?, updated_at=? WHERE id=?').run(JSON.stringify(envelope), Date.now(), id);
      const updated = this.store.requireMission(id);
      this.register(updated, policy);
      this.store.event('risk.auto_acceptance.existing_authorized', id, { source: 'authorize_existing' });
      return { authorized: true, mission_id: id };
    });
    return this.attempt(id);
  }

  remember(id, reason) {
    this.db.prepare('UPDATE cp_risk_acceptance SET review_reason=?, updated_at=? WHERE mission_id=?')
      .run(reason, Date.now(), id);
    const m = this.store.getMission(id);
    if (m && m.state === 'awaiting_acceptance') {
      this.store.event('risk.auto_acceptance.denied', id, { reason, automated: true });
    }
  }

  reviewReason(id) {
    return this.db.prepare('SELECT review_reason FROM cp_risk_acceptance WHERE mission_id=?').get(id)?.review_reason || null;
  }

  evaluate(id) {
    const m = this.store.requireMission(id);
    const deny = reason => ({ accepted: false, reason });
    const row = this.db.prepare('SELECT * FROM cp_risk_acceptance WHERE mission_id=?').get(id);
    const policy = m.envelope.risk_auto_acceptance;
    if (!row || !policy?.authorized) return deny('not_preauthorized_risk');
    if (row.envelope_hash !== fingerprint(m.envelope)) return deny('envelope_changed');
    if (m.state === 'completed') {
      const v = this.db.prepare('SELECT * FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
      if (!v || !require('./execution-evidence').runSatisfied(this.store.run(v.run_id))) return deny('native_tool_required');
      return { accepted: true, duplicate: true };
    }
    if (m.state !== 'awaiting_acceptance') return deny('verification_not_ready');
    if (policy.privacy !== 'local_only' || policy.data_class !== 'public') return deny('privacy_or_data_class');
    if (m.envelope.preferred_agent !== 'opencode' || (m.envelope.fallback_agents || []).length) return deny('worker_route');
    if ((m.envelope.capability_scopes || []).some(s => !SAFE_SCOPES.has(s))) return deny('privileged_scopes');
    if (m.envelope.dispatch_policy && m.envelope.dispatch_policy.privacy !== 'local_only') return deny('external_privacy');
    if (m.envelope.kind === 'browser_research' || m.envelope.coding_plan) return deny('high_risk_mission_kind');
    if ((m.envelope.criteria || []).some(c => c.type === 'operator_review')) return deny('operator_review_criteria');
    if (m.envelope.work_template) {
      if (!Array.isArray(m.envelope.criteria) || m.envelope.criteria.length !== 1 ||
          m.envelope.criteria[0].type !== 'exact_file' || policy.source !== 'mission_mark')
        return deny('template_auto_acceptance_scope');
      try { this.bridge.workTemplates.assertMission(m); }
      catch { return deny('template_expired_or_changed'); }
    }
    if (policy.criteria_hash !== fingerprint(m.envelope.criteria)) return deny('criteria_changed');
    try { this.service.assertAuthority(m); } catch { return deny('authority_mismatch'); }
    if (this.store.decisions(id).some(d => d.state === 'waiting_for_operator')) return deny('waiting_decision');
    if (this.bridge.policy.list().some(p => p.status === 'pending' && this.store.missionForTask(p.taskId)?.id === id)) return deny('pending_approval');
    if (this.db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND state IN ('held','quarantined') AND mode='write'").get(m.envelope.workspace)) {
      return deny('workspace_writer');
    }
    const v = this.db.prepare('SELECT * FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
    if (!v || v.result !== 'passed' || v.checker !== 'airodrom:host-verifier' || v.revision !== m.revision) {
      return deny('independent_verification_required');
    }
    const run = this.store.run(v.run_id);
    const checks = JSON.parse(v.evidence);
    if (!require('./execution-evidence').runSatisfied(run)) return deny('native_tool_required');
    if (!run || run.mission_id !== id || run.task_id !== m.task_id || run.state !== 'completed' || !run.termination_verified) {
      return deny('run_correlation');
    }
    if (m.envelope.criteria.some(c => !checks.some(x => x.id === c.id && x.status === 'passed')) || checks.some(c => c.status !== 'passed')) {
      return deny('missing_or_failed_checker');
    }
    if (m.envelope.manifest) {
      const r = this.db.prepare('SELECT * FROM cp_mission_reviews WHERE mission_id=? AND verification_id=?').get(id, v.id);
      const contract = this.service.program.contract(id);
      if (!r || r.result !== 'passed' || r.workspace_hash !== v.workspace_hash || (contract && r.manifest_hash !== contract.manifest_hash)) {
        return deny('review_broker_required');
      }
    }
    const snap = workspaceSnapshot(m.envelope.workspace);
    if (snap.hash !== v.workspace_hash) return deny('stale_workspace');
    const allowed = new Set(m.envelope.allowed_files || []);
    if ((snap.dirty || []).some(f => !allowed.has(f))) return deny('unauthorized_workspace_changes');
    return { accepted: true, verification_id: v.id, envelope_hash: row.envelope_hash };
  }

  attempt(id) {
    return transaction(this.db, () => {
      const result = this.evaluate(id);
      if (!result.accepted) {
        if (result.reason !== 'not_preauthorized_risk' && result.reason !== 'verification_not_ready') this.remember(id, result.reason);
        return result;
      }
      if (result.duplicate) return result;
      this.service.accept(id, {
        request_id: `risk-accept:${result.verification_id}`,
        verification_id: result.verification_id,
        decision: 'accept',
        rationale: 'Trusted Autonomy: local-only public OpenCode WORK; independent verification satisfied. Automated completion is not human Acceptance.'
      }, 'operator');
      this.db.prepare('UPDATE cp_risk_acceptance SET review_reason=NULL, updated_at=? WHERE mission_id=?').run(Date.now(), id);
      this.store.event('risk.auto_acceptance.completed', id, {
        ...result,
        automated: true,
        acceptance_kind: 'automatic_verified',
        human_acceptance: false
      });
      return result;
    });
  }

  reconcile() {
    // Preference alone never binds historical OpenCode WORK; only envelope-authorized rows.
    // Public research uses standing-origin owner-delegated completion when Trusted Autonomy is ON.
    for (const { id } of this.db.prepare("SELECT id FROM cp_missions WHERE state='awaiting_acceptance'").all()) {
      const m = this.store.getMission(id);
      if (m.envelope.risk_auto_acceptance?.authorized) this.attempt(id);
      else if (m.envelope.kind === 'browser_research' || m.envelope.manifest?.public_web) this.attemptPublicResearch(id);
    }
  }
}

module.exports = {
  RiskAcceptance,
  SAFE_SCOPES,
  trustedAutonomyStatus,
  loadTrustedAutonomyConfig,
  RESEARCH_DELEGATED_EVIDENCE
};
