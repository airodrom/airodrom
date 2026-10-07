'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, generateKeyPairSync, sign } = require('node:crypto');
const SafetyPolicy = require('../src/safety-policy');
const { MissionAuthority } = require('../src/mission-authority');
const { SafeDiagnostics } = require('../src/safe-diagnostics');
const { CapabilityBroker } = require('../src/capability-broker');
const { Level1AcceptanceRecorder, evaluateAcceptance, EXPECTED } = require('../src/level1-acceptance');
const { OpenAIResponsesDecisionAdapter, Level1DecisionVerifier, ENDPOINT, MODEL, MAX_TURN_COST_MICROS, ISSUER, AUDIENCE } = require('../src/level1-provider');
const { Level1MissionFlow, hash } = require('../src/level1-mission');
const { config, WORKSPACE, MISSION_OBJECTIVE, ACCEPTANCE_CRITERIA, ALL_READ_PATHS, createMissionFields } = require('../src/level1-profile');
const { canonical } = require('../src/mission-provider');
const { makeWorkerProfile } = require('../src/sandbox-policy');


function fixtureAuthority() {
  const authority = new MissionAuthority({ fixtureOnly: true });
  const mission = {
    id: 'mission-level1-authority-001', objective: MISSION_OBJECTIVE, criteria: [...ACCEPTANCE_CRITERIA], workspace: WORKSPACE,
    scope: { workspace: WORKSPACE, readOnlyPaths: [...ALL_READ_PATHS] },
    ...createMissionFields('task_a')
  };
  const grant = authority.issueFixtureGrant(mission, { maxActions: 4, maxRuntimeMs: 120_000, maxRetries: 0, egress: 'local-only' });
  mission.grantId = grant.id; mission.requireGrant = true; mission.used = { actions: 0, runtimeMs: 0, retries: 0 };
  mission.budget = { ...config.grant };
  return { authority, mission, grant };
}

function brokerFixture() {
  const { authority, mission, grant } = fixtureAuthority();
  const task = { id: randomUUID(), sessionId: randomUUID(), workspace: WORKSPACE, mission: structuredClone(mission), status: 'thinking', cancelRequested: false };
  const policy = new SafetyPolicy({ missionAuthority: authority });
  policy.registerTask(task);
  const diagnostics = new SafeDiagnostics(policy);
  const broker = new CapabilityBroker({ policy, diagnostics, getTask: id => id === task.id ? task : null, onAuthorized: current => { current.mission.used.actions++; } });
  return { authority, mission, grant, task, policy, diagnostics, broker };
}

function signedDecision(request, privateKey, decision, now = 1000) {
  const phaseA = request.taskA;
  const phaseB = request.phase === 'complete_mission' ? request.taskB : null;
  const payload = {
    version: 1, iss: ISSUER, aud: AUDIENCE, missionId: request.missionId, phase: request.phase,
    decision: request.phase === 'select_task_b' ? 'dispatch_task_b' : decision.decision, decisionId: randomUUID(), nonce: randomUUID(), responseId: `resp-fixture-${randomUUID()}`, simulation: true,
    taskAId: phaseA.taskId, taskASessionId: phaseA.sessionId, taskAEventId: phaseA.eventId, taskAResultHash: phaseA.resultHash,
    taskBId: request.phase === 'select_task_b' ? decision.taskBId : request.taskB.taskId,
    taskBSessionId: phaseB?.sessionId || null, taskBEventId: phaseB?.eventId || null, taskBResultHash: phaseB?.resultHash || null,
    usage: { inputTokens: 72, outputTokens: 19 }, issuedAt: now, expiresAt: now + 20_000
  };
  const signature = sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64url');
  return { payload, signature };
}

