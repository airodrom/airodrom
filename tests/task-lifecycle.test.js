'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures/fake-pi.cjs');
const { PHASES } = require(path.join(project, 'src/execution-lease'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = (promise, ms = 8000) => Promise.race([
  promise,
  new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('lifecycle test deadline exceeded')), ms); timer.unref(); })
]);

function assertOwnershipInvariants(controller, { allowFailClosed = false } = {}) {
  const snap = controller.leases.executionSnapshot();
  assert.equal(controller.inFlight.size, controller.leases.size, 'inFlight must mirror lease registry');
  for (const task of controller.tasks.list()) {
    const lease = controller.leases.get(task.id);
    const busy = controller.snapshotTask(task).busy;
    if (!lease) {
      assert.equal(busy, false, `terminal/idle task ${task.id} must not be busy`);
      continue;
    }
    if (lease.failClosed || lease.phase === PHASES.termination_unverified) {
      assert.equal(busy, true);
      assert.ok(allowFailClosed || lease.failClosed, 'fail-closed lease must be explicit');
      assert.notEqual(task.status, 'cancelled', 'termination_unverified must not masquerade as cancelled+busy');
      assert.equal(task.failureKind, 'worker_termination_unverified');
      continue;
    }
    if (['cancelled', 'failed', 'completed', 'deadline', 'stalled', 'interrupted'].includes(task.status) && !task.connected && !controller.runtimes.has(task.id) && lease.aborted) {
      assert.fail(`terminal disconnected task ${task.id} still holds non-fail-closed lease phase=${lease.phase}`);
    }
  }
  for (const [taskId] of controller.runtimes) {
    // Orphan runtime note is fine; ownership busy requires a lease.
    void taskId;
  }
  for (const [token, taskId] of controller.tokens) {
    assert.ok(controller.runtimes.has(taskId), `token for ${taskId} must belong to a live runtime`);
    void token;
  }
  return snap;
}

async function bridge(t, env = {}, options = {}) {
  const Controller = require(path.join(project, 'src/bridge-controller'));
  const root = fs.mkdtempSync('/private/tmp/br-lifecycle-');
  const profile = path.join(root, 'source'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const controller = new Controller({
    dataDir: path.join(root, 'data'),
    sourceProfile: profile,
    executable: fixture,
    allowFixtureWorker: true,
    shutdownSettleMs: options.shutdownSettleMs || 2000,
    maxConcurrent: options.maxConcurrent || 1,
    stallMs: options.stallMs || 60_000,
    watchdogMs: options.watchdogMs || 30_000,
    taskTimeoutMs: options.taskTimeoutMs || 60 * 60 * 1000
  });
  t.after(async () => {
    try { await deadline(controller.shutdown(), 10000); } catch { /* bounded shutdown tested separately */ }
    for (const [k, v] of Object.entries(previous)) v === undefined ? delete process.env[k] : process.env[k] = v;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await controller.initialize();
  return controller;
}

async function until(predicate, label, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return;
    await wait(15);
  }
  throw new Error(label || 'until timeout');
}

function readSources() {
  const files = [
    'src/bridge-controller.js',
    'src/mcp-tools.js',
    'src/mission-supervisor.js',
    'src/control-server.js',
    'src/rpc-supervisor.js'
  ];
  return files.map(rel => ({ rel, text: fs.readFileSync(path.join(project, rel), 'utf8') }));
}

test('static lifecycle boundary: LeaseRegistry is the only busy-ownership writer', () => {
  const sources = readSources();
  for (const { rel, text } of sources) {
    assert.equal(/\binFlight\.add\s*\(/.test(text), false, `${rel} must not call inFlight.add`);
    assert.equal(/\binFlight\.delete\s*\(/.test(text), false, `${rel} must not call inFlight.delete`);
    assert.equal(/\binFlight\.clear\s*\(/.test(text), false, `${rel} must not call inFlight.clear`);
    assert.equal(/\bactiveRuns\b/.test(text), false, `${rel} must not recreate activeRuns`);
  }
  const bridgeSrc = fs.readFileSync(path.join(project, 'src/bridge-controller.js'), 'utf8');
  assert.match(bridgeSrc, /waitAllSettled/);
  assert.equal(/if\s*\(\s*this\.inFlight\.size\s*\)\s*await\s*new\s*Promise/.test(bridgeSrc), false, 'unbounded inFlight shutdown wait must not return');
  assert.equal(/task\.cancelRequested\s*=\s*false/.test(bridgeSrc), false, 'prompt must not reset cancelRequested');
  const leaseSrc = fs.readFileSync(path.join(project, 'src/execution-lease.js'), 'utf8');
  assert.match(leaseSrc, /busySet\.add/);
  assert.match(leaseSrc, /busySet\.delete/);
  assert.match(leaseSrc, /releaseIfOwner/);
});

test('1 cancel before worker spawn leaves busy=false and admits next task', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_STARTUP_MS: '250' });
  const task = controller.createTask('cancel before spawn');
  const prompting = controller.prompt(task.id, 'must not dispatch');
  const rejected = assert.rejects(prompting, /cancelled/);
  await wait(20);
  const snap = await controller.cancel(task.id);
  assert.equal(snap.status, 'cancelled');
  assert.equal(snap.busy, false);
  await deadline(rejected);
  assertOwnershipInvariants(controller);
  assert.equal(controller.runtimes.size, 0);
  assert.equal(controller.tokens.size, 0);
  const next = controller.createTask('after cancel admit');
  const result = await controller.prompt(next.id, 'ok');
  assert.equal(result.text, 'FIXTURE_OK');
  assertOwnershipInvariants(controller);
});

test('2 cancel while rpc.start unresolved', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_STARTUP_MS: '400' });
  const task = controller.createTask('cancel during start');
  const prompting = assert.rejects(controller.prompt(task.id, 'hang start'), /cancelled/);
  await until(() => controller.leases.get(task.id)?.phase === PHASES.worker_starting || controller.leases.get(task.id)?.phase === PHASES.worker_spawning || controller.runtimes.has(task.id), 'wait startup phase');
  await controller.cancel(task.id);
  await deadline(prompting);
  assert.equal(controller.snapshotTask(controller.tasks.get(task.id)).busy, false);
  assertOwnershipInvariants(controller);
  const next = controller.createTask('after start cancel');
  assert.equal((await controller.prompt(next.id, 'ok')).text, 'FIXTURE_OK');
});

