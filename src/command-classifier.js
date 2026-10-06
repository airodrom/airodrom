'use strict';

const path = require('node:path');

const CLASSES = Object.freeze(['read_only', 'safe_workspace_write', 'safe_dev_execution', 'external_side_effect', 'destructive', 'privileged', 'unknown']);
const RANK = Object.freeze(Object.fromEntries(CLASSES.map((name, index) => [name, index])));
const DECISION = Object.freeze({
  read_only: 'auto_allow', safe_workspace_write: 'auto_allow', safe_dev_execution: 'auto_allow',
  external_side_effect: 'approval_required', destructive: 'approval_required', unknown: 'approval_required', privileged: 'deny'
});

const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'pwd', 'echo', 'printf', 'which', 'file', 'stat', 'du', 'df', 'tree', 'sort', 'uniq', 'cut', 'diff', 'cmp', 'less', 'more', 'date', 'whoami', 'uname', 'basename', 'dirname', 'realpath', 'shasum', 'md5', 'sha256sum', 'true', 'false', 'test']);
const DEV_EXEC = new Set(['node', 'tsc', 'eslint', 'jest', 'vitest', 'mocha', 'pytest', 'ruff', 'mypy', 'black', 'prettier', 'go', 'cargo', 'rustc', 'make', 'swift', 'xcodebuild', 'deno', 'bun']);
const PRIVILEGED = new Set(['sudo', 'doas', 'su', 'launchctl', 'systemsetup', 'csrutil', 'spctl', 'nvram', 'kextload', 'kextunload', 'pfctl', 'security', 'dscl', 'chown', 'chflags', 'softwareupdate', 'installer', 'scutil', 'tmutil', 'fdesetup', 'profiles']);
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'shred', 'dd', 'mkfs', 'newfs_apfs', 'truncate', 'srm', 'unlink']);
const EXTERNAL = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp', 'gh', 'open', 'osascript', 'npx', 'pbcopy', 'say', 'mail', 'sendmail', 'kill', 'killall', 'pkill']);
// Repository-defined scripts run automatically only under conventional
// verification names; anything else is arbitrary repository code.
const SAFE_SCRIPT = /^(?:test|tests|lint|typecheck|type-check|check|build|verify|ci|format:check|fmt:check)(?::[\w.-]+)?$/;
const SAFE_SCRIPT_FILE = /^(?:test|tests|lint|typecheck|type-check|check|build|verify|ci)(?:[-_.][\w.-]*)?$/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'eval', 'source', '.', 'exec', 'xargs', 'env']);

// Minimal POSIX-ish lexer: quotes and escapes; reports control operators so
// that only plain argv commands can ever be executed by an adapter.
function tokenize(command) {
  const tokens = [], operators = [];
  let current = '', quote = null, started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = null; else current += ch; continue; }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < command.length) current += command[++i];
      else if (ch === '$' || ch === '`') { operators.push('substitution'); current += ch; }
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === '\\' && i + 1 < command.length) { current += command[++i]; started = true; continue; }
    if (/\s/.test(ch)) { if (started) { tokens.push(current); current = ''; started = false; } continue; }
    if (ch === '`' || (ch === '$' && command[i + 1] === '(')) { operators.push('substitution'); current += ch; started = true; continue; }
    if (';&|<>(){}\n'.includes(ch)) {
      if (started) { tokens.push(current); current = ''; started = false; }
      let op = ch; while (i + 1 < command.length && ';&|<>'.includes(command[i + 1]) && op.length < 2) op += command[++i];
      operators.push(op); tokens.push({ op }); continue;
    }
    current += ch; started = true;
  }
  if (quote) throw new Error('Unterminated quote');
  if (started) tokens.push(current);
  return { tokens, operators };
}

function splitStages(tokens) {
  const stages = [[]];
  for (const token of tokens) {
    if (typeof token === 'object') { if (['|', '&&', '||', ';', '&'].includes(token.op)) stages.push([]); else stages[stages.length - 1].push(token); }
    else stages[stages.length - 1].push(token);
  }
  return stages.filter(stage => stage.length);
}

function escapesCwd(arg, cwd) {
  if (typeof arg !== 'string' || arg.startsWith('-')) return false;
  if (arg.startsWith('~')) return true;
  if (path.isAbsolute(arg)) return !cwd || path.relative(cwd, arg).startsWith('..');
  return arg.split('/').includes('..');
}

