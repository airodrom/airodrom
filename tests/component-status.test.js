'use strict';
// ADR 0051: operational component states and worker tiers are derived from host observations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { componentStatus, STATES } = require('../src/component-status');
const { CursorWorker } = require('../src/cursor-worker');
const path = require('node:path');

test('component status uses the fixed vocabulary and never reports READY from installation alone', async t => {
  const f = await fixture(t);
  f.bridge.cursorWorker.readiness = async () => ({installed:false,ready:false,available:false,availability:'unavailable',reason:'fixture_worker_unavailable',tiers:{authenticated:false,qualified:false}});
  const status = await componentStatus(f.bridge);
  for (const c of Object.values(status.components)) assert.ok(STATES.includes(c.state), c.state);
  assert.equal(status.components.airodrom_service.state, 'READY');
  assert.equal(status.components.goal_planner.state, 'READY');
  assert.equal(status.components.verifier.state, 'READY');
  assert.equal(status.components.mission_store.state, 'READY');
  assert.equal(status.components.slack_notifications.state, 'UNAVAILABLE', 'no Slack configured in the fixture');
  // Cursor without a sandbox-reachable credential is BLOCKED (installed) or UNAVAILABLE, with the owner step, never READY.
  assert.ok(['BLOCKED', 'UNAVAILABLE'].includes(status.workers.cursor.state), status.workers.cursor.state);
  assert.notEqual(status.workers.cursor.tiers?.qualified, true);
  if (status.workers.cursor.state === 'BLOCKED') assert.match(status.workers.cursor.owner_step || '', /AGENT_CLI_CREDENTIAL_STORE=file agent login|API key/);
  assert.equal(status.workers.cursor.cost, 'UNKNOWN_SUBSCRIPTION');
  assert.deepEqual(Object.keys(status.workers.opencode.tiers || {}), ['installed', 'authenticated', 'qualified', 'available', 'executing', 'verified']);
  // With the governed fixture worker ready, Cursor reports READY and its tiers are explicit.
  f.bridge.cursorWorker = new CursorWorker(f.bridge, { fixtureExecutable: path.join(__dirname, 'fixtures/cursor-agent-fixture.cjs') });
  const ready = await componentStatus(f.bridge);
  assert.equal(ready.workers.cursor.state, 'READY');
  assert.equal(ready.workers.cursor.tiers.verified, false, 'no verified runs yet; READY does not imply verified');
  assert.ok(ready.audit_events && typeof ready.audit_events['goal.autonomous.repair_created'] === 'number');
  // Quarantine blocks the scheduler and verifier states.
  f.bridge.controlStore.db.prepare("INSERT INTO cp_leases(id,resource,run_id,mission_id,mode,state,acquired_at,expires_at,baseline) VALUES('q1','/x','r1',NULL,'write','quarantined',1,2,'{}')").run();
  const blocked = await componentStatus(f.bridge, { probeWorkers: false });
  assert.equal(blocked.components.cae_scheduler.state, 'BLOCKED');
  assert.equal(blocked.components.verifier.state, 'BLOCKED');
});
