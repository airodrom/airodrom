'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const SafetyPolicy = require('../src/safety-policy');
const { SafeDiagnostics, classify } = require('../src/safe-diagnostics');
const BridgeController = require('./fixtures/test-bridge.cjs');
const ControlServer = require('../src/control-server');
const { McpTools } = require('../src/mcp-tools');
const root = path.resolve(__dirname, '..');
const bash = command => ({ toolName: 'bash', input: { command } });

test('workspace edits auto-allow while private and external paths stay denied', () => {
  const policy = new SafetyPolicy();
  policy.registerTask({ id: 'bridge', sessionId: 's', workspace: root });
  for (const toolName of ['write', 'edit']) {
    const call = { toolName, input: { path: `${toolName}-workspace-fixture.txt`, ...(toolName === 'write' ? { content: 'fixture only; never executed' } : { oldText: 'fixture', newText: 'replacement' }) } };
    const allowed = policy.check('bridge', call);
    assert.equal(allowed.allow, true); assert.equal(allowed.approvalId, undefined);
    assert.equal(policy.check('bridge', { ...call, input: { ...call.input, path: 'src/safety-policy.js' } }).allow, false);
    assert.equal(policy.check('bridge', { ...call, input: { ...call.input, path: 'src/safe-diagnostics.js' } }).allow, false);
  }
  for (const supplied of ['.runtime/new', '.git/config', '.env', '../outside', '.pi/auth.json']) {
    const verdict = policy.check('bridge', { toolName: 'write', input: { path: supplied, content: 'never written' } });
    assert.equal(verdict.allow, false); assert.equal(verdict.approvalId, undefined);
  }
  const extra = new SafetyPolicy({ protectedPaths: [path.join(root, 'src')] });
  extra.registerTask({ id: 'a', sessionId: 's', workspace: root });
  assert.equal(extra.check('a', { toolName: 'edit', input: { path: 'src/safety-policy.js' } }).approvalId, undefined);
});

test('recognized diagnostics auto-run after policy recreation and Git log respects its bound', async t => {
  const workspace = fs.mkdtempSync('/private/tmp/p0-reads-');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: workspace, stdio: 'pipe' }).toString().trim();
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(workspace, 'safe.txt'), 'first'); git('add', 'safe.txt'); git('commit', '-m', 'First');
  fs.writeFileSync(path.join(workspace, 'safe.txt'), 'second'); git('commit', '-am', 'Second');
  fs.writeFileSync(path.join(workspace, 'safe.txt'), 'third');
  const commands = ['git status', 'git status --short', 'git status --porcelain', 'git status --porcelain=v1', 'git rev-parse HEAD', 'git rev-parse --short HEAD', 'git rev-parse --abbrev-ref HEAD', 'git log -n 1', 'git log --max-count=1', 'git log -1 --oneline', 'git diff', 'git diff --stat', 'git diff --cached', 'ls', 'cat safe.txt', 'wc safe.txt', 'wc -l safe.txt', 'rg third .', 'find .', 'bridge health', 'bridge logs'];
  for (let restart = 0; restart < 2; restart++) {
    const policy = new SafetyPolicy();
    const task = { ...policy.registerTask({ id: 'a', sessionId: 's', workspace }), events: [] };
    const reader = new SafeDiagnostics(policy);
    for (const command of commands) {
      const verdict = policy.check('a', bash(command));
      assert.equal(verdict.allow, true, command); assert.equal(verdict.approvalId, undefined);
      const output = await reader.execute(task, command);
      if (command.startsWith('git log')) assert.equal(output.trim().split('\n').length, 1);
      if (command === 'git rev-parse HEAD') assert.equal(output.trim(), git('rev-parse', 'HEAD'));
      if (command === 'git diff') assert.match(output, /third/);
    }
    for (const command of ['launchctl list', 'ps -axo pid,ppid,stat,comm']) assert.equal(policy.check('a', bash(command)).allow, true);
    for (const command of ['git log -n 21', 'git log -n', 'git log --max-count=0', 'git rev-parse --git-dir', 'git diff --output=leak', 'git status; touch escape', 'unknown-command', 'gcloud compute instances list']) {
      assert.equal(classify(command), null, command);
      assert.equal(policy.check('a', bash(command)).allow, false, command);
    }
  }
});

