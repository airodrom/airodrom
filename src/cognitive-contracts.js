'use strict';
// ADR 0057. Data contracts only; parsing or possessing a hash confers no authority.
const { canonicalHash, validateJson } = require('./authority-hash');
const { safePath } = require('./repository-verification');
const VERSION = 1;
const schemas = Object.freeze({
  RequestEnvelope: ['version', 'request_id', 'caller', 'delegation', 'repository_id', 'workspace_id', 'git_anchor', 'integrity', 'permitted_paths', 'denied_paths', 'operations', 'eligible_workers', 'verification', 'limits', 'requested_worker', 'instruction_hash', 'expires_at', 'hash'],
  PlanningProposal: ['version', 'request_id', 'envelope_hash', 'files', 'tasks', 'verification', 'complexity'],
  SealedMissionContract: ['version', 'request_id', 'envelope_hash', 'proposal_hash', 'repository_id', 'workspace_id', 'git_anchor', 'integrity_hash', 'paths', 'worker', 'verification', 'authorization', 'limits', 'mission_scope_hash', 'hash'],
  MissionEvidence: ['version', 'mission_id', 'run_ids', 'envelope_hash', 'contract_hash', 'worker', 'changes', 'verification', 'termination', 'leases', 'accounting', 'acceptance', 'state', 'errors', 'references', 'counts'],
});
function fail(code) { const e = Error(code); e.code = code; throw e; }
function object(value, keys, required = keys) {
  validateJson(value);
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('cognitive_schema_invalid');
  return value;
}
function string(v, max = 300) { if (typeof v !== 'string' || !v || v.length > max) fail('cognitive_string_invalid'); return v; }
function integer(v, min, max) { if (!Number.isSafeInteger(v) || v < min || v > max) fail('cognitive_limit_invalid'); return v; }
function list(v, fn = string, max = 40, min = 1) {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail('cognitive_list_invalid');
  v.forEach(x => fn(x));
  if (new Set(v.map(x => canonicalHash(x))).size !== v.length) fail('cognitive_duplicate');
  return v;
}
function digest(v) { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('cognitive_hash_invalid'); return v; }
function choice(v, values) { if (!values.includes(v)) fail('cognitive_enum_invalid'); return v; }
function relative(v) { safePath(v); if (/[:*?\[\]{}]/.test(v)) fail('cognitive_path_invalid'); return v; }
function limits(v, version = 1) {
  object(v, ['planning_attempts', 'execution_attempts', 'repair_attempts', 'planning_ms', 'execution_ms']);
  integer(v.planning_attempts, 1, 2); integer(v.execution_attempts, 1, version === 3 ? 3 : 1); integer(v.repair_attempts, 0, version >= 2 ? 2 : 0);
  integer(v.planning_ms, 1000, 120000); integer(v.execution_ms, 1000, 120000);
}
function integrity(v) {
  object(v, ['version', 'hash', 'entries', 'bytes', 'exclusions']);
  if (v.version !== 1) fail('cognitive_version_unsupported');
  digest(v.hash); integer(v.entries, 0, 10000); integer(v.bytes, 0, 8 * 1024 ** 3); string(v.exclusions);
}
function hashObject(value) { const { hash, ...body } = value; return canonicalHash(body); }
function checkHash(value) { digest(value.hash); if (hashObject(value) !== value.hash) fail('cognitive_hash_mismatch'); }
function seal(value) { return { ...value, hash: hashObject(value) }; }
function parse(kind, data) {
  if (typeof data === 'string') {
    if (Buffer.byteLength(data) > 64000) fail('cognitive_proposal_too_large');
    try { data = require('./authority-json').parseAuthorityJSON(data); } catch { fail('cognitive_json_required'); }
  }
  if (!schemas[kind]) fail('cognitive_contract_unknown');
  object(data, schemas[kind]);
  if (![1, 2, 3].includes(data.version)) fail('cognitive_version_unsupported');
  if (kind === 'RequestEnvelope') {
    string(data.request_id); string(data.caller); object(data.delegation, ['policy_id', 'policy_hash']);
    string(data.delegation.policy_id); digest(data.delegation.policy_hash); string(data.repository_id); string(data.workspace_id);
    if (!/^[a-f0-9]{40}$/.test(data.git_anchor)) fail('cognitive_git_anchor_invalid');
    integrity(data.integrity); list(data.permitted_paths, relative, 8); list(data.denied_paths, string, 80);
    list(data.operations, x => choice(x, ['read', 'edit']), 2); list(data.eligible_workers, x => choice(x, ['host', 'opencode', 'cursor']), 3);
    list(data.verification, string, 5); limits(data.limits, data.version); choice(data.requested_worker, ['auto', 'host', 'opencode', 'cursor']);
    digest(data.instruction_hash); integer(data.expires_at, 1, Number.MAX_SAFE_INTEGER); checkHash(data);
  } else if (kind === 'PlanningProposal') {
    string(data.request_id); digest(data.envelope_hash); list(data.files, relative, 8);
    list(data.verification, string, 5); choice(data.complexity, ['simple', 'bounded', 'complex']);
    list(data.tasks, task => {
      object(task, ['id', 'operation', 'paths', 'description', 'depends_on', ...(data.version === 3 ? ['worker', 'role', 'verification'] : [])]);
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(task.id)) fail('cognitive_task_id_invalid');
      choice(task.operation, ['read', 'edit']); list(task.paths, relative, 8); string(task.description, 600);
      list(task.depends_on, string, 12, 0);
      if (data.version === 3) {
        choice(task.worker, ['opencode', 'cursor', 'codex', 'claude_code']);
        choice(task.role, ['implementation', 'review', 'analysis']);
        list(task.verification, string, 5, 0);
        if (task.role !== 'implementation' && task.operation !== 'read') fail('cognitive_review_read_only');
      }
    }, data.version === 3 ? 3 : 12);
    const tasks = new Map(data.tasks.map(t => [t.id, t]));
    if (tasks.size !== data.tasks.length) fail('cognitive_duplicate_task');
    const visited = new Set(), visiting = new Set();
    const visit = id => {
      if (!tasks.has(id) || visiting.has(id)) fail('cognitive_dependency_invalid');
      if (visited.has(id)) return;
      visiting.add(id); tasks.get(id).depends_on.forEach(visit); visiting.delete(id); visited.add(id);
    };
    data.tasks.forEach(t => visit(t.id));
    // Proposal.files is the work set: the unique union of task.paths.
    // Planners often echo every discovery/context path into files while tasks
    // only touch a legitimate subset (e.g. README.md read→edit). Drop unused
    // context listings and fill any task paths omitted from files. Paths outside
    // permitted_paths still fail later in validateProposal — never broaden auth.
    const used = [...new Set(data.tasks.flatMap(t => t.paths))].sort();
    if (!used.length) fail('cognitive_plan_files_mismatch');
    data.files = used;
  } else if (kind === 'SealedMissionContract') {
    for (const k of ['request_id', 'repository_id', 'workspace_id']) string(data[k]);
    for (const k of ['envelope_hash', 'proposal_hash', 'integrity_hash', 'mission_scope_hash']) digest(data[k]);
    if (!/^[a-f0-9]{40}$/.test(data.git_anchor)) fail('cognitive_git_anchor_invalid');
    list(data.paths, relative, 8); choice(data.worker, ['host', 'opencode', 'cursor']); list(data.verification, string, 5);
    object(data.authorization, ['policy_id', 'policy_hash', 'grant_id']); string(data.authorization.policy_id); digest(data.authorization.policy_hash); string(data.authorization.grant_id);
    limits(data.limits, data.version); checkHash(data);
  } else {
    string(data.mission_id); list(data.run_ids, string, 20, 0); digest(data.envelope_hash); digest(data.contract_hash);
    choice(data.worker, ['host', 'opencode', 'cursor']); list(data.changes, relative, 40, 0);
    object(data.verification, ['id', 'result']); if (data.verification.id !== null) string(data.verification.id);
    choice(data.verification.result, ['passed', 'operator_review', 'failed', 'unavailable', 'pending']);
    choice(data.termination, ['verified', 'unverified', 'not_started']);
    list(data.leases, x => { object(x, ['id', 'state']); string(x.id); string(x.state); }, 40, 0);
    object(data.accounting, ['class', 'observed_cost']); choice(data.accounting.class, ['LOCAL_NO_SPEND', 'UNKNOWN_SUBSCRIPTION']);
    if (data.accounting.observed_cost !== null) fail('cognitive_billing_unobservable');
    choice(data.acceptance, ['accepted', 'pending', 'rework']);
    choice(data.state, ['BLOCKED', 'PLANNING', 'SEALED', 'RUNNING', 'NEEDS_REWORK', 'VERIFIED', 'AWAITING_ACCEPTANCE', 'ACCEPTED', 'CANCELLED']);
    list(data.errors, string, 20, 0); list(data.references, string, 30);
    object(data.counts, ['planning', 'execution', 'repair']);
    integer(data.counts.planning, 0, 2); integer(data.counts.execution, 0, data.version === 3 ? 5 : 1); integer(data.counts.repair, 0, data.version >= 2 ? 2 : 0);
  }
  return JSON.parse(JSON.stringify(data));
}
module.exports = { VERSION, schemas, parse, seal, hashObject, object, string, list, integer, relative, fail };
