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
  'normalize_cognitive_worker',
  'diagnose_filesystem_capacity',
  'await_mission_capacity',
  'resolve_enrolled_repository',
  'prepare_enrollment_action',
  'reuse_local_evaluation_authority',
  'diagnose_repair_budget',
  'consolidate_owner_gate',
  'security_investigate_fail_closed',
]);

/** User-listed operational blockers that must always have an explicit recovery plan. */
const OPERATIONAL_OWNER_CANONICAL = Object.freeze([
  'da_filesystem_capacity_exhausted', 'concurrent_mission_budget_exhausted', 'da_repair_budget',
  'source_repository_not_enrolled', 'arecibo_repository_not_enrolled', 'enrolled_repository_ambiguous',
  'enrolled_workspace_required', 'blocked_spend_authorization', 'scoped_external_disclosure_required',
  'standing_cursor_grant_missing', 'standing_cursor_grant_expired', 'standing_cursor_grant_revoked',
  'standing_cursor_grant_exhausted', 'standing_cursor_grant_invocation_limit', 'standing_cursor_grant_runtime_limit',
  'cursor_execution_disabled', 'cognitive_explicit_worker_syntax_required', 'cognitive_ambiguous_worker',
  'cognitive_delegation_expired_or_revoked', 'cognitive_assignment_limit', 'cognitive_envelope_expired',
  'worker_execution_unqualified', 'evaluation_unavailable', 'gateway_assignment_budget_exhausted',
  'runtime_removed', 'repair_blocked', 'owner_action_required',
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

function missionStandingProbe(bridge, ctx) {
  const mission = ctx.mission_id ? (() => {
    try { return bridge.controlStore.requireMission(ctx.mission_id); } catch { return null; }
  })() : null;
  const env = mission?.envelope || {};
  const cognitive = env.cognitive?.envelope || {};
  const files = env.allowed_files || cognitive.permitted_paths || [];
  const repository = env.workspace || env.repository_binding?.repository_root
    || env.cognitive?.envelope?.repository_root || null;
  const policy_id = env.developer_autonomy_policy_id || env.policy_id || null;
  const limits = cognitive.limits || {};
  return {
    repository,
    files: Array.isArray(files) ? files.slice(0, 16) : [],
    max_invocations: Number.isSafeInteger(limits.max_invocations) ? limits.max_invocations : 2,
    max_runtime_ms: Number.isSafeInteger(limits.execution_ms) ? limits.execution_ms : 120000,
    data_class: 'public',
    policy_id,
  };
}

function recoverMatchStanding(bridge, ctx) {
  const hep = bridge.hostExecutionPolicy;
  if (!hep?.diagnoseStandingCursorDevelopment) {
    return { operation: 'match_standing_cursor_grant', performed: false, reason: 'host_execution_policy_unavailable' };
  }
  // Never invents grants. When an active matching grant already covers the Mission,
  // mark performed so admission can reuse it without a second owner prompt.
  const status = hep.status('operator');
  const active = (status.standing_cursor_development || []).filter(g => g.state === 'active');
  const probe = missionStandingProbe(bridge, ctx);
  let diagnosis = null;
  if (probe.repository && probe.files.length) {
    try {
      diagnosis = hep.diagnoseStandingCursorDevelopment(probe);
    } catch (error) {
      diagnosis = { matched: false, code: 'STANDING_CURSOR_GRANT_MISSING', reason: String(error.message || error).slice(0, 160) };
    }
  }
  const matched = diagnosis?.matched === true;
  return {
    operation: 'match_standing_cursor_grant',
    performed: matched,
    matched,
    diagnosis,
    active_grants: active.length,
    grants: active.map(g => ({
      id: g.id, max_runtime_ms: g.max_runtime_ms, missions_remaining: g.missions_remaining,
      policy_id: g.policy_id, state: g.state, expires_at: g.expires_at || null,
    })),
    reenrollment: matched ? null : {
      api: 'POST /api/assistant/host-execution-policy/enroll-standing-cursor-development',
      docs: 'docs/STANDING-CURSOR-DEVELOPMENT-V1.md',
      next_action: diagnosis?.next_action || 'enroll_standing_cursor_development_via_authenticated_local_api',
      code: diagnosis?.code || null,
    },
    note: 'Standing grants persist in durable host DB across restarts/upgrades; never auto-created or auto-raised beyond raise-only runtime API.',
  };
}

function recoverFilesystemCapacity(bridge, evidence) {
  const disks = (evidence.developer_autonomy || []).map(p => ({
    policy_id: p.policy_id, alias: p.alias, disk: p.disk || null,
  }));
  const exhausted = disks.filter(d => d.disk && /exhaust|insufficient|full/i.test(String(d.disk.state || d.disk)));
  return {
    operation: 'diagnose_filesystem_capacity',
    performed: false,
    policies: disks,
    exhausted_count: exhausted.length,
    next_safe_action: 'free_volume_space_then_retry_workspace_prep',
    note: 'Host never deletes dirty/unique workspaces for capacity.',
  };
}

function recoverMissionCapacity(bridge, evidence) {
  const missions = evidence.missions || {};
  const active = Number(missions.active || missions.running || 0);
  const limit = Number(missions.limit || missions.concurrent_limit || 0);
  const free = limit > 0 && active < limit;
  return {
    operation: 'await_mission_capacity',
    performed: free,
    active, limit,
    next_safe_action: free ? 'retry_mission_admission' : 'wait_for_mission_settlement_then_retry',
    note: 'No duplicate Cursor dispatch while capacity is full.',
  };
}

function recoverResolveRepository(bridge, ctx, entry) {
  try {
    let catalogCount = 0;
    try {
      const catalog = require('../config/development-targets-v1.json');
      catalogCount = Array.isArray(catalog.targets) ? catalog.targets.length : 0;
    } catch { /* catalog optional for diagnosis */ }
    const enrolled = (bridge.developerAutonomy?.list?.('operator') || [])
      .filter(p => p.state === 'active')
      .map(p => ({ policy_id: p.policy_id, alias: p.alias, repository: p.repository || p.source_repository || null }));
    if (entry.id === 'enrolled_repository_ambiguous' && enrolled.length === 1) {
      return {
        operation: 'resolve_enrolled_repository',
        performed: true,
        selected: { policy_id: enrolled[0].policy_id, alias: enrolled[0].alias },
        note: 'Unambiguous single enrolled repository selected; never cross-project fixture fallback.',
      };
    }
    return {
      operation: entry.id.includes('not_enrolled') ? 'prepare_enrollment_action' : 'resolve_enrolled_repository',
      performed: false,
      enrolled_count: enrolled.length,
      catalog_targets: catalogCount,
      enrolled: enrolled.map(e => ({ policy_id: e.policy_id, alias: e.alias })),
      next_safe_action: entry.next_safe_action,
      enrollment_api: 'scripts/prepare-development-target-enrollment.cjs + DA enroll',
    };
  } catch (error) {
    return { operation: 'resolve_enrolled_repository', performed: false, reason: String(error.message || error).slice(0, 160) };
  }
}

function recoverNormalizeWorker(bridge, ctx, entry) {
  // Host may clarify when exactly one eligible worker remains; never invent Cursor spend.
  const preferred = ctx.codes?.find(c => /cursor|opencode/i.test(String(c)));
  return {
    operation: 'normalize_cognitive_worker',
    performed: false,
    guidance: entry.id === 'cognitive_ambiguous_worker'
      ? 'Re-plan with a single sealed worker (cursor or opencode) from the Mission allowlist.'
      : 'Omit ambiguous worker prose; sealed specialist assignment selects the worker.',
    preferred_hint: preferred || null,
    note: 'Normalization happens on the next planning pass; no authority expansion.',
  };
}

function recoverLocalEvaluationAuthority(bridge, ctx) {
  // Post-Cursor local evaluation must not re-require live Cursor dispatch qualification.
  if (!ctx.mission_id) {
    return { operation: 'reuse_local_evaluation_authority', performed: false, reason: 'no_mission' };
  }
  try {
    const mission = bridge.controlStore.requireMission(ctx.mission_id);
    if (mission.envelope?.approval_id && bridge.missionApprovals?.assertLocalEvaluation) {
      bridge.missionApprovals.assertLocalEvaluation(mission);
      return { operation: 'reuse_local_evaluation_authority', performed: true, mode: 'approval_bound_local_evaluation' };
    }
    return {
      operation: 'reuse_local_evaluation_authority',
      performed: false,
      next_safe_action: 'qualify_cursor_or_complete_local_opencode_path',
      note: 'Does not enable Cursor or invent spend.',
    };
  } catch (error) {
    return { operation: 'reuse_local_evaluation_authority', performed: false, reason: String(error.message || error).slice(0, 160) };
  }
}

function recoverRepairBudget(bridge, evidence) {
  const policies = (evidence.developer_autonomy || []).map(p => ({
    policy_id: p.policy_id, alias: p.alias, grants_active: p.grants_active,
  }));
  return {
    operation: 'diagnose_repair_budget',
    performed: false,
    policies,
    next_safe_action: 'wait_for_repair_slot_or_owner_raise_max_repairs',
    note: 'Repair ceilings are never raised automatically.',
  };
}

function recoverEvaluation(bridge, ctx) {
  try {
    if (!ctx.mission_id || !bridge?.controlStore) {
      return { operation: 'reconcile_blocked_evaluation', performed: false, reason: 'no_mission_or_recover_api' };
    }
    const mission = bridge.controlStore.getMission(ctx.mission_id);
    if (!mission) return { operation: 'reconcile_blocked_evaluation', performed: false, reason: 'mission_not_found' };
    const reconciled = require('./opencode-gateway').reconcileBlockedEvaluation(bridge, mission);
    // Specialist recover schedules a locked local evaluation retry of the
    // already host-verified worker packet — never a Cursor redispatch.
    let retried = false;
    try {
      const service = bridge.missions;
      if (service?.bridge && service?.store && typeof require('./specialist-gateway').recover === 'function') {
        retried = !!require('./specialist-gateway').recover(service, bridge.controlStore.getMission(ctx.mission_id));
      }
    } catch { /* reconcile alone is still progress */ }
    return {
      operation: 'reconcile_blocked_evaluation',
      performed: !!reconciled || !!retried,
      reconciled: !!reconciled,
      recovery_scheduled: !!retried,
    };
  } catch (error) {
    return { operation: 'reconcile_blocked_evaluation', performed: false, reason: String(error.message || error).slice(0, 160) };
  }
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
  if (id === 'da_filesystem_capacity_exhausted') {
    return { operation: 'diagnose_filesystem_capacity', executable: true, owner_gate_if_unmatched: true };
  }
  if (id === 'concurrent_mission_budget_exhausted') {
    return { operation: 'await_mission_capacity', executable: true, verify: 'mission_capacity_free' };
  }
  if (id === 'da_repair_budget') {
    return { operation: 'diagnose_repair_budget', executable: true, owner_gate_if_unmatched: true };
  }
  if (id === 'source_repository_not_enrolled' || id === 'arecibo_repository_not_enrolled' || id === 'enrolled_workspace_required') {
    return { operation: 'prepare_enrollment_action', executable: true, owner_gate_if_unmatched: true };
  }
  if (id === 'enrolled_repository_ambiguous') {
    return { operation: 'resolve_enrolled_repository', executable: true, owner_gate_if_unmatched: true };
  }
  if (id === 'cognitive_plan_files_mismatch') {
    return { operation: 'normalize_plan_files_guidance', executable: false, note: 'planner_coerce_on_retry' };
  }
  if (id === 'cognitive_explicit_worker_syntax_required' || id === 'cognitive_ambiguous_worker') {
    return { operation: 'normalize_cognitive_worker', executable: true, owner_gate_if_unmatched: true };
  }
  if (id === 'cognitive_delegation_expired_or_revoked' || id === 'cognitive_envelope_expired') {
    return { operation: 'consolidate_owner_gate', executable: false, note: 'reauthorize_cognitive_delegation_or_envelope' };
  }
  if (id === 'cognitive_assignment_limit' || id === 'gateway_assignment_budget_exhausted') {
    return { operation: 'consolidate_owner_gate', executable: false, note: 'wait_or_owner_raise_assignment_budget' };
  }
  if (id === 'cursor_subscription_deadline' || id === 'cursor_proxy_aborted' || id === 'standing_cursor_grant_runtime_limit') {
    return { operation: 'ensure_cognitive_timing_floor', executable: true, owner_if_still_short: true, verify: 'cognitive_execution_ms_floor' };
  }
  if (id === 'blocked_spend_authorization' || id === 'scoped_external_disclosure_required'
    || id === 'standing_cursor_grant_missing' || id === 'standing_cursor_grant_expired'
    || id === 'standing_cursor_grant_revoked' || id === 'standing_cursor_grant_exhausted'
    || id === 'standing_cursor_grant_invocation_limit' || id === 'standing_cursor_grant_mismatch'
    || id === 'cursor_execution_disabled') {
    return { operation: 'match_standing_cursor_grant', executable: true, owner_gate_if_unmatched: true };
  }
  if (id === 'worker_execution_unqualified') {
    return { operation: 'reuse_local_evaluation_authority', executable: true, owner_gate_if_unmatched: true };
  }
  if (id === 'evaluation_unavailable' || id === 'gateway_evaluation_deadline'
    || id === 'opencode_runtime_unavailable' || id === 'opencode_evaluation_timeout'
    || id === 'opencode_evaluation_cancelled' || id === 'opencode_evaluator_termination_unverified') {
    return { operation: 'reconcile_blocked_evaluation', executable: true, verify: 'evaluation_reconciled_or_terminal' };
  }
  if (id === 'opencode_evaluation_authority_denied' || id === 'opencode_runtime_unsupported'
    || id === 'opencode_evaluation_result_invalid') {
    return id === 'opencode_evaluation_authority_denied'
      ? { operation: 'security_investigate_fail_closed', executable: false }
      : { operation: 'consolidate_owner_gate', executable: false };
  }
  if (id === 'runtime_removed' || id === 'repair_blocked' || id === 'owner_action_required') {
    return { operation: 'consolidate_owner_gate', executable: false };
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
    case 'diagnose_filesystem_capacity':
      return recoverFilesystemCapacity(bridge, evidence);
    case 'await_mission_capacity':
      return recoverMissionCapacity(bridge, evidence);
    case 'resolve_enrolled_repository':
    case 'prepare_enrollment_action':
      return recoverResolveRepository(bridge, ctx, entry);
    case 'normalize_cognitive_worker':
      return recoverNormalizeWorker(bridge, ctx, entry);
    case 'reuse_local_evaluation_authority':
      return recoverLocalEvaluationAuthority(bridge, ctx);
    case 'diagnose_repair_budget':
      return recoverRepairBudget(bridge, evidence);
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
  if (plan.verify === 'mission_capacity_free') {
    return { verified: !!recovery.performed, mode: plan.verify, authority: false };
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

    if (plan.owner_gate_if_unmatched && !recovery.performed && !recovery.matched) {
      const detail = recovery.reenrollment?.next_action
        || recovery.next_safe_action
        || recovery.diagnosis?.reason
        || 'Existing authorization does not cover this Mission; owner action required.';
      owner_gate = ownerGate(entry, detail);
      if (recovery.reenrollment) owner_gate.reenrollment = recovery.reenrollment;
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
      canonical_operational_owner: OPERATIONAL_OWNER_CANONICAL.includes(entry.id),
      authority: false,
    };
  });
  const canonical = OPERATIONAL_OWNER_CANONICAL.map(id => {
    const item = items.find(i => i.id === id);
    return item || { id, missing: true, auto_diagnosis: false };
  });
  return {
    entry_count: items.length,
    auto_diagnosis: items.filter(i => i.auto_diagnosis).length,
    executable_safe_recovery: items.filter(i => i.executable_recovery).length,
    owner_only_gates: items.filter(i => i.owner_gate_possible && !i.executable_recovery).length,
    security_fail_closed: items.filter(i => i.security_fail_closed).length,
    canonical_operational_owner: {
      required: OPERATIONAL_OWNER_CANONICAL.length,
      covered: canonical.filter(c => c.auto_diagnosis).length,
      with_executable_recovery: canonical.filter(c => c.executable_recovery).length,
      items: canonical,
    },
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
  OPERATIONAL_OWNER_CANONICAL,
};
