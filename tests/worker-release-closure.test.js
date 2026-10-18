'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { sourceFingerprint } = require('../src/runtime-fingerprint');

const root = path.resolve(__dirname, '..');
const repairFiles = [
  'src/cursor-worker.js',
  'src/mission-approval.js',
  'src/mission-contract.js',
  'src/projectless-sandbox.js',
  'src/zero-setup-work.js',
  'docs/ISSUE-142-VALIDATION.md',
  'docs/PROJECTLESS-WORK-V1.md',
  'docs/WORKER-EXECUTION-RECOVERY-V1.md',
  'tests/cursor-spend-admission.test.js',
  'tests/cursor-subscription-retention.test.js',
  'tests/projectless-bounded-work.test.js',
  'tests/projectless-mission-integration.test.js',
];

function run(file, args, cwd, options = {}) {
  return spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
}

function succeeded(result, operation) {
  assert.equal(result.error?.code, undefined, operation + ' process unavailable');
  assert.equal(result.status, 0, operation + ' failed; diagnostics withheld');
}

test('the actual source archive preserves the runtime and loads with locked dependencies; npm rejects an omitted worker', { timeout: 120000 }, t => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-release-closure-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const archive = path.join(temporary, 'source.tar.gz');
  const extracted = path.join(temporary, 'source');
  fs.mkdirSync(extracted, { mode: 0o700 });
  const expectedFingerprint = sourceFingerprint(root).source_sha256;

  const generated = run(process.execPath, [path.join(root, 'scripts/source-archive.cjs'), archive], root);
  succeeded(generated, 'source archive generation');
  const receipt = JSON.parse(generated.stdout);
  assert.equal(receipt.sha256, createHash('sha256').update(fs.readFileSync(archive)).digest('hex'));
  const extraction = run('tar', ['-xzf', archive, '-C', extracted], temporary);
  succeeded(extraction, 'source archive extraction');
  assert.equal(sourceFingerprint(root).source_sha256, expectedFingerprint, 'source changed during release verification');
  assert.equal(sourceFingerprint(extracted).source_sha256, expectedFingerprint, 'archive runtime differs from reviewed source');
  for (const name of repairFiles) {
    assert.deepEqual(fs.readFileSync(path.join(extracted, name)), fs.readFileSync(path.join(root, name)), name + ' missing or changed in archive');
  }

  // Install only package-lock.json dependencies from the existing cache. No
  // lifecycle scripts or network resolution are allowed in this archive smoke.
  const dependencies = run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], extracted);
  succeeded(dependencies, 'offline locked dependency installation');
  const smokeHome = path.join(temporary, 'unused-home');
  const smoke = run(process.execPath, ['--experimental-sqlite', '-e', `
    const assert = require('node:assert/strict');
    const forbidden = () => { throw Error('Import attempted host or worker execution'); };
    const processes = require('node:child_process');
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) processes[name] = forbidden;
    for (const name of ['node:http', 'node:https', 'node:net']) require(name).createServer = forbidden;
    global.fetch = forbidden;
    assert.equal(typeof require('./src/bridge-controller'), 'function');
    assert.equal(typeof require('./src/cursor-worker').CursorWorker, 'function');
    assert.equal(typeof require('./src/mission-approval').MissionApprovals, 'function');
    assert.equal(typeof require('./src/mission-contract').normalizeContract, 'function');
    assert.equal(typeof require('./src/projectless-sandbox').workMissionInput, 'function');
    assert.equal(typeof require('./src/zero-setup-work').ZeroSetupWork, 'function');
    assert.equal(typeof require('./src/mission-service').MissionService, 'function');
    assert.ok(require('./src/mcp-tools').TOOLS.some(tool => tool.name === 'prepare_mission'));
    console.log(JSON.stringify({ loaded: 8, host_started: false, worker_started: false }));
  `], extracted, { env: { ...process.env, NODE_ENV: 'test', AIRODROM_HOME: smokeHome } });
  succeeded(smoke, 'archived runtime import');
  assert.deepEqual(JSON.parse(smoke.stdout), { loaded: 8, host_started: false, worker_started: false });
  assert.equal(fs.existsSync(smokeHome), false, 'runtime import must not create service state');

  const packageCheck = run(process.execPath, ['scripts/package-check.cjs'], extracted);
  succeeded(packageCheck, 'actual npm package inspection');
  assert.deepEqual(JSON.parse(packageCheck.stdout).forbidden, []);

  // A real npm selection omission must fail even though the unpacked source
  // still contains the worker and all its imports remain locally resolvable.
  const packageFile = path.join(extracted, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  pkg.files = pkg.files.filter(name => name !== 'src/cursor-worker.js');
  fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
  const omitted = run(process.execPath, ['scripts/package-check.cjs'], extracted);
  assert.equal(omitted.error?.code, undefined);
  assert.equal(omitted.status, 1);
  assert.ok(JSON.parse(omitted.stdout).forbidden.includes('missing:src/cursor-worker.js'));
});
