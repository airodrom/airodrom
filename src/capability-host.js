'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CapabilityPolicy } = require('./capability-policy');
const { FilesystemScopes } = require('./fs-scopes');
const { HostExecutor } = require('./host-exec');
const { CapabilityInputError, keys, text, pattern, sha256, looksSecret, describeInputShape } = require('./capability-util');
const { classifyCommand } = require('./command-classifier');
const { fileCapabilities, TAR } = require('./capability-files');
const { developerCapabilities, ClaudeCodeJobs, toolStatus, claudeAuth, DEV_TOOLS } = require('./capability-devtools');
const { macCapabilities, loadLocalServices, EXECUTABLES } = require('./capability-mac');
const { capabilityApps } = require('./apps');
const { CONNECTORS } = require('./apps/capability-connectors');

const NAME = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_TOUCHED = 2_000;
// Audit keeps identifiers and labels; free text is reduced to size and digest.
const AUDIT_PLAIN_KEYS = new Set(['path', 'root', 'source', 'destination', 'archive', 'repo', 'app', 'service', 'tool', 'pid', 'signal', 'id', 'branch', 'remote', 'number', 'container', 'volume', 'tag', 'label', 'account', 'device', 'jobId', 'mode', 'manager', 'state', 'limit', 'taskType', 'size', 'privacy', 'provider', 'name', 'category', 'recursive', 'overwrite', 'force', 'setUpstream', 'staged', 'billing', 'wait', 'line', 'algorithm']);

function auditCapabilityInput(name, input) {
  const audit = { capability: typeof name === 'string' ? name : null };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return audit;
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    if (AUDIT_PLAIN_KEYS.has(key) && (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 400 && !looksSecret(value)))) audit[key] = value;
    else if (key === 'url' && typeof value === 'string') { try { audit.url_host = new URL(value).host; } catch { audit.url_invalid = true; } }
    else if (Array.isArray(value)) Object.assign(audit, { [`${key}Count`]: value.length, [`${key}Sha256`]: sha256(JSON.stringify(value)) });
    else if (typeof value === 'string') Object.assign(audit, { [`${key}Bytes`]: Buffer.byteLength(value), [`${key}Sha256`]: sha256(value) });
  }
  return audit;
}

class CapabilityHost {
  constructor({
    dataDir, home = os.homedir(), env = process.env, policy = null, scopes = null, exec = null, bridgeRoot = path.resolve(__dirname, '..'),
    protectedRoots = [], trustedFiles = [], saveTask = () => {}, requestBridgeRestart = null, webFetch = null, webEnabled = () => false,
    mcpConnected = () => false, bridgePids = () => [], localServicesPath = path.join(__dirname, '../config/local-services-v2.json'),
    protectedBranches = [], definitions = null, probeHttp = null
  } = {}) {
    this.policy = policy || new CapabilityPolicy();
    this.scopes = scopes || new FilesystemScopes({ home, bridgeRoot, dataDir, protectedRoots, trustedFiles });
    this.exec = exec || new HostExecutor({ allowed: [...EXECUTABLES, TAR], home });
    this.home = home; this.env = env; this.saveTask = saveTask; this.requestBridgeRestart = requestBridgeRestart;
    this.webFetch = webFetch; this.webEnabled = webEnabled; this.mcpConnected = mcpConnected; this.bridgePids = bridgePids;
    this.protectedBranches = protectedBranches;
    this.probeHttp = probeHttp || require('./capability-mac').probeHttp;
    this.jobs = new ClaudeCodeJobs();
    this.notificationState = { sent: [] };
    this.localServices = loadLocalServices(localServicesPath, this.scopes, this.exec);
    this.apps = capabilityApps();
    this.definitions = definitions || {
      ...this._metaCapabilities(), ...fileCapabilities(), ...developerCapabilities({ jobs: this.jobs }), ...macCapabilities({ notificationState: this.notificationState }),
      ...this.apps.definitions()
    };
    // Startup invariant: the policy matrix and the adapters describe exactly the
    // same capability set, so nothing executes without an explicit class.
    const missing = this.policy.names().filter(name => !this.definitions[name]);
    const unclassified = Object.keys(this.definitions).filter(name => !this.policy.entry(name));
    if (missing.length || unclassified.length) throw new Error(`Capability registry mismatch: missing adapters [${missing.join(', ')}], unclassified adapters [${unclassified.join(', ')}]`);
  }

