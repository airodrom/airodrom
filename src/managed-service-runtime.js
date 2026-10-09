'use strict';
// Host adapters for the ADR 0031 supervisor. Reads only allowlisted private files
// and records fixed codes; no token, URL, argv or environment value leaves here.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const local = require('./local-bootstrap');

const STATE_FILE = 'managed-supervisor.json';
const EVENTS_FILE = 'managed-supervisor-events.jsonl';
const STOP_MARKER = 'managed-supervisor-stop.json';
const LOCK_FILE = 'managed-supervisor.lock';
const EVENTS_LIMIT = 256 * 1024;
const SERVICE_ENTRY = path.join(local.ROOT, 'scripts/local-service.cjs');
const SUPERVISOR_ENTRY = path.join(local.ROOT, 'scripts/managed-service.cjs');

const bootTime = () => Date.now() - os.uptime() * 1000;
const sleep = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});

// Classify a live PID without exporting its arguments.
function processInfo(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return { alive: false }; }
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 3000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  if (r.status !== 0 || !r.stdout.trim()) return { alive: false };
  return { alive: true, service: r.stdout.includes(SERVICE_ENTRY), supervisor: r.stdout.includes(SUPERVISOR_ENTRY) };
}

function safeFile(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.nlink !== 1 || stat.size > limit) throw Error('Unsafe private file');
  return stat;
}

// Mirrors scripts/local-service.cjs validation so the supervisor blocks instead of crash-looping.
function preflight(home) {
  let digest = null;
  try {
    local.privateDirectory(home);
    const file = path.join(home, 'local.json');
    if (!fs.existsSync(file)) return { ok: false, reason: 'setup_required', digest };
    const config = local.ownedJSON(file);
    digest = fs.readFileSync(file, 'utf8');
    if (config.version !== 1 || config.source !== local.ROOT || config.dataDir !== path.join(home, 'data') || config.profile !== path.join(home, 'profile') || config.pinsFile !== path.join(home, 'runtime-pins.json')) return { ok: false, reason: 'configuration_mismatch', digest };
    local.privateDirectory(config.dataDir); local.privateDirectory(config.profile);
    try { local.validatePins(local.ownedJSON(config.pinsFile)); }
    catch { return { ok: false, reason: 'runtime_requalification_required', digest }; }
    return { ok: true, digest };
  } catch { return { ok: false, reason: 'private_home_unsafe', digest }; }
}

// Writer ownership from bridge.lock. A dead PID is reclaimed by the Bridge itself;
// a live PID that is not this installation's service is never treated as ours.
function owner(dataDir, { info = processInfo, boot = bootTime() } = {}) {
  const file = path.join(dataDir, 'bridge.lock');
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { return { state: error.code === 'ENOENT' ? 'none' : 'unverified' }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > 32) return { state: 'unverified' };
  const pid = Number(fs.readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unverified' };
  const process_ = info(pid);
  if (!process_.alive) return { state: 'stale', pid };
  if (process_.service) return { state: 'live', pid };
  // Written before this boot yet held by a live foreign process: the PID was reused.
  return { state: stat.mtimeMs < boot - 60000 ? 'pid_reused' : 'unverified', pid };
}

async function probe(home, timeoutMs = 5000) {
  const found = local.discovery(home);
  const s = await local.request(home, '/api/interactive/status', undefined, { timeoutMs });
  if (s.protocol !== 'airodrom-local-v1' || s.pid !== found.pid) throw Error('Service identity mismatch');
  return { healthy: s.healthy === true, pid: s.pid, opencode: { ready: s.opencode?.ready === true, reason: typeof s.opencode?.reason === 'string' ? s.opencode.reason.slice(0, 64) : null } };
}

// Same entry and environment as local-bootstrap start(); detached so a supervisor
// crash cannot take the control plane down with its process group.
function spawnService(home, { entry = SERVICE_ENTRY, execPath = process.execPath } = {}) {
  const child = spawn(execPath, ['--experimental-sqlite', entry], { cwd: local.ROOT, detached: true, stdio: 'ignore', env: { HOME: os.homedir(), PATH: path.dirname(execPath) + ':/usr/bin:/bin', LANG: 'en_US.UTF-8', AIRODROM_HOME: home, AIRODROM_DEFAULT_RUNTIME: require('./default-runtime').defaultRuntime(undefined), NODE_NO_WARNINGS: '1' } });
  const exit = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null, spawn_error: true }));
  });
  return { pid: child.pid, exit, kill: signal => { try { child.kill(signal); } catch {} } };
}

