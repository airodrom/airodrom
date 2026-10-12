'use strict';
// Presentation-only Mission visibility. Never mutates execution authority,
// Acceptance, Settlement, Flight Recorder or erasure requirements.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACTIVE = new Set(['dispatching', 'running', 'verifying']);
const ATTENTION = new Set(['awaiting_acceptance', 'waiting_for_operator']);
const UNCERTAIN = new Set(['paused', 'dispatching', 'running', 'verifying']);

function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cp_mission_visibility(
    mission_id TEXT PRIMARY KEY,
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
    archived_at INTEGER,
    reason TEXT,
    CHECK(archived=0 OR archived_at IS NOT NULL)
  )`);
}

function id(value) {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function isArchived(db, missionId) {
  ensure(db);
  const row = db.prepare('SELECT archived FROM cp_mission_visibility WHERE mission_id=?').get(missionId);
  return row?.archived === 1;
}

function archivedSet(db) {
  ensure(db);
  return new Set(db.prepare('SELECT mission_id FROM cp_mission_visibility WHERE archived=1').all().map(r => r.mission_id));
}

function archiveEligible(mission, { processUnknown = false } = {}) {
  if (!mission || UNCERTAIN.has(mission.state) || ATTENTION.has(mission.state) || ACTIVE.has(mission.state)) return false;
  if (processUnknown) return false;
  return ['completed', 'cancelled', 'blocked', 'needs_rework', 'draft', 'ready'].includes(mission.state);
}

function previewArchive(bridge, { query = '', limit = 200 } = {}) {
  require('./memory-content-erasure').assertReadable(bridge.controlStore.db);
  ensure(bridge.controlStore.db);
  if (typeof query !== 'string' || query.length > 180) throw Error('Invalid archive preview query');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error('Invalid archive preview limit');
  const archived = archivedSet(bridge.controlStore.db);
  const q = query.trim().toLowerCase();
  const items = [];
  for (const row of bridge.controlStore.db.prepare('SELECT id FROM cp_missions ORDER BY created_at DESC,id DESC').all()) {
    if (archived.has(row.id)) continue;
    const mission = bridge.missions.require(row.id, 'operator');
    const unknown = bridge.controlStore.db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND process_state='unknown' LIMIT 1").get(mission.id);
    if (!archiveEligible(mission, { processUnknown: !!unknown })) continue;
    const title = require('./product-observability').operatorTitle(bridge, mission);
    if (q && ![mission.id, title, mission.state].join(' ').toLowerCase().includes(q)) continue;
    items.push({ id: id(mission.id), label: title, state: mission.state, created_at: mission.created_at });
    if (items.length >= limit) break;
  }
  return {
    items,
    total: items.length,
    truncated: items.length >= limit,
    authority: false,
    note: 'Archiving hides Missions from the primary list only. Canonical records, evidence, Acceptance and audit remain.'
  };
}

function archiveMissions(bridge, { ids, confirmed, request_id, reason = 'operator_archive' } = {}) {
  require('./memory-content-erasure').assertReadable(bridge.controlStore.db);
  if (confirmed !== true) throw Error('Explicit operator confirmation required');
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(v => !id(v))) throw Error('Bounded Mission archive set required');
  require('./control-plane-store').text(request_id, 'request id', 240);
  require('./control-plane-store').text(reason, 'archive reason', 120);
  ensure(bridge.controlStore.db);
  const archived = [];
  const refused = [];
  const now = Date.now();
  require('./control-transaction').transaction(bridge.controlStore.db, () => {
    for (const missionId of [...new Set(ids)]) {
      const mission = bridge.missions.require(missionId, 'operator');
      const unknown = bridge.controlStore.db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND process_state='unknown' LIMIT 1").get(mission.id);
      if (!archiveEligible(mission, { processUnknown: !!unknown }) || isArchived(bridge.controlStore.db, mission.id)) {
        refused.push({ id: missionId, reason: 'not_eligible' });
        continue;
      }
      bridge.controlStore.db.prepare(`INSERT INTO cp_mission_visibility(mission_id,archived,archived_at,reason)
        VALUES(?,?,?,?) ON CONFLICT(mission_id) DO UPDATE SET archived=1,archived_at=excluded.archived_at,reason=excluded.reason`)
        .run(mission.id, 1, now, reason);
      archived.push(mission.id);
    }
  });
  if (archived.length) {
    bridge.controlStore.event('product.mission.visibility_archived', null, {
      count: archived.length,
      request_id,
      authority: false
    });
  }
  return { archived: archived.map(id), refused, authority: false };
}

function restoreMission(bridge, { id: missionId, request_id, confirmed } = {}) {
  require('./memory-content-erasure').assertReadable(bridge.controlStore.db);
  if (confirmed !== true) throw Error('Explicit operator confirmation required');
  if (!id(missionId)) throw Error('Mission identity required');
  require('./control-plane-store').text(request_id, 'request id', 240);
  ensure(bridge.controlStore.db);
  bridge.missions.require(missionId, 'operator');
  if (!isArchived(bridge.controlStore.db, missionId)) throw Error('Mission is not archived');
  bridge.controlStore.db.prepare('UPDATE cp_mission_visibility SET archived=0,archived_at=NULL,reason=NULL WHERE mission_id=?').run(missionId);
  bridge.controlStore.event('product.mission.visibility_restored', missionId, { request_id, authority: false });
  return { mission_id: missionId, archived: false, authority: false };
}

function organizeEligible(mission, { processUnknown = false, settled = false } = {}) {
  if (!archiveEligible(mission, { processUnknown })) return false;
  // Prefer settled completions and cancelled drafts; never touch review queues.
  if (mission.state === 'completed') return settled === true;
  return ['cancelled', 'draft', 'ready'].includes(mission.state);
}

function previewOrganize(bridge, { older_than_ms = 0, limit = 200 } = {}) {
  require('./memory-content-erasure').assertReadable(bridge.controlStore.db);
  ensure(bridge.controlStore.db);
  if (!Number.isSafeInteger(older_than_ms) || older_than_ms < 0) throw Error('Invalid organize window');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error('Invalid organize limit');
  const archived = archivedSet(bridge.controlStore.db);
  const settled = new Set(bridge.controlStore.db.prepare("SELECT mission_id FROM cp_mission_settlements WHERE state='settled'").all().map(r => r.mission_id));
  const cutoff = Date.now() - older_than_ms;
  const items = [];
  for (const row of bridge.controlStore.db.prepare('SELECT id FROM cp_missions ORDER BY created_at ASC,id ASC').all()) {
    if (archived.has(row.id)) continue;
    const mission = bridge.missions.require(row.id, 'operator');
    if ((mission.created_at || 0) > cutoff && older_than_ms > 0) continue;
    const unknown = bridge.controlStore.db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND process_state='unknown' LIMIT 1").get(mission.id);
    if (!organizeEligible(mission, { processUnknown: !!unknown, settled: settled.has(mission.id) })) continue;
    const title = require('./product-observability').operatorTitle(bridge, mission);
    items.push({ id: id(mission.id), label: title, state: mission.state, created_at: mission.created_at, settled: settled.has(mission.id) });
    if (items.length >= limit) break;
  }
  return {
    items,
    total: items.length,
    truncated: items.length >= limit,
    authority: false,
    note: 'Organization archives presentation only. Unresolved Acceptance and active execution are never included.'
  };
}

function organizeHistory(bridge, body = {}) {
  const preview = previewOrganize(bridge, { older_than_ms: body.older_than_ms || 0, limit: body.limit || 200 });
  if (body.confirmed !== true) return { ...preview, requires_confirmation: true };
  return archiveMissions(bridge, {
    ids: preview.items.map(i => i.id),
    confirmed: true,
    request_id: body.request_id,
    reason: body.reason || 'outcome_first_organize'
  });
}

module.exports = {
  ensure,
  isArchived,
  archivedSet,
  archiveEligible,
  organizeEligible,
  previewArchive,
  previewOrganize,
  archiveMissions,
  organizeHistory,
  restoreMission,
  ACTIVE: [...ACTIVE],
  ATTENTION: [...ATTENTION]
};
