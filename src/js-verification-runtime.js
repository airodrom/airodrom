'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { classifyCommand } = require('./command-classifier');

function runCpClone(src, dst) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => { if (settled) return; settled = true; resolve(result); };
    let child;
    try {
      child = spawn('/bin/cp', ['-Rc', src, dst], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      return finish({ status: 1, error });
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* best-effort */ }
      finish({ status: 1, timedOut: true });
    }, 600000);
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(0, 400); });
    child.on('error', error => { clearTimeout(timer); finish({ status: 1, error }); });
    child.on('close', status => { clearTimeout(timer); finish({ status: status ?? 1, stderr }); });
  });
}

// Confined JS/TS verification helpers.
// Seatbelt mission profiles only allow exact process-exec targets and workspace
// read roots. Symlinked node_modules and shebang npm/.bin shims fail closed
// under that boundary; materialize deps into the clone and invoke Node against
// JS entrypoints instead.

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Case-sensitive: PascalCase package exports such as effect/Secret must not be
// treated as credential stores. Real vault/secret path segments are lowercase.
// `.env.example` / `.env.sample` / `.env.template` are public templates and must
// remain copyable when packages link to them inside the enrolled repository.
const PRIVATE_DEPENDENCY = /(^|\/)(?:[.]git|[.]runtime|[.]env(?:[.][^/]*)?|[.]ssh|[.]aws|secrets?|credentials?|vault)(\/|$)/;
const PUBLIC_ENV_TEMPLATE = /(^|\/)[.]env[.](?:example|sample|template|dist)(?:\/|$)/;

function privateDependency(root, target) {
  const rel = path.relative(root, target).replaceAll(path.sep, '/');
  if (PUBLIC_ENV_TEMPLATE.test(rel)) return false;
  return PRIVATE_DEPENDENCY.test(rel);
}

// Follow a symlink chain without trusting a final realpath that returned
// through an outside hop. Every hop must remain inside the registered root.
function resolveContained(root, entry) {
  const canonicalRoot = fs.realpathSync(root);
  let current = entry;
  const seen = new Set();
  for (let hop = 0; hop < 32; hop++) {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') throw Error('Dependency symlink target is missing');
      throw Error('Dependency path is unavailable');
    }
    if (!stat.isSymbolicLink()) {
      let canonical;
      try { canonical = fs.realpathSync(current); }
      catch (error) {
        if (error.code === 'ENOENT') throw Error('Dependency symlink target is missing');
        throw Error('Dependency path is unavailable');
      }
      if (!inside(canonicalRoot, canonical) || privateDependency(canonicalRoot, canonical)) {
        throw Error('Dependency symlink escapes permitted repository tree');
      }
      return canonical;
    }
    const id = stat.dev + ':' + stat.ino;
    if (seen.has(id)) throw Error('Dependency symlink cycle');
    seen.add(id);
    let link;
    try { link = fs.readlinkSync(current); }
    catch { throw Error('Dependency path is unavailable'); }
    let parent;
    try { parent = fs.realpathSync(path.dirname(current)); }
    catch { throw Error('Dependency path is unavailable'); }
    if (!inside(canonicalRoot, parent) || privateDependency(canonicalRoot, parent)) {
      throw Error('Dependency symlink escapes permitted repository tree');
    }
    // Resolve from the canonical parent so /var and /private/var cannot disagree.
    const next = path.resolve(parent, link);
    if (!inside(canonicalRoot, next) || privateDependency(canonicalRoot, next)) {
      throw Error('Dependency symlink escapes permitted repository tree');
    }
    current = next;
  }
  throw Error('Dependency symlink chain is too long');
}

