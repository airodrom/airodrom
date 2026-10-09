'use strict';
// ADR 0031: launchd-owned supervisor for the private local service. It signals
// only a child it spawned, never removes locks, discovery or configuration, and
// never replays work. Durable Mission recovery stays inside the Bridge.
const { randomUUID } = require('node:crypto');

const STATES = Object.freeze(['STOPPED', 'STARTING', 'HEALTHY', 'DEGRADED', 'RECOVERING', 'BLOCKED', 'STOPPING']);
const DEFAULTS = Object.freeze({
  readinessTimeoutMs: 60000, healthIntervalMs: 15000, unhealthyThreshold: 3, pollMs: 250,
  backoffBaseMs: 2000, backoffMaxMs: 300000, failureWindowMs: 600000, maxFailures: 5,
  stableAfterMs: 600000, crashLoopCooldownMs: 1800000, stopGraceMs: 30000,
  sleepGapMs: 30000, blockedRecheckMs: 120000
});

// Equal jitter: the delay grows exponentially, never drops below half its ceiling.
function backoffDelay(failures, policy = DEFAULTS, random = Math.random) {
  const ceiling = Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** Math.max(0, failures - 1));
  return Math.round(ceiling / 2 + random() * ceiling / 2);
}

class Supervisor {
  constructor(deps, options = {}) {
    this.deps = deps;
    this.policy = { ...DEFAULTS, ...options };
    this.epoch = randomUUID();
    this.state = 'STOPPED'; this.since = deps.now();
    this.mode = null; this.child = null; this.failures = [];
    this.blocked = null; this.lastExit = null; this.lastRecovery = null;
    this.health = { consecutive_failures: 0, last_ok_at: null };
    this.worker = { opencode: 'UNKNOWN', reason: null };
    this.operatorStopped = false;
  }

  snapshot() {
    const recent = this.recentFailures();
    return { version: 1, supervisor_pid: this.deps.pid ?? null, epoch: this.epoch, state: this.state, since: this.since,
      updated_at: this.deps.now(), mode: this.mode, child_pid: this.child?.pid ?? null, attempts_in_window: recent.length,
      last_exit: this.lastExit, last_recovery: this.lastRecovery, blocked: this.blocked, health: { ...this.health },
      worker: { ...this.worker }, operator_stopped: this.operatorStopped };
  }
  publish() { try { this.deps.publish?.(this.snapshot()); } catch { /* status is advisory; supervision continues */ } }
  record(event, fields = {}) { try { this.deps.record?.({ at: this.deps.now(), event, ...fields }); } catch {} }
  set(state) {
    if (!STATES.includes(state)) throw Error('Unknown supervisor state');
    if (state !== this.state) { this.state = state; this.since = this.deps.now(); this.record('state', { state }); }
    this.publish();
  }
  recentFailures() { const floor = this.deps.now() - this.policy.failureWindowMs; return this.failures.filter(at => at >= floor); }

  // Resolves after ms, or early when the run is cancelled.
  wait(ms) { return this.deps.sleep(ms, this.signal); }
  async race(promise, ms) {
    const local = new AbortController(), signal = this.signal ? AbortSignal.any([this.signal, local.signal]) : local.signal;
    try { return await Promise.race([promise.then(value => ({ value })), this.deps.sleep(ms, signal).then(() => null)]); }
    finally { local.abort(); }
  }

  async run(signal) {
    this.signal = signal;
    this.operatorStopped = this.deps.readStopMarker?.() === true;
    this.record('supervisor_started', { operator_stopped: this.operatorStopped });
    this.publish();
    while (!signal.aborted) {
      try { await this.step(); }
      catch { this.record('supervisor_error'); await this.wait(this.policy.blockedRecheckMs); }
    }
    await this.shutdown();
  }

  async step() {
    const pre = this.deps.preflight();
    if (!pre.ok) return this.block(pre.reason);
    const owner = this.deps.owner();
    if (owner.state === 'live') return this.attach(owner.pid);
    if (owner.state === 'pid_reused') return this.block('writer_lock_pid_reused');
    if (owner.state === 'unverified') return this.block('writer_lock_unverified');
    if (this.operatorStopped) { this.mode = null; this.set('STOPPED'); return this.wait(this.policy.healthIntervalMs); }
    const recent = this.recentFailures();
    if (recent.length >= this.policy.maxFailures && this.deps.now() - recent.at(-1) < this.policy.crashLoopCooldownMs) return this.block('crash_loop');
    return this.launch(recent.length > 0);
  }

  // Blocking persists only while its cause does: each step re-evaluates preflight,
  // ownership and the crash-loop cooldown. No retry storm and no forced repair.
  async block(reason) {
    if (this.blocked?.reason !== reason) { this.blocked = { reason, since: this.deps.now() }; this.record('blocked', { reason }); }
    this.mode = null; this.set('BLOCKED');
    await this.wait(this.policy.blockedRecheckMs);
  }
  unblock() { if (this.blocked) { this.record('unblocked', { reason: this.blocked.reason }); this.blocked = null; } }

