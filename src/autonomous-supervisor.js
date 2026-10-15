'use strict';
// Autonomous Supervisor V1 — display/admission helpers over Mission V2 + CAE (never a second scheduler).
const display = require('./product-observability');
const visibility = require('./mission-visibility');
const router = require('./model-worker-router');

const EXEC_STATES = Object.freeze([
  'QUEUED', 'RUNNING', 'VERIFYING', 'REPAIRING', 'BLOCKED',
  'AWAITING_ACCEPTANCE', 'COMPLETED', 'FAILED', 'CANCELLED'
]);

function executionState(view) {
  if (!view) return 'FAILED';
  if (['dispatching'].includes(view.state)) return 'QUEUED';
  if (view.state === 'running') return 'RUNNING';
  if (view.state === 'verifying') return 'VERIFYING';
  if (view.state === 'needs_rework' && ['recovering', 'eligible', 'waiting'].includes(view.recovery?.kind)) return 'REPAIRING';
  if (view.state === 'blocked' || view.recovery?.kind === 'blocked' || view.recovery?.kind === 'uncertain') return 'BLOCKED';
  if (view.state === 'waiting_for_operator' || view.state === 'awaiting_acceptance') return 'AWAITING_ACCEPTANCE';
  if (view.state === 'completed') return 'COMPLETED';
  if (view.state === 'cancelled') return 'CANCELLED';
  if (['blocked', 'needs_rework'].includes(view.state)) return 'FAILED';
  return 'QUEUED';
}

/** True when Mission is live execution or authorized non-terminal recovery. */
function isLiveWork(mission, view) {
  if (['dispatching', 'running', 'verifying'].includes(mission.state)) return true;
  if (!view.autonomous_managed) return false;
  return ['recovering', 'eligible', 'waiting'].includes(view.recovery?.kind);
}

/** Obsolete needs_rework that is not actionable live work and may be presentation-archived. */
function obsoleteRework(mission, view, bridge) {
  if (mission.state !== 'needs_rework') return false;
  if (isLiveWork(mission, view)) return false;
  if (display.ownerAttentionRequired(mission, view)) return false;
  if (visibility.isArchived(bridge.controlStore.db, mission.id)) return false;
  return ['failed', 'blocked', 'uncertain', 'needs_owner', 'none'].includes(view.recovery?.kind || 'none');
}

function repairBudget(bridge, mission, view) {
  // Authoritative multi-generation lineage + strictest contract/plan/approval ceiling.
  // Never invent a remaining count from immediate children only.
  try {
    const evidence = require('./mission-evidence');
    const lineage = evidence.lineageFor(bridge, mission);
    const repairs_used = lineage.filter(l => l.repair_of).length;
    const root = lineage[0] ? bridge.controlStore.getMission(lineage[0].mission_id) : mission;
    const final = lineage[lineage.length - 1] ? bridge.controlStore.getMission(lineage[lineage.length - 1].mission_id) : mission;
    const contract = final?.envelope?.contract || root?.envelope?.contract || mission.envelope?.contract || null;
    let planMax = null;
    const planId = evidence.planFor(bridge, final.id) || evidence.planFor(bridge, root.id);
    if (planId && bridge.autonomousExecution) {
      try {
        const inspected = bridge.autonomousExecution.inspect(planId);
        if (Number.isSafeInteger(inspected?.autonomous?.max_repairs)) planMax = inspected.autonomous.max_repairs;
      } catch { /* plan inspect optional */ }
    }
    let approvalMax = null;
    const approvalId = final?.envelope?.approval_id || root?.envelope?.approval_id || mission.envelope?.approval_id;
    if (approvalId && bridge.missionApprovals) {
      try {
        const approval = bridge.missionApprovals.view(approvalId);
        if (Number.isSafeInteger(approval?.repair_budget)) approvalMax = approval.repair_budget;
      } catch { /* approval optional */ }
    }
    const sources = {
      contract: Number.isSafeInteger(contract?.budget?.max_repair_attempts) ? contract.budget.max_repair_attempts : null,
      plan: planMax,
      approval: approvalMax
    };
    const ceilings = [sources.contract, sources.plan, sources.approval].filter(v => Number.isSafeInteger(v));
    const max = ceilings.length ? Math.min(...ceilings) : null;
    if (max == null) {
      return {
        max_repairs: null,
        repairs_used,
        remaining: null,
        unavailable: true,
        budget_sources: sources,
        lineage_size: lineage.length,
        recovery_kind: view.recovery?.kind || null,
        phase_label: view.recovery?.headline || null
      };
    }
    return {
      max_repairs: max,
      repairs_used,
      remaining: Math.max(0, max - repairs_used),
      unavailable: false,
      budget_sources: sources,
      lineage_size: lineage.length,
      recovery_kind: view.recovery?.kind || null,
      phase_label: view.recovery?.headline || null
    };
  } catch {
    return {
      max_repairs: null,
      repairs_used: null,
      remaining: null,
      unavailable: true,
      recovery_kind: view.recovery?.kind || null,
      phase_label: view.recovery?.headline || null
    };
  }
}

