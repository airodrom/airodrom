'use strict';
// Regression #142: run the REAL admission/dispatch methods with fixtureExecutable
// absent. Only platform, provider I/O, contract-validation dependency and host store
// plumbing are synthetic. No live Cursor, credentials, model, or paid network use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, createHash } = require('node:crypto');

const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function object(v, fields) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))) throw Error('Unexpected input fields');
  return v;
}
function identifier(v) { if (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(v)) throw Error('Invalid identifier'); return v; }
function text(v, name, max) { if (typeof v !== 'string' || !v.trim() || Buffer.byteLength(v) > max) throw Error('Invalid ' + name); return v; }
function transaction(db, fn) {
  const key = 't_' + randomUUID().replaceAll('-', '');
  db.exec('SAVEPOINT ' + key);
  try { const r = fn(); db.exec('RELEASE ' + key); return r; }
  catch (e) { db.exec('ROLLBACK TO ' + key); db.exec('RELEASE ' + key); throw e; }
}
function seal(c) { c.scope_fingerprint = hash({ project: c.project, permissions: c.permissions, execution: c.execution, budget: c.budget }); return c; }
const contracts = {
  KNOWN_PROVIDER_HOSTS: { cursor: ['api2.cursor.sh'] },
  assertIntact(c) {
    if (!c || c.scope_fingerprint !== hash({ project: c.project, permissions: c.permissions, execution: c.execution, budget: c.budget })) throw Error('Mission contract was altered after creation');
    return c;
  },
};
function loadSource(file, mocks, globals = {}) {
  const filename = path.resolve(__dirname, '..', 'src', file);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, Buffer, console,
    process, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    __filename: filename, __dirname: path.dirname(filename), ...globals,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name) });
  new vm.Script(fs.readFileSync(filename, 'utf8'), { filename }).runInContext(context);
  return module.exports;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-spend-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = Date.now();
  const events = [], missions = new Map();
  const store = { db, now: () => now, event: (...args) => events.push(args),
    requireMission: id => { const m = missions.get(id); if (!m) throw Error('Unknown Mission'); return m; },
    getMission: id => missions.get(id), request: (_owner, _id, _input, fn) => fn() };
  const shared = { './control-plane-store': { object, identifier, text, redactValue: v => v },
    './control-transaction': { transaction }, './mission-contract': contracts };
  const { MissionApprovals } = loadSource('mission-approval.js', shared);
  const b = { controlStore: store, options: {}, emit() {},
    missions: { assertAuthority(m) { b.missionApprovals.assertDispatch(m); if (m.state !== 'running') throw Error('Mission stopped'); } },
    controlContext: { inspect: () => ({ run_id: 'synthetic-run' }) } };
  b.missionApprovals = new MissionApprovals(b);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  for (const file of ['first.txt', 'second.txt']) fs.writeFileSync(path.join(workspace, file), 'pending\n');
  const c = seal({ project: { workspace, project_id: null },
    identity: { created_at: now, expires_at: now + 600000, goal_id: null },
    objective: { normalized_objective: 'Two declared files' },
    execution: { preferred_worker: 'cursor', mode: 'sandboxed_headless', sandbox: 'sandbox-exec' },
    permissions: { allowed_write_paths: ['first.txt', 'second.txt'],
      network: { mode: 'allowlist', allow: ['api2.cursor.sh'] }, personal_memory: { mode: 'none' }, vault_access: { mode: 'none' },
      external_disclosure: { authorized: true, providers: ['cursor'] } },
    budget: { max_worker_invocations: 2, max_repair_attempts: 1, max_wall_clock_ms: 180000 } });
  const task = { id: randomUUID(), controlPlaneMissionId: randomUUID(), contextPackId: randomUUID() };
  const m = { id: task.controlPlaneMissionId, task_id: task.id, state: 'running',
    envelope: { workspace, allowed_files: ['first.txt', 'second.txt'], contract: c, preferred_agent: 'cursor', fallback_agents: [] } };
  missions.set(m.id, m);
  const grant = { provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 1, max_runtime_ms: 10000 };
  function authorize(extra = {}, owner = 'operator') {
    const input = { request_id: randomUUID(), channel: 'control_center', confirmed: true, contract: c,
      subscription_execution: grant, ...extra };
    const a = b.missionApprovals.issue(input, owner);
    m.envelope.approval_id = a.approval_id;
    return { a, input };
  }
  const install = path.join(root, 'install'); fs.mkdirSync(install);
  for (const f of ['agent', 'node', 'index.js']) fs.writeFileSync(path.join(install, f), 'not executed\n');
  const credential = path.join(root, 'dummy-auth.json'); fs.writeFileSync(credential, '{"synthetic":true}', { mode: 0o600 });
  const io = { spawns: 0, closes: 0, beforeClose: null, hold: false, interval: null, terminationUnverified: false, spawnError: false, stagingRoots: [] };
  // No provider process exists in this transport fixture; dispose only its own
  // captured staging roots, including synthetic unverified-termination cases.
  t.after(() => { for (const staged of io.stagingRoots) fs.rmSync(staged, { recursive: true, force: true }); });
  const childProcess = {
    spawnSync: () => ({ status: 0, stdout: '2026.09.28-64d2043\n' }),
    spawn(_command, _argv, options) {
      io.spawns++;
      io.stagingRoots.push(path.dirname(options.cwd));
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 991122;
      child.kill = () => {};
      queueMicrotask(() => {
        if (io.spawnError) { child.emit('error', Error('Synthetic spawn outcome')); return; }
        child.emit('spawn');
        if (io.hold) return;
        fs.writeFileSync(path.join(options.cwd, 'first.txt'), 'one\n');
        fs.writeFileSync(path.join(options.cwd, 'second.txt'), 'two\n');
        io.beforeClose?.();
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: JSON.stringify({ status: 'completed', summary: 'Synthetic transport result', changed_files: ['first.txt', 'second.txt'] }) }) + '\n'));
        child.emit('close', 0, null);
      });
      io.child = child;
      return child;
    },
  };
  const fsProbe = { ...fs, statSync(p, ...args) { return p === '/usr/bin/sandbox-exec' ? { isFile: () => true } : fs.statSync(p, ...args); } };
  const proc = Object.create(process);
  Object.defineProperty(proc, 'platform', { value: 'darwin' });
  Object.defineProperty(proc, 'kill', { value(_pid, signal) {
    if (io.terminationUnverified && signal === 0) return true;
    throw Object.assign(Error('Synthetic process already terminated'), { code: 'ESRCH' });
  } });
  const { CursorWorker } = loadSource('cursor-worker.js', { ...shared, 'node:fs': fsProbe, 'node:child_process': childProcess,
    './agent-adapter': { AgentAdapterError: class extends Error { constructor(code, message) { super(message); this.code = code; } } },
    './memory-content-erasure': { assertContext() {} }, './personal-memory': { containsSecret: () => false },
    './sandbox-policy': { makeProfile: () => '(deny network*)' }, './live-observatory': { record() {} },
    './bounded-worker': { async proxy() { return { port: 41000, stats: () => ({ synthetic: true }), async close() { io.closes++; } }; } },
  }, { process: proc, setInterval: fn => { io.interval = fn; return { unref() {} }; }, clearInterval() {} });
  const worker = new CursorWorker(b, { executable: path.join(install, 'agent') });
  worker.credentialSource = () => ({ kind: 'file_store', available: true, path: credential });
  worker.qualification = () => ({ runtime_version: '2026.09.28-64d2043', execution_qualified: true });
  const args = { task, repo: workspace, prompt: 'Set the two declared files to the exact requested content.', context: { id: task.contextPackId }, requestId: randomUUID() };
  return { b, db, store, events, MissionApprovals, m, c, task, worker, io, args, grant, authorize,
    advance: ms => { now += ms; }, now: () => now };
}

