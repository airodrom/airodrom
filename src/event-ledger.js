'use strict';

const { createHash, randomUUID } = require('node:crypto');

const SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_STORED_PAYLOAD_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_EVENT_TYPE_LENGTH = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,160}$/;
const SAFE_LABEL = /^[A-Za-z0-9_.:/-]{1,160}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,119}$/;
const AGENT = /^(?:chatgpt|pi|claude_code|cursor|shell|bridge|supervisor|system|slack)$/;
const DIRECTIONS = new Set(['incoming', 'outgoing', 'internal']);

class LedgerIdempotencyConflictError extends Error {
  constructor() {
    super('Ledger event replay does not match the original event');
    this.name = 'LedgerIdempotencyConflictError';
    this.code = 'LEDGER_IDEMPOTENCY_CONFLICT';
    // This is a deterministic request conflict, never proof that SQLite is
    // unavailable or that an accepted event was corrupted.
    this.ledgerSemantic = true;
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function stable(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!plainObject(value)) throw new Error('Ledger metadata must contain JSON values only');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function ensureIdentifier(value, name, { optional = true } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new Error(`Ledger ${name} is required`);
  }
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`Invalid ledger ${name}`);
  return value;
}
function ensureLabel(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SAFE_LABEL.test(value)) throw new Error(`Invalid ledger ${name}`);
  return value;
}

function clipUtf8(value, limit) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= limit) return { value, truncated: false };
  const clipped = bytes.subarray(0, Math.max(0, limit - Buffer.byteLength('…'))).toString('utf8');
  return { value: `${clipped}…`, truncated: true };
}

/**
 * Produces a local display-safe payload. The ledger deliberately does not keep
 * a second raw payload: a hash proves what was supplied without retaining a
 * recognizable credential for later browsing.
 */
