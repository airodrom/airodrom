'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { readManifest, verifyExecutable, makeProfile, makeRuntimeDeny, sanitizedRuntimeEnv, SECRET_COMPONENT_PATTERN } = require('./worker-sandbox');

const TRUSTED_DEV_JOBS = new Set([
  'git_status', 'git_diff', 'git_diff_check', 'git_log', 'git_show', 'git_branch', 'git_head', 'git_ls_files', 'git_grep',
  'focused_test', 'npm_script', 'npm_install', 'npm_ci', 'git_add', 'git_commit'
]);
const READ_ONLY_GIT_JOBS = new Set(['git_status', 'git_diff', 'git_diff_check', 'git_log', 'git_show', 'git_branch', 'git_head', 'git_ls_files', 'git_grep']);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const TRUSTED_DEV_READ_SECRET_COMPONENT_PATTERN = String.raw`(^|/)(\.pi|\.codex|\.bridge|\.ssh|\.aws|\.gnupg|\.config|\.npmrc|\.netrc|\.pypirc|\.env(\.[^/]*)?|credentials(\.[^/]*)?|secrets?(\.[^/]*)?|auth\.json|id_(rsa|ed25519|ecdsa)|[^/]*\.(pem|key|p12|pfx))(/|$)`;

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function exactKeys(value, required, optional = []) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function relativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && !path.isAbsolute(value) &&
    value.split(/[\\/]/).every(part => part && part !== '.' && part !== '..' && !/^\.git(?:$|$)/i.test(part));
}
function canonicalFile(workspace, relative, { testOnly = false } = {}) {
  if (!relativePath(relative)) throw new Error('Trusted development path must be project-relative');
  const root = fs.realpathSync(workspace);
  const lexical = path.resolve(root, relative);
  const target = fs.realpathSync(lexical);
  const stat = fs.lstatSync(target);
  if (!contained(root, target) || target !== lexical || stat.isSymbolicLink() || !stat.isFile()) throw new Error('Trusted development path is not a canonical regular workspace file');
  const normalized = path.relative(root, target).split(path.sep).join('/');
  if (testOnly && (!normalized.startsWith('tests/') || !/\.test\.(?:[cm]?js)$/u.test(normalized))) throw new Error('Focused tests must name an existing project-relative tests/*.test.js file');
  return normalized;
}
function explicitCommitRequested(task) {
  const text = [task?.description, task?.mission?.objective, task?.mission?.request].filter(value => typeof value === 'string').join('\n');
  return /\b(?:git\s+commit|commit(?:\s+(?:the|these|my|all|task|changes?))?)\b/i.test(text);
}
function validateTrustedDevJobInput(task, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.jobName !== 'string' || !TRUSTED_DEV_JOBS.has(input.jobName)) throw new Error('Trusted development job is not approved');
  const name = input.jobName;
  const required = name === 'focused_test' ? ['jobName', 'target'] : name === 'git_grep' ? ['jobName', 'query'] : name === 'npm_script' ? ['jobName', 'script'] : name === 'git_add' ? ['jobName', 'paths'] : name === 'git_commit' ? ['jobName', 'message'] : ['jobName'];
  if (!exactKeys(input, required)) throw new Error('Trusted development job arguments are invalid');
  if (name === 'focused_test') canonicalFile(task.workspace, input.target, { testOnly: true });
  if (name === 'git_grep' && (typeof input.query !== 'string' || !input.query || input.query.length > 512 || input.query.includes('\0'))) throw new Error('Trusted development git search is invalid');
  if (name === 'npm_script') {
    if (typeof input.script !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(input.script)) throw new Error('Trusted development npm script is invalid');
    const packageJson = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(task.workspace), 'package.json'), 'utf8'));
    if (!packageJson.scripts || typeof packageJson.scripts[input.script] !== 'string') throw new Error('Trusted development npm script is not declared by this project');
  }
  if (name === 'git_add') {
    if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 32) throw new Error('Trusted development git add paths are invalid');
    const written = new Set(task.trustedDeveloperFiles || []);
    for (const candidate of input.paths) if (typeof candidate !== 'string' || !written.has(canonicalFile(task.workspace, candidate))) throw new Error('Git add is limited to files written or edited by this task');
  }
  if (name === 'git_commit') {
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 200 || /[\0\r\n]/.test(input.message)) throw new Error('Trusted development commit message is invalid');
    if (!explicitCommitRequested(task)) throw new Error('Git commit requires an explicit commit request in the original ChatGPT task');
  }
  return { ...input };
}
function commandFor(task, input, { nodePath, gitPath, npmCli }) {
  const git = (...args) => ({ executable: gitPath, args: ['-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', ...args], writable: !READ_ONLY_GIT_JOBS.has(input.jobName) });
  switch (input.jobName) {
    case 'git_status': return git('status', '--short', '--branch');
    case 'git_diff': return git('diff', '--no-ext-diff', '--');
    case 'git_diff_check': return git('diff', '--check', '--no-ext-diff', '--');
    case 'git_log': return git('log', '-n', '50', '--no-decorate', '--format=%H %s');
    case 'git_show': return git('show', '--no-ext-diff', '--format=medium', '--stat', 'HEAD');
    case 'git_branch': return git('branch', '--show-current');
    case 'git_head': return git('rev-parse', 'HEAD');
    case 'git_ls_files': return git('ls-files', '--');
    case 'git_grep': return git('grep', '-n', '-F', '--', input.query);
    case 'focused_test': return { executable: nodePath, args: ['--experimental-sqlite', '--test', canonicalFile(task.workspace, input.target, { testOnly: true })], writable: true };
    case 'npm_script': return { executable: nodePath, args: [npmCli, 'run', input.script, '--ignore-scripts'], writable: true };
    case 'npm_install': return { executable: nodePath, args: [npmCli, 'install', '--ignore-scripts'], writable: true };
    case 'npm_ci': return { executable: nodePath, args: [npmCli, 'ci', '--ignore-scripts'], writable: true };
    case 'git_add': return git('add', '--', ...input.paths.map(item => canonicalFile(task.workspace, item)));
    case 'git_commit': return { executable: gitPath, args: ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'core.pager=cat', 'commit', '--no-verify', '-m', input.message], writable: true };
    default: throw new Error('Trusted development job is not approved');
  }
}

