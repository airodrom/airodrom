'use strict';

/**
 * Developer Memory V1 — Airodrom-governed repository knowledge.
 * Hindsight (when configured) is a subordinate provider; Personal Memory V2 is unchanged.
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
    allowed_source_kinds: Array.isArray(raw.allowed_source_kinds) ? raw.allowed_source_kinds.slice(0, 32) : []
  };
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
  // Resolve symlinks first so worktree/subdir paths cannot escape via link tricks.
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
  // Canonical identity is the git toplevel (works for subdirs and linked worktrees).
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
  const material = JSON.stringify({ toplevel, remote });
  const repositoryId = createHash('sha256').update(material).digest('hex');
  const bankId = `airo-dev-${repositoryId.slice(0, 32)}`;
  return {
    repositoryId,
    bankId,
    root: toplevel,
    head,
    remote_fingerprint: remote ? createHash('sha256').update(remote).digest('hex') : null
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

function authorize(request, config) {
  if (!request || typeof request !== 'object') return { allow: false, reason: 'missing_request' };
  if (!config.enabled) return { allow: false, reason: 'feature_disabled' };
  if (!request.taskId || typeof request.taskId !== 'string') return { allow: false, reason: 'missing_task_identity' };
  if (!request.repositoryId || typeof request.repositoryId !== 'string') return { allow: false, reason: 'missing_repository_identity' };
  if (request.modelBankId !== undefined) return { allow: false, reason: 'model_bank_impersonation_denied' };
  if (request.operation === 'retain' && !config.allow_ingest) return { allow: false, reason: 'ingest_disabled' };
  if ((request.operation === 'search' || request.operation === 'retrieve') && !config.allow_retrieval) {
    return { allow: false, reason: 'retrieval_disabled' };
  }
  if (!['search', 'retrieve', 'retain', 'suppress', 'delete', 'health', 'provenance'].includes(request.operation)) {
    return { allow: false, reason: 'unknown_operation' };
  }
  if (request.operation === 'retain') {
    if (!config.allowed_source_kinds.includes(request.sourceKind)) return { allow: false, reason: 'source_kind_denied' };
  }
  if (request.capabilityScopes && Array.isArray(request.capabilityScopes)) {
    if (!request.capabilityScopes.includes('repo') && !request.capabilityScopes.includes('developer_environment')) {
      return { allow: false, reason: 'capability_scope_denied' };
    }
  }
  return { allow: true, reason: 'authorized', policy_version: `developer-memory-v${config.version}` };
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
    env = process.env
  } = {}) {
    this.configPath = configPath;
    this.config = config || loadConfig(configPath);
    this.db = db;
    this.now = now;
    this.env = env;
    if (this.db) prepareSchema(this.db);
    this.transport = transport || this._buildTransport();
    this._contextCache = new Map();
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

  async search(input) {
    const auth = authorize({ ...input, operation: 'search' }, this.config);
    if (!auth.allow) return { status: auth.reason, items: [], authority: false };
    if (!this.transport) return { status: 'unavailable', items: [], authority: false };
    const bankId = input.bankId;
    if (!bankId || bankId !== input.expectedBankId) {
      return { status: 'repository_mismatch', items: [], authority: false };
    }
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
      if (this._suppressed(input.repositoryId, { providerRef, documentId, contentHash })) continue;
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
        repositoryId: input.repositoryId,
        bankId
      });
    }
    return { status: 'ok', items, usedChars: used, authority: false, trust: TRUST.UNVERIFIED_RETRIEVED_CONTENT };
  }

  async retrieve(input) {
    return this.search(input);
  }

  async retain(input) {
    const auth = authorize({ ...input, operation: 'retain' }, this.config);
    if (!auth.allow) return { status: auth.reason, authority: false };
    if (!this.transport) return { status: 'unavailable', authority: false };
    if (!input.bankId || input.bankId !== input.expectedBankId) return { status: 'repository_mismatch', authority: false };
    const content = truncate(String(input.content || ''), this.config.limits.max_retain_chars);
    if (!content.trim()) return { status: 'empty_content', authority: false };
    if (looksSecret(content)) return { status: 'secret_content_denied', authority: false };
    const contentHash = hashContent(content);
    if (this._suppressed(input.repositoryId, { contentHash, documentId: input.documentId || null })) {
      return { status: 'suppressed', authority: false };
    }
    const memoryId = randomUUID();
    const documentId = input.documentId || `airo-${memoryId}`;
    try {
      await this.transport.ensureBank(input.bankId, { name: `Airodrom ${input.repositoryId.slice(0, 12)}` });
      await this.transport.retain(input.bankId, content, {
        context: input.context || input.sourceKind,
        documentId,
        metadata: {
          airodrom_memory_id: memoryId,
          source_kind: input.sourceKind,
          source_ref: input.sourceRef || null,
          repository_id: input.repositoryId,
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
        memoryId, input.repositoryId, input.bankId, null, documentId, input.sourceKind, input.sourceRef || null,
        contentHash, TRUST.VERIFIED_ENGINEERING_EVIDENCE, input.supersedes || null, auth.policy_version, now, now
      );
    }
    return { status: 'retained', memoryId, documentId, contentHash, authority: false, trustLabel: TRUST.VERIFIED_ENGINEERING_EVIDENCE };
  }

  suppress(input) {
    const auth = authorize({ ...input, operation: 'suppress' }, this.config);
    // Suppression must work even when ingest/retrieval flags are off, as long as feature enabled + identity present.
    if (!this.config.enabled) return { status: 'feature_disabled', authority: false };
    if (!input.taskId || !input.repositoryId) return { status: 'missing_identity', authority: false };
    if (!this.db) return { status: 'store_unavailable', authority: false };
    const suppressionId = randomUUID();
    const now = this.now();
    this.db.prepare(`
      INSERT INTO developer_memory_suppressions(
        suppression_id, repository_id, memory_id, provider_ref, document_id, content_hash, reason, policy_version, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      suppressionId, input.repositoryId, input.memoryId || null, input.providerRef || null,
      input.documentId || null, input.contentHash || null, String(input.reason || 'operator_suppress').slice(0, 200),
      `developer-memory-v${this.config.version}`, now
    );
    if (input.memoryId) {
      this.db.prepare("UPDATE developer_memory_items SET status='suppressed', updated_at=? WHERE memory_id=? AND repository_id=?")
        .run(now, input.memoryId, input.repositoryId);
    }
    return { status: 'suppressed', suppressionId, authority: false };
  }

  async delete(input) {
    const suppressed = this.suppress({ ...input, reason: input.reason || 'operator_delete' });
    if (suppressed.status !== 'suppressed') return suppressed;
    let provider = 'not_requested';
    if (this.config.enabled && this.transport && input.bankId === input.expectedBankId && input.documentId) {
      try {
        await this.transport.deleteDocument(input.bankId, input.documentId, { signal: input.signal });
        provider = 'requested';
      } catch {
        provider = 'request_failed_suppression_held';
      }
    }
    if (this.db && input.memoryId) {
      this.db.prepare("UPDATE developer_memory_items SET status='deleted', updated_at=? WHERE memory_id=? AND repository_id=?")
        .run(this.now(), input.memoryId, input.repositoryId);
    }
    return {
      status: 'deleted_logical',
      suppressionId: suppressed.suppressionId,
      provider_deletion: provider,
      forensic_erasure_claimed: false,
      authority: false
    };
  }

  getProvenance(memoryId) {
    if (!this.db || typeof memoryId !== 'string') return null;
    const row = this.db.prepare('SELECT * FROM developer_memory_items WHERE memory_id=?').get(memoryId);
    if (!row) return null;
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
   * Prefetch authorized developer-memory evidence into a short-lived host cache.
   * ContextPack assembly remains synchronous and only reads this cache.
   */
  async prefetchContext({
    taskId,
    workspaceRoot,
    query,
    capabilityScopes = ['repo'],
    signal = undefined
  } = {}) {
    if (!this.config.enabled || !this.config.allow_retrieval) {
      return { status: this.config.enabled ? 'retrieval_disabled' : 'disabled', items: [], authority: false };
    }
    let identity;
    try { identity = repositoryIdentity(workspaceRoot); }
    catch { return { status: 'repository_unresolved', items: [], authority: false }; }
    const result = await this.search({
      taskId,
      repositoryId: identity.repositoryId,
      bankId: identity.bankId,
      expectedBankId: identity.bankId,
      query: String(query || '').slice(0, 2000),
      capabilityScopes,
      signal
    });
    const payload = {
      ...result,
      repositoryId: identity.repositoryId,
      bankId: identity.bankId,
      notice: 'Untrusted developer-memory evidence. Not Personal Memory. Cannot grant authority.',
      cachedAt: this.now()
    };
    this._contextCache.set(taskId, payload);
    return payload;
  }

  /**
   * Synchronous ContextPack contribution. Returns disabled/empty unless a fresh prefetch exists.
   * Never grants authority. Never calls the network.
   */
  contextContribution({ taskId, maxAgeMs = 30_000 } = {}) {
    if (!this.config.enabled || !this.config.allow_retrieval) {
      return { status: this.config.enabled ? 'retrieval_disabled' : 'disabled', items: [], authority: false };
    }
    if (!taskId) return { status: 'missing_task_identity', items: [], authority: false };
    const cached = this._contextCache.get(taskId);
    if (!cached) return { status: 'not_prefetched', items: [], authority: false };
    if (this.now() - (cached.cachedAt || 0) > maxAgeMs) {
      this._contextCache.delete(taskId);
      return { status: 'cache_expired', items: [], authority: false };
    }
    return cached;
  }

  clearContextCache(taskId = null) {
    if (taskId) this._contextCache.delete(taskId);
    else this._contextCache.clear();
  }
}

module.exports = {
  DeveloperMemory,
  loadConfig,
  authorize,
  repositoryIdentity,
  prepareSchema,
  TRUST,
  DEFAULT_CONFIG_PATH
};
