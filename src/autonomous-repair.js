'use strict';
// ADR 0048 addendum: one bounded corrective Mission after a safe verified-development failure.
// Never grants Acceptance/Settlement. Never retries uncertain execution. Never expands scope.
// ADR 0051: repair creation is idempotent (deterministic request keys derived from
// plan/stage/parent) and transactionally safe (create + rebind + lineage + claim +
// dispatch commit together or not at all). Transient blocks are retried on later
// ticks; permanent blocks are terminal and explained.
const { randomUUID, createHash } = require('node:crypto');
const { transaction } = require('./control-transaction');
const { classifyReason } = require('./recovery-phase');

// How long a transient block may keep a stage in REPAIR_PENDING before it becomes terminal.
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

function repairKey(planId, stageId, parentId) {
  return createHash('sha256').update([planId, stageId, parentId].join('|')).digest('hex').slice(0, 32);
}

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

function diagnose(mission, store, { attempt = 1, maxAttempts = null, previous = [] } = {}) {
  if (!mission || mission.state !== 'needs_rework') return { ok: false, reason: 'not_needs_rework' };
  if (['conversation', 'browser_research', 'work_request'].includes(mission.envelope?.kind)) {
    return { ok: false, reason: 'unsupported_kind' };
  }
  const checks = failedChecks(mission, store);
  if (!checks) return { ok: false, reason: 'no_host_verification_failure' };
  const run = lastRunSafe(mission, store);
  if (!run.ok) return run;
  // ADR 0051: precise host-built feedback (expected vs observed, failed check ids, remaining
  // budget) so the corrective worker does not have to guess what went wrong.
  const context = require('./repair-context').buildRepairContext(mission, { checks: checks.checks, attempt, maxAttempts, remaining: maxAttempts === null ? null : Math.max(0, maxAttempts - attempt), previous });
  // Put the parent id in the first 180 chars so project_missions UNIQUE(goal_id, name)
  // cannot collide when several controlled failures share the same Goal.
  const original = String(mission.envelope.objective || '').replace(/^Repair \[[0-9a-f]{8}\][\s\S]*?Original objective: /, '').slice(0, 1000);
  return {
    ok: true,
    summary: checks.summary,
    checks: checks.checks,
    run_id: run.run.id,
    context: context.record,
    objective: 'Repair [' + String(mission.id).slice(0, 8) + '] failed verification (' + checks.summary + '). Restore the original approved outcome.\n' + context.text + '\nOriginal objective: ' + original,
  };
}

function sameScope(parent, candidate) {
  const a = parent.envelope, b = candidate;
  if (a.workspace !== b.workspace) return false;
  if (JSON.stringify([...(a.allowed_files || [])].sort()) !== JSON.stringify([...(b.allowed_files || [])].sort())) return false;
  if ((a.preferred_agent || 'host') !== (b.preferred_agent || 'host')) return false;
  if (JSON.stringify(a.capability_scopes || []) !== JSON.stringify(b.capability_scopes || [])) return false;
  const privacy = a.dispatch_policy?.privacy || 'local_only';
  if ((b.dispatch_policy?.privacy || privacy) !== privacy) return false;
  // Non-local privacy is only ever in scope when the parent contract explicitly authorizes
  // external disclosure to that worker (ADR 0051); otherwise repairs stay local-only.
  if (privacy !== 'local_only' && !(a.contract?.permissions?.external_disclosure?.authorized && a.contract.permissions.external_disclosure.providers.includes(a.preferred_agent))) return false;
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

function repairAuthority(env, now = Date.now()) {
  const a = env.authority;
  if (!a || typeof a !== 'object') return undefined;
  // Envelope authority includes normalized version/label; create() rejects those extras.
  let expiresAt = a.expiresAt;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 24 * 60 * 60 * 1000) {
    expiresAt = now + 60 * 60 * 1000;
  }
  return {
    level: a.level,
    permissions: a.permissions,
    filesystem: a.filesystem,
    expiresAt,
  };
}

