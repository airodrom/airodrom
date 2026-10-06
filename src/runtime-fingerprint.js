'use strict';
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
function sourceFingerprint(root = path.resolve(__dirname, '..')) {
  const hash = createHash('sha256');
  const walk = directory => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('Source fingerprint refuses symlinks');
      if (entry.isDirectory()) walk(name);
      else if (/\.(js|mjs|cjs|ts)$/.test(entry.name)) { hash.update(name); hash.update(fs.readFileSync(path.join(root, name))); }
    }
  };
  walk('src');
  for (const file of ['package.json', 'package-lock.json']) { hash.update(file); hash.update(fs.readFileSync(path.join(root, file))); }
  return { source_sha256: hash.digest('hex'), captured_at: new Date().toISOString(), pid: process.pid };
}
module.exports = { sourceFingerprint };
