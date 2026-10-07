'use strict';
// ADR 0007: private per-user lifecycle. No credential enters argv or stdout.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { readPrivateJSON } = require('./private-json');
const { verifyExecutable } = require('./sandbox-policy');
const ROOT = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function privateDirectory(directory, create = false) {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || s.mode & 0o077 || fs.realpathSync(directory) !== path.resolve(directory)) throw Error('Airodrom home must be a private, owned directory without symlinks.');
  return directory;
}
function writePrivate(file, value) {
  privateDirectory(path.dirname(file));
  if (fs.existsSync(file)) ownedJSON(file);
  const temporary = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
  try { fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function ownedJSON(file, maximum = 16000) {
  const s = fs.lstatSync(file);
  if (s.uid !== process.getuid?.() || s.nlink !== 1) throw Error('Private configuration ownership is invalid.');
  return readPrivateJSON(file, maximum);
}
function localHome(env = process.env) {
  const home = path.resolve(env.AIRODROM_HOME || path.join(os.homedir(), '.airodrom'));
  // A dedicated override supports isolated synthetic validation; never aliases legacy data.
  if (Buffer.byteLength(path.join(home, 'data/policy.sock')) > 100) throw Error('Choose a shorter AIRODROM_HOME for the local policy socket.');
  return home;
}
function pin(id, file) {
  const real = fs.realpathSync(file), record = { id, path: real, sha256: digest(real) };
  verifyExecutable(record); return record;
}
async function qualify({ executable, model = 'ollama/qwen3-coder:30b', adapter = null, signal } = {}) {
  if (signal?.aborted) throw Error('Local qualification was interrupted; previous pins preserved.');
  const version=process.versions.node.split('.').map(Number);
  if(version[0]!==22||version[1]<23||version[1]===23&&version[2]<3)throw Error('Local qualification requires supported Node 22.23.3 or later in the 22.x line.');
  const { OpenCodeAdapter, VERSION } = require('./opencode-adapter');
  const runtime = adapter || new OpenCodeAdapter(null, { enabled: true, executable, model });
  const evidence = require('../config/agent-runtime-qualification-v1.json').opencode;
  const candidate = runtime.executable();
  if (!candidate) throw Error('OpenCode is not ready: opencode_unavailable. Install qualified OpenCode 2.0.20 and start Ollama with qwen3-coder:30b.');
  const opencode = pin('opencode', candidate);
  if (process.platform + '-' + process.arch !== evidence.platform || model !== evidence.model || opencode.sha256 !== evidence.executable_sha256 || evidence.execution_qualified !== true) throw Error('Installed OpenCode artifacts do not match the qualified local runtime. Requalify them before startup.');
  const ready = await runtime.readiness();
  if (!ready.ready || ready.version !== VERSION) throw Error('OpenCode is not ready: ' + ready.reason + '. Install qualified OpenCode 2.0.20 and start Ollama with qwen3-coder:30b.');
  if (signal?.aborted) throw Error('Local qualification was interrupted; previous pins preserved.');
  const node = pin('node', process.execPath), sandbox = pin('sandbox-exec', '/usr/bin/sandbox-exec');
  // Use the adapter's existing real sandbox and synthetic result parser before recording pins.
  const probe = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-bootstrap-')));
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  signal?.addEventListener('abort', interrupt, {once:true});
  try {
    if (signal?.aborted) interrupt();
    const result = await runtime.execute({ workspace: probe, files: [], objective: 'Return only JSON with summary exactly "Airodrom local qualification passed" and changed_files:[],tests:[],artifacts:[],limitations:[]', timeoutMs: 90000, signal: controller.signal });
    if (controller.signal.aborted) throw Error('Local qualification was interrupted; previous pins preserved.');
    if (result.result.summary !== 'Airodrom local qualification passed' || result.changes.length || !result.provenance.termination_verified) throw Error('Local OpenCode qualification did not pass.');
  } finally { signal?.removeEventListener('abort', interrupt); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); fs.rmSync(probe, { recursive: true, force: true }); }
  const pins = { version: 1, platform: process.platform + '-' + process.arch, executables: [node, sandbox, opencode], model, runtime_version: VERSION, qualified_at: new Date().toISOString() };
  // A successful probe cannot bless an artifact replaced during qualification.
  validatePins(pins);
  return pins;
}
function repairablePins(pins) {
  const evidence = require('../config/agent-runtime-qualification-v1.json').opencode;
  if (pins?.version !== 1 || pins.platform !== process.platform + '-' + process.arch || pins.runtime_version !== evidence.runtime_version || pins.model !== evidence.model || pins.executables?.length !== 3 || new Set(pins.executables.map(p => p.id)).size !== 3) throw Error('Unsupported runtime drift. Restore qualified artifacts before requalification.');
  for (const id of ['node', 'sandbox-exec', 'opencode']) {
    const record = pins.executables.find(p => p.id === id);
    if (!record || !path.isAbsolute(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw Error('Unsupported runtime drift. Restore qualified artifacts before requalification.');
    if (id !== 'node') verifyExecutable(record);
  }
  if (pins.executables.find(p => p.id === 'opencode').sha256 !== evidence.executable_sha256 || pins.executables.find(p => p.id === 'sandbox-exec').path !== fs.realpathSync('/usr/bin/sandbox-exec') || !/^22\./.test(process.versions.node) || Number(process.versions.node.split('.')[1]) < 23 || Number(process.versions.node.split('.')[1]) === 23 && Number(process.versions.node.split('.')[2]) < 3) throw Error('Unsupported runtime drift. Restore qualified artifacts before requalification.');
  // Only the host Node pin can be stale. OpenCode and Seatbelt must remain exact.
  pin('node', process.execPath);
  return pins;
}
async function requalify(home, env = process.env, {signal} = {}) {
  privateDirectory(home); const file = path.join(home, 'runtime-pins.json');
  const before = ownedJSON(file); repairablePins(before);
  const lockFile = path.join(home, 'qualification.lock'); let fd;
  try { fd = fs.openSync(lockFile, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); }
  catch { throw Error('OpenCode requalification is already running or its private lock is unavailable.'); }
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  const effectiveSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    if (effectiveSignal.aborted) throw Error('Local qualification was interrupted; previous pins preserved.');
    if (!isStopped(home)) throw Error('Stop the owned service before requalification; active writers and data were preserved.');
    assertDurableIdle(home);
    const identity = digest(file);
    const pins = await qualify({ executable: before.executables.find(p => p.id === 'opencode').path, model: before.model, signal: effectiveSignal });
    if (!isStopped(home) || digest(file) !== identity) throw Error('Runtime state changed during requalification. Existing pins were preserved.');
    assertDurableIdle(home);
    if (effectiveSignal.aborted) throw Error('Local qualification was interrupted; previous pins preserved.');
    validatePins(pins); writePrivate(file, pins);
    return { qualified: true, runtime: 'opencode', version: pins.runtime_version };
  } finally { process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); fs.closeSync(fd); fs.unlinkSync(lockFile); }
}
function assertDurableIdle(home) {
  const directory=path.join(home,'data'),file=path.join(directory,'memory.sqlite');let database;
  try {
    try { fs.lstatSync(directory); } catch(error) { if(error.code==='ENOENT')return;throw error; }
    privateDirectory(directory);
    if(!fs.existsSync(file)){
      if(fs.readdirSync(directory).some(name=>!['menu.lock','macos-control.lock'].includes(name)))throw Error('Missing durable database');
      return;
    }
    for(const target of [file,file+'-wal',file+'-shm']){
      let stat;try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT'&&target!==file)continue;throw error;}
      if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.nlink!==1||stat.mode&0o077)throw Error('Unverifiable database ownership');
    }
    database=new (require('node:sqlite').DatabaseSync)(file,{readOnly:true});
    const runs=database.prepare("SELECT count(*) n FROM cp_runs WHERE state IN ('starting','running','verifying','termination_unverified') OR process_state IN ('alive','unknown')").get().n;
    const leases=database.prepare("SELECT count(*) n FROM cp_leases WHERE state IN ('held','quarantined')").get().n;
    if(runs||leases)throw Error('Retained work is not terminated');
  }catch{throw Error('Durable writer state is active or unavailable. Existing runtime pins were preserved.');}
  finally{database?.close();}
}
function validatePins(pins) {
  const evidence = require('../config/agent-runtime-qualification-v1.json').opencode;
  if (pins?.version !== 1 || pins.platform !== process.platform + '-' + process.arch || pins.runtime_version !== evidence.runtime_version || pins.model !== evidence.model || !Array.isArray(pins.executables) || pins.executables.length !== 3) throw Error('Local runtime pins are invalid. Run airodrom restart after restoring qualified artifacts.');
  if (new Set(pins.executables.map(p => p.id)).size !== 3) throw Error('Local runtime pins contain duplicate identities.');
  for (const id of ['node', 'sandbox-exec', 'opencode']) {
    const p = pins.executables.find(x => x.id === id); if (!p) throw Error('Local runtime pin is missing.'); verifyExecutable(p);
  }
  if (pins.executables.find(x => x.id === 'opencode').sha256 !== evidence.executable_sha256 || fs.realpathSync('/usr/bin/sandbox-exec') !== pins.executables.find(x => x.id === 'sandbox-exec').path || fs.realpathSync(process.execPath) !== pins.executables.find(x => x.id === 'node').path) throw Error('Local runtime qualification changed. Requalify the installed runtime.');
  return pins;
}
async function prepare(home, env = process.env, {signal} = {}) {
  privateDirectory(home, true);
  const dataDir = privateDirectory(path.join(home, 'data'), true), profile = privateDirectory(path.join(home, 'profile'), true);
  const pinsFile = path.join(home, 'runtime-pins.json');
  let pins;
  if (fs.existsSync(pinsFile)) {
    try { pins = validatePins(ownedJSON(pinsFile)); }
    catch { repairablePins(ownedJSON(pinsFile)); await requalify(home, env, {signal}); pins = validatePins(ownedJSON(pinsFile)); }
  } else { assertDurableIdle(home);pins = await qualify({ executable: env.AIRODROM_OPENCODE_EXECUTABLE, signal });assertDurableIdle(home); }
  if (!fs.existsSync(pinsFile)) writePrivate(pinsFile, pins);
  const settings = { defaultProvider: 'ollama', defaultModel: pins.model.slice(7), enableTelemetry: false, packages: [], retry: { enabled: false } };
  const settingsFile = path.join(profile, 'settings.json');
  if (fs.existsSync(settingsFile) && JSON.stringify(ownedJSON(settingsFile)) !== JSON.stringify(settings)) throw Error('Local profile differs from the fixed local-only profile. Existing settings were preserved.');
  if (!fs.existsSync(settingsFile)) writePrivate(settingsFile, settings);
  const config = { version: 1, dataDir, profile, pinsFile, source: ROOT };
  const file = path.join(home, 'local.json');
  if (fs.existsSync(file) && JSON.stringify(ownedJSON(file)) !== JSON.stringify(config)) throw Error('Local service belongs to another installation. Stop and inspect it before changing source.');
  if (!fs.existsSync(file)) writePrivate(file, config);
  return config;
}
function discovery(home) {
  privateDirectory(home); const dataDir = privateDirectory(path.join(home, 'data'));
  const ui = ownedJSON(path.join(dataDir, 'ui.json')), credential = ownedJSON(path.join(dataDir, 'control-credential.json'));
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/#token=([a-f0-9]{64})$/.exec(ui.url);
  if (!match || match[2] !== credential.token || ui.port !== Number(match[1]) || !Number.isSafeInteger(ui.pid) || ui.pid <= 0) throw Error('Local discovery is invalid. Existing service state was preserved.');
  const lock = fs.lstatSync(path.join(dataDir, 'bridge.lock'));
  if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== process.getuid?.() || lock.mode & 0o077 || lock.size > 32 || Number(fs.readFileSync(path.join(dataDir, 'bridge.lock'), 'utf8')) !== ui.pid) throw Error('Local service ownership does not match discovery.');
  return { origin: 'http://127.0.0.1:' + ui.port, token: credential.token, pid: ui.pid, url: ui.url };
}
async function request(home, route, body, { timeoutMs = 10000, signal } = {}) {
  const d = discovery(home);
  const r = await fetch(d.origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + d.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const value = await r.json(); if (!r.ok) throw Error(value.error || 'Local request was refused.'); return value;
}
async function status(home, { allowOlderSource = false, timeoutMs = 10000, signal } = {}) {
  const s = await request(home, '/api/interactive/status', undefined, {timeoutMs, signal});
  if (s.pid !== discovery(home).pid || !allowOlderSource && s.source_sha256 !== require('./runtime-fingerprint').sourceFingerprint().source_sha256 || s.protocol !== 'airodrom-local-v1') throw Error('Running service is from another source revision. Restart it through its owning installation.');
  try { s.product = await request(home, '/api/product/native-status', undefined, {timeoutMs, signal}); } catch { s.product=null; }
  return s;
}
function isStopped(home) {
  try { fs.lstatSync(home); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  privateDirectory(home);
  const dataDir = path.join(home, 'data');
  try { fs.lstatSync(dataDir); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  privateDirectory(dataDir);
  // Missing discovery alone never proves a live writer has stopped.
  const ownership = require('../scripts/macos/control.cjs').lock({ dataDir });
  if (ownership.blocked) return false;
  if (!fs.existsSync(path.join(dataDir, 'ui.json'))) return true;
  // A crash can leave discovery behind. Only exact owned discovery bound to a
  // confirmed-dead PID permits reconciliation; nothing is removed here.
  try { const d = discovery(home); process.kill(d.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
async function start(home, env = process.env) {
  privateDirectory(home, true);
  // Serialize bootstrap and service launch. A malformed/live lock is never removed.
  const lockFile = path.join(home, 'launch.lock'); let fd;
  try { fd = fs.openSync(lockFile, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { try { return await status(home, {timeoutMs:Math.min(1000,deadline-Date.now())}); } catch {} await pause(100); }
    throw Error('Another bootstrap owns startup. Inspect its private launch.lock before retrying.');
  }
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  try {
    const dataDir = path.join(home, 'data');
    if (fs.existsSync(dataDir)) {
      try {
        const attached = await status(home, {timeoutMs:2000,signal:controller.signal});
        if (attached.opencode?.reason !== 'opencode_runtime_pins_changed') return attached;
        repairablePins(ownedJSON(path.join(home, 'runtime-pins.json')));
        if (attached.active_runs || attached.quarantined_leases || !attached.managed) throw Error('Runtime pin repair is waiting for owned work to settle.');
        await stop(home);
      } catch (error) {
        const lock = require('../scripts/macos/control.cjs').lock({ dataDir });
        if (lock.blocked) throw Error('A live or unverified service owns the data directory. Existing service and data were preserved.');
        // Unsafe discovery/config is never silently replaced.
        if (fs.existsSync(path.join(dataDir, 'ui.json'))) discovery(home);
      }
    }
    const config = await prepare(home, env, {signal:controller.signal});
    if (controller.signal.aborted) throw Error('Local startup was interrupted; existing data preserved.');
    const child = spawn(process.execPath, ['--experimental-sqlite', path.join(ROOT, 'scripts/local-service.cjs')], { cwd: ROOT, detached: true, stdio: 'ignore', env: { HOME: os.homedir(), PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'en_US.UTF-8', AIRODROM_HOME: home, AIRODROM_DEFAULT_RUNTIME: require('./default-runtime').defaultRuntime(env.AIRODROM_DEFAULT_RUNTIME), NODE_NO_WARNINGS: '1' } });
    let spawnError = false; child.on('error', () => { spawnError = true; }); child.unref();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (controller.signal.aborted) throw Error('Local startup was interrupted; existing data preserved.');
      try { const s = await status(home, {timeoutMs:Math.min(1000,deadline-Date.now()),signal:controller.signal}); if (s.healthy) return s; } catch {}
      if (spawnError) break; await pause(100);
    }
    throw Error('Local service did not become ready. Inspect private service state; data was preserved.');
  } finally { process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); fs.closeSync(fd); fs.unlinkSync(lockFile); }
}
async function stop(home) {
  if (isStopped(home)) return { stopped: true };
  const before = await status(home, { allowOlderSource: true });
  if (!before.managed) throw Error('This service is not owned by the local CLI. Use its original lifecycle control.');
  await request(home, '/api/interactive/stop', {});
  for (let i = 0; i < 150; i++) { if (!require('../scripts/macos/control.cjs').lock({ dataDir: path.join(home, 'data') }).blocked) return { stopped: true }; await pause(100); }
  throw Error('Service is still stopping. Its writer lock was preserved.');
}
function open(home, {missionId} = {}) {
  const d = discovery(home);
  if(missionId&&!require('./product-observability').id(missionId))throw Error('Invalid Mission identity');
  const target=missionId?d.url.replace('/#','/?mission='+missionId+'#'):d.url;
  // LaunchServices receives a private URL on stdin through AppleScript, never argv.
  const r = spawnSync('/usr/bin/osascript', ['-'], { input: 'open location ' + JSON.stringify(target) + '\n', encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) throw Error('Control Center could not open. Check the default browser.');
}
module.exports = { ROOT, localHome, privateDirectory, writePrivate, ownedJSON, pin, qualify, validatePins, repairablePins, requalify, assertDurableIdle, prepare, discovery, request, status, isStopped, start, stop, open };
