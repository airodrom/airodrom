'use strict';

const { EventEmitter } = require('node:events');
const { config, LEVEL1_PROFILE_ID, WORKSPACE, assertReadOnlyMission, taskDefinition } = require('./level1-profile');

const EVIDENCE_LABEL = 'LEVEL1_RESTRICTED_WORKER';

function exactArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

/**
 * Deterministic Level 1 transport worker. It has
 * no model, child-process, filesystem, network, credential, or service API.
 * Its only authority is the opaque broker-read callback supplied by the host.
 */
class Level1RestrictedWorker extends EventEmitter {
  constructor({ task, executeRead } = {}) {
    super();
    if (!task || typeof executeRead !== 'function') throw new Error('Restricted worker requires a task and brokered read callback');
    this.task = task;
    this.executeRead = executeRead;
    this.running = false;
    this.prompted = false;
    this.aborted = false;
    this.closed = false;
  }

  _readPath() {
    const mission = this.task.mission;
    if (config.restrictedWorker?.evidenceLabel !== EVIDENCE_LABEL || config.restrictedWorker?.agentWorkerEnabled !== false || config.restrictedWorker?.allowedCapability !== 'read' || config.restrictedWorker?.allowedOperationsPerTask !== 1 || !mission || mission.level !== 1 || mission.capabilityProfile !== LEVEL1_PROFILE_ID || mission.executionWorker !== EVIDENCE_LABEL || mission.requireGrant !== true || this.task.workspace !== WORKSPACE || !assertReadOnlyMission(mission)) {
      throw new Error('Invalid restricted-worker Level 1 task binding');
    }
    const definition = taskDefinition(mission.level1Phase, mission.level1Phase === 'task_b' ? mission.selectedTaskBId : null);
    if (mission.level1TaskId !== definition.taskId || !exactArray(mission.readOnlyPaths, definition.readOnlyPaths)) throw new Error('Restricted worker task does not match the signed Level 1 read scope');
    return definition.readOnlyPaths[0];
  }

  async start() {
    if (this.closed) throw new Error('Restricted worker is closed');
    this._readPath();
    this.running = true;
    return { sessionId: this.task.sessionId, sessionFile: null, model: null, executionWorker: EVIDENCE_LABEL };
  }

  sendCommand(command) {
    if (!command || typeof command !== 'object' || !['get_state', 'get_session_stats', 'prompt', 'abort'].includes(command.type)) return Promise.reject(new Error('Restricted worker command is not allowed'));
    if (!this.running || this.closed) return Promise.reject(new Error('Restricted worker is not running'));
    if (command.type === 'get_state') return Promise.resolve({ sessionId: this.task.sessionId, sessionFile: null, model: null, executionWorker: EVIDENCE_LABEL });
    if (command.type === 'get_session_stats') return Promise.resolve({ contextUsage: null, executionWorker: EVIDENCE_LABEL });
    if (command.type === 'abort') { this.aborted = true; return Promise.resolve({}); }
    if (this.prompted) return Promise.reject(new Error('Restricted worker permits one deterministic read only'));
    if (typeof command.message !== 'string' || !command.message.trim()) return Promise.reject(new Error('Restricted worker requires a plain-text host instruction'));
    this.prompted = true;
    queueMicrotask(() => this._run());
    return Promise.resolve({});
  }

  async _run() {
    const event = value => this.emit('event', { ...value, executionWorker: EVIDENCE_LABEL });
    event({ type: 'agent_start' });
    if (this.aborted) return this._settleError(event, new Error('Restricted worker was aborted'));
    let readPath;
    try { readPath = this._readPath(); }
    catch (error) { return this._settleError(event, error); }
    event({ type: 'tool_execution_start', toolName: 'read' });
    try {
      const result = await this.executeRead({ toolName: 'read', input: { path: readPath } });
      if (!result || result.allow !== true || typeof result.output !== 'string') throw new Error(result?.decision?.reason || 'Restricted worker broker read was denied');
      event({ type: 'tool_execution_end', toolName: 'read', isError: false });
      event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: result.output }], stopReason: 'stop' } });
      event({ type: 'agent_settled' });
    } catch (error) {
      event({ type: 'tool_execution_end', toolName: 'read', isError: true });
      this._settleError(event, error);
    }
  }

  _settleError(event, error) {
    const message = String(error?.message || error).slice(0, 500);
    event({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: message }, isError: true });
    event({ type: 'agent_settled', isError: true });
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.running = false;
    this.emit('exit', { code: 0, signal: null, executionWorker: EVIDENCE_LABEL });
  }
}

module.exports = { Level1RestrictedWorker, EVIDENCE_LABEL };
