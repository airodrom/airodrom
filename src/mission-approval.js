'use strict';
// ADR 0051. One legitimate owner approval per bounded Mission scope.
//
// The approval binds an authenticated operator decision to an immutable
// scope_fingerprint (permissions, scope, verification, budget, restrictions), a time
// window, a repair budget and an explicit external-disclosure flag. Corrective
// Missions reuse the approval only while their contract carries the same fingerprint;
// a different fingerprint, an expired window or an exhausted repair budget fails
// closed. Request ids are idempotent and replay with a different scope is denied.
// Model-generated text is never an approval. MCP clients can only observe.
const { randomUUID, createHash } = require('node:crypto');
const { object, identifier, text } = require('./control-plane-store');
const { transaction } = require('./control-transaction');

const CHANNELS = new Set(['terminal', 'control_center', 'fixture']);
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

// Billing visibility is not permission. This is a separate, explicit operator
// decision to permit a finite subscription-backed run with unobservable cost.
// It promises invocation/time limits, NEVER an unenforceable monetary cap.
function subscriptionExecution(input, contract, channel) {
  if (input === undefined || input === null) return null;
  object(input, ['provider', 'acknowledge_unknown_cost', 'max_invocations', 'max_runtime_ms']);
  if (channel === 'fixture' || input.provider !== 'cursor' || input.acknowledge_unknown_cost !== true)
    throw Error('subscription_explicit_authorization_required');
  if (contract.execution.preferred_worker !== 'cursor' || contract.execution.mode !== 'sandboxed_headless' ||
      !contract.permissions.external_disclosure.authorized ||
      !contract.permissions.external_disclosure.providers.includes('cursor'))
    throw Error('subscription_scope_mismatch');
  if (contract.budget.max_actual_spend_usd !== undefined && contract.budget.max_actual_spend_usd !== null)
    throw Error('subscription_monetary_cap_unenforceable');
  if (!Number.isSafeInteger(input.max_invocations) || input.max_invocations < 1 ||
      input.max_invocations > Math.min(12, contract.budget.max_worker_invocations))
    throw Error('subscription_invocation_bound');
  if (!Number.isSafeInteger(input.max_runtime_ms) || input.max_runtime_ms < 1000 ||
      input.max_runtime_ms > Math.min(600000, contract.budget.max_wall_clock_ms))
    throw Error('subscription_runtime_bound');
  return { provider: 'cursor', acknowledge_unknown_cost: true,
    max_invocations: input.max_invocations, max_runtime_ms: input.max_runtime_ms };
}

