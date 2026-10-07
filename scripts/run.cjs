'use strict';
// Some older Node builds ship SQLite without FTS5. Select an installed compatible runtime;
// never install or modify a runtime automatically.
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const BRANDING = require('../src/branding');
const check = "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').exec('CREATE VIRTUAL TABLE f USING fts5(content)')";
const configuredNode = process.env.AIRODROM_NODE;
const candidates = configuredNode ? [configuredNode] : [process.execPath, '/opt/homebrew/opt/node@22/bin/node', '/usr/local/opt/node@22/bin/node'];
const executable = [...new Set(candidates)].find(p => fs.existsSync(p) && spawnSync(p, ['--experimental-sqlite','-e',check], {stdio:'ignore'}).status === 0);
if (!executable) { console.error(`${BRANDING.name} requires an installed Node 22.13+ build with SQLite FTS5. Set AIRODROM_NODE to its executable.`); process.exit(1); }
const child = spawn(executable, ['--experimental-sqlite', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ...(process.argv.includes('--test')?{NODE_ENV:'test'}:{}), PATH: require('node:path').dirname(executable) + require('node:path').delimiter + process.env.PATH } });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
