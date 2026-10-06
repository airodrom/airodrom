'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID}=require('node:crypto');
const { keys, text, integer, oneOf, pattern, fail, looksSecret, redactText } = require('./capability-util');
const { classifyCommand } = require('./command-classifier');

// Applications come only from this registry; callers name a registry key.
const APPS = Object.freeze({
  cursor: { label: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', app: '/Applications/Cursor.app' },
  vscode: { label: 'VS Code', bundleId: 'com.microsoft.VSCode', app: '/Applications/Visual Studio Code.app' },
  terminal: { label: 'Terminal', bundleId: 'com.apple.Terminal', app: '/System/Applications/Utilities/Terminal.app' },
  finder: { label: 'Finder', bundleId: 'com.apple.finder', app: '/System/Library/CoreServices/Finder.app', noQuit: true },
  safari: { label: 'Safari', bundleId: 'com.apple.Safari', app: '/Applications/Safari.app', browser: true },
  chrome: { label: 'Google Chrome', bundleId: 'com.google.Chrome', app: '/Applications/Google Chrome.app', browser: true },
  firefox: { label: 'Firefox', bundleId: 'org.mozilla.firefox', app: '/Applications/Firefox.app', browser: true },
  arc: { label: 'Arc', bundleId: 'company.thebrowser.Browser', app: '/Applications/Arc.app', browser: true },
  ollama: { label: 'Ollama', bundleId: 'com.electron.ollama', app: '/Applications/Ollama.app' },
  docker: { label: 'Docker Desktop', bundleId: 'com.docker.docker', app: '/Applications/Docker.app' },
  claude_desktop: { label: 'Claude', bundleId: 'com.anthropic.claudefordesktop', app: '/Applications/Claude.app' }
});
const APP_IDS = Object.keys(APPS);
const BROWSERS = APP_IDS.filter(id => APPS[id].browser);
// Development processes a routine task may stop when owned by the current user.
const DEV_PROCESSES = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'ruby', 'java', 'go', 'cargo', 'rustc', 'vite', 'next-server', 'webpack', 'esbuild', 'jest', 'vitest', 'pytest', 'uvicorn', 'gunicorn', 'flask', 'rails', 'php', 'tsc', 'tsserver', 'nodemon', 'http-server', 'serve', 'make', 'swift-frontend']);
const SYSTEM_PREFIXES = ['/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/', '/Library/Apple/', '/usr/bin/', '/bin/'];
const SECURITY_PROCESS = /(?:LittleSnitch|Little Snitch|falcon|CrowdStrike|SentinelOne|sentinel|Jamf|osquery|santa|BlockBlock|LuLu|KnockKnock|XProtect|syspolicyd|endpointsecurity|com\.apple\.security|MRT|Sophos|Malwarebytes|Norton|Avast|ESET|Bitdefender|Defender|wdav|Kandji|Mosyle|Addigy|1Password|Bitwarden|securityd|trustd|opendirectoryd|loginwindow|WindowServer|launchd|kernel_task|coreaudiod|mds|mds_stores)/i;
const SECRET_ENV_NAMES = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'NPM_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'CLOUDFLARE_API_TOKEN', 'VERCEL_TOKEN', 'OLLAMA_HOST']);
const NOTIFICATION_LIMIT = Object.freeze({ perMinute: 5, dedupeMs: 10 * 60_000 });
const notificationCaches=new Set(),notificationEpochs=new WeakMap(),notificationTimers=new WeakMap();
const OPAQUE_NOTIFICATION_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function pruneNotifications(state,at) {
  state.sent=(state.sent||[]).filter(item=>OPAQUE_NOTIFICATION_ID.test(item.key||'')&&typeof item.title==='string'&&typeof item.message==='string'&&Number.isSafeInteger(item.at)&&item.at<=at&&at-item.at<NOTIFICATION_LIMIT.dedupeMs);
  state.recent=(state.recent||[]).filter(time=>Number.isSafeInteger(time)&&time<=at&&at-time<60_000);
}
function scheduleNotificationExpiry(state,clock) {
  clearTimeout(notificationTimers.get(state));notificationTimers.delete(state);
  if(!state.sent.length)return;
  const ref=new WeakRef(state),delay=Math.max(1,Math.min(...state.sent.map(item=>item.at))+NOTIFICATION_LIMIT.dedupeMs-clock());
  const timer=setTimeout(()=>{const value=ref.deref();if(value){pruneNotifications(value,clock());scheduleNotificationExpiry(value,clock);}},delay);
  timer.unref?.();notificationTimers.set(state,timer);
}
// Host-only hook: erase the dedupe payload without retaining a digest of it.
// Non-content rate timestamps survive so erasure cannot bypass the send limit.
function clearNotificationCache() {
  let count=0;
  for(const ref of notificationCaches) {
    const state=ref.deref();if(!state){notificationCaches.delete(ref);continue;}
    count+=(state.sent||[]).length;state.sent=[];notificationEpochs.set(state,(notificationEpochs.get(state)||0)+1);
    clearTimeout(notificationTimers.get(state));notificationTimers.delete(state);
  }
  return {erased_notification_payloads:count,authority:false};
}

