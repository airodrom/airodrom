'use strict';
// Limits & Blockers Registry V1 — source-grounded definitions + live diagnostics.
// Read-only. Never grants authority, creates grants, expands permissions, or
// deletes protected workspaces. Error messages alone never authorize recovery.
const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_PATH = path.join(__dirname, '..', 'config', 'limits-blockers-registry-v1.json');
const CATEGORIES = Object.freeze(['operational_auto', 'operational_owner', 'security_critical']);
const SEVERITIES = Object.freeze(['info', 'warning', 'error', 'critical']);

let cached = null;

function loadRegistry() {
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  if (!raw || raw.version !== 1 || !Array.isArray(raw.entries)) {
    throw Error('limits-blockers-registry-v1 unavailable or invalid');
  }
  const byId = new Map();
  const byCode = new Map();
  for (const entry of raw.entries) {
    if (!entry?.id || byId.has(entry.id)) throw Error('Invalid registry entry id');
    if (!CATEGORIES.includes(entry.category)) throw Error('Invalid registry category: ' + entry.id);
    if (!SEVERITIES.includes(entry.severity)) throw Error('Invalid registry severity: ' + entry.id);
    byId.set(entry.id, entry);
    for (const code of entry.codes || []) {
      for (const key of new Set([codeKey(code), looseKey(code)].filter(Boolean))) {
        if (!byCode.has(key)) byCode.set(key, []);
        if (!byCode.get(key).includes(entry.id)) byCode.get(key).push(entry.id);
      }
    }
  }
  cached = Object.freeze({
    version: raw.version,
    id: raw.id,
    title: raw.title,
    description: raw.description,
    categories: raw.categories,
    discovery: raw.discovery,
    entries: Object.freeze(raw.entries.map(e => Object.freeze({ ...e }))),
    byId,
    byCode,
    path: REGISTRY_PATH,
    authority: false,
  });
  return cached;
}

function normalizeCode(value) {
  if (value == null) return '';
  return String(value).trim().replace(/\s+/g, ' ').slice(0, 300);
}

function safeCode(code) { return require('./control-plane-store').redactValue(normalizeCode(code)); }

function codeKey(value) {
  const n = normalizeCode(value);
  if (!n) return '';
  return n.toLowerCase();
}

