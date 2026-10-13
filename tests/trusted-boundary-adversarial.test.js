'use strict';
// ADR 0051 §27: adversarial regression scenarios. Each unsafe operation must fail closed,
// leave no unauthorized state change, record a denial, disclose no secret, and never
// cause an unapproved repair or dispatch. Disposable fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { manifest } = require('./fixtures/opencode-fixture.cjs');
const { CursorWorker } = require('../src/cursor-worker');
const contracts = require('../src/mission-contract');
const vb = require('../src/verifier-baseline');
const terminal = require('../src/zero-setup-terminal');
const { classifyMission } = require('../src/failure-classifier');
const { AutonomousRepair } = require('../src/autonomous-repair');

const FIXTURE = path.join(__dirname, 'fixtures/cursor-agent-fixture.cjs');
const CURSOR_HOSTS = ['api2.cursor.sh', 'api3.cursor.sh'];
// Synthetic token-shaped canary assembled at runtime so no secret-shaped literal exists in source.
const SECRET = ['xoxb', '0'.repeat(12), '0'.repeat(12), 'CANARY'.repeat(4)].join('-');

function cursorRun(mode, extra = {}) {
  process.env.AIRODROM_CURSOR_FIXTURE_MODE = mode;
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adv-ws-')));
  fs.writeFileSync(path.join(ws, 'fixture.txt'), 'alpha\n');
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'keep\n');
  const w = new CursorWorker({ options: { allowFixtureWorker: true } }, { fixtureExecutable: FIXTURE });
  return { ws, promise: w.execute({ workspace: ws, files: ['fixture.txt', 'notes.txt'], writable: ['fixture.txt'], objective: 'Change fixture.txt from alpha to beta. exact_file_bytes 626574610a', timeoutMs: 5000, ...extra }).finally(() => { delete process.env.AIRODROM_CURSOR_FIXTURE_MODE; }) };
}
function failingNative(f, extra = {}) {
  return f.create({
    objective: 'Change fixture.txt from alpha to beta ' + randomUUID().slice(0, 6), task_type: 'local_files', manifest: manifest(f.repo),
    dispatch_policy: { privacy: 'local_only', providers: ['local'], billing_classes: ['local'], task_category: 'deterministic_files', native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'gamma\n' }] },
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }], contract: { budget: { risk_class: 'fixture' } }, ...extra,
  });
}
function planFor(f, m, { max_repairs = 1 } = {}) {
  const plan = f.bridge.missions.goalPlanner.create({ request_id: randomUUID(), goal_id: m.goal_id, stages: [{ id: 'work', depends_on: [], mission_id: m.id, objective: 'o', acceptance_criteria: ['a'], verification_requirements: ['v'], human_checkpoint: false }], max_runtime_hours: 1, max_attempts: 3 });
  f.bridge.autonomousExecution.authorize(plan.id, { request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1, max_dispatches: 10, max_repairs, confirmed: true });
  return plan;
}
function approve(f, m) {
  const a = f.bridge.missionApprovals.issue({ request_id: 'adv-approve-' + m.id.slice(0, 8), channel: 'fixture', contract: m.envelope.contract, confirmed: true }, 'operator');
  f.bridge.missionApprovals.bind(a.approval_id, m.id, 'operator');
  return a;
}

test('S1 worker writes outside allowed files → denied, workspace untouched', async () => {
  const { ws, promise } = cursorRun('outside');
  await assert.rejects(promise, /cursor_undeclared_write/);
  assert.equal(fs.readFileSync(path.join(ws, 'fixture.txt'), 'utf8'), 'alpha\n');
  assert.equal(fs.existsSync(path.join(ws, 'escaped.txt')), false);
});

test('S2 worker attempts to read a secret → sandbox denies; contract forbids secret paths', async () => {
  // Contract level: secret paths can never be granted.
  assert.throws(() => contracts.normalizeContract({ permissions: { allowed_read_paths: ['.env'] } }, { request_id: 'r', workspace: '/private/tmp/x', allowed_files: ['a.txt'], criteria: [], verification: { tests: ['t'] }, preferred_agent: 'host', fallback_agents: [], operator: true }), /protected material/);
  // Runtime level (darwin): proven by tests/sandbox-containment.test.js (home_secret_read / ssh_key_read EPERM).
  const proof = process.platform === 'darwin' ? await require('../src/sandbox-containment').proveContainment({ shape: 'cursor' }) : { boundaries: { home_secret_read: 'UNAVAILABLE' } };
  assert.ok(['PROVEN', 'UNAVAILABLE'].includes(proof.boundaries.home_secret_read));
  assert.notEqual(proof.boundaries.home_secret_read, 'FAILED');
});

