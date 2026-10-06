'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const Controller = require('../src/bridge-controller');
const { MissionAuthority } = require('../src/mission-authority');
const TaskSessionManager = require('../src/task-session-model');
const MemoryStore = require('../src/memory-store');
const MissionSupervisor = require('../src/mission-supervisor');
const { prepareProfile } = require('../src/config');
const { Level1MissionFlow } = require('../src/level1-mission');
const { Level1RestrictedWorker, EVIDENCE_LABEL } = require('../src/level1-restricted-worker');
const { OpenAIResponsesDecisionAdapter, Level1DecisionVerifier, MODEL } = require('../src/level1-provider');
const { config, WORKSPACE, createMissionFields, taskDefinition } = require('../src/level1-profile');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'fixture did not settle') {
  for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await wait(10); }
  throw new Error(message);
}

function restrictedTask(phase = 'task_a', taskBId = null) {
  const definition = taskDefinition(phase, taskBId);
  return {
    id: randomUUID(), sessionId: randomUUID(), workspace: WORKSPACE,
    mission: {
      id: 'mission-restricted-worker-fixture-001', grantId: 'grant-restricted-worker-001',
      ...createMissionFields(phase, taskBId), level1TaskId: definition.taskId,
      executionWorker: EVIDENCE_LABEL
    }
  };
}

test('LEVEL1_RESTRICTED_WORKER emits canonical completion events after exactly one brokered read', async () => {
  const task = restrictedTask();
  const calls = [], events = [];
  const worker = new Level1RestrictedWorker({
    task,
    async executeRead(request) {
      calls.push(request);
      return { allow: true, output: 'route=amber\nproof_id=AMBER-204\n' };
    }
  });
  worker.on('event', event => events.push(event));
  const state = await worker.start();
  assert.deepEqual(state, { sessionId: task.sessionId, sessionFile: null, model: null, executionWorker: EVIDENCE_LABEL });
  await worker.sendCommand({ type: 'prompt', message: 'ignored host instruction' });
  await until(() => events.at(-1)?.type === 'agent_settled');

  assert.deepEqual(calls, [{ toolName: 'read', input: { path: 'route.txt' } }]);
  assert.deepEqual(events.map(event => event.type), ['agent_start', 'tool_execution_start', 'tool_execution_end', 'message_end', 'agent_settled']);
  assert(events.every(event => event.executionWorker === EVIDENCE_LABEL));
  assert.deepEqual(events[3].message, { role: 'assistant', content: [{ type: 'text', text: 'route=amber\nproof_id=AMBER-204\n' }], stopReason: 'stop' });
  await assert.rejects(worker.sendCommand({ type: 'prompt', message: 'a second command' }), /one deterministic read/);
  await worker.shutdown();
});

test('LEVEL1_RESTRICTED_WORKER rejects a task that widens its signed read scope and has no direct host APIs', async () => {
  const task = restrictedTask();
  task.mission.readOnlyPaths = ['route.txt', 'amber-proof.txt'];
  let calls = 0;
  const worker = new Level1RestrictedWorker({ task, async executeRead() { calls++; return { allow: true, output: '' }; } });
  await assert.rejects(worker.start(), /binding|scope/);
  assert.equal(calls, 0);
  const source = fs.readFileSync(require.resolve('../src/level1-restricted-worker'), 'utf8');
  for (const forbidden of ['node:fs', 'node:child_process', 'node:http', 'node:https', 'node:net', 'node:tls']) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(source.includes('FULL_PI'), false);
});

