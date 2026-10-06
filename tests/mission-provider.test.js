'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { generateKeyPairSync, sign, randomUUID } = require('node:crypto');
const { MissionCoordinator } = require('../src/mission-coordinator');
const { DecisionCallbackVerifier, ProviderDecisionAdapter, canonical } = require('../src/mission-provider');

function callbackEnvelope(payload, privateKey) {
  const signature = sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64url');
  return { payload, signature };
}
function makePayload({ missionId, taskAId, taskBId, event, decisionId = randomUUID(), nonce = randomUUID(), issuedAt = 1000, expiresAt = 20_000, instructions = 'Verify the specific Task A evidence before continuing.' }) {
  return { version: 1, iss: 'fixture-provider', aud: 'pi-chatgpt-bridge/mission-decision/v1', missionId, taskAId, sessionId: event.sessionId, eventId: event.eventId, resultHash: event.resultHash, taskBId, decisionId, nonce, issuedAt, expiresAt, decision: 'continue', instructions };
}

test('SIMULATION: signed provider callback binds Task A result before Task B dispatch; live adapter stays disabled', async t => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  let now = 1000; const verifier = new DecisionCallbackVerifier({ publicKey, issuer: 'fixture-provider', now: () => now });
  const db = new DatabaseSync(':memory:'), dispatched = [];
  const coordinator = new MissionCoordinator(db, { now: () => now, callbackVerifier: verifier, dispatchTaskB: async action => { dispatched.push(action); return { taskId: action.taskId, accepted: true }; } });
  t.after(() => db.close());
  const missionId = 'mission-signed-roundtrip-001', taskAId = 'task-a-signed-001', taskBId = 'task-b-signed-001';
  coordinator.register({ missionId, taskAId, taskBId, expiresAt: 20_000 });
  const result = 'Task A found two fixture files; SHA256 values are 111 and 222.';
  const event = coordinator.receiveTaskAResult({ missionId, taskId: taskAId, sessionId: randomUUID(), eventId: randomUUID(), result, authenticated: true });
  const adapter = new ProviderDecisionAdapter();
  assert.equal(adapter.status.liveEnabled, false);
  const request = adapter.buildRequest({ mission: { missionId, taskBId }, event });
  assert.equal(request.resultHash, event.resultHash);
  assert.equal(request.taskAResult, result);
  await assert.rejects(adapter.requestDecision(request), /disabled/);
  assert.equal(dispatched.length, 0);

  const payload = makePayload({ missionId, taskAId, taskBId, event });
  const decision = coordinator.acceptProviderCallback(callbackEnvelope(payload, privateKey));
  assert.equal(decision.simulation, false);
  assert.equal(decision.resultHash, event.resultHash);
  assert.equal(dispatched.length, 0, 'signature validation alone does not dispatch Task B');
  const action = await coordinator.dispatch(decision.decisionId);
  assert.equal(action.taskId, taskBId);
  assert.equal(action.simulation, false);
  assert.match(action.instructions, /Task A evidence/);
  assert.equal(dispatched.length, 1);
  assert.throws(() => coordinator.acceptProviderCallback(callbackEnvelope(payload, privateKey)), /nonce|Duplicate/);
});

