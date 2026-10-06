'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { keys, text, integer, bool, oneOf, pattern, fail, redactText } = require('./capability-util');
const { classifyCommand } = require('./command-classifier');

// Fixed adapters: executables come only from these candidate paths and run only
// with the argv built here. User input never names an executable or a path to one.
const DEV_TOOLS = Object.freeze({
  claude_code: { label: 'Claude Code', candidates: ['~/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '~/.claude/local/claude'], version: ['--version'], manage: { install: ['npm', ['install', '-g', '@anthropic-ai/claude-code']], update: ['self', ['update']], uninstall: ['npm', ['uninstall', '-g', '@anthropic-ai/claude-code']] } },
  cursor: { label: 'Cursor', candidates: ['/usr/local/bin/cursor', '/Applications/Cursor.app/Contents/Resources/app/bin/cursor', '/Applications/Cursor.app/Contents/Resources/app/bin/code', '~/Applications/Cursor.app/Contents/Resources/app/bin/code'], version: ['--version'], app: '/Applications/Cursor.app', manage: { install: ['brew', ['install', '--cask', 'cursor']], update: ['brew', ['upgrade', '--cask', 'cursor']], uninstall: ['brew', ['uninstall', '--cask', 'cursor']] } },
  vscode: { label: 'VS Code', candidates: ['/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '~/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'], version: ['--version'], app: '/Applications/Visual Studio Code.app', manage: { install: ['brew', ['install', '--cask', 'visual-studio-code']], update: ['brew', ['upgrade', '--cask', 'visual-studio-code']], uninstall: ['brew', ['uninstall', '--cask', 'visual-studio-code']] } },
  node: { label: 'Node.js', candidates: ['/opt/homebrew/opt/node@22/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node'], version: ['--version'], manage: { install: ['brew', ['install', 'node@22']], update: ['brew', ['upgrade', 'node@22']], uninstall: ['brew', ['uninstall', 'node@22']] } },
  npm: { label: 'npm', candidates: ['/opt/homebrew/opt/node@22/bin/npm', '/opt/homebrew/bin/npm', '/usr/local/bin/npm'], version: ['--version'] },
  pnpm: { label: 'pnpm', candidates: ['/opt/homebrew/bin/pnpm', '/usr/local/bin/pnpm', '~/Library/pnpm/pnpm'], version: ['--version'], manage: { install: ['brew', ['install', 'pnpm']], update: ['brew', ['upgrade', 'pnpm']], uninstall: ['brew', ['uninstall', 'pnpm']] } },
  python: { label: 'Python', candidates: ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'], version: ['--version'], manage: { install: ['brew', ['install', 'python']], update: ['brew', ['upgrade', 'python']], uninstall: ['brew', ['uninstall', 'python']] } },
  pip: { label: 'pip', candidates: ['/opt/homebrew/bin/pip3', '/usr/local/bin/pip3'], version: ['--version'] },
  git: { label: 'Git', candidates: ['/usr/bin/git', '/opt/homebrew/bin/git'], version: ['--version'], manage: { install: ['brew', ['install', 'git']], update: ['brew', ['upgrade', 'git']], uninstall: ['brew', ['uninstall', 'git']] } },
  gh: { label: 'GitHub CLI', candidates: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'], version: ['--version'], manage: { install: ['brew', ['install', 'gh']], update: ['brew', ['upgrade', 'gh']], uninstall: ['brew', ['uninstall', 'gh']] } },
  ollama: { label: 'Ollama', candidates: ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama'], version: ['--version'], app: '/Applications/Ollama.app', manage: { install: ['brew', ['install', '--cask', 'ollama']], update: ['brew', ['upgrade', '--cask', 'ollama']], uninstall: ['brew', ['uninstall', '--cask', 'ollama']] } },
  docker: { label: 'Docker', candidates: ['~/.docker/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'], version: ['--version'], app: '/Applications/Docker.app', manage: { install: ['brew', ['install', '--cask', 'docker']], update: ['brew', ['upgrade', '--cask', 'docker']], uninstall: ['brew', ['uninstall', '--cask', 'docker']] } },
  homebrew: { label: 'Homebrew', candidates: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'], version: ['--version'] },
  make: { label: 'make', candidates: ['/usr/bin/make'], version: ['--version'] }
});
const TOOL_IDS = Object.keys(DEV_TOOLS);
const TRUSTED_EXTENSIONS = new Set(['anthropic.claude-code', 'ms-python.python', 'ms-python.debugpy', 'ms-python.vscode-pylance', 'dbaeumer.vscode-eslint', 'esbenp.prettier-vscode', 'editorconfig.editorconfig', 'github.vscode-github-actions', 'github.vscode-pull-request-github', 'ms-azuretools.vscode-docker', 'ms-azuretools.vscode-containers', 'docker.docker', 'ms-vscode.makefile-tools', 'rust-lang.rust-analyzer', 'golang.go', 'redhat.vscode-yaml', 'anysphere.cursorpyright']);
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9.-]{0,127}(?:@\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)?$/;
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const DATABASE_IMAGE = /(?:postgres|mysql|mariadb|mongo|redis|elasticsearch|opensearch|cockroach|clickhouse|cassandra|neo4j|influxdb|timescale|supabase)/i;
const EDITORS = Object.freeze({
  cursor: { tool: 'cursor', label: 'Cursor', extensionsDir: '~/.cursor/extensions', appSupport: 'Cursor' },
  vscode: { tool: 'vscode', label: 'VS Code', extensionsDir: '~/.vscode/extensions', appSupport: 'Code' }
});

const home = ctx => ctx.home || os.homedir();
const expandHome = (ctx, value) => value.startsWith('~/') ? path.join(home(ctx), value.slice(2)) : value;
const firstLine = value => String(value || '').split('\n').map(line => line.trim()).find(Boolean) || null;
const safeLabel = value => typeof value === 'string' && /^[A-Za-z0-9 ._()+@/-]{1,80}$/.test(value) ? value : null;

function resolveTool(ctx, id) {
  const spec = DEV_TOOLS[id];
  if (!spec) fail('Developer tool is not allowlisted');
  const file = ctx.exec.resolveFirst(spec.candidates);
  if (file) ctx.exec.allow(file);
  return { id, spec, file };
}

async function toolStatus(ctx, id) {
  const { spec, file } = resolveTool(ctx, id);
  const status = { tool: id, label: spec.label, installed: Boolean(file), path: file ? ctx.scopes.display(file) : null, app_installed: spec.app ? fs.existsSync(spec.app) : null, version: null };
  if (!file) return status;
  const result = await ctx.exec.run(file, spec.version, { timeoutMs: 15_000 }).catch(error => ({ exitCode: -1, stdout: '', stderr: error.message }));
  status.version = result.exitCode === 0 ? redactText(firstLine(result.stdout), 200) : null;
  status.healthy = result.exitCode === 0;
  return status;
}

function jsonc(textValue) {
  let out = '', inString = false;
  for (let i = 0; i < textValue.length; i++) {
    const ch = textValue[i], next = textValue[i + 1];
    if (inString) { out += ch; if (ch === '\\') out += textValue[++i] || ''; else if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { while (i < textValue.length && textValue[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < textValue.length && !(textValue[i] === '*' && textValue[i + 1] === '/')) i++; i++; continue; }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function installedExtensions(ctx, editor) {
  const dir = expandHome(ctx, EDITORS[editor].extensionsDir);
  const byId = new Map();
  try {
    for (const entry of JSON.parse(fs.readFileSync(path.join(dir, 'extensions.json'), 'utf8'))) {
      const id = String(entry?.identifier?.id || '').toLowerCase();
      if (!EXTENSION_ID.test(id)) continue;
      const item = { id, version: safeLabel(entry.version), publisher: safeLabel(entry.metadata?.publisherDisplayName), pinned: entry.metadata?.pinned === true, prerelease: entry.metadata?.isPreReleaseVersion === true, trusted: TRUSTED_EXTENSIONS.has(id) };
      byId.set(id, item);
    }
  } catch { /* fall back to directory names */ }
  const folders = {};
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*?)-(\d+\.\d+\.\d+[^/]*)$/i.exec(name);
      if (!match) continue;
      const id = match[1].toLowerCase();
      (folders[id] ||= []).push(match[2]);
      if (!byId.has(id) && EXTENSION_ID.test(id)) byId.set(id, { id, version: safeLabel(match[2].replace(/-darwin.*$|-universal$/, '')), publisher: null, pinned: false, prerelease: false, trusted: TRUSTED_EXTENSIONS.has(id) });
    }
  } catch { /* extensions directory absent */ }
  const items = [...byId.values()].map(item => ({ ...item, installed_versions: (folders[item.id] || []).length || 1 })).sort((a, b) => a.id.localeCompare(b.id));
  return { directory_present: fs.existsSync(dir), items };
}

class ClaudeCodeJobs {
  constructor() { this.jobs = new Map(); }
  snapshot(job) {
    return { job_id: job.id, status: job.status, repo: job.repoDisplay, started_at: new Date(job.startedAt).toISOString(), finished_at: job.finishedAt ? new Date(job.finishedAt).toISOString() : null, duration_ms: (job.finishedAt || Date.now()) - job.startedAt, exit_code: job.exitCode ?? null, api_key_withheld: job.apiKeyWithheld, result: job.result || null, touched_files: job.touched || [] };
  }
  owned(taskId, jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.taskId !== taskId) fail('Claude Code job is not owned by this task');
    return job;
  }
  cancel(job, reason = 'cancelled') {
    if (job.status !== 'running') return false;
    job.status = reason;
    try { job.child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { if (job.child.exitCode === null) job.child.kill('SIGKILL'); } catch {} }, 5_000).unref();
    return true;
  }
  shutdown() { for (const job of this.jobs.values()) this.cancel(job, 'cancelled'); }
}

async function claudeAuth(ctx) {
  const { file } = resolveTool(ctx, 'claude_code');
  const sources = [];
  if (ctx.env?.ANTHROPIC_API_KEY) sources.push('bridge_process_env');
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(home(ctx), '.claude', 'settings.json'), 'utf8'));
    if (settings?.env && Object.hasOwn(settings.env, 'ANTHROPIC_API_KEY')) sources.push('claude_settings_env');
    if (settings?.env && Object.hasOwn(settings.env, 'ANTHROPIC_AUTH_TOKEN')) sources.push('claude_settings_auth_token');
    if (typeof settings?.apiKeyHelper === 'string') sources.push('claude_settings_api_key_helper');
  } catch { /* settings are optional */ }
  let status = null;
  if (file) {
    const result = await ctx.exec.run(file, ['auth', 'status', '--json'], { timeoutMs: 15_000 }).catch(() => null);
    try { status = result && result.stdout ? JSON.parse(result.stdout) : null; } catch { status = null; }
  }
  // Only categorical fields leave this function: never email, org or tokens.
  const category = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(value) ? value : null;
  const loggedIn = status?.loggedIn === true;
  const method = category(status?.authMethod);
  const subscription = loggedIn && Boolean(method) && !/api[_-]?key/i.test(method);
  const authMode = subscription ? 'subscription' : (loggedIn && /api[_-]?key/i.test(method || '')) || sources.length ? 'api_key' : 'unknown';
  return {
    installed: Boolean(file), logged_in: loggedIn, auth_method: method, api_provider: category(status?.apiProvider), subscription_type: category(status?.subscriptionType),
    auth_mode: authMode, api_key_sources: sources, api_key_present: sources.length > 0,
    api_key_overrides_subscription: subscription && sources.some(source => source !== 'bridge_process_env'),
    bridge_env_api_key_withheld_from_children: subscription && sources.includes('bridge_process_env'),
    human_action: loggedIn ? null : { gate: 'claude_oauth_login', action: 'Run claude_code_auth_login_open, then complete the browser sign-in yourself.' },
    note: 'Credential values, account email and organization identifiers are never returned.'
  };
}

function gitPorcelain(ctx, repo) {
  const git = ctx.exec.resolveFirst(DEV_TOOLS.git.candidates);
  if (!git || !fs.existsSync(path.join(repo, '.git'))) return Promise.resolve(null);
  ctx.exec.allow(git);
  return ctx.exec.run(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repo, timeoutMs: 30_000, env: { GIT_OPTIONAL_LOCKS: '0' } })
    .then(result => result.exitCode === 0 ? new Map(result.stdout.split('\0').filter(Boolean).map(line => [line.slice(3), line.slice(0, 2)])) : null).catch(() => null);
}

function repoFor(ctx, value, { write = false } = {}) { return ctx.scopes.approvedRepository(value, { workspace: ctx.task.workspace, write }); }

function editorCapabilities(prefix) {
  const editor = EDITORS[prefix];
  const cli = ctx => { const { file } = resolveTool(ctx, editor.tool); if (!file) fail(`${editor.label} command-line tool is not installed`); return file; };
  const extension = input => { keys(input, ['id']); pattern(input.id, EXTENSION_ID, 'extension id'); return input; };
  const trustedDecision = input => TRUSTED_EXTENSIONS.has(input.id.split('@')[0]) ? null : { decision: 'approval_required', riskClass: 'PRIVILEGED', reason: `Extension ${input.id.split('@')[0]} is not on the trusted allowlist` };
  return {
    [`${prefix}_status`]: {
      validate: input => keys(input),
      perform: async ctx => ({ ...(await toolStatus(ctx, editor.tool)), extensions: installedExtensions(ctx, prefix).items.length })
    },
    [`${prefix}_version`]: {
      validate: input => keys(input),
      perform: async ctx => {
        const result = await ctx.exec.run(cli(ctx), ['--version'], { timeoutMs: 20_000 });
        const [version, commit, arch] = result.stdout.split('\n').map(line => line.trim());
        return { editor: prefix, version: safeLabel(version), commit: /^[0-9a-f]{7,40}$/.test(commit || '') ? commit : null, arch: safeLabel(arch) };
      }
    },
    [`${prefix}_extension_list`]: { validate: input => keys(input), perform: ctx => ({ editor: prefix, ...installedExtensions(ctx, prefix) }) },
    [`${prefix}_extension_status`]: {
      validate: extension,
      perform: (ctx, input) => {
        const id = input.id.split('@')[0];
        const item = installedExtensions(ctx, prefix).items.find(entry => entry.id === id);
        return { editor: prefix, id, installed: Boolean(item), version: item?.version || null, installed_versions: item?.installed_versions || 0, trusted: TRUSTED_EXTENSIONS.has(id), install_decision: TRUSTED_EXTENSIONS.has(id) ? 'auto_allow' : 'approval_required' };
      }
    },
    [`${prefix}_diagnostics`]: {
      validate: input => keys(input),
      perform: async ctx => {
        const extensions = installedExtensions(ctx, prefix).items;
        const logsRoot = path.join(home(ctx), 'Library', 'Application Support', editor.appSupport, 'logs');
        let latest = null, errors = [];
        try {
          latest = fs.readdirSync(logsRoot).filter(name => /^\d{8}T\d{6}$/.test(name)).sort().at(-1) || null;
          if (latest) for (const file of ['main.log', 'sharedprocess.log']) {
            const full = path.join(logsRoot, latest, file);
            if (!fs.existsSync(full) || fs.statSync(full).size > 16 * 1024 * 1024) continue;
            errors.push(...fs.readFileSync(full, 'utf8').split('\n').filter(line => /\[error\]/i.test(line)).slice(-20).map(line => ({ file, line: redactText(line, 400) })));
          }
        } catch { /* logs are optional */ }
        return {
          editor: prefix, cli_installed: Boolean(resolveTool(ctx, editor.tool).file), extensions: extensions.length,
          duplicate_extension_versions: extensions.filter(item => item.installed_versions > 1).map(item => item.id),
          untrusted_extensions: extensions.filter(item => !item.trusted).map(item => item.id),
          latest_log_session: latest, recent_errors: errors.slice(-20),
          limitation: 'Language-server Problems are not exported by the editor CLI; diagnostics are derived from logs and extension state.'
        };
      }
    },
    [`${prefix}_open_workspace`]: {
      validate: input => { keys(input, ['repo']); text(input.repo, 'repo'); return input; },
      assess: (ctx, input) => ({ scope: repoFor(ctx, input.repo).scope }),
      perform: async (ctx, input) => { const repo = repoFor(ctx, input.repo).canonical; const result = await ctx.exec.run(cli(ctx), [repo], { timeoutMs: 20_000 }); return { editor: prefix, opened: result.exitCode === 0, repo: ctx.scopes.display(repo) }; }
    },
    [`${prefix}_open_file`]: {
      validate: input => { keys(input, ['path'], ['line', 'column']); text(input.path, 'path'); integer(input.line, 'line', { min: 1, max: 10_000_000, optional: true }); integer(input.column, 'column', { min: 1, max: 100_000, optional: true }); return input; },
      assess: (ctx, input) => ({ scope: ctx.scopes.resolve(input.path, { mode: 'read', workspace: ctx.task.workspace }).scope }),
      perform: async (ctx, input) => {
        const file = ctx.scopes.resolve(input.path, { mode: 'read', workspace: ctx.task.workspace }).canonical;
        const target = `${file}:${input.line || 1}:${input.column || 1}`;
        const result = await ctx.exec.run(cli(ctx), ['-g', target], { timeoutMs: 20_000 });
        return { editor: prefix, opened: result.exitCode === 0, path: ctx.scopes.display(file), line: input.line || 1 };
      }
    },
    [`${prefix}_extension_install`]: {
      validate: extension, assess: (_ctx, input) => ({ scope: 'editor_extensions', dynamic: trustedDecision(input) }),
      perform: async (ctx, input) => { const result = await ctx.exec.run(cli(ctx), ['--install-extension', input.id], { timeoutMs: 180_000 }); if (result.exitCode !== 0) fail(`Extension install failed: ${redactText(result.stderr, 300)}`); return { editor: prefix, id: input.id, installed: true }; }
    },
    [`${prefix}_extension_update`]: {
      validate: extension, assess: (_ctx, input) => ({ scope: 'editor_extensions', dynamic: trustedDecision(input) }),
      perform: async (ctx, input) => { const result = await ctx.exec.run(cli(ctx), ['--install-extension', input.id, '--force'], { timeoutMs: 180_000 }); if (result.exitCode !== 0) fail(`Extension update failed: ${redactText(result.stderr, 300)}`); return { editor: prefix, id: input.id, updated: true }; }
    },
    [`${prefix}_extension_uninstall`]: {
      validate: extension, assess: () => ({ scope: 'editor_extensions' }),
      perform: async (ctx, input) => { const result = await ctx.exec.run(cli(ctx), ['--uninstall-extension', input.id.split('@')[0]], { timeoutMs: 120_000 }); if (result.exitCode !== 0) fail(`Extension uninstall failed: ${redactText(result.stderr, 300)}`); return { editor: prefix, id: input.id, uninstalled: true }; }
    },
    [`${prefix}_run_task`]: {
      validate: input => { keys(input, ['repo', 'label'], ['timeoutSeconds']); text(input.repo, 'repo'); text(input.label, 'label', { max: 200, multiline: false }); integer(input.timeoutSeconds, 'timeoutSeconds', { min: 1, max: 1_800, optional: true }); return input; },
      assess: (ctx, input) => {
        const repo = repoFor(ctx, input.repo).canonical;
        const plan = ideTaskPlan(ctx, repo, input.label);
        const dynamic = plan.error ? { decision: 'deny', kind: 'capability_denied', reason: plan.error } : plan.decision === 'auto_allow' ? null : { decision: plan.decision, riskClass: plan.decision === 'deny' ? 'PRIVILEGED' : 'DESTRUCTIVE', reason: `Task command classified ${plan.class}: ${plan.reasons.join('; ')}` };
        return { scope: 'workspace', dynamic, facts: { command_class: plan.class || null } };
      },
      perform: async (ctx, input) => {
        const repo = repoFor(ctx, input.repo).canonical;
        const plan = ideTaskPlan(ctx, repo, input.label);
        if (plan.error || !plan.file) fail(plan.error || 'Task command cannot be executed without a shell');
        ctx.exec.allow(plan.file);
        const runtime = require('./verification-runtime').dependencies(repo,input.label);
        const result = await ctx.exec.run(plan.file, plan.args, { cwd: repo, timeoutMs: (input.timeoutSeconds || 600) * 1_000, maxOutput: 256 * 1024, ...runtime });
        return { editor: prefix, label: input.label, command_class: plan.class, exit_code: result.exitCode, timed_out: result.timedOut, output: redactText(result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''), 48_000) };
      }
    }
  };
}

function ideTaskPlan(ctx, repo, label) {
  let tasks;
  try { tasks = jsonc(fs.readFileSync(path.join(repo, '.vscode', 'tasks.json'), 'utf8')).tasks; } catch { return { error: 'Repository has no readable .vscode/tasks.json' }; }
  const task = Array.isArray(tasks) ? tasks.find(item => item?.label === label) : null;
  if (!task) return { error: `No task labelled ${label}` };
  const quote = value => /[\s'"\\$`]/.test(value) ? `'${String(value).replace(/'/g, `'\\''`)}'` : String(value);
  let command;
  if (task.type === 'npm' && typeof task.script === 'string') command = `npm run ${quote(task.script)}`;
  else if (typeof task.command === 'string') command = [task.command, ...(Array.isArray(task.args) ? task.args.map(arg => typeof arg === 'string' ? quote(arg) : '') : [])].join(' ');
  else return { error: 'Task has no command' };
  const classified = classifyCommand(command, { cwd: repo });
  if (!classified.argv) return { ...classified, error: 'Task uses shell operators and cannot run without a shell' };
  const [head, ...args] = classified.argv;
  let file = null;
  if (head.startsWith('./') || head.startsWith('node_modules/')) {
    const candidate = path.resolve(repo, head);
    if (path.relative(repo, candidate).startsWith('..')) return { ...classified, error: 'Task script escapes the repository' };
    try { if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); file = candidate; } } catch { return { ...classified, error: 'Task script is not an executable file in the repository' }; }
  } else {
    const tool = { npm: 'npm', pnpm: 'pnpm', node: 'node', python3: 'python', python: 'python', git: 'git', make: 'make' }[head];
    if (!tool) return { ...classified, error: `Task executable ${head} is not allowlisted` };
    file = ctx.exec.resolveFirst(DEV_TOOLS[tool].candidates);
    if (!file) return { ...classified, error: `${head} is not installed` };
  }
  return { ...classified, file, args };
}

function developerCapabilities({ jobs = new ClaudeCodeJobs() } = {}) {
  const toolInput = input => { keys(input, ['tool']); oneOf(input.tool, TOOL_IDS, 'tool'); return input; };
  const manage = action => ({
    validate: input => { toolInput(input); if (!DEV_TOOLS[input.tool].manage?.[action]) fail(`${input.tool} has no ${action} adapter`); return input; },
    assess: () => ({ scope: 'machine_global' }),
    perform: async (ctx, input) => {
      const [manager, args] = DEV_TOOLS[input.tool].manage[action];
      const file = manager === 'self' ? resolveTool(ctx, input.tool).file : resolveTool(ctx, manager === 'brew' ? 'homebrew' : 'npm').file;
      if (!file) fail(`${manager} is not installed`);
      const result = await ctx.exec.run(file, args, { timeoutMs: 900_000, env: { HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', NONINTERACTIVE: '1' } });
      return { tool: input.tool, action, exit_code: result.exitCode, output: redactText(result.stdout.slice(-8_000) + result.stderr.slice(-4_000), 12_000) };
    }
  });
  return {
    developer_tool_list: { validate: input => keys(input), perform: async ctx => ({ tools: await Promise.all(TOOL_IDS.map(id => toolStatus(ctx, id))) }) },
    developer_tool_status: { validate: toolInput, perform: (ctx, input) => toolStatus(ctx, input.tool) },
    developer_tool_health: {
      validate: toolInput,
      perform: async (ctx, input) => {
        const status = await toolStatus(ctx, input.tool);
        const checks = { executable_runs: status.healthy === true };
        const { file } = resolveTool(ctx, input.tool);
        if (file && input.tool === 'gh') checks.authenticated = (await ctx.exec.run(file, ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 }).catch(() => ({ exitCode: 1 }))).exitCode === 0;
        if (file && input.tool === 'docker') checks.daemon_reachable = (await ctx.exec.run(file, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 }).catch(() => ({ exitCode: 1 }))).exitCode === 0;
        if (input.tool === 'ollama') checks.server_reachable = await ctx.probeHttp('http://127.0.0.1:11434/api/version');
        if (input.tool === 'claude_code') checks.logged_in = (await claudeAuth(ctx)).logged_in;
        return { ...status, checks };
      }
    },
    developer_tool_install: manage('install'),
    developer_tool_update: manage('update'),
    developer_tool_uninstall: manage('uninstall'),
    project_dependency_install: {
      validate: input => { keys(input, ['repo'], ['manager']); text(input.repo, 'repo'); oneOf(input.manager, ['npm', 'pnpm'], 'manager', { optional: true }); return input; },
      assess: (ctx, input) => {
        const repo = repoFor(ctx, input.repo, { write: true }).canonical;
        const manager = input.manager || (fs.existsSync(path.join(repo, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm');
        const lock = manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
        return { scope: 'workspace', dynamic: fs.existsSync(path.join(repo, lock)) ? null : { decision: 'approval_required', reason: `No ${lock}; an unlocked install resolves new dependency versions` } };
      },
      perform: async (ctx, input) => {
        const repo = repoFor(ctx, input.repo, { write: true }).canonical;
        const manager = input.manager || (fs.existsSync(path.join(repo, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm');
        const { file } = resolveTool(ctx, manager);
        if (!file) fail(`${manager} is not installed`);
        const locked = fs.existsSync(path.join(repo, manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'));
        const args = manager === 'pnpm' ? ['install', ...(locked ? ['--frozen-lockfile'] : []), '--ignore-scripts'] : [locked ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
        const result = await ctx.exec.run(file, args, { cwd: repo, timeoutMs: 900_000 });
        return { repo: ctx.scopes.display(repo), manager, lifecycle_scripts: 'disabled', exit_code: result.exitCode, output: redactText(result.stdout.slice(-6_000) + result.stderr.slice(-4_000), 10_000) };
      }
    },

    claude_code_status: {
      validate: input => keys(input),
      perform: async ctx => {
        const status = await toolStatus(ctx, 'claude_code');
        let install = null;
        if (status.installed) { try { install = /\/\.local\/share\/claude\/versions\//.test(fs.realpathSync(resolveTool(ctx, 'claude_code').file)) ? 'native' : 'package'; } catch {} }
        const auth = await claudeAuth(ctx);
        return { ...status, install_kind: install, logged_in: auth.logged_in, auth_mode: auth.auth_mode, api_key_overrides_subscription: auth.api_key_overrides_subscription, running_jobs: [...jobs.jobs.values()].filter(job => job.taskId === ctx.task.id && job.status === 'running').length };
      }
    },
    claude_code_version: { validate: input => keys(input), perform: async ctx => { const status = await toolStatus(ctx, 'claude_code'); return { installed: status.installed, version: status.version }; } },
    claude_code_auth_status: { validate: input => keys(input), perform: ctx => claudeAuth(ctx) },
    claude_code_launch: {
      validate: input => { keys(input, ['repo']); text(input.repo, 'repo'); return input; },
      assess: (ctx, input) => ({ scope: repoFor(ctx, input.repo).scope }),
      perform: async (ctx, input) => {
        const repo = repoFor(ctx, input.repo).canonical, { file } = resolveTool(ctx, 'claude_code');
        if (!file) fail('Claude Code is not installed');
        const result = await ctx.exec.run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application "Terminal" to do script ("cd " & quoted form of (item 1 of argv) & " && " & quoted form of (item 2 of argv))', '-e', 'tell application "Terminal" to activate', '-e', 'end run', repo, file], { timeoutMs: 20_000 });
        if (result.exitCode !== 0) return { launched: false, human_action: /-1743|not authorized|not allowed/i.test(result.stderr) ? ctx.policy.humanGate('macos_automation') : null, error: redactText(result.stderr, 300) };
        return { launched: true, repo: ctx.scopes.display(repo), interactive: true };
      }
    },
    claude_code_auth_login_open: {
      validate: input => keys(input),
      perform: async ctx => {
        const { file } = resolveTool(ctx, 'claude_code');
        if (!file) fail('Claude Code is not installed');
        const result = await ctx.exec.run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application "Terminal" to do script (quoted form of (item 1 of argv) & " auth login")', '-e', 'tell application "Terminal" to activate', '-e', 'end run', file], { timeoutMs: 20_000 });
        return { opened: result.exitCode === 0, authenticated_by_pi: false, human_action: ctx.policy.humanGate('claude_oauth_login'), ...(result.exitCode === 0 ? {} : { automation_permission: ctx.policy.humanGate('macos_automation') }) };
      }
    },
    claude_code_run_task: {
      validate: input => {
        keys(input, ['repo', 'prompt'], ['timeoutSeconds', 'billing', 'model', 'wait']);
        text(input.repo, 'repo'); text(input.prompt, 'prompt', { max: 32_000 }); integer(input.timeoutSeconds, 'timeoutSeconds', { min: 10, max: 3_600, optional: true });
        oneOf(input.billing, ['subscription', 'api_key_allowed'], 'billing', { optional: true }); pattern(input.model, /^[a-z0-9][a-z0-9.\-[\]]{1,63}$/, 'model', { optional: true }); bool(input.wait, 'wait');
        return input;
      },
      assess: (ctx, input) => {
        const repo = repoFor(ctx, input.repo, { write: true });
        const bridge = ctx.scopes.bridgeRoot && path.relative(ctx.scopes.bridgeRoot, repo.canonical) === '';
        return { scope: repo.scope, dynamic: bridge ? { decision: 'approval_required', riskClass: 'PRIVILEGED', reason: 'Claude Code editing the Airodrom control plane itself modifies the enforcement boundary' } : null };
      },
      perform: async (ctx, input) => {
        const repo = repoFor(ctx, input.repo, { write: true }).canonical, { file } = resolveTool(ctx, 'claude_code');
        if (!file) fail('Claude Code is not installed');
        const auth = await claudeAuth(ctx);
        const billing = input.billing || 'subscription';
        const env = {};
        if (billing === 'api_key_allowed' && ctx.env?.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = ctx.env.ANTHROPIC_API_KEY;
        if (billing === 'subscription' && !auth.logged_in) fail('Claude Code has no subscription login; the human must complete claude_oauth_login, or request billing:"api_key_allowed"');
        if (billing === 'subscription' && auth.api_key_sources.some(source => source !== 'bridge_process_env')) fail('Claude Code settings configure an API key that would override subscription billing; resolve the configuration or request billing:"api_key_allowed"');
        const before = await gitPorcelain(ctx, repo);
        const args = ['-p', input.prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', ...(input.model ? ['--model', input.model] : [])];
        // Mission workers use a bounded, isolated CLI configuration. Legacy capability callers retain their existing flags.
        if (ctx.task.controlPlaneMissionId) args.push('--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--max-turns', '8', '--tools', 'Read,Write,Edit', '--settings', JSON.stringify({disableAllHooks:true,autoMemoryEnabled:false,attribution:{commit:'',pr:''}}));
        const jobId = randomUUID();
        const controlRunId = ctx.controlExecution?.beginExternal(ctx.task, repo, jobId);
        let child;
        try { child = ctx.exec.spawnTracked(file, args, { cwd: repo, env }); }
        catch (error) { if (controlRunId) ctx.controlExecution.failedToSpawn(controlRunId); throw error; }
        const job = { id: jobId, taskId: ctx.task.id, repo, repoDisplay: ctx.scopes.display(repo), startedAt: Date.now(), status: 'running', child, apiKeyWithheld: !env.ANTHROPIC_API_KEY && Boolean(ctx.env?.ANTHROPIC_API_KEY), stdout: '' };
        jobs.jobs.set(job.id, job);
        child.stdout.on('data', chunk => { if (job.stdout.length < 1024 * 1024) job.stdout += chunk; });
        child.stderr.on('data', () => {});
        const timeout = setTimeout(() => jobs.cancel(job, 'timed_out'), (input.timeoutSeconds || 1_800) * 1_000);
        timeout.unref();
        const finished = new Promise(resolve => child.on('close', async code => {
          clearTimeout(timeout);
          job.exitCode = code; job.finishedAt = Date.now();
          let parsed = null; try { parsed = JSON.parse(job.stdout.trim().split('\n').at(-1)); } catch {}
          job.result = parsed ? { is_error: parsed.is_error === true, text: redactText(String(parsed.result || ''), 24_000), num_turns: Number.isSafeInteger(parsed.num_turns) ? parsed.num_turns : null, total_cost_usd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null } : { is_error: true, text: redactText(job.stdout, 4_000) };
          const after = await gitPorcelain(ctx, repo);
          if (after) {
            job.touched = [...after.keys()].filter(file => before?.get(file) !== after.get(file)).slice(0, 500);
            try { for (const file of job.touched) ctx.touch(path.join(repo, file)); } catch { /* task state may already be closed at shutdown */ }
          }
          // Settle last: a poll that sees a terminal status also sees the final result and touched files.
          if (job.status === 'running') job.status = code === 0 ? 'completed' : 'failed';
          try { if (controlRunId) ctx.controlExecution.settled(controlRunId, job); }
          catch { job.control_state = 'reconciliation_required'; }
          resolve();
        }));
        // Observers (agent.completed ledger events) wait on the same settlement.
        job.done = finished;
        if (controlRunId) {
          try { ctx.controlExecution.started(controlRunId, child.pid || null); }
          catch { jobs.cancel(job); throw new Error('Durable process observation failed; cancellation requested and lease retained'); }
        }
        if (input.wait === true) await finished;
        return jobs.snapshot(job);
      }
    },
    claude_code_task_status: { validate: input => { keys(input, ['jobId']); pattern(input.jobId, /^[0-9a-f-]{36}$/, 'jobId'); return input; }, perform: (ctx, input) => jobs.snapshot(jobs.owned(ctx.task.id, input.jobId)) },
    claude_code_task_cancel: { validate: input => { keys(input, ['jobId']); pattern(input.jobId, /^[0-9a-f-]{36}$/, 'jobId'); return input; }, perform: (ctx, input) => { const job = jobs.owned(ctx.task.id, input.jobId); return { cancelled: jobs.cancel(job), ...jobs.snapshot(job) }; } },

    ...editorCapabilities('cursor'),
    ...editorCapabilities('vscode'),
    ...containerCapabilities()
  };
}

function containerCapabilities() {
  const docker = ctx => { const { file } = resolveTool(ctx, 'docker'); if (!file) fail('Docker is not installed'); return file; };
  const run = async (ctx, args, options = {}) => {
    const result = await ctx.exec.run(docker(ctx), args, { timeoutMs: 60_000, ...options });
    if (result.exitCode !== 0) fail(/Cannot connect to the Docker daemon|daemon.*running/i.test(result.stderr) ? 'Docker daemon is not running; start Docker with app_launch or service_start' : `docker ${args[0]} failed: ${redactText(result.stderr, 300)}`);
    return result;
  };
  const named = input => { keys(input, ['container']); pattern(input.container, CONTAINER, 'container'); return input; };
  const databaseEscalation = async (ctx, input) => {
    const inspected = await ctx.exec.run(docker(ctx), ['inspect', '--format', '{{.Config.Image}}', input.container], { timeoutMs: 15_000 }).catch(() => null);
    const image = inspected?.exitCode === 0 ? inspected.stdout.trim() : '';
    return { scope: 'local_containers', dynamic: DATABASE_IMAGE.test(image) ? { decision: 'approval_required', riskClass: 'DESTRUCTIVE', reason: `Database container (${image.slice(0, 80)}) state changes require approval` } : null };
  };
  const lifecycle = verb => ({ validate: named, assess: databaseEscalation, perform: async (ctx, input) => { await run(ctx, [verb, input.container]); return { container: input.container, action: verb, ok: true }; } });
  return {
    container_list: {
      validate: input => { keys(input, [], ['all']); bool(input.all, 'all'); return input; },
      perform: async (ctx, input) => {
        const result = await run(ctx, ['ps', ...(input.all ? ['-a'] : []), '--format', '{{json .}}']);
        return { containers: result.stdout.split('\n').filter(Boolean).slice(0, 200).map(line => { try { const item = JSON.parse(line); return { id: item.ID, name: item.Names, image: item.Image, state: item.State, status: item.Status, ports: item.Ports }; } catch { return null; } }).filter(Boolean) };
      }
    },
    container_status: { validate: named, perform: async (ctx, input) => { const result = await run(ctx, ['inspect', '--format', '{{json .State}}', input.container]); const state = JSON.parse(result.stdout); return { container: input.container, status: state.Status, running: state.Running, exit_code: state.ExitCode, started_at: state.StartedAt, health: state.Health?.Status || null }; } },
    container_logs: {
      validate: input => { keys(input, ['container'], ['tail']); pattern(input.container, CONTAINER, 'container'); integer(input.tail, 'tail', { min: 1, max: 1_000, optional: true }); return input; },
      perform: async (ctx, input) => { const result = await run(ctx, ['logs', '--tail', String(input.tail || 200), input.container]); return { container: input.container, logs: redactText(result.stdout + result.stderr, 48_000) }; }
    },
    container_build: {
      validate: input => { keys(input, ['repo', 'tag'], ['dockerfile']); text(input.repo, 'repo'); pattern(input.tag, /^[a-z0-9][a-z0-9._\-/]{0,127}(?::[A-Za-z0-9._-]{1,128})?$/, 'tag'); text(input.dockerfile, 'dockerfile', { optional: true, max: 400 }); return input; },
      assess: (ctx, input) => ({ scope: repoFor(ctx, input.repo).scope }),
      perform: async (ctx, input) => {
        const repo = repoFor(ctx, input.repo).canonical;
        const dockerfile = input.dockerfile ? ctx.scopes.resolve(path.resolve(repo, input.dockerfile), { mode: 'read' }).canonical : path.join(repo, 'Dockerfile');
        if (path.relative(repo, dockerfile).startsWith('..')) fail('Dockerfile must be inside the repository');
        const result = await run(ctx, ['build', '-t', input.tag, '-f', dockerfile, repo], { timeoutMs: 1_800_000, cwd: repo });
        return { tag: input.tag, built: true, output: redactText(result.stdout.slice(-6_000) + result.stderr.slice(-6_000), 12_000) };
      }
    },
    container_start: lifecycle('start'),
    container_stop: lifecycle('stop'),
    container_restart: lifecycle('restart'),
    container_volume_delete: { validate: input => { keys(input, ['volume']); pattern(input.volume, CONTAINER, 'volume'); return input; }, assess: () => ({ scope: 'local_containers' }), perform: async (ctx, input) => { await run(ctx, ['volume', 'rm', input.volume]); return { volume: input.volume, deleted: true }; } },
    container_prune: { validate: input => keys(input), assess: () => ({ scope: 'local_containers' }), perform: async ctx => { const result = await run(ctx, ['container', 'prune', '-f'], { timeoutMs: 300_000 }); return { pruned: true, output: redactText(result.stdout, 4_000) }; } }
  };
}

module.exports = { developerCapabilities, ClaudeCodeJobs, DEV_TOOLS, TRUSTED_EXTENSIONS, EDITORS, installedExtensions, claudeAuth, toolStatus, resolveTool, jsonc };