function repairInput(parent, diagnosis, { request_id } = {}) {
  const env = parent.envelope;
  const criteria = env.criteria || [];
  const native = criteria.filter(c => c.type === 'exact_file').map(c => ({ name: 'file_write', path: c.path, content: c.content }));
  const dispatch = env.dispatch_policy ? {
    ...env.dispatch_policy,
    ...(env.task_type === 'local_files' && native.length ? { native_actions: native } : {}),
  } : undefined;
  const manifest = repairManifest(env);
  const authority = repairAuthority(env);
  return {
    request_id: request_id || ('cae-repair:' + randomUUID()),
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
    ...(authority ? { authority } : {}),
    ...(manifest ? { manifest } : {}),
    // Do not rebind work_template: assertInput fingerprints the live template ceiling,
    // which diverges from a failed parent (expiresAt, normalized manifest, dispatch).
    // Same-scope repair_of already locks workspace and allowed_files.
    ...(env.model ? { model: env.model } : {}),
    // ADR 0051: the corrective Mission carries the parent's immutable contract and
    // approval reference; only the per-Mission identity (request_id, repair_of) differs.
    ...(env.contract ? { contract: env.contract } : {}),
    ...(env.approval_id ? { approval_id: env.approval_id } : {}),
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
    const blocked = autonomous.repair_blocked?.[stage.id];
    // Permanent blocks are terminal. Transient blocks (writer lease, unreconciled
    // dispatch, name collision) are re-evaluated below on every tick until timeout.
    if (blocked && classifyReason(blocked).kind !== 'transient') return { ok: false, reason: blocked };
    const lineage = autonomous.repair_lineage?.[stage.id] || null;
    // Exactly one corrective Mission per failed parent. A corrective Mission that itself
    // fails may be repaired again only while the per-stage budget allows (chained lineage).
    if (lineage?.repair_mission_id && lineage.repair_mission_id !== failed.id) return { ok: false, reason: 'repair_already_spawned' };
    const preferred = failed.envelope.preferred_agent || 'host';
    if (!autonomous.workers.includes(preferred)) return { ok: false, reason: 'worker_not_authorized' };
    if (failed.envelope.dispatch_policy?.privacy && failed.envelope.dispatch_policy.privacy !== 'local_only') {
      // External disclosure is only permitted when the Mission contract records it explicitly.
      if (!failed.envelope.contract?.permissions?.external_disclosure?.authorized) return { ok: false, reason: 'external_disclosure_unauthorized' };
      if (!failed.envelope.approval_id) return { ok: false, reason: 'privacy_not_local' };
    }
    const pending = autonomous.repair_pending?.[stage.id];
    if (pending && this.store.now() - pending.since >= PENDING_TIMEOUT_MS) return { ok: false, reason: 'repair_pending_timeout' };
    const classified = require('./failure-classifier').classifyMission(failed, this.store);
    if (classified.policy !== 'repair') return { ok: false, reason: classified.reason || 'failure_not_repairable' };
    const diagnosis = diagnose(failed, this.store, { attempt: repairs + 1, maxAttempts: autonomous.max_repairs, previous: (autonomous.repair_history || []).filter(h => h.stage_id === stage.id) });
    if (!diagnosis.ok) return diagnosis;
    const approvals = this.bridge.missionApprovals;
    if (approvals) {
      const check = approvals.allowRepair(failed, { repairs });
      if (!check.ok) return { ok: false, reason: check.reason };
      diagnosis.approval_id = check.approval.approval_id;
    }
    const loop = require('./failure-classifier').repeatedSignature(this.store, failed, autonomous, stage.id);
    if (loop.repeated) return { ok: false, reason: 'repeated_failure_signature' };
    diagnosis.failure_signature = loop.signature;
    diagnosis.classification = classified.category;
    return { ok: true, diagnosis };
  }

  // Deterministic identities: the same (plan, stage, parent) can only ever produce one
  // corrective Mission regardless of how many ticks or restarts observe the failure.
  keys(planId, stageId, parentId) {
    const key = repairKey(planId, stageId, parentId);
    return {
      key,
      create: 'cae-repair:' + key,
      rebind: 'cae-rebind:' + key,
      dispatch: 'cae-repair-dispatch:' + key,
    };
  }

  spawn(planId, stage, failed, diagnosis) {
    const keys = this.keys(planId, stage.id, failed.id);
    const input = repairInput(failed, diagnosis, { request_id: keys.create });
    const created = this.bridge.missions.create(input, 'operator');
    if (created.duplicate) {
      // A prior transaction already created this exact corrective Mission (crash after commit).
      const existing = this.store.getMission(created.id);
      if (!existing || existing.envelope.repair_of !== failed.id) throw Error('repair_identity_conflict');
    }
    if (!sameScope(failed, {
      workspace: created.envelope.workspace,
      allowed_files: created.envelope.allowed_files,
      preferred_agent: created.envelope.preferred_agent,
      capability_scopes: created.envelope.capability_scopes,
      dispatch_policy: created.envelope.dispatch_policy,
    })) {
      // Inside the enclosing transaction this throw rolls the creation back entirely.
      throw Error('repair_scope_mismatch');
    }
    if (failed.envelope.contract && created.envelope.contract?.scope_fingerprint !== failed.envelope.contract.scope_fingerprint) {
      throw Error('repair_scope_mismatch');
    }
    this.bridge.missions.goalPlanner.rebindRepair(planId, stage.id, created.id, keys.rebind, {
      parent_mission_id: failed.id,
    });
    followZeroSetup(this.bridge, failed.id, created.id);
    return created;
  }

  recordBlocked(planId, stage, failed, reason, extra = {}) {
    const cls = classifyReason(reason);
    return transaction(this.db, () => {
      const row = this.execution.planRow(planId);
      const a = this.execution.readAutonomous(row);
      const now = this.store.now();
      a.repair_blocked = { ...(a.repair_blocked || {}), [stage.id]: reason };
      if (cls.kind === 'transient') {
        const since = a.repair_pending?.[stage.id]?.since || now;
        a.repair_pending = { ...(a.repair_pending || {}), [stage.id]: { since, reason, attempts: (a.repair_pending?.[stage.id]?.attempts || 0) + 1 } };
        a.last_action = 'repair_pending';
        a.lifecycle = 'recovering';
      } else {
        if (a.repair_pending?.[stage.id]) delete a.repair_pending[stage.id];
        a.last_action = 'repair_blocked';
        a.lifecycle = cls.kind === 'quarantine' ? 'quarantined' : 'recovering';
        // Permanent: the parent claim is abandoned so the scheduler stops re-examining it.
        this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=? AND mission_id=? AND state IN ('claimed','dispatched')").run(planId, failed.id);
      }
      this.execution.writeAutonomous(planId, a);
      this.store.event(cls.kind === 'transient' ? 'goal.autonomous.repair_pending' : 'goal.autonomous.repair_blocked', failed.id, {
        plan_id: planId, stage_id: stage.id, reason, kind: cls.kind, authority: false, ...extra,
      });
      return { action: cls.kind === 'transient' ? 'pending' : 'blocked', reason };
    });
  }

  handleFailure(planId, view, autonomous, claim, failed) {
    const stage = view.stages.find(s => s.mission_id === failed.id);
    if (!stage) {
      this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=? AND mission_id=? AND state IN ('claimed','dispatched')").run(planId, failed.id);
      return { action: 'abandoned' };
    }
    const gate = this.canSpawn(view, autonomous, stage, failed);
    if (!gate.ok) return this.recordBlocked(planId, stage, failed, gate.reason);
    const keys = this.keys(planId, stage.id, failed.id);
    try {
      // One unit of work: create + scope check + rebind + lineage + claim + dispatch.
      return transaction(this.db, () => {
        if (this.bridge.lifecycle && this.bridge.lifecycle.state() !== 'open') throw Error('admission_closed');
        // Fresh gates inside the transaction (another tick may have won the race).
        const freshView = this.execution.inspect(planId);
        const freshAutonomous = freshView.autonomous;
        const freshStage = freshView.stages.find(s => s.id === stage.id);
        if (!freshStage || freshStage.mission_id !== failed.id) throw Error('repair_already_spawned');
        const again = this.canSpawn(freshView, freshAutonomous, freshStage, this.store.requireMission(failed.id));
        if (!again.ok) throw Error(again.reason);
        const row = this.execution.planRow(planId);
        const a = this.execution.readAutonomous(row);
        // Reservation makes a REPAIR_CREATING phase observable if a reader races the commit.
        a.repair_reservations = { ...(a.repair_reservations || {}), [stage.id]: { parent_mission_id: failed.id, key: keys.key, at: this.store.now(), repair_mission_id: null } };
        this.execution.writeAutonomous(planId, a);
        const repair = this.spawn(planId, stage, failed, again.diagnosis);
        const next = this.execution.readAutonomous(this.execution.planRow(planId));
        next.repair_counts[stage.id] = (next.repair_counts[stage.id] || 0) + 1;
        next.repair_lineage = {
          ...(next.repair_lineage || {}),
          [stage.id]: {
            parent_mission_id: failed.id,
            repair_mission_id: repair.id,
            diagnosis: again.diagnosis.summary,
            context: again.diagnosis.context || null,
            failure_signature: again.diagnosis.failure_signature || null,
            classification: again.diagnosis.classification || null,
            approval_id: again.diagnosis.approval_id || null,
            attempt: next.repair_counts[stage.id],
            at: this.store.now(),
          },
        };
        next.repair_history = [...(next.repair_history || []), { stage_id: stage.id, parent_mission_id: failed.id, repair_mission_id: repair.id, at: this.store.now() }].slice(-20);
        if (again.diagnosis.failure_signature) {
          next.repair_signatures = { ...(next.repair_signatures || {}), [stage.id]: [...(next.repair_signatures?.[stage.id] || []), again.diagnosis.failure_signature].slice(-10) };
        }
        next.repair_reservations[stage.id] = { ...next.repair_reservations[stage.id], repair_mission_id: repair.id };
        if (next.repair_pending?.[stage.id]) delete next.repair_pending[stage.id];
        if (next.repair_blocked?.[stage.id]) delete next.repair_blocked[stage.id];
        next.last_action = 'repair_dispatched';
        next.lifecycle = 'recovering';
        next.progress_at = this.store.now();
        next.dispatch_count += 1;
        this.execution.writeAutonomous(planId, next);
        this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=? AND mission_id=? AND state IN ('claimed','dispatched')").run(planId, failed.id);
        this.db.prepare("DELETE FROM cp_autonomous_claims WHERE plan_id=? AND stage_id=? AND mission_id=? AND state IN ('abandoned','settled')")
          .run(planId, stage.id, repair.id);
        this.db.prepare('INSERT INTO cp_autonomous_claims VALUES(?,?,?,?,?,?)')
          .run(planId, stage.id, repair.id, keys.dispatch, 'claimed', this.store.now());
        const dispatch = this.bridge.missions.dispatch(repair.id, { request_id: keys.dispatch });
        this.db.prepare("UPDATE cp_autonomous_claims SET state='dispatched' WHERE request_id=?").run(keys.dispatch);
        this.store.event('goal.autonomous.repair_created', failed.id, {
          plan_id: planId, stage_id: stage.id, parent_mission_id: failed.id, repair_mission_id: repair.id,
          diagnosis: again.diagnosis.summary, classification: again.diagnosis.classification || null,
          attempt: next.repair_counts[stage.id], max_repairs: next.max_repairs, authority: false,
        });
        this.store.event('goal.autonomous.repair', failed.id, {
          plan_id: planId,
          stage_id: stage.id,
          parent_mission_id: failed.id,
          repair_mission_id: repair.id,
          diagnosis: again.diagnosis.summary,
          authority: false,
        });
        this.store.event('goal.autonomous.dispatched', repair.id, {
          plan_id: planId, stage_id: stage.id, request_id: keys.dispatch, repair: true, authority: false,
        });
        return { action: 'repaired', repair_mission_id: repair.id, dispatch };
      });
    } catch (error) {
      const message = String(error.message || '');
      let reason = 'repair_spawn_failed';
      if (/^[a-z_]+$/.test(message)) reason = message;
      else if (/UNIQUE constraint failed:\s*project_missions/i.test(message) || /unique.*project_missions\.name/i.test(message)) {
        reason = 'repair_mission_name_conflict';
      } else if (/Idempotency conflict/i.test(message)) reason = 'repair_identity_conflict';
      else if (/admission/i.test(message)) reason = 'admission_closed';
      if (reason === 'repair_already_spawned') {
        // Lost a benign race with another tick; nothing to record.
        return { action: 'skipped', reason };
      }
      return this.recordBlocked(planId, stage, failed, reason, { error_class: reason });
    }
  }
}

module.exports = { AutonomousRepair, diagnose, failedChecks, repairInput, repairAuthority, sameScope, repairKey, PENDING_TIMEOUT_MS };
