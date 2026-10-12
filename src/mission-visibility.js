'use strict';
// Presentation-only Mission visibility. Never mutates execution authority,
// Acceptance, Settlement, Flight Recorder or erasure requirements.
const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACTIVE = new Set(['dispatching', 'running', 'verifying']);
const ATTENTION = new Set(['awaiting_acceptance', 'waiting_for_operator']);
const UNCERTAIN = new Set(['paused', 'dispatching', 'running', 'verifying']);
const PREVIEW_TTL_MS = 5 * 60 * 1000;

function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cp_mission_visibility(
    mission_id TEXT PRIMARY KEY,
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
    archived_at INTEGER,
    reason TEXT,
    CHECK(archived=0 OR archived_at IS NOT NULL)
  );
  CREATE TABLE IF NOT EXISTS cp_mission_archive_previews(
    preview_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('archive','organize')),
    digest TEXT NOT NULL,
    mission_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    request_id TEXT,
    used_at INTEGER,
    CHECK(used_at IS NULL OR used_at >= created_at)
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

function sortedIds(ids) {
  return [...new Set(ids.map(id).filter(Boolean))].sort();
}

function digestIds(kind, ids) {
  return crypto.createHash('sha256').update(kind + '\n' + sortedIds(ids).join('\n')).digest('hex');
}

