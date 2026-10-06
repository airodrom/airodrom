#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function install() {
  const p = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 5000 });
  if (p.status !== 0) throw Error('Unable to inspect the local npm prefix.');
  const prefix = p.stdout.trim(), bin = path.join(prefix, 'bin'), target = path.join(bin, 'airodrom');
  if (!path.isAbsolute(prefix) || !fs.statSync(prefix).isDirectory() || fs.statSync(prefix).uid !== process.getuid?.()) throw Error('Local install requires a user-owned npm prefix. Existing installation was preserved.');
  try {
    fs.lstatSync(target);
    if (fs.realpathSync(target) !== path.join(root, 'scripts/airodrom.cjs')) throw Error('An unrelated airodrom command already exists. Existing installation was preserved.');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const r = spawnSync('npm', ['link', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'ignore', timeout: 30000 });
  if (r.status !== 0 || fs.realpathSync(target) !== path.join(root, 'scripts/airodrom.cjs')) throw Error('Local npm link did not complete. No shell settings were changed.');
  if (!(process.env.PATH || '').split(path.delimiter).includes(bin)) throw Error('Installed the command in the user npm bin directory. Add that directory to Terminal PATH; shell settings were preserved.');
  console.log('Local command installed. Run airodrom from any Terminal directory. Undo with npm unlink -g airodrom.');
}
if (require.main === module) { try { install(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { install };
