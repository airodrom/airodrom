'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const local = require('../src/local-bootstrap');
const { inspectInstalledCommand } = require('../src/cli-command-inspect');

test('package bin smoke: scripts/airodrom.cjs help and status against disposable stopped home', () => {
  const fs = require('node:fs');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'airo-smoke-')));
  fs.chmodSync(home, 0o700);
  local.privateDirectory(path.join(home, 'data'), true);
  const help = spawnSync(process.execPath, [path.join(local.ROOT, 'scripts/airodrom.cjs'), 'help'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, NO_COLOR: '1', AIRODROM_HOME: home },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /airodrom chat|Attach to the managed service/);
  assert.match(help.stdout, /service start/);
  assert.doesNotMatch(help.stdout, /#token=|Bearer /);
  const status = spawnSync(process.execPath, [path.join(local.ROOT, 'scripts/airodrom.cjs'), 'status'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, NO_COLOR: '1', AIRODROM_HOME: home },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /stopped|service start/i);
  assert.doesNotMatch(status.stdout, /#token=|Bearer /);
  require('node:fs').rmSync(home, { recursive: true, force: true });
});

test('PATH airodrom smoke reports install alignment without mutating the command', () => {
  const info = inspectInstalledCommand({ root: local.ROOT });
  assert.equal(info.command, 'airodrom');
  assert.equal(info.expected_present, true);
  // Stale global installs are reported, never auto-replaced.
  if (info.primary && info.stale_or_unrelated) {
    assert.match(info.advice, /explicit operator authorization|different installation/i);
  }
  assert.doesNotMatch(JSON.stringify(info), /#token=|Bearer /);
});
