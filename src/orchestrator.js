'use strict';

// Direct orchestrator entry point: ChatGPT names a typed capability over MCP and
// the bridge executes it in an existing task's identity and scopes. This module
// is only an entry point. Execution, central policy, scopes, exact one-shot
// approvals, mission budgets and Event Ledger capability events all stay in the
// shared CapabilityBroker path that Pi worker calls use. No model is involved.

const { createHash, randomUUID } = require('node:crypto');

const TOOL_CALL_PREFIX = 'orchestrator:';
const MAX_INVOCATIONS_PER_TASK = 256;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESULT_CHARS = 256 * 1024;
const MAX_LAST_RESULT_CHARS = 24_000;
const SYNC_BUDGET_MS = 10_000;
const REPLAY_CACHE_ENTRIES = 128;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

// Key-sorted JSON, so the idempotency fingerprint ignores property order.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function plainInput(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Capability input must be a JSON object');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_INPUT_BYTES) throw new Error('Capability input exceeds 64 KiB');
  return value;
}

class Orchestrator {
  constructor(bridge, { syncBudgetMs = SYNC_BUDGET_MS, now = () => Date.now() } = {}) {
    this.bridge = bridge; this.syncBudgetMs = syncBudgetMs; this.now = now;
    this.inflight = new Map();
    this.results = new Map();
  }

