'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { externalWorkerEligible } = require('../src/developer-autonomy');

const governed = {
  governed_worker: true,
  ready: true,
  tiers: { qualified: true },
};

test('governed Cursor readiness permits specialist enrollment without the denied bounded-worker qualification', () => {
  const bridge = {
    options: {},
    cursorWorker: { lastReadiness: governed },
    workers: { current: () => ({ qualified: false }) },
  };
  assert.equal(externalWorkerEligible(bridge, 'cursor'), true);
  assert.equal(externalWorkerEligible(bridge, 'codex'), false);
});

test('Cursor enrollment stays closed when the governed worker is not qualified', () => {
  const bridge = {
    options: {},
    cursorWorker: { lastReadiness: { ...governed, ready: false, tiers: { qualified: false } } },
    workers: { current: () => ({ qualified: true }) },
  };
  assert.equal(externalWorkerEligible(bridge, 'cursor'), false);
});