// Positive advancing worker states only. Interrupted / termination_unverified never count.
const ADVANCING_RUN_STATES = Object.freeze(['running', 'starting', 'queued', 'dispatching']);
// Process evidence that may accompany a still-advancing Run. `unknown` is never advancing.
const TRUSTED_PROCESS_STATES = Object.freeze(['alive', 'starting', 'not_started']);

function runOwnership(row) {
  if (!row) return 'none';
  const verified = row.termination_verified === 1;
  const state = row.state;
  const process = row.process_state || 'unknown';
  if (verified && ['completed', 'failed', 'cancelled', 'interrupted'].includes(state)) return 'stopped';
  if (process === 'unknown') return 'unknown';
  if (state === 'interrupted' || state === 'termination_unverified') return 'unverified';
  if (!verified && !ADVANCING_RUN_STATES.includes(state) && !['completed', 'failed', 'cancelled'].includes(state)) {
    return 'unverified';
  }
  if (!verified && ADVANCING_RUN_STATES.includes(state) && !TRUSTED_PROCESS_STATES.includes(process)) {
    return 'unverified';
  }
  if (ADVANCING_RUN_STATES.includes(state) && !verified && TRUSTED_PROCESS_STATES.includes(process)) {
    // running requires live process evidence; pre-alive states may be not_started/starting.
    if (state === 'running' && process !== 'alive' && process !== 'starting') return 'unverified';
    return 'advancing';
  }
  return 'stopped';
}

