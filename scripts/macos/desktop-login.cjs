'use strict';
/**
 * Opt-in login startup for the managed local Airodrom desktop path.
 * Starts Ollama (if needed), the owned Control Plane via local.start, then the native menu.
 * Does not use legacy local.pi-chatgpt-bridge agents or startup PR #36.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const local = require('../../src/local-bootstrap');

const LABEL = 'local.airodrom.desktop-login';
const agentsDir = path.join(os.homedir(), 'Library/LaunchAgents');
const agentPath = path.join(agentsDir, LABEL + '.plist');

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function ollamaReady() {
  const r = spawnSync('/usr/bin/curl', ['-sS', '-m', '1', 'http://127.0.0.1:11434/api/tags'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').includes('models');
}

async function ensureOllama(timeoutMs = 60000) {
  if (ollamaReady()) return { started: false, ready: true };
  const app = '/Applications/Ollama.app';
  if (!fs.existsSync(app)) throw Error('Ollama.app is not installed in /Applications.');
  spawnSync('/usr/bin/open', ['-a', 'Ollama'], { stdio: 'ignore', timeout: 10000 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ollamaReady()) return { started: true, ready: true };
    await pause(500);
  }
  throw Error('Ollama did not become ready on 127.0.0.1:11434.');
}

async function ensureService(home) {
  return local.start(home);
}

function ensureMenu(home) {
  const app = require('./prepare-local-menu.cjs').prepare(home);
  const r = spawnSync('/usr/bin/open', [app], { stdio: 'ignore', timeout: 5000 });
  if (r.status !== 0) throw Error('Native menu could not open.');
  return app;
}

function plistXml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}</plist>\n`;
}

function agentBody({ node, control, home, workingDirectory = local.ROOT }) {
  return `<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>--experimental-sqlite</string>
    <string>${control}</string>
    <string>start</string>
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
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${path.join(home, 'desktop-login.stderr.log')}</string>
  <key>ExitTimeOut</key><integer>120</integer>
</dict>\n`;
}

function writeAgent({ node, control, home, destination = agentPath, workingDirectory = local.ROOT }) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, plistXml(agentBody({ node, control, home, workingDirectory })), { mode: 0o600 });
  const lint = spawnSync('/usr/bin/plutil', ['-lint', destination], { encoding: 'utf8' });
  if (lint.status !== 0) throw Error('Desktop login LaunchAgent failed validation.');
  return destination;
}

function launchctl(...args) {
  const r = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  return r;
}

function guiDomain() { return `gui/${process.getuid()}`; }

function installAgent(home = local.localHome()) {
  local.privateDirectory(home, true);
  const node = local.pin('node', process.execPath).path;
  const control = path.join(local.ROOT, 'scripts/macos/desktop-login.cjs');
  // Leave legacy pi-chatgpt agents disabled; this label is the only desktop login job.
  for (const legacy of ['local.pi-chatgpt-bridge', 'local.pi-chatgpt-bridge.menubar']) {
    launchctl('disable', `${guiDomain()}/${legacy}`);
    launchctl('bootout', `${guiDomain()}/${legacy}`);
  }
  const printed = launchctl('print', `${guiDomain()}/${LABEL}`);
  if (printed.status === 0) {
    launchctl('bootout', `${guiDomain()}/${LABEL}`);
  }
  const dest = writeAgent({ node, control, home });
  const en = launchctl('enable', `${guiDomain()}/${LABEL}`);
  if (en.status !== 0) throw Error('Could not enable desktop login LaunchAgent.');
  const boot = launchctl('bootstrap', guiDomain(), dest);
  if (boot.status !== 0) throw Error('Could not bootstrap desktop login LaunchAgent. ' + (boot.stderr || boot.stdout || ''));
  return { label: LABEL, path: dest, enabled: true };
}

function disableAgent() {
  launchctl('bootout', `${guiDomain()}/${LABEL}`);
  launchctl('disable', `${guiDomain()}/${LABEL}`);
  return { label: LABEL, enabled: false };
}

function uninstallAgent() {
  disableAgent();
  fs.rmSync(agentPath, { force: true });
  return { label: LABEL, removed: true };
}

function agentStatus() {
  const printed = launchctl('print', `${guiDomain()}/${LABEL}`);
  return {
    label: LABEL,
    plist: fs.existsSync(agentPath),
    loaded: printed.status === 0,
    detail: printed.status === 0 ? 'loaded' : 'not loaded'
  };
}

async function start(home = local.localHome()) {
  local.privateDirectory(home, true);
  const ollama = await ensureOllama();
  const service = await ensureService(home);
  const menu = ensureMenu(home);
  return {
    ollama,
    service: {
      healthy: !!service.healthy,
      admission: service.admission || null,
      opencode: service.opencode?.ready === true,
      managed: service.managed === true
    },
    menu,
    authority: false
  };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'start';
  const home = local.localHome();
  if (command === 'start') {
    const result = await start(home);
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (command === 'install') {
    process.stdout.write(JSON.stringify(installAgent(home)) + '\n');
    return;
  }
  if (command === 'disable') {
    process.stdout.write(JSON.stringify(disableAgent()) + '\n');
    return;
  }
  if (command === 'uninstall') {
    process.stdout.write(JSON.stringify(uninstallAgent()) + '\n');
    return;
  }
  if (command === 'status') {
    process.stdout.write(JSON.stringify(agentStatus()) + '\n');
    return;
  }
  throw Error('Usage: desktop-login.cjs start|install|disable|uninstall|status');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write((error && error.message) || String(error));
    process.stderr.write('\n');
    process.exitCode = 1;
  });
}

module.exports = { LABEL, start, installAgent, disableAgent, uninstallAgent, agentStatus, ensureOllama, ollamaReady, writeAgent, agentBody };
