'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const C = require('../src/cognitive-contracts');
const R = require('../src/cognitive-router');
const I = require('../src/cognitive-integrity');
const { canonicalHash } = require('../src/authority-hash');

const caller = 'mcp:380c1915-b24c-40c5-9f7a-8e87c2da61f0';
async function setup(t, { delegated = true, live = false, cursor = false } = {}) {
  const opencode = live ? { enabled: true, executable: '/opt/homebrew/bin/opencode', model: 'ollama/qwen3-coder:30b', timeoutMs: 120000 } : runtime(t).options;
  const f = await fixture(t, { opencode, settleTimeoutMs: live ? 150000 : 15000 });
  if (cursor) f.bridge.cursorWorker = new (require('../src/cursor-worker').CursorWorker)(f.bridge, { fixtureExecutable: path.join(__dirname, 'fixtures/cursor-agent-fixture.cjs') });
  f.bridge.missionAuthority.initializeOperatorKey(); qualifyCanonical(f.bridge);
  const project = f.bridge.projects.listProjects({ status: 'active' })[0];
  const goal = f.bridge.projects.summary(project.projectId).goals[0];
  f.policy = f.bridge.developerAutonomy.enroll({ alias: 'cognitive-fixture', repository: f.repo,
    project_id: project.projectId, goal_id: goal.goalId, workflows: ['routine_edit', 'test'],
    workers: cursor ? ['opencode', 'cursor'] : ['opencode'], duration_days: 1, confirmed: true, diff_check: 'diff-check', default_tests: ['fixture-test'],
    budgets: { max_repairs: 0 }, cognitive: { version: 1, files: ['fixture.txt'], delegated_callers: delegated ? [caller] : [], planning_attempts: 2, planning_ms: 120000, execution_ms: 120000 } }, 'operator');
  const execute = f.bridge.opencodeAdapter.execute.bind(f.bridge.opencodeAdapter);
  f.plannerCalls = 0;
  f.proposal = e => ({ version: 1, request_id: e.request_id, envelope_hash: e.hash, files: ['fixture.txt'], tasks: [{ id: 'edit', operation: 'edit', paths: ['fixture.txt'], description: 'Replace alpha with beta and preserve LF', depends_on: [] }], verification: ['fixture-test'], complexity: 'bounded' });
  if (!live) f.bridge.opencodeAdapter.execute = async options => {
    if (options.writable.length) return execute(options);
    f.plannerCalls++; assert.deepEqual(options.writable, []); assert.deepEqual(options.files, ['fixture.txt']);
    const row = f.bridge.controlStore.db.prepare("SELECT record FROM cp_zero_setup_requests WHERE state='planning'").get();
    const e = JSON.parse(row.record).cognitive.envelope;
    const proposal = await f.proposal(e, options);
    return { result: { summary: typeof proposal === 'string' ? proposal : JSON.stringify(proposal) }, changes: [], provenance: { termination_verified: true } };
  };
  f.ask = async (id = randomUUID(), principal = caller, instruction = 'In Fixture project change fixture.txt from alpha to beta, preserving one final newline.') => {
    let view = await f.bridge.zeroSetupWork.ask({ request_id: id, instruction }, principal);
    for (let i = 0; i < 200 && view.state === 'PLANNING'; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      view = await f.bridge.zeroSetupWork.ask({ request_id: id, instruction }, principal);
    }
    return view;
  };
  return f;
}

test('delegated ordinary text plans read-only, seals, verifies independently, and survives reconnect', async t => {
  const f = await setup(t), id = randomUUID();
  const result = await f.ask(id);
  assert.ok(result.mission_id && ['DISPATCHED', 'RUNNING'].includes(result.state), JSON.stringify(result));
  const m = await f.settle(result.mission_id);
  assert.equal(m.envelope.cognitive.sealed.worker, 'opencode');
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
  assert.equal(fs.readFileSync(path.join(m.envelope.workspace, 'fixture.txt'), 'utf8'), 'beta\n');
  const evidence = require('../src/mission-evidence').evidencePackage(f.bridge, m.id).cognitive;
  assert.equal(evidence.verification.result, 'operator_review'); assert.equal(evidence.termination, 'verified');
  assert.equal(evidence.acceptance, 'pending'); assert.equal(evidence.state, 'AWAITING_ACCEPTANCE');
  assert.equal(evidence.counts.planning, 1); assert.equal(evidence.counts.execution, 1);
  assert.equal((await f.ask(id)).mission_id, m.id); assert.equal(f.plannerCalls, 1);
  await assert.rejects(f.ask(id, caller, 'In Fixture project another change'), /replay/);
  await assert.rejects(f.ask(id, 'mcp:' + randomUUID()), /replay/);
  await f.reopen();
  assert.equal(require('../src/mission-evidence').evidencePackage(f.bridge, m.id).cognitive.contract_hash, evidence.contract_hash);
  assert.throws(() => f.bridge.missions.queue(m.id), /execution_attempts|current state/);
});

