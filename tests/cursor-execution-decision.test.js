'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Decision = require('../src/cursor-execution-decision');
const Registry = require('../src/limits-blockers-registry');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');

function cursorReady() {
  return {
    installed: true, ready: true, available: true, availability: 'available',
    governed_worker: true, reason: null, auth_state: 'fixture',
    tiers: { installed: true, authenticated: true, qualified: true, available: true, executing: false },
  };
}

async function specialistCursorFixture(t, { proof = false } = {}) {
  const f = await fixture(t, { opencode: runtime(t).options, settleTimeoutMs: 45000 });
  const b = f.bridge;
  const file = proof ? 'recovery-proof.txt' : 'fixture.txt';
  if (proof) {
    const fs = require('node:fs');
    fs.renameSync(path.join(f.repo, 'fixture.txt'), path.join(f.repo, file));
    fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), 'Preserve this independent file.\n');
    fs.writeFileSync(path.join(f.repo, 'tests/fixture.test.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('recovery-proof.txt','utf8'),'AIRODROM-CHATGPT-HANDOFF-PASS\\n');\n");
    const git = args => require('node:child_process').execFileSync('/usr/bin/git', ['-C', f.repo, ...args], { stdio: 'pipe' });
    git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Exact file scope fixture']);
    f.instruction = 'In Fixture project using Cursor, read recovery-proof.txt then edit recovery-proof.txt to exact_file_bytes 4149524f44524f4d2d434841544750542d48414e444f46462d504153530a';
  }
  b.missionAuthority.initializeOperatorKey();
  qualifyCanonical(b);
  b.expandedAutonomy.setMode({
    mode: 'routine_auto', confirmed: true, request_id: randomUUID(), sync_risk_acceptance: false,
  }, 'operator');
  b.cursorWorker = new (require('../src/cursor-worker').CursorWorker)(b, {
    fixtureExecutable: path.join(__dirname, 'fixtures/cursor-agent-fixture.cjs'),
  });
  b.hostExecutionPolicy = {
    cursorDisabled: () => false,
    assertCursorAllowed: () => {},
  };
  const p = b.projects.listProjects({ status: 'active' })[0];
  const g = b.projects.summary(p.projectId).goals[0];
  b.developerAutonomy.enroll({
    alias: 'cursor-decision-fixture', repository: f.repo, project_id: p.projectId, goal_id: g.goalId,
    workflows: ['routine_edit', 'test'], workers: ['opencode', 'cursor'], duration_days: 1, confirmed: true,
    diff_check: 'diff-check', default_tests: ['fixture-test'], budgets: { max_repairs: 0 },
    cognitive: {
      version: 3, files: proof ? [file, 'AGENTS.md'] : [file], delegated_callers: [], planning_attempts: 2,
      planning_ms: 120000, execution_ms: 120000, repair_attempts: 0, max_assignments: 2, acceptance: 'automatic',
    },
  }, 'operator');
  f.plan = [
    {
      id: 'read-1', worker: 'cursor', role: 'analysis', operation: 'read', paths: [file],
      description: 'Read ' + file, depends_on: [], verification: [],
    },
    {
      id: 'change-1', worker: 'cursor', role: 'implementation', operation: 'edit', paths: [file],
      description: proof ? 'Edit recovery-proof.txt to exact_file_bytes 4149524f44524f4d2d434841544750542d48414e444f46462d504153530a' : 'Change alpha to beta', depends_on: ['read-1'], verification: [],
    },
  ];
  f.evaluations = [];
  const adapter = b.opencodeAdapter;
  const worker = adapter.execute.bind(adapter);
  adapter.execute = async (o) => {
    if (o.planning) {
      return {
        result: { summary: JSON.stringify({ ...o.planning, tasks: f.plan }) },
        changes: [], provenance: { termination_verified: true },
      };
    }
    if (o.coordination) {
      f.evaluations.push(o.coordination);
      const override = await f.onEvaluation?.(o);
      if (override) return override;
      return {
        result: {
          summary: JSON.stringify({
            ...o.coordination.result_contract,
            recommendation: o.coordination.host_checks.some((c) => c.status === 'failed') ? 'blocked' : 'ready',
            summary: 'ok',
          }),
        },
        changes: [],
        provenance: { runtime_id: 'opencode', sandbox: 'fixture', termination_verified: true, authority: false },
      };
    }
    return worker(o.writable.length ? o : {
      ...o, objective: 'Inspect fixture.txt without changes', objectiveProof: null,
    });
  };
  return f;
}