const OSASCRIPT = '/usr/bin/osascript', OPEN = '/usr/bin/open', PS = '/bin/ps', DF = '/bin/df', PMSET = '/usr/bin/pmset', SYSCTL = '/usr/sbin/sysctl', SW_VERS = '/usr/bin/sw_vers', LSOF = '/usr/sbin/lsof', DISKUTIL = '/usr/sbin/diskutil', PLUTIL = '/usr/bin/plutil', PBCOPY = '/usr/bin/pbcopy', PBPASTE = '/usr/bin/pbpaste';
const EXECUTABLES = [OSASCRIPT, OPEN, PS, DF, PMSET, SYSCTL, SW_VERS, LSOF, DISKUTIL, PLUTIL, PBCOPY, PBPASTE, '/usr/bin/tar'];

async function processTable(ctx) {
  const result = await ctx.exec.run(PS, ['-axo', 'pid=,ppid=,uid=,pcpu=,pmem=,etime=,lstart=,comm='], { timeoutMs: 15_000 });
  const rows = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), cpu: Number(match[4]), mem: Number(match[5]), elapsed: match[6], started: match[7], command: match[8].trim() });
  }
  return rows;
}

function protectedPids(ctx, table) {
  const pids = new Set([0, 1, process.pid, process.ppid]);
  for (const pid of ctx.bridgePids?.() || []) pids.add(pid);
  // Ancestors of the bridge are protected so a task cannot kill its own supervisor.
  const parents = new Map(table.map(row => [row.pid, row.ppid]));
  let cursor = process.ppid;
  for (let depth = 0; cursor > 1 && depth < 32; depth++) { pids.add(cursor); cursor = parents.get(cursor); }
  return pids;
}

function classifyProcess(ctx, row, table) {
  if (!row) return { decision: 'deny', kind: 'capability_denied', reason: 'Process does not exist' };
  if (protectedPids(ctx, table).has(row.pid)) return { decision: 'deny', kind: 'safety_denial', riskClass: 'SECURITY', reason: 'The bridge, its supervisors and its workers are protected' };
  if (row.uid !== process.getuid()) return { decision: 'deny', kind: 'capability_denied', riskClass: 'PRIVILEGED', reason: 'Process belongs to another user or the system' };
  if (SECURITY_PROCESS.test(row.command)) return { decision: 'deny', kind: 'capability_denied', riskClass: 'SECURITY', reason: 'Security and core system software is never stopped' };
  if (SYSTEM_PREFIXES.some(prefix => row.command.startsWith(prefix))) return { decision: 'approval_required', riskClass: 'PRIVILEGED', reason: 'System-provided executable requires approval' };
  const name = path.basename(row.command);
  if (DEV_PROCESSES.has(name)) return null;
  return { decision: 'approval_required', riskClass: 'DESTRUCTIVE', reason: `${name} is not an allowlisted development process` };
}

