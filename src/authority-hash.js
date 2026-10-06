'use strict';
const { createHash } = require('node:crypto');
const canonicalize = require('canonicalize').default;

// Accept JSON data, not objects with executable serialization hooks. The JCS
// library owns serialization; this boundary only rejects unsupported inputs.
function validateJson(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw new Error('JSON nesting exceeds authority boundary');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error('Malformed Unicode');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite JSON number');
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Unsupported JSON value');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Plain JSON object required');
  if (Object.getOwnPropertySymbols(value).length) throw new Error('JSON symbols prohibited');
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (!key.isWellFormed()) throw new Error('Malformed Unicode key');
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, 'value')) throw new Error('JSON accessors prohibited');
    validateJson(property.value, seen, depth + 1);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new Error('Sparse or extended JSON array');
  seen.delete(value);
}
/** @param {import('./authority-types').JsonValue} value @returns {Uint8Array} */
function canonicalSerialize(value) {
  validateJson(value);
  return Buffer.from(canonicalize(value), 'utf8');
}
/** @param {import('./authority-types').JsonValue} value @returns {import('./authority-types').Sha256} */
function canonicalHash(value) {
  return createHash('sha256').update(canonicalSerialize(value)).digest('hex');
}
function genesisHash(projectId) { return canonicalHash({ domain: 'arecibo.authority.ledger', version: 1, project_id: projectId }); }
function ledgerEnvelope(entry) {
  return { version: 1, project_id: entry.project_id, sequence: entry.sequence, entry_id: entry.entry_id,
    mission_id: entry.mission_id, mission_revision: entry.mission_revision, run_id: entry.run_id,
    kind: entry.kind, actor_type: entry.actor_type, actor_id: entry.actor_id,
    payload: typeof entry.payload_json === 'string' ? JSON.parse(entry.payload_json) : entry.payload,
    previous_hash: entry.previous_hash, timestamp: entry.timestamp };
}
function verifyLedgerChain(entries) {
  const heads = new Map();
  try {
    for (const entry of entries) {
      const prior = heads.get(entry.project_id) || { sequence: 0, hash: genesisHash(entry.project_id) };
      if (entry.sequence !== prior.sequence + 1 || entry.previous_hash !== prior.hash || canonicalHash(ledgerEnvelope(entry)) !== entry.entry_hash) {
        return { valid: false, project_id: entry.project_id, sequence: entry.sequence, error: 'LEDGER_INTEGRITY' };
      }
      heads.set(entry.project_id, { sequence: entry.sequence, hash: entry.entry_hash });
    }
    return { valid: true, entries: entries.length, projects: heads.size };
  } catch { return { valid: false, error: 'LEDGER_INVALID_DATA' }; }
}
module.exports = { canonicalSerialize, canonicalHash, validateJson, genesisHash, ledgerEnvelope, verifyLedgerChain };
