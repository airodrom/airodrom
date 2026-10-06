'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const BridgeController = require('../src/bridge-controller');
const ControlServer = require('../src/control-server');

async function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/bridge-personal-memory-api-'); const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture' }));
  const bridge = await new BridgeController({ defaultRuntime: 'pi', dataDir: path.join(root, 'data'), sourceProfile: profile, executable: path.join(__dirname, 'fixtures/fake-pi.cjs'), allowFixtureWorker: true }).initialize();
  const control = new ControlServer(bridge, { port: 0 }); await control.start();
  t.after(async () => { await control.close(); await bridge.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = (route, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${control.origin}${route}`, { method, headers: { authorization: `Bearer ${control.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
      let text = ''; res.on('data', part => { text += part; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { bridge, request };
}

test('operator Personal Memory APIs persist explicit memories, preserve forget evidence, and ledger only records safe metadata', async t => {
  const f = await fixture(t);
  const remembered = await f.request('/api/personal-memory/remember', { method: 'POST', body: { domain: 'personal', type: 'preference', subject: 'review format', content: 'Prefers concise engineering review summaries.', source: 'user_explicit', confidence: 98, sensitivity: 'normal' } });
  assert.equal(remembered.status, 201); const id = remembered.body.memoryId;
  assert.equal((await f.request('/api/personal-memory?query=concise&domain=personal')).body.items[0].memoryId, id);
  const updated = await f.request(`/api/personal-memory/${id}/update`, { method: 'POST', body: { content: 'Prefers concise review summaries with test counts.' } });
  assert.equal(updated.status, 200); assert.notEqual(updated.body.memoryId, id);
  const forgotten = await f.request(`/api/personal-memory/${updated.body.memoryId}/forget`, { method: 'POST', body: {} });
  assert.equal(forgotten.status, 200); assert.equal(forgotten.body.contentRemoved, true);
  assert.equal((await f.request('/api/personal-memory?query=test%20counts&domain=personal')).body.items.length, 0);
  const types = f.bridge.ledger.list({ eventType: 'memory.write', limit: 20 }).events.map(event => event.event_type);
  assert.ok(types.length >= 2);
  const ledgerRows = f.bridge.ledger.list({ limit: 100 }).events.filter(event => event.event_type.startsWith('memory.'));
  assert.ok(ledgerRows.some(event => event.event_type === 'memory.forget'));
  assert.doesNotMatch(JSON.stringify(ledgerRows), /concise engineering|test counts/);
});

test('project APIs form a durable hierarchy and let an existing task retrieve only project-scoped memory', async t => {
  const f = await fixture(t);
  const project = (await f.request('/api/projects', { method: 'POST', body: { name: 'Pi Personal Assistant', desiredOutcomes: ['Durable personal memory'], autonomyLevel: 'suggest' } })).body;
  const goal = (await f.request(`/api/projects/${project.projectId}/goals`, { method: 'POST', body: { name: 'Memory', desiredOutcome: 'Persistent preferences' } })).body;
  const mission = (await f.request(`/api/goals/${goal.goalId}/missions`, { method: 'POST', body: { name: 'Personal Memory V1', acceptanceCriteria: ['restart persistence'] } })).body;
  assert.equal((await f.request(`/api/missions/${mission.missionId}/status`, { method: 'POST', body: { status: 'active', nextAction: 'Add tests' } })).body.status, 'active');
  const memory = await f.request('/api/personal-memory/remember', { method: 'POST', body: { domain: 'project', projectId: project.projectId, type: 'fact', subject: 'storage', content: 'This project uses the existing local SQLite database.', source: 'project_derived', confidence: 90, sensitivity: 'normal' } });
  assert.equal(memory.status, 201);
  const task = (await f.request('/api/tasks', { method: 'POST', body: { description: 'Project-linked task', projectId: project.projectId } })).body;
  assert.equal(f.bridge.tasks.get(task.id).projectId, project.projectId);
  assert.equal(f.bridge.personalMemoryContext(f.bridge.tasks.get(task.id), 'local SQLite').items[0].projectId, project.projectId);
  assert.equal((await f.request(`/api/projects/${project.projectId}/memory?query=SQLite`)).body.items[0].projectId, project.projectId);
  assert.equal((await f.request(`/api/projects/${project.projectId}/summary`)).body.missions[0].missionId, mission.missionId);
  const next = await f.request('/api/next-actions');
  assert.equal(next.status, 200); assert.equal(next.body.state, 'suggested'); assert.equal(next.body.missionId, mission.missionId); assert.equal(next.body.execution, 'not_dispatched');
});