  _context(task, operation = null, signal = null) {
    const executor = task.mission?.authority ? Object.assign(Object.create(this.exec), { run: (file, args, options = {}) => this.exec.run(file, args, {...options, signal, missionAuthority:task.mission.authority, allowGitMetadata:['git_stage','git_commit','git_branch_create','git_checkout','git_pull'].includes(operation)}) }) : this.exec;
    return {
      controlExecution: this.controlExecution, task, home: this.home, env: this.env, scopes: this.scopes, exec: executor, policy: this.policy,
      trashDir: path.join(this.home, '.Trash'), piOwnedRoot: this.scopes.piOwnedRoot, localServices: this.localServices,
      protectedBranches: this.protectedBranches, requestBridgeRestart: this.requestBridgeRestart, bridgePids: this.bridgePids,
      webFetch: input => this.webFetch ? this.webFetch(task, input) : Promise.reject(new Error('Web reader unavailable')), webEnabled: this.webEnabled,
      mcpConnected: this.mcpConnected, probeHttp: this.probeHttp,
      devtools: { claudeStatus: ctx => claudeAuth(ctx).then(auth => ({ installed: auth.installed, logged_in: auth.logged_in, auth_mode: auth.auth_mode,api_key_overrides_subscription:auth.api_key_overrides_subscription,running_jobs:[...this.jobs.jobs.values()].filter(j=>j.status==='running').length })), cursorStatus: ctx => toolStatus(ctx, 'cursor') },
      touched: () => Array.isArray(task.capabilityTouched) ? task.capabilityTouched : [],
      touch: file => this.touch(task, file)
    };
  }

  touch(task, file) {
    if (!task || typeof file !== 'string') return;
    const list = Array.isArray(task.capabilityTouched) ? task.capabilityTouched : [];
    let canonical = path.resolve(file);
    try { canonical = fs.realpathSync(canonical); } catch { try { canonical = path.join(fs.realpathSync(path.dirname(canonical)), path.basename(canonical)); } catch { /* keep lexical */ } }
    if (!list.includes(canonical)) list.push(canonical);
    task.capabilityTouched = list.slice(-MAX_TOUCHED);
    this.saveTask(task);
  }

  taskScopes(task) {
    try { return this.policy.normalizeTaskScopes(task?.capabilityScopes); } catch { return this.policy.defaultTaskScopes; }
  }

  /**
   * Validate and assess one call. Input errors throw CapabilityInputError; every
   * other outcome is a decision object so the central policy records it.
   */
  async prepare(task, name, rawInput = {}) {
    if (typeof name !== 'string' || !NAME.test(name) || !this.definitions[name]) {
      return { name, input: {}, assessment: this.policy.decide(String(name).slice(0, 64), { taskScopes: this.taskScopes(task) }) };
    }
    const definition = this.definitions[name];
    const input = definition.validate(rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : (() => { throw new CapabilityInputError('capability input must be an object'); })());
    if (task.mission?.authority) {
      const permissions = require('./mission-permissions');
      const ceiling = permissions.checkAuthority(task.mission.authority, permissions.callRequirements({toolName:'capability',input:{name,input}},task.workspace));
      if (task.mission.authorityRevoked || !ceiling.allow) return {name,input,assessment:{decision:'deny',kind:'mission_grant_denied',reason:task.mission.authorityRevoked ? 'Mission authority revoked' : ceiling.reason}};
    }
    const ctx = this._context(task);
    let assessed = { scope: null, dynamic: null, facts: null };
    const standing = this.policy.decide(name, { taskScopes: this.taskScopes(task) });
    // Inactive, unscoped and always-denied capabilities never touch the host.
    if ((standing.decision !== 'deny' || definition.pureAssess === true) && typeof definition.assess === 'function') {
      try { assessed = { ...assessed, ...(await definition.assess(ctx, input)) }; }
      catch (error) {
        if (error instanceof CapabilityInputError) throw error;
        assessed.dynamic = { decision: 'deny', kind: error.sensitive ? 'safety_denial' : 'capability_denied', riskClass: error.sensitive ? 'SECURITY' : undefined, reason: String(error.message || error).slice(0, 300) };
      }
    }
    const assessment = this.policy.decide(name, { taskScopes: this.taskScopes(task), dynamic: assessed.dynamic, scope: assessed.scope || null });
    return { name, input, assessment: { ...assessment, ...(assessed.facts ? { facts: assessed.facts } : {}) }, facts: assessed.facts || null };
  }

