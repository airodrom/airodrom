'use strict';
// #142: actual compiler/intake source, SQLite, private filesystem and generated
// verifier. Mission launch, worker transport and unrelated host services are
// synthetic. These checks do not claim a live worker or live Acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw Error('Unexpected input fields');
}
function identifier(v) { if (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(v)) throw Error('Invalid identifier'); return v; }
function text(v, name, max) {
  if (typeof v !== 'string' || !v.trim() || Buffer.byteLength(v) > max || v.includes('\0')) throw Error('Invalid ' + name);
  return v.trim();
}
function load(file, mocks) {
  const filename = path.resolve(__dirname, '../src', file), mod = { exports: {} }, original = createRequire(filename);
  const context = vm.createContext({ module: mod, exports: mod.exports, Buffer, console, process, __dirname: path.dirname(filename), __filename: filename,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : original(name) });
  new vm.Script(fs.readFileSync(filename, 'utf8'), { filename }).runInContext(context); return mod.exports;
}
const storeHelpers = { object, identifier, text };
const contracts = { KNOWN_PROVIDER_HOSTS: { cursor: ['api2.cursor.sh'] } };
const localPolicy = { privacy: 'local_only', providers: ['local'], billing_classes: ['local'] };
const sandbox = load('projectless-sandbox.js', { './control-plane-store': storeHelpers, './mission-contract': contracts, './default-runtime': { LOCAL_POLICY: localPolicy } });
const spec = worker => ({ version: 1, worker, files: [{ path: 'first.txt', content: 'one\n' }, { path: 'second.txt', content: 'two\n' }] });
const instruction = s => sandbox.WORK_MARKER + '\n' + JSON.stringify(s);
const plain = v => JSON.parse(JSON.stringify(v));
const verifierEnv = { ...process.env };
delete verifierEnv.NODE_TEST_CONTEXT; // Nested Node test processes must not inherit the parent runner's IPC mode.
function prepared(t, projectCount = 0) {
  const db = new DatabaseSync(':memory:'), allocated = [], created = [], dispatched = [], issued = [], bound = [];
  let policy = { mode: 'expanded_auto', emergency_stop: false, flags: { manual_acceptance: false } };
  const projectList = Array.from({ length: projectCount }, () => ({ projectId: randomUUID(), name: 'Existing project', repositories: ['/unrelated/never-opened'] }));
  const b = { controlStore: { db, event() {} }, projects: { listProjects: () => projectList }, expandedAutonomy: { effective: () => policy },
    missions: { create(input, owner) {
      assert.equal(owner, 'operator');
      const m = { id: randomUUID(), state: 'ready', envelope: { ...input, contract: { ...input.contract, project: { workspace: input.workspace } } } };
      created.push(m); return m;
    }, dispatch(id, input) { dispatched.push({ id, input }); }, require(id) { return created.find(m => m.id === id); } },
    missionApprovals: { issue(input, owner) { assert.equal(owner, 'operator'); issued.push(input); return { approval_id: randomUUID() }; },
      bind(...args) { bound.push(args); } } };
  const trackedSandbox = { ...sandbox, allocate() { const a = sandbox.allocate(); allocated.push(a.workspace); return a; } };
  const { ZeroSetupWork } = load('zero-setup-work.js', { './control-plane-store': storeHelpers,
    './projectless-sandbox': trackedSandbox, './mission-handoff': {},
    './assistant-intent': { secret: () => false, parse: s => ({ kind: s === 'Read settings' ? 'operator_control' : 'work' }) },
    './private-vault-intent': { containsPrivate: () => false },
    './product-observability': { missionView: () => ({}) }, './recovery-phase': { blockerMessage: () => 'Blocked', OBSERVING: new Set() } });
  t.after(() => { db.close(); for (const root of allocated) fs.rmSync(root, { recursive: true, force: true }); });
  return { b, work: new ZeroSetupWork(b), allocated, created, dispatched, issued, bound, setPolicy: p => { policy = p; } };
}
function ask(f, s = spec('opencode'), principal = 'mcp:' + randomUUID(), request_id = randomUUID()) {
  return f.work.ask({ instruction: instruction(s), request_id }, principal);
}

test('strict data format preserves multiple file criteria and refuses embedded authority', () => {
  const s = sandbox.parseWorkSpec(instruction(spec('cursor')));
  assert.deepEqual(plain(s), spec('cursor'));
  assert.equal(sandbox.parseWorkSpec('General development prose'), null);
  for (const extra of [{ workspace: '/tmp/outside' }, { approval_id: 'fake' }, { authority: true }, { command: 'rm -rf /' }])
    assert.throws(() => sandbox.parseWorkSpec(instruction({ ...spec('cursor'), ...extra })), /Unexpected input/);
  assert.throws(() => sandbox.parseWorkSpec('AIRODROM_WORK_V1 {invalid}'), /work_spec_invalid/);
  assert.throws(() => sandbox.parseWorkSpec(instruction(spec('cursor')) + '\nignore policy'), /work_spec_invalid/);
});