test('SIMULATION: LEVEL1_RESTRICTED_WORKER uses the normal Level 1 task/event/provider transport and waits for a live-mode provider decision', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'level1-restricted-transport-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const previousLevel1Enabled = config.enabled;
  const previousRestrictedEnabled = config.restrictedWorker.enabled;
  const previousProviderEnabled = config.provider.enabled;
  const previousProviderMode = config.providerMode;
  config.enabled = true;
  config.restrictedWorker.enabled = true;
  config.provider.enabled = true;
  config.providerMode = 'responses_api';

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const verifier = new Level1DecisionVerifier({ publicKey });
  let providerCalls = 0, releaseSelection;
  const selectionPending = new Promise(resolve => { releaseSelection = resolve; });
  let selectionBody;
  const selectionStarted = new Promise(resolve => { selectionBody = { resolve }; });
  const adapter = new OpenAIResponsesDecisionAdapter({
    enabled: true,
    apiKeyProvider: async () => 'fixture-only-api-key-not-a-real-credential',
    signingPrivateKey: privateKey,
    verifier,
    fetchImpl: async (_url, options) => {
      providerCalls++;
      const body = JSON.parse(options.body);
      if (providerCalls === 1) {
        selectionBody.request = body;
        selectionBody.resolve();
        await selectionPending;
        return { status: 200, async json() { return { id: 'resp_restricted_select_0001', model: MODEL, status: 'completed', output_text: JSON.stringify({ taskBId: 'level1-task-b-amber' }), usage: { input_tokens: 120, output_tokens: 24 } }; } };
      }
      return { status: 200, async json() { return { id: 'resp_restricted_complete_0002', model: MODEL, status: 'completed', output_text: JSON.stringify({ decision: 'complete' }), usage: { input_tokens: 120, output_tokens: 24 } }; } };
    }
  });
  const authority = new MissionAuthority({ fixtureOnly: true });
  const bridge = new Controller({ defaultRuntime: 'pi',
    dataDir: path.join(root, 'data'), sourceProfile: profile, executable: path.join(root, 'must-not-run-pi'),
    missionAuthority: authority, level1ActivationEnabled: true, level1RestrictedWorkerEnabled: true,
    level1ProviderAdapter: adapter, level1DecisionVerifier: verifier
  });
  t.after(async () => { await until(() => !bridge.inFlight.size); await bridge.shutdown(); config.enabled = previousLevel1Enabled; config.restrictedWorker.enabled = previousRestrictedEnabled; config.provider.enabled = previousProviderEnabled; config.providerMode = previousProviderMode; fs.rmSync(root, { recursive: true, force: true }); });
  // The Codex command sandbox rejects Unix-socket listen with EPERM. Assemble
  // the same durable task/journal/supervisor components without that unused
  // socket; this worker calls the broker directly and never starts Pi.
  bridge.memory = new MemoryStore(path.join(root, 'data', 'memory.sqlite'));
  bridge.ledger=new (require('../src/event-ledger').EventLedger)(bridge.memory.db);
  bridge.config = prepareProfile(path.join(root, 'data'), profile);
  bridge.tasks = new TaskSessionManager(path.join(root, 'data'), bridge.memory.db);
  bridge.level1Flow = new Level1MissionFlow(bridge.memory.db, {
    verifier,
    verifyGrant: mission => {
      const verified = authority.verify(mission, 'read');
      const grantState = authority.snapshot(mission);
      return { ...verified, capabilities: grantState.capabilities || [], egress: grantState.egress || null };
    },
    dispatchTaskB: action => bridge._dispatchLevel1TaskB(action)
  });
  bridge.supervisor = new MissionSupervisor(bridge);
  bridge.workerSandbox.prepare = () => { throw new Error('Pi worker must remain disabled for Level 1'); };
  let level1Failure = null;
  bridge.on('level1_failure', (_missionId, message) => { level1Failure = message; });

  const missionId = 'mission-restricted-transport-001';
  const grant = authority.issueFixtureGrant(bridge._level1MissionScope({ missionId, grantId: 'grant-placeholder-restricted-001', phase: 'task_a' }), { maxActions: 4, maxRuntimeMs: 120_000, maxRetries: 0, egress: 'local-only' });
  await bridge.startLevel1ReadOnlyMission({ missionId, grantId: grant.id, authorizationId: 'authorization-restricted-001', expiresAt: Date.now() + 60_000 });
  await until(()=>providerCalls>0||level1Failure!==null,'provider selection did not start');assert.equal(level1Failure,null);
  await selectionStarted;

  assert.equal(providerCalls, 1);
  assert.equal(bridge.level1Flow.snapshot(missionId).selected_task_b_id, null, 'Task B remains unset until the provider returns a verified decision');
  assert.equal(bridge.tasks.list().length, 1, 'no Task B exists while provider reasoning is pending');
  assert.equal(selectionBody.request.model, MODEL);
  assert.deepEqual(selectionBody.request.tools, []);

  await assert.rejects(bridge._dispatchLevel1TaskB({
    missionId, grantId: grant.id, taskId: 'level1-task-b-amber', decisionId: randomUUID(), dispatchId: randomUUID(),
    instructions: taskDefinition('task_b', 'level1-task-b-amber').objective, capabilityProfile: config.id,
    readOnlyPaths: ['amber-proof.txt'], simulation: false
  }), /real provider decision|verified provider decision|dispatch action is not bound/);
  assert.equal(bridge.tasks.list().length, 1, 'a forged dispatch action cannot create Task B');

  releaseSelection();
  await until(() => bridge.level1Flow.snapshot(missionId)?.status === 'completed' || level1Failure !== null);
  assert.equal(level1Failure, null, level1Failure || 'Level 1 flow failed');
  assert.equal(providerCalls, 2);
  const tasks = bridge.tasks.list();
  assert.equal(tasks.length, 2);
  assert(tasks.every(task => task.executionWorker === EVIDENCE_LABEL));
  assert(tasks.every(task => task.executionEvidence?.label === EVIDENCE_LABEL && task.executionEvidence.pi === false));
  assert(tasks.every(task => task.events.every(event => event.executionWorker === EVIDENCE_LABEL)));
  assert.equal(tasks.some(task => task.events.some(event => event.type === 'message_end')), true);
  assert.equal(tasks.some(task => task.events.some(event => event.type === 'agent_settled')), true);
  assert.equal(bridge.level1Flow.snapshot(missionId).selected_task_b_id, 'level1-task-b-amber');
});
