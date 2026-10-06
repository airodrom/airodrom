'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Controller = require('../src/bridge-controller');
const evidence = require('../src/execution-evidence');
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/pc-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const bridge = await new Controller({ dataDir: path.join(root, 'data'), sourceProfile: profile, executable: path.join(__dirname, 'fixtures/fake-pi.cjs'), allowFixtureWorker: true }).initialize();
  t.after(async () => { await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, bridge };
}
for (const [kind, pseudo] of [['inspection', '<function=ls>{"path":"."}</function>'], ['edit', '<function=edit>{"path":"owned.txt","content":"oops"}</function>'], ['test', '<function=bash>touch pseudo-executed</function>']]) {
  test(`${kind} with pseudo tool text and zero native calls never completes or enters successful inbox`, async t => {
    const { root, bridge } = await fixture(t);
    const workspace = path.join(root, 'repo'); fs.mkdirSync(workspace);
    const task = bridge.tasks.get(bridge.createTask(kind, { workspace, requiredExecutionKind: 'native' }).id);
    await bridge.prompt(task.id, `FIXTURE_INERT_OUTPUT:${pseudo}`);
    assert.equal(task.status, 'failed'); assert.equal(task.failureKind, 'native_tool_required');
    assert.equal(task.nativeExecutionEvidence.completed_invocations, 0);
    assert.match(task.lastResult, /<function=/);
    const runs = bridge.controlStore.db.prepare('SELECT id FROM cp_runs WHERE task_id=?').all(task.id);
    assert.equal(bridge.controlStore.run(runs.at(-1).id).state, 'failed');
    assert.equal(bridge.resultInbox.latest({ task: task.id }).result.status, 'failed');
    assert.ok(!fs.existsSync(path.join(workspace, 'pseudo-executed')) && !fs.existsSync(path.join(workspace, 'owned.txt')));
    await bridge.supervisor.tick(); assert.notEqual(task.mission.status, 'completed');
    // Repeated attempts stay terminal without automatic retries or advancement.
    await bridge.prompt(task.id, `FIXTURE_INERT_OUTPUT:${pseudo}`);
    assert.equal(task.status, 'failed'); await bridge.supervisor.tick();
    assert.equal(task.mission.attempts, 0); assert.equal(task.recovery?.reason, 'human_or_execution_review');
    await bridge.stopTask(task.id);
    const Manager = require('../src/task-session-model');
    const recovered = new Manager(path.join(root, 'data'), bridge.memory.db).get(task.id);
    assert.equal(recovered.status, 'failed');
  });
}
test('same repository task with broker-confirmed native read may complete; prior turn evidence is not inherited', async t => {
  const { root, bridge } = await fixture(t), workspace = path.join(root, 'repo'); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'owned.txt'), 'fixture');
  const task = bridge.tasks.get(bridge.createTask('read fixture', { workspace }).id);
  const steps = [{ path: '/capability', body: { toolName: 'read', input: { path: 'owned.txt' }, toolCallId: 'closure-real-read' } }];
  await bridge.prompt(task.id, 'FIXTURE_POLICY_SCRIPT:' + Buffer.from(JSON.stringify(steps)).toString('base64'));
  assert.equal(task.status, 'completed'); assert.equal(task.nativeExecutionEvidence.completed_invocations, 1);
  const runs = bridge.controlStore.db.prepare('SELECT id FROM cp_runs WHERE task_id=?').all(task.id);
  assert.equal(evidence.runSatisfied(bridge.controlStore.run(runs.at(-1).id)), true);
  await bridge.prompt(task.id, 'FIXTURE_INERT_OUTPUT:<function=ls>.</function>');
  assert.equal(task.status, 'failed'); assert.equal(task.nativeExecutionEvidence.completed_invocations, 0);
});
test('pure reasoning with zero native invocations completes normally', async t => {
  const { bridge } = await fixture(t), task = bridge.tasks.get(bridge.createTask('reason about a puzzle', { requiredExecutionKind: 'reasoning' }).id);
  await bridge.prompt(task.id, 'Explain why two plus two equals four.'); assert.equal(task.status, 'completed'); assert.equal(task.nativeExecutionEvidence.completed_invocations, 0);
});
test('verification rejects absent or wrong-run execution evidence before using any capability', async () => {
  const { MissionVerifier } = require('../src/mission-verifier'); let calls = 0;
  const verifier = new MissionVerifier({ tasks: { get: () => ({ id: 'fixture' }) }, invokeCapability: () => { calls++; } }, {});
  for (const result of [null, { native_execution_evidence: { run_id: 'other', required_execution_kind: 'native', completed_invocations: 1 } }]) {
    const checked = await verifier.verify({ envelope: {} }, { id: 'run', agent_id: 'pi', task_id: 'fixture', state: 'completed', result });
    assert.equal(checked.status, 'failed'); assert.equal(checked.checks[0].evidence.reason, 'native_tool_required');
  }
  assert.equal(calls, 0);
});
test('repository requirement cannot be downgraded to reasoning by caller metadata', async t => {
  const { bridge, root } = await fixture(t);
  assert.throws(() => bridge.createTask('inspect', { workspace: root, requiredExecutionKind: 'reasoning' }), /require native/);
});
test('Acceptance, fixture auto-acceptance and Next Action independently refuse a Pi run without native evidence', async t => {
  const { fixture: missionFixture } = require('./fixtures/mission-fixture.cjs');
  const { randomUUID } = require('node:crypto');
  const f = await missionFixture(t), project = f.bridge.projects.listProjects()[0];
  f.bridge.fixtureAcceptance.register({ project_id: project.projectId, workspace: f.repo, isolated: true, no_external_effects: true });
  const m = f.create({ fixture_auto_acceptance: true });
  const attempt = f.bridge.fixtureAcceptance.attempt.bind(f.bridge.fixtureAcceptance);
  f.bridge.fixtureAcceptance.attempt = () => ({ accepted: false });
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() }); await f.settle(m.id);
  f.bridge.fixtureAcceptance.attempt = attempt;
  const v = f.bridge.missions.detail(m.id).verifications[0], db = f.bridge.memory.db;
  // Simulate a legacy/recovered Pi completion claim with no invocation record.
  db.prepare("UPDATE cp_runs SET agent_id='pi',result=NULL WHERE id=?").run(v.run_id);
  assert.equal(attempt(m.id).reason, 'native_tool_required');
  assert.throws(() => f.bridge.missions.accept(m.id, { request_id: randomUUID(), verification_id: v.id, decision: 'accept', rationale: 'Forged legacy completion must not pass' }), /native execution evidence/);
  const { BoundedNextAction } = require('../src/bounded-next-action');
  const engine = new BoundedNextAction(f.bridge), id = randomUUID();
  engine.register({ id, mode: 'observe', mission_ids: [m.id], max_missions: 1, max_runtime_ms: 60000 });
  // Even a stale historical acceptance cannot confer future advancement.
  db.prepare('INSERT INTO cp_acceptances VALUES(?,?,?,?,?,?,?)').run(randomUUID(), m.id, v.id, 'accept', 'operator', '{}', Date.now());
  db.prepare("UPDATE cp_missions SET state='completed' WHERE id=?").run(m.id);
  assert.equal(engine.eligibility(engine.inspect(id)).reason, 'native_tool_required');
  assert.equal(attempt(m.id).reason, 'native_tool_required');
});
