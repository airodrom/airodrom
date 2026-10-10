'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('ControlServer accepts optional Gmail clientSecretReference and rejects unknown keys', () => {
  const dir = fs.mkdtempSync('/private/tmp/airodrom-gmail-hotfix-');
  fs.chmodSync(dir, 0o700);
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  fs.chmodSync(data, 0o700);
  const file = path.join(data, 'gmail-oauth-config.json');
  const write = (value) => fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
  const ControlServer = require('../src/control-server');
  const bridge = { dataDir: data, conversationEngine: { close: async () => {} } };

  write({ clientId: 'fixture.apps.googleusercontent.com', reference: 'vault:gmail:fixture', clientSecretReference: 'vault:gmail:secret-fixture' });
  const ok = new ControlServer(bridge, { port: 0, token: 'a'.repeat(64), mcpToken: 'b'.repeat(64) });
  assert.equal(!!ok.gmailOAuth, true);

  write({ clientId: 'fixture.apps.googleusercontent.com', reference: 'vault:gmail:fixture', unexpected: true });
  assert.throws(() => new ControlServer(bridge, { port: 0, token: 'a'.repeat(64), mcpToken: 'b'.repeat(64) }), /Unexpected input fields/);

  write({ clientId: 'fixture.apps.googleusercontent.com', reference: 'vault:gmail:fixture' });
  const legacy = new ControlServer(bridge, { port: 0, token: 'a'.repeat(64), mcpToken: 'b'.repeat(64) });
  assert.equal(!!legacy.gmailOAuth, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('wait-presentation module and config are allowlisted and loadable', () => {
  const files = require('../release-files.json');
  const pkg = require('../package.json');
  assert.ok(files.includes('src/wait-presentation.js'));
  assert.ok(files.includes('config/wait-presentation-v1.json'));
  assert.ok(pkg.files.includes('src/wait-presentation.js'));
  assert.ok(pkg.files.includes('config/wait-presentation-v1.json'));
  const wait = require('../src/wait-presentation');
  const status = wait.status({});
  assert.equal(status.version, 1);
  assert.ok(Number.isFinite(status.execution_timeout_ms));
});

test('packaged product-observatory require graph resolves inside the allowlist', () => {
  const allowed = new Set(require('../release-files.json'));
  const text = fs.readFileSync(path.join(root, 'src/product-observability.js'), 'utf8');
  const reqs = [...text.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1]);
  for (const rel of reqs) {
    const candidates = [
      path.join(root, 'src', rel),
      path.join(root, 'src', rel + '.js'),
      path.join(root, 'src', rel + '.json')
    ];
    const hit = candidates.find((p) => fs.existsSync(p));
    assert.ok(hit, 'missing require ./' + rel);
    const packRel = path.relative(root, hit).split(path.sep).join('/');
    assert.ok(allowed.has(packRel), 'allowlist missing ' + packRel);
  }
});

test('installation compatibility marks 1.0.0-rc.1 as outdated against V1.0.1 minimum', () => {
  const compat = require('../src/installation-compatibility');
  assert.equal(compat.compatiblePackage('1.0.0-rc.1', '1.0.1-rc.1'), 'compatible_outdated');
  assert.equal(compat.compatiblePackage('1.0.1-rc.1', '1.0.1-rc.1'), 'compatible');
  const status = compat.evaluate(null, { root });
  assert.equal(status.package_version, '1.0.1-rc.1');
  assert.equal(status.overall, 'compatible');
  assert.equal(status.mutations_allowed, true);
});

test('npm package:check has no forbidden entries after allowlist repair', () => {
  const r = spawnSync('npm', ['run', 'package:check'], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  const body = JSON.parse(line);
  assert.equal(body.forbidden.length, 0);
  assert.ok(body.files >= 350);
});
