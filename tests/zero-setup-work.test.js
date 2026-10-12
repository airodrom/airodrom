'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const { parseExactFileIntent } = require('../src/zero-setup-work');
const { TOOLS } = require('../src/mcp-tools');

test('exact-file natural language intent is recognized without IDs', () => {
  const intent = parseExactFileIntent('Airodrom, change the test file from alpha to beta, verify the result, and tell me when you are finished.');
  assert.equal(intent.kind, 'exact_file');
  assert.equal(intent.file, 'fixture.txt');
  assert.equal(intent.to, 'beta\n');
});

test('ask prepares WAIT approval without writing or dispatching; approve runs once', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  const project = f.bridge.projects.createProject({ name: 'Human Acceptance Exact File', repositories: [f.repo], privacyPolicy: 'local_only' });
  f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Exact-file alpha to beta' });
  const request_id = randomUUID();
  const prepared = await f.bridge.zeroSetupWork.ask({
    instruction: 'Airodrom, change the test file from alpha to beta, verify the result, and tell me when you are finished.',
    request_id,
  }, 'mcp:zero-setup-test');
  assert.equal(prepared.state, 'WAIT');
  assert.equal(prepared.execution_authorized, false);
  assert.equal(prepared.presentation.project_name, 'Human Acceptance Exact File');
  assert.deepEqual(prepared.presentation.files, ['fixture.txt']);
  assert.match(prepared.presentation.worker, /OpenCode/i);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
  assert.equal(f.bridge.controlStore.listMissions({ owner: 'operator', limit: 20 }).filter(m => m.envelope?.work_template).length, 0);
  assert.equal(f.bridge.workTemplates.list('operator').length, 0);
  assert.equal(f.bridge.workTemplates.listProposals('operator').length, 1);

  const approved = await f.bridge.zeroSetupWork.approve({ request_id, confirmed: true }, 'operator');
  assert.equal(approved.execution_authorized, true);
  assert.ok(approved.technical.mission_id);
  assert.ok(approved.technical.plan_id);
  assert.equal(f.bridge.workTemplates.list('operator')[0].state, 'active');
  const mission = f.bridge.missions.require(approved.technical.mission_id);
  assert.ok(['ready', 'dispatching', 'running', 'verifying', 'awaiting_acceptance'].includes(mission.state), mission.state);
  // Owner approval triggers CAE; OpenCode runs without further ChatGPT/Cursor prompts.
  const done = await f.settle(approved.technical.mission_id);
  assert.equal(done.state, 'awaiting_acceptance');
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'beta\n');
  assert.equal(Buffer.from(fs.readFileSync(path.join(f.repo, 'fixture.txt'))).toString('hex'), '626574610a');
  assert.ok(done.verifications[0].evidence.some(c => c.id === 'task:fixture-test' && c.status === 'passed'));
  assert.equal(done.acceptance.length, 0);
  const replay = await f.bridge.zeroSetupWork.ask({
    instruction: 'Airodrom, change the test file from alpha to beta, verify the result, and tell me when you are finished.',
    request_id,
  }, 'mcp:zero-setup-test');
  assert.equal(replay.technical.mission_id, approved.technical.mission_id);
});

test('MCP catalog includes ask_airodrom and get_ask_status', () => {
  const names = TOOLS.map(t => t.name);
  assert.ok(names.includes('ask_airodrom'));
  assert.ok(names.includes('get_ask_status'));
  assert.ok(names.includes('list_authorized_scopes'));
  assert.equal(names.length, 36);
});

test('approval boundary rejects unconfirmed approve and MCP cannot register templates', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  const project = f.bridge.projects.createProject({ name: 'Human Acceptance Exact File', repositories: [f.repo] });
  f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Exact-file alpha to beta' });
  const request_id = randomUUID();
  await f.bridge.zeroSetupWork.ask({
    instruction: 'Change the test file from alpha to beta and verify it.',
    request_id,
  }, 'mcp:boundary');
  await assert.rejects(() => f.bridge.zeroSetupWork.approve({ request_id, confirmed: false }, 'operator'), /approval|confirm/i);
  assert.throws(() => f.bridge.workTemplates.register({
    project: 'x', workspace_alias: 'y', project_id: project.projectId, goal_id: randomUUID(),
    workspace: f.repo, allowed_files: ['fixture.txt'], diff_check: 'diff-check', tests: ['fixture-test'],
    duration_minutes: 60, confirmed: true,
  }, 'mcp:boundary'), /operator/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
});
