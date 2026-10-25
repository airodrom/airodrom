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

test('direct legacy Cursor Mission cannot bypass sealed OpenCode planning, even with owner approval', async t => {
  const f = await fixture(t, { defaultRuntime: 'opencode' });
  f.bridge.hostExecutionPolicy.enableCursor({ confirmed: true, request_id: randomUUID() }, 'operator');
  f.bridge.cursorWorker = new CursorWorker(f.bridge, { fixtureExecutable: FIXTURE });
  f.bridge.missionAuthority.initializeOperatorKey();
  const ws=f.repo;
  const authority={level:'development',permissions:{repository:['read','write'],runtime:['diagnostic','test'],network:['internet','localhost'],secrets:[],data:['read','workspace_write']},filesystem:{read:[ws],write:[path.join(ws,'fixture.txt')]},expiresAt:Date.now()+3600000};
  const m=f.create({preferred_agent:'cursor',fallback_agents:[],authority,contract:{permissions:{external_disclosure:{authorized:true,providers:['cursor'],purpose:'Isolated regression'},network:{mode:'allowlist',allow:CURSOR_HOSTS}},budget:{risk_class:'fixture'}},dispatch_policy:{privacy:'cloud_allowed',providers:['cursor_runtime'],billing_classes:['subscription'],max_attempts:1}});
  assert.throws(()=>f.bridge.missions.dispatch(m.id,{request_id:randomUUID()}),/BLOCKED_SPEND_AUTHORIZATION|CURSOR_PLANNING_REQUIRED/);
  const approval=f.bridge.missionApprovals.issue({request_id:randomUUID(),channel:'control_center',contract:m.envelope.contract,confirmed:true,subscription_execution:{provider:'cursor',acknowledge_unknown_cost:true,max_invocations:1,max_runtime_ms:60000}},'operator');
  f.bridge.missionApprovals.bind(approval.approval_id,m.id,'operator');
  assert.throws(()=>f.bridge.missions.dispatch(m.id,{request_id:randomUUID()}),/CURSOR_PLANNING_REQUIRED/);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_subscription_invocations').get().n,0);
  assert.equal(fs.readFileSync(path.join(ws,'fixture.txt'),'utf8'),'alpha\n');
});