test('a slow planner acknowledges PLANNING before OpenCode returns and the same request does not plan twice', async t => {
  const f = await setup(t);
  const planner = f.bridge.opencodeAdapter.execute;
  f.bridge.opencodeAdapter.execute = async options => {
    await new Promise(resolve => setTimeout(resolve, 300));
    return planner(options);
  };
  const id = randomUUID();
  const instruction = 'In Fixture project change fixture.txt from alpha to beta, preserving one final newline.';
  const started = Date.now();
  const ack = await f.bridge.zeroSetupWork.ask({ request_id: id, instruction }, caller);
  assert.ok(Date.now() - started < 150, String(Date.now() - started));
  assert.equal(ack.state, 'PLANNING');
  assert.equal(ack.request_id, id);
  const replay = await f.bridge.zeroSetupWork.ask({ request_id: id, instruction }, caller);
  assert.equal(replay.state, 'PLANNING');
  await assert.rejects(f.bridge.zeroSetupWork.ask({ request_id: id, instruction: instruction + ' again' }, caller), /replay/);
  const done = await f.ask(id);
  assert.ok(done.mission_id && ['DISPATCHED', 'RUNNING'].includes(done.state), JSON.stringify(done));
  assert.equal(f.plannerCalls, 1);
});

test('missing caller delegation performs no discovery or planning; text never enrolls', async t => {
  const f = await setup(t, { delegated: false });
  const result = await f.ask();
  assert.equal(result.state, 'BLOCKED'); assert.deepEqual(result.blockers, ['cognitive_caller_delegation_required']);
  assert.equal(f.plannerCalls, 0);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_developer_autonomy_workspaces').get().n, 0);
  assert.throws(() => R.enrollment({ version: 1, files: ['../outside'], delegated_callers: [], planning_attempts: 1, planning_ms: 1000, execution_ms: 1000 }, f.repo));
});

test('planner cannot supply authority, commands, or out-of-scope paths; retries are finite', async t => {
  const f = await setup(t), normal = f.proposal;
  f.proposal = e => ({ ...normal(e), authorization: 'approved' });
  const result = await f.ask();
  assert.equal(result.state, 'BLOCKED'); assert.equal(f.plannerCalls, 2);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
  const row = f.bridge.controlStore.db.prepare('SELECT record FROM cp_zero_setup_requests').get();
  const e = JSON.parse(row.record).cognitive.envelope;
  for (const raw of [{ ...normal(e), files: ['../other'] }, { ...normal(e), envelope_hash: 'a'.repeat(64) },
    { ...normal(e), verification: ['sh arbitrary'] }, { ...normal(e), files: ['other.txt'], tasks: [{ ...normal(e).tasks[0], paths: ['other.txt'] }] }]) assert.throws(() => R.validateProposal(raw, e));
});

test('workspace content, mode, new file, and Git drift invalidate the plan', async t => {
  const f = await setup(t), normal = f.proposal;
  f.proposal = (e, options) => { fs.writeFileSync(path.join(options.workspace, 'fixture.txt'), 'drift\n'); return normal(e); };
  const result = await f.ask();
  assert.equal(result.state, 'BLOCKED'); assert.match(result.blockers[0], /drift/); assert.equal(f.plannerCalls, 1);
  const captured = I.capture(f.repo, ['fixture.txt']);
  const envelope = { permitted_paths: ['fixture.txt'], git_anchor: captured.head, integrity: captured.integrity };
  fs.chmodSync(path.join(f.repo, 'fixture.txt'), 0o700);
  assert.throws(() => I.assertCurrent(f.repo, envelope, captured.workspace_identity), /drift/);
});

test('revocation while planning prevents grant issuance and execution', async t => {
  const f = await setup(t), normal = f.proposal;
  f.proposal = e => { f.bridge.developerAutonomy.revoke({ policy_id: f.policy.policy_id, policy_hash: f.policy.policy_hash, confirmed: true }, 'operator'); return normal(e); };
  const result = await f.ask(); assert.equal(result.state, 'BLOCKED'); assert.match(result.blockers[0], /revoked/);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_developer_autonomy_grants').get().n, 0);
});

