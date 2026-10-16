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
  assert.equal(plan.args[0], fs.realpathSync(path.join(f.work, 'node_modules', 'typescript', 'bin', 'tsc')));
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

test('dependency copy rejects links escaping the repository', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.js');
  fs.writeFileSync(outside, 'module.exports = 1;');
  fs.symlinkSync(outside, path.join(f.source, 'node_modules', '.bin', 'escape'));
  assert.throws(() => materializeNodeModules(f.source, f.work), /symlink escapes/);
  assert.equal(fs.existsSync(path.join(f.work, 'node_modules')), false);
});

test('materialized workspace package links remain inside the disposable repository', t => {
  const f = fixture(t);
  for (const root of [f.source, f.work]) {
    fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'local-tool.js'), 'process.stdout.write("workspace-tool");');
  }
  fs.symlinkSync('../../packages/local-tool.js', path.join(f.source, 'node_modules', '.bin', 'local-tool'));
  const copied = materializeNodeModules(f.source, f.work);
  assert.ok(['cloned', 'copied'].includes(copied.status), copied.status);
  const { resolveNodeRunnable } = require('../src/js-verification-runtime');
  assert.equal(resolveNodeRunnable(f.work, 'local-tool').file, fs.realpathSync(path.join(f.work, 'packages', 'local-tool.js')));
});

test('workspace links to private repository paths still fail closed', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, '.git'), { recursive: true });
  fs.writeFileSync(path.join(f.source, '.git', 'config'), 'fixture');
  fs.symlinkSync('../../.git/config', path.join(f.source, 'node_modules', '.bin', 'escape'));
  assert.throws(() => materializeNodeModules(f.source, f.work), /symlink escapes/);
});

test('dependency disk budget rejects oversized trees before copying', t => {
  const f = fixture(t);
  assert.throws(() => materializeNodeModules(f.source, f.work, { maxBytes: 64 }), /disk budget exhausted/);
  assert.equal(fs.existsSync(path.join(f.work, 'node_modules')), false);
});

function tinyRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-js-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const work = path.join(root, 'work');
  fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"tiny"}\n');
  return { root, source, work };
}

test('repository-local symlink targets count toward the dependency disk budget', t => {
  const f = tinyRepo(t);
  fs.mkdirSync(path.join(f.source, 'packages'));
  fs.writeFileSync(path.join(f.source, 'packages', 'blob.js'), 'x'.repeat(180));
  fs.symlinkSync('../packages/blob.js', path.join(f.source, 'node_modules', 'blob.js'));
  assert.throws(() => materializeNodeModules(f.source, f.work, { maxBytes: 80 }), /disk budget exhausted/);
  assert.equal(fs.existsSync(path.join(f.work, 'node_modules')), false);
});

test('a directory link outside node_modules cannot hide its reachable bytes', t => {
  const f = tinyRepo(t);
  fs.mkdirSync(path.join(f.source, 'packages', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(f.source, 'packages', 'pkg', 'index.js'), 'y'.repeat(300));
  fs.symlinkSync('../packages/pkg', path.join(f.source, 'node_modules', 'pkg'));
  assert.throws(() => materializeNodeModules(f.source, f.work, { maxBytes: 120 }), /disk budget exhausted/);
});

test('duplicate links to one inode are counted once and hard-link bytes are counted', t => {
  const f = tinyRepo(t);
  const body = path.join(f.source, 'packages');
  fs.mkdirSync(body);
  fs.writeFileSync(path.join(body, 'once.js'), 'z'.repeat(1000));
  fs.mkdirSync(path.join(f.work, 'packages'), { recursive: true });
  fs.copyFileSync(path.join(body, 'once.js'), path.join(f.work, 'packages', 'once.js'));
  fs.symlinkSync('../packages/once.js', path.join(f.source, 'node_modules', 'a.js'));
  fs.symlinkSync('../packages/once.js', path.join(f.source, 'node_modules', 'b.js'));
  assert.doesNotThrow(() => materializeNodeModules(f.source, f.work, { maxBytes: 1600 }));
  fs.rmSync(path.join(f.work, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(f.source, 'node_modules', 'a.js'));
  fs.rmSync(path.join(f.source, 'node_modules', 'b.js'));
  fs.linkSync(path.join(body, 'once.js'), path.join(f.source, 'node_modules', 'hard.js'));
  assert.throws(() => materializeNodeModules(f.source, f.work, { maxBytes: 40 }), /disk budget exhausted/);
});

test('cyclic, dangling, and outside-return symlink chains fail closed', t => {
  const f = tinyRepo(t);
  const modules = path.join(f.source, 'node_modules');
  fs.symlinkSync('b', path.join(modules, 'a'));
  fs.symlinkSync('a', path.join(modules, 'b'));
  assert.throws(() => materializeNodeModules(f.source, f.work), /symlink cycle/);
  fs.rmSync(path.join(modules, 'a'));
  fs.rmSync(path.join(modules, 'b'));
  fs.symlinkSync('../missing.js', path.join(modules, 'dangling.js'));
  assert.throws(() => materializeNodeModules(f.source, f.work), /target is missing/);
  fs.rmSync(path.join(modules, 'dangling.js'));
  fs.mkdirSync(path.join(f.source, 'packages'));
  fs.writeFileSync(path.join(f.source, 'packages', 'tool.js'), 'module.exports=1;\n');
  const outside = path.join(f.root, 'outside-hop');
  fs.symlinkSync(path.join(f.source, 'packages', 'tool.js'), outside);
  fs.symlinkSync(outside, path.join(modules, 'tool.js'));
  assert.throws(() => materializeNodeModules(f.source, f.work), /symlink escapes/);
  const { resolveNodeRunnable } = require('../src/js-verification-runtime');
  assert.equal(resolveNodeRunnable(f.source, 'node_modules/tool.js'), null);
  fs.rmSync(path.join(modules, 'tool.js'));
  fs.symlinkSync('/etc/passwd', path.join(modules, 'absolute.js'));
  assert.throws(() => materializeNodeModules(f.source, f.work), /symlink escapes/);
  fs.rmSync(path.join(modules, 'absolute.js'));
  const hidden = path.join(modules, 'hidden');
  fs.mkdirSync(hidden);
  fs.writeFileSync(path.join(hidden, 'a.js'), 'a');
  fs.chmodSync(hidden, 0);
  try {
    assert.throws(() => materializeNodeModules(f.source, f.work), /unavailable/);
    assert.equal(fs.existsSync(path.join(f.work, 'node_modules')), false);
  } finally {
    fs.chmodSync(hidden, 0o700);
  }
});

test('package-bin entrypoints must stay in the repository and cannot escape', t => {
  const f = fixture(t);
  const external = path.join(f.root, 'outside.js');
  fs.writeFileSync(external, 'console.log("no");');
  fs.symlinkSync(external, path.join(f.source, 'node_modules', '.bin', 'escape'));
  const { resolveNodeRunnable } = require('../src/js-verification-runtime');
  assert.equal(resolveNodeRunnable(f.source, 'escape'), null);
  assert.equal(resolveNodeRunnable(f.source, 'node_modules/../script.js'), null);
});

test('Mission Seatbelt retains exact execution and excludes general shells', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/host-exec.js'), 'utf8');
  const declaration = source.match(/const missionExec = ([^\n]+)/)?.[1] || '';
  assert.ok(declaration.includes('...exact'));
  assert.doesNotMatch(declaration, /\/usr\/bin\/env|\/bin\/sh|\/bin\/bash/);
});
