'use strict';
// ADR 0051. Trusted verifier baseline and test-tampering prevention.
//
// At Mission creation the host records the trusted base commit plus sha256 digests of
// every verifier-owned input (registered task definitions, test files, verification
// scripts). The record lives in envelope.contract.audit (host-only); workers never
// receive write authority over these paths. At verification time the host:
//   1. identifies changed verifier-owned files and classifies them
//      (A) immutable verifier-owned   → tampering, fail
//      (B) agent-authored new tests   → allowed only if the contract permits; never proof
//      (C) authorized app-test change → only when the contract names the path writable
//   2. detects removed assertions, skipped suites and relaxed negative checks
//   3. refuses to run registered tasks unless their inputs are byte-identical to the
//      trusted baseline (trusted-source execution), preserving evidence either way.
// Security scans are proportional and honest: NEW / PRE-EXISTING / UNAVAILABLE.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const VERSION = 1;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)\.vscode\/tasks\.json$|(^|\/)(jest|vitest|mocha|pytest|tox)\.config\.[^/]+$|(^|\/)(pytest\.ini|setup\.cfg|\.mocharc\.[^/]+)$/;
const VERIFIER_SCRIPT = /(^|\/)scripts\/(verify|qualify|check|test|audit|lint|secret)[^/]*\.(c?js|mjs|py|sh)$|(^|\/)\.github\/workflows\/.*\.ya?ml$/;
const SENSITIVE_AREA = /(auth|authori[sz]|permission|approval|secret|credential|vault|keychain|sandbox|shell|exec|spawn|mcp|network|proxy|deploy|migration|database|sql|payment|billing)/i;
const SECRET_PATTERNS = [
  { rule: 'private_key_block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { rule: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'openai_key', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/ },
  { rule: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { rule: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { rule: 'generic_assignment', re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i },
  { rule: 'url_credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{4,}@/i },
];

const digestOf = buffer => createHash('sha256').update(buffer).digest('hex');
function git(root, args) {
  const r = spawnSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } });
  if (r.status !== 0) throw Error('git ' + args[0] + ' unavailable');
  return r.stdout;
}
function isVerifierOwned(file) { return TEST_PATH.test(file) || VERIFIER_SCRIPT.test(file); }

/** Hash verifier-owned inputs at Mission creation. Pure read; nothing is written. */
function capture(workspace, { allowedFiles = [], verification = {}, baseline = null } = {}) {
  const files = Object.create(null);
  const inventory = baseline?.files && typeof baseline.files === 'object' ? baseline.files : null;
  const names = inventory ? Object.keys(inventory) : [];
  const owned = names.filter(isVerifierOwned);
  for (const name of owned) files[name] = inventory[name];
  // Tasks referenced by the registered verification must exist in the baseline.
  const tasksFile = '.vscode/tasks.json';
  if (!files[tasksFile] && inventory && inventory[tasksFile]) files[tasksFile] = inventory[tasksFile];
  const referenced = [];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(workspace, tasksFile), 'utf8'));
    const labels = new Set([verification.diff_check, ...(verification.tests || []), ...(verification.syntax || []), ...(verification.typecheck || []), ...(verification.lint || []), ...(verification.benchmark || [])].filter(Boolean));
    for (const task of config.tasks || []) {
      if (!labels.has(task.label)) continue;
      for (const arg of [task.command, ...(task.args || [])]) {
        if (typeof arg !== 'string' || path.isAbsolute(arg) || !/[\\/.]/.test(arg)) continue;
        const candidate = arg.replace(/^\.\//, '');
        if (inventory && inventory[candidate]) { files[candidate] = inventory[candidate]; referenced.push(candidate); }
      }
    }
  } catch { /* tasks.json missing or unreadable; the verifier reports that separately */ }
  const overlap = allowedFiles.filter(f => Object.hasOwn(files, f));
  const list = Object.keys(files).sort();
  // Arrays, not path-keyed objects: durable authority records reject keys that look like credentials.
  return {
    version: VERSION,
    captured_at: Date.now(),
    base_commit_sha: baseline?.head || null,
    branch: baseline?.branch || null,
    tasks_json_digest: files[tasksFile] || null,
    files: list.map(p => ({ path: p, sha256: files[p] })),
    referenced,
    file_count: list.length,
    worker_writable_overlap: overlap,
    assertion_profile: assertionProfile(workspace, list),
    authority: false,
  };
}