async function startCursorGraph(f, { expectBlocked = false } = {}) {
  const request_id = f.requestId || randomUUID();
  const instruction = f.instruction || 'In Fixture project, using Cursor, read fixture.txt then change fixture.txt from alpha to beta.';
  let v = await f.bridge.zeroSetupWork.ask({ request_id, instruction }, 'operator');
  for (let i = 0; i < 200 && v.state === 'PLANNING'; i++) {
    await new Promise((r) => setTimeout(r, 20));
    v = await f.bridge.zeroSetupWork.ask({ request_id, instruction }, 'operator');
  }
  if (v.state === 'WAIT') {
    v = await f.bridge.zeroSetupWork.approve({
      request_id: v.request_id, confirmed: true, channel: 'control_center',
      subscription_execution: {
        provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 2, max_runtime_ms: 120000,
      },
    }, 'operator');
  }
  if (expectBlocked) { assert.equal(v.state, 'BLOCKED', JSON.stringify(v)); assert.equal(v.mission_id, null); }
  else assert.ok(v.mission_id, JSON.stringify(v));
  return v;
}

const invalidEvaluation = summary => ({ result: { summary }, changes: [], provenance: { termination_verified: true } });
test('Cursor intake avoids a duplicate-admission blocker and projects obsolete startup errors from live Mission state', async t => {
  const f = await specialistCursorFixture(t), b = f.bridge;
  const readiness = b.cursorWorker.readiness.bind(b.cursorWorker);
  b.cursorWorker.readiness = async options => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return readiness(options);
  };
  const v = await startCursorGraph(f);
  assert.deepEqual(v.blockers, []);
  const m = await f.settle(v.mission_id, 'completed');
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 2);
  const record = { ...b.zeroSetupWork.read(v.request_id), state: 'blocked', blockers: ['gateway_assignment_state'],
    presentation: { worker: 'cursor', status: 'gateway_assignment_state', owner_approval_required: true, owner_gate: { required: true }, registry_id: 'unknown_blocker' } };
  const before = JSON.stringify(record);
  const projected = require('../src/cognitive-router').view(record, b);
  assert.equal(projected.state, 'ACCEPTED');
  assert.deepEqual(projected.blockers, []);
  assert.equal(projected.presentation.owner_gate, undefined);
  assert.equal(projected.presentation.status, 'Completed');
  assert.equal(JSON.stringify(record), before, 'historical intake evidence is immutable');
  const denied = require('../src/cognitive-router').view({ ...record, blockers: ['CURSOR_EXECUTION_DISABLED'] }, b);
  assert.deepEqual(denied.blockers, ['CURSOR_EXECUTION_DISABLED']);
});
test('all evaluator recovery entry points enforce failure class, termination and the existing run budget', () => {
  const G = require('../src/opencode-gateway');
  const m = { state: 'blocked', reason: 'EVALUATION_UNAVAILABLE: opencode_runtime_unavailable' };
  const attempt = { run_id: 'worker', verification: { status: 'passed' } };
  const run = { id: 'eval', agent_id: 'opencode', state: 'failed', pid: 10, termination_verified: 1,
    resolution: 'opencode_evaluation_result_invalid', result: { gateway: { worker_run_id: 'worker',
      failure_class: 'opencode_evaluation_result_invalid', failure_code: 'gateway_json_required' } } };
  assert.equal(G.preStartEvaluationRetryable(m, [run], attempt), true);
  assert.equal(G.preStartEvaluationRetryable(m, [run, { ...run, id: 'eval-2' }], attempt), true);
  assert.equal(G.preStartEvaluationRetryable(m, [run, run, run], attempt), false);
  assert.equal(G.preStartEvaluationRetryable(m, [{ ...run, termination_verified: 0 }], attempt), false);
  for (const code of ['gateway_result_binding_mismatch', 'opencode_sensitive_context', 'opencode_evaluation_authority_denied']) {
    const denied = { ...run, result: { gateway: { ...run.result.gateway, failure_code: code } } };
    assert.equal(G.preStartEvaluationRetryable(m, [denied], attempt), false, code);
  }
  assert.equal(G.evaluationContinuation({ ...m, reason: 'EVALUATION_UNAVAILABLE: opencode_sensitive_context' }, attempt), false);
});
async function awaitGraph(f, id, predicate, timeout = 60000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    await f.bridge.missions.tick();
    const m = f.bridge.missions.detail(id);
    if (predicate(m)) return m;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const m = f.bridge.missions.detail(id);
  if (predicate(m)) return m;
  assert.fail(JSON.stringify({ state: m.state, reason: m.reason, evaluations: f.evaluations.length, runs: m.runs.map(r => ({ agent: r.agent_id, state: r.state, error_class: r.result?.error_class || null })) }));
}

