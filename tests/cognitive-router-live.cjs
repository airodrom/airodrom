'use strict';
// Opt-in local inference only. Isolated DB/repositories; no installed-host mutation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
if (process.env.AIRODROM_OPENCODE_LIVE !== '1') throw Error('Explicit local OpenCode live-test opt-in required');
test('real local OpenCode read-only planning and bounded execution', { timeout: 330000 }, async t => {
  const f = await fixture(t, { opencode: { enabled: true, executable: process.env.AIRODROM_OPENCODE_EXECUTABLE || '/opt/homebrew/bin/opencode', model: 'ollama/qwen3-coder:30b', timeoutMs: 120000 }, settleTimeoutMs: 150000 });
  const b = f.bridge;
  b.missionAuthority.initializeOperatorKey(); qualifyCanonical(b);
  const project = b.projects.listProjects({ status: 'active' })[0], goal = b.projects.summary(project.projectId).goals[0];
  b.developerAutonomy.enroll({ alias: 'cognitive-live-fixture', repository: f.repo, project_id: project.projectId, goal_id: goal.goalId,
    workflows: ['routine_edit', 'test'], workers: ['opencode'], duration_days: 1, confirmed: true, diff_check: 'diff-check', default_tests: ['fixture-test'], budgets: { max_repairs: 0 },
    cognitive: { version: 1, files: ['fixture.txt'], delegated_callers: [], planning_attempts: 2, planning_ms: 120000, execution_ms: 120000 } }, 'operator');
  const prepared = await b.zeroSetupWork.ask({ request_id: randomUUID(), instruction: 'In Fixture project change fixture.txt from alpha to beta. Preserve exactly one final newline. Make the registered test pass.' }, 'operator');
  assert.equal(prepared.state, 'DISPATCHED', JSON.stringify(prepared));
  const done = await f.settle(prepared.mission_id);
  const receipt = require('../src/mission-evidence').evidencePackage(b, done.id);
  assert.equal(receipt.cognitive.termination, 'verified');
  assert.ok(['passed', 'operator_review'].includes(receipt.cognitive.verification.result));
  assert.equal(receipt.cognitive.acceptance, 'pending');
  assert.equal(receipt.worker.agent_id, 'opencode');
  console.log(JSON.stringify({ live_local: true, installed_host: false, ...receipt.cognitive }));
});
