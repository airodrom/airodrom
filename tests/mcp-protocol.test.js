'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable, Writable } = require('node:stream');
const { McpStdio, PROTOCOL_VERSIONS } = require('../src/mcp-stdio');

const tools = [{ name: 'create_task', description: 'Create one scoped task', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false } }];
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const init = (version = '2025-11-25') => rpc(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const line = message => JSON.stringify(message) + '\n';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function ready(options = {}) {
  const server = new McpStdio({ tools, callTool: async (_name, args) => ({ accepted: args.prompt }), ...options });
  await server.handle(init());
  await server.handle(initialized);
  return server;
}

async function wire(server, input) {
  let text = '';
  const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  await server.serve(Readable.from(input), output);
  return text.trim().split('\n').filter(Boolean).map(value => JSON.parse(value));
}

test('MCP initialization negotiates supported revisions, falls back, and gates lifecycle', async () => {
  for (const version of [...PROTOCOL_VERSIONS, '2025-03-26', '2024-11-05', 'future-version']) {
    const server = new McpStdio({ tools, callTool: async () => ({}) });
    assert.equal((await server.handle(rpc(0, 'tools/list'))).error.code, -32000);
    assert.deepEqual((await server.handle(rpc(0, 'ping'))).result, {});
    const result = (await server.handle(init(version))).result;
    assert.equal(result.protocolVersion, PROTOCOL_VERSIONS.includes(version) ? version : PROTOCOL_VERSIONS[0]);
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    assert.equal((await server.handle(rpc(2, 'tools/list'))).error.code, -32000);
    await server.handle(initialized);
    assert.deepEqual((await server.handle(rpc(3, 'tools/list'))).result.tools, tools);
    assert.deepEqual((await server.handle(init(version))).result, result);
  }
});

test('tunnel discovery and client handshakes share metadata without resetting tool gates', async () => {
  const seen = [];
  const server = new McpStdio({ tools, callTool: async (_name, args, client) => { seen.push({ args, client }); return { ok: true }; } });
  const discovery = { ...init(), id: 1, params: { ...init().params, clientInfo: { name: 'discovery-probe', version: '1' } } };
  const client = { ...init(), id: 0, params: { ...init().params, clientInfo: { name: 'different-unverified-client', version: '2' } } };
  const first = await server.handle(discovery);
  assert.deepEqual((await server.handle(client)).result, first.result);
  assert.equal(server.state, 'initializing');
  assert.equal((await server.handle(rpc(2, 'tools/call', { name: 'create_task', arguments: { prompt: 'once' } }))).error.code, -32000);
  await server.handle(initialized);
  assert.deepEqual((await server.handle(client)).result, first.result);
  assert.equal(server.state, 'ready');
  assert.equal((await server.handle({ ...client, params: { ...client.params, arbitrary: true } })).error.code, -32602);
  assert.equal((await server.handle({ ...client, params: { ...client.params, protocolVersion: '2025-06-18' } })).error.code, -32600);
  assert.equal(seen.length, 0);
  assert.deepEqual((await server.handle(rpc(3, 'tools/list'))).result.tools, tools);
  await server.handle(rpc(4, 'tools/call', { name: 'create_task', arguments: { prompt: 'once' } }));
  assert.deepEqual(seen, [{ args: { prompt: 'once' }, client: { name: 'discovery-probe', version: '1' } }]);
});

test('wire initialization, chunked Unicode, list, ping and structured tool result round-trip', async () => {
  const seen = [];
  const server = new McpStdio({ tools, callTool: async (name, args, client) => { seen.push({ name, args, client }); return { task_id: 't1', result: 'café' }; } });
  const input = Buffer.from([init(), initialized, rpc(2, 'tools/list'), rpc(3, 'ping'), rpc(4, 'tools/call', { name: 'create_task', arguments: { prompt: 'café' }, _meta: { progressToken: 1 } })].map(line).join(''));
  const replies = await wire(server, [...input].map(byte => Buffer.from([byte])));
  assert.equal(replies.length, 4);
  assert.deepEqual(replies.find(row => row.id === 2).result.tools, tools);
  assert.deepEqual(replies.find(row => row.id === 3).result, {});
  const result = replies.find(row => row.id === 4).result;
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.deepEqual(result.structuredContent, { task_id: 't1', result: 'café' });
  assert.deepEqual(seen, [{ name: 'create_task', args: { prompt: 'café' }, client: { name: 'test-client', version: '1' } }]);
});

test('malformed envelopes, batches and raw protocol methods are rejected without dispatch', async () => {
  let calls = 0;
  const server = await ready({ callTool: async () => { calls++; return {}; } });
  for (const request of [null, [], [rpc(1, 'ping')], 1, 'x', {}, { jsonrpc: '1.0', id: 1, method: 'ping' }, rpc(null, 'ping'), rpc({}, 'ping'), rpc(1.5, 'ping'), { ...rpc(8, 'ping'), arbitrary: true }]) {
    assert.equal((await server.handle(request)).error.code, -32600);
  }
  for (const method of ['bash', 'resources/read', 'pi/rpc', 'memory/sql', 'notifications/initialized']) {
    assert.equal((await server.handle(rpc(2, method, {}))).error.code, -32601);
  }
  assert.equal(calls, 0);
});

test('invalid params and unknown tools never reach callback', async () => {
  let calls = 0;
  const server = await ready({ callTool: async () => { calls++; return {}; } });
  for (const request of [
    rpc(1, 'tools/call'), rpc(2, 'tools/call', []), rpc(3, 'tools/call', { name: 'create_task', arguments: [] }),
    rpc(4, 'tools/call', { name: 'create_task', command: 'whoami' }), rpc(5, 'tools/call', { name: 'bash', arguments: {} }),
    rpc(6, 'tools/list', { cursor: 'unrecognized' }), rpc(7, 'ping', { arbitrary: true }),
    rpc(8, 'tools/call', { name: 'create_task', _meta: [] }),
  ]) assert.equal((await server.handle(request)).error.code, -32602);
  const fresh = new McpStdio({ tools, callTool: async () => ({}) });
  for (const params of [{}, { ...init().params, capabilities: [] }, { ...init().params, clientInfo: {} }, { ...init().params, protocolVersion: '' }]) {
    assert.equal((await fresh.handle(rpc(1, 'initialize', params))).error.code, -32602);
  }
  assert.equal(calls, 0);
});

test('all tool and initialization notifications are non-executing and silent', async () => {
  let calls = 0;
  const server = new McpStdio({ tools, callTool: async () => { calls++; return {}; } });
  const notification = { ...init() }; delete notification.id;
  assert.equal(await server.handle(notification), null);
  assert.equal(server.state, 'new');
  await server.handle(initialized);
  assert.equal(server.state, 'new');
  await server.handle(init());
  await server.handle({ ...initialized, params: { invalid: true } });
  assert.equal(server.state, 'initializing');
  await server.handle(initialized);
  for (const method of ['tools/call', 'create_task', 'approve_once', 'cancel_task', 'notifications/cancelled', 'ping']) {
    assert.equal(await server.handle({ jsonrpc: '2.0', method, params: { name: 'create_task', arguments: {} } }), null);
  }
  assert.equal(calls, 0);
});

test('tool failures return isError without leaking exception messages or stack', async () => {
  const server = await ready({ callTool: async () => { throw new Error('SECRET_TOKEN_DO_NOT_ECHO'); } });
  const response = await server.handle(rpc(2, 'tools/call', { name: 'create_task' }));
  assert.equal(response.result.isError, true);
  assert.equal(JSON.stringify(response).includes('SECRET_TOKEN'), false);
  assert.equal(response.result.structuredContent.error, 'Tool call failed');
  server.callTool = async () => { const error = new Error('private'); error.publicMessage = 'Task not found'; throw error; };
  assert.equal((await server.handle(rpc(3, 'tools/call', { name: 'create_task' }))).result.structuredContent.error, 'Task not found');
  for (const payload of [undefined, null, 'string', []]) {
    server.callTool = async () => payload;
    assert.equal((await server.handle(rpc(4, 'tools/call', { name: 'create_task' }))).result.isError, true);
  }
});

test('oversized tool output is bounded and does not alter advertised result shape', async () => {
  const server = await ready({ maxResponseBytes: 1024, callTool: async () => ({ text: 'x'.repeat(2000) }) });
  const replies = await wire(server, [line(rpc(2, 'tools/call', { name: 'create_task' }))]);
  assert.equal(replies[0].result.isError, true);
  assert.ok(Buffer.byteLength(JSON.stringify(replies[0])) < 1024);
});

test('wire parser rejects invalid JSON, UTF-8 and oversized frames, then recovers', async () => {
  const server = await ready({ maxRequestBytes: 128 });
  const input = [Buffer.from('{bad}\n'), Buffer.from([0xff, 10]), Buffer.from('x'.repeat(129)), Buffer.from('x'.repeat(50000)), Buffer.from('\n'), Buffer.from(line(rpc(2, 'ping'))), Buffer.from('[]\n')];
  const replies = await wire(server, input);
  assert.deepEqual(replies.map(row => row.error?.code ?? 'ok'), [-32700, -32700, -32600, 'ok', -32600]);
  assert.equal(replies[3].id, 2);
});

test('EOF drains admitted work, rejects an incomplete frame and leaves output owned by caller', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const server = await ready({ callTool: async () => { await blocked; return { done: true }; } });
  const input = new PassThrough();
  const output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  let finished = false;
  const serving = server.serve(input, output).then(() => { finished = true; });
  input.end(line(rpc(2, 'tools/call', { name: 'create_task' })) + '{"unfinished":');
  await tick(); assert.equal(finished, false);
  release(); await serving;
  const responses = text.trim().split('\n').map(JSON.parse);
  assert.equal(responses.find(row => row.id === null).error.code, -32700);
  assert.equal(responses.find(row => row.id === 2).result.structuredContent.done, true);
  assert.equal(output.writableEnded, false);
});

