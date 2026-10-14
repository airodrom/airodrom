'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const display = require('../src/product-observability');
const visibility = require('../src/mission-visibility');
const observatory = require('../src/live-observatory');
const { createWorkspaceActivityWatch, safeRel, classifyWriter } = require('../src/workspace-activity-watch');

const url = q => new URL('http://localhost/api/product/missions?' + q);

test('Needs Attention excludes conversation unread results', async t => {
  const f = await fixture(t), b = f.bridge;
  const coding = f.create({ objective: 'Coding review fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance' WHERE id=?").run(coding.id);
  const conv = f.create({ objective: 'Conversation unread fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance', envelope=json_set(envelope,'$.kind','conversation') WHERE id=?").run(conv.id);
  const waiting = f.create({ objective: 'Operator wait fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='waiting_for_operator' WHERE id=?").run(waiting.id);

  const counts = display.missionCounts(b);
  assert.equal(counts['Needs Attention'], 2, 'coding awaiting + waiting_for_operator');
  assert.equal(counts['Unread Results'], 1);
  assert.equal(counts['Awaiting Review'], 2);
  assert.equal(display.missionHistory(b, url('filter=Unread%20Results')).missions[0].id, conv.id);
  assert.equal(display.missionHistory(b, url('filter=' + encodeURIComponent('Needs Attention'))).missions.some(m => m.id === conv.id), false);

  const view = display.missionView(b, b.missions.require(conv.id, 'operator'));
  assert.equal(view.kind, 'conversation');
  assert.equal(view.display.key, 'unread_result');
  assert.equal(view.outcome.kind, 'result');
  assert.equal(display.ownerAttentionRequired(b.missions.require(conv.id, 'operator'), view), false);

  const native = await display.nativeStatus(b);
  assert.equal(native.review_missions, 2);
  assert.equal(native.unread_results, 1);
});

test('historical conversation results can be archived and restored without Acceptance', async t => {
  const f = await fixture(t), b = f.bridge;
  const conv = f.create({ objective: 'Archive conversation fixture' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance', envelope=json_set(envelope,'$.kind','conversation') WHERE id=?").run(conv.id);
  const research = f.create({ objective: 'Keep research review' });
  b.controlStore.db.prepare("UPDATE cp_missions SET state='awaiting_acceptance', envelope=json_set(envelope,'$.kind','browser_research') WHERE id=?").run(research.id);

  assert.equal(visibility.isHistoricalConversationResult(b.missions.require(conv.id, 'operator')), true);
  assert.equal(visibility.archiveEligible(b.missions.require(conv.id, 'operator'), b), true);
  assert.equal(visibility.organizeEligible(b.missions.require(conv.id, 'operator'), b), true);
  assert.equal(visibility.archiveEligible(b.missions.require(research.id, 'operator'), b), false);

  const preview = visibility.previewOrganize(b, {});
  assert.ok(preview.items.some(i => i.id === conv.id));
  assert.equal(preview.items.some(i => i.id === research.id), false);
  const archived = visibility.organizeHistory(b, {
    preview_id: preview.preview_id,
    digest: preview.digest,
    confirmed: true,
    request_id: require('node:crypto').randomUUID(),
    reason: 'control_center_restore_v1'
  });
  assert.ok(archived.archived.includes(conv.id));
  assert.equal(b.missions.require(conv.id, 'operator').state, 'awaiting_acceptance', 'presentation archive never mutates state');
  assert.equal(display.missionHistory(b, url('filter=Archived')).missions.some(m => m.id === conv.id), true);
  visibility.restoreMission(b, { id: conv.id, confirmed: true, request_id: require('node:crypto').randomUUID() });
  assert.equal(display.missionHistory(b, url('filter=Unread%20Results')).missions.some(m => m.id === conv.id), true);
});

test('workspace watcher records saved-file changes without inventing authorship', async t => {
  const f = await fixture(t), b = f.bridge;
  const watchRoot = f.repo;
  const mission = f.create({ objective: 'Watch boundary fixture' });
  const watch = createWorkspaceActivityWatch(b);
  t.after(() => watch.stop());
  b.hostRepoRoot = watchRoot;
  watch.start();
  assert.equal(safeRel('../escape'), null);
  assert.equal(safeRel('fixture.txt'), 'fixture.txt');
  const writer = classifyWriter(b, watchRoot, 'fixture.txt');
  assert.equal(writer.writer_class, 'SAVED_FILE_CHANGE');
  observatory.record(b, {
    eventType: 'fs.file_modified',
    missionId: null,
    metadata: { path: 'docs/watch-demo.md', writer_class: 'SAVED_FILE_CHANGE', project: 'repo', branch: 'main', lines_added: 1, lines_removed: 0 }
  });
  const batch = observatory.liveEvents(b, new URL('http://local/api/product/live-events?after=0&category=File'));
  assert.ok(batch.events.some(e => e.path === 'docs/watch-demo.md' && e.writer_class === 'SAVED_FILE_CHANGE'));
  const snap = observatory.snapshot(b, mission.id);
  assert.equal(snap.observation_boundary.unsaved_typing_observable, false);
  assert.equal(snap.observation_boundary.authorship_without_evidence, false);
  assert.equal(typeof watch.status().watched_roots, 'number');
});

test('OpenCode file observations mark OPENCODE_WRITE', async t => {
  const f = await fixture(t), b = f.bridge;
  const m = f.create();
  observatory.observeHostFileChanges(b, {
    missionId: m.id,
    runId: null,
    changes: [{ path: 'fixture.txt', op: 'modified', lines_added: 1, lines_removed: 0 }],
    agentId: 'opencode'
  });
  const events = observatory.liveEvents(b, new URL('http://local/api/product/live-events?after=0&category=File'));
  const hit = events.events.find(e => e.mission_id === m.id && e.path === 'fixture.txt');
  assert.ok(hit);
  assert.equal(hit.writer_class, 'OPENCODE_WRITE');
});

test('Control Center primary navigation is simplified', () => {
  const hub = fs.readFileSync(path.join(__dirname, '../public/control-hub.js'), 'utf8');
  assert.match(hub, /primaryViews=\['Overview','Live Activity','Missions','Workers','History','Settings'\]/);
  assert.match(hub, /function liveActivityView/);
  assert.match(hub, /Unread Results/);
  assert.match(hub, /connectGlobalLiveStream/);
});
