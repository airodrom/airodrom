'use strict';
// ADR 0048. Continuous Autonomous Execution V1 — durable scheduler over Goal Plans.
// Dispatches only through MissionService.dispatch. Never grants Acceptance or
// Production mutation authority. Chat/Cursor clients are not the execution owner.
const { randomUUID } = require('node:crypto');
const { transaction } = require('./control-transaction');
const { object, identifier } = require('./control-plane-store');

const WORKERS = new Set(['host', 'opencode', 'claude_code', 'codex', 'cursor']);
const LIFECYCLE = new Set([
  'created', 'validating', 'ready', 'running', 'waiting_dependency', 'waiting_approval',
  'recovering', 'verifying', 'completed', 'failed', 'cancelled', 'quarantined'
]);
const { stagePhase } = require('./recovery-phase');

function defaultAutonomous() {
  return {
    version: 1,
    enabled: false,
    paused: false,
    workers: ['host', 'opencode'],
    max_concurrent_missions: 1,
    max_dispatches: 40,
    max_repairs: 3,
    dispatch_count: 0,
    repair_counts: {},
    repair_lineage: {},
    repair_blocked: {},
    repair_pending: {},
    repair_reservations: {},
    repair_signatures: {},
    repair_history: [],
    worker_history: [],
    progress_at: null,
    last_action: null,
    lifecycle: 'created',
    authorized_at: null,
    production_mutation: false,
    client_independent: true
  };
}

