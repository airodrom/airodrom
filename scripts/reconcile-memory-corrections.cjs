#!/usr/bin/env node
'use strict';
/**
 * Dry-run (default) conflict report for concurrent active Personal Memory facts.
 * Never mutates unless --apply --confirm-apply are both provided.
 * Does not open the live operator home unless --home is explicit.
 */
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PersonalMemory } = require('../src/personal-memory');
const { reconcileActiveConflicts } = require('../src/memory-correction');

function usage() {
  console.log('Usage: node scripts/reconcile-memory-corrections.cjs --db <sqlite> [--apply --confirm-apply]');
  console.log('Default is dry-run. Live operator memories are never touched without both apply flags.');
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { usage(); return 0; }
  const dbFlag = argv.indexOf('--db');
  if (dbFlag < 0 || !argv[dbFlag + 1]) { usage(); return 1; }
  const file = path.resolve(argv[dbFlag + 1]);
  const apply = argv.includes('--apply') && argv.includes('--confirm-apply');
  const db = new DatabaseSync(file);
  try {
    const memory = new PersonalMemory({ db });
    const report = reconcileActiveConflicts(memory, { dryRun: !apply, confirmApply: apply });
    console.log(JSON.stringify({
      database: path.basename(file),
      dryRun: report.dryRun,
      applied: report.applied,
      conflictCount: report.conflictCount,
      conflicts: report.conflicts.map(c => ({
        factKey: c.factKey,
        keepId: c.keepId,
        supersedeCount: c.supersedeIds.length
      }))
    }, null, 2));
    return 0;
  } finally {
    db.close();
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