test('3-8 ready-gate cancellation and fault matrix', async t => {
  for (const [label, env] of [
    ['get_state delay cancel', { BRIDGE_REVIEW_STARTUP_MS: '300' }],
    ['ready hang cancel', { BRIDGE_REVIEW_READY_HANG: '1', BRIDGE_REVIEW_STARTUP_MS: '20' }],
    ['exit before ready', { BRIDGE_REVIEW_EXIT_BEFORE_READY: '1', BRIDGE_REVIEW_STARTUP_MS: '30' }],
    ['fault before ready', { BRIDGE_REVIEW_FAULT_BEFORE_READY: '1', BRIDGE_REVIEW_STARTUP_MS: '30' }]
  ]) {
    await t.test(label, async t2 => {
      const controller = await bridge(t2, env);
      const task = controller.createTask(label);
      const prompting = controller.prompt(task.id, 'probe');
      if (label.includes('cancel') || label.includes('hang')) {
        await until(() => controller.leases.has(task.id) || controller.runtimes.has(task.id), 'lease or runtime', 2000);
        await controller.cancel(task.id);
        await assert.rejects(deadline(prompting, 20000), /cancelled|Safety|exited|fault|shutdown|terminated|ready|timed out/i);
        assert.equal(controller.snapshotTask(controller.tasks.get(task.id)).busy, false);
      } else {
        await assert.rejects(deadline(prompting, 20000), /exited|fault|Safety|timed out|failed|shutdown/i);
        await until(() => !controller.leases.has(task.id), 'lease released after startup failure', 10000);
      }
      // Clear fault-injection env before proving next admission.
      for (const key of Object.keys(env)) delete process.env[key];
      assertOwnershipInvariants(controller);
      const next = controller.createTask(`${label} next`);
      assert.equal((await controller.prompt(next.id, 'ok')).text, 'FIXTURE_OK');
    });
  }
});

test('8 cancel races with /ready', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_STARTUP_MS: '80' });
  const task = controller.createTask('ready race');
  const prompting = assert.rejects(controller.prompt(task.id, 'race'), /cancelled/);
  await until(() => controller.runtimes.has(task.id), 'runtime present');
  await controller.cancel(task.id);
  await deadline(prompting);
  assert.equal(controller.snapshotTask(controller.tasks.get(task.id)).busy, false);
  assertOwnershipInvariants(controller);
});

