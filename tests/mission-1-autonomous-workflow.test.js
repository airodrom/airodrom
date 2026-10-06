'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Bridge = require('../src/bridge-controller');
const ControlServer = require('../src/control-server');

test('SIMULATION: fake Pi result is durably correlated in the local MCP inbox', async t => {
  const root = fs.mkdtempSync('/private/tmp/pi-mission1-'), profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), '{}');
  const bridge = await new Bridge({ dataDir: path.join(root, 'data'), sourceProfile: profile, allowFixtureWorker: true, executable: path.join(__dirname, 'fixtures/fake-pi.cjs'), maxConcurrent: 2 }).initialize();
  const ui = new ControlServer(bridge, { port: 0 }); await ui.start();
  t.after(async () => { await ui.close(); await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const mcp = (name, args) => new Promise((resolve, reject) => {
    const http = require('node:http');
    const req = http.request({ hostname: '127.0.0.1', port: ui.port, path: '/api/mcp/call', method: 'POST', headers: { authorization: `Bearer ${ui.mcpToken}`, 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { reject(new Error(`Invalid fixture response: ${text}`)); } });
    });
    req.on('error', reject); req.end(JSON.stringify({ name, args }));
  });
  const requestId = `mission1-sim-${Date.now()}`;
  const receipt = await mcp('create_task', { description: 'Isolated Mission 1 simulation', workspace: 'isolated', message: 'Return the fixture response and stop.', request_id: requestId });
  assert.equal(receipt.status, 200);
  const task = bridge.tasks.get(receipt.body.task_id);
  assert.equal(task.workspace.startsWith(path.join(root, 'data', 'tasks')), true, 'fixture workspace must remain inside its disposable data directory');
  for (let attempt = 0; attempt < 300 && bridge.inFlight.has(task.id); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(task.status, 'completed');
  assert.equal(task.lastResult, 'FIXTURE_OK');
  const inbox = await mcp('get_task_events', { task_id: task.id });
  assert.equal(inbox.status, 200);
  const completed = inbox.body.events.filter(event => event.event_type === 'completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].task_id, task.id);
  assert.equal(completed[0].session_id, receipt.body.session_id);
  assert.equal(completed[0].request_id, requestId);
  assert.equal(completed[0].delivery, 'inbox_only');
  await mcp('acknowledge_task_event', { task_id: task.id, event_id: completed[0].event_id });
  assert.equal((await mcp('get_task_events', { task_id: task.id })).body.events.length, 0);
});

test('SIMULATION: lifecycle event without operator trigger configuration remains inbox-only', async t => {
  const root = fs.mkdtempSync('/private/tmp/pi-durable-trigger-'), profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), '{}');

  const bridge = await new Bridge({
    dataDir: path.join(root, 'data'),
    sourceProfile: profile,
    allowFixtureWorker: true, executable: path.join(__dirname, 'fixtures/fake-pi.cjs'),
    maxConcurrent: 1
  }).initialize();

  const ui = new ControlServer(bridge, { port: 0 });
  await ui.start();

  t.after(async () => {
    await ui.close();
    await bridge.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const chatGPTEvents = bridge.chatgptEvents;
  assert.ok(chatGPTEvents);

  // Verify basic functionality of the event system
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const testTask = bridge.createTask('Test trigger path', { workspace: path.join(root, 'workspace') });
  assert.ok(testTask.id);

  const task = bridge.tasks.get(testTask.id);
  task.source = { transport: 'mcp' };
  task.latestMcpRequestId = randomUUID();
  task.status = 'completed';
  bridge.tasks.save(task);

  const result = chatGPTEvents.publishLifecycle(task, 'completed');
  assert.ok(result);
  assert.equal(result.accepted, true);
  const eventsForTask = chatGPTEvents.list(task.id);
  assert.equal(eventsForTask.events.length, 1);
  assert.equal(eventsForTask.events[0].delivery, 'inbox_only');
  assert.equal(eventsForTask.events[0].task_id, task.id);

});

test('SIMULATION: fixture checkpoint is persisted as model narrative, not accepted mission evidence', async t => {
  const root = fs.mkdtempSync('/private/tmp/pi-checkpoint-'), profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), '{}');

  const bridge = await new Bridge({
    dataDir: path.join(root, 'data'),
    sourceProfile: profile,
    allowFixtureWorker: true, executable: path.join(__dirname, 'fixtures/fake-pi.cjs'),
    maxConcurrent: 1
  }).initialize();

  const ui = new ControlServer(bridge, { port: 0 });
  await ui.start();

  t.after(async () => {
    await ui.close();
    await bridge.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const task = bridge.createTask('Checkpoint Test Task', { workspace: path.join(root, 'workspace') });
  assert.ok(task.id);

  const checkpoint = {
    "objective": "Demonstrate autonomous execution with checkpointing",
    "nextStep": "Execute a task with mission_checkpoint tool",
    "verifiedFacts": [],
    "hypotheses": [
      "The system maintains autonomous execution paths",
      "Checkpoints can be saved and used for recovery",
      "Continuation after failure is possible"
    ],
    "decisions": [],
    "completedGates": [],
    "failedApproaches": [],
    "gitReferences": []
  };

  const missionCheck = bridge.memory.saveCheckpoint(task.id, checkpoint, { sessionId: task.sessionId, model: true });
  assert.ok(missionCheck.id);
  const saved = JSON.parse(bridge.memory.latestCheckpoint(task.id).content);
  assert.equal(saved.objective, checkpoint.objective);
  assert.equal(saved.verifiedFacts.length, 0);
  assert.deepEqual(saved.completedGates, []);

});
