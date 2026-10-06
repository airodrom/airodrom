'use strict';
const { randomUUID } = require('node:crypto');

const PHASES = Object.freeze({
  admitted: 'admitted',
  retiring_previous_runtime: 'retiring_previous_runtime',
  worker_spawning: 'worker_spawning',
  worker_starting: 'worker_starting',
  waiting_ready: 'waiting_ready',
  ready: 'ready',
  running: 'running',
  approval_wait: 'approval_wait',
  cancelling: 'cancelling',
  stopping: 'stopping',
  settled: 'settled',
  termination_unverified: 'termination_unverified'
});

const TERMINAL_TASK_STATUSES = new Set([
  'cancelled', 'failed', 'error', 'deadline', 'stalled', 'interrupted', 'blocked', 'completed'
]);

class ExecutionLease {
  constructor({ runId, taskId, generation, phase = PHASES.admitted, acquiredAt = Date.now() }) {
    this.runId = runId;
    this.taskId = taskId;
    this.generation = generation;
    this.phase = phase;
    this.acquiredAt = acquiredAt;
    this.controller = new AbortController();
    this.runtimeTaskId = null;
    this.priorRuntimeTaskId = null;
    this.failClosed = false;
    this.failClosedReason = null;
    this.cancelRequested = false;
    this.terminationVerified = null;
    let resolveSettled;
    this.settled = new Promise(resolve => { resolveSettled = resolve; });
    this.resolveSettled = resolveSettled;
  }

  get aborted() {
    return this.controller.signal.aborted;
  }

  abort(reason = 'Task cancelled') {
    this.cancelRequested = true;
    if (this.phase !== PHASES.termination_unverified && this.phase !== PHASES.settled) {
      this.phase = PHASES.cancelling;
    }
    if (!this.controller.signal.aborted) {
      try { this.controller.abort(reason); } catch { this.controller.abort(); }
    }
  }
}

class LeaseRegistry {
  constructor({ busySet, onChange, onEvent } = {}) {
    this.leases = new Map();
    this.generation = 0;
    this.busySet = busySet || new Set();
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
  }

  _event(type, lease, details = {}) {
    try {
      this.onEvent({ type, lease, ...details });
    } catch { /* Audit delivery must never alter execution ownership. */ }
  }

  get size() {
    return this.leases.size;
  }

  has(taskId) {
    return this.leases.has(taskId);
  }

  get(taskId) {
    return this.leases.get(taskId) || null;
  }

  acquire(taskId, { agentId = 'pi' } = {}) {
    if (this.leases.has(taskId)) throw new Error('Task already running');
    const lease = new ExecutionLease({
      runId: randomUUID(),
      taskId,
      generation: ++this.generation,
      phase: PHASES.admitted,
      acquiredAt: Date.now()
    });
    this.beforeAcquire?.(lease, agentId);
    this.leases.set(taskId, lease);
    this.busySet.add(taskId);
    this._event('acquired', lease);
    this.onChange();
    return lease;
  }

  setPhase(lease, phase) {
    if (!lease || !PHASES[phase]) return lease;
    if (this.leases.get(lease.taskId)?.runId !== lease.runId) return lease;
    if (lease.failClosed && phase !== PHASES.termination_unverified && phase !== PHASES.settled) return lease;
    const previous = lease.phase;
    lease.phase = phase;
    if (previous !== phase) this._event('phase_changed', lease, { previous, phase });
    this.onChange();
    return lease;
  }

  bindRuntime(lease, runtimeTaskId) {
    if (!lease || this.leases.get(lease.taskId)?.runId !== lease.runId) return;
    lease.runtimeTaskId = runtimeTaskId;
    this._event('runtime_bound', lease, { runtimeTaskId });
  }

  markPriorRuntime(lease, priorRuntimeTaskId) {
    if (!lease || this.leases.get(lease.taskId)?.runId !== lease.runId) return;
    lease.priorRuntimeTaskId = priorRuntimeTaskId;
    this._event('prior_runtime_bound', lease, { priorRuntimeTaskId });
  }

  awaitLease(lease, promise, phase) {
    if (!lease) return Promise.resolve(promise);
    this.setPhase(lease, phase);
    const signal = lease.controller.signal;
    if (signal.aborted) return Promise.reject(new Error('Task cancelled'));
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Task cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // Keep the underlying work attached so an abort-won race does not surface
    // later as an unhandled rejection (e.g. get_state timeout after cancel).
    const primary = Promise.resolve(promise);
    primary.catch(() => {});
    return Promise.race([primary, aborted])
      .finally(() => signal.removeEventListener('abort', onAbort));
  }

