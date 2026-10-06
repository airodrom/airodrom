'use strict';
const fs = require('node:fs');
// Credentials are internal only. Errors never include parser snippets or paths.
function readPrivateJSON(file, maximum = 8000) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > maximum) throw Error('unsafe');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch { throw Error('Unsafe or invalid private JSON file'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function privateFileExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw Error('Private file observation unavailable'); }
}
module.exports = { readPrivateJSON, privateFileExists };
