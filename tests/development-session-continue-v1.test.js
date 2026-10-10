'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Development Sessions panel exposes Continue Development Session action', () => {
  const panel = fs.readFileSync(path.join(__dirname, '../public/development-sessions-panel.js'), 'utf8');
  assert.match(panel, /AirodromDevelopmentSessions/);
  assert.match(panel, /Continue Development Session/);
  assert.match(panel, /return true/);
  assert.doesNotMatch(panel, /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(/);
  for (const label of [
    'Selected session',
    'Authorized repository',
    'Authorized worktree',
    'Last completed Mission',
    'Next permitted action',
    'Execution state'
  ]) {
    assert.match(panel, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(panel, /development-sessions\/resolve|observe-git|active_missions|duplicate/);
  assert.match(panel, /development_session_id|session\.id/);
});

test('Continue action reuses host Development Session APIs without a second Mission system', () => {
  const panel = fs.readFileSync(path.join(__dirname, '../public/development-sessions-panel.js'), 'utf8');
  assert.match(panel, /\/api\/assistant\/development-sessions/);
  assert.doesNotMatch(panel, /second Mission system|createMissionSystem|newMissionBus/);
  assert.match(panel, /ui\.api/);
  assert.match(panel, /ui\.button/);
});
