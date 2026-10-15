'use strict';
// Bounded personal-ops automation preferences — Issue #112 (review hardening).
// Standing read-only account access and selected local tracker updates only.
// Never authorizes send, apply, invite, share, delete, or scope expansion.
// Tracker mutations without standing use a two-stage propose → confirm → consume flow.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { NEVER_AUTO } = require('./personal-ops');

const ALLOWED_KEYS = Object.freeze([
  'standing_gmail_readonly',
  'standing_local_tracker_updates',
  'expires_at',
  'confirmed'
]);

const MAX_STANDING_MS = 30 * 864e5; // 30 days
const MIN_STANDING_MS = 60e3; // 1 minute
const APPROVAL_TTL_MS = 5 * 60e3; // 5 minutes
const APPROVAL_ACTIONS = Object.freeze(['upsert', 'follow_up']);
const SCHEMA_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULTS = Object.freeze({
  version: SCHEMA_VERSION,
  standing_gmail_readonly: false,
  standing_local_tracker_updates: false,
  expires_at: null,
  never_auto: NEVER_AUTO,
  authority: false,
  active: false
});

function filePath(dataDir) {
  return path.join(dataDir, 'personal-ops-automation.json');
}

function approvalsDir(dataDir) {
  return path.join(dataDir, 'personal-ops-approvals');
}

function assertExactBoolean(value, name) {
  if (typeof value !== 'boolean') {
    const err = Error(`${name} must be an exact boolean`);
    err.code = 'invalid_automation';
    throw err;
  }
  return value;
}

function assertExpiry(expires_at, { requiredWhenEnabled = false, enabled = false } = {}) {
  if (expires_at == null || expires_at === '') {
    if (requiredWhenEnabled && enabled) {
      const err = Error('expires_at is required when any standing grant is enabled');
      err.code = 'invalid_automation';
      throw err;
    }
    return null;
  }
  if (typeof expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(expires_at)) {
    const err = Error('expires_at must be an ISO-8601 timestamp with timezone');
    err.code = 'invalid_automation';
    throw err;
  }
  const ms = Date.parse(expires_at);
  if (!Number.isFinite(ms)) {
    const err = Error('expires_at is not a valid timestamp');
    err.code = 'invalid_automation';
    throw err;
  }
  const now = Date.now();
  if (ms <= now + MIN_STANDING_MS) {
    const err = Error('expires_at must be at least one minute in the future');
    err.code = 'invalid_automation';
    throw err;
  }
  if (ms > now + MAX_STANDING_MS) {
    const err = Error('expires_at must be within 30 days');
    err.code = 'invalid_automation';
    throw err;
  }
  return expires_at;
}

function inactive(extra = {}) {
  return { ...DEFAULTS, ...extra, standing_gmail_readonly: false, standing_local_tracker_updates: false, active: false };
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    const err = Error('automation directory must not be a symlink');
    err.code = 'invalid_path';
    throw err;
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const body = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  const fd = fs.openSync(tmp, flags, 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
      const err = Error('approval destination must not be a symlink');
      err.code = 'invalid_path';
      throw err;
    }
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* */ }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
}

