'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ChatGPTEvents, redact, loadRoute, prepareIdentitySchema } = require('../src/chatgpt-events');
const Bridge = require('./fixtures/test-bridge.cjs');
const ControlServer = require('../src/control-server');
function task() { return { id: randomUUID(), sessionId: randomUUID(), latestMcpRequestId: randomUUID(), source: { transport: 'mcp' } }; }
function event(t, overrides = {}) { return { session_id: t.sessionId, request_id: t.latestMcpRequestId, event: { event_id: randomUUID(), event_type: 'result', summary: 'Acceptance checks passed', ...overrides } }; }
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  return new ChatGPTEvents(db, options);
}
const route = { trigger_id: 'agtch_fixture', access_token: 'fixture-secret' };
const accepted = () => new Response(JSON.stringify({ conversation_url: 'https://chatgpt.com/c/fixture' }), { status: 202 });
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Compatibility formula belongs only to legacy fixtures and the host migration.
function oldLifecycleId(t, type) {
  const hex = createHash('sha256').update(`${t.id}:${t.sessionId}:${t.latestMcpRequestId}:${type}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

test('host lifecycle uses opaque IDs and stored correlation through restart and acknowledgment', t => {
  const root = fs.mkdtempSync('/private/tmp/pi-lifecycle-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.sqlite'), a = task();
  let db = new DatabaseSync(file), q = new ChatGPTEvents(db);
  const first = q.publishLifecycle(a, 'completed');
  assert.match(first.event_id, UUID4);
  assert.notEqual(first.event_id, oldLifecycleId(a, 'completed'));
  assert.equal(q.publishLifecycle(a, 'completed').event_id, first.event_id);
  const relation = db.prepare('SELECT lifecycle_session_id,lifecycle_request_id,lifecycle_type FROM chatgpt_events').get();
  assert.deepEqual({ ...relation }, { lifecycle_session_id: a.sessionId, lifecycle_request_id: a.latestMcpRequestId, lifecycle_type: 'completed' });
  q.acknowledge(a.id, first.event_id); db.close();
  db = new DatabaseSync(file); q = new ChatGPTEvents(db);
  try {
    const replay = q.publishLifecycle(a, 'completed');
    assert.equal(replay.duplicate, true); assert.equal(replay.event_id, first.event_id);
    assert.equal(q.list(a.id).events.length, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM chatgpt_events').get().n, 1);
  } finally { db.close(); }
});

test('lifecycle correlation partitions task, session, request and event type without a digest identity', t => {
  const q = fixture(t), other = fixture(t), a = task();
  const first = q.publishLifecycle(a, 'status');
  assert.notEqual(other.publishLifecycle(a, 'status').event_id, first.event_id, 'independent stores allocate independent opaque identity');
  const receipts = [first, q.publishLifecycle(a, 'completed'),
    q.publishLifecycle({ ...a, id: randomUUID() }, 'status'),
    q.publishLifecycle({ ...a, sessionId: randomUUID() }, 'status'),
    q.publishLifecycle({ ...a, latestMcpRequestId: randomUUID() }, 'status')];
  assert.equal(new Set(receipts.map(r => r.event_id)).size, receipts.length);
  for (const receipt of receipts) assert.match(receipt.event_id, UUID4);
});

test('caller events and host lifecycle events use distinct replay relationships', t => {
  const q = fixture(t), a = task(), e = event(a, { event_type: 'completed', summary: 'Pi task completed.' });
  q.accept(a, e);
  const host = q.publishLifecycle(a, 'completed');
  assert.notEqual(host.event_id, e.event.event_id);
  assert.equal(q.publishLifecycle(a, 'completed').duplicate, true);
  assert.equal(q.accept(a, e).duplicate, true);
  assert.equal(q.db.prepare('SELECT count(*) n FROM chatgpt_events').get().n, 2);
  const caller = q.db.prepare('SELECT event_id,record_id FROM chatgpt_events WHERE event_id=?').get(e.event.event_id);
  assert.equal(caller.event_id, e.event.event_id, 'caller correlation is preserved while content is available');
  assert.match(caller.record_id, UUID4); assert.notEqual(caller.record_id, caller.event_id);
});

test('erasure removes unknown-origin caller event IDs and preserves only opaque host record identity', async t => {
  let sends = 0;
  const q = fixture(t, { route, fetchImpl: async () => { sends++; return accepted(); } }), a = task();
  const { PersonalMemory } = require('../src/personal-memory');
  const memory = new PersonalMemory({ db: q.db });
  const item = memory.remember({ domain: 'session', taskId: a.id, sessionId: a.sessionId, type: 'fact', subject: 'fixture', content: 'fixture personal event canary', source: 'user_explicit' });
  // UUID formatting cannot prove that an external caller chose opaque identity.
  const e = event(a, { event_id: oldLifecycleId(a, 'result'), summary: 'fixture personal event canary' });
  q.accept(a, e);
  const before = q.db.prepare('SELECT seq,task_id,event_id,record_id FROM chatgpt_events').get();
  assert.equal(q.list(a.id).events[0].event_id, e.event.event_id);
  memory.erase(item.memoryId);
  const after = q.db.prepare('SELECT seq,task_id,event_id,record_id,payload FROM chatgpt_events').get();
  assert.equal(after.seq, before.seq); assert.equal(after.task_id, before.task_id); assert.equal(after.record_id, before.record_id);
  assert.equal(after.event_id, before.record_id); assert.notEqual(after.event_id, e.event.event_id);
  for (const table of q.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    assert.equal(JSON.stringify(q.db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all()).includes(e.event.event_id), false, 'erased caller correlation is absent from supported retained stores');
  }
  assert.throws(() => q.list(a.id), /unavailable|erased/i);
  assert.throws(() => q.accept(a, e), /unavailable|erased/i, 'stale in-memory task cannot repopulate erased correlation');
  assert.throws(() => q.publishLifecycle(a, 'result'), /unavailable|erased/i);
  await q.flush(); assert.equal(sends, 0);
  memory.erase(item.memoryId); assert.equal(q.db.prepare('SELECT record_id FROM chatgpt_events').get().record_id, before.record_id);
});

test('identity schema preparation only adds columns; legacy content requires explicit host migration', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE chatgpt_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,event_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL,acknowledged_at INTEGER,trigger_id TEXT,
    delivery TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,conversation_url TEXT,
    UNIQUE(task_id,event_id))`);
  const a = task(), legacy = oldLifecycleId(a, 'completed');
  db.prepare('INSERT INTO chatgpt_events(task_id,event_id,fingerprint,payload,received_at,delivery) VALUES(?,?,?,?,?,?)')
    .run(a.id, legacy, 'fixture-fingerprint', JSON.stringify({ version: 1, event_id: legacy, event_type: 'completed', task_id: a.id,
      session_id: a.sessionId, request_id: a.latestMcpRequestId, summary: 'Pi task completed.', untrusted: true, grants_approval: false }), 1, 'inbox_only');
  prepareIdentitySchema(db); prepareIdentitySchema(db);
  const row = db.prepare('SELECT event_id,record_id,lifecycle_request_id FROM chatgpt_events').get();
  assert.equal(row.event_id, legacy); assert.equal(row.record_id, null); assert.equal(row.lifecycle_request_id, null);
  assert.equal(require('../src/memory-identity').qualification(db).migration_required, true);
});

