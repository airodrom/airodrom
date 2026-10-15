'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');

async function setup(t) {
  const f = await fixture(t, { opencode: runtime(t).options });
  f.bridge.missionAuthority.initializeOperatorKey();
  return f;
}

test('Autopilot defaults OFF and rejects untrusted / unconfirmed enable', async t => {
  const f = await setup(t);
  const ap = f.bridge.globalAutopilot;
  assert.equal(ap.enabled(), false);
  assert.equal(ap.status('operator').defaults_off, true);
  assert.throws(() => ap.enable({ confirmed: true, request_id: randomUUID() }, 'mcp:fixture'), /operator|owner/i);
  assert.throws(() => ap.enable({ confirmed: false, request_id: randomUUID() }, 'operator'), /confirmation/i);
  assert.throws(() => ap.enable({ confirmed: true, request_id: randomUUID() }, 'browser'), /operator|owner/i);
  assert.equal(ap.enabled(), false);
});

test('owner ON then OFF revokes; Autopilot Missions fail closed when OFF', async t => {
  const f = await setup(t);
  const ap = f.bridge.globalAutopilot;
  const on = ap.enable({ confirmed: true, request_id: randomUUID() }, 'operator');
  assert.equal(on.enabled, true);
  assert.equal(ap.enabled(), true);
  // Tagged mission while ON is allowed through assertMission
  ap.assertMission({ envelope: { autopilot: true } });
  ap.disable({ confirmed: true, request_id: randomUUID() }, 'operator');
  assert.equal(ap.enabled(), false);
  assert.throws(() => ap.assertMission({ envelope: { autopilot: true } }), /OFF/i);
  assert.doesNotThrow(() => ap.assertMission({ envelope: {} }));
});

test('emergency STOP fails closed and records activity without secrets', async t => {
  const f = await setup(t);
  const ap = f.bridge.globalAutopilot;
  ap.enable({ confirmed: true, request_id: randomUUID() }, 'operator');
  ap.record({
    kind: 'tool',
    summary: 'Ran fixture tool',
    tool: 'fixture.edit',
    project_id: 'proj',
    repository: f.repo,
    verification: 'passed',
    actor: 'operator'
  });
  const stopped = ap.stop({ confirmed: true, request_id: randomUUID() }, 'operator');
  assert.equal(stopped.enabled, false);
  assert.ok(stopped.stop_count >= 1);
  const items = ap.activity(10);
  assert.ok(items.some(i => i.kind === 'stopped' || i.kind === 'enabled'));
  const blob = JSON.stringify(items);
  assert.equal(/sk-[a-zA-Z0-9]{10,}|password\s*=|Bearer\s+[A-Za-z0-9._-]+/.test(blob), false);
});

test('control-server Autopilot routes require operator confirmation', async t => {
  const f = await setup(t);
  const ControlServer = require('../src/control-server');
  const ui = new ControlServer(f.bridge, { port: 0 });
  await ui.start();
  t.after(() => ui.close());
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + ui.token,
    origin: ui.origin
  };
  const status = await fetch(ui.origin + '/api/assistant/autopilot', { headers }).then(r => r.json());
  assert.equal(status.enabled, false);
  const bad = await fetch(ui.origin + '/api/assistant/autopilot/enable', {
    method: 'POST', headers, body: JSON.stringify({ confirmed: false, request_id: randomUUID() })
  });
  assert.ok(bad.status >= 400);
  const ok = await fetch(ui.origin + '/api/assistant/autopilot/enable', {
    method: 'POST', headers, body: JSON.stringify({ confirmed: true, request_id: randomUUID() })
  }).then(r => r.json());
  assert.equal(ok.enabled, true);
  const off = await fetch(ui.origin + '/api/assistant/autopilot/disable', {
    method: 'POST', headers, body: JSON.stringify({ confirmed: true, request_id: randomUUID() })
  }).then(r => r.json());
  assert.equal(off.enabled, false);
});
