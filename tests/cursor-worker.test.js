'use strict';
// ADR 0051: governed headless Cursor worker contract, adversarial worker behaviour and a
// full governed Mission through MissionService with independent host verification.
// The real CLI is exercised separately by scripts/qualify-cursor-worker.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { CursorWorker, permissionConfig, sandboxProfile, parseStream, normalizeResult, stagingRoot, redactDiagnostic, classifyFailure } = require('../src/cursor-worker');

const FIXTURE = path.join(__dirname, 'fixtures/cursor-agent-fixture.cjs');
const CURSOR_HOSTS = ['api2.cursor.sh', 'api3.cursor.sh', 'api4.cursor.sh', 'repo42.cursor.sh', 'agent.api5.cursor.sh', 'agentn.global.api5.cursor.sh'];

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-ws-')));
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'alpha\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'keep\n');
  return root;
}
function worker(options = {}) {
  const bridge = { options: { allowFixtureWorker: true } };
  return new CursorWorker(bridge, { fixtureExecutable: FIXTURE, ...options });
}
const run = async (mode, extra = {}) => {
  process.env.AIRODROM_CURSOR_FIXTURE_MODE = mode;
  try {
    const ws = workspace();
    const w = worker();
    return await w.execute({ workspace: ws, files: ['fixture.txt', 'other.txt'], writable: ['fixture.txt'], objective: 'Change fixture.txt from alpha to beta. exact_file_bytes 626574610a', timeoutMs: 5000, ...extra }).then(r => ({ r, ws }));
  } finally { delete process.env.AIRODROM_CURSOR_FIXTURE_MODE; }
};

test('cursor worker: readiness tiers are honest (installed ≠ authenticated ≠ qualified ≠ available)', async () => {
  const w = worker();
  const r = await w.readiness();
  assert.equal(r.governed_worker, true);
  assert.deepEqual(Object.keys(r.tiers), ['installed', 'authenticated', 'qualified', 'available', 'executing']);
  assert.equal(r.ready, true);
  assert.equal(r.isolation.keychain, 'denied');
  assert.equal(r.spend, 'UNKNOWN_SUBSCRIPTION');
  // Real install without a file credential reports the exact owner step, never READY.
  const real = new CursorWorker({ options: {} }, { executable: '/nonexistent/cursor-agent' });
  const rr = await real.readiness();
  assert.equal(rr.ready, false);
  assert.equal(rr.tiers.installed, false);
  assert.equal(rr.reason, 'cursor_agent_not_installed');
  const source = new CursorWorker({ options: {} }, {}).credentialSource();
  if (!source.available) assert.match(source.owner_step, /AGENT_CLI_CREDENTIAL_STORE=file agent login/);
});