test('failed lifecycle insert leaves no allocation and retry persists exactly one event', t => {
  const q = fixture(t), a = task();
  q.db.exec("CREATE TRIGGER fixture_lifecycle_failure BEFORE INSERT ON chatgpt_events BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END");
  assert.throws(() => q.publishLifecycle(a, 'completed'), /unavailable/);
  assert.equal(q.db.prepare('SELECT count(*) n FROM chatgpt_events').get().n, 0);
  q.db.exec('DROP TRIGGER fixture_lifecycle_failure');
  const receipt = q.publishLifecycle(a, 'completed');
  assert.match(receipt.event_id, UUID4); assert.equal(q.publishLifecycle(a, 'completed').event_id, receipt.event_id);
  assert.equal(q.db.prepare('SELECT count(*) n FROM chatgpt_events').get().n, 1);
});

test('legacy content-derived request correlation cannot create or deliver new lifecycle events', async t => {
  let sends = 0;
  const q = fixture(t, { route, fetchImpl: async () => { sends++; return accepted(); } });
  const a = { ...task(), latestMcpRequestId: createHash('sha256').update('fixture erased personal request').digest('hex') };
  assert.throws(() => q.publishLifecycle(a, 'completed'), /opaque|legacy|migration/i);
  assert.throws(() => q.accept(a, event(a)), /opaque|legacy|migration/i);
  await q.flush(); assert.equal(sends, 0);
  assert.equal(q.db.prepare('SELECT count(*) n FROM chatgpt_events').get().n, 0);
});

