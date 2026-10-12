'use strict';

/**
 * Developer Memory V1 — Airodrom-governed repository knowledge.
 * Hindsight (when configured) is a subordinate provider; Personal Memory V2 is unchanged.
 * Repository identity and permissions are derived from trusted host task state only.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { HindsightHttpTransport } = require('./developer-memory-hindsight');
const { looksSecret } = require('./capability-util');

const TRUST = Object.freeze({
  CANONICAL_PROJECT_FACT: 'CANONICAL_PROJECT_FACT',
  VERIFIED_ENGINEERING_EVIDENCE: 'VERIFIED_ENGINEERING_EVIDENCE',
  HISTORICAL_DECISION: 'HISTORICAL_DECISION',
  SUPERSEDED_DECISION: 'SUPERSEDED_DECISION',
  UNVERIFIED_RETRIEVED_CONTENT: 'UNVERIFIED_RETRIEVED_CONTENT',
  MODEL_INTERPRETATION: 'MODEL_INTERPRETATION',
  UNKNOWN: 'UNKNOWN'
});

const DEFAULT_CONFIG_PATH = path.join(__dirname, '../config/developer-memory-v1.json');
const ALLOWED_SCOPES = new Set(['repo', 'developer_environment']);
const DESTRUCTIVE = new Set(['suppress', 'delete']);
/** Only ControlServer operator-authenticated surfaces may pass this token into mintOperatorApproval. */
const OPERATOR_CONTROL_SURFACE = Symbol('airodrom.developerMemory.operatorControlSurface');

function loadConfig(file = DEFAULT_CONFIG_PATH) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || raw.version !== 1) throw new Error('Unsupported developer-memory config version');
  return {
    version: 1,
    enabled: raw.enabled === true,
    provider: raw.provider === 'hindsight' ? 'hindsight' : 'none',
    allow_ingest: raw.allow_ingest === true,
    allow_retrieval: raw.allow_retrieval === true,
    allow_external: raw.allow_external === true,
    require_operator_approval_for_destructive: raw.require_operator_approval_for_destructive !== false,
    hindsight: {
      base_url: String(raw.hindsight?.base_url || 'http://127.0.0.1:8888'),
      api_token_env: String(raw.hindsight?.api_token_env || 'HINDSIGHT_API_TOKEN'),
      timeout_ms: Number(raw.hindsight?.timeout_ms) || 4000,
      max_retries: Number(raw.hindsight?.max_retries) || 1,
      circuit_failures: Number(raw.hindsight?.circuit_failures) || 3,
      circuit_cooldown_ms: Number(raw.hindsight?.circuit_cooldown_ms) || 30_000,
      pinned_client_version: String(raw.hindsight?.pinned_client_version || '0.10.3'),
      transport: String(raw.hindsight?.transport || 'http_loopback')
    },
    limits: {
      max_results: Math.min(20, Math.max(1, Number(raw.limits?.max_results) || 8)),
      max_item_chars: Math.min(8000, Math.max(200, Number(raw.limits?.max_item_chars) || 1200)),
      max_pack_chars: Math.min(16_000, Math.max(400, Number(raw.limits?.max_pack_chars) || 2400)),
      max_retain_chars: Math.min(16_000, Math.max(200, Number(raw.limits?.max_retain_chars) || 4000))
    },
    allowed_source_kinds: Array.isArray(raw.allowed_source_kinds) ? raw.allowed_source_kinds.slice(0, 32) : [],
    // Empty allowlist fails closed while enabled. Entries are host-derived repositoryId + bankId only.
    allowed_repositories: normalizeAllowedRepositories(raw.allowed_repositories)
  };
}

function normalizeAllowedRepositories(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const row of value.slice(0, 64)) {
    if (!row || typeof row !== 'object') continue;
    const repositoryId = typeof row.repository_id === 'string' ? row.repository_id : null;
    const bankId = typeof row.bank_id === 'string' ? row.bank_id : null;
    if (!repositoryId || !/^[a-f0-9]{64}$/.test(repositoryId)) continue;
    if (!bankId || !/^airo-dev-[a-f0-9]{32}$/.test(bankId)) continue;
    if (bankId !== `airo-dev-${repositoryId.slice(0, 32)}`) continue;
    out.push({ repository_id: repositoryId, bank_id: bankId });
  }
  return out;
}

/** Host-derived identity must match an explicit operator allowlist entry. */
function repositoryAllowlisted(identity, config) {
  if (!identity?.repositoryId || !identity?.bankId) return false;
  const allowed = Array.isArray(config?.allowed_repositories) ? config.allowed_repositories : [];
  if (!allowed.length) return false;
  return allowed.some(row => row.repository_id === identity.repositoryId && row.bank_id === identity.bankId);
}