function load(dataDir) {
  if (!dataDir) return inactive();
  const file = filePath(dataDir);
  try {
    if (!fs.existsSync(file)) return inactive();
    if (fs.lstatSync(file).isSymbolicLink()) return inactive({ invalid: true, reason: 'symlink' });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const allowedPersisted = new Set([...ALLOWED_KEYS, 'version', 'never_auto', 'updated_at', 'actor', 'authority', 'confirmed_at']);
    for (const key of Object.keys(raw)) {
      if (!allowedPersisted.has(key)) return inactive({ expired: false, invalid: true, reason: 'unknown_field' });
    }
    if (raw.version !== SCHEMA_VERSION) return inactive({ invalid: true, reason: 'unsupported_version', previous_version: raw.version ?? null });
    if (raw.standing_gmail_readonly !== true && raw.standing_gmail_readonly !== false) return inactive({ invalid: true, reason: 'invalid_boolean' });
    if (raw.standing_local_tracker_updates !== true && raw.standing_local_tracker_updates !== false) return inactive({ invalid: true, reason: 'invalid_boolean' });
    const enabled = raw.standing_gmail_readonly === true || raw.standing_local_tracker_updates === true;
    if (!enabled) return inactive({ expires_at: raw.expires_at || null });
    if (typeof raw.expires_at !== 'string') return inactive({ invalid: true, reason: 'missing_expiry', previous_expires_at: raw.expires_at || null });
    const ms = Date.parse(raw.expires_at);
    if (!Number.isFinite(ms)) return inactive({ invalid: true, reason: 'invalid_expiry', previous_expires_at: raw.expires_at });
    const now = Date.now();
    if (ms < now) return inactive({ expired: true, previous_expires_at: raw.expires_at });
    if (ms > now + MAX_STANDING_MS) return inactive({ invalid: true, reason: 'expiry_ceiling', previous_expires_at: raw.expires_at });
    if (typeof raw.updated_at === 'string') {
      const updated = Date.parse(raw.updated_at);
      if (Number.isFinite(updated) && ms > updated + MAX_STANDING_MS) {
        return inactive({ invalid: true, reason: 'expiry_ceiling_from_updated_at', previous_expires_at: raw.expires_at });
      }
    }
    return {
      ...DEFAULTS,
      standing_gmail_readonly: raw.standing_gmail_readonly === true,
      standing_local_tracker_updates: raw.standing_local_tracker_updates === true,
      expires_at: raw.expires_at,
      active: true
    };
  } catch {
    return inactive({ invalid: true, reason: 'unreadable' });
  }
}

function save(dataDir, patch = {}, actor = 'operator') {
  if (!dataDir) throw Error('dataDir required');
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_KEYS.includes(key)) {
      const err = Error('Unknown personal-ops automation field: ' + key);
      err.code = 'invalid_automation';
      throw err;
    }
    if (NEVER_AUTO.includes(key) && patch[key]) {
      const err = Error('Action requires separate explicit confirmation and cannot be standing-authorized: ' + key);
      err.code = 'never_auto';
      throw err;
    }
  }
  if (patch.confirmed !== true) {
    const err = Error('Explicit confirmed:true required to save standing personal-ops automation');
    err.code = 'confirmation_required';
    throw err;
  }
  const current = load(dataDir);
  const standing_gmail_readonly = patch.standing_gmail_readonly === undefined
    ? current.standing_gmail_readonly
    : assertExactBoolean(patch.standing_gmail_readonly, 'standing_gmail_readonly');
  const standing_local_tracker_updates = patch.standing_local_tracker_updates === undefined
    ? current.standing_local_tracker_updates
    : assertExactBoolean(patch.standing_local_tracker_updates, 'standing_local_tracker_updates');
  const enabled = standing_gmail_readonly || standing_local_tracker_updates;
  const expires_at = assertExpiry(
    patch.expires_at === undefined ? current.expires_at : patch.expires_at,
    { requiredWhenEnabled: true, enabled }
  );
  const next = {
    version: SCHEMA_VERSION,
    standing_gmail_readonly,
    standing_local_tracker_updates,
    expires_at,
    never_auto: NEVER_AUTO,
    updated_at: new Date().toISOString(),
    confirmed_at: new Date().toISOString(),
    actor,
    authority: false
  };
  atomicWriteJson(filePath(dataDir), next);
  return load(dataDir);
}

function requiresExplicitPermission(action) {
  return NEVER_AUTO.includes(action);
}

function allows(dataDir, capability) {
  const st = load(dataDir);
  if (!st.active) return false;
  if (capability === 'gmail_readonly') return st.standing_gmail_readonly === true;
  if (capability === 'local_tracker_updates') return st.standing_local_tracker_updates === true;
  return false;
}

