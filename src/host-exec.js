'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';
const MAX_OUTPUT = 512 * 1024;
function isInternalHelper(file) {
  const { HELPER } = require('./slack-credentials');
  if (path.resolve(file) === HELPER || path.basename(file) === 'airodrom-slack-keychain') return true;
  try {
    const crypto = require('node:crypto');
    const digest = name => crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex');
    return fs.realpathSync(file) === fs.realpathSync(HELPER) || (fs.statSync(file).size === fs.statSync(HELPER).size && digest(file) === digest(HELPER));
  } catch { return false; }
}


// Every host adapter executes through this boundary: absolute allowlisted
// executables, argv arrays only (never a shell), a scrubbed environment with no
// inherited credentials, bounded time and bounded output.
class HostExecutor {
  constructor({ allowed = [], home = os.homedir(), spawnImpl = spawn } = {}) {
    Object.defineProperty(this, 'executionDomain', { value: 'worker', enumerable: true });
    this.allowed = new Set(allowed.map(file => path.resolve(file)));
    this.home = home;
    this.spawnImpl = spawnImpl;
  }

  processBoundary(file, args, execDependencies = [], missionAuthority = null, allowGitMetadata = false) {
    if (!Array.isArray(execDependencies)||execDependencies.length>4)throw Error('Invalid executable dependency pins');
    for(const pin of execDependencies){if(!pin||!path.isAbsolute(pin.path)||isInternalHelper(pin.path)||require('./verification-runtime').digest(pin.path)!==pin.sha256)throw Error('Executable dependency pin mismatch');}
    if (missionAuthority && (process.platform !== 'darwin' || this.spawnImpl !== spawn)) throw Error('Mission process sandbox is unqualified');
    if (process.platform !== 'darwin' || this.spawnImpl !== spawn) return { file, args };
    if (missionAuthority && file === '/usr/bin/git') {
      const directGit = '/Applications/Xcode.app/Contents/Developer/usr/bin/git';
      if (!fs.existsSync(directGit)) throw Error('Direct Git runtime is unqualified for mission sandbox');
      file = fs.realpathSync(directGit);
    }
    const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
    const { HELPER } = require('./slack-credentials');
    const helperDirectory = path.dirname(HELPER);
    const exact = [...new Set([file, process.execPath, ...this.allowed, ...execDependencies.map(p=>p.path)])].filter(candidate => fs.existsSync(candidate) && !isInternalHelper(candidate));
    // Seatbelt matches canonical paths. Xcode.app may be a symlink to a
    // versioned installation; keep the same trusted roots, resolving aliases
    // before admitting their children. Unavailable roots grant nothing.
    const executableRoots = ['/bin', '/usr/bin', '/sbin', '/usr/sbin', '/Applications/Xcode.app/Contents/Developer/usr/bin', '/Applications/Xcode.app/Contents/Developer/usr/libexec'].flatMap(root => {
      try { return fs.statSync(root).isDirectory() ? [fs.realpathSync(root)] : []; } catch { return []; }
    });
    const filters = [...exact.map(candidate => `(literal ${quote(fs.realpathSync(candidate))})`), ...executableRoots.map(root => `(subpath ${quote(root)})`)];
    if (missionAuthority) {
      const valid = require('./mission-permissions').checkAuthority(missionAuthority);
      if (!valid.allow) throw Error(valid.reason);
      const {makeProfile,SECRET_COMPONENT_PATTERN} = require('./sandbox-policy');
      const secretPattern = SECRET_COMPONENT_PATTERN.replace(String.raw`\.git|`, '');
      const privatePatterns = [secretPattern, '(^|/)[.]runtime(/|$)'];
      const runtimeRoots = ['/var/empty','/Applications/Xcode.app/Contents','/Library/Developer','/System','/usr/lib','/usr/share','/usr/bin','/bin','/sbin','/Library/Apple','/opt/homebrew','/usr/local','/dev',path.dirname(file),path.dirname(process.execPath)];
      const bounded = makeProfile({readRoots:[...missionAuthority.filesystem.read,...runtimeRoots],writeRoots:missionAuthority.filesystem.write,protectedReadPatterns:privatePatterns,protectedWritePatterns:[...privatePatterns,...(allowGitMetadata?[]:['(^|/)[.]git(/|$)'])],allowLoopbackNetwork:missionAuthority.permissions.network.includes('localhost'),allowForkWithExactExec:true,execPaths:[...exact,...['/usr/bin/xcrun','/Applications/Xcode.app/Contents/Developer/usr/bin/git'].filter(candidate=>fs.existsSync(candidate))]});
      const immutable = exact.map(candidate => `(deny file-write* (literal ${quote(fs.realpathSync(candidate))}))`).join('\n');
      return {file:'/usr/bin/sandbox-exec',args:['-p',bounded+'\n'+immutable,file,...args]};
    }
    const profile = `(version 1) (allow default)
      (deny process-exec (require-not (require-any ${filters.join(' ')})))
      (deny process-exec (subpath ${quote(helperDirectory)}))
      (deny file-read* file-write* (subpath ${quote(helperDirectory)}))
      ${exact.map(candidate => `(deny file-write* (literal ${quote(fs.realpathSync(candidate))}))`).join('\n')}`;
    return { file: '/usr/bin/sandbox-exec', args: ['-p', profile, file, ...args] };
  }

