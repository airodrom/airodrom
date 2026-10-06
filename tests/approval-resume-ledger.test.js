'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const BridgeController = require('../src/bridge-controller');
const ControlServer = require('../src/control-server');
const http = require('node:http');

async function fixture(t, { ttlMs = 60 * 60 * 1000 } = {}) {
  const root = fs.mkdtempSync('/private/tmp/bridge-approval-resume-');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const bridge = await new BridgeController({
    dataDir: path.join(root, 'data'), sourceProfile: profile,
    executable: path.join(__dirname, 'fixtures/fake-pi.cjs'), allowFixtureWorker: true,
    approvalTtlMs: ttlMs
  }).initialize();
  t.after(async () => { await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { bridge, root };
}

function settle(bridge, taskId) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const snap = bridge.snapshotTask(bridge.tasks.get(taskId));
      if (!snap.busy) return resolve(snap);
      if (Date.now() - started > 15_000) return reject(new Error('task did not settle'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function call(bridge, taskId, toolName, input, toolCallId = randomUUID()) {
  return bridge.capabilityBroker.execute(taskId, { toolName, input, toolCallId });
}

test('trusted-routine memory proposals are automatic and stay inactive without review', async t => {
  const { bridge } = await fixture(t);
  const task = bridge.tasks.get(bridge.createTask('Automatic memory write fixture').id);
  const remember = await call(bridge, task.id, 'personal_memory_remember', {
    domain: 'personal', type: 'preference', subject: 'auto.preference.20260930',
    content: 'Automatic under trusted-routine-actions-v1.', confidence: 90, sensitivity: 'normal'
  });
  assert.equal(remember.allow, true);
  assert.equal(remember.decision.automatic, true);
  assert.equal(remember.decision.policy_version, 'trusted-routine-actions-v1');
  assert.equal(bridge.personalMemory.stats().count, 0);
  assert.equal(JSON.parse(remember.output).status,'candidate');
  assert.equal(bridge.policy.list(task.id).length, 0);
});

test('approval resume executes the captured capability directly once', async t => {
  const { bridge } = await fixture(t);
  const requestId = 'named_project_write_gate_fixture_20260930';
  const created = bridge.createTask('Approval resume ledger fixture');
  const task = bridge.tasks.get(created.id);
  task.latestMcpRequestId = requestId;
  task.source = { ...(task.source || {}), transport: 'local', request_id: requestId };
  bridge.tasks.save(task);

  await bridge.prompt(task.id, 'Create a durable project after approval.');
  await settle(bridge, task.id);

  const instructions = bridge.ledger.list({ taskId: task.id, eventType: 'agent.instruction.sent', limit: 10 }).events;
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].request_id, requestId);
  assert.equal(instructions[0].idempotency_key, `instruction:${task.id}:${requestId}`);

  const projectInput = {
    name: 'Approval Resume Project',
    description: 'Exact fingerprint capture for direct approval resume.',
    nextAction: 'Retrieve hierarchy after approval.'
  };
  const pending = await call(bridge, task.id, 'project_create', projectInput, 'tool-call-project-1');
  assert.equal(pending.allow, false);
  assert.equal(pending.decision.kind, 'approval_required');
  const approvalId = pending.decision.approvalId;
  assert.ok(approvalId);

  const approvals = bridge.policy.list(task.id);
  assert.equal(approvals.filter(a => a.status === 'pending').length, 1);
  assert.ok(bridge.ledger.list({ taskId: task.id, eventType: 'approval.requested', limit: 5 }).events.some(e => e.metadata.approval_id === approvalId));

  const approved = bridge.approve(approvalId);
  assert.equal(approved.status, 'approved');
  assert.ok(bridge.ledger.list({ taskId: task.id, eventType: 'approval.approved', limit: 5 }).events.some(e => e.metadata.approval_id === approvalId));

  // Direct host execution — no model reconstruction, no Local Ollama grant.
  const written = await bridge.resumeApproved(approved);
  assert.equal(written.allow, true, 'approved exact fingerprint must execute once via direct resume');
  const project = JSON.parse(written.output);
  assert.equal(project.name, 'Approval Resume Project');
  assert.equal(bridge.tasks.get(task.id).projectId, project.projectId);

  const afterResume = bridge.snapshotTask(bridge.tasks.get(task.id));
  assert.equal(afterResume.busy, false);
  assert.notEqual(afterResume.failureKind, 'ledger_idempotency_conflict');
  assert.equal(bridge.ledger.health().state, 'healthy');
  assert.equal(afterResume.status, 'completed');

  const resumes = bridge.ledger.list({ taskId: task.id, eventType: 'approval.resume', limit: 10 }).events;
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].idempotency_key, `approval-resume:${approvalId}`);
  assert.equal(resumes[0].metadata.approval_id, approvalId);
  assert.equal(resumes[0].metadata.original_request_id, requestId);
  assert.equal(resumes[0].metadata.fingerprint, approved.fingerprint);
  assert.equal(
    bridge.ledger.list({ taskId: task.id, eventType: 'agent.instruction.sent', limit: 10 }).events.length,
    1,
    'approval resume must not create another agent.instruction.sent under the same request id'
  );

  const duplicate = await call(bridge, task.id, 'project_create', projectInput, 'tool-call-project-dup');
  assert.equal(duplicate.allow, false, 'exact replay must not execute twice');
  assert.equal(bridge.policy.list(task.id).find(a => a.id === approvalId)?.status, 'consumed');

  const modified = await call(bridge, task.id, 'project_create', {
    ...projectInput, description: 'changed after approval'
  }, 'tool-call-project-modified');
  assert.equal(modified.allow, false);
  assert.equal(modified.decision.kind, 'approval_required');

  const listed = await call(bridge, task.id, 'project_list', {});
  assert.equal(listed.allow, true);
  assert.equal(JSON.parse(listed.output).items[0].projectId, project.projectId);

  const finalSnap = bridge.snapshotTask(bridge.tasks.get(task.id));
  assert.equal(finalSnap.busy, false);
  assert.equal(bridge.ledger.health().state, 'healthy');
});