function ensureApprovalsDir(dataDir) {
  const dir = approvalsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    const err = Error('approvals directory must not be a symlink');
    err.code = 'invalid_path';
    throw err;
  }
  return dir;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value === undefined ? null : value;
}

function payloadDigest(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(payload))).digest('hex');
}

// operator_confirmation is typed manual evidence (a human claim), never the approval token.
// Keep the claim in the digest; host_approval_id stays outside business-data evidence.
function normalizeEvidenceForDigest(evidence) {
  if (evidence == null) return null;
  if (typeof evidence === 'string') {
    const m = /^(message_id|thread_id|url|operator_confirmation)=(.+)$/i.exec(evidence.trim());
    if (m && m[1].toLowerCase() === 'operator_confirmation') {
      return { kind: 'operator_confirmation', explicit: true, claim: m[2].trim().slice(0, 200) };
    }
    return evidence.trim();
  }
  if (typeof evidence === 'object' && !Array.isArray(evidence)) {
    const kind = String(evidence.kind || '').trim().toLowerCase();
    const claim = evidence.value != null ? String(evidence.value).trim()
      : evidence.operator_confirmation != null ? String(evidence.operator_confirmation).trim()
      : evidence.claim != null ? String(evidence.claim).trim()
      : '';
    if (kind === 'operator_confirmation' || evidence.operator_confirmation != null) {
      return { kind: 'operator_confirmation', explicit: true, claim: claim.slice(0, 200) };
    }
  }
  return stableValue(evidence);
}

function evidenceSummary(evidence) {
  const normalized = normalizeEvidenceForDigest(evidence);
  if (!normalized) return { kind: null, display: 'none' };
  if (typeof normalized === 'string') return { kind: 'raw', display: normalized.slice(0, 120) };
  if (normalized.kind === 'operator_confirmation') {
    return { kind: 'operator_confirmation', display: 'Manual owner confirmation: ' + (normalized.claim || '').slice(0, 120) };
  }
  if (normalized.kind === 'url') return { kind: 'url', display: String(normalized.value || '').slice(0, 160) };
  if (normalized.kind === 'message_id' || normalized.kind === 'thread_id') {
    return { kind: normalized.kind, display: String(normalized.value || '').slice(0, 80) };
  }
  return { kind: normalized.kind || 'evidence', display: JSON.stringify(normalized).slice(0, 160) };
}

function buildMutationPayload(action, body = {}, trackerPath) {
  if (!APPROVAL_ACTIONS.includes(action)) {
    const err = Error('Unsupported tracker approval action');
    err.code = 'invalid_approval';
    throw err;
  }
  if (typeof trackerPath !== 'string' || !trackerPath.trim()) {
    const err = Error('tracker_path required for mutation proposal');
    err.code = 'invalid_approval';
    throw err;
  }
  const requestId = body.request_id == null || body.request_id === '' ? null : String(body.request_id).trim();
  if (requestId != null && (requestId.length < 8 || requestId.length > 200)) {
    const err = Error('request_id must be 8-200 characters when provided');
    err.code = 'invalid_approval';
    throw err;
  }
  const payload = {
    action,
    tracker_path: String(trackerPath),
    request_id: requestId,
    company: body.company == null ? null : String(body.company),
    role: body.role == null ? null : String(body.role),
    status: body.status == null ? null : String(body.status),
    evidence: normalizeEvidenceForDigest(body.evidence),
    posting_url: body.posting_url == null ? null : String(body.posting_url),
    recruiter_email: body.recruiter_email == null ? null : String(body.recruiter_email),
    applied_at: body.applied_at == null ? null : String(body.applied_at),
    follow_up_at: body.follow_up_at == null ? null : String(body.follow_up_at),
    notes: body.notes == null ? null : String(body.notes),
    id: body.id == null ? null : String(body.id),
    source: body.source == null ? null : String(body.source)
  };
  return { payload, digest: payloadDigest(payload) };
}

function proposalPath(dataDir, id) {
  return path.join(approvalsDir(dataDir), `${id}.json`);
}