class MissionApprovals {
  constructor(bridge) {
    this.bridge = bridge;
    this.store = bridge.controlStore;
    this.db = this.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_mission_approvals(
      approval_id TEXT PRIMARY KEY,
      principal TEXT NOT NULL,
      channel TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      nonce TEXT NOT NULL UNIQUE,
      scope_fingerprint TEXT NOT NULL,
      permissions_digest TEXT NOT NULL,
      workspace TEXT NOT NULL,
      project_id TEXT, goal_id TEXT, plan_id TEXT,
      authorized_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      repair_budget INTEGER NOT NULL,
      external_disclosure INTEGER NOT NULL DEFAULT 0,
      disclosure_providers TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL CHECK(state IN ('active','revoked','expired')),
      revoked_at INTEGER, revoked_reason TEXT,
      bound_missions TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL
    )`);
    // Reservations consume the allowance even when launch fails or the host dies.
    // Restart/replay must never silently refund and execute a paid request twice.
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_subscription_invocations(
      approval_id TEXT NOT NULL, request_id TEXT NOT NULL, mission_id TEXT NOT NULL,
      scope_fingerprint TEXT NOT NULL, started_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','settled')),
      outcome TEXT, settled_at INTEGER,
      PRIMARY KEY(approval_id,request_id)
    )`);
  }

  now() { return this.store.now(); }

  row(id) {
    identifier(id);
    const r = this.db.prepare('SELECT * FROM cp_mission_approvals WHERE approval_id=?').get(id);
    if (!r) return null;
    return { ...r, external_disclosure: r.external_disclosure === 1, disclosure_providers: JSON.parse(r.disclosure_providers), bound_missions: JSON.parse(r.bound_missions), summary: JSON.parse(r.summary) };
  }

  view(id) {
    const r = this.row(id);
    if (!r) return null;
    const expired = this.now() >= r.expires_at;
    return {
      approval_id: r.approval_id, channel: r.channel, principal: r.principal, scope_fingerprint: r.scope_fingerprint,
      authorized_at: r.authorized_at, expires_at: r.expires_at, repair_budget: r.repair_budget,
      external_disclosure: r.external_disclosure, disclosure_providers: r.disclosure_providers,
      state: r.state === 'active' && expired ? 'expired' : r.state, bound_missions: r.bound_missions, summary: r.summary,
      plan_id: r.plan_id, goal_id: r.goal_id, project_id: r.project_id, authority: false,
    };
  }

  static permissionsDigest(contract) {
    return createHash('sha256').update(JSON.stringify(contract.permissions)).digest('hex');
  }

  /**
   * Issue one approval for a normalized contract. Operator only; explicit confirmation;
   * idempotent on request_id (identical scope → same approval, different scope → denied).
   */
  issue(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
    object(input, ['request_id', 'channel', 'contract', 'plan_id', 'goal_id', 'confirmed', 'ttl_ms', 'summary', 'subscription_execution']);
    identifier(input.request_id);
    if (input.confirmed !== true) throw Error('Explicit owner approval required');
    if (!CHANNELS.has(input.channel)) throw Error('Unknown approval channel');
    const contract = require('./mission-contract').assertIntact(input.contract);
    const subscription = subscriptionExecution(input.subscription_execution, contract, input.channel);
    const ttl = input.ttl_ms ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 60000 || ttl > MAX_TTL_MS) throw Error('Approval window must be between one minute and 24 hours');
    if (input.plan_id !== undefined) identifier(input.plan_id);
    if (input.goal_id !== undefined) identifier(input.goal_id);
    const summary = {
      goal: String(input.summary?.goal || contract.objective.normalized_objective || '').slice(0, 300),
      workspace_label: require('node:path').basename(contract.project.workspace),
      files: contract.permissions.allowed_write_paths,
      worker: contract.execution.preferred_worker,
      network: contract.permissions.network.mode,
      external_disclosure: contract.permissions.external_disclosure.authorized ? contract.permissions.external_disclosure.providers : null,
      repair_budget: contract.budget.max_repair_attempts,
      production: 'No access',
      git: 'No commits, pushes, merges or deployments',
      ...(subscription ? { subscription_execution: subscription } : {}),
    };
    const existing = this.db.prepare('SELECT * FROM cp_mission_approvals WHERE request_id=?').get(input.request_id);
    if (existing) {
      if (existing.scope_fingerprint !== contract.scope_fingerprint || existing.principal !== owner ||
          JSON.stringify(JSON.parse(existing.summary).subscription_execution || null) !== JSON.stringify(subscription))
        throw Error('approval_replay_denied');
      return { ...this.view(existing.approval_id), duplicate: true };
    }
    const now = this.now();
    const expiresAt = Math.min(now + ttl, contract.identity.expires_at);
    if (expiresAt <= now) throw Error('contract_expired');
    const id = randomUUID();
    return transaction(this.db, () => {
      this.db.prepare(`INSERT INTO cp_mission_approvals(approval_id,principal,channel,request_id,nonce,scope_fingerprint,permissions_digest,workspace,project_id,goal_id,plan_id,authorized_at,expires_at,repair_budget,external_disclosure,disclosure_providers,state,bound_missions,summary)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active','[]',?)`).run(
        id, owner, input.channel, input.request_id, randomUUID(), contract.scope_fingerprint, MissionApprovals.permissionsDigest(contract), contract.project.workspace,
        contract.project.project_id, input.goal_id || contract.identity.goal_id || null, input.plan_id || null, now, expiresAt, contract.budget.max_repair_attempts,
        contract.permissions.external_disclosure.authorized ? 1 : 0, JSON.stringify(contract.permissions.external_disclosure.providers), JSON.stringify(summary));
      this.store.event('mission.approval.issued', null, {
        approval_id: id, channel: input.channel, scope_fingerprint: contract.scope_fingerprint, expires_at: expiresAt,
        repair_budget: contract.budget.max_repair_attempts, external_disclosure: contract.permissions.external_disclosure.authorized, authority: false,
      });
      return this.view(id);
    });
  }

  /** Attach an approval to a Mission whose contract carries the approved fingerprint. Host-only. */
  bind(approvalId, missionId, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
    const mission = this.store.requireMission(identifier(missionId));
    const contract = mission.envelope.contract;
    if (!contract) throw Error('approval_requires_contract');
    this.assertBindable(approvalId, { contract, workspace: mission.envelope.workspace, repair_of: mission.envelope.repair_of || null });
    return transaction(this.db, () => {
      const r = this.row(approvalId);
      if (!r.bound_missions.includes(missionId)) {
        this.db.prepare('UPDATE cp_mission_approvals SET bound_missions=? WHERE approval_id=?').run(JSON.stringify([...r.bound_missions, missionId]), approvalId);
      }
      const envelope = { ...mission.envelope, approval_id: approvalId, contract: { ...contract, identity: { ...contract.identity, authorized_at: contract.identity.authorized_at || r.authorized_at }, audit: { ...contract.audit, approval_id: approvalId, approval_identity: r.principal } } };
      this.db.prepare('UPDATE cp_missions SET envelope=?,updated_at=? WHERE id=?').run(JSON.stringify(envelope), this.now(), missionId);
      if (this.bridge.authorityRuntime?.active) { try { this.db.prepare('UPDATE authority_missions SET envelope=? WHERE id=?').run(JSON.stringify(envelope), missionId); } catch { /* authority plane may not mirror envelopes */ } }
      this.store.event('mission.approval.bound', missionId, { approval_id: approvalId, repair_of: mission.envelope.repair_of || null, authority: false });
      return this.view(approvalId);
    });
  }

  assertBindable(approvalId, { contract, workspace, repair_of = null } = {}) {
    const r = this.row(approvalId);
    if (!r) throw Error('approval_unavailable');
    if (r.state === 'revoked') throw Error('approval_revoked');
    if (this.now() >= r.expires_at) throw Error('approval_expired');
    if (!contract) throw Error('approval_requires_contract');
    if (r.scope_fingerprint !== contract.scope_fingerprint) throw Error('approval_scope_mismatch');
    if (r.permissions_digest !== MissionApprovals.permissionsDigest(contract)) throw Error('approval_scope_mismatch');
    if (workspace && r.workspace !== workspace) throw Error('approval_scope_mismatch');
    if (contract.permissions.external_disclosure.authorized && !r.external_disclosure) throw Error('external_disclosure_unauthorized');
    if (repair_of && r.bound_missions.length && !r.bound_missions.includes(repair_of)) {
      // A corrective Mission must descend from a Mission this approval covers.
      const parent = this.store.getMission(repair_of);
      if (!parent || parent.envelope.approval_id !== approvalId) throw Error('approval_scope_mismatch');
    }
    return r;
  }

  /** Local OpenCode evaluation of an already settled invocation. Expired is allowed. Revoked is not. */
  assertLocalEvaluation(mission) {
    const contract = mission?.envelope?.contract;
    const approvalId = mission?.envelope?.approval_id;
    if (!approvalId || !contract) throw Error('approval_unavailable');
    const r = this.row(approvalId);
    if (!r) throw Error('approval_unavailable');
    if (r.state === 'revoked') throw Error('approval_revoked');
    if (r.scope_fingerprint !== contract.scope_fingerprint) throw Error('approval_scope_mismatch');
    if (r.permissions_digest !== MissionApprovals.permissionsDigest(contract)) throw Error('approval_scope_mismatch');
    if (mission.envelope.workspace && r.workspace !== mission.envelope.workspace) throw Error('approval_scope_mismatch');
    if (contract.permissions?.external_disclosure?.authorized && !r.external_disclosure) throw Error('external_disclosure_unauthorized');
    return r;
  }

  /** Dispatch-time check: active, unexpired, same fingerprint. Running work is not interrupted here. */
  assertDispatch(mission) {
    const approvalId = mission.envelope.approval_id;
    if (!approvalId) return null;
    const r = this.assertBindable(approvalId, { contract: mission.envelope.contract, workspace: mission.envelope.workspace, repair_of: mission.envelope.repair_of || null });
    if (!r.bound_missions.includes(mission.id)) {
      this.db.prepare('UPDATE cp_mission_approvals SET bound_missions=? WHERE approval_id=?').run(JSON.stringify([...r.bound_missions, mission.id]), approvalId);
    }
    return r;
  }

  /** Inspect a grant against current host records, never a worker-supplied object. */
  subscriptionFor(missionId) {
    const mission = this.store.requireMission(identifier(missionId));
    const contract = require('./mission-contract').assertIntact(mission.envelope.contract);
    if (mission.envelope.preferred_agent !== 'cursor' || !mission.envelope.approval_id)
      throw Error('BLOCKED_SPEND_AUTHORIZATION');
    const approval = this.assertDispatch(mission);
    if (!approval || approval.principal !== 'operator' || approval.state !== 'active')
      throw Error('BLOCKED_SPEND_AUTHORIZATION');
    const grant = subscriptionExecution(approval.summary.subscription_execution, contract, approval.channel);
    if (!grant) throw Error('BLOCKED_SPEND_AUTHORIZATION');
    if (mission.envelope.maxCostUsdBoundary !== undefined) throw Error('subscription_monetary_cap_unenforceable');
    if (mission.state !== 'running')
      throw Error('subscription_mission_not_running');
    if (!Number.isSafeInteger(contract.identity.created_at) || !Number.isSafeInteger(contract.identity.expires_at) ||
        this.now() >= contract.identity.expires_at)
      throw Error('subscription_expired');
    return { mission, contract, approval, grant };
  }

  /** Atomic, finite admission; no retry on a used request, even after restart. */
  reserveSubscription(missionId, requestId, timeoutMs) {
    identifier(requestId);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
      throw Error('subscription_runtime_bound');
    return transaction(this.db, () => {
      const { mission, contract, approval, grant } = this.subscriptionFor(missionId);
      if (this.db.prepare('SELECT 1 FROM cp_subscription_invocations WHERE approval_id=? AND request_id=?').get(approval.approval_id, requestId))
        throw Error('subscription_invocation_replay_denied');
      const used = this.db.prepare('SELECT count(*) n FROM cp_subscription_invocations WHERE approval_id=?').get(approval.approval_id).n;
      if (used >= grant.max_invocations) throw Error('subscription_invocations_exhausted');
      const now = this.now();
      const deadline = Math.min(now + timeoutMs, now + grant.max_runtime_ms, approval.expires_at,
        contract.identity.expires_at, contract.identity.created_at + contract.budget.max_wall_clock_ms);
      if (!Number.isSafeInteger(deadline) || deadline - now < 1000) throw Error('subscription_expired');
      this.db.prepare(`INSERT INTO cp_subscription_invocations
        (approval_id,request_id,mission_id,scope_fingerprint,started_at,deadline_at,state)
        VALUES(?,?,?,?,?,?,'reserved')`).run(approval.approval_id, requestId, mission.id, contract.scope_fingerprint, now, deadline);
      this.store.event('subscription.execution.reserved', mission.id, {
        approval_id: approval.approval_id, request_id: requestId, deadline_at: deadline,
        billing_observability: 'UNKNOWN_SUBSCRIPTION', authority: false,
      });
      return Object.freeze({ approval_id: approval.approval_id, request_id: requestId,
        mission_id: mission.id, deadline_at: deadline });
    });
  }

  /** Re-read before launch, periodically while running, and before result publication. */
  assertSubscription(reservation) {
    const row = this.db.prepare('SELECT * FROM cp_subscription_invocations WHERE approval_id=? AND request_id=?')
      .get(reservation?.approval_id || '', reservation?.request_id || '');
    if (!row || row.state !== 'reserved' || row.mission_id !== reservation.mission_id ||
        row.deadline_at !== reservation.deadline_at) throw Error('BLOCKED_SPEND_AUTHORIZATION');
    const { mission, contract, approval, grant } = this.subscriptionFor(row.mission_id);
    if (approval.approval_id !== row.approval_id || contract.scope_fingerprint !== row.scope_fingerprint)
      throw Error('subscription_scope_mismatch');
    if (this.now() >= row.deadline_at || row.deadline_at > row.started_at + grant.max_runtime_ms)
      throw Error('subscription_expired');
    return { row, mission };
  }

  settleSubscription(reservation, outcome) {
    if (!['completed', 'failed', 'cancelled', 'unknown'].includes(outcome)) throw Error('subscription_outcome_invalid');
    return transaction(this.db, () => {
      const changed = this.db.prepare(`UPDATE cp_subscription_invocations SET state='settled',outcome=?,settled_at=?
        WHERE approval_id=? AND request_id=? AND mission_id=? AND state='reserved'`)
        .run(outcome, this.now(), reservation.approval_id, reservation.request_id, reservation.mission_id).changes;
      if (changed) this.store.event('subscription.execution.settled', reservation.mission_id, {
        approval_id: reservation.approval_id, request_id: reservation.request_id,
        outcome, billing_observability: 'UNKNOWN_SUBSCRIPTION', authority: false,
      });
      return { settled: changed === 1, cost_observed: 'UNKNOWN_SUBSCRIPTION', authority: false };
    });
  }

  /** Whether an authorized repair may be created for a failed Mission under its approval. */
  allowRepair(failed, { repairs = 0 } = {}) {
    const approvalId = failed.envelope.approval_id;
    const contract = failed.envelope.contract;
    if (!approvalId && failed.envelope.developer_autonomy) {
      try {
        if (!contract) throw Error('Developer Autonomy contract required');
        require('./mission-contract').assertIntact(contract);
        this.bridge.developerAutonomy.assertRepair(failed);
        if (repairs >= contract.budget.max_repair_attempts) return { ok: false, reason: 'contract_budget' };
        return { ok: true, approval: { approval_id: null } };
      } catch { return { ok: false, reason: 'developer_autonomy_repair_denied' }; }
    }
    if (!approvalId) return contract ? { ok: false, reason: 'approval_unavailable' } : { ok: true, approval: { approval_id: null } };
    const r = this.row(approvalId);
    if (!r) return { ok: false, reason: 'approval_unavailable' };
    if (r.state === 'revoked') return { ok: false, reason: 'approval_revoked' };
    if (this.now() >= r.expires_at) return { ok: false, reason: 'approval_expired' };
    if (!contract || r.scope_fingerprint !== contract.scope_fingerprint) return { ok: false, reason: 'approval_scope_mismatch' };
    if (repairs >= Math.min(r.repair_budget, contract.budget.max_repair_attempts)) return { ok: false, reason: 'contract_budget' };
    return { ok: true, approval: r };
  }

  revoke(approvalId, input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
    object(input, ['request_id', 'reason', 'confirmed']);
    identifier(input.request_id);
    if (input.confirmed !== true) throw Error('Explicit revocation required');
    text(input.reason, 'revocation reason', 500);
    return this.store.request(owner, input.request_id, { op: 'approval_revoke', approvalId }, () => {
      const r = this.row(approvalId);
      if (!r) throw Error('approval_unavailable');
      this.db.prepare("UPDATE cp_mission_approvals SET state='revoked',revoked_at=?,revoked_reason=? WHERE approval_id=?").run(this.now(), input.reason, approvalId);
      this.store.event('mission.approval.revoked', null, { approval_id: approvalId, authority: false });
      return this.view(approvalId);
    });
  }

  list(limit = 20) {
    return this.db.prepare('SELECT approval_id FROM cp_mission_approvals ORDER BY authorized_at DESC LIMIT ?').all(limit).map(r => this.view(r.approval_id));
  }

  forMission(missionId) {
    const m = this.store.getMission(missionId);
    return m?.envelope?.approval_id ? this.view(m.envelope.approval_id) : null;
  }
}

module.exports = { MissionApprovals, CHANNELS, MAX_TTL_MS, DEFAULT_TTL_MS, subscriptionExecution };
