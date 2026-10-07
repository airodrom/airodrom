'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { SandboxRunner, LIMITS, SCRATCH_DIAGNOSTIC_LIMITS, MANIFEST_SNAPSHOT_PATH, summarizeScratch } = require('../src/sandbox-runner');
const { makeProfile, sha256Tree, verifyManifest, verifyModuleClosure } = require('../src/sandbox-policy');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => digest(fs.readFileSync(file));
const nodeEntry = { id: 'node', path: fs.realpathSync(process.execPath), sha256: fileHash(process.execPath) };
const sandboxEntry = { id: 'sandbox-exec', path: '/usr/bin/sandbox-exec', sha256: 'a'.repeat(64) };
const shellEntry = { id: 'sh', path: fs.realpathSync('/bin/sh'), sha256: fileHash('/bin/sh') };
const bashEntry = { id: 'bash', path: fs.realpathSync('/bin/bash'), sha256: fileHash('/bin/bash') };

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runner-pin-')));
  const script = path.join(root, 'check.cjs'); fs.writeFileSync(script, "process.stdout.write('PIN_OK')\n");
  const opensslConfig = path.join(root, 'openssl.cnf'); fs.writeFileSync(opensslConfig, '# isolated OpenSSL configuration fixture\n');
  const providerRoot = path.join(root, 'provider-runtime');
  const providerEntrypoint = path.join(providerRoot, 'dist', 'api', 'openai-completions.js');
  fs.mkdirSync(path.dirname(providerEntrypoint), { recursive: true });
  fs.writeFileSync(providerEntrypoint, 'export const providerRuntime = true;\n');
  const workerRuntimeParent = path.join(root, 'worker-runtime');
  const workerCoreRoot = path.join(workerRuntimeParent, 'module-core');
  const workerChordRoot = path.join(workerRuntimeParent, 'chord');
  const unrelatedWorkerSibling = path.join(workerRuntimeParent, 'unrelated');
  const workerCoreEntrypoint = path.join(workerCoreRoot, 'dist', 'index.js');
  const workerContextEntrypoint = path.join(workerCoreRoot, 'dist', 'harness', 'context.js');
  const workerChordEntrypoint = path.join(workerChordRoot, 'dist', 'index.js');
  fs.mkdirSync(path.dirname(workerContextEntrypoint), { recursive: true });
  fs.mkdirSync(path.dirname(workerChordEntrypoint), { recursive: true });
  fs.mkdirSync(unrelatedWorkerSibling, { recursive: true });
  fs.writeFileSync(path.join(workerCoreRoot, 'package.json'), JSON.stringify({ name: '@fixture/module-core', version: '1.0.0', exports: { '.': { import: './dist/index.js' }, './harness/context': { import: './dist/harness/context.js' } } }));
  fs.writeFileSync(workerCoreEntrypoint, "import { chord } from '@fixture/chord'; export const core = chord;\n");
  fs.writeFileSync(workerContextEntrypoint, "export { core } from '../index.js';\n");
  fs.writeFileSync(path.join(workerChordRoot, 'package.json'), JSON.stringify({ name: '@fixture/chord', version: '1.0.0', exports: { '.': { import: './dist/index.js' } } }));
  fs.writeFileSync(workerChordEntrypoint, 'export const chord = true;\n');
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = { version: 1, platform: 'darwin', executables: [structuredClone(nodeEntry), structuredClone(sandboxEntry), structuredClone(shellEntry), structuredClone(bashEntry)], runtimeLibraries: [{ path: nodeEntry.path, sha256: nodeEntry.sha256 }], runtimeConfig: [{ kind: 'openssl', path: opensslConfig, sha256: fileHash(opensslConfig), aliases: [], includes: [] }], providerRuntime: { entrypoint: providerEntrypoint, entrypointSha256: fileHash(providerEntrypoint), roots: [{ path: providerRoot, sha256: sha256Tree(providerRoot, 'provider runtime').sha256 }] }, worker: { runtimeClosure: { roots: [{ package: '@fixture/module-core', version: '1.0.0', path: workerCoreRoot, sha256: sha256Tree(workerCoreRoot, 'worker runtime').sha256 }, { package: '@fixture/chord', version: '1.0.0', path: workerChordRoot, sha256: sha256Tree(workerChordRoot, 'worker runtime').sha256 }], entrypoints: [{ package: '@fixture/module-core', path: 'dist/index.js' }, { package: '@fixture/module-core', path: 'dist/harness/context.js' }] } }, jobs: [{ name: 'fixture-check', kind: 'test', inputs: [{ path: 'check.cjs', sha256: fileHash(script) }], steps: [{ executable: 'node', args: ['check.cjs'] }], timeoutMs: 3000, maxOutputBytes: 4096, maxConcurrentProcesses: 1, network: 'disabled' }] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, script, providerRoot, providerEntrypoint, workerRuntimeParent, workerCoreRoot, workerChordRoot, workerCoreEntrypoint, unrelatedWorkerSibling, manifest, manifestPath };
}

