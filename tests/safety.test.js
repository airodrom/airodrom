'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const SafetyPolicy = require('../src/safety-policy');

function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-policy-'));
  const workspace = path.join(directory, 'task');
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policy = new SafetyPolicy(options);
  policy.registerTask({ id: 'a', sessionId: 'session-a', workspace });
  return { policy, workspace, directory };
}
const call = input => ({ toolName: 'bash', input, toolCallId: 'call-1' });

test('requires exact input, consumes once, deduplicates pending and keeps an audit', t => {
  const { policy } = fixture(t);
  const events = [];
  policy.on('audit', event => events.push(event));
  const first = policy.check('a', call({ command: 'rm disposable.txt', timeout: 10 }));
  assert.equal(first.allow, false);
  assert.equal(policy.check('a', call({ timeout: 10, command: 'rm disposable.txt' })).approvalId, first.approvalId);
  policy.approve(first.approvalId);
  assert.equal(policy.check('a', call({ command: 'rm other.txt', timeout: 10 })).allow, false);
  assert.equal(policy.check('a', call({ command: 'rm disposable.txt', timeout: 20 })).allow, false);
  assert.equal(policy.check('a', { ...call({ timeout: 10, command: 'rm disposable.txt' }), toolCallId: 'retry-2' }).allow, true);
  assert.equal(policy.list().find(a => a.id === first.approvalId).status, 'consumed');
  assert.equal(policy.check('a', call({ command: 'rm disposable.txt', timeout: 10 })).allow, false);
  assert.ok(events.every(event => event.timestamp && event.taskId === 'a' && event.toolName === 'bash' && event.input && event.decision));
});

test('task and session isolation, revocation, rejected grants, restart', t => {
  const { policy, workspace } = fixture(t);
  policy.registerTask({ id: 'b', sessionId: 'session-b', workspace });
  const input = call({ command: 'touch disposable' });
  const a = policy.check('a', input);
  policy.approve(a.approvalId);
  assert.equal(policy.check('b', input).allow, false);
  policy.registerTask({ id: 'a', sessionId: 'replacement', workspace });
  assert.equal(policy.list('a')[0].status, 'revoked');
  assert.equal(policy.check('a', input).allow, false);
  const pending = policy.check('b', input);
  policy.reject(pending.approvalId);
  assert.throws(() => policy.approve(pending.approvalId));
  policy.revokeTask('b');
  assert.equal(policy.check('b', input).allow, false);
  const restarted = new SafetyPolicy();
  restarted.registerTask({ id: 'a', sessionId: 'replacement', workspace });
  assert.equal(restarted.check('a', input).allow, false);
});

test('expires pending and approved grants after the configured human review window', t => {
  let now = 1000;
  const { policy } = fixture(t, { now: () => now });
  const pending = policy.check('a', call({ command: 'touch a' }));
  const approved = policy.check('a', call({ command: 'touch b' }));
  policy.approve(approved.approvalId);
  now += 59 * 60 * 1000;
  assert.equal(policy.list().find(a => a.id === approved.approvalId).status, 'approved');
  now += 60 * 1000;
  assert.throws(() => policy.approve(pending.approvalId));
  assert.equal(policy.list().find(a => a.id === approved.approvalId).status, 'expired');
  assert.equal(policy.check('a', call({ command: 'touch b' })).allow, false);
});

test('allows safe reads and permanently rejects outside paths and symlink escapes', t => {
  const { policy, workspace, directory } = fixture(t);
  fs.writeFileSync(path.join(workspace, 'safe.txt'), 'safe');
  fs.writeFileSync(path.join(directory, 'outside.txt'), 'outside');
  assert.equal(policy.check('a', { toolName: 'read', input: { path: 'safe.txt' } }).allow, true);
  for (const supplied of ['../outside.txt', path.join(directory, 'outside.txt')]) {
    const result = policy.check('a', { toolName: 'read', input: { path: supplied } });
    assert.equal(result.allow, false);
    assert.equal(result.approvalId, undefined);
  }
  fs.symlinkSync(path.join(directory, 'outside.txt'), path.join(workspace, 'escape'));
  assert.equal(policy.check('a', { toolName: 'read', input: { path: 'escape' } }).allow, false);
  fs.symlinkSync(directory, path.join(workspace, 'escape-dir'));
  assert.equal(policy.check('a', { toolName: 'write', input: { path: 'escape-dir/new.txt', content: 'x' } }).approvalId, undefined);
  assert.equal(policy.check('a', { toolName: 'grep', input: { path: '.', pattern: 'x' } }).allow, true);
});

test('blocks secrets and recursive secret discovery; protects installed and broker files', t => {
  const { policy, workspace } = fixture(t);
  fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=x');
  assert.equal(policy.check('a', { toolName: 'read', input: { path: '.env' } }).approvalId, undefined);
  assert.equal(policy.check('a', { toolName: 'grep', input: { path: '.', pattern: 'SECRET' } }).allow, true);
  fs.mkdirSync(path.join(workspace, 'public'));
  fs.writeFileSync(path.join(workspace, 'public/a'), 'a');
  assert.equal(policy.check('a', { toolName: 'grep', input: { path: 'public', pattern: 'a' } }).allow, true);
  const protectedPolicy = new SafetyPolicy({ protectedPaths: [path.join(workspace, 'public')] });
  protectedPolicy.registerTask({ id: 'a', sessionId: 's', workspace });
  const result = protectedPolicy.check('a', { toolName: 'write', input: { path: 'public/a', content: 'overwrite' } });
  assert.equal(result.allow, false);
  assert.equal(result.approvalId, undefined);
});

