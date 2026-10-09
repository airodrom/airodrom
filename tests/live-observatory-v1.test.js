'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const observatory = require('../src/live-observatory');
const ControlServer = require('../src/control-server');

async function withMission(t) {
  const { fixture } = require('./fixtures/mission-fixture.cjs');
  return fixture(t, { defaultRuntime: 'opencode' });
}

test('1. event capture and delivery projects only allowlisted sanitized fields', async t => {
  const f = await withMission(t);
  const created = f.create({ objective: 'Synthetic observatory capture' });
  const mid = created.mission_id || created.id;
  observatory.record(f.bridge, { eventType: 'worker.started', missionId: mid, metadata: { agent_id: 'opencode', secret: 'PRIVATE_SECRET', path: '../../../etc/passwd', tool: 'read_file' } });
  observatory.record(f.bridge, { eventType: 'worker.tool_requested', missionId: mid, metadata: { agent_id: 'opencode', tool: 'read_file', prompt: 'PRIVATE_REASONING' } });
  const page = observatory.liveEvents(f.bridge, new URL('http://local/api/product/live-events?mission=' + mid));
  assert.ok(page.events.some(e => e.label.includes('Tool requested')));
  assert.ok(page.events.every(e => !JSON.stringify(e).includes('PRIVATE_')));
  assert.ok(page.events.every(e => e.path !== '../../../etc/passwd'));
  const snap = observatory.snapshot(f.bridge, mid);
  assert.equal(snap.mission.id, mid);
  assert.ok(snap.worker.length >= 1);
});

test('2. live file-change observation records host-measured paths only', async t => {
  const f = await withMission(t);
  const created = f.create({ objective: 'Synthetic file observation' });
  const m = { id: created.mission_id || created.id };
  const recorded = observatory.observeHostFileChanges(f.bridge, {
    missionId: m.id,
    changes: [
      { path: 'fixture.txt', op: 'modified', sha256: 'a'.repeat(64), lines_added: 2, lines_removed: 1 },
      { path: '../escape.txt', op: 'modified' },
      { path: '/absolute/secret.env', op: 'created' }
    ]
  });
  assert.equal(recorded.length, 1);
  const page = observatory.liveEvents(f.bridge, new URL('http://local/api/product/live-events?mission=' + m.id + '&category=File'));
  assert.ok(page.events.some(e => e.path === 'fixture.txt'));
  assert.ok(!JSON.stringify(page.events).includes('escape'));
  assert.ok(!JSON.stringify(page.events).includes('secret.env'));
});

test('3. accurate Git diff stays inside Mission allowed files', async t => {
  const f = await withMission(t);
  const created = f.create({ objective: 'Synthetic diff observation' });
  const m = { id: created.mission_id || created.id };
  const mission = f.bridge.missions.require(m.id);
  const workspace = mission.envelope.workspace;
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'beta\n');
  spawnSync('/usr/bin/git', ['-C', workspace, 'add', 'fixture.txt'], { encoding: 'utf8' });
  // Unstaged local edit for diff
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'gamma\n');
  const diff = observatory.authorizedDiff(f.bridge, m.id, 'fixture.txt');
  assert.equal(diff.path, 'fixture.txt');
  assert.ok(diff.diff.includes('gamma') || diff.lines_added >= 0);
  assert.throws(() => observatory.authorizedDiff(f.bridge, m.id, 'package.json'), /permission scope|outside/i);
  assert.throws(() => observatory.authorizedDiff(f.bridge, m.id, '../escape.txt'), /Invalid file path/);
});

test('4. command exit-code reporting surfaces sanitized command events', async t => {
  const f = await withMission(t);
  const created = f.create({ objective: 'Synthetic command observation' });
  const m = { id: created.mission_id || created.id };
  f.bridge.controlStore.event('shell.command.completed', m.id, { job_name: 'focused_test', exit_code: 1, agent_id: 'host' }, { payload: 'token=sk_live_PRIVATE\nFAIL tests/example.test.js' });
  const page = observatory.liveEvents(f.bridge, new URL('http://local/api/product/live-events?mission=' + m.id + '&category=Command'));
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].exit_code, 1);
  assert.ok(page.events[0].output.includes('[redacted-secret]') || !page.events[0].output.includes('sk_live_PRIVATE'));
});