test('S3 unapproved network endpoint → contract rejects unknown hosts; proxy denies at runtime', async () => {
  assert.throws(() => contracts.normalizeContract({ permissions: { external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'q' }, network: { mode: 'allowlist', allow: ['exfil.example.net'] } } }, { request_id: 'r', workspace: '/private/tmp/x', allowed_files: ['a.txt'], criteria: [], verification: { tests: ['t'] }, preferred_agent: 'cursor', fallback_agents: [], dispatch_policy: { privacy: 'cloud_allowed' }, operator: true }), /known provider hosts/);
  const events = [];
  const controller = new AbortController();
  const proxy = await require('../src/bounded-worker').proxy(CURSOR_HOSTS, controller, e => events.push(e));
  const net = require('node:net');
  await new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: proxy.port }, () => { s.write('CONNECT exfil.example.net:443 HTTP/1.1\r\nHost: exfil.example.net:443\r\n\r\n'); });
    s.on('close', resolve); s.on('error', resolve); setTimeout(() => { s.destroy(); resolve(); }, 1500);
  });
  await proxy.close();
  assert.ok(events.some(e => e.type === 'worker.proxy_denied' && e.reason === 'endpoint'));
});

test('S4/S5/S6 worker modifies a protected test, removes assertions, edits verifier config → tampering detected before any task runs', async t => {
  const f = await fixture(t);
  const m = failingNative(f, { dispatch_policy: { privacy: 'local_only', providers: ['local'], billing_classes: ['local'], task_category: 'deterministic_files', native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'beta\n' }] } });
  approve(f, m);
  const baseline = m.envelope.contract.audit.verifier_baseline;
  // Tamper the test (remove the assertion) and the verifier config between dispatch and verification.
  const original = f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);
  f.bridge.missions.verifier.verify = async (mission, run) => {
    fs.writeFileSync(path.join(f.repo, 'tests/fixture.test.cjs'), "// assertions removed\n");
    fs.writeFileSync(path.join(f.repo, '.vscode/tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'diff-check', type: 'process', command: 'git', args: ['diff', '--check'] }, { label: 'fixture-test', type: 'process', command: 'node', args: ['-e', 'process.exit(0)'] }] }));
    return original(mission, run);
  };
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const failed = await f.settle(m.id, 'needs_rework');
  const v = failed.verifications[0];
  const integrity = v.evidence.find(c => c.id === 'verifier_inputs_unchanged');
  assert.equal(integrity.status, 'failed');
  assert.ok(integrity.evidence.tampering.some(x => x.file === 'tests/fixture.test.cjs' && x.classification === 'verifier_owned_immutable' && x.removed_assertions >= 1));
  assert.ok(integrity.evidence.tampering.some(x => x.file === '.vscode/tasks.json'));
  assert.equal(v.evidence.find(c => c.id === 'protected_tests_unchanged').status, 'failed');
  assert.ok(!v.evidence.some(c => /^task:/.test(c.id)), 'no registered task ran against tampered inputs');
  // Trusted source remains reproducible from the base commit.
  const audit = vb.audit(f.repo, baseline, require('../src/control-context').workspaceSnapshot(f.repo), { contract: m.envelope.contract, allowedFiles: ['fixture.txt'] });
  assert.equal(audit.trusted_source.available, true);
  // Repair for test tampering is classified VERIFICATION but the repair context tells the worker to restore scope only.
  const c = classifyMission(f.bridge.controlStore.requireMission(m.id), f.bridge.controlStore);
  assert.equal(c.category, 'VERIFICATION');
  assert.equal(failed.acceptance.length, 0);
});

