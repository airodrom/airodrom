'use strict';
/**
 * Always-on / full Mac reboot acceptance helpers.
 * Read-only verification by default; prepare writes only private acceptance state
 * and one synthetic ordinary memory through the installed service API.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PHRASE = 'My reboot verification phrase is Airodrom-Orbit-2026.';
const SUBJECT_HINT = 'reboot verification phrase';
const DIR_NAME = 'reboot-acceptance';

function acceptanceDir(home) {
  return path.join(home, DIR_NAME);
}

function pendingPath(home) {
  return path.join(acceptanceDir(home), 'pending.json');
}

function receiptPath(home) {
  return path.join(acceptanceDir(home), 'post-reboot-receipt.json');
}

function pause(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function privateWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function supervisorRows() {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  if (r.status !== 0) return [];
  return (r.stdout || '').split('\n').map(line => line.trim()).filter(line => /local-service\.cjs/.test(line) && !/\brg\b/.test(line));
}

function ollamaReady() {
  const r = spawnSync('/usr/bin/curl', ['-sS', '-m', '2', 'http://127.0.0.1:11434/api/tags'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').includes('models');
}

function integrityCheck(dataDir) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(dataDir, 'memory.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    const ok = (row.integrity_check || row['integrity_check']) === 'ok';
    return { file: 'memory.sqlite', ok };
  } finally {
    db.close();
  }
}

function backupDatabase(home, stamp) {
  const dataDir = path.join(home, 'data');
  const dest = path.join(home, 'backups', 'reboot-acceptance-' + stamp);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = require('node:sqlite');
  const src = path.join(dataDir, 'memory.sqlite');
  const out = path.join(dest, 'memory.sqlite');
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(out);
  } finally {
    db.close();
  }
  fs.chmodSync(out, 0o600);
  const check = integrityCheck(dest);
  if (!check.ok) throw Error('Backup integrity check failed.');
  privateWrite(path.join(dest, 'manifest.json'), {
    version: 1,
    created_at: stamp,
    source: 'memory.sqlite',
    integrity: check,
    authority: false
  });
  return { dir: dest, integrity: check };
}

function serviceIdentity(status, home) {
  const rows = supervisorRows();
  const command = rows[0] || '';
  const match = /\/install\/([^/]+)\//.exec(command);
  return {
    supervisor_count: rows.length,
    install_name: match ? match[1] : null,
    pid: status?.pid || null,
    healthy: !!status?.healthy,
    home
  };
}

const VERIFIER_LABEL = 'local.airodrom.reboot-acceptance';

function verifierAgentPath() {
  return path.join(os.homedir(), 'Library/LaunchAgents', VERIFIER_LABEL + '.plist');
}

function installVerifierAgent({ node, script, home, workingDirectory }) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${VERIFIER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>--experimental-sqlite</string>
    <string>${script}</string>
    <string>verify</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${os.homedir()}</string>
    <key>AIRODROM_HOME</key><string>${home}</string>
    <key>PATH</key><string>${path.dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>NODE_NO_WARNINGS</key><string>1</string>
  </dict>
  <key>WorkingDirectory</key><string>${workingDirectory}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${path.join(home, DIR_NAME, 'verifier.stdout.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(home, DIR_NAME, 'verifier.stderr.log')}</string>
  <key>ExitTimeOut</key><integer>180</integer>
</dict>
</plist>
`;
  const dest = verifierAgentPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.mkdirSync(acceptanceDir(home), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, body, { mode: 0o600 });
  const lint = spawnSync('/usr/bin/plutil', ['-lint', dest], { encoding: 'utf8' });
  if (lint.status !== 0) throw Error('Reboot verifier LaunchAgent failed validation.');
  const domain = `gui/${process.getuid()}`;
  // Boot out any current load so verify does not fire before reboot. The enabled
  // plist under ~/Library/LaunchAgents is loaded automatically at next login.
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${VERIFIER_LABEL}`], { encoding: 'utf8' });
  const en = spawnSync('/bin/launchctl', ['enable', `${domain}/${VERIFIER_LABEL}`], { encoding: 'utf8' });
  if (en.status !== 0) throw Error('Could not enable reboot verifier LaunchAgent.');
  return { label: VERIFIER_LABEL, path: dest, enabled: true, deferred_until_login: true };
}

function uninstallVerifierAgent() {
  const domain = `gui/${process.getuid()}`;
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${VERIFIER_LABEL}`], { encoding: 'utf8' });
  spawnSync('/bin/launchctl', ['disable', `${domain}/${VERIFIER_LABEL}`], { encoding: 'utf8' });
  fs.rmSync(verifierAgentPath(), { force: true });
  return { label: VERIFIER_LABEL, removed: true };
}

async function prepare(home, local = require('./local-bootstrap'), options = {}) {
  local.privateDirectory(home, true);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const status = await local.status(home, { allowOlderSource: true, timeoutMs: 8000 });
  if (!status.healthy) throw Error('Managed service is not healthy; prepare aborted.');
  const identity = serviceIdentity(status, home);
  if (identity.supervisor_count !== 1) throw Error('Expected exactly one local-service supervisor before reboot prepare.');
  const integrity = integrityCheck(path.join(home, 'data'));
  if (!integrity.ok) throw Error('Live memory.sqlite integrity check failed.');
  const backup = backupDatabase(home, stamp);
  // Preserve LaunchAgent configuration copies next to the backup (no secrets).
  const agents = path.join(backup.dir, 'launchagents');
  fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
  for (const name of ['local.airodrom.desktop-login.plist', 'local.airodrom.mcp-tunnel.plist']) {
    const src = path.join(os.homedir(), 'Library/LaunchAgents', name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(agents, name));
  }
  const remembered = await local.request(home, '/api/interactive/remember', { content: PHRASE });
  const memoryId = remembered.memoryId || remembered.memory_id || remembered.id;
  if (typeof memoryId !== 'string' || memoryId.length < 8) throw Error('Synthetic remember did not return a memory id.');
  const search = await local.request(home, '/api/interactive/memory?query=' + encodeURIComponent(SUBJECT_HINT));
  const items = search.items || search.results || [];
  const hit = items.find(item => (item.memoryId || item.memory_id || item.id) === memoryId)
    || items.find(item => String(item.content || '').includes('Airodrom-Orbit-2026'));
  if (!hit) throw Error('Synthetic reboot memory was not retrievable after remember.');
  let mcpReady = false;
  try {
    const health = await local.request(home, '/api/control-v2/health');
    mcpReady = health.bridge?.mcp_ready === true;
  } catch { /* recorded as false in baseline */ }
  const root = options.root || local.ROOT;
  const node = local.pin('node', process.execPath).path;
  const script = path.join(root, 'scripts/macos/reboot-acceptance.cjs');
  if (!fs.existsSync(script)) throw Error('Verifier script missing at ' + script);
  const pending = {
    version: 1,
    created_at: Date.now(),
    stamp,
    phrase: PHRASE,
    subject_hint: SUBJECT_HINT,
    memory_id: memoryId,
    expected_install_name: identity.install_name,
    expected_pid_at_prepare: identity.pid,
    backup_dir: backup.dir,
    backup_integrity: backup.integrity,
    agent_label: 'local.airodrom.desktop-login',
    verifier_label: VERIFIER_LABEL,
    baseline: {
      healthy: true,
      opencode_ready: status.opencode?.ready === true,
      product_memory: status.product?.memory || null,
      product_provider: status.product?.provider || null,
      product_model: status.product?.model || null,
      mcp_ready: mcpReady,
      ollama_ready: ollamaReady(),
      active_missions: status.product?.active_missions ?? null,
      mcp_tool_count_source: (() => { try { return require('./mcp-tools').TOOLS.length; } catch { return null; } })(),
      node_path: node,
      macos: (() => {
        const r = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
        return (r.stdout || '').trim() || null;
      })(),
      arch: process.arch
    },
    verification_commands: [
      'node --experimental-sqlite scripts/macos/reboot-acceptance.cjs status',
      'node --experimental-sqlite scripts/macos/reboot-acceptance.cjs verify',
      'AIRODROM_HOME=$HOME/.airodrom PATH=$HOME/.local/npm/bin:/opt/homebrew/opt/node@22/bin:/usr/bin:/bin airodrom status'
    ],
    post_reboot: 'After login, local.airodrom.reboot-acceptance RunAtLoad verifies pending.json and writes post-reboot-receipt.json. desktop-login remains the service starter. Continue with: node --experimental-sqlite scripts/macos/reboot-acceptance.cjs status',
    authority: false
  };
  // Persist pending before enabling the deferred login verifier.
  privateWrite(pendingPath(home), pending);
  const verifier = installVerifierAgent({ node, script, home, workingDirectory: root });
  pending.verifier_plist = verifier.path;
  privateWrite(pendingPath(home), pending);
  privateWrite(path.join(acceptanceDir(home), 'pre-reboot-baseline.json'), {
    ...pending,
    prepared_at: Date.now(),
    identity,
    verifier,
    authority: false
  });
  return {
    prepared: true,
    memory_id: memoryId,
    backup_dir: backup.dir,
    pending: pendingPath(home),
    identity,
    verifier,
    ollama_ready: ollamaReady(),
    mcp_ready: mcpReady,
    authority: false
  };
}

