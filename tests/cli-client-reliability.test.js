'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PassThrough, Readable } = require('node:stream');
const local = require('../src/local-bootstrap');
const { help, interactive } = require('../src/interactive-cli');
const { inspectInstalledCommand } = require('../src/cli-command-inspect');
const ControlServer = require('../src/control-server');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');

async function liveHome(t) {
  const r = runtime(t), f = await fixture(t, { opencode: r.options });
  const home = path.join(f.root, 'cli-home');
  local.privateDirectory(home, true);
  const b = f.bridge, old = b.dataDir;
  b.dataDir = local.privateDirectory(path.join(home, 'data'), true);
  const server = new ControlServer(b, { port: 0, conversationOptions: require('./fixtures/direct-conversation-fixture.cjs').conversationOptions() });
  const address = await server.start();
  local.writePrivate(path.join(b.dataDir, 'ui.json'), { ...address, pid: process.pid });
  fs.writeFileSync(path.join(b.dataDir, 'bridge.lock'), String(process.pid), { mode: 0o600 });
  t.after(async () => { await server.close(); b.dataDir = old; });
  return { home, server, b, f };
}

test('help separates client chat from explicit service lifecycle', () => {
  const text = help();
  assert.match(text, /service start/);
  assert.match(text, /never launch a second supervisor/i);
  assert.match(text, /\bchat\b/);
});

test('attach succeeds across source fingerprint mismatch and never takes launch.lock', async t => {
  const { home } = await liveHome(t);
  t.mock.method(require('../src/runtime-fingerprint'), 'sourceFingerprint', () => ({ source_sha256: 'b'.repeat(64) }));
  const attached = await local.attach(home);
  assert.equal(attached.healthy, true);
  assert.equal(fs.existsSync(path.join(home, 'launch.lock')), false);
  await assert.rejects(local.status(home), /another source revision/);
  assert.equal((await local.start(home)).pid, attached.pid);
  assert.equal(fs.existsSync(path.join(home, 'launch.lock')), false);
});

test('unresponsive owner reports no-replacement attach failure and preserves discovery', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-cli-timeout-')));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const token = 'a'.repeat(64);
  const discovery = { url: 'http://127.0.0.1:12345/#token=' + token, port: 12345, pid: process.pid };
  local.writePrivate(path.join(data, 'ui.json'), discovery);
  local.writePrivate(path.join(data, 'control-credential.json'), { token });
  fs.writeFileSync(path.join(data, 'bridge.lock'), String(process.pid), { mode: 0o600 });
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('Synthetic timeout', 'TimeoutError'); });
  await assert.rejects(local.start(home), /existing service did not respond.*no replacement was started/i);
  assert.deepEqual(local.ownedJSON(path.join(data, 'ui.json')), discovery);
  assert.equal(fs.readFileSync(path.join(data, 'bridge.lock'), 'utf8'), String(process.pid));
  assert.equal(fs.existsSync(path.join(home, 'launch.lock')), false);
});

test('concurrent client attaches share one service without launch.lock', async t => {
  const { home } = await liveHome(t);
  const [a, b] = await Promise.all([local.attach(home), local.attach(home)]);
  assert.equal(a.pid, b.pid);
  assert.equal(fs.existsSync(path.join(home, 'launch.lock')), false);
});

test('interactive client attaches without calling start', async t => {
  const { home } = await liveHome(t);
  let starts = 0;
  t.mock.method(local, 'start', async () => { starts++; throw Error('start must not run for client chat'); });
  const output = new PassThrough();
  let text = '';
  output.on('data', c => text += c);
  await interactive(home, { input: Readable.from(['/quit\n']), output, env: { NO_COLOR: '1', TERM: 'dumb' } });
  assert.equal(starts, 0);
  assert.match(text, /AIRODROM|Type a question/);
  assert.doesNotMatch(text, /#token=|Bearer /);
});

test('service status and chat commands are wired in main', async t => {
  const { home } = await liveHome(t);
  t.mock.method(local, 'localHome', () => home);
  const { main } = require('../src/interactive-cli');
  const chunks = [];
  const write = process.stdout.write;
  t.after(() => { process.stdout.write = write; });
  process.stdout.write = (chunk, ...args) => { chunks.push(String(chunk)); return write.call(process.stdout, chunk, ...args); };
  await main(['status']);
  const text = chunks.join('');
  assert.match(text, /OpenCode|Ready|Memory/);
  assert.doesNotMatch(text, /#token=|Bearer /);
  chunks.length = 0;
  await main(['help']);
  assert.match(chunks.join(''), /service start/);
  await main(['service', 'status']);
  assert.match(chunks.join(''), /OpenCode|Ready|Memory|service start|stopped/);
});
test('install inspector detects unrelated PATH command without printing secrets', () => {
  const info = inspectInstalledCommand({
    root: local.ROOT,
    env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') },
  });
  assert.equal(typeof info.advice, 'string');
  assert.doesNotMatch(JSON.stringify(info), /#token=|Bearer /);
  assert.equal(info.expected_present, true);
});

test('stopped home refuses client attach with service-start guidance', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-cli-stopped-')));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  local.privateDirectory(path.join(home, 'data'), true);
  await assert.rejects(local.attach(home), /service start/);
});
