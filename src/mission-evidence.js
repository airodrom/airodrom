'use strict';
// ADR 0051. Machine-readable final evidence package for ChatGPT review.
// Built only from canonical host records (missions, runs, verifications, approvals,
// Goal Plan autonomous state, ledger). Worker prose is quoted as untrusted summary
// only. The package is retrievable at any time, so a disconnected ChatGPT
// conversation can resume and review without any background wake-up mechanism.
const { PHASES } = require('./recovery-phase');

function safeMissionId(value) { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null; }

function lineageFor(bridge, mission) {
  // Walk repair_of links up to the root parent and down through the plan lineage.
  const chain = [];
  const seen = new Set();
  let current = mission;
  while (current && !seen.has(current.id) && chain.length < 12) {
    seen.add(current.id);
    chain.unshift({ mission_id: current.id, state: current.state, repair_of: current.envelope?.repair_of || null, created_at: current.created_at });
    current = current.envelope?.repair_of ? bridge.controlStore.getMission(current.envelope.repair_of) : null;
  }
  // Descendants: Missions whose repair_of points at any member.
  const ids = new Set(chain.map(c => c.mission_id));
  let grew = true;
  while (grew && chain.length < 12) {
    grew = false;
    for (const row of bridge.controlStore.db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.repair_of') IS NOT NULL").all()) {
      if (ids.has(row.id)) continue;
      const m = bridge.controlStore.getMission(row.id);
      if (m && ids.has(m.envelope.repair_of)) { ids.add(m.id); chain.push({ mission_id: m.id, state: m.state, repair_of: m.envelope.repair_of, created_at: m.created_at }); grew = true; }
    }
  }
  return chain.sort((a, b) => a.created_at - b.created_at);
}

