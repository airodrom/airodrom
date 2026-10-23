'use strict';
/**
 * Host Execution Policy V1 — Local-First Autopilot.
 *
 * Cursor adapter code and historical Milestone B evidence remain installed.
 * When cursor_execution_disabled=1, Airodrom never selects, grants, or
 * dispatches paid Cursor workers. An external Cursor subscription (if any)
 * is unchanged; this policy only governs Airodrom-initiated execution.
 *
 * Defaults to Cursor disabled. Re-enable requires authenticated operator
 * confirmation, or an owner-enrolled, revocable MCP delegation that covers
 * exactly enable/disable of this host preference. Chat text alone never
 * enrolls that delegation.
 *
 * Standing Cursor development grants (owner-enrolled, revocable, finite) may
 * cover routine subscription + scoped disclosure for an approved repository so
 * eligible cognitive Missions do not wait for per-Mission spend confirmation.
 * Paid overages, unapproved repos, private data, and production remain outside.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { object, identifier } = require('./control-plane-store');
const { canonicalHash } = require('./authority-hash');

const CODE = 'CURSOR_EXECUTION_DISABLED';
const OPS = Object.freeze(['enable_cursor', 'disable_cursor']);
const SCOPE = 'authenticated_mcp';
const NOTE_DISABLED =
  'Cursor execution is disabled in Airodrom. Local OpenCode remains the default worker. '
  + 'This does not cancel any external Cursor subscription. Re-enable only from the authenticated Terminal or Control Center, or via an owner-enrolled ChatGPT MCP delegation.';
const NOTE_ENABLED =
  'Cursor execution is enabled in Airodrom. Standing Cursor development grants may cover routine spend/disclosure for enrolled repositories; otherwise subscription and disclosure grants still apply before paid dispatch.';
const STANDING_MAX_MISSIONS = 100;
const STANDING_MAX_INVOCATIONS = 6;
const STANDING_MAX_RUNTIME_MS = 120000;
const STANDING_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function mcpPrincipal(principal) {
  return typeof principal === 'string' && /^mcp:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal);
}

class HostExecutionPolicy {
  constructor(bridge) {
    this.bridge = bridge;
    this.db = bridge.controlStore.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cp_host_execution_policy(
        id INTEGER PRIMARY KEY CHECK(id=1),
        cursor_execution_disabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT,
        request_id TEXT,
        note TEXT NOT NULL
      );
      INSERT OR IGNORE INTO cp_host_execution_policy(id,cursor_execution_disabled,updated_at,note)
        VALUES(1,1,0,'${NOTE_DISABLED.replace(/'/g, "''")}');
      CREATE TABLE IF NOT EXISTS cp_host_execution_mcp_delegation(
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        operations TEXT NOT NULL,
        state TEXT NOT NULL,
        enrolled_at INTEGER NOT NULL,
        enrolled_by TEXT NOT NULL,
        enroll_request_id TEXT NOT NULL,
        revoked_at INTEGER,
        revoked_by TEXT,
        revoke_request_id TEXT,
        expires_at INTEGER,
        note TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cp_host_exec_mcp_deleg_state ON cp_host_execution_mcp_delegation(state, enrolled_at DESC);
      CREATE TABLE IF NOT EXISTS cp_standing_cursor_development(
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        policy_id TEXT,
        state TEXT NOT NULL,
        enrolled_at INTEGER NOT NULL,
        enrolled_by TEXT NOT NULL,
        enroll_request_id TEXT NOT NULL,
        revoked_at INTEGER,
        revoked_by TEXT,
        revoke_request_id TEXT,
        expires_at INTEGER NOT NULL,
        acknowledge_unknown_cost INTEGER NOT NULL,
        max_invocations_per_mission INTEGER NOT NULL,
        max_runtime_ms INTEGER NOT NULL,
        max_missions INTEGER NOT NULL,
        missions_used INTEGER NOT NULL,
        path_allowlist TEXT NOT NULL,
        disclosure_providers TEXT NOT NULL,
        data_classes TEXT NOT NULL,
        seal TEXT,
        note TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cp_standing_cursor_dev_repo
        ON cp_standing_cursor_development(repository, state, enrolled_at DESC);
    `);
    // Existing installs created before this table: prefer local-first default.
    const row = this.row();
    if (row && row.updated_at === 0 && row.cursor_execution_disabled !== 1) {
      this.db.prepare('UPDATE cp_host_execution_policy SET cursor_execution_disabled=1, note=?, updated_at=? WHERE id=1')
        .run(NOTE_DISABLED, Date.now());
    }
  }

  row() {
    return this.db.prepare('SELECT * FROM cp_host_execution_policy WHERE id=1').get();
  }

  cursorDisabled() {
    return this.row()?.cursor_execution_disabled === 1;
  }

  assertCursorAllowed(action = 'dispatch') {
    if (this.cursorDisabled()) {
      const error = Error(CODE);
      error.code = CODE;
      error.action = action;
      error.note = NOTE_DISABLED;
      throw error;
    }
  }

  activeDelegation() {
    const row = this.db.prepare(
      "SELECT * FROM cp_host_execution_mcp_delegation WHERE state='active' ORDER BY enrolled_at DESC LIMIT 1"
    ).get();
    if (!row) return null;
    if (row.expires_at && row.expires_at <= Date.now()) return null;
    let operations;
    try { operations = JSON.parse(row.operations); } catch { return null; }
    if (!Array.isArray(operations) || !OPS.every(op => operations.includes(op))) return null;
    if (row.scope !== SCOPE) return null;
    return { ...row, operations };
  }

  delegationView(delegation = this.activeDelegation()) {
    if (!delegation) {
      return {
        enrolled: false,
        state: 'absent',
        scope: SCOPE,
        operations: [...OPS],
        next_action: 'enroll_mcp_delegation_via_authenticated_local_api',
        note: 'Owner must enroll ChatGPT MCP host-execution control once from Terminal or Control Center. Chat text cannot enroll it.',
      };
    }
    return {
      enrolled: true,
      state: delegation.state,
      id: delegation.id,
      scope: delegation.scope,
      operations: delegation.operations,
      enrolled_at: delegation.enrolled_at,
      enrolled_by: delegation.enrolled_by,
      expires_at: delegation.expires_at || null,
      next_action: null,
      note: delegation.note,
    };
  }

  standingRows(repository = null) {
    const now = Date.now();
    const rows = repository
      ? this.db.prepare(
        "SELECT * FROM cp_standing_cursor_development WHERE repository=? AND state='active' ORDER BY enrolled_at DESC"
      ).all(repository)
      : this.db.prepare(
        "SELECT * FROM cp_standing_cursor_development WHERE state='active' ORDER BY enrolled_at DESC"
      ).all();
    return rows.filter(row => row.expires_at > now && row.missions_used < row.max_missions);
  }

  /** All standing rows for a repository (any state), newest first — diagnosis only. */
  standingRowsHistory(repository) {
    let root;
    try { root = fs.realpathSync(repository); } catch { return []; }
    return this.db.prepare(
      'SELECT * FROM cp_standing_cursor_development WHERE repository=? ORDER BY enrolled_at DESC'
    ).all(root);
  }

  standingView(row) {
    if (!row) return null;
    let path_allowlist = [], disclosure_providers = [], data_classes = [];
    try { path_allowlist = JSON.parse(row.path_allowlist); } catch { /* ignore */ }
    try { disclosure_providers = JSON.parse(row.disclosure_providers); } catch { /* ignore */ }
    try { data_classes = JSON.parse(row.data_classes); } catch { /* ignore */ }
    const expired = row.expires_at <= Date.now();
    const exhausted = row.missions_used >= row.max_missions;
    return {
      id: row.id,
      repository: row.repository,
      policy_id: row.policy_id || null,
      state: row.state === 'active' && (expired || exhausted) ? (expired ? 'expired' : 'exhausted') : row.state,
      enrolled_at: row.enrolled_at,
      expires_at: row.expires_at,
      acknowledge_unknown_cost: row.acknowledge_unknown_cost === 1,
      max_invocations_per_mission: row.max_invocations_per_mission,
      max_runtime_ms: row.max_runtime_ms,
      max_missions: row.max_missions,
      missions_used: row.missions_used,
      missions_remaining: Math.max(0, row.max_missions - row.missions_used),
      path_allowlist,
      disclosure_providers,
      data_classes,
      sealed: !!row.seal,
      note: row.note,
      authority: false,
    };
  }

  /** Persisted preference + delegation enrollment. Safe for authenticated MCP reads. */
  snapshot() {
    const r = this.row();
    return {
      version: 1,
      cursor_execution_disabled: r.cursor_execution_disabled === 1,
      updated_at: r.updated_at || null,
      updated_by: r.updated_by || null,
      request_id: r.request_id || null,
      note: r.note || (r.cursor_execution_disabled === 1 ? NOTE_DISABLED : NOTE_ENABLED),
      external_subscription: 'unaffected',
      reactivation: 'Authenticated operator POST /api/assistant/host-execution-policy/enable-cursor with confirmed=true, or delegated MCP enable_cursor_execution after owner enrollment',
      mcp_delegation: this.delegationView(),
      standing_cursor_development: this.standingRows().map(row => this.standingView(row)),
      authority: false
    };
  }

  status(actor = 'operator') {
    if (actor !== 'operator' && !mcpPrincipal(actor)) {
      throw Error('Only authenticated operator or MCP handoff caller may inspect host execution policy');
    }
    return this.snapshot();
  }

  mcpMayControl(principal, operation) {
    if (!mcpPrincipal(principal) || !OPS.includes(operation)) return false;
    const d = this.activeDelegation();
    return !!(d && d.operations.includes(operation));
  }

  enrollMcpDelegation(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may enroll MCP host-execution delegation');
    object(input, ['confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    const existing = this.activeDelegation();
    if (existing) {
      return {
        ...this.status(owner),
        mcp_delegation: this.delegationView(existing),
        duplicate: true,
        message: 'Existing owner-approved MCP delegation already authorizes enable/disable of Cursor host execution policy.',
      };
    }
    const expiresAt = input.expires_at == null ? null : Number(input.expires_at);
    if (expiresAt != null && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())) {
      throw Error('Delegation expiry must be a future epoch millis or omitted');
    }
    const id = randomUUID();
    const now = Date.now();
    const note = 'Owner-enrolled ChatGPT MCP may enable or disable Cursor host execution policy while this delegation remains active. Spend and disclosure stay separately gated.';
    this.db.prepare(
      `INSERT INTO cp_host_execution_mcp_delegation(
        id, scope, operations, state, enrolled_at, enrolled_by, enroll_request_id, revoked_at, revoked_by, revoke_request_id, expires_at, note
      ) VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)`
    ).run(id, SCOPE, JSON.stringify([...OPS]), 'active', now, owner, input.request_id, expiresAt, note);
    this.bridge.controlStore.event('host_execution_policy.mcp_delegation_enrolled', null, {
      request_id: input.request_id, delegation_id: id, scope: SCOPE, operations: [...OPS], authority: false
    });
    this.bridge.emit?.('change');
    return this.status(owner);
  }

  revokeMcpDelegation(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may revoke MCP host-execution delegation');
    object(input, ['confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    const existing = this.activeDelegation();
    if (!existing) return this.status(owner);
    const now = Date.now();
    this.db.prepare(
      `UPDATE cp_host_execution_mcp_delegation SET state='revoked', revoked_at=?, revoked_by=?, revoke_request_id=? WHERE id=? AND state='active'`
    ).run(now, owner, input.request_id, existing.id);
    this.bridge.controlStore.event('host_execution_policy.mcp_delegation_revoked', null, {
      request_id: input.request_id, delegation_id: existing.id, authority: false
    });
    this.bridge.emit?.('change');
    return this.status(owner);
  }

  disableCursor(input, actor = 'operator') {
    return this._setDisabled(true, input, actor, 'disable_cursor');
  }

  enableCursor(input, actor = 'operator') {
    return this._setDisabled(false, input, actor, 'enable_cursor');
  }

  _setDisabled(disabled, input, actor, operation) {
    object(input, ['confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit confirmation required');
    identifier(input.request_id);
    if (actor === 'operator') {
      /* owner path */
    } else if (mcpPrincipal(actor) && this.mcpMayControl(actor, operation)) {
      /* delegated MCP path */
    } else if (mcpPrincipal(actor)) {
      throw Error('MCP host-execution delegation required');
    } else {
      throw Error('Only authenticated local owner may change Cursor execution');
    }
    const apply = () => {
      const now = Date.now();
      const note = disabled ? NOTE_DISABLED : NOTE_ENABLED;
      this.db.prepare(
        `UPDATE cp_host_execution_policy SET cursor_execution_disabled=?, updated_at=?, updated_by=?, request_id=?, note=? WHERE id=1`
      ).run(disabled ? 1 : 0, now, actor, input.request_id, note);
      this.bridge.controlStore.event(
        disabled ? 'host_execution_policy.cursor_disabled' : 'host_execution_policy.cursor_enabled',
        null,
        {
          request_id: input.request_id,
          actor,
          via: actor === 'operator' ? 'owner' : 'mcp_delegation',
          external_subscription: 'unaffected',
          authority: false
        }
      );
      this.bridge.emit?.('change');
      return this.status(actor === 'operator' ? 'operator' : actor);
    };
    if (actor === 'operator') return apply();
    return this.bridge.controlStore.request(actor, input.request_id, { op: 'host_execution_' + operation }, apply);
  }

  /**
   * Owner enrolls a finite, revocable standing Cursor development grant for one
   * repository. Chat/MCP text cannot enroll it. Host Cursor must already be enabled.
   */
  enrollStandingCursorDevelopment(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may enroll standing Cursor development');
    object(input, [
      'confirmed', 'request_id', 'repository', 'acknowledge_unknown_cost',
      'max_invocations_per_mission', 'max_runtime_ms', 'max_missions', 'path_allowlist',
      'policy_id', 'expires_at', 'ttl_ms'
    ]);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    if (input.acknowledge_unknown_cost !== true) throw Error('Standing Cursor development requires acknowledge_unknown_cost');
    if (this.cursorDisabled()) throw Error(CODE);
    const repository = fs.realpathSync(String(input.repository || ''));
    if (!fs.lstatSync(repository).isDirectory()) throw Error('Standing Cursor development requires a repository directory');
    if (input.policy_id !== undefined) {
      identifier(input.policy_id);
      const policy = this.bridge.developerAutonomy?.inspect?.(input.policy_id);
      if (!policy || policy.state !== 'active') throw Error('Active Developer Autonomy policy required');
      if (fs.realpathSync(policy.repository) !== repository) throw Error('Standing grant repository must match the DA policy repository');
      if (!Array.isArray(policy.workers) || !policy.workers.includes('cursor')) {
        throw Error('Developer Autonomy policy must include cursor on the worker allowlist');
      }
    }
    const paths = Array.isArray(input.path_allowlist) ? input.path_allowlist : [];
    if (!paths.length || paths.length > 16) throw Error('Standing Cursor development requires 1–16 relative path allowlist entries');
    for (const file of paths) {
      if (typeof file !== 'string' || !file || file.includes('\\') || file.startsWith('/') || file.includes('\0') || file.includes('..')) {
        throw Error('Standing path allowlist entries must be relative repository paths');
      }
    }
    const maxInv = Number(input.max_invocations_per_mission);
    const maxRuntime = Number(input.max_runtime_ms);
    const maxMissions = Number(input.max_missions);
    if (!Number.isSafeInteger(maxInv) || maxInv < 1 || maxInv > STANDING_MAX_INVOCATIONS) {
      throw Error('max_invocations_per_mission must be between 1 and ' + STANDING_MAX_INVOCATIONS);
    }
    if (!Number.isSafeInteger(maxRuntime) || maxRuntime < 1000 || maxRuntime > STANDING_MAX_RUNTIME_MS) {
      throw Error('max_runtime_ms must be between 1000 and ' + STANDING_MAX_RUNTIME_MS);
    }
    if (!Number.isSafeInteger(maxMissions) || maxMissions < 1 || maxMissions > STANDING_MAX_MISSIONS) {
      throw Error('max_missions must be between 1 and ' + STANDING_MAX_MISSIONS);
    }
    const now = Date.now();
    let expiresAt = input.expires_at == null ? null : Number(input.expires_at);
    if (expiresAt == null) {
      const ttl = input.ttl_ms == null ? STANDING_MAX_TTL_MS : Number(input.ttl_ms);
      if (!Number.isSafeInteger(ttl) || ttl < 3600000 || ttl > STANDING_MAX_TTL_MS) {
        throw Error('Standing grant ttl_ms must be between one hour and 90 days');
      }
      expiresAt = now + ttl;
    }
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw Error('Standing grant expiry must be a future epoch millis');
    if (expiresAt - now > STANDING_MAX_TTL_MS) throw Error('Standing grant TTL cannot exceed 90 days');

    const existing = this.standingRows(repository)[0];
    if (existing) {
      return {
        ...this.status(owner),
        standing_cursor_development_active: this.standingView(existing),
        duplicate: true,
        message: 'An active standing Cursor development grant already covers this repository.',
      };
    }

    const id = randomUUID();
    const body = {
      version: 1, id, repository, policy_id: input.policy_id || null,
      acknowledge_unknown_cost: true, max_invocations_per_mission: maxInv,
      max_runtime_ms: maxRuntime, max_missions: maxMissions,
      path_allowlist: [...paths].sort(), disclosure_providers: ['cursor'], data_classes: ['public'],
      expires_at: expiresAt,
    };
    const seal = this.bridge.missionAuthority?.sealManifest?.({
      mission_id: 'standing-cursor-development:' + id,
      manifest_hash: canonicalHash(body),
    }) || null;
    if (this.bridge.missionAuthority && !seal) throw Error('Existing operator signing authority required');
    const note = input.policy_id
      ? ('Owner-enrolled standing Cursor development bound to Developer Autonomy policy '
        + input.policy_id + ' for routine public paths in this repository. '
        + 'Eligible cognitive Cursor Missions reuse this grant without per-Mission spend confirmation. '
        + 'UNKNOWN_SUBSCRIPTION cost remains acknowledged and unobservable. '
        + 'Paid overages, private data, production, credentials, and cross-repository work stay outside.')
      : ('Owner-enrolled standing Cursor development for routine public paths in this repository. '
        + 'UNKNOWN_SUBSCRIPTION cost remains acknowledged and unobservable. Paid overages, private data, and production stay outside.');
    this.db.prepare(
      `INSERT INTO cp_standing_cursor_development(
        id, repository, policy_id, state, enrolled_at, enrolled_by, enroll_request_id,
        revoked_at, revoked_by, revoke_request_id, expires_at, acknowledge_unknown_cost,
        max_invocations_per_mission, max_runtime_ms, max_missions, missions_used,
        path_allowlist, disclosure_providers, data_classes, seal, note
      ) VALUES(?,?,?,'active',?,?,?,NULL,NULL,NULL,?,1,?,?,?,0,?,?,?,?,?)`
    ).run(
      id, repository, input.policy_id || null, now, owner, input.request_id, expiresAt,
      maxInv, maxRuntime, maxMissions,
      JSON.stringify(body.path_allowlist), JSON.stringify(body.disclosure_providers),
      JSON.stringify(body.data_classes), seal ? JSON.stringify(seal) : null, note
    );
    this.bridge.controlStore.event('host_execution_policy.standing_cursor_development_enrolled', null, {
      request_id: input.request_id, grant_id: id, repository_basename: path.basename(repository),
      max_missions: maxMissions, max_invocations_per_mission: maxInv, authority: false
    });
    this.bridge.emit?.('change');
    return {
      ...this.status(owner),
      standing_cursor_development_active: this.standingView(this.db.prepare('SELECT * FROM cp_standing_cursor_development WHERE id=?').get(id)),
      message: 'Standing Cursor development enrolled. Eligible cognitive Cursor Missions for this repository may proceed without per-Mission spend confirmation while the grant remains active.',
    };
  }

  revokeStandingCursorDevelopment(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may revoke standing Cursor development');
    object(input, ['confirmed', 'request_id', 'grant_id', 'repository']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    let row = null;
    if (input.grant_id !== undefined) {
      identifier(input.grant_id);
      row = this.db.prepare("SELECT * FROM cp_standing_cursor_development WHERE id=? AND state='active'").get(input.grant_id);
    } else if (input.repository !== undefined) {
      const repository = fs.realpathSync(String(input.repository));
      row = this.standingRows(repository)[0] || null;
    } else {
      throw Error('grant_id or repository required');
    }
    if (!row) return this.status(owner);
    const now = Date.now();
    this.db.prepare(
      `UPDATE cp_standing_cursor_development SET state='revoked', revoked_at=?, revoked_by=?, revoke_request_id=? WHERE id=? AND state='active'`
    ).run(now, owner, input.request_id, row.id);
    this.bridge.controlStore.event('host_execution_policy.standing_cursor_development_revoked', null, {
      request_id: input.request_id, grant_id: row.id, authority: false
    });
    this.bridge.emit?.('change');
    return this.status(owner);
  }

  /**
   * Raise-only finite runtime ceiling on an existing active standing Cursor grant.
   * Never lowers bounds, never widens path/repo/data-class, never invents a grant.
   * Used when Cursor multi-task assignments outlive an undersized 60s enrollment
   * while staying within STANDING_MAX_RUNTIME_MS.
   */
  raiseStandingCursorRuntimeCeiling(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may raise standing Cursor runtime');
    object(input, ['confirmed', 'request_id', 'grant_id', 'max_runtime_ms']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    identifier(input.grant_id);
    const maxRuntime = Number(input.max_runtime_ms);
    if (!Number.isSafeInteger(maxRuntime) || maxRuntime < 1000 || maxRuntime > STANDING_MAX_RUNTIME_MS) {
      throw Error('max_runtime_ms must be between 1000 and ' + STANDING_MAX_RUNTIME_MS);
    }
    const row = this.db.prepare("SELECT * FROM cp_standing_cursor_development WHERE id=? AND state='active'").get(input.grant_id);
    if (!row) throw Error('Active standing Cursor development grant required');
    if (maxRuntime < row.max_runtime_ms) {
      throw Error('Standing Cursor runtime ceiling is raise-only; requested value is below the current grant');
    }
    if (maxRuntime === row.max_runtime_ms) {
      return {
        ...this.status(owner),
        standing_cursor_development_active: this.standingView(row),
        raised: false,
        message: 'Standing Cursor runtime ceiling already at the requested value.',
      };
    }
    this.db.prepare(
      'UPDATE cp_standing_cursor_development SET max_runtime_ms=? WHERE id=? AND state=?'
    ).run(maxRuntime, row.id, 'active');
    this.bridge.controlStore.event('host_execution_policy.standing_cursor_runtime_raised', null, {
      request_id: input.request_id, grant_id: row.id,
      previous_max_runtime_ms: row.max_runtime_ms, max_runtime_ms: maxRuntime, authority: false,
    });
    this.bridge.emit?.('change');
    const updated = this.db.prepare('SELECT * FROM cp_standing_cursor_development WHERE id=?').get(row.id);
    return {
      ...this.status(owner),
      standing_cursor_development_active: this.standingView(updated),
      raised: true,
      message: 'Standing Cursor runtime ceiling raised. Path allowlist, repository binding, and spend acknowledgement are unchanged.',
    };
  }

  /**
   * When a sealed cognitive Cursor Mission fits an active standing grant, return
   * the finite subscription_execution bounds to auto-issue MissionApprovals.
   * Does not invent monetary caps; UNKNOWN_SUBSCRIPTION remains observational.
   * Grants bound to a Developer Autonomy policy_id only cover that policy;
   * unbound grants may cover any active DA on the same repository root.
   * Never transfers grants across repositories.
   */
  matchStandingCursorDevelopment({
    repository, files, max_invocations, max_runtime_ms, data_class = 'public', policy_id = null,
  } = {}) {
    if (this.cursorDisabled()) return null;
    if (!repository || !Array.isArray(files) || !files.length) return null;
    let root;
    try { root = fs.realpathSync(repository); } catch { return null; }
    if (data_class && data_class !== 'public') return null;
    const neededInv = Number(max_invocations);
    const neededRuntime = Number(max_runtime_ms);
    if (!Number.isSafeInteger(neededInv) || neededInv < 1) return null;
    if (!Number.isSafeInteger(neededRuntime) || neededRuntime < 1000) return null;
    if (policy_id != null) {
      try { identifier(policy_id); } catch { return null; }
    }
    const rows = this.standingRows(root);
    // Prefer an exact DA policy binding, then unbound same-repo grants.
    const ordered = policy_id
      ? [
        ...rows.filter(row => row.policy_id === policy_id),
        ...rows.filter(row => !row.policy_id),
      ]
      : rows;
    for (const row of ordered) {
      if (row.policy_id && policy_id && row.policy_id !== policy_id) continue;
      if (row.policy_id && !policy_id) continue;
      const view = this.standingView(row);
      if (!view || view.state !== 'active') continue;
      if (!view.acknowledge_unknown_cost) continue;
      if (!view.disclosure_providers.includes('cursor')) continue;
      if (!view.data_classes.includes('public')) continue;
      if (neededInv > view.max_invocations_per_mission) continue;
      if (neededRuntime > view.max_runtime_ms) continue;
      if (!files.every(file => view.path_allowlist.includes(file))) continue;
      return {
        id: view.id,
        policy_id: view.policy_id,
        repository: view.repository,
        subscription_execution: {
          provider: 'cursor',
          acknowledge_unknown_cost: true,
          max_invocations: neededInv,
          max_runtime_ms: neededRuntime,
        },
        disclosure: { authorized: true, providers: ['cursor'] },
        authority: false,
      };
    }
    return null;
  }

  /**
   * Fail-closed diagnosis when matchStandingCursorDevelopment returns null.
   * Exact actionable codes for expired, revoked, exhausted, mismatched, or missing grants.
   */
  diagnoseStandingCursorDevelopment({
    repository, files, max_invocations, max_runtime_ms, data_class = 'public', policy_id = null,
  } = {}) {
    if (this.cursorDisabled()) {
      return {
        matched: false,
        code: 'CURSOR_EXECUTION_DISABLED',
        reason: 'Cursor execution is disabled in Airodrom. Re-enable from the authenticated Terminal or Control Center, or use local OpenCode only.',
        next_action: 'enable_cursor_via_authenticated_local_api_or_use_local_opencode',
        authority: false,
      };
    }
    const hit = this.matchStandingCursorDevelopment({
      repository, files, max_invocations, max_runtime_ms, data_class, policy_id,
    });
    if (hit) {
      return {
        matched: true,
        code: null,
        grant_id: hit.id,
        policy_id: hit.policy_id || null,
        reason: 'Standing Cursor development grant covers disclosure and subscription bounds',
        authority: false,
      };
    }
    if (!repository) {
      return {
        matched: false,
        code: 'STANDING_CURSOR_GRANT_MISSING',
        reason: 'No repository was bound for standing Cursor grant matching.',
        next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
        authority: false,
      };
    }
    let root;
    try { root = fs.realpathSync(repository); } catch {
      return {
        matched: false,
        code: 'STANDING_CURSOR_GRANT_MISSING',
        reason: 'Repository path is not resolvable for standing Cursor grant matching.',
        next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
        authority: false,
      };
    }
    if (data_class && data_class !== 'public') {
      return {
        matched: false,
        code: 'STANDING_CURSOR_GRANT_DATA_CLASS_MISMATCH',
        reason: 'Standing Cursor development covers public paths only. Private or sensitive data classes require a separate owner authorization.',
        next_action: 'authorize_cursor_via_authenticated_local_api',
        authority: false,
      };
    }
    const history = this.standingRowsHistory(root);
    if (!history.length) {
      return {
        matched: false,
        code: 'STANDING_CURSOR_GRANT_MISSING',
        reason: 'No owner-enrolled standing Cursor development grant exists for this repository. '
          + 'Developer Autonomy Cursor on the worker allowlist is not a spend/disclosure grant. '
          + 'Enroll once via POST /api/assistant/host-execution-policy/enroll-standing-cursor-development with confirmed=true.',
        next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
        authority: false,
      };
    }
    const neededInv = Number(max_invocations);
    const neededRuntime = Number(max_runtime_ms);
    const fileList = Array.isArray(files) ? files : [];
    const active = this.standingRows(root);
    const candidates = policy_id
      ? [
        ...active.filter(row => row.policy_id === policy_id),
        ...active.filter(row => !row.policy_id),
        ...active.filter(row => row.policy_id && row.policy_id !== policy_id),
      ]
      : active;
    for (const row of candidates) {
      const view = this.standingView(row);
      if (!view || view.state !== 'active') continue;
      if (view.policy_id && policy_id && view.policy_id !== policy_id) {
        return {
          matched: false, code: 'STANDING_CURSOR_GRANT_POLICY_MISMATCH', grant_id: view.id,
          reason: 'Standing Cursor grant is bound to a different Developer Autonomy policy. '
            + 'Enroll a grant for policy ' + policy_id + ' on this repository; grants never transfer across projects.',
          next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
          authority: false,
        };
      }
      if (view.policy_id && !policy_id) {
        return {
          matched: false, code: 'STANDING_CURSOR_GRANT_POLICY_MISMATCH', grant_id: view.id,
          reason: 'Standing Cursor grant requires the matching Developer Autonomy policy_id on the Mission.',
          next_action: 'inspect_enrollment_and_prepare_new_request',
          authority: false,
        };
      }
      if (Number.isSafeInteger(neededInv) && neededInv > view.max_invocations_per_mission) {
        return {
          matched: false, code: 'STANDING_CURSOR_GRANT_INVOCATION_LIMIT', grant_id: view.id,
          reason: 'Requested Cursor invocations (' + neededInv + ') exceed standing grant max_invocations_per_mission ('
            + view.max_invocations_per_mission + '). Narrow the Mission or re-enroll with a higher finite limit (max '
            + STANDING_MAX_INVOCATIONS + ').',
          next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
          authority: false,
        };
      }
      if (Number.isSafeInteger(neededRuntime) && neededRuntime > view.max_runtime_ms) {
        return {
          matched: false, code: 'STANDING_CURSOR_GRANT_RUNTIME_LIMIT', grant_id: view.id,
          reason: 'Requested Cursor runtime (' + neededRuntime + ' ms) exceeds standing grant max_runtime_ms ('
            + view.max_runtime_ms + '). Lower cognitive execution_ms or re-enroll with a higher finite ceiling (max '
            + STANDING_MAX_RUNTIME_MS + ' ms).',
          next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
          authority: false,
        };
      }
      const missing = fileList.filter(file => !view.path_allowlist.includes(file));
      if (missing.length) {
        return {
          matched: false, code: 'STANDING_CURSOR_GRANT_PATH_MISMATCH', grant_id: view.id,
          reason: 'Proposed files are outside the standing Cursor path allowlist: '
            + missing.slice(0, 8).join(', ')
            + '. Re-enroll with those relative paths (typically the DA cognitive discovery set) or narrow the plan.',
          next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
          authority: false,
        };
      }
    }
    for (const row of history) {
      const view = this.standingView(row);
      if (!view) continue;
      if (view.state === 'revoked') {
        return {
          matched: false, code: 'STANDING_CURSOR_GRANT_REVOKED', grant_id: view.id,
          reason: 'Standing Cursor development grant was revoked. Re-enroll from the authenticated Terminal or Control Center for this repository.',
          next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
          authority: false,
        };
      }
      if (view.state === 'expired') {
        return {
          matched: false, code: 'STANDING_CURSOR_GRANT_EXPIRED', grant_id: view.id,
          reason: 'Standing Cursor development grant expired. Re-enroll with a fresh TTL for this repository and DA policy.',
          next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
          authority: false,
        };
      }
      if (view.state === 'exhausted') {
        return {
          matched: false, code: 'STANDING_CURSOR_GRANT_EXHAUSTED', grant_id: view.id,
          reason: 'Standing Cursor development grant mission budget is exhausted ('
            + view.missions_used + '/' + view.max_missions
            + '). Re-enroll with a new finite max_missions for this repository.',
          next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
          authority: false,
        };
      }
    }
    return {
      matched: false,
      code: 'STANDING_CURSOR_GRANT_MISMATCH',
      reason: 'An active standing Cursor grant exists for this repository but does not cover this Mission. '
        + 'Inspect path allowlist, policy_id, invocation/runtime ceilings, and remaining mission budget.',
      next_action: 'enroll_standing_cursor_development_via_authenticated_local_api',
      authority: false,
    };
  }

  consumeStandingCursorDevelopment(grantId, requestId) {
    identifier(grantId);
    identifier(requestId);
    const changed = this.db.prepare(
      `UPDATE cp_standing_cursor_development SET missions_used=missions_used+1
       WHERE id=? AND state='active' AND expires_at>? AND missions_used<max_missions`
    ).run(grantId, Date.now()).changes;
    if (changed !== 1) throw Error('Standing Cursor development grant unavailable');
    this.bridge.controlStore.event('host_execution_policy.standing_cursor_development_consumed', null, {
      grant_id: grantId, request_id: requestId, authority: false
    });
    return this.standingView(this.db.prepare('SELECT * FROM cp_standing_cursor_development WHERE id=?').get(grantId));
  }

  /**
   * MCP entry: mutate only when owner-enrolled delegation is active; otherwise WAIT.
   * Never enrolls from chat text.
   */
  mcpSetCursorDisabled(disabled, principal, requestId) {
    if (!mcpPrincipal(principal)) throw Error('Authenticated MCP handoff principal required');
    identifier(requestId);
    const operation = disabled ? 'disable_cursor' : 'enable_cursor';
    if (!this.mcpMayControl(principal, operation)) {
      return {
        state: 'WAIT',
        code: 'MCP_HOST_EXECUTION_DELEGATION_REQUIRED',
        message: 'Owner must enroll ChatGPT MCP host-execution delegation once via authenticated Terminal or Control Center before enable/disable. Chat text cannot grant that authority.',
        blockers: ['MCP_HOST_EXECUTION_DELEGATION_REQUIRED'],
        next_action: 'enroll_mcp_delegation_via_authenticated_local_api',
        cursor_execution_disabled: this.cursorDisabled(),
        mcp_delegation: this.delegationView(),
        authority: false,
      };
    }
    return this._setDisabled(disabled, { confirmed: true, request_id: requestId }, principal, operation);
  }
}

module.exports = { HostExecutionPolicy, CODE, NOTE_DISABLED, NOTE_ENABLED, OPS, SCOPE };