/** Canonical blockers that forbid presentation archive. */
function archiveBlockers(bridge, mission) {
  const db = bridge.controlStore.db;
  const reasons = [];
  if (!mission) return ['mission_missing'];
  if (UNCERTAIN.has(mission.state) || ACTIVE.has(mission.state)) reasons.push('active_or_uncertain_state');
  if (ATTENTION.has(mission.state)) reasons.push('unresolved_owner_decision');
  if (db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND process_state='unknown' LIMIT 1").get(mission.id)) {
    reasons.push('unknown_process_state');
  }
  if (db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND termination_verified=0 AND state NOT IN ('completed','failed','cancelled') LIMIT 1").get(mission.id)) {
    reasons.push('unverified_termination');
  }
  if (db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state IN ('queued','dispatching','running','unknown') LIMIT 1").get(mission.id)) {
    reasons.push('active_or_unknown_dispatch');
  }
  const workspace = typeof mission.envelope?.workspace === 'string' ? mission.envelope.workspace : '';
  if (workspace && db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND mode='write' AND state IN ('held','quarantined') LIMIT 1").get(workspace)) {
    reasons.push('active_or_quarantined_lease');
  }
  if (db.prepare("SELECT 1 FROM cp_leases WHERE state IN ('held','quarantined') AND run_id IN (SELECT id FROM cp_runs WHERE mission_id=?) LIMIT 1").get(mission.id)) {
    reasons.push('active_or_quarantined_lease');
  }
  if (db.prepare("SELECT 1 FROM cp_effect_outbox WHERE status IN ('dispatching','delivery_unknown') AND (json_extract(correlation,'$.mission_id')=? OR destination_ref IN (SELECT id FROM cp_runs WHERE mission_id=?)) LIMIT 1").get(mission.id, mission.id)) {
    reasons.push('unknown_external_delivery');
  }
  const settlement = db.prepare('SELECT state FROM cp_mission_settlements WHERE mission_id=?').get(mission.id);
  if (mission.state === 'completed' && settlement && !['settled', 'needs_rework'].includes(settlement.state)) {
    reasons.push('unresolved_settlement');
  }
  // Pending Acceptance that still requires an owner decision cannot be archived away.
  if (mission.state === 'awaiting_acceptance' || mission.state === 'waiting_for_operator') {
    reasons.push('pending_acceptance');
  }
  const verification = db.prepare('SELECT id,result FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
  if (verification && mission.state === 'awaiting_acceptance') reasons.push('pending_acceptance');
  return reasons;
}

function archiveEligible(mission, bridgeOrOpts = {}, maybeOpts) {
  // Support both archiveEligible(mission,{processUnknown}) and archiveEligible(mission,bridge).
  let bridge = null;
  let opts = {};
  if (bridgeOrOpts && typeof bridgeOrOpts.controlStore === 'object') {
    bridge = bridgeOrOpts;
    opts = maybeOpts || {};
  } else {
    opts = bridgeOrOpts || {};
  }
  if (!mission || UNCERTAIN.has(mission.state) || ATTENTION.has(mission.state) || ACTIVE.has(mission.state)) return false;
  if (opts.processUnknown) return false;
  if (!['completed', 'cancelled', 'blocked', 'needs_rework', 'draft', 'ready'].includes(mission.state)) return false;
  if (bridge) return archiveBlockers(bridge, mission).length === 0;
  return true;
}

function storePreview(bridge, { kind, items, request_id = null }) {
  ensure(bridge.controlStore.db);
  const ids = sortedIds(items.map(i => i.id));
  if (!ids.length) {
    return {
      preview_id: null,
      digest: null,
      items: [],
      total: 0,
      expires_at: null,
      authority: false,
      note: kind === 'organize'
        ? 'No settled or cancelled history ready to organize.'
        : 'No Missions eligible to archive.'
    };
  }
  const preview_id = randomUUID();
  const digest = digestIds(kind, ids);
  const created_at = Date.now();
  const expires_at = created_at + PREVIEW_TTL_MS;
  bridge.controlStore.db.prepare(`INSERT INTO cp_mission_archive_previews
    (preview_id,kind,digest,mission_ids,created_at,expires_at,request_id,used_at)
    VALUES(?,?,?,?,?,?,?,NULL)`).run(preview_id, kind, digest, JSON.stringify(ids), created_at, expires_at, request_id);
  return {
    preview_id,
    digest,
    items,
    total: items.length,
    truncated: items.length >= 200,
    expires_at,
    authority: false,
    note: kind === 'organize'
      ? 'Organization archives presentation only. Confirmation is bound to this exact Mission set until expiry.'
      : 'Archiving hides Missions from the primary list only. Confirmation is bound to this exact Mission set until expiry.'
  };
}

function loadPreview(bridge, { preview_id, digest, kind }) {
  ensure(bridge.controlStore.db);
  if (!id(preview_id) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw Error('Archive preview identity required');
  }
  const row = bridge.controlStore.db.prepare('SELECT * FROM cp_mission_archive_previews WHERE preview_id=?').get(preview_id);
  if (!row) throw Error('Archive preview not found; request a new preview');
  if (row.kind !== kind) throw Error('Archive preview kind mismatch');
  if (row.digest !== digest) throw Error('Stale archive preview rejected');
  if (row.used_at != null) throw Error('Archive preview already consumed; request a new preview');
  if (row.expires_at < Date.now()) throw Error('Archive preview expired; request a new preview');
  const ids = JSON.parse(row.mission_ids);
  if (!Array.isArray(ids) || digestIds(kind, ids) !== digest) throw Error('Stale archive preview rejected');
  return { row, ids: sortedIds(ids) };
}

function previewArchive(bridge, { query = '', limit = 200, request_id = null } = {}) {
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
    if (!archiveEligible(mission, bridge)) continue;
    const title = require('./product-observability').operatorTitle(bridge, mission);
    if (q && ![mission.id, title, mission.state].join(' ').toLowerCase().includes(q)) continue;
    items.push({ id: id(mission.id), label: title, state: mission.state, created_at: mission.created_at });
    if (items.length >= limit) break;
  }
  return storePreview(bridge, { kind: 'archive', items, request_id });
}

