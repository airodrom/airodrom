'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyStderrClass, classifyProcessFailure } = require('../src/apps/opencode-adapter');
const { runtime } = require('./fixtures/opencode-fixture.cjs');

test('process failure classifier preserves exit, signal, overflow and recognized stderr classes', () => {
  assert.equal(classifyProcessFailure({ timedOut: true, code: 1 }), 'opencode_timeout');
  assert.equal(classifyProcessFailure({ cancelled: true, code: 1 }), 'opencode_cancelled');
  assert.equal(classifyProcessFailure({ overflow: true, code: 0 }), 'opencode_output_bound');
  assert.equal(classifyProcessFailure({ code: 7 }, null), 'opencode_process_exit_nonzero');
  assert.equal(classifyProcessFailure({ code: null, signal: 'SIGTERM' }, null), 'opencode_process_signal');
  assert.equal(classifyProcessFailure({ code: 1 }, 'sandbox_denied'), 'opencode_sandbox_denied');
  assert.equal(classifyProcessFailure({ code: 1 }, 'provider_unavailable'), 'opencode_provider_unavailable');
  assert.equal(classifyProcessFailure({ code: 1 }, 'runtime_configuration_failed'), 'opencode_runtime_configuration_failed');
  assert.equal(classifyProcessFailure({ code: null, signal: null }, null), 'opencode_process_failed');
  // Lifecycle and signal outrank stderr pattern matches.
  assert.equal(classifyProcessFailure({ timedOut: true, code: 1, signal: 'SIGKILL' }, 'sandbox_denied'), 'opencode_timeout');
  assert.equal(classifyProcessFailure({ cancelled: true, code: null, signal: 'SIGTERM' }, 'provider_unavailable'), 'opencode_cancelled');
  assert.equal(classifyProcessFailure({ overflow: true, code: 1 }, 'runtime_configuration_failed'), 'opencode_output_bound');
  assert.equal(classifyProcessFailure({ code: 1, signal: 'SIGTERM' }, 'sandbox_denied'), 'opencode_process_signal');
});

test('stderr classifier matches only recognized patterns and never returns raw text', () => {
  assert.equal(classifyStderrClass('sandbox_apply: Operation not permitted'), 'sandbox_denied');
  assert.equal(classifyStderrClass('Error: connect ECONNREFUSED 127.0.0.1:11434'), 'provider_unavailable');
  assert.equal(classifyStderrClass('Unknown option --standalone'), 'runtime_configuration_failed');
  assert.equal(classifyStderrClass('token=syntheticFailureSecret'), null);
  const secret = 'sk-ant-syntheticFailureSecret';
  const classified = classifyStderrClass(`provider unavailable ${secret}`);
  assert.equal(classified, 'provider_unavailable');
  assert.equal(typeof classified, 'string');
  assert.doesNotMatch(classified, /sk-ant|synthetic/);
});

test('fixture launches classify sandbox, provider and configuration failures without leaking stderr', async t => {
  const f = runtime(t);
  await assert.rejects(f.adapter.execute({ ...f.request, objective: 'sandbox-denied' }), error => {
    assert.equal(error.code, 'opencode_sandbox_denied');
    assert.doesNotMatch(error.message, /Operation not permitted|sandbox_apply|synthetic/);
    return true;
  });
  await assert.rejects(f.adapter.execute({ ...f.request, objective: 'provider-unavailable' }), error => {
    assert.equal(error.code, 'opencode_provider_unavailable');
    assert.doesNotMatch(error.message, /11434|ECONNREFUSED|synthetic/);
    return true;
  });
  await assert.rejects(f.adapter.execute({ ...f.request, objective: 'runtime-config' }), error => {
    assert.equal(error.code, 'opencode_runtime_configuration_failed');
    assert.doesNotMatch(error.message, /Unknown option|synthetic/);
    return true;
  });
  await assert.rejects(f.adapter.execute({ ...f.request, objective: 'nonzero' }), error => {
    assert.equal(error.code, 'opencode_process_exit_nonzero');
    assert.doesNotMatch(JSON.stringify(error), /syntheticFailureSecret/);
    return true;
  });
});