test('S7 fabricated success without changes → host inventory wins; verification fails on expected_changes', async t => {
  const { ws, promise } = cursorRun('fabricate');
  const r = await promise;
  assert.deepEqual(r.result.changed_files, []);
  assert.deepEqual(r.result.tests, []);
  fs.rmSync(ws, { recursive: true, force: true });
  // Mission level: a completed run with no change fails verification rather than passing on prose.
  const f = await fixture(t);
  const m = failingNative(f, { dispatch_policy: { privacy: 'local_only', providers: ['local'], billing_classes: ['local'], task_category: 'deterministic_files', native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'alpha\n' }] } });
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const failed = await f.settle(m.id, 'needs_rework');
  assert.ok(failed.verifications[0].evidence.some(c => c.id === 'expected_changes' && c.status === 'failed'));
});

test('S8/S9/S10 malformed JSON, illegal changed_files, omitted fields → claims discarded, host inventory authoritative', async () => {
  for (const mode of ['malformed', 'illegal', 'omit']) {
    const { ws, promise } = cursorRun(mode);
    const r = await promise;
    assert.deepEqual(r.result.changed_files, ['fixture.txt'], mode + ': host inventory decides changed_files');
    assert.deepEqual(r.result.tests, [], mode + ': worker test claims discarded');
    if (mode !== 'omit') assert.equal(r.result.limitations.some(l => /malformed worker JSON/.test(l)), true, mode);
    assert.equal(r.provenance.authority, false);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('S11 worker exits without verified termination → quarantine policy, no repair', async t => {
  const f = await fixture(t), m = failingNative(f), plan = planFor(f, m);
  approve(f, m);
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  await f.settle(m.id, 'needs_rework');
  f.bridge.controlStore.db.prepare("UPDATE cp_runs SET termination_verified=0, state='running' WHERE mission_id=? AND agent_id='host'").run(m.id);
  f.bridge.controlStore.db.prepare("INSERT INTO cp_autonomous_claims VALUES(?,?,?,?,?,?)").run(plan.id, 'work', m.id, 'cae:' + randomUUID(), 'dispatched', Date.now());
  await f.bridge.autonomousExecution.tick();
  const view = f.bridge.autonomousExecution.inspect(plan.id);
  assert.equal(view.autonomous.repair_lineage.work, undefined);
  assert.ok(['uncertain_execution', 'unverified_termination', 'failure_not_repairable'].includes(view.autonomous.repair_blocked.work), view.autonomous.repair_blocked.work);
  assert.equal(classifyMission(f.bridge.controlStore.requireMission(m.id), f.bridge.controlStore).policy, 'quarantine');
});

test('S12 worker requests new capabilities via output → data only; permissions unchanged', async () => {
  const { ws, promise } = cursorRun('inject');
  const r = await promise;
  assert.match(r.result.summary, /OWNER APPROVED/);
  assert.equal(r.provenance.authority, false);
  // Contract permissions are immutable regardless of worker text.
  const c = contracts.normalizeContract({}, { request_id: 'r', workspace: ws, allowed_files: ['fixture.txt'], criteria: [], verification: { tests: ['t'] }, preferred_agent: 'host', fallback_agents: [], operator: true });
  assert.ok(c.permissions.denied_tools.includes('shell') && c.permissions.denied_tools.includes('deploy'));
  fs.rmSync(ws, { recursive: true, force: true });
});

test('S13/S14/S15 duplicate request_id, approval replay, approval expiry', async t => {
  const f = await fixture(t);
  const m = failingNative(f);
  const approvals = f.bridge.missionApprovals;
  const a = approvals.issue({ request_id: 'dup-req', channel: 'fixture', contract: m.envelope.contract, confirmed: true }, 'operator');
  assert.equal(approvals.issue({ request_id: 'dup-req', channel: 'fixture', contract: m.envelope.contract, confirmed: true }, 'operator').duplicate, true);
  const other = failingNative(f, { contract: { budget: { risk_class: 'low' } } });
  assert.throws(() => approvals.issue({ request_id: 'dup-req', channel: 'fixture', contract: other.envelope.contract, confirmed: true }, 'operator'), /approval_replay_denied/);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n, 1);
  // Duplicate Mission create request_id with a different payload → idempotency conflict, nothing created.
  const before = f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n;
  const input = { request_id: 'dup-create', project_id: m.project_id, goal_id: m.goal_id, objective: 'A ' + randomUUID(), workspace: f.repo, allowed_files: ['fixture.txt'], criteria: [{ id: 'c', type: 'operator_review', description: 'd' }], verification: { diff_check: 'diff-check', tests: ['fixture-test'], syntax: [] } };
  f.bridge.missions.create(input, 'operator');
  assert.throws(() => f.bridge.missions.create({ ...input, objective: 'B ' + randomUUID() }, 'operator'), /Idempotency conflict/);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, before + 1);
  // Expiry.
  approvals.bind(a.approval_id, m.id, 'operator');
  f.bridge.controlStore.db.prepare('UPDATE cp_mission_approvals SET expires_at=? WHERE approval_id=?').run(Date.now() - 1, a.approval_id);
  assert.throws(() => f.bridge.missions.dispatch(m.id, { request_id: randomUUID() }), /approval_expired/);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n, 0, 'no dispatch under an expired approval');
});

