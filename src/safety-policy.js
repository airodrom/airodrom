'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { removed } = require('./removed-runtime');

const { classify } = require('./safe-diagnostics');
const { AutonomyPolicy } = require('./autonomy-policy');
const READ_TOOLS = new Set(['read', 'ls', 'find', 'grep']);
const FILE_TOOLS = new Set([...READ_TOOLS, 'write', 'edit']);
const BRIDGE_MEMORY_READ_TOOLS = new Set(['memory_search', 'mission_checkpoint', 'personal_memory_get', 'personal_memory_search', 'personal_memory_recent', 'project_list', 'project_get', 'project_summary', 'project_next_action']);
const BRIDGE_PERSISTENT_WRITE_TOOLS = new Set(['personal_memory_remember', 'personal_memory_update', 'personal_memory_forget', 'project_create', 'project_create_goal', 'project_create_mission', 'project_set_mission_status', 'project_archive']);
const PERSONAL_MEMORY_WRITE_TOOLS = new Set(['personal_memory_remember', 'personal_memory_update', 'personal_memory_forget']);
const SECRET_PART = /^(?:\.git|\.pi|\.codex|\.bridge|\.ssh|\.aws|\.gnupg|\.config|\.npmrc|\.netrc|\.pypirc|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key|p12|pfx))$/i;
const TRUSTED_FILES = [
  // Protect containing directories too, so filesystem renames cannot remove a
  // trusted file while leaving the exact-path checks behind.
  'src', 'scripts', 'macos', 'config',
  'src/mission-permissions.js', 'src/safety-policy.js', 'src/mission-authority.js', 'src/mission-coordinator.js',
  'src/capability-broker.js',
  'src/bridge-controller.js', 'src/control-server.js', 'src/config.js',
  'src/safe-diagnostics.js', 'src/safety-extension.js', 'src/host-worker-adapter.js',
  'src/mission-supervisor.js', 'src/supervisor-acceptance.js', 'src/memory-store.js',
  'src/task-session-model.js', 'src/index.js', 'src/mcp.js', 'src/mcp-stdio.js',
  'src/mcp-tools.js', 'src/service-log.js', 'src/chatgpt-events.js',
  'src/web-reader.js', 'src/sandbox-policy.js',
  'src/sandbox-runner.js', 'src/mission-provider.js', 'scripts/run.cjs',
  'scripts/macos', 'macos', 'config/safe-autonomy-manifest.json', 'wire.log', 'package.json', 'package-lock.json'
];

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Canonical JSON rejects values whose serialization could hide input differences.
function stable(value, depth = 0) {
  if (depth > 25) throw new Error('Input is too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new Error('Sparse arrays are not allowed');
    }
    return `[${value.map(item => stable(item, depth + 1)).join(',')}]`;
  }
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    if (Object.getOwnPropertySymbols(value).length) throw new Error('Symbol keys are not allowed');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key], depth + 1)}`).join(',')}}`;
  }
  throw new Error('Input must contain only JSON values');
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

// Resolve existing parents too: a new write through a symlinked directory must not escape.
function realTarget(target) {
  try { return fs.realpathSync(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Broken symlink'); } catch (inner) {
      if (inner.code !== 'ENOENT') throw inner;
    }
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(realTarget(parent), path.basename(target));
  }
}

