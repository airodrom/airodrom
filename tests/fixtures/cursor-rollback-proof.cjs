'use strict';
// Source-only synthetic recovery proof; use the supported Node 22.23.3 runtime.
// Prepare two detached worktrees at BASE below and install their unchanged locked
// dependencies. Leave PRISTINE_BASE untouched. In COMPATIBLE_BASE, backport ONLY
// the cp_subscription_invocations registry entry and nullable outcome enum from
// CURRENT_SOURCE into config/memory-retention-fields.json and
// src/memory-content-erasure.js. Do not commit either worktree: the proof checks
// HEAD at BASE and exactly that two-file diff, independently of published refs.
// Run from the repaired source checkout, using the same fresh evidence directory:
//   node tests/fixtures/cursor-rollback-proof.cjs seed CURRENT_SOURCE NEW_EVIDENCE_DIRECTORY
//   node tests/fixtures/cursor-rollback-proof.cjs unpatched PRISTINE_BASE NEW_EVIDENCE_DIRECTORY
//   node tests/fixtures/cursor-rollback-proof.cjs compatible COMPATIBLE_BASE NEW_EVIDENCE_DIRECTORY
// Seed refuses an existing directory; later phases require its exact synthetic
// marker before loading host modules or opening SQLite. Keep evidence outside the
// source trees. This does not qualify native sandbox execution or installation.
// No real worker, provider, credentials, installation or live database is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const BASE = 'fb17b8314c33024fb7d75550dc2a0cb13caba277';
const [mode, sourceInput, evidenceInput] = process.argv.slice(2);
assert.ok(['seed', 'unpatched', 'compatible'].includes(mode), 'supported proof phase');
assert.ok(sourceInput && evidenceInput, 'source and evidence paths required');
const source = path.resolve(sourceInput), evidence = path.resolve(evidenceInput);
const database = path.join(evidence, 'migrated-synthetic.sqlite');
const statePath = path.join(evidence, 'seed-state.json');
const SEED_MARKER = 'synthetic-offline-only';
let state;
if (mode !== 'seed') {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(state && typeof state === 'object' && !Array.isArray(state) && state.fixture === SEED_MARKER,
    'Refusing database access without the exact synthetic rollback seed marker');
}
const fromSource = name => require(path.join(source, 'src', name));
const { ControlPlaneStore } = fromSource('control-plane-store.js');
const { EventLedger } = fromSource('event-ledger.js');
const { MissionApprovals } = fromSource('mission-approval.js');
const { normalizeContract } = fromSource('mission-contract.js');
const { PersonalMemory } = fromSource('personal-memory.js');
const identity = fromSource('memory-identity.js');
const content = fromSource('memory-content-erasure.js');
const erasure = fromSource('memory-erasure.js');
const plain = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const checks = [];
function check(name, run) { run(); checks.push({ name, result: 'passed' }); }
function json(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function all(db, sql) { return plain(db.prepare(sql).all()); }
function invocations(db) { return all(db, 'SELECT * FROM cp_subscription_invocations ORDER BY approval_id,request_id'); }
function approvalsIdentity(db) {
  return all(db, 'SELECT approval_id,request_id,nonce,principal,channel,scope_fingerprint,authorized_at,expires_at,state FROM cp_mission_approvals ORDER BY approval_id');
}
function markers(db) { return all(db, 'SELECT * FROM memory_erasure_markers ORDER BY generation'); }
function ledgerIdentities(db) { return all(db, 'SELECT seq,event_id FROM event_ledger_events ORDER BY seq'); }
function schema(db) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cp_subscription_invocations'").get().sql;
}
function open(now, filename = database) {
  const db = new DatabaseSync(filename);
  const ledger = new EventLedger(db, { now: () => now });
  const store = new ControlPlaneStore({ db, ledger, now: () => now });
  const approvals = new MissionApprovals({ controlStore: store });
  // A real host initializes PersonalMemory on each connection. This registers
  // erasure/identity SQL functions needed by already-installed durable triggers.
  const personal = new PersonalMemory({ db, now: () => now });
  return { db, ledger, store, approvals, personal };
}
function contractFor(workspace, now, cursor) {
  return normalizeContract({
    ...(cursor ? { permissions: {
      external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'Synthetic recovery compatibility fixture' },
      network: { mode: 'allowlist', allow: ['api2.cursor.sh'] },
    } } : {}),
    budget: { risk_class: 'low', max_repair_attempts: 0, max_worker_invocations: 1, max_wall_clock_ms: 180000 },
  }, {
    request_id: randomUUID(), now, workspace, allowed_files: ['result.txt'],
    criteria: [{ id: 'expected', type: 'exact_file', path: 'result.txt', content: 'done\n' }],
    verification: { diff_check: 'diff-check', tests: ['result-test'], syntax: [] },
    preferred_agent: cursor ? 'cursor' : 'host', fallback_agents: [],
    dispatch_policy: { privacy: cursor ? 'cloud_allowed' : 'local_only' },
    objective: 'Write the declared public fixture file', operator: true,
  });
}
function register(store, contract, cursor) {
  const missionId = randomUUID();
  store.registerMission({ id: missionId, taskId: randomUUID(), owner: 'operator', ceiling: {},
    envelope: { control_version: 2, kind: 'coding', contract, workspace: contract.project.workspace,
      preferred_agent: cursor ? 'cursor' : 'host', fallback_agents: [], allowed_files: ['result.txt'],
      criteria: [{ id: 'expected', type: 'exact_file', path: 'result.txt', content: 'done\n' }] },
  });
  return missionId;
}
function assertPreserved(db, state) {
  assert.deepEqual(invocations(db), state.invocations);
  assert.equal(schema(db), state.invocationSchema);
  for (const row of state.approvalIdentities) {
    assert.deepEqual(approvalsIdentity(db).find(current => current.approval_id === row.approval_id), row);
  }
  for (const marker of state.markers) {
    assert.deepEqual(markers(db).find(current => current.generation === marker.generation), marker);
  }
  assert.deepEqual(ledgerIdentities(db).slice(0, state.ledgerIdentities.length), state.ledgerIdentities);
}
function assertErased(db, run) {
  assert.throws(() => content.assertContext(db, run.contextId), /erased|replay denied/i);
  const row = db.prepare('SELECT status,content,subject FROM personal_memories WHERE memory_id=?').get(run.memoryId);
  assert.equal(row.status, 'forgotten'); assert.equal(row.content, null); assert.equal(row.subject, '[erased]');
  assert.equal(erasure.marker(db, 'personal', run.memoryId).action, 'operator_erasure');
}
function sourceCheck() {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), BASE);
  const changed = execFileSync('git', ['diff', '--name-only', BASE], { cwd: source, encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(changed, mode === 'unpatched' ? [] : ['config/memory-retention-fields.json', 'src/memory-content-erasure.js']);
  for (const file of ['src/mission-approval.js', 'src/cursor-worker.js', 'src/mission-service.js', 'package.json', 'package-lock.json']) {
    assert.equal(digest(fs.readFileSync(path.join(source, file))), digest(execFileSync('git', ['show', BASE + ':' + file], { cwd: source })), file + ' remains baseline bytes');
  }
}

if (mode === 'seed') {
  // Deliberately non-recursive: EEXIST prevents reuse or overwrite of evidence.
  fs.mkdirSync(evidence, { mode: 0o700 });
  const workspace = path.join(evidence, 'workspace'); fs.mkdirSync(workspace, { mode: 0o700 });
  const now = Date.now();
  const f = open(now), personal = f.personal;
  const runs = [];
  try {
    check('current source creates real reserved and all four settled outcome records', () => {
      for (const outcome of [null, 'completed', 'failed', 'cancelled', 'unknown']) {
        const contract = contractFor(workspace, now, true), missionId = register(f.store, contract, true);
        const approval = f.approvals.issue({ request_id: randomUUID(), channel: 'control_center', confirmed: true, contract,
          subscription_execution: { provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 1, max_runtime_ms: 10000 } });
        f.approvals.bind(approval.approval_id, missionId);
        // The host running state is synthetic. No worker or transport is started.
        f.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(missionId);
        const requestId = 'mission:' + randomUUID();
        const reservation = f.approvals.reserveSubscription(missionId, requestId, 10000);
        if (outcome) f.approvals.settleSubscription(reservation, outcome);
        const memory = personal.remember({ domain: 'personal', type: 'fact', subject: 'Recovery fixture ' + (outcome || 'reserved'),
          content: 'Synthetic recovery erasure canary ' + (outcome || 'reserved'), source: 'user_explicit' });
        const contextId = randomUUID();
        f.db.prepare('INSERT INTO cp_context_packs(id,mission_id,run_id,refs,selection,content_hash,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(contextId, missionId, null, JSON.stringify([{ memory_id: memory.memoryId }]),
            JSON.stringify({ text: 'Synthetic recovery context' }), 'f'.repeat(64), now);
        runs.push({ missionId, requestId, contextId, memoryId: memory.memoryId, outcome });
      }
      assert.equal(invocations(f.db).length, 5);
      assert.equal(invocations(f.db).filter(row => row.state === 'reserved').length, 1);
      assert.equal(invocations(f.db).filter(row => row.state === 'settled').length, 4);
    });
    check('current source erasure is complete before any recovery code reads the database', () => {
      const prior = runs.find(run => run.outcome === 'completed');
      personal.erase(prior.memoryId); prior.erasedBeforeRecovery = true;
      assertErased(f.db, prior); content.assertReadable(f.db); assert.equal(content.verify(f.db).valid, true);
    });
    json(statePath, { fixture: SEED_MARKER, now, workspace, runs,
      invocations: invocations(f.db), invocationSchema: schema(f.db), approvalIdentities: approvalsIdentity(f.db),
      markers: markers(f.db), ledgerIdentities: ledgerIdentities(f.db) });
  } finally { f.db.close(); }
} else {
  check('pinned previous source and unchanged dispatch, approval, and dependency bytes', sourceCheck);
  if (mode === 'unpatched') {
    const db = new DatabaseSync(database);
    try {
      check('unpatched baseline rejects the migrated table in the real identity guard', () => {
        assert.throws(() => identity.assertReadable(db), /unclassified store/);
        assert.throws(() => content.assertReadable(db), /unclassified store/);
      });
      check('unpatched baseline rejects a real ControlPlaneStore Mission read', () => {
        assert.throws(() => {
          const store = new ControlPlaneStore({ db, ledger: new EventLedger(db), now: () => state.now });
          store.requireMission(state.runs[0].missionId);
        }, /unclassified store/);
      });
      check('denied old-source reads preserve accounting, event identity, and current erasure', () => assertPreserved(db, state));
    } finally { db.close(); }
  } else {
    let f = open(state.now);
    try {
      check('compatibility backport reads the existing database and preserves all invocation and approval identities', () => {
        identity.assertReadable(f.db); content.assertReadable(f.db); assertPreserved(f.db, state);
        assert.equal(f.store.requireMission(state.runs[0].missionId).id, state.runs[0].missionId);
        assert.equal(f.ledger.health().healthy, true);
      });
      check('erasure completed by the upgraded source remains enforced under recovery code', () => {
        assertErased(f.db, state.runs.find(run => run.erasedBeforeRecovery));
        assert.equal(content.verify(f.db).valid, true); erasure.assertCurrent(f.db);
      });
      check('previous approval behavior remains available and subscription admission is not added', () => {
        assert.equal(typeof f.approvals.reserveSubscription, 'undefined');
        assert.equal(typeof f.approvals.settleSubscription, 'undefined');
        const contract = contractFor(state.workspace, state.now, false), missionId = register(f.store, contract, false);
        const approval = f.approvals.issue({ request_id: randomUUID(), channel: 'control_center', confirmed: true, contract });
        f.approvals.bind(approval.approval_id, missionId);
        assert.equal(f.approvals.assertDispatch(f.store.requireMission(missionId)).approval_id, approval.approval_id);
        assert.throws(() => f.approvals.issue({ request_id: randomUUID(), channel: 'control_center', confirmed: true, contract,
          subscription_execution: { provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 1, max_runtime_ms: 10000 } }), /Unexpected input fields/);
      });
      const personal = new PersonalMemory({ db: f.db, now: () => state.now + 1000 });
      for (const run of state.runs.filter(row => !row.erasedBeforeRecovery)) {
        check('recovery erasure preserves consumed ' + (run.outcome || 'reserved') + ' accounting and previous erasure decisions', () => {
          personal.erase(run.memoryId); assertErased(f.db, run);
          assertPreserved(f.db, state); content.assertReadable(f.db);
          assert.equal(content.verify(f.db).valid, true);
        });
      }
      const finalMarkers = markers(f.db), finalLedger = ledgerIdentities(f.db);
      check('SQLite reopen preserves all consumed rows, current erasure decisions, and audit identities', () => {
        f.db.close(); f = open(state.now + 1000);
        assertPreserved(f.db, state); assert.deepEqual(markers(f.db), finalMarkers);
        assert.deepEqual(ledgerIdentities(f.db), finalLedger);
        for (const run of state.runs) assertErased(f.db, run);
        content.assertReadable(f.db); erasure.assertCurrent(f.db);
        assert.equal(content.verify(f.db).valid, true);
        assert.equal(content.qualification(f.db).pending_generations, 0);
      });
      json(path.join(evidence, 'compatible-final-state.json'), {
        invocations: invocations(f.db), markers: markers(f.db), eventIdentities: ledgerIdentities(f.db),
        erasureVerification: content.verify(f.db), erasureQualification: content.qualification(f.db),
      });
    } finally { f.db.close(); }
  }
}
const report = { phase: mode, node: process.version, source, database, pinnedBaseline: BASE,
  checksPassed: checks.length, checks, synthetic: true, liveExecution: false };
json(path.join(evidence, mode + '-report.json'), report);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