test('local evaluator recovers from unavailable then malformed JSON without replaying Cursor', async t => {
  const f = await specialistCursorFixture(t);
  f.onEvaluation = async () => {
    if (f.evaluations.length === 1) throw Object.assign(Error('opencode_runtime_unavailable'), { code: 'opencode_runtime_unavailable' });
    if (f.evaluations.length === 2) {
      // Keep the evaluator active past the initial deferred-retry timer, as the
      // real model does. Instant fixture replies otherwise hide the lost wake.
      await new Promise(resolve => setTimeout(resolve, 3000));
      return invalidEvaluation('Evaluation complete, but no JSON was returned.');
    }
  };
  const v = await startCursorGraph(f);
  const m = await awaitGraph(f, v.mission_id, m => m.state === 'completed');
  assert.equal(f.evaluations.length, 4);
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 2);
  assert.ok(m.specialists.assignments.every(a => a.state === 'ready' && a.attempts.length === 1));
  assert.equal(m.acceptance.length, 1);
});

test('evidence reports an active bounded evaluator retry while the parent remains blocked', async t => {
  const f = await specialistCursorFixture(t);
  let retryEvidence;
  f.onEvaluation = async () => {
    if (f.evaluations.length === 1) return invalidEvaluation('No evaluation JSON.');
    if (f.evaluations.length === 2) {
      const mission=f.bridge.controlStore.db.prepare("SELECT id FROM cp_missions WHERE state='blocked'").get();
      retryEvidence=require('../src/mission-evidence').evidencePackage(f.bridge,mission.id);
    }
  };
  const v=await startCursorGraph(f);
  const m=await awaitGraph(f,v.mission_id,m=>m.state==='completed');
  assert.equal(retryEvidence.status,'RECOVERING');
  assert.equal(retryEvidence.phase.observing,true);
  assert.match(retryEvidence.next_safe_action,/retrying the read-only evaluation/);
  assert.deepEqual(retryEvidence.answers.requires_owner,[]);
  assert.equal(m.runs.filter(r=>r.agent_id==='cursor').length,2);
  assert.equal(m.acceptance.length,1);
});

test('malformed evaluator responses stop at the existing three-run ceiling and show the latest failure', async t => {
  const f = await specialistCursorFixture(t);
  f.onEvaluation = async () => {
    if (f.evaluations.length === 1) throw Object.assign(Error('opencode_runtime_unavailable'), { code: 'opencode_runtime_unavailable' });
    await new Promise(resolve => setTimeout(resolve, 3000));
    return invalidEvaluation('No evaluation JSON.');
  };
  const v = await startCursorGraph(f);
  const m = await awaitGraph(f, v.mission_id, m => f.evaluations.length === 3 && m.runs.filter(r => r.agent_id === 'opencode' && r.state === 'failed').length === 3);
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(f.evaluations.length, 3);
  assert.match(m.reason, /opencode_evaluation_result_invalid/);
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 1);
  assert.equal(m.specialists.assignments[1].attempts.length, 0);
  assert.equal(m.acceptance.length, 0);
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(m.id).n, 0);
});

test('a malformed final evaluation recovers through acceptance without replaying either Cursor assignment', async t => {
  const f = await specialistCursorFixture(t);
  f.onEvaluation = () => f.evaluations.length === 2 ? invalidEvaluation('Missing final JSON.') : undefined;
  const v = await startCursorGraph(f);
  const m = await awaitGraph(f, v.mission_id, m => m.state === 'completed');
  assert.equal(f.evaluations.length, 3);
  assert.equal(f.evaluations[2].assignment_contract.stage, 'final');
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 2);
  assert.equal(m.acceptance.length, 1);
  assert.ok(m.specialists.assignments.every(a => a.state === 'ready' && a.attempts.length === 1));
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(m.id).n, 0);
});