  async perform(task, prepared, {signal = null} = {}) {
    const permissions = require('./mission-permissions');
    const authority = task.mission?.authority ? permissions.checkAuthority(task.mission.authority, permissions.callRequirements({toolName:'capability',input:{name:prepared.name,input:prepared.input}},task.workspace)) : {allow:true};
    if (task.mission?.authorityRevoked || !authority.allow) throw Error(task.mission?.authorityRevoked ? 'Mission authority revoked' : authority.reason);
    const manifest=require('./mission-manifest').checkManifest(task.mission?.manifest,{toolName:'capability',input:{name:prepared.name,input:prepared.input}},task.workspace);
    if(!manifest.allow)throw Error(manifest.reason);
    const definition = this.definitions[prepared.name];
    if (!definition || prepared.assessment?.decision === 'deny') throw new Error('Capability is not executable');
    const started = Date.now();
    const result = await definition.perform(this._context(task,prepared.name,signal), prepared.input, prepared.assessment);
    return { capability: prepared.name, risk_class: prepared.assessment.risk_class, decision: prepared.assessment.decision, scope: prepared.assessment.scope || null, duration_ms: Date.now() - started, result };
  }

  auditInput(name, input) { return auditCapabilityInput(name, input); }

  // Operator-readable inventory: what Pi can do, what is detected, and what a
  // human must do first. Never includes credential values.
  async inventory({ task = null, detect = false } = {}) {
    const scopes = task ? this.taskScopes(task) : null;
    const rows = this.policy.names().map(name => {
      const decided = this.policy.decide(name, scopes ? { taskScopes: scopes } : {});
      const entry = this.policy.entry(name);
      return { capability: name, group: entry.group, risk_class: entry.riskClass, standing_decision: decided.standing_decision, effective_decision: decided.decision, active: decided.active, task_scopes: entry.taskScopes, connector: entry.connector || null, human_gate: decided.human_gate, ...(scopes ? { granted_to_task: !['capability_scope_denied'].includes(decided.kind) } : {}) };
    });
    const result = {
      policy_version: this.policy.policyVersion, base_policy_version: this.policy.document.basePolicyVersion, precedence: this.policy.document.precedence,
      task_scopes: scopes, default_task_scopes: this.policy.defaultTaskScopes, available_task_scopes: this.policy.taskScopes,
      filesystem: this.scopes.describe(), connectors: Object.fromEntries(Object.entries(CONNECTORS).map(([id, connector]) => [id, { label: connector.label, accounts: connector.accounts, status: 'not_connected', human_gate: this.policy.humanGate(connector.humanGate) }])),
      human_gates: this.policy.document.humanGates, always_deny: Object.keys(this.policy.document.alwaysDeny),
      counts: rows.reduce((acc, row) => { acc[row.effective_decision] = (acc[row.effective_decision] || 0) + 1; return acc; }, {}),
      capabilities: rows
    };
    if (detect) {
      const ctx = this._context(task || { id: 'inventory', workspace: null });
      result.detected = {
        developer_tools: (await this.definitions.developer_tool_list.perform(ctx, {})).tools,
        claude_code: await claudeAuth(ctx).then(auth => ({ installed: auth.installed, logged_in: auth.logged_in, auth_mode: auth.auth_mode,api_key_overrides_subscription:auth.api_key_overrides_subscription,running_jobs:[...this.jobs.jobs.values()].filter(j=>j.status==='running').length, api_key_overrides_subscription: auth.api_key_overrides_subscription })).catch(error => ({ error: error.message })),
        services: (await this.definitions.service_status.perform(ctx, {}).catch(error => ({ services: [], error: error.message }))).services,
        agents: (await this.definitions.agent_list.perform(ctx, {})).agents.map(agent => ({ id: agent.id, state: agent.state }))
      };
    }
    return result;
  }

  async agents() { return this.definitions.agent_list.perform(this._context({ id: 'agents', workspace: null }), {}); }

  // The developer tool a capability depends on, when it has a fixed one.
  _dependencyTool(name, entry) {
    if (entry.group === 'claude_code') return 'claude_code';
    if (entry.group === 'editors') return name.startsWith('cursor_') ? 'cursor' : name.startsWith('vscode_') ? 'vscode' : null;
    return { git: 'git', github: 'gh', containers: 'docker' }[entry.group] || null;
  }

