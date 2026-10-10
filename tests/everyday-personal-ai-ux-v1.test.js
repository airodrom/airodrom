'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('Conversation surface exposes model, history, Memory consent and reconnect honesty', () => {
  const hub = read('public/control-hub.js');
  const css = read('public/control-hub.css');
  for (const needle of [
    'Conversation model',
    'Qwen · local only (default)',
    'Use selected model',
    'Continue previous conversation',
    'Start new conversation',
    'Memory consent:',
    'Model activity:',
    'Reconnecting to the local service',
    'conversation-model-bar',
    'memory-consent-status',
    'deepLinkViews'
  ]) assert.match(hub, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(css, /conversation-model-bar/);
  assert.match(css, /memory-consent-status/);
  assert.match(hub, /conversationSession|\/api\/assistant\/input/);
  assert.doesNotMatch(hub, /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(/);
});

test('Mission cards surface verified activity, approval, Settlement and Observatory', () => {
  const hub = read('public/control-hub.js');
  assert.match(hub, /Active work:/);
  assert.match(hub, /Assigned worker:/);
  assert.match(hub, /Pending approval:/);
  assert.match(hub, /Settlement:/);
  assert.match(hub, /Open Observatory/);
});

test('Control Center deep links cover Conversation, Missions, Development Sessions and System Health', () => {
  const hub = read('public/control-hub.js');
  const bootstrap = read('src/local-bootstrap.js');
  const control = read('scripts/macos/product-control.cjs');
  assert.match(hub, /deepLinkViews\.has\(value\)/);
  assert.match(bootstrap, /Development Sessions/);
  assert.match(bootstrap, /System Health/);
  for (const action of ['open-conversation', 'open-missions', 'open-development-sessions', 'open-system-health']) {
    assert.match(control, new RegExp(action));
  }
});

test('macOS Menu V2 retains Control Center and adds everyday deep links', () => {
  const menu = read('macos/AirodromMenu.swift');
  for (const needle of [
    'Open Control Center',
    'Open Conversation',
    'Active Missions',
    'Continue Development Session',
    'Open System Health',
    'open-conversation',
    'open-missions',
    'open-development-sessions',
    'open-system-health',
    'Personal AI Operations'
  ]) assert.match(menu, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Development Sessions Continue clarity includes branch and next permitted action', () => {
  const panel = read('public/development-sessions-panel.js');
  assert.match(panel, /Continue Development Session/);
  assert.match(panel, /Authorized branch/);
  assert.match(panel, /Next permitted action/);
  assert.match(panel, /no duplicate execution/);
  assert.match(panel, /development-sessions\/resolve/);
  assert.doesNotMatch(panel, /development-sessions\/continue/);
});
