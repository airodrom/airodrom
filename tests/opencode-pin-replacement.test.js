'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

function sha(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function loadBootstrap({ executable, version = '2.0.20', evidenceSha, runtimeVersion = version, onProbe = async () => {}, probes }) {
  class Adapter {
    constructor(_, options = {}) { this.options = options; }
    executable() { return this.options.executable || executable; }
    async readiness() { return { ready: true, version }; }
    async execute() { probes.count++; await onProbe(); return { result: { summary: 'Airodrom local qualification passed' }, changes: [], provenance: { termination_verified: true } }; }
  }
  const evidence = {
    platform: process.platform + '-' + process.arch,
    model: 'ollama/qwen3-coder:30b',
    executable_sha256: evidenceSha || sha(executable),
    execution_qualified: true,
    runtime_version: runtimeVersion
  };
  const realRequire = require('node:module').createRequire(require.resolve('../src/local-bootstrap'));
  const sandboxModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/local-bootstrap'), 'utf8'), {
    require: name => name === './opencode-adapter' ? { OpenCodeAdapter: Adapter, VERSION: version }
      : name === '../config/agent-runtime-qualification-v1.json' ? { opencode: evidence }
      : realRequire(name),
    module: sandboxModule, exports: sandboxModule.exports, process,
    __dirname: path.dirname(require.resolve('../src/local-bootstrap')),
    Buffer, URL, fetch, AbortSignal, AbortController, setTimeout
  });
  return { l: sandboxModule.exports, evidence };
}

function fixture(t, { contents = 'synthetic executable', version = '2.0.20', runtimeVersion } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-opencode-replace-')));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const executable = path.join(home, 'fixture-opencode');
  fs.writeFileSync(executable, contents, { mode: 0o700 });
  const probes = { count: 0 };
  const { l, evidence } = loadBootstrap({ executable, version, runtimeVersion: runtimeVersion || version, probes });
  const pins = {
    version: 1,
    platform: evidence.platform,
    model: evidence.model,
    runtime_version: evidence.runtime_version,
    executables: [
      { id: 'node', path: path.join(home, 'removed-node'), sha256: '0'.repeat(64) },
      l.pin('sandbox-exec', '/usr/bin/sandbox-exec'),
      l.pin('opencode', executable)
    ]
  };
  l.writePrivate(path.join(home, 'runtime-pins.json'), pins);
  return { home, l, executable, evidence, probes, pinsFile: path.join(home, 'runtime-pins.json') };
}

test('removed OpenCode pin path requalifies a package-matching replacement and archives prior pins', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.pinsFile, 'utf8');
  const oldPath = f.executable;
  const replacement = path.join(f.home, 'replacement-opencode');
  fs.renameSync(oldPath, replacement);
  assert.equal(f.l.openCodePinMissing(f.l.ownedJSON(f.pinsFile)), true);
  const result = await f.l.requalify(f.home, { ...process.env, AIRODROM_OPENCODE_EXECUTABLE: replacement });
  assert.equal(result.qualified, true);
  assert.equal(result.replaced_missing_opencode, true);
  assert.equal(f.probes.count, 1);
  const next = f.l.validatePins(f.l.ownedJSON(f.pinsFile));
  assert.equal(next.executables.find(p => p.id === 'opencode').path, fs.realpathSync(replacement));
  assert.equal(fs.readFileSync(path.join(f.home, 'runtime-pins.previous.json'), 'utf8'), before);
});

test('new package-qualified OpenCode version replaces a removed pin only after evidence matches', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-opencode-newver-')));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const oldExe = path.join(home, 'old-opencode');
  const newExe = path.join(home, 'new-opencode');
  fs.writeFileSync(oldExe, 'old qualified bytes', { mode: 0o700 });
  fs.writeFileSync(newExe, 'new qualified bytes', { mode: 0o700 });
  const probes = { count: 0 };
  // Package evidence already cut over to the new digest/version; pins still name the removed old path.
  const { l, evidence } = loadBootstrap({ executable: newExe, version: '2.0.25', runtimeVersion: '2.0.25', evidenceSha: sha(newExe), probes });
  const pins = {
    version: 1,
    platform: evidence.platform,
    model: evidence.model,
    runtime_version: '2.0.20',
    executables: [
      { id: 'node', path: path.join(home, 'removed-node'), sha256: '0'.repeat(64) },
      l.pin('sandbox-exec', '/usr/bin/sandbox-exec'),
      { id: 'opencode', path: oldExe, sha256: sha(oldExe) }
    ]
  };
  l.writePrivate(path.join(home, 'runtime-pins.json'), pins);
  fs.rmSync(oldExe);
  const before = fs.readFileSync(path.join(home, 'runtime-pins.json'), 'utf8');
  const result = await l.requalify(home, { ...process.env, AIRODROM_OPENCODE_EXECUTABLE: newExe });
  assert.equal(result.qualified, true);
  assert.equal(result.version, '2.0.25');
  assert.equal(result.replaced_missing_opencode, true);
  assert.equal(probes.count, 1);
  assert.equal(l.validatePins(l.ownedJSON(path.join(home, 'runtime-pins.json'))).runtime_version, '2.0.25');
  assert.equal(fs.readFileSync(path.join(home, 'runtime-pins.previous.json'), 'utf8'), before);
});

