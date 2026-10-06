'use strict';
const path = require('node:path');
const BRANDING = require('./branding');
const fs = require('node:fs');
const BridgeController = require('./bridge-controller');
const ControlServer = require('./control-server');
const { atomicJSON } = require('./config');
const { createServiceLog } = require('./service-log');
const background = process.env.PI_BRIDGE_BACKGROUND === '1';
let serviceLog;
function reportError(error) {
  if (background) {
    try { serviceLog?.write('error'); } catch { /* Never expose a raw logging failure. */ }
    console.error(`${BRANDING.name} service failed; inspect private service log and configuration.`);
  } else console.error(error.message);
  process.exitCode = 1;
}
async function main() {
  if (background) { serviceLog = createServiceLog(process.env.PI_BRIDGE_LOG_FILE); serviceLog.write('starting'); }
  const allowedHosts = process.env.PI_BRIDGE_WEB_HOSTS?.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.PI_TRUSTED_DEV_MODE !== undefined && process.env.PI_TRUSTED_DEV_MODE !== '1') throw new Error('PI_TRUSTED_DEV_MODE must be exactly 1 when present');
  const trustedDeveloperMode = process.env.PI_TRUSTED_DEV_MODE === '1';
  const bridge = await new BridgeController({
    dataDir: process.env.PI_BRIDGE_DATA_DIR,
    sourceProfile: process.env.PI_BRIDGE_SOURCE_PROFILE,
    allowedHosts,
    webEnabled: process.env.PI_BRIDGE_WEB !== 'off',
    level1ActivationEnabled: process.env.PI_BRIDGE_LEVEL1_ACTIVATION === '1',
    level1RestrictedWorkerEnabled: process.env.PI_BRIDGE_LEVEL1_RESTRICTED_WORKER === '1',
    trustedDeveloperMode,
    defaultRuntime: process.env.AIRODROM_DEFAULT_RUNTIME,
    opencode: { ...require('./default-runtime').OPENCODE_DEFAULTS, ...(process.env.AIRODROM_OPENCODE_MODEL ? {model:process.env.AIRODROM_OPENCODE_MODEL} : {}), ...(process.env.AIRODROM_OPENCODE_EXECUTABLE ? {executable:process.env.AIRODROM_OPENCODE_EXECUTABLE} : {}) }
  }).initialize();
  const ui = new ControlServer(bridge, { port: process.env.PI_BRIDGE_PORT ? Number(process.env.PI_BRIDGE_PORT) : 43117 });
  try {
    const address = await ui.start();
    atomicJSON(path.join(bridge.dataDir, 'ui.json'), { ...address, pid: process.pid, startedAt: new Date().toISOString() });
    atomicJSON(path.join(bridge.dataDir, 'mcp.json'), { port: address.port, token: ui.mcpToken, pid: process.pid });
    if (background) serviceLog.write('listening', { port: address.port });
    else {
      console.log(`${BRANDING.controlCenter}: ${address.url}`);
      console.log('Listening only on 127.0.0.1. Keep this private link local. Press Ctrl+C to stop.');
      console.log('MCP adapter: local stdio via src/mcp.js. Direct ChatGPT round trip is not automatically proven.');
    }
  } catch (e) { await ui.close(); await bridge.shutdown(); throw e; }
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { serviceLog?.write('stopping'); } catch { /* Logging must not prevent graceful shutdown. */ }
    await Promise.all([ui.close(), bridge.shutdown()]);
    fs.rmSync(path.join(bridge.dataDir, 'ui.json'), { force: true });
    fs.rmSync(path.join(bridge.dataDir, 'mcp.json'), { force: true });
    serviceLog?.write('stopped');
  };
  process.on('SIGINT', () => stop().catch(reportError));
  process.on('SIGTERM', () => stop().catch(reportError));
  process.on('SIGHUP', () => stop().catch(reportError));
}
if (require.main === module) main().catch(reportError);
module.exports = BridgeController;
