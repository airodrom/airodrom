'use strict';
// Deliberately small grammar: recognized commands are executed without a shell.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
// Tokenize a bounded shell subset, retaining operators separately from quoted data.
function parse(command) {
  if (typeof command !== 'string' || command.length > 4000 || /[\0\n\r$`]/.test(command)) return null;
  const groups = [[]]; let word = '', active = false, quote = null;
  const flush = () => { if (active) groups.at(-1).push(word); word = ''; active = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && !(quote && command[i + 1] === '|')) return null;
    if (quote) { if (c === quote) quote = null; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (/\s/.test(c)) { flush(); continue; }
    if (c === '&' && command[i + 1] === '&') { flush(); groups.push([]); i++; continue; }
    if (/[;&|<>*?{}()]/.test(c)) return null;
    word += c; active = true;
  }
  if (quote) return null;
  flush();
  return groups.length <= 8 && groups.every(a => a.length) ? groups : null;
}
function classify(command, workspace) {
  const groups = parse(command); if (!groups) return null;
  let cwd;
  if (groups[0][0] === 'cd') {
    const cd = groups.shift();
    if (!workspace || cd.length !== 2 || !groups.length || !cd[1] || cd[1].startsWith('-')) return null;
    const supplied = cd[1].startsWith('~/') ? path.join(require('node:os').homedir(), cd[1].slice(2)) : cd[1];
    // Classification is syntax-only so filesystem changes cannot route an
    // auto-allowed command into the extension's approved-shell fallback.
    cwd = path.resolve(workspace, supplied);
    const relative = path.relative(workspace, cwd);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  }
  const steps = groups.map(classifyWords);
  if (steps.some(s => !s)) return null;
  if (cwd) for (const step of steps) step.cwd = cwd;
  return steps.length === 1 ? steps[0] : { op: 'sequence', steps };
}
function classifyWords(a) {
  if (a.join(' ') === 'bridge health') return { op: 'health' };
  if (a.join(' ') === 'bridge logs') return { op: 'logs' };
  if (a.join(' ') === 'launchctl list') return { op: 'services' };
  if (a[0] === 'pwd' && a.length === 1) return { op: 'pwd' };
  if (a[0] === 'ls' && a.length <= 3) {
    const args = a.slice(1).filter(s => !['-l','-a','-la','-al'].includes(s));
    if (args.length <= 1 && !args[0]?.startsWith('-')) return { op: 'ls', path: args[0] || '.' };
  }
  if (['cat','head','tail'].includes(a[0]) && a.length === 2 && !a[1].startsWith('-')) return { op: a[0], path: a[1] };
  if (a[0] === 'wc') {
    const flags = a.slice(1, -1);
    const file = a.at(-1);
    if (!file || file.startsWith('-') || flags.some(flag => !['-l','-w','-c'].includes(flag)) || new Set(flags).size !== flags.length) return null;
    return { op: 'wc', path: file, flags };
  }
  if (['head','tail'].includes(a[0])) {
    const match = /^(?:-n|--lines)=(\d+)$/.exec(a[1] || '') || /^-n(\d+)$/.exec(a[1] || '');
    const count = match ? match[1] : ['-n', '--lines'].includes(a[1]) ? a[2] : null;
    const file = match && a.length === 3 ? a[2] : !match && a.length === 4 ? a[3] : null;
    if (count && /^[0-9]+$/.test(count) && Number(count) >= 1 && Number(count) <= 2000 && file && !file.startsWith('-')) return { op: a[0], path: file, limit: Number(count) };
  }
  if (a[0] === 'sed' && a.length === 4 && a[1] === '-n' && !a[3].startsWith('-')) {
    const range = /^(\d+)(?:,(\d+))?p$/.exec(a[2]);
    if (!range) return null;
    const first = Number(range[1]), last = Number(range[2] || range[1]);
    if (first < 1 || last < first || last > 2000) return null;
    return { op: 'cat', path: a[3], offset: first, limit: last - first + 1 };
  }
  if (['rg','grep'].includes(a[0])) {
    const args = [], includes = []; let options = true, fixed = false, extended = a[0] === 'rg', namesOnly = false;
    for (let i = 1; i < a.length; i++) {
      const arg = a[i];
      if (options && arg === '--') { options = false; continue; }
      if (options && /^-[nrFlE]+$/.test(arg)) {
        fixed ||= arg.includes('F'); extended ||= arg.includes('E'); namesOnly ||= arg.includes('l'); continue;
      }
      if (options && (arg.startsWith('--include=') || (a[0] === 'rg' && arg === '-g'))) {
        const glob = arg === '-g' ? a[++i] : arg.slice(10);
        if (!glob || !/^[a-zA-Z0-9_.*-]+$/.test(glob)) return null;
        includes.push(glob); continue;
      }
      if (options && arg.startsWith('-')) return null;
      args.push(arg);
    }
    if (args.length >= 1 && args.length <= 2) {
      // Only literal alternatives, never an attacker-controlled regular expression.
      const patterns = fixed ? [args[0]] : args[0].split(extended ? '|' : '\\|');
      if (!fixed && patterns.some(p => !p || /[.*+?^${}()\[\]\\]/.test(p))) return null;
      return { op: 'grep', pattern: args[0], patterns, namesOnly, path: args[1] || '.', includes };
    }
  }
  if (a[0] === 'find' && a.length >= 2 && !a[1].startsWith('-')) {
    const spec = { op: 'find', path: a[1] };
    for (let i = 2; i < a.length; i++) {
      const flag = a[i];
      if (flag === '-print') continue;
      const value = a[++i];
      if (flag === '-name' && value && /^[a-zA-Z0-9_.*-]+$/.test(value) && spec.pattern === undefined) spec.pattern = value;
      else if (flag === '-type' && ['f','d'].includes(value) && !spec.type) spec.type = value;
      else if (flag === '-maxdepth' && /^(?:[1-9]|1[0-5])$/.test(value) && !spec.maxDepth) spec.maxDepth = Number(value);
      else return null;
    }
    return spec;
  }
  if (a[0] === 'git') {
    if (a[1] === 'status' && a.slice(2).every(s => ['--short','--branch','--porcelain','--porcelain=v1'].includes(s))) return { op: 'git', args: a.slice(1) };
    if (a.join(' ') === 'git branch --show-current') return { op: 'git', args: a.slice(1) };
    if (['git rev-parse HEAD', 'git rev-parse --short HEAD', 'git rev-parse --abbrev-ref HEAD'].includes(a.join(' '))) return { op: 'git', args: a.slice(1) };
    if (a[1] === 'show') {
      const flags = [], revisions = [];
      for (const arg of a.slice(2)) {
        if (['--name-only','--stat','--oneline'].includes(arg)) flags.push(arg);
        else if (/^(?:HEAD|[0-9a-fA-F]{7,40})(?:[~^][0-9]{0,3})?$/.test(arg)) revisions.push(arg);
        else return null;
      }
      if (revisions.length > 1) return null;
      return { op: 'git', args: ['show', ...flags, revisions[0] || 'HEAD'] };
    }
    if (a[1] === 'log') {
      const args = a.slice(2); let count = 20;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--oneline') continue;
        let value;
        if (args[i] === '-n') value = args[++i];
        else value = /^(?:-|--max-count=)([0-9]+)$/.exec(args[i])?.[1];
        if (!value || !/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 20) return null;
        count = Number(value);
      }
      return { op: 'git', args: ['log','--oneline',`-${count}`] };
    }
    if (a[1] === 'diff' && a.slice(2).every(s => ['--stat','--name-only','--cached','--staged'].includes(s))) return { op: 'git', args: a.slice(1) };
  }
  if (a.join(' ') === 'ps -axo pid,ppid,stat,comm') return { op: 'processes' };
  return null;
}
class SafeDiagnostics {
  constructor(policy) { this.policy = policy; }
  target(task, supplied, logRead = false) {
    if (typeof supplied !== 'string' || !supplied || supplied.includes('\0') || supplied.startsWith('~')) throw new Error('Invalid diagnostic path');
    const lexical = path.resolve(task.workspace, supplied), target = fs.realpathSync(lexical);
    const relative = path.relative(task.workspace, target);
    const lexicalRelative = path.relative(task.workspace, lexical);
    if ([relative,lexicalRelative].some(s => s === '..' || s.startsWith('../') || path.isAbsolute(s)) || ((this.policy._protected(task, lexical) || this.policy._protected(task, target)) && !(logRead && this.policy._diagnosticLog(task, lexical, target)))) throw new Error('Protected or outside diagnostic path');
    return target;
  }
  read(task, input) {
    const logRead = ['cat', 'head', 'tail'].includes(input.op);
    const target = this.target(task, input.path || '.', logRead);
    const stat = fs.statSync(target);
    const files = [], names = []; let scanned = 0;
    const visit = (file, depth) => {
      if (++scanned > 2000 || depth > 15) throw new Error('Narrow the diagnostic path (scan limit)');
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) return;
      try { this.target(task, file, logRead); } catch { return; }
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(file).sort()) {
          if (++scanned > 2000) throw new Error('Narrow the diagnostic path (scan limit)');
          const child = path.join(file, name);
          try { this.target(task, child); } catch { continue; }
          if (fs.lstatSync(child).isSymbolicLink()) continue;
          const childStat = fs.lstatSync(child);
          if (!input.type || (input.type === 'f' && childStat.isFile()) || (input.type === 'd' && childStat.isDirectory())) names.push(path.relative(task.workspace, child));
          if (input.op !== 'ls' && (!input.maxDepth || depth + 1 < input.maxDepth)) visit(child, depth + 1);
        }
      } else if (st.isFile()) files.push(file);
    };
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('Only regular files may be read');
    visit(target, 0);
    if (['ls','find'].includes(input.op)) {
      const pattern = input.pattern || '*';
      if (typeof pattern !== 'string' || pattern.length > 200) throw new Error('Invalid find pattern');
      const expression = new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return names.filter(name => input.op === 'ls' || expression.test(name) || expression.test(path.basename(name))).slice(0, 1000).join('\n').slice(0, 16000);
    }
    if (input.op === 'grep' && (typeof input.pattern !== 'string' || input.pattern.length > 1000)) throw new Error('Invalid literal search pattern');
    for (const key of ['offset','limit']) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1)) throw new Error(`Invalid read ${key}`);
    let output = '', total = 0;
    for (const file of files) {
      if (input.includes?.length && !input.includes.some(glob => new RegExp('^' + glob.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(path.basename(file)))) continue;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let data;
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > 1024 * 1024 || (total += st.size) > 4 * 1024 * 1024) throw new Error('Narrow the diagnostic path (byte limit)');
        data = fs.readFileSync(fd, 'utf8');
      } finally { fs.closeSync(fd); }
      if (data.includes('\0')) continue;
      let lines = data.split('\n');
      if (input.op === 'grep') {
        const patterns = input.patterns || [input.pattern];
        lines = lines.flatMap((line,i) => patterns.some(pattern => line.includes(pattern)) ? [`${path.relative(task.workspace,file)}:${i+1}:${line}`] : []);
        if (input.namesOnly) lines = lines.length ? [path.relative(task.workspace, file)] : [];
      }
      if (input.op === 'cat') lines = lines.slice(Math.max(0, (input.offset || 1) - 1), Math.max(0, (input.offset || 1) - 1) + Math.min(input.limit || 2000, 2000));
      if (['head', 'tail'].includes(input.op)) {
        // A trailing newline terminates the last line; it is not an extra line.
        if (lines.at(-1) === '') lines.pop();
        const count = Math.min(input.limit || 40, 2000);
        lines = input.op === 'head' ? lines.slice(0, count) : lines.slice(-count);
      }
      const formatted = lines.join('\n');
      output += formatted + (formatted.endsWith('\n') ? '' : '\n');
      if (output.length >= 16000) break;
    }
    return require('./secret-observation').redactText(output.slice(0, 16000));
  }
  async execute(task, command) {
    const spec = classify(command, task.workspace); if (!spec) throw new Error('Not a bounded diagnostic command');
    const steps = spec.steps || [spec];
    const outputs = [];
    for (const step of steps) outputs.push(await this.executeSpec(task, step));
    return require('./secret-observation').redactText(outputs.join('\n').slice(0, 16000));
  }
  async executeSpec(task, spec) {
    const cwd = spec.cwd ? this.target(task, spec.cwd) : task.workspace;
    if (!fs.statSync(cwd).isDirectory()) throw new Error('Diagnostic working directory must be a directory');
    if (spec.path) spec = { ...spec, path: path.resolve(cwd, spec.path) };
    if (spec.op === 'health') return JSON.stringify({ taskId: task.id, status: task.status, connected: task.connected, lastHeartbeatAt: task.lastHeartbeatAt });
    if (spec.op === 'logs') return JSON.stringify(task.events.slice(-40));
    if (spec.op === 'services') return (await run('/bin/launchctl', ['list'], { timeout: 3000, maxBuffer: 65536 })).stdout.slice(0,16000);
    if (spec.op === 'pwd') return cwd;
    if (spec.op === 'wc') {
      const target = this.target(task, spec.path);
      const data = fs.readFileSync(target, 'utf8');
      const flags = spec.flags.length ? spec.flags : ['-l','-w','-c'];
      const values = flags.map(flag => flag === '-l' ? String((data.match(/\n/g) || []).length) : flag === '-w' ? String(data.trim() ? data.trim().split(/\s+/).length : 0) : String(Buffer.byteLength(data)));
      return `${values.join(' ')} ${path.relative(task.workspace, target)}`;
    }
    if (spec.op === 'processes') return JSON.stringify(await require('./secret-observation').observeProcesses()).slice(0,16000);
    if (spec.op !== 'git') return this.read(task, spec);
    const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', LANG: 'C' };
    if (['status','diff'].includes(spec.args[0])) spec.args.push('--ignore-submodules=all');
    const git = args => run('/usr/bin/git', ['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-c','log.showSignature=false','-c','log.showNotes=false','--no-pager',...args], { cwd, env, timeout: 5000, maxBuffer: 65536 });
    // Do not discover a parent repository from an isolated task, or follow a redirected
    // metadata directory into a different repository. Linked worktrees require review.
    const metadata = path.join(task.workspace, '.git');
    const metadataStat = fs.lstatSync(metadata);
    if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink()) throw new Error('Git diagnostics require a workspace-owned .git directory');
    const top = (await git(['rev-parse','--show-toplevel'])).stdout.trim();
    if (fs.realpathSync(top) !== task.workspace) throw new Error('Git repository is outside the task workspace');
    if (spec.args[0] === 'show') {
      const revision = spec.args.at(-1);
      // Commit-only show: no blobs, paths, options, tag contents or configured helpers.
      const oid = (await git(['rev-parse','--verify',`${revision}^{commit}`])).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error('Invalid diagnostic commit');
      const names = (await git(['diff-tree','--root','-m','-r','--no-commit-id','--no-renames','--no-ext-diff','--no-textconv','--name-only','-z',oid])).stdout.split('\0').filter(Boolean);
      for (const name of names) this.target(task, path.join(task.workspace, name));
      spec.args = ['show','--ignore-submodules=all','--no-renames','--no-ext-diff','--no-textconv','--no-notes','--format=medium', ...spec.args.slice(1, -1), oid, '--'];
    }
    if (spec.args[0] === 'diff') {
      const flags = spec.args.filter(s => ['--cached','--staged'].includes(s));
      const names = (await git(['diff','--no-ext-diff','--no-textconv','--name-only','-z',...flags])).stdout.split('\0').filter(Boolean);
      // Fail closed for protected/deleted/unresolvable paths, rather than leak their diff.
      for (const name of names) this.target(task, name);
      spec.args.splice(1, 0, '--no-ext-diff', '--no-textconv');
    }
    return (await git(spec.args)).stdout.slice(0,16000);
  }
}
module.exports = { SafeDiagnostics, classify };
