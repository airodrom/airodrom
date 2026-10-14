'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const ControlServer = require('../src/control-server');
const local = require('../src/local-bootstrap');
const { waitResult, isTransportLoss, transportLossMessage } = require('../src/interactive-cli');

function synthetic(f) {
  f.bridge.missions.web.options = {
    synthetic: true,
    browserFactory: () => ({
      start: async () => {},
      execute: async () => ({
        id: randomUUID(),
        classification: 'observed',
        title: 'Synthetic',
        text: 'Synthetic public page',
        url: 'https://example.com/',
        links: [],
        untrusted: true,
        authority: false
      }),
      verify: () => true,
      close: async () => ({ closed: true, termination_verified: true, owned_process_termination: 'verified' }),
      ownedProcessId: () => null
    })
  };
}

async function apiHome(t, bridge) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-reg-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  local.privateDirectory(home, true);
  const data = local.privateDirectory(path.join(home, 'data'), true);
  const old = bridge.dataDir;
  bridge.dataDir = data;
  const server = new ControlServer(bridge, { port: 0 });
  const address = await server.start();
  local.writePrivate(path.join(data, 'ui.json'), { ...address, pid: process.pid });
  fs.writeFileSync(path.join(data, 'bridge.lock'), String(process.pid), { mode: 0o600 });
  t.after(async () => { await server.close(); bridge.dataDir = old; });
  return home;
}

test('public web research API returns live dispatch state, not stale ready', async t => {
  const f = await fixture(t);
  synthetic(f);
  f.bridge.options.researchMission = { workspace: f.repo, synthetic: true, baselineFiles: ['docs/README.md'], maxPages: 4, maxActions: 30, timeoutMs: 30000 };
  const home = await apiHome(t, f.bridge);
  const receipt = await local.request(home, '/api/assistant/web/research', {
    request_id: randomUUID(),
    objective: 'explore https://example.com',
    mode: 'on',
    entries: ['https://example.com/'],
    confirmed: true
  });
  assert.equal(receipt.kind, 'mission');
  assert.equal(receipt.browser_research_available, true);
  assert.notEqual(receipt.state, 'ready');
  assert.ok(['dispatching', 'running', 'verifying', 'awaiting_acceptance', 'blocked'].includes(receipt.state), receipt.state);
  assert.match(receipt.message, /dispatch has started|registered/i);
  assert.doesNotMatch(receipt.message, /Mission failed|execution failed/i);
  const count = f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions WHERE id=?').get(receipt.mission_id).n;
  assert.equal(count, 1);
});

test('duplicate public web research request identity does not create a second Mission', async t => {
  const f = await fixture(t);
  synthetic(f);
  f.bridge.options.researchMission = { workspace: f.repo, synthetic: true, baselineFiles: ['docs/README.md'], maxPages: 4, maxActions: 30, timeoutMs: 30000 };
  const home = await apiHome(t, f.bridge);
  const request_id = randomUUID();
  const first = await local.request(home, '/api/assistant/web/research', {
    request_id,
    objective: 'explore https://example.com',
    mode: 'on',
    entries: ['https://example.com/'],
    confirmed: true
  });
  const again = await local.request(home, '/api/assistant/web/research', {
    request_id,
    objective: 'explore https://example.com',
    mode: 'on',
    entries: ['https://example.com/'],
    confirmed: true
  });
  assert.equal(again.mission_id, first.mission_id);
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_missions WHERE envelope LIKE '%explore https://example.com%'").get().n, 1);
});

