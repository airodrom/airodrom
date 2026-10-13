'use strict';
// ADR 0051: canonical Mission contract + one owner approval bound to the immutable
// scope fingerprint (separate from per-Mission identity).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { manifest } = require('./fixtures/opencode-fixture.cjs');
const contracts = require('../src/mission-contract');

const baseCtx = (overrides = {}) => ({
  request_id: randomUUID(), workspace: '/private/tmp/fixture-ws', allowed_files: ['fixture.txt'],
  criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }],
  verification: { diff_check: 'diff-check', tests: ['fixture-test'], syntax: [] },
  preferred_agent: 'host', fallback_agents: [], dispatch_policy: { privacy: 'local_only' },
  objective: 'Change fixture.txt from alpha to beta', project_id: 'p1', goal_id: 'g1', base_commit_sha: 'a'.repeat(40), operator: true, ...overrides,
});

test('contract: defaults deny by default, unknown fields fail, identity is separate from scope fingerprint', () => {
  const a = contracts.normalizeContract({}, baseCtx({ request_id: 'r1' }));
  assert.equal(a.schema_version, 1);
  assert.equal(a.permissions.network.mode, 'none');
  assert.equal(a.permissions.vault_access.mode, 'none');
  assert.equal(a.permissions.personal_memory.mode, 'none');
  assert.equal(a.permissions.external_disclosure.authorized, false);
  assert.ok(a.permissions.denied_tools.includes('shell') && a.permissions.denied_tools.includes('sudo'));
  assert.ok(a.permissions.denied_paths.includes('.ssh/**') && a.permissions.denied_paths.includes('.env'));
  assert.deepEqual(a.permissions.allowed_write_paths, ['fixture.txt']);
  assert.equal(a.verification.verifier, 'airodrom:host-verifier');
  assert.deepEqual(a.verification.required_tests, ['fixture-test']);
  assert.equal(a.budget.max_repair_attempts, 3);
  assert.equal(a.restrictions.prohibited_deployments, true);
  // Same scope, different identity and objective text → identical fingerprint.
  const b = contracts.normalizeContract({}, baseCtx({ request_id: 'r2', objective: 'Repair [abc] failed verification. Restore the approved outcome.', repair_of: 'parent-id' }));
  assert.equal(a.scope_fingerprint, b.scope_fingerprint);
  assert.notEqual(a.identity.idempotency_key, b.identity.idempotency_key);
  assert.equal(b.identity.repair_of, 'parent-id');
  assert.deepEqual(b.audit.repair_lineage, ['parent-id']);
  // Scope change → different fingerprint.
  const c = contracts.normalizeContract({ budget: { max_repair_attempts: 1 } }, baseCtx({ request_id: 'r3' }));
  assert.notEqual(a.scope_fingerprint, c.scope_fingerprint);
  // Unknown fields never grant capability.
  assert.throws(() => contracts.normalizeContract({ permissions: { allow_everything: true } }, baseCtx()), /Unknown contract\.permissions field/);
  assert.throws(() => contracts.normalizeContract({ superpowers: true }, baseCtx()), /Unknown contract field/);
  assert.throws(() => contracts.normalizeContract({ permissions: { allowed_write_paths: ['tests/fixture.test.cjs'] } }, baseCtx()), /within allowed files/);
  assert.throws(() => contracts.normalizeContract({ permissions: { allowed_read_paths: ['.env'] } }, baseCtx()), /protected material/);
  assert.throws(() => contracts.normalizeContract({ permissions: { allowed_read_paths: ['../other/secret.txt'] } }, baseCtx()), /Unsafe|protected/);
  assert.throws(() => contracts.normalizeContract({ permissions: { allowed_tools: ['shell'] } }, baseCtx()), /Unknown tool permission/);
  assert.throws(() => contracts.normalizeContract({ permissions: { vault_access: { mode: 'read' } } }, baseCtx()), /not available/);
  assert.throws(() => contracts.normalizeContract({ permissions: { personal_memory: { mode: 'read' } } }, baseCtx()), /never exposed/);
  assert.throws(() => contracts.normalizeContract({ verification: { required_tests: ['made-up-test'] } }, baseCtx()), /registered verification task labels/);
  assert.throws(() => contracts.normalizeContract({ verification: { verifier: 'cursor' } }, baseCtx()), /independent host verifier/);
  assert.throws(() => contracts.normalizeContract({ verification: { required_git_checks: ['symlink_safety'] } }, baseCtx()), /Mandatory git check missing/);
  assert.throws(() => contracts.normalizeContract({ budget: { max_repair_attempts: 9 } }, baseCtx()), /Invalid max_repair_attempts/);
  assert.throws(() => contracts.normalizeContract({ budget: { max_repair_attempts: 4 } }, baseCtx({ operator: false })), /operator authority/);
  assert.throws(() => contracts.normalizeContract({ restrictions: { prohibited_deployments: false } }, baseCtx()), /always prohibited/);
  assert.throws(() => contracts.normalizeContract({ restrictions: { prohibited_git_mutations: ['commit'] } }, baseCtx()), /Git mutation prohibition missing/);
  assert.throws(() => contracts.normalizeContract({ identity: { expires_at: Date.now() - 1 } }, baseCtx()), /contract_expired/);
  // Tamper detection on stored contracts.
  const tampered = JSON.parse(JSON.stringify(a)); tampered.permissions.allowed_write_paths.push('src/auth.js');
  assert.throws(() => contracts.assertIntact(tampered), /altered after creation/);
  assert.equal(contracts.assertIntact(a), a);
});

