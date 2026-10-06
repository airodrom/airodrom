'use strict';
// Host composition port over the canonical Codex handoff. No product launcher is
// inferred from tool names, authentication, prompts, or artifact self-attestation.
const fs = require('node:fs');
const path = require('node:path');
const { createHash,randomUUID } = require('node:crypto');
const { object, identifier, text, fingerprint, redactValue } = require('../control-plane-store');
const { transaction } = require('../control-transaction');
const { provision, validateEnvelope } = (() => {
  const relay = require('../codex-completion-relay');
  return { ...relay, provision: (runtime, run) => {
    const p = relay.location(runtime, run);
    for (const dir of [p.root, p.dir]) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); relay.owned(dir, true); }
    return p;
  } };
})();
const PROTOCOL = 'airodrom-work-surface-v1';
const REQUIRED = Object.freeze(['launch', 'private_workspace', 'artifact_return', 'lifecycle', 'cancel', 'idempotency', 'bounded_scope']);
const TYPES = Object.freeze(['text/plain', 'text/markdown', 'application/json']);
const MAX_BYTES = 24000;
function hash(content) { return createHash('sha256').update(content).digest('hex'); }
function safe(value) {
  if (fingerprint(redactValue(value)) !== fingerprint(value)) throw Error('work_sensitive_data');
  const scan = x => {
    if (typeof x === 'string' && /(?:^|[\s"'=])(?:\/(?:Users|private|tmp|var|home|etc)\/|[A-Z]:\\|file:\/\/)|--(?:api-key|token|password|secret)\b/i.test(x)) throw Error('work_private_path_or_credential_argument');
    if (x && typeof x === 'object') Object.values(x).forEach(scan);
  };
  scan(value); return value;
}
function opaque(value) {
  identifier(value); text(value, 'opaque Work reference', 160);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw Error('work_opaque_reference_required');
  return value;
}
function relative(value) {
  text(value, 'Work relative file', 300);
  if (path.isAbsolute(value) || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..' || p === '.git') || /(^|\/)(?:\.env|\.ssh|credentials|secrets)(?:\.|\/|$)/i.test(value)) throw Error('work_unsafe_relative_path');
  return value;
}
function surfaceDescriptor(surface) {
  if (!surface) return null;
  try {
    const d = surface.descriptor;
    object(d, ['id', 'protocol', 'runtime_id', 'mode', 'documentation', 'capabilities']);
    opaque(d.id);
    const u = new URL(d.documentation);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || d.protocol !== PROTOCOL || d.runtime_id !== 'work' || !['fixture', 'live'].includes(d.mode)) return null;
    if (!Array.isArray(d.capabilities) || new Set(d.capabilities).size !== d.capabilities.length || d.capabilities.some(c => !REQUIRED.includes(c))) return null;
    text(d.documentation, 'public supported-surface documentation', 1000);
    if (!['learn.chatgpt.com', 'developers.openai.com', 'help.openai.com'].includes(u.hostname)) return null;
    const { documentation, ...metadata } = d; safe(metadata); return structuredClone(d);
  } catch { return null; }
}
function workspaceReference(resolved, mission, handle) {
  if (!resolved || resolved.approved !== true || resolved.private !== true || resolved.handle !== handle || resolved.project_id !== mission.project_id || resolved.owner !== mission.owner || fs.realpathSync(resolved.local_root) !== mission.envelope.workspace) throw Error('work_workspace_not_approved');
  return { version: 1, kind: 'private', handle: opaque(handle), project_id: mission.project_id, owner: mission.owner };
}
function validateReturn(input, request, surfaceId, attempt) {
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) throw Error('work_return_hash_or_bound_invalid');
  object(input, ['version', 'runtime_id', 'mission_id', 'task_id', 'run_id', 'request_id', 'dispatch_id', 'attempt_id', 'workspace', 'surface_id', 'context_hash', 'result', 'artifacts', 'content_hash']);
  if (!attempt?.active_attempt_id || input.dispatch_id !== attempt.dispatch_id || input.attempt_id !== attempt.active_attempt_id) throw Error('work_stale_dispatch_attempt');
  if (input.version !== 1 || input.runtime_id !== 'work' || input.surface_id !== surfaceId || input.context_hash !== request.context_hash || fingerprint(input.workspace) !== fingerprint(request.workspace)) throw Error('work_return_origin_mismatch');
  for (const k of ['mission_id', 'task_id', 'run_id', 'request_id']) if (input[k] !== request[k]) throw Error('work_return_correlation_mismatch');
  object(input.result, ['status', 'summary', 'changed_files', 'tests', 'limitations']);
  if (!['completed', 'failed', 'partial', 'cancelled'].includes(input.result.status)) throw Error('work_return_status_invalid');
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 8) throw Error('work_artifact_bound');
  if (input.result.status === 'completed' && !input.artifacts.length) throw Error('work_completed_artifact_required');
  const ids = new Set(), names = new Set(); let bytes = 0;
  for (const a of input.artifacts) {
    object(a, ['id', 'path', 'type', 'size', 'sha256', 'content', 'origin']);
    opaque(a.id); relative(a.path);
    if (ids.has(a.id) || names.has(a.path) || !TYPES.includes(a.type) || typeof a.content !== 'string' || !Number.isSafeInteger(a.size) || a.size < 0 || a.size !== Buffer.byteLength(a.content) || a.sha256 !== hash(a.content)) throw Error('work_artifact_identity_type_or_hash_invalid');
    object(a.origin, ['runtime_id', 'mission_id', 'task_id', 'run_id', 'workspace_handle', 'surface_id']);
    const origin = { runtime_id: 'work', mission_id: request.mission_id, task_id: request.task_id, run_id: request.run_id, workspace_handle: request.workspace.handle, surface_id: surfaceId };
    if (fingerprint(a.origin) !== fingerprint(origin)) throw Error('work_artifact_provenance_missing_or_invalid');
    if (a.type === 'application/json') { try { JSON.parse(a.content); } catch { throw Error('work_artifact_json_invalid'); } }
    ids.add(a.id); names.add(a.path); bytes += a.size;
  }
  const { content_hash, ...body } = input;
  if (bytes > MAX_BYTES || Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES || content_hash !== fingerprint(body)) throw Error('work_return_hash_or_bound_invalid');
  safe(input); return structuredClone(input);
}
class WorkExecutionAdapter {
  constructor(bridge, { surface = null, now = () => bridge.controlStore.now() } = {}) {
    this.bridge = bridge; this.store = bridge.controlStore; this.db = this.store.db;
    this.surface = surface; this.descriptor = surfaceDescriptor(surface); this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_work_bindings(run_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, policy_hash TEXT NOT NULL, descriptor_hash TEXT NOT NULL, mode TEXT NOT NULL, packet TEXT NOT NULL, deadline INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS work_binding_immutable BEFORE UPDATE ON cp_work_bindings BEGIN SELECT RAISE(ABORT,'Immutable Work binding'); END;
      CREATE TRIGGER IF NOT EXISTS work_binding_no_delete BEFORE DELETE ON cp_work_bindings BEGIN SELECT RAISE(ABORT,'Immutable Work binding'); END;
      CREATE TABLE IF NOT EXISTS cp_work_receipts(run_id TEXT PRIMARY KEY, artifact_hash TEXT, lifecycle_ref TEXT);`);
  }
  capabilities() {
    const d = this.descriptor, has = (c, method) => !!d?.capabilities.includes(c) && typeof this.surface?.[method] === 'function';
    const state = { runtime_id: 'work', legacy_agent_id: 'codex', adapter_implemented: true, transport_contract_ready: true,
      launcher_available: has('launch', 'launch'), private_workspace_available: has('private_workspace', 'resolveWorkspace'),
      artifact_return_available: has('artifact_return', 'collect'), lifecycle_available: has('lifecycle', 'observe'),
      cancellation_available: has('cancel', 'cancel'), idempotency_available: !!d?.capabilities.includes('idempotency'), bounded_scope_available: !!d?.capabilities.includes('bounded_scope'),
      live_qualification_complete: false, qualification: 'IMPLEMENTED_LIVE_UNQUALIFIED', execution_authority: false, mode: d?.mode || 'unsupported', surface_id: d?.id || null };
    // Live proof is derived from canonical records, never a descriptor flag or a
    // fixture success. It is invalidated when the configured surface changes.
    if (d?.mode === 'live') state.live_qualification_complete = !!this.db.prepare(`SELECT 1 FROM cp_work_bindings b JOIN cp_work_receipts w ON w.run_id=b.run_id JOIN cp_runs r ON r.id=b.run_id JOIN cp_verifications v ON v.run_id=r.id JOIN cp_acceptances a ON a.verification_id=v.id AND a.mission_id=b.mission_id JOIN cp_mission_settlements s ON s.mission_id=b.mission_id WHERE b.mode='live' AND b.descriptor_hash=? AND w.artifact_hash IS NOT NULL AND w.lifecycle_ref IS NOT NULL AND r.termination_verified=1 AND r.state='completed' AND v.result='passed' AND a.decision='accept' AND s.state='settled' LIMIT 1`).get(fingerprint(d));
    if (state.live_qualification_complete) state.qualification = 'QUALIFIED';
    state.live_qualified = state.live_qualification_complete;
    state.support_tier = require('../runtime-support').support('codex').tier;
    state.missing = Object.entries(state).filter(([k, v]) => k.endsWith('_available') && v === false).map(([k]) => k);
    return state;
  }
  requireSurface() {
    require('../memory-content-erasure').assertReadable(this.db);
    const c = this.capabilities(); if (c.missing.length) throw Error('work_supported_surface_unavailable');
    if (this.descriptor.mode === 'fixture' && !(process.env.NODE_ENV === 'test' && this.bridge.options.allowFixtureWorker)) throw Error('work_fixture_surface_denied');
    if (this.bridge.agentDispatch.transport) throw Error('work_conflicting_transport');
  }
  resolve(mission, handle) {
    try {
    const r = this.surface.resolveWorkspace({ handle, project_id: mission.project_id, owner: mission.owner });
    if (r?.then) throw Error('work_synchronous_approved_workspace_required');
    const project = this.bridge.projects.getProject(mission.project_id);
    if (!project.repositories?.some(root => fs.realpathSync(typeof root === 'string' ? root : root.path) === mission.envelope.workspace)) throw Error('work_project_workspace_mismatch');
    return workspaceReference(r, mission, handle);
    } catch { throw Error('work_workspace_not_approved'); }
  }
  prepare(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('work_authenticated_operator_required');
    object(input, ['mission_id', 'request_id', 'workspace_handle', 'timeout_ms', 'context_files']);
    identifier(input.mission_id); identifier(input.request_id); opaque(input.workspace_handle);
    this.requireSurface();
    const m = this.bridge.missions.require(input.mission_id, owner), p = m.envelope.dispatch_policy;
    if (m.envelope.preferred_agent !== 'codex' || m.envelope.fallback_agents.length || !p || !p.providers.includes('codex_openai') || !p.billing_classes.includes('subscription') || p.privacy !== 'cloud_allowed') throw Error('work_immutable_external_policy_required');
    if (m.envelope.continuity === 'prior_context') throw Error('work_minimum_context_continuity_unqualified');
    if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 10 || input.timeout_ms > 3600000) throw Error('work_timeout_bound');
    if (!Array.isArray(input.context_files) || input.context_files.length > 8 || new Set(input.context_files).size !== input.context_files.length || input.context_files.some(f => !m.envelope.allowed_files.includes(relative(f)))) throw Error('work_minimum_context_scope');
    const workspace = this.resolve(m, input.workspace_handle), requestHash = fingerprint(input);
    const prior = this.db.prepare('SELECT run_id,request_hash FROM cp_work_bindings WHERE request_id=?').get(input.request_id);
    if (prior) { if (prior.request_hash !== requestHash) throw Error('work_idempotency_conflict'); return { ...this.binding(prior.run_id), duplicate: true }; }
    if (this.db.prepare('SELECT 1 FROM cp_codex_handoffs WHERE request_id=?').get(input.request_id)) throw Error('work_unbound_legacy_request');
    const files = input.context_files.map(file => {
      try {
      const target = path.join(m.envelope.workspace, file);
      if (fs.realpathSync(target) !== target || !fs.lstatSync(target).isFile()) throw Error('work_context_symlink_or_type');
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { if (fs.fstatSync(fd).size > 12000) throw Error('work_context_bound'); const content = fs.readFileSync(fd, 'utf8'); return { path: file, content, sha256: hash(content) }; } finally { fs.closeSync(fd); }
      } catch { throw Error('work_context_unavailable'); }
    });
    const context = { objective: m.envelope.objective, constraints: m.envelope.constraints, allowed_files: m.envelope.allowed_files, criteria: m.envelope.criteria, files };
    safe(context); if (Buffer.byteLength(JSON.stringify(context)) > MAX_BYTES) throw Error('work_context_bound');
    this.bridge.missions.assertAuthority(m);
    return transaction(this.db, () => {
      const h = this.bridge.codexAdapter.startTask(m.id, input.request_id);
      const packet = { version: 1, runtime_id: 'work', legacy_agent_id: 'codex', mission_id: m.id, task_id: m.task_id, run_id: h.run_id, request_id: input.request_id, workspace, capabilities: ['bounded_file_work', 'artifact_return'], context, context_hash: fingerprint(context), deadline: this.now() + input.timeout_ms,
        result_contract: { version: 1, types: TYPES, max_bytes: MAX_BYTES, provenance_required: true, authority: 'evidence_only' } };
      safe(packet);
      this.db.prepare('INSERT INTO cp_work_bindings VALUES(?,?,?,?,?,?,?,?,?)').run(h.run_id, m.id, input.request_id, requestHash, fingerprint({ version: 2, envelope: m.envelope, ceiling: m.ceiling }), fingerprint(this.descriptor), this.descriptor.mode, JSON.stringify(packet), packet.deadline);
      return this.binding(h.run_id);
    });
  }
  binding(runId) {
    require('../memory-content-erasure').assertReadable(this.db);
    identifier(runId); const b = this.db.prepare('SELECT * FROM cp_work_bindings WHERE run_id=?').get(runId);
    if (!b) throw Error('work_binding_missing'); return { ...b, packet: JSON.parse(b.packet) };
  }
  guard(runId) {
    this.requireSurface(); const b = this.binding(runId), m = this.store.requireMission(b.mission_id);
    if (b.descriptor_hash !== fingerprint(this.descriptor) || b.policy_hash !== fingerprint({ version: 2, envelope: m.envelope, ceiling: m.ceiling }) || fingerprint(this.resolve(m, b.packet.workspace.handle)) !== fingerprint(b.packet.workspace)) throw Error('work_binding_changed');
    return b;
  }
  assertEvidence(missionId, selectedRun = null) {
    if (!this.db.prepare('SELECT 1 FROM cp_work_bindings WHERE mission_id=?').get(missionId)) return;
    selectedRun ||= this.db.prepare('SELECT run_id FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(missionId)?.run_id;
    const rows = this.db.prepare('SELECT run_id FROM cp_work_bindings WHERE mission_id=? AND run_id=?').all(missionId, selectedRun || '');
    if (!rows.length) throw Error('work_acceptance_run_binding_missing');
    for (const row of rows) {
      const b = this.guard(row.run_id), receipt = this.db.prepare('SELECT * FROM cp_work_receipts WHERE run_id=?').get(row.run_id), h = this.bridge.codexAdapter.getTask(row.run_id);
      if (!receipt?.artifact_hash || !receipt.lifecycle_ref || !h.run.termination_verified || h.state !== 'settled') throw Error('work_independent_artifact_and_termination_required');
      const records = this.db.prepare('SELECT metadata FROM cp_artifacts WHERE run_id=? ORDER BY created_at,rowid').all(row.run_id);
      const artifacts = records.map(r => { const { workspace, untrusted, external_label, ...a } = JSON.parse(r.metadata); if (fingerprint(workspace) !== fingerprint(b.packet.workspace) || untrusted !== true || typeof external_label!=='string' || Object.hasOwn(a,'id')) throw Error('work_artifact_binding_changed'); return {...a,id:external_label}; });
      const { artifacts: refs, ...result } = h.published_result.result;
      if (fingerprint(refs) !== fingerprint(artifacts.map(a => 'work-artifact:' + a.id))) throw Error('work_artifact_references_changed');
      validateReturn({ ...this.locator(b), version: 1, runtime_id: 'work', mission_id: b.mission_id, task_id: b.packet.task_id, run_id: b.run_id, request_id: b.request_id, workspace: b.packet.workspace, surface_id: artifacts[0]?.origin.surface_id || this.descriptor?.id, context_hash: b.packet.context_hash, result, artifacts, content_hash: receipt.artifact_hash }, b.packet, this.descriptor?.id, this.bridge.agentDispatch.get(b.run_id));
    }
  }
  async call(method, input, deadline) {
    const controller = new AbortController(); let timer;
    try { return await Promise.race([Promise.resolve().then(() => this.surface[method](structuredClone(input), { signal: controller.signal })), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('work_timeout')); }, Math.max(1, Math.min(5000, deadline - this.now()))); })]); }
    catch { throw Error('work_transport_unknown'); } finally { clearTimeout(timer); }
  }
  async dispatch(runId) {
    const b = this.guard(runId); if (this.now() >= b.deadline) return this.cancel(runId);
    const claim = this.bridge.agentDispatch.claim({ dispatch_id: runId }, 'operator');
    if (claim.state !== 'dispatching') return { state: claim.state, runtime_id: 'work' };
    let outcome;
    try { outcome = await this.call('launch', { ...b.packet, dispatch_id: claim.dispatch_id, attempt_id: claim.attempt_id, idempotency_key: claim.idempotency_key }, b.deadline); }
    catch { outcome = {}; }
    // Canonical classifier drops raw provider diagnostics and retains uncertainty.
    const result = this.bridge.agentDispatch.report({ dispatch_id: claim.dispatch_id, attempt_id: claim.attempt_id, outcome }, 'operator');
    return { state: result.status, runtime_id: 'work', run_id: runId };
  }
  async collect(runId) {
    const b = this.guard(runId);
    if (this.now() >= b.deadline) return this.cancel(runId);
    const h = this.bridge.codexAdapter.getTask(runId), d = this.bridge.agentDispatch.get(runId);
    if (!['accepted', 'running_unknown', 'completion_waiting', 'completed_transport'].includes(d.status)) throw Error('work_collect_not_dispatched');
    const raw = await this.call('collect', this.locator(b), b.deadline);
    if (raw === null) return { state: 'pending', runtime_id: 'work' };
    const value = validateReturn(raw, b.packet, this.descriptor.id, d);
    const old = this.db.prepare('SELECT artifact_hash FROM cp_work_receipts WHERE run_id=?').get(runId);
    if (old?.artifact_hash) { if (old.artifact_hash !== value.content_hash) throw Error('work_immutable_return_conflict'); return this.observe(runId); }
    if (h.state !== 'awaiting_handoff' || this.store.requireMission(b.mission_id).state === 'cancelled') throw Error('work_stale_return');
    const result = { ...value.result, artifacts: value.artifacts.map(a => 'work-artifact:' + a.id) };
    for (const file of result.changed_files || []) if (!b.packet.context.allowed_files.includes(file)) throw Error('work_changed_file_outside_scope');
    const envelope = { schema_version: 'codex-result-v1', mission_id: b.mission_id, task_id: b.packet.task_id, run_id: runId, request_id: b.request_id, agent_id: 'codex', transport: 'handoff', relay_nonce: h.contract.relay_nonce, result, timestamps: { started_at: 0, finished_at: this.now() }, publisher: { identity: 'codex-work', mode: 'artifact' } };
    envelope.content_hash = fingerprint(envelope); validateEnvelope(envelope, h.contract);
    const p = provision(this.bridge.dataDir, runId);
    // Existing protected relay path provides recoverable atomic evidence ingestion.
    // Content remains in the bounded immutable proposal; no repository path writes.
    transaction(this.db, () => {
      if (this.bridge.codexAdapter.getTask(runId).state !== 'awaiting_handoff' || this.store.requireMission(b.mission_id).state === 'cancelled') throw Error('work_stale_return');
      for (const a of value.artifacts) {
        const {id:external_label,...payload}=a,metadata={...payload,external_label,workspace:b.packet.workspace,untrusted:true},reference='work-artifact:'+external_label;
        // External artifact IDs are untrusted erasable payload. They cannot
        // determine an immutable application identity, even through a hash.
        const prior=this.db.prepare("SELECT id,mission_id,kind,reference,metadata FROM cp_artifacts WHERE run_id=? AND json_extract(metadata,'$.path')=?").all(runId,a.path);
        if(prior.length>1||prior.length&&(prior[0].mission_id!==b.mission_id||prior[0].kind!==a.type||prior[0].reference!==reference||fingerprint(JSON.parse(prior[0].metadata))!==fingerprint(metadata)))throw Error('work_immutable_artifact_conflict');
        if(!prior.length)this.db.prepare('INSERT INTO cp_artifacts VALUES(?,?,?,?,?,?,?)').run(randomUUID(),b.mission_id,runId,a.type,reference,JSON.stringify(metadata),this.now());
      }
      const file = path.join(p.dir, 'work-return.tmp');
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(envelope)); } finally { fs.closeSync(fd); }
      try {
        fs.renameSync(file, p.file); const receipt = this.bridge.codexRelay.consume(runId);
        if (!receipt || receipt.rejected) throw Error('work_relay_rejected');
        this.db.prepare('INSERT INTO cp_work_receipts VALUES(?,?,NULL) ON CONFLICT(run_id) DO UPDATE SET artifact_hash=excluded.artifact_hash').run(runId, value.content_hash);
      } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
    });
    return this.observe(runId);
  }
  locator(b) { const d=this.bridge.agentDispatch.get(b.run_id);return { runtime_id: 'work', mission_id: b.mission_id, task_id: b.packet.task_id, run_id: b.run_id, request_id: b.request_id, dispatch_id:d.dispatch_id, attempt_id:d.active_attempt_id, workspace: b.packet.workspace }; }
  async observe(runId) {
    const b = this.guard(runId), h = this.bridge.codexAdapter.getTask(runId);
    if (h.state === 'settled' && this.db.prepare('SELECT lifecycle_ref FROM cp_work_receipts WHERE run_id=?').get(runId)?.lifecycle_ref) return { state: 'awaiting_independent_acceptance', runtime_id: 'work', run_id: runId };
    const observed = await this.call('observe', this.locator(b), Math.max(b.deadline, this.now() + 1000));
    object(observed, ['runtime_id', 'run_id', 'dispatch_id', 'attempt_id', 'workspace_handle', 'surface_id', 'state', 'receipt']);
    const locator = this.locator(b);
    if (observed.runtime_id !== 'work' || observed.run_id !== runId || observed.dispatch_id !== locator.dispatch_id || observed.attempt_id !== locator.attempt_id || observed.workspace_handle !== b.packet.workspace.handle || observed.surface_id !== this.descriptor.id) throw Error('work_lifecycle_origin_mismatch');
    if (!['exited', 'cancelled'].includes(observed.state)) return { state: 'termination_unverified', runtime_id: 'work', run_id: runId };
    opaque(observed.receipt);
    const result = h.published_result?.result;
    if (!result && h.state !== 'cancellation_requested') return { state: 'artifact_return_required', runtime_id: 'work', run_id: runId };
    transaction(this.db, () => {
      this.bridge.codexAdapter.reconcile({ run_id: runId, termination_verified: true, ...(result ? {} : { result: { status: 'cancelled', summary: 'Supported Work surface confirmed cancellation', changed_files: [], tests: [], artifacts: [], limitations: [] } }) });
      // The provider receipt may itself encode content. Keep only a host
      // identity proving that the correlated lifecycle observation succeeded.
      this.db.prepare('INSERT INTO cp_work_receipts VALUES(?,NULL,?) ON CONFLICT(run_id) DO UPDATE SET lifecycle_ref=excluded.lifecycle_ref').run(runId, randomUUID());
    });
    return { state: 'awaiting_independent_acceptance', runtime_id: 'work', run_id: runId };
  }
  async cancel(runId) {
    const b = this.guard(runId);
    if (this.bridge.codexAdapter.getTask(runId).state === 'settled') return { state: 'settled', runtime_id: 'work' };
    this.bridge.codexAdapter.cancelTask(runId);
    try { await this.call('cancel', this.locator(b), this.now() + 1000); } catch { return { state: 'termination_unverified', runtime_id: 'work', run_id: runId }; }
    return this.observe(runId);
  }
  async reconcileTimeouts() {
    for (const b of this.db.prepare("SELECT w.run_id FROM cp_work_bindings w JOIN cp_codex_handoffs h ON h.run_id=w.run_id WHERE w.deadline<=? AND h.state NOT IN ('settled','cancellation_requested')").all(this.now())) {
      try { await this.cancel(b.run_id); } catch { /* No raw transport diagnostics. Ownership remains fail-closed. */ }
    }
  }
}
module.exports = { WorkExecutionAdapter, surfaceDescriptor, workspaceReference, validateReturn, PROTOCOL, REQUIRED, TYPES, MAX_BYTES, hash };