class SafetyPolicy extends EventEmitter {
  constructor({ now = () => Date.now(), ttlMs = 60 * 60 * 1000, protectedPaths = [], privatePaths = [], readOnlyTools = {}, missionAuthority = null, trustedDeveloperMode = false, beforeApproval = null, autonomyPolicy = null } = {}) {
    super();
    this.now = now; this.readOnlyTools = readOnlyTools; this.missionAuthority = missionAuthority; this.trustedDeveloperMode = trustedDeveloperMode === true;
    this.beforeApproval = typeof beforeApproval === 'function' ? beforeApproval : null;
    this.autonomyPolicy = autonomyPolicy instanceof AutonomyPolicy ? autonomyPolicy : new AutonomyPolicy(autonomyPolicy || undefined);
    // A human review window must outlive a normal coding turn.  Keep an upper
    // bound so a forgotten one-shot grant cannot become a standing permission.
    this.ttlMs = Math.min(Math.max(ttlMs, 60 * 1000), 24 * 60 * 60 * 1000);
    this.tasks = new Map();
    this.approvals = new Map();
    this.safetyStops = new Map();
    this.audit = [];
    this.bridgeRoot = realTarget(path.resolve(__dirname, '..'));
    this.runtimeRoots = [path.join(this.bridgeRoot, '.runtime'), ...privatePaths].map(p => realTarget(path.resolve(p)));
    // These files decide what the worker may do, issue/revoke authority, or
    // contain runtime configuration. A task editing the bridge cannot rewrite
    // the enforcement boundary that is evaluating that same task.
    const trustedPaths = TRUSTED_FILES.map(file => path.join(this.bridgeRoot, file));
    this.explicitProtectedPaths = [...new Set([...protectedPaths, ...trustedPaths])].map(p => realTarget(path.resolve(p)));
    this.protectedPaths = [...this.runtimeRoots, this.bridgeRoot, path.join(os.homedir(), '.pi'), ...protectedPaths].map(p => realTarget(path.resolve(p)));
  }

  registerTask({ id, sessionId, workspace, mission = null, reasoningMode = null, executionAgent = null }) {
    if (typeof id !== 'string' || !id || typeof sessionId !== 'string' || !sessionId || typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('Invalid task registration');
    const resolved = fs.realpathSync(workspace);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('Task workspace must be a directory');
    if (resolved.split(path.sep).some(part => SECRET_PART.test(part))) throw new Error('Task workspace cannot be protected metadata or secrets');
    if (this.runtimeRoots.some(root => contained(root, resolved)) && !this._generatedWorkspace({id, workspace: resolved})) throw new Error('Bridge state is not a task workspace');
    const current = this.tasks.get(id);
    if (current && (current.sessionId !== sessionId || current.workspace !== resolved)) this.revokeTask(id);
    this.tasks.set(id, { id, sessionId, reasoningMode, executionAgent, workspace: resolved, mission: mission ? clone(mission) : null });
    return { id, sessionId, workspace: resolved, mission: mission ? clone(mission) : null };
  }

  _expire() {
    for (const approval of this.approvals.values()) {
      if (['pending', 'approved'].includes(approval.status) && this.now() >= approval.expiresAt) {
        approval.status = 'expired';
        this.emit('approval', clone(approval));
      }
    }
  }

  _record(taskId, call, decision, approvalId) {
    if (!decision.allow) decision = { ...decision, executionStatus: 'NOT EXECUTED', reason: `NOT EXECUTED: ${decision.reason}. STOP and await user direction; do not retry or use alternate tools.` };
    let input = null;
    try { input = JSON.parse(stable(call?.auditInput ?? call?.input)); } catch { /* Malformed input is deliberately not retained. */ }
    const policyFields = {};
    for (const key of ['policy_version', 'policy_decision', 'policy_automatic', 'policy_scope', 'policy_action', 'policy_risk_class', 'policy_precedence', 'automatic']) {
      if (Object.hasOwn(decision, key)) policyFields[key] = decision[key];
    }
    const record = { timestamp: new Date(this.now()).toISOString(), taskId, sessionId: this.tasks.get(taskId)?.sessionId ?? null, toolName: typeof call?.toolName === 'string' ? call.toolName : null, toolCallId: typeof call?.toolCallId === 'string' ? call.toolCallId : null, input, decision: decision.allow ? 'allow' : 'deny', ...(decision.allow ? {} : { executionStatus: 'NOT EXECUTED' }), ...(decision.kind ? { kind: decision.kind } : {}), reason: decision.reason, ...(approvalId ? { approvalId } : {}), ...policyFields };
    this.audit.push(record);
    if (this.audit.length > 1000) this.audit.shift();
    this.emit('audit', clone(record));
    return { ...decision, ...(approvalId ? { approvalId } : {}) };
  }

  _protected(task, target) {
    return path.relative(task.workspace, target).split(path.sep).some(part => SECRET_PART.test(part)) || this.runtimeRoots.some(root => contained(root, target) && !(this._generatedWorkspace(task) && contained(task.workspace, target)));
  }

  _diagnosticLog(task, lexical, target) {
    // Only known service logs in the explicitly selected bridge workspace.
    // Never extend this exception to writes, directory scans, or symlink aliases.
    const runtime = path.join(this.bridgeRoot, '.runtime');
    return task.workspace === this.bridgeRoot && lexical === target &&
      path.dirname(lexical) === runtime && ['service.log', 'background-service.log'].includes(path.basename(lexical)) &&
      !this.explicitProtectedPaths.some(root => contained(root, target)) &&
      !this.runtimeRoots.some(root => root !== runtime && contained(root, target));
  }

  _generatedWorkspace(task) {
    return this.runtimeRoots.some(root => {
      const segments = path.relative(root, task.workspace).split(path.sep);
      return segments.length === 3 && segments[0] === 'tasks' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segments[1]) && segments[1] === task.id && segments[2] === 'workspace';
    });
  }

