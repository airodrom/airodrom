'use strict';
// Event-driven terminal Mission / request notifications. Fired from Mission
// state transitions and ZeroSetup request terminal states (not a poller).
// Delivery uses the durable effect outbox. ChatGPT unsolicited push is used
// only when chatgpt-trigger.json is present; otherwise notifications remain
// inbox-retrievable via MCP. Pre-Mission failures use request_id identity.
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

/** Request states that warrant a durable inbox notification (pre- or post-Mission). */
const REQUEST_NOTIFY = Object.freeze({
  blocked: 'BLOCKED',
  rejected: 'CANCELLED',
  awaiting_approval: 'WAIT',
  // Mission-linked terminals still prefer onMissionState; these cover ask settlement
  // mirrors when the ask row reaches a terminal label without a Mission id.
  verified: 'ACCEPTED',
  awaiting_acceptance: 'OWNER_ACTION_REQUIRED',
  failed: 'BLOCKED',
  cancelled: 'CANCELLED',
});

function statusFor(state, reason) {
  if (state === 'completed') return 'ACCEPTED';
  if (state === 'cancelled') return 'CANCELLED';
  if (state === 'blocked') return 'BLOCKED';
  if (state === 'needs_rework') return 'NEEDS_REWORK';
  if (state === 'waiting_for_operator' || state === 'awaiting_acceptance') return 'OWNER_ACTION_REQUIRED';
  if (FAILED_STATES.has(state)) return 'FAILED';
  return null;
}