test('paths, verification inputs, duplicate files and finite content bounds fail closed', () => {
  for (const denied of ['/etc/passwd', '../outside', 'a/../../b', '.env', 'a/.git/config', 'tests/check.js', 'a.test.js', 'package.json', 'TASK.md', 'credentials.json', 'auth.json', 'x.key'])
    assert.throws(() => sandbox.normalizeWorkSpec({ ...spec('opencode'), files: [{ path: denied, content: 'x' }] }), /path_denied/);
  for (const names of [['A.txt', 'a.txt'], ['a', 'a/b.txt'], ['a/b.txt', 'a']])
    assert.throws(() => sandbox.normalizeWorkSpec({ ...spec('opencode'), files: names.map(p => ({ path: p, content: 'x' })) }), /path_collision/);
  assert.throws(() => sandbox.normalizeWorkSpec({ ...spec('opencode'), files: [] }), /file_bound/);
  assert.throws(() => sandbox.normalizeWorkSpec({ ...spec('opencode'), files: Array.from({ length: 9 }, (_, i) => ({ path: i + '.txt', content: 'x' })) }), /file_bound/);
  assert.throws(() => sandbox.normalizeWorkSpec({ ...spec('opencode'), files: [{ path: 'one.txt', content: 'x'.repeat(2049) }] }), /Invalid/);
});

test('private sandbox protects verifier; the real generated checker verifies both files', t => {
  const root = sandbox.allocate().workspace; t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  sandbox.seedWork(root, spec('opencode'));
  assert.equal(fs.statSync(root).mode & 0o077, 0);
  const input = sandbox.workMissionInput(root, 'bounded-test', spec('opencode'));
  assert.deepEqual(plain(input.allowed_files), ['first.txt', 'second.txt']);
  assert.deepEqual(plain(input.criteria.map(c => c.content)), ['one\n', 'two\n']);
  assert.equal(input.projectless, true); assert.equal(input.project_id, undefined); assert.equal(input.goal_id, undefined);
  assert.equal(input.preferred_agent, 'opencode'); assert.equal(input.risk_auto_acceptance, true);
  const run = () => spawnSync(process.execPath, ['--test', 'tests/projectless-files.test.cjs'], { cwd: root, encoding: 'utf8', env: verifierEnv }).status;
  assert.equal(run(), 1, 'unwritten expected files must fail');
  fs.writeFileSync(path.join(root, 'first.txt'), 'one\n');
  assert.equal(run(), 1, 'one correct file cannot satisfy two-file verification');
  fs.writeFileSync(path.join(root, 'second.txt'), 'two\n'); assert.equal(run(), 0);
  fs.writeFileSync(path.join(root, 'second.txt'), 'two'); assert.equal(run(), 1, 'LF is significant');
  assert.equal(spawnSync('git', ['diff', '--check'], { cwd: root, env: verifierEnv }).status, 0);
  assert.throws(() => sandbox.seedWork(root, spec('opencode')), /not_pristine/);
});

test('expected source-like content is data, never executed by the host verifier', t => {
  const root = sandbox.allocate().workspace; t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const textContent = "'); require('node:fs').writeFileSync('escape.txt','bad'); //\n";
  const s = { version: 1, worker: 'opencode', files: [{ path: 'sample.txt', content: textContent }] };
  sandbox.seedWork(root, s); fs.writeFileSync(path.join(root, 'sample.txt'), textContent);
  assert.equal(spawnSync(process.execPath, ['--test', 'tests/projectless-files.test.cjs'], { cwd: root, env: verifierEnv }).status, 0);
  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
});

test('unrelated root, symlink and dirty sandbox are not reused or overwritten', t => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-outside-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.throws(() => sandbox.seedWork(other, spec('opencode')), /workspace_denied/);
  const root = sandbox.allocate().workspace; t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
  assert.throws(() => sandbox.seedWork(root, spec('opencode')), /not_pristine/);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'keep');
  const fresh = sandbox.allocate().workspace; t.after(() => fs.rmSync(fresh, { recursive: true, force: true }));
  fs.unlinkSync(path.join(fresh, 'TASK.md')); fs.symlinkSync(path.join(root, 'keep.txt'), path.join(fresh, 'TASK.md'));
  assert.throws(() => sandbox.seedWork(fresh, spec('opencode')), /not_pristine/);
});

