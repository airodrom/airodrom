'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseProcessRows, pidAlive, controlPlaneStatus, processLookup, CONTROL_PLANE_SERVICE, CONTROL_PLANE_LEGACY_SERVICE
} = require('../src/capability-mac');
const { CapabilityHost } = require('../src/capability-host');
const { HostExecutor } = require('../src/host-exec');
const { EXECUTABLES } = require('../src/capability-mac');
const { TAR } = require('../src/capability-files');

test('parseProcessRows accepts macOS ps lstart lines', () => {
  const rows = parseProcessRows(' 1603     1   501  1.0  1.3 09:15 Sun Oct 11 20:28:33 2026     /opt/homebrew/bin/node');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 1603);
  assert.equal(rows[0].command, '/opt/homebrew/bin/node');
});

test('controlPlaneStatus never claims running without a live PID probe', () => {
  const root = fs.mkdtempSync('/private/tmp/airodrom-identity-');
  try {
    const hostOwned = path.join(root, 'host-owned');
    fs.mkdirSync(hostOwned, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'bridge.lock'), String(process.pid), { mode: 0o600 });
    const status = controlPlaneStatus({ hostOwnedRoot: hostOwned });
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
    assert.equal(status.identity, CONTROL_PLANE_SERVICE);
    assert.equal(status.legacy_service_id, CONTROL_PLANE_LEGACY_SERVICE);
    assert.equal(status.verification, 'signal_probe');
    assert.equal(status.pid_source, 'bridge_lock');
    assert.match(status.note, /not a separate Pi Bridge/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controlPlaneStatus ignores stale bridge.lock PIDs', () => {
  const root = fs.mkdtempSync('/private/tmp/airodrom-identity-');
  try {
    const hostOwned = path.join(root, 'host-owned');
    fs.mkdirSync(hostOwned, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'bridge.lock'), '999999999', { mode: 0o600 });
    const status = controlPlaneStatus({ hostOwnedRoot: hostOwned });
    assert.equal(status.supervisor_pid, null);
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
    assert.equal(status.pid_source, 'capability_host');
    assert.equal(pidAlive(999999999), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('process_status uses targeted lookup and signal probe when the table omits a live PID', async t => {
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/cap-identity-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const stamp = 'Sun Oct 11 20:28:33 2026';
  const uid = process.getuid();
  let psCalls = 0;
  class FakeExec extends HostExecutor {
    constructor() { super({ allowed: [...EXECUTABLES, TAR], home }); this.calls = []; }
    run(file, args = [], options = {}) {
      this.calls.push({ file, args });
      if (file === '/bin/ps') {
        psCalls += 1;
        if (args[0] === '-axo') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, signal: null });
        if (args[0] === '-p' && args[1] === String(process.pid)) {
          return Promise.resolve({
            exitCode: 0,
            stdout: ` ${process.pid}     1   ${uid}  0.0  0.1 00:05 ${stamp}     ${process.execPath}\n`,
            stderr: '', truncated: false, timedOut: false, signal: null
          });
        }
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: '', truncated: false, timedOut: false, signal: null });
      }
      return super.run(file, args, options);
    }
  }
  const exec = new FakeExec();
  const host = new CapabilityHost({
    dataDir: path.join(root, 'data'), home, env: {}, exec, bridgeRoot: path.resolve(__dirname, '..'),
    localServicesPath: path.join(root, 'no-services.json'),
    requestBridgeRestart: () => ({ outcome: 'handed_off', request_id: 'fixture' })
  });
  const task = { id: 'task-identity', workspace: home, capabilityScopes: ['mac_local', 'system_readonly', 'developer_environment'] };
  t.after(() => { host.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const prepared = await host.prepare(task, 'process_status', { pid: process.pid });
  assert.equal(prepared.assessment.decision, 'auto_allow');
  const result = await host.perform(task, prepared);
  assert.equal(result.result.running, true);
  assert.equal(result.result.pid, process.pid);
  assert.equal(result.result.verification, 'process_lookup');
  assert.ok(psCalls >= 2, 'table then targeted lookup');
  assert.equal((await processLookup({ exec }, 999999999)), null);
});

test('missing PID is not reported running without a live signal probe', async t => {
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/cap-identity-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  class EmptyPs extends HostExecutor {
    constructor() { super({ allowed: [...EXECUTABLES, TAR], home }); }
    run(file, args = [], options = {}) {
      if (file === '/bin/ps') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, signal: null });
      return super.run(file, args, options);
    }
  }
  const host = new CapabilityHost({
    dataDir: path.join(root, 'data'), home, env: {}, exec: new EmptyPs(), bridgeRoot: path.resolve(__dirname, '..'),
    localServicesPath: path.join(root, 'no-services.json')
  });
  const task = { id: 'task-missing', workspace: home, capabilityScopes: ['mac_local', 'system_readonly', 'developer_environment'] };
  t.after(() => { host.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const prepared = await host.prepare(task, 'process_status', { pid: 99_999_997 });
  const result = await host.perform(task, prepared);
  assert.equal(result.result.running, false);
  assert.equal(result.result.verification, 'not_found');
});
