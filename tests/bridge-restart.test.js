'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const SafetyPolicy = require('../src/safety-policy');
const { CapabilityBroker, validateToolInput, BRIDGE_RESTART_JOB, BRIDGE_RESTART_STATUS_JOB } = require('../src/capability-broker');
const {
  requestRestart, executeRestart, statusRestart, readReceipt, clearLock, writeReceipt, COOLDOWN_MS
} = require('../src/bridge-restart');
const BridgeController = require('./fixtures/test-bridge.cjs');

function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bridge-restart-'));
  const runtimeDir = path.join(root, '.runtime');
  const repoRoot = root;
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(repoRoot, 'scripts/macos'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'bridge.lock'), '4242\n', { mode: 0o600 });
  fs.writeFileSync(path.join(repoRoot, 'scripts/macos/restart-handoff.cjs'), '// fixture placeholder\n');
  return { root, runtimeDir, repoRoot };
}

function brokerFixture(t, { requireGrant = false, bridgeRestart } = {}) {
  const { root, runtimeDir, repoRoot } = tempRuntime();
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(root, 'ws-')));
  const task = {
    id: 'task-restart-001', sessionId: 'session-restart-001', workspace,
    mission: { id: 'mission-restart', requireGrant, status: 'active', used: { runtimeMs: 0, actions: 0, retries: 0 }, budget: { maxRuntimeMs: 60_000, maxActions: 20, maxRetries: 0, maxSpendMicros: 0 } },
    status: 'thinking', safetyLoaded: true, events: [], cancelRequested: false
  };
  const policy = new SafetyPolicy({ trustedDeveloperMode: true });
  policy.registerTask(task);
  const diagnostics = { read: async () => 'unused' };
  const runner = {
    describeJob() { throw new Error('Sandbox job is not approved: unexpected'); },
    async run() { throw new Error('sandbox must not run'); }
  };
  const ledger = [];
  const broker = new CapabilityBroker({
    policy, diagnostics, getTask: id => id === task.id ? task : null, runner,
    repoRoot, runtimeDir, bridgeRestart,
    trustedDeveloperAllowed: () => false,
    onAuthorized: current => { current.mission.used.actions++; },
    onCompleted: (_task, toolName, output, request) => ledger.push({ toolName, output, request })
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, runtimeDir, repoRoot, task, policy, broker, ledger };
}

test('bridge_restart accepts only jobName and rejects command/cwd/env/target injection', async t => {
  const f = brokerFixture(t, {
    bridgeRestart: {
      describeMaintenanceJob: name => ({ name, kind: 'bridge-maintenance', acceptsTarget: false }),
      requestRestart: () => ({ request_id: randomUUID(), outcome: 'handed_off', old_pid: 4242, helper_pid: 99 }),
      statusRestart: () => ({ available: true, outcome: 'handed_off' })
    }
  });

  assert.throws(() => validateToolInput('run_job', { jobName: BRIDGE_RESTART_JOB, target: '/tmp/evil' }), /only jobName|Bridge maintenance/);
  assert.throws(() => validateToolInput('run_job', { jobName: BRIDGE_RESTART_JOB, command: 'rm -rf /' }), /Invalid run_job|only jobName/);
  assert.throws(() => validateToolInput('run_job', { jobName: BRIDGE_RESTART_JOB, cwd: '/tmp' }), /Invalid run_job|only jobName/);
  assert.throws(() => validateToolInput('run_job', { jobName: BRIDGE_RESTART_JOB, env: { PATH: '/evil' } }), /Invalid run_job|only jobName/);
  assert.throws(() => validateToolInput('run_job', { jobName: BRIDGE_RESTART_JOB, executable: '/bin/sh' }), /Invalid run_job|only jobName/);

  const injected = await f.broker.execute(f.task.id, {
    toolName: 'run_job', toolCallId: 'inject-1',
    input: { jobName: BRIDGE_RESTART_JOB, target: 'scripts/evil.cjs' }
  });
  assert.equal(injected.allow, false);
  assert.equal(injected.decision.kind, 'invalid_tool_arguments');

  const ok = await f.broker.execute(f.task.id, {
    toolName: 'run_job', toolCallId: 'restart-1', input: { jobName: BRIDGE_RESTART_JOB }
  });
  assert.equal(ok.allow, true, JSON.stringify(ok));
  assert.equal(f.policy.list(f.task.id).some(a => a.status === 'pending'), false, 'bridge_restart must not require approval');
  const payload = JSON.parse(ok.output);
  assert.equal(payload.name, BRIDGE_RESTART_JOB);
  assert.equal(payload.kind, 'bridge-maintenance');
  assert.equal(payload.outcome, 'handed_off');
});

