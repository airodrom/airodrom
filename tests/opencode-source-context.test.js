'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceContextSensitive, OpenCodeAdapter } = require('../src/opencode-adapter');
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
    '/** Marker */\nfunction parseConfig(text) {\n  return text.split(String.fromCharCode(10));\n}\n'
  ];
  for (const sample of samples) assert.equal(sourceContextSensitive(sample), false, sample);
});

test('credentials, absolute sensitive paths and protected locations remain fail-closed', () => {
  const denied = [
    'Bearer sk-ant-abcdefghijklmnopqrstuvwxyz',
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
    'open vault.sqlite for export'
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

test('sourceContextSensitive is exported for host inspection without granting authority', () => {
  assert.equal(typeof sourceContextSensitive, 'function');
  assert.equal(new OpenCodeAdapter(null, {}).id, 'opencode');
});
