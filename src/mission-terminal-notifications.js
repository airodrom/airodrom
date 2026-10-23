'use strict';
// Event-driven terminal Mission notifications. Fired from Mission state
// transitions (not a poller). Delivery uses the durable effect outbox.
// ChatGPT unsolicited push is used only when chatgpt-trigger.json is present;
// otherwise notifications remain inbox-retrievable via MCP.
const { randomUUID } = require('node:crypto');
const { redactValue } = require('./control-plane-store');

const TERMINAL = Object.freeze({
  completed: 'ACCEPTED',
  blocked: 'BLOCKED',
  cancelled: 'CANCELLED',
  needs_rework: 'NEEDS_REWORK',
  waiting_for_operator: 'OWNER_ACTION_REQUIRED',
  awaiting_acceptance: 'OWNER_ACTION_REQUIRED',
});

const FAILED_STATES = new Set(['blocked', 'needs_rework']);

function statusFor(state, reason) {
  if (state === 'completed') return 'ACCEPTED';
  if (state === 'cancelled') return 'CANCELLED';
  if (state === 'blocked') return 'BLOCKED';
  if (state === 'needs_rework') return 'NEEDS_REWORK';
  if (state === 'waiting_for_operator' || state === 'awaiting_acceptance') return 'OWNER_ACTION_REQUIRED';
  if (FAILED_STATES.has(state)) return 'FAILED';
  return null;
}