class TrustedDeveloperRunner {
  constructor({ repoRoot, dataDir, manifestPath, sandboxExec = '/usr/bin/sandbox-exec', spawnImpl = spawn } = {}) {
    this.repoRoot = fs.realpathSync(repoRoot || path.resolve(__dirname, '..'));
    this.dataDir = path.resolve(dataDir || path.join(this.repoRoot, '.runtime'));
    this.manifestPath = manifestPath;
    this.sandboxExec = sandboxExec;
    this.spawnImpl = spawnImpl;
  }

  describe(task, input) {
    const checked = validateTrustedDevJobInput(task, input);
    return { name: checked.jobName, kind: 'trusted-development', readOnly: READ_ONLY_GIT_JOBS.has(checked.jobName) };
  }

  async run(task, input, { signal } = {}) {
    const checked = validateTrustedDevJobInput(task, input);
    const manifest = readManifest(this.manifestPath);
    const executable = id => verifyExecutable(manifest.executables.find(entry => entry.id === id));
    const nodePath = executable('node');
    const sandboxPath = executable('sandbox-exec');
    if (sandboxPath !== fs.realpathSync(this.sandboxExec)) throw new Error('Pinned trusted development sandbox executable mismatch');
    const directXcodeGit = '/Applications/Xcode.app/Contents/Developer/usr/bin/git';
    const gitPath = fs.realpathSync(fs.existsSync(directXcodeGit) ? directXcodeGit : '/usr/bin/git');
    const npmCli = path.resolve(path.dirname(nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.statSync(npmCli).isFile()) throw new Error('Pinned Node npm CLI is unavailable');
    const command = commandFor(task, checked, { nodePath, gitPath, npmCli });
    const workspace = fs.realpathSync(task.workspace);
    const sessionRoot = path.join(task.sessionDir, 'trusted-dev-jobs', crypto.randomUUID());
    const scratchRoot = path.join(sessionRoot, 'scratch');
    fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    const protectedPaths = [path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.gnupg'), path.join(os.homedir(), '.aws'), path.join(os.homedir(), '.pi'), path.join(os.homedir(), '.config'), path.join(os.homedir(), 'Library/Keychains')].filter(item => fs.existsSync(item));
    const developerReadRoots = ['/Library/Developer'];
    const xcodeContentsRoot = '/Applications/Xcode.app/Contents';
    if (fs.existsSync(xcodeContentsRoot)) developerReadRoots.push(xcodeContentsRoot);
    const profile = `${makeProfile({
      readRoots: [workspace, task.sessionDir, path.dirname(nodePath), '/System', '/usr/lib', '/usr/share', '/usr/bin', '/bin', '/sbin', '/opt/homebrew', '/usr/local', ...developerReadRoots, '/dev'],
      writeRoots: command.writable ? [workspace, scratchRoot] : [scratchRoot], protectedRead: protectedPaths, protectedWrite: protectedPaths,
      protectedReadPatterns: [TRUSTED_DEV_READ_SECRET_COMPONENT_PATTERN], protectedWritePatterns: [SECRET_COMPONENT_PATTERN], denyFork: false
    })}${makeRuntimeDeny({ runtimeRoot: this.dataDir, sessionDir: task.sessionDir, workspace })}`;
    const profilePath = path.join(sessionRoot, 'trusted-dev.sb');
    fs.writeFileSync(profilePath, profile, { mode: 0o600, flag: 'wx' });
    const env = sanitizedRuntimeEnv({
      HOME: path.join(scratchRoot, 'home'), TMPDIR: path.join(scratchRoot, 'tmp'), LANG: 'C', PATH: `${path.dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat', npm_config_cache: path.join(scratchRoot, 'npm-cache')
    });
    fs.mkdirSync(env.HOME, { recursive: true, mode: 0o700 }); fs.mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
    try {
      return await this._spawn([ '-f', profilePath, command.executable, ...command.args ], { cwd: workspace, env, signal, name: checked.jobName });
    } finally {
      fs.rmSync(sessionRoot, { recursive: true, force: true });
    }
  }

  _spawn(args, { cwd, env, signal, name }) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.sandboxExec, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', bytes = 0, timedOut = false, settled = false;
      const append = chunk => { if (settled) return; bytes += Buffer.byteLength(chunk); if (bytes > MAX_OUTPUT_BYTES) return finish(new Error('Trusted development job output limit exceeded')); output += String(chunk); };
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', abort); if (error) { child.kill?.('SIGTERM'); reject(error); } };
      const abort = () => finish(new Error('Trusted development job cancelled'));
      const timer = setTimeout(() => { timedOut = true; finish(new Error('Trusted development job timed out')); }, MAX_TIMEOUT_MS);
      signal?.addEventListener?.('abort', abort, { once: true });
      child.stdout?.on('data', append); child.stderr?.on('data', append);
      child.once('error', finish);
      child.once('close', (exitCode, exitSignal) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', abort); resolve({ name, kind: 'trusted-development', exitCode: Number.isInteger(exitCode) ? exitCode : 1, signal: exitSignal || null, timedOut, output: output.slice(0, MAX_OUTPUT_BYTES) }); });
    });
  }
}

module.exports = { TRUSTED_DEV_JOBS, READ_ONLY_GIT_JOBS, TrustedDeveloperRunner, validateTrustedDevJobInput, explicitCommitRequested, commandFor, canonicalFile };
