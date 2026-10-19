'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { specialistWallClockMs } = require('../src/cognitive-router');

test('v3 wall clock reserves host verification and OpenCode evaluation after Cursor', () => {
  const limits = { execution_ms: 120000, planning_ms: 120000, repair_attempts: 0 };
  const proposal = { tasks: [{ worker: 'cursor' }] };
  assert.equal(specialistWallClockMs({ version: 3, limits }, proposal), 360000);
  assert.equal(specialistWallClockMs({ version: 2, limits }, proposal), 120000);
});
