#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const local = require('../src/local-bootstrap');
const Bridge = require('../src/bridge-controller');
const ControlServer = require('../src/control-server');
async function main() {
  process.umask(0o077);
  const home = local.localHome(); local.privateDirectory(home);
  const c = local.ownedJSON(path.join(home, 'local.json'));
  if (c.version !== 1 || c.source !== local.ROOT || c.dataDir !== path.join(home, 'data') || c.profile !== path.join(home, 'profile') || c.pinsFile !== path.join(home, 'runtime-pins.json')) throw Error('Local service configuration changed.');
  const pins = local.validatePins(local.ownedJSON(c.pinsFile));
  local.privateDirectory(c.dataDir); local.privateDirectory(c.profile);
  const bridge = await new Bridge({ dataDir: c.dataDir, sourceProfile: c.profile, webEnabled: false, defaultRuntime: process.env.AIRODROM_DEFAULT_RUNTIME, slack: { env: {} }, opencode: { enabled: true, executable: pins.executables.find(p => p.id === 'opencode').path, model: pins.model, pinsFile: c.pinsFile, timeoutMs: 90000 } }).initialize();
  const server = new ControlServer(bridge, { port: 0 });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await server.close(); await bridge.shutdown();
    for (const name of ['ui.json', 'mcp.json']) fs.rmSync(path.join(c.dataDir, name), { force: true });
  };
  server.localShutdown = stop;
  try {
    const address = await server.start();
    local.writePrivate(path.join(c.dataDir, 'ui.json'), { ...address, pid: process.pid });
    local.writePrivate(path.join(c.dataDir, 'mcp.json'), { port: address.port, token: server.mcpToken, pid: process.pid });
  } catch (error) { await stop(); throw error; }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop().catch(() => { process.exitCode = 1; }));
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { main };