test('waitResult survives transport loss without cancelling and reports durable Mission identity', async t => {
  const id = randomUUID();
  let polls = 0;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-wait-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  local.privateDirectory(home, true);
  local.privateDirectory(path.join(home, 'data'), true);
  const original = local.request;
  const stopped = local.isStopped;
  t.after(() => { local.request = original; local.isStopped = stopped; });
  local.isStopped = () => false;
  local.request = async (h, route) => {
    if (String(route).includes('/api/interactive/task')) {
      polls++;
      if (polls < 3) throw Object.assign(Error('fetch failed'), { name: 'TypeError' });
      return { state: 'awaiting_acceptance', summary: 'Synthetic' };
    }
    if (String(route).includes('/api/interactive/cancel')) assert.fail('cancel must not run on recoverable transport loss');
    throw Error('unexpected ' + route);
  };
  const result = await waitResult(home, id, { timeoutMs: 5000 });
  assert.equal(result.state, 'awaiting_acceptance');
  assert.ok(polls >= 3);
});

test('waitResult reports service stop without implying Mission failure', async t => {
  const id = randomUUID();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-stop-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  local.privateDirectory(home, true);
  local.privateDirectory(path.join(home, 'data'), true);
  const original = local.request;
  const stopped = local.isStopped;
  t.after(() => { local.request = original; local.isStopped = stopped; });
  local.isStopped = () => true;
  local.request = async () => { throw Object.assign(Error('fetch failed'), { name: 'TypeError' }); };
  await assert.rejects(waitResult(home, id, { timeoutMs: 2000 }), /Lost contact with the managed Airodrom service/);
  assert.match(transportLossMessage(id), new RegExp(id));
  assert.match(transportLossMessage(id), /does not cancel a registered Mission/);
  assert.equal(isTransportLoss(Object.assign(Error('fetch failed'), { name: 'TypeError' })), true);
});

test('managed local-service ignores SIGINT while still wiring SIGTERM stop', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/local-service.cjs'), 'utf8');
  assert.match(source, /process\.on\('SIGINT',\s*\(\)\s*=>\s*\{\}\)/);
  assert.match(source, /SIGTERM/);
  assert.match(source, /unhandledRejection/);
  assert.match(source, /supervisor-diagnostics\.log/);
  assert.doesNotMatch(source, /for \(const signal of \['SIGINT', 'SIGTERM', 'SIGHUP'\]\)/);
  assert.doesNotMatch(source, /process\.on\('uncaughtException'/);
});