test('incomplete identity migration denies event reads and remote delivery before transport', async t => {
  let sends = 0;
  const q = fixture(t, { route, fetchImpl: async () => { sends++; return accepted(); } }), a = task();
  const receipt = q.publishLifecycle(a, 'completed');
  require('../src/memory-identity').install(q.db);
  q.db.prepare("UPDATE memory_identity_progress SET state='failed' WHERE id=1").run();
  assert.throws(() => q.list(a.id), /migration|identity|incomplete/i);
  assert.throws(() => q.acknowledge(a.id, receipt.event_id), /migration|identity|incomplete/i);
  assert.throws(() => q.publishLifecycle(a, 'completed'), /migration|identity|incomplete/i);
  assert.throws(() => q.accept(a, event(a)), /migration|identity|incomplete/i);
  await assert.rejects(q.flush(), /migration|identity|incomplete/i);
  assert.equal(sends, 0);
});

test('incomplete content propagation denies an otherwise opaque event before read or transport', async t => {
  let sends = 0;
  const q = fixture(t, { route, fetchImpl: async () => { sends++; return accepted(); } }), a = task();
  const receipt = q.publishLifecycle(a, 'completed');
  const erasure = require('../src/memory-erasure');
  erasure.mark(q.db, { store: 'personal', identity: randomUUID(), scope_hash: erasure.scopeHash(['fixture']), action: 'operator_erasure' });
  assert.throws(() => q.list(a.id), /propagation|incomplete/i);
  assert.throws(() => q.acknowledge(a.id, receipt.event_id), /propagation|incomplete/i);
  assert.throws(() => q.publishLifecycle(a, 'completed'), /propagation|incomplete/i);
  assert.throws(() => q.accept(a, event(a)), /propagation|incomplete/i);
  await assert.rejects(q.flush(), /propagation|incomplete/i); assert.equal(sends, 0);
});

test('task routing, stable dedupe, changed payload rejection, acknowledgment and replay tombstones', t => {
  const q = fixture(t), a = task(), b = task(), e = event(a);
  assert.equal(q.accept(a, e).duplicate, false);
  assert.equal(q.accept(a, e).duplicate, true);
  assert.equal(q.list(b.id).events.length, 0);
  const out = q.list(a.id).events[0];
  assert.equal(out.task_id, a.id); assert.equal(out.session_id, a.sessionId); assert.equal(out.request_id, a.latestMcpRequestId);
  assert.equal(out.untrusted, true); assert.equal(out.grants_approval, false);
  assert.throws(() => q.accept(a, { ...e, event: { ...e.event, summary: 'changed' } }), /different content/);
  assert.throws(() => q.acknowledge(b.id, e.event.event_id), /not found/);
  q.acknowledge(a.id, e.event.event_id); q.acknowledge(a.id, e.event.event_id);
  q.accept(a, e); assert.equal(q.list(a.id).events.length, 0);
  assert.equal(q.db.prepare('SELECT count(*) AS n FROM chatgpt_events').get().n, 1);
});

test('malformed events, forged task/approval fields, stale sessions and requests fail closed', t => {
  const q = fixture(t), a = task(), e = event(a);
  for (const bad of [null, [], {}, { ...e, task_id: a.id }, { ...e, session_id: randomUUID() }, { ...e, request_id: randomUUID() }]) assert.throws(() => q.accept(a, bad));
  for (const change of [{ event_id: '../x' }, { event_type: 'approve' }, { summary: '' }, { summary: 'x'.repeat(1001) }, { summary: 'a\0b' }, { follow_up: 42 }, { approved: true }, { task_id: randomUUID() }]) assert.throws(() => q.accept(a, { ...e, event: { ...e.event, ...change } }));
  q.accept(a, e); a.sessionId = randomUUID(); assert.throws(() => q.accept(a, e), /correlation/);
  a.source.transport = 'local'; assert.throws(() => q.accept(a, event(a)), /correlation/);
});

