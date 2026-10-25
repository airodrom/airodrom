'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { completeHistoricalNative } = require('./fixtures/historical-native-fixture.cjs');
const { securityScan } = require('../src/verifier-baseline');

function manifest(repo, files) {
  return { mission: { id: 'host-coding-v1', version: 1, title: 'Host coding coverage', repository: { root: repo, branch: execFileSync('/usr/bin/git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim() }, authority: { level: 'Development' }, duration: { expires_after: '1h' }, scope: { repositories: [repo], include: files, exclude: [] }, permissions: { filesystem: { read: true, write: true, delete: false }, repository: { branch: false, commit: false, push: false, merge: false }, runtime: { test: true, lint: false, typecheck: true, restart_local: false }, network: { localhost: true, internet: false }, providers: { local_reasoning: false, approved_external: false }, memory: { read: true, search: false, write: false, delete: false } }, evidence: { required: ['tests', 'diff_check'], optional: [] }, settlement: { review_required: true, merge_allowed: false, deploy_allowed: false }, budget: { max_files_changed: files.length, max_commits: 0, max_runtime_hours: 1, max_external_reasoning_calls: 0, max_memory_injections: 0 } } };
}
function plan(repo, files) {
  const { digest } = require('../src/qualified-coding-adapter');
  return { version: 1, operations: Object.entries(files).map(([file, content]) => ({ name: 'file_write', path: file, content, preimage_sha256: digest(path.join(repo, file)) })) };
}
function compiler() {
  const root = path.resolve(__dirname, '..');
  const declared = require(path.join(root, 'package.json')).devDependencies.typescript;
  const locked = require(path.join(root, 'package-lock.json')).packages['node_modules/typescript'].version;
  if (declared !== locked) throw new Error('TypeScript package and lockfile disagree');
  const installed = require(require.resolve('typescript/package.json', { paths: [root] }));
  if (installed.version !== locked) throw new Error('Installed TypeScript ' + installed.version + ' is not the lockfile-controlled ' + locked);
  const entry = path.join(path.dirname(require.resolve('typescript/package.json', { paths: [root] })), installed.bin.tsc);
  if (!fs.existsSync(entry)) throw new Error('Real TypeScript compiler is required; a stub is not used');
  return { entry, version: installed.version };
}
function commit(repo) {
  execFileSync('/usr/bin/git', ['-C', repo, 'add', '-A']);
  const pending = execFileSync('/usr/bin/git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  if (!pending.trim()) return;
  execFileSync('/usr/bin/git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'host coding fixture'], { encoding: 'utf8' });
}

test('a historical host coding completion retains independent coverage and pending Acceptance', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.repo, 'sample.ts'), 'export const ready: number = 1; \n');
  commit(f.repo);
  const files = { 'fixture.txt': 'beta\n', 'sample.ts': 'export const ready: number = 1;\n' };
  const created = f.create({ objective: 'Derive host coverage and correct two files.', contract: null, allowed_files: Object.keys(files), criteria: [{ id: 'fixture', type: 'exact_file', path: 'fixture.txt', content: files['fixture.txt'] }, { id: 'sample', type: 'exact_file', path: 'sample.ts', content: files['sample.ts'] }, { id: 'owner-review', type: 'operator_review', description: 'Owner Acceptance remains pending.' }], verification: { diff_check: 'diff-check', tests: ['fixture-test'], syntax: [] }, manifest: manifest(f.repo, Object.keys(files)), coding_plan: plan(f.repo, files) });
  assert.equal(created.envelope.contract.execution.preferred_worker, 'host');
  assert.equal(created.envelope.contract.execution.mode, 'native_plan');
  assert.equal(created.envelope.contract.permissions.external_disclosure.authorized, false);
  assert.equal(created.envelope.contract.budget.max_repair_attempts, 0);
  assert.deepEqual(created.envelope.contract.verification.required_security_checks, ['protected_tests_unchanged', 'secret_scan', 'verifier_inputs_unchanged']);
  assert.equal(created.envelope.contract.audit.verifier_baseline.base_commit_sha, execFileSync('/usr/bin/git', ['-C', f.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.equal(fs.readFileSync(path.join(f.repo, 'sample.ts'), 'utf8').endsWith(' \n'), true);
  await completeHistoricalNative(f, created);
  const done = await f.settle(created.id);
  assert.equal(done.state, 'awaiting_acceptance');
  assert.equal(done.reason, 'Verification operator_review');
  assert.equal(done.acceptance.length, 0);
  assert.equal(done.verifications[0].result, 'operator_review');
  const evidence = done.verifications[0].evidence;
  for (const id of ['contract_integrity', 'verifier_inputs_unchanged', 'protected_tests_unchanged', 'security:secret_scan', 'task:diff-check', 'task:fixture-test', 'fixture', 'sample']) {
    assert.equal(evidence.find(check => check.id === id).status, 'passed', id);
  }
  assert.equal(evidence.find(check => check.id === 'owner-review').status, 'operator_review');
  assert.equal(evidence.find(check => check.id === 'security:sensitive_area').status, 'passed');
  assert.equal(fs.readFileSync(path.join(f.repo, 'sample.ts'), 'utf8'), files['sample.ts']);
  // Supplementary evidence after settlement. This is not a registered task: receipt.
  const tsc = compiler();
  assert.equal(execFileSync(process.execPath, [tsc.entry, '--strict', '--noEmit', 'sample.ts'], { cwd: f.repo, encoding: 'utf8' }), '');
  fs.writeFileSync(path.join(f.repo, 'invalid.ts'), 'export const bad: number = "no";\n');
  let rejected = false;
  try { execFileSync(process.execPath, [tsc.entry, '--strict', '--noEmit', 'invalid.ts'], { cwd: f.repo, encoding: 'utf8' }); }
  catch (error) { rejected = true; assert.notEqual(error.status, 0); assert.match(String(error.stdout || error.stderr), /error TS/); }
  assert.equal(rejected, true);
  assert.equal(done.verifications[0].evidence.some(check => check.id === 'task:static-typecheck'), false);
  assert.equal(f.bridge.memory.db.prepare("SELECT COUNT(*) c FROM cp_leases WHERE mission_id=? AND state!='released'").get(created.id).c, 0);
  assert.equal(f.inference(), 0);
  assert.equal(done.runs.filter(run => run.agent_id === 'opencode').length, 0);
});

test('callers cannot suppress, widen, or reuse a contractless host coding Mission as covered', async t => {
  const f = await fixture(t);
  const good = { allowed_files: ['fixture.txt'], criteria: [{ id: 'file-0', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }], manifest: manifest(f.repo, ['fixture.txt']), coding_plan: plan(f.repo, { 'fixture.txt': 'beta\n' }) };
  const suppressed = f.create({ ...good, objective: 'Suppress attempt', contract: { verification: { required_security_checks: [] }, budget: { max_repair_attempts: 3 }, permissions: { external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'widen' } } } });
  assert.equal(suppressed.envelope.contract.permissions.external_disclosure.authorized, false);
  assert.equal(suppressed.envelope.contract.budget.max_repair_attempts, 0);
  assert.ok(suppressed.envelope.contract.verification.required_security_checks.includes('secret_scan'));
  assert.throws(() => f.create({ ...good, objective: 'Malformed contract', contract: 'suppress' }), /Invalid contract/);
  assert.throws(() => f.create({ ...good, objective: 'Wrong preimage', coding_plan: { version: 1, operations: [{ ...good.coding_plan.operations[0], preimage_sha256: 'a'.repeat(64) }] } }), /preimage/);
  assert.throws(() => f.create({ ...good, objective: 'Outside manifest', manifest: manifest(f.repo, ['outside.txt']) }), /manifest scope|boundary|owned files/);
  const legacy = f.create({ ...good, objective: 'Legacy contractless' });
  const stored = JSON.parse(f.bridge.memory.db.prepare('SELECT envelope FROM cp_missions WHERE id=?').get(legacy.id).envelope);
  delete stored.contract;
  f.bridge.memory.db.prepare('UPDATE cp_missions SET envelope=? WHERE id=?').run(JSON.stringify(stored), legacy.id);
  assert.throws(() => f.bridge.missions.dispatch(legacy.id, { request_id: 'legacy' }), /CURSOR_IMPLEMENTATION_REQUIRED/);
  assert.throws(() => f.bridge.missions.codingAdapter.assert(f.bridge.controlStore.requireMission(legacy.id)), /host_coding_contract_required/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
  const expired = f.create({ ...good, objective: 'Expired contract' });
  const expiring = JSON.parse(f.bridge.memory.db.prepare('SELECT envelope FROM cp_missions WHERE id=?').get(expired.id).envelope);
  expiring.contract.identity.expires_at = 1;
  f.bridge.memory.db.prepare('UPDATE cp_missions SET envelope=? WHERE id=?').run(JSON.stringify(expiring), expired.id);
  assert.throws(() => f.bridge.missions.codingAdapter.assert(f.bridge.controlStore.requireMission(expired.id)), /contract_expired/);
});

test('new secrets, sensitive paths, unreadable scans, and tampering fail closed without Acceptance', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.repo, 'auth.txt'), 'alpha\n');
  fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'beta\n');
  commit(f.repo);
  const planted = 'ghp_' + 'a'.repeat(36) + '\n';
  assert.throws(() => f.create({ objective: 'Secret exact content', allowed_files: ['fixture.txt'], criteria: [{ id: 'file-0', type: 'exact_file', path: 'fixture.txt', content: planted }], verification: { diff_check: 'diff-check', tests: ['fixture-test'], syntax: [] }, manifest: manifest(f.repo, ['fixture.txt']), coding_plan: plan(f.repo, { 'fixture.txt': planted }) }), /sensitive/);
  fs.writeFileSync(path.join(f.repo, 'fixture.txt'), planted);
  const head = execFileSync('/usr/bin/git', ['-C', f.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const introduced = securityScan(f.repo, ['fixture.txt'], { contract: { verification: { required_security_checks: ['secret_scan'] } }, baselineRecord: { base_commit_sha: head, files: [] } });
  assert.equal(introduced.find(check => check.id === 'security:secret_scan').status, 'failed');
  assert.equal(introduced.find(check => check.id === 'security:secret_scan').evidence.new_findings > 0, true);
  fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'beta\n');
  const sensitive = f.create({ objective: 'Sensitive path review', allowed_files: ['auth.txt'], criteria: [{ id: 'auth', type: 'exact_file', path: 'auth.txt', content: 'reviewed\n' }], verification: { diff_check: 'diff-check', tests: ['fixture-test'], syntax: [] }, manifest: manifest(f.repo, ['auth.txt']), coding_plan: plan(f.repo, { 'auth.txt': 'reviewed\n' }) });
  await completeHistoricalNative(f, sensitive);
  const sensitiveDone = await f.settle(sensitive.id);
  assert.equal(sensitiveDone.verifications[0].result, 'operator_review');
  assert.equal(sensitiveDone.verifications[0].evidence.find(check => check.id === 'security:sensitive_area').status, 'operator_review');
  assert.equal(sensitiveDone.acceptance.length, 0);
  commit(f.repo);
  const later = execFileSync('/usr/bin/git', ['-C', f.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const missing = securityScan(f.repo, ['missing.ts'], { contract: { verification: { required_security_checks: ['secret_scan'] } }, baselineRecord: { base_commit_sha: later, files: [] } });
  assert.equal(missing.find(check => check.id === 'security:secret_scan').status, 'unavailable');
  assert.equal(missing.find(check => check.id === 'security:sensitive_area').status, 'unavailable');
  const tamper = f.create({ objective: 'Tampered contract', allowed_files: ['fixture.txt'], criteria: [{ id: 'file-0', type: 'exact_file', path: 'fixture.txt', content: 'gamma\n' }], manifest: manifest(f.repo, ['fixture.txt']), coding_plan: plan(f.repo, { 'fixture.txt': 'gamma\n' }) });
  const envelope = JSON.parse(f.bridge.memory.db.prepare('SELECT envelope FROM cp_missions WHERE id=?').get(tamper.id).envelope);
  envelope.contract.permissions.allowed_write_paths.push('package.json');
  f.bridge.memory.db.prepare('UPDATE cp_missions SET envelope=? WHERE id=?').run(JSON.stringify(envelope), tamper.id);
  assert.throws(() => f.bridge.missions.dispatch(tamper.id, { request_id: 'tamper' }), /CURSOR_IMPLEMENTATION_REQUIRED|altered|qualification|Immutable coding/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'beta\n');
  const weakened = f.create({ objective: 'Weakened verifier input', allowed_files: ['fixture.txt'], criteria: [{ id: 'file-0', type: 'exact_file', path: 'fixture.txt', content: 'gamma\n' }], manifest: manifest(f.repo, ['fixture.txt']), coding_plan: plan(f.repo, { 'fixture.txt': 'gamma\n' }) });
  const verify = f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);
  f.bridge.missions.verifier.verify = async (mission, run) => {
    fs.writeFileSync(path.join(f.repo, 'tests/fixture.test.cjs'), 'assert.fail();\n');
    return verify(mission, run);
  };
  await completeHistoricalNative(f, weakened);
  const weakenedDone = await f.settle(weakened.id, 'needs_rework');
  assert.equal(weakenedDone.verifications[0].evidence.find(check => check.id === 'protected_tests_unchanged').status, 'failed');
  assert.equal(weakenedDone.verifications[0].evidence.find(check => check.id === 'security:secret_scan').status, 'unavailable');
  assert.equal(weakenedDone.acceptance.length, 0);
});

test('verification rejects a tampered or missing contract and an expired manifest before a registered command', async t => {
  const f = await fixture(t);
  let verifierCommands = 0;
  const run = f.host.exec.run.bind(f.host.exec);
  f.host.exec.run = (file, args, options) => {
    if (args && (args.includes('--check') || args.includes('--test'))) verifierCommands += 1;
    return run(file, args, options);
  };
  const request = objective => ({ objective, allowed_files: ['fixture.txt'], criteria: [{ id: 'file-0', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }], manifest: manifest(f.repo, ['fixture.txt']), coding_plan: plan(f.repo, { 'fixture.txt': 'beta\n' }) });
  const reset = () => { fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'alpha\n'); commit(f.repo); };
  const altered = f.create(request('Verification contract mismatch'));
  const verify = f.bridge.missions.verifier.verify.bind(f.bridge.missions.verifier);
  f.bridge.missions.verifier.verify = async (mission, runRecord) => {
    if (mission.id === altered.id) mission.envelope.contract.permissions.allowed_write_paths.push('package.json');
    return verify(mission, runRecord);
  };
  await completeHistoricalNative(f, altered);
  const alteredDone = await f.settle(altered.id, 'needs_rework');
  assert.equal(alteredDone.verifications[0].evidence.find(check => check.id === 'contract_integrity').status, 'failed');
  assert.match(alteredDone.verifications[0].evidence.find(check => check.id === 'contract_integrity').evidence.reason, /altered/);
  assert.equal(alteredDone.verifications[0].evidence.find(check => check.id === 'security:secret_scan').status, 'unavailable');
  assert.equal(alteredDone.acceptance.length, 0);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'beta\n');
  reset();
  const legacy = f.create(request('Verification legacy contract'));
  f.bridge.missions.verifier.verify = async (mission, runRecord) => {
    if (mission.id === legacy.id) delete mission.envelope.contract;
    return verify(mission, runRecord);
  };
  await completeHistoricalNative(f, legacy);
  const legacyDone = await f.settle(legacy.id, 'needs_rework');
  assert.equal(legacyDone.verifications[0].evidence.find(check => check.id === 'contract_integrity').evidence.reason, 'host_coding_contract_required');
  assert.equal(legacyDone.verifications[0].evidence.find(check => check.id === 'security:secret_scan').status, 'unavailable');
  assert.equal(legacyDone.verifications[0].evidence.some(check => String(check.id).startsWith('task:')), false);
  reset();
  const unreadable = f.create(request('Unreadable trusted baseline'));
  f.bridge.missions.verifier.verify = verify;
  const blobName = execFileSync('/usr/bin/git', ['-C', f.repo, 'rev-parse', 'HEAD:tests/fixture.test.cjs'], { encoding: 'utf8' }).trim();
  const blob = path.join(f.repo, '.git/objects', blobName.slice(0, 2), blobName.slice(2));
  fs.chmodSync(blob, 0);
  let unreadableDone;
  try {
    await completeHistoricalNative(f, unreadable);
    unreadableDone = await f.settle(unreadable.id, 'needs_rework');
  } finally { fs.chmodSync(blob, 0o644); }
  assert.equal(unreadableDone.verifications[0].evidence.find(check => check.id === 'verifier_inputs_unchanged').status, 'unavailable');
  assert.equal(unreadableDone.verifications[0].evidence.find(check => check.id === 'verifier_inputs_unchanged').evidence.trusted_source.available, false);
  assert.equal(unreadableDone.verifications[0].evidence.find(check => check.id === 'security:secret_scan').status, 'unavailable');
  assert.notEqual(unreadableDone.verifications[0].result, 'passed');
  assert.equal(unreadableDone.acceptance.length, 0);
  reset();
  const expiring = f.create(request('Verification manifest expiry'));
  const invoke = f.bridge.invokeCapability.bind(f.bridge);
  f.bridge.invokeCapability = (id, request) => {
    if (request.name === 'vscode_run_task') f.bridge.controlStore.now = () => Date.now() + 48 * 60 * 60 * 1000;
    return invoke(id, request);
  };
  const before = verifierCommands;
  await completeHistoricalNative(f, expiring);
  const expiredDone = await f.settle(expiring.id, 'needs_rework');
  assert.equal(verifierCommands, before);
  assert.match(expiredDone.verifications[0].evidence.find(check => check.id === 'verification_available').evidence.reason, /Mission Manifest runtime budget expired/);
  assert.equal(expiredDone.verifications[0].evidence.some(check => String(check.id).startsWith('task:')), false);
  assert.equal(expiredDone.acceptance.length, 0);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'beta\n');
  const persisted = f.bridge.memory.db.prepare('SELECT result FROM cp_verifications WHERE mission_id=?').get(expiring.id);
  assert.equal(persisted.result, 'unavailable');
});
