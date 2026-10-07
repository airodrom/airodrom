'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Bridge = require('./fixtures/test-bridge.cjs');
const { McpTools } = require('../src/mcp-tools');

async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('fixture did not settle');
}
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync('/private/tmp/pi-bootstrap-');
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), '{}');
  const bridge = await new Bridge({ defaultRuntime: 'host', dataDir: path.join(root, 'data'), sourceProfile: profile, allowFixtureWorker:true, executable: path.join(__dirname, 'fixtures/host-worker.cjs'), ...options }).initialize();
  t.after(async () => {
    const active = bridge.tasks.list().find(item => bridge.inFlight.has(item.id));
    if (active) await bridge.cancel(active.id).catch(() => {});
    await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true });
  });
  return bridge;
}

test('active deadline pauses during an actionable approval and resumes only after approval', async t => {
  const bridge = await fixture(t, { taskTimeoutMs: 80, deadlineWarningMs: 20 });
  const task = bridge.createTask('deadline pause');
  const running = bridge.prompt(task.id, 'never settle');
  await until(() => bridge.runtimes.get(task.id)?.deadline);
  const pending = bridge.policy.check(task.id, { toolName: 'bash', input: { command: 'rm only-a-fixture', timeout: 1 }, toolCallId: 'pause-fixture' });
  task.status = 'approval_required'; bridge.runtimes.get(task.id).deadline.pause();
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(task.stopReason, undefined);
  assert.equal(bridge.policy.list(task.id).find(a => a.id === pending.approvalId).status, 'pending');
  bridge.policy.approve(pending.approvalId); bridge.runtimes.get(task.id).deadline.resume();
  await assert.rejects(running, /deadline exceeded/);
  assert(bridge.tasks.transitions(task.id).some(entry => entry.state === 'deadline'));
});

test('MCP task completion automatically emits one correlated durable lifecycle event', async t => {
  const bridge = await fixture(t); const mcp = new McpTools(bridge);
  const receipt = await mcp.call('create_task', { description: 'event fixture', message: 'finish safely', request_id: `event-${randomUUID()}` });
  await until(() => !bridge.inFlight.has(receipt.task_id));
  const inbox = bridge.chatgptEvents.list(receipt.task_id);
  const completed = inbox.events.filter(event => event.event_type === 'completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].task_id, receipt.task_id);
  assert.equal(completed[0].session_id, receipt.session_id);
  assert.equal(completed[0].request_id, receipt.request_id);
  assert.equal(completed[0].grants_approval, false);
  assert.equal(bridge.chatgptEvents.publishLifecycle(bridge.tasks.get(receipt.task_id), 'completed', 'ignored duplicate').duplicate, true);
});
