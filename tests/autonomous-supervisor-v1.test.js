'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const supervisor = require('../src/autonomous-supervisor');
const board = require('../src/live-activity-board');
const display = require('../src/product-observability');

const url = (q = '') => new URL('http://localhost/api/product/live-activity?' + q);

test('execution states map Mission views without inventing Runs', async t => {
  const f = await fixture(t), b = f.bridge;
  const m = f.create({ objective: 'Supervisor state fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(m.id);
  const view = display.missionView(b, b.missions.require(m.id));
  assert.equal(supervisor.executionState(view), 'RUNNING');
  assert.equal(supervisor.isLiveWork(b.missions.require(m.id), view), true);
  assert.equal(supervisor.activeRun(b, b.missions.require(m.id)), null);
  const card = board.liveActivityBoard(b, url('tab=now')).now.missions[0];
  assert.equal(card.execution_state, 'RUNNING');
  assert.equal(card.worker_active, false);
  assert.equal(card.active_run, null);
});

test('obsolete needs_rework stays out of Now and is session-classified', async t => {
  const f = await fixture(t), b = f.bridge;
  const m = f.create({ objective: 'Obsolete rework fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='needs_rework' WHERE id=?").run(m.id);
  const mission = b.missions.require(m.id);
  const view = display.missionView(b, mission);
  // Without authorized recovery, needs_rework is not live work.
  assert.equal(supervisor.isLiveWork(mission, view), false);
  const now = board.liveActivityBoard(b, url('tab=now'));
  assert.equal(now.now.missions.some(c => c.id === m.id), false);
  const sessions = supervisor.executionSessions(b);
  assert.ok(sessions.summary.obsolete_rework >= 1 || sessions.sessions.some(s => s.mission_id === m.id));
  assert.equal(sessions.summary.active_agent_runs, 0);
  assert.match(sessions.summary.note, /not Runs/);
});

test('AUTO worker admission prefers qualified local OpenCode and never invents Cursor Agent', async t => {
  const f = await fixture(t), b = f.bridge;
  const admission = supervisor.workerAdmission(b, { ready: true });
  assert.equal(admission.mode_default, 'AUTO');
  const cursor = admission.workers.find(w => w.id === 'cursor');
  assert.ok(cursor);
  assert.equal(cursor.qualification, 'unqualified');
  assert.equal(cursor.selectable_by_auto, false);
  assert.equal(cursor.editor_not_worker, true);
  const opencode = admission.workers.find(w => w.id === 'opencode');
  assert.ok(opencode);
  // Fixture bridges are not live-qualified; AUTO must wait rather than invent a route.
  if (opencode.qualification !== 'qualified' || !opencode.available) {
    assert.equal(admission.auto_route.state, 'WAIT');
  } else {
    assert.equal(admission.auto_route.worker, 'opencode');
  }
});

test('standing authorization surfaces work-template mechanism without granting authority', async t => {
  const f = await fixture(t), b = f.bridge;
  const standing = supervisor.standingAuthorization(b);
  assert.equal(standing.mechanism, 'work_templates');
  assert.equal(standing.authority, false);
  assert.ok(standing.never_auto.includes('production_deployments'));
  assert.ok(standing.routine_within_scope.includes('local_tests'));
});

test('CLI live-logs help and package surface include supervisor artifacts', () => {
  const help = require('../scripts/live-logs.cjs').help();
  assert.match(help, /airodrom logs follow/);
  assert.match(help, /never prints credentials/i);
  const hub = fs.readFileSync(path.join(__dirname, '../public/control-hub.js'), 'utf8');
  assert.match(hub, /execution_state/);
  assert.match(hub, /archive-obsolete-rework/);
  const cli = fs.readFileSync(path.join(__dirname, '../src/interactive-cli.js'), 'utf8');
  assert.match(cli, /logs follow/);
  assert.match(cli, /command === 'logs'/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(pkg.files.includes('src/autonomous-supervisor.js'));
  assert.ok(pkg.files.includes('scripts/live-logs.cjs'));
});

test('execution-sessions API path is registered on ControlServer', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/control-server.js'), 'utf8');
  assert.match(src, /\/api\/product\/execution-sessions/);
  assert.match(src, /archive-obsolete-rework-preview/);
});
