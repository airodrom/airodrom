'use strict';
// Disposable HTTP fixture; never starts Pi or touches managed service state.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const directory = process.argv[2];
let server, port = 0, generation = 0, revision = 0, state = 'Starting';
const calls = [];
const mcpToken = () => String(generation).repeat(64);
const uiToken = () => 'a'.repeat(64);
function write(name, value) {
  const file = path.join(directory, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
function publish() { write('fixture.json', { port, generation, revision, state, calls, pid: process.pid }); }
async function start() {
  server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const expected = request.url === '/api/status' ? uiToken() : mcpToken();
      const status = request.headers.authorization === `Bearer ${expected}` ? 200 : 401;
      calls.push({ route: request.url, status, generation });
      publish();
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ task_id: 'existing-task' }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  port = server.address().port;
  write('mcp.json', { port, pid: process.pid, token: mcpToken() });
  write('ui.json', { token: uiToken() });
  state = 'Connected';
  publish();
}
async function stop() {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  state = 'Stopped';
}
process.on('message', async message => {
  try {
    revision = message.revision;
    if (message.action === 'stop' || message.action === 'restart') await stop();
    if (message.action === 'start' || message.action === 'restart') { generation++; await start(); }
    else publish();
  } catch { process.exit(1); }
});
start().catch(() => process.exit(1));
