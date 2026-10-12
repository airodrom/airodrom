'use strict';
// ADR 0048 addendum: one bounded corrective Mission after a safe verified-development failure.
// Never grants Acceptance/Settlement. Never retries uncertain execution. Never expands scope.
const { randomUUID } = require('node:crypto');
const { transaction } = require('./control-transaction');

function failedChecks(mission, store) {
  const row = store.db.prepare('SELECT evidence, result FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
  if (!row || row.result !== 'failed') return null;
  let evidence = [];
  try { evidence = JSON.parse(row.evidence || '[]'); } catch { return null; }
  if (!Array.isArray(evidence) || !evidence.length) return null;
  const failed = evidence.filter(c => c && c.status === 'failed');
  if (!failed.length) return null;
  return { checks: failed, summary: failed.map(c => c.id).slice(0, 8).join(', ') };
}

function lastRunSafe(mission, store) {
  const run = store.db.prepare('SELECT * FROM cp_runs WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
  if (!run) return { ok: false, reason: 'missing_run' };
  if (run.termination_verified !== 1) return { ok: false, reason: 'unverified_termination' };
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)) return { ok: false, reason: 'run_not_terminal' };
  if (store.db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state IN ('queued','dispatching','running','unknown')").get(mission.id)) {
    return { ok: false, reason: 'unreconciled_dispatch' };
  }
  if (store.db.prepare("SELECT 1 FROM cp_leases WHERE mission_id=? AND state='quarantined'").get(mission.id)) {
    return { ok: false, reason: 'quarantined_lease' };
  }
  if (store.db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND mode='write' AND state IN ('held','quarantined')").get(mission.envelope.workspace)) {
    return { ok: false, reason: 'workspace_writer' };
  }
  return { ok: true, run };
}

function diagnose(mission, store) {
  if (!mission || mission.state !== 'needs_rework') return { ok: false, reason: 'not_needs_rework' };
  if (['conversation', 'browser_research', 'work_request'].includes(mission.envelope?.kind)) {
    return { ok: false, reason: 'unsupported_kind' };
  }
  const checks = failedChecks(mission, store);
  if (!checks) return { ok: false, reason: 'no_host_verification_failure' };
  const run = lastRunSafe(mission, store);
  if (!run.ok) return run;
  return {
    ok: true,
    summary: checks.summary,
    checks: checks.checks,
    run_id: run.run.id,
    objective: 'Repair failed verification (' + checks.summary + '). Restore the original approved outcome. Original objective: ' + String(mission.envelope.objective || '').slice(0, 1200),
  };
}

function sameScope(parent, candidate) {
  const a = parent.envelope, b = candidate;
  if (a.workspace !== b.workspace) return false;
  if (JSON.stringify([...(a.allowed_files || [])].sort()) !== JSON.stringify([...(b.allowed_files || [])].sort())) return false;
  if ((a.preferred_agent || 'host') !== (b.preferred_agent || 'host')) return false;
  if (JSON.stringify(a.capability_scopes || []) !== JSON.stringify(b.capability_scopes || [])) return false;
  if ((a.dispatch_policy?.privacy || 'local_only') !== 'local_only') return false;
  if ((b.dispatch_policy?.privacy || a.dispatch_policy?.privacy || 'local_only') !== 'local_only') return false;
  return true;
}

function repairManifest(env) {
  const m = env.manifest;
  if (!m || typeof m !== 'object') return undefined;
  // Envelope stores the normalized mission body; create() expects { mission }.
  const mission = {
    id: m.id,
    version: m.version,
    title: m.title,
    repository: { root: m.repository.root, branch: m.repository.branch },
    authority: { level: m.authority.level },
    duration: { ...m.duration },
    scope: {
      repositories: [...(m.scope.repositories || [])],
      include: [...(m.scope.include || [])],
      exclude: [...(m.scope.exclude || [])].filter(p => !['.git/**', '.runtime/**', 'secrets/**', 'production/**', '.env', '.env.*'].includes(p)),
    },
    permissions: JSON.parse(JSON.stringify(m.permissions)),
    evidence: {
      required: [...(m.evidence.required || [])],
      optional: [...(m.evidence.optional || [])],
    },
    settlement: { ...m.settlement },
    budget: { ...m.budget },
  };
  return { mission };
}