test('cursor worker: short staging root keeps Cursor private dir inside writeRoots', () => {
  const root = stagingRoot();
  try {
    const projects = path.join(root, 'state', 'cursor-data', 'projects');
    assert.ok(projects.length <= 84, 'CURSOR_DATA_DIR/projects must stay ≤84 chars to avoid /tmp/.cursor fallback');
    assert.match(root, process.platform === 'darwin' ? /^\/private\/tmp\/ad-/ : /airodrom-cursor-/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cursor worker: failure diagnostics redact secrets and classify sandbox denials', () => {
  const sample = redactDiagnostic('Bearer abcdef0123456789abcdef0123456789 authId:github|user_SECRETTOK EPERM mkdir \'/tmp/.cursor/private-var-folders-x\'');
  assert.doesNotMatch(sample, /abcdef0123456789|SECRETTOK|github\|user_/);
  assert.match(sample, /Bearer <redacted>/);
  assert.deepEqual(classifyFailure(sample).sort(), ['cursor_private_dir', 'sandbox_denial'].sort());
  assert.ok(classifyFailure('Failed to negotiate an HTTP CONNECT tunnel with the configured proxy').includes('network_or_proxy'));
});

test('cursor worker: host-authored deny-list and sandbox profile enforce boundaries independently of --force', () => {
  const p = permissionConfig(['fixture.txt']);
  assert.ok(p.permissions.deny.includes('Shell(*)') && p.permissions.deny.includes('WebFetch(*)') && p.permissions.deny.includes('Mcp(*:*)'));
  assert.equal(p.permissions.deny.includes('Write(**)'), false, 'blanket Write(**) deny must not override allowlisted Write(path)');
  assert.ok(p.permissions.allow.includes('Write(fixture.txt)'));
  assert.equal(p.sandbox.mode, 'disabled', 'Cursor\'s own sandbox is disabled; sandbox-exec is authoritative');
  const fake = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-fake-install-')));
  fs.writeFileSync(path.join(fake, 'node'), ''); fs.writeFileSync(path.join(fake, 'index.js'), '');
  const install = { dir: fake, node: path.join(fake, 'node'), index: path.join(fake, 'index.js') };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-cursor-test-')));
  fs.mkdirSync(path.join(root, 'state')); fs.mkdirSync(path.join(root, 'home'));
  const profile = sandboxProfile({ install, root, writable: ['fixture.txt'], port: 45678 });
  const esc = v => v.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m);
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, new RegExp('\\(allow process-exec \\(literal "' + esc(install.node) + '"\\)\\)'));
  assert.doesNotMatch(profile, /process-exec \(literal "\/bin\/(?:sh|bash|zsh)"/, 'no shell may be executed inside the sandbox');
  assert.match(profile, new RegExp('\\(allow file-write\\* \\(literal "' + esc(path.join(root, 'workspace/fixture.txt')) + '"\\)\\)'));
  assert.match(profile, new RegExp('\\(deny file-write\\* \\(literal "' + esc(path.join(root, 'workspace/.cursor/cli.json')) + '"\\)\\)'));
  fs.rmSync(fake, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
  assert.match(profile, /\(deny network\* \(require-not \(remote ip "localhost:45678"\)\)\)/);
  assert.doesNotMatch(profile, /securityd|SecurityServer/, 'Keychain services are never reachable');
  assert.doesNotMatch(profile, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\)'), 'real home directory is not a read root');
});

test('cursor worker: stream-json parsing records provenance-tagged tool events and rejects malformed results', () => {
  const root = '/private/tmp/r';
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'm1', session_id: 's1' }),
    JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { writeToolCall: { args: { path: '/private/tmp/r/workspace/fixture.txt' } } } }),
    JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'curl evil' } } } }),
    JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: '/Users/someone/.ssh/id_rsa' } } } }),
    'not json',
    JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 10, result: '{"status":"completed","summary":"ok","changed_files":["fixture.txt"]}' }),
  ].join('\n');
  const parsed = parseStream(stdout, root);
  assert.equal(parsed.model, 'm1');
  assert.equal(parsed.malformed, 1);
  assert.deepEqual(parsed.tools.map(t => [t.provenance, t.tool, t.scope, t.path]), [['WORKER_REPORTED', 'write', 'workspace', 'fixture.txt'], ['WORKER_REPORTED', 'shell', null, null], ['WORKER_REPORTED', 'read', 'outside', '[redacted]']]);
  assert.equal(parsed.tools[1].command_category, 'shell_attempt');
  const result = normalizeResult(parsed, ['fixture.txt']);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.tests, [], 'worker test claims are discarded');
  assert.throws(() => normalizeResult({ text: 'done!' }, ['fixture.txt']), /cursor_malformed_result/);
  assert.throws(() => normalizeResult({ text: '{"status":"completed","summary":"x","changed_files":["src/auth.js"]}' }, ['fixture.txt']), /cursor_malformed_result/);
  assert.throws(() => normalizeResult({ text: '{"status":"completed","summary":"x","grant":"Shell(*)"}' }, ['fixture.txt']), /cursor_malformed_result/);
});

