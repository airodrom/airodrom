'use strict';
// Opt-in local inference only. Isolated DB/repositories; no installed-host mutation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
if (process.env.AIRODROM_OPENCODE_LIVE !== '1') throw Error('Explicit local OpenCode live-test opt-in required');
test('real local OpenCode read-only planning, execution, and result evaluation', { timeout: 480000 }, async t => {
  const f = await fixture(t, { opencode: { enabled: true, executable: process.env.AIRODROM_OPENCODE_EXECUTABLE || '/opt/homebrew/bin/opencode', model: 'ollama/qwen3-coder:30b', timeoutMs: 120000 }, settleTimeoutMs: 300000 });
  const b = f.bridge;
  b.missionAuthority.initializeOperatorKey(); qualifyCanonical(b);
  const project = b.projects.listProjects({ status: 'active' })[0], goal = b.projects.summary(project.projectId).goals[0];
  b.developerAutonomy.enroll({ alias: 'cognitive-live-fixture', repository: f.repo, project_id: project.projectId, goal_id: goal.goalId,
    workflows: ['routine_edit', 'test'], workers: ['opencode'], duration_days: 1, confirmed: true, diff_check: 'diff-check', default_tests: ['fixture-test'], budgets: { max_repairs: 0 },
    cognitive: { version: 2, repair_attempts: 0, files: ['fixture.txt'], delegated_callers: [], planning_attempts: 2, planning_ms: 120000, execution_ms: 120000 } }, 'operator');
  const prepared = await b.zeroSetupWork.ask({ request_id: randomUUID(), instruction: 'In Fixture project change fixture.txt from alpha to beta. Preserve exactly one final newline. Make the registered test pass.' }, 'operator');
  assert.equal(prepared.state, 'DISPATCHED', JSON.stringify(prepared));
  const done = await f.settle(prepared.mission_id);
  const receipt = require('../src/mission-evidence').evidencePackage(b, done.id);
  assert.equal(receipt.cognitive.termination, 'verified');
  assert.ok(['passed', 'operator_review'].includes(receipt.cognitive.verification.result));
  assert.equal(receipt.cognitive.acceptance, 'pending');
  assert.equal(receipt.worker.agent_id, 'opencode');
  assert.equal(receipt.gateway.evaluations.length, 1);
  assert.equal(receipt.gateway.evaluations[0].recommendation, 'ready');
  assert.equal(receipt.gateway.evaluations[0].termination_verified, true);
  assert.equal(receipt.gateway.evaluations[0].provenance.runtime_version, '2.0.25');
  assert.equal(receipt.gateway.evaluations[0].provenance.sandbox, 'sandbox-exec');
  assert.equal(receipt.cognitive.leases.every(l => l.state === 'released'), true);
  // This explicit fixture-owner decision is confined to the isolated database.
  b.missions.accept(done.id, { request_id: randomUUID(), verification_id: receipt.verification.id,
    decision: 'accept', rationale: 'Reviewed disposable alpha-to-beta result and host checks', evidence: 'Real local planning, execution, evaluation and host verification' }, 'operator');
  await f.reopen();
  const recovered = require('../src/mission-evidence').evidencePackage(f.bridge, done.id);
  assert.equal(recovered.cognitive.acceptance, 'accepted');
  assert.deepEqual(recovered.gateway, receipt.gateway);
  console.log(JSON.stringify({ live_local: true, installed_host: false, fixture_owner_acceptance: true, durable_reopen: true, ...recovered.cognitive, gateway: recovered.gateway }));
});