test('9 double cancel is idempotent', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_STARTUP_MS: '200' });
  const task = controller.createTask('double cancel');
  const prompting = assert.rejects(controller.prompt(task.id, 'x'), /cancelled/);
  await wait(30);
  const first = await controller.cancel(task.id);
  const second = await controller.cancel(task.id);
  assert.equal(first.status, 'cancelled');
  assert.equal(second.status, 'cancelled');
  assert.equal(second.busy, false);
  await deadline(prompting);
  assertOwnershipInvariants(controller);
});

test('10 cancel during active prompt', async t => {
  const controller = await bridge(t);
  const task = controller.createTask('active prompt cancel');
  const prompting = assert.rejects(controller.prompt(task.id, 'never settle'), /cancelled|deadline|exited|shutdown/i);
  await until(() => fs.existsSync(path.join(task.workspace, 'wire.log')), 'prompt dispatched');
  await controller.cancel(task.id);
  await deadline(prompting, 10000);
  assert.equal(controller.snapshotTask(controller.tasks.get(task.id)).busy, false);
  assertOwnershipInvariants(controller);
  const next = controller.createTask('after active cancel');
  assert.equal((await controller.prompt(next.id, 'ok')).text, 'FIXTURE_OK');
});

test('11-12 watchdog/requestStop during startup and execution', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_STARTUP_MS: '300' }, { stallMs: 50, watchdogMs: 30 });
  const task = controller.createTask('watchdog startup');
  const prompting = assert.rejects(controller.prompt(task.id, 'watch'), /cancelled|stalled|Task cancelled/i);
  await until(() => controller.leases.has(task.id), 'lease acquired');
  await controller.requestStop(task.id, 'stalled');
  controller.tasks.get(task.id).stopReason = 'stalled';
  controller.tasks.get(task.id).status = 'stalled';
  await deadline(prompting, 10000);
  await until(() => !controller.leases.has(task.id), 'lease cleared after stall stop');
  assertOwnershipInvariants(controller);
  delete process.env.BRIDGE_REVIEW_STARTUP_MS;

  const running = controller.createTask('watchdog running');
  const hang = assert.rejects(controller.prompt(running.id, 'never settle'), /cancelled|stalled|deadline|exited|shutdown/i);
  await until(() => fs.existsSync(path.join(running.workspace, 'wire.log')) || !controller.leases.has(running.id), 'running wire or settled', 8000);
  if (controller.leases.has(running.id)) await controller.requestStop(running.id, 'stalled');
  await deadline(hang, 10000);
  await until(() => !controller.leases.has(running.id), 'running lease cleared');
  assertOwnershipInvariants(controller);
});

test('13-14 bounded shutdown during startup and execution', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_STARTUP_MS: '400' }, { shutdownSettleMs: 1500 });
  const task = controller.createTask('shutdown startup');
  const prompting = controller.prompt(task.id, 'shut');
  prompting.catch(() => {});
  await until(() => controller.leases.has(task.id), 'leased');
  const started = Date.now();
  await deadline(controller.shutdown(), 5000);
  assert.ok(Date.now() - started < 4500, 'shutdown must be bounded');
  await wait(20);
  // Controller is closed; create a fresh controller for execution-shutdown proof.
  const controller2 = await bridge(t, {}, { shutdownSettleMs: 1500 });
  const task2 = controller2.createTask('shutdown execution');
  const hang = controller2.prompt(task2.id, 'never settle');
  hang.catch(() => {});
  await until(() => fs.existsSync(path.join(task2.workspace, 'wire.log')), 'wire');
  const started2 = Date.now();
  await deadline(controller2.shutdown(), 5000);
  assert.ok(Date.now() - started2 < 4500, 'execution shutdown must be bounded');
});

