'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SafetyPolicy = require('../src/safety-policy');
const { SafeDiagnostics, classify } = require('../src/safe-diagnostics');
const bash = command => ({ toolName: 'bash', input: { command } });

test('bounded bridge log reads auto-run while private paths, aliases and writes remain blocked', async t => {
  const root = fs.mkdtempSync('/private/tmp/bridge-log-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.runtime');
  fs.mkdirSync(runtime);
  const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  for (const name of ['service.log', 'background-service.log', 'secrets.log', 'state.json']) fs.writeFileSync(path.join(runtime, name), content);
  fs.writeFileSync(path.join(root, '.env'), 'private');
  fs.mkdirSync(path.join(root, 'subdir'));
  for (let restart = 0; restart < 2; restart++) {
    const policy = new SafetyPolicy();
    // Isolate the bridge layout; never edit or expose the running service's logs.
    policy.bridgeRoot = root; policy.runtimeRoots = [runtime]; policy.protectedPaths = [root, runtime];
    const task = policy.registerTask({ id: 'logs', sessionId: 's', workspace: root });
    const reader = new SafeDiagnostics(policy);
    for (const [command, first, count] of [
      ['tail -n 20 .runtime/service.log', 41, 20],
      ['head -n 3 .runtime/service.log', 1, 3],
      ['tail --lines=2 .runtime/background-service.log', 59, 2],
      ['head -n2 .runtime/service.log', 1, 2],
      ['tail .runtime/service.log', 21, 40],
      ['cat .runtime/service.log', 1, 60],
    ]) for (const wrapped of [command, `cd '${root}' && ${command}`]) {
      const verdict = policy.check(task.id, bash(wrapped));
      assert.equal(verdict.allow, true, wrapped); assert.equal(verdict.approvalId, undefined);
      const lines = (await reader.execute(task, wrapped)).trim().split('\n');
      assert.equal(lines.length, count); assert.equal(lines[0], `line ${first}`);
    }
    const read = { toolName: 'read', input: { path: '.runtime/service.log', offset: 2, limit: 3 } };
    assert.equal(policy.check(task.id, read).allow, true);
    assert.equal(reader.read(task, { ...read.input, op: 'cat' }).trim(), 'line 2\nline 3\nline 4');
    assert.deepEqual(policy.list(task.id), []);
    for (const command of ['tail -n 20 .runtime/secrets.log', 'head -n 2 .runtime/state.json', 'cat .env', 'tail -n 2 /etc/hosts', 'ls .runtime', 'grep line .runtime/service.log']) {
      assert.equal(policy.check(task.id, bash(command)).allow, false, command);
      await assert.rejects(reader.execute(task, command), /Protected/);
    }
    for (const command of ['tail -f .runtime/service.log', 'tail -n 2001 .runtime/service.log', 'tail -n +2 .runtime/service.log', 'head -n 0 .runtime/service.log', 'tail -n 2 .runtime/service.log > copy', 'tail -n 2 .runtime/service.log && touch sentinel', 'unknown-command']) {
      assert.equal(classify(command, root), null, command);
      assert.equal(policy.check(task.id, bash(command)).allow, false, command);
    }
    fs.symlinkSync(path.join(runtime, 'service.log'), path.join(root, 'alias'));
    assert.equal(policy.check(task.id, bash('tail -n 2 alias')).allow, false);
    await assert.rejects(reader.execute(task, 'tail -n 2 alias'), /Protected/);
    fs.unlinkSync(path.join(root, 'alias'));
    fs.renameSync(path.join(runtime, 'service.log'), path.join(runtime, 'saved.log'));
    fs.symlinkSync(path.join(root, '.env'), path.join(runtime, 'service.log'));
    assert.equal(policy.check(task.id, bash('tail -n 2 .runtime/service.log')).allow, false);
    await assert.rejects(reader.execute(task, 'tail -n 2 .runtime/service.log'), /Protected/);
    fs.unlinkSync(path.join(runtime, 'service.log'));
    fs.renameSync(path.join(runtime, 'saved.log'), path.join(runtime, 'service.log'));
    policy.explicitProtectedPaths = [runtime];
    assert.equal(policy.check(task.id, read).allow, false);
    policy.explicitProtectedPaths = [];
    const other = policy.registerTask({ id: 'other', sessionId: 's', workspace: path.join(root, 'subdir') });
    assert.equal(policy.check(other.id, { ...read, input: { path: '../.runtime/service.log' } }).allow, false);
    assert.equal(policy.check(task.id, { toolName: 'write', input: { path: '.runtime/service.log', content: 'never' } }).allow, false);
    // Clear the parser-negative approvals before the rejected-write acceptance.
    for (const approval of policy.list(task.id)) if (approval.status === 'pending') policy.reject(approval.id);
    const write = policy.check(task.id, bash('gcloud run deploy fixture --project=never-execute'));
    assert.equal(write.allow, false); assert.equal(write.executionStatus, 'NOT EXECUTED'); assert.ok(write.approvalId);
    policy.reject(write.approvalId);
    assert.equal(policy.list(task.id).filter(a => ['pending', 'approved'].includes(a.status)).length, 0);
    assert.equal(fs.existsSync(path.join(root, 'sentinel')), false);
  }
});