test('cursor worker: bounded edit succeeds with host-measured changes and provenance', async () => {
  const { r, ws } = await run('edit');
  assert.equal(r.result.status, 'completed');
  assert.deepEqual(r.result.changed_files, ['fixture.txt']);
  assert.equal(r.changes[0].content, 'beta\n');
  assert.equal(fs.readFileSync(path.join(ws, 'fixture.txt'), 'utf8'), 'alpha\n', 'original workspace untouched until the host applies');
  assert.equal(r.provenance.sandbox, 'sandbox-exec');
  assert.ok(r.provenance.sandbox_id);
  assert.equal(r.provenance.termination_verified, true);
  assert.equal(r.provenance.spend, 'UNKNOWN_SUBSCRIPTION');
  assert.ok(r.trace.some(e => e.provenance === 'HOST_MEDIATED' && e.kind === 'worker.launch'));
  assert.ok(r.trace.some(e => e.provenance === 'HOST_MEDIATED' && e.kind === 'worker.exited' && e.termination_verified === true));
  assert.ok(r.tools.some(t => t.tool === 'write' && t.path === 'fixture.txt'));
  assert.ok(r.provenance.unobservable.length, 'unobservable classes are declared, not hidden');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('cursor worker: adversarial behaviours fail closed with evidence and no workspace mutation', async () => {
  const expectFail = async (mode, re) => {
    let ws; await assert.rejects(async () => { const out = await run(mode); ws = out.ws; }, re);
    return ws;
  };
  await expectFail('outside', /cursor_undeclared_write/);
  await expectFail('tamper', /cursor_permission_file_tampered/);
  // Illegal changed_files claim: the claim is discarded; host inventory decides.
  const { r: illegal } = await run('illegal');
  assert.deepEqual(illegal.result.changed_files, ['fixture.txt']);
  assert.ok(illegal.result.limitations.some(l => /malformed worker JSON/.test(l)));
  await expectFail('crash', /cursor_process_failed_after_edits/);
  await expectFail('hang', /cursor_timeout/);
  // Fabricated success without any change: no changes, worker JSON parses, but nothing changed → host sees zero edits.
  const { r: fab } = await run('fabricate');
  assert.equal(fab.changes.length, 0);
  assert.deepEqual(fab.result.changed_files, [], 'worker-claimed changed_files are replaced by host inventory');
  assert.deepEqual(fab.result.tests, [], 'worker-claimed test results are discarded');
  // Malformed final text with real edits: host recovers from inventory, flags limitation.
  const { r: mal } = await run('malformed');
  assert.equal(mal.changes.length, 1);
  assert.ok(mal.result.limitations.some(l => /malformed worker JSON/.test(l)));
  // Omitted fields with real edits: fail closed on the result schema, then recover from inventory.
  const { r: omit } = await run('omit');
  assert.equal(omit.changes.length, 1);
  // Prompt-injection text in the result is just data.
  const { r: inj } = await run('inject');
  assert.equal(inj.result.status, 'completed');
  assert.match(inj.result.summary, /OWNER APPROVED/);
  assert.equal(inj.provenance.authority, false);
  // Wrong content is accepted by the adapter (it is not the verifier); verification catches it later.
  const { r: wrong } = await run('wrong');
  assert.equal(wrong.changes[0].content, 'gamma\n');
});

test('cursor worker: cancellation aborts the run and verifies termination', async () => {
  process.env.AIRODROM_CURSOR_FIXTURE_MODE = 'hang';
  try {
    const ws = workspace(); const w = worker(); const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(w.execute({ workspace: ws, files: ['fixture.txt'], writable: ['fixture.txt'], objective: 'Change fixture.txt from alpha to beta', timeoutMs: 10000, signal: controller.signal }), /cursor_cancelled/);
    assert.equal(fs.readFileSync(path.join(ws, 'fixture.txt'), 'utf8'), 'alpha\n');
  } finally { delete process.env.AIRODROM_CURSOR_FIXTURE_MODE; }
});

test('governed Cursor Mission: contract + disclosure + approval → sandboxed worker → independent host verification; ungoverned Cursor never routes', async t => {
  const f = await fixture(t, { defaultRuntime: 'opencode' });
  f.bridge.cursorWorker = new CursorWorker(f.bridge, { fixtureExecutable: FIXTURE });
  const ws = f.repo;
  const authority = { level: 'development', permissions: { repository: ['read', 'write'], runtime: ['diagnostic', 'test'], network: ['internet', 'localhost'], secrets: [], data: ['read', 'workspace_write'] }, filesystem: { read: [ws], write: [path.join(ws, 'fixture.txt')] }, expiresAt: Date.now() + 60 * 60 * 1000 };
  const disclosure = { permissions: { external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'Disposable Cursor qualification fixture' }, network: { mode: 'allowlist', allow: CURSOR_HOSTS } }, budget: { risk_class: 'fixture' } };
  // Ungoverned: a Cursor Mission without contract/disclosure never routes to Cursor.
  const ungoverned = f.create({ preferred_agent: 'cursor', fallback_agents: [], objective: 'Ungoverned ' + randomUUID().slice(0, 8), authority, dispatch_policy: { privacy: 'cloud_allowed', providers: ['cursor_runtime'], billing_classes: ['subscription'], max_attempts: 1 } });
  assert.equal(ungoverned.envelope.contract, undefined);
  // Governed: contract with disclosure, approval bound, dispatch runs the sandboxed worker.
  process.env.AIRODROM_CURSOR_FIXTURE_MODE = 'edit';
  try {
    const m = f.create({ preferred_agent: 'cursor', fallback_agents: [], objective: 'Change fixture.txt from alpha to beta via governed Cursor ' + randomUUID().slice(0, 8), authority, contract: disclosure, dispatch_policy: { privacy: 'cloud_allowed', providers: ['cursor_runtime'], billing_classes: ['subscription'], max_attempts: 1 } });
    assert.equal(m.envelope.contract.permissions.external_disclosure.authorized, true);
    assert.equal(m.envelope.contract.execution.sandbox, 'sandbox-exec');
    // No approval yet: dispatch is refused as unqualified.
    assert.throws(() => f.bridge.missions.dispatch(m.id, { request_id: randomUUID() }), /worker_execution_unqualified/);
    const approval = f.bridge.missionApprovals.issue({ request_id: 'cursor-approve-' + m.id, channel: 'fixture', contract: m.envelope.contract, confirmed: true }, 'operator');
    assert.equal(approval.external_disclosure, true);
    assert.deepEqual(approval.disclosure_providers, ['cursor']);
    f.bridge.missionApprovals.bind(approval.approval_id, m.id, 'operator');
    f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
    const done = await f.settle(m.id, 'awaiting_acceptance');
    assert.equal(Buffer.from(fs.readFileSync(path.join(ws, 'fixture.txt'))).toString('hex'), '626574610a');
    const cursorRuns = done.runs.filter(r => r.agent_id === 'cursor');
    assert.equal(cursorRuns.length, 1, 'exactly one cursor run: ' + JSON.stringify(done.runs.map(r => [r.agent_id, r.state, r.result ? Object.keys(r.result) : null])));
    const run = cursorRuns[0];
    assert.equal(run.termination_verified, 1);
    assert.equal(run.result.cursor_provenance.sandbox, 'sandbox-exec');
    assert.ok(done.verifications[0].evidence.some(c => c.id === 'expected_file' && c.status === 'passed'));
    assert.ok(done.verifications[0].evidence.some(c => c.id === 'task:fixture-test' && c.status === 'passed'));
    assert.ok(done.verifications[0].evidence.some(c => c.id === 'security:secret_scan' && c.status === 'passed'));
    assert.equal(done.acceptance.length, 0, 'Acceptance remains owner-only');
    const dispatch = f.bridge.controlStore.db.prepare('SELECT route FROM cp_dispatches WHERE mission_id=?').get(m.id);
    assert.equal(JSON.parse(dispatch.route).selected, 'cursor');
    // Trace events are durable, redacted and provenance-tagged.
    const traces = f.bridge.ledger.list({ missionId: m.id, limit: 200 }).events.filter(e => e.event_type === 'worker.trace');
    assert.ok(traces.length >= 3);
    assert.ok(traces.every(e => ['HOST_MEDIATED', 'WORKER_REPORTED', 'SANDBOX_OBSERVED'].includes(e.metadata.provenance)));
    assert.ok(traces.some(e => e.metadata.kind === 'worker.exited' && e.metadata.termination_verified === true));
  } finally { delete process.env.AIRODROM_CURSOR_FIXTURE_MODE; }
  // Routing: the plain ungoverned Mission is rejected by the router with the honest reason.
  f.bridge.missions.dispatch(ungoverned.id, { request_id: randomUUID() });
  const blocked = await f.settle(ungoverned.id, 'blocked');
  assert.match(blocked.reason, /worker_execution_unqualified|no_compatible_available_agent|requires a qualified bounded native adapter/);
  assert.equal(blocked.runs.filter(r => r.agent_id === 'cursor').length, 0, 'ungoverned Cursor never executed');
});