test('Level 1 fixture grant and broker expose only one exact read path and cannot be broadened', async () => {
  const f = brokerFixture();
  assert.deepEqual(f.grant.capabilities, ['read']);
  const route = await f.broker.execute(f.task.id, { toolName: 'read', input: { path: 'route.txt' } });
  assert.equal(route.allow, true);
  assert.equal(route.output, fs.readFileSync(`${WORKSPACE}/route.txt`, 'utf8'));

  const other = brokerFixture();
  for (const request of [
    { toolName: 'read', input: { path: 'route.txt', offset: 1 } },
    { toolName: 'read', input: { path: '../README.md' } },
    { toolName: 'ls', input: {} },
    { toolName: 'write', input: { path: 'route.txt', content: 'changed' } },
    { toolName: 'edit', input: { path: 'route.txt', edits: [{ oldText: 'amber', newText: 'cobalt' }] } },
    { toolName: 'run_job', input: { jobName: 'safe-autonomy-regression' } },
    { toolName: 'web_fetch', input: { url: 'https://api.openai.com/' } },
    { toolName: 'bash', input: { command: 'touch route.txt' } }
  ]) {
    const isolated = brokerFixture();
    const result = await isolated.broker.execute(isolated.task.id, request);
    assert.equal(result.allow, false, request.toolName);
    assert.equal(isolated.policy.safetyStops.has(isolated.task.id), true, request.toolName);
  }
  assert.throws(() => f.authority.issueFixtureGrant(f.mission, { capabilities: ['read', 'edit'] }), /Invalid mission capabilities/);
  assert.equal(f.authority.verify(f.mission, 'edit').allow, false);
  const record = f.authority.grants.get(f.grant.id);
  const { signature: _oldSignature, ...unsigned } = record;
  unsigned.capabilities = ['edit', 'read'];
  record.capabilities = unsigned.capabilities;
  record.signature = f.authority._sign(unsigned);
  assert.equal(f.authority.verify(f.mission, 'read').allow, false, 'even a validly signed broader grant cannot authorize Level 1');
});

test('Task A requires one exact route/proof pair; inconsistent fixture evidence cannot choose Task B', () => {
  assert.equal(require('../src/level1-profile').selectExpectedTaskB('route=amber\nproof_id=AMBER-204'), 'level1-task-b-amber');
  for (const result of [
    'route=amber\nproof_id=COBALT-503',
    'route=amber\nproof_id=AMBER-204\nroute=cobalt',
    'route=amber\nproof_id=AMBER-204\nextra=data',
    'route=cobalt\nproof_id=UNKNOWN'
  ]) assert.throws(() => require('../src/level1-profile').selectExpectedTaskB(result), /route\/proof pair|exactly one/);
});

