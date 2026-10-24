'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const Registry = require('../src/limits-blockers-registry');
const Recovery = require('../src/limits-blockers-recovery');
function bridge(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  return { controlStore: { db, event() {} } };
}
test('unknown text cannot select recovery through substring or first-word collisions', () => {
  for (const code of ['new_failure WORKTREE_BUDGET_EXHAUSTED', 'new_failure: WORKTREE_BUDGET_EXHAUSTED',
    'WORKTREE_BUDGET_EXHAUSTED_extra', 'Invalid unrelated input', 'Path to something else',
    'not opencode_runtime_unavailable', 'prefix_termination_unverified']) {
    const d = Registry.resolve(code); assert.equal(d.id, 'unknown_blocker', code); assert.equal(d.automatic_recovery_allowed, false);
  }
  assert.equal(Registry.resolve('WORKTREE_BUDGET_EXHAUSTED: 4/4').id, 'worktree_budget_exhausted');
  assert.equal(Registry.resolve('Worktree budget exhausted: 4/4').id, 'worktree_budget_exhausted');
  assert.equal(Registry.resolve('cognitive_worker_unqualified:cursor').id, 'cognitive_worker_unqualified');
});
test('newly mapped diagnostics have source, exact prerequisites and no authority', () => {
  assert.equal(Registry.validateAgainstSource().ok, true);
  for (const code of ['Invalid repositories', 'PROJECT_REPOSITORY_CAPACITY_EXHAUSTED', 'cognitive_repository_ambiguous',
    'projectless_scope_required', 'requested_file_operation_required', 'Path is outside every read scope', 'opencode_evaluation_stage_mismatch']) {
    const [d] = Registry.annotateBlockers([code]); assert.equal(d.registered, true, code);
    assert.ok(d.enforcement.file); assert.ok(d.missing_prerequisite); assert.equal(d.authority, false);
  }
  assert.equal(Registry.resolve('requested_file_plan_mismatch').security_critical, true);
  assert.equal(Registry.resolve('requested_file_operation_required').security_critical, false);
});
test('compound unknown or security denial cannot run an operational recovery first', t => {
  const b = bridge(t); let mutations = 0;
  b.developerAutonomy = { list() { mutations++; return []; } };
  for (const codes of [['WORKTREE_BUDGET_EXHAUSTED', 'new_failure'], ['WORKTREE_BUDGET_EXHAUSTED', 'termination_unverified'], ['new_failure', 'WORKTREE_BUDGET_EXHAUSTED']]) {
    const r = Recovery.dispatch(b, { codes, request_id: 'fixture-' + codes.join('-'), live: false });
    assert.equal(r.recovery.operation, 'diagnose_only'); assert.equal(r.recovery.fail_closed, true);
    assert.equal(r.recovery.performed, false); assert.equal(r.resumed, false);
    assert.equal(r.recovery_receipt.plan.executable, false);
  }
  assert.equal(mutations, 0);
});
test('runtime-limit diagnosis never reseals enrollment or adds worker authority', t => {
  const b = bridge(t); let mutations = 0;
  b.developerAutonomy = { ensureCognitiveDiscovery() { mutations++; throw Error('must not be called'); },
    status() { return { policies: [{ state: 'active', policy_id: 'fixture-policy', budgets: {} }] }; },
    inspect() { return { cognitive: { execution_ms: 60000 }, workers: ['opencode'] }; } };
  for (const code of ['cursor_subscription_deadline', 'aborted', 'STANDING_CURSOR_GRANT_RUNTIME_LIMIT']) {
    const r = Recovery.dispatch(b, { codes: [code], request_id: code, live: false });
    assert.equal(r.recovery.performed, false); assert.equal(r.verification.completed_repair, false);
    assert.equal(r.recovery_receipt.plan.executable, false); assert.ok(r.owner_gate);
  }
  assert.equal(mutations, 0);
});
test('observed blockers use durable Mission reason and chronological/filter order', t => {
  const b = bridge(t); const db = b.controlStore.db;
  db.exec(`CREATE TABLE cp_missions(id TEXT, state TEXT, reason TEXT, project_id TEXT, envelope TEXT, updated_at INTEGER);
    CREATE TABLE cp_zero_setup_requests(request_id TEXT, state TEXT, record TEXT, updated_at INTEGER);`);
  db.prepare('INSERT INTO cp_missions VALUES(?,?,?,?,?,?)').run('fixture-mission', 'blocked', 'termination_unverified', 'project', '{}', 20);
  db.prepare('INSERT INTO cp_zero_setup_requests VALUES(?,?,?,?)').run('fixture-request', 'blocked', JSON.stringify({blockers:['Invalid repositories'],project_id:'project'}), 10);
  const all = Registry.diagnostics(b, {limit: 1}); assert.equal(all.observed_blockers[0].kind, 'mission');
  assert.equal(all.observed_blockers[0].blockers[0].registry_id, 'termination_unverified');
  const filtered = Registry.diagnostics(b, {category:'security_critical',project_id:'project'});
  assert.equal(filtered.observed_blockers.length, 1); assert.equal(filtered.observed_blockers[0].mission_id, 'fixture-mission');
});
test('diagnostics redact secrets while original evidence stays unchanged', () => {
  const original = 'unknown_failure: sk-fixturecredentialabcdefgh';
  const [d] = Registry.annotateBlockers([original]);
  assert.equal(d.registry_id, 'unknown_blocker'); assert.doesNotMatch(JSON.stringify(d), /sk-fixturecredentialabcdefgh/);
  assert.equal(original, 'unknown_failure: sk-fixturecredentialabcdefgh');
});

