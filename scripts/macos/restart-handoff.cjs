#!/usr/bin/env node
'use strict';

/**
 * Out-of-process bridge restart handoff.
 *
 * Accepts only fixed argv forms:
 *   node restart-handoff.cjs --execute --request-id <uuid>
 *   node restart-handoff.cjs --status
 *
 * Resolves repository and runtime paths internally. Never evaluates shell text
 * and never accepts executable/cwd/env/path overrides from callers.
 */

const path = require('node:path');
const {
  executeRestart,
  statusRestart,
  REQUEST_ID_PATTERN_HINT
} = (() => {
  const mod = require('../../src/bridge-restart');
  return {
    executeRestart: mod.executeRestart,
    statusRestart: mod.statusRestart,
    REQUEST_ID_PATTERN_HINT: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  };
})();

const ROOT = path.resolve(__dirname, '../..');
const RUNTIME = path.join(ROOT, '.runtime');

function parseArgv(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === '--status') return { mode: 'status' };
  if (args.length === 1 && args[0] === '--reconcile') return { mode: 'reconcile' };
  if (args.length === 3 && args[0] === '--execute' && args[1] === '--request-id') {
    const requestId = args[2];
    if (!REQUEST_ID_PATTERN_HINT.test(requestId)) throw new Error('Invalid restart request id');
    return { mode: 'execute', requestId };
  }
  throw new Error('Unsupported restart handoff arguments');
}

async function main() {
  const command = parseArgv(process.argv);
  if (command.mode === 'status' || command.mode === 'reconcile') {
    const options = command.mode === 'reconcile' ? { reconcileProbe: require('./resilient-control.cjs').probeReadiness } : {};
    process.stdout.write(`${JSON.stringify(statusRestart(RUNTIME, options))}\n`);
    return;
  }
  const receipt = await executeRestart({
    runtimeDir: RUNTIME,
    repoRoot: ROOT,
    requestId: command.requestId
  });
  process.stdout.write(`${JSON.stringify({ handoff_execute: true, receipt })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ handoff_execute: false, error: String(error.message || error).slice(0, 300) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgv, ROOT, RUNTIME };