for (const mutation of ['none', 'workspace', 'revocation', 'receipt']) test(`saved READY receipt recovery: ${mutation}`, async t => {
  const f = await specialistCursorFixture(t), service = f.bridge.missions;
  f.onEvaluation = () => f.evaluations.length === 2 ? invalidEvaluation('Missing final JSON.') : undefined;
  const persist = service.verifier.persist.bind(service.verifier);
  let failFinalization = true;
  service.verifier.persist = (...args) => {
    if (failFinalization && args[0].state === 'blocked') throw Object.assign(Error('gateway_parent_stopped'), { code: 'gateway_parent_stopped' });
    return persist(...args);
  };
  const v = await startCursorGraph(f);
  await awaitGraph(f, v.mission_id, m => m.reason === 'EVALUATION_UNAVAILABLE: gateway_parent_stopped');
  const blocked = service.store.requireMission(v.mission_id);
  if (mutation === 'workspace') require('node:fs').writeFileSync(path.join(blocked.envelope.workspace, 'fixture.txt'), 'changed after verification\n');
  if (mutation === 'revocation') f.bridge.missionApprovals.revoke(blocked.envelope.approval_id, { request_id: randomUUID(), reason: 'Fixture revocation', confirmed: true });
  if (mutation === 'receipt') {
    const worker = f.bridge.missions.detail(v.mission_id).runs.filter(r => r.agent_id === 'cursor').at(-1);
    const receipt = require('../src/opencode-gateway').receipt(f.bridge, v.mission_id, worker.id);
    receipt.result.gateway.binding_hash = 'ab'.repeat(32);
    service.db.prepare('UPDATE cp_runs SET result=? WHERE id=?').run(JSON.stringify(receipt.result), receipt.id);
  }
  failFinalization = false;
  // Exercise the same durable recovery entry point used on service restart.
  require('../src/specialist-gateway').recover(service, service.store.requireMission(v.mission_id));
  const error = { workspace: 'gateway_workspace_changed', revocation: 'approval_revoked', receipt: 'gateway_evaluation_stale' }[mutation];
  const m = await awaitGraph(f, v.mission_id, m => error
    ? m.reason === 'EVALUATION_UNAVAILABLE: ' + error : m.state === 'completed');
  assert.equal(f.evaluations.length, 3, 'the saved evaluator receipt must be reused');
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 2);
  assert.equal(m.acceptance.length, error ? 0 : 1);
  if (error) assert.equal(m.state, 'blocked');
});

test('a mismatched evaluator binding does not trigger an automatic syntax retry', async t => {
  const f = await specialistCursorFixture(t);
  f.onEvaluation = o => invalidEvaluation(JSON.stringify({ ...o.coordination.result_contract, binding_hash: 'ab'.repeat(32), recommendation: 'ready', summary: 'Wrong binding.' }));
  const v = await startCursorGraph(f), m = await f.settle(v.mission_id, 'blocked');
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(f.evaluations.length, 1);
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 1);
  assert.equal(m.acceptance.length, 0);
  const evidence=require('../src/mission-evidence').evidencePackage(f.bridge,m.id);
  assert.equal(evidence.status,'BLOCKED');
  assert.deepEqual(evidence.answers.requires_owner,['Inspect diagnostics']);
  assert.match(evidence.next_safe_action,/no automatic retry is pending/);
});

test('dependent Cursor edit completes despite a stale negative readiness observation after the read', async (t) => {
  const f = await specialistCursorFixture(t), b = f.bridge, worker = b.cursorWorker;
  // Exercise production qualification semantics; only the subprocess is synthetic.
  const qualifiedFor = worker.qualifiedFor;
  worker.qualifiedFor = (m, opts) => qualifiedFor.call({ options: {}, lastReadiness: worker.lastReadiness }, m, opts);
  f.onEvaluation = () => {
    if (f.evaluations.length === 1) worker.lastReadiness = {
      ...cursorReady(), ready: false, available: false, reason: 'cursor_version_unavailable',
    };
  };
  const v = await startCursorGraph(f);
  const m = await f.settle(v.mission_id, 'completed');
  assert.deepEqual(m.specialists.assignments.map(a => [a.operation, a.state, a.attempts.length]), [
    ['read', 'ready', 1], ['edit', 'ready', 1],
  ]);
  assert.equal(f.evaluations.length, 2);
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 2);
  assert.equal(m.acceptance.length, 1);
  assert.equal(require('node:fs').readFileSync(path.join(m.envelope.workspace, 'fixture.txt'), 'utf8'), 'beta\n');
  assert.equal(b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(m.id).n, 0);
});

