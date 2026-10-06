#!/usr/bin/env node
'use strict';
const { McpStdio } = require('./mcp-stdio');
const { trace } = require('./mcp-stdio-trace');
const { TOOLS } = require('./mcp-tools');
const { createClient } = require('./mcp-client');
const server = new McpStdio({ tools: TOOLS, callTool: createClient(), maxRequestBytes: 128 * 1024 });
const handle = server.handle.bind(server);
server.handle = async request => {
  const method = ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'].includes(request?.method) ? request.method : 'other';
  const before = server.state;
  trace('request', { method, hasId: Object.hasOwn(request || {}, 'id'), state: before });
  const response = await handle(request);
  trace('response', { method, before, state: server.state, code: response?.error?.code ?? null, toolError: response?.result?.isError === true, notification: response === null });
  return response;
};
trace('start');
process.stdin.once('end', () => trace('stdin-end'));
process.once('exit', code => trace('exit', { code }));
server.serve(process.stdin, process.stdout).catch(() => { trace('transport-error'); console.error('MCP transport stopped'); process.exitCode = 1; });
