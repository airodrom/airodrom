'use strict';
// Limits & Blockers Recovery Dispatcher V1 — host-owned, registry-driven.
// Every registered blocker gets automatic diagnosis. Executable recovery runs
// only through allowlisted, idempotent host operations with required evidence.
// Security-critical stays fail-closed. Error text never authorizes recovery.
const { randomUUID } = require('node:crypto');
const Registry = require('./limits-blockers-registry');

const MAX_ATTEMPTS_PER_BLOCKER = 2;
const ALLOWLIST = Object.freeze([
  'diagnose_only',
  'reclaim_idle_ready_workspaces',
  'ensure_cognitive_timing_floor',
  'match_standing_cursor_grant',
  'reconcile_blocked_evaluation',
  'reconcile_writer_death_lease',
  'consume_bridge_restart_cooldown',
  'classify_proxy_denial',
  'reject_cross_project_fallback',
  'normalize_plan_files_guidance',
  'consolidate_owner_gate',
  'security_investigate_fail_closed',
]);

function ensureAttemptsSchema(db) {
  if (!db) return;
  db.exec(`CREATE TABLE IF NOT EXISTS cp_limits_blocker_recovery_attempts(
    id TEXT PRIMARY KEY,
    registry_id TEXT NOT NULL,
    request_id TEXT,
    mission_id TEXT,
    lineage_key TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    operation TEXT NOT NULL,
    outcome TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cp_limits_blocker_recovery_lineage
    ON cp_limits_blocker_recovery_attempts(lineage_key, registry_id, created_at DESC);`);
}

function lineageKey({ request_id, mission_id, registry_id }) {
  return String(mission_id || request_id || 'none') + ':' + String(registry_id || 'unknown');
}

function attemptCount(db, key, registryId) {
  if (!db) return 0;
  try {
    return db.prepare(
      'SELECT COUNT(*) AS n FROM cp_limits_blocker_recovery_attempts WHERE lineage_key=? AND registry_id=?'
    ).get(key, registryId)?.n || 0;
  } catch { return 0; }
}

