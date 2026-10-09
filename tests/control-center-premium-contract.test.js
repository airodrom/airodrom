'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const ControlServer = require('../src/control-server');

const REQUIRED_VIEWS = [
  'AI & Workers', 'Automation & Permissions', 'Conversation', 'Models', 'Workers',
  'WORK Templates', 'Google Connections', 'Connectors', 'Sensitive & Vault', 'Overview',
  'Missions', 'Memory', 'Projects', 'Runtime & OpenCode', 'Approvals', 'Activity & Audit',
  'System Health', 'Settings & About'
];

test('premium Control Center keeps atmosphere mounts reconciled with live product APIs', async t => {
  const html = fs.readFileSync(path.join(__dirname, '../public/control-hub.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../public/control-hub.js'), 'utf8');
  assert.match(html, /id="atmosphere"/);
  assert.match(html, /id="weather-switcher"/);
  assert.match(html, /id="theme"/);
  assert.match(js, /BEGIN generated atmosphere compatibility bundle/);
  for (const view of REQUIRED_VIEWS) assert.match(js, new RegExp(view.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const route of [
    '/api/product/overview',
    '/api/product/observatory',
    '/api/product/observatory/diff',
    '/api/product/live-stream',
    '/api/product/accept-mission',
    '/api/assistant/google',
    '/api/assistant/work-templates',
    '/api/assistant/preferences'
  ]) assert.match(js, new RegExp(route.replace(/\//g, '\\/')));

  const { fixture } = require('./fixtures/mission-fixture.cjs');
  const f = await fixture(t, { defaultRuntime: 'opencode' });
  const created = f.create({ objective: 'Synthetic premium Control Center contract' });
  const missionId = created.mission_id || created.id;
  const ui = new ControlServer(f.bridge, {
    port: 0,
    connectionStatus: async () => ({ state: 'connected', connected: true, tunnelHealthy: true, mcpProbe: 'ok' })
  });
  await ui.start();
  t.after(async () => { await ui.close(); });

  const get = (route, authorized = true) => new Promise((resolve, reject) => {
    http.get(ui.origin + route, {
      headers: authorized ? { authorization: `Bearer ${ui.token}` } : {}
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = text;
        try { body = text ? JSON.parse(text) : null; } catch { /* html/static */ }
        resolve({ status: res.statusCode, body, text });
      });
    }).on('error', reject);
  });

  // Control Center entry is `/` → control-hub.html (not `/control-hub.html`).
  const page = await get('/', false);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="atmosphere"/);
  assert.match(page.text, /id="weather-switcher"/);
  assert.match(page.text, /id="theme"/);

  const overview = await get('/api/product/overview');
  assert.equal(overview.status, 200);
  assert.equal(typeof overview.body.status, 'string');
  assert.ok(overview.body.control || overview.body.runtime || overview.body.memory);

  const observatory = await get('/api/product/observatory?mission=' + encodeURIComponent(missionId));
  assert.equal(observatory.status, 200);
  assert.equal(observatory.body.mission.id, missionId);
  assert.match(JSON.stringify(observatory.body), /mission|activity|worker/);
  assert.doesNotMatch(JSON.stringify(observatory.body), /Bearer |SECRET|private\/fixture/);
});
