'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AgentAdapterError, AgentRouter, SECURITY_PROFILES } = require('../src/agent-adapter');
const { HostWorkerAdapter, HOST_CAPABILITIES } = require('../src/host-worker-adapter');

test('HostWorkerAdapter exposes deterministic identity, capabilities, and normalized native identities', async () => {
  const calls = [];
  const rpc = {
    running: true,
    async sendCommand(command) {
      calls.push(command);
      if (command.type === 'get_state') return { sessionId: 'host-session-1', sessionFile: '/private/tmp/session.jsonl' };
      if (command.type === 'get_session_stats') return { contextUsage: { tokens: 2, contextWindow: 100 } };
      return {};
    },
    async shutdown() { calls.push({ type: 'shutdown' }); }
  };
  const runtime = { rpc, sessionId: 'host-session-1', runId: 'host-run-1' };
  const bridge = { async _ensureHostRuntime(taskId) { calls.push({ type: 'start', taskId }); return runtime; } };
  const adapter = new HostWorkerAdapter({ bridge });
  const router = new AgentRouter({ adapters: [adapter] });
  const task = { id: 'task-1', executionAgent: 'host' };

  assert.deepEqual(router.describe(task), { id: 'host', label: 'Airodrom host', capabilities: [...HOST_CAPABILITIES] });
  assert.deepEqual(SECURITY_PROFILES, ['safe', 'developer', 'autonomous', 'operator']);
  assert.equal((await router.start(task, { taskId: task.id })).runId, 'host-run-1');
  await router.dispatch(task, { runtime, message: 'continue safely' });
  assert.deepEqual(await router.status(task, { runtime }), {
    state: { sessionId: 'host-session-1', sessionFile: '/private/tmp/session.jsonl' },
    stats: { contextUsage: { tokens: 2, contextWindow: 100 } },
    nativeSessionId: 'host-session-1', nativeExecutionId: 'host-run-1'
  });
  assert.deepEqual(router.normalizeEvent(task, { type: 'tool_execution_start', toolName: 'read' }), {
    type: 'tool_execution_start', toolName: 'read', agentId: 'host', nativeEventType: 'tool_execution_start'
  });
  assert.deepEqual(router.normalizeResult(task, { text: 'done', sessionId: 'host-session-1', runId: 'host-run-1' }), {
    text: 'done', sessionId: 'host-session-1', runId: 'host-run-1', agentId: 'host', nativeSessionId: 'host-session-1', nativeExecutionId: 'host-run-1'
  });
  await router.cancel(task, { runtime });
  await router.shutdown(task, { runtime });
  assert.deepEqual(calls.map(call => call.type), ['start', 'prompt', 'get_state', 'get_session_stats', 'abort', 'shutdown']);
});

test('AgentRouter fails closed for unavailable adapters and HostWorkerAdapter normalizes adapter failures', async () => {
  const adapter = new HostWorkerAdapter({ bridge: { async _ensureHostRuntime() { throw new Error('unused'); } } });
  const router = new AgentRouter({ adapters: [adapter] });
  assert.throws(() => router.resolve({ executionAgent: 'unknown_agent' }), error => error instanceof AgentAdapterError && error.code === 'AGENT_ADAPTER_UNAVAILABLE');
  await assert.rejects(
    router.cancel({ executionAgent: 'host' }, { runtime: { rpc: { sendCommand: async () => { throw new Error('socket closed'); } } } }),
    error => error instanceof AgentAdapterError && error.code === 'AGENT_CANCEL_FAILED'
  );
  assert.throws(() => router.normalizeEvent({ executionAgent: 'host' }, { nope: true }), error => error instanceof AgentAdapterError && error.code === 'AGENT_EVENT_INVALID');
});
