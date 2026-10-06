#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const branding = require('../src/branding');
const args = process.argv.slice(2);
const command = args[0];
if (!command || command === '--help' || command === '-h') {
  console.log(`${branding.name} — ${branding.tagline}\n\nUsage: airodrom <command>\n\n  start       Run the local platform service\n  mcp         Run the existing MCP stdio transport\n  --version   Show package version\n  --help      Show this help\n\n${branding.website}\nExisting npm scripts and PI_BRIDGE_* configuration remain supported.`);
} else if (command === '--version') {
  console.log(`${branding.name} ${require('../package.json').version}`);
} else if (['start', 'mcp'].includes(command) && args.length === 1) {
  const child = spawn(process.execPath, [path.join(__dirname, 'run.cjs'), path.join(__dirname, '../src', command === 'start' ? 'index.js' : 'mcp.js')], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error(`${branding.name} command could not start.`); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} else {
  console.error(`Unknown ${branding.name} command. Use airodrom --help.`);
  process.exitCode = 2;
}
