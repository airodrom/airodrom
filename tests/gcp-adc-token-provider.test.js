'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGcpAdcTokenProvider, runGcloud } = require('../src/gcp-adc-token-provider');

test('ADC helper refuses cloud resource verbs', () => {
  assert.throws(() => runGcloud(['storage', 'buckets', 'create', 'x']), /refused|forbidden/i);
});

test('ADC helper returns account+token from fixed auth argv', async () => {
  const calls = [];
  const provider = createGcpAdcTokenProvider({
    spawnImpl: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('list')) return { status: 0, stdout: 'andcantech@gmail.com\n', error: null };
      if (args.includes('print-access-token')) return { status: 0, stdout: 'ya29.test-token-value\n', error: null };
      return { status: 1, stdout: '', error: null };
    },
  });
  const id = await provider();
  assert.equal(id.account_email, 'andcantech@gmail.com');
  assert.equal(id.accessToken, 'ya29.test-token-value');
  assert.deepEqual(calls[0].slice(1, 3), ['auth', 'list']);
  assert.deepEqual(calls[1].slice(1, 3), ['auth', 'print-access-token']);
});
