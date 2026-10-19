'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const intent = require('../src/assistant-intent');
const policy = require('../src/provider-policy');

const CURSOR_WORK = 'Use OpenCode to plan a bounded edit. Use Cursor to change fixture.txt from alpha to beta inside the enrolled disposable workspace. Return Cursor artifacts to OpenCode for evaluation. Require Airodrom independent verification.';

test('prose authorization is not a secret; session values stay blocked', () => {
  for (const text of [
    'Host authorization remains required for the enrolled workspace.',
    'Project 7050a853-4754-4cab-a357-ff882b3446f0 is an enrolled workspace reference.',
    CURSOR_WORK,
  ]) {
    assert.equal(policy.operatorSecretLike(text), false);
    assert.equal(intent.secret(text), false);
  }
  assert.equal(intent.parse('session synthetic-canary').kind, 'secret');
  assert.equal(intent.parse('browser session synthetic-canary').kind, 'secret');
  assert.equal(intent.parse('session for app.monarch.com').kind, 'secret');
});

test('actual credentials and assignments still fail closed', () => {
  for (const text of [
    'Set the api key to sk-testkeyvalue12345678',
    'authorization=Bearer fixture-token-value',
    'SESSION=fixture-session-value',
    'password is hunter2fixture',
  ]) {
    assert.equal(intent.secret(text), true);
    assert.equal(policy.operatorSecretLike(text), true);
    assert.equal(intent.parse(text).kind, 'secret');
  }
});

test('OpenCode to Cursor file change is bounded work, not conversation', () => {
  assert.equal(intent.isWorkRequest(CURSOR_WORK), true);
  assert.equal(intent.parse(CURSOR_WORK).kind, 'work');
  assert.equal(intent.parse('hello there').kind, 'conversation');
  assert.equal(intent.isWorkRequest('How do I change fixture.txt from alpha to beta?'), false);
  assert.equal(intent.parse('How do I change fixture.txt from alpha to beta?').kind, 'conversation');
});

test('secret classification does not echo the submitted value', () => {
  const value = 'authorization=Bearer fixture-token-value';
  const routed = intent.parse(value);
  assert.equal(routed.kind, 'secret');
  assert.equal(JSON.stringify(routed).includes('fixture-token-value'), false);
});