test('bounded concurrency and queue reject excess requests before executing them', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const executed = [];
  const server = await ready({ maxConcurrentRequests: 1, maxQueuedRequests: 1, callTool: async (_name, args) => { executed.push(args.number); if (args.number === 1) await blocked; return { number: args.number }; } });
  const input = new PassThrough(); const output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  const serving = server.serve(input, output);
  input.end([1, 2, 3, 4].map(number => line(rpc(number + 10, 'tools/call', { name: 'create_task', arguments: { number } }))).join(''));
  await tick(); await tick();
  assert.deepEqual(executed, [1]);
  const busy = text.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(busy.map(row => row.id), [13, 14]);
  assert.ok(busy.every(row => row.error.code === -32000));
  release(); await serving;
  assert.deepEqual(executed, [1, 2]);
});

test('duplicate in-flight request IDs cannot repeat a mutation', async () => {
  let release; const blocked = new Promise(resolve => { release = resolve; }); let calls = 0;
  const server = await ready({ callTool: async () => { calls++; await blocked; return {}; } });
  const input = new PassThrough(); const output = new PassThrough(); let text = '';
  output.on('data', chunk => { text += chunk; });
  const serving = server.serve(input, output);
  input.end(line(rpc(2, 'tools/call', { name: 'create_task' })).repeat(2));
  await tick(); assert.equal(calls, 1);
  release(); await serving;
  assert.equal(text.trim().split('\n').map(JSON.parse).find(row => row.error).error.code, -32600);
});