function statusForRequest(state) {
  return REQUEST_NOTIFY[state] || null;
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
  const cols = db.prepare('PRAGMA table_info(cp_mission_notifications)').all().map(c => c.name);
  if (!cols.includes('request_id')) {
    db.exec('ALTER TABLE cp_mission_notifications ADD COLUMN request_id TEXT');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS cp_mission_notifications_request
    ON cp_mission_notifications(request_id, created_at DESC)`);
}

function safeSummary(mission, status) {
  const reason = typeof mission.reason === 'string' ? mission.reason.slice(0, 180) : '';
  const objective = typeof mission.envelope?.objective === 'string'
    ? mission.envelope.objective.replace(/\s+/g, ' ').slice(0, 120) : 'Mission';
  const base = `Airodrom Mission ${status}: ${objective}`;
  return redactValue(reason ? `${base}. ${reason}` : base).slice(0, 400);
}

function safeRequestSummary(record, status) {
  const blockers = Array.isArray(record.blockers) ? record.blockers
    : (Array.isArray(record.intake_blockers) ? record.intake_blockers : []);
  const reason = blockers[0] || record.presentation?.status || record.state || 'request';
  const objective = typeof record.instruction === 'string'
    ? record.instruction.replace(/\s+/g, ' ').slice(0, 120) : 'Ask';
  const next = record.presentation?.correction
    || (status === 'WAIT' ? 'Authorize or enroll standing Cursor development when required.'
      : status === 'BLOCKED' ? 'Inspect blockers and issue a corrected request.'
        : null);
  const base = `Airodrom Ask ${status}: ${objective}`;
  const detail = next ? `${reason}. Next: ${next}` : String(reason);
  return redactValue(`${base}. ${detail}`).slice(0, 400);
}

function enqueueNotification(bridge, {
  subjectId, requestId = null, revision, status, state, summary, projectId = null, repositoryId = null,
}) {
  const store = bridge.controlStore;
  const db = store.db;
  ensureSchema(db);
  const existing = db.prepare(
    'SELECT id, outbox_id, destination FROM cp_mission_notifications WHERE mission_id=? AND revision=? AND status=?'
  ).get(subjectId, revision, status);
  if (existing) return { duplicate: true, id: existing.id, destination: existing.destination, outbox_id: existing.outbox_id };

  const id = randomUUID();
  const hasChatgptRoute = !!bridge.chatgptEvents?.route;
  const destination = hasChatgptRoute ? 'chatgpt_trigger' : 'mission_notification_inbox';
  const key = `mission-terminal:${subjectId}:${revision}:${status}`;
  let outboxId = null;
  if (store.outbox) {
    outboxId = store.outbox.enqueue({
      key,
      destination,
      ref: subjectId,
      eventType: 'mission.terminal_notification',
      correlation: {
        mission_id: subjectId.startsWith('request:') ? null : subjectId,
        request_id: requestId,
        revision,
        status,
      },
      payload: {
        notification_id: id,
        mission_id: subjectId.startsWith('request:') ? null : subjectId,
        request_id: requestId,
        status,
        state,
        summary,
        project_id: projectId,
        repository_binding: repositoryId,
        authority: false,
        untrusted: false,
      },
    });
  }
  db.prepare(
    'INSERT INTO cp_mission_notifications(id,mission_id,revision,status,state,summary,destination,outbox_id,created_at,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(id, subjectId, revision, status, state, summary, destination, outboxId, store.now(), requestId);
  store.event('mission.terminal_notification_enqueued', subjectId.startsWith('request:') ? null : subjectId, {
    notification_id: id, status, destination, request_id: requestId, authority: false,
  });
  return { duplicate: false, id, destination, outbox_id: outboxId, status, request_id: requestId };
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
    return enqueueNotification(bridge, {
      subjectId: mission.id,
      requestId: mission.envelope?.cognitive?.envelope?.request_id
        || mission.envelope?.cognitive_request_id
        || null,
      revision: Number(mission.revision) || 0,
      status,
      state: state || mission.state,
      summary: safeSummary(mission, status),
      projectId: mission.project_id || null,
      repositoryId: mission.envelope?.cognitive?.envelope?.repository_id
        || mission.envelope?.repository_binding?.repository_id
        || null,
    });
  } catch {
    return null;
  }
}

/**
 * Pre-Mission / ask-row notifications keyed by request_id when mission_id is absent.
 * WAIT notifies once per request (revision 0); unchanged WAIT replays are duplicate-safe.
 */
function onRequestState(bridge, record, { previous, state } = {}) {
  try {
    if (!bridge?.controlStore || !record?.request_id) return null;
    if (!notificationsEnabled(bridge)) return null;
    // Mission-owned rows are notified from Mission state transitions.
    if (record.mission_id) return null;
    const next = state || record.state;
    const status = statusForRequest(next);
    if (!status) return null;
    if (previous && previous === next) return null;
    // Ignore non-terminal chatter (planning/sealed/approved/running).
    const subjectId = 'request:' + record.request_id;
    return enqueueNotification(bridge, {
      subjectId,
      requestId: record.request_id,
      revision: 0,
      status,
      state: next,
      summary: safeRequestSummary({ ...record, state: next }, status),
      projectId: record.project_id || null,
      repositoryId: record.repository_binding?.repository_id || null,
    });
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
    if (!missionId || String(missionId).startsWith('request:')) {
      // Pre-Mission ask notifications stay inbox-only unless a real MCP task exists.
      return { local_receipt: row.event_key, destination: 'chatgpt_trigger', skipped: 'request_scoped_inbox' };
    }
    const mission = store.getMission(missionId);
    const taskId = mission?.task_id;
    let task = null;
    try { task = taskId ? bridge.tasks.get(taskId) : null; } catch { task = null; }
    if (!task || task.source?.transport !== 'mcp') {
      return { local_receipt: row.event_key, destination: 'chatgpt_trigger', skipped: 'no_mcp_task' };
    }
    const type = row.payload?.status === 'ACCEPTED' ? 'completed'
      : row.payload?.status === 'OWNER_ACTION_REQUIRED' || row.payload?.status === 'WAIT' ? 'approval_required'
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

function mapRow(r) {
  return {
    id: r.id,
    mission_id: r.mission_id && !String(r.mission_id).startsWith('request:') ? r.mission_id : null,
    request_id: r.request_id || (String(r.mission_id || '').startsWith('request:')
      ? String(r.mission_id).slice('request:'.length) : null),
    status: r.status,
    state: r.state,
    summary: r.summary,
    destination: r.destination,
    outbox_id: r.outbox_id,
    created_at: r.created_at,
    authority: false,
  };
}

function listForMission(bridge, missionId, { limit = 20 } = {}) {
  ensureSchema(bridge.controlStore.db);
  const rows = bridge.controlStore.db.prepare(
    'SELECT * FROM cp_mission_notifications WHERE mission_id=? ORDER BY created_at DESC LIMIT ?'
  ).all(missionId, Math.min(50, Math.max(1, limit)));
  return {
    mission_id: missionId,
    notifications: rows.map(mapRow),
    authority: false,
  };
}

function listForRequest(bridge, requestId, { limit = 20 } = {}) {
  ensureSchema(bridge.controlStore.db);
  const rows = bridge.controlStore.db.prepare(
    `SELECT * FROM cp_mission_notifications
     WHERE request_id=? OR mission_id=?
     ORDER BY created_at DESC LIMIT ?`
  ).all(requestId, 'request:' + requestId, Math.min(50, Math.max(1, limit)));
  return {
    request_id: requestId,
    notifications: rows.map(mapRow),
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
    notifications: rows.map(mapRow),
    authority: false,
  };
}

module.exports = {
  TERMINAL,
  REQUEST_NOTIFY,
  statusFor,
  statusForRequest,
  onMissionState,
  onRequestState,
  registerOutboxHandlers,
  listForMission,
  listForRequest,
  listRecent,
  notificationsEnabled,
};
