'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LABELS = [
  'Active Development Session',
  'Associated Missions',
  'Current worker',
  'Repository and branch',
  'Local changes',
  'Focused verification',
  'Pending integration checkpoint',
  'Last completed activity',
  'Next permitted action'
];

test('Development Sessions panel uses evidence-backed summary labels without HTML injection', () => {
  const panel = fs.readFileSync(path.join(__dirname, '../public/development-sessions-panel.js'), 'utf8');
  assert.match(panel, /AirodromDevelopmentSessions/);
  assert.match(panel, /return true/);
  assert.doesNotMatch(panel, /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(/);
  for (const label of LABELS) assert.match(panel, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(panel, /assigned_worker/);
  assert.match(panel, /integration_state/);
  assert.match(panel, /dirty_files/);
  assert.match(panel, /Prepare Daily Integration/);
});

test('Control Center wires the Development Sessions panel entry', () => {
  const hub = fs.readFileSync(path.join(__dirname, '../public/control-hub.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/control-hub.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/control-hub.css'), 'utf8');
  assert.match(hub, /AirodromDevelopmentSessions/);
  assert.match(hub, /development_sessions/);
  assert.match(hub, /view==='Development Sessions'/);
  assert.match(html, /development-sessions-panel\.js/);
  assert.match(css, /Development Sessions/);
  assert.doesNotMatch(hub, /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(/);
});

test('Development Sessions APIs and Live Observatory remain host-owned', () => {
  const server = fs.readFileSync(path.join(__dirname, '../src/control-server.js'), 'utf8');
  const observatory = fs.readFileSync(path.join(__dirname, '../src/live-observatory.js'), 'utf8');
  const product = fs.readFileSync(path.join(__dirname, '../src/product-observability.js'), 'utf8');
  assert.match(server, /\/api\/assistant\/development-sessions/);
  assert.match(server, /prepare-daily-integration/);
  assert.match(server, /observe-git/);
  assert.match(product, /development_sessions/);
  assert.match(observatory, /observeOpenCode/);
});
