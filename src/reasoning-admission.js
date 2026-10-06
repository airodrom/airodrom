'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { LocalOllamaBroker, LOCAL_OLLAMA, LIMITS } = require('./local-ollama-broker');
const digest = value => createHash('sha256').update(value).digest('hex');
const { redactPayload } = require('./event-ledger');
const MODE = 'reasoning_only';

// Host-owned inference decisions are separate from signed execution grants.
// A consumed request is never replayed, including after a crash or restart.
class ReasoningAdmission {
  constructor(bridge, { now = Date.now } = {}) {
    this.bridge = bridge; this.db = bridge.memory.db; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS reasoning_admissions (
      id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, task_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
      probe TEXT, context_hash TEXT NOT NULL, context_bytes INTEGER NOT NULL, provider TEXT NOT NULL,
      mode TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
      UNIQUE(task_id, request_id));`);
    this.db.prepare("UPDATE reasoning_admissions SET state='interrupted' WHERE state IN ('granted','consumed')").run();
    this.active = new Map();
  }
  event(task, suffix, status, extra = {}) {
    this.bridge._ledgerRecord({ ...this.bridge._ledgerContext(task), eventType: `reasoning.admission.${suffix}`,
      agent: 'bridge', direction: 'internal', status,
      metadata: { mode: MODE, provider: 'ollama', execution_authority: 'none', probe: task.reasoningProbe || null, ...extra } }, { critical: true });
  }
  deny(task, reason) {
    this.event(task, 'denied', 'denied', { reason });
    return { allow: false, kind: 'reasoning_admission_denied', reason: `Reasoning admission denied: ${reason}` };
  }
  grant(task, lease, message, requestId) {
    this.event(task, 'requested', 'requested');
    if (task.reasoningMode !== MODE || task.mission.requireGrant || task.capabilityScopes.length ||
        this.bridge.config.provider !== 'ollama' || this.bridge.config.model !== LOCAL_OLLAMA.model ||
        this.bridge.leases.get(task.id) !== lease || task.activeRunId !== lease.runId ||
        !requestId || Buffer.byteLength(message) > 59000) throw Error(this.deny(task, 'invalid_policy_or_binding').reason);
    const id = randomUUID();
    try {
      this.db.prepare('INSERT INTO reasoning_admissions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, task.mission.id, task.id, lease.runId, task.sessionId, requestId, task.reasoningProbe, digest(message),
        Buffer.byteLength(message), 'ollama', MODE, this.now() + LIMITS.timeoutMs, 'granted');
    } catch (error) {
      if (!/UNIQUE/.test(error.message)) throw error;
      throw Error(this.deny(task, 'request_replay').reason);
    }
    this.event(task, 'granted', 'granted', { admission_id: id, context_bytes: Buffer.byteLength(message) });
    return id;
  }
  authorize(task, runtime, runId) {
    const record = this.db.prepare('SELECT * FROM reasoning_admissions WHERE id=?').get(runtime?.admissionId || '');
    const lease = this.bridge.leases.get(task.id);
    if (!record || this.active.get(task.id) !== runtime || this.bridge.tasks.get(task.id) !== task ||
        !lease || lease.aborted || lease.runId !== runId || task.activeRunId !== runId ||
        record.task_id !== task.id || record.mission_id !== task.mission.id || record.run_id !== runId ||
        record.session_id !== task.sessionId || record.request_id !== runtime.requestId ||
        record.probe !== (task.reasoningProbe || null) || record.context_hash !== runtime.contextHash || record.mode !== MODE || record.provider !== 'ollama' ||
        task.reasoningMode !== MODE || task.capabilityScopes.length || task.mission.requireGrant ||
        record.expires_at <= this.now() || record.state !== 'granted' || task.safetyStop?.latched || task.cancelRequested ||
        this.bridge.config.provider !== 'ollama' || this.bridge.config.model !== LOCAL_OLLAMA.model)
      return this.deny(task, 'missing_invalid_expired_or_consumed');
    const consumed = this.db.prepare("UPDATE reasoning_admissions SET state='consumed' WHERE id=? AND state='granted'").run(record.id);
    if (consumed.changes !== 1) return this.deny(task, 'request_replay');
    return { allow: true, source: 'bounded-reasoning-admission-v1' };
  }
  async run(task, message, { recovery = false, timeoutMs = LIMITS.timeoutMs } = {}) {
    const bridge = this.bridge;
    if (bridge.closed || bridge.leases.size || task.cancelRequested || task.safetyStop?.latched ||
        (['cancelled','paused'].includes(task.status) || ['cancelled','paused'].includes(task.mission.status)) || task.continuationRequired ||
        recovery || typeof message !== 'string' || !message.trim() || message.length > 59000)
      throw Error(this.deny(task, 'inactive_or_recovery_or_invalid_context').reason);
    message = redactPayload(message).value.replace(/\b(?:xox[baprs]-|xapp-|crsr_|sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{8,}/g, '[redacted-secret]');
    const lease = bridge.leases.acquire(task.id, { agentId: 'reasoning_provider' });
    task.startedAt = this.now(); task.lastActivityAt = task.startedAt;
    task.activeRunId = lease.runId; task.status = 'running'; task.failureKind = null; task.error = null;
    delete task.reasoningAuthorizationDenied; delete task.reasoningProviderUnavailable; delete task.providerWait;
    task.mission.status = 'active'; task.mission.started = true;
    const started = this.now(); let timer;
    try {
      const remaining = task.mission.budget.maxRuntimeMs - task.mission.used.runtimeMs;
      if (remaining <= 0) throw Error(this.deny(task, 'runtime_budget_exhausted').reason);
      timer = setTimeout(() => lease.controller.abort(), Math.min(timeoutMs, remaining, LIMITS.timeoutMs));
      if(!task.latestMcpRequestId&&this.db.prepare('SELECT 1 FROM reasoning_admissions WHERE task_id=? AND context_hash=?').get(task.id,digest(message)))throw Error(this.deny(task,'request_replay').reason);
      const requestId = task.latestMcpRequestId || randomUUID();
      const admissionId = this.grant(task, lease, message, requestId);
      // Record provider selection independently of agent identity. Existing local
      // admission and broker still own execution; this cannot enable external inference.
      task.providerRouting = bridge.providerGateway?.plan({request_id:requestId,run_id:lease.runId,
        selected_agent:'reasoning_provider',messages:[{role:'user',content:message}],data_class:'internal',
        privacy:'local_only',required_provider:'ollama',requirements:['chat'],max_output:8192}) || null;
      bridge.tasks.save(task);
      bridge.leases.setPhase(lease, 'running');
      const runtime = { admissionId, requestId, contextHash: digest(message), runId: lease.runId };
      this.active.set(task.id, runtime);
      // No memory retrieval, repository context, tools, headers or credentials
      // from a worker. Only operator text crosses the existing bounded broker.
      const payload = { model: LOCAL_OLLAMA.model, stream: true, stream_options: { include_usage: true },
        store: false, max_completion_tokens: 8192, messages: [{ role: 'user', content: message }] };
      const response = new EventEmitter(); let output = ''; let status = 0;
      response.writeHead = code => { status = code; };
      response.write = chunk => { output += chunk.toString(); return true; };
      response.end = chunk => { if (chunk) response.write(chunk); response.writableEnded = true; };
      response.destroy = () => { response.destroyed = true; response.emit('close'); };
      bridge.nativeExecution.prompt(task);
      let broker = bridge.localOllamaBroker;
      if (task.reasoningProbe === 'ollama_unavailable') {
        // Reuse the broker's existing injected-request seam, confined to this
        // explicit diagnostic. Real provider configuration and traffic stay intact.
        broker = new LocalOllamaBroker({ authorize: broker.authorize, isTaskActive: broker.isTaskActive,
          record: entry => bridge.localOllamaBroker.record({ ...entry, probe: 'ollama_unavailable' }),
          request: () => {
            const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = () => {};
            request.end = () => queueMicrotask(() => request.emit('error', new Error('ECONNREFUSED bounded reasoning transport probe')));
            return request;
          } });
      }
      await broker.proxy({ task, runtime, runId: lease.runId, response, signal: lease.controller.signal,
        body: { sessionId: task.sessionId, url: LOCAL_OLLAMA.completionsUrl, method: 'POST', headers: {}, body: JSON.stringify(payload) } });
      if (lease.aborted || task.cancelRequested) throw Error('Reasoning inference cancelled or timed out');
      if (status !== 200 || response.destroyed) {
        if (task.reasoningAuthorizationDenied) throw Error('Reasoning admission denied by inference broker');
        if (/Local Ollama connection failed/.test(output)) throw Error('Local Ollama connection failed');
        throw Error(`Reasoning provider response failed (${status})`);
      }
      let text = '', done = false;
      for (const line of output.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const value = line.slice(5).trim(); if (value === '[DONE]') { done = true; continue; }
        const chunk = JSON.parse(value);
        if (chunk.choices?.some(choice => choice.delta?.tool_calls)) throw Error('Reasoning provider attempted a tool call');
        for (const choice of chunk.choices || []) text += choice.delta?.content || '';
      }
      if (!done || !text.trim()) throw Error('Reasoning provider stream incomplete');
      if(bridge.providerGateway){bridge.providerGateway.registry.observe('ollama','available');
        bridge.providerGateway.reliability.success('ollama:'+LOCAL_OLLAMA.model);
        task.providerRouting={...task.providerRouting,status:'completed',selected_provider:'ollama',selected_model:LOCAL_OLLAMA.model,
          selected_profile:LOCAL_OLLAMA.model,wait_reason:null,provider_rationale:'existing_bounded_local_admission',accepted:false};
        bridge.providerGateway.router.persist(task.providerRouting);}
      task.lastResult = text; task.status = 'idle'; // inference completion is never acceptance
      this.event(task, 'settled', 'completed', { output_bytes: Buffer.byteLength(text), accepted: false });
      return { text };
    } catch (error) {
      task.status = task.cancelRequested ? 'cancelled' : 'failed';
      task.failureKind = /Reasoning admission denied/.test(error.message) ? 'reasoning_admission_denied' : 'reasoning_provider_error';
      task.error = error.message;
      if (!lease.aborted && !task.cancelRequested && task.failureKind !== 'reasoning_admission_denied') bridge.nativeExecution.providerFailure(task, error);
      if (task.status === 'waiting_for_provider') this.event(task, 'provider_unavailable', 'waiting_for_provider', { reason: 'ollama_unavailable' });
      throw error;
    } finally {
      clearTimeout(timer); this.active.delete(task.id);
      this.db.prepare("UPDATE reasoning_admissions SET state='settled' WHERE run_id=? AND state IN ('granted','consumed')").run(lease.runId);
      bridge.leases.releaseIfOwner(lease, { verified: true }); delete task.activeRunId;
      task.mission.used.runtimeMs += Math.max(0, this.now() - started);
      bridge.tasks.save(task); bridge.emit('change');
    }
  }
}
module.exports = { ReasoningAdmission, MODE };