function readState(dataDir) {
  try {
    const file = path.join(dataDir, STATE_FILE); safeFile(file, 16384);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.version === 1 && typeof value.state === 'string' && Number.isSafeInteger(value.updated_at) ? value : null;
  } catch { return null; }
}

function recordEvent(dataDir, event) {
  if (!fs.existsSync(dataDir)) return;
  const file = path.join(dataDir, EVENTS_FILE);
  try { if (safeFile(file, Infinity).size > EVENTS_LIMIT) fs.renameSync(file, file + '.1'); }
  catch (error) { if (error.code !== 'ENOENT') return; }
  fs.appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600, flag: 'a' });
}

function readEvents(dataDir, limit = 20) {
  try {
    const file = path.join(dataDir, EVENTS_FILE); safeFile(file, EVENTS_LIMIT * 2);
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-limit).map(line => JSON.parse(line));
  } catch { return []; }
}

// An operator stop holds for the current boot session only; a new login starts the service.
function readStopMarker(dataDir) {
  try { const file = path.join(dataDir, STOP_MARKER); safeFile(file, 1024); const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value.version === 1 && Math.abs(value.boot - bootTime()) < 120000; }
  catch { return false; }
}
function writeStopMarker(dataDir, stopped) {
  const file = path.join(dataDir, STOP_MARKER);
  if (stopped) local.writePrivate(file, { version: 1, boot: Math.round(bootTime()) });
  else fs.rmSync(file, { force: true });
}

// One supervisor per Airodrom home. A second instance waits in standby; a lock
// left by a dead or foreign PID is the supervisor's own state and is reclaimed.
async function acquireSupervisorLock(home, signal, { info = processInfo, pollMs = 15000 } = {}) {
  const file = path.join(home, LOCK_FILE);
  while (!signal.aborted) {
    try {
      if (fs.existsSync(home)) {
        local.privateDirectory(home);
        try {
          const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
          return () => { try { if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file); } catch {} };
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          safeFile(file, 32);
          const pid = Number(fs.readFileSync(file, 'utf8')), holder = Number.isSafeInteger(pid) && pid > 0 ? info(pid) : { alive: false };
          if (!(holder.alive && holder.supervisor)) { fs.unlinkSync(file); continue; }
        }
      }
    } catch { /* unsafe or unavailable home: stay in standby */ }
    await sleep(pollMs, signal);
  }
  return null;
}

function adapters(home) {
  const dataDir = path.join(home, 'data');
  return {
    pid: process.pid,
    now: Date.now, monotonic: () => performance.now(), sleep, random: Math.random,
    preflight: () => preflight(home),
    owner: () => owner(dataDir),
    probe: () => probe(home),
    spawn: () => spawnService(home),
    publish: snapshot => { if (fs.existsSync(dataDir)) local.writePrivate(path.join(dataDir, STATE_FILE), snapshot); },
    record: event => recordEvent(dataDir, event),
    readStopMarker: () => readStopMarker(dataDir),
    writeStopMarker: stopped => writeStopMarker(dataDir, stopped)
  };
}

module.exports = { STATE_FILE, EVENTS_FILE, STOP_MARKER, LOCK_FILE, processInfo, preflight, owner, probe, spawnService, readState, readEvents, recordEvent, readStopMarker, writeStopMarker, acquireSupervisorLock, adapters, bootTime };