  requestCancel(taskIdOrLease, reason = 'Task cancelled') {
    const lease = typeof taskIdOrLease === 'string' ? this.leases.get(taskIdOrLease) : taskIdOrLease;
    if (!lease) return null;
    if (this.leases.get(lease.taskId)?.runId !== lease.runId) return null;
    lease.abort(reason);
    this._event('cancellation_requested', lease, { reason: String(reason).slice(0, 500) });
    this.onChange();
    return lease;
  }

  /**
   * Compare-and-release: only the finishing run identity may clear busy ownership.
   * Returns true when this lease released ownership.
   */
  releaseIfOwner(lease, { verified = true } = {}) {
    if (!lease) return false;
    const current = this.leases.get(lease.taskId);
    if (!current || current.runId !== lease.runId) {
      lease.phase = PHASES.settled;
      lease.terminationVerified = verified;
      lease.resolveSettled?.();
      lease.resolveSettled = null;
      return false;
    }
    this.beforeRelease?.(lease, verified);
    lease.phase = PHASES.settled;
    lease.terminationVerified = verified;
    lease.failClosed = false;
    this.leases.delete(lease.taskId);
    this.busySet.delete(lease.taskId);
    lease.resolveSettled?.();
    lease.resolveSettled = null;
    this._event('released', lease, { verified });
    this.onChange();
    return true;
  }

  /**
   * Keep admission closed when worker death cannot be proven.
   */
  holdFailClosed(lease, reason) {
    if (!lease) return false;
    const current = this.leases.get(lease.taskId);
    if (!current || current.runId !== lease.runId) {
      lease.resolveSettled?.();
      lease.resolveSettled = null;
      return false;
    }
    lease.failClosed = true;
    lease.failClosedReason = String(reason || 'Worker termination could not be verified').slice(0, 500);
    lease.phase = PHASES.termination_unverified;
    lease.terminationVerified = false;
    this.busySet.add(lease.taskId);
    lease.resolveSettled?.();
    lease.resolveSettled = null;
    this._event('fail_closed', lease, { reason: lease.failClosedReason });
    this.onChange();
    return true;
  }

  async waitSettled(lease, timeoutMs = 6000) {
    if (!lease?.settled) return false;
    let timer;
    try {
      await Promise.race([
        lease.settled,
        new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
      ]);
    } finally {
      clearTimeout(timer);
    }
    return this.leases.get(lease.taskId)?.runId !== lease.runId || lease.phase === PHASES.settled;
  }

  abortAll(reason = 'Bridge shutdown') {
    for (const lease of this.leases.values()) lease.abort(reason);
    this.onChange();
  }

