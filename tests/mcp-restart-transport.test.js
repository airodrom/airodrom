'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createClient } = require('../src/mcp-client');
const { runValidation } = require('../scripts/macos/validate.cjs');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-http-restart-'));
  fs.chmodSync(dataDir, 0o700);
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/restarting-http.cjs'), dataDir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const previousAgent = http.globalAgent, agent = new http.Agent({ keepAlive: true });
  http.globalAgent = agent;
  t.after(async () => {
    http.globalAgent = previousAgent;
    agent.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const state = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture.json')));
  // Deliberately block this event loop like the native spawnSync controller.
  // The child closes/rebinds its socket while the client's FIN event is queued.
  function wait(revision) {
    const result = spawnSync(process.execPath, ['-e', `
      const fs=require('node:fs'),deadline=Date.now()+5000;
      while(Date.now()<deadline){
        try{if(JSON.parse(fs.readFileSync(process.argv[1])).revision===Number(process.argv[2]))process.exit(0);}catch{}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
      process.exit(1);
    `, path.join(dataDir, 'fixture.json'), String(revision)], { timeout: 6000 });
    assert.equal(result.status, 0, 'Disposable HTTP fixture completed its control action');
    return state();
  }
  wait(0);
  const c = { dataDir, port: state().port };
  const discovery = () => ({ mcp: JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp.json'))), token: JSON.parse(fs.readFileSync(path.join(dataDir, 'ui.json'))).token });
  const status = () => {
    const value = state();
    return { state: value.state, pid: 100 + value.generation, endpoint: `http://127.0.0.1:${c.port}`, managed: true, tasks: { active: 0 }, mcp: { ready: value.state === 'Connected' } };
  };
  function control(action) {
    if (action === 'status' || action === 'open' || (action === 'start' && state().state === 'Connected')) return status();
    const revision = state().revision + 1;
    child.send({ action, revision });
    wait(revision);
    return status();
  }
  const primePool = () => new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: c.port, path: '/api/mcp/health', headers: { authorization: `Bearer ${discovery().mcp.token}` } }, response => {
      response.on('error', reject);
      response.resume();
      response.on('end', () => setImmediate(() => {
        assert.equal(response.statusCode, 200);
        assert(Object.values(agent.freeSockets).some(sockets => sockets.length), 'Keepalive socket was pooled before the synchronous lifecycle change');
        resolve();
      }));
    });
    request.on('error', reject);
  });
  return { c, state, discovery, status, control, primePool };
}

test('same MCP client rereads discovery after synchronous restart without reusing a stale pooled socket or replaying calls', async t => {
  const f = fixture(t), client = createClient({ dataDir: f.c.dataDir });
  assert.equal((await client('get_task_status', { task_id: 'existing-task' })).task_id, 'existing-task');
  await f.primePool();
  f.control('restart');
  assert.equal((await client('get_task_status', { task_id: 'existing-task' })).task_id, 'existing-task');
  assert.deepEqual(f.state().calls.filter(call => call.route === '/api/mcp/call'), [
    { route: '/api/mcp/call', status: 200, generation: 0 },
    { route: '/api/mcp/call', status: 200, generation: 1 }
  ]);
});

test('validator probes old credentials on fresh connections despite unrelated pooled sockets across synchronous lifecycle controls', async t => {
  const f = fixture(t);
  const result = await runValidation({
    config: () => f.c,
    helper: async (_c, action) => {
      if (action === 'stop' || action === 'restart') await f.primePool();
      return f.control(action);
    },
    readTasks: () => [{ id: 'existing-task', sessionId: 'saved-session', source: { transport: 'mcp' } }],
    uiDiscovery: f.discovery,
    lockExists: () => f.state().state !== 'Stopped',
    listeners: () => ({ status: 0, stdout: `p${f.status().pid}\nn127.0.0.1:${f.c.port}\n` })
  });
  assert.equal(result.ok, true);
  assert.deepEqual(f.state().calls.filter(call => call.status === 401), [
    { route: '/api/mcp/health', status: 401, generation: 1 },
    { route: '/api/mcp/health', status: 401, generation: 2 }
  ]);
  assert.deepEqual(f.state().calls.filter(call => call.route === '/api/status'), [
    { route: '/api/status', status: 200, generation: 1 },
    { route: '/api/status', status: 200, generation: 2 }
  ]);
  assert.equal(f.state().calls.filter(call => call.route === '/api/mcp/call').length, 2);
});
