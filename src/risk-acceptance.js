'use strict';
const { fingerprint, object, identifier } = require('./control-plane-store');
const { transaction } = require('./control-transaction');
const { workspaceSnapshot } = require('./control-context');

// Host-owned risk-based automatic Acceptance for opt-in low-risk local WORK.
// Untrusted packets cannot set automatic_acceptance. Operator preference and
// per-Mission marks are evaluated freshly; historical Missions are never
// silently accepted without authorizeExisting.
const SAFE_SCOPES = new Set(['repo', 'developer_environment']);

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
      updated_by TEXT NOT NULL
    );
    INSERT OR IGNORE INTO cp_risk_acceptance_preference VALUES(1,0,'local_only','public','["opencode"]',0,'system');`);
  }

  preference() {
    const row = this.db.prepare('SELECT * FROM cp_risk_acceptance_preference WHERE id=1').get();
    return {
      enabled: row?.enabled === 1,
      privacy: row?.privacy || 'local_only',
      data_class: row?.data_class || 'public',
      workers: JSON.parse(row?.workers || '["opencode"]'),
      updated_at: row?.updated_at || null,
      updated_by: row?.updated_by || null,
      inheritable: false,
      applies_to: 'new_eligible_opencode_work',
      historical_missions: 'require_authorize_existing'
    };
  }

  setPreference(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may change risk auto acceptance preference');
    object(input, ['enabled', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (typeof input.enabled !== 'boolean') throw Error('enabled must be boolean');
    this.db.prepare('UPDATE cp_risk_acceptance_preference SET enabled=?, privacy=?, data_class=?, workers=?, updated_at=?, updated_by=? WHERE id=1')
      .run(input.enabled ? 1 : 0, 'local_only', 'public', JSON.stringify(['opencode']), Date.now(), actor);
    this.store.event(input.enabled ? 'risk.auto_acceptance.preference_enabled' : 'risk.auto_acceptance.preference_disabled', null, {
      enabled: input.enabled,
      privacy: 'local_only',
      data_class: 'public'
    });
    return this.preference();
  }

  status() {
    return {
      preference: this.preference(),
      waits: require('./wait-presentation').status(this.bridge),
      eligibility: {
        privacy: 'local_only',
        data_class: 'public',
        workers: ['opencode'],
        scopes: [...SAFE_SCOPES],
        verification: 'airodrom:host-verifier passed at current revision',
        pending_approvals: 'block',
        historical: 'authorizeExisting with confirmed operator consent only'
      }
    };
  }

  validateCreation(input, owner) {
    const explicit = input.risk_auto_acceptance;
    const preferenceOn = this.preference().enabled === true;
    const opted = explicit === true || Boolean(input.work_template) || (explicit !== false && preferenceOn);
    if (!opted) return null;
    if (owner !== 'operator') throw Error('Risk auto acceptance requires operator authorization');
    if (input.automatic_acceptance === true) throw Error('Risk auto acceptance cannot combine with coding-plan automatic Acceptance');
    if (input.fixture_auto_acceptance === true) throw Error('Risk auto acceptance cannot combine with fixture auto acceptance');
    const preferred = input.preferred_agent || 'claude_code';
    if (preferred !== 'opencode') throw Error('Risk auto acceptance requires OpenCode only');
    if ((input.fallback_agents || []).length) throw Error('Risk auto acceptance forbids fallback workers');
    const scopes = input.capability_scopes || ['repo', 'developer_environment'];
    if (scopes.some(s => !SAFE_SCOPES.has(s))) throw Error('Risk auto acceptance scopes exceed repo/developer_environment');
    const privacy = input.dispatch_policy?.privacy || (preferred === 'opencode' ? 'local_only' : null);
    const dataClass = input.data_class || 'public';
    if (privacy !== 'local_only' || dataClass !== 'public') throw Error('Risk auto acceptance requires privacy local_only and data_class public');
    if ((input.criteria || []).some(c => c.type === 'operator_review')) throw Error('Risk auto acceptance forbids operator_review criteria');
    if (input.coding_plan) throw Error('Risk auto acceptance does not cover high-risk coding-plan Missions');
    return {
      authorized: true,
      privacy: 'local_only',
      data_class: 'public',
      workers: ['opencode'],
      scopes: [...scopes],
      criteria_hash: fingerprint(input.criteria || []),
      source: explicit === true || input.work_template ? 'mission_mark' : 'operator_preference',
      inheritable: false
    };
  }

  register(mission, policy) {
    if (!policy?.authorized) return;
    this.db.prepare('INSERT OR REPLACE INTO cp_risk_acceptance VALUES(?,?,?,?,?)')
      .run(mission.id, fingerprint(mission.envelope), JSON.stringify(policy), null, Date.now());
    this.store.event('risk.auto_acceptance.authorized', mission.id, { privacy: policy.privacy, data_class: policy.data_class, source: policy.source || 'mission_mark' });
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
      this.store.event('risk.auto_acceptance.denied', id, { reason });
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
        rationale: 'Host risk policy: local-only public OpenCode WORK; independent verification and Review Broker requirements satisfied'
      }, 'operator');
      this.db.prepare('UPDATE cp_risk_acceptance SET review_reason=NULL, updated_at=? WHERE mission_id=?').run(Date.now(), id);
      this.store.event('risk.auto_acceptance.completed', id, result);
      return result;
    });
  }

  reconcile() {
    // Preference alone never binds historical Missions; only envelope-authorized rows.
    for (const { id } of this.db.prepare("SELECT id FROM cp_missions WHERE state='awaiting_acceptance'").all()) {
      if (this.store.getMission(id).envelope.risk_auto_acceptance?.authorized) this.attempt(id);
    }
  }
}

module.exports = { RiskAcceptance, SAFE_SCOPES };