test('rejects changed test inputs and unpinned executable hashes before launching any process', async t => {
  const s = setup(t); let launched = 0;
  const runner = new SandboxRunner({ repoRoot: s.root, manifestPath: s.manifestPath, spawnImpl() { launched++; throw new Error('must not spawn'); } });
  fs.writeFileSync(s.script, "process.stdout.write('UNPINNED')\n");
  await assert.rejects(runner.run('fixture-check'), /hash mismatch/);
  assert.equal(launched, 0);

  s.manifest.jobs[0].inputs[0].sha256 = fileHash(s.script);
  s.manifest.executables[0].sha256 = 'b'.repeat(64);
  fs.writeFileSync(s.manifestPath, JSON.stringify(s.manifest), { mode: 0o600 });
  await assert.rejects(runner.run('fixture-check'), /executable verification failed/);
  assert.equal(launched, 0);
});

test('requires a hash-verified /bin/bash variant before launching the /bin/sh wrapper', async t => {
  const s = setup(t); let launched = 0;
  const runner = new SandboxRunner({ repoRoot: s.root, manifestPath: s.manifestPath, spawnImpl() { launched++; throw new Error('must not spawn'); } });
  s.manifest.executables = s.manifest.executables.filter(entry => entry.id !== 'bash');
  fs.writeFileSync(s.manifestPath, JSON.stringify(s.manifest), { mode: 0o600 });
  await assert.rejects(runner.run('fixture-check'), /Pinned sh execution variant is missing/);
  assert.equal(launched, 0);

  s.manifest.executables.push({ ...bashEntry, sha256: 'b'.repeat(64) });
  fs.writeFileSync(s.manifestPath, JSON.stringify(s.manifest), { mode: 0o600 });
  await assert.rejects(runner.run('fixture-check'), /Pinned executable verification failed: bash/);
  assert.equal(launched, 0);
});

test('uses /bin/sh -c while allowing only its verified /bin/bash execution variant', async t => {
  const s = setup(t); const captured = {};
  const runner = new SandboxRunner({
    repoRoot: s.root,
    manifestPath: s.manifestPath,
    spawnImpl(command, args) {
      captured.command = command; captured.args = args; captured.profile = fs.readFileSync(args[1], 'utf8');
      const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    }
  });
  const result = await runner.run('fixture-check');
  assert.equal(result.exitCode, 0);
  assert.equal(captured.command, '/usr/bin/sandbox-exec');
  assert.equal(captured.args[2], '/bin/sh');
  assert.equal(captured.args[3], '-c');
  assert.equal(captured.args.includes('/bin/bash'), false, 'the resource-limit wrapper still launches /bin/sh');
  const execLines = captured.profile.split('\n').filter(line => line.includes('(allow process-exec'));
  assert.equal(execLines.length, 3);
  for (const executable of [nodeEntry.path, shellEntry.path, bashEntry.path]) assert.ok(execLines.some(line => new RegExp(`\\(literal "${executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`).test(line)));
  for (const line of execLines) assert.doesNotMatch(line, /\/bin\/zsh|subpath/);
  assert.doesNotMatch(captured.profile, /\(allow process-fork\)/);
  assert.match(captured.profile, /\(deny network\*\)/);
  assert.doesNotMatch(captured.profile, new RegExp(`\\(subpath "${s.providerRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`), 'provider runtime remains unavailable without explicit job opt-in');
  for (const root of [s.workerCoreRoot, s.workerChordRoot]) assert.doesNotMatch(captured.profile, new RegExp(`\\(subpath "${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`), 'worker runtime remains unavailable without explicit job opt-in');
});