  // Resolve the persisted invocation relationship. Unseen requests have no
  // tool call identity; allocation happens once while recording new intent.
  toolCallIdFor(taskId, requestId) {
    const id = this.bridge.tasks.get(taskId).capabilityInvocations?.[requestId]?.toolCallId;
    if (id && !/^orchestrator:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Legacy tool call identity requires migration');
    return id || null;
  }
  isOrchestratorCall(toolCallId) { return typeof toolCallId === 'string' && toolCallId.startsWith(TOOL_CALL_PREFIX); }

  requestIdFor(task, toolCallId) {
    if (!this.isOrchestratorCall(toolCallId)) return null;
    for (const [requestId, record] of Object.entries(task?.capabilityInvocations || {})) if (record.toolCallId === toolCallId) return requestId;
    return null;
  }

  _find(requestId) {
    for (const task of this.bridge.tasks.list()) {
      const record = task.capabilityInvocations?.[requestId];
      if (record) return { task, record };
    }
    return null;
  }

  _remember(requestId, response) {
    this.results.delete(requestId);
    this.results.set(requestId, response);
    while (this.results.size > REPLAY_CACHE_ENTRIES) this.results.delete(this.results.keys().next().value);
  }

  async invoke(taskId, { name, input, requestId, brokerTool = null }) {
    if (brokerTool && (!require('./capability-broker').BROKER_TOOLS.has(brokerTool) || brokerTool === 'capability')) throw new Error('Unknown native broker tool');
    const bridge = this.bridge;
    if (bridge.closed) throw new Error('Bridge is stopped; poll health before retrying');
    const identity = require('./memory-identity');
    const db = bridge.controlStore?.db || bridge.memory?.db;
    if (db) require('./memory-content-erasure').assertReadable(db);
    if (identity.hasLegacyIdentifiers({ request_id: requestId })) throw new Error('Legacy request identity requires migration');
    const task = bridge.tasks.get(taskId);
    const payload = plainInput(input);
    const fingerprint = sha256(canonical(brokerTool ? [task.id, name, payload, brokerTool] : [task.id, name, payload]));
    const durable = bridge.controlStore?.invocation(requestId);
    if (durable) {
      if (durable.task_id !== task.id || durable.fingerprint !== fingerprint) {
        bridge._ledgerRecord({ ...bridge._ledgerContext(task), eventType: 'orchestrator.capability.conflict', agent: 'chatgpt', direction: 'incoming', status: 'rejected', metadata: { capability: name, request_id: requestId, reason: 'request_id reused with a different invocation' } });
        const error = new Error('Idempotency conflict: request_id was already used with a different invocation; nothing was executed');
        error.code = 'IDEMPOTENCY_CONFLICT'; throw error;
      }
      const live = this.inflight.get(requestId);
      if (live) return this._within(task, requestId, live, true);
      if (durable.state === 'settled') {
        const response = { ...durable.result, duplicate: true, result_recoverable: true };
        // An old receipt is evidence, never a transferable approval.
        if (response.approval) {
          const current = bridge.policy.approvals.get(response.approval.approval_id);
          response.approval = { ...response.approval, status: current?.status || 'expired' };
        }
        return response;
      }
      return { task_id: task.id, request_id: requestId, capability: name, duplicate: true,
        status: 'unknown', result: null, result_untrusted: true,
        note: 'Dispatch may have occurred. Reconcile the recorded job or workspace; this request will never execute again.' };
    }
    const existing = this._find(requestId);
    if (existing) {
      if (existing.task.id !== task.id || existing.record.fingerprint !== fingerprint) {
        bridge._ledgerRecord({ ...bridge._ledgerContext(task), eventType: 'orchestrator.capability.conflict', agent: 'chatgpt', direction: 'incoming', status: 'rejected', metadata: { capability: name, request_id: requestId, reason: 'request_id reused with a different invocation' } });
        const error = new Error('Idempotency conflict: request_id was already used with a different invocation; nothing was executed');
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
      }
      return this._replay(task, requestId, existing.record);
    }
    if (payload.wait === true) throw new Error('Direct invocations are asynchronous: omit wait and poll the capability\'s status');
    if (Object.keys(task.capabilityInvocations || {}).length >= MAX_INVOCATIONS_PER_TASK) throw new Error(`Task reached ${MAX_INVOCATIONS_PER_TASK} direct capability invocations; create a new task`);
    // The per-task lease excludes a concurrent Pi turn on this task and makes
    // busy truthful while the capability runs.
    let lease;
    try { lease = bridge.leases.acquire(task.id, { agentId: 'bridge' }); }
    catch { throw new Error('Task is running; wait for it to settle before invoking capabilities directly'); }

    const toolCallId = `${TOOL_CALL_PREFIX}${randomUUID()}`;
    const record = { fingerprint, capability: name, brokerTool, toolCallId, state: 'running', requestedAt: this.now() };
    task.capabilityInvocations = { ...(task.capabilityInvocations || {}), [requestId]: record };
    task.latestMcpRequestId = requestId;
    task.activeRunId = lease.runId; task.status = 'running'; task.lastActivityAt = this.now();
    try {
      // Persist intent before any capability side effect. An uncertain receipt is never replayed.
      bridge.controlStore?.beginInvocation(task.id, requestId, fingerprint);
      // Fail closed: an orchestrator request that cannot be audited never runs.
      bridge._ledgerRecord({
        ...bridge._ledgerContext(task), eventType: 'orchestrator.capability.requested', agent: 'chatgpt', direction: 'incoming', status: 'received',
        metadata: { capability: name, request_id: requestId, tool_call_id: toolCallId, task_scopes: bridge.capabilityHost.taskScopes(task), input_fields: Object.keys(payload).slice(0, 32) },
        idempotencyKey: `orchestrator-capability:${toolCallId.slice(TOOL_CALL_PREFIX.length)}`
      }, { critical: true });
    } catch (error) {
      delete task.capabilityInvocations[requestId];
      this._release(task, lease);
      task.status = 'blocked'; task.error = 'Event ledger is unavailable; capability was not executed';
      bridge.tasks.save(task); bridge.emit('change');
      throw new Error(`${task.error}: ${error.message}`);
    }
    bridge.tasks.save(task); bridge.emit('change');
    const execution = this._execute(task, lease, record, requestId, name, payload).finally(() => this.inflight.delete(requestId));
    this.inflight.set(requestId, execution);
    return this._within(task, requestId, execution, false);
  }

  _release(task, lease) {
    this.bridge.leases.releaseIfOwner(lease, { verified: true });
    if (task.activeRunId === lease.runId) delete task.activeRunId;
  }

  // Answer inside the MCP client's timeout. A slower capability keeps running;
  // the same request_id later recovers its result without executing again.
  _within(task, requestId, execution, duplicate) {
    let timer;
    const pending = new Promise(resolve => {
      timer = setTimeout(() => resolve({ task_id: task.id, request_id: requestId, duplicate, status: 'pending', next: 'Re-send capability_invoke with the same request_id to recover the result; it will not execute again.' }), this.syncBudgetMs);
      timer.unref?.();
    });
    return Promise.race([execution.then(response => (duplicate ? { ...response, duplicate: true } : response)), pending]).finally(() => clearTimeout(timer));
  }

  async _execute(task, lease, record, requestId, name, input) {
    const bridge = this.bridge;
    let result;
    try {
      const request = { toolName: record.brokerTool || 'capability', input: record.brokerTool ? input : { name, input }, toolCallId: record.toolCallId };
      result = await (bridge.nativeExecution ? bridge.nativeExecution.capability(task.id, request, {signal:lease.controller.signal}) : bridge.capabilityBroker.execute(task.id, request, {signal:lease.controller.signal}));
    } catch (error) {
      result = { allow: false, executionFailed: true, decision: { allow: false, kind: 'execution_failed', reason: String(error?.message || error).slice(0, 500) } };
    }
    try {
      const decision = result.decision || {};
      if (!result.allow && !result.executionFailed) bridge._recordPolicyDenial(task, { toolName: record.brokerTool || 'capability', toolCallId: record.toolCallId }, decision);
      const kind = result.allow ? null : decision.kind || 'execution_failed';
      task.status = result.allow ? 'completed' : kind === 'approval_required' ? 'approval_required' : result.executionFailed ? 'failed' : 'blocked';
      task.lastRunBlocked = !result.allow && !result.executionFailed;
      task.failureKind = result.allow ? null : kind;
      task.error = result.allow ? null : String(decision.reason || 'Capability was not executed').slice(0, 500);
      if (result.allow) task.lastBlockedAction = null;
      const response = this._response(task, requestId, name, result, record.brokerTool);
      task.lastResult = JSON.stringify({ capability: name, request_id: requestId, status: response.status, result: response.result }).slice(0, MAX_LAST_RESULT_CHARS);
      task.lastSettledAt = this.now(); task.lastActivityAt = task.lastSettledAt;
      record.state = 'settled';
      record.outcome = { status: response.status, allow: result.allow === true, kind, approval_id: response.approval?.approval_id || null, output_sha256: response.output_sha256, settledAt: task.lastSettledAt };
      bridge.controlStore?.finishInvocation(requestId, response);
      this._remember(requestId, response);
      return response;
    } finally {
      this._release(task, lease);
      bridge.tasks.save(task); bridge.emit('change');
    }
  }

  _response(task, requestId, name, result, brokerTool = null) {
    const decision = result.decision || {};
    let executed = null, resultText = null;
    if (result.allow && typeof result.output === 'string') {
      try { executed = JSON.parse(result.output); } catch { resultText = result.output; }
    }
    let body = executed ? (brokerTool ? executed : executed.result ?? null) : resultText;
    let truncated = false;
    const serialized = body === null ? '' : JSON.stringify(body);
    if (serialized.length > MAX_RESULT_CHARS) { body = serialized.slice(0, MAX_RESULT_CHARS); truncated = true; }
    const approvalId = decision.approvalId || null;
    const approval = approvalId ? this.bridge.policy.approvals.get(approvalId) : null;
    return {
      task_id: task.id, request_id: requestId, capability: name, duplicate: false,
      status: result.allow ? 'completed' : decision.kind === 'approval_required' ? 'approval_required' : result.executionFailed ? 'failed' : 'denied',
      allow: result.allow === true,
      decision: {
        policy_decision: executed?.decision || decision.policy_decision || (result.allow ? null : decision.kind === 'approval_required' ? 'approval_required' : 'deny'),
        kind: result.allow ? null : decision.kind || null,
        automatic: decision.automatic === true || decision.policy_automatic === true,
        risk_class: executed?.risk_class || decision.policy_risk_class || decision.capabilityAssessment?.risk_class || null,
        policy_version: decision.policy_version || null,
        reason: result.allow ? null : String(decision.reason || '').slice(0, 500) || null
      },
      approval: approval ? { approval_id: approval.id, status: approval.status, fingerprint: approval.fingerprint, expires_at: approval.expiresAt, instructions: 'The local operator must review and click Approve once & retry in Control Center. The exact captured invocation then runs once; nothing is reconstructed.' } : null,
      scope: executed?.scope || null,
      duration_ms: Number.isFinite(executed?.duration_ms) ? executed.duration_ms : null,
      result: body,
      result_untrusted: true,
      result_truncated: truncated,
      output_sha256: typeof result.output === 'string' ? sha256(result.output) : null
    };
  }

  _replay(task, requestId, record) {
    if (record.state === 'running') {
      const execution = this.inflight.get(requestId);
      if (execution) return this._within(task, requestId, execution, true);
      return { task_id: task.id, request_id: requestId, capability: record.capability, duplicate: true, status: 'unknown', result: null, result_untrusted: true, note: 'The bridge restarted before this invocation settled. It is never re-executed; inspect get_task_status and Control Center.' };
    }
    const cached = this.results.get(requestId);
    const approvalId = record.outcome?.approval_id || cached?.approval?.approval_id || null;
    const approval = approvalId ? this.bridge.policy.approvals.get(approvalId) : null;
    const approvalView = approval ? { ...(cached?.approval || {}), approval_id: approval.id, status: approval.status, fingerprint: approval.fingerprint, expires_at: approval.expiresAt } : cached?.approval || null;
    const resume = record.approvalResume ? { ...record.approvalResume, result: this.results.get(`${requestId}#approval-resume`)?.result ?? null, result_untrusted: true } : null;
    if (cached) return { ...cached, duplicate: true, approval: approvalView, ...(resume ? { approval_resume: resume } : {}) };
    return {
      task_id: task.id, request_id: requestId, capability: record.capability, duplicate: true, status: record.outcome?.status || 'unknown',
      allow: record.outcome?.allow === true, approval: approvalView, ...(resume ? { approval_resume: resume } : {}),
      result: null, result_untrusted: true, result_recoverable: false, output_sha256: record.outcome?.output_sha256 || null,
      note: 'The full result is held in memory only and was not retained across a bridge restart. The invocation was not executed again.'
    };
  }

  // Called after the operator's exact one-shot approval executes the captured
  // invocation through the existing resume path.
  recordApprovalResume(task, approval, result) {
    const requestId = this.requestIdFor(task, approval?.toolCallId);
    const record = requestId ? task.capabilityInvocations?.[requestId] : null;
    if (!record) return;
    const response = this._response(task, requestId, record.capability, result || { allow: false, decision: {} }, record.brokerTool);
    record.approvalResume = { approval_id: approval.id, status: response.status, allow: response.allow, kind: response.decision.kind, output_sha256: response.output_sha256, at: this.now() };
    const durable = this.bridge.controlStore?.invocation(requestId);
    if (durable?.result) this.bridge.controlStore.finishInvocation(requestId, {
      ...durable.result, approval_resume: { ...record.approvalResume, result: response.result, result_untrusted: true }
    });
    this._remember(`${requestId}#approval-resume`, response);
    this.bridge.tasks.save(task);
  }
}

module.exports = { Orchestrator, TOOL_CALL_PREFIX, canonical };
