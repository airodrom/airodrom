'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const erasure = require('./memory-erasure');
const { transaction } = require('./control-transaction');

const MAX_CONTENT = 8000;
const MAX_PROVENANCE = 2048;
const MAX_RESULTS = 10;
const MAX_RETRIEVAL_CHARS = 8000;

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function boundedString(value, name, maximum, { multiline = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || (multiline ? /\0/ : /[\u0000-\u001f]/).test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function scope(taskId) { return boundedString(taskId, 'taskId', 128); }

function booleanOption(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`);
  return value;
}

function boundedNumber(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return Math.min(value, maximum);
}

function provenanceFor(value) {
  if (!plainObject(value)) throw new Error('Provenance is required');
  if (Object.getOwnPropertySymbols(value).length || Object.keys(value).some(key => !['source', 'sessionId', 'entryId', 'url'].includes(key))) throw new Error('Unsupported provenance metadata');
  const provenance = { source: boundedString(value.source, 'provenance source', 512) };
  for (const key of ['sessionId', 'entryId']) {
    if (value[key] !== undefined) provenance[key] = boundedString(value[key], `provenance ${key}`, 128);
  }
  if (value.url !== undefined) {
    const url = boundedString(value.url, 'provenance URL', 1200);
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid provenance URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Provenance URL must be HTTP(S) without credentials');
    provenance.url = url;
  }
  if (JSON.stringify(provenance).length > MAX_PROVENANCE) throw new Error('Provenance metadata exceeds limit');
  return provenance;
}

function toItem(row) {
  return { id: row.id, taskId: row.task_id, kind: row.kind, content: row.content, provenance: JSON.parse(row.provenance), shared: row.shared === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}

function serializedLength(item) { return JSON.stringify(item).length; }

function fitItem(item, available) {
  if (serializedLength(item) <= available) return item;
  const excerpt = { ...item, content: '', contentTruncated: true };
  if (serializedLength(excerpt) + 1 > available) return null;
  let low = 0;
  let high = item.content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    excerpt.content = item.content.slice(0, middle);
    if (serializedLength(excerpt) <= available) low = middle; else high = middle - 1;
  }
  excerpt.content = item.content.slice(0, low);
  if (/[\uD800-\uDBFF]$/.test(excerpt.content)) excerpt.content = excerpt.content.slice(0, -1);
  return excerpt.content ? excerpt : null;
}

class MemoryStore {
  constructor(dbPath, { db, restoreFromBackup = false, erasureSourceDb } = {}) {
    if (typeof dbPath !== 'string' || !dbPath || dbPath.includes('\0')) throw new Error('Memory database path is required');
    if (typeof restoreFromBackup !== 'boolean') throw new Error('Invalid restore policy');
    this.dbPath = dbPath === ':memory:' ? dbPath : path.resolve(dbPath);
    if (this.dbPath !== ':memory:') fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.ownsDb = !db;
    this.db = db || new DatabaseSync(this.dbPath);
    this.closed = false;
    if (this.dbPath !== ':memory:') fs.chmodSync(this.dbPath, 0o600);
    if (this.ownsDb) this.db.exec('PRAGMA busy_timeout = 2500; PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        provenance TEXT NOT NULL,
        shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0, 1)),
        dedupe TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_scope ON memory_entries(task_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memory_shared ON memory_entries(shared);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content='memory_entries', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memory_entries BEGIN
        INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memory_entries BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_update AFTER UPDATE ON memory_entries BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
    erasure.migrate(this.db);
    if (restoreFromBackup) erasure.reconcile(this.db, erasureSourceDb);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_erasure_insert BEFORE INSERT ON memory_entries
      WHEN EXISTS(SELECT 1 FROM memory_erasure_markers WHERE store='scratch' AND identity=new.id)
      BEGIN SELECT RAISE(ABORT,'Erased scratch memory replay denied'); END;
      CREATE TRIGGER IF NOT EXISTS memory_erasure_update BEFORE UPDATE ON memory_entries
      WHEN EXISTS(SELECT 1 FROM memory_erasure_markers WHERE store='scratch' AND identity=new.id)
      BEGIN SELECT RAISE(ABORT,'Erased scratch memory replay denied'); END;
    `);
    this.retryErasure();
  }

  _open() { if (this.closed) throw new Error('Memory store is closed');erasure.assertCurrent(this.db);require('./memory-identity').assertReadable(this.db); }

  // Host-only lifecycle operation; no model-facing mutation or scope override.
  eraseTask(taskId) {
    this._open(); scope(taskId);
    const rows = this.db.prepare('SELECT id FROM memory_entries WHERE task_id=?').all(taskId);
    transaction(this.db, () => { for (const row of rows) erasure.mark(this.db, { store: 'scratch', identity: row.id, scope_hash: erasure.scopeHash([taskId]), action: 'operator_erasure' }); });
    const result = this.retryErasure();
    return { taskId, marked: rows.length, ...result, authority: false };
  }

  retryErasure() {
    this._open(); let purged = 0, retryable = 0;
    for (const item of this.db.prepare("SELECT identity,scope_hash FROM memory_erasure_markers WHERE store='scratch' GROUP BY identity,scope_hash").all()) {
      const row = this.db.prepare('SELECT task_id FROM memory_entries WHERE id=?').get(item.identity);
      if (row && erasure.scopeHash([row.task_id]) !== item.scope_hash) throw Error('Scratch erasure scope mismatch');
      try {
        const marker=erasure.marker(this.db,'scratch',item.identity);
        if(marker.action==='operator_erasure')require('./memory-content-erasure').propagate(this.db,marker);
        transaction(this.db, () => this.db.prepare('DELETE FROM memory_entries WHERE id=?').run(item.identity));
        erasure.progress(this.db, 'scratch', item.identity, 'purged'); purged++;
      } catch {
        erasure.progress(this.db, 'scratch', item.identity, 'retryable'); retryable++;
      }
    }
    return { purged, retryable };
  }

  // Call only from an authenticated local operator route. Models can retrieve, but cannot
  // invoke this method through a bridge tool or automatically promote text to shared memory.
  save(record = {}) {
    this._open();
    if (!plainObject(record)) throw new Error('Memory entry must be an object');
    const { taskId, kind, content, provenance, shared = false } = record;
    scope(taskId);
    boundedString(kind, 'memory kind', 64);
    if (!/^[a-z][a-z0-9_-]*$/i.test(kind)) throw new Error('Invalid memory kind');
    boundedString(content, 'memory content', MAX_CONTENT, { multiline: true });
    const sourceMetadata = provenanceFor(provenance);
    booleanOption(shared, 'shared');
    const serialized = JSON.stringify(sourceMetadata);
    const dedupe = createHash('sha256').update(JSON.stringify([taskId, sourceMetadata.source, content])).digest('hex');
    const previous = this.db.prepare('SELECT * FROM memory_entries WHERE dedupe = ?').get(dedupe);
    if (previous && erasure.marker(this.db, 'scratch', previous.id)) throw Error('Scratch memory erasure pending');
    const timestamp = new Date().toISOString();
    if (previous) {
      // Sharing is never inferred from content, provenance, or retrieval. A caller must explicitly
      // provide shared:true; an ordinary duplicate save keeps existing scope unchanged.
      const sharing = Object.hasOwn(record, 'shared') ? (shared ? 1 : 0) : previous.shared;
      this.db.prepare('UPDATE memory_entries SET kind = ?, provenance = ?, shared = ?, updated_at = ? WHERE id = ?').run(kind, serialized, sharing, timestamp, previous.id);
      return { ...toItem(this.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(previous.id)), deduplicated: true };
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO memory_entries(id, task_id, kind, content, source, provenance, shared, dedupe, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, taskId, kind, content, sourceMetadata.source, serialized, shared ? 1 : 0, dedupe, timestamp, timestamp);
    return { ...toItem(this.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id)), deduplicated: false };
  }

  saveCheckpoint(taskId, value, { sessionId, model = false, runtime = false } = {}) {
    const checkpoint = require('./mission-checkpoint').validateCheckpoint(value, { model });
    if (model) {
      const previous = this.latestCheckpoint(taskId);
      if (previous) {
        const prior = JSON.parse(previous.content);
        checkpoint.verifiedFacts = prior.verifiedFacts;
        checkpoint.completedGates = prior.completedGates;
      }
      require('./mission-checkpoint').validateCheckpoint(checkpoint);
    }
    return this.save({ taskId, kind: 'checkpoint', content: JSON.stringify(checkpoint), provenance: { source: model ? 'model-narrative' : runtime ? 'runtime-observation' : 'operator-verified', sessionId } });
  }

  latestCheckpoint(taskId) {
    this._open(); scope(taskId);
    const row = this.db.prepare("SELECT * FROM memory_entries WHERE task_id = ? AND kind = 'checkpoint' AND NOT EXISTS(SELECT 1 FROM memory_erasure_markers e WHERE e.store='scratch' AND e.identity=memory_entries.id) ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(taskId);
    return row ? toItem(row) : null;
  }

  search(query, { taskId, includeShared = false, limit = 4, maxChars = 4000 } = {}) {
    this._open();
    scope(taskId);
    booleanOption(includeShared, 'includeShared');
    const count = boundedNumber(limit, 4, MAX_RESULTS, 'limit');
    const budget = boundedNumber(maxChars, 4000, MAX_RETRIEVAL_CHARS, 'maxChars');
    if (typeof query !== 'string' || query.length > 4000) throw new Error('Invalid memory query');
    const terms = [...new Set((query.match(/[\p{L}\p{N}_]+/gu) || []).map(term => term.toLocaleLowerCase('en-US')).filter(term => term.length <= 64))].slice(0, 16);
    if (!terms.length) return { items: [], usedChars: 0, estimatedTokens: 0, truncated: false };
    // Every term is tokenized and quoted; user syntax can never become an FTS operator.
    const match = terms.map(term => `"${term}"`).join(' OR ');
    const rows = this.db.prepare(`
      SELECT m.*, bm25(memory_fts) AS rank
      FROM memory_fts JOIN memory_entries m ON m.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ? AND (m.task_id = ? OR (? = 1 AND m.shared = 1))
        AND NOT EXISTS(SELECT 1 FROM memory_erasure_markers e WHERE e.store='scratch' AND e.identity=m.id)
      ORDER BY rank ASC, m.updated_at DESC, m.id ASC LIMIT ?
    `).all(match, taskId, includeShared ? 1 : 0, count + 1);
    const items = [];
    let usedChars = 0;
    let truncated = rows.length > count;
    for (const row of rows.slice(0, count)) {
      const item = { ...toItem(row), score: row.rank, reason: `FTS5 relevance for: ${terms.join(', ')}` };
      const fitted = fitItem(item, budget - usedChars);
      if (!fitted) { truncated = true; break; }
      items.push(fitted);
      usedChars += serializedLength(fitted);
      if (fitted.contentTruncated) truncated = true;
    }
    return { items, usedChars, estimatedTokens: Math.ceil(usedChars / 4), truncated };
  }

  list({ taskId, includeShared = false, limit = 50 } = {}) {
    this._open();
    scope(taskId);
    booleanOption(includeShared, 'includeShared');
    const count = boundedNumber(limit, 50, 200, 'limit');
    return this.db.prepare("SELECT * FROM memory_entries WHERE (task_id = ? OR (? = 1 AND shared = 1)) AND NOT EXISTS(SELECT 1 FROM memory_erasure_markers e WHERE e.store='scratch' AND e.identity=memory_entries.id) ORDER BY updated_at DESC, id ASC LIMIT ?").all(taskId, includeShared ? 1 : 0, count).map(toItem);
  }

  stats() {
    this._open();
    const count = this.db.prepare('SELECT count(*) AS count FROM memory_entries').get().count;
    const byKind = Object.fromEntries(this.db.prepare('SELECT kind, count(*) AS count FROM memory_entries GROUP BY kind ORDER BY kind').all().map(row => [row.kind, row.count]));
    let dbBytes = 0;
    if (this.dbPath !== ':memory:') {
      for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
        try { dbBytes += fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return { count, byKind, dbBytes };
  }

  close() {
    if (this.closed) return;
    if (this.ownsDb) this.db.close();
    this.closed = true;
  }
}

module.exports = MemoryStore;
module.exports.MemoryStore = MemoryStore;