test('permits fork only for the canonical regression job while retaining exact executable rules', async t => {
  const s = setup(t); const captured = {};
  s.manifest.jobs[0].name = 'safe-autonomy-regression';
  s.manifest.jobs[0].allowPinnedChildProcesses = true;
  fs.writeFileSync(s.manifestPath, JSON.stringify(s.manifest), { mode: 0o600 });
  const runner = new SandboxRunner({
    repoRoot: s.root,
    manifestPath: s.manifestPath,
    spawnImpl(command, args) {
      captured.profile = fs.readFileSync(args[1], 'utf8');
      const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    }
  });
  const result = await runner.run('safe-autonomy-regression');
  assert.equal(result.exitCode, 0);
  assert.match(captured.profile, /^\(allow process-fork\)$/m);
  assert.doesNotMatch(captured.profile, /^\(allow process-exec\)$/m);
  assert.doesNotMatch(captured.profile, /\/bin\/zsh/);
  const execLines = captured.profile.split('\n').filter(line => line.includes('(allow process-exec'));
  assert.equal(execLines.length, 3);
  for (const executable of [nodeEntry.path, shellEntry.path, bashEntry.path]) assert.ok(execLines.some(line => line.includes(`(literal "${executable}")`)));
});


test('allows only a hash-verified provider runtime root for jobs that explicitly require it',()=>{
 const policy=require('../src/sandbox-policy');assert.equal(policy.verifyWorkerPackage,undefined);assert.equal(policy.verifyProviderRuntime,undefined);assert.equal(policy.WorkerSandbox,undefined);
});

test('allows only the hash-verified worker runtime closure for the explicit canonical regression capability',()=>{
 const policy=require('../src/sandbox-policy');assert.equal(policy.verifyWorkerPackage,undefined);assert.equal(policy.verifyProviderRuntime,undefined);assert.equal(policy.WorkerSandbox,undefined);
});

test('summarizes only bounded relative scratch entries with byte sizes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-scratch-summary-'));
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(path.join(scratch, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'home'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'tmp', 'largest.bin'), Buffer.alloc(900));
  fs.writeFileSync(path.join(scratch, 'home', 'medium.bin'), Buffer.alloc(400));
  fs.writeFileSync(path.join(scratch, 'tmp', 'small.bin'), Buffer.alloc(4));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const summary = summarizeScratch(scratch);
  assert.deepEqual(summary.entries.map(entry => entry.path), ['tmp/largest.bin', 'home/medium.bin', 'tmp/small.bin']);
  assert.deepEqual(summary.entries.map(entry => entry.bytes), [900, 400, 4]);
  assert.match(summary.text, /tmp\/largest\.bin=900/);
  assert.match(summary.text, /home\/medium\.bin=400/);
  assert.doesNotMatch(summary.text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(summary.text, /scratch\//);
});