test('dependent dispatch retries a fresh transient probe without replaying the completed read', async (t) => {
  const f = await specialistCursorFixture(t), worker = f.bridge.cursorWorker;
  const readiness = worker.readiness.bind(worker);
  let injected = 0;
  worker.readiness = async (opts = {}) => {
    if (opts.fresh && f.evaluations.length === 1 && injected++ === 0) return {
      ...cursorReady(), ready: false, available: false, reason: 'cursor_version_unavailable',
    };
    return readiness(opts);
  };
  const v = await startCursorGraph(f), m = await f.settle(v.mission_id, 'completed');
  assert.equal(f.evaluations.length, 2);
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 2);
  assert.ok(m.specialists.assignments.every(a => a.attempts.length === 1));
  const rows = f.bridge.controlStore.db.prepare('SELECT route FROM cp_dispatches WHERE mission_id=?').all(m.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.map(r => JSON.parse(r.route).transient_retries || 0).reduce((a, b) => a + b), 1);
});

test('persistent dependent runtime failure stops after two retries with no second worker run', async (t) => {
  const f = await specialistCursorFixture(t), worker = f.bridge.cursorWorker;
  const readiness = worker.readiness.bind(worker);
  let probes = 0;
  worker.readiness = async (opts = {}) => {
    if (opts.fresh && f.evaluations.length === 1) {
      probes++;
      return { ...cursorReady(), ready: false, available: false, reason: 'cursor_version_unavailable' };
    }
    return readiness(opts);
  };
  const v = await startCursorGraph(f), m = await f.settle(v.mission_id, 'blocked');
  assert.equal(m.reason, 'cursor_version_unavailable');
  assert.equal(probes, 3);
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 1);
  assert.equal(m.acceptance.length, 0);
  assert.equal(require('node:fs').readFileSync(path.join(m.envelope.workspace, 'fixture.txt'), 'utf8'), 'alpha\n');
});

test('a transient failure after a dependent run starts never retries that run', async (t) => {
  const f = await specialistCursorFixture(t), worker = f.bridge.cursorWorker;
  const execute = worker.execute.bind(worker);
  let calls = 0;
  worker.execute = async o => {
    calls++;
    if (calls === 2) throw Object.assign(Error('cursor_version_unavailable'), { transient: true });
    return execute(o);
  };
  const v = await startCursorGraph(f), m = await f.settle(v.mission_id, 'needs_rework');
  assert.equal(calls, 2);
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 2);
  assert.ok(m.specialists.assignments.every(a => a.attempts.length === 1));
  assert.equal(m.acceptance.length, 0);
});

test('registry normalizes cognitive_worker_unqualified:cursor', () => {
  const entry = Registry.resolve('cognitive_worker_unqualified:cursor');
  assert.equal(entry.id, 'cognitive_worker_unqualified');
  assert.equal(entry.registered, true);
  assert.equal(entry.recovery_dispatcher.operation, 'refresh_cursor_execution_decision');
});

test('registry maps cursor_runtime_not_ready codes', () => {
  assert.equal(Registry.resolve('cursor_runtime_not_ready').id, 'cursor_runtime_not_ready');
  assert.equal(Registry.resolve('cursor_version_unavailable').id, 'cursor_runtime_not_ready');
});

