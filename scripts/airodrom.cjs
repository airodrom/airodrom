#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const command = args[0];
// Select the installed SQLite-compatible runtime before loading the CLI.
const child = spawn(process.execPath, [path.join(__dirname, 'run.cjs'), path.join(__dirname, '../src', command === 'mcp' ? 'mcp.js' : 'interactive-cli.js'), ...(command === 'mcp' ? args.slice(1) : args)], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Airodrom command could not start.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
