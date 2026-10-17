'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const intent = require('../src/assistant-intent');
const awareness = require('../src/memory-awareness');
const service = require('../src/assistant-service');
const { AssistantConnectors } = require('../src/assistant-connectors');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const ControlServer = require('../src/control-server');

async function setup(t) {
  const f = await fixture(t);
  const server = new ControlServer(f.bridge, { port: 0 });
  await server.start();
  t.after(() => server.close());
  return { ...f, server };
}

const QUESTIONS = [
  'what kind of memory you have like assistant',
  'what kind of memory do you have',
  'Do you have personal memory?',
  'Can you remember my company information?',
  'What is Sensitive Memory?',
  'Do you have a Vault?',
  'Can you access Gmail?',
  'Can you browse the web?',
  'What can you do as my assistant?',
];

for (const message of QUESTIONS) {
  test('detects memory/capability question: ' + message.slice(0, 48), () => {
    const parsed = intent.parse(message);
    assert.equal(parsed.kind, 'memory_awareness');
    assert.equal(parsed.authority, false);
  });
}

test('concrete remember-that statements are not awareness', () => {
  assert.equal(intent.parse('Can you remember that my name is Aurora.').kind, 'remember');
  assert.equal(intent.parse('Remember that my name is Aurora.').kind, 'remember');
});

test('memory capability question explains Personal Memory without inventing contents', async (t) => {
  const f = await setup(t);
  f.server.rememberInteractive('My name is Aurora');
  const result = await service.submit(f.server, {
    message: 'what kind of memory you have like assistant',
    request_id: crypto.randomUUID(),
  });
  assert.equal(result.kind, 'memory_awareness');
  assert.match(result.message, /Personal Memory V2/i);
  assert.match(result.message, /Sensitive Memory/i);
  assert.match(result.message, /Secret Vault/i);
  assert.match(result.message, /Project Memory/i);
  assert.match(result.message, /Conversation Context/i);
  assert.match(result.message, /does not directly read databases/i);
  assert.doesNotMatch(result.message, /Aurora/);
  assert.equal(result.authority, false);
});

test('Personal versus Sensitive Memory boundaries', async (t) => {
  const f = await setup(t);
  const personal = await service.submit(f.server, {
    message: 'Do you have personal memory?',
    request_id: crypto.randomUUID(),
  });
  assert.equal(personal.kind, 'memory_awareness');
  assert.match(personal.message, /Personal Memory V2/i);
  assert.match(personal.message, /Sensitive Memory/i);
  assert.match(personal.message, /excluded from automatic AI context/i);
  assert.doesNotMatch(personal.message, /encrypt(?:ed|ion) at rest|field-level encryption is enabled/i);

  const sensitive = await service.submit(f.server, {
    message: 'What is Sensitive Memory?',
    request_id: crypto.randomUUID(),
  });
  assert.equal(sensitive.focus, 'sensitive_memory');
  assert.match(sensitive.message, /operator-only/i);
  assert.match(sensitive.message, /\/remember-sensitive/i);
  assert.doesNotMatch(sensitive.message, /field-level encryption is (?:enabled|active)/i);
});

test('Vault access boundaries never disclose values', async (t) => {
  const f = await setup(t);
  const result = await service.submit(f.server, {
    message: 'Do you have a Vault?',
    request_id: crypto.randomUUID(),
  });
  assert.equal(result.kind, 'memory_awareness');
  assert.equal(result.focus, 'secret_vault');
  assert.match(result.message, /Keychain/i);
  assert.match(result.message, /never discloses Vault values/i);
  assert.doesNotMatch(result.message, /password|token|secret value|sk-/i);
});

test('connected versus disconnected Gmail uses live evidence only', async (t) => {
  const f = await setup(t);

  const disconnected = await service.submit(f.server, {
    message: 'Can you access Gmail?',
    request_id: crypto.randomUUID(),
  });
  assert.equal(disconnected.kind, 'memory_awareness');
  assert.equal(disconnected.connectors.gmail.connected, false);
  assert.match(disconnected.message, /not live-connected/i);
  assert.doesNotMatch(disconnected.message, /live read access is available right now/i);

  f.bridge.assistantConnectors = new AssistantConnectors({
    gmail: { reference: 'opaque', scope: 'https://www.googleapis.com/auth/gmail.readonly' },
    secrets: { resolve: async () => 'synthetic-mail-token' },
    request: async () => ({ ok: true, text: async () => JSON.stringify({ messages: [] }) }),
  }).markLive('gmail');

  const connected = awareness.explain(f.server, { focus: 'gmail' });
  assert.equal(connected.connectors.gmail.connected, true);
  assert.equal(connected.connectors.gmail.live_qualified, true);
  assert.match(connected.message, /live read access is available/i);
});

test('governed browser availability is honest about qualification', async (t) => {
  const f = await setup(t);
  const result = await service.submit(f.server, {
    message: 'Can you browse the web?',
    request_id: crypto.randomUUID(),
  });
  assert.equal(result.kind, 'memory_awareness');
  assert.equal(result.focus, 'web');
  assert.match(result.message, /not qualified|governed Mission web|approved search provider/i);
  assert.match(result.message, /browser research/i);
  assert.doesNotMatch(result.message, /I (?:can|will) browse (?:any|the) (?:site|web) (?:freely|now)/i);
});

test('no private data disclosure on capability questions', async (t) => {
  const f = await setup(t);
  const privateValue = 'My private account value is 4827';
  service.sensitiveRecord(f.bridge, privateValue);
  f.server.rememberInteractive('My company is SyntheticCorp Canary');

  for (const message of [
    'what kind of memory do you have',
    'What is Sensitive Memory?',
    'Do you have a Vault?',
    'What can you do as my assistant?',
  ]) {
    const result = await service.submit(f.server, { message, request_id: crypto.randomUUID() });
    assert.equal(result.kind, 'memory_awareness');
    assert.doesNotMatch(JSON.stringify(result), /4827|SyntheticCorp Canary|private account value/i);
    assert.match(result.message, /not listing or inventing any stored personal records/i);
  }
});

test('no invented memory access claims', async (t) => {
  const f = await setup(t);
  const result = await service.submit(f.server, {
    message: 'Can you remember my company information?',
    request_id: crypto.randomUUID(),
  });
  assert.equal(result.kind, 'memory_awareness');
  assert.match(result.message, /Personal Memory V2|host-owned/i);
  assert.match(result.message, /does not directly read databases|Host services select authorized context/i);
  assert.doesNotMatch(result.message, /I (?:already )?(?:have|stored|saved) your company/i);
  assert.doesNotMatch(result.message, /I can(?:not)? access ordinary Memory V2 but not Personal Memory/i);
});