test('contract: external workers require explicit disclosure authorization and a known-host allowlist', () => {
  const cursorCtx = (extra = {}) => baseCtx({ preferred_agent: 'cursor', dispatch_policy: { privacy: 'approved_external' }, ...extra });
  assert.throws(() => contracts.normalizeContract({}, cursorCtx()), /external_disclosure_unauthorized/);
  assert.throws(() => contracts.normalizeContract({ permissions: { external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'qualification' } } }, cursorCtx()), /explicit network allowlist/);
  assert.throws(() => contracts.normalizeContract({ permissions: { external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'qualification' }, network: { mode: 'allowlist', allow: ['evil.example.com'] } } }, cursorCtx()), /known provider hosts/);
  assert.throws(() => contracts.normalizeContract({ permissions: { external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'q', data_classes: ['personal_memory'] }, network: { mode: 'allowlist', allow: ['api2.cursor.sh'] } } }, cursorCtx()), /never be disclosed/);
  assert.throws(() => contracts.normalizeContract({ permissions: { external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'q' }, network: { mode: 'allowlist', allow: ['api2.cursor.sh'] } } }, cursorCtx({ operator: false })), /operator authority/);
  assert.throws(() => contracts.normalizeContract({ permissions: { external_disclosure: { authorized: true, providers: ['codex'], purpose: 'q' }, network: { mode: 'allowlist', allow: ['api2.cursor.sh'] } } }, cursorCtx()), /not covered by the disclosure/);
  const ok = contracts.normalizeContract({ permissions: { external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'Disposable Cursor qualification' }, network: { mode: 'allowlist', allow: ['api2.cursor.sh', 'api3.cursor.sh'] } } }, cursorCtx());
  assert.equal(ok.permissions.external_disclosure.authorized, true);
  assert.equal(ok.permissions.external_providers.mode, 'approved');
  assert.equal(ok.execution.mode, 'sandboxed_headless');
  assert.equal(ok.execution.sandbox, 'sandbox-exec');
  assert.equal(ok.budget.spend_observability, 'UNKNOWN_SUBSCRIPTION');
  // Local-only Missions cannot carry a meaningless disclosure grant.
  assert.throws(() => contracts.normalizeContract({ permissions: { external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'q' } } }, baseCtx()), /meaningless/);
});

test('definition of done is measurable only from registered verification and never invents tests', () => {
  const dod = contracts.definitionOfDone({ intent: { kind: 'exact_file' }, criteria: [{ id: 'f', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }], verification: { tests: ['fixture-test'], diff_check: 'diff-check' }, allowed_files: ['fixture.txt'] });
  assert.equal(dod.measurable, true);
  assert.ok(dod.items.some(i => /626574610a/.test(i.text)));
  assert.ok(dod.items.some(i => /"fixture-test" passes/.test(i.text)));
  const vague = contracts.definitionOfDone({ intent: { kind: 'general' }, criteria: [{ id: 'r', type: 'operator_review', description: 'Fix login' }], verification: { tests: [] }, allowed_files: [] });
  assert.equal(vague.measurable, false);
  assert.match(vague.clarify, /Which exact file/);
});