test('all status surfaces normalize missing and terminal approvals without trusting MCP_OK', () => {
  for (const transition of ['empty', 'approved', 'consumed', 'expired', 'rejected', 'revoked']) {
    let now = 1000;
    const bridge = new BridgeController();
    bridge.policy = new SafetyPolicy({ now: () => now });
    const task = { ...bridge.policy.registerTask({ id: 'a', sessionId: 's', workspace: root }), status: 'approval_required', lastResult: 'MCP_OK', events: [], lastRunBlocked: true, lastBlockedAction: { executionStatus: 'NOT EXECUTED' } };
    let saves = 0;
    bridge.tasks = { transitions: () => [], list: () => [task], save: () => saves++ };
    if (transition !== 'empty') {
      const call = bash('unrecognized-command');
      const denied = bridge.policy.check('a', call);
      assert.equal(bridge.snapshotTask(task).status, 'approval_required');
      if (['approved', 'consumed'].includes(transition)) bridge.policy.approve(denied.approvalId);
      if (transition === 'consumed') bridge.policy.check('a', call);
      if (transition === 'expired') now += 60 * 60 * 1000;
      if (transition === 'rejected') bridge.policy.reject(denied.approvalId);
      if (transition === 'revoked') bridge.policy.revokeTask('a');
    }
    const mcp = new McpTools(bridge).status(task);
    assert.equal(mcp.status, transition === 'expired' ? 'approval_expired' : 'blocked', transition);
    assert.equal(mcp.last_run_blocked, true);
    assert.equal(bridge.snapshotTask(task).lastBlockedAction.executionStatus, 'NOT EXECUTED');
    assert.equal(mcp.result, 'MCP_OK'); assert.equal(mcp.result_untrusted, true);
    assert.equal(mcp.approvals.some(a => a.status === 'pending'), false);
    assert.equal(ControlServer.prototype.status.call({ bridge }).tasks.counts.approval_required, undefined);
    assert.equal(task.status, transition === 'expired' ? 'approval_expired' : 'blocked'); assert.equal(saves, 1);
  }
});


test('broker denial survives a settled MCP_OK narrative with no execution receipt', async t => {
  const { EventEmitter } = require('node:events');
  const bridge = new BridgeController();
  const db=new (require('node:sqlite').DatabaseSync)(':memory:');t.after(()=>db.close());bridge.ledger=new (require('../src/event-ledger').EventLedger)(db);
  const task = { ...bridge.policy.registerTask({ id: 'a', sessionId: 's', workspace: root }), executionAgent:'host', safetyLoaded: true, events: [], compactions: 0 };
  bridge.tasks = { transitions: () => [], get: () => task, save: () => {} };
  bridge.memory = { search: () => ({ items: [] }), latestCheckpoint: () => null, saveCheckpoint: () => ({ id: 'checkpoint', createdAt: 1 }) };
  bridge.diagnostics = { execute: async () => '' };
  const rpc = new EventEmitter();
  const runtime = { rpc };
  bridge.runtimes.set(task.id, runtime); bridge.tokens.set('fixture-token', task.id);
  bridge.ensureRuntime = async () => runtime;
  rpc.sendCommand = async command => {
    if (command.type === 'get_state') return {};
    if (command.type === 'get_session_stats') return {};
    const call = { ...bash('gcloud run deploy fixture --project=never-execute'), toolCallId: 'blocked-call' };
    const req = { method: 'POST', url: '/check', headers: { authorization: 'Bearer fixture-token' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(call)); } };
    let decision;
    await bridge.handlePolicy(req, { writeHead: () => {}, end: value => { decision = JSON.parse(value); } });
    assert.equal(decision.allow, false); assert.equal(decision.executionStatus, 'NOT EXECUTED');
    bridge.onWorkerEvent(task, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'MCP_OK' }], stopReason: 'stop' } });
    bridge.onWorkerEvent(task, { type: 'agent_settled' });
    return {};
  };
  await bridge.prompt('a', 'Check blocked execution evidence');
  let state = new McpTools(bridge).status(task);
  assert.equal(state.status, 'approval_required'); assert.equal(state.result, 'MCP_OK');
  assert.equal(bridge.snapshotTask(task).lastBlockedAction.toolCallId, 'blocked-call');
  assert.equal(bridge.snapshotTask(task).lastBlockedAction.executionStatus, 'NOT EXECUTED');
  bridge.reject(state.approvals[0].id);
  state = new McpTools(bridge).status(task);
  assert.equal(state.status, 'blocked'); assert.deepEqual(state.approvals, []);
  assert.equal(bridge.snapshotTask(task).lastBlockedAction.executionStatus, 'NOT EXECUTED');
});

