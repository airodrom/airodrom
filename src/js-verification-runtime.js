'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { classifyCommand } = require('./command-classifier');

// Confined JS/TS verification helpers.
// Seatbelt mission profiles only allow exact process-exec targets and workspace
// read roots. Symlinked node_modules and shebang npm/.bin shims fail closed
// under that boundary; materialize deps into the clone and invoke Node against
// JS entrypoints instead.

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
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
  let bytes = 0, entries = 0;
  function inspect(entry) {
    const stat = fs.lstatSync(entry);
    if (++entries > 200000) throw Error('Dependency file count exceeds bounded inspection');
    bytes += stat.size;
    if (bytes > maxBytes) throw Error('Developer Autonomy disk budget exhausted');
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(entry);
      const relative = path.relative(canonicalRoot, resolved).replaceAll(path.sep, '/');
      if (!inside(canonicalRoot, resolved)
        || /(^|\/)(?:[.]git|[.]runtime|[.]env(?:[.][^/]*)?|[.]ssh|[.]aws|secrets?|credentials?|vault)(\/|$)/i.test(relative)) {
        throw Error('Dependency symlink escapes permitted repository tree');
      }
    } else if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) inspect(path.join(entry, child));
    }
  }
  inspect(root);
  return bytes;
}

function materializeNodeModules(sourceRepo, workPath, { maxBytes = 2048 * 1024 * 1024 } = {}) {
  if (typeof sourceRepo !== 'string' || typeof workPath !== 'string' || !path.isAbsolute(sourceRepo) || !path.isAbsolute(workPath)) {
    return { status: 'skipped', reason: 'invalid_paths' };
  }
  const src = path.join(sourceRepo, 'node_modules');
  const dst = path.join(workPath, 'node_modules');
  if (!fs.existsSync(src)) return { status: 'absent' };
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw Error('Invalid dependency disk budget');
  let current = null;
  try { current = fs.lstatSync(dst); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current) {
    if (current.isSymbolicLink()) fs.rmSync(dst, { force: true });
    else {
      if (!current.isDirectory()) throw Error('Dependency destination is not a directory');
      boundedDependencyBytes(dst, maxBytes, workPath);
      return { status: 'present' };
    }
  }
  let srcStat;
  try { srcStat = fs.lstatSync(src); } catch { return { status: 'absent' }; }
  if (srcStat.isSymbolicLink()) return { status: 'skipped', reason: 'source_symlink' };
  if (!srcStat.isDirectory()) return { status: 'skipped', reason: 'source_not_directory' };
  boundedDependencyBytes(src, maxBytes, sourceRepo);

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
      // realpath resolves chained links, so an escaped .bin script is rejected.
      target = fs.realpathSync(candidate);
      // Workspace packages may live elsewhere inside this same disposable repo.
      // Never follow executable links outside it or into private Git/secret paths.
      const relative = path.relative(repo, target).replaceAll(path.sep, '/');
      if (!inside(repo, target)
        || /(^|\/)(?:[.]git|[.]runtime|[.]env(?:[.][^/]*)?|[.]ssh|[.]aws|secrets?|credentials?|vault)(\/|$)/i.test(relative)) continue;
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
  resolveNpmCli,
  resolveNodeRunnable,
  planPackageManagerInvocation
};
