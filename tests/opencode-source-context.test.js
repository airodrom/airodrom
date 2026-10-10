'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  sourceContextSensitive,
  codingSecretScanView,
  OpenCodeAdapter,
  MAX_FILE,
  CODING_TIMEOUT_MS
} = require('../src/opencode-adapter');
const { containsSecret } = require('../src/personal-memory');
const { runtime } = require('./fixtures/opencode-fixture.cjs');
const { redactValue } = require('../src/control-plane-store');

test('display redaction still rewrites ordinary JS syntax (historical false-positive class)', () => {
  for (const sample of [
    '// line comment',
    '/** block comment */',
    'const re=/^abc$/;',
    'const x = a / b;',
    "require('./local')",
    "require('../src/x.js')",
    'text.split(/\\r?\\n/)'
  ]) {
    assert.notEqual(redactValue(sample), sample, sample);
    assert.equal(sourceContextSensitive(sample), false, sample);
  }
});

test('ordinary authorized source paths and JS syntax are not sensitive context', () => {
  const samples = [
    'src/config-parser.js',
    'lib/util.js',
    'tests/fixture.test.cjs',
    "'use strict';\n// Parse KEY=VALUE lines.\nconst re=/^ready$/;\nmodule.exports={parse(){}};\n",
    '/** Marker */\nfunction parseConfig(text) {\n  return text.split(String.fromCharCode(10));\n}\n',
    "headers:{Authorization:'Bearer '+token}",
    'headers:{Authorization:`Bearer ${token}`}',
    'Conversations cannot change credentials or deploy.',
    'session credentials remain operator-local',
    'Sensitive Memory · app secret withheld'
  ];
  for (const sample of samples) assert.equal(sourceContextSensitive(sample), false, sample);
});

test('authorized Control Hub source is usable without removing secret protection', () => {
  const hub = fs.readFileSync(path.join(__dirname, '../public/control-hub.js'), 'utf8');
  assert.ok(Buffer.byteLength(hub) > 12000, 'hub exceeds the prior 12 KiB bound');
  assert.ok(Buffer.byteLength(hub) <= MAX_FILE, 'hub stays within the hard file bound');
  assert.equal(containsSecret("Authorization:'Bearer '+token"), true, 'Memory classifier still flags Auth header construction');
  assert.equal(containsSecret(codingSecretScanView("Authorization:'Bearer '+token")), false);
  assert.equal(sourceContextSensitive(hub), false);
  assert.equal(CODING_TIMEOUT_MS, 120000);
  assert.ok(MAX_FILE >= 262144);
});

test('credentials, absolute sensitive paths and protected locations remain fail-closed', () => {
  const denied = [
    'Bearer sk-ant-abcdefghijklmnopqrstuvwxyz',
    "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz",
    'api_key=supersecretvalue123',
    'password: hunter2hunter2',
    'token=ghp_abcdefghijklmnopqrstuvwxyz12',
    '/Users/andrew/.airodrom/data/memory.sqlite',
    '/home/operator/.airodrom/profile/settings.json',
    '~/secrets/token',
    'C:\\Users\\x\\credentials.json',
    '\\\\server\\share\\secret',
    '/private/tmp/credentials.json',
    'OPENAI_API_KEY=sk-proj-examplevalue',
    'process.env.AIRODROM_MCP_TOKEN',
    'copy .env into the worker',
    'read auth.json from disk',
    'open vault.sqlite for export',
    'load credentials.json before dispatch',
    'read /secrets/prod from disk'
  ];
  for (const sample of denied) assert.equal(sourceContextSensitive(sample), true, sample);
});

test('OpenCode execute admits slash-containing authorized JS and denies secret context', async t => {
  const f = runtime(t);
  const js = path.join(f.workspace, 'sample.js');
  fs.writeFileSync(js, [
    "'use strict';",
    '// Ordinary line comment',
    '/** Ordinary block comment */',
    'const PATTERN = /^alpha$/;',
    "const rel = './neighbor';",
    "headers:{Authorization:'Bearer '+token}",
    "module.exports = { value: 'alpha', PATTERN, rel };",
    ''
  ].join('\n'));
  // Read-only admission proves sourceContextSensitive accepts ordinary JS syntax.
  const admitted = await f.adapter.execute({
    workspace: f.workspace,
    files: ['sample.js'],
    writable: [],
    objective: 'Read sample.js and return JSON with summary fixture, changed_files:[],tests:[],artifacts:[],limitations:[]',
    timeoutMs: 5000
  });
  assert.equal(admitted.changes.length, 0);
  assert.equal(admitted.provenance.authority, false);
  await assert.rejects(
    f.adapter.execute({ ...f.request, objective: 'use Bearer sk-ant-abcdefghijklmnopqrstuvwxyz' }),
    /sensitive_context/
  );
  await assert.rejects(
    f.adapter.execute({
      workspace: f.workspace,
      files: ['sample.js'],
      objective: 'Read /Users/operator/.airodrom/data/memory.sqlite',
      timeoutMs: 1000
    }),
    /sensitive_context/
  );
  await assert.rejects(f.adapter.execute({ ...f.request, files: ['../outside.txt'] }), /file_scope/);
});

test('worker timeout remains bounded and oversized files stay fail-closed', async t => {
  const f = runtime(t);
  await assert.rejects(f.adapter.execute({ ...f.request, objective: 'timeout', timeoutMs: 100 }), /opencode_timeout/);
  await assert.rejects(f.adapter.execute({ ...f.request, timeoutMs: 120001 }), /timeout_or_cancel_bound/);
  const oversized = path.join(f.workspace, 'huge.js');
  fs.writeFileSync(oversized, `'use strict';\n` + 'x'.repeat(MAX_FILE));
  await assert.rejects(
    f.adapter.execute({
      workspace: f.workspace,
      files: ['huge.js'],
      writable: [],
      objective: 'read',
      timeoutMs: 1000
    }),
    /file_boundary/
  );
});

test('sourceContextSensitive is exported for host inspection without granting authority', () => {
  assert.equal(typeof sourceContextSensitive, 'function');
  assert.equal(new OpenCodeAdapter(null, {}).id, 'opencode');
});