function classifyGit(args) {
  const [sub, ...rest] = args;
  const has = (...flags) => rest.some(arg => flags.includes(arg) || flags.some(flag => flag.endsWith('=') && arg.startsWith(flag)));
  if (!sub) return ['read_only', 'git without subcommand'];
  if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'reflog', 'grep', 'cat-file', 'ls-tree', 'merge-base', 'rev-list', 'check-ref-format', 'for-each-ref', 'name-rev'].includes(sub)) return ['read_only', `git ${sub}`];
  if (sub === 'branch') {
    if (has('-D', '--delete', '-d')) return has('-D') || has('--force', '-f') ? ['destructive', 'git branch force delete'] : ['safe_workspace_write', 'git branch delete merged'];
    if (has('-m', '-M', '--move', '-c', '-C')) return ['safe_workspace_write', 'git branch rename/copy'];
    return rest.filter(arg => !arg.startsWith('-')).length ? ['safe_workspace_write', 'git branch create'] : ['read_only', 'git branch list'];
  }
  if (sub === 'remote') return rest.length === 0 || has('-v', '--verbose') || rest[0] === 'show' || rest[0] === 'get-url' ? ['read_only', 'git remote inspect'] : ['external_side_effect', 'git remote mutation'];
  if (sub === 'tag') return rest.length === 0 || has('-l', '--list') ? ['read_only', 'git tag list'] : has('-d', '--delete') ? ['destructive', 'git tag delete'] : ['safe_workspace_write', 'git tag create'];
  if (sub === 'stash') return ['list', 'show'].includes(rest[0]) ? ['read_only', 'git stash inspect'] : ['drop', 'clear'].includes(rest[0]) ? ['destructive', 'git stash drop'] : ['safe_workspace_write', 'git stash'];
  if (sub === 'reset') return has('--hard', '--merge', '--keep') ? ['destructive', 'git reset --hard'] : ['safe_workspace_write', 'git reset'];
  if (sub === 'clean') return has('-n', '--dry-run') ? ['read_only', 'git clean dry run'] : ['destructive', 'git clean'];
  if (sub === 'push') return has('-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '-d', '--prune') || rest.some(arg => arg.startsWith('+') || arg.startsWith(':')) ? ['destructive', 'git push force/delete'] : ['external_side_effect', 'git push'];
  if (sub === 'checkout') return has('-f', '--force', '--', '.', '-p', '--patch') ? ['destructive', 'git checkout discards changes'] : ['safe_workspace_write', 'git checkout'];
  if (sub === 'restore') return has('--staged', '-S') && !has('--worktree', '-W') ? ['safe_workspace_write', 'git restore --staged'] : ['destructive', 'git restore discards changes'];
  if (sub === 'switch') return has('-f', '--force', '--discard-changes', '-C') ? ['destructive', 'git switch force'] : ['safe_workspace_write', 'git switch'];
  if (['rebase', 'filter-branch', 'filter-repo', 'replace'].includes(sub)) return ['destructive', `git ${sub} rewrites history`];
  if (['add', 'commit', 'mv', 'rm', 'merge', 'cherry-pick', 'revert', 'apply', 'am', 'notes', 'worktree', 'init'].includes(sub)) {
    if (sub === 'add' && has('-A', '--all', '.', '-u', '--update')) return ['destructive', 'blind git add of the whole tree'];
    if (sub === 'rm') return ['destructive', 'git rm'];
    if (sub === 'commit' && has('--amend')) return ['destructive', 'git commit --amend rewrites history'];
    return ['safe_workspace_write', `git ${sub}`];
  }
  if (['fetch', 'pull', 'clone', 'submodule', 'lfs'].includes(sub)) return ['external_side_effect', `git ${sub}`];
  if (sub === 'config') return has('--get', '--list', '-l', '--get-all') ? ['read_only', 'git config read'] : ['safe_workspace_write', 'git config write'];
  if (sub === 'gc' || sub === 'prune') return ['destructive', `git ${sub}`];
  return ['unknown', `git ${sub}`];
}

function classifyPackageManager(name, args) {
  const [sub, ...rest] = args;
  const global = rest.includes('-g') || rest.includes('--global') || args.includes('-g');
  if (global) return ['privileged', `${name} global install/modify`];
  if (!sub || ['--version', '-v', 'version', 'ls', 'list', 'outdated', 'view', 'info', 'why', 'explain', 'audit', 'config', 'root', 'bin', 'prefix', 'help'].includes(sub)) return ['read_only', `${name} ${sub || ''}`.trim()];
  if (['test', 't'].includes(sub)) return ['safe_dev_execution', `${name} test`];
  if (['run', 'run-script'].includes(sub) || (name !== 'npm' && SAFE_SCRIPT.test(sub))) {
    const script = ['run', 'run-script'].includes(sub) ? rest.find(arg => !arg.startsWith('-')) : sub;
    return script && SAFE_SCRIPT.test(script) ? ['safe_dev_execution', `${name} run ${script}`] : ['unknown', `${name} script ${script || ''} is arbitrary repository code`.trim()];
  }
  if (sub === 'exec' || sub === 'dlx') return ['external_side_effect', `${name} ${sub} may download`];
  if (sub === 'start') return ['unknown', `${name} start runs a long-lived repository process`];
  if (['ci', 'install', 'i', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'prune', 'dedupe'].includes(sub)) return ['external_side_effect', `${name} ${sub} fetches or runs package code`];
  if (['publish', 'unpublish', 'deprecate', 'owner', 'access', 'token', 'login', 'logout', 'adduser'].includes(sub)) return ['privileged', `${name} ${sub} changes registry or credentials`];
  return ['unknown', `${name} ${sub}`];
}

