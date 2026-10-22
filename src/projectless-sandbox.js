'use strict';
// Task-scoped sandbox for work that does not name an authorized repository.
// The directory is new, private, and not a view of any enrolled project.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function allocate() {
  const parent = path.join(os.tmpdir(), 'airodrom-task-sandboxes');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'task-')));
  fs.chmodSync(workspace, 0o700);
  fs.writeFileSync(path.join(workspace, 'TASK.md'), 'Task-scoped sandbox. No registered Project. No personal files.\n', { mode: 0o600 });
  const git = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  if (git.status !== 0) throw Error('task_sandbox_unavailable');
  return { workspace, projectless: true, project: null, filesystem: 'task_sandbox_only' };
}

function seedExactFixture(workspace) {
  fs.mkdirSync(path.join(workspace, 'tests'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'alpha\n', { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, 'tests', 'fixture.test.cjs'), "const assert=require('node:assert/strict');assert.equal(require('node:fs').readFileSync('fixture.txt','utf8'),'beta\\n');\n", { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'diff-check', type: 'process', command: 'git', args: ['diff', '--check'] }, { label: 'fixture-test', type: 'process', command: 'node', args: ['--test', 'tests/fixture.test.cjs'] }] }), { mode: 0o600 });
  const git = (...args) => spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  if (git('add', '.').status !== 0) throw Error('task_sandbox_unavailable');
  const commit = spawnSync('git', ['-C', workspace, '-c', 'user.name=Airodrom', '-c', 'user.email=sandbox@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'task sandbox baseline'], { encoding: 'utf8' });
  if (commit.status !== 0) throw Error('task_sandbox_unavailable');
  return workspace;
}

function exactMissionInput(workspace, requestId) {
  return {
    request_id: requestId,
    projectless: true,
    objective: 'Change fixture.txt from alpha to beta. Make its test pass.',
    workspace,
    allowed_files: ['fixture.txt'],
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }],
    verification: { diff_check: 'diff-check', tests: ['fixture-test'], syntax: [] },
    preferred_agent: 'opencode',
    fallback_agents: [],
    capability_scopes: ['repo', 'developer_environment'],
    data_class: 'public',
    risk_auto_acceptance: true,
    dispatch_policy: require('./default-runtime').LOCAL_POLICY,
    task_type: 'focused_refactor',
  };
}



// Explicit data format for exact-result multi-file work. The caller chooses files
// and expected bytes, NEVER permissions, arbitrary commands, grants or verifiers.
// Natural-language intake below compiles to this same data format, never authority.
const WORK_MARKER = 'AIRODROM_WORK_V1';
function normalizeWorkSpec(spec) {
  const { object, text } = require('./control-plane-store');
  object(spec, ['version', 'worker', 'files']);
  if (spec.version !== 1 || !['opencode', 'cursor'].includes(spec.worker)) throw Error('projectless_work_spec_invalid');
  if (!Array.isArray(spec.files) || !spec.files.length || spec.files.length > 8) throw Error('projectless_file_bound');
  const names = new Set(); let bytes = 0;
  const files = spec.files.map(file => {
    object(file, ['path', 'content']);
    const rel = file.path;
    if (typeof rel !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,199}$/.test(rel) ||
        rel.split('/').some(x => !x || x === '.' || x === '..' || x.startsWith('.')) ||
        /(^|\/)(tests?|__tests__|node_modules|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|auth\.json|TASK\.md|package(?:-lock)?\.json)(\/|$)/i.test(rel) ||
        /\.(?:pem|key|p12|db|sqlite)$|\.(?:test|spec)\./i.test(rel)) throw Error('projectless_path_denied');
    const key = rel.toLowerCase();
    if ([...names].some(n => key === n || key.startsWith(n + '/') || n.startsWith(key + '/'))) throw Error('projectless_path_collision');
    names.add(key);
    text(file.content, 'expected file content', 2048); // Validate, but never trim the registered bytes.
    bytes += Buffer.byteLength(file.content);
    if (bytes > 8000) throw Error('projectless_content_bound');
    return { path: rel, content: file.content };
  });
  return { version: 1, worker: spec.worker, files };
}
function parseWorkSpec(instruction) {
  if (typeof instruction !== 'string' || !instruction.trimStart().startsWith(WORK_MARKER)) return null;
  const rest = instruction.trim().slice(WORK_MARKER.length).trim();
  let spec; try { spec = JSON.parse(rest); } catch { throw Error('projectless_work_spec_invalid'); }
  return normalizeWorkSpec(spec);
}