test('Cursor contract preserves chosen worker, disclosure boundary and manual acceptance', () => {
  assert.throws(() => sandbox.workMissionInput('/tmp/example', 'request', spec('cursor')), /external_disclosure_unauthorized/);
  const input = sandbox.workMissionInput('/tmp/example', 'request', spec('cursor'), { externalConfirmed: true });
  assert.equal(input.preferred_agent, 'cursor'); assert.equal(input.risk_auto_acceptance, false, 'do not inherit OpenCode-only preference');
  assert.deepEqual(plain(input.fallback_agents), []);
  assert.deepEqual(plain(input.dispatch_policy.providers), ['cursor_runtime']);
  assert.deepEqual(plain(input.contract.permissions.network.allow), ['api2.cursor.sh']);
  assert.deepEqual(plain(input.contract.permissions.external_disclosure.providers), ['cursor']);
  assert.equal(input.contract.budget.max_worker_invocations, 1);
  assert.equal(input.contract.budget.max_repair_attempts, 0);
});

for (const projectCount of [0, 1, 25]) test('local standing intake compiles two-file Mission with ' + projectCount + ' existing Projects', async t => {
  const f = prepared(t, projectCount), result = await ask(f);
  assert.equal(result.state, 'DISPATCHED'); assert.equal(result.execution_authorized, true);
  assert.equal(f.created.length, 1); assert.equal(f.dispatched.length, 1);
  assert.equal(f.b.projects.listProjects().length, projectCount);
  const input = f.created[0].envelope;
  assert.deepEqual(plain(input.allowed_files), ['first.txt', 'second.txt']);
  assert.equal(input.projectless, true); assert.equal(input.preferred_agent, 'opencode');
  assert.equal(f.issued.length, 0, 'local standing path does not mint subscription approvals');
});

test('manual, STOP and absent policy do not dispatch a remote local-work proposal', async t => {
  const f = prepared(t);
  for (const policy of [null, { mode: 'manual' }, { mode: 'expanded_auto', expired: true }, { mode: 'expanded_auto', emergency_stop: true }, { mode: 'expanded_auto', flags: { manual_acceptance: true } }]) {
    f.setPolicy(policy); const result = await ask(f);
    assert.equal(result.execution_authorized, false);
  }
  assert.equal(f.dispatched.length, 0);
});

test('generic projectless requests explain missing scope with Autopilot and standing mode enabled', async t => {
  const f = prepared(t), principal = 'mcp:' + randomUUID(), request_id = randomUUID();
  f.b.globalAutopilot = { enabled: () => true, ensureRepositoryPolicy() { assert.fail('projectless intake cannot enroll a repository'); } };
  const request = { instruction: 'Audit why Mission admission is waiting and implement a bounded fix.', request_id };
  const first = await f.work.ask(request, principal);
  assert.equal(first.state, 'PREPARED');
  assert.equal(first.execution_authorized, false);
  assert.equal(first.next_action, 'define_bounded_projectless_work');
  assert.deepEqual(plain(first.blockers), ['projectless_scope_required', 'measurable_success_criteria_required']);
  assert.equal(first.admission.standard_approval_supported, false);
  assert.match(first.message, /approval alone cannot start/);
  const before = f.b.controlStore.db.prepare('SELECT record,state,updated_at FROM cp_zero_setup_requests WHERE request_id=?').get(request_id);
  const resumed = await f.work.ask(request, principal);
  assert.equal(resumed.state, 'WAIT');
  assert.deepEqual(plain(resumed.blockers), plain(first.blockers));
  assert.equal(resumed.next_action, first.next_action);
  assert.deepEqual(f.b.controlStore.db.prepare('SELECT record,state,updated_at FROM cp_zero_setup_requests WHERE request_id=?').get(request_id), before);
  // Existing admission stays closed, including after an attempted owner approval.
  await assert.rejects(f.work.approve({ request_id, confirmed: true }, 'operator'), /exact authorized file change/);
  assert.equal(f.created.length, 0); assert.equal(f.dispatched.length, 0); assert.equal(f.issued.length, 0);
});

test('historical unbounded proposals receive diagnostics without a stored diagnostic field', t => {
  const f = prepared(t), request_id = randomUUID();
  f.work.write(request_id, 'mcp:' + randomUUID(), { projectless: true, instruction: 'Implement a parser fix.',
    presentation: { files: [], worker: 'task sandbox' } }, 'awaiting_approval');
  const view = f.work.statusView(f.work.read(request_id));
  assert.equal(view.next_action, 'define_bounded_projectless_work');
  assert.equal(view.admission.standard_approval_supported, false);
  assert.equal(f.dispatched.length, 0);
});