  async launch(recovering) {
    this.unblock();
    this.set(recovering ? 'RECOVERING' : 'STARTING');
    let child;
    try { child = this.deps.spawn(); } catch { return this.fail('spawn_failed', null); }
    this.child = child; this.mode = 'managed';
    this.record('child_spawned', { pid: child.pid ?? null });
    this.publish();
    const started = this.deps.now(), outcome = await this.awaitReady(child);
    if (outcome.kind === 'aborted') return;
    if (outcome.kind === 'exited') {
      this.child = null;
      // Writer exclusion decided a concurrent launch; adopt the winner, no failure.
      if (this.deps.owner().state === 'live') { this.record('launch_race_lost'); return; }
      return this.fail('exited_during_startup', outcome.exit);
    }
    if (outcome.kind === 'timeout') {
      this.record('startup_timeout');
      child.kill('SIGTERM');
      const exited = await this.race(child.exit, this.policy.stopGraceMs);
      if (!exited) {
        // Never SIGKILL a process that may hold the writer lock; preserve and report it.
        this.record('startup_hung_process_preserved', { pid: child.pid ?? null });
        this.set('DEGRADED');
      } else { this.child = null; return this.fail('startup_timeout', exited.value); }
    } else {
      this.record('ready', { pid: child.pid ?? null, ms: this.deps.now() - started });
      this.set('HEALTHY');
    }
    const exit = await this.monitor({ pid: child.pid, exit: child.exit });
    if (this.signal.aborted || !exit) return;
    this.child = null;
    this.lastExit = { code: exit.code ?? null, signal: exit.signal ?? null, at: this.deps.now() };
    if (exit.code === 0 && !exit.signal) return this.operatorStop();
    return this.fail('unexpected_exit', exit);
  }

  async awaitReady(child) {
    const deadline = this.deps.now() + this.policy.readinessTimeoutMs;
    let exited = null; child.exit.then(exit => { exited = exit; });
    while (this.deps.now() < deadline) {
      if (this.signal.aborted) return { kind: 'aborted' };
      if (exited) return { kind: 'exited', exit: exited };
      try {
        const health = await this.deps.probe();
        if (health.healthy && health.pid === child.pid) { this.observe(health); return { kind: 'ready' }; }
      } catch {}
      await this.wait(this.policy.pollMs);
    }
    if (this.signal.aborted) return { kind: 'aborted' };
    return exited ? { kind: 'exited', exit: exited } : { kind: 'timeout' };
  }

  // Returns the child's exit, or null when an attached owner disappears or the run stops.
  async monitor({ pid, exit, alive }) {
    let wall = this.deps.now(), mono = this.deps.monotonic(), healthySince = this.deps.now();
    while (!this.signal.aborted) {
      if (exit) { const done = await this.race(exit, this.policy.healthIntervalMs); if (done) return done.value; }
      else { await this.wait(this.policy.healthIntervalMs); if (!alive()) return null; }
      if (this.signal.aborted) return null;
      // Monotonic time stops during sleep; a large wall/monotonic gap means the Mac slept.
      const nowWall = this.deps.now(), nowMono = this.deps.monotonic();
      if ((nowWall - wall) - (nowMono - mono) > this.policy.sleepGapMs) { this.record('wake_detected'); this.health.consecutive_failures = 0; }
      wall = nowWall; mono = nowMono;
      try {
        const health = await this.deps.probe();
        if (!health.healthy || health.pid !== pid) throw Error('identity');
        this.observe(health);
        if (this.state !== 'HEALTHY') { this.record('health_recovered'); this.set('HEALTHY'); healthySince = this.deps.now(); }
        if (this.deps.now() - healthySince >= this.policy.stableAfterMs && this.failures.length) { this.failures = []; this.record('stable'); }
      } catch {
        this.health.consecutive_failures++;
        // An unresponsive control plane may still hold Mission state: report, never kill.
        if (this.health.consecutive_failures >= this.policy.unhealthyThreshold && this.state !== 'DEGRADED') { this.record('health_degraded'); this.set('DEGRADED'); }
      }
      this.publish();
    }
    return null;
  }

  observe(health) {
    this.health = { consecutive_failures: 0, last_ok_at: this.deps.now() };
    // Worker readiness is reported separately; it never restarts the control plane.
    this.worker = health.opencode?.ready ? { opencode: 'READY', reason: null } : { opencode: 'DEGRADED', reason: health.opencode?.reason || 'opencode_unavailable' };
  }

  async attach(pid) {
    this.unblock(); this.mode = 'attached'; this.child = null;
    if (this.operatorStopped) { this.operatorStopped = false; this.deps.writeStopMarker?.(false); }
    this.record('adopted', { pid });
    this.set('HEALTHY');
    await this.monitor({ pid, alive: () => { const o = this.deps.owner(); return o.state === 'live' && o.pid === pid; } });
    if (this.signal.aborted) return;
    this.mode = null;
    // An unmanaged owner's exit code is not observable. A clean stop releases the
    // writer lock; a crash leaves it behind for the Bridge to reclaim.
    if (this.deps.owner().state === 'none') return this.operatorStop();
    return this.fail('adopted_service_exited', null);
  }

  operatorStop() {
    this.record('operator_stop_observed');
    this.operatorStopped = true; this.deps.writeStopMarker?.(true);
    this.set('STOPPED');
  }

  async fail(reason, exit) {
    this.failures.push(this.deps.now());
    const attempts = this.recentFailures().length, delay = backoffDelay(attempts, this.policy, this.deps.random || Math.random);
    this.lastRecovery = { at: this.deps.now(), reason, delay_ms: delay, attempts_in_window: attempts };
    this.record('child_failed', { reason, code: exit?.code ?? null, signal: exit?.signal ?? null, delay_ms: delay });
    this.set('RECOVERING');
    await this.wait(delay);
  }

  async shutdown() {
    this.set('STOPPING');
    if (this.child) {
      this.child.kill('SIGTERM');
      const exited = await Promise.race([this.child.exit.then(() => true), this.deps.sleep(this.policy.stopGraceMs).then(() => false)]);
      this.record(exited ? 'child_stopped' : 'child_stop_timeout');
      if (exited) this.child = null;
    }
    this.mode = null; this.set('STOPPED'); this.record('supervisor_stopped');
  }
}

module.exports = { Supervisor, STATES, DEFAULTS, backoffDelay };
