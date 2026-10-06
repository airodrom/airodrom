'use strict';

// Exercises the same broker entry point used by safety-extension.mjs after Pi
// calls a registered tool. The only worker here is the disposable fake Pi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const BridgeController = require('../src/bridge-controller');

async function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/bridge-personal-memory-worker-tools-');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const bridge = await new BridgeController({ defaultRuntime: 'pi',
    dataDir: path.join(root, 'data'), sourceProfile: profile,
    executable: path.join(__dirname, 'fixtures/fake-pi.cjs'), allowFixtureWorker: true
  }).initialize();
  t.after(async () => { await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { bridge };
}

function task(bridge, description, options = {}) {
  return bridge.tasks.get(bridge.createTask(description, options).id);
}

async function call(bridge, taskId, toolName, input, toolCallId = randomUUID()) {
  return bridge.capabilityBroker.execute(taskId, { toolName, input, toolCallId });
}

async function approvedCall(bridge, taskId, toolName, input) {
  const toolCallId = randomUUID();
  const pending = await call(bridge, taskId, toolName, input, toolCallId);
  assert.equal(pending.allow, false, `${toolName} must require an exact approval`);
  assert.equal(pending.decision.kind, 'approval_required');
  bridge.approve(pending.decision.approvalId);
  const allowed = await call(bridge, taskId, toolName, input, toolCallId);
  assert.equal(allowed.allow, true, `${toolName} should consume its approved exact call`);
  return JSON.parse(allowed.output);
}

async function autoCall(bridge, taskId, toolName, input) {
  const allowed = await call(bridge, taskId, toolName, input);
  assert.equal(allowed.allow, true, `${toolName} should auto-allow under trusted-routine-actions-v1: ${require("../src/secret-observation").redactText(JSON.stringify(allowed))}`);
  assert.equal(allowed.decision.automatic, true);
  assert.equal(allowed.decision.policy_version, 'trusted-routine-actions-v1');
  return JSON.parse(allowed.output);
}

async function prompt(bridge, message) {
  const current = task(bridge, 'Prompt memory retrieval fixture');
  const result = await bridge.prompt(current.id, message);
  assert.equal(result.text, 'FIXTURE_OK');
  assert.equal(bridge.snapshotTask(current).busy, false);
  return current;
}

test('automatic Personal Memory retrieval accepts ordinary, multiline, feature-oriented, and maximum valid prompts', async t => {
  const { bridge } = await fixture(t);
  await prompt(bridge, 'Return the fixture response.');
  await prompt(bridge, `This is a valid long prompt about durable context.\n${'Personal Memory retrieval remains bounded and local.\n'.repeat(120)}`);
  await prompt(bridge, 'Use Personal Memory deliberately.\nSearch any relevant durable preference before responding.');
  await prompt(bridge, 'Review Projects, Goals, Missions, and the suggestion-only Next Action.\nDo not dispatch work.');
  const maximum = `${'maximum valid prompt memory retrieval '.repeat(2_000)}x`.slice(0, 59_000);
  const maximumTask = await prompt(bridge, maximum);
  assert.equal(bridge.tasks.get(maximumTask.id).mission.objective, maximum);
});

test('Pi worker memory writes become candidates; approved legacy reads remain scoped', async t => {
  const { bridge } = await fixture(t);
  const current = task(bridge, 'Personal Memory worker tool fixture');
  bridge.memory.save({ taskId: current.id, kind: 'note', content: 'Legacy checkpoint search stays compatible.', provenance: { source: 'operator-verified', sessionId: current.sessionId } });
  const legacy = await call(bridge, current.id, 'memory_search', { query: 'checkpoint search' });
  assert.equal(legacy.allow, true);
  assert.equal(JSON.parse(legacy.output).items[0].content, 'Legacy checkpoint search stays compatible.');

  const proposed = await autoCall(bridge, current.id, 'personal_memory_remember', {
    domain: 'personal', type: 'preference', subject: 'review style', content: 'Use concise review summaries.', confidence: 96, sensitivity: 'normal'
  });
  assert.equal(proposed.status, 'candidate');
  assert.equal(proposed.active, false);
  assert.equal(bridge.personalMemory.stats().count, 0);
  const personal = bridge.personalMemory.remember({domain:'personal',type:'preference',subject:'review style',content:'Use concise review summaries.',source:'user_explicit'});
  const found = await call(bridge, current.id, 'personal_memory_search', { query: 'concise review', domain: 'personal' });
  assert.equal(found.allow, true);
  assert.equal(JSON.parse(found.output).items[0].memoryId, personal.memoryId);
  const recent = await call(bridge, current.id, 'personal_memory_recent', { domain: 'personal', limit: 5 });
  assert.equal(recent.allow, true);
  assert.equal(JSON.parse(recent.output).items[0].memoryId, personal.memoryId);
  const got = await call(bridge, current.id, 'personal_memory_get', { memoryId: personal.memoryId });
  assert.equal(JSON.parse(got.output).item.content, 'Use concise review summaries.');
  const updated = await autoCall(bridge, current.id, 'personal_memory_update', {
    memoryId: personal.memoryId, content: 'Use concise review summaries with focused test counts.'
  });
  assert.equal(updated.status, 'candidate');
  assert.equal(bridge.personalMemory.get(personal.memoryId).content, 'Use concise review summaries.');
  const deniedForget = await call(bridge, current.id, 'personal_memory_forget', { memoryId: personal.memoryId });
  assert.equal(deniedForget.allow, false);
  assert.equal(bridge.personalMemory.forget(personal.memoryId).contentRemoved, true);

  const countBeforeSecret = bridge.personalMemory.stats().count;
  const secret = await call(bridge, current.id, 'personal_memory_remember', {
    domain: 'personal', type: 'credential', subject: 'forbidden', content: 'api_key=super-secret-value'
  });
  assert.equal(secret.allow, false);
  assert.equal(secret.decision.kind, 'invalid_tool_arguments');
  assert.equal(bridge.personalMemory.stats().count, countBeforeSecret);
  assert.equal(bridge.policy.safetyStops.has(current.id), false);

  const project = await approvedCall(bridge, current.id, 'project_create', {
    name: 'Worker-scoped Project', nextAction: 'Inspect the project-specific fixture.', preferredAgents: ['pi']
  });
  assert.equal(bridge.tasks.get(current.id).projectId, project.projectId);
  const projectCandidate = await autoCall(bridge, current.id, 'personal_memory_remember', {
    domain: 'project', type: 'fact', subject: 'storage', content: 'This Project stores durable project facts locally.'
  });
  const sessionCandidate = await autoCall(bridge, current.id, 'personal_memory_remember', {
    domain: 'session', type: 'note', subject: 'session evidence', content: 'This session has a bounded private working note.'
  });
  assert.equal(projectCandidate.status, 'candidate');
  assert.equal(sessionCandidate.status, 'session_only');
  const projectMemory=bridge.personalMemory.remember({domain:'project',projectId:project.projectId,type:'fact',subject:'storage',content:'Approved project fixture',source:'user_explicit'});
  const sessionMemory=bridge.personalMemory.remember({domain:'session',taskId:current.id,sessionId:current.sessionId,type:'note',subject:'session evidence',content:'Approved session fixture',source:'user_explicit'});
  const other = task(bridge, 'Separate Personal Memory worker fixture');
  const otherProject = await call(bridge, other.id, 'personal_memory_get', { memoryId: projectMemory.memoryId });
  const otherSession = await call(bridge, other.id, 'personal_memory_get', { memoryId: sessionMemory.memoryId });
  assert.equal(otherProject.allow, false); assert.equal(otherProject.executionFailed, true);
  assert.equal(otherSession.allow, false); assert.equal(otherSession.executionFailed, true);
  assert.equal((await call(bridge, other.id, 'personal_memory_search', { query: 'Project stores', domain: 'project' })).allow, false);
});

test('Pi worker Project, Goal, Mission, and Next Action tools stay task-scoped and suggestion-only', async t => {
  const { bridge } = await fixture(t);
  const current = task(bridge, 'Project worker tool fixture');
  const project = await approvedCall(bridge, current.id, 'project_create', {
    name: 'Pi Project Tool Fixture', nextAction: 'Review durable project state.', preferredAgents: ['pi']
  });
  const goal = await approvedCall(bridge, current.id, 'project_create_goal', {
    projectId: project.projectId, name: 'Worker access', desiredOutcome: 'Bounded project capability access', nextAction: 'Create a mission.'
  });
  const mission = await approvedCall(bridge, current.id, 'project_create_mission', {
    goalId: goal.goalId, name: 'Bounded Mission', acceptanceCriteria: ['Return only a suggestion'], nextAction: 'Inspect project state.', preferredAgents: ['pi']
  });
  const active = await approvedCall(bridge, current.id, 'project_set_mission_status', {
    missionId: mission.missionId, status: 'active', nextAction: 'Inspect project state.'
  });
  assert.equal(active.status, 'active');

  const listed = await call(bridge, current.id, 'project_list', {});
  assert.deepEqual(JSON.parse(listed.output).items.map(item => item.projectId), [project.projectId]);
  const read = await call(bridge, current.id, 'project_get', { projectId: project.projectId });
  assert.equal(JSON.parse(read.output).projectId, project.projectId);
  const summary = await call(bridge, current.id, 'project_summary', { projectId: project.projectId });
  assert.equal(JSON.parse(summary.output).missions[0].missionId, mission.missionId);
  const before = { inFlight: bridge.inFlight.size, leases: bridge.leases.size, taskStatus: bridge.tasks.get(current.id).status };
  const next = await call(bridge, current.id, 'project_next_action', {});
  const suggestion = JSON.parse(next.output);
  assert.equal(suggestion.projectId, project.projectId);
  assert.equal(suggestion.execution, 'not_dispatched');
  assert.equal(bridge.inFlight.size, before.inFlight); assert.equal(bridge.leases.size, before.leases); assert.equal(bridge.tasks.get(current.id).status, before.taskStatus);

  const unrelated = bridge.projects.createProject({ name: 'Control-only unrelated Project' });
  const denied = await call(bridge, current.id, 'project_get', { projectId: unrelated.projectId });
  assert.equal(denied.allow, false); assert.equal(denied.executionFailed, true);
  assert.equal(bridge.policy.safetyStops.has(current.id), false);

  const extension = fs.readFileSync(path.join(__dirname, '../src/safety-extension.mjs'), 'utf8');
  for (const name of ['personal_memory_get', 'personal_memory_search', 'personal_memory_recent', 'personal_memory_remember', 'personal_memory_update', 'personal_memory_forget', 'project_list', 'project_get', 'project_summary', 'project_next_action', 'project_create', 'project_create_goal', 'project_create_mission', 'project_set_mission_status', 'project_archive']) assert.match(extension, new RegExp(`name: '${name}'`));
  const controller = fs.readFileSync(path.join(__dirname, '../src/bridge-controller.js'), 'utf8');
  assert.match(controller, /toolAllowlist = .*personal_memory_get.*project_next_action/s);
});