function repairInput(parent, diagnosis) {
  const env = parent.envelope;
  const criteria = env.criteria || [];
  const native = criteria.filter(c => c.type === 'exact_file').map(c => ({ name: 'file_write', path: c.path, content: c.content }));
  const dispatch = env.dispatch_policy ? {
    ...env.dispatch_policy,
    ...(env.task_type === 'local_files' && native.length ? { native_actions: native } : {}),
  } : undefined;
  const manifest = repairManifest(env);
  return {
    request_id: 'cae-repair:' + randomUUID(),
    project_id: parent.project_id,
    goal_id: parent.goal_id,
    objective: diagnosis.objective,
    workspace: env.workspace,
    allowed_files: [...env.allowed_files],
    criteria: criteria.map(c => ({ ...c })),
    verification: { ...env.verification, tests: [...(env.verification?.tests || [])], syntax: [...(env.verification?.syntax || [])] },
    preferred_agent: env.preferred_agent,
    fallback_agents: [...(env.fallback_agents || [])],
    capability_scopes: [...(env.capability_scopes || [])],
    ...(typeof env.constraints === 'string' && env.constraints.trim() ? { constraints: env.constraints } : {}),
    ...(Number.isInteger(env.priority) ? { priority: env.priority } : {}),
    task_type: env.task_type,
    ...(dispatch ? { dispatch_policy: dispatch } : {}),
    ...(env.authority ? { authority: env.authority } : {}),
    ...(manifest ? { manifest } : {}),
    ...(env.work_template ? { work_template: env.work_template } : {}),
    ...(env.model ? { model: env.model } : {}),
    repair_of: parent.id,
  };
}

function followZeroSetup(bridge, parentId, repairId) {
  const db = bridge.controlStore.db;
  let rows = [];
  try {
    rows = db.prepare('SELECT request_id, record, principal, state FROM cp_zero_setup_requests').all();
  } catch { return; }
  for (const row of rows) {
    let record;
    try { record = JSON.parse(row.record); } catch { continue; }
    if (record.mission_id !== parentId) continue;
    record.mission_id = repairId;
    record.repair_of = parentId;
    record.presentation = {
      ...(record.presentation || {}),
      status: 'Repairing failed verification',
    };
    db.prepare('UPDATE cp_zero_setup_requests SET record=?, state=?, updated_at=? WHERE request_id=?')
      .run(JSON.stringify(record), 'running', Date.now(), row.request_id);
  }
}

class AutonomousRepair {
  constructor(execution) {
    this.execution = execution;
    this.bridge = execution.bridge;
    this.store = execution.store;
    this.db = execution.db;
  }

  canSpawn(view, autonomous, stage, failed) {
    if (!autonomous.enabled || autonomous.paused) return { ok: false, reason: 'not_enabled' };
    if (this.store.now() >= view.expires_at) return { ok: false, reason: 'budget_expired' };
    if (autonomous.dispatch_count >= autonomous.max_dispatches) return { ok: false, reason: 'dispatch_budget' };
    const repairs = autonomous.repair_counts[stage.id] || 0;
    if (repairs >= autonomous.max_repairs) return { ok: false, reason: 'repair_budget' };
    if (autonomous.repair_blocked?.[stage.id]) return { ok: false, reason: autonomous.repair_blocked[stage.id] };
    if (autonomous.repair_lineage?.[stage.id]?.repair_mission_id) return { ok: false, reason: 'repair_already_spawned' };
    const preferred = failed.envelope.preferred_agent || 'host';
    if (!autonomous.workers.includes(preferred)) return { ok: false, reason: 'worker_not_authorized' };
    if (failed.envelope.dispatch_policy?.privacy && failed.envelope.dispatch_policy.privacy !== 'local_only') {
      return { ok: false, reason: 'privacy_not_local' };
    }
    const diagnosis = diagnose(failed, this.store);
    if (!diagnosis.ok) return diagnosis;
    return { ok: true, diagnosis };
  }

  spawn(planId, stage, failed, diagnosis) {
    const input = repairInput(failed, diagnosis);
    const created = this.bridge.missions.create(input, 'operator');
    if (!sameScope(failed, {
      workspace: created.envelope.workspace,
      allowed_files: created.envelope.allowed_files,
      preferred_agent: created.envelope.preferred_agent,
      capability_scopes: created.envelope.capability_scopes,
      dispatch_policy: created.envelope.dispatch_policy,
    })) {
      try { this.bridge.missions.cancel(created.id, { request_id: 'cae-repair-scope:' + created.id }); } catch { /* best effort */ }
      throw Error('repair_scope_mismatch');
    }
    this.bridge.missions.goalPlanner.rebindRepair(planId, stage.id, created.id, 'cae-rebind:' + randomUUID(), {
      parent_mission_id: failed.id,
    });
    followZeroSetup(this.bridge, failed.id, created.id);
    return created;
  }

