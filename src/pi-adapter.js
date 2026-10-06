'use strict';

const { AgentAdapter, AgentAdapterError } = require('./agent-adapter');

const PI_CAPABILITIES = Object.freeze([
  'session_lifecycle', 'continuations', 'rpc_events', 'brokered_capability_requests', 'cancellation', 'status'
]);

function runtimeRpc(runtime) {
  if (!runtime?.rpc || typeof runtime.rpc.sendCommand !== 'function') {
    throw new AgentAdapterError('AGENT_RUNTIME_INVALID', 'Pi runtime is unavailable');
  }
  return runtime.rpc;
}

/**
 * Pi's transport-specific implementation of the generic worker boundary.
 * It owns no policy decision: every tool request still reaches the bridge's
 * safety extension and CapabilityBroker over the existing task-bound channel.
 */
class PiAdapter extends AgentAdapter {
  constructor({ bridge } = {}) {
    super({ id: 'pi', label: 'Pi' });
    if (!bridge || typeof bridge._ensurePiRuntime !== 'function') {
      throw new AgentAdapterError('AGENT_ADAPTER_INVALID', 'Pi adapter requires the bridge runtime factory');
    }
    this.bridge = bridge;
  }

  contextPacket(pack) { const db=this.bridge.controlStore?.db||this.bridge.memory?.db;if(db&&!require('./memory-erasure').packetUsable(db,pack))throw new AgentAdapterError('MEMORY_CONTEXT_ERASED','Pi memory context is unavailable');return require('./architecture-memory').packet(pack); }

  capabilities() { return PI_CAPABILITIES; }

  async readiness({ runtime } = {}) {
    const rpc = runtimeRpc(runtime);
    return { agentId: this.id, ready: rpc.running === true, nativeSessionId: runtime.sessionId || null, nativeExecutionId: runtime.runId || null };
  }

  async start({ taskId } = {}) {
    if (typeof taskId !== 'string' || !taskId) throw new AgentAdapterError('AGENT_TASK_INVALID', 'Pi task identity is invalid');
    return this.bridge._ensurePiRuntime(taskId);
  }

  async dispatch({ runtime, message } = {}) {
    const db=this.bridge.controlStore?.db||this.bridge.memory?.db;if(db)require('./memory-content-erasure').assertReadable(db);
    if (typeof message !== 'string' || !message) throw new AgentAdapterError('AGENT_DISPATCH_INVALID', 'Pi instruction is invalid');
    let packet;try{packet=JSON.parse(message);}catch{/* Plain operator messages carry no packet identity. */}
    if(packet&&require('./memory-identity').hasLegacyIdentifiers(packet))throw new AgentAdapterError('MEMORY_CONTEXT_ERASED','Pi legacy memory context is unavailable');
    return runtimeRpc(runtime).sendCommand({ type: 'prompt', message });
  }

  async cancel({ runtime } = {}) {
    try { return await runtimeRpc(runtime).sendCommand({ type: 'abort' }); }
    catch (error) { throw new AgentAdapterError('AGENT_CANCEL_FAILED', 'Pi cancellation could not be delivered', { cause: error }); }
  }

  async shutdown({ runtime } = {}) {
    const rpc = runtimeRpc(runtime);
    if (typeof rpc.shutdown !== 'function') throw new AgentAdapterError('AGENT_RUNTIME_INVALID', 'Pi runtime cannot be stopped');
    return rpc.shutdown();
  }

  async status({ runtime } = {}) {
    const rpc = runtimeRpc(runtime);
    const [state, stats] = await Promise.all([
      rpc.sendCommand({ type: 'get_state' }),
      rpc.sendCommand({ type: 'get_session_stats' })
    ]);
    return {
      state, stats,
      nativeSessionId: state?.sessionId || runtime.sessionId || null,
      nativeExecutionId: runtime.runId || null
    };
  }

  normalizeEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      throw new AgentAdapterError('AGENT_EVENT_INVALID', 'Pi emitted an invalid event');
    }
    return { ...event, agentId: this.id, nativeEventType: event.type };
  }

  normalizeResult(result) {
    if (!result || typeof result !== 'object' || typeof result.sessionId !== 'string') {
      throw new AgentAdapterError('AGENT_RESULT_INVALID', 'Pi returned an invalid result');
    }
    return { ...result, agentId: this.id, nativeSessionId: result.sessionId, nativeExecutionId: result.runId || null };
  }
}

module.exports = { PiAdapter, PI_CAPABILITIES };
