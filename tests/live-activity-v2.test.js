'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const board = require('../src/live-activity-board');
const observatory = require('../src/live-observatory');
const display = require('../src/product-observability');

const url = (q = '') => new URL('http://localhost/api/product/live-activity?' + q);

test('Now stays empty without active Missions and never fills with historical events', async t => {
  const f = await fixture(t), b = f.bridge;
  const done = f.create({ objective: 'Historical completed fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='completed' WHERE id=?").run(done.id);
  b.controlStore.event('mission.completed', done.id, { authority: false });

  const now = board.liveActivityBoard(b, url('tab=now'));
  assert.equal(now.version, 2);
  assert.equal(now.tab, 'now');
  assert.equal(now.now.empty, true);
  assert.equal(now.now.message, 'No active work.');
  assert.equal(now.now.missions.length, 0);
  assert.ok(now.recent.missions.some(m => m.id === done.id) || now.history.missions.some(m => m.id === done.id));
});

test('Active Missions appear in Now with grouped summary and workflow timeline', async t => {
  const f = await fixture(t), b = f.bridge;
  const m = f.create({ objective: 'Live Activity active fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='running' WHERE id=?").run(m.id);
  observatory.record(b, { eventType: 'capability.requested', missionId: m.id, metadata: { tool: 'read' } });
  observatory.record(b, { eventType: 'capability.completed', missionId: m.id, metadata: { tool: 'read' } });
  observatory.record(b, {
    eventType: 'fs.file_modified',
    missionId: m.id,
    metadata: { path: 'fixture.txt', writer_class: 'SAVED_FILE_CHANGE', lines_added: 2, lines_removed: 1 }
  });

  const now = board.liveActivityBoard(b, url('tab=now'));
  assert.equal(now.now.empty, false);
  assert.equal(now.now.missions.length, 1);
  const card = now.now.missions[0];
  assert.equal(card.id, m.id);
  assert.match(card.grouping.detail || '', /capability/);
  assert.match(card.grouping.detail || '', /saved-file/);
  assert.equal(card.changed_file_count, 1);
  assert.equal(card.changed_files[0].writer_class, 'SAVED_FILE_CHANGE');
  assert.equal(card.changed_files[0].lines_added, 2);
  assert.ok(Array.isArray(card.timeline));
  assert.equal(card.timeline.length, 7);
  assert.equal(card.timeline.some(s => s.name === 'Execution'), true);
});

test('Attention inbox excludes conversation unread results', async t => {
  const f = await fixture(t), b = f.bridge;
  const coding = f.create({ objective: 'Coding attention fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance' WHERE id=?").run(coding.id);
  const conv = f.create({ objective: 'Conversation unread fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance', envelope=json_set(envelope,'$.kind','conversation') WHERE id=?").run(conv.id);

  const now = board.liveActivityBoard(b, url('tab=now'));
  assert.equal(now.attention.some(a => a.mission_id === coding.id), true);
  assert.equal(now.attention.some(a => a.mission_id === conv.id), false);
  assert.equal(display.missionCounts(b)['Needs Attention'] >= 1, true);
});

test('History preserves technical events while Now hides the raw dump', async t => {
  const f = await fixture(t), b = f.bridge;
  const m = f.create({ objective: 'Technical history fixture' });
  for (let i = 0; i < 3; i++) {
    observatory.record(b, { eventType: 'capability.requested', missionId: m.id, metadata: { tool: 'read', n: i } });
    observatory.record(b, { eventType: 'capability.completed', missionId: m.id, metadata: { tool: 'read', n: i } });
  }
  const now = board.liveActivityBoard(b, url('tab=now'));
  assert.equal(now.history.technical_events.length, 0, 'Now response does not stream technical dump by default');
  const history = board.liveActivityBoard(b, url('tab=history&technical=1&mission=' + m.id));
  assert.ok(history.history.technical_events.length >= 3);
  assert.ok(history.history.missions.some(card => card.id === m.id));
});

test('Control Hub Live Activity markup uses V2 tabs and empty-now copy', () => {
  const hub = fs.readFileSync(path.join(__dirname, '../public/control-hub.js'), 'utf8');
  assert.match(hub, /live-activity-v2/);
  assert.match(hub, /\['now','Now'\],\['recent','Recent'\],\['history','History'\]/);
  assert.match(hub, /No active work\./);
  assert.match(hub, /Technical events/);
  assert.match(hub, /\/api\/product\/live-activity/);
  assert.doesNotMatch(hub, /function liveActivityView\(\)\{\s*const root=node\('div',null,'observatory live-activity'\)/);
});

test('OpenCode readiness alone does not invent active workers', async t => {
  const f = await fixture(t), b = f.bridge;
  const ready = f.create({ objective: 'Ready but idle fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='ready' WHERE id=?").run(ready.id);
  const now = board.liveActivityBoard(b, url('tab=now'));
  assert.equal(now.now.workers.length, 0);
  assert.equal(now.now.missions.some(m => m.id === ready.id), false);
});