  _protectedWrite(task, target) {
    // The explicitly selected bridge workspace may request exact approval for source
    // maintenance. Runtime/private roots and caller-supplied protections still win.
    return this.explicitProtectedPaths.some(root => contained(root, target)) || this.protectedPaths.some(root => contained(root, target) && !(root === this.bridgeRoot && task.workspace === this.bridgeRoot) && !((root === this.bridgeRoot || this.runtimeRoots.includes(root)) && this._generatedWorkspace(task) && contained(task.workspace, target)));
  }

  _checkTree(task, target, recursive) {
    let inspected = 0;
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (++inspected > 2000) throw new Error('Directory safety scan limit reached; use a narrower path');
        const entryPath = path.join(directory, entry.name);
        if (SECRET_PART.test(entry.name)) throw new Error('Directory includes protected metadata or secrets; use a narrower path');
        const canonical = fs.realpathSync(entryPath);
        if (!contained(task.workspace, canonical) || this._protected(task, canonical)) throw new Error('Directory includes an unsafe symbolic link');
        // Built-in find/grep do not follow directory symlinks; checking the link target is enough.
        if (recursive && entry.isDirectory()) visit(entryPath);
      }
    };
    visit(target);
  }

  _validateCall(task, call) {
    if (!call || typeof call !== 'object' || Array.isArray(call) || typeof call.toolName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(call.toolName) || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) throw new Error('Malformed tool call');
    const canonicalInput = stable(call.input);
    if (canonicalInput.length > 1024 * 1024) throw new Error('Tool input exceeds safety limit');
    if (fs.realpathSync(task.workspace) !== task.workspace) throw new Error('Task workspace changed');
    if (FILE_TOOLS.has(call.toolName)) {
      const supplied = call.input.path ?? (['ls', 'find', 'grep'].includes(call.toolName) ? '.' : undefined);
      if (typeof supplied !== 'string' || !supplied || supplied.includes('\0') || supplied.startsWith('~')) throw new Error('Invalid file path');
      const lexical = path.resolve(task.workspace, supplied);
      const target = realTarget(lexical);
      if (!contained(task.workspace, lexical) || !contained(task.workspace, target)) throw new Error('Path is outside the task workspace');
      if ((this._protected(task, lexical) || this._protected(task, target)) && !(call.toolName === 'read' && this._diagnosticLog(task, lexical, target))) throw new Error('Protected metadata or secret path');
      if (['write', 'edit'].includes(call.toolName) && this._protectedWrite(task, target)) throw new Error('Bridge state and installed runtime files are protected');
      if (READ_TOOLS.has(call.toolName)) {
        const stat = fs.statSync(target);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error('Only regular files and directories may be read');
        // Directory reads run through the broker's filtered, bounded reader.
        if (call.toolName === 'read' && stat.isDirectory()) throw new Error('Use ls for directories');
      }
    }
    if (call.toolName === 'bash') {
      if (typeof call.input.command !== 'string' || !call.input.command.trim() || call.input.command.includes('\0')) throw new Error('Invalid bash command');
      // This is an authorization boundary, not a shell sandbox. Explicit access to broker/agent
      // internals is always rejected; unrecognized commands require exact user approval.
      const diagnostic = classify(call.input.command, task.workspace);
      if (diagnostic) {
        for (const step of diagnostic.steps || [diagnostic]) {
          if (step.cwd) {
            this._validateCall(task, { toolName: 'ls', input: { path: step.cwd } });
            if (!fs.statSync(step.cwd).isDirectory()) throw new Error('Diagnostic working directory must be a directory');
          }
          if (step.path) this._validateCall(task, { toolName: ['ls','find','grep'].includes(step.op) ? step.op : 'read', input: { path: path.resolve(step.cwd || task.workspace, step.path) } });
        }
        return canonicalInput;
      }
      const inspectedCommand = this._generatedWorkspace(task) ? call.input.command.split(task.workspace + path.sep).join('<TASK_WORKSPACE>/') : call.input.command;
      if (this.protectedPaths.some(root => inspectedCommand.includes(root)) || /(?:^|[\s/])(?:\.git|\.pi|\.codex|\.ssh|\.env(?:\.[^\s/]*)?)(?:[/\s"']|$)/.test(inspectedCommand)) throw new Error('Bash references a protected path');
    }
    return canonicalInput;
  }

  check(taskId, call, { brokered = false } = {}) {
    this._expire();
    const task = this.tasks.get(taskId);
    if (!task) return this._record(taskId, call, { allow: false, kind: 'unknown_task', reason: 'Unknown or revoked task' });
    if (removed(task)) return this._record(taskId, call, { allow: false, kind: 'runtime_removed', reason: 'Historical runtime removed; no execution authority' });
    const hostReasoning = task.reasoningMode === 'reasoning_only' && call?.toolName === 'host_reasoning';
    if (task.reasoningMode === 'reasoning_only' && !hostReasoning) return this._record(taskId, call, { allow: false, kind: 'reasoning_execution_denied', reason: 'Reasoning admission grants no execution authority' });
    const latched = this.safetyStops.get(taskId);
    if (latched) return this._record(taskId, call, { allow: false, kind: 'safety_stop_latched', reason: `Safety stop is latched: ${latched.reason}` });
    let input, hostReasoningPolicy = null;
    try {
      input = this._validateCall(task, call);
      if (hostReasoning) {
        const fields = Object.keys(call.input).sort();
        if (JSON.stringify(fields) !== JSON.stringify(['message', 'policy', 'request_id'])) throw new Error('Invalid host reasoning request');
        if (typeof call.input.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(call.input.request_id)) throw new Error('Invalid host reasoning request');
        if (typeof call.input.message !== 'string' || !call.input.message.trim() || Buffer.byteLength(call.input.message) > 59000) throw new Error('Invalid host reasoning request');
        if (require('./provider-policy').secretLike(call.input.message)) throw new Error('Host reasoning admission denied');
        hostReasoningPolicy = require('./host-reasoning-admission').policy(call.input.policy);
      }
    } catch (error) {
      const kind = /Host reasoning admission denied/.test(error.message) ? 'safety_denial' : hostReasoning ? 'invalid_tool_arguments' : /Malformed|Invalid (?:file path|bash command|diagnostic|read|literal|find|search)|exceeds safety limit|too deeply nested|Sparse arrays|Symbol keys|Input must|ENOENT|ENOTDIR|no such file or directory|Parent path does not exist|Use ls for directories|Only regular files and directories may be read/.test(error.message) ? 'invalid_tool_arguments' : 'safety_denial';
      return this._record(taskId, call, { allow: false, kind, reason: error.message });
    }
    try{this.manifestGuard?.(task,call);}catch{return this._record(taskId,call,{allow:false,kind:'mission_grant_denied',reason:'Mission Manifest integrity, budget or program boundary denied'});}
    if (task.mission?.manifest) {
      const ceiling=require('./mission-manifest').checkManifest(task.mission.manifest,call,task.workspace,this.now());
      if(!ceiling.allow)return this._record(taskId,call,{allow:false,kind:'mission_grant_denied',reason:ceiling.reason});
    }
    if (task.mission?.authority) {
      const ceiling = require('./mission-permissions').checkAuthority(task.mission.authority, require('./mission-permissions').callRequirements(call, task.workspace), this.now());
      if (task.mission.authorityRevoked || !ceiling.allow) {
        const reason = task.mission.authorityRevoked ? 'Mission authority revoked' : ceiling.reason;
        this.latchSafetyStop(taskId, reason, { kind: 'mission_grant_denied' });
        return this._record(taskId, call, { allow: false, kind: 'mission_grant_denied', reason });
      }
    }
    if (hostReasoning && hostReasoningPolicy.privacy === 'local_only') return this._record(taskId, call, { allow: true, reason: 'Bounded local-only host reasoning allowed', automatic: true });
    if (task.mission?.requireGrant) {
      if (call.toolName === 'bash' && !classify(call.input.command, task.workspace)) {
        return this._record(taskId, call, { allow: false, reason: 'Arbitrary shell, test, and build execution is outside the mission runner; executable inputs must be inspected, pinned, and launched in a host sandbox' });
      }
      const capability = BRIDGE_MEMORY_READ_TOOLS.has(call.toolName) ? 'read' : BRIDGE_PERSISTENT_WRITE_TOOLS.has(call.toolName) ? 'write' : call.toolName === 'web_fetch' ? null : require('./mission-authority').ACTION_CAPABILITY[call.toolName];
      if (!capability || !this.missionAuthority) return this._record(taskId, call, { allow: false, kind: 'mission_grant_denied', reason: 'Mission capability is not granted' });
      const authorization = this.missionAuthority.verify(task.mission, capability, { consumeAction: true, usageKind: capability === 'read' ? 'read' : null });
      if (!authorization.allow) return this._record(taskId, call, { allow: false, kind: 'mission_grant_denied', reason: authorization.reason });
    }
    if (Object.hasOwn(this.readOnlyTools, call.toolName)) {
      try { this.readOnlyTools[call.toolName](call.input); return this._record(taskId, call, { allow: true, reason: 'Controlled read-only tool allowed' }); }
      catch (error) { return this._record(taskId, call, { allow: false, kind: 'invalid_tool_arguments', reason: error.message }); }
    }
    if (call.toolName === 'bash' && classify(call.input.command, task.workspace)) return this._record(taskId, call, { allow: true, reason: 'Bounded diagnostic executed by broker without a shell' });
    if (READ_TOOLS.has(call.toolName)) return this._record(taskId, call, { allow: true, reason: 'Read contained in task workspace' });
    // Writes confined to the selected workspace are reversible ordinary coding
    // work. Protected paths and symlink escapes were rejected above; destructive
    // shell commands and all unknown tools still require a one-shot approval.
    if (['write', 'edit'].includes(call.toolName)) return this._record(taskId, call, { allow: true, reason: 'Workspace edit allowed' });
    if (brokered && this.trustedDeveloperMode && call.toolName === 'trusted-development') return this._record(taskId, call, { allow: true, reason: 'Bounded trusted development job authorized', ...this._policyMeta('trusted-development') });
    if (brokered && ['test', 'build'].includes(call.toolName)) return this._record(taskId, call, { allow: true, reason: 'Named test/build job authorized for host runner validation', ...this._policyMeta(call.toolName) });
    if (brokered && call.toolName === 'bridge-maintenance') {
      const jobName = call.input?.jobName;
      if (jobName !== 'bridge_restart' && jobName !== 'bridge_restart_status') {
        return this._record(taskId, call, { allow: false, kind: 'invalid_tool_arguments', reason: 'Unknown bridge maintenance job' });
      }
      return this._record(taskId, call, { allow: true, reason: 'Pinned local bridge maintenance job authorized without approval', ...this._policyMeta('bridge-maintenance') });
    }
    // Typed V2 capabilities arrive with a host assessment from the central
    // capability policy. Auto-allow and deny are recorded here; approval_required
    // falls through to the same exact one-shot fingerprint approval as every tool.
    if (call.toolName === 'capability') {
      const assessment = brokered ? call.capabilityAssessment : null;
      if (!assessment || !['auto_allow', 'approval_required', 'deny'].includes(assessment.decision)) return this._record(taskId, call, { allow: false, kind: 'capability_denied', reason: 'Capability assessment is missing; fail closed' });
      const meta = {
        policy_version: assessment.policy_version, policy_decision: assessment.decision, policy_automatic: assessment.decision === 'auto_allow',
        policy_scope: assessment.scope || null, policy_action: assessment.capability || null, policy_risk_class: assessment.risk_class || null, policy_precedence: assessment.precedence || null
      };
      if (assessment.decision === 'deny') return this._record(taskId, call, { allow: false, kind: assessment.kind || 'capability_denied', reason: assessment.reason || 'Capability denied by policy', ...meta });
      if (assessment.decision === 'auto_allow') return this._record(taskId, call, { allow: true, reason: assessment.reason, automatic: true, ...meta });
    }
    // Standing trusted-routine policy can auto-allow Personal Memory writes without
    // a per-action operator approval. Secret-like content remains denied earlier by
    // broker validation. Final-clause protected categories never auto-allow here.
    if (PERSONAL_MEMORY_WRITE_TOOLS.has(call.toolName)) {
      const standing = this.autonomyPolicy.decide(call.toolName);
      if (standing.decision === 'deny' || standing.active === false) {
        return this._record(taskId, call, { allow: false, kind: 'safety_denial', reason: standing.reason, ...this.autonomyPolicy.auditMetadata(standing) });
      }
      if (standing.decision === 'auto_allow' && standing.automatic) {
        return this._record(taskId, call, {
          allow: true,
          reason: standing.reason,
          automatic: true,
          ...this.autonomyPolicy.auditMetadata(standing)
        });
      }
    }
    const fingerprint = crypto.createHash('sha256').update(stable({ taskId, sessionId: task.sessionId, cwd: task.workspace, toolName: call.toolName, input: JSON.parse(input) })).digest('hex');
    const matching = [...this.approvals.values()].find(record => record.fingerprint === fingerprint && ['pending', 'approved'].includes(record.status));
    if (matching?.status === 'approved') {
      // Consume synchronously, before returning permission; concurrent replays cannot share a grant.
      matching.status = 'consumed';
      matching.consumedAt = this.now();
      matching.consumedToolCallId = call.toolCallId ?? null;
      this.emit('approval', clone(matching));
      return this._record(taskId, call, { allow: true, reason: 'Exact one-shot approval consumed' }, matching.id);
    }
    if (matching) return this._record(taskId, call, { allow: false, kind: 'approval_required', reason: 'Exact one-shot approval required' }, matching.id);
    if ([...this.approvals.values()].filter(a => ['pending','approved'].includes(a.status)).length >= 256) return this._record(taskId, call, { allow: false, reason: 'Too many outstanding approvals' });
    for (const [id, record] of this.approvals) { if (this.approvals.size > 1000 && !['pending','approved'].includes(record.status)) this.approvals.delete(id); }
    const approval = { id: crypto.randomUUID(), taskId, sessionId: task.sessionId, workspace: task.workspace, toolName: call.toolName, input: JSON.parse(input), toolCallId: call.toolCallId ?? null, fingerprint, status: 'pending', createdAt: this.now(), expiresAt: this.now() + this.ttlMs };
    // A pending approval is a new authority surface. Record it durably before
    // exposing it to the worker or Control Center; a ledger outage therefore
    // cannot create an unaccounted approval.
    this.beforeApproval?.(clone(approval));
    this.approvals.set(approval.id, approval);
    this.emit('approval', clone(approval));
    return this._record(taskId, call, { allow: false, kind: 'approval_required', reason: 'Exact one-shot approval required' }, approval.id);
  }

  _policyMeta(capability) {
    try {
      const decision = this.autonomyPolicy.decide(capability);
      return this.autonomyPolicy.auditMetadata(decision);
    } catch {
      return {};
    }
  }

  // Record a denial issued by the host capability broker without creating an
  // approval for a tool that has no broker implementation.
  deny(taskId, call, { reason, kind = 'safety_denial' } = {}) {
    return this._record(taskId, call, { allow: false, kind, reason: String(reason || 'Capability denied') });
  }

  list(taskId) {
    this._expire();
    return [...this.approvals.values()].filter(record => taskId === undefined || record.taskId === taskId).map(clone);
  }

  approve(id) {
    this._expire();
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== 'pending' || !this.tasks.has(approval.taskId)) throw new Error('Approval is not pending or has expired');
    approval.status = 'approved';
    approval.approvedAt = this.now();
    this.emit('approval', clone(approval));
    return clone(approval);
  }

  reject(id) {
    this._expire();
    const approval = this.approvals.get(id);
    if (!approval || !['pending', 'approved'].includes(approval.status)) throw new Error('Approval is no longer available');
    approval.status = 'rejected';
    this.emit('approval', clone(approval));
    return clone(approval);
  }

  revokeTask(taskId) {
    this.tasks.delete(taskId);
    for (const approval of this.approvals.values()) {
      if (approval.taskId === taskId && ['pending', 'approved'].includes(approval.status)) {
        approval.status = 'revoked';
        this.emit('approval', clone(approval));
      }
    }
  }

  latchSafetyStop(taskId, reason, evidence = null) {
    if (!this.tasks.has(taskId)) throw new Error('Cannot latch an unknown task');
    const previous = this.safetyStops.get(taskId);
    const stop = previous || { taskId, reason: String(reason || 'Policy denied execution').slice(0, 500), evidence: evidence ? clone(evidence) : null, latchedAt: this.now() };
    this.safetyStops.set(taskId, stop);
    this.emit('audit', { timestamp: new Date(this.now()).toISOString(), taskId, decision: 'stop_latched', reason: stop.reason, evidence: stop.evidence });
    return clone(stop);
  }

  resolveSafetyStop(taskId, rationale) {
    if (typeof rationale !== 'string' || !rationale.trim() || rationale.length > 1000) throw new Error('Operator resolution rationale is required');
    const stop = this.safetyStops.get(taskId);
    if (!stop) throw new Error('Task has no latched safety stop');
    this.safetyStops.delete(taskId);
    this.emit('audit', { timestamp: new Date(this.now()).toISOString(), taskId, decision: 'stop_resolved', reason: rationale.trim(), priorStop: clone(stop), resolver: 'authenticated-local-operator' });
    return { ...clone(stop), resolvedAt: this.now(), resolution: rationale.trim(), resolvedBy: 'authenticated-local-operator' };
  }
}

module.exports = SafetyPolicy;
module.exports.SafetyPolicy = SafetyPolicy;
module.exports.TRUSTED_FILES = TRUSTED_FILES;
