'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServiceLog, MAX_BYTES } = require('../src/service-log');

function temporary(t) {
  const root = fs.mkdtempSync('/private/tmp/pi-log-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('background log excludes arbitrary values, remains private and rotates within its size limit', t => {
  const root = temporary(t), file = path.join(root, 'service.log');
  const log = createServiceLog(file);
  log.write('listening', { port: 43117, token: 'NEVER-LOG-THIS', error: 'NEVER-LOG-THIS', message: 'NEVER-LOG-THIS' });
  const line = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(line).sort(), ['at', 'event', 'pid', 'port']);
  assert(!fs.readFileSync(file, 'utf8').includes('NEVER-LOG-THIS'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => log.write('NEVER-LOG-THIS'), /Invalid service log event/);
  fs.writeFileSync(file, Buffer.alloc(MAX_BYTES, 32));
  log.write('stopped');
  assert.equal(fs.statSync(file + '.1').size, MAX_BYTES);
  assert(fs.statSync(file).size < 256);
  assert.equal(fs.statSync(file + '.1').mode & 0o777, 0o600);
});
test('background logger rejects relative paths, shared files, links and nonprivate directories', t => {
  const root = temporary(t), target = path.join(root, 'target'), file = path.join(root, 'service.log');
  assert.throws(() => createServiceLog('relative.log'), /absolute/);
  fs.writeFileSync(target, 'private', { mode: 0o600 });
  fs.symlinkSync(target, file);
  assert.throws(() => createServiceLog(file), /private regular file/);
  fs.unlinkSync(file); fs.linkSync(target, file);
  assert.throws(() => createServiceLog(file), /private regular file/);
  fs.unlinkSync(file); fs.writeFileSync(file, 'shared', { mode: 0o644 });
  assert.throws(() => createServiceLog(file), /private regular file/);
  fs.chmodSync(file, 0o600); fs.chmodSync(root, 0o755);
  assert.throws(() => createServiceLog(file), /directory must be private/);
});

test('background service logs lifecycle without printing its launch token or raw startup errors', async t => {
  const root = temporary(t), source = path.join(root, 'source'), data = path.join(root, 'data'), logFile = path.join(root, 'service.log');
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'settings.json'), '{}');
  const child = spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, '../src/index.js')], {
    env: { ...process.env, AIRODROM_DATA_DIR: data, AIRODROM_SOURCE_PROFILE: source, AIRODROM_PORT: '0', AIRODROM_BACKGROUND: '1', AIRODROM_LOG_FILE: logFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', part => output += part); child.stderr.on('data', part => output += part);
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(data, 'ui.json')) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(fs.existsSync(path.join(data, 'ui.json')), 'background service started');
  const discovery = JSON.parse(fs.readFileSync(path.join(data, 'ui.json')));
  // Discovery is published synchronously before startup finishes registering
  // shutdown handlers. An HTTP response proves the startup callback returned.
  await new Promise((resolve, reject) => {
    const request = require('node:http').get({ hostname: '127.0.0.1', port: discovery.port, path: '/' }, response => {
      response.resume(); response.once('end', resolve); response.once('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('Fixture readiness timeout')));
    request.once('error', reject);
  });
  child.kill('SIGTERM');
  assert.equal(await exit, 0);
  assert(!output.includes('#token='));
  assert(!output.includes(discovery.url));
  assert.deepEqual(fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line).event), ['starting', 'listening', 'stopping', 'stopped']);
  assert.equal(fs.existsSync(path.join(data, 'bridge.lock')), false);

  const secretPath = path.join(root, 'PRIVATE-CONFIG-PATH');
  const bad = spawn(process.execPath, ['--experimental-sqlite', path.join(__dirname, '../src/index.js')], {
    env: { ...process.env, AIRODROM_DATA_DIR: data, AIRODROM_SOURCE_PROFILE: secretPath, AIRODROM_BACKGROUND: '1', AIRODROM_LOG_FILE: logFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure = ''; bad.stdout.on('data', part => failure += part); bad.stderr.on('data', part => failure += part);
  assert.equal(await new Promise(resolve => bad.once('exit', resolve)), 1);
  assert(!failure.includes(secretPath));
  assert(!fs.readFileSync(logFile, 'utf8').includes(secretPath));
  assert.equal(JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').at(-1)).event, 'error');
});
