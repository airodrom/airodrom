'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const entry = path.join(__dirname, '../src/mcp.js');
const frames = [
  { id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
  { method: 'notifications/initialized' },
  { id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { message: 'DO_NOT_LOG_THIS' } } },
  { id: 2, method: 'ping' },
].map(v => JSON.stringify({ jsonrpc: '2.0', ...v })).join('\n') + '\n';
function run(directory, enabled) {
  const result = spawnSync(process.execPath, [entry], { input: frames, encoding: 'utf8', timeout: 5000, env: { ...process.env, AIRODROM_DATA_DIR: directory, MCP_STDIO_TRACE: enabled } });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 3);
  assert.equal(replies[1].result.isError, true);
  assert.deepEqual(replies[2].result, {});
}
test('trace creates a private missing file, preserves tool errors and session, and excludes payloads', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  run(dir, '1');
  const file = path.join(dir, 'mcp-stdio-trace.log'), text = fs.readFileSync(file, 'utf8');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert(!text.includes('DO_NOT_LOG_THIS'));
  const rows = text.trim().split('\n').map(JSON.parse);
  assert(rows.some(r => r.method === 'notifications/initialized' && r.state === 'ready'));
  assert(rows.some(r => r.toolError === true));
  assert(rows.some(r => r.event === 'exit' && r.code === 0));
});
test('disabled and unwritable tracing do not create files or break replies', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  run(dir, '');
  assert.deepEqual(fs.readdirSync(dir), []);
  const file = path.join(dir, 'not-directory'); fs.writeFileSync(file, '');
  run(file, '1');
});
test('trace refuses symlinks and stops writing at its size cap', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-trace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mcp-stdio-trace.log'), target = path.join(dir, 'target');
  fs.writeFileSync(target, 'untouched'); fs.symlinkSync(target, file);
  run(dir, '1'); assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
  fs.unlinkSync(file); fs.writeFileSync(file, Buffer.alloc(1024 * 1024), { mode: 0o600 });
  run(dir, '1'); assert.equal(fs.statSync(file).size, 1024 * 1024);
});