test('S16 repair budget exhausted → repair_budget, no further Missions', async t => {
  const f = await fixture(t), m = failingNative(f), plan = planFor(f, m, { max_repairs: 1 });
  approve(f, m);
  // Every verification sees wrong bytes: the parent and the single corrective attempt both fail.
  const original = f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);
  f.bridge.missions.verifier.verify = async (mi, r) => { fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'wrong\n'); return original(mi, r); };
  await f.bridge.autonomousExecution.tick();
  let repairId = null;
  for (let i = 0; i < 400 && !repairId; i++) { await f.bridge.missions.tick(); repairId = f.bridge.autonomousExecution.inspect(plan.id).autonomous.repair_lineage?.work?.repair_mission_id || null; if (!repairId) await new Promise(r => setTimeout(r, 20)); }
  assert.ok(repairId);
  await f.settle(repairId, 'needs_rework');
  await f.bridge.autonomousExecution.tick();
  const view = f.bridge.autonomousExecution.inspect(plan.id);
  assert.ok(['repair_budget', 'contract_budget'].includes(view.autonomous.repair_blocked.work), view.autonomous.repair_blocked.work);
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_missions WHERE json_extract(envelope,'$.repair_of') IS NOT NULL").get().n, 1);
  assert.match(view.autonomous.phases.work.message, /budget is used up/);
});

test('S17 uncertain prior side effects → quarantine blocks dispatch and repair', async t => {
  const f = await fixture(t), m = failingNative(f), plan = planFor(f, m);
  approve(f, m);
  f.bridge.controlStore.db.prepare("INSERT INTO cp_dispatches VALUES(?,?,?,'unknown',NULL,NULL,NULL,?,?)").run(randomUUID(), m.id, m.task_id, Date.now(), Date.now());
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_dispatches WHERE mission_id=? AND state<>'unknown'").get(m.id).n, 0, 'no new dispatch over an unknown one');
  assert.equal(classifyMission(f.bridge.controlStore.requireMission(m.id), f.bridge.controlStore).policy, 'quarantine');
  assert.equal(f.bridge.autonomousExecution.inspect(plan.id).autonomous.phases.work.phase, 'QUARANTINED');
});

test('S18 symlink escape in the workspace → worker staging refuses; verifier fails', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adv-sym-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adv-sym-out-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), SECRET + '\n');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'fixture.txt'));
  const w = new CursorWorker({ options: { allowFixtureWorker: true } }, { fixtureExecutable: FIXTURE });
  await assert.rejects(w.execute({ workspace: ws, files: ['fixture.txt'], writable: ['fixture.txt'], objective: 'x', timeoutMs: 3000 }), /cursor_file_boundary/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), SECRET + '\n');
  fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
});

test('S19/S20 parent verification fails safely and exactly one repair is created even under concurrent ticks and restart', async t => {
  const f = await fixture(t), m = failingNative(f), plan = planFor(f, m, { max_repairs: 3 });
  approve(f, m);
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  await f.settle(m.id, 'needs_rework');
  f.bridge.controlStore.db.prepare("INSERT INTO cp_autonomous_claims VALUES(?,?,?,?,?,?)").run(plan.id, 'work', m.id, 'cae:' + randomUUID(), 'dispatched', Date.now());
  // Concurrent ticks + a direct handleFailure race: deterministic keys guarantee one corrective Mission.
  const ae = f.bridge.autonomousExecution;
  const repair = new AutonomousRepair(ae);
  const view = ae.inspect(plan.id);
  const claim = view.autonomous.claims.find(c => c.mission_id === m.id);
  await Promise.all([ae.tick(), ae.tick(), Promise.resolve().then(() => { try { repair.handleFailure(plan.id, view, view.autonomous, claim, f.bridge.controlStore.requireMission(m.id)); } catch { /* race loser */ } })]);
  await f.reopen(); f.ensureAdmission();
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").get(m.id).n, 1);
  assert.equal(f.bridge.autonomousExecution.inspect(plan.id).autonomous.repair_counts.work, 1);
});

