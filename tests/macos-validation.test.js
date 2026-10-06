'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { inspect } = require('node:util');
const { runValidation, failureReport } = require('../scripts/macos/validate.cjs');

function fixture() {
  const calls = [], mcpCalls = [], rejected = [];
  const c = { dataDir: '/private/fixture', port: 43117 };
  let generation = 0, state = 'Connected';
  const status = () => ({ state, pid: state === 'Connected' ? 100 + generation : null, endpoint: `http://127.0.0.1:${c.port}`, managed: state === 'Connected', mcp: { ready: state === 'Connected' }, tasks: { active: 0 } });
  const discovery = () => ({ mcp: { token: `MCP_SECRET_${generation}` }, token: `UI_SECRET_0` });
  const tasks = [{ id: 'existing-task', sessionId: 'saved-session', source: { transport: 'mcp' } }];
  const dependencies = {
    config: () => c,
    helper: (_c, action) => {
      calls.push(action);
      if (action === 'stop') state = 'Stopped';
      else if (action === 'restart' || (action === 'start' && state === 'Stopped')) { generation++; state = 'Connected'; }
      return status();
    },
    readTasks: () => structuredClone(tasks),
    uiDiscovery: discovery,
    createClient: () => async (name, args) => { mcpCalls.push({ name, args }); return { task_id: args.task_id }; },
    lockExists: () => state !== 'Stopped',
    listeners: () => ({ status: 0, stdout: `p${status().pid}\nn127.0.0.1:${c.port}\n` }),
    credentialRejected: async (_c, token, route) => { rejected.push({ token, route }); return route === '/api/mcp/health'; }
  };
  return { dependencies, calls, mcpCalls, rejected, status, discovery, c };
}
async function failure(dependencies, expectedStage, expectedRecovery) {
  await assert.rejects(runValidation(dependencies), error => {
    const report = failureReport(error);
    assert.equal(report.ok, false);
    assert.equal(report.stage, expectedStage);
    assert.equal(report.recovery, expectedRecovery);
    assert.equal(error.cause, undefined);
    assert(!/SECRET|private\/fixture|existing-task|saved-session/.test(JSON.stringify(report) + inspect(error)));
    return true;
  });
}

test('validator preserves existing MCP task/session IDs and checks each credential lifecycle', async () => {
  const f = fixture();
  const result = await runValidation(f.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.pid, 102);
  assert.equal(result.taskCount, 1);
  assert.deepEqual(f.calls, ['status', 'start', 'stop', 'start', 'status', 'restart', 'open']);
  assert.deepEqual(f.mcpCalls, [
    { name: 'get_task_status', args: { task_id: 'existing-task' } },
    { name: 'get_task_status', args: { task_id: 'existing-task' } }
  ]);
  assert.deepEqual(f.rejected, [
    { token: 'MCP_SECRET_0', route: '/api/mcp/health' }, { token: 'UI_SECRET_0', route: '/api/status' },
    { token: 'MCP_SECRET_1', route: '/api/mcp/health' }, { token: 'UI_SECRET_0', route: '/api/status' }
  ]);
  assert(!JSON.stringify(result).includes('SECRET'));
});

test('failed initial checks never invoke lifecycle controls or recovery', async t => {
  for (const invalid of [{ state: 'Stopped' }, { managed: false }, { mcp: { ready: false } }, { tasks: { active: 1 } }]) {
    await t.test(JSON.stringify(invalid), async () => {
      const f = fixture(), helper = f.dependencies.helper;
      f.dependencies.helper = (c, action) => ({ ...helper(c, action), ...invalid });
      await failure(f.dependencies, 'initial-health', 'not-attempted');
      assert.deepEqual(f.calls, ['status']);
    });
  }
  const f = fixture();
  f.dependencies.readTasks = () => { throw new Error('SECRET task metadata'); };
  await failure(f.dependencies, 'saved-task-identities', 'not-attempted');
  assert.deepEqual(f.calls, ['status']);
});

test('helper stop failure reports its stage and leaves a connected service alone', async () => {
  const f = fixture(), helper = f.dependencies.helper;
  f.dependencies.helper = (c, action) => {
    if (action === 'stop') { f.calls.push(action); throw new Error('Could not stop the login service. SECRET'); }
    return helper(c, action);
  };
  await failure(f.dependencies, 'helper-stop', 'not-needed');
  assert.deepEqual(f.calls, ['status', 'start', 'stop', 'status']);
  assert.equal(f.status().pid, 100);
  assert.equal(f.rejected.length, 0);
});