test('Level 1 Seatbelt source policy denies direct fixture reads, fixture writes, child processes, and TCP', () => {
  const profile = makeWorkerProfile({
    task: { workspace: WORKSPACE, mission: { level: 1, capabilityProfile: config.id, level1Phase: 'task_a', readOnlyPaths: ['route.txt'], networkPolicy: { egress: 'local-only', webFetch: false } } },
    workspace: WORKSPACE, sessionDir: '/private/tmp', readRoots: [WORKSPACE, '/private/tmp'], writeRoots: [WORKSPACE, '/private/tmp'],
    protectedRead: [], protectedWrite: [], protectedReadPatterns: [], protectedWritePatterns: [], socketPath: '/private/tmp/level1-broker.sock',
    executable: '/usr/bin/true', nodePath: process.execPath, envPath: '/usr/bin/env'
  });
  assert.equal(profile.includes(`(allow file-read* file-test-existence (subpath "${WORKSPACE}"))`), false);
  assert.equal(profile.includes(`(allow file-read* file-test-existence file-write* (subpath "${WORKSPACE}"))`), false);
  assert.match(profile, /file-write\* \(subpath "\/private\/tmp"\)/);
  assert.doesNotMatch(profile, /\(allow process-fork\)/);
  assert.equal((profile.match(/\(allow process-exec/g) || []).length, 3, 'only the pinned Pi, Node, and env launch executables may be exec targets');
  assert.match(profile, /\(allow process-exec \(literal "\/usr\/bin\/true"\)\)/);
  assert.ok(profile.includes(`(allow process-exec (literal "${process.execPath}"))`));
  assert.match(profile, /\(allow process-exec \(literal "\/usr\/bin\/env"\)\)/);
  assert.match(profile, /\(deny network\* \(require-not \(remote unix-socket \(path-literal "\/private\/tmp\/level1-broker\.sock"\)\)\)\)/);
  assert.equal((profile.match(/\(allow network-outbound/g) || []).length, 1, 'the broker Unix socket is the only network capability');
  assert.match(profile, /\(allow network-outbound \(remote unix-socket/);
});

test('control profile selects inference without copying credentials or model catalogs', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'control-profile-')),source=path.join(root,'source'),data=path.join(root,'data');fs.mkdirSync(source);
 fs.writeFileSync(path.join(source,'settings.json'),JSON.stringify({defaultProvider:'ollama',defaultModel:'qwen3-coder:30b'}));fs.writeFileSync(path.join(source,'auth.json'),'synthetic credential');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 assert.deepEqual(require('../src/config').prepareControlProfile(data,source),{provider:'ollama',model:'qwen3-coder:30b'});assert.equal(fs.existsSync(data),false);
});

test('SIMULATION: Task B remains unset until signed provider reasoning over Task A, then only that result-bound candidate dispatches', async t => {
  let now = 1000;
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const verifier = new Level1DecisionVerifier({ publicKey, now: () => now });
  const authority = new MissionAuthority({ fixtureOnly: true, now: () => now });
  const dispatched = [];
  const flow = new Level1MissionFlow(db, {
    now: () => now, verifier,
    verifyGrant(mission) {
      const verified = authority.verify(mission, 'read');
      return { ...verified, capabilities: authority.snapshot(mission).capabilities, egress: 'local-only' };
    },
    async dispatchTaskB(action) { dispatched.push(action); return { accepted: true, taskId: action.taskId, sessionId: randomUUID() }; }
  });
  const missionId = 'mission-level1-roundtrip-001';
  flow.register({ missionId, workspace: WORKSPACE, expiresAt: 30_000 });
  assert.equal(flow.snapshot(missionId).selected_task_b_id, null, 'registration must not choose Task B');
  const taskAScope = flow._grantScope(flow._mission(missionId), 'task_a', null, 'grant-placeholder-0001');
  const grant = authority.issueFixtureGrant(taskAScope, { maxActions: 4, maxRuntimeMs: 120_000, maxRetries: 0, egress: 'local-only' });
  flow.activate(missionId, { grantId: grant.id, authorizationId: 'operator-authorization-01', authorizedAt: now });
  flow.recordUsage(missionId, { runtimeMs: 5_000, actions: 1, retries: 0 });
  assert.deepEqual(flow.usage(missionId), { runtimeMs: 5_000, actions: 1, retries: 0 });
  assert.throws(() => flow.recordUsage(missionId, { runtimeMs: 4_999, actions: 1, retries: 0 }), /cumulative Level 1 runtimeMs/);
  await assert.rejects(flow.chooseAndDispatchTaskB(missionId, randomUUID(), { status: { simulation: true }, reason: async () => { throw new Error('must wait for Task A'); } }), /cannot be chosen before/);

  const taskASession = randomUUID(), taskAEvent = randomUUID();
  const taskAResult = 'route=amber\nproof_id=AMBER-204';
  const observed = flow.recordTaskAResult({ missionId, taskId: config.taskA.id, sessionId: taskASession, eventId: taskAEvent, result: taskAResult, authenticated: true, simulation: true });
  assert.equal(flow.snapshot(missionId).selected_task_b_id, null, 'Task A completion still must not preselect Task B');
  const fakeProvider = {
    status: { simulation: true },
    async reason(request) {
      if (request.phase === 'select_task_b') {
        const route = /^route=([a-z]+)$/m.exec(request.taskA.result)?.[1];
        const candidate = request.candidates.find(item => item.route === route);
        return signedDecision(request, privateKey, { taskBId: candidate.taskId }, now);
      }
      assert.equal(request.phase, 'complete_mission');
      assert.match(request.taskB.result, /proof=AMBER-204/);
      return signedDecision(request, privateKey, { decision: 'complete' }, now);
    }
  };
  const dispatch = await flow.chooseAndDispatchTaskB(missionId, observed.eventId, fakeProvider);
  assert.equal(dispatch.taskId, 'level1-task-b-amber');
  assert.equal(dispatched.length, 1);
  assert.deepEqual(flow.usage(missionId), { runtimeMs: 5_000, actions: 1, retries: 0 }, 'usage remains cumulative for Task B');
  assert.equal(dispatched[0].readOnlyPaths.length, 1);
  assert.equal(dispatched[0].readOnlyPaths[0], 'amber-proof.txt');
  const taskBResult = 'proof=AMBER-204\nstatus=valid';
  flow.recordTaskBResult({ missionId, taskId: dispatch.taskId, sessionId: dispatch.sessionId, eventId: randomUUID(), result: taskBResult, authenticated: true, simulation: true });
  const completed = await flow.completeMission(missionId, flow.snapshot(missionId).task_b_event_id, fakeProvider);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.simulation, true);
  assert.equal(completed.acceptance, null, 'fixture reasoning is never reported as live acceptance evidence');
  assert.equal(flow.acceptanceSnapshot(missionId).realReasoningTurns, 0);
});