  async waitAllSettled(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (this.leases.size && Date.now() < deadline) {
      const pending = [...this.leases.values()].map(lease => lease.settled);
      let timer;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })
        ]);
      } finally {
        clearTimeout(timer);
      }
      if ([...this.leases.values()].every(lease => lease.failClosed || lease.phase === PHASES.settled)) break;
    }
    return {
      remaining: this.size,
      failClosed: [...this.leases.values()].filter(lease => lease.failClosed).map(lease => this.leaseSnapshot(lease))
    };
  }

  /**
   * Clear ownership only when no live worker/execution remains for a suspicious lease.
   */
  reconcile({ tasks, runtimes, tokens, workerAlive, activeInference } = {}) {
    const report = { cleared: [], held: [], notes: [] };
    const alive = typeof workerAlive === 'function' ? workerAlive : () => null;

    for (const [taskId, lease] of [...this.leases.entries()]) {
      if (activeInference?.(taskId)) continue;
      const task = tasks?.get?.(taskId);
      const runtime = runtimes?.get?.(taskId);
      const liveness = runtime?.rpc ? alive(runtime.rpc) : false;

      if (lease.failClosed) {
        if (liveness === false && !runtime) {
          this.releaseIfOwner(lease, { verified: true });
          report.cleared.push({ taskId, runId: lease.runId, reason: 'fail_closed_worker_proven_gone' });
        } else {
          report.held.push({ taskId, runId: lease.runId, reason: 'termination_unverified' });
        }
        continue;
      }

      const terminal = task && (TERMINAL_TASK_STATUSES.has(task.status) || task.mission?.status === 'cancelled');
      const disconnected = task && task.connected !== true;
      const stuckPreWorker = !runtime && ['admitted', 'retiring_previous_runtime', 'worker_spawning', 'cancelling', 'stopping'].includes(lease.phase);
      const leaseAge = Date.now() - lease.acquiredAt;

      if (terminal && disconnected && !runtime && (lease.aborted || stuckPreWorker || leaseAge > 30_000)) {
        if (liveness === true) {
          this.holdFailClosed(lease, 'Terminal task still has a live worker');
          report.held.push({ taskId, runId: lease.runId, reason: 'terminal_live_worker' });
        } else {
          this.releaseIfOwner(lease, { verified: true });
          report.cleared.push({ taskId, runId: lease.runId, reason: 'terminal_disconnected_no_runtime' });
        }
        continue;
      }

      if (!runtime && stuckPreWorker && lease.aborted && leaseAge > 100) {
        this.releaseIfOwner(lease, { verified: true });
        report.cleared.push({ taskId, runId: lease.runId, reason: 'aborted_pre_worker' });
      }
    }

    if (runtimes) {
      for (const [taskId, runtime] of runtimes.entries()) {
        if (this.leases.has(taskId)) continue;
        const liveness = runtime?.rpc ? alive(runtime.rpc) : false;
        report.notes.push({
          kind: 'orphan_runtime',
          taskId,
          alive: liveness,
          action: liveness === false ? 'safe_to_retire' : 'fail_closed_keep'
        });
      }
    }

    if (tokens && runtimes) {
      for (const [token, taskId] of tokens.entries()) {
        if (!runtimes.has(taskId)) {
          report.notes.push({ kind: 'orphan_token', taskId, tokenFingerprint: String(token).slice(0, 8) });
        }
      }
    }

    return report;
  }

  leaseSnapshot(lease) {
    if (!lease) return null;
    return {
      taskId: lease.taskId,
      runId: lease.runId,
      generation: lease.generation,
      phase: lease.phase,
      leaseAgeMs: Math.max(0, Date.now() - lease.acquiredAt),
      runtimeBound: lease.runtimeTaskId != null,
      priorRuntimeTaskId: lease.priorRuntimeTaskId || null,
      cancellationRequested: lease.cancelRequested || lease.aborted,
      failClosed: Boolean(lease.failClosed),
      terminationVerified: lease.terminationVerified,
      failClosedReason: lease.failClosedReason || null
    };
  }

  executionSnapshot() {
    const active = [...this.leases.values()].map(lease => this.leaseSnapshot(lease));
    const primary = active[0] || null;
    return {
      busy: active.length > 0,
      activeCount: active.length,
      activeTaskId: primary?.taskId || null,
      runId: primary?.runId || null,
      generation: primary?.generation || null,
      phase: primary?.phase || null,
      leaseAgeMs: primary?.leaseAgeMs || null,
      priorRuntimeTaskId: primary?.priorRuntimeTaskId || null,
      cancellationRequested: primary?.cancellationRequested || false,
      failClosed: primary?.failClosed || false,
      terminationVerified: primary?.terminationVerified ?? null,
      leases: active
    };
  }

  busyAdmissionError() {
    const snap = this.executionSnapshot();
    if (!snap.busy) return 'Bridge is busy or stopped; poll the active task before retrying';
    if (snap.failClosed || snap.phase === PHASES.termination_unverified) {
      return `Bridge admission is fail-closed (termination_unverified) for task ${snap.activeTaskId} run ${snap.runId}; worker death is unverified — do not treat this as an ordinary active run`;
    }
    if (snap.phase === PHASES.retiring_previous_runtime) {
      return `Bridge is busy retiring previous runtime${snap.priorRuntimeTaskId ? ` ${snap.priorRuntimeTaskId}` : ''} for task ${snap.activeTaskId}; poll that task before retrying`;
    }
    if (snap.phase === PHASES.cancelling || snap.phase === PHASES.stopping) {
      return `Bridge is stopping task ${snap.activeTaskId} (phase=${snap.phase}); poll that task before retrying`;
    }
    return `Bridge is busy with active run ${snap.runId} on task ${snap.activeTaskId} (phase=${snap.phase}); poll that task before retrying`;
  }
}

module.exports = {
  PHASES,
  ExecutionLease,
  LeaseRegistry,
  TERMINAL_TASK_STATUSES
};
