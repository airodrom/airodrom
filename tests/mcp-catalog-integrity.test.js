'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const integrity = require('../src/mcp-catalog-integrity');
const verify = require('../scripts/mcp-catalog-verify.cjs');

const rows = () => [
  { name: 'prepare_mission', inputSchema: { type: 'object', properties: { objective: { type: 'string' } } } },
  { name: 'get_mission_evidence', inputSchema: { type: 'object', properties: { mission_id: { type: 'string' } } } },
];
function installedFixture(t, catalog = rows()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-mcp-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['src', 'scripts', 'bin', 'elsewhere']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'src/mcp-tools.js'), 'module.exports={TOOLS:' + JSON.stringify(catalog) + '};\n');
  fs.writeFileSync(path.join(root, 'src/mcp-stdio.js'), '// Disposable test stub\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"airodrom-test-fixture"}\n');
  const executable = path.join(root, 'scripts/airodrom.cjs');
  const script = [
    "'use strict';",
    'const catalog=' + JSON.stringify(catalog) + ';',
    "let input='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',s=>input+=s);",
    "process.stdin.on('end',()=>{",
    "const frames=input.trim().split('\\n').map(JSON.parse);",
    "if(frames.some(frame=>frame.method==='tools/call'))process.exit(13);",
    "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{capabilities:{tools:{listChanged:true}}}})+'\\n');",
    "if(!frames.some(frame=>frame.method==='notifications/initialized'))process.exit(14);",
    "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:catalog}})+'\\n');",
    "});",
  ].join('\n');
  fs.writeFileSync(executable, script, { mode: 0o755 });
  const alias = path.join(root, 'bin/airodrom');
  fs.symlinkSync(executable, alias);
  return { root, executable, alias, cwd: path.join(root, 'elsewhere') };
}

test('canonical hashes remain deterministic under property and tool reordering', () => {
  const original = integrity.snapshot(rows());
  const permuted = rows().reverse().map(row => ({
    inputSchema: { properties: Object.fromEntries(Object.entries(row.inputSchema.properties).reverse()), type: 'object' }, name: row.name,
  }));
  assert.equal(integrity.snapshot(permuted).name_digest, original.name_digest);
  assert.equal(integrity.snapshot(permuted).schema_digest, original.schema_digest);
});

test('schema change with same count and same names fails closed', () => {
  const installed = rows(), client = structuredClone(installed);
  client[0].inputSchema.properties.objective.type = 'number';
  const report = integrity.inspect({ source: installed, installed, advertised: installed, client });
  assert.equal(report.status, 'MISMATCH');
  assert.deepEqual(report.comparisons[2].schema_changed_names, ['prepare_mission']);
  assert.equal(report.first_mismatch.to, 'client');
  assert.equal(report.diagnosis, 'CLIENT_CATALOG_DIFFERENCE_CAUSE_UNKNOWN');
});

test('missing, extra, and reordered names give precise differential', () => {
  const source = rows();
  const report = integrity.inspect({ source, installed: source, advertised: source, client: [
    source[0], { name: 'unknown_new_tool', inputSchema: { type: 'object' } },
  ] });
  assert.deepEqual(report.comparisons[2].missing, ['get_mission_evidence']);
  assert.deepEqual(report.comparisons[2].extra, ['unknown_new_tool']);
  assert.equal(report.status, 'MISMATCH');
});

test('unknown client returns UNVERIFIED rather than PASS', () => {
  const source = rows();
  const result = integrity.inspect({ source, installed: source, advertised: source });
  assert.equal(result.local_status, 'PASS');
  assert.equal(result.status, 'UNVERIFIED');
  assert.equal(result.client_visibility, 'NOT_OBSERVED');
  assert.equal(result.observed.client, null);
});

test('name-only client receipt does not claim schema verification', () => {
  const source = rows();
  const result = integrity.inspect({ source, installed: source, advertised: source, client: source.map(row => row.name) });
  assert.equal(result.client_status, 'UNVERIFIED');
  assert.equal(result.status, 'UNVERIFIED');
});

test('stale installed version is reported without guessing cache cause', () => {
  const source = rows();
  const result = integrity.inspect({ source, installed: [source[0]], advertised: [source[0]] });
  assert.equal(result.local_status, 'MISMATCH');
  assert.equal(result.first_mismatch.to, 'installed');
  assert.equal(result.diagnosis, 'SOURCE_INSTALL_DIFFERENCE');
});

test('commit divergence is identified independently from tool schema', () => {
  const source = rows();
  const result = integrity.inspect({ source, installed: source, advertised: source,
    sourceSha: 'a'.repeat(40), installedSha: 'b'.repeat(40) });
  assert.equal(result.local_status, 'MISMATCH');
  assert.equal(result.version_mismatch, true);
});

test('invalid names and duplicates never enter an observation', () => {
  assert.throws(() => integrity.snapshot([{ name: 'dupe' }, { name: 'dupe' }]), /Duplicate/);
  assert.throws(() => integrity.snapshot([{ name: 'not valid' }]), /Invalid/);
  assert.throws(() => integrity.snapshot([{ name: 'x', inputSchema: [] }]), /Invalid/);
});

test('PATH symlink resolves to installed executable regardless of old working directory', t => {
  const fixture = installedFixture(t);
  const found = verify.findExecutable('airodrom', { PATH: path.join(fixture.root, 'bin') });
  // macOS may surface /var vs /private/var; compare real paths.
  assert.equal(fs.realpathSync(found), fs.realpathSync(fixture.executable));
  assert.equal(fs.realpathSync(verify.installationRoot(found)), fs.realpathSync(fixture.root));
  const observed = verify.verify({ sourceTools: rows(), installedTools: rows(), executable: found,
    sourceSha: null, installedSha: null, cwd: fixture.cwd });
  assert.equal(observed.local_status, 'PASS');
  assert.equal(observed.status, 'UNVERIFIED');
  assert.equal(observed.gate, 'PASS');
  assert.equal(observed.probe.no_tool_calls, true);
  assert.equal(observed.executable.realpath, undefined);
});

test('read-only stdio handshake detects stale running catalog and never calls a tool', t => {
  const fixture = installedFixture(t, [rows()[0]]);
  const result = verify.verify({ sourceTools: rows(), installedTools: rows(), executable: fixture.executable,
    sourceSha: null, installedSha: null });
  assert.equal(result.local_status, 'MISMATCH');
  assert.equal(result.comparisons[1].to, 'advertised');
  assert.equal(result.comparisons[1].status, 'MISMATCH');
  assert.equal(result.gate, 'BLOCKED');
});

test('requiring a client receipt blocks an otherwise matching local probe', t => {
  const fixture = installedFixture(t);
  const result = verify.verify({ sourceTools: rows(), installedTools: rows(), executable: fixture.executable,
    sourceSha: null, installedSha: null, requireClient: true });
  assert.equal(result.local_status, 'PASS');
  assert.equal(result.gate, 'BLOCKED');
});

test('client receipt file enforces size and array structure', t => {
  const fixture = installedFixture(t);
  const receipt = path.join(fixture.root, 'client.json');
  fs.writeFileSync(receipt, JSON.stringify({ names: ['prepare_mission', 'get_mission_evidence'] }));
  assert.deepEqual(verify.clientCatalog(receipt), ['prepare_mission', 'get_mission_evidence']);
  fs.writeFileSync(receipt, '{"secret":"not-a-catalog"}');
  assert.throws(() => verify.clientCatalog(receipt), /Expected/);
});