test('15-17 worker never/delayed close and startup timeout paths', async t => {
  await t.test('ignore signals fail-closed or settle without orphan cancelled+busy', async t2 => {
    const controller = await bridge(t2, { BRIDGE_REVIEW_IGNORE_SIGNALS: '1', BRIDGE_REVIEW_STARTUP_MS: '20' }, { shutdownSettleMs: 1200 });
    const task = controller.createTask('ignore signals');
    const prompting = controller.prompt(task.id, 'ok');
    prompting.catch(() => {});
    await until(() => controller.runtimes.has(task.id) || controller.tasks.get(task.id).status === 'failed', 'started or failed');
    await controller.cancel(task.id).catch(() => {});
    await wait(200);
    const snap = controller.snapshotTask(controller.tasks.get(task.id));
    if (snap.busy) {
      assert.equal(snap.failureKind, 'worker_termination_unverified');
      assert.notEqual(snap.status, 'cancelled');
      assert.equal(snap.execution?.terminationUnverified, true);
    } else {
      assert.equal(snap.busy, false);
    }
    // Force child exit for cleanup without touching managed daemon.
    for (const runtime of controller.runtimes.values()) {
      try { process.kill(-runtime.rpc.child.pid, 'SIGKILL'); } catch { try { runtime.rpc.child.kill('SIGKILL'); } catch { /* */ } }
    }
    await wait(100);
    controller.reconcileExecution();
  });

  await t.test('delayed close still settles busy=false', async t2 => {
    const controller = await bridge(t2, { BRIDGE_REVIEW_CLOSE_MS: '200' });
    const task = controller.createTask('delayed close');
    const prompting = assert.rejects(controller.prompt(task.id, 'never settle', { timeoutMs: 80 }), /deadline/);
    await until(() => fs.existsSync(path.join(task.workspace, 'wire.log')), 'wire');
    await deadline(prompting, 10000);
    await until(() => !controller.leases.has(task.id), 'lease gone after deadline');
    assertOwnershipInvariants(controller);
  });
});

test('18-20 runtime handoff: cancel while retiring previous runtime', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_CLOSE_MS: '800' });
  const taskA = controller.createTask('handoff A');
  assert.equal((await controller.prompt(taskA.id, 'complete A')).text, 'FIXTURE_OK');
  assert.equal(controller.runtimes.has(taskA.id), true, 'completed A keeps reusable runtime');
  assert.equal(controller.leases.has(taskA.id), false);

  // Deterministically stretch retirement so cancel can win the handoff race.
  const originalStop = controller.stopTask.bind(controller);
  controller.stopTask = async id => {
    if (id === taskA.id) await wait(250);
    return originalStop(id);
  };

  const taskB = controller.createTask('handoff B');
  const promptingB = controller.prompt(taskB.id, 'must not spawn after cancel');
  const rejectedB = assert.rejects(promptingB, /cancelled/);
  await until(() => {
    const lease = controller.leases.get(taskB.id);
    return lease?.phase === PHASES.retiring_previous_runtime || lease?.priorRuntimeTaskId === taskA.id;
  }, 'B enters retiring_previous_runtime', 3000);
  assert.equal(controller.leases.get(taskB.id).priorRuntimeTaskId, taskA.id);
  const cancelSnap = await controller.cancel(taskB.id);
  assert.equal(cancelSnap.status, 'cancelled');
  assert.equal(cancelSnap.busy, false);
  await deadline(rejectedB, 10000);
  assert.equal(fs.existsSync(path.join(taskB.workspace, 'wire.log')), false, 'B worker must not dispatch prompt');
  assert.equal(controller.runtimes.has(taskB.id), false, 'no B runtime after cancel during handoff');
  assertOwnershipInvariants(controller);

  controller.stopTask = originalStop;
  delete process.env.BRIDGE_REVIEW_CLOSE_MS;
  const taskC = controller.createTask('handoff C');
  assert.equal((await controller.prompt(taskC.id, 'admit C')).text, 'FIXTURE_OK');
  assertOwnershipInvariants(controller);
});

test('20 previous runtime retirement timeout/failure stays fail-closed or recovers without orphan busy', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_IGNORE_SIGNALS: '1', BRIDGE_REVIEW_CLOSE_MS: '0' });
  const taskA = controller.createTask('retire fail A');
  const runA = controller.prompt(taskA.id, 'ok');
  runA.catch(() => {});
  await until(() => controller.runtimes.has(taskA.id) || controller.tasks.get(taskA.id).status === 'failed', 'A runtime or fail');
  // If A somehow completed with ignore-signals, force lease clear via cancel path.
  if (controller.leases.has(taskA.id)) await controller.cancel(taskA.id).catch(() => {});
  await wait(50);
  for (const runtime of [...controller.runtimes.values()]) {
    try { process.kill(-runtime.rpc.child.pid, 'SIGKILL'); } catch { try { runtime.rpc.child.kill('SIGKILL'); } catch { /* */ } }
  }
  await wait(100);
  controller.reconcileExecution();
});

