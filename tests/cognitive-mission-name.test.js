'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { missionName } = require('../src/mission-service');

test('cognitive Missions with the same instruction get distinct project names', () => {
  const objective = 'In milestone-b1-fixture, use cursor to change alpha.txt from alpha to ALPHA and beta.txt from beta to BETA.';
  const first = missionName({ request_id: 'cognitive-cursor:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cognitive_request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', objective });
  const second = missionName({ request_id: 'cognitive-cursor:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cognitive_request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', objective });
  assert.notEqual(first, second);
  assert.match(first, /^\[[0-9a-f]{8}\] /);
  assert.equal(missionName({ request_id: 'plain', objective }), objective);
});
