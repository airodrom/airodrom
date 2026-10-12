#!/usr/bin/env node
'use strict';
/**
 * Always-on reboot acceptance prepare/verify for the managed desktop path.
 * Uses the installed managed service; never starts a duplicate supervisor.
 */
const path = require('node:path');
const local = require('../../src/local-bootstrap');
const reboot = require('../../src/reboot-acceptance');

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'status';
  const home = local.localHome();
  if (command === 'prepare') {
    process.stdout.write(JSON.stringify(await reboot.prepare(home, local)) + '\n');
    return;
  }
  if (command === 'verify') {
    const receipt = await reboot.verify(home, local);
    process.stdout.write(JSON.stringify(receipt) + '\n');
    // Exit 0 means the verifier completed, including idle skip when no pending
    // stamp exists (RunAtLoad). Reboot acceptance success is receipt.acceptance_ok.
    if (receipt.ok !== true) process.exitCode = 2;
    return;
  }
  if (command === 'forget-test-memory') {
    process.stdout.write(JSON.stringify(await reboot.forgetTestMemory(home, local)) + '\n');
    return;
  }
  if (command === 'status') {
    process.stdout.write(JSON.stringify(reboot.status(home)) + '\n');
    return;
  }
  throw Error('Usage: reboot-acceptance.cjs prepare|verify|forget-test-memory|status');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write((error && error.message) || String(error));
    process.stderr.write('\n');
    process.exitCode = 1;
  });
}

module.exports = { main };
