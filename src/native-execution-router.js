'use strict';

// Classification never interprets prompt text or grants execution authority.
// Native calls delegate to the existing broker and durable invocation owner.
class NativeExecutionRouter {
  constructor(bridge) { this.bridge = bridge; }
  capabilityPath(name) {
    return ['claude_code_run_task', 'cursor_run_task'].includes(name) ? 'agent_direct' : 'native_capability';
  }
  record(task, path, metadata = {}) {
    this.bridge._ledgerRecord({ ...this.bridge._ledgerContext(task), eventType: 'execution.dispatch.classified',
      agent: 'bridge', direction: 'internal', status: 'classified',
      metadata: { dispatch_path: path, provider: path === 'reasoning_provider' ? this.bridge.config?.provider || 'configured' : null, ...metadata } }, { critical: true });
  }
  async capability(taskId, request, options) {
    const task = this.bridge.tasks.get(taskId);
    this.record(task, this.capabilityPath(request.input?.name), { capability: request.input?.name || null, tool_name: request.toolName, tool_call_id: request.toolCallId || null });
    return this.bridge.capabilityBroker.execute(taskId, request, options);
  }
  prompt(task) {
    const path = task.mission?.acceptanceMode ? 'verification_native' : task.mission?.capabilityProfile === require('./level1-profile').LEVEL1_PROFILE_ID ? 'native_workflow' : 'reasoning_provider';
    this.record(task, path);
    return path;
  }
  providerFailure(task, error) {
    // Policy/grant denials, protocol failures, and arbitrary worker exits remain
    // failures. Only recognized local transport unavailability is degradable.
    if(task.reasoningAuthorizationDenied){task.failureKind='mission_grant_denied';task.providerWait=null;return false;}
    if (this.bridge.config?.provider !== 'ollama' || !(task.reasoningProviderUnavailable === true || /Local Ollama inference is unavailable for this task|Ollama (?:is )?unavailable|Local Ollama connection failed/i.test(String(error?.message || '')))) return false;
    task.status = 'waiting_for_provider';
    task.failureKind = 'ollama_unavailable';
    task.providerWait = { provider: 'ollama', reason: 'ollama_unavailable', fallback: 'none', automatic_switch: false };
    this.record(task, 'reasoning_provider', { reason: 'ollama_unavailable', fallback: 'none', automatic_switch: false });
    return true;
  }
}
module.exports = { NativeExecutionRouter };