test('route preserves explicit worker and disregards advisory complexity', () => {
  const e = { requested_worker: 'auto', eligible_workers: ['host', 'opencode', 'cursor'] };
  const p = { files: ['a'], tasks: [{ operation: 'edit' }], complexity: 'complex' };
  assert.equal(R.route(e, p, ['host', 'opencode', 'cursor']), 'opencode');
  assert.equal(R.route({ ...e, requested_worker: 'cursor' }, p, ['cursor']), 'cursor');
  assert.throws(() => R.route({ ...e, requested_worker: 'cursor' }, p, ['opencode']), /unqualified:cursor/);
  assert.equal(R.route(e, { ...p, tasks: [{ operation: 'read' }] }, ['host']), 'host');
  assert.throws(() => R.requestedWorker('Use Cursor only with OpenCode'), /ambiguous/);
});

test('unrecognized explicit worker prose blocks before planning instead of silently using another worker', async t => {
  const f = await setup(t);
  for (const instruction of ['In Fixture project run this in Cursor.', 'In Fixture project OpenCode must execute this.']) {
    const result = await f.ask(randomUUID(), caller, instruction);
    assert.equal(result.state, 'BLOCKED'); assert.deepEqual(result.blockers, ['cognitive_explicit_worker_syntax_required']);
  }
  assert.equal(f.plannerCalls, 0);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches').get().n, 0);
});

test('strict versioned schemas reject dependency cycles, unknown fields and tampered hashes', () => {
  const p = { version: 1, request_id: 'request', envelope_hash: 'a'.repeat(64), files: ['a'], tasks: [{ id: 'a', operation: 'edit', paths: ['a'], description: 'edit', depends_on: ['a'] }], verification: ['test'], complexity: 'bounded' };
  assert.throws(() => C.parse('PlanningProposal', p), /dependency/);
  assert.throws(() => C.parse('PlanningProposal', { ...p, version: 4 }), /version/);
  assert.throws(() => C.parse('PlanningProposal', '```json\n{}\n```'), /json/);
  assert.throws(() => C.parse('PlanningProposal', { ...p, tools: ['shell'] }), /schema/);
  assert.throws(() => C.parse('RequestEnvelope', { hash: canonicalHash({}) }), /schema/);
  assert.throws(() => C.parse('PlanningProposal', '{"version":1,"version":1}'), /json/);
});

test('read-only proposals use existing host capabilities and cannot satisfy an unmet coding criterion', async t => {
  const f = await setup(t), normal = f.proposal;
  f.proposal = e => ({ ...normal(e), tasks: [{ ...normal(e).tasks[0], operation: 'read', description: 'Inspect fixture.txt' }] });
  const result = await f.ask(); assert.ok(result.mission_id && ['DISPATCHED', 'RUNNING'].includes(result.state), JSON.stringify(result));
  const done = await f.settle(result.mission_id, 'needs_rework');
  assert.equal(done.envelope.preferred_agent, 'host');
  assert.deepEqual(done.envelope.contract.permissions.allowed_write_paths, []);
  assert.equal(fs.readFileSync(path.join(done.envelope.workspace, 'fixture.txt'), 'utf8'), 'alpha\n');
  assert.equal(done.runs.filter(r => r.agent_id === 'host' && r.result?.native_execution_evidence).length, 1);
});

test('drift immediately before queue blocks dispatch and remains a durable blocked result', async t => {
  const f = await setup(t), dispatch = f.bridge.missions.dispatch.bind(f.bridge.missions);
  f.bridge.missions.dispatch = (id, input) => {
    const mission = f.bridge.controlStore.getMission(id);
    fs.writeFileSync(path.join(mission.envelope.workspace, 'new.txt'), 'unexpected\n');
    return dispatch(id, input);
  };
  const result = await f.ask(); assert.equal(result.state, 'BLOCKED'); assert.match(result.blockers[0], /drift/);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches').get().n, 0);
});

test('explicit Cursor never launches OpenCode execution without its own qualification and grant', async t => {
  const f = await setup(t);
  const result = await f.ask(randomUUID(), caller, 'Use Cursor only in Fixture project to change fixture.txt from alpha to beta.');
  assert.equal(result.state, 'BLOCKED'); assert.match(result.blockers[0], /cursor|subscription/i);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches').get().n, 0);
});