test('newly active work prevents the next stop or restart', async t => {
  for (const phase of ['stop', 'restart']) await t.test(phase, async () => {
    const f = fixture(), helper = f.dependencies.helper;
    f.dependencies.helper = (c, action) => {
      const result = helper(c, action);
      if ((phase === 'stop' && action === 'start') || (phase === 'restart' && action === 'status' && f.status().pid === 101)) result.tasks.active = 1;
      return result;
    };
    await failure(f.dependencies, phase === 'stop' ? 'helper-start-idempotent' : 'before-restart-health', 'not-needed');
    assert(!f.calls.includes(phase));
    assert.equal(f.calls.at(-1), 'status');
  });
});

test('a failure after stopping makes one normal start recovery attempt', async () => {
  const f = fixture();
  f.dependencies.lockExists = () => true;
  await failure(f.dependencies, 'stopped-lock-removed', 'restored');
  assert.deepEqual(f.calls, ['status', 'start', 'stop', 'status', 'start']);
  assert.equal(f.status().state, 'Connected');
});

test('failed recovery is reported without retry loops or raw errors', async () => {
  const f = fixture(), helper = f.dependencies.helper;
  f.dependencies.lockExists = () => true;
  f.dependencies.helper = (c, action) => {
    if (action === 'start' && f.calls.includes('stop')) { f.calls.push(action); throw new Error('SECRET recovery error'); }
    return helper(c, action);
  };
  await failure(f.dependencies, 'stopped-lock-removed', 'failed');
  assert.deepEqual(f.calls, ['status', 'start', 'stop', 'status', 'start']);
});

test('credential lifecycle violations fail without disclosure', async t => {
  for (const phase of ['start', 'restart']) for (const credential of ['mcp', 'ui']) {
    await t.test(`${phase} ${credential}`, async () => {
      const f = fixture(), discovery = f.dependencies.uiDiscovery;
      f.dependencies.uiDiscovery = () => {
        const value = discovery();
        if (f.status().pid === (phase === 'start' ? 101 : 102)) {
          if (credential === 'mcp') value.mcp.token = `MCP_SECRET_${phase === 'start' ? 0 : 1}`;
          else value.token = 'UI_SECRET_changed';
        }
        return value;
      };
      await failure(f.dependencies, `${phase}-${credential}-token-${credential === 'mcp' ? 'rotation' : 'preserved'}`, 'not-needed');
      assert(!f.calls.includes('open'));
    });
  }
});

test('old MCP acceptance or preserved operator rejection fails closed', async t => {
  for (const credential of ['mcp', 'ui']) await t.test(credential, async () => {
    const f = fixture();
    f.dependencies.credentialRejected = async () => credential === 'ui';
    await failure(f.dependencies, credential === 'mcp' ? 'start-old-mcp-credential-rejected' : 'start-operator-credential-accepted', 'not-needed');
  });
});

test('validator detects a reused PID or changed session identity', async t => {
  await t.test('reused PID', async () => {
    const f = fixture(), helper = f.dependencies.helper;
    f.dependencies.helper = (c, action) => ({ ...helper(c, action), pid: 100 });
    await failure(f.dependencies, 'helper-start', 'not-needed');
  });
  await t.test('changed saved session', async () => {
    const f = fixture(), readTasks = f.dependencies.readTasks;
    let reads = 0;
    f.dependencies.readTasks = () => {
      const tasks = readTasks();
      if (reads++) tasks[0].sessionId = 'SECRET changed session';
      return tasks;
    };
    await failure(f.dependencies, 'task-session-identities-preserved', 'not-needed');
  });
});

test('validator rejects additional listeners or non-loopback binding', async t => {
  for (const stdout of ['p102\nn127.0.0.1:43117\nn*:43117\n', 'p102\nn*:43117\n', 'p102\nn127.0.0.1:43117\np103\nn127.0.0.1:43117\n']) {
    await t.test(stdout.trim(), async () => {
      const f = fixture();
      f.dependencies.listeners = () => ({ status: 0, stdout });
      await failure(f.dependencies, 'single-localhost-listener', 'not-needed');
    });
  }
});

test('real loopback requests verify old credentials receive 401, not merely a changed string', async t => {
  const f = fixture(), requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const current = request.url === '/api/mcp/health' ? f.discovery().mcp.token : f.discovery().token;
    response.writeHead(request.headers.authorization === `Bearer ${current}` ? 200 : 401);
    response.end('{}');
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  f.c.port = server.address().port;
  delete f.dependencies.credentialRejected;
  assert.equal((await runValidation(f.dependencies)).ok, true);
  assert.deepEqual(requests, ['/api/mcp/health', '/api/status', '/api/mcp/health', '/api/status']);
});

test('unexpected errors have a fixed public report', () => {
  const report = failureReport(new Error('SECRET raw error'));
  assert.equal(report.stage, 'unexpected');
  assert(!JSON.stringify(report).includes('SECRET'));
});
