'use strict';
// ADR 0031 focused checks: synthetic clocks, fake processes and disposable
// directories only. No launchd, installed service or live data is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Supervisor, backoffDelay, DEFAULTS } = require('../src/managed-supervisor');
const runtime = require('../src/managed-service-runtime');
const agent = require('../src/managed-service-agent');
const local = require('../src/local-bootstrap');
const { createClient } = require('../src/mcp-client');

const tick = () => new Promise(resolve => setImmediate(resolve));
const POLICY = { readinessTimeoutMs: 5000, healthIntervalMs: 1000, pollMs: 100, stopGraceMs: 2000, blockedRecheckMs: 1000, stableAfterMs: 60000 };

function harness(overrides = {}) {
  const h = { clock: 1e9, mono: 0, events: [], spawned: [], killed: [], marker: null, nextPid: 500, probes: 0,
    preflight: () => ({ ok: true }), owner: () => ({ state: h.current ? 'none' : 'none' }), current: null,
    probe: async () => { h.probes++; if (!h.current || h.current.exited) throw Error('down'); return { healthy: true, pid: h.current.pid, opencode: { ready: true } }; },
    ...overrides };
  h.spawn = overrides.spawn || (() => {
    let resolve; const child = { pid: h.nextPid++, exited: false, exit: new Promise(r => { resolve = r; }) };
    child.end = (code, signal = null) => { child.exited = true; resolve({ code, signal }); };
    child.kill = signal => { h.killed.push([child.pid, signal]); if (!h.ignoreTerm) child.end(null, signal); };
    h.current = child; h.spawned.push(child); return child;
  });
  h.deps = { pid: 1, now: () => h.clock, monotonic: () => h.mono, random: () => 0.5,
    sleep: async (ms, signal) => { if (signal?.aborted) return; h.clock += ms; h.mono += h.sleeping ? 0 : ms; await tick(); },
    preflight: () => h.preflight(), owner: () => h.owner(), probe: () => h.probe(), spawn: () => h.spawn(),
    publish: s => { h.last = s; }, record: e => h.events.push(e), readStopMarker: () => false, writeStopMarker: v => { h.marker = v; } };
  return h;
}
async function runUntil(h, predicate, options = POLICY, max = 3000) {
  const supervisor = new Supervisor(h.deps, options), controller = new AbortController(), done = supervisor.run(controller.signal);
  for (let i = 0; i < max && !predicate(supervisor); i++) await tick();
  const reached = predicate(supervisor);
  controller.abort(); await done;
  return { supervisor, reached };
}
const names = h => h.events.map(e => e.event);

test('login start launches one service and reports HEALTHY only after authenticated readiness', async () => {
  const h = harness();
  const { reached } = await runUntil(h, s => s.state === 'HEALTHY');
  assert.equal(reached, true); assert.equal(h.spawned.length, 1);
  assert.ok(names(h).indexOf('ready') > names(h).indexOf('child_spawned'));
  assert.equal(h.last.state, 'STOPPED'); // graceful shutdown on abort
  assert.deepEqual(h.killed, [[500, 'SIGTERM']]);
});

test('an existing live service is adopted, never duplicated, and a clean stop is not relaunched', async () => {
  let live = true;
  const h = harness({ owner: () => live ? { state: 'live', pid: 77 } : { state: 'none' }, probe: async () => ({ healthy: true, pid: 77, opencode: { ready: true } }) });
  const { supervisor } = await runUntil(h, s => { if (s.mode === 'attached') live = false; return s.operatorStopped; });
  assert.equal(h.spawned.length, 0); assert.equal(supervisor.operatorStopped, true); assert.equal(h.marker, true);
  assert.ok(names(h).includes('adopted') && names(h).includes('operator_stop_observed'));
});

test('invalid configuration and reused writer-lock PIDs block without launching', async () => {
  for (const [override, reason] of [[{ preflight: () => ({ ok: false, reason: 'configuration_mismatch' }) }, 'configuration_mismatch'], [{ owner: () => ({ state: 'pid_reused', pid: 9 }) }, 'writer_lock_pid_reused']]) {
    const h = harness(override);
    const { supervisor } = await runUntil(h, s => s.state === 'BLOCKED');
    assert.equal(supervisor.blocked.reason, reason); assert.equal(h.spawned.length, 0);
  }
});

