'use strict';

const { createHmac, randomUUID, timingSafeEqual, createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { LEVEL1_PROFILE_ID, WORKSPACE, ALL_READ_PATHS, assertReadOnlyMission } = require('./level1-profile');
const { ACTIVE_CHAT_PROFILE_ID, BUDGET: ACTIVE_CHAT_BUDGET, CAPABILITIES: ACTIVE_CHAT_CAPABILITIES, assertActiveChatMission } = require('./active-chat-mission');

const POLICY_VERSION = 'safe-autonomy-v2-local-1';
const CAPABILITIES = new Set(['read', 'edit', 'diagnostic', 'test', 'build', 'inference']);
const ACTION_CAPABILITY = Object.freeze({ read: 'read', ls: 'read', find: 'read', grep: 'read', bash: 'diagnostic', write: 'edit', edit: 'edit', test: 'test', build: 'build' });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const KEY_FILE = 'operator-hmac-key.json';
const GRANTS_FILE = 'grants.json';
const USAGE_KINDS = new Set(['read', 'inference']);

function missionIdentity(mission) {
  if (!mission || typeof mission !== 'object' || typeof mission.id !== 'string' || !mission.id || typeof mission.objective !== 'string' || !mission.objective.trim() || typeof mission.workspace !== 'string' || !fs.existsSync(mission.workspace)) throw new Error('Invalid mission identity');
  const realWorkspace = fs.realpathSync(mission.workspace);
  if ((mission.level === 1 || mission.capabilityProfile === LEVEL1_PROFILE_ID) && (
    !assertReadOnlyMission(mission) || realWorkspace !== WORKSPACE ||
    JSON.stringify(mission.scope?.readOnlyPaths) !== JSON.stringify(ALL_READ_PATHS)
  )) throw new Error('Invalid Level 1 read-only mission scope');
  if (mission.capabilityProfile === ACTIVE_CHAT_PROFILE_ID) assertActiveChatMission(mission);
  return {
    id: mission.id,
    objectiveHash: hash(mission.objective),
    criteriaHash: hash(mission.criteria || []),
    scopeHash: hash({ workspace: realWorkspace, scope: mission.scope || { workspace: realWorkspace }, networkPolicy: mission.networkPolicy || { egress: 'local-only' }, level: mission.level || null, capabilityProfile: mission.capabilityProfile || null, ...(mission.authority ? { authority: mission.authority } : {}) }),
    workspace: realWorkspace
  };
}
function safeUid(stat) { return typeof process.getuid !== 'function' || stat.uid === process.getuid(); }
function privateRegular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !safeUid(stat) || (stat.mode & 0o077)) throw new Error('Protected mission-authority state is unsafe');
  return stat;
}
function privateDirectory(directory, { create = false } = {}) {
  if (create && !fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !safeUid(stat) || (stat.mode & 0o077)) throw new Error('Protected mission-authority directory is unsafe');
}
function writeNewPrivateJSON(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function replacePrivateJSON(file, value) {
  const directory = path.dirname(file), temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    fs.renameSync(temporary, file);
  } finally {
    if (fd != null) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function normalizeUsed(used = {}) {
  const value = { actions: 0, runtimeMs: 0, retries: 0, reads: 0, inferenceRequests: 0, promptTurns: 0, ...used };
  for (const [key, amount] of Object.entries(value)) if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Invalid mission grant usage: ${key}`);
  return value;
}
function unsignedFor(record) { const { signature: _signature, ...unsigned } = record; return unsigned; }

/**
 * Fixture authorities keep an in-memory key for tests. Production authorities
 * are inert until an authenticated local operator explicitly initializes a
 * private key file; no environment, Keychain, worker, MCP, or model path can
 * create or rotate that key.
 */
class MissionAuthority {
  constructor({ fixtureOnly = false, now = Date.now, policyVersion = POLICY_VERSION, authorityDir = null } = {}) {
    this.fixtureOnly = fixtureOnly === true && process.env.NODE_ENV === 'test';
    this.now = now; this.policyVersion = policyVersion;
    this.authorityDir = authorityDir == null ? null : path.resolve(authorityDir);
    this.key = this.fixtureOnly ? randomBytes(32) : null;
    this.keyId = null; this.grants = new Map();
    if (!this.fixtureOnly && this.authorityDir) this._loadProductionState();
  }
  sealManifest(value) {
    if(!this.key)return null;
    const payload={purpose:'mission-manifest-v1',...value,key_id:this.keyId||'fixture'};
    return {...payload,signature:this._sign(payload)};
  }
  verifyManifestSeal(seal,value) {
    if(!this.key||seal.purpose!=='mission-manifest-v1'||seal.mission_id!==value.mission_id||seal.manifest_hash!==value.manifest_hash)return false;
    const {signature,...payload}=seal;const expected=this._sign(payload);
    return typeof signature==='string'&&/^[a-f0-9]{64}$/.test(signature)&&timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex'));
  }
  get keyPath() { return this.authorityDir ? path.join(this.authorityDir, KEY_FILE) : null; }
  get grantsPath() { return this.authorityDir ? path.join(this.authorityDir, GRANTS_FILE) : null; }
  get liveReady() { return !this.fixtureOnly && Buffer.isBuffer(this.key) && this.key.length === 32 && typeof this.keyId === 'string' && this.keyId.length > 0; }

  _loadProductionState() {
    if (!fs.existsSync(this.authorityDir)) return;
    privateDirectory(this.authorityDir);
    if (!fs.existsSync(this.keyPath)) return;
    privateRegular(this.keyPath);
    const record = JSON.parse(fs.readFileSync(this.keyPath, 'utf8'));
    if (!record || record.version !== 1 || typeof record.keyId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(record.keyId) || typeof record.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.key)) throw new Error('Protected mission-authority key is invalid');
    const key = Buffer.from(record.key, 'base64url');
    if (key.length !== 32) throw new Error('Protected mission-authority key is invalid');
    this.key = key; this.keyId = record.keyId;
    if (!fs.existsSync(this.grantsPath)) return;
    privateRegular(this.grantsPath);
    const grants = JSON.parse(fs.readFileSync(this.grantsPath, 'utf8'));
    if (!grants || grants.version !== 1 || !Array.isArray(grants.grants)) throw new Error('Protected mission grants are invalid');
    for (const grant of grants.grants) {
      if (!grant || typeof grant.id !== 'string' || this.grants.has(grant.id)) throw new Error('Protected mission grant record is invalid');
      this.grants.set(grant.id, grant);
    }
  }
  initializeOperatorKey() {
    if (this.fixtureOnly) throw new Error('Fixture authority cannot initialize a production key');
    if (!this.authorityDir) throw new Error('Protected mission-authority storage is not configured');
    if (this.liveReady) return { initialized: false, keyId: this.keyId, status: 'ready' };
    privateDirectory(this.authorityDir, { create: true });
    if (fs.existsSync(this.keyPath)) { this._loadProductionState(); if (this.liveReady) return { initialized: false, keyId: this.keyId, status: 'ready' }; throw new Error('Protected mission-authority key is invalid'); }
    const record = { version: 1, keyId: randomUUID(), createdAt: this.now(), key: randomBytes(32).toString('base64url') };
    writeNewPrivateJSON(this.keyPath, record);
    this.key = Buffer.from(record.key, 'base64url'); this.keyId = record.keyId;
    return { initialized: true, keyId: this.keyId, status: 'ready' };
  }
  status() { return { fixtureOnly: this.fixtureOnly, storageConfigured: Boolean(this.authorityDir), keyInitialized: this.liveReady, keyId: this.liveReady ? this.keyId : null, grantCount: this.grants.size }; }
  _persistGrants() {
    if (this.fixtureOnly) return;
    if (!this.liveReady) throw new Error('Protected mission-authority key is not initialized');
    privateDirectory(this.authorityDir);
    replacePrivateJSON(this.grantsPath, { version: 1, keyId: this.keyId, grants: [...this.grants.values()] });
  }
  _sign(grant) { if (!Buffer.isBuffer(this.key)) throw new Error('Protected mission-authority key is not initialized'); return createHmac('sha256', this.key).update(JSON.stringify(grant)).digest('hex'); }
  _save(record) { record.signature = this._sign(unsignedFor(record)); this.grants.set(record.id, record); this._persistGrants(); return record; }

  issueFixtureGrant(mission, { capabilities = null, ttlMs = 60_000, maxActions = 100, maxRuntimeMs = 120_000, maxRetries = 0, egress = 'local-only' } = {}) {
    if (!this.fixtureOnly) throw new Error('Fixture grant issuer is unavailable outside isolated tests');
    const identity = missionIdentity(mission);
    capabilities ||= mission.level === 1 ? ['read'] : ['read', 'edit', 'diagnostic'];
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some(capability => !CAPABILITIES.has(capability)) || (mission.level === 1 && (capabilities.length !== 1 || capabilities[0] !== 'read' || egress !== 'local-only'))) throw new Error('Invalid mission capabilities');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 10 * 60_000 || !Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > 1000 || !Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1 || maxRuntimeMs > 10 * 60_000 || !Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 2 || egress !== 'local-only') throw new Error('Invalid fixture grant budget or egress policy');
    const unsigned = {
      id: randomUUID(), missionId: identity.id, workspace: identity.workspace,
      objectiveHash: identity.objectiveHash, criteriaHash: identity.criteriaHash,
      scopeHash: identity.scopeHash, capabilities: [...new Set(capabilities)].sort(),
      policyVersion: this.policyVersion, egress, createdAt: this.now(), expiresAt: this.now() + ttlMs,
      budget: { maxActions, maxRuntimeMs, maxRetries, maxSpendMicros: 0 },
      used: normalizeUsed(), status: 'active', revokedAt: null, revokeReason: null, keyId: null, authorizationId: null
    };
    return clone(this._save(unsigned));
  }
  issueOperatorGrant(mission, { authorizationId } = {}) {
    if (this.fixtureOnly) throw new Error('Fixture authority cannot issue an operator grant');
    if (!this.liveReady) throw new Error('Protected mission-authority key is not initialized');
    if (typeof authorizationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(authorizationId)) throw new Error('Authenticated operator authorization is required');
    if ([...this.grants.values()].some(grant => grant.authorizationId === authorizationId)) throw new Error('Operator authorization was already consumed');
    const identity = missionIdentity(mission); assertActiveChatMission(mission);
    if ([...this.grants.values()].some(grant => grant.missionId === identity.id && grant.status === 'active')) throw new Error('Active Chat mission already has an active grant');
    const unsigned = {
      id: randomUUID(), missionId: identity.id, workspace: identity.workspace,
      objectiveHash: identity.objectiveHash, criteriaHash: identity.criteriaHash, scopeHash: identity.scopeHash,
      capabilities: [...ACTIVE_CHAT_CAPABILITIES].sort(), policyVersion: this.policyVersion, egress: 'local-only',
      createdAt: this.now(), expiresAt: this.now() + ACTIVE_CHAT_BUDGET.maxRuntimeMs,
      budget: { ...ACTIVE_CHAT_BUDGET }, used: normalizeUsed(), status: 'active', revokedAt: null, revokeReason: null,
      keyId: this.keyId, authorizationId
    };
    return clone(this._save(unsigned));
  }
  _validatedRecord(mission) {
    if (mission?.authorityRevoked) return { allow: false, reason: 'Mission authority revoked' };
    if (mission?.authority) { const ceiling = require('./mission-permissions').checkAuthority(mission.authority, {}, this.now()); if (!ceiling.allow) return ceiling; }
    if (!mission?.grantId || (!this.fixtureOnly && !this.liveReady)) return { allow: false, reason: 'No active trusted mission grant' };
    const record = this.grants.get(mission.grantId);
    if (!record) return { allow: false, reason: 'Mission grant not found' };
    const { signature, ...unsigned } = record;
    const expected = this._sign(unsigned);
    const suppliedSignature = typeof signature === 'string' && /^[a-f0-9]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
    const expectedSignature = Buffer.from(expected, 'hex');
    if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) return { allow: false, reason: 'Mission grant integrity check failed' };
    const now = this.now();
    if (record.status !== 'active') return { allow: false, reason: record.status === 'expired' ? 'Mission grant expired' : 'Mission grant is revoked or inactive' };
    if (now >= record.expiresAt) { record.status = 'expired'; this._save(record); return { allow: false, reason: 'Mission grant expired' }; }
    if (record.used.runtimeMs >= record.budget.maxRuntimeMs) return { allow: false, reason: 'Mission runtime budget exhausted' };
    let identity;
    try { identity = missionIdentity(mission); } catch { return { allow: false, reason: 'Mission identity is invalid' }; }
    if (record.missionId !== identity.id || record.workspace !== identity.workspace || record.objectiveHash !== identity.objectiveHash || record.criteriaHash !== identity.criteriaHash || record.scopeHash !== identity.scopeHash) return { allow: false, reason: 'Mission grant scope or identity changed' };
    if (record.policyVersion !== this.policyVersion || record.egress !== 'local-only') return { allow: false, reason: 'Mission grant policy or egress is invalid' };
    if (mission.capabilityProfile === ACTIVE_CHAT_PROFILE_ID && (record.keyId !== this.keyId || JSON.stringify(record.capabilities) !== JSON.stringify([...ACTIVE_CHAT_CAPABILITIES].sort()) || JSON.stringify(record.budget) !== JSON.stringify(ACTIVE_CHAT_BUDGET))) return { allow: false, reason: 'Active Chat mission grant scope changed' };
    return { allow: true, record };
  }
  verify(mission, capability, { consumeAction = false, usageKind = null } = {}) {
    if (mission?.level === 1 && (capability !== 'read' || !assertReadOnlyMission(mission))) return { allow: false, reason: 'Level 1 grants authorize only the current exact read-only fixture path' };
    const validated = this._validatedRecord(mission);
    if (!validated.allow) return validated;
    const record = validated.record;
    if ((mission?.level === 1 || mission?.capabilityProfile === LEVEL1_PROFILE_ID) && (record.capabilities.length !== 1 || record.capabilities[0] !== 'read' || record.egress !== 'local-only')) return { allow: false, reason: 'Level 1 grant must authorize read-only local fixture access and no broader capability' };
    if (mission?.capabilityProfile === ACTIVE_CHAT_PROFILE_ID && (capability !== 'read' && capability !== 'inference')) return { allow: false, reason: 'Active Chat grant allows only fixture reads and local inference' };
    if (!record.capabilities.includes(capability)) return { allow: false, reason: `Mission grant does not permit ${capability}` };
    if (record.used.actions >= record.budget.maxActions) return { allow: false, reason: 'Mission action budget exhausted' };
    if (usageKind !== null && !USAGE_KINDS.has(usageKind)) return { allow: false, reason: 'Mission usage category is invalid' };
    if (consumeAction) {
      record.used.actions++;
      if (usageKind === 'read') record.used.reads++;
      if (usageKind === 'inference') record.used.inferenceRequests++;
      this._save(record);
    }
    return { allow: true, grantId: record.id, remainingActions: record.budget.maxActions - record.used.actions, expiresAt: record.expiresAt };
  }
  consumePromptTurn(mission) {
    const validated = this._validatedRecord(mission); if (!validated.allow) return validated;
    const record = validated.record;
    if (mission?.capabilityProfile !== ACTIVE_CHAT_PROFILE_ID) return { allow: true };
    if (record.used.promptTurns >= record.budget.maxPromptTurns) return { allow: false, reason: 'Active Chat prompt-turn budget exhausted' };
    record.used.promptTurns++; this._save(record);
    return { allow: true, remainingPromptTurns: record.budget.maxPromptTurns - record.used.promptTurns };
  }
  revoke(missionId, reason = 'operator revoked') {
    let changed = false;
    for (const grant of this.grants.values()) if (grant.missionId === missionId && grant.status === 'active') {
      grant.status = 'revoked'; grant.revokedAt = this.now(); grant.revokeReason = String(reason).slice(0, 300); this._save(grant); changed = true;
    }
    return changed;
  }
  complete(missionId) {
    let changed = false;
    for (const grant of this.grants.values()) if (grant.missionId === missionId && grant.status === 'active') { grant.status = 'completed'; grant.completedAt = this.now(); this._save(grant); changed = true; }
    return changed;
  }
  consumeRuntime(mission, milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || !mission?.grantId) return { allow: false, reason: 'No active trusted mission grant' };
    const verified = this._validatedRecord(mission); if (!verified.allow) return verified;
    const grant = verified.record;
    if (grant.used.runtimeMs + milliseconds > grant.budget.maxRuntimeMs) return { allow: false, reason: 'Mission runtime budget exhausted' };
    grant.used.runtimeMs += Math.ceil(milliseconds); this._save(grant);
    return { allow: true, remainingRuntimeMs: grant.budget.maxRuntimeMs - grant.used.runtimeMs };
  }
  consumeRetry(mission) {
    if (!mission?.grantId) return { allow: false, reason: 'No active trusted mission grant' };
    const verified = this._validatedRecord(mission); if (!verified.allow) return verified;
    const grant = verified.record;
    if (grant.used.retries >= grant.budget.maxRetries) return { allow: false, reason: 'Mission retry budget exhausted' };
    grant.used.retries++; this._save(grant);
    return { allow: true, remainingRetries: grant.budget.maxRetries - grant.used.retries };
  }
  snapshot(mission) {
    const record = mission?.grantId ? this.grants.get(mission.grantId) : null;
    if (!record) return { enabled: false, status: 'inactive', liveEnabled: false, authority: this.status() };
    if (record.status === 'active' && this.now() >= record.expiresAt) { record.status = 'expired'; this._save(record); }
    return { enabled: true, status: record.status, liveEnabled: !this.fixtureOnly && this.liveReady, grantId: record.id, missionId: record.missionId, workspace: record.workspace, capabilities: [...record.capabilities], policyVersion: record.policyVersion, egress: record.egress, expiresAt: record.expiresAt, budget: clone(record.budget), used: clone(record.used), revokedAt: record.revokedAt || null, completedAt: record.completedAt || null, authority: this.status() };
  }
}

module.exports = { MissionAuthority, POLICY_VERSION, CAPABILITIES, ACTION_CAPABILITY, missionIdentity, KEY_FILE, GRANTS_FILE };