  handleFailure(planId, view, autonomous, claim, failed) {
    const stage = view.stages.find(s => s.mission_id === failed.id);
    if (!stage) {
      this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=? AND mission_id=? AND state IN ('claimed','dispatched')").run(planId, failed.id);
      return { action: 'abandoned' };
    }
    const gate = this.canSpawn(view, autonomous, stage, failed);
    if (!gate.ok) {
      return transaction(this.db, () => {
        const row = this.execution.planRow(planId);
        const a = this.execution.readAutonomous(row);
        a.repair_blocked = { ...(a.repair_blocked || {}), [stage.id]: gate.reason };
        a.last_action = 'repair_blocked';
        a.lifecycle = 'recovering';
        this.execution.writeAutonomous(planId, a);
        this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=? AND mission_id=? AND state IN ('claimed','dispatched')").run(planId, failed.id);
        this.store.event('goal.autonomous.repair_blocked', failed.id, {
          plan_id: planId, stage_id: stage.id, reason: gate.reason, authority: false,
        });
        return { action: 'blocked', reason: gate.reason };
      });
    }
    let repair;
    try {
      repair = this.spawn(planId, stage, failed, gate.diagnosis);
    } catch (error) {
      return transaction(this.db, () => {
        const row = this.execution.planRow(planId);
        const a = this.execution.readAutonomous(row);
        const reason = /^[a-z_]+$/.test(error.message) ? error.message : 'repair_spawn_failed';
        a.repair_blocked = { ...(a.repair_blocked || {}), [stage.id]: reason };
        a.last_action = 'repair_blocked';
        this.execution.writeAutonomous(planId, a);
        this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=? AND mission_id=? AND state IN ('claimed','dispatched')").run(planId, failed.id);
        this.store.event('goal.autonomous.repair_blocked', failed.id, {
          plan_id: planId, stage_id: stage.id, reason, error_class: reason, authority: false,
        });
        return { action: 'blocked', reason };
      });
    }
    const requestId = 'cae-repair-dispatch:' + randomUUID();
    return transaction(this.db, () => {
      const row = this.execution.planRow(planId);
      const a = this.execution.readAutonomous(row);
      a.repair_counts[stage.id] = (a.repair_counts[stage.id] || 0) + 1;
      a.repair_lineage = {
        ...(a.repair_lineage || {}),
        [stage.id]: {
          parent_mission_id: failed.id,
          repair_mission_id: repair.id,
          diagnosis: gate.diagnosis.summary,
          at: this.store.now(),
        },
      };
      a.last_action = 'repair_dispatched';
      a.lifecycle = 'recovering';
      a.progress_at = this.store.now();
      a.dispatch_count += 1;
      this.execution.writeAutonomous(planId, a);
      this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=? AND mission_id=? AND state IN ('claimed','dispatched')").run(planId, failed.id);
      this.db.prepare("DELETE FROM cp_autonomous_claims WHERE plan_id=? AND stage_id=? AND mission_id=? AND state IN ('abandoned','settled')")
        .run(planId, stage.id, repair.id);
      this.db.prepare('INSERT INTO cp_autonomous_claims VALUES(?,?,?,?,?,?)')
        .run(planId, stage.id, repair.id, requestId, 'claimed', this.store.now());
      const dispatch = this.bridge.missions.dispatch(repair.id, { request_id: requestId });
      this.db.prepare("UPDATE cp_autonomous_claims SET state='dispatched' WHERE request_id=?").run(requestId);
      this.store.event('goal.autonomous.repair', failed.id, {
        plan_id: planId,
        stage_id: stage.id,
        parent_mission_id: failed.id,
        repair_mission_id: repair.id,
        diagnosis: gate.diagnosis.summary,
        authority: false,
      });
      this.store.event('goal.autonomous.dispatched', repair.id, {
        plan_id: planId, stage_id: stage.id, request_id: requestId, repair: true, authority: false,
      });
      return { action: 'repaired', repair_mission_id: repair.id, dispatch };
    });
  }
}

module.exports = { AutonomousRepair, diagnose, failedChecks, repairInput, sameScope };