test('qualified Cursor with Mission grant allows dispatch', async (t) => {
  const f = await specialistCursorFixture(t);
  const view = await (async () => {
    const request_id = randomUUID();
    const instruction = 'In Fixture project, using Cursor, read fixture.txt then change fixture.txt from alpha to beta.';
    let v = await f.bridge.zeroSetupWork.ask({
      request_id, instruction,
      // Force Cursor path through standing-style approve when WAIT.
    }, 'operator');
    for (let i = 0; i < 200 && v.state === 'PLANNING'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      v = await f.bridge.zeroSetupWork.ask({ request_id, instruction }, 'operator');
    }
    if (v.state === 'WAIT') {
      v = await f.bridge.zeroSetupWork.approve({
        request_id: v.request_id, confirmed: true, channel: 'control_center',
        subscription_execution: {
          provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 2, max_runtime_ms: 120000,
        },
      }, 'operator');
    }
    return v;
  })();
  assert.ok(view.mission_id, JSON.stringify(view));
  const m = f.bridge.controlStore.requireMission(view.mission_id);
  const readiness = cursorReady();
  f.bridge.cursorWorker.lastReadiness = readiness;
  const decision = Decision.decide(f.bridge, m, { readiness });
  assert.equal(decision.allow, true, JSON.stringify(decision));
  assert.equal(decision.dimensions.standing_or_mission_grant_covers, true);
  assert.equal(decision.dimensions.external_disclosure_covered, true);
  f.bridge.cursorWorker.lastReadiness = { ...readiness, ready: false, reason: 'cursor_version_unavailable' };
  assert.equal(Decision.decideAuthority(f.bridge, m).allow, true);
  assert.equal(Decision.decide(f.bridge, m).code, 'cursor_version_unavailable');
  const changed = structuredClone(m);
  changed.envelope.contract.permissions.allowed_write_paths = ['outside.txt'];
  assert.equal(Decision.decideAuthority(f.bridge, changed).allow, false, 'modified scope stays denied');
  f.bridge.missionApprovals.revoke(m.envelope.approval_id, {
    request_id: randomUUID(), confirmed: true, reason: 'Synthetic revocation test',
  }, 'operator');
  const revoked = Decision.decide(f.bridge, m, { readiness });
  assert.equal(revoked.allow, false);
  assert.match(revoked.code, /revoked/);
});

test('Cursor available but grant missing blocks', async (t) => {
  const f = await specialistCursorFixture(t);
  const m = {
    id: randomUUID(),
    envelope: {
      preferred_agent: 'cursor',
      approval_id: null,
      contract: {
        permissions: {
          external_disclosure: { authorized: true, providers: ['cursor'] },
          network: { mode: 'allowlist', allow: ['api2.cursor.sh'] },
          personal_memory: { mode: 'none' },
          vault_access: { mode: 'none' },
        },
        execution: { mode: 'sandboxed_headless', sandbox: 'sandbox-exec' },
      },
    },
  };
  // Bypass assertIntact by stubbing
  const mc = require('../src/mission-contract');
  const prev = mc.assertIntact;
  mc.assertIntact = () => {};
  t.after(() => { mc.assertIntact = prev; });
  f.bridge.cursorWorker.qualifiedFor = () => false;
  const decision = Decision.decide(f.bridge, m, { readiness: cursorReady() });
  assert.equal(decision.allow, false);
  assert.ok(/BLOCKED_SPEND|worker_execution_unqualified|unqualified/i.test(decision.code), decision.code);
});

test('runtime not ready is transient and distinct from cognitive unqualified', () => {
  const bridge = {
    cursorWorker: {
      active: new Map(),
      qualifiedFor: () => true,
      lastReadiness: null,
    },
    hostExecutionPolicy: { cursorDisabled: () => false },
    controlStore: { now: () => Date.now() },
    missionApprovals: { assertDispatch: () => {} },
  };
  const m = {
    envelope: {
      preferred_agent: 'cursor',
      approval_id: randomUUID(),
      contract: {
        permissions: {
          external_disclosure: { authorized: true, providers: ['cursor'] },
          network: { mode: 'allowlist', allow: ['api2.cursor.sh'] },
          personal_memory: { mode: 'none' },
          vault_access: { mode: 'none' },
        },
        execution: { mode: 'sandboxed_headless', sandbox: 'sandbox-exec' },
      },
    },
  };
  const mc = require('../src/mission-contract');
  const prev = mc.assertIntact;
  mc.assertIntact = () => {};
  const decision = Decision.decide(bridge, m, {
    readiness: {
      installed: true, ready: false, available: false, reason: 'cursor_version_unavailable',
      governed_worker: true, tiers: { qualified: true },
    },
  });
  mc.assertIntact = prev;
  assert.equal(decision.allow, false);
  assert.equal(decision.transient, true);
  assert.notEqual(decision.code, 'cognitive_worker_unqualified:cursor');
  assert.ok(Decision.isTransient(decision.code));
});

