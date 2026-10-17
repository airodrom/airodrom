'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { OpenCodeAdapter } = require('../src/apps/opencode-adapter');

function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }

function tempExecutable(t, bytes) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-exe-integrity-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'opencode-fixture');
  fs.writeFileSync(executable, bytes, { mode: 0o700 });
  return { root, executable };
}

test('status observation cache cannot authorize same-size executable tampering', t => {
  const original = Buffer.alloc(128, 0x41);
  const { executable } = tempExecutable(t, original);
  const digest = sha(original);
  const adapter = new OpenCodeAdapter(null, {
    enabled: true,
    model: 'ollama/qwen3-coder:30b',
    executable
  });
  adapter.qualifiedDigest = () => digest;

  assert.equal(adapter.observeArtifact(executable), executable);
  assert.equal(adapter.observeArtifact(executable), executable, 'metadata cache hits for status');

  const st = fs.statSync(executable);
  fs.writeFileSync(executable, Buffer.alloc(128, 0x42), { mode: 0o700 });
  fs.utimesSync(executable, st.atime, st.mtime);

  // Unchanged size+mtime may keep status observation warm — that is intentional and non-authorizing.
  assert.equal(adapter.observeArtifact(executable), executable);
  assert.throws(() => adapter.verifyArtifact(executable), /opencode_runtime_pins_changed/,
    'launch must digest-fail when bytes change under restored mtime');
});

test('edited runtime-pins sha256 cannot re-qualify a substitute executable', t => {
  const original = Buffer.alloc(64, 0x31);
  const substitute = Buffer.alloc(64, 0x32);
  const { root, executable } = tempExecutable(t, original);
  const pinsFile = path.join(root, 'runtime-pins.json');
  const forged = sha(substitute);
  fs.writeFileSync(pinsFile, JSON.stringify({
    version: 1,
    platform: process.platform + '-' + process.arch,
    model: 'ollama/qwen3-coder:30b',
    runtime_version: '2.0.25',
    executables: [
      { id: 'node', path: process.execPath, sha256: sha(fs.readFileSync(process.execPath)) },
      { id: 'sandbox-exec', path: '/usr/bin/sandbox-exec', sha256: sha(fs.readFileSync('/usr/bin/sandbox-exec')) },
      { id: 'opencode', path: executable, sha256: forged }
    ]
  }) + '\n', { mode: 0o600 });
  fs.writeFileSync(executable, substitute, { mode: 0o700 });

  const adapter = new OpenCodeAdapter(null, {
    enabled: true,
    model: 'ollama/qwen3-coder:30b',
    executable,
    pinsFile
  });
  // Observation may accept path identity; launch must still require the package-qualified digest.
  assert.equal(adapter.observeArtifact(executable), executable);
  assert.throws(() => adapter.verifyArtifact(executable), /opencode_runtime_pins_changed/);
});

test('missionCounts do not share mutable state across Bridge instances', async t => {
  const display = require('../src/product-observability');
  const { fixture } = require('./fixtures/mission-fixture.cjs');
  const a = await fixture(t), b = await fixture(t);
  a.bridge.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(a.create().id);
  const first = display.missionCounts(a.bridge);
  assert.ok(first.Active >= 1);
  assert.equal(display.missionCounts(b.bridge).Active, 0);
  assert.ok(display.missionCounts(a.bridge).Active >= 1);
});