test('Cursor proposal uses the existing local approval and finite subscription grant without fallback', async t => {
  const f = await setup(t, { cursor: true }), request_id = randomUUID();
  const prepared = await f.ask(request_id, caller, 'Use Cursor only in Fixture project to change fixture.txt from alpha to beta.');
  assert.equal(prepared.state, 'WAIT', JSON.stringify(prepared));
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
  await assert.rejects(f.bridge.zeroSetupWork.approve({ request_id, confirmed: true, channel: 'control_center' }, 'operator'), /SPEND/);
  const approval = { request_id, confirmed: true, channel: 'control_center', subscription_execution: { provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 1, max_runtime_ms: 120000 } };
  await assert.rejects(f.bridge.zeroSetupWork.approve(approval, caller), /operator/);
  const result = await f.bridge.zeroSetupWork.approve(approval, 'operator');
  assert.ok(result.mission_id && ['DISPATCHED', 'RUNNING'].includes(result.state), JSON.stringify(result));
  const done = await f.settle(result.mission_id).catch(error => {
    const route = f.bridge.controlStore.db.prepare('SELECT route FROM cp_dispatches WHERE mission_id=?').get(result.mission_id);
    throw Error(error.message + '\n' + route?.route);
  });
  assert.equal(done.envelope.preferred_agent, 'cursor'); assert.deepEqual(done.envelope.fallback_agents, []);
  const evidence = require('../src/mission-evidence').evidencePackage(f.bridge, done.id).cognitive;
  assert.equal(evidence.accounting.class, 'UNKNOWN_SUBSCRIPTION'); assert.equal(evidence.acceptance, 'pending');
  assert.equal(evidence.termination, 'verified');
});

test('Emergency STOP revokes cognitive standing delegation during planning', async t => {
  const f = await setup(t), normal = f.proposal;
  f.proposal = e => { f.bridge.globalAutopilot.stop({ request_id: randomUUID(), confirmed: true }, 'operator'); return normal(e); };
  const result = await f.ask(); assert.equal(result.state, 'BLOCKED'); assert.match(result.blockers[0], /revoked/);
  assert.equal(f.bridge.developerAutonomy.inspect(f.policy.policy_id).state, 'revoked');
});

test('owner cancellation during planning is durable and launches no Mission', async t => {
  const f = await setup(t), normal = f.proposal, id = randomUUID();
  f.proposal = e => { f.bridge.zeroSetupWork.reject({ request_id: id, confirmed: true }, 'operator'); return normal(e); };
  const result = await f.ask(id); assert.equal(result.state, 'CANCELLED');
  assert.equal((await f.ask(id)).state, 'CANCELLED');
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
});

test('canonical routing still denies Cursor without a Mission-bound approval', async t => {
  const f = await setup(t, { cursor: true });
  const m = f.create({ preferred_agent: 'cursor', fallback_agents: [], dispatch_policy: { privacy: 'cloud_allowed', providers: ['cursor_runtime'], billing_classes: ['subscription'], max_attempts: 1 } });
  const route = await f.bridge.missions.agents.select(m.envelope);
  assert.equal(route.selected, null);
  assert.ok(route.rejected.some(r => r.agent_id === 'cursor' && r.reason === 'cursor_execution_unqualified'));
});

test('a rehashed sealed contract cannot change the bound repository, limits or authorization', async t => {
  const f = await setup(t), dispatch = f.bridge.missions.dispatch.bind(f.bridge.missions);
  let captured;
  f.bridge.missions.dispatch = (id, input) => { captured = f.bridge.controlStore.getMission(id); return dispatch(id, input); };
  await f.ask();
  for (const change of [{ repository_id: 'other' }, { workspace_id: 'other' }, { integrity_hash: 'f'.repeat(64) },
    { limits: { ...captured.envelope.cognitive.sealed.limits, planning_attempts: 1 } },
    { authorization: { ...captured.envelope.cognitive.sealed.authorization, grant_id: randomUUID() } }]) {
    const m = structuredClone(captured);
    m.envelope.cognitive.sealed = C.seal({ ...m.envelope.cognitive.sealed, ...change });
    assert.throws(() => R.assertBound(f.bridge, m), /seal_changed/);
  }
});

test('uncertain planner termination retains a quarantined lease and never retries', async t => {
  const f = await setup(t);
  f.bridge.opencodeAdapter.execute = async options => { options.onStart({ pid: null }); throw Error('opencode_termination_unverified'); };
  const result = await f.ask(); assert.equal(result.state, 'BLOCKED');
  assert.equal(result.cognitive.planning_attempts, 1);
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE state='quarantined'").get().n, 1);
});

test('integrity excludes no tracked files, rejects scoped symlinks and ignored inputs, and is content deterministic', async t => {
  const f = await setup(t), a = I.capture(f.repo, ['fixture.txt']);
  const file = path.join(f.repo, 'fixture.txt'); fs.utimesSync(file, new Date(), new Date());
  assert.equal(I.capture(f.repo, ['fixture.txt']).integrity.hash, a.integrity.hash);
  fs.symlinkSync('fixture.txt', path.join(f.repo, 'link.txt'));
  assert.throws(() => I.capture(f.repo, ['link.txt']), /symlink/);
  fs.writeFileSync(path.join(f.repo, '.gitignore'), 'ignored.txt\n'); fs.writeFileSync(path.join(f.repo, 'ignored.txt'), 'hidden');
  assert.throws(() => I.capture(f.repo, ['ignored.txt']), /excluded/);
});

module.exports = { setup };