test('nested recovery reserves its durable attempt before invoking any host operation', t => {
  const b=bridge(t);let calls=0;
  b.controlStore.requireMission=()=>({envelope:{developer_autonomy:{policy_id:'fixture'}}});
  b.developerAutonomy={list:()=>[{state:'active',policy_id:'fixture'}],occupiedWorktrees:()=>1,
    reclaimIdleReadyWorkspaces(){ calls++; if(calls<5)Recovery.dispatch(b,{codes:['WORKTREE_BUDGET_EXHAUSTED'],mission_id:'same-lineage',live:false}); }};
  Recovery.dispatch(b,{codes:['WORKTREE_BUDGET_EXHAUSTED'],mission_id:'same-lineage',live:false});
  assert.equal(calls,2,'nested callbacks must see the reservation');
});
test('unavailable accounting or missing lineage cannot execute recovery', t => {
  const b=bridge(t);let calls=0;b.developerAutonomy={list(){calls++;return [];}};
  b.controlStore.db.exec('PRAGMA query_only=ON');
  const failed=Recovery.dispatch(b,{codes:['WORKTREE_BUDGET_EXHAUSTED'],request_id:'accounting-failure',live:false});
  assert.equal(failed.recovery.reason,'recovery_accounting_unavailable');
  b.controlStore.db.exec('PRAGMA query_only=OFF');
  const unbound=Recovery.dispatch(b,{codes:['WORKTREE_BUDGET_EXHAUSTED'],live:false});
  assert.equal(unbound.recovery.reason,'recovery_lineage_required');assert.equal(calls,0);
});

test('capacity recovery is restricted to the durably bound policy', t => {
  const b=bridge(t), cleaned=[];
  b.controlStore.requireMission=()=>({envelope:{developer_autonomy:{policy_id:'requested'}}});
  b.developerAutonomy={list:()=>[{state:'active',policy_id:'requested'},{state:'active',policy_id:'unrelated'}],
    occupiedWorktrees:()=>1,reclaimIdleReadyWorkspaces(p){cleaned.push(p.policy_id);}};
  Recovery.dispatch(b,{codes:['WORKTREE_BUDGET_EXHAUSTED'],mission_id:'bound',live:false});
  assert.deepEqual(cleaned,['requested']);
  const r=Recovery.dispatch(b,{codes:['WORKTREE_BUDGET_EXHAUSTED'],request_id:'unbound',live:false});
  assert.equal(r.recovery.reason,'recovery_policy_binding_required');assert.deepEqual(cleaned,['requested']);
});


test('request clarification does not become an owner-approval gate after repeated diagnosis', t => {
  const b = bridge(t);
  for (const code of ['requested_file_operation_required', 'cognitive_repository_ambiguous']) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = Recovery.dispatch(b, { codes: [code], request_id: code, live: false });
      assert.equal(result.owner_gate, null);
      assert.equal(result.recovery.performed, false);
      assert.equal(result.resumed, false);
    }
    const coverage = Recovery.coverage().items.find(item => item.id === code);
    assert.equal(coverage.owner_gate_possible, false);
  }
});