test('production readiness stays UNKNOWN_SUBSCRIPTION; a real scoped grant admits two files', async t => {
  const f = fixture(t); f.authorize();
  assert.equal(f.worker.options.fixtureExecutable, undefined);
  assert.equal((await f.worker.readiness()).spend, 'UNKNOWN_SUBSCRIPTION');
  const result = await f.worker.dispatch(f.args);
  assert.equal(f.io.spawns, 1);
  assert.deepEqual(Array.from(result.changes, x => [x.path, x.content]), [['first.txt', 'one\n'], ['second.txt', 'two\n']]);
  assert.equal(result.provenance.spend, 'UNKNOWN_SUBSCRIPTION');
  assert.equal(f.worker.active.size, 0);
  assert.equal(f.io.closes, 1);
  assert.equal(f.db.prepare('SELECT state FROM cp_subscription_invocations').get().state, 'settled');
  assert.equal(fs.readFileSync(path.join(f.args.repo, 'first.txt'), 'utf8'), 'pending\n', 'host application stays separate');
});

test('missing grant blocks a healthy production worker before provider I/O', async t => {
  const f = fixture(t); f.authorize({ subscription_execution: undefined });
  await assert.rejects(f.worker.dispatch(f.args), /BLOCKED_SPEND_AUTHORIZATION/);
  assert.equal(f.io.spawns, 0); assert.equal(f.worker.active.size, 0);
});