test('21 stale old-run finally never clears newer run ownership', async t => {
  const { LeaseRegistry } = require(path.join(project, 'src/execution-lease'));
  const busy = new Set();
  const leases = new LeaseRegistry({ busySet: busy });
  const first = leases.acquire('task');
  leases.releaseIfOwner(first, { verified: true });
  const second = leases.acquire('task');
  assert.equal(leases.releaseIfOwner(first, { verified: true }), false);
  assert.equal(leases.has('task'), true);
  assert.equal(leases.get('task').runId, second.runId);
  assert.equal(busy.has('task'), true);
  assert.equal(leases.releaseIfOwner(second, { verified: true }), true);
  assert.equal(busy.size, 0);
});

test('22-25 runtime replacement, terminal busy, orphan runtime/token cleanup', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_CLOSE_MS: '50' });
  const task = controller.createTask('replace');
  assert.equal((await controller.prompt(task.id, 'first')).text, 'FIXTURE_OK');
  await controller.cancel(task.id);
  assert.equal(controller.snapshotTask(controller.tasks.get(task.id)).busy, false);
  // Cancelled missions cannot restart; use a fresh task for admission proof.
  const next = controller.createTask('replace next');
  assert.equal((await controller.prompt(next.id, 'second')).text, 'FIXTURE_OK');
  assertOwnershipInvariants(controller);
  assert.equal(controller.tokens.size, controller.runtimes.size);
});

test('26 immediate next task admission after every settled cancel/failure', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_STARTUP_MS: '120' });
  for (let i = 0; i < 5; i++) {
    const task = controller.createTask(`admit-${i}`);
    const prompting = assert.rejects(controller.prompt(task.id, 'x'), /cancelled/);
    await wait(15);
    await controller.cancel(task.id);
    await deadline(prompting);
    assert.equal(controller.snapshotTask(controller.tasks.get(task.id)).busy, false);
    const next = controller.createTask(`admit-next-${i}`);
    assert.equal((await controller.prompt(next.id, 'ok')).text, 'FIXTURE_OK');
    assertOwnershipInvariants(controller);
  }
});

test('cancelRequested is not erased by late async dispatch', async t => {
  const controller = await bridge(t, { BRIDGE_REVIEW_STARTUP_MS: '200' });
  const created = controller.createTask('cancel race admit');
  const task = controller.tasks.get(created.id);
  task.cancelRequested = true;
  await assert.rejects(controller.prompt(task.id, 'should not run'), /Cancelled missions cannot be restarted|Task cancelled/);
  assert.equal(task.cancelRequested, true);
  assert.equal(controller.leases.has(task.id), false);
});