test('crashes recover with growing jittered backoff and stop at a bounded crash loop', async () => {
  const h = harness({ owner: () => ({ state: h.current && !h.current.exited ? 'live-child' : 'stale', pid: 1 }) });
  h.probe = async () => { if (!h.current || h.current.exited) throw Error('down'); h.current.end(1); return { healthy: true, pid: h.current.pid, opencode: { ready: true } }; };
  const { supervisor } = await runUntil(h, s => s.state === 'BLOCKED');
  assert.equal(supervisor.blocked.reason, 'crash_loop'); assert.equal(h.spawned.length, DEFAULTS.maxFailures);
  const delays = h.events.filter(e => e.event === 'child_failed').map(e => e.delay_ms);
  assert.deepEqual(delays, [1500, 3000, 6000, 12000, 24000]);
  for (let n = 1; n < 20; n++) { const d = backoffDelay(n, DEFAULTS, Math.random); assert.ok(d >= Math.min(DEFAULTS.backoffMaxMs, 2000 * 2 ** (n - 1)) / 2 && d <= DEFAULTS.backoffMaxMs); }
});

test('a lost launch race adopts the winner without counting a failure', async () => {
  let winner = false;
  const h = harness({ owner: () => winner ? { state: 'live', pid: 42 } : { state: 'none' }, probe: async () => winner ? { healthy: true, pid: 42, opencode: { ready: true } } : Promise.reject(Error('down')) });
  const spawn = h.spawn; h.spawn = () => { const c = spawn(); winner = true; c.end(1); return c; };
  const { supervisor } = await runUntil(h, s => s.mode === 'attached');
  assert.equal(supervisor.failures.length, 0); assert.ok(names(h).includes('launch_race_lost'));
});

test('worker and health problems degrade status without killing; sleep resets the counter', async () => {
  const h = harness();
  let calls = 0;
  h.probe = async () => { calls++; if (calls === 1) return { healthy: true, pid: h.current.pid, opencode: { ready: false, reason: 'opencode_unavailable' } }; throw Error('timeout'); };
  const { supervisor } = await runUntil(h, s => s.state === 'DEGRADED');
  assert.equal(supervisor.worker.opencode, 'DEGRADED'); assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.killed, [[500, 'SIGTERM']]); // only the graceful stop at shutdown
  const s = harness(); s.probe = async () => { if (s.mono > 5000) s.sleeping = true; return { healthy: true, pid: s.current.pid, opencode: { ready: true } }; };
  await runUntil(s, () => names(s).includes('wake_detected'), { ...POLICY, sleepGapMs: 500 });
  assert.ok(names(s).includes('wake_detected'));
});

test('a hung startup gets SIGTERM only and is preserved, never SIGKILLed', async () => {
  const h = harness({ probe: async () => { throw Error('not ready'); } }); h.ignoreTerm = true;
  await runUntil(h, s => h.events.some(e => e.event === 'startup_hung_process_preserved'));
  assert.ok(h.killed.every(([, signal]) => signal === 'SIGTERM'));
  assert.equal(h.spawned.length, 1);
});

