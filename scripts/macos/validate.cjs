'use strict';
// Live installed-service validation. Never creates/replays a Pi task.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { config, uiDiscovery } = require('./control.cjs');
const { createClient } = require('../../src/mcp-client');

function helper(c, action) {
  const result = spawnSync(c.helper, ['--action', action], { encoding: 'utf8', timeout: 35000, maxBuffer: 32768 });
  const value = JSON.parse(result.stdout || '{}');
  assert.equal(result.status, 0);
  assert.notEqual(value.state, 'Error');
  return value;
}
function readTasks(c) {
  return fs.readdirSync(path.join(c.dataDir, 'tasks'))
    .map(id => JSON.parse(fs.readFileSync(path.join(c.dataDir, 'tasks', id, 'task.json'))))
    .sort((a, b) => a.id.localeCompare(b.id));
}
function credentialRejected(c, token, route) {
  return new Promise((resolve, reject) => {
    // A synchronous helper restart can leave a dead keep-alive socket queued for cleanup.
    const request = http.get({ agent: false, hostname: '127.0.0.1', port: c.port, path: route, headers: { authorization: `Bearer ${token}` } }, response => {
      response.on('error', reject);
      const rejected = response.statusCode === 401;
      response.destroy();
      resolve(rejected);
    });
    request.setTimeout(1800, () => request.destroy(new Error('Credential check timed out')));
    request.on('error', reject);
  });
}
class ValidationFailure extends Error {
  constructor(stage, recovery) {
    // Never retain a raw assertion/helper error: it may contain credentials,
    // task content, private paths, or arbitrary subprocess output.
    super(`Live macOS validation failed at ${stage}. No test task was created.`);
    this.stage = stage;
    this.recovery = recovery;
  }
}
function failureReport(error) {
  return error instanceof ValidationFailure
    ? { ok: false, stage: error.stage, recovery: error.recovery, message: error.message }
    : { ok: false, stage: 'unexpected', recovery: 'unknown', message: 'Live macOS validation did not complete. No test task was created.' };
}

async function runValidation(overrides = {}) {
  const dependencies = {
    config, helper, readTasks, uiDiscovery, createClient, credentialRejected,
    lockExists: c => fs.existsSync(path.join(c.dataDir, 'bridge.lock')),
    listeners: c => spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${c.port}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' }),
    ...overrides
  };
  let stage = 'configuration', c, mutationAttempted = false;
  const healthy = status => {
    assert.equal(status.state, 'Connected');
    assert.equal(status.managed, true);
    assert.equal(status.mcp.ready, true);
    assert.equal(status.tasks.active, 0);
  };
  const control = async action => {
    if (['start', 'stop', 'restart'].includes(action)) mutationAttempted = true;
    return dependencies.helper(c, action);
  };
  const rotation = async (previous, current, phase) => {
    stage = `${phase}-mcp-token-rotation`;
    assert.notEqual(current.mcp.token, previous.mcp.token);
    stage = `${phase}-ui-token-preserved`;
    assert.equal(current.token, previous.token);
    stage = `${phase}-old-mcp-credential-rejected`;
    assert.equal(await dependencies.credentialRejected(c, previous.mcp.token, '/api/mcp/health'), true);
    stage = `${phase}-operator-credential-accepted`;
    assert.equal(await dependencies.credentialRejected(c, previous.token, '/api/status'), false);
  };
  try {
    c = dependencies.config();
    stage = 'initial-helper-status';
    const before = await control('status');
    stage = 'initial-health';
    healthy(before);
    stage = 'saved-task-identities';
    const existing = dependencies.readTasks(c), identities = existing.map(task => [task.id, task.sessionId]);
    stage = 'initial-discovery';
    const discoveryBefore = dependencies.uiDiscovery(c);
    const client = dependencies.createClient({ dataDir: c.dataDir });
    const mcpTask = existing.find(task => task.source?.transport === 'mcp');
    const readMcpTask = async () => {
      if (mcpTask) assert.equal((await client('get_task_status', { task_id: mcpTask.id }, { name: 'macOS read-only validation', version: '1' })).task_id, mcpTask.id);
    };
    stage = 'mcp-read-before';
    await readMcpTask();
    stage = 'helper-start-idempotent';
    const unchanged = await control('start');
    healthy(unchanged);
    assert.equal(unchanged.pid, before.pid);
    stage = 'helper-stop';
    assert.equal((await control('stop')).state, 'Stopped');
    stage = 'stopped-lock-removed';
    assert.equal(dependencies.lockExists(c), false);
    stage = 'helper-start';
    const started = await control('start');
    healthy(started);
    assert.notEqual(started.pid, before.pid);
    stage = 'start-discovery';
    const discoveryStarted = dependencies.uiDiscovery(c);
    await rotation(discoveryBefore, discoveryStarted, 'start');
    stage = 'before-restart-health';
    healthy(await control('status'));
    stage = 'helper-restart';
    const restarted = await control('restart');
    healthy(restarted);
    assert.notEqual(restarted.pid, started.pid);
    stage = 'restart-discovery';
    await rotation(discoveryStarted, dependencies.uiDiscovery(c), 'restart');
    stage = 'mcp-read-after';
    await readMcpTask();
    stage = 'task-session-identities-preserved';
    assert.deepEqual(dependencies.readTasks(c).map(task => [task.id, task.sessionId]), identities);
    stage = 'single-localhost-listener';
    const sockets = dependencies.listeners(c);
    assert.equal(sockets.status, 0);
    assert.deepEqual(sockets.stdout.split('\n').filter(line => /^p\d+$/.test(line)), [`p${restarted.pid}`]);
    assert.deepEqual(sockets.stdout.split('\n').filter(line => line.startsWith('n')), [`n127.0.0.1:${c.port}`]);
    stage = 'helper-open';
    assert.equal((await control('open')).state, 'Connected');
    return { ok: true, pid: restarted.pid, endpoint: restarted.endpoint, taskCount: identities.length, localMcp: mcpTask ? 'read-only call recovered' : 'authenticated health only', duplicateStart: 'same PID', stopStartRestart: 'passed', credentials: 'UI operator credential preserved and accepted; MCP rotated and previous MCP credentials rejected after start and restart', controlCenter: 'opened', actualLoginReboot: 'not performed' };
  } catch {
    let recovery = 'not-attempted';
    if (mutationAttempted) {
      let connected = false;
      try { connected = (await dependencies.helper(c, 'status')).state === 'Connected'; } catch { /* Try the normal ownership-checked start once. */ }
      if (connected) recovery = 'not-needed';
      else {
        try { healthy(await dependencies.helper(c, 'start')); recovery = 'restored'; }
        catch { recovery = 'failed'; }
      }
    }
    throw new ValidationFailure(stage, recovery);
  }
}
if (require.main === module) {
  runValidation().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify(failureReport(error), null, 2));
    process.exitCode = 1;
  });
}
module.exports = { runValidation, failureReport };
