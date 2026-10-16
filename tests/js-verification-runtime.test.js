'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  materializeNodeModules,
  planPackageManagerInvocation,
  resolveNpmCli
} = require('../src/js-verification-runtime');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-js-ver-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const work = path.join(root, 'work');
  fs.mkdirSync(source);
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: { typecheck: 'tsc --noEmit', build: 'node ./scripts/build.js' }
  }));
  fs.mkdirSync(path.join(source, 'node_modules', '.bin'), { recursive: true });
  fs.mkdirSync(path.join(source, 'node_modules', 'typescript', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(source, 'node_modules', 'typescript', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'node_modules', 'typescript', 'lib', 'tsc.js'), 'process.stdout.write("tsc-ok\\n");\n');
  fs.writeFileSync(path.join(source, 'node_modules', 'typescript', 'bin', 'tsc'), '#!/usr/bin/env node\nrequire("../lib/tsc.js");\n', { mode: 0o755 });
  fs.symlinkSync('../typescript/bin/tsc', path.join(source, 'node_modules', '.bin', 'tsc'));
  fs.writeFileSync(path.join(source, 'scripts', 'build.js'), 'process.stdout.write("build-ok\\n");\n');
  return { root, source, work };
}

test('materializeNodeModules clones into the worktree and refuses to leave a symlink', t => {
  const f = fixture(t);
  const first = materializeNodeModules(f.source, f.work);
  assert.ok(['cloned', 'copied'].includes(first.status), first.status);
  assert.equal(fs.lstatSync(path.join(f.work, 'node_modules')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(f.work, 'node_modules', 'typescript', 'lib', 'tsc.js')), true);
  assert.equal(materializeNodeModules(f.source, f.work).status, 'present');
});

test('materializeNodeModules replaces a stale symlink with a real tree', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.source, 'node_modules'), path.join(f.work, 'node_modules'));
  const result = materializeNodeModules(f.source, f.work);
  assert.ok(['cloned', 'copied'].includes(result.status), result.status);
  assert.equal(fs.lstatSync(path.join(f.work, 'node_modules')).isSymbolicLink(), false);
});

test('planPackageManagerInvocation rewrites npm run typecheck to node + tsc entry', t => {
  const f = fixture(t);
  materializeNodeModules(f.source, f.work);
  fs.copyFileSync(path.join(f.source, 'package.json'), path.join(f.work, 'package.json'));
  const nodePath = process.execPath;
  const plan = planPackageManagerInvocation(f.work, ['npm', 'run', 'typecheck'], nodePath);
  assert.ok(plan);
  assert.equal(plan.file, nodePath);
  assert.equal(plan.args[0], path.join(f.work, 'node_modules', 'typescript', 'bin', 'tsc'));
  assert.deepEqual(plan.args.slice(1), ['--noEmit']);
});

test('planPackageManagerInvocation rewrites npm run build to node + local script', t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(f.source, 'package.json'), path.join(f.work, 'package.json'));
  fs.cpSync(path.join(f.source, 'scripts'), path.join(f.work, 'scripts'), { recursive: true });
  const nodePath = process.execPath;
  const plan = planPackageManagerInvocation(f.work, ['npm', 'run', 'build'], nodePath);
  assert.ok(plan);
  assert.equal(plan.file, nodePath);
  assert.equal(plan.args[0], path.join(f.work, 'scripts', 'build.js'));
});

test('resolveNpmCli finds npm-cli.js beside a pinned node binary', () => {
  const cli = resolveNpmCli(process.execPath);
  // Homebrew Node and many installs expose npm-cli next to node; when absent, stay null.
  if (cli) assert.equal(fs.statSync(cli).isFile(), true);
});