test('governed Missions carry a contract and a bound approval; repairs reuse the approval in-scope; replay/expiry/revocation fail closed', async t => {
  const f = await fixture(t);
  const approvals = f.bridge.missionApprovals;
  const create = (extra = {}) => f.create({
    objective: 'Change fixture.txt from alpha to beta ' + randomUUID().slice(0, 6), task_type: 'local_files', manifest: manifest(f.repo),
    dispatch_policy: { privacy: 'local_only', providers: ['local'], billing_classes: ['local'], task_category: 'deterministic_files', native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'gamma\n' }] },
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }],
    contract: { budget: { risk_class: 'fixture' } }, ...extra,
  });
  const parent = create();
  assert.ok(parent.envelope.contract, 'contract stored in the envelope');
  assert.equal(parent.envelope.contract.budget.max_repair_attempts, 1);
  assert.equal(parent.envelope.contract.project.base_commit_sha.length, 40);
  assert.ok(parent.envelope.contract.audit.verifier_baseline.files.some(x => x.path === 'tests/fixture.test.cjs'));
  assert.ok(parent.envelope.contract.audit.verifier_baseline.files.some(x => x.path === '.vscode/tasks.json'));
  // Non-operator principals cannot shape contracts or approvals.
  assert.throws(() => f.bridge.missions.create({ request_id: randomUUID(), project_id: parent.project_id, goal_id: parent.goal_id, objective: 'x', workspace: f.repo, allowed_files: ['fixture.txt'], criteria: [{ id: 'c', type: 'operator_review', description: 'd' }], verification: { diff_check: 'diff-check', tests: ['fixture-test'], syntax: [] }, contract: {} }, 'mcp:zero-setup'), /Only operator/);
  // Issue one approval for the contract; replay with identical scope is idempotent.
  const approval = approvals.issue({ request_id: 'approve-1', channel: 'fixture', contract: parent.envelope.contract, confirmed: true, ttl_ms: 60 * 60 * 1000 }, 'operator');
  assert.equal(approval.state, 'active');
  assert.equal(approval.repair_budget, 1);
  assert.equal(approvals.issue({ request_id: 'approve-1', channel: 'fixture', contract: parent.envelope.contract, confirmed: true, ttl_ms: 60 * 60 * 1000 }, 'operator').duplicate, true);
  assert.throws(() => approvals.issue({ request_id: 'approve-1', channel: 'fixture', contract: parent.envelope.contract, confirmed: false }, 'operator'), /Explicit owner approval/);
  assert.throws(() => approvals.issue({ request_id: 'approve-1', channel: 'fixture', contract: parent.envelope.contract, confirmed: true }, 'mcp:zero-setup'), /operator required/);
  // Replay of the same request id with a different scope is denied.
  const other = create({ contract: { budget: { risk_class: 'low' } } });
  assert.throws(() => approvals.issue({ request_id: 'approve-1', channel: 'fixture', contract: other.envelope.contract, confirmed: true }, 'operator'), /approval_replay_denied/);
  // Bind, then run: dispatch is allowed; a different-scope Mission cannot bind.
  approvals.bind(approval.approval_id, parent.id, 'operator');
  assert.equal(f.bridge.controlStore.requireMission(parent.id).envelope.approval_id, approval.approval_id);
  assert.throws(() => approvals.bind(approval.approval_id, other.id, 'operator'), /approval_scope_mismatch/);
  f.bridge.missions.dispatch(parent.id, { request_id: randomUUID() });
  await f.settle(parent.id, 'needs_rework');
  const failed = f.bridge.missions.detail(parent.id);
  assert.ok(failed.verifications[0].evidence.some(c => c.id === 'contract_integrity' && c.status === 'passed'));
  assert.ok(failed.verifications[0].evidence.some(c => c.id === 'verifier_inputs_unchanged' && c.status === 'passed'));
  // Corrective Mission: new identity, same fingerprint, same approval, bound automatically.
  const { diagnose, repairInput } = require('../src/autonomous-repair');
  const d = diagnose(f.bridge.controlStore.requireMission(parent.id), f.bridge.controlStore);
  assert.equal(d.ok, true);
  const repair = f.bridge.missions.create(repairInput(f.bridge.controlStore.requireMission(parent.id), d), 'operator');
  assert.equal(repair.envelope.repair_of, parent.id);
  assert.equal(repair.envelope.contract.scope_fingerprint, parent.envelope.contract.scope_fingerprint);
  assert.notEqual(repair.envelope.contract.identity.idempotency_key, parent.envelope.contract.identity.idempotency_key);
  assert.equal(repair.envelope.approval_id, approval.approval_id);
  assert.deepEqual(repair.envelope.contract.audit.verifier_baseline, parent.envelope.contract.audit.verifier_baseline, 'trusted baseline inherited, not re-captured');
  assert.equal(approvals.allowRepair(f.bridge.controlStore.requireMission(parent.id), { repairs: 0 }).ok, true);
  assert.equal(approvals.allowRepair(f.bridge.controlStore.requireMission(parent.id), { repairs: 1 }).reason, 'contract_budget');
  // Expiry fails closed for new dispatches.
  f.bridge.controlStore.db.prepare('UPDATE cp_mission_approvals SET expires_at=? WHERE approval_id=?').run(Date.now() - 1, approval.approval_id);
  assert.equal(approvals.view(approval.approval_id).state, 'expired');
  assert.throws(() => f.bridge.missions.dispatch(repair.id, { request_id: randomUUID() }), /approval_expired/);
  assert.equal(approvals.allowRepair(f.bridge.controlStore.requireMission(parent.id), { repairs: 0 }).reason, 'approval_expired');
  f.bridge.controlStore.db.prepare('UPDATE cp_mission_approvals SET expires_at=? WHERE approval_id=?').run(Date.now() + 3600000, approval.approval_id);
  // Revocation fails closed; a worker/MCP text cannot revive it.
  approvals.revoke(approval.approval_id, { request_id: randomUUID(), reason: 'owner stop', confirmed: true }, 'operator');
  assert.throws(() => f.bridge.missions.dispatch(repair.id, { request_id: randomUUID() }), /approval_revoked/);
  assert.equal(approvals.allowRepair(f.bridge.controlStore.requireMission(parent.id), { repairs: 0 }).reason, 'approval_revoked');
  // Envelope tampering (a worker rewriting its own permissions) is detected at dispatch.
  const row = f.bridge.controlStore.requireMission(other.id);
  const forged = { ...row.envelope, contract: { ...row.envelope.contract, permissions: { ...row.envelope.contract.permissions, allowed_write_paths: ['fixture.txt', 'src/auth.js'] } } };
  f.bridge.controlStore.db.prepare('UPDATE cp_missions SET envelope=? WHERE id=?').run(JSON.stringify(forged), other.id);
  assert.throws(() => f.bridge.missions.dispatch(other.id, { request_id: randomUUID() }), /altered after creation/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'gamma\n');
});

