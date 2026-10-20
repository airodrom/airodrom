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
 * confirmation. Model/MCP/browser text cannot flip this preference.
 */
const { object, identifier } = require('./control-plane-store');

const CODE = 'CURSOR_EXECUTION_DISABLED';
const NOTE_DISABLED =
  'Cursor execution is disabled in Airodrom. Local OpenCode remains the default worker. '
  + 'This does not cancel any external Cursor subscription. Re-enable only from the authenticated Terminal or Control Center.';
const NOTE_ENABLED =
  'Cursor execution is enabled in Airodrom. Subscription and disclosure grants still apply before any paid dispatch.';

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

  status(owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated operator may inspect host execution policy');
    const r = this.row();
    return {
      version: 1,
      cursor_execution_disabled: r.cursor_execution_disabled === 1,
      updated_at: r.updated_at || null,
      updated_by: r.updated_by || null,
      request_id: r.request_id || null,
      note: r.note || (r.cursor_execution_disabled === 1 ? NOTE_DISABLED : NOTE_ENABLED),
      external_subscription: 'unaffected',
      reactivation: 'Authenticated operator POST /api/assistant/host-execution-policy/enable-cursor with confirmed=true',
      authority: false
    };
  }

  disableCursor(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may disable Cursor execution');
    object(input, ['confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    const now = Date.now();
    this.db.prepare(`UPDATE cp_host_execution_policy SET cursor_execution_disabled=1, updated_at=?, updated_by=?, request_id=?, note=? WHERE id=1`)
      .run(now, owner, input.request_id, NOTE_DISABLED);
    this.bridge.controlStore.event('host_execution_policy.cursor_disabled', null, {
      request_id: input.request_id, external_subscription: 'unaffected', authority: false
    });
    this.bridge.emit?.('change');
    return this.status(owner);
  }

  enableCursor(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may enable Cursor execution');
    object(input, ['confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    const now = Date.now();
    this.db.prepare(`UPDATE cp_host_execution_policy SET cursor_execution_disabled=0, updated_at=?, updated_by=?, request_id=?, note=? WHERE id=1`)
      .run(now, owner, input.request_id, NOTE_ENABLED);
    this.bridge.controlStore.event('host_execution_policy.cursor_enabled', null, {
      request_id: input.request_id, authority: false
    });
    this.bridge.emit?.('change');
    return this.status(owner);
  }
}

module.exports = { HostExecutionPolicy, CODE, NOTE_DISABLED, NOTE_ENABLED };
