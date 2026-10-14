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
  const db = bridge.controlStore.db;
  let max = null;
  let used = 0;
  try {
    const contract = mission.envelope?.contract?.budget;
    if (contract && Number.isInteger(contract.max_repair_attempts)) max = contract.max_repair_attempts;
    const rootId = mission.envelope?.repair_of || mission.id;
    const children = db.prepare("SELECT count(*) n FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").get(rootId);
    used = Number(children?.n) || 0;
  } catch { /* unavailable */ }
  const remaining = max != null ? Math.max(0, max - used) : null;
  return {
    max_repairs: max,
    repairs_used: used,
    remaining,
    recovery_kind: view.recovery?.kind || null,
    phase_label: view.recovery?.headline || null
  };
}

function activeRun(bridge, mission) {
  const row = bridge.controlStore.db.prepare(`
    SELECT r.id, r.agent_id, r.state, r.process_state, r.termination_verified, r.created_at, r.updated_at
    FROM cp_runs r JOIN cp_dispatches d ON d.run_id=r.id
    WHERE d.mission_id=? ORDER BY r.created_at DESC LIMIT 1`).get(mission.id);
  if (!row) return null;
  const advancing = ['running', 'starting', 'queued', 'dispatching'].includes(row.state)
    || (row.termination_verified !== 1 && !['completed', 'failed', 'cancelled'].includes(row.state));
  return {
    run_id: row.id,
    worker: row.agent_id || null,
    state: row.state,
    process_state: row.process_state,
    advancing: !!advancing && row.termination_verified !== 1,
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
  return {
    mechanism: 'work_templates',
    active_count: active.length,
    templates: templates.slice(0, 40),
    routine_within_scope: [
      'repository_inspection',
      'approved_file_edits',
      'local_tests',
      'build_verification',
      'safe_repair_attempts',
      'approved_worker_execution'
    ],
    never_auto: [
      'production_deployments',
      'credential_changes',
      'security_policy_changes',
      'destructive_operations',
      'unauthorized_disclosure',
      'scope_expansion',
      'privileged_system_mutations'
    ],
    note: active.length
      ? 'Active owner-registered WORK templates authorize routine local work inside their exact scope until expiry or revocation.'
      : 'No active WORK template. Owner enrollment through authenticated Control Center or /workspace is required for standing local development authorization.',
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
    const live = isLiveWork(m, view);
    if (live) liveWork++;
    const obs = obsoleteRework(m, view, bridge);
    if (obs) obsolete++;
    if (display.ownerAttentionRequired(m, view)) ownerGates++;
    if (!live && !obs && !display.ownerAttentionRequired(m, view) && !['awaiting_acceptance', 'waiting_for_operator', 'needs_rework', 'blocked'].includes(m.state)) continue;
    sessions.push({
      mission_id: m.id,
      title: display.operatorTitle(bridge, m).slice(0, 160),
      state: m.state,
      execution_state: executionState(view),
      live_work: live,
      obsolete_rework: obs,
      owner_attention: display.ownerAttentionRequired(m, view),
      active_run: run?.advancing ? run.run_id : null,
      worker: view.runtime || null,
      recovery: view.recovery?.kind || null,
      archive_eligible: obs && visibility.archiveEligible(m, bridge)
    });
  }
  return {
    version: 1,
    summary: {
      active_agent_runs: activeRuns,
      live_work: liveWork,
      obsolete_rework: obsolete,
      owner_gates: ownerGates,
      note: 'Active agent Runs count advancing cp_runs only. Idle Terminal/MCP client sessions are not Runs.'
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
  executionState,
  isLiveWork,
  obsoleteRework,
  repairBudget,
  activeRun,
  workerAdmission,
  standingAuthorization,
  enrichMissionCard,
  previewObsoleteRework,
  executionSessions
};