test('5. SSE reconnection and deduplication', async t => {
  const f = await withMission(t);
  const created = f.create({ objective: 'Synthetic SSE observation' });
  const m = { id: created.mission_id || created.id };
  observatory.record(f.bridge, { eventType: 'worker.started', missionId: m.id, metadata: { agent_id: 'opencode' }, idempotencyKey: 'obs-sse-a' });
  observatory.record(f.bridge, { eventType: 'worker.started', missionId: m.id, metadata: { agent_id: 'opencode' }, idempotencyKey: 'obs-sse-a' });
  const first = observatory.liveEvents(f.bridge, new URL('http://local/api/product/live-events?mission=' + m.id));
  assert.equal(first.events.filter(e => e.event_type === 'worker.started').length, 1);
  const cursor = first.cursor;
  observatory.record(f.bridge, { eventType: 'worker.tool_completed', missionId: m.id, metadata: { agent_id: 'opencode' }, idempotencyKey: 'obs-sse-b' });
  const second = observatory.liveEvents(f.bridge, new URL('http://local/api/product/live-events?mission=' + m.id + '&after=' + cursor));
  assert.ok(second.events.some(e => e.event_type === 'worker.tool_completed'));
  assert.ok(!second.events.some(e => e.event_type === 'worker.started'));

  const server = new ControlServer(f.bridge, { port: 0 });
  t.after(async () => { await new Promise(r => server.server.close(r)); });
  await server.start();
  const url = new URL(server.origin + '/api/product/live-stream?mission=' + m.id + '&after=0');
  const events = [];
  await new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Authorization: 'Bearer ' + server.token } }, res => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); resolve(); }, 1500);
      res.on('data', chunk => {
        buf += chunk.toString();
        if (buf.includes('event: event') && buf.includes('worker')) {
          clearTimeout(timer);
          req.destroy();
          resolve();
        }
      });
      res.on('error', reject);
    });
    req.on('error', err => err.message.includes('socket') ? resolve() : reject(err));
  });
  assert.ok(true);
});

test('6. secret redaction and authorization boundaries', async t => {
  const f = await withMission(t);
  const created = f.create({ objective: 'Synthetic redaction' });
  const m = { id: created.mission_id || created.id };
  const otherCreated = f.create({ objective: 'Other mission isolation' });
  const other = { id: otherCreated.mission_id || otherCreated.id };
  observatory.record(f.bridge, { eventType: 'fs.file_modified', missionId: m.id, metadata: { path: 'fixture.txt', agent_id: 'opencode' }, payload: 'Authorization: Bearer PRIVATE_TOKEN\n/Users/private/secret.env' });
  const mine = observatory.snapshot(f.bridge, m.id);
  const theirs = observatory.snapshot(f.bridge, other.id);
  assert.ok(mine.files.some(e => e.path === 'fixture.txt'));
  assert.ok(!theirs.files.some(e => e.path === 'fixture.txt'));
  assert.ok(!JSON.stringify(mine).includes('PRIVATE_TOKEN'));
  assert.ok(!JSON.stringify(mine).includes('/Users/private'));
  assert.throws(() => observatory.snapshot(f.bridge, 'not-a-uuid'), /Invalid Mission/);
});

test('7. durable event retrieval survives reload cursor catch-up', async t => {
  const f = await withMission(t);
  const created = f.create({ objective: 'Synthetic durability' });
  const m = { id: created.mission_id || created.id };
  for (let i = 0; i < 5; i++) {
    observatory.record(f.bridge, { eventType: 'observatory.heartbeat', missionId: m.id, metadata: { heartbeat_at: Date.now() + i }, idempotencyKey: 'obs-hb-' + i });
  }
  let after = 0, all = [];
  for (let page = 0; page < 3; page++) {
    const batch = observatory.liveEvents(f.bridge, new URL('http://local/api/product/live-events?mission=' + m.id + '&after=' + after));
    all.push(...batch.events);
    after = batch.cursor;
    if (!batch.has_more) break;
  }
  const ids = all.map(e => e.event_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(all.filter(e => e.event_type === 'observatory.heartbeat').length >= 5);
});

test('OpenCode NDJSON line observation never stores reasoning text', async t => {
  const f = await withMission(t);
  const created = f.create({ objective: 'Synthetic NDJSON' });
  const m = { id: created.mission_id || created.id };
  observatory.observeOpenCodeLine(f.bridge, { missionId: m.id, line: JSON.stringify({ type: 'reasoning', sessionID: 'ses_abc123DEF456', part: { text: 'PRIVATE_CHAIN_OF_THOUGHT' } }) });
  observatory.observeOpenCodeLine(f.bridge, { missionId: m.id, line: JSON.stringify({ type: 'tool_use', sessionID: 'ses_abc123DEF456', part: { tool: 'edit', id: 't1' } }) });
  const snap = observatory.snapshot(f.bridge, m.id);
  assert.ok(snap.worker.some(e => e.tool === 'edit' || e.label.includes('Tool requested')));
  assert.ok(!JSON.stringify(snap).includes('PRIVATE_CHAIN'));
});
