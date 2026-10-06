'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
const EVENTS = new Set(['starting', 'listening', 'stopping', 'stopped', 'error']);

// Background logs contain only fixed lifecycle events. Error messages, URLs,
// task content, credentials and arbitrary metadata are never accepted.
function createServiceLog(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('An absolute private service log path is required');
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw new Error('Service log directory must be private and owned by the current user');
  function inspect(target) {
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Service log must be a private regular file');
      return stat;
    } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }
  inspect(file); inspect(file + '.1');
  return {
    write(event, details = {}) {
      if (!EVENTS.has(event)) throw new Error('Invalid service log event');
      const entry = { at: new Date().toISOString(), event, pid: process.pid };
      if (Number.isInteger(details.port) && details.port >= 1 && details.port <= 65535) entry.port = details.port;
      const line = JSON.stringify(entry) + '\n';
      if ((inspect(file)?.size || 0) + Buffer.byteLength(line) > MAX_BYTES) {
        inspect(file + '.1');
        fs.renameSync(file, file + '.1');
      }
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Service log must be a private regular file');
        fs.writeSync(fd, line);
      } finally { fs.closeSync(fd); }
    },
  };
}
module.exports = { createServiceLog, MAX_BYTES };