class AutonomousExecution {
  constructor(bridge) {
    this.bridge = bridge;
    this.store = bridge.controlStore;
    this.db = this.store.db;
    this.busy = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_autonomous_claims(
      plan_id TEXT NOT NULL, stage_id TEXT NOT NULL, mission_id TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('claimed','dispatched','settled','abandoned')),
      created_at INTEGER NOT NULL, PRIMARY KEY(plan_id, stage_id, mission_id))`);
  }

  planner() { return this.bridge.missions.goalPlanner; }

  planRow(id, owner = 'operator') { return this.planner().row(id, owner); }

  readAutonomous(row) {
    const a = { ...defaultAutonomous(), ...(row.plan.autonomous || {}) };
    if (a.version !== 1) throw Error('Unsupported autonomous execution schema');
    if (!LIFECYCLE.has(a.lifecycle)) a.lifecycle = 'ready';
    return a;
  }

  writeAutonomous(id, autonomous) {
    const row = this.planRow(id);
    row.plan.autonomous = autonomous;
    this.db.prepare('UPDATE cp_mission_programs SET goal_plan=? WHERE id=?').run(JSON.stringify(row.plan), id);
  }

  deriveLifecycle(view, autonomous, phases = {}) {
    if (view.state === 'cancelled' || autonomous.paused && !autonomous.enabled) return 'cancelled';
    if (view.state === 'completed') return 'completed';
    if (autonomous.paused) return 'waiting_approval';
    if (!autonomous.enabled) return view.ready.length ? 'ready' : 'created';
    if (view.stages.some(s => s.reason === 'uncertain_execution')) return 'quarantined';
    if (Object.values(phases).some(p => p.phase === 'QUARANTINED')) return 'quarantined';
    if (view.stages.some(s => s.state === 'waiting_approval')) return 'waiting_approval';
    if (view.stages.some(s => s.state === 'active')) return 'running';
    if (view.stages.some(s => s.reason === 'dependency_unverified')) return 'waiting_dependency';
    const recovering = view.stages.filter(s => s.state === 'blocked' && s.reason === 'explicit_mission_recovery_required');
    if (recovering.length) {
      // A failed parent is only "recovering" while repair is pending or possible. Permanent
      // blocks are failed, not perpetually recovering.
      if (recovering.some(s => !phases[s.id] || !['REPAIR_BLOCKED', 'FAILED_TERMINAL', 'WAITING_OWNER'].includes(phases[s.id].phase))) return 'recovering';
      return 'failed';
    }
    if (view.ready.length) return 'running';
    if (view.blocked.length) return 'failed';
    return 'ready';
  }

  /** Derived recovery phase per stage. Observational only; never grants authority. */
  phases(view, autonomous) {
    const out = {};
    for (const stage of view.stages) {
      const mission = stage.mission_id ? this.store.getMission(stage.mission_id) : null;
      const lineage = autonomous.repair_lineage?.[stage.id] || null;
      const repair = lineage?.repair_mission_id && lineage.repair_mission_id !== stage.mission_id ? this.store.getMission(lineage.repair_mission_id) : null;
      const quarantined = mission ? !!(this.db.prepare("SELECT 1 FROM cp_leases WHERE mission_id=? AND state='quarantined'").get(mission.id)
        || this.db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state='unknown'").get(mission.id)) : false;
      const phase = stagePhase({ mission, autonomous, stageId: stage.id, repair, quarantined });
      out[stage.id] = {
        ...phase,
        stage_id: stage.id,
        mission_id: repair?.id || mission?.id || null,
        parent_mission_id: lineage?.parent_mission_id || (mission?.envelope?.repair_of) || null,
        repair_attempt: autonomous.repair_counts?.[stage.id] || 0,
        max_repairs: autonomous.max_repairs,
      };
    }
    return out;
  }

  inspect(id, owner = 'operator') {
    const view = this.planner().inspect(id, owner);
    const row = this.planRow(id, owner);
    const autonomous = this.readAutonomous(row);
    const claims = this.db.prepare('SELECT * FROM cp_autonomous_claims WHERE plan_id=? ORDER BY created_at').all(id);
    const phases = this.phases(view, autonomous);
    const lifecycle = this.deriveLifecycle(view, autonomous, phases);
    return {
      ...view,
      execution_enabled: autonomous.enabled === true && autonomous.paused !== true,
      autonomous: {
        ...autonomous,
        lifecycle,
        phases,
        claims: claims.map(c => ({ stage_id: c.stage_id, mission_id: c.mission_id, state: c.state, request_id: c.request_id })),
        next_eligible: view.ready.slice(0, autonomous.max_concurrent_missions),
        production_mutation: false,
        authority: false
      }
    };
  }

  list(limit = 50) {
    return this.db.prepare('SELECT id FROM cp_mission_programs WHERE goal_plan IS NOT NULL ORDER BY started_at DESC LIMIT ?')
      .all(limit).map(r => this.inspect(r.id));
  }

  authorize(id, input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required');
    object(input, ['request_id', 'workers', 'max_concurrent_missions', 'max_dispatches', 'max_repairs', 'confirmed']);
    identifier(input.request_id);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required for autonomous execution');
    if (!Array.isArray(input.workers) || !input.workers.length || input.workers.length > 4 || input.workers.some(w => !WORKERS.has(w))) {
      throw Error('Authorized worker allowlist required');
    }
    for (const key of ['max_concurrent_missions', 'max_dispatches', 'max_repairs']) {
      if (!Number.isSafeInteger(input[key]) || input[key] < 1) throw Error('Invalid autonomous budget');
    }
    if (input.max_concurrent_missions > 3 || input.max_dispatches > 100 || input.max_repairs > 10) throw Error('Autonomous budget exceeds V1 ceiling');
    return this.store.request(owner, input.request_id, { op: 'autonomous_authorize', id, workers: input.workers }, () => {
      const row = this.planRow(id, owner);
      if (row.state !== 'goal_observing') throw Error('Cancelled goal plan');
      if (this.store.now() >= row.expires_at) throw Error('Goal plan expired');
      const autonomous = this.readAutonomous(row);
      autonomous.enabled = true;
      autonomous.paused = false;
      autonomous.workers = [...input.workers];
      autonomous.max_concurrent_missions = input.max_concurrent_missions;
      autonomous.max_dispatches = input.max_dispatches;
      autonomous.max_repairs = input.max_repairs;
      autonomous.authorized_at = this.store.now();
      autonomous.lifecycle = 'ready';
      autonomous.progress_at = this.store.now();
      autonomous.last_action = 'authorized';
      autonomous.production_mutation = false;
      autonomous.client_independent = true;
      delete autonomous.pending_request;
      this.writeAutonomous(id, autonomous);
      this.store.event('goal.autonomous.authorized', null, {
        plan_id: id, workers: autonomous.workers, max_concurrent_missions: autonomous.max_concurrent_missions, authority: false
      });
      return this.inspect(id, owner);
    });
  }

  pause(id, requestId, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required');
    identifier(requestId);
    return this.store.request(owner, requestId, { op: 'autonomous_pause', id }, () => {
      const autonomous = this.readAutonomous(this.planRow(id, owner));
      autonomous.paused = true;
      autonomous.last_action = 'paused';
      autonomous.lifecycle = 'waiting_approval';
      this.writeAutonomous(id, autonomous);
      this.store.event('goal.autonomous.paused', null, { plan_id: id, authority: false });
      return this.inspect(id, owner);
    });
  }

  resume(id, requestId, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required');
    identifier(requestId);
    return this.store.request(owner, requestId, { op: 'autonomous_resume', id }, () => {
      const autonomous = this.readAutonomous(this.planRow(id, owner));
      if (!autonomous.enabled) throw Error('Autonomous execution is not authorized');
      autonomous.paused = false;
      autonomous.last_action = 'resumed';
      autonomous.progress_at = this.store.now();
      this.writeAutonomous(id, autonomous);
      this.store.event('goal.autonomous.resumed', null, { plan_id: id, authority: false });
      this.bridge.missions?.schedule();
      return this.inspect(id, owner);
    });
  }

  stop(id, requestId, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required');
    identifier(requestId);
    return this.store.request(owner, requestId, { op: 'autonomous_stop', id }, () => {
      const autonomous = this.readAutonomous(this.planRow(id, owner));
      autonomous.enabled = false;
      autonomous.paused = true;
      autonomous.last_action = 'stopped_scheduling';
      autonomous.lifecycle = 'cancelled';
      this.writeAutonomous(id, autonomous);
      this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=? AND state IN ('claimed','dispatched')").run(id);
      this.store.event('goal.autonomous.stopped', null, { plan_id: id, authority: false });
      return this.inspect(id, owner);
    });
  }

  switchWorker(id, input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required');
    object(input, ['request_id', 'from_worker', 'to_worker', 'confirmed']);
    identifier(input.request_id);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required for worker switch');
    if (!WORKERS.has(input.from_worker) || !WORKERS.has(input.to_worker)) throw Error('Unknown worker');
    return this.store.request(owner, input.request_id, { op: 'autonomous_switch_worker', id, ...input }, () => {
      const autonomous = this.readAutonomous(this.planRow(id, owner));
      if (!autonomous.enabled) throw Error('Autonomous execution is not authorized');
      if (!autonomous.workers.includes(input.to_worker)) throw Error('Replacement worker is not authorized');
      if (this.db.prepare("SELECT 1 FROM cp_leases WHERE state IN ('held','quarantined') LIMIT 1").get()) {
        throw Error('Active or quarantined writer lease blocks worker switch');
      }
      if (this.db.prepare("SELECT 1 FROM cp_dispatches WHERE state IN ('dispatching','running','unknown') LIMIT 1").get()) {
        throw Error('Uncertain or active dispatch blocks worker switch');
      }
      if (this.db.prepare("SELECT 1 FROM cp_runs WHERE termination_verified=0 AND state NOT IN ('completed','failed','cancelled','interrupted') LIMIT 1").get()) {
        throw Error('Unverified prior execution blocks worker switch');
      }
      autonomous.worker_history.push({
        from: input.from_worker, to: input.to_worker, at: this.store.now(), request_id: input.request_id
      });
      if (!autonomous.workers.includes(input.to_worker)) autonomous.workers.push(input.to_worker);
      autonomous.last_action = 'worker_switched';
      autonomous.progress_at = this.store.now();
      this.writeAutonomous(id, autonomous);
      this.store.event('goal.autonomous.worker_switched', null, {
        plan_id: id, from_worker: input.from_worker, to_worker: input.to_worker, authority: false
      });
      return this.inspect(id, owner);
    });
  }

  eligibleStage(view, autonomous, stage) {
    if (!autonomous.enabled || autonomous.paused) return { ok: false, reason: 'not_enabled' };
    if (this.store.now() >= view.expires_at) return { ok: false, reason: 'budget_expired' };
    if (autonomous.dispatch_count >= autonomous.max_dispatches) return { ok: false, reason: 'dispatch_budget' };
    if (stage.state !== 'ready' || !stage.mission_id) return { ok: false, reason: stage.reason || stage.state };
    const mission = this.store.requireMission(stage.mission_id);
    if (mission.state !== 'ready') return { ok: false, reason: 'mission_not_ready' };
    const preferred = mission.envelope.preferred_agent || 'host';
    if (!autonomous.workers.includes(preferred)) return { ok: false, reason: 'worker_not_authorized' };
    if (this.db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND mode='write' AND state IN ('held','quarantined')").get(mission.envelope.workspace)) {
      return { ok: false, reason: 'workspace_writer' };
    }
    if (this.db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state IN ('queued','dispatching','running','unknown')").get(mission.id)) {
      return { ok: false, reason: 'unreconciled_dispatch' };
    }
    if (this.db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND termination_verified=0 AND state NOT IN ('completed','failed','cancelled','interrupted')").get(mission.id)) {
      return { ok: false, reason: 'unverified_execution' };
    }
    const repairs = autonomous.repair_counts[stage.id] || 0;
    if (repairs >= autonomous.max_repairs) return { ok: false, reason: 'repair_budget' };
    const prior = this.db.prepare('SELECT state FROM cp_autonomous_claims WHERE plan_id=? AND stage_id=? AND mission_id=?').get(view.id, stage.id, mission.id);
    if (prior && prior.state !== 'abandoned' && prior.state !== 'settled') return { ok: false, reason: 'already_claimed' };
    return { ok: true, mission };
  }

  async tick() {
    if (this.busy || this.bridge.closed) return;
    if (this.bridge.lifecycle && this.bridge.lifecycle.state() !== 'open') return;
    this.busy = true;
    try {
      const plans = this.db.prepare("SELECT id FROM cp_mission_programs WHERE goal_plan IS NOT NULL AND state='goal_observing' ORDER BY started_at").all();
      let dispatched = 0;
      const globalActive = this.db.prepare("SELECT count(*) n FROM cp_autonomous_claims WHERE state IN ('claimed','dispatched')").get().n;
      for (const { id } of plans) {
        let view;
        try { view = this.inspect(id); } catch { continue; }
        const autonomous = view.autonomous;
        if (!autonomous.enabled || autonomous.paused) continue;
        if (['completed', 'cancelled', 'quarantined'].includes(autonomous.lifecycle)) continue;
        // Settle finished claims.
        for (const claim of autonomous.claims.filter(c => c.state === 'dispatched' || c.state === 'claimed')) {
          const m = this.store.getMission(claim.mission_id);
          if (!m) continue;
          if (['completed', 'cancelled'].includes(m.state) || this.planner().verified(m.id)) {
            this.db.prepare("UPDATE cp_autonomous_claims SET state='settled' WHERE plan_id=? AND mission_id=? AND state IN ('claimed','dispatched')").run(id, m.id);
          } else if (m.state === 'needs_rework') {
            // One in-scope corrective Mission when termination is verified and budgets allow.
            // 'pending' keeps the claim so a later tick re-evaluates a transient block.
            const repair = this.repair || (this.repair = new (require('./autonomous-repair').AutonomousRepair)(this));
            const outcome = repair.handleFailure(id, view, autonomous, claim, m);
            if (outcome?.action === 'repaired') dispatched += 1;
          } else if (m.state === 'blocked') {
            const row = this.planRow(id);
            const a = this.readAutonomous(row);
            a.last_action = 'blocked_hold';
            this.writeAutonomous(id, a);
            this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE plan_id=? AND mission_id=? AND state IN ('claimed','dispatched')").run(id, m.id);
            this.store.event('goal.autonomous.blocked', m.id, { plan_id: id, reason: m.reason || 'blocked', authority: false });
          }
        }
        view = this.inspect(id);
        const activeForPlan = view.autonomous.claims.filter(c => ['claimed', 'dispatched'].includes(c.state)).length;
        const capacity = Math.max(0, view.autonomous.max_concurrent_missions - activeForPlan);
        if (!capacity || globalActive + dispatched >= 6) continue;
        for (const stageId of view.ready.slice(0, capacity)) {
          const stage = view.stages.find(s => s.id === stageId);
          const gate = this.eligibleStage(view, view.autonomous, stage);
          if (!gate.ok) {
            this.store.event('goal.autonomous.blocked', stage.mission_id || null, {
              plan_id: id, stage_id: stageId, reason: gate.reason, authority: false
            });
            continue;
          }
          const requestId = `cae:${randomUUID()}`;
          try {
            const result = transaction(this.db, () => {
              // Fresh gates inside the transaction.
              const fresh = this.inspect(id);
              const st = fresh.stages.find(s => s.id === stageId);
              const again = this.eligibleStage(fresh, fresh.autonomous, st);
              if (!again.ok) return { skipped: true, reason: again.reason };
              if (this.bridge.lifecycle.state() !== 'open') throw Error('Service admission is closed for maintenance');
              this.db.prepare("DELETE FROM cp_autonomous_claims WHERE plan_id=? AND stage_id=? AND mission_id=? AND state IN ('abandoned','settled')")
                .run(id, stageId, again.mission.id);
              this.db.prepare("INSERT INTO cp_autonomous_claims VALUES(?,?,?,?,?,?)")
                .run(id, stageId, again.mission.id, requestId, 'claimed', this.store.now());
              const dispatch = this.bridge.missions.dispatch(again.mission.id, { request_id: requestId });
              this.db.prepare("UPDATE cp_autonomous_claims SET state='dispatched' WHERE request_id=?").run(requestId);
              const row = this.planRow(id);
              const a = this.readAutonomous(row);
              a.dispatch_count += 1;
              a.progress_at = this.store.now();
              a.last_action = 'dispatched';
              a.lifecycle = 'running';
              this.writeAutonomous(id, a);
              this.store.event('goal.autonomous.dispatched', again.mission.id, {
                plan_id: id, stage_id: stageId, request_id: requestId, authority: false
              });
              return { skipped: false, dispatch };
            });
            if (!result.skipped) dispatched += 1;
          } catch (error) {
            this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE request_id=?").run(requestId);
            this.store.event('goal.autonomous.dispatch_failed', null, {
              plan_id: id, stage_id: stageId, error_class: /^[a-z_]+$/.test(error.message) ? error.message : 'dispatch_failed', authority: false
            });
          }
        }
      }
      return { dispatched };
    } finally {
      this.busy = false;
    }
  }

  recover() {
    // On restart: abandon only claims whose Missions never left ready without a
    // dispatch row; never invent termination. Uncertain Missions stay claimed for inspect.
    for (const claim of this.db.prepare("SELECT * FROM cp_autonomous_claims WHERE state IN ('claimed','dispatched')").all()) {
      const m = this.store.getMission(claim.mission_id);
      if (!m) {
        this.db.prepare("UPDATE cp_autonomous_claims SET state='abandoned' WHERE request_id=?").run(claim.request_id);
        continue;
      }
      if (this.planner().verified(m.id) || m.state === 'completed') {
        this.db.prepare("UPDATE cp_autonomous_claims SET state='settled' WHERE request_id=?").run(claim.request_id);
      }
    }
    for (const { id } of this.db.prepare("SELECT id FROM cp_mission_programs WHERE goal_plan IS NOT NULL").all()) {
      try {
        const row = this.planRow(id);
        const a = this.readAutonomous(row);
        if (!a.enabled) continue;
        a.last_action = 'recovered';
        a.progress_at = this.store.now();
        a.lifecycle = this.deriveLifecycle(this.planner().inspect(id), a);
        this.writeAutonomous(id, a);
        this.store.event('goal.autonomous.recovered', null, { plan_id: id, lifecycle: a.lifecycle, authority: false });
      } catch { /* plan unavailable */ }
    }
  }
}

module.exports = { AutonomousExecution, defaultAutonomous, WORKERS, LIFECYCLE };
