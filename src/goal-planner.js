'use strict';
// ADR 0047. Planning is a projection over existing Goals and Mission Programs.
// No scheduler, worker, grant issuer or Acceptance implementation lives here.
const { randomUUID } = require('node:crypto');
const { object, identifier, text, fingerprint, transaction } = require('./control-plane-store');
const MAX_STAGES = 40;
function graphOrder(stages) {
  if (!Array.isArray(stages) || !stages.length || stages.length > MAX_STAGES) throw Error('Invalid goal milestones');
  const nodes = new Map();
  for (const s of stages) {
    identifier(s.id);
    if (nodes.has(s.id) || !Array.isArray(s.depends_on) || new Set(s.depends_on).size !== s.depends_on.length) throw Error('Duplicate goal milestone or dependency');
    nodes.set(s.id, s);
  }
  const seen = new Set(), active = new Set(), order = [];
  function visit(id) {
    identifier(id);
    if (active.has(id)) throw Error('Goal dependency cycle');
    if (seen.has(id)) return;
    const stage = nodes.get(id); if (!stage) throw Error('Missing goal dependency');
    active.add(id); stage.depends_on.forEach(visit); active.delete(id); seen.add(id); order.push(id);
  }
  nodes.forEach((_, id) => visit(id)); return order;
}
class AirodromGoalPlanner {
  constructor(service) { this.service = service; this.bridge = service.bridge; this.store = service.store; this.db = service.db; }
  create(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required');
    object(input, ['request_id', 'goal_id', 'stages', 'max_runtime_hours', 'max_attempts']);
    identifier(input.request_id); identifier(input.goal_id);
    const hash = fingerprint(input);
    const replay = this.db.prepare('SELECT id,fingerprint FROM cp_mission_programs WHERE owner=? AND request_id=?').get(owner, input.request_id);
    if (replay) { if (replay.fingerprint !== hash) throw Error('Goal plan idempotency conflict'); return this.inspect(replay.id, owner); }
    const goal = this.bridge.projects.getGoal(input.goal_id), project = this.bridge.projects.getProject(goal.projectId);
    if (project.status === 'archived' || goal.status !== 'active') throw Error('Goal or Project is inactive');
    if (!Number.isFinite(input.max_runtime_hours) || input.max_runtime_hours <= 0 || input.max_runtime_hours > 24 || !Number.isSafeInteger(input.max_attempts) || input.max_attempts < 1 || input.max_attempts > 10) throw Error('Invalid goal budget');
    graphOrder(input.stages);
    const stages = input.stages.map(s => {
      object(s, ['id', 'depends_on', 'mission_id', 'objective', 'acceptance_criteria', 'verification_requirements', 'human_checkpoint']);
      text(s.objective, 'milestone objective', 1000);
      for (const key of ['acceptance_criteria', 'verification_requirements']) {
        if (!Array.isArray(s[key]) || !s[key].length || s[key].length > 10) throw Error('Milestone evidence requirements missing');
        s[key].forEach(v => text(v, key, 500));
      }
      if (s.human_checkpoint !== undefined && typeof s.human_checkpoint !== 'boolean') throw Error('Invalid checkpoint');
      if (s.mission_id) this.checkBinding(s.mission_id, goal, owner);
      return { ...s, mission_id: s.mission_id || null };
    });
    return transaction(this.db, () => {
      const prior = this.db.prepare('SELECT id,fingerprint FROM cp_mission_programs WHERE owner=? AND request_id=?').get(owner, input.request_id);
      if (prior) { if (prior.fingerprint !== hash) throw Error('Goal plan idempotency conflict'); return this.inspect(prior.id, owner); }
      const id = randomUUID(), now = this.store.now();
      const plan = {
        version: 1, goal_id: goal.goalId, project_id: goal.projectId, max_attempts: input.max_attempts,
        checkpoints: [], recovery: { continuations: 0, last_at: null }, execution_enabled: false,
        autonomous: require('./autonomous-execution').defaultAutonomous()
      };
      this.db.prepare('INSERT INTO cp_mission_programs(id,owner,graph,fingerprint,state,started_at,expires_at,request_id,goal_plan) VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, JSON.stringify(stages), hash, 'goal_observing', now, now + input.max_runtime_hours * 3600000, input.request_id, JSON.stringify(plan));
      for (const s of stages) this.db.prepare('INSERT INTO cp_mission_program_nodes VALUES(?,?,?,?,?)').run(id, s.id, s.mission_id, JSON.stringify(s), 'pending');
      this.store.event('goal.plan.created', null, { plan_id: id, goal_id: goal.goalId, milestones: stages.length, authority: false });
      return this.inspect(id, owner);
    });
  }
  checkBinding(id, goal, owner) {
    const m = this.service.require(identifier(id), owner);
    if (m.goal_id !== goal.goalId || m.project_id !== goal.projectId || !m.envelope.manifest || m.state !== 'ready') throw Error('Goal requires a ready bounded Mission in the same Goal and Project');
    return m;
  }
  row(id, owner = 'operator') {
    require('./memory-content-erasure').assertReadable(this.db);
    const row = this.db.prepare('SELECT * FROM cp_mission_programs WHERE id=? AND owner=? AND goal_plan IS NOT NULL').get(identifier(id), owner);
    if (!row) throw Error('Goal plan unavailable');
    const plan = JSON.parse(row.goal_plan), graph = JSON.parse(row.graph);
    if (plan?.version !== 1) throw Error('Goal plan unavailable'); graphOrder(graph);
    return { ...row, plan, graph };
  }
  // Completion is re-derived from canonical correlated host evidence on every read.
  verified(id) {
    const m = this.store.requireMission(id);
    if (m.state !== 'completed') return false;
    const revision = this.bridge.authorityRuntime?.active && this.bridge.authorityRuntime.store.getMission(id) ? m.revision : m.revision - 1;
    const v = this.db.prepare(`SELECT v.*,r.termination_verified FROM cp_acceptances a
      JOIN cp_verifications v ON v.id=a.verification_id AND v.mission_id=a.mission_id
      JOIN cp_runs r ON r.id=v.run_id AND r.mission_id=v.mission_id
      JOIN cp_mission_settlements s ON s.mission_id=a.mission_id AND s.state='settled'
      JOIN cp_mission_reviews review ON review.id=s.review_id AND review.verification_id=v.id AND review.mission_id=a.mission_id AND review.result='passed'
      WHERE a.mission_id=? AND a.decision='accept' AND a.actor='operator' AND v.revision=?
      AND v.result='passed' AND v.checker='airodrom:host-verifier' AND r.termination_verified=1 ORDER BY a.created_at DESC LIMIT 1`).get(id, revision);
    return !!v;
  }
  status(row) {
    const nodes = this.db.prepare('SELECT * FROM cp_mission_program_nodes WHERE program_id=?').all(row.id), byId = new Map(nodes.map(n => [n.node_id, n])), states = new Map();
    const inactive = row.state !== 'goal_observing' || this.store.now() >= row.expires_at;
    const goal = this.bridge.projects.getGoal(row.plan.goal_id), project = this.bridge.projects.getProject(row.plan.project_id);
    for (const id of graphOrder(row.graph)) {
      const s = row.graph.find(s => s.id === id), n = byId.get(id), mission = n.mission_id ? this.service.require(n.mission_id, row.owner) : null;
      let state = 'ready', reason = null;
      if (mission && (mission.goal_id !== row.plan.goal_id || mission.project_id !== row.plan.project_id)) throw Error('Goal scope mismatch');
      const attempts = mission ? this.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(mission.id).n : 0;
      if (mission && this.verified(mission.id)) state = 'verified';
      else if (inactive || project.status === 'archived' || goal.status !== 'active') { state = 'blocked'; reason = row.state !== 'goal_observing' ? 'cancelled' : this.store.now() >= row.expires_at ? 'budget_expired' : 'goal_inactive'; }
      else if (s.depends_on.some(d => states.get(d).state !== 'verified')) { state = 'blocked'; reason = 'dependency_unverified'; }
      else if (s.human_checkpoint && !row.plan.checkpoints.includes(id)) { state = 'waiting_approval'; reason = 'operator_checkpoint'; }
      else if (!mission) { state = 'blocked'; reason = 'bounded_mission_required'; }
      else if (mission.state === 'awaiting_acceptance') { state = 'waiting_approval'; reason = 'acceptance_required'; }
      else if (['dispatching', 'running', 'verifying'].includes(mission.state)) state = 'active';
      else if (mission.state === 'waiting_for_operator') { state = 'waiting_approval'; reason = 'mission_decision'; }
      else if (mission.state !== 'ready') { state = 'blocked'; reason = 'explicit_mission_recovery_required'; }
      else if (attempts >= row.plan.max_attempts) { state = 'blocked'; reason = 'attempt_budget'; }
      if (state === 'ready' || state === 'active') {
        const task = this.bridge.tasks.get(mission.task_id);
        const uncertain = this.db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state='unknown'").get(mission.id) || this.db.prepare("SELECT 1 FROM cp_leases WHERE mission_id=? AND state='quarantined'").get(mission.id);
        const grant = require('./mission-permissions').checkAuthority(mission.envelope.authority, {});
        if (uncertain || task.mission?.authorityRevoked || !grant.allow) { state = 'blocked'; reason = uncertain ? 'uncertain_execution' : 'authority_unavailable'; }
      }
      states.set(id, { id, mission_id: mission?.id || null, depends_on: s.depends_on, state, reason, attempts, retry_eligible: state === 'ready' && attempts > 0 });
    }
    return [...states.values()];
  }
  inspect(id, owner = 'operator') {
    const row = this.row(id, owner), stages = this.status(row);
    const autonomous = row.plan.autonomous || {};
    const executionEnabled = autonomous.enabled === true && autonomous.paused !== true;
    return { id: row.id, goal_id: row.plan.goal_id, project_id: row.plan.project_id, owner: row.owner, state: row.state !== 'goal_observing' ? 'cancelled' : stages.every(s => s.state === 'verified') ? 'completed' : 'observing', expires_at: row.expires_at, stages, ready: stages.filter(s => s.state === 'ready').map(s => s.id), blocked: stages.filter(s => s.state === 'blocked').map(s => s.id), recovery: row.plan.recovery, execution_enabled: executionEnabled, autonomous_enabled: autonomous.enabled === true, authority: false };
  }
  list(limit = 50) { return this.db.prepare('SELECT id FROM cp_mission_programs WHERE goal_plan IS NOT NULL ORDER BY started_at DESC LIMIT ?').all(limit).map(r => this.inspect(r.id)); }
  assertMission(mission) {
    const row = this.db.prepare('SELECT p.id FROM cp_mission_programs p JOIN cp_mission_program_nodes n ON p.id=n.program_id WHERE n.mission_id=? AND p.goal_plan IS NOT NULL').get(mission.id);
    if (!row) return;
    const view = this.inspect(row.id, mission.owner), stage = view.stages.find(s => s.mission_id === mission.id);
    if (view.state === 'cancelled' || this.store.now() >= view.expires_at || !['ready', 'active', 'waiting_approval', 'verified'].includes(stage.state) || stage.reason === 'operator_checkpoint') throw Error('Goal dependency, authority, checkpoint or recovery boundary halted');
  }
  continue(id, requestId, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required'); identifier(requestId);
    return this.store.request(owner, requestId, { op: 'goal_continue', id }, () => {
      const row = this.row(id, owner); if (row.state !== 'goal_observing') throw Error('Cancelled goal plan');
      const view = this.inspect(id, owner), contexts = [];
      // Fresh ContextPacks only for currently ready, authorized bounded Missions.
      for (const s of view.stages.filter(s => s.state === 'ready')) {
        const m = this.service.require(s.mission_id, owner); this.service.assertAuthority(m);
        const pack = this.bridge.controlContext.build(m); contexts.push({ mission_id: m.id, context_pack_id: pack.id });
      }
      row.plan.recovery = { continuations: row.plan.recovery.continuations + 1, last_at: this.store.now() };
      this.db.prepare('UPDATE cp_mission_programs SET goal_plan=? WHERE id=?').run(JSON.stringify(row.plan), id);
      this.store.event('goal.plan.continued', null, { plan_id: id, ready_count: contexts.length, authority: false });
      return { ...this.inspect(id, owner), contexts, next_action: contexts.length ? 'operator_dispatch_existing_mission' : 'resolve_blockers', dispatched: false };
    });
  }
  checkpoint(id, stageId, requestId, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required'); identifier(requestId);
    return this.store.request(owner, requestId, { op: 'goal_checkpoint', id, stageId }, () => {
      const row = this.row(id, owner), s = row.graph.find(s => s.id === stageId);
      if (row.state !== 'goal_observing' || this.store.now() >= row.expires_at || !s?.human_checkpoint) throw Error('Checkpoint unavailable');
      row.plan.checkpoints = [...new Set([...row.plan.checkpoints, stageId])];
      this.db.prepare('UPDATE cp_mission_programs SET goal_plan=? WHERE id=?').run(JSON.stringify(row.plan), id);
      this.store.event('goal.checkpoint.confirmed', null, { plan_id: id, authority: false }); return this.inspect(id, owner);
    });
  }
  bind(id, stageId, missionId, requestId, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required'); identifier(requestId);
    return this.store.request(owner, requestId, { op: 'goal_bind', id, stageId, missionId }, () => {
      const row = this.row(id, owner); if (row.state !== 'goal_observing' || this.store.now() >= row.expires_at) throw Error('Goal plan inactive');
      this.checkBinding(missionId, this.bridge.projects.getGoal(row.plan.goal_id), owner);
      const node = this.db.prepare('SELECT mission_id FROM cp_mission_program_nodes WHERE program_id=? AND node_id=?').get(id, stageId);
      if (!node || node.mission_id) throw Error('Milestone already bound or missing');
      this.db.prepare('UPDATE cp_mission_program_nodes SET mission_id=? WHERE program_id=? AND node_id=?').run(missionId, id, stageId); return this.inspect(id, owner);
    });
  }
  // CAE-only: replace a failed stage Mission with one in-scope corrective Mission.
  rebindRepair(id, stageId, missionId, requestId, { parent_mission_id }, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required');
    identifier(requestId); identifier(parent_mission_id); identifier(missionId); identifier(stageId);
    return this.store.request(owner, requestId, { op: 'goal_rebind_repair', id, stageId, missionId, parent_mission_id }, () => {
      const row = this.row(id, owner);
      if (row.state !== 'goal_observing' || this.store.now() >= row.expires_at) throw Error('Goal plan inactive');
      const parent = this.store.requireMission(parent_mission_id);
      const repair = this.store.requireMission(missionId);
      if (parent.state !== 'needs_rework') throw Error('Repair rebind requires a failed parent Mission');
      if (repair.envelope?.repair_of !== parent_mission_id) throw Error('Repair Mission must declare its parent');
      if (repair.goal_id !== row.plan.goal_id || repair.project_id !== row.plan.project_id) throw Error('Goal scope mismatch');
      if (parent.goal_id !== row.plan.goal_id || parent.project_id !== row.plan.project_id) throw Error('Parent Goal scope mismatch');
      if (parent.envelope.workspace !== repair.envelope.workspace) throw Error('Repair workspace mismatch');
      this.checkBinding(missionId, this.bridge.projects.getGoal(row.plan.goal_id), owner);
      const node = this.db.prepare('SELECT mission_id FROM cp_mission_program_nodes WHERE program_id=? AND node_id=?').get(id, stageId);
      if (!node || node.mission_id !== parent_mission_id) throw Error('Stage is not bound to the failed parent Mission');
      this.db.prepare('UPDATE cp_mission_program_nodes SET mission_id=? WHERE program_id=? AND node_id=?').run(missionId, id, stageId);
      this.store.event('goal.plan.repair_rebound', missionId, {
        plan_id: id, stage_id: stageId, parent_mission_id, authority: false,
      });
      return this.inspect(id, owner);
    });
  }
  cancel(id, requestId, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated operator required'); identifier(requestId);
    return this.store.request(owner, requestId, { op: 'goal_cancel', id }, () => {
      this.row(id, owner); this.db.prepare("UPDATE cp_mission_programs SET state='goal_cancelled' WHERE id=?").run(id);
      for (const n of this.db.prepare('SELECT mission_id FROM cp_mission_program_nodes WHERE program_id=? AND mission_id IS NOT NULL').all(id)) {
        if (!['completed', 'cancelled'].includes(this.store.requireMission(n.mission_id).state)) this.service.cancel(n.mission_id, { request_id: 'goal-stop:' + id + ':' + n.mission_id }, owner);
      }
      return this.inspect(id, owner);
    });
  }
}
module.exports = { AirodromGoalPlanner, graphOrder };