test('bounds scratch diagnostics and rejects symlinks without following them', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-scratch-bounds-'));
  const scratch = path.join(root, 'scratch');
  const tmp = path.join(scratch, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  for (let index = 0; index < 12; index++) fs.writeFileSync(path.join(tmp, `${String(index).padStart(2, '0')}-${'x'.repeat(240)}`), 'x');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const summary = summarizeScratch(scratch);
  assert.ok(summary.entries.length <= SCRATCH_DIAGNOSTIC_LIMITS.maxResults);
  assert.ok(Buffer.byteLength(summary.text, 'utf8') <= SCRATCH_DIAGNOSTIC_LIMITS.maxTextLength);
  assert.equal(summary.truncated, true);
  const limited = summarizeScratch(scratch, { maxEntries: 3, maxDepth: 2, maxResults: 2, maxTextLength: 80 });
  assert.equal(limited.visited, 3);
  assert.equal(limited.truncated, true);
  // This is deliberately a virtual filesystem. The canonical outer runner
  // monitors its own TMPDIR and must never be asked to host a real test
  // symlink merely to prove that its production traversal rejects one.
  const virtualRoot = '/virtual/scratch';
  const virtualTmp = path.join(virtualRoot, 'tmp');
  const virtualEscape = path.join(virtualTmp, 'escape');
  const directory = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false, size: 0 };
  const symlink = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, size: 0 };
  const virtualFs = {
    lstatSync(file) {
      const candidate = path.resolve(file);
      if (candidate === virtualRoot || candidate === virtualTmp) return directory;
      if (candidate === virtualEscape) return symlink;
      const error = new Error('missing virtual scratch entry'); error.code = 'ENOENT'; throw error;
    },
    readdirSync(directoryPath) {
      const candidate = path.resolve(directoryPath);
      if (candidate === virtualRoot) return [{ name: 'tmp' }];
      if (candidate === virtualTmp) return [{ name: 'escape' }];
      const error = new Error('missing virtual scratch directory'); error.code = 'ENOENT'; throw error;
    }
  };
  const assertSymlinkDenied = operation => assert.throws(operation, error => {
    assert.equal(error.code, 'ELOOP');
    assert.match(error.message, /scratch symlinks are forbidden/);
    return true;
  });
  assertSymlinkDenied(() => summarizeScratch(virtualRoot, undefined, virtualFs));
  assertSymlinkDenied(() => new SandboxRunner({ repoRoot: root })._directoryBytes(virtualRoot, virtualFs));
});


test('tolerates only disappearing scratch entries and verified directory races', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-scratch-race-'));
  const scratch = path.join(root, 'scratch');
  const tmp = path.join(scratch, 'tmp');
  const vanishedFile = path.join(tmp, 'vanished-file');
  const vanishedDirectory = path.join(tmp, 'vanished-directory');
  fs.mkdirSync(vanishedDirectory, { recursive: true });
  fs.writeFileSync(vanishedFile, 'file');
  fs.writeFileSync(path.join(vanishedDirectory, 'child'), 'directory child');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = new SandboxRunner({ repoRoot: root });
  const originalLstat = fs.lstatSync;
  let missingFileCalls = 2;
  fs.lstatSync = function(file, ...args) {
    if (file === vanishedFile && missingFileCalls-- > 0) { const error = new Error('disappeared'); error.code = 'ENOENT'; throw error; }
    return originalLstat.call(this, file, ...args);
  };
  try {
    assert.equal(runner._directoryBytes(scratch), Buffer.byteLength('directory child'));
    assert.deepEqual(summarizeScratch(scratch).entries.map(entry => entry.path), ['tmp/vanished-directory/child']);
  } finally { fs.lstatSync = originalLstat; }

  const originalReaddir = fs.readdirSync;
  let directoryRaceCalls = 2;
  fs.readdirSync = function(directory, ...args) {
    if (directory === vanishedDirectory && directoryRaceCalls-- > 0) { const error = new Error('directory became a file'); error.code = 'ENOTDIR'; throw error; }
    return originalReaddir.call(this, directory, ...args);
  };
  try {
    assert.equal(runner._directoryBytes(scratch), Buffer.byteLength('file'));
    assert.deepEqual(summarizeScratch(scratch).entries.map(entry => entry.path), ['tmp/vanished-file']);
  } finally { fs.readdirSync = originalReaddir; }
});

test('unexpected scratch inspection errors terminate without a quota label or path leak', async t => {
  const s = setup(t);
  const runner = new SandboxRunner({
    repoRoot: s.root,
    manifestPath: s.manifestPath,
    spawnImpl() {
      const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      setTimeout(() => child.emit('close', 0, null), 75);
      return child;
    }
  });
  runner._directoryBytes = () => { const error = new Error('/private/should-not-leak'); error.code = 'EACCES'; throw error; };
  await assert.rejects(runner.run('fixture-check'), error => {
    assert.equal(error.message, 'Sandbox scratch inspection failed; code=EACCES');
    assert.doesNotMatch(error.message, /quota|private|should-not-leak/i);
    return true;
  });
});