function recordAttempt(bridge, row) {
  const db = bridge?.controlStore?.db;
  if (!db) return;
  try {
    ensureAttemptsSchema(db);
    db.prepare(
      `INSERT INTO cp_limits_blocker_recovery_attempts
        (id,registry_id,request_id,mission_id,lineage_key,attempt,operation,outcome,receipt_json,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.id, row.registry_id, row.request_id, row.mission_id, row.lineage_key,
      row.attempt, row.operation, row.outcome, JSON.stringify(row.receipt), row.created_at
    );
  } catch { /* accounting must not break recovery */ }
  try {
    bridge.controlStore.event('limits_blockers.recovery', row.mission_id || null, {
      registry_id: row.registry_id, request_id: row.request_id, operation: row.operation,
      outcome: row.outcome, attempt: row.attempt, authority: false,
    });
  } catch { /* observational */ }
}

function baseDiagnosis(entry, report, evidence) {
  return {
    registry_id: entry.id,
    category: entry.category,
    severity: entry.severity,
    security_critical: !!entry.security_critical,
    description: entry.description,
    enforcement: entry.source,
    matched_code: report.blockers?.[0]?.code || null,
    evidence_keys: Object.keys(evidence || {}),
    next_safe_action: entry.next_safe_action,
    authority: false,
  };
}

function ownerGate(entry, detail) {
  return {
    required: true,
    registry_id: entry.id,
    action: entry.next_safe_action,
    detail: detail || entry.description,
    consolidated: true,
    authority: false,
  };
}

/** Collect authoritative evidence without secrets or private paths. */
function collectEvidence(bridge, ctx) {
  const evidence = { collected_at: Date.now(), authority: false };
  try {
    const snap = Registry.diagnostics(bridge, { limit: 10 });
    evidence.missions = snap.missions;
    evidence.cursor = {
      runtime: snap.cursor?.runtime,
      standing_grant: snap.cursor?.standing_grant,
      standing_active_count: snap.cursor?.standing_active_count,
      spend_admission: snap.cursor?.spend_admission,
    };
    evidence.developer_autonomy = (snap.developer_autonomy?.policies || []).map(p => ({
      policy_id: p.policy_id, alias: p.alias,
      worktrees_occupied: p.worktrees?.occupied, worktrees_limit: p.worktrees?.limit,
      disk: p.disk?.state, grants_active: p.grants?.active,
    }));
    evidence.observed_blockers = (snap.observed_blockers || []).slice(0, 5).map(o => ({
      kind: o.kind, registry_id: o.blockers?.[0]?.registry_id, next_safe_action: o.next_safe_action,
    }));
  } catch (error) {
    evidence.diagnostics_error = String(error.message || error).slice(0, 160);
  }
  if (ctx.request_id) {
    try {
      const row = bridge.controlStore.db.prepare(
        'SELECT state FROM cp_zero_setup_requests WHERE request_id=?'
      ).get(ctx.request_id);
      evidence.request_state = row?.state || null;
    } catch { /* optional */ }
  }
  if (ctx.mission_id) {
    try {
      const m = bridge.controlStore.requireMission(ctx.mission_id);
      evidence.mission = { id: m.id, state: m.state, preferred_agent: m.envelope?.preferred_agent || null };
    } catch { /* optional */ }
  }
  return evidence;
}

function recoverReclaimWorktrees(bridge, owner) {
  const policies = bridge.developerAutonomy?.list?.(owner) || [];
  let before = 0, after = 0;
  for (const policy of policies.filter(p => p.state === 'active')) {
    before += bridge.developerAutonomy.occupiedWorktrees(policy.policy_id);
    bridge.developerAutonomy.reclaimIdleReadyWorkspaces(policy, owner);
    after += bridge.developerAutonomy.occupiedWorktrees(policy.policy_id);
  }
  return {
    operation: 'reclaim_idle_ready_workspaces',
    performed: after < before,
    before_occupied: before,
    after_occupied: after,
    note: 'Only clean disposable idle ready clones; dirty/unique/protected preserved.',
  };
}

function recoverEnsureCognitiveTiming(bridge, owner, evidence) {
  const results = [];
  for (const p of evidence.developer_autonomy || []) {
    try {
      const before = bridge.developerAutonomy.inspect(p.policy_id);
      const after = bridge.developerAutonomy.ensureCognitiveDiscovery(p.policy_id, owner);
      results.push({
        policy_id: p.policy_id,
        before_execution_ms: before?.cognitive?.execution_ms ?? null,
        after_execution_ms: after?.cognitive?.execution_ms ?? null,
        refreshed: (after?.cognitive?.execution_ms || 0) >= 120000,
      });
    } catch (error) {
      results.push({ policy_id: p.policy_id, error: String(error.message || error).slice(0, 160) });
    }
  }
  return {
    operation: 'ensure_cognitive_timing_floor',
    performed: results.some(r => r.refreshed),
    policies: results,
  };
}

function recoverMatchStanding(bridge, ctx) {
  const hep = bridge.hostExecutionPolicy;
  if (!hep?.diagnoseStandingCursorDevelopment) {
    return { operation: 'match_standing_cursor_grant', performed: false, reason: 'host_execution_policy_unavailable' };
  }
  // Diagnosis only unless an active matching grant already covers — never invents grants.
  const status = hep.status('operator');
  const active = (status.standing_cursor_development || []).filter(g => g.state === 'active');
  return {
    operation: 'match_standing_cursor_grant',
    performed: false,
    active_grants: active.length,
    grants: active.map(g => ({
      id: g.id, max_runtime_ms: g.max_runtime_ms, missions_remaining: g.missions_remaining,
      policy_id: g.policy_id, state: g.state,
    })),
    note: 'Standing grants are never created automatically; raise-only runtime uses owner API.',
  };
}

function recoverEvaluation(bridge, ctx) {
  try {
    const gw = require('./specialist-gateway');
    if (ctx.mission_id && typeof gw.recover === 'function') {
      const result = gw.recover(bridge, ctx.mission_id);
      return { operation: 'reconcile_blocked_evaluation', performed: !!result, result: result && typeof result === 'object' ? { keys: Object.keys(result) } : !!result };
    }
  } catch (error) {
    return { operation: 'reconcile_blocked_evaluation', performed: false, reason: String(error.message || error).slice(0, 160) };
  }
  return { operation: 'reconcile_blocked_evaluation', performed: false, reason: 'no_mission_or_recover_api' };
}

function recoverWriterDeath(bridge, ctx) {
  try {
    const mod = require('./writer-death-recovery');
    if (typeof mod.reconcile === 'function' && ctx.mission_id) {
      const result = mod.reconcile(bridge, ctx.mission_id);
      return { operation: 'reconcile_writer_death_lease', performed: !!result?.reconciled || !!result, result: result && typeof result === 'object' ? { keys: Object.keys(result) } : !!result };
    }
  } catch (error) {
    return { operation: 'reconcile_writer_death_lease', performed: false, reason: String(error.message || error).slice(0, 160) };
  }
  return { operation: 'reconcile_writer_death_lease', performed: false, reason: 'reconcile_unavailable' };
}

/**
 * Map every registry id to an automatic diagnostic + optional allowlisted recovery.
 * Recovery never expands NEVER_AUTO, invents grants, or deletes protected work.
 */
function planFor(entry) {
  const id = entry.id;
  if (id === 'worktree_budget_exhausted') {
    return { operation: 'reclaim_idle_ready_workspaces', executable: true, verify: 'occupied_decreased_or_slots_free' };
  }
  if (id === 'da_disk_budget_legacy') {
    return { operation: 'diagnose_only', executable: false, note: 'fixed_defect_use_filesystem_capacity' };
  }
  if (id === 'cognitive_plan_files_mismatch') {
    return { operation: 'normalize_plan_files_guidance', executable: false, note: 'planner_coerce_on_retry' };
  }
  if (id === 'cursor_subscription_deadline' || id === 'cursor_proxy_aborted' || id === 'standing_cursor_grant_runtime_limit') {
    return { operation: 'ensure_cognitive_timing_floor', executable: true, owner_if_still_short: true, verify: 'cognitive_execution_ms_floor' };
  }
  if (id === 'blocked_spend_authorization' || id === 'scoped_external_disclosure_required'
    || id === 'standing_cursor_grant_missing' || id === 'standing_cursor_grant_expired'
    || id === 'standing_cursor_grant_revoked' || id === 'standing_cursor_grant_exhausted'
    || id === 'standing_cursor_grant_invocation_limit' || id === 'standing_cursor_grant_mismatch') {
    return { operation: 'match_standing_cursor_grant', executable: true, owner_gate_if_unmatched: true };
  }
  if (id === 'evaluation_unavailable' || id === 'gateway_evaluation_deadline') {
    return { operation: 'reconcile_blocked_evaluation', executable: true, verify: 'evaluation_reconciled_or_terminal' };
  }
  if (id === 'quarantined_lease_not_reconciled' || id === 'writer_still_alive' || id === 'termination_unverified') {
    return { operation: 'reconcile_writer_death_lease', executable: true, security_fail_closed: true };
  }
  if (id === 'bridge_restart_cooldown') {
    return { operation: 'consume_bridge_restart_cooldown', executable: false, note: 'wait_cooldown' };
  }
  if (id === 'cursor_proxy_dns_unavailable') {
    return { operation: 'classify_proxy_denial', executable: false, note: 'retry_when_resolver_healthy' };
  }
  if (id === 'cursor_proxy_dns_boundary' || id === 'cursor_proxy_unauthorized_host') {
    return { operation: 'security_investigate_fail_closed', executable: false };
  }
  if (id === 'cross_project_fixture_fallback_rejected') {
    return { operation: 'reject_cross_project_fallback', executable: false, note: 'select_enrolled_repository' };
  }
  if (entry.category === 'security_critical') {
    return { operation: 'security_investigate_fail_closed', executable: false };
  }
  if (entry.category === 'operational_auto') {
    return { operation: 'diagnose_only', executable: false, note: entry.next_safe_action };
  }
  // operational_owner default: diagnose + consolidate one owner gate
  return { operation: 'consolidate_owner_gate', executable: false };
}

function executePlan(bridge, entry, plan, ctx, evidence, owner) {
  if (!ALLOWLIST.includes(plan.operation)) {
    return { performed: false, reason: 'operation_not_allowlisted', operation: plan.operation };
  }
  switch (plan.operation) {
    case 'reclaim_idle_ready_workspaces':
      return recoverReclaimWorktrees(bridge, owner);
    case 'ensure_cognitive_timing_floor':
      return recoverEnsureCognitiveTiming(bridge, owner, evidence);
    case 'match_standing_cursor_grant':
      return recoverMatchStanding(bridge, ctx);
    case 'reconcile_blocked_evaluation':
      return recoverEvaluation(bridge, ctx);
    case 'reconcile_writer_death_lease':
      return recoverWriterDeath(bridge, ctx);
    case 'normalize_plan_files_guidance':
      return { operation: plan.operation, performed: false, guidance: 'Retry planning; host normalizes files to task-path union.', note: plan.note };
    case 'reject_cross_project_fallback':
      return { operation: plan.operation, performed: false, guidance: 'Bind the enrolled authoritative repository; never borrow fixture grants.', note: plan.note };
    case 'classify_proxy_denial':
      return { operation: plan.operation, performed: false, guidance: evidence.cursor || null, note: plan.note };
    case 'consume_bridge_restart_cooldown':
      return { operation: plan.operation, performed: false, guidance: 'Wait for bridge restart cooldown then retry.', note: plan.note };
    case 'consolidate_owner_gate':
      return { operation: plan.operation, performed: false, owner_gate: ownerGate(entry) };
    case 'security_investigate_fail_closed':
      return {
        operation: plan.operation, performed: false, fail_closed: true,
        investigation: {
          registry_id: entry.id, category: entry.category,
          enforcement: entry.source, evidence_summary: evidence.missions || null,
        },
      };
    case 'diagnose_only':
    default:
      return { operation: 'diagnose_only', performed: false, note: plan.note || entry.next_safe_action };
  }
}

function verifyRecovery(bridge, entry, plan, recovery, evidenceAfter) {
  if (!plan.verify) {
    return { verified: recovery.performed === true || recovery.fail_closed === true || recovery.performed === false, mode: 'diagnostic_complete', authority: false };
  }
  if (plan.verify === 'occupied_decreased_or_slots_free') {
    const free = (evidenceAfter.developer_autonomy || []).some(p => Number.isInteger(p.worktrees_occupied) && Number.isInteger(p.worktrees_limit) && p.worktrees_occupied < p.worktrees_limit);
    return { verified: !!recovery.performed || free, mode: plan.verify, authority: false };
  }
  if (plan.verify === 'cognitive_execution_ms_floor') {
    const ok = (recovery.policies || []).some(p => p.after_execution_ms >= 120000);
    return { verified: ok || !!recovery.performed, mode: plan.verify, authority: false };
  }
  return { verified: !!recovery.performed, mode: plan.verify || 'performed', authority: false };
}

/**
 * Central dispatcher: diagnose every registered blocker; recover only when allowlisted.
 */
function dispatch(bridge, {
  codes, request_id = null, mission_id = null, owner = 'operator', live = true,
} = {}) {
  const report = Registry.reportForBlock(bridge, { codes, request_id, mission_id, live });
  const primaryId = report.primary_registry_id || 'unknown_blocker';
  const entry = primaryId === 'unknown_blocker'
    ? Registry.unknownEntry(codes?.[0] || 'unknown')
    : (Registry.loadRegistry().byId.get(primaryId) || Registry.unknownEntry(codes?.[0] || primaryId));

  const ctx = { request_id, mission_id, codes };
  const evidence = collectEvidence(bridge, ctx);
  const diagnosis = baseDiagnosis(entry, report, evidence);
  const plan = planFor(entry);
  const key = lineageKey({ request_id, mission_id, registry_id: entry.id });
  const db = bridge?.controlStore?.db;
  ensureAttemptsSchema(db);
  const prior = attemptCount(db, key, entry.id);

  let recovery = { operation: plan.operation, performed: false, skipped: false };
  let verification = { verified: false, mode: 'not_attempted', authority: false };
  let owner_gate = null;
  let resumed = false;

  if (prior >= MAX_ATTEMPTS_PER_BLOCKER) {
    recovery = {
      operation: plan.operation, performed: false, skipped: true,
      reason: 'recovery_attempt_budget_exhausted',
      attempts: prior, max_attempts: MAX_ATTEMPTS_PER_BLOCKER,
    };
    owner_gate = ownerGate(entry, 'Recovery attempt budget exhausted for this lineage; owner inspects diagnostics.');
  } else if (entry.registered === false) {
    recovery = { operation: 'diagnose_only', performed: false, reason: 'unknown_blocker_no_auto_execution' };
    owner_gate = ownerGate(entry, 'Unregistered blocker; register or decide manually.');
  } else {
    recovery = executePlan(bridge, entry, plan, ctx, evidence, owner);
    const evidenceAfter = live ? collectEvidence(bridge, ctx) : evidence;
    verification = verifyRecovery(bridge, entry, plan, recovery, evidenceAfter);

    if (plan.owner_gate_if_unmatched && !recovery.active_grants) {
      owner_gate = ownerGate(entry, 'No active standing Cursor grant covers this Mission.');
    }
    if (plan.owner_if_still_short) {
      const stillShort = !(recovery.policies || []).some(p => p.after_execution_ms >= 120000);
      // Cognitive floor may be raised automatically; standing grant runtime still owner raise-only.
      owner_gate = ownerGate(entry,
        'Ensure standing Cursor max_runtime_ms is raised to 120000 via raise-standing-cursor-runtime (raise-only). Cognitive execution_ms floor refresh '
        + (stillShort ? 'incomplete or unavailable.' : 'applied.'));
    }
    if (plan.operation === 'consolidate_owner_gate' || (entry.category === 'operational_owner' && !recovery.performed && !owner_gate)) {
      owner_gate = ownerGate(entry);
    }
    if (entry.security_critical || plan.operation === 'security_investigate_fail_closed') {
      owner_gate = null; // fail closed; no owner bypass instruction that implies privilege expansion
      recovery.fail_closed = true;
    }
  }

  const attempt = prior + 1;
  const receipt = {
    id: randomUUID(),
    registry_id: entry.id,
    category: entry.category,
    diagnosis,
    plan: { operation: plan.operation, executable: !!plan.executable, allowlisted: ALLOWLIST.includes(plan.operation) },
    evidence: {
      missions: evidence.missions,
      cursor: evidence.cursor,
      developer_autonomy: evidence.developer_autonomy,
      request_state: evidence.request_state || null,
      mission: evidence.mission || null,
    },
    recovery,
    verification,
    owner_gate,
    resumed,
    authorization_used: owner === 'operator' ? 'host_operator_context' : 'none',
    attempts: { prior, attempt, max: MAX_ATTEMPTS_PER_BLOCKER },
    authority: false,
    generated_at: Date.now(),
  };

  recordAttempt(bridge, {
    id: receipt.id,
    registry_id: entry.id,
    request_id,
    mission_id,
    lineage_key: key,
    attempt,
    operation: plan.operation,
    outcome: recovery.performed ? 'recovered' : (recovery.fail_closed ? 'fail_closed' : (owner_gate ? 'owner_gate' : 'diagnosed')),
    receipt,
    created_at: Date.now(),
  });

  return {
    ...report,
    recovery_receipt: receipt,
    diagnosis,
    recovery,
    verification,
    owner_gate,
    resumed,
    authority: false,
  };
}

/** Coverage matrix for acceptance: every registry entry has a plan. */
function coverage() {
  const registry = Registry.loadRegistry();
  const items = registry.entries.map(entry => {
    const plan = planFor(entry);
    return {
      id: entry.id,
      category: entry.category,
      auto_diagnosis: true,
      executable_recovery: !!plan.executable && ALLOWLIST.includes(plan.operation),
      operation: plan.operation,
      owner_gate_possible: entry.category === 'operational_owner' || !!plan.owner_gate_if_unmatched || !!plan.owner_if_still_short,
      security_fail_closed: entry.category === 'security_critical' || !!plan.security_fail_closed,
      authority: false,
    };
  });
  return {
    entry_count: items.length,
    auto_diagnosis: items.filter(i => i.auto_diagnosis).length,
    executable_safe_recovery: items.filter(i => i.executable_recovery).length,
    owner_only_gates: items.filter(i => i.owner_gate_possible && !i.executable_recovery).length,
    security_fail_closed: items.filter(i => i.security_fail_closed).length,
    items,
    allowlist: ALLOWLIST,
    authority: false,
  };
}

module.exports = {
  dispatch,
  coverage,
  planFor,
  collectEvidence,
  ALLOWLIST,
  MAX_ATTEMPTS_PER_BLOCKER,
};
