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
  const verifications = detail.verifications || [];
  const latestVerification = verifications[0] || null;
  // Worker runs: coding agents, or host native-plan runs with execution evidence. Bridge/verifier bookkeeping runs are excluded.
  const workerRuns = (detail.runs || []).filter(r => ['opencode', 'cursor', 'claude_code', 'codex'].includes(r.agent_id) || (r.agent_id === 'host' && r.result?.native_execution_evidence));
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
  for (const run of detail.runs || []) for (const a of run.result?.artifacts || []) if (a?.path && !changedFiles.some(c => c.path === a.path)) changedFiles.push({ path: a.path, sha256: a.sha256 || null, size: a.size || null, run_id: run.id });
  const tests = (latestVerification?.evidence || []).filter(c => /^task:/.test(c.id)).map(c => ({ name: c.id.slice(5), status: c.status, exit_code: c.evidence?.exit_code ?? null }));
  const security = (latestVerification?.evidence || []).filter(c => /^security:|^(verifier_inputs_unchanged|protected_tests_unchanged|contract_integrity)$/.test(c.id)).map(c => ({ id: c.id, status: c.status, classification: c.evidence?.classification || null, new_findings: c.evidence?.new_findings ?? null, tampering: c.evidence?.tampering?.length ?? null }));
  const repairs = lineage.filter(l => l.repair_of).length;
  const stageId = phase?.stage_id || null;
  const budgetConsumed = {
    repair_attempts: repairs,
    max_repair_attempts: contract?.budget?.max_repair_attempts ?? autonomous?.max_repairs ?? null,
    dispatches: autonomous?.dispatch_count ?? null,
    max_dispatches: autonomous?.max_dispatches ?? null,
    worker_runs: workerRuns.length,
    wall_clock_ms: final.updated_at && root.created_at ? final.updated_at - root.created_at : null,
    repair_signatures: stageId ? (autonomous?.repair_signatures?.[stageId] || []).length : null,
  };
  const spend = contract?.budget?.spend_observability === 'UNKNOWN_SUBSCRIPTION' || lastWorkerRun?.agent_id === 'cursor' ? 'UNKNOWN (subscription-backed worker; no per-run billing is observable)' : 'LOCAL_NO_SPEND (local inference)';
  const unauthorized = (latestVerification?.evidence || []).filter(c => ['protected_files', 'repository_v2', 'creation_repository_v2', 'verifier_inputs_unchanged', 'protected_tests_unchanged'].includes(c.id) && c.status === 'failed').map(c => c.id);
  const status = final.state === 'completed' ? 'OWNER_ACCEPTED' : final.state === 'awaiting_acceptance' ? 'VERIFIED_AWAITING_ACCEPTANCE' : final.state === 'cancelled' ? 'CANCELLED' : phase?.phase || final.state.toUpperCase();
  const nextSafeAction = final.state === 'awaiting_acceptance' ? 'Owner reviews evidence and records Acceptance (accept or rework) in Control Center or Terminal.' : final.state === 'completed' ? 'None required for this Mission. Merge, installation and production remain separate owner-controlled actions.' : phase?.observing ? 'Wait; Airodrom is still executing or repairing within the approved scope.' : phase?.message || 'Owner inspects diagnostics; no automatic retry is pending.';
  return {
    schema_version: 1,
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
    acceptance_status: final.state === 'completed' ? 'accepted' : (detail.acceptance || []).length ? detail.acceptance[0].decision : 'owner_only_pending',
    settlement_status: detail.program_contract?.settlement?.state || null,
    unauthorized_changes: unauthorized,
    git: { pr_created: false, merged: false, installed: false, note: 'Coding workers never commit, push, merge or deploy; those remain owner actions.' },
    worker_summary_untrusted: (detail.results || []).map(r => r.result?.summary).filter(Boolean).slice(-1)[0] || null,
    answers: {
      what_was_requested: root.envelope.objective,
      what_changed: changedFiles.map(c => c.path),
      tests_passed: tests.length ? tests.every(t => t.status === 'passed') : null,
      security_passed: security.length ? security.every(s => ['passed', 'operator_review'].includes(s.status)) : null,
      repair_needed: repairs > 0,
      attempts: repairs + 1,
      original_goal_resumed: !!planId && (final.state === 'awaiting_acceptance' || final.state === 'completed'),
      unauthorized_changes: unauthorized.length > 0,
      pr_created: false, merged: false, installed: false,
      requires_owner: final.state === 'awaiting_acceptance' ? ['Acceptance'] : final.state === 'completed' ? [] : ['Inspect diagnostics'],
    },
    next_safe_action: nextSafeAction,
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
    for (const e of bridge.ledger.list({ missionId: item.mission_id, limit, order: 'asc' }).events) {
      events.push({ at: e.timestamp_ms, mission_id: item.mission_id, type: e.event_type, status: e.status || null, metadata: compactMetadata(e.metadata) });
    }
  }
  events.sort((a, b) => a.at - b.at);
  return { mission_id: id, lineage: lineage.map(l => l.mission_id), events: events.slice(-limit), authority: false };
}

function compactMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const keep = ['state', 'previous', 'reason', 'kind', 'provenance', 'agent_id', 'plan_id', 'stage_id', 'repair_mission_id', 'parent_mission_id', 'diagnosis', 'classification', 'attempt', 'max_repairs', 'approval_id', 'result', 'phase', 'tool', 'scope', 'path', 'exit_code', 'termination_verified', 'dispatch_path'];
  return Object.fromEntries(Object.entries(metadata).filter(([k]) => keep.includes(k)));
}

module.exports = { evidencePackage, missionEvents, lineageFor, planFor, PHASES };
