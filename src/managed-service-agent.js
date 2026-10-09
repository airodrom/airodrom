'use strict';
// ADR 0031 LaunchAgent contract for the local service supervisor. Planning and
// status are read-only; install and uninstall change launchd only with apply:true.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const local = require('./local-bootstrap');
const { plist } = require('../scripts/macos/mcp-tunnel.cjs');

const LABEL = 'local.airodrom.service';
const LEGACY_LABELS = Object.freeze(['local.pi-chatgpt-bridge', 'local.pi-chatgpt-bridge.menubar']);
const TUNNEL_LABELS = Object.freeze(['local.airodrom.mcp-tunnel', 'local.pi-chatgpt-bridge.mcp-tunnel']);
// Homebrew's stable opt path survives node@22 patch upgrades; the pins still fail closed.
const STABLE_NODE = Object.freeze(['/opt/homebrew/opt/node@22/bin/node', '/usr/local/opt/node@22/bin/node']);

const launchctl = args => spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin' } });
const target = label => `gui/${process.getuid()}/${label}`;
const agentPath = (home, label) => path.join(home, 'Library/LaunchAgents', label + '.plist');

// Only allowlisted fields leave `launchctl print`; its environment and arguments never do.
function jobStatus(label, run = launchctl) {
  const r = run(['print', target(label)]);
  if (r.status !== 0) return { label, loaded: false, state: null, pid: null, last_exit_code: null, runs: null };
  const field = pattern => r.stdout.match(pattern)?.[1] ?? null;
  const exit = field(/^\s*last exit code = (-?\d+)/m);
  return { label, loaded: true, state: field(/^\s*state = ([a-z ]+?)\s*$/m), pid: Number(field(/^\s*pid = (\d+)/m)) || null, last_exit_code: exit === null ? null : Number(exit), runs: Number(field(/^\s*runs = (\d+)/m)) || 0 };
}

function stableNode(execPath, { exists = fs.existsSync, realpath = fs.realpathSync } = {}) {
  const real = realpath(execPath);
  return STABLE_NODE.find(candidate => { try { return exists(candidate) && realpath(candidate) === real; } catch { return false; } }) || real;
}

function plan({ home = os.homedir(), airodromHome = local.localHome(), root = local.ROOT, node = stableNode(process.execPath) } = {}) {
  const environment = { HOME: home, PATH: [path.dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), LANG: 'en_US.UTF-8', AIRODROM_HOME: airodromHome, NODE_NO_WARNINGS: '1' };
  const agent = {
    Label: LABEL,
    ProgramArguments: ['/usr/bin/env', '-i', ...Object.entries(environment).map(([key, value]) => key + '=' + value), node, '--experimental-sqlite', path.join(root, 'scripts/managed-service.cjs')],
    EnvironmentVariables: environment, WorkingDirectory: root,
    RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, ThrottleInterval: 30, ExitTimeOut: 45,
    ProcessType: 'Standard', LimitLoadToSessionType: 'Aqua', Umask: 63,
    StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null'
  };
  return { label: LABEL, path: agentPath(home, LABEL), agent, xml: plist(agent) };
}

function checks(p, { home = os.homedir(), airodromHome = local.localHome(), root = local.ROOT, run = launchctl } = {}) {
  const problems = [];
  if (process.platform !== 'darwin') problems.push('macos_required');
  // Never run the retired Pi Bridge agents and this supervisor side by side.
  for (const label of LEGACY_LABELS) if (fs.existsSync(agentPath(home, label)) || jobStatus(label, run).loaded) problems.push('legacy_agent_present:' + label);
  try {
    local.privateDirectory(airodromHome);
    const config = local.ownedJSON(path.join(airodromHome, 'local.json'));
    if (config.source !== root) problems.push('installation_source_mismatch');
  } catch { problems.push('installation_missing_or_unsafe'); }
  const agents = path.dirname(p.path);
  try { if (fs.lstatSync(agents).isSymbolicLink()) problems.push('launch_agents_symlink'); } catch {}
  let existing = null;
  try { const stat = fs.lstatSync(p.path); existing = stat.isFile() && !stat.isSymbolicLink() ? fs.readFileSync(p.path, 'utf8') : 'unsafe'; } catch {}
  if (existing === 'unsafe') problems.push('agent_path_unsafe');
  else if (existing !== null && existing !== p.xml) problems.push('agent_differs');
  return { problems, installed: existing === p.xml };
}

function install({ apply = false, replace = false, run = launchctl, ...options } = {}) {
  const p = plan(options), c = checks(p, { ...options, run });
  const blocking = c.problems.filter(problem => !(replace && problem === 'agent_differs'));
  if (blocking.length) return { label: LABEL, installed: false, refused: blocking };
  const job = jobStatus(LABEL, run);
  if (c.installed && job.loaded) return { label: LABEL, installed: true, changed: false, job };
  const steps = [c.installed ? null : 'write_agent', job.loaded ? 'bootout' : null, 'enable', 'bootstrap'].filter(Boolean);
  if (!apply) return { label: LABEL, dry_run: true, steps };
  let previous = null;
  try { previous = fs.readFileSync(p.path, 'utf8'); } catch {}
  try {
    fs.mkdirSync(path.dirname(p.path), { recursive: true, mode: 0o755 });
    const temporary = p.path + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, p.xml, { mode: 0o644, flag: 'wx' }); fs.renameSync(temporary, p.path);
    if (spawnSync('/usr/bin/plutil', ['-lint', p.path], { stdio: 'ignore' }).status !== 0) throw Error('lint');
    if (job.loaded) run(['bootout', target(LABEL)]);
    if (run(['enable', target(LABEL)]).status !== 0 || run(['bootstrap', `gui/${process.getuid()}`, p.path]).status !== 0) throw Error('bootstrap');
  } catch {
    run(['bootout', target(LABEL)]);
    if (previous === null) fs.rmSync(p.path, { force: true }); else fs.writeFileSync(p.path, previous, { mode: 0o644 });
    return { label: LABEL, installed: false, refused: ['launchd_bootstrap_failed'], rolled_back: true };
  }
  return { label: LABEL, installed: true, changed: true, job: jobStatus(LABEL, run) };
}

// Bootout sends SIGTERM; the supervisor stops only the child it launched.
function uninstall({ apply = false, run = launchctl, home = os.homedir() } = {}) {
  const file = agentPath(home, LABEL), job = jobStatus(LABEL, run), present = fs.existsSync(file);
  if (!apply) return { label: LABEL, dry_run: true, steps: [job.loaded ? 'bootout' : null, present ? 'remove_agent' : null].filter(Boolean) };
  if (job.loaded && run(['bootout', target(LABEL)]).status !== 0) return { label: LABEL, removed: false, refused: ['launchd_bootout_failed'] };
  fs.rmSync(file, { force: true });
  return { label: LABEL, removed: true };
}

function status({ run = launchctl, ...options } = {}) {
  const p = plan(options), c = checks(p, { ...options, run });
  return { label: LABEL, agent_installed: c.installed, agent_differs: c.problems.includes('agent_differs'), job: jobStatus(LABEL, run),
    legacy_agents: c.problems.filter(x => x.startsWith('legacy_agent_present:')).map(x => x.split(':')[1]),
    tunnel: TUNNEL_LABELS.map(label => jobStatus(label, run)).find(j => j.loaded) || { loaded: false } };
}

module.exports = { LABEL, LEGACY_LABELS, TUNNEL_LABELS, jobStatus, stableNode, plan, checks, install, uninstall, status };
