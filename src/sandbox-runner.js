'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { MANIFEST_PATH, readManifest, verifyManifest, verifyExecutable, verifyRuntimeLibraries, verifyRuntimeConfigInputs, sanitizedRuntimeEnv, makeProfile } = require('./sandbox-policy');

const MANIFEST_SNAPSHOT_PATH = 'config/safe-autonomy-manifest.json';
function hashBytes(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hashFile(file) { return hashBytes(fs.readFileSync(file)); }
function contained(root, target) { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }

function captureManifestSnapshot(file) {
  const bytes = fs.readFileSync(file);
  const sha256 = hashBytes(bytes);
  const manifest = readManifest(file);
  if (hashFile(file) !== sha256) throw new Error('Pinned job manifest changed while capturing');
  return { path: MANIFEST_SNAPSHOT_PATH, bytes, sha256, manifest };
}

function copyPinnedInputs(inputRoot, inputs, stageRoot, snapshots = []) {
  const destinationFor = relativePath => {
    const destination = path.join(stageRoot, relativePath);
    if (!contained(stageRoot, destination)) throw new Error(`Staged input path escapes runner root: ${relativePath}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    return destination;
  };
  for (const input of inputs) {
    const destination = destinationFor(input.path);
    fs.copyFileSync(input.lexical, destination, fs.constants.COPYFILE_EXCL);
    if (hashFile(destination) !== input.sha256) throw new Error(`Staged input changed while copying: ${input.path}`);
    fs.chmodSync(destination, 0o444);
  }
  for (const snapshot of snapshots) {
    if (!snapshot || snapshot.path !== MANIFEST_SNAPSHOT_PATH || !Buffer.isBuffer(snapshot.bytes) || !/^[a-f0-9]{64}$/.test(snapshot.sha256) || hashBytes(snapshot.bytes) !== snapshot.sha256) throw new Error('Invalid sandbox manifest snapshot');
    const destination = destinationFor(snapshot.path);
    fs.writeFileSync(destination, snapshot.bytes, { mode: 0o600, flag: 'wx' });
    if (hashFile(destination) !== snapshot.sha256) throw new Error('Staged manifest snapshot hash mismatch');
    fs.chmodSync(destination, 0o444);
  }
  const dirs = [];
  for (const input of [...inputs, ...snapshots]) {
    let dir = path.dirname(path.join(stageRoot, input.path));
    while (contained(stageRoot, dir) && dir !== stageRoot) { dirs.push(dir); dir = path.dirname(dir); }
  }
  for (const dir of [...new Set(dirs)].sort((a, b) => b.length - a.length)) fs.chmodSync(dir, 0o555);
  fs.chmodSync(stageRoot, 0o555);
}

const LIMITS = Object.freeze({ maxWallMs: 120_000, maxJobWallMs: 120_000, maxOutputBytes: 2 * 1024 * 1024, maxSteps: 64, maxScratchBytes: 256 * 1024 * 1024 });
const SCRATCH_DIAGNOSTIC_LIMITS = Object.freeze({ maxEntries: 2048, maxDepth: 8, maxResults: 10, maxTextLength: 2048 });

function scratchRelativePath(root, file) {
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => !part || part === '.' || part === '..')) throw new Error('Scratch diagnostic path escapes runner scratch');
  return relative.split(path.sep).join('/');
}

function scratchFailure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function scratchSymlinkFailure() { return scratchFailure('Sandbox scratch symlinks are forbidden', 'ELOOP'); }
function scratchFilesystem(fsImpl) {
  if (!fsImpl || typeof fsImpl.lstatSync !== 'function' || typeof fsImpl.readdirSync !== 'function') throw new Error('Invalid scratch filesystem adapter');
  return fsImpl;
}
function scratchLstat(fsImpl, file, { allowEnotdir = false, allowEnoent = true } = {}) {
  try { return fsImpl.lstatSync(file); }
  catch (error) { if ((allowEnoent && error?.code === 'ENOENT') || (allowEnotdir && error?.code === 'ENOTDIR')) return null; throw error; }
}
function scratchDirectoryEntries(fsImpl, directory, { allowEnoent = true } = {}) {
  // ENOTDIR is a benign race here only because this directory was just
  // lstat-verified as a directory by scanScratch().
  try { return fsImpl.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if ((allowEnoent && error?.code === 'ENOENT') || error?.code === 'ENOTDIR') return null; throw error; }
}

function scanScratch(scratchRoot, { maxEntries = Infinity, maxDepth = Infinity, onFile, fsImpl = fs } = {}) {
  const filesystem = scratchFilesystem(fsImpl);
  const root = path.resolve(scratchRoot);
  const rootStat = scratchLstat(filesystem, root, { allowEnoent: false });
  if (!rootStat) throw scratchFailure('Sandbox scratch root disappeared', 'ENOENT');
  if (rootStat.isSymbolicLink()) throw scratchSymlinkFailure();
  if (!rootStat.isDirectory()) throw scratchFailure('Sandbox scratch root is unsafe', 'ENOTDIR');
  let visited = 0, truncated = false;
  const walk = (directory, depth, wasVerifiedDirectory, isRoot = false) => {
    if (depth >= maxDepth) { truncated = true; return; }
    const stat = scratchLstat(filesystem, directory, { allowEnotdir: wasVerifiedDirectory, allowEnoent: !isRoot });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw scratchSymlinkFailure();
    if (!stat.isDirectory()) {
      // A child first seen as a directory can become a file before recursion.
      if (wasVerifiedDirectory) return;
      throw scratchFailure('Sandbox scratch root is unsafe', 'ENOTDIR');
    }
    const directoryEntries = scratchDirectoryEntries(filesystem, directory, { allowEnoent: !isRoot });
    if (!directoryEntries) return;
    for (const entry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (visited >= maxEntries) { truncated = true; return; }
      visited++;
      const file = path.join(directory, entry.name);
      // The parent was lstat-verified and read as a directory. ENOTDIR can
      // therefore only describe a concurrent parent file↔directory race.
      const childStat = scratchLstat(filesystem, file, { allowEnotdir: true });
      if (!childStat) continue;
      if (childStat.isSymbolicLink()) throw scratchSymlinkFailure();
      if (childStat.isDirectory()) walk(file, depth + 1, true);
      else onFile?.(file, childStat);
    }
  };
  walk(root, 0, false, true);
  return { root, visited, truncated };
}

function summarizeScratch(scratchRoot, limits = SCRATCH_DIAGNOSTIC_LIMITS, fsImpl = fs) {
  const settings = { ...SCRATCH_DIAGNOSTIC_LIMITS, ...limits };
  for (const [key, maximum] of Object.entries(SCRATCH_DIAGNOSTIC_LIMITS)) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1 || settings[key] > maximum) throw new Error('Invalid scratch diagnostic limits');
  }
  const candidates = [];
  const scan = scanScratch(scratchRoot, {
    maxEntries: settings.maxEntries,
    maxDepth: settings.maxDepth,
    fsImpl,
    onFile(file, stat) {
      if (stat.isFile()) candidates.push({ path: scratchRelativePath(path.resolve(scratchRoot), file), bytes: stat.size });
    }
  });
  const ranked = candidates.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path)).slice(0, settings.maxResults);
  const entries = [];
  let text = 'scratch-largest=', truncated = scan.truncated;
  for (const item of ranked) {
    const part = `${item.path}=${item.bytes}`;
    const separator = entries.length ? ',' : '';
    if (Buffer.byteLength(`${text}${separator}${part};truncated`, 'utf8') > settings.maxTextLength) { truncated = true; break; }
    entries.push(item); text += `${separator}${part}`;
  }
  if (!entries.length) text += 'none';
  if (truncated) text += ';truncated';
  return { entries, visited: scan.visited, truncated, text };
}

function scratchInspectionCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'UNKNOWN';
}
function scratchInspectionError(code) { return new Error(`Sandbox scratch inspection failed; code=${code}`); }

function scratchQuotaError(summary) {
  return new Error(`Sandbox scratch output limit exceeded${summary?.text ? `; ${summary.text}` : ''}`);
}

class SandboxRunner {
  constructor({ repoRoot, manifestPath = MANIFEST_PATH, sandboxExec = '/usr/bin/sandbox-exec', spawnImpl = spawn, tempRoot = os.tmpdir() } = {}) {
    this.repoRoot = fs.realpathSync(repoRoot || path.resolve(__dirname, '..'));
    this.manifestPath = manifestPath; this.sandboxExec = sandboxExec; this.spawnImpl = spawnImpl; this.tempRoot = tempRoot;
  }

  // The broker uses this host-side preflight to map a named job to its grant
  // capability. It verifies every input and executable pin without launching.
  describeJob(jobName) {
    const manifest = readManifest(this.manifestPath);
    const verified = verifyManifest(this.repoRoot, manifest, jobName);
    const manifestSha256 = hashFile(this.manifestPath);
    return { name: jobName, kind: verified.job.kind, manifestSha256, inputHashes: verified.inputs.map(item => ({ path: item.path, sha256: item.sha256 })) };
  }

  async run(jobName, { expectedManifestSha256 } = {}) {
    if (process.platform !== 'darwin') throw new Error('Pinned OS sandbox runner is unavailable on this platform');
    const manifestSnapshot = captureManifestSnapshot(this.manifestPath);
    if (expectedManifestSha256 && manifestSnapshot.sha256 !== expectedManifestSha256) throw new Error('Pinned job manifest changed after broker authorization');
    const manifest = manifestSnapshot.manifest;
    const requestedJob = manifest.jobs.find(entry => entry?.name === jobName);
    if (requestedJob?.inputs?.some(input => input?.path === MANIFEST_SNAPSHOT_PATH)) throw new Error('Sandbox manifest must not be a normal staged input');
    const verified = verifyManifest(this.repoRoot, manifest, jobName);
    if (hashFile(this.manifestPath) !== manifestSnapshot.sha256) throw new Error('Pinned job manifest changed during verification');
    if (verified.steps.length > LIMITS.maxSteps || verified.job.timeoutMs > LIMITS.maxWallMs || verified.job.maxOutputBytes > LIMITS.maxOutputBytes) throw new Error('Sandbox job exceeds the host runner limits');
    const executablePins = new Map(manifest.executables.map(entry => [entry.id, entry]));
    const sandboxExecPin = executablePins.get('sandbox-exec');
    if (!sandboxExecPin || fs.realpathSync(sandboxExecPin.path) !== fs.realpathSync(this.sandboxExec)) throw new Error('Pinned sandbox launcher mismatch');
    const runRoot = fs.mkdtempSync(path.join(this.tempRoot, 'airodrom-sandbox-run-'));
    const stageRoot = path.join(runRoot, 'input');
    const scratchRoot = path.join(runRoot, 'scratch');
    const tmpDir = path.join(scratchRoot, 'tmp');
    fs.mkdirSync(stageRoot, { mode: 0o700 }); fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    let preserveBuildOutput = false;
    try {
      this._stageInputs(stageRoot, verified.inputs, manifestSnapshot);
      if (hashFile(this.manifestPath) !== manifestSnapshot.sha256) throw new Error('Pinned job manifest changed during staging');
      const profilePath = path.join(runRoot, 'runner.sb');
      const nodeExe = manifest.executables.find(item => item.id === 'node');
      const nodePath = verifyExecutable(nodeExe);
      const nodeRoot = path.dirname(nodePath);
      const runtimeReadFiles = [...verifyRuntimeLibraries(manifest.runtimeLibraries), ...verifyRuntimeConfigInputs(manifest.runtimeConfig)].flatMap(input => input.paths);
      const shellPin = manifest.executables.find(item => item.id === 'sh');
      if (!shellPin) throw new Error('Pinned resource-limit shell is missing');
      const shellPath = verifyExecutable(shellPin);
      const bashPin = manifest.executables.find(item => item.id === 'bash');
      if (!bashPin) throw new Error('Pinned sh execution variant is missing');
      const bashPath = verifyExecutable(bashPin);
      if (bashPath !== fs.realpathSync('/bin/bash')) throw new Error('Pinned sh execution variant mismatch');
      const profile = makeProfile({ readRoots: [stageRoot, nodeRoot, '/System', '/usr/lib', '/usr/share', '/usr/bin/env', '/bin', '/sbin', '/Library/Apple', '/dev'], exactReadFiles: runtimeReadFiles, writeRoots: [scratchRoot], denyFork: true, allowForkWithExactExec: verified.job.allowPinnedChildProcesses === true, execPaths: [nodePath, shellPath, bashPath] });
      fs.writeFileSync(profilePath, profile, { mode: 0o600, flag: 'wx' });
      const output = [];
      const jobStartedAt = Date.now();
      let outputBytes = 0, timedOut = false, overflow = false;
      for (let index = 0; index < verified.steps.length; index++) {
        const remainingJobMs = LIMITS.maxJobWallMs - (Date.now() - jobStartedAt);
        if (remainingJobMs <= 0) throw new Error('Sandbox total job time limit exceeded');
        const step = verified.steps[index];
        const executablePin = executablePins.get(step.executableId);
        if (fs.realpathSync(executablePin.path) !== step.executable) throw new Error('Executable changed after manifest validation');
        const stepTimeoutMs = Math.min(verified.job.timeoutMs, remainingJobMs);
        const cpuSeconds = Math.max(1, Math.ceil(stepTimeoutMs / 1000));
        const shell = '/bin/sh';
        if (fs.realpathSync(shellPin.path) !== fs.realpathSync(shell)) throw new Error('Pinned resource-limit shell mismatch');
        const limitScript = `ulimit -t ${cpuSeconds} || exit 91; ulimit -f 262144 || exit 92; ulimit -n 128 || exit 93; exec "$@"`;
        const args = ['-f', profilePath, shell, '-c', limitScript, 'sandbox-step', step.executable, ...step.args];
        const env = sanitizedRuntimeEnv({ PATH: `${nodeRoot}:/usr/bin:/bin`, HOME: path.join(scratchRoot, 'home'), TMPDIR: tmpDir, LANG: 'C', CI: '1', ...(verified.job.kind === 'test' ? { NODE_ENV: 'test' } : {}) });
        fs.mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
        const result = await this._runStep(args, { cwd: stageRoot, env, timeoutMs: stepTimeoutMs, maxOutputBytes: verified.job.maxOutputBytes, scratchRoot, maxScratchBytes: LIMITS.maxScratchBytes, output, onOutput(bytes) { outputBytes += bytes; if (outputBytes > verified.job.maxOutputBytes) overflow = true; }, onTimeout() { timedOut = true; } });
        if (overflow) throw new Error('Sandbox output limit exceeded');
        if (result.inspectionCode) throw scratchInspectionError(result.inspectionCode);
        if (result.resourceExceeded) throw scratchQuotaError(result.scratchSummary);
        if (result.exitCode !== 0) return { name: jobName, kind: verified.job.kind, exitCode: result.exitCode, signal: result.signal, timedOut, output: output.join(''), inputHashes: verified.inputs.map(item => ({ path: item.path, sha256: item.sha256 })) };
      }
      let scratchBytes;
      try { scratchBytes = this._directoryBytes(scratchRoot); }
      catch (error) { throw scratchInspectionError(scratchInspectionCode(error)); }
      if (scratchBytes > LIMITS.maxScratchBytes) {
        let scratchSummary;
        try { scratchSummary = summarizeScratch(scratchRoot); }
        catch (error) { throw scratchInspectionError(scratchInspectionCode(error)); }
        throw scratchQuotaError(scratchSummary);
      }
      preserveBuildOutput = verified.job.kind === 'build';
      return { name: jobName, kind: verified.job.kind, exitCode: 0, signal: null, timedOut: false, output: output.join(''), runRoot, scratchRoot, inputHashes: verified.inputs.map(item => ({ path: item.path, sha256: item.sha256 })) };
    } finally {
      // Staged inputs and scratch are newly created unique fixtures; remove only
      // this runner-owned directory. Do not traverse symlinks outside it.
      if (!preserveBuildOutput) this._removeRunRoot(runRoot);
    }
  }

  _stageInputs(stageRoot, inputs, manifestSnapshot) {
    copyPinnedInputs(this.repoRoot, inputs, stageRoot, [manifestSnapshot]);
  }

  _removeRunRoot(root) {
    const dirs = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) { walk(file); dirs.push(file); }
      }
    };
    walk(root);
    for (const dir of dirs.reverse()) fs.chmodSync(dir, 0o700);
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }

  _directoryBytes(root, fsImpl = fs) {
    let total = 0;
    scanScratch(root, { fsImpl, onFile(file, stat) { total += stat.size; } });
    return total;
  }

  _runStep(args, { cwd, env, timeoutMs, maxOutputBytes, scratchRoot, maxScratchBytes, output, onOutput, onTimeout }) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawnImpl(this.sandboxExec, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { reject(error); return; }
      let bytes = 0, timedOut = false, resourceExceeded = false, scratchSummary = null, inspectionCode = null;
      const kill = signal => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
      const collect = stream => stream.on('data', chunk => {
        bytes += chunk.length; onOutput(chunk.length);
        if (bytes > maxOutputBytes) { kill('SIGKILL'); return; }
        output.push(chunk.toString('utf8'));
      });
      collect(child.stdout); collect(child.stderr);
      const timer = setTimeout(() => { timedOut = true; onTimeout(); kill('SIGKILL'); }, timeoutMs);
      const monitor = setInterval(() => {
        if (resourceExceeded || inspectionCode) return;
        try {
          if (this._directoryBytes(scratchRoot) > maxScratchBytes) {
            try { scratchSummary = summarizeScratch(scratchRoot); }
            catch (error) { inspectionCode = scratchInspectionCode(error); kill('SIGKILL'); return; }
            resourceExceeded = true;
            kill('SIGKILL');
          }
        } catch (error) { inspectionCode = scratchInspectionCode(error); kill('SIGKILL'); }
      }, 25);
      child.once('error', error => { clearTimeout(timer); clearInterval(monitor); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); clearInterval(monitor); resolve({ exitCode: code ?? (signal ? 1 : 0), signal, timedOut, resourceExceeded, scratchSummary, inspectionCode }); });
    });
  }
}

module.exports = { SandboxRunner, LIMITS, SCRATCH_DIAGNOSTIC_LIMITS, MANIFEST_SNAPSHOT_PATH, copyPinnedInputs, contained, summarizeScratch, scanScratch };

if (require.main === module) {
  const job = process.argv[2];
  if (!job || process.argv.length !== 3) { process.stderr.write('usage: node src/sandbox-runner.js <approved-job-name>\n'); process.exitCode = 64; }
  else new SandboxRunner().run(job).then(result => {
    process.stdout.write(result.output);
    process.stdout.write(`\nSANDBOX_RESULT ${JSON.stringify({ name: result.name, kind: result.kind, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, inputHashes: result.inputHashes })}\n`);
    process.exitCode = result.exitCode;
  }).catch(error => { process.stderr.write(`SANDBOX_DENIED: ${error.message}\n`); process.exitCode = 1; });
}