function readProposal(dataDir, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    const err = Error('proposal_id must be a host UUID');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  const file = proposalPath(dataDir, id);
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) {
    const err = Error('Mutation proposal not found');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) {
      const err = Error('Mutation proposal identity refused');
      err.code = 'mutation_authorization_required';
      throw err;
    }
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function writeProposal(dataDir, record) {
  atomicWriteJson(proposalPath(dataDir, record.id), record);
}

function proposedFields(payload = {}) {
  const evidence = evidenceSummary(payload.evidence);
  return {
    company: payload.company || null,
    role: payload.role || null,
    status: payload.status || null,
    source: payload.source || null,
    posting_url: payload.posting_url || null,
    recruiter_email: payload.recruiter_email || null,
    applied_at: payload.applied_at || null,
    follow_up_at: payload.follow_up_at || null,
    notes: payload.notes == null ? null : String(payload.notes).slice(0, 500),
    application_id: payload.id || null,
    evidence_kind: evidence.kind,
    evidence_display: evidence.display
  };
}

function beforeAfterDiff(payload = {}, currentRow = null) {
  const proposed = proposedFields(payload);
  if (!currentRow) {
    return {
      mode: 'create',
      before: null,
      after: proposed,
      changes: Object.entries(proposed).filter(([, v]) => v != null && v !== '').map(([k, v]) => ({ field: k, from: null, to: v }))
    };
  }
  const before = {
    company: currentRow.company || null,
    role: currentRow.role || null,
    status: currentRow.status || null,
    source: currentRow.source || null,
    posting_url: currentRow.posting_url || null,
    recruiter_email: currentRow.recruiter_email || null,
    applied_at: currentRow.applied_at || null,
    follow_up_at: currentRow.follow_up_at || null,
    notes: currentRow.notes == null ? null : String(currentRow.notes).slice(0, 500),
    application_id: currentRow.id || null,
    evidence_kind: evidenceSummary(currentRow.evidence).kind,
    evidence_display: evidenceSummary(currentRow.evidence).display
  };
  const changes = [];
  for (const key of Object.keys(proposed)) {
    const from = before[key] == null ? null : String(before[key]);
    const to = proposed[key] == null ? null : String(proposed[key]);
    if (from !== to && to != null && to !== '') changes.push({ field: key, from, to });
  }
  return { mode: 'update', before, after: proposed, changes };
}

function publicProposalView(record, extra = {}) {
  const fields = proposedFields(record.payload || {});
  return {
    proposal_id: record.id,
    status: record.status,
    action: record.action,
    payload_digest: record.payload_digest,
    tracker_path: record.tracker_path,
    request_id: record.request_id,
    expires_at: record.expires_at,
    reviewed: !!(record.reviewed_at && record.reviewed_digest === record.payload_digest),
    reviewed_at: record.reviewed_at || null,
    executable: record.status === 'approved',
    authority: false,
    summary: fields,
    ...extra
  };
}

function reviewPacket(record, currentRow = null) {
  const diff = beforeAfterDiff(record.payload || {}, currentRow);
  return {
    ...publicProposalView(record, {
      message: 'Read-only proposal review. Approve only after inspecting these exact fields in Control Center or Terminal.'
    }),
    proposed: diff.after,
    before: diff.before,
    diff,
    review_required_before_approve: true,
    conversational_auto_approve: false
  };
}

function proposeMutation(dataDir, { action, body = {}, trackerPath, actor = 'operator' } = {}) {
  if (!dataDir) throw Error('dataDir required');
  const { payload, digest } = buildMutationPayload(action, body, trackerPath);
  ensureApprovalsDir(dataDir);
  const id = crypto.randomUUID();
  const record = {
    version: 1,
    id,
    action,
    status: 'pending_review',
    actor,
    tracker_path: payload.tracker_path,
    request_id: payload.request_id,
    payload,
    payload_digest: digest,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    approved_at: null,
    reserved_at: null,
    consumed_at: null,
    failed_at: null,
    authority: false,
    executable: false
  };
  writeProposal(dataDir, record);
  return {
    ...publicProposalView(record, {
      message: 'Pending mutation proposal recorded. Open Control Center → Approvals or POST review_proposal, inspect the exact fields, then approve_proposal with confirmed:true. Not executable yet.'
    }),
    standing_active: allows(dataDir, 'local_tracker_updates')
  };
}