test('unknown worker names never auto-qualify via registry', () => {
  const entry = Registry.resolve('cognitive_worker_unqualified:codex');
  assert.equal(entry.id, 'cognitive_worker_unqualified');
  assert.equal(entry.security_critical, false);
});

test('security-critical standing mismatch remains fail-closed', () => {
  const entry = Registry.resolve('STANDING_CURSOR_GRANT_MISMATCH');
  assert.equal(entry.category, 'security_critical');
  assert.equal(entry.security_critical, true);
});


test('exact recovery-proof read and edit pass host scope, bytes, settlement, and durable evidence', async t => {
  const f = await specialistCursorFixture(t, { proof: true });
  const v = await startCursorGraph(f), m = await f.settle(v.mission_id, 'completed');
  const E = require('../src/mission-evidence'), fs = require('node:fs');
  const e = E.evidencePackage(f.bridge, m.id);
  assert.equal(fs.readFileSync(path.join(m.envelope.workspace, 'recovery-proof.txt'), 'utf8'), 'AIRODROM-CHATGPT-HANDOFF-PASS\n');
  assert.equal(fs.readFileSync(path.join(m.envelope.workspace, 'AGENTS.md'), 'utf8'), 'Preserve this independent file.\n');
  assert.equal(e.file_scope.host_verification.status, 'passed');
  assert.deepEqual(e.file_scope.executed_changes, ['recovery-proof.txt']);
  assert.equal(e.verification.result, 'passed'); assert.equal(e.settlement_status, 'settled');
  assert.equal(e.acceptance_status, 'accepted'); assert.equal(f.evaluations.length, 2);
  assert.ok(e.cognitive.leases.every(l => l.state === 'released'));
  assert.equal(e.cognitive.termination, 'verified');
  const saved = JSON.stringify(e.file_scope);
  await f.reopen(); assert.equal(JSON.stringify(E.evidencePackage(f.bridge, m.id).file_scope), saved);
});

test('enrolled AGENTS substitution is rejected before any Cursor dispatch', async t => {
  const f = await specialistCursorFixture(t, { proof: true });
  f.plan = f.plan.map(task => ({ ...task, paths: ['AGENTS.md'] }));
  const v = await startCursorGraph(f, { expectBlocked: true });
  assert.equal(v.state, 'BLOCKED'); assert.deepEqual(v.blockers, ['requested_file_plan_mismatch']);
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_runs WHERE agent_id='cursor'").get().n, 0);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_acceptances').get().n, 0);
});

test('acceptance independently refuses wrong-file bytes after READY and successful verification', async t => {
  const f = await specialistCursorFixture(t, { proof: true });
  const originalList = f.bridge.policy.list.bind(f.bridge.policy);
  f.onEvaluation = async o => {
    if (o.coordination.specialist_return.assignment.id === 'change-1') {
      const m = f.bridge.controlStore.requireMission(o.coordination.specialist_return.assignment.parent_mission_id);
      f.bridge.policy.list = () => [...originalList(), { status: 'pending', taskId: m.task_id }];
    }
  };
  const v = await startCursorGraph(f), m = await f.settle(v.mission_id, 'awaiting_acceptance');
  const e = require('../src/mission-evidence').evidencePackage(f.bridge, m.id);
  assert.equal(e.verification.result, 'passed'); assert.equal(f.evaluations.length, 2);
  const fs = require('node:fs');
  fs.writeFileSync(path.join(m.envelope.workspace, 'recovery-proof.txt'), 'alpha\n');
  fs.writeFileSync(path.join(m.envelope.workspace, 'AGENTS.md'), 'AIRODROM-CHATGPT-HANDOFF-PASS\n');
  f.bridge.policy.list = originalList;
  assert.throws(() => f.bridge.missions.accept(m.id, { request_id: randomUUID(), verification_id: m.verifications[0].id, decision: 'accept', rationale: 'Attempt acceptance against independent current scope check' }, 'operator'), /requested_file_execution_mismatch/);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_acceptances WHERE mission_id=?').get(m.id).n, 0);
});