function appRunning(table, app) {
  const marker = `${app.app}/Contents/MacOS/`;
  return table.filter(row => row.command.startsWith(marker)).map(row => row.pid);
}

async function osa(ctx, lines, args, timeoutMs = 20_000) {
  const argv = ['-e', 'on run argv', ...lines.flatMap(line => ['-e', line]), '-e', 'end run', ...args];
  return ctx.exec.run(OSASCRIPT, argv, { timeoutMs });
}

async function probeHttp(url, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetch(url, { signal: controller.signal }); return response.ok; } catch { return false; } finally { clearTimeout(timer); }
}

async function plist(ctx, args) {
  const result = await ctx.exec.run(DISKUTIL, args, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) fail(`diskutil failed: ${redactText(result.stderr, 200)}`);
  const converted = await ctx.exec.run(PLUTIL, ['-convert', 'json', '-o', '-', '-'], { input: result.stdout, timeoutMs: 15_000 });
  if (converted.exitCode !== 0) fail('Disk information could not be decoded');
  return JSON.parse(converted.stdout);
}

// Fixed service registry. Unknown services never resolve.
function serviceRegistry(ctx) {
  const services = {
    pi_bridge: {
      label: 'Pi bridge', status: async () => ({ running: true, pid: process.pid, uptime_s: Math.round(process.uptime()) }),
      restart: async () => { if (typeof ctx.requestBridgeRestart !== 'function') fail('Bridge restart is unavailable'); return ctx.requestBridgeRestart(); },
      start: () => fail('The bridge is already running'), stop: () => fail('Stopping the bridge from inside a task is denied; use service_restart')
    },
    ollama: {
      label: 'Ollama',
      status: async () => ({ running: await ctx.probeHttp('http://127.0.0.1:11434/api/version'), endpoint: 'http://127.0.0.1:11434' }),
      start: async () => ({ launched: (await ctx.exec.run(OPEN, ['-g', '-b', APPS.ollama.bundleId], { timeoutMs: 20_000 })).exitCode === 0 }),
      stop: async () => ({ stopped: (await osa(ctx, ['tell application id (item 1 of argv) to quit'], [APPS.ollama.bundleId])).exitCode === 0 }),
      restart: async () => { await services.ollama.stop(); await new Promise(resolve => setTimeout(resolve, 1_500)); return services.ollama.start(); }
    }
  };
  for (const item of ctx.localServices || []) {
    const pidFile = path.join(ctx.piOwnedRoot || os.tmpdir(), 'services', `${item.name}.pid`);
    const readPid = () => { try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) || null; } catch { return null; } };
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    services[item.name] = {
      label: item.label || item.name, local: true,
      status: async () => { const pid = readPid(); return { running: Boolean(pid && alive(pid)), pid: pid && alive(pid) ? pid : null, ...(item.readyUrl ? { ready: await ctx.probeHttp(item.readyUrl) } : {}) }; },
      start: async () => {
        const pid = readPid(); if (pid && alive(pid)) return { running: true, pid, already: true };
        fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
        const child = ctx.exec.spawnTracked(item.executable, item.args, { cwd: item.cwd });
        const log = fs.createWriteStream(pidFile.replace(/\.pid$/, '.log'), { flags: 'a', mode: 0o600 });
        child.stdout.pipe(log); child.stderr.pipe(log); child.unref?.();
        fs.writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
        return { started: true, pid: child.pid };
      },
      stop: async () => { const pid = readPid(); if (!pid || !alive(pid)) return { running: false }; process.kill(pid, 'SIGTERM'); fs.rmSync(pidFile, { force: true }); return { stopped: true, pid }; },
      restart: async () => { await services[item.name].stop(); await new Promise(resolve => setTimeout(resolve, 500)); return services[item.name].start(); }
    };
  }
  return services;
}