function redactPayload(text) {
  let value = require('./secret-observation').redactText(String(text).normalize('NFKC'));
  try { value = decodeURIComponent(value); } catch { /* Keep malformed escapes as text. */ }
  const before = value;
  value = value
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/=:-]{8,}/gi, '[redacted-secret]')
    .replace(/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{8,}\b/gi, '[redacted-secret]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,})\b/g, '[redacted-secret]')
    .replace(/\b(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|password|passwd|secret|credential|private[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, match => `${match.split(/[:=]/, 1)[0]}=<redacted>`)
    .replace(/(?:https?:\/\/|file:\/\/)[^\s]+/gi, '[redacted-url]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|~\/|(?<![\w])\/)[^\r\n]*/g, '[redacted-path]');
  return { value, redacted: value !== before };
}

function redactJson(value, depth = 0) {
  if (depth > 8) return '[truncated-metadata-depth]';
  if (typeof value === 'string') return redactPayload(value).value;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, 64).map(item => redactJson(item, depth + 1));
  if (!plainObject(value)) throw new Error('Ledger metadata must contain JSON values only');
  const out = {};
  for (const key of Object.keys(value).sort().slice(0, 128)) {
    if (require('./secret-observation').sensitiveKey(key)) out[key] = '[redacted-secret]';
    else out[key] = redactJson(value[key], depth + 1);
  }
  return out;
}

function fingerprint(input) {
  return createHash('sha256').update(stable(input), 'utf8').digest('hex');
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    sequence: row.seq, event_id: row.event_id, event_type: row.event_type, timestamp: row.timestamp, timestamp_ms: row.timestamp_ms,
    task_id: row.task_id, run_id: row.run_id, mission_id: row.mission_id, session_id: row.session_id, request_id: row.request_id,
    trace_id: row.trace_id, span_id: row.span_id, parent_event_id: row.parent_event_id, agent: row.agent, direction: row.direction,
    workspace: row.workspace, repository: row.repository, branch: row.branch, status: row.status, duration_ms: row.duration_ms,
    idempotency_key: row.idempotency_key || null,
    metadata: JSON.parse(row.metadata), payload: row.payload, payload_sha256: row.payload_sha256,
    payload_byte_length: row.payload_byte_length, payload_stored_byte_length: row.payload_stored_byte_length,
    payload_redacted: row.payload_redacted === 1, payload_truncated: row.payload_truncated === 1, protected: row.protected === 1
  };
}

class EventLedger {
  constructor(db, { now = () => Date.now() } = {}) {
    if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new Error('EventLedger requires a SQLite database');
    this.db = db; this.now = now; this.degraded = null;
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_ledger_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, idempotency_key TEXT UNIQUE, fingerprint TEXT NOT NULL,
        event_type TEXT NOT NULL, timestamp TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, task_id TEXT, run_id TEXT, mission_id TEXT,
        session_id TEXT, request_id TEXT, trace_id TEXT, span_id TEXT, parent_event_id TEXT, agent TEXT NOT NULL, direction TEXT NOT NULL,
        workspace TEXT, repository TEXT, branch TEXT, status TEXT, duration_ms INTEGER, metadata TEXT NOT NULL, payload TEXT,
        payload_sha256 TEXT, payload_byte_length INTEGER NOT NULL DEFAULT 0, payload_stored_byte_length INTEGER NOT NULL DEFAULT 0,
        payload_redacted INTEGER NOT NULL DEFAULT 0 CHECK(payload_redacted IN (0, 1)),
        payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK(payload_truncated IN (0, 1)),
        protected INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS event_ledger_timestamp ON event_ledger_events(timestamp_ms, seq);
      CREATE INDEX IF NOT EXISTS event_ledger_task ON event_ledger_events(task_id, seq);
      CREATE INDEX IF NOT EXISTS event_ledger_run ON event_ledger_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS event_ledger_trace ON event_ledger_events(trace_id, seq);
      CREATE INDEX IF NOT EXISTS event_ledger_agent ON event_ledger_events(agent, seq);
      CREATE INDEX IF NOT EXISTS event_ledger_type ON event_ledger_events(event_type, seq);
      CREATE INDEX IF NOT EXISTS event_ledger_repository ON event_ledger_events(repository, branch, seq);
      CREATE INDEX IF NOT EXISTS event_ledger_status ON event_ledger_events(status, seq);
    `);
    const row = this.db.prepare("SELECT value FROM event_ledger_meta WHERE key='schema_version'").get();
    if (!row) this.db.prepare("INSERT INTO event_ledger_meta(key,value) VALUES ('schema_version',?)").run(String(SCHEMA_VERSION));
    else if (Number(row.value) > SCHEMA_VERSION) throw new Error('Event ledger database is newer than this bridge');
    else if (Number(row.value) < SCHEMA_VERSION) this.db.prepare("UPDATE event_ledger_meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION));
  }

  health() {
    return { healthy: this.degraded === null, state: this.degraded === null ? 'healthy' : 'degraded', reason: this.degraded?.message || null, since: this.degraded?.at || null, schema_version: SCHEMA_VERSION };
  }
  markDegraded(error) {
    this.degraded ||= { message: String(error?.message || error || 'Ledger write failed').slice(0, 500), at: new Date(this.now()).toISOString() };
    return this.health();
  }
  requireHealthy() { if (this.degraded) throw new Error(`Event ledger is degraded: ${this.degraded.message}`); }

  _normalize(input) {
    if (!plainObject(input)) throw new Error('Ledger event must be an object');
    if (typeof input.eventType !== 'string' || !EVENT_TYPE.test(input.eventType) || input.eventType.length > MAX_EVENT_TYPE_LENGTH) throw new Error('Invalid ledger event type');
    const agent = input.agent || 'bridge'; if (typeof agent !== 'string' || !AGENT.test(agent)) throw new Error('Invalid ledger agent');
    const direction = input.direction || 'internal'; if (!DIRECTIONS.has(direction)) throw new Error('Invalid ledger direction');
    const eventId = input.eventId || randomUUID(); if (!UUID.test(eventId)) throw new Error('Invalid ledger event ID');
    const ids = {};
    for (const [field, value] of Object.entries({ taskId: input.taskId, runId: input.runId, missionId: input.missionId, sessionId: input.sessionId, requestId: input.requestId, traceId: input.traceId, spanId: input.spanId, parentEventId: input.parentEventId, idempotencyKey: input.idempotencyKey })) ids[field] = ensureIdentifier(value, field);
    const safe = {};
    for (const [field, value] of Object.entries({ workspace: input.workspace, repository: input.repository, branch: input.branch, status: input.status })) safe[field] = ensureLabel(value, field);
    if (input.durationMs !== undefined && (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 7 * 24 * 60 * 60 * 1000)) throw new Error('Invalid ledger duration');
    let payload = null;
    if (input.payload !== undefined && input.payload !== null) {
      if (typeof input.payload !== 'string') throw new Error('Ledger payload must be text');
      const bytes = Buffer.from(input.payload, 'utf8'); if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error('Ledger payload exceeds the maximum input size');
      const redacted = redactPayload(input.payload), clipped = clipUtf8(redacted.value, MAX_STORED_PAYLOAD_BYTES);
      payload = { value: clipped.value, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, storedByteLength: Buffer.byteLength(clipped.value, 'utf8'), redacted: redacted.redacted, truncated: clipped.truncated };
    }
    const metadata = redactJson(input.metadata === undefined ? {} : input.metadata);
    const clippedMetadata = clipUtf8(stable(metadata), MAX_METADATA_BYTES);
    const metadataValue = clippedMetadata.truncated ? JSON.stringify({ truncated: true, preview: clippedMetadata.value }) : clippedMetadata.value;
    const now = this.now();
    const record = { eventId, eventType: input.eventType, agent, direction, ...ids, ...safe, durationMs: input.durationMs ?? null, metadata: metadataValue, payload, protected: input.protected === true ? 1 : 0, timestamp: new Date(now).toISOString(), timestampMs: now };
    record.fingerprint = fingerprint({ eventType: record.eventType, agent: record.agent, direction: record.direction, taskId: record.taskId, runId: record.runId, missionId: record.missionId, sessionId: record.sessionId, requestId: record.requestId, traceId: record.traceId, spanId: record.spanId, parentEventId: record.parentEventId, workspace: record.workspace, repository: record.repository, branch: record.branch, status: record.status, durationMs: record.durationMs, metadata: record.metadata, payloadSha256: record.payload?.sha256 || null, payloadByteLength: record.payload?.byteLength || 0, protected: record.protected });
    return record;
  }

  record(input) {
    this.requireHealthy();
    // Validation and replay conflicts are caller errors. They must not turn a
    // healthy durable store into a denial-of-service condition.
    const record = this._normalize(input);
    try {
      this.db.exec('SAVEPOINT ledger_record');
      try {
        let prior = null;
        if (record.idempotencyKey) prior = this.db.prepare('SELECT * FROM event_ledger_events WHERE idempotency_key=?').get(record.idempotencyKey);
        if (!prior) prior = this.db.prepare('SELECT * FROM event_ledger_events WHERE event_id=?').get(record.eventId);
        if (prior) {
          if (prior.fingerprint !== record.fingerprint) {
            throw new LedgerIdempotencyConflictError();
          }
          this.db.exec('RELEASE SAVEPOINT ledger_record'); return { ...rowToEvent(prior), duplicate: true };
        }
        this.db.prepare(`INSERT INTO event_ledger_events(event_id,idempotency_key,fingerprint,event_type,timestamp,timestamp_ms,task_id,run_id,mission_id,session_id,request_id,trace_id,span_id,parent_event_id,agent,direction,workspace,repository,branch,status,duration_ms,metadata,payload,payload_sha256,payload_byte_length,payload_stored_byte_length,payload_redacted,payload_truncated,protected) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          record.eventId, record.idempotencyKey, record.fingerprint, record.eventType, record.timestamp, record.timestampMs, record.taskId, record.runId, record.missionId, record.sessionId, record.requestId, record.traceId, record.spanId, record.parentEventId, record.agent, record.direction, record.workspace, record.repository, record.branch, record.status, record.durationMs, record.metadata, record.payload?.value || null, record.payload?.sha256 || null, record.payload?.byteLength || 0, record.payload?.storedByteLength || 0, record.payload?.redacted ? 1 : 0, record.payload?.truncated ? 1 : 0, record.protected
        );
        const row = this.db.prepare('SELECT * FROM event_ledger_events WHERE event_id=?').get(record.eventId);
        this.db.exec('RELEASE SAVEPOINT ledger_record'); return { ...rowToEvent(row), duplicate: false };
      } catch (error) { try { this.db.exec('ROLLBACK TO SAVEPOINT ledger_record; RELEASE SAVEPOINT ledger_record'); } catch {} throw error; }
    } catch (error) {
      if (!error.ledgerSemantic) this.markDegraded(error);
      throw error;
    }
  }

  startSpan(input = {}) { const spanId = input.spanId || randomUUID(); return this.record({ ...input, spanId, eventType: input.eventType || 'span.started', status: input.status || 'started' }); }
  completeSpan(span, input = {}) { const started = typeof span === 'string' ? this.list({ spanId: span, limit: 1 }).events[0] : span; if (!started?.span_id) throw new Error('Ledger span is required'); return this.record({ ...input, spanId: started.span_id, parentEventId: input.parentEventId || started.event_id, eventType: input.eventType || 'span.completed', status: input.status || 'completed', durationMs: input.durationMs ?? Math.max(0, this.now() - started.timestamp_ms) }); }
  failSpan(span, input = {}) { return this.completeSpan(span, { ...input, eventType: input.eventType || 'span.failed', status: input.status || 'failed' }); }
  get(eventId) { require('./memory-content-erasure').assertReadable(this.db);if (!UUID.test(eventId)) throw new Error('Invalid ledger event ID'); return rowToEvent(this.db.prepare('SELECT * FROM event_ledger_events WHERE event_id=?').get(eventId)); }

  list(filters = {}) {
    require('./memory-content-erasure').assertReadable(this.db);
    if (!plainObject(filters)) throw new Error('Ledger query must be an object');
    const where = [], values = [];
    const map = { taskId: 'task_id', runId: 'run_id', missionId: 'mission_id', sessionId: 'session_id', requestId: 'request_id', traceId: 'trace_id', spanId: 'span_id', agent: 'agent', eventType: 'event_type', repository: 'repository', branch: 'branch', status: 'status' };
    for (const [input, column] of Object.entries(map)) {
      if (filters[input] === undefined || filters[input] === null) continue;
      const value = input === 'eventType' ? filters[input] : ensureIdentifier(filters[input], input, { optional: false });
      if (input === 'eventType' && (typeof value !== 'string' || !EVENT_TYPE.test(value))) throw new Error('Invalid ledger event type query');
      if (input === 'agent' && !AGENT.test(value)) throw new Error('Invalid ledger agent query');
      where.push(`${column}=?`); values.push(value);
    }
    for (const [input, operator] of [['fromMs', '>='], ['toMs', '<=']]) { if (filters[input] !== undefined) { if (!Number.isSafeInteger(filters[input]) || filters[input] < 0) throw new Error('Invalid ledger time query'); where.push(`timestamp_ms${operator}?`); values.push(filters[input]); } }
    for (const [name, op] of [['afterSequence', '>'], ['beforeSequence', '<']]) {
      if (filters[name] !== undefined) { if (!Number.isSafeInteger(filters[name]) || filters[name] < 0) throw new Error('Invalid ledger sequence cursor'); where.push(`seq${op}?`); values.push(filters[name]); }
    }
    const limit = filters.limit === undefined ? 100 : filters.limit; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid ledger query limit');
    const order = filters.order === 'desc' ? 'DESC' : 'ASC'; const sql = `SELECT * FROM event_ledger_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ${order} LIMIT ?`;
    const events = this.db.prepare(sql).all(...values, limit).map(rowToEvent); return { events, has_more: events.length === limit, health: this.health() };
  }
  listTaskEvents(taskId, options = {}) { return this.list({ ...options, taskId }); }
  listTrace(traceId, options = {}) { return this.list({ ...options, traceId }); }
}

module.exports = { EventLedger, LedgerIdempotencyConflictError, SCHEMA_VERSION, MAX_PAYLOAD_BYTES, MAX_STORED_PAYLOAD_BYTES, redactPayload };