function archiveMissions(bridge, body = {}) {
  require('./memory-content-erasure').assertReadable(bridge.controlStore.db);
  if (body.confirmed !== true) throw Error('Explicit operator confirmation required');
  require('./control-plane-store').text(body.request_id, 'request id', 240);
  require('./control-plane-store').text(body.reason || 'operator_archive', 'archive reason', 120);
  ensure(bridge.controlStore.db);

  let ids;
  if (body.preview_id) {
    const preview = loadPreview(bridge, { preview_id: body.preview_id, digest: body.digest, kind: body.kind || 'archive' });
    ids = preview.ids;
    // Exact set only — never accept a substituted ID list alongside a preview.
    if (Array.isArray(body.ids) && body.ids.length) {
      const supplied = sortedIds(body.ids);
      if (supplied.length !== ids.length || supplied.some((v, i) => v !== ids[i])) {
        throw Error('Stale archive preview rejected');
      }
    }
  } else {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200 || body.ids.some(v => !id(v))) {
      throw Error('Bounded Mission archive set required');
    }
    ids = sortedIds(body.ids);
  }

  const archived = [];
  const refused = [];
  const now = Date.now();
  require('./control-transaction').transaction(bridge.controlStore.db, () => {
    if (body.preview_id) {
      const again = loadPreview(bridge, { preview_id: body.preview_id, digest: body.digest, kind: body.kind || 'archive' });
      if (again.ids.join('\n') !== ids.join('\n')) throw Error('Stale archive preview rejected');
    }
    for (const missionId of ids) {
      const mission = bridge.missions.require(missionId, 'operator');
      const blockers = archiveBlockers(bridge, mission);
      if (blockers.length || isArchived(bridge.controlStore.db, mission.id) || !['completed', 'cancelled', 'blocked', 'needs_rework', 'draft', 'ready'].includes(mission.state)) {
        refused.push({ id: missionId, reason: blockers[0] || 'not_eligible' });
        continue;
      }
      bridge.controlStore.db.prepare(`INSERT INTO cp_mission_visibility(mission_id,archived,archived_at,reason)
        VALUES(?,?,?,?) ON CONFLICT(mission_id) DO UPDATE SET archived=1,archived_at=excluded.archived_at,reason=excluded.reason`)
        .run(mission.id, 1, now, body.reason || 'operator_archive');
      archived.push(mission.id);
    }
    if (body.preview_id) {
      // Fail closed: if any approved ID became ineligible, reject the whole confirmation.
      if (refused.length) throw Error('Stale archive preview rejected');
      bridge.controlStore.db.prepare('UPDATE cp_mission_archive_previews SET used_at=? WHERE preview_id=? AND used_at IS NULL')
        .run(now, body.preview_id);
    }
  });
  if (archived.length) {
    bridge.controlStore.event('product.mission.visibility_archived', null, {
      count: archived.length,
      request_id: body.request_id,
      authority: false
    });
  }
  return { archived: archived.map(id), refused, authority: false, preview_id: body.preview_id || null };
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

function organizeEligible(mission, bridge, { settled = false } = {}) {
  if (!archiveEligible(mission, bridge)) return false;
  if (mission.state === 'completed') return settled === true;
  return ['cancelled', 'draft', 'ready'].includes(mission.state);
}

function previewOrganize(bridge, { older_than_ms = 0, limit = 200, request_id = null } = {}) {
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
    if (!organizeEligible(mission, bridge, { settled: settled.has(mission.id) })) continue;
    const title = require('./product-observability').operatorTitle(bridge, mission);
    items.push({ id: id(mission.id), label: title, state: mission.state, created_at: mission.created_at, settled: settled.has(mission.id) });
    if (items.length >= limit) break;
  }
  return storePreview(bridge, { kind: 'organize', items, request_id });
}

function organizeHistory(bridge, body = {}) {
  if (body.confirmed !== true) {
    return { ...previewOrganize(bridge, body), requires_confirmation: true };
  }
  if (!body.preview_id || !body.digest) throw Error('Archive preview identity required');
  return archiveMissions(bridge, {
    preview_id: body.preview_id,
    digest: body.digest,
    kind: 'organize',
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
  archiveBlockers,
  organizeEligible,
  previewArchive,
  previewOrganize,
  archiveMissions,
  organizeHistory,
  restoreMission,
  digestIds,
  PREVIEW_TTL_MS,
  ACTIVE: [...ACTIVE],
  ATTENTION: [...ATTENTION]
};