test('invalid replacement digest is rejected and previous pins are preserved', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.pinsFile, 'utf8');
  fs.rmSync(f.executable);
  const bad = path.join(f.home, 'bad-opencode');
  fs.writeFileSync(bad, 'not the qualified digest', { mode: 0o700 });
  await assert.rejects(f.l.requalify(f.home, { ...process.env, AIRODROM_OPENCODE_EXECUTABLE: bad }), /do not match the qualified local runtime|Previous runtime pins were preserved/);
  assert.equal(f.probes.count, 0);
  assert.equal(fs.readFileSync(f.pinsFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.home, 'runtime-pins.previous.json')), false);
});

test('running service blocks OpenCode replacement requalification', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.pinsFile, 'utf8');
  const dataDir = path.join(f.home, 'data');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'bridge.lock'), String(process.pid), { mode: 0o600 });
  await assert.rejects(f.l.requalify(f.home), /Stop the owned service before requalification/);
  assert.equal(f.probes.count, 0);
  assert.equal(fs.readFileSync(f.pinsFile, 'utf8'), before);
});

test('failed qualification after a missing pin preserves previous pins and releases the lock', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.pinsFile, 'utf8');
  const replacement = path.join(f.home, 'replacement-opencode');
  fs.renameSync(f.executable, replacement);
  const { l } = loadBootstrap({
    executable: replacement,
    evidenceSha: sha(replacement),
    probes: f.probes,
    onProbe: async () => { throw Error('synthetic probe failure'); }
  });
  // Rebind fixture helper exports onto the failing loader while keeping the same pin file.
  await assert.rejects(l.requalify(f.home, { ...process.env, AIRODROM_OPENCODE_EXECUTABLE: replacement }), /synthetic probe failure|Local OpenCode qualification did not pass/);
  assert.equal(fs.readFileSync(f.pinsFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.home, 'qualification.lock')), false);
  assert.equal(fs.existsSync(path.join(f.home, 'runtime-pins.previous.json')), false);
});

test('concurrent OpenCode replacement requalification is rejected', async t => {
  const f = fixture(t);
  const replacement = path.join(f.home, 'replacement-opencode');
  fs.renameSync(f.executable, replacement);
  let release, started;
  const gate = new Promise(r => { release = r; });
  const begin = new Promise(r => { started = r; });
  const probes = { count: 0 };
  const { l } = loadBootstrap({
    executable: replacement,
    evidenceSha: sha(replacement),
    probes,
    onProbe: async () => { started(); return gate; }
  });
  // Keep pins pointing at the removed path for both callers.
  const first = l.requalify(f.home, { ...process.env, AIRODROM_OPENCODE_EXECUTABLE: replacement });
  await begin;
  await assert.rejects(l.requalify(f.home, { ...process.env, AIRODROM_OPENCODE_EXECUTABLE: replacement }), /already running/);
  release();
  assert.equal((await first).qualified, true);
  assert.equal(probes.count, 1);
});

test('CLI surfaces a clear missing-pin error instead of a raw ENOENT lstat', async t => {
  const f = fixture(t);
  fs.rmSync(f.executable);
  await assert.rejects(f.l.requalify(f.home, { ...process.env, AIRODROM_OPENCODE_EXECUTABLE: '' }), /Pinned OpenCode executable is missing|Replacement OpenCode|Install that exact qualified artifact/);
  // Direct helper message includes the removed pin path and avoids leaking only a bare ENOENT.
  const pins = f.l.ownedJSON(f.pinsFile);
  assert.match(String(f.l.resolveOpenCodeExecutable && (() => { try { f.l.resolveOpenCodeExecutable({}, pins, true); } catch (e) { return e.message; } })()), /Pinned OpenCode executable is missing|not ready|Install/);
});