/** Normalize codes and human messages to a comparable token (spaces/punct → _). */
function looseKey(value) {
  return normalizeCode(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function unknownEntry(code) {
  const normalized = safeCode(code) || 'unknown';
  return {
    id: 'unknown_blocker',
    codes: [normalized],
    description: 'Unregistered blocker. Reported as unknown rather than invented.',
    category: 'operational_owner',
    severity: 'warning',
    source: { file: null, symbol: null },
    configured_limit: null,
    runtime_usage: null,
    failure_condition: null,
    operational: true,
    security_critical: false,
    automatic_recovery_allowed: false,
    automatic_recovery: null,
    next_safe_action: 'inspect_source_then_register_or_owner_decide',
    owner_approval_required: true,
    historical_status: 'active',
    docs: ['docs/operations/LIMITS-AND-BLOCKERS-REGISTRY.md'],
    registered: false,
    matched_code: normalized,
    authority: false,
  };
}

/** Resolve one runtime code/message to a registry view. Never invents security class. */
function resolve(codeOrMessage) {
  const registry = loadRegistry();
  const normalized = normalizeCode(codeOrMessage);
  if (!normalized) return unknownEntry('unknown');
  const key = codeKey(normalized);
  const loose = looseKey(normalized);
  let ids = registry.byCode.get(key) || registry.byCode.get(loose) || [];
  if (!ids.length) {
    // Only a complete registered prefix followed by ':' may carry detail.
    // A known token embedded in an unknown error is never executable recovery.
    const prefix = normalized.split(':', 1)[0];
    if (prefix !== normalized) ids = registry.byCode.get(codeKey(prefix)) || registry.byCode.get(looseKey(prefix)) || [];
  }
  if (!ids.length) return unknownEntry(normalized);
  const entry = registry.byId.get(ids[0]);
  return {
    ...entry,
    registered: true,
    matched_code: safeCode(normalized),
    authority: false,
  };
}

function annotateBlockers(codes) {
  const list = Array.isArray(codes) ? codes : (codes ? [codes] : []);
  return list.map(code => {
    const entry = resolve(code);
    return {
      code: safeCode(code),
      registry_id: entry.id,
      category: entry.category,
      severity: entry.severity,
      security_critical: !!entry.security_critical,
      automatic_recovery_allowed: !!entry.automatic_recovery_allowed,
      owner_approval_required: !!entry.owner_approval_required,
      next_safe_action: entry.next_safe_action,
      enforcement: entry.source,
      registered: entry.registered !== false,
      historical_status: entry.historical_status || 'active',
      description: entry.description,
      policy_decision: entry.registered === false ? 'unknown_fail_closed' : 'blocked',
      missing_prerequisite: entry.missing_prerequisite || entry.failure_condition || null,
      allowed_recovery: entry.automatic_recovery || null,
      authority: false,
    };
  });
}

function validateAgainstSource({ root = path.join(__dirname, '..') } = {}) {
  const registry = loadRegistry();
  const issues = [];
  for (const entry of registry.entries) {
    const file = entry.source?.file;
    if (!file) {
      issues.push({ id: entry.id, issue: 'missing_source_file' });
      continue;
    }
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) {
      issues.push({ id: entry.id, issue: 'source_file_missing', file });
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    const found = (entry.codes || []).some(code => {
      const token = String(code).match(/[A-Za-z][A-Za-z0-9_]{3,}/)?.[0];
      return token && text.includes(token);
    });
    if (!found && entry.historical_status !== 'fixed_defect') {
      issues.push({ id: entry.id, issue: 'code_literal_not_found_in_source', file, codes: entry.codes });
    }
  }
  return {
    ok: issues.length === 0,
    entry_count: registry.entries.length,
    issues,
    registry_version: registry.version,
    authority: false,
  };
}

function filterEntries(entries, { category, severity, recoverability, project_id } = {}) {
  return entries.filter(e => {
    if (category && e.category !== category) return false;
    if (severity && e.severity !== severity) return false;
    if (recoverability === 'automatic' && !e.automatic_recovery_allowed) return false;
    if (recoverability === 'owner' && !e.owner_approval_required) return false;
    if (recoverability === 'security' && !e.security_critical) return false;
    if (project_id && e.project_id && e.project_id !== project_id) return false;
    return true;
  });
}

function safeBasename(p) {
  try { return path.basename(String(p || '')); } catch { return null; }
}

function missionCounts(bridge) {
  const db = bridge?.controlStore?.db;
  if (!db) return null;
  try {
    const rows = db.prepare('SELECT state, COUNT(*) AS n FROM cp_missions GROUP BY state').all();
    const by = Object.fromEntries(rows.map(r => [r.state, r.n]));
    const running = (by.running || 0) + (by.dispatching || 0) + (by.verifying || 0);
    return {
      running,
      blocked: by.blocked || 0,
      needs_rework: by.needs_rework || 0,
      awaiting_acceptance: by.awaiting_acceptance || 0,
      completed: by.completed || 0,
      cancelled: by.cancelled || 0,
      authority: false,
    };
  } catch {
    return null;
  }
}

function developerAutonomyLive(bridge, { policy_id = null } = {}) {
  const da = bridge?.developerAutonomy;
  if (!da) return { available: false, authority: false };
  try {
    const status = da.status('operator');
    const policies = (status.policies || []).filter(p => p.state === 'active'
      && (!policy_id || p.policy_id === policy_id));
    const sections = [];
    for (const policy of policies) {
      let inventory = null;
      let disk = { state: 'unknown' };
      try {
        inventory = da.capacityInventory(policy.policy_id);
      } catch {
        inventory = null;
      }
      try {
        const available = da.assertPreparationCapacity(policy, 0, { label: 'limits diagnostics' });
        disk = {
          state: 'healthy',
          available_bytes: Number.isSafeInteger(available) ? available : null,
          note: 'Filesystem free space after reserve; not legacy max_disk_mb.',
        };
      } catch (error) {
        disk = {
          state: 'exhausted',
          message: String(error.message || error).slice(0, 240),
          registry_id: resolve(error.message || error).id,
        };
      }
      let grants = { active: 0, expired: 0, consumed: 0 };
      try {
        const rows = da.db.prepare(
          'SELECT state, expires_at FROM cp_developer_autonomy_grants WHERE policy_id=?'
        ).all(policy.policy_id);
        const now = Date.now();
        for (const row of rows) {
          if (row.state === 'active' && row.expires_at > now) grants.active++;
          else if (row.state === 'active' && row.expires_at <= now) grants.expired++;
          else if (row.state === 'consumed') grants.consumed++;
          else if (row.state === 'expired') grants.expired++;
        }
      } catch { /* grants optional */ }
      const limit = policy.budgets?.max_worktrees ?? null;
      const occupied = inventory?.occupied_count ?? null;
      sections.push({
        policy_id: policy.policy_id,
        alias: policy.alias || null,
        repository_label: safeBasename(policy.repository),
        worktrees: {
          occupied,
          limit,
          tracked: inventory?.total_tracked ?? null,
          occupied_slots: (inventory?.occupied || []).map(s => ({
            workspace_id: s.workspace_id,
            classification: s.classification,
            mission_ids: s.mission_ids,
            grant_id: s.grant_id,
          })),
          exhausted: Number.isInteger(occupied) && Number.isInteger(limit) && occupied >= limit,
          registry_id: 'worktree_budget_exhausted',
        },
        disk,
        grants,
        budgets: policy.budgets || null,
        authority: false,
      });
    }
    return { available: true, policies: sections, authority: false };
  } catch (error) {
    return { available: false, error: String(error.message || error).slice(0, 200), authority: false };
  }
}

function cursorLive(bridge) {
  const hep = bridge?.hostExecutionPolicy;
  const cursor = bridge?.cursorWorker;
  const out = {
    runtime: 'unavailable',
    agent_availability: null,
    standing_grant: 'unavailable',
    spend_admission: 'unavailable',
    authority: false,
  };
  try {
    const ready = cursor?.lastReadiness || null;
    if (ready?.ready === true && ready?.governed_worker === true) out.runtime = 'ready';
    else if (ready?.ready === false) out.runtime = 'not_ready';
    else if (ready) out.runtime = 'observed';
    out.agent_availability = ready?.tiers || null;
  } catch { /* ignore */ }
  try {
    const status = hep.status('operator');
    const disabled = !!hep.cursorDisabled?.();
    if (disabled) {
      out.runtime = 'disabled';
      out.spend_admission = 'cursor_execution_disabled';
    }
    const standing = status?.standing_cursor_development || status?.standing || null;
    if (Array.isArray(standing)) {
      const active = standing.filter(g => g.state === 'active' || g.active === true);
      out.standing_grant = active.length ? 'active' : 'none_active';
      out.standing_active_count = active.length;
    } else if (standing && typeof standing === 'object') {
      out.standing_grant = standing.state || (standing.active ? 'active' : 'none_active');
    }
    if (out.spend_admission === 'unavailable') {
      out.spend_admission = out.standing_grant === 'active' ? 'covered_when_matched'
        : out.standing_grant === 'none_active' ? 'requires_owner_grant' : 'unknown';
    }
  } catch { /* ignore */ }
  return out;
}

function observedBlockers(bridge, { limit = 20 } = {}) {
  const db = bridge?.controlStore?.db;
  if (!db) return [];
  const items = [];
  try {
    const rows = db.prepare(
      "SELECT request_id, state, record, updated_at FROM cp_zero_setup_requests WHERE state IN ('blocked','WAIT','wait') ORDER BY updated_at DESC LIMIT ?"
    ).all(Math.min(50, Math.max(1, limit)));
    for (const row of rows) {
      let record = {};
      try { record = JSON.parse(row.record); } catch { record = {}; }
      const codes = Array.isArray(record.blockers) ? record.blockers
        : (record.presentation?.status ? [record.presentation.status] : [row.state]);
      const annotated = annotateBlockers(codes);
      items.push({
        kind: 'request',
        request_id: row.request_id,
        mission_id: record.mission_id || null,
        state: row.state,
        project_id: record.project_id || null,
        blockers: annotated,
        next_safe_action: annotated[0]?.next_safe_action || null,
        updated_at: row.updated_at,
        authority: false,
      });
    }
  } catch { /* optional */ }
  try {
    const missions = db.prepare(
      "SELECT id, state, reason, project_id, envelope, updated_at FROM cp_missions WHERE state IN ('blocked','needs_rework') ORDER BY updated_at DESC LIMIT ?"
    ).all(Math.min(50, Math.max(1, limit)));
    for (const row of missions) {
      let envelope = {};
      try { envelope = JSON.parse(row.envelope); } catch { envelope = {}; }
      const reason = row.reason || envelope.block_reason || envelope.reason || row.state;
      const annotated = annotateBlockers([reason]);
      items.push({
        kind: 'mission',
        request_id: envelope.cognitive_request_id || envelope.request_id || null,
        mission_id: row.id,
        state: row.state,
        blockers: annotated,
        next_safe_action: annotated[0]?.next_safe_action || null,
        project_id: row.project_id || envelope.project_id || null,
        updated_at: row.updated_at,
        authority: false,
      });
    }
  } catch { /* optional */ }
  return items.sort((a, b) => b.updated_at - a.updated_at).slice(0, limit);
}

/**
 * Read-only live diagnostic combining static registry + authoritative host state.
 * Never fabricates counts; missing sources are reported unavailable.
 */
function diagnostics(bridge, filters = {}) {
  const registry = loadRegistry();
  const da = developerAutonomyLive(bridge, { policy_id: filters.policy_id || null });
  const cursor = cursorLive(bridge);
  const missions = missionCounts(bridge);
  const observed = observedBlockers(bridge, { limit: 50 }).filter(item =>
    (!filters.project_id || item.project_id === filters.project_id)
    && filterEntries(item.blockers, filters).length > 0
  ).slice(0, filters.limit || 20);
  const definitions = filterEntries(registry.entries.map(e => ({
    id: e.id,
    category: e.category,
    severity: e.severity,
    automatic_recovery_allowed: e.automatic_recovery_allowed,
    owner_approval_required: e.owner_approval_required,
    security_critical: e.security_critical,
    description: e.description,
    codes: e.codes,
    historical_status: e.historical_status,
    authority: false,
  })), filters);

  const text = renderText({ da, cursor, missions, observed });

  return {
    schema_version: 1,
    registry_id: registry.id,
    registry_version: registry.version,
    generated_at: Date.now(),
    text,
    developer_autonomy: da,
    cursor,
    missions,
    observed_blockers: observed,
    definitions: {
      count: definitions.length,
      category_counts: Object.fromEntries(CATEGORIES.map(c => [c, definitions.filter(d => d.category === c).length])),
      items: definitions,
    },
    filters: {
      category: filters.category || null,
      severity: filters.severity || null,
      recoverability: filters.recoverability || null,
      policy_id: filters.policy_id || null,
      project_id: filters.project_id || null,
    },
    note: 'Live counters come from authoritative host state. Unknown codes are reported as unknown_blocker. Automatic recovery never runs from this read-only view.',
    authority: false,
  };
}

function renderText({ da, cursor, missions, observed }) {
  const lines = ['AIRODROM LIMITS & BLOCKERS', ''];
  lines.push('Developer Autonomy');
  if (!da?.available) {
    lines.push('  Status:           Unavailable');
  } else if (!(da.policies || []).length) {
    lines.push('  Active policies:  0');
  } else {
    for (const p of da.policies) {
      const label = p.alias || p.policy_id.slice(0, 8);
      lines.push('  Policy:           ' + label);
      if (p.worktrees.occupied != null && p.worktrees.limit != null) {
        lines.push('  Worktrees:        ' + p.worktrees.occupied + ' / ' + p.worktrees.limit + ' occupied'
          + (p.worktrees.exhausted ? ' (EXHAUSTED)' : ''));
      } else {
        lines.push('  Worktrees:        Unavailable');
      }
      lines.push('  Disk:             ' + (p.disk.state === 'healthy' ? 'Healthy'
        : p.disk.state === 'exhausted' ? 'Exhausted' : 'Unknown'));
      lines.push('  Active grants:    ' + (p.grants?.active ?? 'Unavailable'));
      lines.push('  Expired grants:   ' + (p.grants?.expired ?? 'Unavailable'));
    }
  }
  lines.push('');
  lines.push('Cursor');
  lines.push('  Runtime:          ' + String(cursor.runtime || 'unavailable'));
  lines.push('  Standing grant:   ' + String(cursor.standing_grant || 'unavailable'));
  lines.push('  Spend admission:  ' + String(cursor.spend_admission || 'unavailable'));
  lines.push('');
  lines.push('Missions');
  if (!missions) {
    lines.push('  Counts:           Unavailable');
  } else {
    lines.push('  Running:          ' + missions.running);
    lines.push('  Blocked:          ' + missions.blocked);
    lines.push('  Pending repair:   ' + missions.needs_rework);
  }
  if (observed?.length) {
    lines.push('');
    lines.push('Observed blockers');
    for (const item of observed.slice(0, 8)) {
      const id = item.mission_id || item.request_id || 'unknown';
      const code = item.blockers?.[0]?.registry_id || item.blockers?.[0]?.code || item.state;
      lines.push('  - ' + id.slice(0, 36) + ': ' + code);
    }
  }
  return lines.join('\n');
}

/**
 * Attach registry annotations for a blocked Mission or pre-Mission request.
 * Does not mutate durable state by itself; callers persist as needed.
 */
function reportForBlock(bridge, { codes, request_id = null, mission_id = null, live = true } = {}) {
  const annotated = annotateBlockers(codes);
  const primary = annotated[0] || annotateBlockers(['unknown'])[0];
  let authoritative = null;
  if (live && bridge) {
    try {
      const snap = diagnostics(bridge, {});
      authoritative = {
        worktrees: (snap.developer_autonomy?.policies || []).map(p => ({
          policy_id: p.policy_id,
          occupied: p.worktrees.occupied,
          limit: p.worktrees.limit,
          exhausted: p.worktrees.exhausted,
        })),
        cursor: snap.cursor,
        missions: snap.missions,
      };
    } catch {
      authoritative = null;
    }
  }
  return {
    request_id,
    mission_id,
    blockers: annotated,
    primary_registry_id: primary.registry_id,
    enforcement: primary.enforcement,
    next_safe_action: primary.next_safe_action,
    automatic_recovery_allowed: annotated.length > 0
      && annotated.every(a => a.automatic_recovery_allowed)
      && !annotated.some(a => a.security_critical),
    owner_approval_required: annotated.some(a => a.owner_approval_required),
    security_critical: annotated.some(a => a.security_critical),
    authoritative_state: authoritative,
    authority: false,
  };
}

/**
 * Perform recovery only when an existing host-authorized operation already permits
 * it and required evidence is present. Never deletes protected work.
 * Delegates to the registry-driven recovery dispatcher (all registered blockers).
 */
function attemptAuthorizedRecovery(bridge, report, owner = 'operator') {
  if (!bridge || !report) {
    return { performed: false, reason: 'missing_context', authority: false };
  }
  try {
    const codes = (report.blockers || []).map(b => b.code || b.registry_id).filter(Boolean);
    const dispatched = require('./limits-blockers-recovery').dispatch(bridge, {
      codes: codes.length ? codes : [report.primary_registry_id || 'unknown'],
      request_id: report.request_id || null,
      mission_id: report.mission_id || null,
      owner,
    });
    return {
      performed: !!dispatched.recovery?.performed,
      operation: dispatched.recovery?.operation || null,
      recovery_receipt: dispatched.recovery_receipt || null,
      owner_gate: dispatched.owner_gate || null,
      verification: dispatched.verification || null,
      next_safe_action: dispatched.next_safe_action || report.next_safe_action,
      authority: false,
    };
  } catch (error) {
    return { performed: false, reason: String(error.message || error).slice(0, 200), authority: false };
  }
}

function list(filters = {}) {
  const registry = loadRegistry();
  return {
    registry_id: registry.id,
    version: registry.version,
    items: filterEntries(registry.entries, filters),
    authority: false,
  };
}

module.exports = {
  REGISTRY_PATH,
  loadRegistry,
  resolve,
  annotateBlockers,
  validateAgainstSource,
  diagnostics,
  reportForBlock,
  attemptAuthorizedRecovery,
  list,
  unknownEntry,
};