function planFor(bridge, missionId) {
  const db = bridge.controlStore.db;
  const direct = db.prepare('SELECT p.id FROM cp_mission_programs p JOIN cp_mission_program_nodes n ON n.program_id=p.id WHERE n.mission_id=? AND p.goal_plan IS NOT NULL').get(missionId);
  if (direct) return direct.id;
  for (const row of db.prepare("SELECT id, goal_plan FROM cp_mission_programs WHERE goal_plan IS NOT NULL AND goal_plan LIKE ?").all('%' + missionId + '%')) {
    try {
      const plan = JSON.parse(row.goal_plan);
      const lineage = plan.autonomous?.repair_lineage || {};
      if (Object.values(lineage).some(l => l?.parent_mission_id === missionId || l?.repair_mission_id === missionId) || (plan.autonomous?.repair_history || []).some(h => h.parent_mission_id === missionId || h.repair_mission_id === missionId)) return row.id;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Build the evidence package for a Mission (or any Mission in its repair lineage).
 */
function evidencePackage(bridge, missionId) {
  const store = bridge.controlStore;
  const id = safeMissionId(missionId);
  if (!id) throw Error('Invalid mission id');
  const mission = store.getMission(id);
  if (!mission) throw Error('Mission not found');
  const db = store.db;
  const lineage = lineageFor(bridge, mission);
  const final = lineage[lineage.length - 1] ? store.getMission(lineage[lineage.length - 1].mission_id) : mission;
  const root = lineage[0] ? store.getMission(lineage[0].mission_id) : mission;
  const detail = bridge.missions.detail(final.id);
  const specialists=require('./specialist-gateway').enabled(final)?require('./specialist-gateway').inspect(bridge,final):null;
  const verifications = detail.verifications || [];
  const latestVerification = verifications[0] || null;
  // Worker runs: coding agents, or host native-plan runs with execution evidence. Bridge/verifier bookkeeping runs are excluded.
  const workerRuns = (detail.runs || []).filter(r => !r.result?.gateway && (['opencode', 'cursor', 'claude_code', 'codex'].includes(r.agent_id) || (r.agent_id === 'host' && r.result?.native_execution_evidence)));
  const lastWorkerRun = workerRuns[workerRuns.length - 1] || null;
  const planId = planFor(bridge, final.id) || planFor(bridge, root.id);
  let autonomous = null, phase = null;
  if (planId && bridge.autonomousExecution) {
    try {
      const view = bridge.autonomousExecution.inspect(planId);
      autonomous = view.autonomous;
      phase = Object.values(view.autonomous.phases || {}).find(p => p.mission_id === final.id || p.parent_mission_id === final.id || p.mission_id === root.id || p.parent_mission_id === root.id) || null;
    } catch { autonomous = null; }
  }
  const approval = final.envelope.approval_id && bridge.missionApprovals ? bridge.missionApprovals.view(final.envelope.approval_id) : null;
  const contract = final.envelope.contract || null;
  const changedFiles = [];
  for(const run of detail.runs||[])for(const a of run.result?.artifacts||[])if(a?.path){const item={path:a.path,sha256:a.sha256||null,size:a.size??null,run_id:run.id},prior=changedFiles.findIndex(c=>c.path===a.path);if(prior<0)changedFiles.push(item);else if(specialists)changedFiles[prior]=item;}
  const tests = (latestVerification?.evidence || []).filter(c => /^task:/.test(c.id)).map(c => ({ name: c.id.slice(5), status: c.status, exit_code: c.evidence?.exit_code ?? null }));
  const security = (latestVerification?.evidence || []).filter(c => /^security:|^(verifier_inputs_unchanged|protected_tests_unchanged|contract_integrity)$/.test(c.id)).map(c => ({ id: c.id, status: c.status, classification: c.evidence?.classification || null, new_findings: c.evidence?.new_findings ?? null, tampering: c.evidence?.tampering?.length ?? null }));
  const repairs = specialists?specialists.repair_attempts:lineage.filter(l=>l.repair_of).length;
  const stageId = phase?.stage_id || null;
  const budgetSources = { contract: contract?.budget?.max_repair_attempts ?? null, plan: autonomous?.max_repairs ?? null, approval: approval?.repair_budget ?? null };
  const effectiveRepairs = [budgetSources.contract, budgetSources.plan, budgetSources.approval].filter(v => Number.isSafeInteger(v));
  const budgetConsumed = {
    repair_attempts: repairs,
    // The effective ceiling is the strictest of contract, Goal Plan authorization and approval.
    max_repair_attempts: effectiveRepairs.length ? Math.min(...effectiveRepairs) : null,
    budget_sources: budgetSources,
    dispatches: specialists?detail.dispatches.length:autonomous?.dispatch_count??null,
    max_dispatches: specialists?contract.budget.max_worker_invocations:autonomous?.max_dispatches??null,
    worker_runs: workerRuns.length,
    wall_clock_ms: final.updated_at && root.created_at ? final.updated_at - root.created_at : null,
    repair_signatures: stageId ? (autonomous?.repair_signatures?.[stageId] || []).length : null,
  };
  const spend = contract?.budget?.spend_observability === 'UNKNOWN_SUBSCRIPTION' || lastWorkerRun?.agent_id === 'cursor' ? 'UNKNOWN (subscription-backed worker; no per-run billing is observable)' : 'LOCAL_NO_SPEND (local inference)';
  const unauthorized = (latestVerification?.evidence || []).filter(c => ['protected_files', 'repository_v2', 'creation_repository_v2', 'verifier_inputs_unchanged', 'protected_tests_unchanged'].includes(c.id) && c.status === 'failed').map(c => c.id);
  const status = final.state === 'completed' ? (specialists?'AUTOMATICALLY_ACCEPTED':'OWNER_ACCEPTED') : final.state === 'awaiting_acceptance' ? 'VERIFIED_AWAITING_ACCEPTANCE' : final.state === 'cancelled' ? 'CANCELLED' : phase?.phase || final.state.toUpperCase();
  const legacyNextSafeAction = final.state === 'awaiting_acceptance' ? 'Owner reviews evidence and records Acceptance (accept or rework) in Control Center or Terminal.' : final.state === 'completed' ? 'None required for this Mission. Merge, installation and production remain separate owner-controlled actions.' : phase?.observing ? 'Wait; Airodrom is still executing or repairing within the approved scope.' : phase?.message || 'Owner inspects diagnostics; no automatic retry is pending.';
  const nextSafeAction=specialists&&['ready','dispatching','running','verifying'].includes(final.state)?'Wait; sealed specialist work, evaluation and bounded repair advance automatically.':specialists&&final.state==='awaiting_acceptance'?'Automatic completion is pending current policy, protected-action clearance or settlement; no routine manual Acceptance is required.':legacyNextSafeAction;
  return {
    schema_version: 1,
    ...(specialists?{specialists}:{}),
    ...(final.envelope.cognitive ? { gateway: require('./opencode-gateway').evidence(bridge, final),
    cognitive: require('./cognitive-router').evidence(bridge, final, detail, latestVerification, changedFiles) } : {}),
    mission_id: final.id,
    root_mission_id: root.id,
    goal_id: final.goal_id,
    plan_id: planId,
    status,
    phase: phase ? { phase: phase.phase, observing: phase.observing, reason: phase.reason, message: phase.message } : null,
    objective: root.envelope.objective,
    approved_scope: contract ? { workspace_label: require('node:path').basename(contract.project.workspace), allowed_write_paths: contract.permissions.allowed_write_paths, allowed_read_paths: contract.permissions.allowed_read_paths, network: contract.permissions.network, external_disclosure: contract.permissions.external_disclosure, worker_allowlist: contract.execution.worker_allowlist, scope_fingerprint: contract.scope_fingerprint } : { workspace_label: require('node:path').basename(final.envelope.workspace), allowed_write_paths: final.envelope.allowed_files, contract: 'absent (legacy Mission; governed by authority/manifest/dispatch policy)' },
    base_sha: contract?.project?.base_commit_sha || final.envelope.baseline?.head || null,
    result_sha: latestVerification?.workspace_hash || null,
    worker: lastWorkerRun ? { agent_id: lastWorkerRun.agent_id, version: lastWorkerRun.result?.cursor_provenance?.runtime_version || lastWorkerRun.result?.opencode_provenance?.runtime_version || lastWorkerRun.result?.worker_provenance?.runtime_version || null, termination_verified: lastWorkerRun.termination_verified === 1 } : null,
    sandbox: lastWorkerRun?.result?.cursor_provenance || lastWorkerRun?.result?.opencode_provenance ? { kind: (lastWorkerRun.result.cursor_provenance || lastWorkerRun.result.opencode_provenance).sandbox || 'sandbox-exec', sandbox_id: (lastWorkerRun.result.cursor_provenance || lastWorkerRun.result.opencode_provenance).sandbox_id || null, network: (lastWorkerRun.result.cursor_provenance || lastWorkerRun.result.opencode_provenance).network || null } : null,
    changed_files: changedFiles,
    tests,
    security_checks: security,
    verification: latestVerification ? { id: latestVerification.id, result: latestVerification.result, checker: latestVerification.checker, checks: latestVerification.evidence.map(c => ({ id: c.id, status: c.status })), created_at: latestVerification.created_at } : null,
    repair_attempts: repairs,
    repair_lineage: lineage,
    budget_consumed: budgetConsumed,
    cost_observed: spend,
    known_limitations: [
      ...(lastWorkerRun?.agent_id === 'cursor' ? ['Cursor tool arguments beyond file paths, model reasoning and provider billing are unobservable; host inventory is authoritative.'] : []),
      ...(contract ? [] : ['Legacy Mission without a canonical contract; approval binding and verifier baseline were not recorded.']),
      'Worker summaries are untrusted; only host verification records prove results.',
    ],
    approval_status: approval ? { approval_id: approval.approval_id, state: approval.state, channel: approval.channel, expires_at: approval.expires_at, repair_budget: approval.repair_budget, external_disclosure: approval.external_disclosure } : { state: 'absent' },
    acceptance_status: final.state === 'completed' ? 'accepted' : (detail.acceptance || []).length ? detail.acceptance[0].decision : (specialists?'automatic_pending':'owner_only_pending'),
    settlement_status: detail.program_contract?.settlement?.state || (specialists?db.prepare('SELECT state FROM cp_mission_settlements WHERE mission_id=?').get(final.id)?.state:null) || null,
    unauthorized_changes: unauthorized,
    git: { pr_created: false, merged: false, installed: false, note: 'Coding workers never commit, push, merge or deploy; those remain owner actions.' },
    worker_summary_untrusted: (detail.results || []).map(r => r.result?.summary).filter(Boolean).slice(-1)[0] || null,
    answers: {
      what_was_requested: root.envelope.objective,
      what_changed: changedFiles.map(c => c.path),
      tests_passed: tests.length ? tests.every(t => t.status === 'passed') : null,
      security_passed: security.length ? security.every(s => ['passed', 'operator_review'].includes(s.status)) : null,
      repair_needed: repairs > 0,
      attempts: specialists?workerRuns.length:repairs+1,
      original_goal_resumed: !!planId && (final.state === 'awaiting_acceptance' || final.state === 'completed'),
      unauthorized_changes: unauthorized.length > 0,
      pr_created: false, merged: false, installed: false,
      requires_owner: specialists&&['ready','dispatching','running','verifying','completed','awaiting_acceptance'].includes(final.state)?[]:final.state === 'awaiting_acceptance' ? ['Acceptance'] : final.state === 'completed' ? [] : ['Inspect diagnostics'],
    },
    next_safe_action: nextSafeAction,
    limits_blockers: (() => {
      try {
        if (!['blocked', 'needs_rework'].includes(final.state)) return null;
        const codes = [final.reason, final.envelope?.block_reason, phase?.reason].filter(Boolean);
        if (!codes.length) codes.push(final.state);
        return require('./limits-blockers-registry').reportForBlock(bridge, {
          codes, mission_id: final.id,
          request_id: final.envelope?.cognitive_request_id || null,
        });
      } catch { return null; }
    })(),
    authority: false,
    generated_at: Date.now(),
  };
}

/** Compact event timeline for a Mission lineage (flight recorder subset). */
function missionEvents(bridge, missionId, { limit = 100 } = {}) {
  const id = safeMissionId(missionId);
  if (!id) throw Error('Invalid mission id');
  const mission = bridge.controlStore.getMission(id);
  if (!mission) throw Error('Mission not found');
  const lineage = lineageFor(bridge, mission);
  const events = [];
  for (const item of lineage) {
    for (const e of bridge.ledger.list({ missionId: item.mission_id, limit: Math.max(limit, 200), order: 'asc' }).events) {
      events.push({
        event_id: e.event_id,
        sequence: e.sequence,
        at: e.timestamp_ms,
        mission_id: item.mission_id,
        type: e.event_type,
        status: e.status || null,
        metadata: compactMetadata(e.metadata),
        run_id: e.run_id || null,
      });
    }
  }
  events.sort((a, b) => (a.sequence || a.at) - (b.sequence || b.at));
  const sliced = events.slice(-limit);
  return {
    mission_id: id,
    lineage: lineage.map(l => l.mission_id),
    events: sliced,
    cursor: sliced.length ? (sliced[sliced.length - 1].sequence || sliced[sliced.length - 1].at) : null,
    authority: false,
  };
}

/**
 * Chronological engineering report for ChatGPT retrieval.
 * Separates worker-reported claims from host-verified evidence. Never invents
 * private model reasoning or unverified actions.
 */
function engineeringReport(bridge, missionId, { limit = 200 } = {}) {
  const base = missionEvents(bridge, missionId, { limit });
  const mission = bridge.controlStore.getMission(base.mission_id);
  const evidence = evidencePackage(bridge, base.mission_id);
  const stages = [];
  for (const e of base.events) {
    const provenance = e.metadata?.provenance || null;
    const claim = provenance === 'WORKER_REPORTED' || (e.type === 'worker.trace' && provenance !== 'HOST_MEDIATED');
    const host = provenance === 'HOST_MEDIATED' || /^(mission\.|verification\.|acceptance\.|gateway\.|runtime\.execution)/.test(e.type);
    let label = e.type;
    if (e.type === 'mission.created') label = 'Mission created';
    else if (e.type === 'mission.approval.bound' || e.type === 'mission.approval.issued') label = 'Mission authorized';
    else if (e.type === 'gateway.assignments.sealed') label = 'OpenCode plan sealed';
    else if (e.type === 'runtime.execution.started' && e.metadata?.agent_id === 'cursor') label = 'Cursor startup';
    else if (e.type === 'worker.trace' && e.metadata?.kind === 'worker.tool_started' && e.metadata?.path) label = 'File inspected (worker-reported)';
    else if (e.type === 'worker.trace' && e.metadata?.kind === 'worker.tool_completed' && e.metadata?.path) label = 'File tool completed (worker-reported)';
    else if (e.type === 'worker.terminated' || (e.type === 'worker.trace' && e.metadata?.kind === 'worker.exited')) label = 'Worker execution result';
    else if (e.type === 'gateway.evaluated') label = 'OpenCode evaluation';
    else if (e.type === 'verification.completed' || e.type === 'verification.failed') label = 'Airodrom independent verification';
    else if (e.type === 'mission.completed' || e.type === 'mission.accepted') label = 'Mission Acceptance';
    else if (e.type === 'mission.blocked' || e.type === 'mission.needs_rework' || e.type === 'mission.cancelled') label = 'Mission ' + (e.metadata?.state || e.type.split('.')[1]);
    else if (e.type === 'mission.terminal_notification_enqueued') label = 'Terminal notification enqueued';
    stages.push({
      event_id: e.event_id,
      sequence: e.sequence,
      at: e.at,
      mission_id: e.mission_id,
      type: e.type,
      label,
      evidence_class: claim ? 'worker_reported_untrusted' : host ? 'host_verified' : 'observed',
      path: e.metadata?.path || null,
      tool: e.metadata?.tool || null,
      agent_id: e.metadata?.agent_id || null,
      recommendation: e.metadata?.recommendation || null,
      termination_verified: e.metadata?.termination_verified ?? null,
      authority: false,
    });
  }
  const notifications = require('./mission-terminal-notifications').listForMission(bridge, base.mission_id);
  let limitsBlockers = evidence.limits_blockers || null;
  let recoveryReceipt = null;
  if (['blocked', 'needs_rework'].includes(mission.state)) {
    try {
      const codes = [mission.reason, mission.envelope?.block_reason, evidence.status].filter(Boolean);
      if (!limitsBlockers) {
        limitsBlockers = require('./limits-blockers-registry').reportForBlock(bridge, {
          codes: codes.length ? codes : [mission.state],
          mission_id: base.mission_id,
          request_id: mission.envelope?.cognitive_request_id || null,
        });
      }
      // Read-only: do not re-dispatch recovery from report reads; surface latest receipt if present.
      const db = bridge.controlStore?.db;
      if (db) {
        try {
          const row = db.prepare(
            `SELECT receipt_json FROM cp_limits_blocker_recovery_attempts
             WHERE mission_id=? ORDER BY created_at DESC LIMIT 1`
          ).get(base.mission_id);
          if (row?.receipt_json) recoveryReceipt = JSON.parse(row.receipt_json);
        } catch { /* schema may not exist yet */ }
      }
    } catch { /* annotation must not break engineering report */ }
  }
  return {
    mission_id: base.mission_id,
    lineage: base.lineage,
    repository_binding: {
      project_id: mission.project_id || null,
      repository_id: mission.envelope?.cognitive?.envelope?.repository_id
        || mission.envelope?.repository_binding?.repository_id || null,
      target_id: mission.envelope?.repository_binding?.target_id || null,
      workspace: mission.envelope?.workspace || null,
      preferred_agent: mission.envelope?.preferred_agent || null,
      allowed_files: mission.envelope?.allowed_files || [],
      cross_project_grant: false,
    },
    stages,
    cursor: base.cursor,
    host_verified_changes: evidence.changed_files || [],
    verification_status: evidence.verification?.result || evidence.status || null,
    acceptance_status: evidence.acceptance_status || null,
    notifications: notifications.notifications,
    limits_blockers: limitsBlockers,
    blocker_recovery: recoveryReceipt ? {
      receipt_id: recoveryReceipt.id,
      registry_id: recoveryReceipt.registry_id,
      category: recoveryReceipt.category,
      operation: recoveryReceipt.plan?.operation || recoveryReceipt.recovery?.operation || null,
      performed: !!recoveryReceipt.recovery?.performed,
      verification: recoveryReceipt.verification || null,
      owner_gate: recoveryReceipt.owner_gate || null,
      resumed: !!recoveryReceipt.resumed,
      authority: false,
    } : null,
    authority: false,
    note: 'Worker-reported stages are untrusted claims. Host-verified stages come from Airodrom ledger and independent verification.',
  };
}

function compactMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const keep = ['assignment_id', 'worker', 'role', 'repair', 'worker_run_id', 'binding_hash', 'result_hash', 'recommendation', 'state', 'previous', 'reason', 'kind', 'provenance', 'agent_id', 'plan_id', 'stage_id', 'repair_mission_id', 'parent_mission_id', 'diagnosis', 'classification', 'attempt', 'max_repairs', 'approval_id', 'result', 'phase', 'tool', 'scope', 'path', 'exit_code', 'termination_verified', 'dispatch_path', 'notification_id', 'destination', 'status', 'files', 'writable', 'sandbox_id'];
  return Object.fromEntries(Object.entries(metadata).filter(([k]) => keep.includes(k)));
}

module.exports = { evidencePackage, missionEvents, engineeringReport, lineageFor, planFor, PHASES };