test('a forged readiness string or serializable ticket cannot authorize execute()', async t => {
  const f = fixture(t); f.authorize();
  f.worker.readiness = async () => ({ ready: true, spend: 'authorized_subscription' });
  for (const admission of [null, {}, { authorized: true, approval_id: f.m.envelope.approval_id }]) {
    await assert.rejects(f.worker.execute({ workspace: f.args.repo, files: ['first.txt'], writable: ['first.txt'], objective: 'one', admission }), /BLOCKED_SPEND_AUTHORIZATION/);
  }
  assert.equal(f.io.spawns, 0);
});

test('only explicitly confirmed authenticated owner can issue subscription grant', t => {
  const f = fixture(t);
  assert.throws(() => f.authorize({}, 'mcp:' + randomUUID()), /Authenticated local operator/);
  assert.throws(() => f.authorize({ confirmed: false }), /Explicit owner approval/);
  assert.throws(() => f.authorize({ channel: 'fixture' }), /subscription_explicit/);
  assert.throws(() => f.authorize({ subscription_execution: { ...f.grant, acknowledge_unknown_cost: false } }), /subscription_explicit/);
});

test('grant accepts finite run/time bounds, rejects fabricated money caps and provider changes', t => {
  const f = fixture(t);
  for (const max_invocations of [0, -1, 3, Infinity, 1.5]) assert.throws(() => f.authorize({ subscription_execution: { ...f.grant, max_invocations } }), /subscription_invocation_bound/);
  for (const max_runtime_ms of [0, 999, 600001, Infinity]) assert.throws(() => f.authorize({ subscription_execution: { ...f.grant, max_runtime_ms } }), /subscription_runtime_bound/);
  assert.throws(() => f.authorize({ subscription_execution: { ...f.grant, max_cost_usd: 0 } }), /Unexpected input/);
  assert.throws(() => f.authorize({ subscription_execution: { ...f.grant, provider: 'other' } }), /subscription_explicit/);
});

test('same issue request cannot increase, remove, or retrospectively add a spending grant', t => {
  const f = fixture(t); const { a, input } = f.authorize();
  assert.equal(f.b.missionApprovals.issue(input).approval_id, a.approval_id);
  assert.throws(() => f.b.missionApprovals.issue({ ...input, subscription_execution: { ...f.grant, max_invocations: 2 } }), /approval_replay_denied/);
  assert.throws(() => f.b.missionApprovals.issue({ ...input, subscription_execution: undefined }), /approval_replay_denied/);
  const plain = f.authorize({ subscription_execution: undefined });
  assert.throws(() => f.b.missionApprovals.issue({ ...plain.input, subscription_execution: f.grant }), /approval_replay_denied/);
});

test('expiry and revocation block new dispatch, without refunding consumed invocations', async t => {
  const f = fixture(t); f.authorize(); f.advance(600001);
  await assert.rejects(f.worker.dispatch(f.args), /expired/); assert.equal(f.io.spawns, 0);
  const g = fixture(t); const { a } = g.authorize();
  g.b.missionApprovals.revoke(a.approval_id, { request_id: randomUUID(), confirmed: true, reason: 'test revocation' });
  await assert.rejects(g.worker.dispatch(g.args), /revoked/); assert.equal(g.io.spawns, 0);
});

test('wrong scope, workspace, or different contract cannot borrow an approval', async t => {
  const f = fixture(t); f.authorize();
  f.c.permissions.allowed_write_paths = ['other.txt']; seal(f.c);
  await assert.rejects(f.worker.dispatch(f.args), /scope_mismatch/);
  assert.equal(f.io.spawns, 0);
});

test('used request cannot replay and exhausted allowance cannot launch another request', async t => {
  const f = fixture(t); f.authorize(); await f.worker.dispatch(f.args);
  await assert.rejects(f.worker.dispatch(f.args), /replay_denied/);
  await assert.rejects(f.worker.dispatch({ ...f.args, requestId: randomUUID() }), /exhausted/);
  assert.equal(f.io.spawns, 1);
});

test('reserved invocation survives host restart and stays consumed when outcome is unknown', t => {
  const f = fixture(t); f.authorize();
  f.b.missionApprovals.reserveSubscription(f.m.id, f.args.requestId, 10000);
  f.b.missionApprovals = new f.MissionApprovals(f.b);
  assert.throws(() => f.b.missionApprovals.reserveSubscription(f.m.id, f.args.requestId, 10000), /replay_denied/);
  assert.throws(() => f.b.missionApprovals.reserveSubscription(f.m.id, randomUUID(), 10000), /exhausted/);
});

