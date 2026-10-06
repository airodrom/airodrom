'use strict';

const { createHash, randomUUID } = require('node:crypto');
const erasure = require('./memory-erasure');
const {transaction}=require('./control-transaction');

const SCHEMA_VERSION = 2;
const DOMAINS = new Set(['personal', 'project', 'session']);
const SOURCES = new Set(['user_explicit', 'conversation_derived', 'project_derived', 'imported', 'system_observed']);
const STATUSES = new Set(['active', 'superseded', 'forgotten', 'expired']);
const SENSITIVITIES = new Set(['normal', 'private', 'sensitive']);
const MAX_CONTENT_BYTES = 12_000;
const MAX_SUBJECT_BYTES = 240;
const MAX_TYPE_BYTES = 80;
const MAX_RESULTS = 20;
const MAX_RETRIEVAL_CHARS = 8_000;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value, allowed, name) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.has(key))) throw new Error(`Invalid ${name}`);
}
function byteLength(value) { return Buffer.byteLength(value, 'utf8'); }
function text(value, name, max, { optional = false, multiline = true } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new Error(`${name} is required`);
  }
  if (typeof value !== 'string' || !value.trim() || byteLength(value) > max || value.includes('\0') || (!multiline && /[\u0000-\u001f]/.test(value))) throw new Error(`Invalid ${name}`);
  return value.normalize('NFC').trim();
}
function identifier(value, name, { optional = true } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new Error(`${name} is required`);
  }
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function count(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return Math.min(value, maximum);
}
function normalizeSearchQuery(value, { maximum = 4_000, truncate = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid memory query');
  const normalized = value.normalize('NFC').replace(/[\u0001-\u001f\u007f]+/gu, ' ').trim();
  if (!normalized) throw new Error('Invalid memory query');
  if (byteLength(normalized) <= maximum) return normalized;
  if (!truncate) throw new Error('Invalid memory query');
  let result = '';
  for (const character of normalized) {
    if (byteLength(result + character) > maximum) break;
    result += character;
  }
  return result.trim();
}
function luhnCandidate(value) {
  const digits = value.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0; let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index]);
    if (double && (digit *= 2) > 9) digit -= 9;
    sum += digit; double = !double;
  }
  return sum % 10 === 0;
}
function containsSecret(value) {
  if (/\b(?:crsr_|xox[baprs]-|xapp-|sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{8,}\b/.test(value) || /--(?:api-key|auth-token|token|password)(?:=|\s+)\S+/i.test(value)) return true;
  for (const [candidate] of value.matchAll(/(?:https?|wss?|codex):\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password || [...url.searchParams.keys()].some(k => /token|key|secret|password|credential|signature|auth/i.test(k)) || /token|secret|credential|password|signature/i.test(url.hash) || /\/(?:auth|token|secret|credential|api[-_]?key)\//i.test(url.pathname)) return true;
    } catch { return true; }
  }
  if (/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/=:-]{8,}\b/i.test(value)) return true;
  if (/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{8,}\b|\b(?:gh[pousr]_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,})\b/.test(value)) return true;
  if (/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|password|passwd|secret|credential|private[_-]?key)\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s,;]+)/i.test(value)) return true;
  if (/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(value)) return true;
  return (value.match(/(?:\d[ -]?){13,19}/g) || []).some(luhnCandidate);
}
function clip(value, maximum) {
  if (value.length <= maximum) return { value, truncated: false };
  return { value: `${value.slice(0, Math.max(0, maximum - 1))}…`, truncated: true };
}
function asItem(row, { includeContent = true } = {}) {
  if (!row) return null;
  const item = {
    memoryId: row.memory_id, domain: row.domain, type: row.type, subject: row.subject,
    source: row.source, sourceEventId: row.source_event_id, taskId: row.task_id, projectId: row.project_id,
    sessionId: row.session_id, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at,
    confidence: row.confidence, sensitivity: row.sensitivity, status: row.status,
    supersededBy: row.superseded_by, expiresAt: row.expires_at
  };
  if (includeContent && row.content !== null) item.content = row.content;
  if (row.content === null) item.contentRemoved = true;
  return item;
}

