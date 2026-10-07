'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

function discovery(dataDir = process.env.AIRODROM_DATA_DIR || path.join(__dirname, '../.runtime')) {
  const file = path.join(dataDir, 'mcp.json');
  const directory = fs.lstatSync(dataDir), stat = fs.lstatSync(file);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (stat.mode & 0o077) || stat.uid !== process.getuid() || directory.uid !== process.getuid()) throw new Error('MCP discovery must be private and owned by the current user');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token) || !Number.isInteger(value.pid) || value.pid < 1) throw new Error('Invalid MCP discovery file');
  // Authenticate the loopback service itself. A PID probe is not authentication
  // and is denied even for healthy services in some desktop client sandboxes.
  return value;
}

function createClient({ dataDir } = {}) {
  return async (name, args, clientInfo) => {
    let connection;
    try { connection = discovery(dataDir); }
    catch { const error = new Error('Bridge discovery failed'); error.publicMessage = 'Local bridge unavailable or private discovery invalid. Start the bridge with npm start.'; throw error; }
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ name, args, clientInfo: { name: String(clientInfo?.name || 'unknown').slice(0, 100), version: String(clientInfo?.version || '').slice(0, 100) } });
      let settled = false;
      const fail = message => { if (settled) return; settled = true; const error = new Error(message); error.publicMessage = message; reject(error); };
      // Address and route are constant except for the locally discovered port. No redirects,
      // arbitrary URL, operator credential or general-purpose HTTP proxy is exposed.
      // Each call follows fresh discovery; do not reuse a socket from a replaced bridge.
      // A failed call is still returned to the caller, never automatically replayed.
      const req = http.request({ agent: false, hostname: '127.0.0.1', port: connection.port, path: '/api/mcp/call', method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        const parts = []; let bytes = 0;
        res.on('data', part => { bytes += part.length; if (bytes > 512 * 1024) { fail('Bridge response exceeded limit; inspect Control Center before retrying'); res.destroy(); } else parts.push(part); });
        res.on('error', () => fail('Bridge response interrupted; inspect status before retrying'));
        res.on('end', () => {
          if (settled) return;
          let value; try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return fail('Unreadable bridge response'); }
          if (res.statusCode !== 200) return fail(typeof value.error === 'string' ? value.error.slice(0, 512) : 'Bridge request refused');
          settled = true; resolve(value);
        });
      });
      const timer = setTimeout(() => { fail('Bridge request timed out; use the same request_id to recover, never blindly replay'); req.destroy(); }, 15000);
      req.on('error', () => fail('Local bridge request failed; inspect status before retrying'));
      req.on('close', () => clearTimeout(timer));
      req.end(body);
    });
  };
}
module.exports = { createClient, discovery };