test('wrapped acceptance reads share policy and broker routing without shell approvals', async t => {
  const workspace = fs.mkdtempSync('/private/tmp/p0-wrapped-');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: workspace, stdio: 'pipe' }).toString().trim();
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src/example.js'), 'approval fixture\n');
  fs.writeFileSync(path.join(workspace, 'src/example.mjs'), 'approval module\n');
  fs.writeFileSync(path.join(workspace, 'src/exclude.txt'), 'approval excluded\n');
  git('add', 'src'); git('commit', '-m', 'Fixture');
  const reads = ['git status', 'git status --short', 'git status --porcelain', 'git log -n 5 --oneline', 'git rev-parse HEAD', 'git rev-parse --short HEAD', 'git diff', 'git diff --stat', 'ls -la', 'cat src/example.js', 'rg -n approval src', 'grep -r "approval" src/ --include="*.js" --include="*.mjs"', 'pwd && ls -la', 'bridge health', 'bridge logs'];
  for (let restart = 0; restart < 2; restart++) {
    const policy = new SafetyPolicy();
    const task = { ...policy.registerTask({ id: 'wrapped', sessionId: 's', workspace }), events: [] };
    const reader = new SafeDiagnostics(policy);
    for (const read of reads) for (const command of [read, `cd '${workspace}' && ${read}`]) {
      const verdict = policy.check(task.id, bash(command));
      assert.equal(verdict.allow, true, command);
      const output = await reader.execute(task, command);
      if (read.startsWith('grep')) { assert.match(output, /example.js/); assert.match(output, /example.mjs/); assert.doesNotMatch(output, /excluded/); }
    }
    for (const command of ['ps -axo pid,ppid,stat,comm', 'launchctl list']) {
      assert.equal(policy.check(task.id, bash(`cd '${workspace}' && ${command}`)).allow, true);
    }
    assert.deepEqual(policy.list(task.id), []);
    const nested = `cd '${workspace}/src' && cat example.js`;
    assert.equal(policy.check(task.id, bash(nested)).allow, true);
    assert.match(await reader.execute(task, nested), /approval fixture/);
    for (const command of ['git status && touch sentinel', 'git status; touch sentinel', 'git status | sh', 'git diff --output=sentinel', 'git reset --hard', 'unknown-command', 'cat $(touch sentinel)', 'cd .. && git status', 'git status &&', 'cd . && cd .. && ls', 'rg --pre=sh approval src']) {
      const verdict = policy.check(task.id, bash(command));
      assert.equal(verdict.allow, false, command); assert.equal(verdict.executionStatus, 'NOT EXECUTED');
    }
    assert.equal(fs.existsSync(path.join(workspace, 'sentinel')), false);
    fs.symlinkSync('/private/tmp', path.join(workspace, 'escape'));
    assert.equal(policy.check(task.id, bash('cd escape && ls')).allow, false);
    fs.unlinkSync(path.join(workspace, 'escape'));
  }
  // Home-relative reads need an owned Git directory, also when this suite is
  // launched from a worktree whose Git pointer intentionally remains denied.
  const homeRepo = fs.mkdtempSync(path.join(path.dirname(root), 'p0-home-wrapper-'));
  t.after(() => fs.rmSync(homeRepo, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['init', '-q', homeRepo], { stdio: 'pipe' });
  fs.writeFileSync(path.join(homeRepo, 'fixture.txt'), 'synthetic home wrapper\n');
  execFileSync('/usr/bin/git', ['-C', homeRepo, 'add', '.'], { stdio: 'pipe' });
  execFileSync('/usr/bin/git', ['-C', homeRepo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture'], { stdio: 'pipe' });
  const policy = new SafetyPolicy();
  const task = policy.registerTask({ id: 'home-wrapper', sessionId: 's', workspace: homeRepo });
  for (const command of ['git status', 'git status --short', 'git status --porcelain', 'git log -n 5 --oneline', 'git rev-parse HEAD', 'git rev-parse --short HEAD']) {
    const homeRelative = path.relative(require('node:os').homedir(), homeRepo);
    const wrapped = `cd ~/${homeRelative} && ${command}`;
    assert.equal(policy.check(task.id, bash(wrapped)).allow, true);
    await new SafeDiagnostics(policy).execute(task, wrapped);
  }
  assert.deepEqual(policy.list(task.id), []);
});

test('Control Center credential and complete task index survive restart with truthful blocked evidence', async t => {
  const dir = fs.mkdtempSync('/private/tmp/p0-index-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const Manager = require('../src/task-session-model');
  const { atomicJSON } = require('../src/config');
  const tasks = new Manager(dir);
  const known = tasks.create('Known blocked acceptance fixture');
  Object.assign(known, { status: 'blocked', lastRunBlocked: true, lastBlockedAction: { executionStatus: 'NOT EXECUTED' }, lastResult: 'MCP_OK' }); tasks.save(known);
  const completed = tasks.create('Completed fixture'); completed.status = 'completed'; tasks.save(completed);
  const active = tasks.create('Active fixture'); active.status = 'thinking'; tasks.save(active);
  let token;
  for (let restart = 0; restart < 2; restart++) {
    const bridge = new BridgeController({ defaultRuntime: 'host', dataDir: dir });
    bridge.tasks = restart ? new Manager(dir) : tasks;
    bridge.snapshot = () => ({ bridge: { healthy: true }, tasks: bridge.tasks.list().map(task => bridge.snapshotTask(task)) });
    bridge.conversationEngine = { close: async () => {}, start: () => { throw Error('Task index fixture cannot call inference'); } };
    const ui = new ControlServer(bridge, { port: 0 }); await ui.start();
    try {
      token ||= ui.token;
      assert.equal(ui.token, token);
      assert.notEqual(ui.mcpToken, token);
      for (let reload = 0; reload < 2; reload++) {
        const response = await fetch(`${ui.origin}/api/state`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(response.status, 200);
        const state = await response.json(); assert.equal(state.tasks.length, 3);
        const blocked = state.tasks.find(task => task.id === known.id);
        assert.equal(blocked.status, 'blocked'); assert.deepEqual(blocked.approvals, []);
        assert.equal(blocked.lastBlockedAction.executionStatus, 'NOT EXECUTED');
        assert.equal(state.tasks.find(task => task.id === completed.id).status, 'completed');
        assert.equal(state.tasks.find(task => task.id === active.id).status, restart ? 'interrupted' : 'thinking');
      }
      assert.equal((await fetch(`${ui.origin}/api/state`)).status, 401);
      assert.equal((await fetch(`${ui.origin}/api/state`, { headers: { authorization: `Bearer ${ui.mcpToken}` } })).status, 401);
    } finally { await ui.close(); }
  }
  assert.equal(fs.statSync(path.join(dir, 'control-credential.json')).mode & 0o777, 0o600);
  atomicJSON(path.join(dir, 'control-credential.json'), { token: 'invalid' });
  assert.throws(() => new ControlServer({ dataDir: dir }), /Invalid Control Center credential/);
});

test('host broker refuses direct shell without a worker or model', async t => {
 const root=fs.mkdtempSync('/private/tmp/host-broker-');
 const bridge=await new BridgeController({dataDir:root}).initialize();
 t.after(async()=>{await bridge.shutdown();fs.rmSync(root,{recursive:true,force:true});});
 const task=bridge.tasks.get(bridge.createTask('Host boundary').id);
 const result=await bridge.capabilityBroker.execute(task.id,{toolName:'bash',input:{command:'touch escaped'},toolCallId:'direct-shell'});
 assert.equal(result.allow,false);assert.equal(fs.existsSync(path.join(task.workspace,'escaped')),false);
 assert.equal(bridge.runtimes.size,0);
});