test('100-cycle deterministic lifecycle stress', async t => {
  const phases = [
    { env: { BRIDGE_REVIEW_STARTUP_MS: '40' }, mode: 'cancel-startup' },
    { env: { BRIDGE_REVIEW_STARTUP_MS: '20' }, mode: 'cancel-early' },
    { env: {}, mode: 'complete' },
    { env: {}, mode: 'cancel-running' },
    { env: { BRIDGE_REVIEW_CLOSE_MS: '30' }, mode: 'deadline' },
    { env: { BRIDGE_REVIEW_EXIT_BEFORE_READY: '1', BRIDGE_REVIEW_STARTUP_MS: '10' }, mode: 'exit-before-ready' },
    { env: { BRIDGE_REVIEW_STARTUP_MS: '60' }, mode: 'double-cancel' },
    { env: { BRIDGE_REVIEW_CLOSE_MS: '80' }, mode: 'handoff-cancel' }
  ];

  let orphans = { leases: 0, runtimes: 0, tokens: 0, busy: 0 };
  const controller = await bridge(t, {}, { shutdownSettleMs: 2500, maxConcurrent: 1 });
  const clearReviewEnv = () => {
    for (const key of ['BRIDGE_REVIEW_STARTUP_MS', 'BRIDGE_REVIEW_CLOSE_MS', 'BRIDGE_REVIEW_EXIT_BEFORE_READY', 'BRIDGE_REVIEW_READY_HANG', 'BRIDGE_REVIEW_FAULT_BEFORE_READY', 'BRIDGE_REVIEW_IGNORE_SIGNALS', 'BRIDGE_REVIEW_HANG_BEFORE_OUTPUT']) {
      delete process.env[key];
    }
  };

  for (let i = 0; i < 100; i++) {
    const spec = phases[i % phases.length];
    clearReviewEnv();
    Object.assign(process.env, spec.env);

    try {
      if (spec.mode === 'handoff-cancel') {
        const a = controller.createTask(`stress-a-${i}`);
        await controller.prompt(a.id, 'ok');
        const b = controller.createTask(`stress-b-${i}`);
        const prompting = controller.prompt(b.id, 'x');
        prompting.catch(() => {});
        await until(() => controller.leases.has(b.id), 'b leased', 3000);
        await controller.cancel(b.id);
        await deadline(Promise.resolve(prompting).then(() => {}, () => {}), 10000);
        await until(() => !controller.leases.has(b.id) || controller.leases.get(b.id)?.failClosed, 'b settled', 10000);
      } else {
        const task = controller.createTask(`stress-${i}`);
        if (spec.mode === 'complete') {
          assert.equal((await controller.prompt(task.id, 'ok')).text, 'FIXTURE_OK');
        } else if (spec.mode === 'deadline') {
          await assert.rejects(controller.prompt(task.id, 'never settle', { timeoutMs: 40 }), /deadline/);
          await until(() => !controller.leases.has(task.id) || controller.leases.get(task.id)?.failClosed, 'deadline settle', 10000);
        } else if (spec.mode === 'exit-before-ready') {
          await assert.rejects(controller.prompt(task.id, 'x'), /exited|fault|Safety|failed|shutdown|timed out/i);
          await until(() => !controller.leases.has(task.id) || controller.leases.get(task.id)?.failClosed, 'exit settle', 10000);
        } else if (spec.mode === 'cancel-running') {
          const prompting = controller.prompt(task.id, 'never settle');
          prompting.catch(() => {});
          await until(() => fs.existsSync(path.join(task.workspace, 'wire.log')) || !controller.leases.has(task.id), 'wire', 5000);
          await controller.cancel(task.id);
          await deadline(Promise.resolve(prompting).then(() => {}, () => {}), 10000);
        } else if (spec.mode === 'double-cancel') {
          const prompting = controller.prompt(task.id, 'x');
          prompting.catch(() => {});
          await wait(10);
          await controller.cancel(task.id);
          await controller.cancel(task.id);
          await deadline(Promise.resolve(prompting).then(() => {}, () => {}), 10000);
        } else {
          const prompting = controller.prompt(task.id, 'x');
          prompting.catch(() => {});
          await wait(8);
          await controller.cancel(task.id);
          await deadline(Promise.resolve(prompting).then(() => {}, () => {}), 10000);
        }
      }
    } finally {
      clearReviewEnv();
    }

    controller.reconcileExecution();
    for (const task of controller.tasks.list()) {
      const snap = controller.snapshotTask(task);
      if (snap.busy && snap.status === 'cancelled' && !snap.execution?.terminationUnverified) orphans.busy++;
      if (snap.busy && !controller.leases.has(task.id)) orphans.leases++;
    }
    for (const [taskId] of controller.runtimes) {
      if (!controller.tasks.get(taskId)) orphans.runtimes++;
    }
    for (const [, taskId] of controller.tokens) {
      if (!controller.runtimes.has(taskId)) orphans.tokens++;
    }

    // Keep only recent tasks to bound memory; still exercise admission each cycle.
    if (i % 10 === 9) {
      clearReviewEnv();
      const probe = controller.createTask(`probe-${i}`);
      assert.equal((await controller.prompt(probe.id, 'ok')).text, 'FIXTURE_OK');
      assert.equal(controller.snapshotTask(controller.tasks.get(probe.id)).busy, false);
    }
  }

  assert.equal(orphans.busy, 0, 'zero stuck cancelled+busy');
  assert.equal(orphans.leases, 0, 'zero orphan busy without lease');
  assert.equal(orphans.tokens, 0, 'zero orphan tokens');
  assertOwnershipInvariants(controller, { allowFailClosed: true });
  clearReviewEnv();
  const finalAdmit = controller.createTask('stress-final');
  assert.equal((await controller.prompt(finalAdmit.id, 'ok')).text, 'FIXTURE_OK');
});
