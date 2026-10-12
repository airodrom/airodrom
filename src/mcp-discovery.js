'use strict';
// ADR 0047: observations never imply client visibility or expand public authority.
const { createHash } = require('node:crypto');
const { canonicalHash } = require('./authority-hash');
const { TOOLS } = require('./mcp-tools');
const PUBLIC = new Set(TOOLS.map(t => t.name));
function catalog(tools) {
 if (!Array.isArray(tools) || tools.length > 100 || tools.some(t => !t || !PUBLIC.has(t.name)) || new Set(tools.map(t => t.name)).size !== tools.length) throw Error('Invalid public MCP observation');
 const names = tools.map(t => t.name).sort();
 // Hash public schemas only, never user content or memory.
 return { count: names.length, names, digest: createHash('sha256').update(JSON.stringify(names)).digest('hex'), schema_digest: tools.every(t=>t.inputSchema) ? canonicalHash(tools.map(t => ({ name: t.name, inputSchema: t.inputSchema })).sort((a,b) => a.name.localeCompare(b.name))) : null };
}
function diagnose({ source = TOOLS, installed = null, advertised = null, client = null, sourceSha = null, installedSha = null } = {}) {
 const observed = { source: catalog(source), installed: installed ? catalog(installed) : null, advertised: advertised ? catalog(advertised) : null, client: client ? catalog(client) : null };
 const differences = [];
 for (const [left, right] of [['source', 'installed'], ['installed', 'advertised'], ['advertised', 'client']]) {
  if (!observed[left] || !observed[right]) continue;
  const a = observed[left], b = observed[right];
  if (a.digest !== b.digest || a.schema_digest && b.schema_digest && a.schema_digest !== b.schema_digest) differences.push({ from: left, to: right, missing: a.names.filter(n => !b.names.includes(n)), extra: b.names.filter(n => !a.names.includes(n)), schema_changed: a.names.length === b.names.length && a.names.every(n => b.names.includes(n)) });
 }
 const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x) ? x : null;
 return { schema_version: 1, server_version: require('../package.json').version, observed, source_sha: sha(sourceSha), installed_sha: sha(installedSha),
  version_mismatch: sha(sourceSha) && sha(installedSha) ? sourceSha !== installedSha : null,
  differences, health: differences.length ? 'observed_mismatch' : observed.installed && observed.advertised && observed.client ? 'observed_match' : 'incomplete_observation',
  list_changed: true, catalog_lifetime: 'process_snapshot_with_list_changed_capability',
  limitations: ['Client catalog is unknown unless separately supplied by the client.', 'A mismatch alone cannot distinguish filtering from a cached client snapshot.', 'ChatGPT may keep a conversation-scoped tool catalog; a new conversation is required when ask_airodrom is missing after install refresh.', 'Restart or reconnect must be authorized separately; this diagnostic performs neither.'], authority: false };
}
async function advertisedCatalog() {
 const { McpStdio } = require('./mcp-stdio');
 const server = new McpStdio({ tools: TOOLS, callTool: async () => { throw Error('Discovery never invokes tools'); } });
 await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-contract-probe', version: '1' } } });
 await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
 return (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
}
module.exports = { catalog, diagnose, advertisedCatalog };