test('zero-setup approve issues exactly one approval bound to the Mission contract and the repair reuses it', async t => {
  const f = await fixture(t, { opencode: require('./fixtures/opencode-fixture.cjs').runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  require('./fixtures/opencode-fixture.cjs').qualifyCanonical(f.bridge);
  const project = f.bridge.projects.createProject({ name: 'Human Acceptance Exact File', repositories: [f.repo], privacyPolicy: 'local_only' });
  f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Exact-file alpha to beta' });
  const request_id = randomUUID();
  const prepared = await f.bridge.zeroSetupWork.ask({ instruction: 'Change the test file from alpha to beta and verify it.', request_id }, 'operator');
  assert.equal(prepared.state, 'WAIT');
  assert.ok(prepared.presentation.success_criteria.some(c => /626574610a/.test(c)));
  assert.equal(prepared.presentation.measurable, true);
  const approved = await f.bridge.zeroSetupWork.approve({ request_id, confirmed: true, channel: 'fixture' }, 'operator');
  const mission = f.bridge.controlStore.requireMission(approved.technical.mission_id);
  assert.ok(mission.envelope.contract);
  assert.ok(mission.envelope.approval_id);
  const approval = f.bridge.missionApprovals.view(mission.envelope.approval_id);
  assert.equal(approval.channel, 'fixture');
  assert.equal(approval.scope_fingerprint, mission.envelope.contract.scope_fingerprint);
  assert.deepEqual(approval.bound_missions, [mission.id]);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n, 1);
  // Approving twice returns the same durable state; no second approval or Mission.
  await f.bridge.zeroSetupWork.approve({ request_id, confirmed: true }, 'operator');
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n, 1);
  await f.settle(mission.id);
  assert.equal(Buffer.from(fs.readFileSync(path.join(f.repo, 'fixture.txt'))).toString('hex'), '626574610a');
  assert.equal(f.bridge.missions.detail(mission.id).acceptance.length, 0);
});
