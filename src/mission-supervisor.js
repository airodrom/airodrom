'use strict';
const acceptance = require('./supervisor-acceptance');
// Local coordination only. This module never grants or impersonates human approval.
class MissionSupervisor {
  constructor(bridge) {
    this.bridge = bridge; this.pending = false; this.busy = false;
    this.listener = () => this.schedule();
    bridge.tasks.on('transition', this.listener);
    this.timer = setInterval(() => this.schedule(), bridge.options.watchdogMs || 30000);
    this.timer.unref(); this.schedule();
  }
  schedule() {
    if (this.pending || this.bridge.closed) return;
    this.pending = true;
    queueMicrotask(() => { this.pending = false; this.tick().catch(error => {
      this.bridge.supervisorError = error.message;
      this.bridge.emit('change');
    }); });
  }
  async tick(now = Date.now()) {
    const b = this.bridge;
    if (b.closed) return;
    if (this.busy) { this.rerun = true; return; }
    this.busy = true;
    try {
      for (const task of b.tasks.list()) {
        if (task.mission?.authority && !task.mission.authorityRevoked && !['cancelled','completed'].includes(task.status) && !task.safetyStop?.latched) {
          const authority = require('./mission-permissions').checkAuthority(task.mission.authority, {}, now);
          if (!authority.allow) {
            b._recordPolicyDenial(task, { toolName: 'mission_expiry' }, { allow: false, kind: 'mission_grant_denied', reason: authority.reason });
            for (const job of b.capabilityHost?.jobs?.jobs.values() || []) if (job.taskId === task.id && job.status === 'running') b.capabilityHost.jobs.cancel(job);
            const mission = task.controlPlaneMissionId ? b.controlStore.getMission(task.controlPlaneMissionId) : null;
            if (mission && !['cancelled','completed','blocked'].includes(mission.state)) b.controlStore.state(mission.id,'blocked',authority.reason);
            if (b.leases.has(task.id)) await b.requestStop(task.id, 'blocked');
            continue;
          }
        }
        if (task.controlPlaneMissionId) continue; // Mission V2 owns acceptance and explicit continuation.
        const approvals = b.policy.list(task.id);
        if (task.status === 'approval_required' && !approvals.some(a => a.status === 'pending')) {
          task.status = approvals.some(a => a.status === 'expired') ? 'approval_expired' : 'blocked'; b.tasks.save(task);
        }
        if (b.inFlight.has(task.id)) {
          // A valid human review is an explicit wait state, not an activity
          // failure. Its separate approval expiry remains visible and actionable.
          if (approvals.some(a => ['pending', 'approved'].includes(a.status))) continue;
          if (!task.stopReason && !task.cancelRequested && (now - (task.lastActivityAt || task.startedAt) > (b.options.stallMs || 60000) || (task.connected && now - (task.lastHeartbeatAt || task.startedAt) > (b.options.stallMs || 60000)))) {
            task.stopReason = 'stalled'; task.status = 'stalled'; b.tasks.save(task);
            // Abort the lease so pre-worker / handoff waits cannot orphan busy.
            await b.requestStop(task.id, 'stalled');
          }
          continue;
        }
        // Level 1 advances only through its result-bound provider coordinator.
        // The generic checkpoint/retry loop must never select or replay Task B.
        if (task.mission?.level1MissionId || task.reasoningMode === 'reasoning_only') continue;
        if (!task.mission || !task.mission.started || task.cancelRequested || task.status === 'cancelled') continue;
        const checkpoint = b.memory.latestCheckpoint(task.id);
        const gates = checkpoint ? JSON.parse(checkpoint.content).completedGates : [];
        const accepted = task.mission.criteria.length > 0 && task.mission.criteria.every(g => g === acceptance.CRITERION ? acceptance.satisfied(task) : gates.includes(g));
        if (accepted && !task.lastRunBlocked && task.status === 'completed' && require('./execution-evidence').satisfied(task)) {
          if (task.mission.status !== 'completed') { task.mission.status = 'completed'; task.recovery = null; b.tasks.save(task); }
          continue;
        }
        if (!['completed','failed','error','deadline','stalled','blocked','approval_required','approval_expired','interrupted','recovering'].includes(task.status)) continue;
        const held = approvals.some(a => ['pending','approved'].includes(a.status)) || ['blocked','approval_required','approval_expired','interrupted'].includes(task.status) || task.lastRunBlocked;
        const reason = held ? 'human_or_execution_review' : !task.mission.criteria.length ? 'acceptance_criteria_required' : task.mission.attempts >= task.mission.budget.maxRetries || task.mission.used.retries >= task.mission.budget.maxRetries ? 'recovery_budget_exhausted' : task.mission.requireGrant && !task.mission.grantId ? 'mission_grant_required' : null;
        if (task.recovery?.state === 'dispatching') {
          // A crash may have occurred after dispatch. Never replay an uncertain attempt.
          task.recovery.state = 'prepared'; task.recovery.reason = 'execution_outcome_unknown'; task.mission.status = 'needs_review'; b.tasks.save(task); continue;
        }
        if (task.recovery?.reason === 'execution_outcome_unknown') continue;
        const desired = reason ? 'prepared' : 'queued';
        if (!task.recovery || task.recovery.state !== desired || task.recovery.reason !== reason || task.recovery.checkpointId !== (checkpoint?.id || null)) {
          task.recovery = { state: desired, reason, trigger: task.status, checkpointId: checkpoint?.id || null, preparedAt: now };
          task.mission.status = reason ? 'needs_review' : 'recovering'; b.tasks.save(task);
        }
        if (reason || b.inFlight.size >= (b.options.maxConcurrent || 1)) continue;
        if (task.mission.requireGrant) {
          const retryGrant = b.missionAuthority.consumeRetry(task.mission);
          if (!retryGrant.allow) {
            task.recovery.state = 'prepared'; task.recovery.reason = 'mission_grant_required'; task.mission.status = 'needs_review'; b.tasks.save(task); continue;
          }
          task.mission.used.retries++;
        }
        // Persist the budget reservation BEFORE dispatch. No inherited approval grants.
        task.mission.attempts++; task.recovery.state = 'dispatching'; task.status = 'recovering'; b.tasks.save(task);
        await b.stopTask(task.id);
        if (b.closed || task.cancelRequested) continue;
        task.continuationRequired = true;
        const message = `Retry instruction only; the original mission objective, acceptance criteria, workspace scope, and cumulative budgets are immutable. Continue from the latest durable checkpoint. Original objective: ${task.mission.objective}. Criteria: ${JSON.stringify(task.mission.criteria)}. Scope: ${JSON.stringify(task.mission.scope)}. Remaining budget: ${JSON.stringify({ runtimeMs: task.mission.budget.maxRuntimeMs - task.mission.used.runtimeMs, actions: task.mission.budget.maxActions - task.mission.used.actions, retries: task.mission.budget.maxRetries - task.mission.used.retries, spendMicros: 0 })}. Runtime evidence is authoritative. Blocked-before-execution means NOT EXECUTED. Do not repeat denied actions, seek broader permissions, or treat prose as verified acceptance. Any cloud, billable, credential, config, IAM, network, or deploy action remains blocked or requires explicit human authorization.`;
        task.recovery.retryInstructions = message;
        b.tasks.save(task);
        b.prompt(task.id, message.slice(0, 59000), { recovery: true }).catch(() => {});
      }
    } finally { this.busy = false; if (this.rerun) { this.rerun = false; this.schedule(); } }
  }
  close() { clearInterval(this.timer); this.bridge.tasks.off('transition', this.listener); }
}
module.exports = MissionSupervisor;