const ASSERT_RE = /\b(?:assert(?:\.[a-zA-Z]+)?|expect|should|t\.(?:ok|equal|same|match|throws|rejects)|self\.assert[A-Za-z]*|ok|equal|deepEqual|strictEqual|notEqual|throws|rejects|doesNotThrow|match)\s*\(/g;
const NEGATIVE_RE = /\b(?:assert\.(?:throws|rejects|notEqual|notStrictEqual|notDeepEqual|doesNotMatch)|expect\([^)]*\)\.(?:not|toThrow|rejects)|assertRaises|pytest\.raises)\b/g;
const SKIP_RE = /\b(?:test|it|describe|suite)\.(?:skip|todo|only)\s*\(|\bxit\s*\(|\bxdescribe\s*\(|@pytest\.mark\.skip|@unittest\.skip|\{\s*skip\s*:\s*true|--test-skip-pattern|\.skip\(/g;
function profileText(text) {
  return {
    assertions: (text.match(ASSERT_RE) || []).length,
    negative_assertions: (text.match(NEGATIVE_RE) || []).length,
    skips: (text.match(SKIP_RE) || []).length,
    bytes: Buffer.byteLength(text),
  };
}
function assertionProfile(workspace, names) {
  const out = [];
  for (const name of names) {
    try {
      const st = fs.lstatSync(path.join(workspace, name));
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      out.push({ path: name, ...profileText(fs.readFileSync(path.join(workspace, name), 'utf8')) });
    } catch { /* unreadable: no profile */ }
  }
  return out;
}
function baselineMap(record) {
  const files = new Map(), profiles = new Map();
  for (const f of record?.files || []) files.set(f.path, f.sha256);
  for (const p of record?.assertion_profile || []) profiles.set(p.path, p);
  return { files, profiles };
}

/** Trusted content of a baseline file at the recorded base commit, or null when unavailable. */
function trustedContent(workspace, baselineRecord, file) {
  if (!baselineRecord?.base_commit_sha) return null;
  const r = spawnSync('/usr/bin/git', ['-C', workspace, 'show', baselineRecord.base_commit_sha + ':' + file], { encoding: 'buffer', timeout: 10000, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } });
  if (r.status !== 0) return null;
  return r.stdout;
}

/**
 * Audit verifier-owned inputs against the trusted baseline.
 * @returns {{status:'passed'|'failed', changed:object[], tampering:object[], agent_authored:object[], authorized:object[], trusted_source:object}}
 */
function audit(workspace, baselineRecord, snapshot, { contract = null, allowedFiles = [] } = {}) {
  const changed = [], tampering = [], agentAuthored = [], authorized = [];
  const writable = new Set(contract?.permissions?.allowed_write_paths || allowedFiles || []);
  if (!baselineRecord || baselineRecord.version !== VERSION) {
    return { status: 'failed', reason: 'verifier_baseline_missing', changed, tampering, agent_authored: agentAuthored, authorized, trusted_source: { available: false } };
  }
  const now = snapshot?.files || {};
  const { files: baseFiles, profiles } = baselineMap(baselineRecord);
  // (A) baseline-owned files: any digest change is tampering unless explicitly authorized.
  for (const [file, digest] of baseFiles) {
    const current = now[file];
    if (current === digest) continue;
    const entry = { file, kind: current === undefined ? 'removed' : 'modified', baseline_sha256: digest, current_sha256: current || null };
    try {
      const before = profiles.get(file) || null;
      const after = current !== undefined ? profileText(fs.readFileSync(path.join(workspace, file), 'utf8')) : { assertions: 0, negative_assertions: 0, skips: 0, bytes: 0 };
      entry.assertions_before = before?.assertions ?? null;
      entry.assertions_after = after.assertions;
      entry.removed_assertions = before ? Math.max(0, before.assertions - after.assertions) : null;
      entry.weakened_negative_checks = before ? Math.max(0, before.negative_assertions - after.negative_assertions) : null;
      entry.skips_added = before ? Math.max(0, after.skips - before.skips) : after.skips;
    } catch { /* unreadable */ }
    changed.push(entry);
    if (writable.has(file) && contract?.permissions?.allowed_write_paths?.includes(file)) authorized.push(entry);
    else tampering.push({ ...entry, classification: 'verifier_owned_immutable' });
  }
  // (B) new verifier-owned files absent from the baseline.
  for (const file of Object.keys(now)) {
    if (baseFiles.has(file) || !isVerifierOwned(file)) continue;
    const entry = { file, kind: 'added', current_sha256: now[file], classification: writable.has(file) ? 'agent_authored_non_authoritative' : 'unauthorized_new_verifier_input' };
    changed.push(entry);
    if (writable.has(file)) agentAuthored.push(entry); else tampering.push(entry);
  }
  // Trusted-source availability: baseline digests must be reproducible from the base commit.
  let reproducible = 0, missing = [];
  for (const [file, digest] of baseFiles) {
    const content = trustedContent(workspace, baselineRecord, file);
    if (content && digestOf(content) === digest) reproducible += 1; else missing.push(file);
  }
  const trusted_source = { available: missing.length === 0, base_commit_sha: baselineRecord.base_commit_sha, reproducible, missing: missing.slice(0, 20) };
  return { status: tampering.length ? 'failed' : 'passed', changed, tampering, agent_authored: agentAuthored, authorized, trusted_source };
}

/** Proportional, honest security scan of changed files. */
function securityScan(workspace, changedFiles, { contract = null, baselineRecord = null } = {}) {
  const required = new Set(contract?.verification?.required_security_checks || ['secret_scan', 'protected_tests_unchanged', 'verifier_inputs_unchanged']);
  const checks = [];
  const readText = file => {
    try { const st = fs.lstatSync(path.join(workspace, file)); if (!st.isFile() || st.size > 4 * 1024 * 1024) return null; return fs.readFileSync(path.join(workspace, file), 'utf8'); } catch { return null; }
  };
  if (required.has('secret_scan')) {
    const findings = [];
    for (const file of changedFiles) {
      const text = readText(file); if (text === null) continue;
      const before = baselineRecord ? trustedContent(workspace, baselineRecord, file) : null;
      const priorText = before ? before.toString('utf8') : '';
      for (const { rule, re } of SECRET_PATTERNS) {
        const hits = (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
        const prior = priorText ? (priorText.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length : 0;
        if (hits > prior) findings.push({ file, rule, count: hits - prior, classification: 'NEW', severity: 'high' });
        else if (hits) findings.push({ file, rule, count: hits, classification: 'PRE_EXISTING', severity: 'high' });
      }
    }
    const fresh = findings.filter(f => f.classification === 'NEW');
    checks.push({ id: 'security:secret_scan', status: fresh.length ? 'failed' : 'passed', evidence: { scanned: changedFiles.length, new_findings: fresh.length, pre_existing_findings: findings.length - fresh.length, findings: findings.map(f => ({ file: f.file, rule: f.rule, classification: f.classification, count: f.count })) } });
  }
  const sensitive = changedFiles.filter(f => SENSITIVE_AREA.test(f) || SENSITIVE_AREA.test(readText(f) || '') && /\.(c?js|mjs|ts|py|go|rb|sh)$/.test(f));
  checks.push({ id: 'security:sensitive_area', status: sensitive.length ? 'operator_review' : 'passed', evidence: { files: sensitive.slice(0, 20), policy: sensitive.length ? 'Stronger review required: changes touch authentication/authorization/secrets/sandbox/shell/MCP/network/deploy/database paths.' : 'No sensitive-area paths changed.' } });
  const tools = { npm_audit: ['npm', ['audit', '--json', '--audit-level=high']], eslint: ['npx', ['--no-install', 'eslint', '--format', 'json']], typecheck: ['npx', ['--no-install', 'tsc', '--noEmit']], semgrep: ['semgrep', ['--json', '--quiet', '--config', 'auto']], gitleaks: ['gitleaks', ['detect', '--no-git', '--report-format', 'json', '--report-path', '/dev/stdout']] };
  for (const name of Object.keys(tools)) {
    if (!required.has(name)) continue;
    if (name === 'npm_audit' && !changedFiles.some(f => /(^|\/)package(-lock)?\.json$/.test(f))) { checks.push({ id: 'security:' + name, status: 'passed', evidence: { classification: 'NOT_APPLICABLE', reason: 'no dependency manifest changed' } }); continue; }
    const [cmd, args] = tools[name];
    const which = spawnSync('/usr/bin/which', [cmd], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin' } });
    if (which.status !== 0) { checks.push({ id: 'security:' + name, status: 'unavailable', evidence: { classification: 'UNAVAILABLE', reason: cmd + ' is not installed; not treated as passed' } }); continue; }
    const r = spawnSync(which.stdout.trim(), name === 'eslint' ? [...args, ...changedFiles.filter(f => /\.(c?js|mjs|ts|tsx)$/.test(f))] : args, { cwd: workspace, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: workspace } });
    if (r.error) { checks.push({ id: 'security:' + name, status: 'unavailable', evidence: { classification: 'UNAVAILABLE', reason: String(r.error.code || 'spawn_failed') } }); continue; }
    checks.push({ id: 'security:' + name, status: r.status === 0 ? 'passed' : 'failed', evidence: { exit_code: r.status, output_bytes: Buffer.byteLength(r.stdout || ''), classification: r.status === 0 ? 'PASSED' : 'FINDINGS' } });
  }
  return checks;
}

module.exports = { VERSION, capture, audit, securityScan, isVerifierOwned, profileText, trustedContent, SECRET_PATTERNS, SENSITIVE_AREA };