test('Level 1 rejects wrong, stale, expired, replayed, and cancelled decisions before a second dispatch', async t => {
  let now = 1000;
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const verifier = new Level1DecisionVerifier({ publicKey, now: () => now });
  const authority = new MissionAuthority({ fixtureOnly: true, now: () => now });
  let dispatches = 0;
  const flow = new Level1MissionFlow(db, {
    now: () => now, verifier,
    verifyGrant(mission) { const v = authority.verify(mission, 'read'); return { ...v, capabilities: authority.snapshot(mission).capabilities, egress: 'local-only' }; },
    async dispatchTaskB(action) { dispatches++; return { accepted: true, taskId: action.taskId, sessionId: randomUUID() }; }
  });
  const missionId = 'mission-level1-invalid-001';
  flow.register({ missionId, workspace: WORKSPACE, expiresAt: 10_000 });
  const grant = authority.issueFixtureGrant(flow._grantScope(flow._mission(missionId), 'task_a', null, 'grant-placeholder-0002'), { maxActions: 4, maxRuntimeMs: 120_000, maxRetries: 0 });
  flow.activate(missionId, { grantId: grant.id, authorizationId: 'operator-authorization-02', authorizedAt: now });
  const taskASession = randomUUID(), taskAEvent = randomUUID(), taskAResult = 'route=amber\nproof_id=AMBER-204';
  const event = flow.recordTaskAResult({ missionId, taskId: config.taskA.id, sessionId: taskASession, eventId: taskAEvent, result: taskAResult, authenticated: true, simulation: true });
  const stub = { status: { simulation: true }, async reason(request) { return signedDecision(request, privateKey, { taskBId: 'level1-task-b-cobalt' }, now); } };
  await assert.rejects(flow.chooseAndDispatchTaskB(missionId, event.eventId, stub), /inconsistent with Task A/);
  assert.equal(dispatches, 0);

  const valid = signedDecision({
    missionId, phase: 'select_task_b', taskA: { taskId: config.taskA.id, sessionId: taskASession, eventId: taskAEvent, result: taskAResult, resultHash: event.resultHash },
    candidates: config.taskBCandidates
  }, privateKey, { taskBId: 'level1-task-b-amber' }, now);
  const replayProbe = signedDecision({
    missionId, phase: 'select_task_b', taskA: { taskId: config.taskA.id, sessionId: taskASession, eventId: taskAEvent, result: taskAResult, resultHash: event.resultHash },
    candidates: config.taskBCandidates
  }, privateKey, { taskBId: 'level1-task-b-amber' }, now);
  assert.equal(verifier.verify(replayProbe).decision, 'dispatch_task_b');
  assert.throws(() => verifier.verify(replayProbe), /nonce replay/);
  const stale = { ...valid, payload: { ...valid.payload, taskAResultHash: '0'.repeat(64) } };
  stale.signature = sign(null, Buffer.from(canonical(stale.payload)), privateKey).toString('base64url');
  const staleAdapter = { status: { simulation: true }, async reason() { return stale; } };
  await assert.rejects(flow.chooseAndDispatchTaskB(missionId, event.eventId, staleAdapter), /stale or cross-mission/);
  assert.equal(dispatches, 0);

  const crossMission = { ...valid, payload: { ...valid.payload, missionId: 'mission-level1-another-001', nonce: randomUUID() } };
  crossMission.signature = sign(null, Buffer.from(canonical(crossMission.payload)), privateKey).toString('base64url');
  const crossAdapter = { status: { simulation: true }, async reason() { return crossMission; } };
  await assert.rejects(flow.chooseAndDispatchTaskB(missionId, event.eventId, crossAdapter), /stale or cross-mission/);
  assert.equal(dispatches, 0);

  const expired = { ...valid, payload: { ...valid.payload, nonce: randomUUID(), issuedAt: now - 1000, expiresAt: now } };
  expired.signature = sign(null, Buffer.from(canonical(expired.payload)), privateKey).toString('base64url');
  const expiredAdapter = { status: { simulation: true }, async reason() { return expired; } };
  await assert.rejects(flow.chooseAndDispatchTaskB(missionId, event.eventId, expiredAdapter), /expired/);
  assert.equal(dispatches, 0);

  flow.cancel(missionId);
  await assert.rejects(flow.chooseAndDispatchTaskB(missionId, event.eventId, stub), /cancelled/);
  assert.throws(() => flow.recordTaskAResult({ missionId, taskId: config.taskA.id, sessionId: randomUUID(), eventId: randomUUID(), result: taskAResult, authenticated: true, simulation: true }), /cancelled/);
});