test('scratch quota monitor retains a bounded relative summary in the failure', async t => {
  const s = setup(t);
  const runner = new SandboxRunner({
    repoRoot: s.root,
    manifestPath: s.manifestPath,
    spawnImpl(command, args, options) {
      fs.writeFileSync(path.join(options.env.TMPDIR, 'quota-producer.bin'), Buffer.alloc(3));
      const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      setTimeout(() => child.emit('close', 0, null), 75);
      return child;
    }
  });
  runner._directoryBytes = () => LIMITS.maxScratchBytes + 1;
  await assert.rejects(runner.run('fixture-check'), error => {
    assert.match(error.message, /^Sandbox scratch output limit exceeded; scratch-largest=tmp\/quota-producer\.bin=3/);
    assert.doesNotMatch(error.message, new RegExp(s.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
});



test('stages an exact read-only manifest snapshot without a normal self-input', async t => {
  const s = setup(t); const captured = {};
  const sourceBytes = fs.readFileSync(s.manifestPath);
  const sourceHash = fileHash(s.manifestPath);
  assert.equal(s.manifest.jobs[0].inputs.some(input => input.path === MANIFEST_SNAPSHOT_PATH), false);
  const runner = new SandboxRunner({
    repoRoot: s.root,
    manifestPath: s.manifestPath,
    spawnImpl(command, args, options) {
      const snapshot = path.join(options.cwd, MANIFEST_SNAPSHOT_PATH);
      captured.bytes = fs.readFileSync(snapshot);
      captured.hash = fileHash(snapshot);
      captured.mode = fs.lstatSync(snapshot).mode & 0o777;
      captured.parentMode = fs.lstatSync(path.dirname(snapshot)).mode & 0o777;
      captured.unrelated = fs.existsSync(path.join(options.cwd, 'unrelated.txt'));
      captured.profile = fs.readFileSync(args[1], 'utf8');
      const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    }
  });
  const result = await runner.run('fixture-check');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(captured.bytes, sourceBytes);
  assert.equal(captured.hash, sourceHash);
  assert.equal(captured.mode, 0o444);
  assert.equal(captured.parentMode & 0o222, 0);
  assert.equal(captured.unrelated, false);
  assert.match(captured.profile, /\(deny network\*\)/);
  assert.doesNotMatch(captured.profile, /^\(allow process-exec\)$/m);
  assert.doesNotMatch(captured.profile, /^\(allow process-fork\)$/m);
});

test('fails closed when the trust-root manifest changes during staging', async t => {
  const s = setup(t); let launched = 0;
  const runner = new SandboxRunner({ repoRoot: s.root, manifestPath: s.manifestPath, spawnImpl() { launched++; throw new Error('must not spawn'); } });
  const stageInputs = runner._stageInputs.bind(runner);
  runner._stageInputs = (...args) => {
    fs.appendFileSync(s.manifestPath, '\n');
    return stageInputs(...args);
  };
  await assert.rejects(runner.run('fixture-check'), /Pinned job manifest changed during staging/);
  assert.equal(launched, 0);
});

test('rejects manifest self-inputs before staging or spawning', async t => {
  const s = setup(t); let launched = 0;
  s.manifest.jobs[0].inputs.push({ path: MANIFEST_SNAPSHOT_PATH, sha256: '0'.repeat(64) });
  fs.writeFileSync(s.manifestPath, JSON.stringify(s.manifest), { mode: 0o600 });
  const runner = new SandboxRunner({ repoRoot: s.root, manifestPath: s.manifestPath, spawnImpl() { launched++; throw new Error('must not spawn'); } });
  await assert.rejects(runner.run('fixture-check'), /Sandbox manifest must not be a normal staged input/);
  assert.equal(launched, 0);
});


test('removed runtime dependency requirements deny before spawning even with valid host pins', async t => { const s=setup(t); let launched=0; const runner=new SandboxRunner({repoRoot:s.root,manifestPath:s.manifestPath,spawnImpl(){launched++;throw Error('must not spawn');}}); for(const selector of ['requiresProviderRuntime','requiresWorkerRuntimeClosure']) { s.manifest.jobs[0][selector]=true; fs.writeFileSync(s.manifestPath,JSON.stringify(s.manifest),{mode:0o600}); await assert.rejects(runner.run('fixture-check'),/Removed worker runtime dependency/); delete s.manifest.jobs[0][selector]; } assert.equal(launched,0); });

test('rejects unsafe manifest paths, symlinked inputs, network grants, and unbounded job settings', t => {
  const s = setup(t);
  const outside = path.join(s.root, 'outside.cjs'); fs.writeFileSync(outside, '');
  s.manifest.jobs[0].inputs[0].path = 'link.cjs';
  const link = path.join(s.root, 'link.cjs');
  const originalLstat = fs.lstatSync;
  fs.lstatSync = function(file, ...args) {
    if (path.resolve(file) === link) return { isSymbolicLink: () => true };
    return originalLstat.call(this, file, ...args);
  };
  try { assert.throws(() => verifyManifest(s.root, s.manifest, 'fixture-check'), /symbolic link/); }
  finally { fs.lstatSync = originalLstat; }
  s.manifest.jobs[0].inputs[0] = { path: '../outside.cjs', sha256: fileHash(outside) };
  assert.throws(() => verifyManifest(s.root, s.manifest, 'fixture-check'), /escapes repository/);
  s.manifest.jobs[0].inputs[0] = { path: 'check.cjs', sha256: fileHash(s.script) };
  s.manifest.jobs[0].network = 'enabled';
  assert.throws(() => verifyManifest(s.root, s.manifest, 'fixture-check'), /disable network/);
  s.manifest.jobs[0].network = 'disabled'; s.manifest.jobs[0].maxConcurrentProcesses = 2;
  assert.throws(() => verifyManifest(s.root, s.manifest, 'fixture-check'), /bound process concurrency/);
  s.manifest.jobs[0].maxConcurrentProcesses = 1; s.manifest.jobs[0].requiresProviderRuntime = 'true';
  assert.throws(() => verifyManifest(s.root, s.manifest, 'fixture-check'), /provider runtime option/);
  s.manifest.jobs[0].requiresProviderRuntime = false; s.manifest.jobs[0].requiresWorkerRuntimeClosure = 'true';
  assert.throws(() => verifyManifest(s.root, s.manifest, 'fixture-check'), /worker runtime option/);
  s.manifest.jobs[0].requiresWorkerRuntimeClosure = true;
  assert.throws(() => verifyManifest(s.root, s.manifest, 'fixture-check'), /Removed worker runtime dependency/);
  s.manifest.jobs[0].requiresWorkerRuntimeClosure = false; s.manifest.jobs[0].allowPinnedChildProcesses = true;
  assert.throws(() => verifyManifest(s.root, s.manifest, 'fixture-check'), /child-process capability is limited/);
});

test('generates deny-by-default Seatbelt policies with workspace-only writes and exact bridge-socket access', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-seatbelt-profile-'));
  const input = path.join(root, 'input'), scratch = path.join(root, 'scratch'), trusted = path.join(root, 'trusted.js');
  fs.mkdirSync(input); fs.mkdirSync(scratch); fs.writeFileSync(trusted, 'trusted');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = makeProfile({ readRoots: [input], writeRoots: [scratch], protectedRead: [trusted], protectedWrite: [trusted], protectedReadPatterns: ['(^|/)\\.env($|/)'], protectedWritePatterns: ['(^|/)\\.env($|/)'], socketPath: '/private/tmp/bridge-policy.sock' });
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(deny file-write\*/);
  assert.match(profile, /\(deny file-read\*/);
  assert.match(profile, /\(deny network\*/);
  assert.match(profile, /path-literal "\/private\/tmp\/bridge-policy\.sock"/);
  assert.doesNotMatch(profile, /network-outbound \(remote ip\)/);
  assert.match(profile, /file-read\* \(regex/);
  assert.match(profile, /file-write\* \(regex/);

  const runnerProfile = makeProfile({ readRoots: [input], writeRoots: [scratch], denyFork: true, execPaths: [process.execPath] });
  assert.doesNotMatch(runnerProfile, /\(allow process-fork\)/);
  assert.match(runnerProfile, /\(allow process-exec/);
  assert.match(runnerProfile, /\(deny network\*\)/);
});