async function verify(home, local = require('./local-bootstrap'), { timeoutMs = 120000 } = {}) {
  // RunAtLoad fires on every login. With no pending stamp the verifier is an
  // idle no-op: exit success must not be read as reboot acceptance success.
  if (!fs.existsSync(pendingPath(home))) {
    return {
      version: 1,
      verified_at: Date.now(),
      pending: false,
      skipped: true,
      reason: 'no_pending_reboot_acceptance_state',
      ok: true,
      acceptance_ok: null,
      authority: false,
      identity: { supervisor_count: supervisorRows().length, home },
      status_summary: { pending: false, ollama_ready: ollamaReady() }
    };
  }
  const pending = readJson(pendingPath(home));
  const deadline = Date.now() + timeoutMs;
  let status = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      status = await local.status(home, { allowOlderSource: true, timeoutMs: 3000 });
      if (status.healthy) break;
    } catch (error) {
      lastError = error;
    }
    await pause(1000);
  }
  if (!status?.healthy) throw Error('Service did not become healthy after reboot: ' + (lastError?.message || 'unhealthy'));

  const identity = serviceIdentity(status, home);
  let mcpReady = false;
  let lifecycle = null;
  try {
    const health = await local.request(home, '/api/control-v2/health');
    mcpReady = health.bridge?.mcp_ready === true;
  } catch (error) {
    lastError = error;
  }
  try { lifecycle = await local.request(home, '/api/interactive/lifecycle'); } catch (error) { lastError = error; }
  const admissionOpen = status.admission === 'open' || lifecycle?.state === 'open';
  const checks = {
    service_healthy: !!status.healthy,
    one_supervisor: identity.supervisor_count === 1,
    install_identity: !pending.expected_install_name || identity.install_name === pending.expected_install_name,
    opencode_ready: status.opencode?.ready === true,
    admission_open: admissionOpen,
    memory_ready: admissionOpen && String(status.product?.memory || '') === 'Ready',
    ollama_ready: ollamaReady(),
    provider_ready: admissionOpen && String(status.product?.provider || '') === 'Ready',
    mcp_ready: mcpReady,
    discovery_ok: Number.isInteger(status.pid),
    memory_retrievable: false,
    memory_id_match: false,
    no_duplicate_supervisors: identity.supervisor_count === 1
  };

  let memoryItems = [];
  let memoryErrorClass = null;
  for (let i = 0; i < 30 && !checks.memory_retrievable; i++) {
    try {
      const search = await local.request(home, '/api/interactive/memory?query=' + encodeURIComponent(pending.subject_hint || SUBJECT_HINT));
      memoryItems = search.items || search.results || [];
      const hit = memoryItems.find(item => (item.memoryId || item.memory_id || item.id) === pending.memory_id)
        || memoryItems.find(item => String(item.content || '').includes('Airodrom-Orbit-2026'));
      checks.memory_retrievable = !!hit;
      checks.memory_id_match = !!(hit && (hit.memoryId || hit.memory_id || hit.id) === pending.memory_id);
      if (checks.memory_retrievable) break;
    } catch (error) {
      lastError = error;
      const msg = String(error.message || error);
      memoryErrorClass = /admission is closed|closed for maintenance/i.test(msg) ? 'admission_closed'
        : /identity|namespace|tenant/i.test(msg) ? 'identity_mismatch'
        : 'retrieval_error';
    }
    await pause(500);
  }

  const passed = Object.entries(checks).filter(([, v]) => v === true).length;
  const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
  const verifiedStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const stampedReceipt = path.join(acceptanceDir(home), 'post-reboot-receipt-' + verifiedStamp + '.json');
  const receipt = {
    version: 1,
    verified_at: Date.now(),
    verified_stamp: verifiedStamp,
    pending_stamp: pending.stamp,
    memory_id: pending.memory_id,
    identity,
    checks,
    passed,
    failed,
    ollama_ready: checks.ollama_ready,
    admission: {
      state: lifecycle?.state || status.admission || null,
      reconciled: lifecycle?.reconciled ?? null,
      idle: lifecycle?.idle ?? null,
      prior_state: lifecycle?.prior_state || null,
      hold_reason: lifecycle?.hold_reason || null,
      closed_startup: lifecycle?.closed_startup ?? null
    },
    memory_error_class: memoryErrorClass,
    status_summary: {
      healthy: status.healthy,
      admission: status.admission || null,
      opencode: status.opencode?.ready === true,
      product: status.product?.status || null
    },
    ok: failed.length === 0,
    // Process exit 0 from the verifier LaunchAgent must not be read as acceptance success.
    acceptance_ok: failed.length === 0,
    authority: false
  };
  // Preserve any historical receipt; always write a timestamped evidence file.
  privateWrite(stampedReceipt, receipt);
  if (!fs.existsSync(receiptPath(home))) privateWrite(receiptPath(home), receipt);
  else receipt.canonical_receipt_preserved = true;
  receipt.receipt_path = stampedReceipt;
  privateWrite(stampedReceipt, receipt);
  if (receipt.ok) {
    privateWrite(path.join(acceptanceDir(home), 'pending.completed.json'), { ...pending, completed_at: Date.now() });
    fs.rmSync(pendingPath(home), { force: true });
  }
  return receipt;
}

