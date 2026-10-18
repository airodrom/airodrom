'use strict';
// Actual canonical contracts, approvals, ControlPlaneStore, SQLite, identity and
// erasure integration. Running state is a synthetic host fixture: no worker,
// provider transport, credential, live process or Acceptance is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ControlPlaneStore } = require('../src/control-plane-store');
const { EventLedger } = require('../src/event-ledger');
const { MissionApprovals } = require('../src/mission-approval');
const { normalizeContract } = require('../src/mission-contract');
const { PersonalMemory } = require('../src/personal-memory');
const identity = require('../src/memory-identity');
const content = require('../src/memory-content-erasure');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-subscription-retention-'));
  const database = path.join(root, 'fixture.sqlite');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o700 });
  const now = Date.now();
  let db, store, approvals;
  const open = () => {
    db = new DatabaseSync(database);
    store = new ControlPlaneStore({ db, ledger: new EventLedger(db), now: () => now });
    approvals = new MissionApprovals({ controlStore: store });
  };
  open();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const missionId = randomUUID();
  const criteria = [{ id: 'expected', type: 'exact_file', path: 'result.txt', content: 'done\n' }];
  const contract = normalizeContract({
    permissions: {
      external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'Synthetic public-file admission regression' },
      network: { mode: 'allowlist', allow: ['api2.cursor.sh'] },
    },
    budget: { risk_class: 'low', max_repair_attempts: 0, max_worker_invocations: 1, max_wall_clock_ms: 180000 },
  }, {
    request_id: randomUUID(), now, workspace, allowed_files: ['result.txt'], criteria,
    verification: { diff_check: 'diff-check', tests: ['result-test'], syntax: [] },
    preferred_agent: 'cursor', fallback_agents: [], dispatch_policy: { privacy: 'cloud_allowed' },
    objective: 'Write the declared public fixture file', operator: true,
  });
  store.registerMission({
    id: missionId, taskId: randomUUID(), owner: 'operator', ceiling: {},
    envelope: { control_version: 2, kind: 'coding', contract, workspace,
      preferred_agent: 'cursor', fallback_agents: [], allowed_files: ['result.txt'], criteria },
  });
  const approval = approvals.issue({
    request_id: randomUUID(), channel: 'control_center', confirmed: true, contract,
    subscription_execution: { provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 1, max_runtime_ms: 10000 },
  });
  approvals.bind(approval.approval_id, missionId);
  // Admission accounting requires a running Mission. This fixture supplies that
  // state directly without claiming an actual process was launched or verified.
  db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(missionId);
  const requestId = 'mission:' + randomUUID();
  return {
    get db() { return db; }, get store() { return store; }, get approvals() { return approvals; },
    missionId, approval, requestId,
    reserve: () => approvals.reserveSubscription(missionId, requestId, 10000),
    reopen() { db.close(); open(); },
    rows: () => db.prepare('SELECT * FROM cp_subscription_invocations ORDER BY approval_id,request_id').all(),
  };
}

test('subscription schema is identity-readable while unknown columns still fail closed', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  identity.assertReadable(db);
  new MissionApprovals({ controlStore: { db } });
  assert.doesNotThrow(() => identity.assertReadable(db));
  assert.doesNotThrow(() => content.assertReadable(db));
  db.exec('ALTER TABLE cp_subscription_invocations ADD COLUMN unexpected_content TEXT');
  assert.throws(() => identity.assertReadable(db), /unclassified field/);
});

test('real canonical subscription reservations remain consumed after closing and reopening SQLite', t => {
  const f = fixture(t), reservation = f.reserve();
  assert.doesNotThrow(() => f.approvals.assertSubscription(reservation));
  assert.doesNotThrow(() => content.assertReadable(f.db));
  const before = f.rows();
  f.reopen();
  assert.deepEqual(f.rows(), before);
  assert.doesNotThrow(() => f.approvals.assertSubscription(reservation));
  assert.throws(() => f.reserve(), /subscription_invocation_replay_denied/);
  assert.throws(() => f.approvals.reserveSubscription(f.missionId, 'mission:' + randomUUID(), 10000), /subscription_invocations_exhausted/);
  f.approvals.settleSubscription(reservation, 'unknown');
  assert.equal(f.rows()[0].outcome, 'unknown');
  assert.throws(() => f.reserve(), /subscription_invocation_replay_denied/);
});

for (const outcome of [null, 'completed', 'failed', 'cancelled', 'unknown']) {
  test('personal erasure preserves consumed subscription accounting for ' + (outcome || 'reserved'), t => {
    const f = fixture(t), reservation = f.reserve();
    if (outcome) f.approvals.settleSubscription(reservation, outcome);
    const before = f.rows();
    const personal = new PersonalMemory({ db: f.db });
    const item = personal.remember({ domain: 'personal', type: 'fact', subject: 'retention fixture',
      content: 'Synthetic personal erasure canary', source: 'user_explicit' });
    const contextId = randomUUID();
    f.db.prepare('INSERT INTO cp_context_packs(id,mission_id,run_id,refs,selection,content_hash,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(contextId, f.missionId, null, JSON.stringify([{ memory_id: item.memoryId }]),
        JSON.stringify({ text: 'Synthetic personal erasure canary' }), 'f'.repeat(64), Date.now());
    personal.erase(item.memoryId);
    assert.doesNotThrow(() => content.assertReadable(f.db));
    assert.equal(content.verify(f.db).valid, true);
    assert.deepEqual(f.rows(), before, 'erasure cannot remove a consumed slot or restore its allowance');
    assert.throws(() => content.assertContext(f.db, contextId), /erased|replay denied/i);
    assert.throws(() => f.reserve(), /contract|erased|scope|unavailable/i);
    f.reopen();
    assert.doesNotThrow(() => content.assertReadable(f.db));
    assert.deepEqual(f.rows(), before);
    assert.throws(() => f.reserve(), /contract|erased|scope|unavailable/i);
  });
}

test('unknown subscription outcome cannot be silently retained during personal erasure', t => {
  const f = fixture(t); f.reserve();
  f.db.prepare("UPDATE cp_subscription_invocations SET outcome='unexpected' WHERE request_id=?").run(f.requestId);
  const personal = new PersonalMemory({ db: f.db });
  const item = personal.remember({ domain: 'personal', type: 'fact', subject: 'invalid outcome fixture',
    content: 'Synthetic invalid-outcome erasure canary', source: 'user_explicit' });
  assert.throws(() => personal.erase(item.memoryId), /incomplete/);
  assert.throws(() => content.assertReadable(f.db), /incomplete/);
  assert.equal(f.rows().length, 1, 'failed erasure cannot refund a subscription slot');
});
