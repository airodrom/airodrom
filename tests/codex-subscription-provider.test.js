'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, generateKeyPairSync } = crypto;
const {
  CodexSubscriptionDecisionAdapter, Level1ProviderPauseError, Level1DecisionVerifier,
  CODEX_SUBSCRIPTION_MODE, CODEX_SUBSCRIPTION_PROTOCOL
} = require('../src/level1-provider');
const { Level1MissionFlow } = require('../src/level1-mission');
const { config, WORKSPACE } = require('../src/level1-profile');
const BridgeController = require('../src/bridge-controller');

const auth = Object.freeze({ authMode: 'chatgpt', billingMode: 'included_allowance', includedAllowanceAvailable: true, apiKeyFallback: false, accountSwitch: false });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixtureCli(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-subscription-provider-'));
  const cliPath = path.join(root, 'codex');
  fs.writeFileSync(cliPath, '#!/bin/false\n'); fs.chmodSync(cliPath, 0o500);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pinnedPath = fs.realpathSync(cliPath);
  return { path: pinnedPath, sha256: hash(fs.readFileSync(pinnedPath)) };
}

function requests() {
  const taskA = { taskId: 'level1-task-a-observe-route', sessionId: randomUUID(), eventId: randomUUID(), result: 'route=amber\nproof_id=AMBER-204', resultHash: 'a'.repeat(64) };
  return {
    select: { phase: 'select_task_b', missionId: 'mission-codex-subscription-001', taskA, candidates: [{ taskId: 'level1-task-b-amber', route: 'amber', objective: 'Read only amber-proof.txt and report its exact proof and status values.', readPaths: ['amber-proof.txt'], expectedProof: 'AMBER-204' }] },
    complete: { phase: 'complete_mission', missionId: 'mission-codex-subscription-001', taskA, taskB: { taskId: 'level1-task-b-amber', sessionId: randomUUID(), eventId: randomUUID(), result: 'proof=AMBER-204\nstatus=valid', resultHash: 'b'.repeat(64), expectedProof: 'AMBER-204' } }
  };
}

test('SIMULATION: Codex subscription adapter pins its CLI, requires included allowance, structured output, and session continuation', async t => {
  const cli = fixtureCli(t);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const verifier = new Level1DecisionVerifier({ publicKey });
  const invocations = [];
  const sessionId = randomUUID();
  const adapter = new CodexSubscriptionDecisionAdapter({
    enabled: true, noAdditionalSpend: true, cli, verifier, signingPrivateKey: privateKey,
    authProbe: async value => { assert.equal(value.protocol, CODEX_SUBSCRIPTION_PROTOCOL); assert.deepEqual(value.cli, cli); return auth; },
    invoke: async invocation => {
      invocations.push(invocation);
      const first = invocations.length === 1;
      return {
        protocol: CODEX_SUBSCRIPTION_PROTOCOL, cliSha256: cli.sha256, ...auth, sessionId,
        responseId: first ? 'codexrespselect001' : 'codexrespcomplete002',
        finalOutput: JSON.stringify(first ? { taskBId: 'level1-task-b-amber' } : { decision: 'complete' }),
        usage: { inputTokens: first ? 17 : 21, outputTokens: first ? 6 : 5 }
      };
    }
  });
  const input = requests();

  assert.deepEqual(adapter.status, {
    mode: CODEX_SUBSCRIPTION_MODE, liveEnabled: true, configured: true, simulation: false,
    noAdditionalSpend: true, automaticPaidFallback: false, creditPurchases: false, accountSwitching: false,
    requestCount: 0, maxRequests: 2, sessionContinuation: true
  });
  const preflight = await adapter.preflight();
  assert.equal(preflight.auth.billingMode, 'included_allowance');
  assert.equal(preflight.cli.sha256, cli.sha256);

  const selection = verifier.verify(await adapter.reason(input.select));
  assert.equal(selection.decision, 'dispatch_task_b');
  assert.equal(selection.taskBId, 'level1-task-b-amber');
  const completion = verifier.verify(await adapter.reason(input.complete));
  assert.equal(completion.decision, 'complete');
  assert.equal(adapter.status.requestCount, 2);

  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].continuationOf, null);
  assert.deepEqual(invocations[0].argv.slice(0, 4), ['exec', '--sandbox', 'read-only', '--json']);
  assert.equal(invocations[0].sandbox, 'read-only');
  assert.equal(invocations[0].networkAuthority, 'trusted-provider-broker-only');
  assert.deepEqual(invocations[0].outputSchema, { type: 'json_schema', name: 'level1_task_selection', strict: true, schema: { type: 'object', additionalProperties: false, properties: { taskBId: { type: 'string', enum: ['level1-task-b-amber'] } }, required: ['taskBId'] } });
  assert.deepEqual(invocations[1].argv.slice(0, 3), ['exec', 'resume', sessionId]);
  assert.equal(invocations[1].continuationOf, sessionId);
  assert.deepEqual(invocations[1].outputSchema, { type: 'json_schema', name: 'level1_completion', strict: true, schema: { type: 'object', additionalProperties: false, properties: { decision: { type: 'string', enum: ['complete', 'incomplete'] } }, required: ['decision'] } });
});