test('SIMULATION: provider adapter reasons over Task A, coordinator validates callback, and Task B waits for dispatch', async t => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  let now = 2000;
  const verifier = new DecisionCallbackVerifier({ publicKey, issuer: 'fixture-provider', now: () => now });
  const db = new DatabaseSync(':memory:'), dispatched = [];
  const coordinator = new MissionCoordinator(db, { now: () => now, callbackVerifier: verifier, dispatchTaskB: async action => { dispatched.push(action); return { taskId: action.taskId }; } });
  t.after(() => db.close());
  const missionId = 'mission-adapter-sim-001', taskAId = 'task-a-adapter-001', taskBId = 'task-b-adapter-001';
  coordinator.register({ missionId, taskAId, taskBId, expiresAt: 20_000 });
  const result = 'Task A inspected fixture.log and found checksum abc123.';
  const event = coordinator.receiveTaskAResult({ missionId, taskId: taskAId, sessionId: randomUUID(), eventId: randomUUID(), result, authenticated: true });
  const adapter = new ProviderDecisionAdapter({ enabled: true, simulation: true, verifier, transport: async request => {
    assert.equal(request.taskAResult, result);
    assert.equal(request.resultHash, event.resultHash);
    const instructions = request.taskAResult.includes('checksum abc123') ? 'Task B must verify checksum abc123 against fixture.log.' : 'Do not dispatch without the Task A checksum evidence.';
    return callbackEnvelope(makePayload({ missionId, taskAId, taskBId, event, issuedAt: now, expiresAt: 10_000, instructions }), privateKey);
  } });
  assert.equal(adapter.status.liveEnabled, false, 'simulation adapter is never counted as a live provider');
  const decision = await coordinator.requestProviderDecision(adapter, event.eventId);
  assert.equal(decision.simulation, true);
  assert.equal(dispatched.length, 0);
  const action = await coordinator.dispatch(decision.decisionId);
  assert.equal(action.simulation, true);
  assert.match(action.instructions, /checksum abc123/);
  assert.equal(dispatched.length, 1);
});

test('simulation adapter configuration is unavailable outside test mode', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { assert.throws(() => new ProviderDecisionAdapter({ enabled: true, simulation: true }), /restricted to isolated test runs/); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('rejects provider callbacks with bad signatures, wrong bindings, duplicate IDs, expiry, cancellation, or replay', t => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  let now = 1000; const verifier = new DecisionCallbackVerifier({ publicKey, issuer: 'fixture-provider', now: () => now });
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const coordinator = new MissionCoordinator(db, { now: () => now, callbackVerifier: verifier });
  const missionId = 'mission-callback-verify-001', taskAId = 'task-a-callback-001', taskBId = 'task-b-callback-001';
  coordinator.register({ missionId, taskAId, taskBId, expiresAt: 20_000 });
  const event = coordinator.receiveTaskAResult({ missionId, taskId: taskAId, sessionId: randomUUID(), eventId: randomUUID(), result: 'Verified event body.', authenticated: true });

  const valid = makePayload({ missionId, taskAId, taskBId, event });
  const invalidSignature = callbackEnvelope(valid, privateKey);
  invalidSignature.signature = Buffer.alloc(64).toString('base64url');
  assert.throws(() => coordinator.acceptProviderCallback(invalidSignature), /signature/);
  const wrongHash = { ...valid, resultHash: '0'.repeat(64), nonce: randomUUID() };
  assert.throws(() => coordinator.acceptProviderCallback(callbackEnvelope(wrongHash, privateKey)), /stale or cross-mission/);
  const wrongTask = { ...valid, taskBId: 'task-b-other-0001', nonce: randomUUID() };
  assert.throws(() => coordinator.acceptProviderCallback(callbackEnvelope(wrongTask, privateKey)), /stale or cross-mission/);

  const successPayload = { ...valid, nonce: randomUUID() };
  const success = coordinator.acceptProviderCallback(callbackEnvelope(successPayload, privateKey));
  assert.equal(success.state, 'validated');
  const sameDecisionId = { ...valid, nonce: randomUUID() };
  assert.throws(() => coordinator.acceptProviderCallback(callbackEnvelope(sameDecisionId, privateKey)), /Duplicate/);
  assert.throws(() => coordinator.acceptProviderCallback(callbackEnvelope(successPayload, privateKey)), /nonce/);

  const expiredEvent = coordinator.receiveTaskAResult({ missionId, taskId: taskAId, sessionId: randomUUID(), eventId: randomUUID(), result: 'A newer Task A event.', authenticated: true });
  const expired = makePayload({ missionId, taskAId, taskBId, event: expiredEvent, expiresAt: 1050, nonce: randomUUID() });
  now = 1051;
  assert.throws(() => coordinator.acceptProviderCallback(callbackEnvelope(expired, privateKey)), /expired/);
  now = 1060;
  const fresh = makePayload({ missionId, taskAId, taskBId, event: expiredEvent, nonce: randomUUID(), issuedAt: 1060, expiresAt: 10_000 });
  coordinator.cancel(missionId);
  assert.throws(() => coordinator.acceptProviderCallback(callbackEnvelope(fresh, privateKey)), /cancelled/);
});