test('redacts sensitive text before persistence and delivery without touching approval state', t => {
  const q = fixture(t), a = task();
  const summary = `${os.userInfo().username} finished\n/Users/someone/My Project/file.txt\nC:\\Users\\someone\\file.txt\nBearer abcdef\ntoken=abcdef\nfile:///home/someone/f\n%2Fhome%2Fsomeone%2Ffile`;
  const e = event(a, { summary, follow_up: 'Review /private/tmp/results' }); q.accept(a, e);
  const raw = q.db.prepare('SELECT payload FROM chatgpt_events').get().payload;
  for (const secret of [os.userInfo().username, '/Users/', 'someone', 'abcdef', '/private/', '%2Fhome']) assert(!raw.includes(secret), secret);
  assert.equal(redact('user alice uses /opt/private data', 'alice'), 'user [operator] uses [redacted-path]');
  assert.equal(q.list(a.id).events[0].grants_approval, false);
});

test('bounded inbox pagination preserves pending entries; event cap retains replay history', t => {
  const q = fixture(t), a = task();
  for (let i = 0; i < 21; i++) q.accept(a, event(a));
  assert.equal(q.list(a.id).events.length, 20); assert.equal(q.list(a.id).has_more, true);
  for (const e of q.list(a.id).events) q.acknowledge(a.id, e.event_id);
  assert.equal(q.list(a.id).events.length, 1);
  for (let i = 21; i < 1000; i++) q.accept(a, event(a));
  assert.throws(() => q.accept(a, event(a)), /limit/);
});

test('restart preserves dedupe, pending delivery, and acknowledgment', t => {
  const root = fs.mkdtempSync('/private/tmp/pi-events-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.sqlite'); const a = task(), e = event(a);
  let db = new DatabaseSync(file), q = new ChatGPTEvents(db); q.accept(a, e); q.acknowledge(a.id, e.event.event_id); db.close();
  db = new DatabaseSync(file); q = new ChatGPTEvents(db); assert.equal(q.accept(a, e).duplicate, true); assert.equal(q.list(a.id).events.length, 0); db.close();
});

test('Workspace Agent route uses stable correlation and remote idempotency; no duplicate concurrent sends', async t => {
  const calls = [], q = fixture(t, { route, fetchImpl: async (url, init) => { calls.push({ url, ...init }); await new Promise(r => setTimeout(r, 5)); return accepted(); } });
  const a = task(), e = event(a); q.accept(a, e);
  await Promise.all([q.flush(), q.flush()]); await q.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.chatgpt.com/v1/workspace_agents/agtch_fixture/trigger');
  assert.equal(calls[0].redirect, 'error'); assert.equal(calls[0].headers['Idempotency-Key'], `pi-${a.id}-${e.event.event_id}`);
  assert.equal(JSON.parse(calls[0].body).conversation_key, `pi-task-${a.id}`);
  assert(!calls[0].body.includes(route.access_token)); assert.equal(q.list(a.id).events[0].delivery, 'accepted');
});

test('ambiguous delivery retries identical payload/key, caps failures, and rejects permanent errors', async t => {
  let clock = 100000, count = 0; const calls = [];
  const q = fixture(t, { route, now: () => clock, fetchImpl: async (_url, init) => { calls.push(init); if (++count === 1) throw new Error('secret response'); return accepted(); } });
  const a = task(); q.accept(a, event(a)); await q.flush(); await q.flush(); assert.equal(count, 1);
  clock += 10000; await q.flush(); assert.equal(count, 2); assert.equal(calls[0].body, calls[1].body); assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  const b = task(); q.accept(b, event(b)); q.fetch = async () => new Response('secret error', { status: 403 }); await q.flush(); assert.equal(q.list(b.id).events[0].delivery, 'rejected');
  const c = task(); q.accept(c, event(c)); q.fetch = async () => { throw new Error('private'); };
  for (let i = 0; i < 6; i++) { clock += 100000; await q.flush(); }
  assert.equal(q.list(c.id).events[0].delivery, 'needs_review'); assert.equal(q.list(c.id).events[0].attempts, 5);
});