test('canonical host creation binds card-shaped request and registered workspace coordinates', async t => {
  const f = await specialistCursorFixture(t), b = f.bridge;
  const nonce = 'a4e32e0a-30a5-4bb4-a5e2-898472350870';
  const crypto = require('node:crypto'), fs = require('node:fs'), { Module } = require('node:module');
  assert.equal(require('../src/personal-memory').containsSecret(nonce), true);
  // Substitute only the workspace UUID source; registration, filesystem identity,
  // canonical creation, host scanning and both workers use the real paths.
  const filename = require.resolve('../src/developer-autonomy'), isolated = new Module(filename, module);
  isolated.filename = filename; isolated.paths = module.paths;
  const originalRequire = isolated.require.bind(isolated); let allocated = false;
  isolated.require = name => name === 'node:crypto' ? { ...crypto, randomUUID: () => {
    if (!allocated) { allocated = true; return nonce; } return crypto.randomUUID();
  } } : originalRequire(name);
  isolated._compile(fs.readFileSync(filename, 'utf8'), filename);
  b.developerAutonomy = new isolated.exports.DeveloperAutonomy(b);
  f.requestId = nonce;
  const v = await startCursorGraph(f), m = await awaitGraph(f, v.mission_id, m => m.state === 'completed');
  assert.equal(allocated, true);
  assert.equal(path.basename(m.envelope.workspace), nonce);
  assert.equal(m.envelope.contract.identity.idempotency_key, 'cognitive-cursor:' + nonce);
  const portable = b.authorityRuntime.store.getMissionRevision(m.id, 1).envelope;
  assert.equal(portable.workspace, m.envelope.workspace, 'stored authority bytes are not projected');
  assert.deepEqual(portable.contract, m.envelope.contract);
  assert.equal(m.runs.filter(r => r.agent_id === 'cursor').length, 2);
  assert.equal(f.evaluations.length, 2);
  assert.equal(m.acceptance.length, 1);
  assert.throws(() => b.authorityRuntime.store.createMission({ id: randomUUID(), envelope: portable }, b.authorityRuntime.store.host), /Sensitive authority data rejected/);
  const altered = structuredClone(portable); altered.objective = nonce;
  assert.throws(() => b.authorityRuntime.store.createMission({ id: m.id, envelope: altered }, b.authorityRuntime.store.host), /Sensitive authority data rejected/);
  const db = b.controlStore.db;
  for (const mutate of [
    e => { e.objective = nonce; },
    e => { e.authority.filesystem.write = [e.workspace + '/' + nonce + '.txt']; },
    e => { e.contract.project.extra_path = e.workspace; },
    e => { e.contract.identity.idempotency_key = 'unbound:' + nonce; },
  ]) {
    db.exec('SAVEPOINT coordinate_probe');
    try {
      const canonical = structuredClone(m.envelope); mutate(canonical);
      db.prepare('UPDATE cp_missions SET envelope=? WHERE id=?').run(JSON.stringify(canonical), m.id);
      const input = { ...canonical, baseline: portable.baseline, cognitive: portable.cognitive };
      assert.throws(() => b.authorityRuntime.store.createMission({ id: m.id, envelope: input }, b.authorityRuntime.store.host), /Sensitive authority data rejected/);
    } finally { db.exec('ROLLBACK TO coordinate_probe; RELEASE coordinate_probe'); }
  }
  for (const mutation of ['missing', 'identity', 'container']) {
    db.exec('SAVEPOINT coordinate_probe');
    try {
      if (mutation === 'missing') db.prepare('DELETE FROM cp_developer_autonomy_workspaces WHERE workspace_id=?').run(nonce);
      else {
        const ws = b.developerAutonomy.inspectWorkspace(nonce);
        if (mutation === 'identity') ws.identities[0].ino++; else ws.container = path.dirname(ws.container);
        db.prepare('UPDATE cp_developer_autonomy_workspaces SET record=? WHERE workspace_id=?').run(JSON.stringify(ws), nonce);
      }
      assert.throws(() => b.authorityRuntime.store.createMission({ id: m.id, envelope: portable }, b.authorityRuntime.store.host), /Host Mission scan workspace changed|Workspace identity changed/);
    } finally { db.exec('ROLLBACK TO coordinate_probe; RELEASE coordinate_probe'); }
  }
  assert.equal(b.authorityRuntime.store.integrity().ok, true);
});
