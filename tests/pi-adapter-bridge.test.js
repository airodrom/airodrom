'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const BridgeController = require('../src/bridge-controller');

async function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/pi-adapter-bridge-');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const bridge = await new BridgeController({ defaultRuntime: 'pi',
    dataDir: path.join(root, 'data'), sourceProfile: profile,
    executable: path.join(__dirname, 'fixtures/fake-pi.cjs'), allowFixtureWorker: true
  }).initialize();
  t.after(async () => { await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return bridge;
}

function script(steps) {
  return `FIXTURE_POLICY_SCRIPT:${Buffer.from(JSON.stringify(steps)).toString('base64')}`;
}

test('Bridge routes Pi create, continuation, cancellation, status, events, and brokered approval through PiAdapter', async t => {
  const bridge = await fixture(t);
  const adapter = bridge.agentRouter.resolve('pi');
  const observed = { start: 0, dispatch: 0, status: 0, cancel: 0, shutdown: 0 };
  for (const name of Object.keys(observed)) {
    const original = adapter[name].bind(adapter);
    adapter[name] = async (...args) => { observed[name]++; return original(...args); };
  }

  assert.throws(
    () => bridge.createTask('unknown execution agent', { executionAgent: 'missing_adapter' }),
    error => error?.code === 'AGENT_ADAPTER_UNAVAILABLE'
  );
  const task = bridge.tasks.get(bridge.createTask('Pi adapter compatibility fixture').id);
  assert.equal(task.executionAgent, 'pi');
  assert.equal((await bridge.prompt(task.id, 'first Pi turn')).text, 'FIXTURE_OK');
  assert.equal((await bridge.prompt(task.id, 'second Pi turn')).text, 'FIXTURE_OK');
  assert.ok(observed.start >= 2);
  assert.equal(observed.dispatch, 2);
  assert.ok(observed.status >= 2);
  assert.ok(bridge.snapshotTask(task).events.some(event => event.agentId === 'pi'), 'Pi events are normalized at the adapter boundary');

  const approvalTask = bridge.tasks.get(bridge.createTask('Pi adapter approval fixture').id);
  await bridge.prompt(approvalTask.id, script([{ path: '/capability', body: {
    toolName: 'project_create', toolCallId: 'adapter-approval-1', input: { name: 'Adapter approval project' }
  } }]));
  assert.equal(bridge.policy.list(approvalTask.id).length, 1, 'Pi tool request reaches bridge-owned approval policy');
  assert.equal(bridge.policy.list(approvalTask.id)[0].status, 'pending');
  assert.ok(bridge.capabilityBroker.audit.some(entry => entry.taskId === approvalTask.id && entry.toolName === 'project_create'));

  const cancellationTask = bridge.tasks.get(bridge.createTask('Pi adapter cancellation fixture').id);
  const activePrompt = bridge.prompt(cancellationTask.id, 'never settle');
  for (let attempt = 0; attempt < 20 && !bridge.runtimes.has(cancellationTask.id); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(bridge.runtimes.has(cancellationTask.id), 'fixture prompt owns a live runtime before cancellation');
  await bridge.cancel(cancellationTask.id);
  await activePrompt.catch(() => {});
  assert.ok(observed.cancel >= 1);
  assert.ok(observed.shutdown >= 1);
  assert.equal(bridge.snapshotTask(cancellationTask).busy, false);
});
