'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const RUNTIME = path.join(ROOT, '.runtime');
const CONTROL = path.join(ROOT, 'scripts/macos/control.cjs');
const PORT = Number(process.env.PI_BRIDGE_PORT || 43117);
const GRACE_MS = 5000;

function run(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? 30000,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024
  });
}

function processCommand(pid) {
  const result = run('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 3000 });
  return result.status === 0 ? require('../../src/secret-observation').redactText(String(result.stdout || '').trim()) : '';
}

function isExpectedBridgeCommand(command) {
  return typeof command === 'string' &&
    command.includes(path.join(ROOT, 'src/index.js')) &&
    /(^|\/)node(?:\s|$)/.test(command);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitDead(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!processAlive(pid)) return true;
    sleep(100);
  }
  return !processAlive(pid);
}

function listenerOutput() {
  const result = run('/usr/sbin/lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { timeout: 3000 });
  if (result.error?.code === 'ENOENT') return '';
  return String(result.stdout || '');
}

function readLockPid() {
  try {
    const value = Number(fs.readFileSync(path.join(RUNTIME, 'bridge.lock'), 'utf8').trim());
    return Number.isInteger(value) && value > 1 ? value : null;
  } catch {
    return null;
  }
}

function quarantine(file, stamp) {
  const source = path.join(RUNTIME, file);
  if (!fs.existsSync(source)) return null;
  const target = `${source}.stale-${stamp}`;
  fs.renameSync(source, target);
  return target;
}

function parseStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value === 'object') return value;
    } catch {}
  }
  return null;
}

function forceRecoverStuckBridge() {
  const pid = readLockPid();
  if (pid && processAlive(pid)) {
    const command = processCommand(pid);
    if (!isExpectedBridgeCommand(command)) {
      throw new Error(`Refusing to terminate PID ${pid}: bridge.lock does not identify this repository's bridge process`);
    }

    process.kill(pid, 'SIGTERM');
    if (!waitDead(pid, GRACE_MS)) {
      process.kill(pid, 'SIGKILL');
      if (!waitDead(pid, GRACE_MS)) throw new Error(`Bridge PID ${pid} did not terminate`);
    }
  }

  const listeners = listenerOutput();
  if (listeners.trim()) {
    throw new Error(`Refusing stale cleanup: port ${PORT} is still listening\n${listeners}`);
  }

  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const quarantined = [
    quarantine('bridge.lock', stamp),
    quarantine('policy.sock', stamp)
  ].filter(Boolean);

  return { pid, quarantined };
}

function control(action, timeout = 30000) {
  return run(process.execPath, [CONTROL, action], { timeout });
}

function readiness(status, { command = processCommand, database = databaseReady } = {}) {
  if (status?.state !== 'Connected' || status?.managed !== true || status?.mcp?.ready !== true ||
      !Number.isInteger(status?.pid) || status.pid <= 1) return false;
  if (!isExpectedBridgeCommand(command(status.pid))) return false;
  return database(status.pid) === true;
}

function databaseReady(pid) {
  // Read-only probe: never migrate or repair the running database.
  const probe = run(process.execPath, ['--experimental-sqlite', '-e',
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});const r=db.prepare('PRAGMA integrity_check').all();db.close();if(r.length!==1||Object.values(r[0])[0]!=='ok')process.exit(1)",
    path.join(RUNTIME, 'memory.sqlite')], { timeout: 5000 });
  if (probe.error || probe.status !== 0) return false;
  try {
    const lines = fs.readFileSync(path.join(RUNTIME, 'background-service.log'), 'utf8').split(/\r?\n/);
    const events = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const start = events.findLastIndex(e => e.pid === pid && e.event === 'starting');
    if (start < 0) return false;
    return !events.slice(start).some(e => e.pid === pid && /fatal|startup_error/.test(e.event || ''));
  } catch { return false; }
}

function probeReadiness() {
  const result = control('status', 10000);
  const status = parseStatus(result.stdout);
  let started_ms = null;
  try {
    const events = fs.readFileSync(path.join(RUNTIME, 'background-service.log'), 'utf8').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    started_ms = Date.parse(events.findLast(e => e.pid === status?.pid && e.event === 'starting')?.at);
  } catch {}
  return { status, started_ms, ready: !result.error && result.status === 0 && readiness(status) };
}

function waitReadiness({ probe = probeReadiness, sleepImpl = sleep, now = Date.now, timeoutMs = 30000,
  oldPid = null } = {}) {
  const deadline = now() + timeoutMs;
  let delay = 200, last = null;
  do {
    last = probe();
    if (now() <= deadline && last?.ready === true && last.status?.pid !== oldPid) return { ready: true, status: last.status };
    if (now() >= deadline) break;
    sleepImpl(Math.min(delay, deadline - now()));
    delay = Math.min(1000, delay * 2);
  } while (now() <= deadline);
  return { ready: false, status: last?.status || null };
}

function resilientRestart({ controlImpl = control, waitImpl = waitReadiness, recoverImpl = forceRecoverStuckBridge, pidImpl = readLockPid } = {}) {
  const oldPid = pidImpl();
  const first = controlImpl('restart', 30000);
  // Even a transient control-helper failure may have started the intended service.
  const normal = waitImpl({ oldPid });
  if (normal.ready) return { recovered: Boolean(first.error || first.status !== 0), status: normal.status };
  const recovery = recoverImpl();
  controlImpl('start', 30000);
  const recovered = waitImpl({ oldPid });
  if (!recovered.ready) {
    const error = new Error('Managed bridge readiness timed out after bounded recovery');
    error.result = { recovered: true, recovery, status: recovered.status, failure_class: 'readiness_timeout' };
    throw error;
  }
  return { recovered: true, recovery, status: recovered.status };
}

if (require.main === module) {
  try {
    const result = resilientRestart();
    process.stdout.write(`${JSON.stringify({ resilient_restart: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ resilient_restart: false, error: error.message, ...(error.result || {}) })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  isExpectedBridgeCommand,
  parseStatus,
  resilientRestart,
  forceRecoverStuckBridge, readiness, waitReadiness, probeReadiness
};
