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

function materializeNodeModules(sourceRepo, workPath) {
  if (typeof sourceRepo !== 'string' || typeof workPath !== 'string' || !path.isAbsolute(sourceRepo) || !path.isAbsolute(workPath)) {
    return { status: 'skipped', reason: 'invalid_paths' };
  }
  const src = path.join(sourceRepo, 'node_modules');
  const dst = path.join(workPath, 'node_modules');
  if (!fs.existsSync(src)) return { status: 'absent' };
  if (fs.existsSync(dst)) {
    try {
      if (fs.lstatSync(dst).isSymbolicLink()) {
        fs.rmSync(dst, { force: true });
      } else {
        return { status: 'present' };
      }
    } catch {
      return { status: 'present' };
    }
  }
  let srcStat;
  try { srcStat = fs.lstatSync(src); } catch { return { status: 'absent' }; }
  if (srcStat.isSymbolicLink()) return { status: 'skipped', reason: 'source_symlink' };
  if (!srcStat.isDirectory()) return { status: 'skipped', reason: 'source_not_directory' };

  if (process.platform === 'darwin') {
    const cloned = spawnSync('/bin/cp', ['-Rc', src, dst], { encoding: 'utf8' });
    if (cloned.status === 0 && fs.existsSync(dst) && !fs.lstatSync(dst).isSymbolicLink()) {
      return { status: 'cloned' };
    }
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* retry with copy */ }
  }

  fs.cpSync(src, dst, { recursive: true });
  if (!fs.existsSync(dst) || fs.lstatSync(dst).isSymbolicLink()) {
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* ignore */ }
    return { status: 'failed', reason: 'materialization_symlink_or_missing' };
  }
  return { status: 'copied' };
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
    let target = candidate;
    try {
      const link = fs.lstatSync(candidate);
      if (link.isSymbolicLink()) {
        target = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
        if (!inside(modulesRoot, target) && !inside(repo, target)) continue;
      }
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