function classifyStage(argv, cwd) {
  let index = 0;
  while (index < argv.length && typeof argv[index] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index])) index++;
  const words = argv.slice(index);
  if (words.some(word => typeof word === 'object')) {
    const redirect = words.find(word => typeof word === 'object');
    if (['>', '>>', '>|'].includes(redirect.op)) {
      const target = words[words.indexOf(redirect) + 1];
      if (escapesCwd(target, cwd) || target === undefined) return ['unknown', 'redirection outside the working directory'];
      const inner = classifyStage(words.slice(0, words.indexOf(redirect)), cwd);
      return RANK[inner[0]] > RANK.safe_workspace_write ? inner : ['safe_workspace_write', 'redirection into the working directory'];
    }
    if (redirect.op === '<') return classifyStage(words.slice(0, words.indexOf(redirect)), cwd);
    return ['unknown', `shell operator ${redirect.op}`];
  }
  if (!words.length) return ['unknown', 'empty command'];
  const executable = path.basename(words[0]);
  const args = words.slice(1);
  if (PRIVILEGED.has(executable)) return ['privileged', `${executable} is privileged`];
  if (SHELLS.has(executable)) return ['unknown', `${executable} evaluates arbitrary commands`];
  if (executable === 'git') return classifyGit(args);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) return classifyPackageManager(executable, args);
  if (['brew', 'port'].includes(executable)) return ['list', 'info', 'search', 'outdated', 'doctor', 'config', '--version', 'deps', 'leaves', 'services'].includes(args[0]) && !(args[0] === 'services' && args[1] && args[1] !== 'list') ? ['read_only', `${executable} ${args[0] || ''}`.trim()] : ['privileged', `${executable} ${args[0] || ''} changes machine-global software`.trim()];
  if (['pip', 'pip3'].includes(executable) || (['python', 'python3'].includes(executable) && args[0] === '-m' && ['pip'].includes(args[1]))) {
    const sub = executable.startsWith('pip') ? args[0] : args[2];
    return ['list', 'show', 'freeze', 'check', '--version', 'help'].includes(sub) ? ['read_only', 'pip inspect'] : ['external_side_effect', `pip ${sub || ''} fetches or runs package code`.trim()];
  }
  if (['python', 'python3'].includes(executable)) {
    if (args[0] === '-m' && ['pytest', 'unittest', 'mypy', 'ruff', 'black', 'pyflakes', 'compileall'].includes(args[1])) return ['safe_dev_execution', `python -m ${args[1]}`];
    if (args[0] === '-c' || args[0] === '-') return ['unknown', 'python inline code'];
    return args.length && !escapesCwd(args[0], cwd) && SAFE_SCRIPT_FILE.test(path.basename(args[0]).replace(/\.py$/, '')) ? ['safe_dev_execution', 'python verification script'] : ['unknown', 'python script is arbitrary repository code'];
  }
  if (executable === 'find') {
    if (args.some(arg => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(arg))) return ['destructive', 'find with actions'];
    return ['read_only', 'find'];
  }
  if (executable === 'sed' || executable === 'perl') return args.some(arg => /^-[a-zA-Z]*i/.test(arg)) ? (args.some(arg => escapesCwd(arg, cwd)) ? ['unknown', `${executable} -i outside the working directory`] : ['safe_workspace_write', `${executable} in-place edit`]) : ['read_only', executable];
  if (executable === 'diskutil') return ['list', 'info', 'verifyVolume', 'verifyDisk', 'apfs'].includes(args[0]) && !(args[0] === 'apfs' && !['list', 'listSnapshots'].includes(args[1])) ? ['read_only', `diskutil ${args[0]}`] : ['destructive', `diskutil ${args[0] || ''}`.trim()];
  if (executable === 'defaults') return ['read', 'read-type', 'domains', 'find'].includes(args[0]) ? ['read_only', 'defaults read'] : ['privileged', 'defaults write changes settings'];
  if (executable === 'docker') {
    if (['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'port'].includes(args[0])) return ['read_only', `docker ${args[0]}`];
    if (['build', 'start', 'stop', 'restart', 'create', 'run', 'compose', 'exec', 'pull'].includes(args[0])) return ['safe_dev_execution', `docker ${args[0]}`];
    if (['rm', 'rmi', 'prune', 'volume', 'system', 'kill'].includes(args[0])) return ['destructive', `docker ${args[0]}`];
    if (['push', 'login', 'logout'].includes(args[0])) return ['external_side_effect', `docker ${args[0]}`];
    return ['unknown', `docker ${args[0] || ''}`.trim()];
  }
  if (DESTRUCTIVE.has(executable)) return ['destructive', `${executable} deletes or overwrites data`];
  if (EXTERNAL.has(executable)) return ['external_side_effect', `${executable} has external side effects`];
  if (['mkdir', 'touch', 'cp', 'mv', 'ln', 'chmod', 'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'ditto'].includes(executable)) {
    if (args.some(arg => escapesCwd(arg, cwd))) return ['unknown', `${executable} outside the working directory`];
    if (executable === 'mv' || (executable === 'cp' && args.some(arg => /^-[a-zA-Z]*f/.test(arg)))) return ['safe_workspace_write', `${executable} may overwrite inside the working directory`];
    return ['safe_workspace_write', `${executable} inside the working directory`];
  }
  if (READ_ONLY.has(executable)) return ['read_only', executable];
  if (DEV_EXEC.has(executable)) {
    if (executable === 'go' && !['test', 'build', 'vet', 'run', 'fmt', 'version', 'env', 'list'].includes(args[0])) return ['external_side_effect', `go ${args[0] || ''}`.trim()];
    if (executable === 'cargo' && !['test', 'build', 'check', 'clippy', 'fmt', 'run', 'bench', 'doc', 'tree', 'metadata', '--version'].includes(args[0])) return ['external_side_effect', `cargo ${args[0] || ''}`.trim()];
    if (executable === 'node' && (args[0] === '-e' || args[0] === '--eval' || args[0] === '-p')) return ['unknown', 'node inline code'];
    if (executable === 'node') { const file = args.find(arg => !arg.startsWith('-')); return file && !escapesCwd(file, cwd) && (args.includes('--test') || SAFE_SCRIPT_FILE.test(path.basename(file).replace(/\.[cm]?[jt]s$/, ''))) ? ['safe_dev_execution', 'node verification script'] : ['unknown', 'node script is arbitrary repository code']; }
    if (executable === 'make') { const targets = args.filter(arg => !arg.startsWith('-') && !arg.includes('=')); return targets.length && targets.every(target => SAFE_SCRIPT.test(target)) ? ['safe_dev_execution', `make ${targets.join(' ')}`] : ['unknown', 'make target is arbitrary repository code']; }
    return ['safe_dev_execution', executable];
  }
  if (words[0].startsWith('./') && !escapesCwd(words[0], cwd)) return SAFE_SCRIPT_FILE.test(path.basename(words[0]).replace(/\.(?:sh|bash|zsh|js|mjs|cjs|py)$/, '')) ? ['safe_dev_execution', 'repository verification script'] : ['unknown', 'repository script is arbitrary code'];
  return ['unknown', `${executable} is not classified`];
}

/**
 * Classify a command string without executing it. Pipelines take the most
 * dangerous stage; piping into a shell interpreter is never automatic.
 */
function classifyCommand(command, { cwd = null } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 8_000 || command.includes('\0')) return { class: 'unknown', decision: DECISION.unknown, reasons: ['invalid command'], argv: null, executableForm: 'invalid' };
  let lexed;
  try { lexed = tokenize(command); } catch (error) { return { class: 'unknown', decision: DECISION.unknown, reasons: [error.message], argv: null, executableForm: 'invalid' }; }
  const reasons = [];
  if (lexed.operators.includes('substitution')) return { class: 'unknown', decision: DECISION.unknown, reasons: ['command substitution'], argv: null, executableForm: 'shell' };
  const stages = splitStages(lexed.tokens);
  let worst = 'read_only';
  stages.forEach((stage, index) => {
    let [name, reason] = classifyStage(stage, cwd);
    const first = typeof stage[0] === 'string' ? path.basename(stage[0]) : '';
    if (index > 0 && lexed.operators.includes('|') && SHELLS.has(first)) { name = 'privileged'; reason = 'pipe into a shell interpreter (install script pattern)'; }
    reasons.push(reason);
    if (RANK[name] > RANK[worst]) worst = name;
  });
  if (!stages.length) worst = 'unknown';
  const plainArgv = !lexed.tokens.some(token => typeof token === 'object');
  return { class: worst, decision: DECISION[worst], reasons, argv: plainArgv ? lexed.tokens : null, executableForm: plainArgv ? 'argv' : 'shell' };
}

module.exports = { classifyCommand, tokenize, CLASSES, DECISION: DECISION };