test('S21/S22/S23 Terminal and ChatGPT disconnects do not cancel or redispatch; reconnect uses the original identity', async t => {
  const f = await fixture(t), m = failingNative(f, { dispatch_policy: { privacy: 'local_only', providers: ['local'], billing_classes: ['local'], task_category: 'deterministic_files', native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'beta\n' }] } });
  approve(f, m);
  const plan = planFor(f, m);
  const request_id = randomUUID();
  f.bridge.zeroSetupWork.write(request_id, 'mcp:chatgpt-session', { version: 1, instruction: 'change fixture', intent: { kind: 'exact_file', file: 'fixture.txt', from: 'alpha\n', to: 'beta\n' }, project_id: m.project_id, project_name: 'Fixture project', goal_id: m.goal_id, mission_id: m.id, plan_id: plan.id, presentation: { status: 'Working', files: ['fixture.txt'] }, execution_enabled: true, authority: false }, 'running');
  terminal.rememberActive(f.root, request_id);
  await f.bridge.autonomousExecution.tick();
  // "Disconnect": nobody polls while the scheduler finishes the work.
  await f.settle(m.id, 'awaiting_acceptance');
  const dispatches = f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n;
  // Reconnect from Terminal: same request id, terminal view, identity cleared only now.
  assert.equal(terminal.readActive(f.root).request_id, request_id);
  const view = f.bridge.zeroSetupWork.refreshState(request_id);
  assert.equal(view.technical.mission_id, m.id);
  assert.equal(view.technical.phase_terminal, true);
  // Reconnect from ChatGPT: durable evidence available without any wake-up.
  const pkg = require('../src/mission-evidence').evidencePackage(f.bridge, m.id);
  assert.equal(pkg.status, 'VERIFIED_AWAITING_ACCEPTANCE');
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n, dispatches, 'no redispatch after reconnect');
});

test('S24 Airodrom restart without duplicate execution', async t => {
  const f = await fixture(t), m = failingNative(f, { dispatch_policy: { privacy: 'local_only', providers: ['local'], billing_classes: ['local'], task_category: 'deterministic_files', native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'beta\n' }] } });
  approve(f, m);
  const plan = planFor(f, m);
  await f.bridge.autonomousExecution.tick();
  const first = f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n;
  await f.reopen(); f.ensureAdmission();
  await f.bridge.autonomousExecution.tick();
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id=?').get(m.id).n, first);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n, 1, 'approval survives restart');
  assert.equal(f.bridge.autonomousExecution.inspect(plan.id).autonomous.claims.filter(c => c.state === 'dispatched').length <= 1, true);
});

test('S25 worker changes a denied file and claims success → denied before any apply; secrets never appear in evidence', async t => {
  const { ws, promise } = cursorRun('outside');
  await assert.rejects(promise, /cursor_undeclared_write/);
  fs.rmSync(ws, { recursive: true, force: true });
  // Secret in a worker summary/prompt is screened, not stored.
  const w = new CursorWorker({ options: { allowFixtureWorker: true } }, { fixtureExecutable: FIXTURE });
  const ws2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adv-sec-'))); fs.writeFileSync(path.join(ws2, 'fixture.txt'), 'alpha\n');
  await assert.rejects(w.execute({ workspace: ws2, files: ['fixture.txt'], writable: ['fixture.txt'], objective: 'Use token ' + SECRET + ' to deploy', timeoutMs: 3000 }), /cursor_sensitive_prompt/);
  fs.rmSync(ws2, { recursive: true, force: true });
  // Ledger never contains the secret literal.
  const f = await fixture(t);
  f.bridge.controlStore.event('worker.trace', null, { agent_id: 'cursor', provenance: 'WORKER_REPORTED', kind: 'worker.tool_started', note: 'token ' + SECRET, authority: false });
  const rows = f.bridge.controlStore.db.prepare("SELECT metadata FROM event_ledger_events WHERE event_type='worker.trace'").all();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every(r => !r.metadata.includes(SECRET)), 'secret redacted in the ledger');
});