test('contract and approval lifetime shorten the execution deadline', t => {
  const f = fixture(t); f.authorize();
  f.c.identity.created_at = f.now() - 177000;
  const r = f.b.missionApprovals.reserveSubscription(f.m.id, randomUUID(), 10000);
  assert.equal(r.deadline_at - f.now(), 3000);
  f.advance(3000); assert.throws(() => f.b.missionApprovals.assertSubscription(r), /expired/);
});

test('revocation before publication rejects the result despite successful worker output', async t => {
  const f = fixture(t); const { a } = f.authorize();
  f.io.beforeClose = () => f.b.missionApprovals.revoke(a.approval_id, { request_id: randomUUID(), confirmed: true, reason: 'revoked during run' });
  await assert.rejects(f.worker.dispatch(f.args), /revoked/);
  assert.equal(f.worker.active.size, 0);
  assert.equal(f.db.prepare('SELECT outcome FROM cp_subscription_invocations').get().outcome, 'failed');
});

test('revocation monitor aborts an active run and cleanup still completes', async t => {
  const f = fixture(t); const { a } = f.authorize(); f.io.hold = true;
  const pending = f.worker.dispatch(f.args);
  const rejected = assert.rejects(pending, /cancelled|revoked/);
  for (let i = 0; i < 20 && !f.io.child; i++) await new Promise(r => setImmediate(r));
  assert.equal(f.io.spawns, 1);
  f.b.missionApprovals.revoke(a.approval_id, { request_id: randomUUID(), confirmed: true, reason: 'stop active run' });
  f.io.interval();
  assert.equal(f.worker.active.get(f.task.id).signal.aborted, true);
  f.io.child.emit('close', null, 'SIGKILL'); await rejected;
  assert.equal(f.worker.active.size, 0);
  assert.equal(f.db.prepare('SELECT outcome FROM cp_subscription_invocations').get().outcome, 'cancelled');
});


test('an explicit monetary ceiling cannot be replaced with unknown-cost acknowledgement', async t => {
  const f = fixture(t); f.c.budget.max_actual_spend_usd = 0; seal(f.c);
  assert.throws(() => f.authorize(), /monetary_cap_unenforceable/);
  const g = fixture(t); g.authorize(); g.m.envelope.maxCostUsdBoundary = 0;
  await assert.rejects(g.worker.dispatch(g.args), /monetary_cap_unenforceable/);
  assert.equal(g.io.spawns, 0);
});

test('unverified process termination is recorded as unknown subscription consumption', async t => {
  const f = fixture(t); f.authorize(); f.io.terminationUnverified = true;
  await assert.rejects(f.worker.dispatch(f.args), error => error.code === 'cursor_termination_unverified');
  assert.equal(f.db.prepare('SELECT outcome FROM cp_subscription_invocations').get().outcome, 'unknown');
  assert.equal(f.worker.active.size, 0);
});

for (const code of ['cursor_termination_unverified', 'cursor_spawn_failed']) {
  test('accounting failure cannot mask ' + code + ' and release uncertain ownership', async t => {
    const f = fixture(t); f.authorize();
    f.io.terminationUnverified = code === 'cursor_termination_unverified';
    f.io.spawnError = code === 'cursor_spawn_failed';
    f.db.exec("CREATE TRIGGER injected_settlement_failure BEFORE UPDATE ON cp_subscription_invocations BEGIN SELECT RAISE(ABORT,'Synthetic settlement failure'); END");
    await assert.rejects(f.worker.dispatch(f.args), error => error.code === code);
    assert.equal(f.db.prepare('SELECT state FROM cp_subscription_invocations').get().state, 'reserved');
    await assert.rejects(f.worker.dispatch({ ...f.args, requestId: randomUUID() }), /exhausted/);
    assert.equal(f.io.spawns, 1, 'an accounting failure never refunds the consumed invocation');
    assert.equal(f.worker.active.size, 0);
  });
}

test('successful worker output is not published when subscription settlement fails', async t => {
  const f = fixture(t); f.authorize();
  f.db.exec("CREATE TRIGGER injected_settlement_failure BEFORE UPDATE ON cp_subscription_invocations BEGIN SELECT RAISE(ABORT,'Synthetic settlement failure'); END");
  await assert.rejects(f.worker.dispatch(f.args), error => error.code === 'cursor_subscription_settlement_failed');
  assert.equal(f.db.prepare('SELECT state FROM cp_subscription_invocations').get().state, 'reserved');
  assert.equal(fs.readFileSync(path.join(f.args.repo, 'first.txt'), 'utf8'), 'pending\n');
  assert.equal(f.worker.active.size, 0);
});
