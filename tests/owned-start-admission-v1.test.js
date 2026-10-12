'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { EventLedger } = require('../src/event-ledger');
const { ControlPlaneStore } = require('../src/control-plane-store');
const { ServiceLifecycle } = require('../src/service-lifecycle');

function gateFixture(t, { startClosed = false, seedOpen = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE project_missions(mission_id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER)');
  const store = new ControlPlaneStore({ db, ledger: new EventLedger(db) });
  const bridge = { controlStore: store, leases: { size: 0 }, startClosed };
  const gate = new ServiceLifecycle(bridge);
  bridge.lifecycle = gate;
  store.lifecycle = gate;
  t.after(() => db.close());
  if (seedOpen) {
    gate.finishRecovery();
    if (gate.state() !== 'open') gate.resume(gate.epoch);
  }
  return { db, store, bridge, gate };
}

test('prior stopping reports awaiting_owned_start_resume and stays booting until resume', t => {
  const { bridge, store, gate } = gateFixture(t);
  gate.drain();
  gate.prepareStop();
  assert.equal(gate.state(), 'stopping');
  const next = new ServiceLifecycle(bridge);
  store.lifecycle = next;
  store.recover();
  next.finishRecovery();
  assert.equal(next.state(), 'booting');
  assert.equal(next.autoOpen, false);
  assert.equal(next.priorState, 'stopping');
  assert.equal(next.status().hold_reason, 'awaiting_owned_start_resume');
  assert.equal(next.status().idle, true);
  assert.equal(next.status().reconciled, true);
  assert.equal(next.resume(next.epoch).state, 'open');
  assert.equal(next.status().hold_reason, null);
});

test('previously open epoch still auto-opens after recovery when idle', t => {
  const { bridge, store } = gateFixture(t);
  const next = new ServiceLifecycle(bridge);
  store.lifecycle = next;
  assert.equal(next.autoOpen, true);
  assert.equal(next.state(), 'booting');
  next.finishRecovery();
  assert.equal(next.state(), 'open');
  assert.equal(next.status().hold_reason, null);
});

test('closed startup never auto-opens and reports closed_startup hold', t => {
  const { bridge, store, gate } = gateFixture(t);
  gate.drain();
  gate.prepareStop();
  bridge.startClosed = true;
  const next = new ServiceLifecycle(bridge);
  store.lifecycle = next;
  store.recover();
  next.finishRecovery();
  assert.equal(next.state(), 'booting');
  assert.equal(next.autoOpen, false);
  assert.equal(next.status().hold_reason, 'closed_startup');
  // Authenticated operator resume remains available; owned local.start must not auto-resume.
  assert.equal(next.resume(next.epoch).state, 'open');
});

test('unresolved blockers remain fail-closed with hold_reason', t => {
  const { store, bridge, gate } = gateFixture(t);
  store.startRun({ id: 'r', taskId: 't' });
  gate.drain();
  const next = new ServiceLifecycle(bridge);
  store.lifecycle = next;
  store.recover();
  next.finishRecovery();
  assert.equal(next.state(), 'booting');
  assert.equal(next.status().hold_reason, 'unresolved_blockers');
  assert.throws(() => next.resume(next.epoch), /unresolved/);
});

test('ownedStartResume opens idle booting admission and leaves closed_startup closed', async t => {
  const local = require('../src/local-bootstrap');
  const calls = { resume: 0, status: 0, lifecycle: 0 };
  const fake = {
    async status() {
      calls.status++;
      return { healthy: true, admission: calls.resume ? 'open' : 'booting' };
    },
    async request(_home, route) {
      if (route === '/api/interactive/lifecycle') {
        calls.lifecycle++;
        return {
          state: calls.resume ? 'open' : 'booting',
          reconciled: true,
          idle: true,
          closed_startup: false,
          hold_reason: calls.resume ? null : 'awaiting_owned_start_resume'
        };
      }
      if (route === '/api/interactive/resume-admission') {
        calls.resume++;
        return { state: 'open', reconciled: true, idle: true, hold_reason: null };
      }
      throw Error('unexpected route ' + route);
    },
    async admission(_home, action) {
      if (action !== 'resume') throw Error('expected resume');
      return fake.request(_home, '/api/interactive/resume-admission', {});
    }
  };
  const original = {
    status: local.status,
    request: local.request,
    admission: local.admission
  };
  local.status = fake.status;
  local.request = fake.request;
  local.admission = fake.admission;
  t.after(() => {
    local.status = original.status;
    local.request = original.request;
    local.admission = original.admission;
  });
  const opened = await local.ownedStartResume('/synthetic-home', { timeoutMs: 2000 });
  assert.equal(opened.admission, 'open');
  assert.equal(calls.resume, 1);

  calls.resume = 0;
  fake.request = async (_home, route) => {
    if (route === '/api/interactive/lifecycle') {
      return { state: 'booting', reconciled: true, idle: true, closed_startup: true, hold_reason: 'closed_startup' };
    }
    throw Error('resume must not run for closed startup');
  };
  local.request = fake.request;
  local.status = async () => ({ healthy: true, admission: 'booting' });
  const closed = await local.ownedStartResume('/synthetic-home', { timeoutMs: 500 });
  assert.equal(closed.admission, 'booting');
  assert.equal(calls.resume, 0);
});

test('ownedStartResume does not reopen an active drain', async t => {
  const local = require('../src/local-bootstrap');
  const original = { status: local.status, request: local.request, admission: local.admission };
  let resumes = 0;
  local.status = async () => ({ healthy: true, admission: 'draining' });
  local.request = async () => ({ state: 'draining', reconciled: true, idle: true, closed_startup: false });
  local.admission = async () => { resumes++; throw Error('resume must not run during drain'); };
  t.after(() => {
    local.status = original.status;
    local.request = original.request;
    local.admission = original.admission;
  });
  const left = await local.ownedStartResume('/synthetic-home', { timeoutMs: 500 });
  assert.equal(left.admission, 'draining');
  assert.equal(resumes, 0);
});

test('ownedStartResume throws when idle reconciled resume never opens', async t => {
  const local = require('../src/local-bootstrap');
  const original = { status: local.status, request: local.request, admission: local.admission };
  local.status = async () => ({ healthy: true, admission: 'booting' });
  local.request = async (_home, route) => {
    if (route === '/api/interactive/lifecycle') {
      return { state: 'booting', reconciled: true, idle: true, closed_startup: false, hold_reason: 'awaiting_owned_start_resume' };
    }
    throw Error('synthetic resume denied');
  };
  local.admission = async () => { throw Error('synthetic resume denied'); };
  t.after(() => {
    local.status = original.status;
    local.request = original.request;
    local.admission = original.admission;
  });
  await assert.rejects(() => local.ownedStartResume('/synthetic-home', { timeoutMs: 400 }), /could not reopen admission/);
});

test('real disposable Bridge: stopping prior state requires authenticated resume after recovery', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const Bridge = require('../src/bridge-controller');
  const ControlServer = require('../src/control-server');
  const dir = fs.mkdtempSync('/private/tmp/ad-owned-start-');
  const data = path.join(dir, 'data');
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'settings.json'), '{}');
  let bridge, server;
  const boot = async () => {
    bridge = await new Bridge({ dataDir: data, sourceProfile: profile, webEnabled: false, slack: { env: {} } }).initialize();
    server = new ControlServer(bridge, { port: 0, mcpToken: 'a'.repeat(64) });
    server.localShutdown = async () => {};
    await server.start();
  };
  const call = async (route, body) => {
    const r = await fetch(server.origin + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: r.status, body: await r.json() };
  };
  t.after(async () => {
    await server?.close();
    await bridge?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await boot();
  assert.equal(bridge.lifecycle.state(), 'booting');
  assert.equal((await call('/api/interactive/resume-admission', { epoch: bridge.lifecycle.epoch })).body.state, 'open');
  assert.equal((await call('/api/interactive/drain', {})).body.state, 'draining');
  bridge.lifecycle.prepareStop();
  await server.close();
  await bridge.shutdown();
  await boot();
  const gate = (await call('/api/interactive/lifecycle')).body;
  assert.equal(gate.state, 'booting');
  assert.equal(gate.prior_state, 'stopping');
  assert.equal(gate.reconciled, true);
  assert.equal(gate.idle, true);
  assert.equal(gate.hold_reason, 'awaiting_owned_start_resume');
  assert.equal((await call('/api/assistant/conversation', {})).status, 503);
  assert.equal((await call('/api/interactive/resume-admission', { epoch: bridge.lifecycle.epoch })).body.state, 'open');
  assert.notEqual((await call('/api/assistant/conversation', {})).status, 503);
});