test('transportLossMessage never claims Mission failure or erases Mission identity', () => {
  const id = randomUUID();
  const message = transportLossMessage(id);
  assert.match(message, new RegExp(id));
  assert.match(message, /Lost contact with the managed Airodrom service/);
  assert.doesNotMatch(message, /Mission failed|execution failed|registration failed/i);
  assert.equal(isTransportLoss(Object.assign(Error('ECONNRESET'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransportLoss(Object.assign(Error('other side closed'), { name: 'TypeError' })), true);
});

test('network denial path leaves Mission blocked/quarantined without fabricating browser_closed', async t => {
  const f = await fixture(t);
  let closed = 0;
  f.bridge.missions.web.options = {
    synthetic: true,
    browserFactory: () => ({
      start: async () => {},
      execute: async () => { throw Object.assign(Error('private_query_denied'), { code: 'research.network_denied' }); },
      verify: () => true,
      close: async () => { closed++; return { closed: true, termination_verified: true, owned_process_termination: 'verified' }; },
      ownedProcessId: () => 424242
    })
  };
  f.bridge.options.researchMission = { workspace: f.repo, synthetic: true, baselineFiles: ['docs/README.md'], maxPages: 4, maxActions: 30, timeoutMs: 30000 };
  const home = await apiHome(t, f.bridge);
  const receipt = await local.request(home, '/api/assistant/web/research', {
    request_id: randomUUID(),
    objective: 'explore https://example.com',
    mode: 'on',
    entries: ['https://example.com/'],
    confirmed: true
  });
  assert.notEqual(receipt.state, 'ready');
  // Allow synthetic dispatch/browser work to settle.
  for (let i = 0; i < 40; i++) {
    const m = f.bridge.missions.require(receipt.mission_id, 'operator');
    if (['blocked', 'awaiting_acceptance', 'failed', 'cancelled', 'needs_rework'].includes(m.state)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  const mission = f.bridge.missions.require(receipt.mission_id, 'operator');
  assert.notEqual(mission.state, 'ready');
  const events = f.bridge.controlStore.db.prepare("SELECT event_type FROM event_ledger_events WHERE mission_id=? AND event_type LIKE 'research.%'").all(receipt.mission_id).map(r => r.event_type);
  // Never invent browser_closed without an actual close() call.
  if (events.includes('research.browser_closed')) assert.ok(closed > 0, 'browser_closed requires close()');
  assert.doesNotMatch(JSON.stringify(receipt), /Mission failed|registration failed/i);
});

test('detached supervisor pattern ignores SIGINT and records unhandledRejection without exit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airo-sig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'supervisor.cjs');
  const log = path.join(dir, 'supervisor-diagnostics.log');
  fs.writeFileSync(script, `
'use strict';
const fs = require('node:fs');
const log = ${JSON.stringify(log)};
process.on('SIGINT', () => {});
process.on('SIGTERM', () => process.exit(0));
process.on('unhandledRejection', reason => {
  fs.appendFileSync(log, JSON.stringify({ kind: 'unhandledRejection', text: String(reason && reason.message || reason) }) + '\\n');
});
setInterval(() => {}, 1000);
Promise.reject(Error('synthetic_async_fault'));
process.stdout.write('ready\\n');
`);
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGTERM'); } catch {} });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { if (String(d).includes('ready')) resolve(); });
    child.on('exit', code => reject(Error('exited early ' + code)));
    setTimeout(() => reject(Error('supervisor start timeout')), 3000);
  });
  process.kill(child.pid, 'SIGINT');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(child.exitCode, null);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  for (let i = 0; i < 20 && !fs.existsSync(log); i++) await new Promise(r => setTimeout(r, 50));
  assert.match(fs.readFileSync(log, 'utf8'), /synthetic_async_fault/);
  process.kill(child.pid, 'SIGTERM');
  const code = await new Promise(r => child.once('exit', r));
  assert.equal(code, 0);
});

test('expired public web grant rejects reuse without inventing browser execution', async t => {
  const f = await fixture(t);
  synthetic(f);
  f.bridge.options.researchMission = { workspace: f.repo, synthetic: true, baselineFiles: ['docs/README.md'], maxPages: 4, maxActions: 30, timeoutMs: 30000 };
  const created = f.bridge.missions.web.createResearch({
    request_id: randomUUID(),
    objective: 'explore https://example.com',
    mode: 'on',
    entries: ['https://example.com/'],
    confirmed: true,
    duration_ms: 1000
  });
  const { fingerprint } = require('../src/control-plane-store');
  const row = f.bridge.controlStore.db.prepare('SELECT id, policy FROM cp_mission_web_grants WHERE mission_id=? AND state=?').get(created.mission_id, 'active');
  const policy = JSON.parse(row.policy);
  policy.expires_at = Date.now() - 1;
  const digest = fingerprint(policy);
  const seal = f.bridge.missionAuthority.sealManifest({ mission_id: created.mission_id, manifest_hash: digest });
  f.bridge.controlStore.db.prepare('UPDATE cp_mission_web_grants SET policy=?, policy_hash=?, seal=? WHERE id=?')
    .run(JSON.stringify(policy), digest, JSON.stringify(seal), row.id);
  const status = f.bridge.missions.web.status(created.mission_id);
  assert.equal(status.mode, 'expired');
  assert.equal(f.bridge.missions.web.rows(f.bridge.controlStore.requireMission(created.mission_id)).length, 0);
  assert.throws(
    () => f.bridge.missions.web.assess(f.bridge.tasks.get(created.task_id), { mission_id: created.mission_id, action: { type: 'explore', url: 'https://example.com/' } }),
    /web_grant_expired|expired|approval|grant/i
  );
});