// Local dev services are declared by the operator, never by a model. Each entry
// must run an allowlisted development command inside an approved project root.
function loadLocalServices(filePath, scopes, exec) {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf8')).services || []; } catch { return []; }
  const valid = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    try {
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(item.name) || ['pi_bridge', 'ollama'].includes(item.name) || !Array.isArray(item.argv) || !item.argv.length) continue;
      const cwd = scopes.approvedRepository(item.cwd).canonical;
      const classified = classifyCommand(item.argv.map(arg => /[\s'"]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg).join(' '), { cwd });
      if (!['read_only', 'safe_dev_execution'].includes(classified.class)) continue;
      const executable = exec.resolveFirst([{ npm: '/opt/homebrew/opt/node@22/bin/npm', node: '/opt/homebrew/opt/node@22/bin/node', python3: '/opt/homebrew/bin/python3', pnpm: '/opt/homebrew/bin/pnpm' }[item.argv[0]]].filter(Boolean));
      if (!executable) continue;
      exec.allow(executable);
      valid.push({ name: item.name, label: item.label, cwd, executable, args: item.argv.slice(1), readyUrl: /^http:\/\/127\.0\.0\.1:\d{2,5}\//.test(item.readyUrl || '') ? item.readyUrl : null });
    } catch { /* invalid entries are ignored */ }
  }
  return valid;
}

function macCapabilities({ notificationState = { sent: [] },now=Date.now } = {}) {
  if(!notificationEpochs.has(notificationState)) {
    // A pre-upgrade digest cache has no erasable payload to dedupe safely.
    // Preserve rate timestamps, then discard those legacy fingerprints.
    notificationState.recent=(notificationState.recent||notificationState.sent?.map(item=>item.at)||[]).filter(at=>Number.isSafeInteger(at));
    notificationEpochs.set(notificationState,0);notificationCaches.add(new WeakRef(notificationState));
  }
  pruneNotifications(notificationState,now());scheduleNotificationExpiry(notificationState,now);
  const appInput = input => { keys(input, ['app']); oneOf(input.app, APP_IDS, 'app'); return input; };
  const serviceInput = input => { keys(input, ['service']); pattern(input.service, /^[a-z][a-z0-9_]{1,40}$/, 'service'); return input; };
  const serviceAssess = verb => (ctx, input) => {
    const service = serviceRegistry(ctx)[input.service];
    if (!service) return { scope: 'services', dynamic: { decision: 'deny', kind: 'capability_denied', reason: `Service ${input.service} is not in the fixed registry` } };
    if (input.service === 'pi_bridge' && verb !== 'restart' && verb !== 'status') return { scope: 'services', dynamic: { decision: 'deny', kind: 'capability_denied', reason: 'Only status and restart are available for the Pi bridge' } };
    return { scope: 'services' };
  };
  const serviceVerb = verb => ({ validate: serviceInput, assess: serviceAssess(verb), perform: async (ctx, input) => ({ service: input.service, action: verb, ...(await serviceRegistry(ctx)[input.service][verb]()) }) });
  const url = value => { text(value, 'url', { max: 2_048, multiline: false }); let parsed; try { parsed = new URL(value); } catch { fail('Invalid url'); } if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('Only plain http(s) URLs are allowed'); return parsed.href; };
  const browserOpen = {
    validate: input => { keys(input, ['url'], ['browser']); url(input.url); oneOf(input.browser, BROWSERS, 'browser', { optional: true }); return input; },
    assess: () => ({ scope: 'browser' }),
    perform: async (ctx, input) => {
      const args = input.browser ? ['-b', APPS[input.browser].bundleId, url(input.url)] : [url(input.url)];
      const result = await ctx.exec.run(OPEN, args, { timeoutMs: 20_000 });
      return { opened: result.exitCode === 0, host: new URL(input.url).host, browser: input.browser || 'default' };
    }
  };
  return {
    app_status: {
      validate: input => { keys(input, [], ['app']); oneOf(input.app, APP_IDS, 'app', { optional: true }); return input; },
      perform: async (ctx, input) => {
        const table = await processTable(ctx);
        const ids = input.app ? [input.app] : APP_IDS;
        return { apps: ids.map(id => ({ app: id, label: APPS[id].label, installed: fs.existsSync(APPS[id].app), running: appRunning(table, APPS[id]).length > 0 })) };
      }
    },
    app_launch: { validate: appInput, assess: (_ctx, input) => ({ scope: 'apps', dynamic: fs.existsSync(APPS[input.app].app) ? null : { decision: 'deny', kind: 'capability_denied', reason: `${APPS[input.app].label} is not installed` } }), perform: async (ctx, input) => ({ app: input.app, launched: (await ctx.exec.run(OPEN, ['-b', APPS[input.app].bundleId], { timeoutMs: 20_000 })).exitCode === 0 }) },
    app_focus: { validate: appInput, perform: async (ctx, input) => ({ app: input.app, focused: (await ctx.exec.run(OPEN, ['-b', APPS[input.app].bundleId], { timeoutMs: 20_000 })).exitCode === 0 }) },
    app_quit: {
      validate: appInput,
      assess: (_ctx, input) => ({ scope: 'apps', dynamic: APPS[input.app].noQuit ? { decision: 'deny', kind: 'capability_denied', reason: `${APPS[input.app].label} is not quittable` } : null }),
      perform: async (ctx, input) => {
        const result = await osa(ctx, ['tell application id (item 1 of argv) to quit'], [APPS[input.app].bundleId]);
        if (result.exitCode !== 0 && /-1743|not authorized|not allowed/i.test(result.stderr)) return { app: input.app, quit: false, human_action: ctx.policy.humanGate('macos_automation') };
        return { app: input.app, quit: result.exitCode === 0 };
      }
    },

    process_list: {
      validate: input => { keys(input, [], ['filter', 'limit']); text(input.filter, 'filter', { max: 80, optional: true, multiline: false }); integer(input.limit, 'limit', { min: 1, max: 1_000, optional: true }); return input; },
      perform: async (ctx, input) => {
        const table = await processTable(ctx);
        const uid = process.getuid();
        const rows = table.filter(row => !input.filter || path.basename(row.command).toLowerCase().includes(input.filter.toLowerCase()));
        return { processes: rows.slice(0, input.limit || 200).map(row => ({ pid: row.pid, ppid: row.ppid, name: path.basename(row.command), owner: row.uid === uid ? 'current_user' : row.uid === 0 ? 'root' : 'other', cpu: row.cpu, mem: row.mem, elapsed: row.elapsed })), total: rows.length, note: 'Command arguments are never listed because they can contain secrets.' };
      }
    },
    process_status: {
      validate: input => { keys(input, ['pid']); integer(input.pid, 'pid', { min: 1, max: 99_999_999 }); return input; },
      perform: async (ctx, input) => {
        const table = await processTable(ctx);
        const row = table.find(item => item.pid === input.pid);
        if (!row) return { pid: input.pid, running: false };
        const classification = classifyProcess(ctx, row, table);
        return { pid: row.pid, running: true, name: path.basename(row.command), owner: row.uid === process.getuid() ? 'current_user' : 'other', cpu: row.cpu, mem: row.mem, elapsed: row.elapsed, stop_decision: classification ? classification.decision : 'auto_allow' };
      }
    },
    process_stop: {
      validate: input => { keys(input, ['pid'], ['signal']); integer(input.pid, 'pid', { min: 2, max: 99_999_999 }); oneOf(input.signal, ['SIGTERM', 'SIGINT', 'SIGKILL'], 'signal', { optional: true }); return input; },
      assess: async (ctx, input) => {
        const table = await processTable(ctx);
        const row = table.find(item => item.pid === input.pid);
        return { scope: 'processes', dynamic: classifyProcess(ctx, row, table), facts: row ? { name: path.basename(row.command), started: row.started } : null };
      },
      perform: async (ctx, input, assessment) => {
        const table = await processTable(ctx);
        const row = table.find(item => item.pid === input.pid);
        // The pid must still be the same process that was classified.
        if (!row || path.basename(row.command) !== assessment?.facts?.name || row.started !== assessment?.facts?.started) fail('Process changed since it was classified; not stopped');
        const escalation = classifyProcess(ctx, row, table);
        if (escalation?.decision === 'deny') fail(escalation.reason);
        process.kill(input.pid, input.signal || 'SIGTERM');
        return { pid: input.pid, name: path.basename(row.command), signal: input.signal || 'SIGTERM', sent: true };
      }
    },

    service_status: {
      validate: input => { keys(input, [], ['service']); pattern(input.service, /^[a-z][a-z0-9_]{1,40}$/, 'service', { optional: true }); return input; },
      assess: (ctx, input) => input.service ? serviceAssess('status')(ctx, input) : { scope: 'services' },
      perform: async (ctx, input) => {
        const registry = serviceRegistry(ctx);
        const names = input.service ? [input.service] : Object.keys(registry);
        return { services: await Promise.all(names.map(async name => ({ service: name, label: registry[name].label, ...(await registry[name].status()) }))) };
      }
    },
    service_start: serviceVerb('start'),
    service_stop: serviceVerb('stop'),
    service_restart: serviceVerb('restart'),

    clipboard_read: {
      validate: input => keys(input),
      perform: async ctx => {
        const result = await ctx.exec.run(PBPASTE, [], { timeoutMs: 10_000, maxOutput: 256 * 1024 });
        const content = result.stdout;
        // Secret-like clipboard content is never returned, logged or persisted.
        if (looksSecret(content)) return { secret_like: true, withheld: true, bytes: Buffer.byteLength(content) };
        return { secret_like: false, content, bytes: Buffer.byteLength(content), truncated: result.truncated };
      },
      redactOutput: true
    },
    clipboard_write: {
      validate: input => { keys(input, ['content']); text(input.content, 'content', { max: 256 * 1024, min: 0 }); return input; },
      perform: async (ctx, input) => ({ written: (await ctx.exec.run(PBCOPY, [], { input: input.content, timeoutMs: 10_000 })).exitCode === 0, bytes: Buffer.byteLength(input.content), secret_like: looksSecret(input.content) }),
      redactInput: ['content']
    },
    notification_send: {
      validate: input => { keys(input, ['title', 'message'], ['category']); text(input.title, 'title', { max: 120, multiline: false }); text(input.message, 'message', { max: 400 }); oneOf(input.category, ['task_completed', 'task_failed', 'ci_failure', 'reminder', 'bridge_recovery', 'event', 'info'], 'category', { optional: true }); return input; },
      assess: (ctx, input) => {
        const at=now();pruneNotifications(notificationState,at);
        if (notificationState.sent.some(item => item.title===input.title&&item.message===input.message)) return { scope: 'notifications', dynamic: { decision: 'deny', kind: 'capability_denied', reason: 'Duplicate notification suppressed' } };
        if (notificationState.recent.length >= NOTIFICATION_LIMIT.perMinute) return { scope: 'notifications', dynamic: { decision: 'deny', kind: 'capability_denied', reason: 'Notification rate limit reached' } };
        return { scope: 'notifications' };
      },
      perform: async (ctx, input) => {
        if (looksSecret(input.message) || looksSecret(input.title)) fail('Notifications may not contain secret-like text');
        const epoch=notificationEpochs.get(notificationState);
        const result = await osa(ctx, ['display notification (item 2 of argv) with title (item 1 of argv)'], [input.title, input.message]);
        const at=now();pruneNotifications(notificationState,at);notificationState.recent.push(at);
        if(notificationEpochs.get(notificationState)===epoch)notificationState.sent.push({key:randomUUID(),title:input.title,message:input.message,at});
        scheduleNotificationExpiry(notificationState,now);
        return { delivered: result.exitCode === 0, category: input.category || 'info' };
      }
    },

    system_info: {
      validate: input => keys(input),
      perform: async ctx => {
        const version = await ctx.exec.run(SW_VERS, [], { timeoutMs: 10_000 });
        const model = await ctx.exec.run(SYSCTL, ['-n', 'hw.model'], { timeoutMs: 10_000 });
        const field = name => (new RegExp(`${name}:\\s*(.+)`).exec(version.stdout) || [])[1]?.trim() || null;
        return { os: field('ProductName'), os_version: field('ProductVersion'), build: field('BuildVersion'), kernel: os.release(), arch: os.arch(), model: model.stdout.trim() || null, cpus: os.cpus().length, memory_bytes: os.totalmem(), uptime_s: Math.round(os.uptime()), node: process.version };
      }
    },
    battery_status: {
      validate: input => keys(input),
      perform: async ctx => {
        const result = await ctx.exec.run(PMSET, ['-g', 'batt'], { timeoutMs: 10_000 });
        const source = /Now drawing from '([^']+)'/.exec(result.stdout)?.[1] || null;
        const battery = /(\d+)%;\s*([^;]+);\s*([^\n]*)/.exec(result.stdout);
        return { power_source: source, battery_present: Boolean(battery), percent: battery ? Number(battery[1]) : null, state: battery ? battery[2].trim() : null, remaining: battery ? battery[3].replace(/present:.*$/, '').trim() || null : null };
      }
    },
    storage_status: {
      validate: input => keys(input),
      perform: () => ({ volumes: ['/', os.homedir()].concat(fs.existsSync('/Volumes') ? fs.readdirSync('/Volumes').map(name => path.join('/Volumes', name)) : []).map(mount => { try { const stat = fs.statfsSync(mount); return { mount: mount === os.homedir() ? '~' : mount, total_bytes: stat.blocks * stat.bsize, free_bytes: stat.bavail * stat.bsize }; } catch { return null; } }).filter(Boolean) })
    },
    network_status: {
      validate: input => keys(input),
      perform: () => ({ interfaces: Object.entries(os.networkInterfaces()).map(([name, addresses]) => ({ name, internal: addresses.every(item => item.internal), ipv4: addresses.some(item => item.family === 'IPv4'), ipv6: addresses.some(item => item.family === 'IPv6') })), note: 'Addresses and hardware identifiers are omitted.' })
    },
    mounted_volumes: {
      validate: input => keys(input),
      perform: async ctx => {
        const result = await ctx.exec.run(DF, ['-k', '-P'], { timeoutMs: 10_000 });
        return { volumes: result.stdout.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 6 && (parts[5] === '/' || parts[5].startsWith('/Volumes/'))).map(parts => ({ device: parts[0], size_kb: Number(parts[1]), used_kb: Number(parts[2]), available_kb: Number(parts[3]), capacity: parts[4], mount: parts.slice(5).join(' ') })) };
      }
    },
    service_health: {
      validate: input => keys(input),
      perform: async ctx => { const registry = serviceRegistry(ctx); return { services: await Promise.all(Object.entries(registry).map(async ([name, service]) => ({ service: name, ...(await service.status().catch(error => ({ error: error.message }))) }))) }; }
    },
    port_status: {
      validate: input => { keys(input, [], ['port']); integer(input.port, 'port', { min: 1, max: 65_535, optional: true }); return input; },
      perform: async (ctx, input) => {
        const result = await ctx.exec.run(LSOF, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeoutMs: 15_000 });
        const listeners = []; let pid = null, command = null;
        for (const line of result.stdout.split('\n')) {
          if (line.startsWith('p')) pid = Number(line.slice(1));
          else if (line.startsWith('c')) command = line.slice(1);
          else if (line.startsWith('n')) { const port = Number(/:(\d+)$/.exec(line)?.[1]); if (port && (!input.port || port === input.port)) listeners.push({ port, pid, command, address: line.slice(1).replace(/:\d+$/, '') }); }
        }
        return { listeners: listeners.slice(0, 500), filtered_port: input.port || null };
      }
    },

    disk_list: {
      validate: input => keys(input),
      perform: async ctx => {
        const data = await plist(ctx, ['list', '-plist']);
        return { disks: (data.AllDisksAndPartitions || []).map(disk => ({ device: disk.DeviceIdentifier, size_bytes: disk.Size, content: disk.Content || null, volume: disk.VolumeName || null, mount: disk.MountPoint || null, partitions: (disk.Partitions || disk.APFSVolumes || []).map(part => ({ device: part.DeviceIdentifier, size_bytes: part.Size, content: part.Content || null, volume: part.VolumeName || null, mount: part.MountPoint || null })) })) };
      }
    },
    disk_info: {
      validate: input => { keys(input, ['device']); pattern(input.device, /^disk\d{1,3}(?:s\d{1,3})?$/, 'device'); return input; },
      perform: async (ctx, input) => {
        const info = await plist(ctx, ['info', '-plist', `/dev/${input.device}`]);
        const pick = ['DeviceIdentifier', 'MediaName', 'Size', 'SMARTStatus', 'SolidState', 'Internal', 'RemovableMedia', 'Ejectable', 'FilesystemType', 'FilesystemName', 'VolumeName', 'MountPoint', 'WritableMedia', 'WritableVolume', 'BusProtocol', 'Encryption', 'FileVault'];
        return Object.fromEntries(pick.filter(key => Object.hasOwn(info, key)).map(key => [key, info[key]]));
      }
    },
    disk_health: {
      validate: input => { keys(input, ['device']); pattern(input.device, /^disk\d{1,3}(?:s\d{1,3})?$/, 'device'); return input; },
      perform: async (ctx, input) => {
        const info = await plist(ctx, ['info', '-plist', `/dev/${input.device}`]);
        return { device: input.device, smart_status: info.SMARTStatus || 'Not Supported', solid_state: info.SolidState ?? null, internal: info.Internal ?? null, writable: info.WritableMedia ?? null, note: 'Read-only health. Verification or repair that writes requires approval.' };
      }
    },

    browser_open: browserOpen,
    browser_navigate: browserOpen,
    browser_read: {
      validate: input => { keys(input, ['url']); url(input.url); return input; },
      assess: (ctx, input) => ({ scope: 'network', dynamic: ctx.webEnabled?.() ? null : { decision: 'deny', kind: 'capability_denied', reason: 'Host network reading is disabled in bridge configuration' } }),
      perform: async (ctx, input) => ctx.webFetch({ url: input.url, method: 'GET' })
    },

    secret_status: {
      validate: input => { keys(input, ['name']); pattern(input.name, /^[A-Z][A-Z0-9_]{1,63}$/, 'name'); return input; },
      assess: (_ctx, input) => ({ scope: 'secrets', dynamic: SECRET_ENV_NAMES.has(input.name) ? null : { decision: 'deny', kind: 'capability_denied', reason: 'Secret name is not in the status allowlist' } }),
      perform: (ctx, input) => ({ secret_name: input.name, secret_exists: Boolean(ctx.env?.[input.name]), source: 'bridge_process_env', value_returned: false })
    }
  };
}

module.exports = { macCapabilities, clearNotificationCache, loadLocalServices, serviceRegistry, classifyProcess, processTable, probeHttp, APPS, EXECUTABLES, DEV_PROCESSES, SECRET_ENV_NAMES };
