'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const ControlServer = require('../src/control-server');

test('PATCH /api/projects/:id updates repositories without archive semantics', async t => {
  const f = await fixture(t);
  const ui = new ControlServer(f.bridge, { port: 0, connectionStatus: async () => ({ state: 'not_connected', connected: false, tunnelHealthy: false, mcpProbe: 'unknown' }) });
  await ui.start();
  t.after(() => ui.close());
  const request = (route, { method = 'GET', body, authorized = true, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request(ui.origin + route, {
      method,
      headers: {
        ...(authorized ? { authorization: `Bearer ${ui.token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers
      }
    }, res => {
      let text = '';
      res.on('data', p => text += p);
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

  const project = f.bridge.projects.listProjects()[0];
  assert.deepEqual(project.repositories, [f.repo]);
  const other = fs.realpathSync(fs.mkdtempSync('/private/tmp/airodrom-project-update-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, 'README.md'), 'safe\n');
  require('node:child_process').execFileSync('/usr/bin/git', ['-C', other, 'init', '-q']);
  require('node:child_process').execFileSync('/usr/bin/git', ['-C', other, 'add', '.']);
  require('node:child_process').execFileSync('/usr/bin/git', ['-C', other, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'baseline']);

  assert.equal((await request(`/api/projects/${project.projectId}`, { method: 'PATCH', body: { repositories: [f.repo, other] }, authorized: false })).status, 401);
  assert.equal((await request(`/api/projects/${project.projectId}`, { method: 'PATCH', body: { repositories: [f.repo, other] }, headers: { origin: 'https://evil.example' } })).status, 403);

  const updated = await request(`/api/projects/${project.projectId}`, { method: 'PATCH', body: { repositories: [f.repo, other], nextAction: 'Register bounded work template' } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.repositories, [f.repo, other]);
  assert.equal(updated.body.nextAction, 'Register bounded work template');
  assert.equal(updated.body.status, 'active');
  assert.deepEqual(f.bridge.projects.getProject(project.projectId).repositories, [f.repo, other]);
});