function gitBin() {
  for (const candidate of [
    '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
    '/Library/Developer/CommandLineTools/usr/bin/git',
    '/usr/bin/git',
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git'
  ]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

function repositoryIdentity(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new Error('Repository workspace required');
  const observed = fs.realpathSync(workspaceRoot);
  const git = gitBin();
  if (!git) throw new Error('Git unavailable for repository identity');
  const run = (cwd, args) => {
    const r = spawnSync(git, ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
      env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' }
    });
    if (r.status !== 0) throw new Error('Repository identity observation unavailable');
    return r.stdout.trim();
  };
  const toplevel = fs.realpathSync(run(observed, ['rev-parse', '--show-toplevel']));
  if (toplevel !== observed && !observed.startsWith(`${toplevel}${path.sep}`)) {
    throw new Error('Workspace is outside repository toplevel');
  }
  let remote = null;
  const remoteProbe = spawnSync(git, ['-C', toplevel, 'config', '--get', 'remote.origin.url'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' }
  });
  if (remoteProbe.status === 0) remote = remoteProbe.stdout.trim() || null;
  const head = run(toplevel, ['rev-parse', 'HEAD']);
  // Linked worktrees share --git-common-dir but have distinct toplevels. Canonical bank
  // identity is therefore git-common-dir + remote (not mutable basename / worktree path).
  let gitDirRaw = run(toplevel, ['rev-parse', '--git-common-dir']);
  if (!path.isAbsolute(gitDirRaw)) gitDirRaw = path.resolve(toplevel, gitDirRaw);
  const gitDir = fs.realpathSync(gitDirRaw);
  const material = JSON.stringify({ git_common_dir: gitDir, remote });
  const repositoryId = createHash('sha256').update(material).digest('hex');
  const bankId = `airo-dev-${repositoryId.slice(0, 32)}`;
  return {
    repositoryId,
    bankId,
    root: toplevel,
    head,
    remote_fingerprint: remote ? createHash('sha256').update(remote).digest('hex') : null,
    git_common_dir: gitDir
  };
}

function prepareSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS developer_memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS developer_memory_items (
      memory_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      bank_id TEXT NOT NULL,
      provider_ref TEXT,
      document_id TEXT,
      source_kind TEXT NOT NULL,
      source_ref TEXT,
      content_hash TEXT NOT NULL,
      trust_label TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','superseded','suppressed','deleted')),
      supersedes TEXT,
      policy_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS developer_memory_repo_status
      ON developer_memory_items(repository_id, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS developer_memory_suppressions (
      suppression_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      memory_id TEXT,
      provider_ref TEXT,
      document_id TEXT,
      content_hash TEXT,
      reason TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS developer_memory_suppression_lookup
      ON developer_memory_suppressions(repository_id, content_hash, provider_ref, document_id);
  `);
  const version = db.prepare("SELECT value FROM developer_memory_meta WHERE key='schema_version'").get();
  if (!version) db.prepare("INSERT INTO developer_memory_meta(key,value) VALUES('schema_version','1')").run();
}

function scopesFromTask(task) {
  const fromMission = task?.mission?.envelope?.capability_scopes
    || task?.mission?.capability_scopes
    || task?.capabilityScopes
    || task?.capability_scopes;
  if (!Array.isArray(fromMission)) return null;
  return fromMission.filter(s => typeof s === 'string');
}

/**
 * Host-verified destructive approval. A caller-supplied `operatorApproved`
 * boolean never independently grants approval — only host.verifyOperatorApproval
 * (or an equivalent host-minted single-use approval id verified by the host).
 */
function verifyDestructiveApproval(request, host, config) {
  if (!DESTRUCTIVE.has(request?.operation)) return { ok: true };
  if (!config.require_operator_approval_for_destructive) return { ok: true };
  if (!host || typeof host.verifyOperatorApproval !== 'function') {
    return { ok: false, reason: 'operator_approval_required' };
  }
  let verified;
  try {
    verified = host.verifyOperatorApproval({
      operation: request.operation,
      taskId: request.taskId,
      approvalId: typeof request.operatorApprovalId === 'string' ? request.operatorApprovalId : null,
      repositoryId: typeof request.repositoryId === 'string' ? request.repositoryId : null
    });
  } catch {
    return { ok: false, reason: 'operator_approval_verification_failed' };
  }
  if (verified === true || verified?.verified === true || verified?.allow === true) {
    return { ok: true, reason: 'host_verified' };
  }
  return {
    ok: false,
    reason: (typeof verified?.reason === 'string' && verified.reason) || 'operator_approval_required'
  };
}

/**
 * Authorize a developer-memory operation from trusted host state.
 * Caller-supplied repositoryId/bankId are never trusted — host identity wins.
 * Allowlist gates search/retrieve/retain/ContextPack. Owner-authenticated
 * suppress/delete may proceed after revocation without restoring retrieval.
 */
function authorize(request, config, host = null) {
  if (!request || typeof request !== 'object') return { allow: false, reason: 'missing_request' };
  if (!config.enabled) return { allow: false, reason: 'feature_disabled' };
  if (!request.taskId || typeof request.taskId !== 'string') return { allow: false, reason: 'missing_task_identity' };
  if (request.modelBankId !== undefined) return { allow: false, reason: 'model_bank_impersonation_denied' };
  if (!['search', 'retrieve', 'retain', 'suppress', 'delete', 'health', 'provenance'].includes(request.operation)) {
    return { allow: false, reason: 'unknown_operation' };
  }
  if (request.operation === 'retain' && !config.allow_ingest) return { allow: false, reason: 'ingest_disabled' };
  if ((request.operation === 'search' || request.operation === 'retrieve') && !config.allow_retrieval) {
    return { allow: false, reason: 'retrieval_disabled' };
  }

  const destructive = DESTRUCTIVE.has(request.operation);
  if (destructive && config.require_operator_approval_for_destructive) {
    // Boolean flags from callers/models are explicitly non-authorizing.
    if (request.operatorApproved === true && !request.operatorApprovalId) {
      return { allow: false, reason: 'operator_approval_boolean_rejected' };
    }
  }

  let identity = null;
  let scopes = null;
  if (host && typeof host.resolveTask === 'function') {
    let task;
    try { task = host.resolveTask(request.taskId); }
    catch { return { allow: false, reason: 'task_lookup_failed' }; }
    if (!task || !task.id || task.id !== request.taskId) return { allow: false, reason: 'task_not_authenticated' };
    const workspace = task.mission?.envelope?.workspace || task.workspace;
    if (!workspace) return { allow: false, reason: 'missing_host_workspace' };
    try { identity = repositoryIdentity(workspace); }
    catch { return { allow: false, reason: 'repository_unresolved' }; }
    scopes = scopesFromTask(task);
    if (!scopes || !scopes.length) return { allow: false, reason: 'capability_scope_absent' };
    if (!scopes.some(s => ALLOWED_SCOPES.has(s))) return { allow: false, reason: 'capability_scope_denied' };
    // Reject caller impersonation of another repository/bank.
    if (request.repositoryId && request.repositoryId !== identity.repositoryId) {
      return { allow: false, reason: 'caller_repository_impersonation_denied' };
    }
    if (request.bankId && request.bankId !== identity.bankId) {
      return { allow: false, reason: 'caller_bank_impersonation_denied' };
    }
    if (request.expectedBankId && request.expectedBankId !== identity.bankId) {
      return { allow: false, reason: 'repository_mismatch' };
    }
  } else {
    // Fixture / unit path: require explicit host-derived identity fields, never modelBankId.
    if (!request.repositoryId || typeof request.repositoryId !== 'string') {
      return { allow: false, reason: 'missing_repository_identity' };
    }
    if (!request.bankId || request.bankId !== request.expectedBankId) {
      return { allow: false, reason: 'repository_mismatch' };
    }
    if (!Array.isArray(request.capabilityScopes) || !request.capabilityScopes.length) {
      return { allow: false, reason: 'capability_scope_absent' };
    }
    if (!request.capabilityScopes.some(s => ALLOWED_SCOPES.has(s))) {
      return { allow: false, reason: 'capability_scope_denied' };
    }
    identity = { repositoryId: request.repositoryId, bankId: request.bankId };
    scopes = request.capabilityScopes;
  }

  // Owner cleanup after allowlist revocation: verify single-use approval against
  // host-derived repository identity. Never treat cleanup as retrieval authority.
  if (destructive && config.require_operator_approval_for_destructive) {
    const approval = verifyDestructiveApproval({
      ...request,
      repositoryId: identity.repositoryId
    }, host, config);
    if (!approval.ok) return { allow: false, reason: approval.reason, identity };
  }

  const allowlisted = repositoryAllowlisted(identity, config);
  // Global enable/retrieval flags never grant cross-repository access.
  // Destructive cleanup is the sole exception and does not restore retrieval.
  if (!destructive && !allowlisted) {
    return { allow: false, reason: 'repository_not_allowlisted', identity };
  }

  if (request.operation === 'retain') {
    if (!config.allowed_source_kinds.includes(request.sourceKind)) return { allow: false, reason: 'source_kind_denied' };
  }

  return {
    allow: true,
    reason: allowlisted ? 'authorized' : 'authorized_cleanup_revoked',
    cleanup_only: destructive && !allowlisted,
    policy_version: `developer-memory-v${config.version}`,
    identity,
    scopes
  };
}

function truncate(text, maximum) {
  if (typeof text !== 'string') return '';
  if (text.length <= maximum) return text;
  return text.slice(0, maximum);
}

function hashContent(content) {
  return createHash('sha256').update(String(content || '')).digest('hex');
}

class DeveloperMemory {
  constructor({
    db = null,
    configPath = DEFAULT_CONFIG_PATH,
    config = null,
    transport = null,
    now = Date.now,
    env = process.env,
    resolveTask = null
  } = {}) {
    this.configPath = configPath;
    this.config = config || loadConfig(configPath);
    this.db = db;
    this.now = now;
    this.env = env;
    this.resolveTask = typeof resolveTask === 'function' ? resolveTask : null;
    if (this.db) prepareSchema(this.db);
    this.transport = transport || this._buildTransport();
    this._contextCache = new Map();
    /** @type {Map<string, {operation:string,taskId:string,repositoryId:string|null,expiresAt:number}>} */
    this._operatorApprovals = new Map();
  }

  /**
   * Mint a single-use destructive approval. Requires the authenticated
   * operator control-plane surface token — models, workers, MCP, and bare
   * in-process callers cannot manufacture human consent.
   */
  mintOperatorApproval(input = {}) {
    if (input?.[OPERATOR_CONTROL_SURFACE] !== true) {
      throw new Error('operator_control_surface_required');
    }
    const { operation, taskId, ttlMs = 120_000 } = input;
    if (!DESTRUCTIVE.has(operation)) throw new Error('Not a destructive developer-memory operation');
    if (typeof taskId !== 'string' || !taskId) throw new Error('taskId required for operator approval');
    // Bind approval to host-derived repository identity when a task resolver exists.
    // Never accept model-supplied repository permissions as the binding source.
    let repositoryId = null;
    if (this.resolveTask) {
      let task;
      try { task = this.resolveTask(taskId); }
      catch { throw new Error('task_lookup_failed'); }
      if (!task || task.id !== taskId) throw new Error('task_not_authenticated');
      const workspace = task.mission?.envelope?.workspace || task.workspace;
      if (!workspace) throw new Error('missing_host_workspace');
      repositoryId = repositoryIdentity(workspace).repositoryId;
    } else if (typeof input.repositoryId === 'string' && /^[a-f0-9]{64}$/.test(input.repositoryId)) {
      repositoryId = input.repositoryId;
    }
    const approvalId = randomUUID();
    const expiresAt = this.now() + Math.min(Math.max(Number(ttlMs) || 120_000, 1_000), 600_000);
    this._operatorApprovals.set(approvalId, {
      operation,
      taskId,
      repositoryId,
      expiresAt
    });
    return { approvalId, expiresAt, operation, taskId, repositoryId, single_use: true, authority: false };
  }

  /** Test/host helper: mark an options object as coming from the operator control plane. */
  static withOperatorControlSurface(input = {}) {
    return { ...input, [OPERATOR_CONTROL_SURFACE]: true };
  }

  _verifyApproval({ operation, taskId, approvalId, repositoryId = null } = {}) {
    if (typeof approvalId !== 'string' || !approvalId) {
      return { verified: false, reason: 'operator_approval_required' };
    }
    const row = this._operatorApprovals.get(approvalId);
    if (!row) return { verified: false, reason: 'operator_approval_unknown' };
    if (row.expiresAt <= this.now()) {
      this._operatorApprovals.delete(approvalId);
      return { verified: false, reason: 'operator_approval_expired' };
    }
    if (row.operation !== operation) {
      return { verified: false, reason: 'operator_approval_operation_mismatch' };
    }
    if (row.taskId !== taskId) {
      return { verified: false, reason: 'operator_approval_task_mismatch' };
    }
    if (row.repositoryId && repositoryId && row.repositoryId !== repositoryId) {
      return { verified: false, reason: 'operator_approval_repository_mismatch' };
    }
    // Single-use: consume before returning success.
    this._operatorApprovals.delete(approvalId);
    return { verified: true, reason: 'host_verified' };
  }

  _host() {
    const host = {
      verifyOperatorApproval: (req) => this._verifyApproval(req)
    };
    if (this.resolveTask) host.resolveTask = (id) => this.resolveTask(id);
    return host;
  }

  _buildTransport() {
    if (!this.config.enabled || this.config.provider !== 'hindsight') return null;
    const tokenEnv = this.config.hindsight.api_token_env;
    const apiToken = tokenEnv && this.env[tokenEnv] ? String(this.env[tokenEnv]) : null;
    return new HindsightHttpTransport({
      baseUrl: this.config.hindsight.base_url,
      apiToken,
      timeoutMs: this.config.hindsight.timeout_ms,
      maxRetries: this.config.hindsight.max_retries,
      circuitFailures: this.config.hindsight.circuit_failures,
      circuitCooldownMs: this.config.hindsight.circuit_cooldown_ms,
      allowExternal: this.config.allow_external === true,
      now: this.now
    });
  }

  health() {
    if (!this.config.enabled) {
      return { status: 'disabled', provider: this.config.provider, authority: false };
    }
    if (!this.transport) {
      return { status: 'unavailable', provider: this.config.provider, authority: false, error_class: 'no_transport' };
    }
    return this.transport.health().then(h => ({ ...h, provider: 'hindsight', authority: false, transport: this.transport.status() }));
  }

  resolveRepository(workspaceRoot) {
    return repositoryIdentity(workspaceRoot);
  }

  _suppressed(repositoryId, { memoryId = null, providerRef = null, documentId = null, contentHash = null } = {}) {
    if (!this.db) return false;
    const row = this.db.prepare(`
      SELECT 1 AS ok FROM developer_memory_suppressions
      WHERE repository_id = ?
        AND (
          (? IS NOT NULL AND memory_id = ?)
          OR (? IS NOT NULL AND provider_ref = ?)
          OR (? IS NOT NULL AND document_id = ?)
          OR (? IS NOT NULL AND content_hash = ?)
        )
      LIMIT 1
    `).get(repositoryId, memoryId, memoryId, providerRef, providerRef, documentId, documentId, contentHash, contentHash);
    return Boolean(row);
  }

  _invalidateCache({ taskId = null, repositoryId = null } = {}) {
    if (taskId) this._contextCache.delete(taskId);
    if (repositoryId) {
      for (const [key, value] of this._contextCache.entries()) {
        if (value?.repositoryId === repositoryId) this._contextCache.delete(key);
      }
    }
  }

  async search(input) {
    const auth = authorize({ ...input, operation: 'search' }, this.config, this._host());
    if (!auth.allow) return { status: auth.reason, items: [], authority: false };
    if (!this.transport) return { status: 'unavailable', items: [], authority: false };
    const { repositoryId, bankId } = auth.identity;
    let recalled;
    try {
      recalled = await this.transport.recall(bankId, String(input.query || '').slice(0, 2000), {
        budget: 'low',
        maxTokens: Math.min(2048, this.config.limits.max_pack_chars),
        signal: input.signal
      });
    } catch {
      return { status: 'unavailable', items: [], authority: false, transport: this.transport.status() };
    }
    const results = Array.isArray(recalled?.results) ? recalled.results : [];
    const items = [];
    let used = 0;
    for (const row of results) {
      if (items.length >= this.config.limits.max_results) break;
      const text = truncate(typeof row.text === 'string' ? row.text : (row.content || ''), this.config.limits.max_item_chars);
      if (!text) continue;
      const contentHash = hashContent(text);
      const providerRef = row.id || row.memory_id || row.chunk_id || null;
      const documentId = row.document_id || row.documentId || null;
      if (this._suppressed(repositoryId, { providerRef, documentId, contentHash })) continue;
      const size = Buffer.byteLength(text);
      if (used + size > this.config.limits.max_pack_chars) break;
      used += size;
      items.push({
        memoryId: randomUUID(),
        providerRef,
        documentId,
        content: text,
        contentHash,
        trustLabel: TRUST.UNVERIFIED_RETRIEVED_CONTENT,
        type: row.type || 'unknown',
        authority: false,
        repositoryId,
        bankId
      });
    }
    return { status: 'ok', items, usedChars: used, authority: false, trust: TRUST.UNVERIFIED_RETRIEVED_CONTENT, repositoryId, bankId };
  }

  async retrieve(input) {
    return this.search(input);
  }

  async retain(input) {
    const auth = authorize({ ...input, operation: 'retain' }, this.config, this._host());
    if (!auth.allow) return { status: auth.reason, authority: false };
    if (!this.transport) return { status: 'unavailable', authority: false };
    const { repositoryId, bankId } = auth.identity;
    const content = truncate(String(input.content || ''), this.config.limits.max_retain_chars);
    if (!content.trim()) return { status: 'empty_content', authority: false };
    if (looksSecret(content)) return { status: 'secret_content_denied', authority: false };
    const contentHash = hashContent(content);
    if (this._suppressed(repositoryId, { contentHash, documentId: input.documentId || null })) {
      return { status: 'suppressed', authority: false };
    }
    const memoryId = randomUUID();
    const documentId = input.documentId || `airo-${memoryId}`;
    try {
      await this.transport.ensureBank(bankId, { name: `Airodrom ${repositoryId.slice(0, 12)}` });
      await this.transport.retain(bankId, content, {
        context: input.context || input.sourceKind,
        documentId,
        metadata: {
          airodrom_memory_id: memoryId,
          source_kind: input.sourceKind,
          source_ref: input.sourceRef || null,
          repository_id: repositoryId,
          trust_label: TRUST.VERIFIED_ENGINEERING_EVIDENCE,
          authority: false
        },
        signal: input.signal
      });
    } catch {
      return { status: 'unavailable', authority: false, transport: this.transport.status() };
    }
    if (this.db) {
      const now = this.now();
      this.db.prepare(`
        INSERT INTO developer_memory_items(
          memory_id, repository_id, bank_id, provider_ref, document_id, source_kind, source_ref,
          content_hash, trust_label, status, supersedes, policy_version, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?,?)
      `).run(
        memoryId, repositoryId, bankId, null, documentId, input.sourceKind, input.sourceRef || null,
        contentHash, TRUST.VERIFIED_ENGINEERING_EVIDENCE, input.supersedes || null, auth.policy_version, now, now
      );
    }
    this._invalidateCache({ taskId: input.taskId, repositoryId });
    return { status: 'retained', memoryId, documentId, contentHash, authority: false, trustLabel: TRUST.VERIFIED_ENGINEERING_EVIDENCE, repositoryId, bankId };
  }

  /**
   * Canonical retained-row metadata is authoritative for cleanup targeting.
   * Model-supplied bank/document fields cannot redirect erasure across repos.
   */
  _canonicalRetainTarget(input, identity) {
    if (!this.db || typeof input?.memoryId !== 'string' || !input.memoryId) {
      return { ok: true, documentId: input?.documentId || null, contentHash: input?.contentHash || null };
    }
    const row = this.db.prepare(
      'SELECT repository_id, bank_id, document_id, content_hash, status FROM developer_memory_items WHERE memory_id=?'
    ).get(input.memoryId);
    if (!row) return { ok: false, reason: 'memory_not_found' };
    if (row.repository_id !== identity.repositoryId) return { ok: false, reason: 'repository_mismatch' };
    if (row.bank_id !== identity.bankId) return { ok: false, reason: 'bank_mismatch' };
    if (input.documentId && row.document_id && input.documentId !== row.document_id) {
      return { ok: false, reason: 'document_identity_mismatch' };
    }
    return {
      ok: true,
      documentId: row.document_id || input.documentId || null,
      contentHash: row.content_hash || input.contentHash || null,
      status: row.status
    };
  }

  _suppressAuthorized(auth, input) {
    if (!this.db) return { status: 'store_unavailable', authority: false };
    const { repositoryId } = auth.identity;
    const canonical = this._canonicalRetainTarget(input, auth.identity);
    if (!canonical.ok) return { status: canonical.reason, authority: false };
    const suppressionId = randomUUID();
    const now = this.now();
    this.db.prepare(`
      INSERT INTO developer_memory_suppressions(
        suppression_id, repository_id, memory_id, provider_ref, document_id, content_hash, reason, policy_version, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      suppressionId, repositoryId, input.memoryId || null, input.providerRef || null,
      canonical.documentId, canonical.contentHash, String(input.reason || 'operator_suppress').slice(0, 200),
      auth.policy_version, now
    );
    if (input.memoryId) {
      this.db.prepare("UPDATE developer_memory_items SET status='suppressed', updated_at=? WHERE memory_id=? AND repository_id=?")
        .run(now, input.memoryId, repositoryId);
    }
    this._invalidateCache({ taskId: input.taskId, repositoryId });
    return {
      status: 'suppressed',
      suppressionId,
      authority: false,
      repositoryId,
      cleanup_only: auth.cleanup_only === true
    };
  }

  suppress(input) {
    const auth = authorize({ ...input, operation: 'suppress' }, this.config, this._host());
    if (!auth.allow) return { status: auth.reason, authority: false, cleanup_only: false };
    return this._suppressAuthorized(auth, input);
  }

  async delete(input) {
    const auth = authorize({ ...input, operation: 'delete' }, this.config, this._host());
    if (!auth.allow) return { status: auth.reason, authority: false, cleanup_only: false };
    const canonical = this._canonicalRetainTarget(input, auth.identity);
    if (!canonical.ok) return { status: canonical.reason, authority: false, cleanup_only: auth.cleanup_only === true };
    // Delete approval already host-verified; apply logical suppression without a second mint.
    const suppressed = this._suppressAuthorized(auth, {
      ...input,
      documentId: canonical.documentId,
      contentHash: canonical.contentHash,
      reason: input.reason || 'operator_delete'
    });
    if (suppressed.status !== 'suppressed') return suppressed;
    let provider = 'not_requested';
    if (this.config.enabled && this.transport && auth.identity.bankId && canonical.documentId) {
      try {
        await this.transport.deleteDocument(auth.identity.bankId, canonical.documentId, { signal: input.signal });
        provider = 'requested';
      } catch {
        provider = 'request_failed_suppression_held';
      }
    }
    if (this.db && input.memoryId) {
      this.db.prepare("UPDATE developer_memory_items SET status='deleted', updated_at=? WHERE memory_id=? AND repository_id=?")
        .run(this.now(), input.memoryId, auth.identity.repositoryId);
    }
    this._invalidateCache({ taskId: input.taskId, repositoryId: auth.identity.repositoryId });
    return {
      status: 'deleted_logical',
      suppressionId: suppressed.suppressionId,
      provider_deletion: provider,
      forensic_erasure_claimed: false,
      authority: false,
      cleanup_only: auth.cleanup_only === true
    };
  }

  getProvenance(input) {
    const memoryId = typeof input === 'string' ? input : input?.memoryId;
    const request = typeof input === 'string'
      ? { operation: 'provenance', taskId: null, memoryId }
      : { ...input, operation: 'provenance' };
    if (!this.db || typeof memoryId !== 'string') return null;
    // Provenance requires authenticated task when host binding is present.
    if (this.resolveTask) {
      const auth = authorize(request, this.config, this._host());
      if (!auth.allow) return { status: auth.reason, authority: false };
    }
    const row = this.db.prepare('SELECT * FROM developer_memory_items WHERE memory_id=?').get(memoryId);
    if (!row) return null;
    if (this.resolveTask) {
      const auth = authorize(request, this.config, this._host());
      if (auth.allow && row.repository_id !== auth.identity.repositoryId) {
        return { status: 'repository_mismatch', authority: false };
      }
    }
    return {
      memoryId: row.memory_id,
      repositoryId: row.repository_id,
      bankId: row.bank_id,
      documentId: row.document_id,
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
      contentHash: row.content_hash,
      trustLabel: row.trust_label,
      status: row.status,
      supersedes: row.supersedes,
      policyVersion: row.policy_version,
      authority: false
    };
  }

  /**
   * Prefetch from an authenticated Mission/task — host derives identity and scopes.
   */
  async prefetchForMission(mission, task, { signal } = {}) {
    if (!this.config.enabled || !this.config.allow_retrieval) {
      return { status: this.config.enabled ? 'retrieval_disabled' : 'disabled', items: [], authority: false };
    }
    if (!mission || !task?.id) return { status: 'missing_task_identity', items: [], authority: false };
    if (mission.envelope?.kind === 'conversation' || mission.envelope?.worker_contract) {
      return { status: 'not_applicable', items: [], authority: false };
    }
    const workspace = mission.envelope?.workspace || task.workspace;
    const query = String(mission.envelope?.objective || task.description || '').slice(0, 2000);
    return this.prefetchContext({
      taskId: task.id,
      workspaceRoot: workspace,
      query,
      capabilityScopes: scopesFromTask(task) || mission.envelope?.capability_scopes || ['repo'],
      signal,
      hostBound: true
    });
  }

  async prefetchContext({
    taskId,
    workspaceRoot,
    query,
    capabilityScopes = ['repo'],
    signal = undefined,
    hostBound = false
  } = {}) {
    if (!this.config.enabled || !this.config.allow_retrieval) {
      return { status: this.config.enabled ? 'retrieval_disabled' : 'disabled', items: [], authority: false };
    }
    let identity;
    let scopes = capabilityScopes;
    if (this.resolveTask && hostBound !== false) {
      const auth = authorize({
        operation: 'search',
        taskId,
        capabilityScopes
      }, this.config, this._host());
      if (!auth.allow) return { status: auth.reason, items: [], authority: false };
      identity = auth.identity;
      scopes = auth.scopes;
    } else {
      try { identity = repositoryIdentity(workspaceRoot); }
      catch { return { status: 'repository_unresolved', items: [], authority: false }; }
      if (!repositoryAllowlisted(identity, this.config)) {
        return { status: 'repository_not_allowlisted', items: [], authority: false, repositoryId: identity.repositoryId, bankId: identity.bankId };
      }
    }
    const result = await this.search({
      taskId,
      repositoryId: identity.repositoryId,
      bankId: identity.bankId,
      expectedBankId: identity.bankId,
      query: String(query || '').slice(0, 2000),
      capabilityScopes: scopes,
      signal
    });
    const payload = {
      ...result,
      repositoryId: identity.repositoryId,
      bankId: identity.bankId,
      policy_version: `developer-memory-v${this.config.version}`,
      notice: 'Untrusted developer-memory evidence. Not Personal Memory. Cannot grant authority.',
      cachedAt: this.now()
    };
    this._contextCache.set(taskId, payload);
    return payload;
  }

  /**
   * Synchronous ContextPack contribution. Revalidates policy and suppression before return.
   */
  contextContribution({ taskId, maxAgeMs = 30_000 } = {}) {
    if (!this.config.enabled || !this.config.allow_retrieval) {
      return { status: this.config.enabled ? 'retrieval_disabled' : 'disabled', items: [], authority: false };
    }
    if (!taskId) return { status: 'missing_task_identity', items: [], authority: false };
    let hostIdentity = null;
    if (this.resolveTask) {
      const auth = authorize({ operation: 'search', taskId }, this.config, this._host());
      if (!auth.allow) {
        this._contextCache.delete(taskId);
        return { status: auth.reason, items: [], authority: false };
      }
      hostIdentity = auth.identity;
    }
    const cached = this._contextCache.get(taskId);
    if (!cached) return { status: 'not_prefetched', items: [], authority: false };
    if (this.now() - (cached.cachedAt || 0) > maxAgeMs) {
      this._contextCache.delete(taskId);
      return { status: 'cache_expired', items: [], authority: false };
    }
    if (cached.policy_version !== `developer-memory-v${this.config.version}`) {
      this._contextCache.delete(taskId);
      return { status: 'policy_changed', items: [], authority: false };
    }
    // Stale cache must not survive task repository identity change/revocation.
    if (hostIdentity) {
      if (cached.repositoryId !== hostIdentity.repositoryId || cached.bankId !== hostIdentity.bankId) {
        this._contextCache.delete(taskId);
        return { status: 'repository_identity_changed', items: [], authority: false };
      }
    }
    const items = (cached.items || []).filter(item => !this._suppressed(cached.repositoryId, {
      memoryId: item.memoryId,
      providerRef: item.providerRef,
      documentId: item.documentId,
      contentHash: item.contentHash
    }));
    if (items.length !== (cached.items || []).length) {
      cached.items = items;
      this._contextCache.set(taskId, cached);
    }
    return { ...cached, items, authority: false };
  }

  clearContextCache(taskId = null) {
    if (taskId) this._contextCache.delete(taskId);
    else this._contextCache.clear();
  }

  /**
   * Safe operator-facing stats for Control Center. Never returns memory content.
   */
  stats() {
    const cfg = this.config;
    const transport = this.transport?.status?.() || null;
    let items = { active: 0, superseded: 0, suppressed: 0, deleted: 0 };
    let suppressions = 0;
    if (this.db) {
      try {
        for (const row of this.db.prepare('SELECT status, count(*) n FROM developer_memory_items GROUP BY status').all()) {
          if (Object.prototype.hasOwnProperty.call(items, row.status)) items[row.status] = row.n;
        }
        suppressions = this.db.prepare('SELECT count(*) n FROM developer_memory_suppressions').get().n;
      } catch { /* schema may be absent on old installs */ }
    }
    const active = items.active;
    const capacity = 500;
    return {
      enabled: cfg.enabled === true,
      allow_ingest: cfg.allow_ingest === true,
      allow_retrieval: cfg.allow_retrieval === true,
      allow_external: cfg.allow_external === true,
      allowed_repository_count: Array.isArray(cfg.allowed_repositories) ? cfg.allowed_repositories.length : 0,
      provider: cfg.provider,
      authority: false,
      transport: transport ? {
        circuit_open: transport.circuit_open === true,
        failures: transport.failures || 0,
        allow_external: transport.allow_external === true,
        api_prefix: transport.api_prefix || null
      } : null,
      items,
      suppressions,
      prefetch_cache_entries: this._contextCache.size,
      limits: { ...cfg.limits },
      capacity,
      capacity_kind: 'reference_soft',
      used: active,
      percent: Math.min(100, Math.round((active / capacity) * 100)),
      state: !cfg.enabled
        ? 'Disabled'
        : !transport
          ? 'Configured'
          : transport.circuit_open
            ? 'Degraded'
            : (cfg.allow_retrieval || cfg.allow_ingest)
              ? 'Ready'
              : 'Configured'
    };
  }
}

module.exports = {
  DeveloperMemory,
  loadConfig,
  authorize,
  verifyDestructiveApproval,
  repositoryIdentity,
  repositoryAllowlisted,
  normalizeAllowedRepositories,
  prepareSchema,
  TRUST,
  DEFAULT_CONFIG_PATH,
  scopesFromTask,
  OPERATOR_CONTROL_SURFACE
};
