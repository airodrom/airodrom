'use strict';
// ADR 0051. One canonical Mission contract stored inside cp_missions.envelope.contract.
// The contract extends the existing envelope; it is not a competing schema. The host
// validates it on create; a worker can never modify it. Unknown fields fail closed.
//
// Two distinct identities live here on purpose (owner correction, 2026-10-12):
//   scope_fingerprint  – immutable hash of permissions/scope/verification/budget/
//                        restrictions/execution. Shared by a Mission and every
//                        corrective Mission inside the same approval.
//   identity           – per-Mission: idempotency_key, repair_of, timestamps.
//                        Never part of the fingerprint.
const path = require('node:path');
const { canonicalHash } = require('./authority-hash');

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

const RISK_CLASSES = Object.freeze({
  low: { max_repair_attempts: 2 },
  normal: { max_repair_attempts: 3 },
  high: { max_repair_attempts: 0 },
  fixture: { max_repair_attempts: 1 },
});
const ABSOLUTE_MAX_REPAIRS = 5;
const WORKERS = Object.freeze(['host', 'opencode', 'cursor', 'claude_code', 'codex']);
const EXTERNAL_WORKERS = Object.freeze(['cursor', 'claude_code', 'codex']);
const EXECUTION_MODES = Object.freeze(['native_plan', 'sandboxed_headless', 'bounded_proposal']);
const SANDBOXES = Object.freeze(['none', 'sandbox-exec']);
const NETWORK_MODES = Object.freeze(['none', 'loopback', 'allowlist']);
const TOOLS = Object.freeze(['read', 'edit', 'write', 'list', 'search', 'test', 'build']);
const GIT_CHECKS = Object.freeze(['diff_check', 'allowed_files_only', 'no_unexpected_files', 'symlink_safety', 'base_commit_unchanged', 'no_git_mutation']);
const SECURITY_CHECKS = Object.freeze(['secret_scan', 'protected_tests_unchanged', 'verifier_inputs_unchanged', 'npm_audit', 'eslint', 'typecheck', 'semgrep', 'gitleaks']);
const GIT_MUTATIONS = Object.freeze(['commit', 'push', 'force_push', 'merge', 'rebase', 'branch_delete', 'tag', 'history_rewrite']);
const DEFAULT_DENIED_PATHS = Object.freeze([
  '.git/**', '.env', '.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/id_rsa*', '**/id_ed25519*',
  '.ssh/**', '**/.ssh/**', '.aws/**', '**/.aws/**', '.config/gcloud/**', '**/Library/Keychains/**', '.airodrom/**', '**/.airodrom/**',
  '.runtime/**', 'node_modules/**', '.vscode/**', 'tests/**', 'test/**', '__tests__/**', '**/*.test.*', '**/*.spec.*',
  'package.json', 'package-lock.json', '.cursor/**', '.opencode/**', '.claude/**',
]);
const DEFAULT_DENIED_TOOLS = Object.freeze(['shell', 'sudo', 'network', 'mcp', 'web_fetch', 'git_push', 'git_merge', 'git_commit', 'process_signal', 'package_install', 'deploy', 'credential_export']);
const KNOWN_PROVIDER_HOSTS = Object.freeze({
  // agentn.global.api5.cursor.sh is the current agent-stream endpoint observed under
  // governed headless runs (2026.09.28); keep agent.api5.cursor.sh for older clients.
  cursor: ['api2.cursor.sh', 'api3.cursor.sh', 'api4.cursor.sh', 'repo42.cursor.sh', 'agent.api5.cursor.sh', 'agentn.global.api5.cursor.sh', 'cursor.com', 'www.cursor.com', 'authenticator.cursor.sh', 'us-asia.gcpp.cursor.sh', 'us-eu.gcpp.cursor.sh', 'us-only.gcpp.cursor.sh', 'marketplace.cursorapi.com'],
  claude_code: ['api.anthropic.com', 'claude.ai', 'console.anthropic.com'],
  codex: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
});