test('rejected, expired, and cross-task approvals cannot execute or resume', async t => {
  const { bridge } = await fixture(t, { ttlMs: 30 });
  const taskA = bridge.tasks.get(bridge.createTask('Approval denial fixture A').id);
  const taskB = bridge.tasks.get(bridge.createTask('Approval denial fixture B').id);
  const input = {
    name: 'Deny Fixture Project',
    description: 'must never persist from rejected or foreign approvals'
  };

  const pending = await call(bridge, taskA.id, 'project_create', input);
  assert.equal(pending.decision.kind, 'approval_required');
  const rejected = bridge.reject(pending.decision.approvalId);
  assert.equal(rejected.status, 'rejected');
  await assert.rejects(
    () => bridge.resumeApproved(rejected),
    /Only an approved grant can be resumed/
  );
  const afterReject = await call(bridge, taskA.id, 'project_create', input);
  assert.equal(afterReject.allow, false);

  const pendingExpire = await call(bridge, taskA.id, 'project_create', {
    ...input, name: 'Expire Fixture Project'
  });
  const liveApproval = bridge.policy.approvals.get(pendingExpire.decision.approvalId);
  liveApproval.expiresAt = Date.now() - 1;
  assert.throws(() => bridge.approve(liveApproval.id), /not pending|expired/i);
  const expiredCall = await call(bridge, taskA.id, 'project_create', {
    ...input, name: 'Expire Fixture Project'
  });
  assert.equal(expiredCall.allow, false);

  const foreign = await call(bridge, taskA.id, 'project_create', {
    ...input, name: 'Cross Task Fixture Project'
  });
  const foreignApproved = bridge.approve(foreign.decision.approvalId);
  const cross = await call(bridge, taskB.id, 'project_create', {
    ...input, name: 'Cross Task Fixture Project'
  });
  assert.equal(cross.allow, false);
  assert.equal(cross.decision.kind, 'approval_required');
  assert.notEqual(cross.decision.approvalId, foreignApproved.id);

  // Stale approved grant for task A must not execute under task B via resume.
  const stolen = { ...foreignApproved, taskId: taskB.id };
  await assert.rejects(() => bridge.resumeApproved(stolen), /Approval task mismatch/);
  assert.equal(bridge.projects.listProjects().length, 0);
});

test('Control Center approve path resumes without colliding with the original instruction request id', async t => {
  const { bridge } = await fixture(t);
  const server = new ControlServer(bridge, { port: 0 });
  await server.start();
  t.after(async () => { await server.close(); });

  const requestId = 'control_center_approval_resume_20260930';
  const created = bridge.createTask('Control Center approval resume');
  const task = bridge.tasks.get(created.id);
  task.latestMcpRequestId = requestId;
  bridge.tasks.save(task);
  await bridge.prompt(task.id, 'Store a durable project after approval.');
  await settle(bridge, task.id);

  const input = {
    name: 'Control Center Resume Project',
    description: 'Control Center resume must not ledger-collide.'
  };
  const pending = await call(bridge, task.id, 'project_create', input);
  const approvalId = pending.decision.approvalId;

  const body = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.port, path: `/api/approvals/${approvalId}/approve`, method: 'POST',
      headers: {
        authorization: `Bearer ${server.token}`,
        'content-type': 'application/json',
        'content-length': 2
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(body.status, 202);
  await settle(bridge, task.id);

  const taskAfter = bridge.tasks.get(task.id);
  assert.notEqual(taskAfter.failureKind, 'ledger_idempotency_conflict');
  assert.equal(bridge.ledger.health().state, 'healthy');
  assert.equal(bridge.ledger.list({ taskId: task.id, eventType: 'approval.resume', limit: 5 }).events.length, 1);
  assert.equal(bridge.ledger.list({ taskId: task.id, eventType: 'agent.instruction.sent', limit: 5 }).events.length, 1);
  assert.equal(taskAfter.projectId, JSON.parse(
    (await call(bridge, task.id, 'project_list', {})).output
  ).items[0].projectId);
  assert.equal(bridge.policy.list(task.id).find(a => a.id === approvalId)?.status, 'consumed');
  assert.equal(bridge.snapshotTask(taskAfter).busy, false);
});

test('altered tool after approval fails closed and cancelled tasks cannot resume', async t => {
  const { bridge } = await fixture(t);
  const task = bridge.tasks.get(bridge.createTask('Altered approval fixture').id);
  const input = { name: 'Alter Guard Project', description: 'fingerprint bound' };
  const pending = await call(bridge, task.id, 'project_create', input);
  const approved = bridge.approve(pending.decision.approvalId);

  const alteredTool = await call(bridge, task.id, 'project_archive', { projectId: randomUUID() });
  assert.equal(alteredTool.allow, false);

  const alteredArgs = await call(bridge, task.id, 'project_create', { ...input, name: 'Altered Name' });
  assert.equal(alteredArgs.allow, false);
  assert.equal(alteredArgs.decision.kind, 'approval_required');

  await bridge.cancel(task.id);
  await assert.rejects(() => bridge.resumeApproved(approved), /Cancelled tasks cannot resume/);
  assert.equal(bridge.projects.listProjects().length, 0);
});
