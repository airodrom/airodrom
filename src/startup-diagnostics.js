'use strict';
// ADR 0031 read-only startup diagnostics. Fixed categories, counts and times only:
// no tokens, URLs, paths, process arguments or environment values. Never restarts.
const fs = require('node:fs');
const path = require('node:path');
const local = require('./local-bootstrap');
const runtime = require('./managed-service-runtime');
const agent = require('./managed-service-agent');

const NEXT = Object.freeze({
  setup_required: 'Run airodrom once to complete setup and qualify the local runtime.',
  configuration_mismatch: 'The installation belongs to another source checkout. Inspect the local installation configuration before changing it.',
  runtime_requalification_required: 'Run airodrom requalify, then the supervisor starts the service on its next check.',
  private_home_unsafe: 'Restore private, owned permissions on the Airodrom home; nothing was changed.',
  writer_lock_pid_reused: 'A writer lock from before this boot names a reused process ID. Confirm no Airodrom service is running, then remove only the stale writer lock file.',
  writer_lock_unverified: 'The writer lock is held by an unverified process. Inspect it before any restart; data was preserved.',
  crash_loop: 'The service failed repeatedly. Inspect recent supervisor events; one automatic retry follows the cooldown.',
  not_installed: 'Automatic login startup is not installed. Use the menu or airodrom start, or install it with npm run macos:service:install -- --apply.'
});

function discoveryState(home) {
  try { local.discovery(home); return 'valid'; }
  catch { return fs.existsSync(path.join(home, 'data', 'ui.json')) ? 'invalid' : 'missing'; }
}

function collect(home, { run, now = Date.now() } = {}) {
  const dataDir = path.join(home, 'data');
  let installed = { agent_installed: false, job: { loaded: false }, legacy_agents: [], tunnel: { loaded: false } };
  try { installed = agent.status({ run, airodromHome: home }); } catch {}
  const supervisor = runtime.readState(dataDir);
  const fresh = supervisor && now - supervisor.updated_at <= 90000;
  const writer = fs.existsSync(dataDir) ? runtime.owner(dataDir).state : 'none';
  const last = runtime.readEvents(dataDir, 50).filter(e => e.event === 'child_failed').at(-1) || null;
  const blocking = fresh && supervisor.state === 'BLOCKED' ? supervisor.blocked?.reason || 'unknown'
    : ['pid_reused', 'unverified'].includes(writer) ? 'writer_lock_' + writer
    : !installed.job.loaded ? 'not_installed' : null;
  const job = installed.job;
  return {
    automatic_startup: installed.agent_installed ? (job.loaded ? (job.state === 'running' ? 'Installed · running' : 'Installed · not running') : 'Installed · not loaded') : 'Not installed',
    legacy_agents: installed.legacy_agents.length,
    supervisor: fresh ? supervisor.state : supervisor ? 'UNKNOWN · stale status' : 'UNKNOWN · no supervisor status',
    supervisor_mode: fresh ? supervisor.mode : null,
    opencode_worker: fresh ? supervisor.worker?.opencode || 'UNKNOWN' : 'UNKNOWN',
    writer,
    discovery: discoveryState(home),
    tunnel: installed.tunnel.loaded ? (installed.tunnel.state === 'running' ? 'READY · process running' : 'DISCONNECTED · not running') : 'Not installed',
    last_recovery: last ? { at: new Date(last.at).toISOString(), reason: last.reason, delay_ms: last.delay_ms } : null,
    blocking_condition: blocking,
    next_action: blocking ? NEXT[blocking] || 'Run airodrom doctor --json and inspect the supervisor status.' : null
  };
}

function lines(s) {
  return ['Automatic startup: ' + s.automatic_startup, 'Supervisor: ' + s.supervisor + (s.supervisor_mode ? ' · ' + s.supervisor_mode : ''),
    'Writer lock: ' + s.writer, 'Discovery: ' + s.discovery, 'MCP tunnel: ' + s.tunnel,
    ...(s.last_recovery ? ['Last recovery: ' + s.last_recovery.reason + ' at ' + s.last_recovery.at] : []),
    ...(s.blocking_condition ? ['Blocking: ' + s.blocking_condition, s.next_action] : [])];
}

module.exports = { collect, lines, NEXT };
