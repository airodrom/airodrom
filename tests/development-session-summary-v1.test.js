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
  assert.match(hub, /AirodromDevelopmentSessions/);
  assert.match(html, /development-sessions-panel\.js/);
  assert.doesNotMatch(hub, /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(/);
});
