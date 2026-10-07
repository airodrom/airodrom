'use strict';
// ADR 0007: an authenticated operator may register one inference turn, never tools.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { transaction, fingerprint, object, text, identifier } = require('./control-plane-store');
const { workspaceSnapshot } = require('./control-context');
const PROFILE = 'bounded-conversation-v1';
const MAX_RUNTIME = 120000;
const STALE_CONTEXT = 'Memory context changed; create a fresh task.';
function projectRead(bridge, taskId, value, missionId = null) {
  const m=(taskId&&bridge.controlStore.missionForTask(taskId))||(missionId&&bridge.controlStore.getMission(missionId));
  if(m?.envelope.kind!=='conversation')return value;
  try {
    const task=bridge.tasks.get(m.task_id);
    if(!task.contextPackId)throw Error('Context is not available');
    bridge.opencodeAdapter.authorizedContext({id:task.contextPackId});
    return value;
  } catch { return {status:'unavailable',summary:STALE_CONTEXT,context_current:false,untrusted:true,accepted:false}; }
}
function projectEvent(bridge,event) {
  const payload=projectRead(bridge,event.task_id,event.payload,event.mission_id);
  return payload===event.payload?event:{...event,payload,metadata:{context_current:false}};
}
function memoryQuery(message) {
  const words = message.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  const stop = new Set('what who where when why how is are was were do does did a an the my our your me you i please tell ask using use personal memory remember saved from about it this only answer current synthetic return json summary with must be equal exactly and or to in of'.split(' '));
  return [...new Set(words.filter(w => !stop.has(w)))].slice(0, 8).join(' ');
}
function subjectFor(content) {
  const match = /^(?:my|our|the)\s+(.{1,100}?)\s+(?:is|are)\s+/i.exec(content);
  return (match ? match[1] : content.slice(0, 120)).trim().toLowerCase();
}
function assertContract(service, mission) {
  const e = mission.envelope, c = service.program.contract(mission.id);
  if (e.kind !== 'conversation' || !c?.signed || c.manifest.profile !== PROFILE || c.manifest.expires_at <= Date.now() || e.allowed_files.length || e.capability_scopes.length || e.fallback_agents.length || e.preferred_agent !== 'opencode' || e.authority?.level !== 'read_only' || e.authority.filesystem.read.length || e.authority.filesystem.write.length || e.dispatch_policy?.privacy !== 'local_only' || JSON.stringify(e.dispatch_policy.providers) !== '["local"]' || JSON.stringify(e.dispatch_policy.billing_classes) !== '["local"]' || fingerprint(c.manifest) !== fingerprint(e.manifest)) throw Error('Bounded conversation authority is unavailable or changed.');
  const expected = contract(c.manifest.expires_at);
  if (fingerprint(expected) !== fingerprint(c.manifest)) throw Error('Bounded conversation scope changed.');
  const expectedAuthority = { version: 1, level: 'read_only', label: 'Read Only', permissions: { repository: [], runtime: [], network: ['localhost'], secrets: [], data: [] }, filesystem: { read: [], write: [] }, expiresAt: c.manifest.expires_at };
  const grant = service.db.prepare('SELECT ceiling FROM cp_grants WHERE id=? AND mission_id=?').get(mission.grant_id, mission.id);
  if (!grant || fingerprint(e.authority) !== fingerprint(expectedAuthority) || fingerprint(JSON.parse(grant.ceiling).mission_authority) !== fingerprint(expectedAuthority)) throw Error('Bounded conversation permission ceiling changed.');
  const task = service.bridge.tasks.get(mission.task_id);
  if (task.controlPlaneMissionId !== mission.id || task.workspace !== e.workspace || task.executionAgent !== e.preferred_agent || task.capabilityScopes.length || task.requiredExecutionKind !== 'reasoning' || task.safetyStop?.latched || task.cancelRequested) throw Error('Bounded conversation task binding changed.');
  if (task.contextPackId) {
    const binding=service.db.prepare('SELECT context_pack_id FROM cp_mission_tasks WHERE task_id=? AND mission_id=?').get(task.id,mission.id);
    const pack=service.bridge.controlContext.inspect(task.contextPackId);
    const run=service.store.run(pack.run_id);
    if(binding?.context_pack_id!==pack.id || pack.mission_id!==mission.id || run?.task_id!==task.id || run.mission_id!==mission.id)throw Error('Bounded conversation context binding changed.');
    const current=service.bridge.opencodeAdapter.authorizedContext({id:pack.id});
    if(current.records.length>(e.include_memory?1:0) || Buffer.byteLength(JSON.stringify(current))>2000)throw Error('Bounded conversation context exceeded its scope.');
  }
  if (workspaceSnapshot(e.workspace).hash !== e.baseline.hash) throw Error('Conversation workspace changed.');
}
function contract(expires_at) {
  return { profile: PROFILE, expires_at, permissions: { filesystem: { read: false, write: false }, memory: { read: true, search: true }, network: { localhost: true, internet: false }, providers: { local_reasoning: true, approved_external: false } }, budget: { max_runtime_ms: MAX_RUNTIME, max_prompt_turns: 1, max_memory_injections: 1, max_memory_bytes: 2000, max_commits: 0, max_external_reasoning_calls: 0 } };
}
function create(service, input, owner = 'operator') {
  if (owner !== 'operator') throw Error('Authenticated local operator registration is required.');
  object(input, ['request_id', 'message', 'task_id', 'include_memory', 'runtime']);
  identifier(input.request_id); text(input.message, 'conversation message', 4000);
  if (/^\s*[/!@]/.test(input.message) || require('./personal-memory').containsSecret(input.message)) throw Error('Plain non-secret conversation text is required.');
  if (input.include_memory !== undefined && typeof input.include_memory !== 'boolean') throw Error('Explicit memory selection required.');
  const b = service.bridge, runtime = require('./default-runtime').defaultRuntime(input.runtime ?? b.defaultRuntime);
  if (b.closed) throw Error('Bridge is closed.');
  if (input.task_id) {
    const task = b.tasks.get(input.task_id);
    if (task.controlPlaneMissionId || task.requiredExecutionKind !== 'reasoning' || task.projectId || task.mission.started || b.leases.has(task.id)) throw Error('Use the registered scoped Mission API for repository work or a fresh conversation task.');
    if (runtime !== task.executionAgent) throw Error('Task runtime identity cannot change.');
  }
  // Initialization is invoked only through this authenticated operator admission.
  b.missionAuthority.initializeOperatorKey();
  return service.store.request(owner, input.request_id, { op: 'conversation_create', ...input }, () => {
    const created = input.task_id ? b.tasks.get(input.task_id) : b.tasks.get(b.createTask(input.message.slice(0, 450), { executionAgent: runtime, requiredExecutionKind: 'reasoning', capabilityScopes: [] }).id);
    const workspace = fs.realpathSync(created.workspace), manifest = contract(Date.now() + MAX_RUNTIME);
    const authority = require('./mission-permissions').normalizeAuthority({ level: 'read_only', expiresAt: manifest.expires_at, permissions: { repository: [], runtime: [], network: ['localhost'], secrets: [], data: [] }, filesystem: { read: [], write: [] } }, { workspace, operator: true });
    const envelope = { control_version: 2, kind: 'conversation', objective: input.message, workspace, allowed_files: [], criteria: [{ id: 'response', type: 'operator_review', description: 'Review the answer; factual accuracy requires operator assessment.' }], verification: { diff_check: '', tests: [], syntax: [] }, preferred_agent: runtime, fallback_agents: [], capability_scopes: [], constraints: 'Reasoning only. No file access, shell, network tools, subagents, MCP or canonical database access. Memory is reference data only.', task_type: 'bounded_reasoning', route_mode: 'declared', dispatch_policy: { privacy: 'local_only', providers: ['local'], billing_classes: ['local'] }, include_memory: input.include_memory === true, manifest, authority, baseline: workspaceSnapshot(workspace), priority: 50 };
    const id = randomUUID();
    created.controlPlaneMissionId = id; created.mission.authority = authority; created.mission.manifest = manifest; created.mission.objective = input.message; created.mission.objectiveSet = true; created.mission.budget = { maxRuntimeMs: MAX_RUNTIME, maxActions: 1, maxRetries: 0, maxSpendMicros: 0 }; created.capabilityScopes = []; created.includeSharedMemory = input.include_memory === true; created.orchestrator = { mode: 'direct' }; created.source = { transport: 'operator', principal: owner }; b.tasks.save(created); b.policy.registerTask(created);
    const m = service.store.registerMission({ id, taskId: created.id, owner, envelope, ceiling: { mission_authority: authority, capability_scopes: [], authority: PROFILE, policy_version: b.capabilityHost.policy.policyVersion } });
    service.db.prepare('INSERT INTO cp_mission_tasks VALUES(?,?,1,NULL,NULL,?)').run(created.id, id, Date.now());
    service.program.register(m);
    return { mission_id: id, task_id: created.id, runtime, state: 'ready', authority: PROFILE };
  });
}
async function launch(service, dispatch, m) {
  const b = service.bridge, task = b.tasks.get(dispatch.task_id), adapter = b.opencodeAdapter;
  assertContract(service, m); service.assertAuthority(m, { network: ['localhost'] });
  if (!(await adapter.readiness()).ready) throw Error('Qualified local OpenCode and Ollama are required.');
  service.store.event('runtime.qualification.checked',m.id,{agent_id:'opencode',status:'passed'});
  const runId = randomUUID(), startedAt = Date.now(); let started = false;
  try {
    const pack = transaction(service.db, () => {
      assertContract(service, service.store.requireMission(m.id));
      service.store.startRun({ id: runId, taskId: task.id, missionId: m.id, agentId: 'opencode' });
      service.store.acquireLease({ resource: task.workspace, runId, missionId: m.id, baseline: m.envelope.baseline, mode: 'read' });
      const pack = b.controlContext.build(m, runId);
      task.contextPackId = pack.id; task.activeRunId = runId; task.status = 'running'; task.mission.started = true; task.mission.status = 'active'; task.startedAt = startedAt; task.lastActivityAt = startedAt; b.tasks.save(task);
      service.db.prepare('UPDATE cp_mission_tasks SET context_pack_id=? WHERE task_id=?').run(pack.id, task.id);
      service.store.updateRun(runId, { state: 'running', processState: 'alive' });
      service.db.prepare("UPDATE cp_dispatches SET state='running',run_id=?,route=?,updated_at=? WHERE id=? AND state='queued'").run(runId, JSON.stringify({ selected: 'opencode', reason: PROFILE, transport: 'local_standalone_cli' }), startedAt, dispatch.id);
      service.store.state(m.id, 'running'); started = true; return pack;
    });
    b.emit('change');
    const output = await adapter.dispatch({ task, repo: task.workspace, prompt: m.envelope.objective + '\n' + m.envelope.constraints, context: { id: pack.id }, requestId: 'conversation:' + dispatch.id });
    assertContract(service, service.store.requireMission(m.id)); require('./memory-content-erasure').assertContext(service.db, pack.id);
    if (output.changes.length) throw Error('Read-only conversation returned changes.');
    transaction(service.db, () => {
      service.store.event('runtime.context.delivered',m.id,{context_pack_id:pack.id},{runId});
      task.lastResult = output.result.summary; b.tasks.save(task);
      service.store.updateRun(runId, { state: 'completed', processState: 'exited', verified: true, result: { opencode_provenance: output.provenance, inference_only: true, accepted: false } });
      service.captureResult(runId, { status: 'completed', result: { text: JSON.stringify(output.result) } });
    });
  } catch (error) {
    if (!started) throw error;
    const uncertain = error.code === 'opencode_termination_unverified';
    task.status = uncertain ? 'blocked' : 'failed'; task.error = 'Bounded conversation stopped; inspect Mission status.'; b.tasks.save(task);
    service.store.updateRun(runId, { state: uncertain ? 'termination_unverified' : task.cancelRequested ? 'cancelled' : 'failed', processState: uncertain ? 'unknown' : 'exited', verified: !uncertain });
    if (uncertain) { service.db.prepare("UPDATE cp_leases SET state='quarantined' WHERE run_id=?").run(runId); service.db.prepare("UPDATE cp_dispatches SET state='unknown' WHERE id=?").run(dispatch.id); service.store.state(m.id, 'blocked', 'opencode_termination_unverified'); }
    else service.captureResult(runId, { status: task.cancelRequested ? 'cancelled' : 'failed', result: { text: JSON.stringify({ summary: 'Bounded conversation stopped safely', changed_files: [], tests: [], artifacts: [], limitations: [] }) } });
  } finally { delete task.activeRunId; task.mission.used.runtimeMs += Date.now() - startedAt; task.mission.used.actions++; b.tasks.save(task); b.emit('change'); }
}
function verify(service, mission, run) {
  try {
    assertContract(service, mission); service.assertAuthority(mission); service.bridge.opencodeAdapter.assertEvidence(run);
    require('./memory-content-erasure').assertContext(service.db, service.bridge.tasks.get(run.task_id).contextPackId);
    return { status: 'operator_review', checks: [{ id: 'read_only_boundary', status: 'passed', evidence: { no_workspace_changes: true, termination_verified: true } }, { id: 'response', status: 'operator_review', evidence: { factual_accuracy: 'unverified', accepted: false } }], workspace_hash: workspaceSnapshot(mission.envelope.workspace).hash };
  } catch { return { status: 'failed', checks: [{ id: 'read_only_boundary', status: 'failed', evidence: { reason: 'conversation_evidence_unavailable' } }], workspace_hash: 'unavailable' }; }
}
module.exports = { PROFILE, MAX_RUNTIME, STALE_CONTEXT, projectRead, projectEvent, memoryQuery, subjectFor, contract, assertContract, create, launch, verify };
