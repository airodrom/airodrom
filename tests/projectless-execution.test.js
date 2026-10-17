'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');
const { CursorWorker } = require('../src/cursor-worker');
const sandbox = require('../src/projectless-sandbox');

test('projectless OpenCode mission verifies and accepts without a Project', async t => {
  const rt = runtime(t);
  const f = await fixture(t, { opencode: rt.options, defaultRuntime: 'opencode' });
  f.bridge.expandedAutonomy.setMode({ mode: 'expanded_auto', confirmed: true, request_id: randomUUID() }, 'operator');
  const before = f.bridge.projects.listProjects().length;
  const asked = await f.bridge.zeroSetupWork.ask({
    request_id: randomUUID(),
    instruction: 'In a projectless task sandbox, change fixture.txt from alpha to beta.'
  }, 'operator');
  assert.equal(asked.state, 'DISPATCHED');
  assert.equal(asked.projectless, true);
  assert.equal(asked.execution_authorized, true);
  assert.equal(f.bridge.projects.listProjects().length, before);
  t.after(() => fs.rmSync(asked.workspace, { recursive: true, force: true }));
  const done = await f.settle(asked.mission_id, 'completed');
  assert.equal(done.project_id, null);
  assert.equal(done.goal_id, null);
  assert.equal(done.runs[0].agent_id, 'opencode');
  assert.equal(done.verifications[0].result, 'passed');
  assert.equal(done.acceptance.length, 1);
  assert.equal(done.acceptance[0].decision, 'accept');
  const bytes = fs.readFileSync(path.join(asked.workspace, 'fixture.txt'));
  assert.equal(bytes.toString('hex'), '626574610a');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update('beta\n').digest('hex'));
});

test('failed projectless verification is not accepted', async t => {
  const rt = runtime(t);
  const f = await fixture(t, { opencode: rt.options, defaultRuntime: 'opencode' });
  const allocated = sandbox.allocate();
  sandbox.seedExactFixture(allocated.workspace);
  t.after(() => fs.rmSync(allocated.workspace, { recursive: true, force: true }));
  const input = sandbox.exactMissionInput(allocated.workspace, randomUUID());
  input.criteria = [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'wrong\n' }];
  const mission = f.bridge.missions.create(input, 'operator');
  f.bridge.missions.dispatch(mission.id, { request_id: randomUUID() });
  const done = await f.settle(mission.id, 'needs_rework');
  assert.equal(done.acceptance.length, 0);
  assert.equal(done.verifications[0].result, 'failed');
});

test('cursor live execution stays blocked without spend authorization', async t => {
  const worker = new CursorWorker({});
  worker.readiness = async () => ({ ready: true, spend: 'UNKNOWN_SUBSCRIPTION' });
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/cursor-spend-'));
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'alpha\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    worker.execute({ workspace: root, files: ['fixture.txt'], writable: ['fixture.txt'], objective: 'change fixture' }),
    /BLOCKED_SPEND_AUTHORIZATION/
  );
});
