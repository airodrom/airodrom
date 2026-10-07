'use strict';

// Agents execute; the bridge governs.  This module deliberately models only
// the worker boundary. Mission authority, capabilities, approvals, safety,
// lifecycle ownership, acceptance, and auditing remain bridge concerns.

const AGENT_ID = /^[a-z][a-z0-9_-]{1,63}$/;
const SECURITY_PROFILES = Object.freeze(['safe', 'developer', 'autonomous', 'operator']);

class AgentAdapterError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AgentAdapterError';
    this.code = code;
  }
}

function assertAgentId(value) {
  if (typeof value !== 'string' || !AGENT_ID.test(value)) {
    throw new AgentAdapterError('AGENT_ADAPTER_INVALID', 'Agent adapter identity is invalid');
  }
  return value;
}

class AgentAdapter {
  constructor({ id, label } = {}) {
    this.id = assertAgentId(id);
    if (typeof label !== 'string' || !label || label.length > 120) {
      throw new AgentAdapterError('AGENT_ADAPTER_INVALID', 'Agent adapter label is invalid');
    }
    this.label = label;
  }

  identity() { return { id: this.id, label: this.label }; }
  capabilities() { return []; }
  async readiness() { return { agentId: this.id, ready: false, reason: 'not_implemented' }; }
  async start() { throw new AgentAdapterError('AGENT_ADAPTER_UNSUPPORTED', `${this.id} cannot start a task`); }
  async dispatch() { throw new AgentAdapterError('AGENT_ADAPTER_UNSUPPORTED', `${this.id} cannot dispatch a task`); }
  async cancel() { throw new AgentAdapterError('AGENT_ADAPTER_UNSUPPORTED', `${this.id} cannot cancel a task`); }
  async shutdown() { throw new AgentAdapterError('AGENT_ADAPTER_UNSUPPORTED', `${this.id} cannot stop a task`); }
  async status() { throw new AgentAdapterError('AGENT_ADAPTER_UNSUPPORTED', `${this.id} cannot report task status`); }
  normalizeEvent(event) { return { ...event, agentId: this.id, nativeEventType: event?.type || null }; }
  normalizeResult(result) { return { ...result, agentId: this.id, nativeSessionId: result?.sessionId || null, nativeExecutionId: result?.runId || null }; }
}

class AgentRouter {
  constructor({ adapters = [] } = {}) {
    if (!Array.isArray(adapters)) throw new AgentAdapterError('AGENT_ADAPTER_INVALID', 'Agent adapter registry is invalid');
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    if (!(adapter instanceof AgentAdapter)) throw new AgentAdapterError('AGENT_ADAPTER_INVALID', 'Agent adapter must implement the bridge contract');
    require('./removed-runtime').assertExecutable(adapter.id);
    if (this.adapters.has(adapter.id)) throw new AgentAdapterError('AGENT_ADAPTER_INVALID', `Agent adapter is already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    return adapter;
  }

  agentId(taskOrId = null) {
    require('./removed-runtime').assertExecutable(taskOrId);
    const id = typeof taskOrId === 'string' ? taskOrId : taskOrId?.executionAgent || require('./default-runtime').DEFAULT_RUNTIME;
    require('./removed-runtime').assertExecutable(id);
    return assertAgentId(id);
  }

  resolve(taskOrId = null) {
    const id = this.agentId(taskOrId);
    const adapter = this.adapters.get(id);
    if (!adapter) throw new AgentAdapterError('AGENT_ADAPTER_UNAVAILABLE', `Execution agent is unavailable: ${id}`);
    return adapter;
  }

  describe(taskOrId = null) {
    const adapter = this.resolve(taskOrId);
    return { ...adapter.identity(), capabilities: [...adapter.capabilities()] };
  }

  async readiness(task, context) { const adapter = this.resolve(task); return adapter.readiness({ task, ...context }); }
  async start(task, context) { const adapter = this.resolve(task); return adapter.start({ task, ...context }); }
  async dispatch(task, context) { const adapter = this.resolve(task); return adapter.dispatch({ task, ...context }); }
  async cancel(task, context) { const adapter = this.resolve(task); return adapter.cancel({ task, ...context }); }
  async shutdown(task, context) { const adapter = this.resolve(task); return adapter.shutdown({ task, ...context }); }
  async status(task, context) { const adapter = this.resolve(task); return adapter.status({ task, ...context }); }
  normalizeEvent(task, event) { return this.resolve(task).normalizeEvent(event); }
  normalizeResult(task, result) { return this.resolve(task).normalizeResult(result); }
}

module.exports = { AgentAdapter, AgentAdapterError, AgentRouter, SECURITY_PROFILES, assertAgentId };