  allow(file) { if (typeof file === 'string' && path.isAbsolute(file)) this.allowed.add(path.resolve(file)); return this; }

  resolveFirst(candidates) {
    for (const candidate of candidates) {
      const file = candidate.startsWith('~/') ? path.join(this.home, candidate.slice(2)) : candidate;
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* try the next fixed candidate */ }
    }
    return null;
  }

  env(extra = {}) {
    const base = { PATH: SAFE_PATH, HOME: this.home, USER: os.userInfo().username, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TMPDIR: os.tmpdir(), NO_COLOR: '1', TERM: 'dumb' };
    for (const [key, value] of Object.entries(extra)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid child environment entry');
      base[key] = value;
    }
    return base;
  }

  run(file, args = [], { cwd = this.home, timeoutMs = 20_000, input = null, env = {}, maxOutput = MAX_OUTPUT, detached = false, execDependencies = [], missionAuthority = null, allowGitMetadata = false, signal = null } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !this.allowed.has(path.resolve(file)) || isInternalHelper(file)) return Promise.reject(new Error('Executable is not allowlisted'));
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 64 * 1024)) return Promise.reject(new Error('Invalid executable arguments'));
    if (signal?.aborted) return Promise.reject(new Error('Host operation cancelled'));
    if (missionAuthority) {
      const valid = require('./mission-permissions').checkAuthority(missionAuthority);
      if (!valid.allow) return Promise.reject(new Error(valid.reason));
      timeoutMs = Math.min(timeoutMs, missionAuthority.expiresAt - Date.now());
      detached = true;
      env = {...env,HOME:'/var/empty'};
    }
    return new Promise((resolve, reject) => {
      let child;
      try { const bounded = this.processBoundary(file, args, execDependencies, missionAuthority, allowGitMetadata); child = this.spawnImpl(bounded.file, bounded.args, { cwd, env: this.env(env), shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached }); }
      catch (error) { return reject(new Error(require('./secret-observation').redactText(error.message))); }
      let stdout = '', stderr = '', truncated = false, timedOut = false, done = false;
      const collect = which => chunk => {
        const text = chunk.toString('utf8');
        if (which === 'out') { if (stdout.length < maxOutput) stdout += text; else truncated = true; }
        else if (stderr.length < 64 * 1024) stderr += text;
      };
      child.stdout?.on('data', collect('out'));
      child.stderr?.on('data', collect('err'));
      const abort = () => {
        if (missionAuthority && child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
        else { try { child.kill('SIGTERM'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} },2000).unref(); }
      };
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort();
      const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
      timer.unref?.();
      child.on('error', error => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort',abort); reject(new Error(require('./secret-observation').redactText(error.message))); });
      child.on('close', (code, exitSignal) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort',abort);
        resolve({ exitCode: code, signal: exitSignal || null, timedOut, stdout: stdout.slice(0, maxOutput), stderr: stderr.slice(0, 64 * 1024), truncated });
      });
      if (input !== null && input !== undefined) child.stdin?.end(String(input)); else child.stdin?.end();
    });
  }

  // Long-running process owned by a job manager; caller supervises lifecycle.
  spawnTracked(file, args = [], { cwd, env = {} } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !this.allowed.has(path.resolve(file)) || isInternalHelper(file)) throw new Error('Executable is not allowlisted');
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid executable arguments');
    const bounded = this.processBoundary(file, args);
    return this.spawnImpl(bounded.file, bounded.args, { cwd, env: this.env(env), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  }
}

module.exports = { HostExecutor, SAFE_PATH };