test('writer ownership is classified from the lock without trusting a reused PID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airo-owner-')); fs.chmodSync(dir, 0o700);
  const lock = path.join(dir, 'bridge.lock'), boot = Date.now();
  try {
    assert.equal(runtime.owner(dir).state, 'none');
    fs.writeFileSync(lock, '4242', { mode: 0o600 });
    assert.equal(runtime.owner(dir, { info: () => ({ alive: false }), boot }).state, 'stale');
    assert.equal(runtime.owner(dir, { info: () => ({ alive: true, service: true }), boot }).state, 'live');
    assert.equal(runtime.owner(dir, { info: () => ({ alive: true, service: false }), boot }).state, 'unverified');
    fs.utimesSync(lock, new Date(boot - 3600e3), new Date(boot - 3600e3));
    assert.equal(runtime.owner(dir, { info: () => ({ alive: true, service: false }), boot }).state, 'pid_reused');
    fs.writeFileSync(lock, 'not-a-pid'); assert.equal(runtime.owner(dir).state, 'unverified');
    fs.rmSync(lock); fs.symlinkSync('/dev/null', lock); assert.equal(runtime.owner(dir).state, 'unverified');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LaunchAgent plan is login-scoped, crash-restarting, argv-secret-free and conflict-aware', () => {
  const p = agent.plan({ home: '/Users/fixture', airodromHome: '/Users/fixture/.airodrom', root: '/opt/airodrom', node: '/opt/homebrew/opt/node@22/bin/node' });
  assert.equal(p.agent.Label, 'local.airodrom.service'); assert.equal(p.agent.RunAtLoad, true);
  assert.deepEqual(p.agent.KeepAlive, { SuccessfulExit: false }); assert.equal(p.agent.LimitLoadToSessionType, 'Aqua');
  assert.equal(p.agent.ProgramArguments.at(-1), '/opt/airodrom/scripts/managed-service.cjs');
  assert.doesNotMatch(p.agent.ProgramArguments.join(' '), /token|secret|key=|password/i);
  const printed = { status: 0, stdout: 'gui/501/x = {\n\tstate = running\n\tpid = 321\n\truns = 2\n\tlast exit code = 0\n\tenvironment = {\n\t\tTOKEN => abc\n\t}\n\targuments = {\n\t\t--secret\n\t}\n}' };
  assert.deepEqual(agent.jobStatus('x', () => printed), { label: 'x', loaded: true, state: 'running', pid: 321, last_exit_code: 0, runs: 2 });

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-agent-'))), airodromHome = path.join(home, '.airodrom');
  fs.mkdirSync(path.join(home, 'Library/LaunchAgents'), { recursive: true }); fs.mkdirSync(airodromHome, { mode: 0o700 });
  const calls = [], run = args => { calls.push(args[0]); return { status: args[0] === 'print' ? 113 : 0, stdout: '' }; };
  const options = { home, airodromHome, root: local.ROOT, node: process.execPath, run };
  try {
    fs.writeFileSync(path.join(airodromHome, 'local.json'), JSON.stringify({ version: 1, source: '/elsewhere' }), { mode: 0o600 });
    assert.deepEqual(agent.install(options).refused, ['installation_source_mismatch']);
    fs.writeFileSync(path.join(airodromHome, 'local.json'), JSON.stringify({ version: 1, source: local.ROOT }), { mode: 0o600 });
    assert.deepEqual(agent.install(options).steps, ['write_agent', 'enable', 'bootstrap']);
    assert.equal(fs.existsSync(path.join(home, 'Library/LaunchAgents/local.airodrom.service.plist')), false); // dry run
    fs.writeFileSync(path.join(home, 'Library/LaunchAgents/local.pi-chatgpt-bridge.plist'), 'legacy');
    assert.deepEqual(agent.install({ ...options, apply: true }).refused, ['legacy_agent_present:local.pi-chatgpt-bridge']);
    fs.rmSync(path.join(home, 'Library/LaunchAgents/local.pi-chatgpt-bridge.plist'));
    assert.equal(agent.install({ ...options, apply: true }).installed, true);
    assert.equal(fs.readFileSync(path.join(home, 'Library/LaunchAgents/local.airodrom.service.plist'), 'utf8'), agent.plan(options).xml);
    assert.ok(calls.includes('enable') && calls.includes('bootstrap'));
    assert.equal(agent.uninstall({ home, run, apply: true }).removed, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('MCP client waits through a supervised restart and never replays a delivered call', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-mcp-'))); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let delivered = 0, drop = false;
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { delivered++; if (drop) return req.socket.destroy(); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const token = 'a'.repeat(64), write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value), { mode: 0o600 });
  const supervisor = state => write('managed-supervisor.json', { version: 1, state, updated_at: Date.now() });
  const discover = (port, pid) => write('mcp.json', { port, token, pid });
  const call = createClient({ dataDir: dir, waitMs: 3000, pollMs: 20 });

  supervisor('BLOCKED');
  await assert.rejects(call('agent_status', {}), e => /needs attention/.test(e.publicMessage));
  fs.rmSync(path.join(dir, 'managed-supervisor.json'));
  await assert.rejects(call('agent_status', {}), e => /not running/.test(e.publicMessage) && !/npm start/.test(e.publicMessage));

  supervisor('STARTING'); setTimeout(() => discover(server.address().port, 11), 100);
  assert.deepEqual(await call('agent_status', {}), { ok: true }); assert.equal(delivered, 1);

  const closed = http.createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r)); const stale = closed.address().port; await new Promise(r => closed.close(r));
  discover(stale, 12); supervisor('RECOVERING'); setTimeout(() => discover(server.address().port, 13), 100);
  assert.deepEqual(await call('agent_status', {}), { ok: true }); assert.equal(delivered, 2); // refused connect, one delivery

  drop = true; supervisor('RECOVERING');
  await assert.rejects(call('agent_status', {}), e => /request failed/.test(e.publicMessage));
  assert.equal(delivered, 3); // delivered then dropped: not retried
});

test('doctor reports startup categories without paths or secrets', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-startup-doctor-'))); fs.chmodSync(home, 0o700);
  try {
    const startup = require('../src/startup-diagnostics').collect(home, { run: () => ({ status: 113, stdout: '' }) });
    assert.equal(startup.automatic_startup, 'Not installed'); assert.equal(startup.blocking_condition, 'not_installed');
    const text = require('../src/product-diagnostics').summary({ ...await require('../src/product-diagnostics').doctor(home), startup });
    assert.match(text, /Automatic startup: Not installed/); assert.doesNotMatch(text, /\/private\/|\/Users\/|token=|Bearer|argv/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