test('unknown jobs remain denied and other run_job policy is unchanged', async t => {
  const f = brokerFixture(t);
  const unknown = await f.broker.execute(f.task.id, {
    toolName: 'run_job', toolCallId: 'unknown-1', input: { jobName: 'not_a_real_job' }
  });
  assert.equal(unknown.allow, false);
  assert.match(unknown.decision.reason, /Pinned job verification failed|not approved|not a pinned/);

  const granted = brokerFixture(t, { requireGrant: true });
  const deniedGrant = await granted.broker.execute(granted.task.id, {
    toolName: 'run_job', toolCallId: 'grant-1', input: { jobName: BRIDGE_RESTART_JOB }
  });
  assert.equal(deniedGrant.allow, false);
  assert.equal(deniedGrant.decision.kind, 'mission_grant_denied');
});

test('assistant fake run_job markup remains inert at the broker boundary', async t => {
  const f = brokerFixture(t);
  const fake = await f.broker.execute(f.task.id, {
    toolName: 'run_job',
    toolCallId: 'fake-text',
    input: { jobName: '<function=run_job>' }
  });
  assert.equal(fake.allow, false);
});

test('restart handoff lock, cooldown, idempotency, detached survivor, and receipt are fail-closed', async t => {
  const { root, runtimeDir, repoRoot } = tempRuntime();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requestId = randomUUID();
  let helperRuns = 0;
  const spawnImpl = () => {
    helperRuns += 1;
    const child = new EventEmitter();
    child.pid = 55_000 + helperRuns;
    child.unref = () => {};
    queueMicrotask(async () => {
      await executeRestart({
        runtimeDir, repoRoot, requestId,
        waitMs: 5,
        restartInvoker: async () => ({
          ok: true, recovered: false,
          status: { state: 'Connected', managed: true, pid: 7777, mcp: { ready: true } }
        })
      });
    });
    return child;
  };

  const first = requestRestart({ runtimeDir, repoRoot, requestId, spawnImpl, now: 1_000 });
  assert.equal(first.outcome, 'handed_off');
  assert.equal(first.old_pid, 4242);
  assert.ok(first.helper_pid);

  const replay = requestRestart({ runtimeDir, repoRoot, requestId, spawnImpl, now: 1_100 });
  assert.ok(['handed_off', 'idempotent_replay', 'completed'].includes(replay.outcome));
  assert.equal(helperRuns, 1, 'duplicate request must not spawn another helper');

  for (let i = 0; i < 50; i++) {
    const receipt = readReceipt(runtimeDir);
    if (receipt?.outcome === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const completed = readReceipt(runtimeDir);
  assert.equal(completed.outcome, 'completed');
  assert.equal(completed.new_pid, 7777);
  assert.equal(completed.mcp_ready, true);

  // Parent process exiting is simulated by only the helper updating the receipt.
  assert.equal(statusRestart(runtimeDir).outcome, 'completed');

  const concurrentId = randomUUID();
  // Force an active lock without a completed cooldown window by writing a fresh lock.
  writeReceipt(runtimeDir, {
    ...completed,
    completed_at: new Date(Date.now()).toISOString(),
    outcome: 'completed'
  });
  await assert.rejects(
    async () => requestRestart({ runtimeDir, repoRoot, requestId: concurrentId, spawnImpl, now: Date.now() }),
    error => error.code === 'BRIDGE_RESTART_COOLDOWN'
  );

  // After cooldown, a new request can proceed; concurrent lock still rejects storms.
  clearLock(runtimeDir);
  writeReceipt(runtimeDir, {
    ...completed,
    completed_at: new Date(Date.now() - COOLDOWN_MS - 5).toISOString(),
    outcome: 'completed'
  });
  let locked = false;
  const blockingSpawn = () => {
    locked = true;
    const child = new EventEmitter();
    child.pid = 66_001;
    child.unref = () => {};
    return child;
  };
  const next = requestRestart({
    runtimeDir, repoRoot, requestId: randomUUID(), spawnImpl: blockingSpawn, now: Date.now()
  });
  assert.equal(next.outcome, 'handed_off');
  assert.equal(locked, true);
  await assert.rejects(
    async () => requestRestart({ runtimeDir, repoRoot, requestId: randomUUID(), spawnImpl: blockingSpawn, now: Date.now() }),
    error => error.code === 'BRIDGE_RESTART_CONCURRENT'
  );

  const stale = statusRestart(path.join(root, 'missing-runtime'));
  assert.equal(stale.available, false);
  assert.equal(stale.outcome, 'stale');
});

test('bridge_restart_status is read-only and can verify completed receipts without restarting', async t => {
  const requestId = randomUUID();
  const f = brokerFixture(t, {
    bridgeRestart: {
      describeMaintenanceJob: name => ({ name, kind: 'bridge-maintenance' }),
      requestRestart: () => { throw new Error('status must not restart'); },
      statusRestart: () => ({
        available: true, request_id: requestId, outcome: 'completed', mcp_ready: true,
        old_pid: 1, new_pid: 2, bridge_state: 'Connected', handed_off_at: new Date().toISOString(),
        completed_at: new Date().toISOString(), requested_at: new Date().toISOString()
      })
    }
  });
  const status = await f.broker.execute(f.task.id, {
    toolName: 'run_job', toolCallId: 'status-1', input: { jobName: BRIDGE_RESTART_STATUS_JOB }
  });
  assert.equal(status.allow, true);
  assert.equal(JSON.parse(status.output).outcome, 'completed');
  assert.equal(f.policy.list(f.task.id).length, 0);
});

test('bridge controller records restart requested/verified ledger events without secret leakage', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bridge-restart-ledger-'));
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const dataDir = path.join(root, 'data');
  const bridge = await new BridgeController({ defaultRuntime: 'host',
    dataDir, sourceProfile: profile,
    executable: path.join(__dirname, 'fixtures/host-worker.cjs'), allowFixtureWorker: true
  }).initialize();
  t.after(async () => { await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });

  const task = bridge.tasks.get(bridge.createTask('Bridge restart ledger fixture').id);
  const requestId = randomUUID();
  bridge.capabilityBroker.bridgeRestart = {
    describeMaintenanceJob: name => ({ name, kind: 'bridge-maintenance' }),
    requestRestart: () => ({
      request_id: requestId, outcome: 'handed_off', old_pid: 111, helper_pid: 222,
      requested_at: new Date().toISOString(), handed_off_at: new Date().toISOString()
    }),
    statusRestart: () => ({
      available: true, request_id: requestId, outcome: 'completed', mcp_ready: true,
      old_pid: 111, new_pid: 333, bridge_state: 'Connected',
      requested_at: new Date().toISOString(), handed_off_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    })
  };
  bridge.capabilityBroker.runtimeDir = dataDir;
  bridge.capabilityBroker.repoRoot = path.resolve(__dirname, '..');

  const restart = await bridge.capabilityBroker.execute(task.id, {
    toolName: 'run_job', toolCallId: 'ledger-restart-1', input: { jobName: BRIDGE_RESTART_JOB }
  });
  assert.equal(restart.allow, true);
  const requested = bridge.ledger.list({ taskId: task.id, eventType: 'bridge.restart.requested', limit: 5 }).events;
  assert.equal(requested.length, 1);
  assert.equal(JSON.stringify(requested[0]).includes(dataDir), false);

  const verifiedCall = await bridge.capabilityBroker.execute(task.id, {
    toolName: 'run_job', toolCallId: 'ledger-status-1', input: { jobName: BRIDGE_RESTART_STATUS_JOB }
  });
  assert.equal(verifiedCall.allow, true);
  const verified = bridge.ledger.list({ taskId: task.id, eventType: 'bridge.restart.verified', limit: 5 }).events;
  assert.equal(verified.length, 1);
  assert.equal(verified[0].metadata.request_id, requestId);
  assert.equal(verified[0].metadata.new_pid, 333);
});

test('failed request replay never dispatches twice; late recovery is explicitly persisted', t => {
  const {root,runtimeDir,repoRoot}=tempRuntime();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const requestId=randomUUID(),requested_at=new Date(1000).toISOString();
  writeReceipt(runtimeDir,{request_id:requestId,requested_at,outcome:'failed',failure_class:'readiness_timeout',old_pid:4242,mcp_ready:false});
  assert.equal(requestRestart({runtimeDir,repoRoot,requestId,spawnImpl:()=>{throw Error('duplicate dispatch')}}).outcome,'failed');
  for(const probe of [{ready:false},{ready:true,status:{pid:4242},started_ms:2000},{ready:true,status:{pid:7777},started_ms:999}]) {
    assert.equal(statusRestart(runtimeDir,{reconcileProbe:()=>probe}).outcome,'failed');
  }
  const recovered=statusRestart(runtimeDir,{now:3000,reconcileProbe:()=>({ready:true,status:{pid:7777},started_ms:2000})});
  assert.equal(recovered.outcome,'recovered_after_timeout');assert.equal(recovered.failure_class,'readiness_timeout');
  assert.equal(readReceipt(runtimeDir).new_pid,7777);assert.equal(recovered.cooldown_active,true);
});


test('restart receipts distinguish bounded recovery and reject unmanaged readiness', async t => {
  for (const managed of [true, false]) {
    const {root,runtimeDir,repoRoot}=tempRuntime();
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const requestId=randomUUID();
    const child=new EventEmitter();child.pid=66001;child.unref=()=>{};
    requestRestart({runtimeDir,repoRoot,requestId,spawnImpl:()=>child});
    const execute=()=>executeRestart({runtimeDir,repoRoot,requestId,waitMs:0,sleepImpl:async()=>{},
      restartInvoker:async()=>({ok:true,recovered:true,status:{state:'Connected',managed,pid:7777,mcp:{ready:true}}})});
    if(managed){
      const receipt=await execute();assert.equal(receipt.outcome,'completed_after_recovery');
      assert.equal(statusRestart(runtimeDir).cooldown_active,true);
      assert.equal(requestRestart({runtimeDir,repoRoot,requestId,spawnImpl:()=>{throw Error('replay')}}).outcome,'completed_after_recovery');
    } else {await assert.rejects(execute,/readiness/);assert.equal(readReceipt(runtimeDir).outcome,'failed');}
  }
});

test('terminal restart failure cannot be reclassified as a late timeout recovery', t => {
  const {root,runtimeDir}=tempRuntime();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  writeReceipt(runtimeDir,{request_id:randomUUID(),requested_at:new Date(1000).toISOString(),outcome:'failed',failure_class:'restart_failed',old_pid:4242});
  assert.equal(statusRestart(runtimeDir,{reconcileProbe:()=>({ready:true,status:{pid:7777},started_ms:2000})}).outcome,'failed');
});