  // Safe metadata for one capability: policy, required scopes, the input shape
  // its validator enforces, and whether its dependency is present. Never inputs,
  // outputs, paths of credentials or credential values.
  describe(name, { task = null } = {}) {
    const scopes = task ? this.taskScopes(task) : null;
    const decided = this.policy.decide(name, scopes ? { taskScopes: scopes } : {});
    const entry = this.policy.entry(name);
    const definition = entry && Object.hasOwn(this.definitions, name) ? this.definitions[name] : null;
    let dependency = { kind: 'host', available: decided.active === true };
    if (entry?.connector) dependency = { kind: 'connector', id: entry.connector, available: decided.active === true };
    else if (entry) {
      const tool = this._dependencyTool(name, entry);
      if (tool) dependency = { kind: 'developer_tool', id: tool, available: Boolean(this.exec.resolveFirst(DEV_TOOLS[tool].candidates)) };
    }
    return {
      capability: name, known: decided.found === true, group: decided.group || null, active: decided.active === true,
      risk_class: decided.risk_class, standing_decision: decided.standing_decision || null, policy_decision: decided.decision,
      automatic: decided.automatic === true, reason: decided.reason || null, kind: decided.kind || null,
      required_scopes: decided.task_scopes || null, ...(scopes ? { task_scopes: scopes, granted_to_task: decided.kind !== 'capability_scope_denied' } : {}),
      human_gate: decided.human_gate || null, policy_version: this.policy.policyVersion,
      input_schema: definition ? describeInputShape(definition.validate) : null,
      dependency: entry ? dependency : null
    };
  }

  // Agent availability for orchestration. Categorical auth fields only.
  async agentStatus() {
    const ctx = this._context({ id: 'agent-status', workspace: null });
    const [claude, cursor, auth, cursorRuntime] = await Promise.all([
      toolStatus(ctx, 'claude_code').catch(() => null), toolStatus(ctx, 'cursor').catch(() => null), claudeAuth(ctx).catch(() => null),
      require('./cursor-runtime').cursorRuntimeStatus({home:this.home,fixture:process.env.NODE_ENV==='test'}).catch(()=>({availability:'unknown',reason:'runtime_probe_unavailable'}))
    ]);
    const running = [...this.jobs.jobs.values()].filter(job => job.status === 'running')
      .map(job => ({ job_id: job.id, task_id: job.taskId, repo: job.repoDisplay, started_at: new Date(job.startedAt).toISOString() }));
    const installed = claude?.installed === true, authenticated = auth?.logged_in === true;
    return {
      claude_code: {
        installed, version: claude?.version || null, authenticated, subscription: auth?.subscription_type || 'unknown', auth_mode: auth?.auth_mode || 'unknown',
        api_key_overrides_subscription: auth?.api_key_overrides_subscription === true,
        availability: !installed ? 'not_installed' : authenticated ? 'available' : 'needs_login',
        running_jobs: running.length, jobs: running
      },
      cursor: { installed: cursor?.installed === true, version: cursor?.version || null, editor_available:cursor?.installed===true, availability:cursorRuntime.availability, runtime:cursorRuntime }
    };
  }

  shutdown() { this.jobs.shutdown(); }

  _metaCapabilities() {
    return {
      capability_list: {
        validate: input => { keys(input, [], ['group', 'detect']); if (input.group !== undefined) pattern(input.group, /^[a-z_]{2,40}$/, 'group'); if (input.detect !== undefined && typeof input.detect !== 'boolean') throw new CapabilityInputError('Invalid detect'); return input; },
        perform: async (ctx, input) => {
          const inventory = await this.inventory({ task: ctx.task, detect: input.detect === true });
          if (input.group) inventory.capabilities = inventory.capabilities.filter(row => row.group === input.group);
          return inventory;
        }
      },
      capability_status: {
        validate: input => { keys(input, ['capability']); pattern(input.capability, NAME, 'capability'); return input; },
        perform: (ctx, input) => {
          const decided = this.policy.decide(input.capability, { taskScopes: this.taskScopes(ctx.task) });
          return { capability: input.capability, known: decided.found, group: decided.group || null, risk_class: decided.risk_class, standing_decision: decided.standing_decision || null, effective_decision: decided.decision, reason: decided.reason, active: decided.active, task_scopes_required: decided.task_scopes || null, human_gate: decided.human_gate || null, user_action_required: Boolean(decided.human_gate) || decided.decision === 'approval_required' };
        }
      },
      command_classify: {
        validate: input => { keys(input, ['command'], ['cwd']); text(input.command, 'command', { max: 8_000 }); text(input.cwd, 'cwd', { optional: true }); return input; },
        perform: (ctx, input) => { const result = classifyCommand(input.command, { cwd: input.cwd || ctx.task.workspace }); return { class: result.class, decision: result.decision, reasons: result.reasons, executable_form: result.executableForm, executed: false }; }
      }
    };
  }
}

module.exports = { CapabilityHost, auditCapabilityInput };