function fail(message) { const error = new Error(message); error.code = 'mission_contract_invalid'; throw error; }
function object(value, keys, label = 'contract') {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid ' + label);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('Unknown ' + label + ' field: ' + key);
  return value;
}
function strings(value, label, { max = 40, maxLength = 300, allowEmpty = true } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v || v.length > maxLength)) fail('Invalid ' + label);
  if (!allowEmpty && !value.length) fail(label + ' required');
  return [...new Set(value)].sort();
}
function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value === undefined || value === null) { if (optional) return null; fail(label + ' required'); }
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('Invalid ' + label);
  return value;
}
function relativePath(value, label) {
  if (typeof value !== 'string' || !value || value.length > 300 || path.isAbsolute(value)) fail('Invalid ' + label + ' path');
  if (value.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) fail('Unsafe ' + label + ' path');
  if (/(^|\/)(\.env|\.ssh|\.aws|\.git|credentials|secrets|id_rsa|id_ed25519)(\/|$|\.)/i.test(value) || /\.(pem|key|p12)$/i.test(value)) fail(label + ' path touches protected material');
  return value;
}
function denied(target, patterns) {
  return patterns.some(pattern => globMatch(pattern, target));
}
function globMatch(pattern, target) {
  const re = new RegExp('^' + pattern.split('**').map(seg => seg.split('*').map(s => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('(?:.*)?') + '$');
  return re.test(target) || (pattern.endsWith('/**') && target === pattern.slice(0, -3));
}

/**
 * Normalize (and validate) a Mission contract. `input` may be partial, absent, or a
 * previously normalized contract (for corrective Missions). Context comes from the
 * host, never from a worker.
 */
function normalizeContract(input, ctx) {
  const c = object(input, ['schema_version', 'identity', 'objective', 'project', 'permissions', 'execution', 'verification', 'budget', 'restrictions', 'audit', 'scope_fingerprint']);
  if (c.schema_version !== undefined && c.schema_version !== SCHEMA_VERSION) fail('Unsupported contract schema_version');
  const {
    request_id, now = Date.now(), workspace, allowed_files, criteria = [], verification = {}, preferred_agent = 'host',
    fallback_agents = [], dispatch_policy = null, objective, project_id, goal_id, base_commit_sha = null, branch = null,
    repair_of = null, operator = false, approval_id = null, expires_at = null, fixture = false,
  } = ctx;
  if (!workspace || !path.isAbsolute(workspace)) fail('Contract requires an absolute workspace');
  if (!Array.isArray(allowed_files) || !allowed_files.length) fail('Contract requires allowed files');
  const files = [...new Set(allowed_files)].sort();

  // identity: per-Mission, never fingerprinted.
  const identityIn = object(c.identity, ['idempotency_key', 'schema_version', 'created_at', 'authorized_at', 'expires_at', 'parent_mission_id', 'repair_of', 'mission_id', 'goal_id', 'plan_id'], 'contract.identity');
  const identity = {
    schema_version: SCHEMA_VERSION,
    idempotency_key: request_id,
    created_at: now,
    authorized_at: approval_id ? (identityIn.authorized_at ?? now) : null,
    expires_at: expires_at ?? identityIn.expires_at ?? (now + DAY_MS),
    parent_mission_id: repair_of,
    repair_of,
    goal_id: goal_id || identityIn.goal_id || null,
    plan_id: identityIn.plan_id || null,
  };
  if (!Number.isSafeInteger(identity.expires_at)) fail('contract_expiry_invalid');
  if (identity.expires_at <= now) fail('contract_expired');
  if (identity.expires_at > now + DAY_MS) fail('contract_expiry_window');

  // objective: human text, not fingerprinted (a corrective Mission restates it).
  const objectiveIn = object(c.objective, ['original_instruction', 'normalized_objective', 'intended_result', 'assumptions'], 'contract.objective');
  const exact = criteria.filter(x => x.type === 'exact_file');
  const objectiveOut = {
    original_instruction: String(objectiveIn.original_instruction ?? objective ?? '').slice(0, 4000),
    normalized_objective: String(objectiveIn.normalized_objective ?? objective ?? '').slice(0, 2000),
    intended_result: String(objectiveIn.intended_result ?? (exact.length ? exact.map(x => x.path + ' has exactly the approved content').join('; ') : 'Registered focused verification passes with no changes outside the approved files')).slice(0, 1000),
    assumptions: strings(objectiveIn.assumptions, 'assumptions', { max: 10, maxLength: 300 }),
  };

  // project
  const projectIn = object(c.project, ['project_id', 'repository', 'workspace', 'base_commit_sha', 'branch_strategy', 'authorized_worktree', 'branch'], 'contract.project');
  if (projectIn.workspace !== undefined && projectIn.workspace !== workspace) fail('Contract workspace mismatch');
  if (projectIn.base_commit_sha !== undefined && base_commit_sha && projectIn.base_commit_sha !== base_commit_sha) fail('Contract base commit mismatch');
  const project = {
    project_id: project_id || projectIn.project_id || null,
    repository: path.basename(workspace),
    workspace,
    base_commit_sha: base_commit_sha || projectIn.base_commit_sha || null,
    branch: branch || projectIn.branch || null,
    branch_strategy: projectIn.branch_strategy ?? 'working_tree_only_no_commits',
    authorized_worktree: workspace,
  };
  if (!['working_tree_only_no_commits', 'feature_branch_no_push', 'isolated_worktree_no_push'].includes(project.branch_strategy)) fail('Unknown branch strategy');

  // permissions: deny by default.
  const permIn = object(c.permissions, ['allowed_read_paths', 'allowed_write_paths', 'denied_paths', 'allowed_tools', 'denied_tools', 'network', 'external_providers', 'vault_access', 'external_disclosure', 'personal_memory'], 'contract.permissions');
  const write = strings(permIn.allowed_write_paths ?? files, 'allowed_write_paths', { max: 40 });
  for (const p of write) { relativePath(p, 'allowed_write'); if (!files.includes(p)) fail('allowed_write_paths must stay within allowed files'); }
  const read = strings(permIn.allowed_read_paths ?? files, 'allowed_read_paths', { max: 80 });
  for (const p of read) relativePath(p, 'allowed_read');
  const extraDenied = strings(permIn.denied_paths, 'denied_paths', { max: 80 });
  const deniedPaths = [...new Set([...DEFAULT_DENIED_PATHS, ...extraDenied])].sort();
  for (const p of [...write, ...read]) if (denied(p, deniedPaths) && !(p.startsWith('tests/') && permIn.allowed_write_paths && write.includes(p) && operator && c.permissions?.allowed_write_paths)) {
    // Protected material can never be opened to a worker, even with operator input.
    if (/(^|\/)(\.env|\.ssh|\.aws|\.git|\.airodrom|\.runtime|node_modules)(\/|$|\.)/.test(p) || /\.(pem|key|p12)$/.test(p)) fail('Permission path is denied by host policy: ' + p);
    if (/(^|\/)(tests?|__tests__|\.vscode)(\/|$)|\.(test|spec)\.|^package(-lock)?\.json$/.test(p)) fail('Verification inputs must remain protected: ' + p);
  }
  const allowedTools = strings(permIn.allowed_tools ?? ['read', 'edit', 'write'], 'allowed_tools', { max: 12, maxLength: 80 });
  for (const tool of allowedTools) if (!TOOLS.includes(tool) && !/^shell:(npm|node|git|pnpm|yarn|pytest|python3|go|cargo|make):[A-Za-z0-9_.:-]{1,60}$/.test(tool)) fail('Unknown tool permission: ' + tool);
  const deniedTools = [...new Set([...DEFAULT_DENIED_TOOLS, ...strings(permIn.denied_tools, 'denied_tools', { max: 40, maxLength: 80 })])].sort();
  if (allowedTools.some(t => t.startsWith('shell:')) && !operator) fail('Shell command allowances require operator authority');
  const networkIn = object(permIn.network, ['mode', 'allow', 'deny_metadata_endpoints'], 'contract.permissions.network');
  const privacy = dispatch_policy?.privacy || 'local_only';
  const external = EXTERNAL_WORKERS.includes(preferred_agent) || fallback_agents.some(a => EXTERNAL_WORKERS.includes(a)) || privacy !== 'local_only';
  const networkMode = networkIn.mode ?? (preferred_agent === 'opencode' ? 'loopback' : external ? 'allowlist' : 'none');
  if (!NETWORK_MODES.includes(networkMode)) fail('Unknown network mode');
  const network = { mode: networkMode, allow: strings(networkIn.allow, 'network.allow', { max: 20, maxLength: 120 }), deny_metadata_endpoints: true };
  if (networkMode !== 'allowlist' && network.allow.length) fail('Network allowlist requires allowlist mode');
  for (const host of network.allow) if (!/^[a-z0-9.-]+(?::\d{2,5})?$/i.test(host) || /^(169\.254\.|metadata|localhost|127\.)/i.test(host)) fail('Unsafe network allow entry');
  const disclosureIn = object(permIn.external_disclosure, ['authorized', 'providers', 'purpose', 'authorized_by', 'data_classes'], 'contract.permissions.external_disclosure');
  const disclosure = {
    authorized: disclosureIn.authorized === true,
    providers: strings(disclosureIn.providers, 'external_disclosure.providers', { max: 3, maxLength: 20 }),
    purpose: disclosureIn.purpose ? String(disclosureIn.purpose).slice(0, 300) : null,
    authorized_by: disclosureIn.authorized === true ? 'operator' : null,
    data_classes: strings(disclosureIn.data_classes ?? ['workspace_declared_files'], 'external_disclosure.data_classes', { max: 4, maxLength: 40 }),
  };
  if (disclosure.authorized) {
    if (!operator) fail('External disclosure authorization requires operator authority');
    if (!disclosure.purpose) fail('External disclosure requires a stated purpose');
    if (!disclosure.providers.length || disclosure.providers.some(p => !EXTERNAL_WORKERS.includes(p))) fail('External disclosure requires named qualified providers');
    if (disclosure.data_classes.some(d => ['personal_memory', 'credentials', 'secrets'].includes(d))) fail('Personal Memory and credentials can never be disclosed to a coding provider');
  }
  if (external) {
    // Any external worker or non-local privacy requires explicit disclosure authorization.
    if (!disclosure.authorized) fail('external_disclosure_unauthorized');
    const providers = [preferred_agent, ...fallback_agents].filter(a => EXTERNAL_WORKERS.includes(a));
    if (providers.some(p => !disclosure.providers.includes(p))) fail('External worker is not covered by the disclosure authorization');
    if (networkMode !== 'allowlist' || !network.allow.length) fail('External worker requires an explicit network allowlist');
    const known = new Set(providers.flatMap(p => KNOWN_PROVIDER_HOSTS[p] || []));
    if (network.allow.some(h => !known.has(h.replace(/:\d+$/, '')))) fail('External worker network allowlist must name only known provider hosts');
  } else if (disclosure.authorized) {
    fail('External disclosure authorization is meaningless for a local-only Mission');
  }
  const providersIn = object(permIn.external_providers, ['mode', 'providers'], 'contract.permissions.external_providers');
  const externalProviders = { mode: external ? 'approved' : 'none', providers: external ? disclosure.providers : [] };
  if (providersIn.mode !== undefined && providersIn.mode !== externalProviders.mode) fail('external_providers.mode conflicts with disclosure authorization');
  const vaultIn = object(permIn.vault_access, ['mode'], 'contract.permissions.vault_access');
  if (vaultIn.mode !== undefined && vaultIn.mode !== 'none') fail('Worker vault access is not available in V1');
  const memoryIn = object(permIn.personal_memory, ['mode'], 'contract.permissions.personal_memory');
  if (memoryIn.mode !== undefined && memoryIn.mode !== 'none') fail('Personal Memory is never exposed to coding workers');
  const permissions = {
    allowed_read_paths: read, allowed_write_paths: write, denied_paths: deniedPaths,
    allowed_tools: allowedTools, denied_tools: deniedTools, network,
    external_providers: externalProviders, vault_access: { mode: 'none' }, personal_memory: { mode: 'none' },
    external_disclosure: disclosure,
  };

  // execution
  const execIn = object(c.execution, ['worker_allowlist', 'preferred_worker', 'fallback_worker', 'mode', 'sandbox', 'concurrency'], 'contract.execution');
  const preferredWorker = execIn.preferred_worker ?? preferred_agent;
  if (!WORKERS.includes(preferredWorker) || preferredWorker !== preferred_agent) fail('Contract preferred worker must match the declared route');
  const fallbackWorker = execIn.fallback_worker ?? (fallback_agents[0] || null);
  if (fallbackWorker !== null && (!WORKERS.includes(fallbackWorker) || !fallback_agents.includes(fallbackWorker))) fail('Contract fallback worker must match the declared route');
  const allowlist = strings(execIn.worker_allowlist ?? [preferred_agent, ...fallback_agents], 'worker_allowlist', { max: 4, maxLength: 20, allowEmpty: false });
  if (allowlist.some(w => !WORKERS.includes(w)) || !allowlist.includes(preferred_agent) || fallback_agents.some(a => !allowlist.includes(a))) fail('Worker allowlist must cover the declared route only');
  const mode = execIn.mode ?? (preferred_agent === 'host' ? 'native_plan' : ['opencode', 'cursor'].includes(preferred_agent) ? 'sandboxed_headless' : 'bounded_proposal');
  if (!EXECUTION_MODES.includes(mode)) fail('Unknown execution mode');
  const sandbox = execIn.sandbox ?? (mode === 'sandboxed_headless' ? 'sandbox-exec' : 'none');
  if (!SANDBOXES.includes(sandbox)) fail('Unknown sandbox');
  if (mode === 'sandboxed_headless' && sandbox === 'none') fail('Sandboxed workers require a sandbox');
  const execution = { worker_allowlist: allowlist, preferred_worker: preferredWorker, fallback_worker: fallbackWorker, mode, sandbox, concurrency: integer(execIn.concurrency ?? 1, 'concurrency', { min: 1, max: 1 }) };

  // verification: immutable expected outcome, exact criteria, registered tests only.
  const verIn = object(c.verification, ['expected_outcome', 'acceptance_criteria', 'required_tests', 'required_git_checks', 'required_security_checks', 'verifier'], 'contract.verification');
  const registered = Array.isArray(verification.tests) ? verification.tests : [];
  const requiredTests = strings(verIn.required_tests ?? registered, 'required_tests', { max: 8, maxLength: 100 });
  if (requiredTests.some(t => !registered.includes(t))) fail('required_tests must be registered verification task labels');
  const gitChecks = strings(verIn.required_git_checks ?? ['diff_check', 'allowed_files_only', 'no_unexpected_files', 'symlink_safety', 'base_commit_unchanged', 'no_git_mutation'], 'required_git_checks', { max: 8, maxLength: 40, allowEmpty: false });
  if (gitChecks.some(g => !GIT_CHECKS.includes(g))) fail('Unknown git check');
  for (const mandatory of ['diff_check', 'allowed_files_only', 'no_git_mutation']) if (!gitChecks.includes(mandatory)) fail('Mandatory git check missing: ' + mandatory);
  const securityChecks = strings(verIn.required_security_checks ?? ['secret_scan', 'protected_tests_unchanged', 'verifier_inputs_unchanged'], 'required_security_checks', { max: 8, maxLength: 40 });
  if (securityChecks.some(s => !SECURITY_CHECKS.includes(s))) fail('Unknown security check');
  for (const mandatory of ['secret_scan', 'protected_tests_unchanged', 'verifier_inputs_unchanged']) if (!securityChecks.includes(mandatory)) fail('Mandatory security check missing: ' + mandatory);
  if (verIn.verifier !== undefined && verIn.verifier !== 'airodrom:host-verifier') fail('Only the independent host verifier may verify');
  const criteriaOut = criteria.map(x => x.type === 'exact_file'
    ? { id: x.id, type: 'exact_file', path: x.path, content_sha256: require('node:crypto').createHash('sha256').update(x.content).digest('hex'), bytes: Buffer.byteLength(x.content) }
    : { id: x.id, type: x.type, description: String(x.description || '').slice(0, 1000) });
  const expectedOutcome = verIn.expected_outcome !== undefined ? String(verIn.expected_outcome).slice(0, 1000) : objectiveOut.intended_result;
  const verificationOut = { expected_outcome: expectedOutcome, acceptance_criteria: criteriaOut, required_tests: requiredTests, required_git_checks: gitChecks, required_security_checks: securityChecks, verifier: 'airodrom:host-verifier' };

  // budget
  const budgetIn = object(c.budget, ['risk_class', 'max_wall_clock_ms', 'max_worker_invocations', 'max_repair_attempts', 'max_tool_calls', 'max_inference_units', 'max_estimated_spend_usd', 'max_actual_spend_usd', 'spend_observability'], 'contract.budget');
  const riskClass = budgetIn.risk_class ?? (fixture ? 'fixture' : external ? 'normal' : 'normal');
  if (!Object.hasOwn(RISK_CLASSES, riskClass)) fail('Unknown risk class');
  const repairDefault = RISK_CLASSES[riskClass].max_repair_attempts;
  const maxRepairs = integer(budgetIn.max_repair_attempts ?? repairDefault, 'max_repair_attempts', { min: 0, max: ABSOLUTE_MAX_REPAIRS });
  if (maxRepairs > repairDefault && !operator) fail('Raising the repair budget above the risk-class default requires operator authority');
  if (riskClass === 'high' && maxRepairs > 0 && !operator) fail('High-risk Missions do not retry automatically');
  const budget = {
    risk_class: riskClass,
    max_wall_clock_ms: integer(budgetIn.max_wall_clock_ms ?? Math.min(DAY_MS, identity.expires_at - now), 'max_wall_clock_ms', { min: 60000, max: DAY_MS }),
    max_worker_invocations: integer(budgetIn.max_worker_invocations ?? (1 + maxRepairs), 'max_worker_invocations', { min: 1, max: 12 }),
    max_repair_attempts: maxRepairs,
    max_tool_calls: integer(budgetIn.max_tool_calls ?? 200, 'max_tool_calls', { min: 1, max: 2000 }),
    // Model tokens. Named "units" because durable authority records reject keys that look like credentials.
    max_inference_units: integer(budgetIn.max_inference_units, 'max_inference_units', { min: 1000, max: 50000000, optional: true }),
    max_estimated_spend_usd: integer(budgetIn.max_estimated_spend_usd ?? 0, 'max_estimated_spend_usd', { min: 0, max: 1000 }),
    max_actual_spend_usd: integer(budgetIn.max_actual_spend_usd, 'max_actual_spend_usd', { min: 0, max: 1000, optional: true }),
    spend_observability: external ? 'UNKNOWN_SUBSCRIPTION' : 'LOCAL_NO_SPEND',
  };

  // restrictions
  const resIn = object(c.restrictions, ['prohibited_files', 'prohibited_services', 'prohibited_deployments', 'prohibited_git_mutations', 'prohibited_dependency_upgrades', 'prohibited_schema_changes'], 'contract.restrictions');
  const restrictions = {
    prohibited_files: strings(resIn.prohibited_files, 'prohibited_files', { max: 40 }),
    prohibited_services: strings(resIn.prohibited_services ?? ['production', 'arecibo', 'launchd', 'keychain'], 'prohibited_services', { max: 20 }),
    prohibited_deployments: true,
    prohibited_git_mutations: strings(resIn.prohibited_git_mutations ?? GIT_MUTATIONS, 'prohibited_git_mutations', { max: 12, maxLength: 40 }),
    prohibited_dependency_upgrades: resIn.prohibited_dependency_upgrades ?? true,
    prohibited_schema_changes: resIn.prohibited_schema_changes ?? true,
  };
  if (resIn.prohibited_deployments !== undefined && resIn.prohibited_deployments !== true) fail('Deployments are always prohibited for coding workers');
  if (restrictions.prohibited_git_mutations.some(m => !GIT_MUTATIONS.includes(m))) fail('Unknown git mutation');
  for (const mandatory of ['push', 'force_push', 'merge', 'history_rewrite']) if (!restrictions.prohibited_git_mutations.includes(mandatory)) fail('Git mutation prohibition missing: ' + mandatory);
  if (typeof restrictions.prohibited_dependency_upgrades !== 'boolean' || typeof restrictions.prohibited_schema_changes !== 'boolean') fail('Invalid restriction flags');
  for (const p of restrictions.prohibited_files) if (write.includes(p)) fail('A file cannot be both writable and prohibited');

  // immutable scope fingerprint — identity, objective text and audit are excluded.
  const scope_fingerprint = canonicalHash({
    schema_version: SCHEMA_VERSION,
    project: { project_id: project.project_id, workspace: project.workspace, base_commit_sha: project.base_commit_sha, branch_strategy: project.branch_strategy },
    permissions, execution, verification: verificationOut, budget, restrictions,
  });
  if (c.scope_fingerprint !== undefined && c.scope_fingerprint !== scope_fingerprint) fail('Contract scope fingerprint mismatch');

  // audit: filled by the host over time; a supplied audit block is reset for a new Mission.
  const auditIn = object(c.audit, ['approval_id', 'approval_identity', 'scope_fingerprint', 'execution_attempts', 'verification_records', 'repair_lineage', 'completion_evidence', 'verifier_baseline'], 'contract.audit');
  const audit = {
    approval_id: approval_id || null,
    approval_identity: approval_id ? 'operator' : null,
    scope_fingerprint,
    execution_attempts: [],
    verification_records: [],
    repair_lineage: repair_of ? [...(Array.isArray(auditIn.repair_lineage) ? auditIn.repair_lineage.slice(-10) : []), repair_of] : [],
    completion_evidence: null,
  };

  return { schema_version: SCHEMA_VERSION, identity, objective: objectiveOut, project, permissions, execution, verification: verificationOut, budget, restrictions, audit, scope_fingerprint };
}

/** Recompute the fingerprint of a stored contract; detects tampering with the stored envelope. */
function fingerprintOf(contract) {
  return canonicalHash({
    schema_version: SCHEMA_VERSION,
    project: { project_id: contract.project.project_id, workspace: contract.project.workspace, base_commit_sha: contract.project.base_commit_sha, branch_strategy: contract.project.branch_strategy },
    permissions: contract.permissions, execution: contract.execution, verification: contract.verification, budget: contract.budget, restrictions: contract.restrictions,
  });
}

function assertIntact(contract) {
  if (!contract || contract.schema_version !== SCHEMA_VERSION) fail('Mission contract missing or unsupported');
  if (fingerprintOf(contract) !== contract.scope_fingerprint || contract.audit?.scope_fingerprint !== contract.scope_fingerprint) fail('Mission contract was altered after creation');
  return contract;
}

/** Measurable Definition of Done derived from registered verification only; never invents test names. */
function definitionOfDone({ intent = null, criteria = [], verification = {}, allowed_files = [] } = {}) {
  const items = [];
  for (const c of criteria) {
    if (c.type === 'exact_file') items.push({ kind: 'exact_file', text: c.path + ' contains exactly the approved bytes' + (c.content ? ' (' + Buffer.from(c.content).toString('hex') + ')' : ''), measurable: true });
    else if (c.type === 'operator_review') items.push({ kind: 'operator_review', text: c.description || 'Operator reviews the result', measurable: false });
    else items.push({ kind: c.type, text: c.description || c.id, measurable: false });
  }
  for (const label of verification.tests || []) items.push({ kind: 'registered_test', text: 'Registered test "' + label + '" passes', measurable: true });
  if (verification.diff_check) items.push({ kind: 'git_check', text: 'git diff --check passes', measurable: true });
  items.push({ kind: 'scope', text: 'No files change outside ' + (allowed_files.join(', ') || 'the approved files'), measurable: true });
  items.push({ kind: 'security', text: 'No secrets introduced; protected tests and verifier inputs unchanged', measurable: true });
  items.push({ kind: 'independent', text: 'Independent host verification passes; worker claims are not proof', measurable: true });
  const measurable = items.some(i => i.measurable && i.kind !== 'scope' && i.kind !== 'security' && i.kind !== 'independent');
  const clarify = measurable ? null : (intent?.kind === 'general' ? 'Which exact file should change, and which registered test proves it?' : 'A measurable success criterion is required before authorization.');
  return { items, measurable, clarify };
}

module.exports = {
  SCHEMA_VERSION, RISK_CLASSES, ABSOLUTE_MAX_REPAIRS, WORKERS, EXTERNAL_WORKERS, DEFAULT_DENIED_PATHS, DEFAULT_DENIED_TOOLS,
  KNOWN_PROVIDER_HOSTS, GIT_CHECKS, SECURITY_CHECKS, normalizeContract, fingerprintOf, assertIntact, definitionOfDone, globMatch,
};
