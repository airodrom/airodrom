'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const BridgeController = require('./fixtures/test-bridge.cjs');
const { BROKER_TOOLS, classifyValidationError, validateToolInput } = require('../src/capability-broker');

async function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/bridge-native-reliability-');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const bridge = await new BridgeController({ defaultRuntime: 'host',
    dataDir: path.join(root, 'data'), sourceProfile: profile,
    executable: path.join(__dirname, 'fixtures/host-worker.cjs'), allowFixtureWorker: true
  }).initialize();
  t.after(async () => { await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { bridge, root };
}

async function call(bridge, taskId, toolName, input, toolCallId = randomUUID()) {
  return bridge.capabilityBroker.execute(taskId, { toolName, input, toolCallId });
}

test('production broker registry exposes the full tool family for native forcing', () => {
  assert.equal(BROKER_TOOLS.size >= 20, true);
  for (const name of ['read', 'write', 'edit', 'ls', 'run_job', 'personal_memory_search', 'personal_memory_remember', 'project_list', 'project_next_action']) {
    assert.equal(BROKER_TOOLS.has(name), true, name);
  }
});

test('invalid tool arguments produce safe validation diagnostics without argument values', async t => {
  const { bridge } = await fixture(t);
  const task = bridge.tasks.get(bridge.createTask('Invalid args diagnostics').id);
  const denied = await call(bridge, task.id, 'read', { wrong: true });
  assert.equal(denied.allow, false);
  assert.equal(denied.decision.kind, 'invalid_tool_arguments');
  assert.equal(denied.decision.validation_error_class, 'missing_or_extra_field');
  assert.equal(denied.decision.tool_name, 'read');
  assert.deepEqual(denied.decision.invalid_field_names, ['wrong']);
  assert.equal(Object.hasOwn(denied.decision, 'input'), false);
  const classified = classifyValidationError('write', { path: 1 }, 'Invalid file path');
  assert.equal(classified.validation_error_class, 'field_value_invalid');
  assert.doesNotThrow(() => validateToolInput('ls', {}));
});

test('Personal Memory proposals require promotion and operator forget', async t => {
  const { bridge } = await fixture(t);
  const a=bridge.authorityRuntime,by=a.store.operator;
  a.qualification.prepare(by);const preference=a.memory.ingest({session_id:'lifecycle-fixture',chunk_id:'preference',timestamp:1,speaker:'operator',claim:'No micro-prompts.',kind:'personal_preference',subject_key:'workflow.micro_prompts',value:'forbidden'},by);const approved=a.memory.promote(preference.id,{},by);a.qualification.proveMemory(approved.id,by);
  const task = bridge.tasks.get(bridge.createTask('Personal Memory autonomy fixture').id);
  const alpha = await call(bridge, task.id, 'personal_memory_remember', {
    domain: 'personal', type: 'preference', subject: 'lifecycle.alpha', content: 'alpha', confidence: 80, sensitivity: 'normal'
  });
  assert.equal(alpha.allow, true);
  assert.equal(alpha.decision.automatic, true);
  const alphaCandidate = JSON.parse(alpha.output).candidateId;
  assert.equal(a.memory.candidate(alphaCandidate).status,'candidate');
  assert.equal(a.memoryItems({domain:'personal',query:'lifecycle.alpha'}).items.some(m=>m.subject==='lifecycle.alpha'),false);
  const alphaId=a.memory.promote(alphaCandidate,{},by).id;
  const beta = await call(bridge, task.id, 'personal_memory_update', {memoryId:alphaId,content:'beta'});
  assert.equal(beta.allow,true);assert.equal(beta.decision.automatic,true);
  assert.equal(a.memory.get(alphaId).value,'alpha');
  const betaId=a.memory.promote(JSON.parse(beta.output).candidateId,{supersedes_id:alphaId},by).id;
  assert.notEqual(betaId,alphaId);assert.equal(a.memory.get(alphaId).status,'superseded');
  const found=await call(bridge,task.id,'personal_memory_search',{query:'lifecycle.alpha',domain:'personal'});
  assert(JSON.parse(found.output).items.some(item=>item.memoryId===betaId&&item.content==='beta'));
  const forgot=await call(bridge,task.id,'personal_memory_forget',{memoryId:betaId});assert.equal(forgot.allow,false);
  assert.equal(a.memory.get(betaId).status,'active');a.memory.forget(betaId,by);
  assert.equal(a.memoryItems({domain:'personal',query:'lifecycle.alpha'}).items.some(m=>m.memoryId===betaId),false);

  const secret = await call(bridge, task.id, 'personal_memory_remember', {
    domain: 'personal', type: 'credential', subject: 'secret', content: 'password=hunter2-fixture', confidence: 10, sensitivity: 'normal'
  });
  assert.equal(secret.allow, false);
  assert.equal(secret.decision.kind, 'invalid_tool_arguments');
});

test('Project/Goal/Mission hierarchy and suggestion-only next action', async t => {
  const { bridge } = await fixture(t);
  const task = bridge.tasks.get(bridge.createTask('Project hierarchy fixture').id);
  const create = await call(bridge, task.id, 'project_create', {
    name: 'Hierarchy Fixture', nextAction: 'Create goal', preferredAgents: ['host']
  });
  assert.equal(create.allow, false);
  assert.equal(create.decision.kind, 'approval_required');
  bridge.approve(create.decision.approvalId);
  const project = JSON.parse((await bridge.resumeApproved(bridge.policy.approvals.get(create.decision.approvalId))).output);

  async function approveOnce(toolName, input) {
    const pending = await call(bridge, task.id, toolName, input);
    assert.equal(pending.decision.kind, 'approval_required');
    const approved = bridge.approve(pending.decision.approvalId);
    const result = await bridge.resumeApproved(approved);
    assert.equal(result.allow, true);
    return JSON.parse(result.output);
  }

  const goal = await approveOnce('project_create_goal', {
    projectId: project.projectId, name: 'Goal One', desiredOutcome: 'Hierarchy visible', nextAction: 'Create mission'
  });
  const mission = await approveOnce('project_create_mission', {
    goalId: goal.goalId, name: 'Mission One', acceptanceCriteria: ['Suggestion only'], nextAction: 'Inspect next action', preferredAgents: ['host']
  });
  await approveOnce('project_set_mission_status', {
    missionId: mission.missionId, status: 'active', nextAction: 'Inspect next action'
  });

  const listed = await call(bridge, task.id, 'project_list', {});
  assert.equal(JSON.parse(listed.output).items[0].projectId, project.projectId);
  const got = await call(bridge, task.id, 'project_get', { projectId: project.projectId });
  assert.equal(JSON.parse(got.output).projectId, project.projectId);
  const next = await call(bridge, task.id, 'project_next_action', {});
  assert.equal(JSON.parse(next.output).execution, 'not_dispatched');
  assert.equal(bridge.snapshotTask(bridge.tasks.get(task.id)).busy, false);
});

test('safe read/write/edit/ls/run_job status execute through the broker', async t => {
  const { bridge, root } = await fixture(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'edit-me.txt'), 'OLD');
  const task = bridge.tasks.get(bridge.createTask('File tools fixture', { workspace }).id);

  const listed = await call(bridge, task.id, 'ls', { path: '.' });
  assert.equal(listed.allow, true);
  assert.match(listed.output, /edit-me\.txt/);

  const written = await call(bridge, task.id, 'write', { path: 'write-me.txt', content: 'ok' });
  assert.equal(written.allow, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'write-me.txt'), 'utf8'), 'ok');

  const edited = await call(bridge, task.id, 'edit', {
    path: 'edit-me.txt', edits: [{ oldText: 'OLD', newText: 'NEW' }]
  });
  assert.equal(edited.allow, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'edit-me.txt'), 'utf8'), 'NEW');

  const read = await call(bridge, task.id, 'read', { path: 'edit-me.txt' });
  assert.equal(read.allow, true);
  assert.match(read.output, /NEW/);

  const status = await call(bridge, task.id, 'run_job', { jobName: 'bridge_restart_status' });
  assert.equal(status.allow, true);
  assert.match(status.output, /bridge_restart_status|cooldown|idle|ready/i);
});
