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
 * enrolls that delegation. Spend and disclosure grants remain separate.
 */
const { randomUUID } = require('node:crypto');
const { object, identifier } = require('./control-plane-store');

const CODE = 'CURSOR_EXECUTION_DISABLED';
const OPS = Object.freeze(['enable_cursor', 'disable_cursor']);
const SCOPE = 'authenticated_mcp';
const NOTE_DISABLED =
  'Cursor execution is disabled in Airodrom. Local OpenCode remains the default worker. '
  + 'This does not cancel any external Cursor subscription. Re-enable only from the authenticated Terminal or Control Center, or via an owner-enrolled ChatGPT MCP delegation.';
const NOTE_ENABLED =
  'Cursor execution is enabled in Airodrom. Subscription and disclosure grants still apply before any paid dispatch.';

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
