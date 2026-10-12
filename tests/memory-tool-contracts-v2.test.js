'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateToolInput, validateWorkerToolInput } = require('../src/capability-broker');

test('ChatGPT personal_memory_search shape with optional limit is accepted', () => {
  assert.deepEqual(
    validateWorkerToolInput('personal_memory_search', { query: 'Airodrom', limit: 5 }),
    { query: 'Airodrom', limit: 5 }
  );
  assert.deepEqual(
    validateWorkerToolInput('personal_memory_search', { query: 'Airodrom', domain: 'personal', limit: 5 }),
    { query: 'Airodrom', domain: 'personal', limit: 5 }
  );
  assert.deepEqual(
    validateWorkerToolInput('personal_memory_search', { query: 'Airodrom' }),
    { query: 'Airodrom' }
  );
});

test('ChatGPT personal_memory_recent shape without domain defaults at execution', () => {
  assert.deepEqual(
    validateWorkerToolInput('personal_memory_recent', { limit: 5 }),
    { limit: 5 }
  );
  assert.deepEqual(
    validateWorkerToolInput('personal_memory_recent', {}),
    {}
  );
  assert.deepEqual(
    validateWorkerToolInput('personal_memory_recent', { domain: 'personal', limit: 5 }),
    { domain: 'personal', limit: 5 }
  );
});

test('ChatGPT memory_search shape with optional limit is accepted', () => {
  assert.deepEqual(
    validateToolInput('memory_search', { query: 'Airodrom context memory V2', limit: 5 }),
    { query: 'Airodrom context memory V2', limit: 5 }
  );
  assert.deepEqual(
    validateToolInput('memory_search', { query: 'Airodrom context memory V2' }),
    { query: 'Airodrom context memory V2' }
  );
});

test('memory read contracts still reject unknown keys and out-of-range limits', () => {
  assert.throws(() => validateWorkerToolInput('personal_memory_search', { query: 'x', offset: 1 }), /Invalid personal_memory_search/);
  assert.throws(() => validateWorkerToolInput('personal_memory_search', { query: 'x', limit: 0 }), /Invalid memory limit/);
  assert.throws(() => validateWorkerToolInput('personal_memory_search', { query: 'x', limit: 21 }), /Invalid memory limit/);
  assert.throws(() => validateWorkerToolInput('personal_memory_recent', { domain: 'vault' }), /Invalid memory domain/);
  assert.throws(() => validateToolInput('memory_search', { query: 'x', domain: 'personal' }), /Invalid memory_search/);
  assert.throws(() => validateToolInput('memory_search', { query: 'x', limit: 99 }), /Invalid memory limit/);
  assert.throws(() => validateWorkerToolInput('personal_memory_get', { memoryId: 'm1', limit: 1 }), /Invalid personal_memory_get/);
});

test('q alias for personal_memory_search still normalizes before validation', () => {
  assert.deepEqual(
    validateWorkerToolInput('personal_memory_search', { q: 'alias query', limit: 3 }),
    { query: 'alias query', limit: 3 }
  );
});
