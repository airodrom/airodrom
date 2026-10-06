'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

const BRIDGE_RESTART_JOB = 'bridge_restart';
const BRIDGE_RESTART_STATUS_JOB = 'bridge_restart_status';
const BRIDGE_MAINTENANCE_JOBS = Object.freeze(new Set([BRIDGE_RESTART_JOB, BRIDGE_RESTART_STATUS_JOB]));
const KIND = 'bridge-maintenance';
const COOLDOWN_MS = 60_000;
const DETACH_WAIT_MS = 1_500;
const LOCK_STALE_MS = 10 * 60_000;
const RECEIPT_NAME = 'bridge-restart-receipt.json';
const LOCK_NAME = 'bridge-restart.lock';
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set([
  'accepted', 'handed_off', 'completed', 'completed_after_recovery', 'failed', 'rejected_concurrent',
  'rejected_cooldown', 'rejected_invalid', 'stale', 'idempotent_replay', 'recovered_after_timeout'
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safePid(value) {
  return Number.isInteger(value) && value > 1 ? value : null;
}

function safeIso(value) {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40 ? value : null;
}

function safeOutcome(value) {
  return typeof value === 'string' && OUTCOMES.has(value) ? value : 'failed';
}

function safeFailureClass(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runtimePaths(runtimeDir) {
  const root = path.resolve(runtimeDir);
  return {
    runtimeDir: root,
    lockPath: path.join(root, LOCK_NAME),
    receiptPath: path.join(root, RECEIPT_NAME)
  };
}

function readJsonFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function sanitizeReceipt(raw) {
  if (!plainObject(raw)) return null;
  const requestId = typeof raw.request_id === 'string' && REQUEST_ID.test(raw.request_id) ? raw.request_id : null;
  if (!requestId) return null;
  return {
    schema_version: 1,
    request_id: requestId,
    requested_at: safeIso(raw.requested_at),
    handed_off_at: safeIso(raw.handed_off_at),
    completed_at: safeIso(raw.completed_at),
    outcome: safeOutcome(raw.outcome),
    failure_class: safeFailureClass(raw.failure_class),
    old_pid: safePid(raw.old_pid),
    new_pid: safePid(raw.new_pid),
    helper_pid: safePid(raw.helper_pid),
    mcp_ready: raw.mcp_ready === true ? true : raw.mcp_ready === false ? false : null,
    bridge_state: typeof raw.bridge_state === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(raw.bridge_state) ? raw.bridge_state : null,
    recovered: raw.recovered === true ? true : raw.recovered === false ? false : null
  };
}

function readReceipt(runtimeDir) {
  const { receiptPath } = runtimePaths(runtimeDir);
  return sanitizeReceipt(readJsonFile(receiptPath));
}

function writeReceipt(runtimeDir, receipt) {
  const sanitized = sanitizeReceipt(receipt);
  if (!sanitized) throw new Error('Invalid bridge restart receipt');
  atomicWriteJson(runtimePaths(runtimeDir).receiptPath, sanitized);
  return sanitized;
}

function readLock(runtimeDir) {
  const raw = readJsonFile(runtimePaths(runtimeDir).lockPath);
  if (!plainObject(raw)) return null;
  const requestId = typeof raw.request_id === 'string' && REQUEST_ID.test(raw.request_id) ? raw.request_id : null;
  if (!requestId) return null;
  return {
    request_id: requestId,
    owner_pid: safePid(raw.owner_pid),
    helper_pid: safePid(raw.helper_pid),
    created_at: safeIso(raw.created_at),
    created_ms: Number.isSafeInteger(raw.created_ms) ? raw.created_ms : null
  };
}

function processAlive(pid) {
  if (!safePid(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function clearLock(runtimeDir) {
  try { fs.unlinkSync(runtimePaths(runtimeDir).lockPath); } catch { /* absent lock is fine */ }
}

function acquireLock(runtimeDir, requestId, now) {
  const { lockPath } = runtimePaths(runtimeDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const existing = readLock(runtimeDir);
  if (existing) {
    const age = existing.created_ms ? now - existing.created_ms : Infinity;
    const holdersAlive = processAlive(existing.owner_pid) || processAlive(existing.helper_pid);
    if (existing.request_id === requestId) return { lock: existing, replay: true };
    if (holdersAlive && age < LOCK_STALE_MS) {
      const error = new Error('Bridge restart already in progress');
      error.code = 'BRIDGE_RESTART_CONCURRENT';
      throw error;
    }
    clearLock(runtimeDir);
  }
  const lock = {
    request_id: requestId,
    owner_pid: process.pid,
    helper_pid: null,
    created_at: new Date(now).toISOString(),
    created_ms: now
  };
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(lock, null, 2) + '\n');
  } finally {
    fs.closeSync(fd);
  }
  return { lock, replay: false };
}

function updateLockHelper(runtimeDir, helperPid) {
  const existing = readLock(runtimeDir);
  if (!existing) return null;
  const next = { ...existing, helper_pid: safePid(helperPid) };
  atomicWriteJson(runtimePaths(runtimeDir).lockPath, next);
  return next;
}

function cooldownActive(receipt, now) {
  if (!receipt || !['completed', 'completed_after_recovery', 'recovered_after_timeout'].includes(receipt.outcome) || !receipt.completed_at) return false;
  const completedMs = Date.parse(receipt.completed_at);
  if (!Number.isFinite(completedMs)) return false;
  return now - completedMs < COOLDOWN_MS;
}

function describeMaintenanceJob(jobName) {
  if (!BRIDGE_MAINTENANCE_JOBS.has(jobName)) throw new Error(`Bridge maintenance job is not approved: ${jobName}`);
  return { name: jobName, kind: KIND, acceptsTarget: false };
}

function defaultRestartInvoker(repoRoot) {
  const resilient = path.join(repoRoot, 'scripts/macos/resilient-control.cjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resilient], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) child.kill('SIGKILL');
    });
    child.on('error', reject);
    child.on('exit', code => {
      let parsed = null;
      for (const line of String(stdout + '\n' + stderr).split(/\r?\n/).reverse()) {
        try {
          const value = JSON.parse(line);
          if (plainObject(value)) { parsed = value; break; }
        } catch { /* keep scanning */ }
      }
      if (code === 0 && parsed?.resilient_restart === true) {
        resolve({
          ok: true,
          recovered: parsed.recovered === true,
          status: plainObject(parsed.status) ? parsed.status : null
        });
        return;
      }
      const error = new Error(parsed?.error || `resilient restart exited ${code}`);
      error.result = parsed;
      reject(error);
    });
  });
}

function spawnDetachedHelper({ repoRoot, requestId, spawnImpl = spawn }) {
  const helper = path.join(repoRoot, 'scripts/macos/restart-handoff.cjs');
  const child = spawnImpl(process.execPath, [helper, '--execute', '--request-id', requestId], {
    cwd: repoRoot,
    env: process.env,
    detached: true,
    stdio: 'ignore'
  });
  child.unref?.();
  return child;
}

function requestRestart({
  runtimeDir,
  repoRoot,
  requestId = randomUUID(),
  now = Date.now(),
  spawnImpl = spawn,
  readBridgePid = () => {
    try {
      const value = Number(fs.readFileSync(path.join(runtimeDir, 'bridge.lock'), 'utf8').trim());
      return safePid(value);
    } catch { return null; }
  }
} = {}) {
  if (!REQUEST_ID.test(requestId)) {
    const error = new Error('Bridge restart request id is invalid');
    error.code = 'BRIDGE_RESTART_INVALID';
    throw error;
  }
  const existingReceipt = readReceipt(runtimeDir);
  if (existingReceipt?.request_id === requestId && ['handed_off', 'completed', 'completed_after_recovery', 'accepted', 'idempotent_replay', 'failed', 'recovered_after_timeout'].includes(existingReceipt.outcome)) {
    return { ...existingReceipt, outcome: existingReceipt.outcome === 'completed' ? 'idempotent_replay' : existingReceipt.outcome };
  }
  if (cooldownActive(existingReceipt, now)) {
    const error = new Error('Bridge restart cooldown is active');
    error.code = 'BRIDGE_RESTART_COOLDOWN';
    error.receipt = existingReceipt;
    throw error;
  }

  const { replay } = acquireLock(runtimeDir, requestId, now);
  if (replay && existingReceipt?.request_id === requestId) {
    return { ...existingReceipt, outcome: 'idempotent_replay' };
  }

  const oldPid = readBridgePid();
  let receipt = writeReceipt(runtimeDir, {
    schema_version: 1,
    request_id: requestId,
    requested_at: new Date(now).toISOString(),
    handed_off_at: null,
    completed_at: null,
    outcome: 'accepted',
    failure_class: null,
    old_pid: oldPid,
    new_pid: null,
    helper_pid: null,
    mcp_ready: null,
    bridge_state: null,
    recovered: null
  });

  const child = spawnDetachedHelper({ repoRoot, requestId, spawnImpl });
  const helperPid = safePid(child.pid);
  updateLockHelper(runtimeDir, helperPid);
  receipt = writeReceipt(runtimeDir, {
    ...receipt,
    handed_off_at: new Date(Date.now()).toISOString(),
    outcome: 'handed_off',
    helper_pid: helperPid
  });
  return receipt;
}

async function executeRestart({
  runtimeDir,
  repoRoot,
  requestId,
  waitMs = DETACH_WAIT_MS,
  now = Date.now(),
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  restartInvoker = null
} = {}) {
  if (!REQUEST_ID.test(requestId)) throw new Error('Bridge restart execute request id is invalid');
  const lock = readLock(runtimeDir);
  if (!lock || lock.request_id !== requestId) throw new Error('Bridge restart lock does not match request');
  updateLockHelper(runtimeDir, process.pid);

  let receipt = readReceipt(runtimeDir);
  if (!receipt || receipt.request_id !== requestId) {
    receipt = writeReceipt(runtimeDir, {
      schema_version: 1,
      request_id: requestId,
      requested_at: new Date(now).toISOString(),
      handed_off_at: new Date(now).toISOString(),
      completed_at: null,
      outcome: 'handed_off',
      failure_class: null,
      old_pid: null,
      new_pid: null,
      helper_pid: process.pid,
      mcp_ready: null,
      bridge_state: null,
      recovered: null
    });
  }

  await sleepImpl(waitMs);
  const invoker = restartInvoker || (() => defaultRestartInvoker(repoRoot));
  try {
    const result = await invoker();
    const status = plainObject(result?.status) ? result.status : null;
    if (result?.ok !== true || status?.state !== 'Connected' || status?.managed !== true || status?.mcp?.ready !== true ||
        !safePid(status?.pid) || status.pid === receipt.old_pid) throw new Error('Restart readiness was not proven');
    receipt = writeReceipt(runtimeDir, {
      ...receipt,
      completed_at: new Date(Date.now()).toISOString(),
      outcome: result?.recovered === true ? 'completed_after_recovery' : 'completed',
      failure_class: null,
      new_pid: safePid(status?.pid),
      helper_pid: process.pid,
      mcp_ready: status?.mcp?.ready === true,
      bridge_state: typeof status?.state === 'string' ? status.state : null,
      recovered: result?.recovered === true
    });
    clearLock(runtimeDir);
    return receipt;
  } catch (error) {
    receipt = writeReceipt(runtimeDir, {
      ...receipt,
      completed_at: new Date(Date.now()).toISOString(),
      outcome: 'failed',
      failure_class: error.result?.failure_class === 'readiness_timeout' ? 'readiness_timeout' : 'restart_failed',
      new_pid: safePid(error.result?.status?.pid),
      recovered: error.result?.recovered === true,
      helper_pid: process.pid,
      mcp_ready: false,
      bridge_state: 'Error'
    });
    clearLock(runtimeDir);
    const failure = new Error(String(error?.message || error).slice(0, 300));
    failure.receipt = receipt;
    throw failure;
  }
}

function statusRestart(runtimeDir, { now = Date.now(), reconcileProbe = null } = {}) {
  let receipt = readReceipt(runtimeDir);
  if (receipt?.outcome === 'failed' && receipt.failure_class === 'readiness_timeout' && reconcileProbe) {
    const observed = reconcileProbe();
    if (observed?.ready === true && safePid(observed.status?.pid) && observed.status.pid !== receipt.old_pid &&
        Number.isFinite(observed.started_ms) && observed.started_ms >= Date.parse(receipt.requested_at)) {
      receipt = writeReceipt(runtimeDir, { ...receipt, outcome: 'recovered_after_timeout',
        completed_at: new Date(now).toISOString(), new_pid: observed.status.pid,
        mcp_ready: true, bridge_state: 'Connected', recovered: true });
    }
  }
  const lock = readLock(runtimeDir);
  if (!receipt) {
    return {
      schema_version: 1,
      available: false,
      outcome: 'stale',
      failure_class: 'receipt_missing',
      lock_held: Boolean(lock),
      cooldown_active: false
    };
  }
  const staleLock = lock && !(processAlive(lock.owner_pid) || processAlive(lock.helper_pid)) &&
    lock.created_ms && now - lock.created_ms > LOCK_STALE_MS;
  return {
    ...receipt,
    available: true,
    lock_held: Boolean(lock) && !staleLock,
    cooldown_active: cooldownActive(receipt, now),
    receipt_sha256: hash(JSON.stringify(receipt))
  };
}

module.exports = {
  BRIDGE_RESTART_JOB,
  BRIDGE_RESTART_STATUS_JOB,
  BRIDGE_MAINTENANCE_JOBS,
  KIND,
  COOLDOWN_MS,
  DETACH_WAIT_MS,
  describeMaintenanceJob,
  requestRestart,
  executeRestart,
  statusRestart,
  readReceipt,
  writeReceipt,
  readLock,
  clearLock,
  sanitizeReceipt,
  runtimePaths
};
