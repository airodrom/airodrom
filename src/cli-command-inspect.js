'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const local = require('./local-bootstrap');

function resolveWhich(command, env = process.env) {
  const which = spawnSync('/usr/bin/which', ['-a', command], { encoding: 'utf8', env, timeout: 3000 });
  if (which.status !== 0) return [];
  return which.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

function realTarget(file) {
  try { return fs.realpathSync(file); } catch { return null; }
}

function inspectInstalledCommand({ root = local.ROOT, env = process.env, command = 'airodrom' } = {}) {
  const expected = path.join(root, 'scripts/airodrom.cjs');
  const expectedReal = realTarget(expected);
  const pathEntries = resolveWhich(command, env);
  const resolved = pathEntries.map(entry => ({ entry, real: realTarget(entry) }));
  const primary = resolved[0] || null;
  const aligns = !!(primary && expectedReal && primary.real === expectedReal);
  const shadowed = resolved.length > 1 && aligns === false && resolved.some(item => item.real === expectedReal);
  const unrelated = !!(primary && expectedReal && primary.real && primary.real !== expectedReal);
  return {
    command,
    expected,
    expected_present: !!expectedReal,
    path_entries: resolved.map(item => item.entry),
    primary: primary && primary.entry || null,
    primary_matches_package: aligns,
    shadowed,
    stale_or_unrelated: unrelated,
    advice: !primary
      ? 'No airodrom command is on PATH. From an authorized package run npm run install:local.'
      : aligns
        ? 'Terminal airodrom matches this package.'
        : unrelated
          ? 'Terminal airodrom points at a different installation. Client commands can still attach to the managed service; replace the command only with explicit operator authorization (npm unlink -g airodrom, then npm run install:local from the intended package).'
          : 'Inspect PATH ordering for airodrom.',
  };
}

function formatInstallAdvice(info) {
  return [
    'CLI install: ' + (info.primary_matches_package ? 'aligned' : info.stale_or_unrelated ? 'stale/unrelated' : info.primary ? 'unknown' : 'missing'),
    info.advice,
  ].join('\n');
}

module.exports = { inspectInstalledCommand, formatInstallAdvice, resolveWhich };