test('SIMULATION: unavailable ChatGPT allowance, API-key mode, a changed executable, or a paid execution result pauses without fallback', async t => {
  const cli = fixtureCli(t);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const verifier = new Level1DecisionVerifier({ publicKey });
  let invoked = 0;
  const unavailable = new CodexSubscriptionDecisionAdapter({
    enabled: true, noAdditionalSpend: true, cli, verifier, signingPrivateKey: privateKey,
    authProbe: async () => ({ ...auth, includedAllowanceAvailable: false }), invoke: async () => { invoked++; }
  });
  await assert.rejects(unavailable.preflight(), error => error instanceof Level1ProviderPauseError && error.code === 'codex_subscription_unavailable');
  assert.equal(invoked, 0);

  const apiKeyMode = new CodexSubscriptionDecisionAdapter({
    enabled: true, noAdditionalSpend: true, cli, verifier, signingPrivateKey: privateKey,
    authProbe: async () => ({ ...auth, authMode: 'api_key' }), invoke: async () => { invoked++; }
  });
  await assert.rejects(apiKeyMode.preflight(), error => error instanceof Level1ProviderPauseError && error.code === 'codex_subscription_unavailable');
  assert.equal(invoked, 0, 'an API-key result cannot cause a Responses fallback');

  fs.chmodSync(cli.path, 0o700);
  fs.appendFileSync(cli.path, '# changed\n');
  const changedPin = new CodexSubscriptionDecisionAdapter({
    enabled: true, noAdditionalSpend: true, cli, verifier, signingPrivateKey: privateKey,
    authProbe: async () => auth, invoke: async () => { invoked++; }
  });
  await assert.rejects(changedPin.preflight(), error => error instanceof Level1ProviderPauseError && error.code === 'codex_cli_pin_mismatch');
  assert.equal(invoked, 0);
});

test('SIMULATION: the existing Level 1 coordinator journals an unavailable subscription preflight as paused before it can activate a grant or task', async t => {
  const cli = fixtureCli(t);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const verifier = new Level1DecisionVerifier({ publicKey });
  const adapter = new CodexSubscriptionDecisionAdapter({
    enabled: true, noAdditionalSpend: true, cli, verifier, signingPrivateKey: privateKey,
    authProbe: async () => ({ ...auth, includedAllowanceAvailable: false }), invoke: async () => { throw new Error('must not invoke'); }
  });
  const previous = { enabled: config.enabled, restrictedWorker: config.restrictedWorker.enabled, providerMode: config.providerMode, codexEnabled: config.codexSubscription.enabled };
  config.enabled = true; config.restrictedWorker.enabled = true; config.providerMode = CODEX_SUBSCRIPTION_MODE; config.codexSubscription.enabled = true;
  const db = new DatabaseSync(':memory:');
  const bridge = new BridgeController({ level1ActivationEnabled: true, level1RestrictedWorkerEnabled: true, level1ProviderAdapter: adapter, level1DecisionVerifier: verifier });
  bridge.level1Flow = new Level1MissionFlow(db, { verifier });
  t.after(async () => { await bridge.shutdown(); db.close(); config.enabled = previous.enabled; config.restrictedWorker.enabled = previous.restrictedWorker; config.providerMode = previous.providerMode; config.codexSubscription.enabled = previous.codexEnabled; });

  const result = await bridge.startLevel1ReadOnlyMission({ missionId: 'mission-codex-preflight-pause-001', grantId: 'grant-codex-preflight-pause-001', authorizationId: 'authorization-codex-preflight-001', expiresAt: Date.now() + 60_000 });
  assert.deepEqual(result, { missionId: 'mission-codex-preflight-pause-001', status: 'paused', reason: 'codex_subscription_unavailable' });
  assert.equal(bridge.level1Flow.snapshot(result.missionId).status, 'paused');
  const checkpoint = db.prepare('SELECT provider_mode,code,reason,resumed_at FROM level1_preflight_checkpoints WHERE mission_id=?').get(result.missionId);
  assert.deepEqual({ ...checkpoint }, { provider_mode: CODEX_SUBSCRIPTION_MODE, code: 'codex_subscription_unavailable', reason: 'Codex ChatGPT authentication with included allowance is unavailable; Level 1 is paused with no paid fallback', resumed_at: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM level1_acceptance_missions WHERE mission_id=?').get(result.missionId).count, 0, 'no grant activation or task was recorded');
  assert.equal(bridge.tasks, undefined, 'no task manager was reached before the pause');
});