test('inbox-only and changed routes never silently forward existing data; unsafe config rejected', async t => {
  let calls = 0; const q = fixture(t, { fetchImpl: async () => { calls++; return accepted(); } }), a = task();
  q.accept(a, event(a)); q.route = route; await q.flush(); assert.equal(calls, 0);
  q.accept(a, event(a)); q.route = { ...route, trigger_id: 'agtch_other' }; await q.flush(); assert.equal(calls, 0);
  const root = fs.mkdtempSync('/private/tmp/pi-route-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(loadRoute(root), null); const file = path.join(root, 'chatgpt-trigger.json'); fs.writeFileSync(file, JSON.stringify(route), { mode: 0o600 }); assert.deepEqual(loadRoute(root), route);
  fs.chmodSync(file, 0o644); assert.throws(() => loadRoute(root), /Unsafe/);
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify({ ...route, url: 'https://evil.test' })); assert.throws(() => loadRoute(root), /Invalid/);
});

function request(options, body) {
  return new Promise((resolve, reject) => { const req = http.request(options, res => { let text = ''; res.on('data', b => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); }); req.on('error', reject); req.end(JSON.stringify(body)); });
}
async function until(fn) { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Fixture timeout'); }

test('end-to-end Pi extension -> authenticated socket -> durable queue -> MCP inbox; revoked and cross-task attempts fail', async t => {
  const root = fs.mkdtempSync('/private/tmp/pi-event-e2e-'), profile = path.join(root, 'profile'); fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'settings.json'), '{}');
  const bridge = await new Bridge({ defaultRuntime: 'host', dataDir: path.join(root, 'data'), sourceProfile: profile, allowFixtureWorker: true, executable: path.join(__dirname, 'fixtures/host-worker.cjs') }).initialize();
  const ui = new ControlServer(bridge, { port: 0 }); await ui.start();
  t.after(async () => { await ui.close(); await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const mcp = (name, args, token = ui.mcpToken) => request({ hostname: '127.0.0.1', port: ui.port, path: '/api/mcp/call', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, { name, args });
  const created = await mcp('create_task', { description: 'Event fixture', message: 'never settle', request_id: randomUUID() }); assert.equal(created.status, 200);
  const id = created.body.task_id; await until(() => bridge.tasks.get(id).safetyLoaded);
  const runtime = bridge.runtimes.get(id), producer = (route, body, token = runtime.token) => request({ socketPath: bridge.socketPath, path: route, method: 'POST', headers: { authorization: `Bearer ${token}` } }, body);
  const handlers = {}, registered = {};
  const correlation=(await producer('/events/context',{})).body;
  registered.chatgpt_notify={execute:async (_id,input)=>{const out=await producer('/events',{...correlation,event:input});if(out.status!==200||out.body.allow===false)throw Error('Rejected');const details=typeof out.body.output==='string'?JSON.parse(out.body.output):out.body;return{details};}};
  const input = { event_id: randomUUID(), event_type: 'follow_up', summary: 'Fixture result is ready', follow_up: 'Review the result within existing authorization' };
  const check = await producer('/check', { toolName: 'chatgpt_notify', input }); assert.equal(check.body.allow, true);
  const receipt = await registered.chatgpt_notify.execute('call-fixture', input); assert.equal(receipt.details.accepted, true);
  assert.equal((await registered.chatgpt_notify.execute('call-fixture', input)).details.duplicate, true);
  const inbox = await mcp('get_task_events', { task_id: id }); assert.equal(inbox.status, 200); assert.equal(inbox.body.events.length, 1); assert.equal(inbox.body.events[0].request_id, created.body.request_id);
  const other = bridge.createTask('Other'); const otherTask = bridge.tasks.get(other.id); otherTask.source = { transport: 'mcp' }; otherTask.latestMcpRequestId = randomUUID(); bridge.tasks.save(otherTask);
  const forged=await producer('/events', { ...event(otherTask), task_id: other.id });assert.equal(forged.status,200);assert.equal(forged.body.allow,false);
  assert.equal((await mcp('get_task_events', { task_id: other.id })).body.events.length, 0);
  assert.equal((await mcp('acknowledge_task_event', { task_id: other.id, event_id: input.event_id })).status, 400);
  assert.equal((await mcp('get_task_events', { task_id: id }, runtime.token)).status, 401);
  assert.equal((await producer('/events', event(bridge.tasks.get(id)), ui.mcpToken)).status, 403);
  assert.equal(bridge.policy.list(id).length, 0);
  const remoteCalls = [];
  bridge.chatgptEvents.route = route;
  bridge.chatgptEvents.fetch = async (url, init) => { remoteCalls.push({ url, ...init }); return accepted(); };
  bridge.chatgptEvents.start();
  const remoteInput = { ...input, event_id: randomUUID(), summary: 'Result in /Users/private/result.txt' };
  await registered.chatgpt_notify.execute('remote-call', remoteInput);
  await until(() => remoteCalls.length === 1 && bridge.chatgptEvents.list(id).events.some(e => e.delivery === 'accepted'));
  const triggerBody = JSON.parse(remoteCalls[0].body);
  assert.equal(triggerBody.conversation_key, `pi-task-${id}`);
  assert(!triggerBody.input.includes('/Users/'));
  assert(triggerBody.input.includes(created.body.request_id));
  await mcp('acknowledge_task_event', { task_id: id, event_id: remoteInput.event_id });
  await mcp('acknowledge_task_event', { task_id: id, event_id: input.event_id });
  await registered.chatgpt_notify.execute('call-fixture', input); assert.equal((await mcp('get_task_events', { task_id: id })).body.events.length, 0);
  bridge.tokens.delete(runtime.token); assert.equal((await producer('/events', event(bridge.tasks.get(id)))).status, 403);
});

test('remote replay age and crash-at-attempt-limit require review without another send', async t => {
  let clock = 0, sends = 0; const q = fixture(t, { route, now: () => clock, fetchImpl: async () => { sends++; throw new Error('uncertain'); } });
  const a = task(); q.accept(a, event(a)); await q.flush(); clock = 16 * 60 * 1000; await q.flush();
  assert.equal(sends, 1); assert.equal(q.list(a.id).events[0].delivery, 'needs_review');
  const b = task(); q.accept(b, event(b)); q.db.prepare('UPDATE chatgpt_events SET attempts=5 WHERE task_id=?').run(b.id);
  await q.flush(); assert.equal(sends, 1); assert.equal(q.list(b.id).events[0].delivery, 'needs_review');
});

test('invalid/oversized remote receipts cannot leak data and keep retry identity', async t => {
  let clock = 0; const q = fixture(t, { route, now: () => clock, fetchImpl: async () => new Response(JSON.stringify({ conversation_url: 'https://evil.test/private' }), { status: 202 }) });
  const a = task(); q.accept(a, event(a)); await q.flush(); assert.equal(q.list(a.id).events[0].delivery, 'pending');
  q.fetch = async () => new Response('x'.repeat(9000), { status: 202 }); clock += 10000; await q.flush();
  assert.equal(q.list(a.id).events[0].conversation_url, null);
});

test('queued events for one task retain send order during backoff', async t => {
  let clock = 0, fail = true; const ids = [];
  const q = fixture(t, { route, now: () => clock, fetchImpl: async (_u, init) => { ids.push(init.headers['Idempotency-Key']); if (fail) throw new Error('network'); return accepted(); } });
  const a = task(), first = event(a), second = event(a); q.accept(a, first); q.accept(a, second);
  await q.flush(); await q.flush(); assert.equal(ids.length, 1);
  clock = 10000; fail = false; await q.flush(); await q.flush();
  assert.deepEqual(ids, [`pi-${a.id}-${first.event.event_id}`, `pi-${a.id}-${first.event.event_id}`, `pi-${a.id}-${second.event.event_id}`]);
});
