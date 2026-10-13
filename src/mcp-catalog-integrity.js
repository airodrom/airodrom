'use strict';
// Public MCP metadata only. Never use a catalog observation as execution authority.
const { createHash } = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const sha256 = value => createHash('sha256').update(canonical(value)).digest('hex');
const validName = name => typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(name);

function snapshot(tools) {
  if (!Array.isArray(tools) || tools.length > 100) throw Error('Invalid MCP catalog array');
  const rows = tools.map(value => typeof value === 'string' ? { name: value } : value);
  if (rows.some(row => !row || !validName(row.name))) throw Error('Invalid MCP tool name');
  const names = rows.map(row => row.name).sort();
  if (new Set(names).size !== names.length) throw Error('Duplicate MCP tool name');
  if (rows.some(row => row.inputSchema !== undefined && (!row.inputSchema || typeof row.inputSchema !== 'object' || Array.isArray(row.inputSchema)))) throw Error('Invalid MCP input schema');
  const schemasComplete = rows.every(row => row.inputSchema !== undefined);
  const schemas = Object.fromEntries(rows.filter(row => row.inputSchema !== undefined).map(row => [row.name, sha256(row.inputSchema)]));
  return {
    count: names.length, names, name_digest: sha256(names),
    schema_digest: schemasComplete ? sha256(rows.map(row => ({ name: row.name, schema: row.inputSchema })).sort((a,b) => a.name.localeCompare(b.name))) : null,
    schemas_complete: schemasComplete,
    schema_digests: schemas,
  };
}

function comparison(left, right, a, b) {
  if (!a || !b) return { from: left, to: right, status: 'UNVERIFIED', missing: [], extra: [], schema_changed_names: [], schema_comparison: 'UNVERIFIED' };
  const missing = a.names.filter(name => !b.names.includes(name));
  const extra = b.names.filter(name => !a.names.includes(name));
  const shared = a.names.filter(name => b.names.includes(name));
  const schemaChanged = shared.filter(name => a.schema_digests[name] && b.schema_digests[name] && a.schema_digests[name] !== b.schema_digests[name]);
  const schemasComplete = shared.every(name => a.schema_digests[name] && b.schema_digests[name]);
  const mismatch = Boolean(missing.length || extra.length || schemaChanged.length);
  return {
    from: left, to: right, status: mismatch ? 'MISMATCH' : schemasComplete ? 'PASS' : 'UNVERIFIED',
    missing, extra, schema_changed_names: schemaChanged,
    schema_comparison: schemasComplete ? (schemaChanged.length ? 'MISMATCH' : 'PASS') : 'UNVERIFIED',
  };
}

function inspect({ source, installed = null, advertised = null, client = null, sourceSha = null, installedSha = null } = {}) {
  if (!source) throw Error('Source catalog required');
  const internal = {
    source: snapshot(source), installed: installed === null ? null : snapshot(installed),
    advertised: advertised === null ? null : snapshot(advertised),
    client: client === null ? null : snapshot(client),
  };
  const comparisons = [['source','installed'],['installed','advertised'],['advertised','client']]
    .map(([a,b]) => comparison(a,b,internal[a],internal[b]));
  const knownSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
  const source_sha = knownSha(sourceSha), installed_sha = knownSha(installedSha);
  const version_mismatch = source_sha && installed_sha ? source_sha !== installed_sha : null;
  const local = comparisons.slice(0,2);
  const local_status = version_mismatch || local.some(c => c.status === 'MISMATCH') ? 'MISMATCH' : local.every(c => c.status === 'PASS') ? 'PASS' : 'UNVERIFIED';
  const client_status = comparisons[2].status;
  const status = local_status === 'MISMATCH' || client_status === 'MISMATCH'
    ? 'MISMATCH' : local_status === 'PASS' && client_status === 'PASS' ? 'PASS' : 'UNVERIFIED';
  const observed = Object.fromEntries(Object.entries(internal).map(([stage, value]) => [stage, value && {
    count: value.count, names: value.names, digest: value.name_digest,
    schema_digest: value.schema_digest, schemas_complete: value.schemas_complete,
  }]));
  let first_mismatch = comparisons.find(c => c.status === 'MISMATCH');
  if (version_mismatch && !first_mismatch) first_mismatch = { from: 'source', to: 'installed', status: 'MISMATCH', reason: 'sha_mismatch' };
  return {
    schema_version: 1, status, local_status, client_status, source_sha, installed_sha,
    version_mismatch, observed, comparisons, first_mismatch: first_mismatch || null,
    diagnosis: first_mismatch
      ? first_mismatch.to === 'client' ? 'CLIENT_CATALOG_DIFFERENCE_CAUSE_UNKNOWN'
        : first_mismatch.to === 'advertised' ? 'MCP_PROCESS_CATALOG_DIFFERENCE'
        : 'SOURCE_INSTALL_DIFFERENCE'
      : status === 'PASS' ? 'CATALOG_MATCH' : 'INCOMPLETE_OBSERVATION',
    client_visibility: client === null ? 'NOT_OBSERVED' : client_status === 'PASS' ? 'VERIFIED_MATCH' : client_status === 'MISMATCH' ? 'OBSERVED_DIFFERENCE' : 'PARTIAL_EVIDENCE',
    limitations: [
      'MCP tool discovery does not establish execution permissions or Mission readiness.',
      'A client catalog mismatch cannot distinguish caching, filtering, or connector-target differences without independent client evidence.',
      'Absent client metadata is UNVERIFIED, not PASS.',
    ],
    authority: false,
  };
}

module.exports = { canonical, sha256, snapshot, comparison, inspect };