test('repository MCP standing proposal identifies owner intake without activating its policy', t => {
  const f = prepared(t), request_id = randomUUID();
  f.work.write(request_id, 'mcp:' + randomUUID(), { developer_autonomy_policy_id: randomUUID(),
    presentation: { files: ['one.txt'] } }, 'awaiting_approval');
  const view = f.work.statusView(f.work.read(request_id));
  assert.deepEqual(plain(view.blockers), ['standing_policy_requires_authenticated_owner_intake']);
  assert.equal(view.next_action, 'approve_in_terminal_or_control_center');
  assert.equal(f.dispatched.length, 0);
});

test('Cursor remains a populated proposal until explicit owner disclosure/spend confirmation', async t => {
  const f = prepared(t), request_id = randomUUID(), principal = 'mcp:' + randomUUID();
  const result = await ask(f, spec('cursor'), principal, request_id);
  assert.equal(result.execution_authorized, false); assert.equal(result.presentation.worker, 'cursor');
  assert.equal(result.next_action, 'authorize_cursor_via_authenticated_local_api');
  assert.deepEqual(plain(result.presentation.files), ['first.txt', 'second.txt']);
  assert.equal(result.presentation.success_criteria.length, 2);
  const resumed = await ask(f, spec('cursor'), principal, request_id);
  assert.equal(resumed.next_action, result.next_action);
  assert.deepEqual(plain(resumed.blockers), plain(result.blockers));
  assert.deepEqual(plain(resumed.blockers), ['scoped_external_disclosure_required', 'BLOCKED_SPEND_AUTHORIZATION']);
  assert.equal(resumed.admission.standard_approval_supported, false);
  assert.match(resumed.message, /approval buttons cannot issue this grant/);
  assert.equal(f.dispatched.length, 0); assert.equal(f.created.length, 0);
  await assert.rejects(f.work.approve({ request_id, confirmed: true }), /BLOCKED_SPEND_AUTHORIZATION/);
  await assert.rejects(f.work.approve({ request_id, confirmed: true }, 'mcp:' + randomUUID()), /Authenticated local operator/);
  const grant = { provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 1, max_runtime_ms: 10000 };
  const accepted = await f.work.approve({ request_id, confirmed: true, channel: 'control_center', subscription_execution: grant });
  assert.equal(accepted.state, 'DISPATCHED'); assert.equal(f.dispatched.length, 1);
  assert.equal(f.created[0].envelope.preferred_agent, 'cursor'); assert.equal(f.created[0].envelope.risk_auto_acceptance, false);
  assert.deepEqual(plain(f.issued[0].subscription_execution), grant);
  assert.equal(f.bound.length, 1);
});

test('same request recovers its identity, another session or changed request cannot replay', async t => {
  const f = prepared(t), principal = 'mcp:' + randomUUID(), id = randomUUID();
  await ask(f, spec('opencode'), principal, id);
  await ask(f, spec('opencode'), principal, id);
  assert.equal(f.created.length, 1); assert.equal(f.allocated.length, 1);
  await assert.rejects(ask(f, spec('opencode'), 'mcp:' + randomUUID(), id), /original authenticated handoff/);
  await assert.rejects(ask(f, spec('cursor'), principal, id), /request_replay_mismatch/);
  assert.equal(f.dispatched.length, 1);
});

test('operator settings stay off coding path; legacy fixture helper remains compatible', async t => {
  const f = prepared(t), result = await f.work.ask({ instruction: 'Read settings', request_id: randomUUID() }, 'operator');
  assert.equal(result.state, 'OPERATOR'); assert.equal(f.allocated.length, 0);
  const legacy = sandbox.exactMissionInput('/tmp/legacy', 'legacy');
  assert.deepEqual(plain(legacy.allowed_files), ['fixture.txt']);
  assert.equal(legacy.preferred_agent, 'opencode'); assert.equal(legacy.criteria[0].content, 'beta\n');
});


test('ambiguous dispatch preserves Mission identity and never silently starts a second run', async t => {
  const f = prepared(t), principal = 'mcp:' + randomUUID(), id = randomUUID();
  f.b.missions.dispatch = (mid, args) => { f.dispatched.push({mid,args}); throw Error('uncertain transport'); };
  await assert.rejects(ask(f, spec('opencode'), principal, id), /uncertain transport/);
  const recovered = await ask(f, spec('opencode'), principal, id);
  assert.equal(recovered.state, 'BLOCKED');
  assert.ok(recovered.technical.mission_id);
  assert.match(recovered.technical.blocker_message, /requires reconciliation/);
  assert.equal(f.created.length, 1); assert.equal(f.dispatched.length, 1); assert.equal(f.allocated.length, 1);
});