function listProposals(dataDir, { status = null, limit = 20 } = {}) {
  if (!dataDir) return [];
  const dir = approvalsDir(dataDir);
  if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const id = name.slice(0, -5);
    if (!UUID_RE.test(id)) continue;
    try {
      const record = readProposal(dataDir, id);
      if (status && record.status !== status) continue;
      out.push(publicProposalView(record));
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => String(b.expires_at || '').localeCompare(String(a.expires_at || '')));
  return out.slice(0, Math.max(1, Math.min(50, limit | 0 || 20)));
}

function reviewProposal(dataDir, { proposal_id, current_row = null, actor = 'operator' } = {}) {
  const record = readProposal(dataDir, proposal_id);
  if (record.version !== 1 || record.id !== proposal_id) {
    const err = Error('Mutation proposal invalid');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  const exp = Date.parse(record.expires_at);
  if (!Number.isFinite(exp) || exp < Date.now()) {
    record.status = 'expired';
    writeProposal(dataDir, record);
    const err = Error('Mutation proposal expired');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  if (!['pending_review', 'approved'].includes(record.status)) {
    const err = Error('Mutation proposal is not reviewable');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  record.reviewed_at = new Date().toISOString();
  record.reviewed_digest = record.payload_digest;
  record.reviewed_by = actor;
  writeProposal(dataDir, record);
  return reviewPacket(record, current_row);
}

function approveProposal(dataDir, { proposal_id, confirmed, actor = 'operator' } = {}) {
  if (confirmed !== true) {
    const err = Error('Explicit confirmed:true required to approve a tracker mutation proposal');
    err.code = 'confirmation_required';
    throw err;
  }
  const record = readProposal(dataDir, proposal_id);
  if (record.version !== 1 || record.id !== proposal_id) {
    const err = Error('Mutation proposal invalid');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  const exp = Date.parse(record.expires_at);
  if (!Number.isFinite(exp) || exp < Date.now()) {
    record.status = 'expired';
    writeProposal(dataDir, record);
    const err = Error('Mutation proposal expired');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  if (record.status === 'consumed' || record.status === 'failed' || record.status === 'in_flight') {
    const err = Error('Mutation proposal is no longer approvable');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  if (!record.reviewed_at || record.reviewed_digest !== record.payload_digest) {
    const err = Error('Review the exact proposal first (review_proposal) before approve_proposal');
    err.code = 'review_required';
    throw err;
  }
  if (record.status === 'approved') {
    return {
      ...publicProposalView(record, {
        approval_id: record.id,
        message: 'Proposal already approved. Execute with the exact approved payload and host_approval_id.'
      })
    };
  }
  if (record.status !== 'pending_review') {
    const err = Error('Mutation proposal is not pending review');
    err.code = 'mutation_authorization_required';
    throw err;
  }
  record.status = 'approved';
  record.approved_at = new Date().toISOString();
  record.approved_by = actor;
  record.executable = true;
  writeProposal(dataDir, record);
  return {
    ...publicProposalView(record, {
      approval_id: record.id,
      message: 'Proposal approved after operator review. Execute once with the exact approved payload and host_approval_id.'
    })
  };
}

function authError(message) {
  const err = Error(message);
  err.code = 'mutation_authorization_required';
  throw err;
}

function prepareApproval(dataDir, approvalId, action, { digest, trackerPath, requestId = null, payload = null } = {}) {
  const record = readProposal(dataDir, approvalId);
  if (record.version !== 1 || record.id !== approvalId) authError('Host approval invalid');
  if (record.action !== action) authError('Host approval action mismatch');
  const exp = Date.parse(record.expires_at);
  if (!Number.isFinite(exp) || exp < Date.now()) {
    if (record.status === 'pending_review' || record.status === 'approved') {
      record.status = 'expired';
      writeProposal(dataDir, record);
    }
    authError('Host approval expired');
  }
  if (record.status === 'pending_review') authError('Mutation proposal is still pending operator review');
  if (record.status === 'consumed') authError('Host approval already consumed');
  if (record.status === 'failed' || record.status === 'expired') authError('Host approval is closed');
  if (record.status === 'in_flight') authError('Host approval is already in flight');
  if (record.status !== 'approved') authError('Host approval is not approved');
  if (record.payload_digest !== digest) authError('Approved mutation payload digest mismatch');
  if (record.tracker_path !== trackerPath) authError('Approved tracker identity mismatch');
  const expectedRequest = record.request_id == null ? null : String(record.request_id);
  const actualRequest = requestId == null || requestId === '' ? null : String(requestId);
  if (expectedRequest !== actualRequest) authError('Approved request_id mismatch');
  if (payload) {
    const recomputed = payloadDigest(payload);
    if (recomputed !== record.payload_digest) authError('Approved mutation payload mismatch');
  }
  record.status = 'in_flight';
  record.reserved_at = new Date().toISOString();
  record.executable = false;
  writeProposal(dataDir, record);
  return { ok: true, approval_id: approvalId, action, mode: 'host_approval', payload_digest: record.payload_digest };
}

function commitApproval(dataDir, approvalId) {
  const record = readProposal(dataDir, approvalId);
  if (record.status === 'consumed' && record.consumed_at) {
    return { ok: true, approval_id: approvalId, duplicate: true };
  }
  if (record.status !== 'in_flight') authError('Host approval commit requires in_flight reservation');
  record.status = 'consumed';
  record.consumed_at = new Date().toISOString();
  record.executable = false;
  writeProposal(dataDir, record);
  return { ok: true, approval_id: approvalId, duplicate: false };
}

function failApproval(dataDir, approvalId, reason = 'uncertain_or_failed_mutation') {
  try {
    const record = readProposal(dataDir, approvalId);
    if (record.status === 'consumed') return { ok: true, approval_id: approvalId, status: 'consumed' };
    record.status = 'failed';
    record.failed_at = new Date().toISOString();
    record.failure_reason = String(reason).slice(0, 200);
    record.executable = false;
    writeProposal(dataDir, record);
    return { ok: true, approval_id: approvalId, status: 'failed' };
  } catch {
    return { ok: false, approval_id: approvalId, status: 'unknown' };
  }
}

function trackerPolicy(dataDir) {
  return {
    allowsLocalTrackerUpdates: () => allows(dataDir, 'local_tracker_updates'),
    prepareApproval: (approvalId, action, binding) => prepareApproval(dataDir, approvalId, action, binding),
    commitApproval: (approvalId) => commitApproval(dataDir, approvalId),
    failApproval: (approvalId, reason) => failApproval(dataDir, approvalId, reason),
    proposeMutation: (args) => proposeMutation(dataDir, args),
    approveProposal: (args) => approveProposal(dataDir, args),
    reviewProposal: (args) => reviewProposal(dataDir, args),
    listProposals: (args) => listProposals(dataDir, args),
    buildMutationPayload: (action, body, trackerPath) => buildMutationPayload(action, body, trackerPath)
  };
}

module.exports = {
  load,
  save,
  requiresExplicitPermission,
  allows,
  proposeMutation,
  approveProposal,
  reviewProposal,
  listProposals,
  prepareApproval,
  commitApproval,
  failApproval,
  buildMutationPayload,
  normalizeEvidenceForDigest,
  payloadDigest,
  reviewPacket,
  trackerPolicy,
  DEFAULTS,
  NEVER_AUTO,
  ALLOWED_KEYS,
  MAX_STANDING_MS,
  APPROVAL_TTL_MS,
  APPROVAL_ACTIONS,
  SCHEMA_VERSION
};