// Deliberately finite grammar: consume the entire request, including both exact
// JSON string literals. Never guess newlines, discard trailing constraints, select
// an existing repository, or treat prose as a grant. ADR 0051 / recovery #142.
function parseNaturalWorkSpec(instruction) {
  if (typeof instruction !== 'string') return null;
  const header = /^(?:use cursor(?: only)? in a (?:new )?disposable (?:workspace|sandbox) to (?:create|write) (?:exactly )?(?:two|2) files|(?:create|write) (?:exactly )?(?:two|2) files in a (?:new )?disposable (?:workspace|sandbox) using cursor(?: only)?)\s*:\s*/i;
  const source = instruction.trim(), prefix = header.exec(source);
  if (!prefix) return null;
  // Match each clause separately so the backreference to optional path ticks is
  // local. JSON.parse interprets escapes as data, without executing source.
  const clause = /^(?:-\s*)?(`?)([^`\s:]+)\1\s*(?::|containing|with content)\s*("(?:[^"\\\r\n]|\\[^\r\n])*")/;
  let rest = source.slice(prefix[0].length);
  const files = [];
  for (let i = 0; i < 2; i++) {
    const match = clause.exec(rest);
    if (!match) throw Error('projectless_exact_two_file_syntax_required');
    let content;
    try { content = JSON.parse(match[3]); } catch { throw Error('projectless_exact_content_json_required'); }
    files.push({ path: match[2], content });
    rest = rest.slice(match[0].length);
    if (i === 0) {
      const separator = /^(?:\s+and\s+|\s*;\s*|[ \t]*\r?\n\s*)/.exec(rest);
      if (!separator) throw Error('projectless_exact_two_file_syntax_required');
      rest = rest.slice(separator[0].length);
    }
  }
  if (!/^\s*\.?\s*$/.test(rest)) throw Error('projectless_unparsed_constraints');
  return normalizeWorkSpec({ version: 1, worker: 'cursor', files });
}

