'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const intent = require('../src/assistant-intent');
const service = require('../src/assistant-service');
const { fixture } = require('./fixtures/mission-fixture.cjs');

const OWNER = 'In the prepared self-repair test workspace, change fixture.txt from alpha to beta. Verify the result. If verification fails, diagnose the problem, repair it automatically within my approved scope, resume the original goal, and report the final result.';

test('contextual file-change instructions classify as WORK, not conversation', () => {
  for (const message of [
    OWNER,
    'In this disposable workspace, change fixture.txt from alpha to beta.',
    'Please change fixture.txt from alpha to beta.',
    'Can you change fixture.txt from alpha to beta?',
    'Fix this repository.',
  ]) {
    const parsed = intent.parse(message);
    assert.equal(parsed.route, 'WORK', message);
    assert.equal(parsed.kind, 'work', message);
  }
});

test('ordinary discussion about files stays conversation', () => {
  for (const message of [
    'Explain how to change fixture.txt',
    'How do I edit a repository file?',
    'Tell me about the test file',
    'Hi',
  ]) {
    const parsed = intent.parse(message);
    assert.equal(parsed.kind, 'conversation', message);
  }
});

test('recognized Terminal WORK routes through ZeroSetupWork, never chatbot refusal', async t => {
  const f = await fixture(t);
  const server = { bridge: f.bridge, conversationEngine: { start() { throw Error('Conversation must not answer WORK'); } } };
  const receipt = await service.submit(server, { message: OWNER, request_id: randomUUID() });
  assert.equal(receipt.kind, 'zero_setup');
  assert.equal(receipt.route, 'WORK');
  assert.equal(receipt.authority, false);
  assert.equal(receipt.execution_authorized, false);
  assert.notEqual(receipt.state, 'draft');
  assert.doesNotMatch(JSON.stringify(receipt), /cannot access|do not have access|as a language model/i);
});