test('slow output applies backpressure while accepted work remains bounded', async () => {
  let concurrent = 0; let maximum = 0; let calls = 0;
  const server = await ready({ maxConcurrentRequests: 2, maxQueuedRequests: 1, callTool: async () => { concurrent++; maximum = Math.max(maximum, concurrent); calls++; await tick(); concurrent--; return { ok: true }; } });
  const lines = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { lines.push(chunk.toString()); setTimeout(callback, 1); } });
  await server.serve(Readable.from([[1, 2, 3, 4, 5, 6].map(id => line(rpc(id, 'tools/call', { name: 'create_task' }))).join('')]), output);
  assert.equal(lines.length, 6);
  assert.ok(maximum <= 2);
  assert.ok(calls < 6);
});

test('disconnected output stops queued mutations and terminates transport', async () => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const server = await ready({ maxConcurrentRequests: 1, maxQueuedRequests: 3, callTool: async () => { calls++; await blocked; return {}; } });
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('Output disconnected')); } });
  const serving = server.serve(input, output);
  const rejection = assert.rejects(serving, /Output disconnected/);
  input.write([1, 2, 3].map(id => line(rpc(id, 'tools/call', { name: 'create_task' }))).join(''));
  await tick();
  release();
  await rejection;
  assert.equal(calls, 1);
  assert.equal(server.serving, false);
});