function explicitlyRequestsCursor(instruction) {
  // Destination / imperative phrases are explicit specialist selection.
  // Bare "Cursor" without a destination verb stays unrecognized here and is handled
  // by the cognitive worker parser, which still fails closed when ambiguous.
  return /\b(?:use|using|with|via|in|have|ask)\s+cursor\b|\bcursor[- ]only\b|\bassign(?:ed)?\s+to\s+cursor\b|\bcursor\s+(?:to\s+)?(?:change|edit|modify|write|update|implement|execute|run)\b|\bcursor\s+as\s+(?:the\s+)?(?:\w+\s+){0,4}(?:implementation\s+)?specialist\b|\bcursor\s+as\s+(?:the\s+)?(?:explicitly\s+requested\s+)?(?:implementation\s+)?(?:specialist|worker)\b/i.test(instruction);
}
function workPresentation(spec) {
  spec = normalizeWorkSpec(spec);
  return { brand: 'AIRODROM', project_name: null, workspace_label: 'task sandbox',
    goal: 'Write the exact requested content to ' + spec.files.map(f => f.path).join(', '),
    worker: spec.worker, files: spec.files.map(f => f.path), measurable: true,
    success_criteria: spec.files.map(f => f.path + ': exact ' + Buffer.byteLength(f.content) + ' bytes'),
    verification: 'Independent host exact-file checks, protected focused test and diff check',
    completion_policy: spec.worker === 'opencode' ? 'Existing risk-based Acceptance after independent verification' : 'Existing Cursor owner Acceptance after independent verification',
    external_disclosure: spec.worker === 'cursor' ? 'Only these public task files, to Cursor' : 'None',
    spending: spec.worker === 'cursor' ? 'Explicit bounded subscription authorization required; per-run cost is unknown' : 'Local inference',
    status: 'Bounded multi-file task prepared' };
}
function seedWork(workspace, input) {
  const spec = normalizeWorkSpec(input);
  const parent = fs.realpathSync(path.join(os.tmpdir(), 'airodrom-task-sandboxes'));
  if (typeof workspace !== 'string' || fs.realpathSync(workspace) !== workspace ||
      path.dirname(workspace) !== parent || !/^task-[A-Za-z0-9]+$/.test(path.basename(workspace)) ||
      (fs.statSync(workspace).mode & 0o077) !== 0) throw Error('projectless_workspace_denied');
  const entries = fs.readdirSync(workspace);
  if (entries.length !== 2 || !entries.includes('TASK.md') || !entries.includes('.git') ||
      entries.some(f => fs.lstatSync(path.join(workspace, f)).isSymbolicLink()) ||
      fs.readFileSync(path.join(workspace, 'TASK.md'), 'utf8') !== 'Task-scoped sandbox. No registered Project. No personal files.\n')
    throw Error('projectless_workspace_not_pristine');
  for (const file of spec.files) {
    fs.mkdirSync(path.dirname(path.join(workspace, file.path)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workspace, file.path), '', { flag: 'wx', mode: 0o600 });
  }
  fs.mkdirSync(path.join(workspace, 'tests'), { mode: 0o700 });
  fs.mkdirSync(path.join(workspace, '.vscode'), { mode: 0o700 });
  // Expected bytes are JSON data; never interpolate them as executable source.
  const check = "'use strict';\nconst assert=require('node:assert/strict'),fs=require('node:fs');\n" +
    'const expected=' + JSON.stringify(spec.files) + ';\n' +
    "for(const f of expected)assert.deepEqual(fs.readFileSync(f.path),Buffer.from(f.content,'utf8'),f.path);\n";
  fs.writeFileSync(path.join(workspace, 'tests', 'projectless-files.test.cjs'), check, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(workspace, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [
    { label: 'diff-check', type: 'process', command: 'git', args: ['diff', '--check'] },
    { label: 'projectless-files', type: 'process', command: 'node', args: ['--test', 'tests/projectless-files.test.cjs'] },
  ] }), { mode: 0o600, flag: 'wx' });
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', HOME: workspace, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = args => spawnSync('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', env });
  if (git(['add', '.']).status !== 0 || git(['-c', 'user.name=Airodrom', '-c', 'user.email=sandbox@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'task sandbox baseline']).status !== 0)
    throw Error('task_sandbox_unavailable');
  return spec;
}
function workMissionInput(workspace, requestId, input, { externalConfirmed = false } = {}) {
  const spec = normalizeWorkSpec(input), external = spec.worker === 'cursor';
  if (external && externalConfirmed !== true) throw Error('external_disclosure_unauthorized');
  const now = Date.now(), files = spec.files.map(f => f.path);
  const permissions = external ? { external_disclosure: { authorized: true, providers: ['cursor'], purpose: 'Declared public files in a new projectless exact-result task sandbox' },
    network: { mode: 'allowlist', allow: require('./mission-contract').KNOWN_PROVIDER_HOSTS.cursor } } : {};
  return { request_id: requestId, projectless: true, workspace,
    objective: workPresentation(spec).goal,
    allowed_files: files,
    criteria: spec.files.map((f, i) => ({ id: 'expected_file_' + i, type: 'exact_file', path: f.path, content: f.content })),
    verification: { diff_check: 'diff-check', tests: ['projectless-files'], syntax: [] },
    preferred_agent: spec.worker, fallback_agents: [], capability_scopes: ['repo', 'developer_environment'], data_class: 'public',
    risk_auto_acceptance: !external, // Cursor must not inherit the OpenCode-only preference.
    dispatch_policy: external ? { privacy: 'cloud_allowed', providers: ['cursor_runtime'], billing_classes: ['subscription'], max_attempts: 1 } : require('./default-runtime').LOCAL_POLICY,
    task_type: 'focused_refactor',
    authority: { level: 'development', permissions: { repository: ['read', 'write'], runtime: ['diagnostic', 'test'],
      network: external ? ['internet', 'localhost'] : ['localhost'], secrets: [], data: ['read', 'workspace_write'] },
      // The host verifier reads the repository and its protected test definitions.
      // Worker reads remain the contract's declared files in a separate staging
      // tree; this host ceiling never expands provider disclosure or writes.
      filesystem: { read: [workspace], write: files.map(f => path.join(workspace, f)) }, expiresAt: now + 900000 },
    contract: { permissions, identity: { expires_at: now + 900000 },
      budget: { risk_class: 'low', max_worker_invocations: 1, max_repair_attempts: 0, max_wall_clock_ms: 180000 } },
  };
}

module.exports = { allocate, seedExactFixture, exactMissionInput, WORK_MARKER, normalizeWorkSpec, parseWorkSpec, parseNaturalWorkSpec, explicitlyRequestsCursor, workPresentation, seedWork, workMissionInput };
