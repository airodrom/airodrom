'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Observation only: tunnel health never confers task or operator authority.
async function chatgptConnection({ healthFile = path.join(os.homedir(), 'Library/Application Support/Pi Bridge/MCP Tunnel/health.url'), request = fetch } = {}) {
  const result = { state: 'not_connected', connected: false, tunnelHealthy: false, mcpProbe: 'unknown' };
  try {
    const fd = fs.openSync(healthFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let address;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022) || stat.size > 2048) return result;
      address = fs.readFileSync(fd, 'utf8').trim();
    } finally { fs.closeSync(fd); }
    const url = new URL(address);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') return result;
    const options = { redirect: 'error', signal: AbortSignal.timeout(1500) };
    const health = await request(url.origin + '/healthz', options);
    if (!health.ok || (await health.text()).trim() !== 'live') return result;
    result.tunnelHealthy = true;
    result.state = 'degraded';
    const status = await request(url.origin + '/api/status', options);
    if (!status.ok) return result;
    const body = await status.json();
    const main = Array.isArray(body.channels) ? body.channels.find(channel => channel.name === 'main') : null;
    result.mcpProbe = main?.probe_status === 'ok' ? 'ok' : 'failed';
    if (main?.enabled === true && result.mcpProbe === 'ok') {
      result.state = 'connected';
      result.connected = true;
    }
  } catch { /* Missing/stale discovery and failed probes are fixed safe states. */ }
  return result;
}
module.exports = { chatgptConnection };