test('SIMULATION: acceptance recorder requires exact zero-manual/two-task/two-live-turn/one-dispatch completion evidence', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let now = 1000;
  const recorder = new Level1AcceptanceRecorder(db, { now: () => now });
  recorder.authorize('mission-acceptance-fixture-001', 'authorization-fixture-001', now);
  assert.equal(recorder.evaluate('mission-acceptance-fixture-001').accepted, false);
  assert.throws(() => recorder.recordReasoningTurn('mission-acceptance-fixture-001', { responseId: 'resp-fixture-0001', phase: 'select_task_b', resultHash: 'a'.repeat(64), simulation: false, verified: true }), /verifier-authenticated/);
  assert.equal(evaluateAcceptance({ ...EXPECTED, manualStatusChecks: 1 }).accepted, false);
  assert.equal(evaluateAcceptance({ ...EXPECTED }).accepted, true, 'pure predicate fixture only; no live evidence was created');
  now++;
  recorder.recordManualStatusCheck('mission-acceptance-fixture-001', randomUUID(), 'manual-status-001', now);
  recorder.recordHumanTurn('mission-acceptance-fixture-001', randomUUID(), 'human-turn-001', now);
  recorder.recordManualNextAction('mission-acceptance-fixture-001', randomUUID(), 'manual-action-001', now);
  assert.deepEqual(
    Object.fromEntries(['humanTurnsAfterAuthorization', 'manualStatusChecks', 'manualNextActions'].map(key => [key, recorder.evaluate('mission-acceptance-fixture-001').actual[key]])),
    { humanTurnsAfterAuthorization: 1, manualStatusChecks: 1, manualNextActions: 1 }
  );
});

test('SIMULATION: prepared OpenAI Responses adapter is inert by default and fake responses remain non-acceptance simulations', async () => {
  const disabled = new OpenAIResponsesDecisionAdapter();
  assert.equal(disabled.status.liveEnabled, false);
  assert.equal(disabled.status.endpoint, ENDPOINT);
  let keyReads = 0;
  await assert.rejects(disabled.reason({ phase: 'select_task_b' }), /disabled/);
  assert.equal(keyReads, 0);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const verifier = new Level1DecisionVerifier({ publicKey });
  const requests = [];
  const fetchFixture = async (url, options) => {
    requests.push({ url, options });
    const body = JSON.parse(options.body);
    const phase = requests.length === 1 ? 'select_task_b' : 'complete_mission';
    return {
      status: 200,
      async json() {
        return {
          id: `resp-fixture-${String(requests.length).padStart(8, '0')}`,
          model: MODEL,
          status: 'completed',
          output_text: phase === 'select_task_b' ? JSON.stringify({ taskBId: 'level1-task-b-amber' }) : JSON.stringify({ decision: 'complete' }),
          usage: { input_tokens: 240, output_tokens: 48 }
        };
      }
    };
  };
  const adapter = new OpenAIResponsesDecisionAdapter({
    enabled: true,
    simulation: true,
    apiKeyProvider: async () => { keyReads++; return 'fixture-only-api-key-not-a-real-credential'; },
    fetchImpl: fetchFixture,
    signingPrivateKey: privateKey,
    verifier
  });
  assert.equal(adapter.status.liveEnabled, false);
  assert.equal(adapter.status.simulation, true);
  await assert.rejects(adapter.preflight(), /disabled/);
  const baseTaskA = { taskId: config.taskA.id, sessionId: randomUUID(), eventId: randomUUID(), result: 'route=amber\nproof_id=AMBER-204', resultHash: 'a'.repeat(64) };
  const first = await adapter.reason({ phase: 'select_task_b', missionId: 'mission-provider-fixture-001', taskA: baseTaskA, candidates: config.taskBCandidates });
  const selected = verifier.verify(first);
  assert.equal(selected.taskBId, 'level1-task-b-amber');
  assert.equal(selected.simulation, true);
  const second = await adapter.reason({
    phase: 'complete_mission', missionId: 'mission-provider-fixture-001', taskA: baseTaskA,
    taskB: { taskId: selected.taskBId, sessionId: randomUUID(), eventId: randomUUID(), result: 'proof=AMBER-204\nstatus=valid', resultHash: 'b'.repeat(64), expectedProof: 'AMBER-204' }
  });
  assert.equal(verifier.verify(second).decision, 'complete');
  assert.equal(requests.length, 2);
  assert.equal(keyReads, 2);
  assert.ok(MAX_TURN_COST_MICROS * 2 <= 1500);
  for (const request of requests) {
    assert.equal(request.url, ENDPOINT);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.authorization, 'Bearer fixture-only-api-key-not-a-real-credential');
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, MODEL);
    assert.equal(body.max_output_tokens, 128);
    assert.equal(body.store, false);
    assert.equal(body.background, false);
    assert.deepEqual(body.tools, []);
    assert.equal(body.text.format.strict, true);
    assert.equal(request.options.redirect, 'error');
  }
  await assert.rejects(adapter.reason({ phase: 'select_task_b', missionId: 'mission-provider-fixture-001', taskA: baseTaskA, candidates: config.taskBCandidates }), /turn or spend budget exhausted|duplicate or out of order/);
});