async function forgetTestMemory(home, local = require('./local-bootstrap')) {
  const completed = path.join(acceptanceDir(home), 'pending.completed.json');
  const source = fs.existsSync(pendingPath(home)) ? pendingPath(home) : completed;
  if (!fs.existsSync(source)) throw Error('No reboot acceptance memory checkpoint to forget.');
  const row = readJson(source);
  const result = await local.request(home, '/api/interactive/forget', { selection: row.memory_id });
  privateWrite(path.join(acceptanceDir(home), 'cleanup.json'), {
    forgotten_at: Date.now(),
    memory_id: row.memory_id,
    result_kind: result.kind || null,
    authority: false
  });
  return { forgotten: true, memory_id: row.memory_id, authority: false };
}

function status(home) {
  const pending = fs.existsSync(pendingPath(home));
  return {
    pending,
    receipt: fs.existsSync(receiptPath(home)),
    pending_path: pendingPath(home),
    receipt_path: receiptPath(home),
    supervisors: supervisorRows().length,
    ollama_ready: ollamaReady(),
    // Idle RunAtLoad verify is expected when pending is absent; launchctl
    // last_exit alone is not current service health.
    idle_verify_expected: !pending,
    authority: false
  };
}

module.exports = {
  PHRASE,
  SUBJECT_HINT,
  VERIFIER_LABEL,
  acceptanceDir,
  pendingPath,
  receiptPath,
  prepare,
  verify,
  forgetTestMemory,
  status,
  supervisorRows,
  ollamaReady,
  integrityCheck,
  backupDatabase,
  serviceIdentity,
  installVerifierAgent,
  uninstallVerifierAgent,
  verifierAgentPath
};