test('malformed inputs fail closed; unknown tools require approvals and returned records are copies', t => {
  const { policy } = fixture(t);
  for (const malformed of [undefined, null, {}, { toolName: 'bash', input: {} }, { toolName: 'read', input: { path: 2 } }, { toolName: 'bash', input: { command: 'x', surprise: undefined } }, { toolName: 'bash', input: [] }, { toolName: 'bash', input: { command: 'x', array: Array(2) } }]) {
    const result = policy.check('a', malformed);
    assert.equal(result.allow, false);
    assert.equal(result.approvalId, undefined);
  }
  const result = policy.check('a', { toolName: 'arbitrary', input: { action: 'x' } });
  assert.equal(result.allow, false);
  assert.ok(result.approvalId);
  policy.list()[0].status = 'approved';
  assert.equal(policy.check('a', { toolName: 'arbitrary', input: { action: 'x' } }).allow, false);
});

test('generated task workspace permits ordinary mutations while bridge internals stay protected', t => {
  const id = randomUUID();
  const taskDirectory = path.resolve(__dirname, '../.runtime/tasks', id);
  const workspace = path.join(taskDirectory, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(taskDirectory, { recursive: true, force: true }));
  const policy = new SafetyPolicy();
  policy.registerTask({ id, sessionId: 's', workspace });
  assert.throws(() => policy.registerTask({ id: randomUUID(), sessionId: 'other', workspace }), /not a task workspace/);
  const write = policy.check(id, { toolName: 'write', input: { path: 'fixture', content: 'x' } });
  assert.equal(write.allow, true);
  assert.ok(policy.check(id, call({ command: `rm '${path.join(workspace, 'fixture')}'` })).approvalId);
  assert.equal(policy.check(id, call({ command: `rm '${path.resolve(__dirname, '../src/safety-policy.js')}'` })).approvalId, undefined);
  assert.equal(policy.check(id, { toolName: 'write', input: { path: '../session.jsonl', content: 'x' } }).approvalId, undefined);
});

test('extension proves readiness through broker, fails closed, and refuses direct RPC bash', async t => {
  const { default: extension } = await import('../src/safety-extension.mjs');
  const { EventEmitter } = require('node:events');
  const handlers = new Map();
  const previousSocket = process.env.BRIDGE_POLICY_SOCKET;
  const previousToken = process.env.BRIDGE_TASK_TOKEN;
  delete process.env.BRIDGE_POLICY_SOCKET;
  delete process.env.BRIDGE_TASK_TOKEN;
  await extension({ on: (name, handler) => handlers.set(name, handler), registerTool: () => {} });
  const ctx = { cwd: '/workspace', sessionManager: { getSessionId: () => 'test-session' } };
  const tool = call({ command: 'rm disposable.txt' });
  t.after(async () => {
    await handlers.get('session_shutdown')();
    if (previousSocket === undefined) delete process.env.BRIDGE_POLICY_SOCKET; else process.env.BRIDGE_POLICY_SOCKET = previousSocket;
    if (previousToken === undefined) delete process.env.BRIDGE_TASK_TOKEN; else process.env.BRIDGE_TASK_TOKEN = previousToken;
  });
  await assert.rejects(handlers.get('session_start')({}, ctx), /not configured/);
  assert.equal((await handlers.get('tool_call')(tool)).block, true);
  await assert.rejects(handlers.get('user_bash')({ command: 'echo bypass' }), /Direct RPC bash is disabled/);

  // Source simulation: this verifies the extension's broker protocol without
  // requiring a Unix listener from the restricted coding environment.
  process.env.BRIDGE_POLICY_SOCKET = '/private/tmp/fixture-policy.sock';
  process.env.BRIDGE_TASK_TOKEN = 'test-token';
  const seen = [];
  const originalRequest = http.request;
  http.request = (options, onResponse) => {
    const client = new EventEmitter();
    client.setTimeout = () => client;
    client.destroy = error => { if (error) queueMicrotask(() => client.emit('error', error)); return client; };
    client.end = rawBody => {
      seen.push({ path: options.path, authorization: options.headers.authorization, body: JSON.parse(rawBody) });
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      queueMicrotask(() => {
        onResponse(response);
        response.emit('data', JSON.stringify(options.path === '/ready' ? { ok: true } : { allow: true }));
        response.emit('end');
      });
    };
    return client;
  };
  t.after(() => { http.request = originalRequest; });
  await handlers.get('session_start')({}, ctx);
  // Unknown tools remain blocked even if a simulated broker reply claims allow.
  assert.equal((await handlers.get('tool_call')(tool)).block, true);
  assert.equal(seen[0].path, '/ready');
  assert.equal(seen[0].body.sessionId, 'test-session');
  assert.ok(seen.every(entry => entry.authorization === 'Bearer test-token'));
});
