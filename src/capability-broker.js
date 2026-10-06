'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { removed } = require('./removed-runtime');
const { LEVEL1_PROFILE_ID, WORKSPACE, assertReadOnlyMission } = require('./level1-profile');
const { ACTIVE_CHAT_PROFILE_ID, READ_ONLY_PATHS: ACTIVE_CHAT_READ_ONLY_PATHS, assertActiveChatMission } = require('./active-chat-mission');
const { containsSecret, MAX_CONTENT_BYTES } = require('./personal-memory');

const TRUSTED_DEV_BROKER_JOBS = new Set(['git_status', 'git_diff', 'git_diff_check', 'git_branch', 'git_head', 'focused_test']);
const {
  BRIDGE_RESTART_JOB, BRIDGE_RESTART_STATUS_JOB, BRIDGE_MAINTENANCE_JOBS, KIND: BRIDGE_MAINTENANCE_KIND,
  describeMaintenanceJob, requestRestart, statusRestart
} = require('./bridge-restart');
const FILE_TOOLS = new Set(['read', 'ls', 'find', 'grep', 'write', 'edit']);
const PERSONAL_MEMORY_READ_TOOLS = new Set(['personal_memory_get', 'personal_memory_search', 'personal_memory_recent']);
const PERSONAL_MEMORY_WRITE_TOOLS = new Set(['personal_memory_remember', 'personal_memory_update', 'personal_memory_forget']);
const PROJECT_READ_TOOLS = new Set(['project_list', 'project_get', 'project_summary', 'project_next_action']);
const PROJECT_WRITE_TOOLS = new Set(['project_create', 'project_create_goal', 'project_create_mission', 'project_set_mission_status', 'project_archive']);
const WORKER_READ_TOOLS = new Set([...PERSONAL_MEMORY_READ_TOOLS, ...PROJECT_READ_TOOLS]);
const WORKER_WRITE_TOOLS = new Set([...PERSONAL_MEMORY_WRITE_TOOLS, ...PROJECT_WRITE_TOOLS]);
const BROKER_TOOLS = new Set([
  ...FILE_TOOLS, 'run_job', 'mission_checkpoint', 'memory_search', 'web_fetch', 'chatgpt_notify', ...WORKER_READ_TOOLS, ...WORKER_WRITE_TOOLS, 'capability'
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_EDITS = 32;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const DOMAINS = new Set(['personal', 'project', 'session']);
const SENSITIVITIES = new Set(['normal', 'private', 'sensitive']);
const PROJECT_STATUSES = new Set(['active', 'paused', 'completed', 'archived']);
const MISSION_STATUSES = new Set(['planned', 'active', 'blocked', 'completed', 'cancelled', 'archived']);
const AUTONOMY_LEVELS = new Set(['observe', 'suggest', 'auto_safe', 'auto_development', 'auto_personal', 'custom']);

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

// Worker nested-call IDs are runtime correlation metadata, never an authority grant.
function toolCallEvidence(value) {
  const id = typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9_.:-]+(?:\/[1-9][0-9]{0,5})*$/.test(value) && !containsSecret(value) ? value : null;
  const split = id?.lastIndexOf('/') ?? -1;
  return { tool_call_id: id, parent_tool_call_id: split > 0 ? id.slice(0, split) : null };
}

function validKeys(value, required, optional = []) {
  return exactKeys(value, required, optional);
}
function boundedText(value, name, maximum, { optional = false, nullable = false } = {}) {
  if (value === undefined) {
    if (optional) return value;
    throw new Error(`Invalid ${name}`);
  }
  if (value === null) {
    if (nullable) return value;
    throw new Error(`Invalid ${name}`);
  }
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function validId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function optionalInteger(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (value === undefined) return;
  if (value === null && nullable) return;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
}
function optionalEnum(value, values, name, { nullable = false } = {}) {
  if (value === undefined) return;
  if (value === null && nullable) return;
  if (typeof value !== 'string' || !values.has(value)) throw new Error(`Invalid ${name}`);
}
function optionalStrings(value, name, maximum = 24, itemMaximum = 500) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${name}`);
  value.forEach((item, index) => boundedText(item, `${name}[${index}]`, itemMaximum));
}

function normalizeWorkerAliases(toolName, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  // Models often echo snake_case from operator prose. Accept only exact known
  // aliases and rewrite to the broker schema before validation — no other keys.
  if (toolName === 'personal_memory_get' || toolName === 'personal_memory_forget') {
    if (input.memoryId === undefined && typeof input.memory_id === 'string') {
      const { memory_id, ...rest } = input;
      return { ...rest, memoryId: memory_id };
    }
  }
  if (toolName === 'personal_memory_update') {
    if (input.memoryId === undefined && typeof input.memory_id === 'string') {
      const { memory_id, ...rest } = input;
      return { ...rest, memoryId: memory_id };
    }
  }
  if (toolName === 'personal_memory_search' && input.query === undefined && typeof input.q === 'string') {
    const { q, ...rest } = input;
    return { ...rest, query: q };
  }
  return input;
}

function validateWorkerToolInput(toolName, input) {
  input = normalizeWorkerAliases(toolName, input);
  if (PERSONAL_MEMORY_READ_TOOLS.has(toolName)) {
    if (toolName === 'personal_memory_get') {
      if (!validKeys(input, ['memoryId'])) throw new Error('Invalid personal_memory_get capability input');
      validId(input.memoryId, 'memoryId'); return input;
    }
    if (toolName === 'personal_memory_search') {
      if (!validKeys(input, ['query'], ['domain'])) throw new Error('Invalid personal_memory_search capability input');
      boundedText(input.query, 'personal memory query', 4_000); optionalEnum(input.domain, DOMAINS, 'memory domain'); return input;
    }
    if (!validKeys(input, ['domain'], ['limit'])) throw new Error('Invalid personal_memory_recent capability input');
    optionalEnum(input.domain, DOMAINS, 'memory domain'); optionalInteger(input.limit, 'memory limit', { minimum: 1, maximum: 20 }); return input;
  }
  if (PERSONAL_MEMORY_WRITE_TOOLS.has(toolName)) {
    if (toolName === 'personal_memory_forget') {
      if (!validKeys(input, ['memoryId'])) throw new Error('Invalid personal_memory_forget capability input');
      validId(input.memoryId, 'memoryId'); return input;
    }
    if (toolName === 'personal_memory_remember') {
      if (!validKeys(input, ['domain', 'type', 'subject', 'content'], ['confidence', 'sensitivity', 'expiresAt'])) throw new Error('Invalid personal_memory_remember capability input');
      if (!DOMAINS.has(input.domain)) throw new Error('Invalid memory domain'); boundedText(input.type, 'memory type', 80); boundedText(input.subject, 'memory subject', 240); boundedText(input.content, 'memory content', MAX_CONTENT_BYTES);
      if (containsSecret(input.content) || containsSecret(input.subject)) throw new Error('Secret-like content cannot be stored in personal memory');
      optionalInteger(input.confidence, 'memory confidence', { maximum: 100 }); optionalEnum(input.sensitivity, SENSITIVITIES, 'memory sensitivity'); optionalInteger(input.expiresAt, 'memory expiration', { minimum: 1, nullable: true }); return input;
    }
    if (!validKeys(input, ['memoryId', 'content'], ['type', 'subject', 'confidence', 'sensitivity', 'expiresAt'])) throw new Error('Invalid personal_memory_update capability input');
    validId(input.memoryId, 'memoryId'); boundedText(input.content, 'memory content', MAX_CONTENT_BYTES); if (containsSecret(input.content)) throw new Error('Secret-like content cannot be stored in personal memory');
    if (input.type !== undefined) boundedText(input.type, 'memory type', 80); if (input.subject !== undefined) boundedText(input.subject, 'memory subject', 240); optionalInteger(input.confidence, 'memory confidence', { maximum: 100 }); optionalEnum(input.sensitivity, SENSITIVITIES, 'memory sensitivity'); optionalInteger(input.expiresAt, 'memory expiration', { minimum: 1, nullable: true }); return input;
  }
  if (PROJECT_READ_TOOLS.has(toolName)) {
    if (toolName === 'project_list') { if (!validKeys(input, [], ['status'])) throw new Error('Invalid project_list capability input'); optionalEnum(input.status, PROJECT_STATUSES, 'project status'); return input; }
    if (toolName === 'project_next_action') { if (!validKeys(input, [])) throw new Error('Invalid project_next_action capability input'); return input; }
    if (!validKeys(input, ['projectId'])) throw new Error(`Invalid ${toolName} capability input`);
    validId(input.projectId, 'projectId'); return input;
  }
  if (PROJECT_WRITE_TOOLS.has(toolName)) {
    if (toolName === 'project_create') {
      if (!validKeys(input, ['name'], ['description', 'desiredOutcomes', 'currentPhase', 'nextAction', 'preferredAgents', 'autonomyLevel'])) throw new Error('Invalid project_create capability input');
      boundedText(input.name, 'project name', 200); if (input.description !== undefined) boundedText(input.description, 'project description', 4_000, { nullable: true }); optionalStrings(input.desiredOutcomes, 'desiredOutcomes'); if (input.currentPhase !== undefined) boundedText(input.currentPhase, 'current phase', 500, { nullable: true }); if (input.nextAction !== undefined) boundedText(input.nextAction, 'next action', 1_000, { nullable: true }); optionalStrings(input.preferredAgents, 'preferredAgents', 8, 32); optionalEnum(input.autonomyLevel, AUTONOMY_LEVELS, 'autonomy level'); return input;
    }
    if (toolName === 'project_create_goal') {
      if (!validKeys(input, ['projectId', 'name'], ['description', 'desiredOutcome', 'nextAction', 'priority'])) throw new Error('Invalid project_create_goal capability input');
      validId(input.projectId, 'projectId'); boundedText(input.name, 'goal name', 200); if (input.description !== undefined) boundedText(input.description, 'goal description', 4_000, { nullable: true }); if (input.desiredOutcome !== undefined) boundedText(input.desiredOutcome, 'goal desired outcome', 1_000, { nullable: true }); if (input.nextAction !== undefined) boundedText(input.nextAction, 'goal next action', 1_000, { nullable: true }); optionalInteger(input.priority, 'goal priority', { maximum: 100 }); return input;
    }
    if (toolName === 'project_create_mission') {
      if (!validKeys(input, ['goalId', 'name'], ['description', 'acceptanceCriteria', 'nextAction', 'preferredAgents'])) throw new Error('Invalid project_create_mission capability input');
      validId(input.goalId, 'goalId'); boundedText(input.name, 'mission name', 200); if (input.description !== undefined) boundedText(input.description, 'mission description', 4_000, { nullable: true }); optionalStrings(input.acceptanceCriteria, 'acceptanceCriteria', 20, 500); if (input.nextAction !== undefined) boundedText(input.nextAction, 'mission next action', 1_000, { nullable: true }); optionalStrings(input.preferredAgents, 'preferredAgents', 8, 32); return input;
    }
    if (toolName === 'project_set_mission_status') {
      if (!validKeys(input, ['missionId', 'status'], ['nextAction'])) throw new Error('Invalid project_set_mission_status capability input');
      validId(input.missionId, 'missionId'); if (!MISSION_STATUSES.has(input.status)) throw new Error('Invalid mission status'); if (input.nextAction !== undefined) boundedText(input.nextAction, 'mission next action', 1_000, { nullable: true }); return input;
    }
    if (!validKeys(input, ['projectId'])) throw new Error('Invalid project_archive capability input');
    validId(input.projectId, 'projectId'); return input;
  }
  return input;
}

function canonicalWriteTarget(workspacePath, supplied, { allowMissing = true } = {}) {
  if (typeof supplied !== 'string' || !supplied || supplied.includes('\0') || supplied.startsWith('~')) throw new Error('Invalid file path');
  const workspace = fs.realpathSync(workspacePath);
  const target = path.resolve(workspace, supplied);
  if (!contained(workspace, target) || target === workspace) throw new Error('Path is outside the task workspace');

  const relative = path.relative(workspace, target);
  const components = relative.split(path.sep);
  let cursor = workspace;
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    const isFinal = index === components.length - 1;
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!isFinal || !allowMissing) throw new Error('Parent path does not exist');
      break;
    }
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not writable capabilities');
    if (!isFinal && !stat.isDirectory()) throw new Error('Parent path is not a directory');
    if (isFinal && !stat.isFile()) throw new Error('Only regular files may be written');
    if (isFinal && fs.realpathSync(cursor) !== cursor) throw new Error('Target path is not canonical');
  }
  const parent = fs.realpathSync(path.dirname(target));
  if (!contained(workspace, parent) || parent !== path.dirname(target)) throw new Error('Parent path is not canonical within the workspace');
  return target;
}

function writeRegularFile(workspace, suppliedPath, content) {
  const target = canonicalWriteTarget(workspace, suppliedPath);
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw new Error('File content exceeds the broker write limit');
  let before = null;
  try { before = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (before && (!before.isFile() || before.isSymbolicLink())) throw new Error('Only regular files may be written');

  const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW |
    (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = fs.openSync(target, flags, 0o600);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || (before && (opened.dev !== before.dev || opened.ino !== before.ino))) throw new Error('Target changed during broker authorization');
    fs.ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return { path: path.relative(fs.realpathSync(workspace), target), bytes: bytes.length, sha256: hash(bytes) };
}

function readRegularFile(workspace, suppliedPath) {
  const target = canonicalWriteTarget(workspace, suppliedPath, { allowMissing: false });
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('File exceeds the broker edit limit');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

function applyEdits(original, edits) {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_EDITS ||
      edits.some(edit => !exactKeys(edit, ['oldText', 'newText']) || typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string')) {
    throw new Error('Edit must contain 1 to 32 exact oldText/newText replacements');
  }
  const ranges = edits.map(edit => {
    const first = original.indexOf(edit.oldText);
    if (first < 0 || original.indexOf(edit.oldText, first + edit.oldText.length) >= 0) throw new Error('Each oldText must match exactly once');
    return { start: first, end: first + edit.oldText.length, replacement: edit.newText };
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) if (ranges[index].start < ranges[index - 1].end) throw new Error('Edit replacements may not overlap');
  let result = '', cursor = 0;
  for (const range of ranges) {
    result += original.slice(cursor, range.start) + range.replacement;
    cursor = range.end;
  }
  result += original.slice(cursor);
  if (Buffer.byteLength(result) > MAX_FILE_BYTES) throw new Error('Edited file exceeds the broker write limit');
  return result;
}

function validateToolInput(toolName, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Capability input must be an object');
  if (WORKER_READ_TOOLS.has(toolName) || WORKER_WRITE_TOOLS.has(toolName)) return validateWorkerToolInput(toolName, input);
  const rules = {
    read: [['path'], ['offset', 'limit']], ls: [[], ['path']], find: [[], ['path', 'pattern', 'type', 'maxDepth']],
    grep: [['pattern'], ['path', 'offset', 'limit']], write: [['path', 'content'], []], edit: [['path', 'edits'], []],
    run_job: [['jobName'], ['target']], mission_checkpoint: [['checkpoint'], []], memory_search: [['query'], []],
    web_fetch: [['url'], ['method']], chatgpt_notify: [['session_id', 'request_id', 'event'], []],
    capability: [['name'], ['input']]
  }[toolName];
  if (!rules || !exactKeys(input, rules[0], rules[1])) throw new Error(`Invalid ${toolName} capability input`);
  if (['read', 'ls', 'find', 'grep', 'write', 'edit'].includes(toolName) && input.path !== undefined && (typeof input.path !== 'string' || !input.path || input.path.length > 4096)) throw new Error('Invalid file path');
  if (['read', 'grep'].includes(toolName)) for (const key of ['offset', 'limit']) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > 2000)) throw new Error(`Invalid ${key}`);
  if (toolName === 'grep' && (typeof input.pattern !== 'string' || !input.pattern || input.pattern.length > 1000)) throw new Error('Invalid literal search pattern');
  if (toolName === 'find' && input.pattern !== undefined && (typeof input.pattern !== 'string' || input.pattern.length > 200)) throw new Error('Invalid find pattern');
  if (toolName === 'write' && (typeof input.content !== 'string' || Buffer.byteLength(input.content) > MAX_FILE_BYTES)) throw new Error('Invalid or oversized file content');
  if (toolName === 'edit' && (!Array.isArray(input.edits) || input.edits.length > MAX_EDITS)) throw new Error('Invalid edit list');
  if (toolName === 'run_job' && (typeof input.jobName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.jobName))) throw new Error('Invalid approved job name');
  if (toolName === 'run_job' && BRIDGE_MAINTENANCE_JOBS.has(input.jobName)) {
    if (!exactKeys(input, ['jobName'])) throw new Error('Bridge maintenance jobs accept only jobName');
    return input;
  }
  if (toolName === 'run_job' && input.target !== undefined && (typeof input.target !== 'string' || !input.target || input.target.length > 4096)) throw new Error('Invalid trusted development test target');
  if (toolName === 'memory_search' && (typeof input.query !== 'string' || input.query.length > 4000)) throw new Error('Invalid memory query');
  if (toolName === 'web_fetch' && (typeof input.url !== 'string' || input.url.length > 2048 || (input.method !== undefined && !['GET', 'HEAD'].includes(input.method)))) throw new Error('Invalid web request');
  if (toolName === 'capability') {
    if (typeof input.name !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(input.name)) throw new Error('Invalid capability name');
    if (input.input !== undefined && (!input.input || typeof input.input !== 'object' || Array.isArray(input.input))) throw new Error('Invalid capability input');
    return { name: input.name, input: input.input || {} };
  }
  return input;
}

function classifyValidationError(toolName, input, message) {
  const text = String(message || '');
  const provided = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).filter(key => typeof key === 'string').slice(0, 32) : [];
  let errorClass = 'schema_mismatch';
  if (/must be an object|JSON|parse|SyntaxError/i.test(text)) errorClass = 'syntactically_invalid';
  else if (/unknown|not in the broker|is unavailable/i.test(text)) errorClass = 'unknown_tool';
  else if (/required|missing|Invalid \w+ capability input/i.test(text)) errorClass = 'missing_or_extra_field';
  else if (/Invalid (?:file path|literal|find|approved job|memory|web|edit|trusted)/i.test(text)) errorClass = 'field_value_invalid';
  else if (/Secret-like/i.test(text)) errorClass = 'secret_content_denied';
  return {
    validation_error_class: errorClass,
    tool_name: typeof toolName === 'string' ? toolName : null,
    // Field names only — never argument values.
    invalid_field_names: provided,
    native_call_present: true
  };
}

// Safe capability metadata for broker audit and the Event Ledger; never payloads.
function capabilityAuditFields(prepared, { durationMs = null, resultClass = null } = {}) {
  if (!prepared?.assessment) return {};
  const assessment = prepared.assessment;
  return {
    capability: prepared.name, capability_group: assessment.group || null, capability_scope: assessment.scope || null,
    capability_policy_version: assessment.policy_version, capability_decision: assessment.decision, capability_automatic: assessment.decision === 'auto_allow',
    risk_class: assessment.risk_class || null, ...(durationMs !== null ? { duration_ms: durationMs } : {}), ...(resultClass ? { result_class: resultClass } : {})
  };
}

function auditInput(toolName, input) {
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (WORKER_READ_TOOLS.has(toolName) || WORKER_WRITE_TOOLS.has(toolName)) {
    const audit = {};
    for (const [key, value] of Object.entries(input)) {
      if (/^(?:memoryId|projectId|goalId|missionId|domain|status|sensitivity|confidence|expiresAt|priority|autonomyLevel)$/u.test(key)) audit[key] = value;
      else if (Array.isArray(value)) Object.assign(audit, { [`${key}Count`]: value.length, [`${key}Sha256`]: hash(JSON.stringify(value)) });
      else if (typeof value === 'string') Object.assign(audit, { [`${key}Bytes`]: Buffer.byteLength(value), [`${key}Sha256`]: hash(value) });
    }
    return audit;
  }
  if (FILE_TOOLS.has(toolName)) {
    const result = { ...(input.path ? { path: input.path } : {}) };
    if (toolName === 'write') {
      const content = typeof input.content === 'string' ? input.content : '';
      Object.assign(result, { contentBytes: Buffer.byteLength(content), contentSha256: hash(content) });
    }
    if (toolName === 'edit') result.edits = Array.isArray(input.edits) ? input.edits.slice(0, MAX_EDITS).map(edit => {
      const oldText = typeof edit?.oldText === 'string' ? edit.oldText : '', newText = typeof edit?.newText === 'string' ? edit.newText : '';
      return { oldTextBytes: Buffer.byteLength(oldText), oldTextSha256: hash(oldText), newTextBytes: Buffer.byteLength(newText), newTextSha256: hash(newText) };
    }) : { invalid: true };
    if (toolName === 'grep') {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      Object.assign(result, { patternBytes: Buffer.byteLength(pattern), patternSha256: hash(pattern) });
    }
    return result;
  }
  if (toolName === 'mission_checkpoint') { const checkpoint = JSON.stringify(input.checkpoint) || ''; return { checkpointSha256: hash(checkpoint), checkpointBytes: Buffer.byteLength(checkpoint) }; }
  if (toolName === 'memory_search') { const query = typeof input.query === 'string' ? input.query : ''; return { queryBytes: Buffer.byteLength(query), querySha256: hash(query) }; }
  if (toolName === 'chatgpt_notify') return { eventType: input.event?.event_type, eventId: input.event?.event_id, summaryBytes: Buffer.byteLength(typeof input.event?.summary === 'string' ? input.event.summary : '') };
  if (toolName === 'run_job') return { jobName: input.jobName };
  if (toolName === 'capability') return require('./capability-host').auditCapabilityInput(input.name, input.input);
  if (toolName === 'web_fetch') return { host: (() => { try { return new URL(input.url).hostname; } catch { return null; } })(), method: input.method || 'GET' };
  return {};
}

class CapabilityBroker extends EventEmitter {
  constructor({
    policy, diagnostics, getTask, onAuthorized = () => {}, onCompleted = () => {},
    checkpoint, memorySearch, personalMemoryOperation, projectOperation, webFetch,
    networkEnabled = () => false, eventAllowed = () => false, publishEvent, runner,
    trustedRunner = null, trustedDeveloperAllowed = () => false, now = () => Date.now(),
    repoRoot = null, runtimeDir = null, bridgeRestart = null, capabilityHost = null
  } = {}) {
    super();
    if (!policy || !diagnostics || typeof getTask !== 'function') throw new Error('Capability broker requires host policy, diagnostics, and task lookup');
    this.policy = policy; this.diagnostics = diagnostics; this.getTask = getTask; this.onAuthorized = onAuthorized; this.onCompleted = onCompleted;
    this.checkpoint = checkpoint; this.memorySearch = memorySearch; this.personalMemoryOperation = personalMemoryOperation; this.projectOperation = projectOperation; this.webFetch = webFetch; this.networkEnabled = networkEnabled; this.eventAllowed = eventAllowed; this.publishEvent = publishEvent; this.runner = runner;
    this.trustedRunner = trustedRunner; this.trustedDeveloperAllowed = trustedDeveloperAllowed; this.now = now;
    this.repoRoot = repoRoot; this.runtimeDir = runtimeDir; this.bridgeRestart = bridgeRestart || {
      requestRestart, statusRestart, describeMaintenanceJob
    };
    this.capabilityHost = capabilityHost;
    this.audit = []; this.writeQueues = new Map(); this.jobQueue = Promise.resolve();
  }

  _record(taskId, request, decision, execution = 'NOT EXECUTED', details = {}) {
    const task = this.policy.tasks.get(taskId);
    const record = {
      timestamp: new Date(this.now()).toISOString(), taskId, sessionId: task?.sessionId || null,
      toolName: typeof request?.toolName === 'string' ? request.toolName : null,
      toolCallId: typeof request?.toolCallId === 'string' ? request.toolCallId : null,
      parentToolCallId: toolCallEvidence(request?.toolCallId).parent_tool_call_id,
      decision, executionStatus: execution, ...details
    };
    this.audit.push(record);
    if (this.audit.length > 1000) this.audit.shift();
    this.emit('audit', structuredClone(record));
    return record;
  }

  _deny(taskId, request, reason, kind = 'safety_denial', extra = {}) {
    const decision = this.policy.deny(taskId, { toolName: request?.toolName, toolCallId: request?.toolCallId, input: auditInput(request?.toolName, request?.input || {}) }, { reason, kind });
    if (['safety_denial', 'mission_grant_denied'].includes(kind) && this.policy.tasks.has(taskId) && !this.policy.safetyStops.has(taskId)) {
      this.policy.latchSafetyStop(taskId, reason, { taskId, sessionId: this.policy.tasks.get(taskId).sessionId, toolName: request?.toolName || null, toolCallId: request?.toolCallId || null, kind, at: this.now() });
    }
    this._record(taskId, request, 'deny', 'NOT EXECUTED', { kind, reason: String(reason).slice(0, 500), ...extra });
    return { allow: false, decision: { ...decision, ...extra } };
  }

  async execute(taskId, request, { signal } = {}) {
    if (!exactKeys(request, ['toolName', 'input'], ['toolCallId']) || !BROKER_TOOLS.has(request.toolName) ||
        (request.toolCallId !== undefined && (typeof request.toolCallId !== 'string' || request.toolCallId.length > 200))) return this._deny(taskId, request, 'Request is not in the broker capability schema');
    let input;
    try { input = validateToolInput(request.toolName, request.input); }
    catch (error) {
      const diagnostics = classifyValidationError(request.toolName, request.input, error.message);
      return this._deny(taskId, request, error.message, 'invalid_tool_arguments', diagnostics);
    }
    const task = this.getTask(taskId);
    if (!task || !this.policy.tasks.has(taskId)) return this._deny(taskId, request, 'Unknown or revoked task', 'unknown_task');
    if (removed(task)) return this._deny(taskId, request, 'Historical runtime removed; capabilities and context delivery are denied', 'runtime_removed');
    if (task.reasoningMode === 'reasoning_only') return this._deny(taskId, request, 'Reasoning admission grants no execution authority', 'reasoning_execution_denied');
    if (task.mission?.level === 1 || task.mission?.capabilityProfile === LEVEL1_PROFILE_ID) {
      if (!assertReadOnlyMission(task.mission) || task.workspace !== WORKSPACE || request.toolName !== 'read' || !exactKeys(input, ['path'])) return this._deny(taskId, request, 'Level 1 exposes only one exact brokered fixture read path', 'mission_grant_denied');
      try {
        const target = canonicalWriteTarget(task.workspace, input.path, { allowMissing: false });
        const relative = path.relative(fs.realpathSync(task.workspace), target).split(path.sep).join('/');
        if (input.path !== relative || !task.mission.readOnlyPaths.includes(relative)) return this._deny(taskId, request, 'Level 1 read path is outside this task phase allowlist', 'mission_grant_denied');
        input = { path: relative };
      } catch (error) { return this._deny(taskId, request, `Level 1 read path rejected: ${error.message}`, 'mission_grant_denied'); }
    }
    if (task.mission?.capabilityProfile === ACTIVE_CHAT_PROFILE_ID) {
      try { assertActiveChatMission(task.mission); }
      catch (error) { return this._deny(taskId, request, `Active Chat mission rejected: ${error.message}`, 'mission_grant_denied'); }
      if (request.toolName !== 'read' || !exactKeys(input, ['path'])) return this._deny(taskId, request, 'Active Chat exposes only one exact brokered fixture read', 'mission_grant_denied');
      try {
        const target = canonicalWriteTarget(task.workspace, input.path, { allowMissing: false });
        const relative = path.relative(fs.realpathSync(task.workspace), target).split(path.sep).join('/');
        const allowed = task.activeChat?.phase === 'task_a_running' ? ACTIVE_CHAT_READ_ONLY_PATHS[0] : task.activeChat?.phase === 'task_b_running' ? ACTIVE_CHAT_READ_ONLY_PATHS[1] : null;
        if (input.path !== relative || relative !== allowed) return this._deny(taskId, request, 'Active Chat read path is outside the current task phase allowlist', 'mission_grant_denied');
        const phase = task.activeChat?.phase === 'task_a_running' ? 'task_a' : 'task_b';
        if (task.activeChat?.readEvidence?.[phase]) return this._deny(taskId, request, 'Active Chat fixture read was already completed for this task phase', 'mission_grant_denied');
        input = { path: relative };
      } catch (error) { return this._deny(taskId, request, `Active Chat read path rejected: ${error.message}`, 'mission_grant_denied'); }
    }
    if (request.toolName === 'web_fetch' && (!this.networkEnabled(task, input) || typeof this.webFetch !== 'function')) return this._deny(taskId, request, 'Network capability is disabled by default or absent from this mission policy');
    if (task.cancelRequested || task.status === 'cancelled' || task.mission?.status === 'cancelled') return this._deny(taskId, request, 'Cancelled missions cannot use broker capabilities');
    if (request.toolName === 'chatgpt_notify' && !this.eventAllowed(task, input)) return this._deny(taskId, request, 'Event publication is unavailable outside an active, correlated MCP task');
    if (task.continuationRequired && request.toolName !== 'mission_checkpoint') {
      const decision = this.policy.deny(taskId, { toolName: request.toolName, toolCallId: request.toolCallId, auditInput: auditInput(request.toolName, input) }, { reason: 'Fresh continuation required; save a checkpoint and end this session', kind: 'context_pressure' });
      this._record(taskId, request, 'deny', 'NOT EXECUTED', { kind: 'context_pressure', reason: decision.reason });
      return { allow: false, decision };
    }
    if (task.mission?.used && task.mission?.budget && task.mission.used.actions >= task.mission.budget.maxActions) return this._deny(taskId, request, 'Cumulative mission action budget exhausted', 'mission_grant_denied');

    let policyTool = request.toolName;
    let policyInput = input;
    let describedJob = null;
    if (request.toolName === 'run_job') {
      const trustedAllowed = this.trustedDeveloperAllowed(task, input) === true;
      if (BRIDGE_MAINTENANCE_JOBS.has(input.jobName)) {
        if (!exactKeys(input, ['jobName'])) return this._deny(taskId, request, 'Bridge maintenance jobs accept only jobName', 'invalid_tool_arguments');
        if (task.mission?.requireGrant === true) {
          return this._deny(taskId, request, 'Bridge restart is unavailable under mission grants', 'mission_grant_denied');
        }
        try {
          describedJob = this.bridgeRestart.describeMaintenanceJob(input.jobName);
          if (!describedJob || describedJob.kind !== BRIDGE_MAINTENANCE_KIND) throw new Error('Bridge maintenance job description is invalid');
          policyTool = BRIDGE_MAINTENANCE_KIND;
          policyInput = { jobName: input.jobName };
        } catch (error) {
          return this._deny(taskId, request, error.message, 'invalid_tool_arguments');
        }
      } else if (trustedAllowed && this.trustedRunner && TRUSTED_DEV_BROKER_JOBS.has(input.jobName)) {
        try {
          describedJob = this.trustedRunner.describe(task, input);
          if (!describedJob || describedJob.kind !== 'trusted-development') throw new Error('Trusted development job description is invalid');
          policyTool = 'trusted-development';
          policyInput = { jobName: input.jobName };
        } catch (error) {
          return this._deny(taskId, request, error.message, 'invalid_tool_arguments');
        }
      } else {
        if (!exactKeys(input, ['jobName'])) return this._deny(taskId, request, 'Pinned jobs accept only jobName', 'invalid_tool_arguments');
        if (!this.runner || typeof this.runner.describeJob !== 'function') return this._deny(taskId, request, 'Pinned job runner is unavailable');
        try {
          describedJob = this.runner.describeJob(input.jobName);
          if (!describedJob || !['test', 'build'].includes(describedJob.kind)) throw new Error('Approved job is not a pinned test or build');
          policyTool = describedJob.kind;
          policyInput = { jobName: input.jobName };
        } catch (error) {
          if (trustedAllowed && /Sandbox job is not approved/.test(error.message)) {
            return this._deny(taskId, request, `Trusted development job is not approved: ${input.jobName}`, 'invalid_tool_arguments');
          }
          return this._deny(taskId, request, `Pinned job verification failed: ${error.message}`);
        }
      }
    }
    let prepared = null;
    if (request.toolName === 'capability') {
      if (!this.capabilityHost) return this._deny(taskId, request, 'Capability host is unavailable', 'capability_denied');
      try { prepared = await this.capabilityHost.prepare(task, input.name, input.input); }
      catch (error) {
        const diagnostics = classifyValidationError(`capability:${input.name}`, input.input, error.message);
        return this._deny(taskId, request, String(error.message || error).slice(0, 500), error?.constructor?.name === 'CapabilityInputError' ? 'invalid_tool_arguments' : 'capability_denied', error?.constructor?.name === 'CapabilityInputError' ? diagnostics : {});
      }
      policyInput = { name: prepared.name, input: prepared.input };
    }
    const check = this.policy.check(taskId, {
      toolName: policyTool, input: policyInput, toolCallId: request.toolCallId,
      auditInput: auditInput(request.toolName, request.toolName === 'capability' ? policyInput : input),
      ...(prepared ? { capabilityAssessment: prepared.assessment } : {})
    }, { brokered: true });
    if (!check.allow) {
      if (['safety_denial', 'mission_grant_denied'].includes(check.kind) && !this.policy.safetyStops.has(taskId)) this.policy.latchSafetyStop(taskId, check.reason, { taskId, sessionId: task.sessionId, toolName: request.toolName, toolCallId: request.toolCallId || null, kind: check.kind, at: this.now() });
      this._record(taskId, request, 'deny', 'NOT EXECUTED', { kind: check.kind || 'approval_required', reason: check.reason, ...(check.approvalId ? { approvalId: check.approvalId } : {}), ...capabilityAuditFields(prepared) });
      return { allow: false, decision: check };
    }

    this.onAuthorized(task, request.toolName, { request: { ...request, input }, describedJob, prepared });
    const started = this.now();
    try {
      const output = await this._perform(task, request.toolName, input, { signal, describedJob, prepared });
      try { this.onCompleted(task, request.toolName, output, { ...request, input, describedJob }); }
      catch (error) {
        if (task.mission?.capabilityProfile === ACTIVE_CHAT_PROFILE_ID && request.toolName === 'read') return this._deny(taskId, request, `Active Chat broker evidence rejected: ${error.message}`, 'mission_grant_denied');
        throw error;
      }
      this._record(taskId, request, 'allow', 'COMPLETED', {
        outputBytes: Buffer.byteLength(output),
        outputSha256: hash(output),
        ...capabilityAuditFields(prepared, { durationMs: this.now() - started, resultClass: 'completed' }),
        ...(check.policy_version ? {
          policy_version: check.policy_version,
          policy_decision: check.policy_decision,
          policy_automatic: check.policy_automatic === true,
          automatic: check.automatic === true
        } : {})
      });
      return { allow: true, output, decision: check };
    } catch (error) {
      const reason = String(error?.message || error).slice(0, 500);
      if (request.toolName === 'run_job' && BRIDGE_MAINTENANCE_JOBS.has(input.jobName) &&
          ['BRIDGE_RESTART_CONCURRENT', 'BRIDGE_RESTART_COOLDOWN', 'BRIDGE_RESTART_INVALID'].includes(error.code)) {
        return this._deny(taskId, request, reason, 'invalid_tool_arguments');
      }
      if (request.toolName === 'run_job' && /sandbox_apply|operation not permitted|sandbox-exec|sandbox verification failed|pinned|hash mismatch|executable verification failed|manifest/i.test(reason)) {
        const denial = this.policy.deny(taskId, { toolName: policyTool, toolCallId: request.toolCallId, input: policyInput }, { kind: 'safety_denial', reason: `Pinned runner failed closed: ${reason}` });
        if (!this.policy.safetyStops.has(taskId)) this.policy.latchSafetyStop(taskId, denial.reason, { taskId, sessionId: task.sessionId, toolName: request.toolName, toolCallId: request.toolCallId || null, kind: 'safety_denial', at: this.now() });
        this._record(taskId, request, 'deny', 'NOT EXECUTED', { kind: 'safety_denial', reason: denial.reason });
        return { allow: false, decision: denial };
      }
      this._record(taskId, request, 'allow', 'FAILED', { reason, ...capabilityAuditFields(prepared, { durationMs: this.now() - started, resultClass: 'failed' }) });
      return { allow: false, executionFailed: true, decision: { allow: false, kind: 'execution_failed', reason } };
    }
  }

  async _perform(task, toolName, input, { signal, describedJob, prepared } = {}) {
    if (toolName === 'capability') {
      if (!this.capabilityHost || !prepared) throw new Error('Capability host is unavailable');
      return JSON.stringify(await this.capabilityHost.perform(task, prepared, {signal}));
    }
    if (['read', 'ls', 'find', 'grep'].includes(toolName)) {
      return this.diagnostics.read(task, { ...input, op: toolName === 'read' ? 'cat' : toolName });
    }
    if (toolName === 'write') return JSON.stringify(await this._serializeWrite(task.id, () => writeRegularFile(task.workspace, input.path, input.content)));
    if (toolName === 'edit') return JSON.stringify(await this._serializeWrite(task.id, () => {
      const original = readRegularFile(task.workspace, input.path);
      return writeRegularFile(task.workspace, input.path, applyEdits(original, input.edits));
    }));
    if (toolName === 'mission_checkpoint') {
      if (typeof this.checkpoint !== 'function') throw new Error('Checkpoint capability is unavailable');
      return JSON.stringify(await this.checkpoint(task, input));
    }
    if (toolName === 'memory_search') {
      if (typeof this.memorySearch !== 'function') throw new Error('Memory search capability is unavailable');
      return JSON.stringify(await this.memorySearch(task, input));
    }
    if (PERSONAL_MEMORY_READ_TOOLS.has(toolName) || PERSONAL_MEMORY_WRITE_TOOLS.has(toolName)) {
      if (typeof this.personalMemoryOperation !== 'function') throw new Error('Personal memory capability is unavailable');
      return JSON.stringify(await this.personalMemoryOperation(task, toolName, input));
    }
    if (PROJECT_READ_TOOLS.has(toolName) || PROJECT_WRITE_TOOLS.has(toolName)) {
      if (typeof this.projectOperation !== 'function') throw new Error('Project capability is unavailable');
      return JSON.stringify(await this.projectOperation(task, toolName, input));
    }
    if (toolName === 'web_fetch') {
      if (typeof this.webFetch !== 'function') throw new Error('Network capability is disabled by default');
      return JSON.stringify(await this.webFetch(task, input, signal));
    }
    if (toolName === 'chatgpt_notify') {
      if (task.mission?.requireGrant) throw new Error('Outbound event publication is outside the local-only mission grant');
      if (typeof this.publishEvent !== 'function') throw new Error('Event publication capability is unavailable');
      return JSON.stringify(await this.publishEvent(task, input));
    }
    if (toolName === 'run_job') {
      if (!describedJob) throw new Error('Job runner is unavailable');
      if (describedJob.kind === BRIDGE_MAINTENANCE_KIND) {
        if (!this.runtimeDir || !this.repoRoot) throw new Error('Bridge restart runtime is unavailable');
        if (input.jobName === BRIDGE_RESTART_STATUS_JOB) {
          const status = this.bridgeRestart.statusRestart(this.runtimeDir, { now: this.now() });
          return JSON.stringify({ name: BRIDGE_RESTART_STATUS_JOB, kind: BRIDGE_MAINTENANCE_KIND, ...status });
        }
        if (input.jobName !== BRIDGE_RESTART_JOB) throw new Error('Unknown bridge maintenance job');
        try {
          const receipt = this.bridgeRestart.requestRestart({
            runtimeDir: this.runtimeDir,
            repoRoot: this.repoRoot,
            now: this.now()
          });
          return JSON.stringify({
            name: BRIDGE_RESTART_JOB,
            kind: BRIDGE_MAINTENANCE_KIND,
            exitCode: 0,
            signal: null,
            timedOut: false,
            ...receipt
          });
        } catch (error) {
          if (error?.code === 'BRIDGE_RESTART_CONCURRENT') {
            const denial = new Error(error.message);
            denial.code = error.code;
            denial.kind = 'invalid_tool_arguments';
            throw denial;
          }
          if (error?.code === 'BRIDGE_RESTART_COOLDOWN') {
            const denial = new Error(error.message);
            denial.code = error.code;
            denial.kind = 'invalid_tool_arguments';
            throw denial;
          }
          throw error;
        }
      }
      if (describedJob.kind === 'trusted-development') {
        if (!this.trustedRunner) throw new Error('Trusted development runner is unavailable');
        const result = await this._serializeJob(() => this.trustedRunner.run(task, input, { signal }));
        return JSON.stringify({ name: result.name, kind: result.kind, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, output: result.output.slice(0, 48_000), outputTruncated: result.output.length > 48_000 });
      }
      if (!this.runner) throw new Error('Pinned job runner is unavailable');
      const result = await this._serializeJob(() => this.runner.run(input.jobName, { expectedManifestSha256: describedJob.manifestSha256 }));
      return JSON.stringify({ name: result.name, kind: result.kind, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, inputHashes: result.inputHashes, output: result.output.slice(0, 48_000), outputTruncated: result.output.length > 48_000 });
    }
    throw new Error('Capability is unavailable');
  }

  _serializeWrite(taskId, operation) {
    const previous = this.writeQueues.get(taskId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.writeQueues.set(taskId, current);
    return current.finally(() => { if (this.writeQueues.get(taskId) === current) this.writeQueues.delete(taskId); });
  }

  _serializeJob(operation) {
    const current = this.jobQueue.catch(() => {}).then(operation);
    this.jobQueue = current;
    return current;
  }
}

module.exports = { toolCallEvidence, CapabilityBroker, BROKER_TOOLS, MAX_FILE_BYTES, canonicalWriteTarget, writeRegularFile, applyEdits, validateToolInput, validateWorkerToolInput, auditInput, classifyValidationError, PERSONAL_MEMORY_READ_TOOLS, PERSONAL_MEMORY_WRITE_TOOLS, PROJECT_READ_TOOLS, PROJECT_WRITE_TOOLS, WORKER_READ_TOOLS, WORKER_WRITE_TOOLS, BRIDGE_RESTART_JOB, BRIDGE_RESTART_STATUS_JOB, BRIDGE_MAINTENANCE_JOBS };
