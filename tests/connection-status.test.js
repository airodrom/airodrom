'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { derive, menuPresentation } = require('../src/connection-status');

test('connectivity distinguishes service reachability from provider gaps', () => {
  assert.equal(derive({ authorized: true, reachable: true, overviewStatus: 'Ready' }).state, 'CONNECTED');
  assert.equal(derive({ authorized: true, reachable: true, overviewStatus: 'Degraded' }).state, 'DEGRADED');
  assert.equal(derive({ authorized: true, reachable: false, failures: 2 }).state, 'RECONNECTING');
  assert.equal(derive({ authorized: true, reachable: false, failures: 0 }).state, 'DISCONNECTED');
  assert.equal(derive({ authorized: false }).state, 'AUTHORIZATION_REQUIRED');
  assert.equal(derive({ authorized: true, reachable: true, maintenance: true }).state, 'MAINTENANCE');
});

test('menu presentation never treats provider-only gaps as disconnected when bridge is connected', () => {
  const healthy = menuPresentation({ bridgeState: 'Connected', productStatus: 'Ready', activeMissions: 0, approvals: 0 });
  assert.equal(healthy.tone, 'healthy');
  const working = menuPresentation({ bridgeState: 'Connected', productStatus: 'Ready', activeMissions: 1, missionState: 'running' });
  assert.equal(working.tone, 'working');
  const degraded = menuPresentation({ bridgeState: 'Connected', productStatus: 'Degraded' });
  assert.equal(degraded.tone, 'degraded');
  assert.notEqual(degraded.tone, 'disconnected');
});

test('menu presentation: historical review backlog stays healthy; only pending Approvals force gold', () => {
  const backlog = menuPresentation({ bridgeState: 'Connected', productStatus: 'Ready', activeMissions: 0, approvals: 0, reviewMissions: 45 });
  assert.equal(backlog.tone, 'healthy');
  assert.equal(backlog.label, 'CONNECTED');
  const approval = menuPresentation({ bridgeState: 'Connected', productStatus: 'Ready', activeMissions: 0, approvals: 2, reviewMissions: 45 });
  assert.equal(approval.tone, 'approval');
  assert.equal(approval.label, 'ACTION REQUIRED');
  const activeOverReview = menuPresentation({ bridgeState: 'Connected', productStatus: 'Ready', activeMissions: 1, approvals: 0, reviewMissions: 10, missionState: 'running' });
  assert.equal(activeOverReview.tone, 'working');
  assert.equal(menuPresentation({ bridgeState: 'Error' }).tone, 'disconnected');
});

test('control hub exposes authoritative connection helpers', () => {
  const js = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/control-hub.js'), 'utf8');
  assert.match(js, /deriveConnection/);
  assert.match(js, /applyConnection/);
  assert.match(js, /RECONNECTING/);
  assert.match(js, /Observatory snapshot unavailable/);
  assert.match(js, /Does not imply service disconnect|does not imply service disconnect/);
});