class PersonalMemory {
  constructor({ db, now = () => Date.now(), record = null, restoreFromBackup = false, erasureSourceDb = null } = {}) {
    if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new Error('PersonalMemory requires a SQLite database');
    if (typeof restoreFromBackup !== 'boolean') throw Error('Invalid restore policy');
    if (restoreFromBackup && (!erasureSourceDb || erasureSourceDb === db)) throw Error('Restore requires current independent erasure database');
    this.db = db; this.now = now; this.record = typeof record === 'function' ? record : null;
    this.restoreSource = restoreFromBackup ? erasureSourceDb : null;
    this._migrate();
  }

  _migrate() {
    // Check compatibility before touching tables, triggers or search indexes.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_memory_meta'").get()) {
      const version = this.db.prepare("SELECT value FROM personal_memory_meta WHERE key='schema_version'").get();
      if (version && (!/^\d+$/.test(version.value) || Number(version.value) > SCHEMA_VERSION)) throw new Error('Personal memory database is newer than this bridge or has an invalid version');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personal_memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_memories (
        memory_id TEXT PRIMARY KEY, domain TEXT NOT NULL CHECK(domain IN ('personal','project','session')),
        type TEXT NOT NULL, subject TEXT NOT NULL, content TEXT, content_hash TEXT NOT NULL,
        source TEXT NOT NULL, source_event_id TEXT, task_id TEXT, project_id TEXT, session_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER,
        confidence INTEGER NOT NULL CHECK(confidence >= 0 AND confidence <= 100),
        sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal','private','sensitive')),
        status TEXT NOT NULL CHECK(status IN ('active','superseded','forgotten','expired')),
        superseded_by TEXT, expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS personal_memory_active ON personal_memories(domain, status, updated_at DESC, memory_id);
      CREATE INDEX IF NOT EXISTS personal_memory_project ON personal_memories(project_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS personal_memory_task ON personal_memories(task_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS personal_memory_subject ON personal_memories(domain, project_id, task_id, type, subject, status);
    `);
    erasure.migrate(this.db);
    for (const row of this.db.prepare("SELECT * FROM personal_memories WHERE status IN ('forgotten','expired')").all()) if (!erasure.marker(this.db, 'personal', row.memory_id)) erasure.mark(this.db, {store:'personal',identity:row.memory_id,scope_hash:this._erasureScope(row),action:row.status==='expired'?'expiry':'forget',erased_at:row.updated_at});
    if (this.restoreSource) {
      erasure.reconcile(this.db, this.restoreSource);
      // Retention tightening after a backup cannot be undone by restore.
      for (const prior of this.restoreSource.prepare('SELECT * FROM personal_memories WHERE expires_at IS NOT NULL').all()) {
        const restored = this.db.prepare('SELECT * FROM personal_memories WHERE memory_id=?').get(prior.memory_id);
        if (!restored) continue;
        if (this._erasureScope(restored) !== this._erasureScope(prior)) throw Error('Restore retention scope mismatch');
        if (erasure.marker(this.db, 'personal', prior.memory_id)) continue;
        this.db.prepare('UPDATE personal_memories SET expires_at=? WHERE memory_id=?').run(Math.min(restored.expires_at ?? prior.expires_at, prior.expires_at), prior.memory_id);
      }
    }
    // Marker guards precede index migration and every readable service instance.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS personal_memory_erased_insert BEFORE INSERT ON personal_memories
      WHEN new.content IS NOT NULL AND EXISTS(SELECT 1 FROM memory_erasure_markers WHERE store='personal' AND identity=new.memory_id)
      BEGIN SELECT RAISE(ABORT,'Erased memory replay denied'); END;
      CREATE TRIGGER IF NOT EXISTS personal_memory_erased_update BEFORE UPDATE ON personal_memories
      WHEN (new.content IS NOT NULL OR new.status='active') AND EXISTS(SELECT 1 FROM memory_erasure_markers WHERE store='personal' AND identity=new.memory_id)
      BEGIN SELECT RAISE(ABORT,'Erased memory replay denied'); END;`);
    this._ensureSearchIndex();
    this.retryErasure();
    if (this.restoreSource) this._expire();
    const version = this.db.prepare("SELECT value FROM personal_memory_meta WHERE key = 'schema_version'").get();
    if (!version) this.db.prepare("INSERT INTO personal_memory_meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    else if (Number(version.value) > SCHEMA_VERSION) throw new Error('Personal memory database is newer than this bridge');
    else if (Number(version.value) < SCHEMA_VERSION) this.db.prepare("UPDATE personal_memory_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
  }

  // One transaction: an interrupted rebuild must not leave a subject-bearing but
  // empty index, which the needsRebuild check would then never repopulate.
  _ensureSearchIndex() {
    this.db.exec('SAVEPOINT personal_memory_write');
    try {
      this._rebuildSearchIndex();
      this.db.exec('RELEASE SAVEPOINT personal_memory_write');
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT personal_memory_write; RELEASE SAVEPOINT personal_memory_write');
      throw error;
    }
  }

  _rebuildSearchIndex() {
    const fts = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'personal_memory_fts'").get();
    const needsRebuild = !fts || !/subject/.test(String(fts.sql || ''));
    if (needsRebuild) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS personal_memory_insert;
        DROP TRIGGER IF EXISTS personal_memory_delete;
        DROP TRIGGER IF EXISTS personal_memory_update_delete;
        DROP TRIGGER IF EXISTS personal_memory_update_insert;
        DROP TABLE IF EXISTS personal_memory_fts;
        CREATE VIRTUAL TABLE personal_memory_fts USING fts5(
          subject, type, content,
          content='personal_memories', content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );
      `);
      this.db.exec(`
        INSERT INTO personal_memory_fts(rowid, subject, type, content)
        SELECT rowid, subject, type, COALESCE(content, '') FROM personal_memories WHERE status = 'active';
      `);
    }
    this.db.exec(`
      DROP TRIGGER IF EXISTS personal_memory_insert;
      DROP TRIGGER IF EXISTS personal_memory_delete;
      DROP TRIGGER IF EXISTS personal_memory_update_delete;
      DROP TRIGGER IF EXISTS personal_memory_update_insert;
      CREATE TRIGGER personal_memory_insert AFTER INSERT ON personal_memories WHEN new.status = 'active' BEGIN
        INSERT INTO personal_memory_fts(rowid, subject, type, content) VALUES (new.rowid, new.subject, new.type, COALESCE(new.content, ''));
      END;
      CREATE TRIGGER personal_memory_delete AFTER DELETE ON personal_memories WHEN old.status = 'active' BEGIN
        INSERT INTO personal_memory_fts(personal_memory_fts, rowid, subject, type, content) VALUES ('delete', old.rowid, old.subject, old.type, COALESCE(old.content, ''));
      END;
      CREATE TRIGGER personal_memory_update_delete AFTER UPDATE OF subject, type, content, status ON personal_memories WHEN old.status = 'active' BEGIN
        INSERT INTO personal_memory_fts(personal_memory_fts, rowid, subject, type, content) VALUES ('delete', old.rowid, old.subject, old.type, COALESCE(old.content, ''));
      END;
      CREATE TRIGGER personal_memory_update_insert AFTER UPDATE OF subject, type, content, status ON personal_memories WHEN new.status = 'active' BEGIN
        INSERT INTO personal_memory_fts(rowid, subject, type, content) VALUES (new.rowid, new.subject, new.type, COALESCE(new.content, ''));
      END;
    `);
  }

  _record(eventType, item, status = 'completed') {
    if (!this.record) return;
    this.record({ eventType, agent: 'bridge', direction: 'internal', status, taskId: item?.taskId || null,
      sessionId: item?.sessionId || null, metadata: { memory_id: item?.memoryId || null, domain: item?.domain || null,
        source: item?.source || null, project_id: item?.projectId || null, sensitivity: item?.sensitivity || null } });
  }
  _expire(now = this.now()) {
    const rows = this.db.prepare("SELECT * FROM personal_memories WHERE status IN ('active','superseded') AND expires_at IS NOT NULL AND expires_at <= ?").all(now);
    if (!rows.length) return;
    for (const row of rows) {
      this._eraseRow(row, 'expiry');
      this._record('memory.expired', asItem({ ...row, content: null, status: 'expired', updated_at: now }), 'expired');
    }
  }
  _erasureScope(row) { return erasure.scopeHash([row.domain, row.project_id, row.task_id, row.session_id]); }
  _purgeRow(row, marker) {
    if (this._erasureScope(row) !== marker.scope_hash) throw Error('Personal memory erasure scope mismatch');
    this.db.exec('SAVEPOINT personal_memory_purge');
    try {
      this.db.prepare("UPDATE personal_memories SET content=NULL,status=?,updated_at=?,last_used_at=NULL WHERE memory_id=?").run(marker.action === 'expiry' ? 'expired' : 'forgotten', marker.erased_at, row.memory_id);
      if (marker.action === 'operator_erasure') this.db.prepare("UPDATE personal_memories SET subject='[erased]',type='erased',source_event_id=NULL,content_hash='',superseded_by=NULL WHERE memory_id=?").run(row.memory_id);
      erasure.progress(this.db, 'personal', row.memory_id, 'purged', this.now());
      this.db.exec('RELEASE SAVEPOINT personal_memory_purge');
    } catch {
      this.db.exec('ROLLBACK TO SAVEPOINT personal_memory_purge; RELEASE SAVEPOINT personal_memory_purge');
      erasure.progress(this.db, 'personal', row.memory_id, 'retryable', this.now());
      throw Error('Personal memory purge incomplete; retrieval denied until retry');
    }
    if (marker.action === 'operator_erasure') require('./memory-content-erasure').propagate(this.db, marker, {now:this.now()});
  }
  _eraseRow(row, action) {
    if(action==='operator_erasure'){
      const members=this._erasureFamily(row),now=this.now();
      // Validate the complete lineage before writing even its first marker.
      // An interruption after this transaction cannot leave an unmarked copy.
      const plans=members.map(member=>{
        const prior=erasure.marker(this.db,'personal',member.memory_id);
        const provenance=prior?.action==='operator_erasure'?{source_event_id:prior.source_event_id,source_provenance:prior.source_provenance}:erasure.personalSourceEvent(this.db,member);
        if(!['none','verified'].includes(provenance.source_provenance))throw Error('Personal memory source provenance migration required');
        return {member,provenance};
      });
      const markers=transaction(this.db,()=>plans.map(({member,provenance})=>erasure.mark(this.db,{store:'personal',identity:member.memory_id,scope_hash:this._erasureScope(member),action,erased_at:now,...provenance})));
      plans.forEach(({member},i)=>this._purgeRow(member,markers[i]));return;
    }
    const prior=erasure.marker(this.db,'personal',row.memory_id);
    const provenance=action==='operator_erasure'?(prior?.action==='operator_erasure'?{source_event_id:prior.source_event_id,source_provenance:prior.source_provenance}:erasure.personalSourceEvent(this.db,row)):{};
    const marker = erasure.mark(this.db, { store: 'personal', identity: row.memory_id, scope_hash: this._erasureScope(row), action, erased_at: this.now(),...provenance });
    this._purgeRow(row, marker);
  }
  _erasureFamily(root) {
    const scope=this._erasureScope(root),pending=[root.memory_id],members=new Map();
    while(pending.length){
      const id=pending.pop();if(members.has(id))continue;
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw Error('Personal memory history identity migration required');
      const row=this.db.prepare('SELECT * FROM personal_memories WHERE memory_id=?').get(id);
      if(!row)throw Error('Personal memory history provenance unavailable');
      if(this._erasureScope(row)!==scope)throw Error('Personal memory history scope mismatch');
      if(row.status==='superseded'&&!row.superseded_by&&row.source!=='project_derived')throw Error('Personal memory history provenance unavailable');
      members.set(id,row);
      if(row.superseded_by)pending.push(row.superseded_by);
      for(const prior of this.db.prepare('SELECT memory_id FROM personal_memories WHERE superseded_by=?').all(id))pending.push(prior.memory_id);
    }
    for(const row of members.values()){
      const seen=new Set();let id=row.memory_id;
      while(id){if(seen.has(id))throw Error('Cyclic personal memory history provenance');seen.add(id);id=members.get(id)?.superseded_by;}
    }
    return [...members.values()].sort((a,b)=>a.created_at-b.created_at||a.memory_id.localeCompare(b.memory_id));
  }
  retryErasure() {
    for (const row of this.db.prepare("SELECT p.* FROM personal_memories p WHERE EXISTS(SELECT 1 FROM memory_erasure_markers e WHERE e.store='personal' AND e.identity=p.memory_id)").all()) this._purgeRow(row, erasure.marker(this.db, 'personal', row.memory_id));
    return { authority: false, physicalErasure: false };
  }
  purgeExpired() { this._expire(); return this.retryErasure(); }
  erase(memoryId) {
    identifier(memoryId, 'memoryId', { optional: false });
    const row = this.db.prepare('SELECT * FROM personal_memories WHERE memory_id=?').get(memoryId);
    if (!row) throw Error('Memory to erase was not found');
    this._eraseRow(row, 'operator_erasure');
    return this._read(memoryId, { includeInactive: true });
  }
  _scope(input) {
    const domain = text(input.domain, 'memory domain', 16, { multiline: false });
    if (!DOMAINS.has(domain)) throw new Error('Unsupported memory domain');
    const projectId = identifier(input.projectId, 'projectId');
    const taskId = identifier(input.taskId, 'taskId');
    const sessionId = identifier(input.sessionId, 'sessionId');
    if (domain === 'project' && !projectId) throw new Error('Project memory requires projectId');
    if (domain === 'session' && !taskId && !sessionId) throw new Error('Session memory requires taskId or sessionId');
    if (domain === 'personal' && (projectId || taskId || sessionId)) throw new Error('Personal memory cannot carry project, task, or session scope');
    return { domain, projectId, taskId, sessionId };
  }
  _identity(scope, type, subject) {
    return [scope.domain, scope.projectId || '', scope.taskId || '', scope.sessionId || '', type, subject].join('\u001f');
  }
  _activeByIdentity(scope, type, subject) {
    return this.db.prepare(`SELECT * FROM personal_memories WHERE domain = ? AND project_id IS ? AND task_id IS ? AND session_id IS ? AND type = ? AND subject = ? AND status = 'active' ORDER BY updated_at DESC, memory_id ASC`).all(scope.domain, scope.projectId, scope.taskId, scope.sessionId, type, subject);
  }
  _read(id, { includeInactive = false } = {}) {
    require('./memory-identity').assertReadable(this.db);
    const row = this.db.prepare(`SELECT * FROM personal_memories WHERE memory_id = ? ${includeInactive ? '' : "AND status = 'active'"}`).get(id);
    if (!row) return null;
    const marker = erasure.marker(this.db, 'personal', id);
    if (marker) {
      if (!includeInactive) return null;
      if (marker.action === 'operator_erasure') return { memoryId: id, status: 'forgotten', contentRemoved: true, erased: true };
      return asItem({ ...row, content: null, status: marker.action === 'expiry' ? 'expired' : 'forgotten', last_used_at: null });
    }
    return asItem(row);
  }

  remember(input = {}) {
    keys(input, new Set(['domain', 'type', 'subject', 'content', 'source', 'sourceEventId', 'taskId', 'projectId', 'sessionId', 'confidence', 'sensitivity', 'expiresAt', 'replaces']), 'memory record');
    const scope = this._scope(input);
    const type = text(input.type, 'memory type', MAX_TYPE_BYTES, { multiline: false });
    const subject = text(input.subject, 'memory subject', MAX_SUBJECT_BYTES, { multiline: false });
    const content = text(input.content, 'memory content', MAX_CONTENT_BYTES);
    if (containsSecret(content) || containsSecret(subject)) throw new Error('Secret-like content cannot be stored in personal memory');
    const source = text(input.source, 'memory source', 40, { multiline: false });
    if (!SOURCES.has(source)) throw new Error('Unsupported memory source');
    const sourceEventId = identifier(input.sourceEventId, 'sourceEventId');
    const sensitivity = input.sensitivity === undefined ? 'normal' : text(input.sensitivity, 'memory sensitivity', 16, { multiline: false });
    if (!SENSITIVITIES.has(sensitivity)) throw new Error('Unsupported memory sensitivity');
    const confidence = input.confidence === undefined ? 100 : input.confidence;
    if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) throw new Error('Invalid memory confidence');
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : input.expiresAt;
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now())) throw new Error('Invalid memory expiration');
    const replaceId = identifier(input.replaces, 'replaces');
    const now = this.now(); const hash = createHash('sha256').update(content, 'utf8').digest('hex');
    this._expire(now);
    if (replaceId) {
      const prior = this.db.prepare("SELECT * FROM personal_memories WHERE memory_id = ? AND status = 'active'").get(replaceId);
      if (!prior) throw new Error('Memory to update is not active');
      if (prior.domain !== scope.domain || prior.project_id !== scope.projectId || prior.task_id !== scope.taskId || prior.session_id !== scope.sessionId) throw new Error('Memory replacement scope cannot change');
    }
    const existing = this._activeByIdentity(scope, type, subject).find(row => row.content_hash === hash &&
      row.source === source && row.source_event_id === sourceEventId && row.sensitivity === sensitivity &&
      row.confidence === confidence && row.expires_at === expiresAt && (!replaceId || row.memory_id === replaceId));
    if (existing) {
      const item = asItem(existing); this._record('memory.write', item, 'deduplicated');
      return { ...item, deduplicated: true };
    }
    const id = randomUUID();
    this.db.exec('SAVEPOINT personal_memory_write');
    try {
      if (replaceId) {
        const prior = this.db.prepare("SELECT * FROM personal_memories WHERE memory_id = ? AND status = 'active'").get(replaceId);
        if (!prior) throw new Error('Memory to update is not active');
      }
      this.db.prepare(`INSERT INTO personal_memories(memory_id, domain, type, subject, content, content_hash, source, source_event_id, task_id, project_id, session_id, created_at, updated_at, last_used_at, confidence, sensitivity, status, superseded_by, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'active', NULL, ?)`)
        .run(id, scope.domain, type, subject, content, hash, source, sourceEventId, scope.taskId, scope.projectId, scope.sessionId, now, now, confidence, sensitivity, expiresAt);
      const replaced = this._activeByIdentity(scope, type, subject).filter(row => row.memory_id !== id).map(row => row.memory_id);
      if (replaceId && !replaced.includes(replaceId)) replaced.push(replaceId);
      if (replaced.length) this.db.prepare(`UPDATE personal_memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE memory_id IN (${replaced.map(() => '?').join(',')}) AND status = 'active'`).run(id, now, ...replaced);
      this.db.exec('RELEASE SAVEPOINT personal_memory_write');
      const item = this._read(id, { includeInactive: true });
      this._record('memory.write', item);
      for (const previousId of replaced) this._record('memory.superseded', { ...item, memoryId: previousId });
      return { ...item, deduplicated: false, superseded: replaced };
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT personal_memory_write; RELEASE SAVEPOINT personal_memory_write'); } catch { /* Transaction was not opened. */ }
      throw error;
    }
  }

  update(memoryId, patch = {}) {
    identifier(memoryId, 'memoryId', { optional: false });
    keys(patch, new Set(['domain', 'type', 'subject', 'content', 'source', 'sourceEventId', 'taskId', 'projectId', 'sessionId', 'confidence', 'sensitivity', 'expiresAt']), 'memory update');
    const previous = this._read(memoryId, { includeInactive: true });
    if (!previous || previous.status !== 'active') throw new Error('Memory to update is not active');
    if (!Object.hasOwn(patch, 'content')) throw new Error('Memory update requires content');
    return this.remember({
      domain: patch.domain ?? previous.domain, type: patch.type ?? previous.type, subject: patch.subject ?? previous.subject,
      content: patch.content, source: patch.source ?? previous.source, sourceEventId: patch.sourceEventId ?? previous.sourceEventId,
      projectId: patch.projectId ?? previous.projectId, taskId: patch.taskId ?? previous.taskId, sessionId: patch.sessionId ?? previous.sessionId,
      confidence: patch.confidence ?? previous.confidence, sensitivity: patch.sensitivity ?? previous.sensitivity,
      expiresAt: Object.hasOwn(patch, 'expiresAt') ? patch.expiresAt : previous.expiresAt, replaces: memoryId
    });
  }

  forget(memoryId) {
    identifier(memoryId, 'memoryId', { optional: false });
    const previous = this._read(memoryId, { includeInactive: true });
    if (!previous) throw new Error('Memory to forget was not found');
    const row = this.db.prepare('SELECT * FROM personal_memories WHERE memory_id=?').get(memoryId);
    this._eraseRow(row, 'forget');
    const forgotten = this._read(memoryId, { includeInactive: true }); this._record('memory.forget', forgotten, 'forgotten');
    return forgotten;
  }

  get(memoryId, { includeInactive = false, includeSensitive = true } = {}) {
    identifier(memoryId, 'memoryId', { optional: false });
    if (typeof includeInactive !== 'boolean') throw new Error('includeInactive must be boolean');
    if (typeof includeSensitive !== 'boolean') throw new Error('includeSensitive must be boolean');
    this._expire(); const item = this._read(memoryId, { includeInactive });
    if (item && !includeSensitive && item.sensitivity !== 'normal') return null;
    if (!item) return null;
    if (item.status === 'active') this.db.prepare('UPDATE personal_memories SET last_used_at = ? WHERE memory_id = ?').run(this.now(), memoryId);
    const current = this._read(memoryId, { includeInactive }); this._record('memory.read', current, 'found'); return current;
  }

  search(query, options = {}) {
    erasure.assertCurrent(this.db);require('./memory-identity').assertReadable(this.db);
    keys(options, new Set(['domain', 'projectId', 'taskId', 'sessionId', 'limit', 'maxChars', 'includeSensitive']), 'memory search options');
    this._expire();
    const value = normalizeSearchQuery(query);
    const domain = options.domain === undefined ? null : text(options.domain, 'memory domain', 16, { multiline: false });
    if (domain !== null && !DOMAINS.has(domain)) throw new Error('Unsupported memory domain');
    const projectId = identifier(options.projectId, 'projectId'); const taskId = identifier(options.taskId, 'taskId'); const sessionId = identifier(options.sessionId, 'sessionId');
    const limit = count(options.limit, 6, MAX_RESULTS, 'limit'); const maxChars = count(options.maxChars, 4000, MAX_RETRIEVAL_CHARS, 'maxChars');
    if (options.includeSensitive !== undefined && typeof options.includeSensitive !== 'boolean') throw new Error('includeSensitive must be boolean');
    if (limit === 0 || maxChars === 0) return { items: [], usedChars: 0, truncated: false };

    const scopeSql = `p.status = 'active' AND NOT EXISTS(SELECT 1 FROM memory_erasure_markers e WHERE e.store='personal' AND e.identity=p.memory_id) AND (? IS NULL OR p.domain = ?) AND (? IS NULL OR p.project_id = ?) AND (? IS NULL OR p.task_id = ?) AND (? IS NULL OR p.session_id = ?) AND (? = 1 OR p.sensitivity = 'normal')`;
    const scopeArgs = [domain, domain, projectId, projectId, taskId, taskId, sessionId, sessionId, options.includeSensitive ? 1 : 0];
    const seen = new Set();
    const ranked = [];

    // Exact subject match first — FTS tokenizes punctuation (e.g. autonomy.smoke.20260930)
    // and would otherwise miss the live exact-subject retrieval case.
    const exact = this.db.prepare(`SELECT p.*, 0 AS rank FROM personal_memories p
      WHERE ${scopeSql} AND lower(p.subject) = lower(?)
      ORDER BY p.updated_at DESC, p.memory_id ASC LIMIT ?`).all(...scopeArgs, value, limit + 1);
    for (const row of exact) {
      if (seen.has(row.memory_id)) continue;
      seen.add(row.memory_id);
      ranked.push({ ...row, reason: `exact subject match for: ${value}` });
    }

    const terms = [...new Set((value.match(/[\p{L}\p{N}_]+/gu) || []).map(term => term.toLocaleLowerCase('en-US')).filter(term => term.length <= 64))].slice(0, 16);
    if (terms.length) {
      // AND keeps multi-token queries precise (lifecycle.alpha must not match
      // lifecycle.beta). Single-token queries behave as before.
      const match = terms.map(term => `"${term}"`).join(' AND ');
      const rows = this.db.prepare(`SELECT p.*, bm25(personal_memory_fts) AS rank FROM personal_memory_fts JOIN personal_memories p ON p.rowid = personal_memory_fts.rowid
        WHERE personal_memory_fts MATCH ? AND ${scopeSql}
        ORDER BY rank ASC, p.updated_at DESC, p.memory_id ASC LIMIT ?`).all(match, ...scopeArgs, limit + 1);
      for (const row of rows) {
        if (seen.has(row.memory_id)) continue;
        seen.add(row.memory_id);
        ranked.push({ ...row, reason: `FTS5 relevance for: ${terms.join(', ')}` });
      }
    }

    // Substring subject fallback for punctuation-heavy queries whose tokens alone
    // are too weak (e.g. numeric segments) after exact match missed a near-hit.
    if (ranked.length < limit && value.length >= 3) {
      const like = this.db.prepare(`SELECT p.*, 1 AS rank FROM personal_memories p
        WHERE ${scopeSql} AND instr(lower(p.subject), lower(?)) > 0
        ORDER BY p.updated_at DESC, p.memory_id ASC LIMIT ?`).all(...scopeArgs, value, limit + 1);
      for (const row of like) {
        if (seen.has(row.memory_id)) continue;
        seen.add(row.memory_id);
        ranked.push({ ...row, reason: `subject contains: ${value}` });
      }
    }

    let usedChars = 0; let truncated = ranked.length > limit; const items = [];
    for (const row of ranked.slice(0, limit)) {
      const item = { ...asItem(row), score: row.rank, reason: row.reason };
      const serialized = JSON.stringify(item);
      if (serialized.length > maxChars - usedChars) {
        const excerpt = clip(item.content, Math.max(0, maxChars - usedChars - JSON.stringify({ ...item, content: '', contentTruncated: true }).length));
        if (!excerpt.value) { truncated = true; break; }
        item.content = excerpt.value; item.contentTruncated = true; truncated = true;
      }
      const size = JSON.stringify(item).length;
      if (size > maxChars - usedChars) { truncated = true; break; }
      items.push(item); usedChars += size;
    }
    if (items.length) this.db.prepare(`UPDATE personal_memories SET last_used_at = ? WHERE memory_id IN (${items.map(() => '?').join(',')})`).run(this.now(), ...items.map(item => item.memoryId));
    this._record('memory.read', { domain: domain || 'mixed', projectId, taskId, sessionId, sensitivity: options.includeSensitive ? 'included' : 'normal' }, 'searched');
    return { items, usedChars, truncated };
  }

  recent(options = {}) {
    erasure.assertCurrent(this.db);require('./memory-identity').assertReadable(this.db);
    keys(options, new Set(['domain', 'projectId', 'taskId', 'sessionId', 'limit', 'includeSensitive']), 'memory recent options'); this._expire();
    const domain = options.domain === undefined ? null : text(options.domain, 'memory domain', 16, { multiline: false });
    if (domain !== null && !DOMAINS.has(domain)) throw new Error('Unsupported memory domain');
    const projectId = identifier(options.projectId, 'projectId'); const taskId = identifier(options.taskId, 'taskId'); const sessionId = identifier(options.sessionId, 'sessionId');
    if (options.includeSensitive !== undefined && typeof options.includeSensitive !== 'boolean') throw new Error('includeSensitive must be boolean');
    const limit = count(options.limit, 20, 100, 'limit'); const rows = this.db.prepare(`SELECT * FROM personal_memories WHERE status = 'active' AND (? IS NULL OR domain = ?) AND (? IS NULL OR project_id = ?) AND (? IS NULL OR task_id = ?) AND (? IS NULL OR session_id = ?) AND (? = 1 OR sensitivity = 'normal') ORDER BY updated_at DESC, memory_id ASC LIMIT ?`).all(domain, domain, projectId, projectId, taskId, taskId, sessionId, sessionId, options.includeSensitive === false ? 0 : 1, limit);
    const items = rows.filter(row => !erasure.marker(this.db, 'personal', row.memory_id)).map(asItem); this._record('memory.read', { domain: domain || 'mixed', projectId, taskId, sessionId, sensitivity: options.includeSensitive === false ? 'normal' : 'included' }, 'recent'); return { items };
  }

  stats() {
    this._expire();
    const byStatus = Object.fromEntries(this.db.prepare('SELECT status, count(*) AS count FROM personal_memories GROUP BY status ORDER BY status').all().map(row => [row.status, row.count]));
    const byDomain = Object.fromEntries(this.db.prepare('SELECT domain, count(*) AS count FROM personal_memories GROUP BY domain ORDER BY domain').all().map(row => [row.domain, row.count]));
    return { schemaVersion: SCHEMA_VERSION, count: this.db.prepare('SELECT count(*) AS count FROM personal_memories').get().count, byStatus, byDomain };
  }
}

module.exports = { PersonalMemory, SCHEMA_VERSION, MAX_CONTENT_BYTES, MAX_RESULTS, containsSecret, normalizeSearchQuery };