function resolveNpmCli(nodePath) {
  if (typeof nodePath !== 'string' || !path.isAbsolute(nodePath)) return null;
  const candidates = [
    path.resolve(path.dirname(nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(fs.realpathSync(nodePath)), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

// Refuse oversized dependency trees and links that escape the isolated tree.
function boundedDependencyBytes(root, maxBytes, allowedRoot = root) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw Error('Invalid dependency disk budget');
  const canonicalRoot = fs.realpathSync(allowedRoot);
  const seen = new Set();
  let bytes = 0, entries = 0;
  function charge(canonical) {
    if (seen.has(canonical)) return;
    seen.add(canonical);
    let stat;
    try { stat = fs.statSync(canonical); }
    catch { throw Error('Dependency path is unavailable'); }
    if (++entries > 200000) throw Error('Dependency file count exceeds bounded inspection');
    // Count the target, not the small size of a symlink directory entry.
    bytes += stat.size;
    if (bytes > maxBytes) throw Error('Developer Autonomy disk budget exhausted');
    if (!stat.isDirectory()) return;
    let children;
    try { children = fs.readdirSync(canonical); }
    catch { throw Error('Dependency path is unavailable'); }
    for (const child of children) inspect(path.join(canonical, child));
  }
  function inspect(entry) {
    let stat;
    try { stat = fs.lstatSync(entry); }
    catch { throw Error('Dependency path is unavailable'); }
    if (stat.isSymbolicLink()) {
      charge(resolveContained(canonicalRoot, entry));
      return;
    }
    let canonical;
    try { canonical = fs.realpathSync(entry); }
    catch { throw Error('Dependency path is unavailable'); }
    if (!inside(canonicalRoot, canonical) || privateDependency(canonicalRoot, canonical)) {
      throw Error('Dependency symlink escapes permitted repository tree');
    }
    charge(canonical);
  }
  inspect(root);
  return bytes;
}

function materializePreconditions(sourceRepo, workPath, maxBytes) {
  if (typeof sourceRepo !== 'string' || typeof workPath !== 'string' || !path.isAbsolute(sourceRepo) || !path.isAbsolute(workPath)) {
    return { early: { status: 'skipped', reason: 'invalid_paths' } };
  }
  const src = path.join(sourceRepo, 'node_modules');
  const dst = path.join(workPath, 'node_modules');
  if (!fs.existsSync(src)) return { early: { status: 'absent' } };
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw Error('Invalid dependency disk budget');
  let current = null;
  try { current = fs.lstatSync(dst); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current) {
    if (current.isSymbolicLink()) fs.rmSync(dst, { force: true });
    else {
      if (!current.isDirectory()) throw Error('Dependency destination is not a directory');
      boundedDependencyBytes(dst, maxBytes, workPath);
      return { early: { status: 'present' } };
    }
  }
  let srcStat;
  try { srcStat = fs.lstatSync(src); } catch { return { early: { status: 'absent' } }; }
  if (srcStat.isSymbolicLink()) return { early: { status: 'skipped', reason: 'source_symlink' } };
  if (!srcStat.isDirectory()) return { early: { status: 'skipped', reason: 'source_not_directory' } };
  // pnpm/yarn external stores link outside the enrolled tree. Refuse to copy those
  // graphs into the disposable clone, but do not abort workspace preparation —
  // verification that needs local modules still fails closed later.
  try {
    boundedDependencyBytes(src, maxBytes, sourceRepo);
  } catch (error) {
    if (/Dependency symlink escapes permitted repository tree/i.test(error.message)) {
      return { early: { status: 'skipped', reason: 'external_store_links' } };
    }
    throw error;
  }
  return { src, dst };
}

function materializeFallbackCopy(src, dst, workPath, maxBytes) {
  try {
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
    if (!fs.existsSync(dst) || fs.lstatSync(dst).isSymbolicLink()) {
      throw Error('Materialized dependencies are missing or symlinked');
    }
    boundedDependencyBytes(dst, maxBytes, workPath);
    return { status: 'copied' };
  } catch (error) {
    fs.rmSync(dst, { recursive: true, force: true });
    throw error;
  }
}

function materializeNodeModules(sourceRepo, workPath, { maxBytes = 2048 * 1024 * 1024 } = {}) {
  const prep = materializePreconditions(sourceRepo, workPath, maxBytes);
  if (prep.early) return prep.early;
  const { src, dst } = prep;

  if (process.platform === 'darwin') {
    const cloned = spawnSync('/bin/cp', ['-Rc', src, dst], { encoding: 'utf8' });
    if (cloned.status === 0 && fs.existsSync(dst) && !fs.lstatSync(dst).isSymbolicLink()) {
      try {
        boundedDependencyBytes(dst, maxBytes, workPath);
        return { status: 'cloned' };
      } catch { /* Retry with relative links preserved by fs.cpSync. */ }
    }
    fs.rmSync(dst, { recursive: true, force: true });
  }

  return materializeFallbackCopy(src, dst, workPath, maxBytes);
}

// Non-blocking materialization for the MCP event loop. clone/copy runs in a
// child process so get_ask_status / agent_status stay responsive during prep.
async function materializeNodeModulesAsync(sourceRepo, workPath, { maxBytes = 2048 * 1024 * 1024 } = {}) {
  const prep = materializePreconditions(sourceRepo, workPath, maxBytes);
  if (prep.early) return prep.early;
  const { src, dst } = prep;

  if (process.platform === 'darwin') {
    const cloned = await runCpClone(src, dst);
    if (cloned.status === 0 && fs.existsSync(dst) && !fs.lstatSync(dst).isSymbolicLink()) {
      try {
        boundedDependencyBytes(dst, maxBytes, workPath);
        return { status: 'cloned' };
      } catch { /* Retry with relative links preserved by fs.cpSync. */ }
    }
    fs.rmSync(dst, { recursive: true, force: true });
  }

  return materializeFallbackCopy(src, dst, workPath, maxBytes);
}

function resolveNodeRunnable(repo, token) {
  if (typeof token !== 'string' || !token || token.includes('\0')) return null;
  const modulesRoot = path.join(repo, 'node_modules');
  const candidates = [];
  if (token === 'node') return { kind: 'node' };
  if (token.startsWith('./') || token.startsWith('../') || token.startsWith('node_modules/')) {
    candidates.push(path.resolve(repo, token));
  } else if (!token.includes('/') && !token.includes('\\')) {
    candidates.push(path.join(modulesRoot, '.bin', token));
  } else return null;

  for (const candidate of candidates) {
    if (!inside(repo, candidate) || !fs.existsSync(candidate)) continue;
    const fromModules = inside(modulesRoot, candidate);
    if (token.startsWith('node_modules/') && !fromModules) continue;
    let target = candidate;
    try {
      // Walk every hop. A chain that leaves the repository and returns is denied.
      target = resolveContained(repo, candidate);
      if (!fs.statSync(target).isFile()) continue;
    } catch { continue; }
    let head = '';
    try { head = fs.readFileSync(target, 'utf8').slice(0, 160); } catch { continue; }
    if (/^#!.*\bnode(?:\s|$)/m.test(head) || /\.[cm]?js$/i.test(target)) return { kind: 'script', file: target };
  }
  return null;
}

function planPackageManagerInvocation(repo, argv, nodePath) {
  if (!Array.isArray(argv) || argv.length < 1 || typeof nodePath !== 'string' || !path.isAbsolute(nodePath)) return null;
  const head = argv[0];
  if (head !== 'npm' && head !== 'pnpm') return null;

  if (argv[1] === 'run' && typeof argv[2] === 'string' && argv[2]) {
    const scriptName = argv[2];
    let passthrough = argv.slice(3);
    if (passthrough[0] === '--') passthrough = passthrough.slice(1);
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); }
    catch { return null; }
    const script = pkg?.scripts?.[scriptName];
    if (typeof script !== 'string' || !script.trim()) return null;
    const classified = classifyCommand(script, { cwd: repo });
    if (!classified.argv) return null;
    const [cmd, ...scriptArgs] = classified.argv;
    if (cmd === 'node') {
      if (!scriptArgs.length) return { file: nodePath, args: passthrough };
      const entry = path.resolve(repo, scriptArgs[0]);
      if (!inside(repo, entry) || !fs.existsSync(entry) || !fs.statSync(entry).isFile()) return null;
      return { file: nodePath, args: [entry, ...scriptArgs.slice(1), ...passthrough] };
    }
    const runnable = resolveNodeRunnable(repo, cmd);
    if (runnable?.kind === 'script') {
      return { file: nodePath, args: [runnable.file, ...scriptArgs, ...passthrough] };
    }
    return null;
  }

  const npmCli = resolveNpmCli(nodePath);
  if (!npmCli) return null;
  return { file: nodePath, args: [npmCli, ...argv.slice(1)] };
}

module.exports = {
  materializeNodeModules,
  materializeNodeModulesAsync,
  resolveNpmCli,
  resolveNodeRunnable,
  planPackageManagerInvocation
};
