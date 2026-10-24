'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Exercise the security boundary in a child: catching fetch's rejection must
// also prevent a later orphaned-stream error from terminating the process.
for (const transport of ['builtin', 'package']) test('excessive content encodings cannot crash ' + transport + ' fetch', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'gzip, gzip, gzip, gzip, gzip, gzip', 'Content-Length': '100' });
    res.flushHeaders(); res.socket.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const program = `const request=${transport === 'builtin' ? 'fetch' : 'require("undici").fetch'};
    request(process.argv[1]).then(()=>process.exitCode=2,()=>{
      setTimeout(()=>process.stdout.write('rejected-safely'),150);
    });`;
  const child = spawn(process.execPath, ['-e', program, 'http://127.0.0.1:' + server.address().port], { cwd: require('node:path').resolve(__dirname, '..'), stdio: ['ignore','pipe','pipe'] });
  t.after(() => child.kill());
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000); t.after(() => clearTimeout(timer));
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({code,signal})); });
  assert.equal(result.code, 0, stderr); assert.equal(result.signal, null); assert.equal(stdout, 'rejected-safely');
});

test('mixed-case SRI algorithm cannot bypass a mismatched response digest', async t => {
  const server = http.createServer((_req, res) => res.end('actual bytes'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const integrity = 'SHA256-' + require('node:crypto').createHash('sha256').update('different bytes').digest('base64');
  for (const request of [fetch, require('undici').fetch]) {
    await assert.rejects(request('http://127.0.0.1:' + server.address().port, {integrity}), /fetch failed/);
  }
});