function notificationsEnabled(bridge) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const home = require('./local-bootstrap').localHome();
    const file = path.join(home, 'local.json');
    if (fs.existsSync(file)) {
      const local = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (local?.mission_notifications?.enabled === false) return false;
    }
  } catch { /* preference optional; default on */ }
  return true;
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cp_mission_notifications(
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    state TEXT NOT NULL,
    summary TEXT NOT NULL,
    destination TEXT NOT NULL,
    outbox_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(mission_id, revision, status)
  );
  CREATE INDEX IF NOT EXISTS cp_mission_notifications_mission
    ON cp_mission_notifications(mission_id, created_at DESC);`);
}

function safeSummary(mission, status) {
  const reason = typeof mission.reason === 'string' ? mission.reason.slice(0, 180) : '';
  const objective = typeof mission.envelope?.objective === 'string'
    ? mission.envelope.objective.replace(/\s+/g, ' ').slice(0, 120) : 'Mission';
  const base = `Airodrom Mission ${status}: ${objective}`;
  return redactValue(reason ? `${base}. ${reason}` : base).slice(0, 400);
}

/**
 * Enqueue a duplicate-safe terminal notification. Never throws into Mission settlement.
 */
function onMissionState(bridge, mission, { previous, state } = {}) {
  try {
    if (!bridge?.controlStore || !mission?.id) return null;
    if (!notificationsEnabled(bridge)) return null;
    const status = statusFor(state || mission.state, mission.reason);
    if (!status) return null;
    if (previous && previous === state) return null;
    const store = bridge.controlStore;
    const db = store.db;
    ensureSchema(db);
    const revision = Number(mission.revision) || 0;
    const existing = db.prepare(
      'SELECT id, outbox_id, destination FROM cp_mission_notifications WHERE mission_id=? AND revision=? AND status=?'
    ).get(mission.id, revision, status);
    if (existing) return { duplicate: true, id: existing.id, destination: existing.destination, outbox_id: existing.outbox_id };

    const id = randomUUID();
    const summary = safeSummary(mission, status);
    const hasChatgptRoute = !!bridge.chatgptEvents?.route;
    const destination = hasChatgptRoute ? 'chatgpt_trigger' : 'mission_notification_inbox';
    const key = `mission-terminal:${mission.id}:${revision}:${status}`;
    let outboxId = null;
    if (store.outbox) {
      outboxId = store.outbox.enqueue({
        key,
        destination,
        ref: mission.id,
        eventType: 'mission.terminal_notification',
        correlation: { mission_id: mission.id, revision, status },
        payload: {
          notification_id: id,
          mission_id: mission.id,
          status,
          state: state || mission.state,
          summary,
          project_id: mission.project_id || null,
          repository_binding: mission.envelope?.cognitive?.envelope?.repository_id
            || mission.envelope?.repository_binding?.repository_id
            || null,
          authority: false,
          untrusted: false,
        },
      });
    }
    db.prepare(
      'INSERT INTO cp_mission_notifications(id,mission_id,revision,status,state,summary,destination,outbox_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(id, mission.id, revision, status, state || mission.state, summary, destination, outboxId, store.now());
    store.event('mission.terminal_notification_enqueued', mission.id, {
      notification_id: id, status, destination, authority: false,
    });
    return { duplicate: false, id, destination, outbox_id: outboxId, status };
  } catch {
    return null;
  }
}

function registerOutboxHandlers(bridge) {
  const store = bridge.controlStore;
  if (!store?.outbox) return;
  ensureSchema(store.db);
  store.outbox.register('mission_notification_inbox', (row) => {
    // Inbox destination is the durable cp_mission_notifications row already inserted.
    // Receipt proves the outbox cycle completed without mutating Mission state.
    return {
      local_receipt: row.event_key,
      notification_id: row.payload?.notification_id || null,
      destination: 'mission_notification_inbox',
      delivered_at: store.now(),
    };
  }, { idempotent: true });

  store.outbox.register('chatgpt_trigger', async (row) => {
    // Best-effort: publish a lifecycle-shaped event only when a ChatGPT route exists.
    // Failure stays in outbox retry; Mission settlement is unaffected.
    if (!bridge.chatgptEvents?.route) {
      return { local_receipt: row.event_key, destination: 'chatgpt_trigger', skipped: 'route_unavailable' };
    }
    const missionId = row.correlation?.mission_id || row.ref;
    const mission = store.getMission(missionId);
    const taskId = mission?.task_id;
    let task = null;
    try { task = taskId ? bridge.tasks.get(taskId) : null; } catch { task = null; }
    if (!task || task.source?.transport !== 'mcp') {
      return { local_receipt: row.event_key, destination: 'chatgpt_trigger', skipped: 'no_mcp_task' };
    }
    const type = row.payload?.status === 'ACCEPTED' ? 'completed'
      : row.payload?.status === 'OWNER_ACTION_REQUIRED' ? 'approval_required'
        : row.payload?.status === 'CANCELLED' ? 'blocked'
          : 'blocked';
    const receipt = bridge.chatgptEvents.publishLifecycle(task, type);
    return {
      local_receipt: row.event_key,
      notification_id: row.payload?.notification_id || null,
      destination: 'chatgpt_trigger',
      delivery: receipt?.delivery || null,
      event_id: receipt?.event_id || null,
      delivered_at: store.now(),
    };
  }, { idempotent: true });
}

function listForMission(bridge, missionId, { limit = 20 } = {}) {
  ensureSchema(bridge.controlStore.db);
  const rows = bridge.controlStore.db.prepare(
    'SELECT * FROM cp_mission_notifications WHERE mission_id=? ORDER BY created_at DESC LIMIT ?'
  ).all(missionId, Math.min(50, Math.max(1, limit)));
  return {
    mission_id: missionId,
    notifications: rows.map(r => ({
      id: r.id,
      status: r.status,
      state: r.state,
      summary: r.summary,
      destination: r.destination,
      outbox_id: r.outbox_id,
      created_at: r.created_at,
      authority: false,
    })),
    authority: false,
  };
}

function listRecent(bridge, { after = 0, limit = 20 } = {}) {
  ensureSchema(bridge.controlStore.db);
  const rows = bridge.controlStore.db.prepare(
    'SELECT * FROM cp_mission_notifications WHERE created_at>? ORDER BY created_at ASC LIMIT ?'
  ).all(Number(after) || 0, Math.min(50, Math.max(1, limit)));
  const cursor = rows.length ? rows[rows.length - 1].created_at : after;
  return {
    cursor,
    notifications: rows.map(r => ({
      id: r.id,
      mission_id: r.mission_id,
      status: r.status,
      state: r.state,
      summary: r.summary,
      destination: r.destination,
      outbox_id: r.outbox_id,
      created_at: r.created_at,
      authority: false,
    })),
    authority: false,
  };
}

module.exports = {
  TERMINAL,
  statusFor,
  onMissionState,
  registerOutboxHandlers,
  listForMission,
  listRecent,
  notificationsEnabled,
};
