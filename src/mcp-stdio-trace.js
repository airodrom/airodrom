'use strict';
// Optional metadata-only diagnostics. Never inspect arguments, results, or credentials.
const fs = require('node:fs');
const path = require('node:path');
function trace(event, fields = {}) {
  if (process.env.MCP_STDIO_TRACE !== '1') return;
  let fd;
  try {
    const directory = process.env.PI_BRIDGE_DATA_DIR || path.join(__dirname, '../work');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = fs.lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid()) return;
    fd = fs.openSync(path.join(directory, 'mcp-stdio-trace.log'), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size >= 1024 * 1024) return;
    fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ppid: process.ppid, event, ...fields }) + '\n');
  } catch { /* Diagnostics must never change protocol behavior. */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
module.exports = { trace };