function activeRun(bridge, mission) {
  const row = bridge.controlStore.db.prepare(`
    SELECT r.id, r.agent_id, r.state, r.process_state, r.termination_verified, r.created_at, r.updated_at
    FROM cp_runs r JOIN cp_dispatches d ON d.run_id=r.id
    WHERE d.mission_id=? ORDER BY r.created_at DESC LIMIT 1`).get(mission.id);
  if (!row) return null;
  const ownership = runOwnership(row);
  const advancing = ownership === 'advancing';
  return {
    run_id: row.id,
    worker: row.agent_id || null,
    state: row.state,
    process_state: row.process_state,
    termination_verified: row.termination_verified === 1,
    ownership,
    advancing,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function workerAdmission(bridge, observed = {}) {
  let catalog;
  try {
    catalog = router.registry(bridge, observed);
  } catch {
    catalog = { workers: [], models: [] };
  }
  const byId = Object.fromEntries((catalog.workers || []).map(w => [w.id, w]));
  const known = [
    { id: 'opencode', label: 'OpenCode / Qwen', locality: 'local' },
    { id: 'cursor', label: 'Cursor Agent', locality: 'external' },
    { id: 'claude_code', label: 'Claude Code', locality: 'external' },
    { id: 'codex', label: 'Codex', locality: 'external' },
    { id: 'host', label: 'Host verifier', locality: 'local' }
  ];
  const out = [];
  for (const k of known) {
    if (k.id === 'host') {
      out.push({
        id: k.id,
        label: k.label,
        locality: k.locality,
        qualification: 'qualified',
        available: true,
        selectable_by_auto: false,
        reason: 'host_verifier',
        editor_not_worker: false
      });
      continue;
    }
    const w = byId[k.id];
    const qualification = w?.qualification === 'qualified' ? 'qualified' : 'unqualified';
    const available = !!(w?.available && qualification === 'qualified');
    let reason = w?.reason || (w ? (available ? 'qualified_available' : 'not_available') : 'not_admitted_for_work');
    if (k.id === 'cursor' && qualification !== 'qualified') {
      reason = 'cursor_execution_unqualified';
    }
    out.push({
      id: k.id,
      label: k.label,
      locality: k.locality,
      qualification,
      available,
      selectable_by_auto: available && k.locality === 'local',
      reason,
      editor_not_worker: k.id === 'cursor'
    });
  }
  const auto = router.select(catalog, {
    mission_class: 'WORK',
    data_class: 'public',
    privacy: 'local_only',
    model: 'auto',
    worker: 'auto',
    required_capabilities: ['coding']
  });
  return {
    mode_default: 'AUTO',
    auto_route: auto.state === 'READY'
      ? { state: 'READY', worker: auto.worker, model: auto.model, locality: auto.locality, reason: auto.reason }
      : { state: 'WAIT', worker: null, model: null, reason: auto.reason },
    auto_selects: out.filter(w => w.selectable_by_auto).map(w => w.id),
    workers: out,
    note: 'AUTO selects only currently qualified and authorized WORK workers. Cursor IDE tasks are not Cursor Agent execution.'
  };
}

/** Standing local WORK authorization surface (work templates). Never grants new authority. */
function standingAuthorization(bridge) {
  let templates = [];
  try {
    templates = (bridge.workTemplates?.list?.('operator') || []).map(t => ({
      project: t.project,
      workspace_alias: t.workspace_alias,
      state: t.state,
      expires_at: t.expires_at || null,
      workers: t.workers || ['opencode'],
      privacy: t.privacy || 'local_only',
      active: t.state === 'active'
    }));
  } catch { /* unavailable */ }
  const active = templates.filter(t => t.active);
  let autonomy = null;
  try { autonomy = bridge.developerAutonomy?.status?.('operator') || null; } catch { autonomy = null; }
  const daActive = autonomy?.active_count || 0;
  return {
    mechanism: daActive ? 'developer_autonomy' : 'work_templates',
    active_count: daActive || active.length,
    templates: templates.slice(0, 40),
    developer_autonomy: autonomy,
    routine_within_scope: [
      'repository_inspection',
      'approved_file_edits',
      'local_tests',
      'build_verification',
      'safe_repair_attempts',
      'approved_worker_execution',
      'isolated_worktree_preparation',
      'draft_pr_preparation'
    ],
    never_auto: [
      'production_deployments',
      'credential_changes',
      'security_policy_changes',
      'destructive_operations',
      'unauthorized_disclosure',
      'scope_expansion',
      'privileged_system_mutations',
      'protected_branch_merge',
      'paid_external_usage'
    ],
    note: daActive
      ? 'Active Developer Autonomy policies authorize routine local work inside enrolled repositories. Short-lived Mission grants are validated at dispatch. WORK templates remain available for exact-file scopes.'
      : (active.length
        ? 'Active owner-registered WORK templates authorize routine local work inside their exact scope until expiry or revocation.'
        : 'No active Developer Autonomy policy or WORK template. Owner enrollment through authenticated Control Center is required for standing local development authorization.'),
    authority: false
  };
}

function enrichMissionCard(bridge, mission, card, view) {
  const run = activeRun(bridge, mission);
  const budget = repairBudget(bridge, mission, view);
  const exec = executionState(view);
  return {
    ...card,
    execution_state: exec,
    execution_states: EXEC_STATES,
    active_run: run && run.advancing ? { run_id: run.run_id, worker: run.worker, state: run.state } : null,
    worker_active: !!(run && run.advancing),
    // Uncertain ownership is surfaced for recovery; never counted as an advancing worker.
    run_ownership: run ? {
      ownership: run.ownership,
      run_id: run.run_id,
      worker: run.worker,
      state: run.state,
      process_state: run.process_state,
      termination_verified: run.termination_verified
    } : null,
    repair: budget,
    recovery: view.recovery ? {
      kind: view.recovery.kind,
      headline: view.recovery.headline,
      detail: view.recovery.detail,
      suppress_manual: view.recovery.suppress_manual
    } : null,
    live_work: isLiveWork(mission, view),
    obsolete_rework: obsoleteRework(mission, view, bridge),
    worker_selection: {
      preferred: mission.envelope?.preferred_agent || null,
      mode: mission.envelope?.model_route_mode || mission.envelope?.route_mode || 'AUTO',
      assigned: view.runtime || null
    }
  };
}

function previewObsoleteRework(bridge, { request_id = null, limit = 50 } = {}) {
  visibility.ensure(bridge.controlStore.db);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error('Invalid obsolete-rework limit');
  const items = [];
  for (const m of display.missionIndex(bridge)) {
    if (visibility.isArchived(bridge.controlStore.db, m.id)) continue;
    const view = display.missionView(bridge, m);
    if (!obsoleteRework(m, view, bridge)) continue;
    if (!visibility.archiveEligible(m, bridge)) continue;
    items.push({
      id: m.id,
      label: display.operatorTitle(bridge, m).slice(0, 160),
      state: m.state,
      recovery: view.recovery?.kind || null,
      created_at: m.created_at
    });
    if (items.length >= limit) break;
  }
  if (!items.length) {
    return {
      preview_id: null,
      digest: null,
      items: [],
      total: 0,
      authority: false,
      note: 'No obsolete needs_rework Missions are eligible for presentation archive.'
    };
  }
  const crypto = require('node:crypto');
  const { randomUUID } = require('node:crypto');
  const sorted = [...items.map(i => i.id)].sort();
  const digest = crypto.createHash('sha256').update('archive\n' + sorted.join('\n')).digest('hex');
  const preview_id = randomUUID();
  const created_at = Date.now();
  const expires_at = created_at + visibility.PREVIEW_TTL_MS;
  bridge.controlStore.db.prepare(`INSERT INTO cp_mission_archive_previews
    (preview_id,kind,digest,mission_ids,created_at,expires_at,request_id,used_at)
    VALUES(?,?,?,?,?,?,?,NULL)`).run(preview_id, 'archive', digest, JSON.stringify(sorted), created_at, expires_at, request_id);
  return {
    preview_id,
    digest,
    items,
    total: items.length,
    expires_at,
    authority: false,
    note: 'Presentation archive only. Durable evidence and audit history are preserved. Active Runs are never included.'
  };
}

function executionSessions(bridge) {
  visibility.ensure(bridge.controlStore.db);
  const missions = display.missionIndex(bridge);
  const sessions = [];
  let activeRuns = 0;
  let unverifiedRuns = 0;
  let unknownOwnership = 0;
  let liveWork = 0;
  let obsolete = 0;
  let ownerGates = 0;
  let observed = {};
  try {
    const rt = bridge.opencodeAdapter?.status?.() || {};
    observed = { ready: rt.state === 'Ready' || rt.ready === true, reason: rt.reason };
  } catch { /* ignore */ }
  for (const m of missions) {
    if (visibility.isArchived(bridge.controlStore.db, m.id)) continue;
    const view = display.missionView(bridge, m);
    const run = activeRun(bridge, m);
    if (run?.advancing) activeRuns++;
    if (run?.ownership === 'unverified') unverifiedRuns++;
    if (run?.ownership === 'unknown') unknownOwnership++;
    const live = isLiveWork(m, view);
    if (live) liveWork++;
    const obs = obsoleteRework(m, view, bridge);
    if (obs) obsolete++;
    if (display.ownerAttentionRequired(m, view)) ownerGates++;
    if (!live && !obs && !display.ownerAttentionRequired(m, view) && !['awaiting_acceptance', 'waiting_for_operator', 'needs_rework', 'blocked'].includes(m.state) && !run) continue;
    sessions.push({
      mission_id: m.id,
      title: display.operatorTitle(bridge, m).slice(0, 160),
      state: m.state,
      execution_state: executionState(view),
      live_work: live,
      obsolete_rework: obs,
      owner_attention: display.ownerAttentionRequired(m, view),
      active_run: run?.advancing ? run.run_id : null,
      run_ownership: run?.ownership || null,
      worker: view.runtime || null,
      recovery: view.recovery?.kind || null,
      archive_eligible: obs && visibility.archiveEligible(m, bridge)
    });
  }
  return {
    version: 1,
    summary: {
      active_agent_runs: activeRuns,
      unverified_runs: unverifiedRuns,
      unknown_ownership_runs: unknownOwnership,
      live_work: liveWork,
      obsolete_rework: obsolete,
      owner_gates: ownerGates,
      note: 'Active agent Runs count only positively advancing cp_runs with trustworthy process evidence. Interrupted, termination_unverified, and unknown process ownership are not active Runs.'
    },
    sessions: sessions.slice(0, 100),
    workers: workerAdmission(bridge, observed),
    standing_authorization: standingAuthorization(bridge),
    observed_at: Date.now(),
    authority: false
  };
}

module.exports = {
  EXEC_STATES,
  ADVANCING_RUN_STATES,
  TRUSTED_PROCESS_STATES,
  executionState,
  isLiveWork,
  obsoleteRework,
  repairBudget,
  runOwnership,
  activeRun,
  workerAdmission,
  standingAuthorization,
  enrichMissionCard,
  previewObsoleteRework,
  executionSessions
};
