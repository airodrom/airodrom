'use strict';
// Read-only release probe. No tools/call, Mission mutations, installs, or restarts.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const integrity = require('../src/mcp-catalog-integrity');

function findExecutable(command = 'airodrom', env = process.env) {
  if (typeof command !== 'string' || !command || command.includes('\0')) throw Error('Invalid executable');
  const candidates = path.isAbsolute(command) ? [command] :
    (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  throw Error('Airodrom executable not found on MCP process PATH');
}
function installationRoot(executable) {
  const resolved = fs.realpathSync(executable);
  if (path.basename(resolved) !== 'airodrom.cjs' || path.basename(path.dirname(resolved)) !== 'scripts')
    throw Error('Executable does not resolve to scripts/airodrom.cjs');
  const root = path.dirname(path.dirname(resolved));
  for (const file of ['src/mcp-tools.js', 'src/mcp-stdio.js', 'package.json']) {
    if (!fs.statSync(path.join(root, file)).isFile()) throw Error('Incomplete Airodrom installation');
  }
  return root;
}
function gitSha(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 });
  const sha = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}
function freshTools(executable, options = {}) {
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'catalog-integrity-probe', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  const result = spawnSync(process.execPath, [executable, 'mcp'], {
    input: frames.map(frame => JSON.stringify(frame)).join('\n') + '\n',
    encoding: 'utf8', timeout: options.timeout || 20000, maxBuffer: 4 * 1024 * 1024,
    cwd: options.cwd || installationRoot(executable), env: options.env || process.env,
  });
  if (result.error || result.status !== 0) throw Error('Fresh MCP tools/list probe failed');
  let responses;
  try { responses = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { throw Error('MCP tool discovery returned invalid JSON'); }
  const initialization = responses.find(row => row.id === 1);
  const response = responses.find(row => row.id === 2);
  if (!initialization?.result?.capabilities?.tools || !response?.result || !Array.isArray(response.result.tools))
    throw Error('MCP initialization or tools/list invalid');
  return { tools: response.result.tools, list_changed: initialization.result.capabilities.tools.listChanged === true };
}
function clientCatalog(filename) {
  if (!filename) return null;
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 512 * 1024) throw Error('Invalid client-catalog receipt');
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.tools || parsed.names;
  if (!Array.isArray(rows)) throw Error('Expected a JSON array, tools, or names');
  return rows;
}
function verify(options = {}) {
  const sourceRoot = options.sourceRoot || path.resolve(__dirname, '..');
  const sourceTools = options.sourceTools || require(path.join(sourceRoot, 'src/mcp-tools')).TOOLS;
  const executable = options.executable || findExecutable(options.command || 'airodrom', options.env || process.env);
  const installedRoot = installationRoot(executable);
  const installedTools = options.installedTools || require(path.join(installedRoot, 'src/mcp-tools')).TOOLS;
  const probe = freshTools(executable, { cwd: options.cwd || installedRoot, env: options.env || process.env });
  const client = options.client !== undefined ? options.client : clientCatalog(options.clientFile);
  const sourceSha = options.sourceSha === undefined ? gitSha(sourceRoot) : options.sourceSha;
  const installedSha = options.installedSha === undefined ? gitSha(installedRoot) : options.installedSha;
  const report = integrity.inspect({ source: sourceTools, installed: installedTools, advertised: probe.tools, client, sourceSha, installedSha });
  const exeSha = createHash('sha256').update(executable).digest('hex').slice(0, 16);
  return {
    ...report,
    probe: { method: 'initialize + tools/list', no_tool_calls: true, list_changed: probe.list_changed },
    executable: { basename: path.basename(executable), path_digest: exeSha,
      ...(options.showPaths ? { realpath: executable, installation_root: installedRoot } : {}) },
    gate: report.local_status === 'PASS' && (!options.requireClient || report.client_status === 'PASS') ? 'PASS' : 'BLOCKED',
    client_required: Boolean(options.requireClient),
  };
}
function cli(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--installed') opts.command = argv[++i];
    else if (arg === '--client') opts.clientFile = argv[++i];
    else if (arg === '--require-client') opts.requireClient = true;
    else if (arg === '--show-paths') opts.showPaths = true;
    else throw Error('Unknown MCP catalog option');
  }
  const report = verify(opts);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.gate === 'PASS' ? 0 : 2;
}
if (require.main === module) {
  try { process.exitCode = cli(); }
  catch (error) {
    process.stderr.write('MCP catalog integrity check unavailable: ' + (error?.message || 'unknown error') + '\n');
    process.exitCode = 2;
  }
}
module.exports = { findExecutable, installationRoot, gitSha, freshTools, clientCatalog, verify, cli };
