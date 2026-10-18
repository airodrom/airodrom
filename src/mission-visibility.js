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
const AUTO_ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000;
const AUTO_ARCHIVE_INTERVAL_MS = 60 * 1000;

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

/** Conversation turns awaiting Acceptance are historical unread results, not urgent owner decisions. */
function isHistoricalConversationResult(mission) {
  return !!mission && mission.envelope?.kind === 'conversation' && mission.state === 'awaiting_acceptance';
}

function isArchived(db, missionId) {
  ensure(db);
  const row = db.prepare('SELECT archived FROM cp_mission_visibility WHERE mission_id=?').get(missionId);
  return row?.archived === 1;
}

function archivedSet(db, bridge = null) {
  ensure(db);
  return new Set(db.prepare('SELECT mission_id FROM cp_mission_visibility WHERE archived=1').all()
    .filter(r => !bridge || archiveBlockers(bridge, bridge.missions.require(r.mission_id, 'operator')).length === 0)
    .map(r => r.mission_id));
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
  const historicalConversation = isHistoricalConversationResult(mission);
  if (UNCERTAIN.has(mission.state) || ACTIVE.has(mission.state)) reasons.push('active_or_uncertain_state');
  if (ATTENTION.has(mission.state) && !historicalConversation) reasons.push('unresolved_owner_decision');
  if (db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND process_state='unknown' LIMIT 1").get(mission.id)) {
    reasons.push('unknown_process_state');
  }
  if (db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND (termination_verified=0 OR process_state IN ('alive','starting') OR state NOT IN ('completed','failed','cancelled','interrupted')) LIMIT 1").get(mission.id)) {
    reasons.push('unverified_termination');
  }
  if (db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state IN ('queued','dispatching','running','unknown') LIMIT 1").get(mission.id)) {
    reasons.push('active_or_unknown_dispatch');
  }
  const workspace = typeof mission.envelope?.workspace === 'string' ? mission.envelope.workspace : '';
  if (workspace && db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND mode='write' AND state IN ('held','quarantined') LIMIT 1").get(workspace)) {
    reasons.push('active_or_quarantined_lease');
  }
  if (db.prepare("SELECT 1 FROM cp_leases WHERE state IN ('held','quarantined') AND (mission_id=? OR run_id IN (SELECT id FROM cp_runs WHERE mission_id=?)) LIMIT 1").get(mission.id, mission.id)) {
    reasons.push('active_or_quarantined_lease');
  }
  if (db.prepare("SELECT 1 FROM cp_effect_outbox WHERE status!='sent' AND (json_extract(correlation,'$.mission_id')=? OR json_extract(correlation,'$.task_id')=? OR destination_ref IN (SELECT id FROM cp_runs WHERE mission_id=?)) LIMIT 1").get(mission.id, mission.task_id, mission.id)) {
    reasons.push('unknown_external_delivery');
  }
  const settlement = db.prepare('SELECT state FROM cp_mission_settlements WHERE mission_id=?').get(mission.id);
  if (mission.state === 'completed' && settlement?.state !== 'settled') {
    reasons.push('unresolved_settlement');
  }
  if (db.prepare("SELECT 1 FROM cp_decisions WHERE mission_id=? AND state IN ('pending','waiting_for_operator') LIMIT 1").get(mission.id)
    || (bridge.policy?.list(mission.task_id) || []).some(a => ['pending','approved'].includes(a.status))) reasons.push('unresolved_owner_decision');
  if (db.prepare("SELECT 1 FROM cp_continuations WHERE mission_id=? AND state='queued' LIMIT 1").get(mission.id)) reasons.push('pending_continuation');
  if (db.prepare("SELECT 1 FROM cp_subscription_invocations WHERE mission_id=? AND state='reserved' LIMIT 1").get(mission.id)) reasons.push('unsettled_accounting');
  if (db.prepare("SELECT 1 FROM cp_autonomous_claims WHERE mission_id=? AND state IN ('claimed','dispatched') LIMIT 1").get(mission.id)) reasons.push('active_recovery');
  // A program or repair family may still need this Mission as an actionable dependency.
  if (db.prepare(`SELECT 1 FROM cp_mission_program_nodes n JOIN cp_mission_programs p ON p.id=n.program_id
    WHERE n.mission_id=? AND p.state IN ('running','waiting_acceptance','goal_observing')
    AND EXISTS (SELECT 1 FROM cp_mission_program_nodes dependency LEFT JOIN cp_missions m ON m.id=dependency.mission_id
      WHERE dependency.program_id=p.id AND (m.id IS NULL OR m.state NOT IN ('completed','cancelled'))) LIMIT 1`).get(mission.id)) reasons.push('program_dependency');
  if (db.prepare(`WITH RECURSIVE family(id) AS (
    SELECT ? UNION SELECT m.id FROM cp_missions m JOIN family f
    ON json_extract(m.envelope,'$.repair_of')=f.id
  ) SELECT 1 FROM cp_missions WHERE id IN (SELECT id FROM family) AND id!=?
    AND state NOT IN ('completed','cancelled') LIMIT 1`).get(mission.id, mission.id)) reasons.push('active_repair_descendant');
  // Pending Acceptance that still requires an owner decision cannot be archived away.
  // Historical conversation results may be presentation-archived without Acceptance.
  if ((mission.state === 'awaiting_acceptance' || mission.state === 'waiting_for_operator') && !historicalConversation) {
    reasons.push('pending_acceptance');
  }
  const verification = db.prepare('SELECT id,result FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(mission.id);
  if (verification && mission.state === 'awaiting_acceptance' && !historicalConversation) reasons.push('pending_acceptance');
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
  if (!mission || UNCERTAIN.has(mission.state) || ACTIVE.has(mission.state)) return false;
  if (ATTENTION.has(mission.state) && !isHistoricalConversationResult(mission)) return false;
  if (opts.processUnknown) return false;
  if (!isHistoricalConversationResult(mission) && !['completed', 'cancelled', 'blocked', 'needs_rework', 'draft', 'ready'].includes(mission.state)) return false;
  if (bridge) return archiveBlockers(bridge, mission).length === 0;
  return true;
}

function storePreview(bridge, { kind, items, request_id = null, total = items.length }) {
  ensure(bridge.controlStore.db);
  const ids = sortedIds(items.map(i => i.id));
  if (!ids.length) {
    return {
      preview_id: null,
      digest: null,
      items: [],
      total: 0,
      selected: 0,
      truncated: false,
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
    total,
    selected: items.length,
    truncated: total > items.length,
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
  let total = 0;
  for (const row of bridge.controlStore.db.prepare('SELECT id FROM cp_missions ORDER BY created_at DESC,id DESC').all()) {
    if (archived.has(row.id)) continue;
    const mission = bridge.missions.require(row.id, 'operator');
    if (!archiveEligible(mission, bridge)) continue;
    const title = require('./product-observability').operatorTitle(bridge, mission);
    if (q && ![mission.id, title, mission.state].join(' ').toLowerCase().includes(q)) continue;
    total++;
    if (items.length < limit) items.push({ id: id(mission.id), label: title, state: mission.state, created_at: mission.created_at });
  }
  return storePreview(bridge, { kind: 'archive', items, request_id, total });
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
    if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some(v => !id(v)))) throw Error('Bounded Mission archive set required');
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
      const eligibleState = isHistoricalConversationResult(mission)
        || ['completed', 'cancelled', 'blocked', 'needs_rework', 'draft', 'ready'].includes(mission.state);
      if (blockers.length || isArchived(bridge.controlStore.db, mission.id) || !eligibleState
        || body.kind === 'organize' && !organizeEligible(mission, bridge)) {
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
    for (const missionId of archived) bridge.controlStore.event('product.mission.visibility_archived', missionId, {request_id: body.request_id, authority: false});
  });
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
  require('./control-transaction').transaction(bridge.controlStore.db, () => {
    bridge.controlStore.db.prepare('UPDATE cp_mission_visibility SET archived=0,archived_at=NULL,reason=NULL WHERE mission_id=?').run(missionId);
    bridge.controlStore.event('product.mission.visibility_restored', missionId, { request_id, authority: false });
  });
  return { mission_id: missionId, archived: false, authority: false };
}

function organizeEligible(mission, bridge) {
  if (!mission || !['completed','cancelled'].includes(mission.state)) return false;
  if (!archiveEligible(mission, bridge)) return false;
  return mission.state === 'cancelled' || bridge.controlStore.db.prepare("SELECT 1 FROM cp_mission_settlements WHERE mission_id=? AND state='settled'").get(mission.id) !== undefined;
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
  let total = 0;
  for (const row of bridge.controlStore.db.prepare('SELECT id FROM cp_missions ORDER BY created_at ASC,id ASC').all()) {
    if (archived.has(row.id)) continue;
    const mission = bridge.missions.require(row.id, 'operator');
    if (terminalUpdatedAt(bridge, mission) > cutoff && older_than_ms > 0) continue;
    if (!organizeEligible(mission, bridge)) continue;
    const title = require('./product-observability').operatorTitle(bridge, mission);
    total++;
    if (items.length < limit) items.push({ id: id(mission.id), label: title, state: mission.state, created_at: mission.created_at, settled: settled.has(mission.id) });
  }
  return storePreview(bridge, { kind: 'organize', items, request_id, total });
}

function terminalUpdatedAt(bridge, mission) {
  const db = bridge.controlStore.db;
  return Math.max(mission.updated_at || mission.created_at || 0,
    db.prepare('SELECT updated_at FROM cp_mission_settlements WHERE mission_id=?').get(mission.id)?.updated_at || 0,
    db.prepare('SELECT max(updated_at) at FROM cp_runs WHERE mission_id=?').get(mission.id)?.at || 0);
}

// Host maintenance only: bounded keyset scan, no execution or Acceptance authority.
// An explicit restore (archived=0 row) pins visibility across restarts.
function autoArchive(bridge, { now = Date.now(), after = '', limit = 200 } = {}) {
  require('./memory-content-erasure').assertReadable(bridge.controlStore.db);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (after !== '' && !id(after))) throw Error('Invalid archive maintenance page');
  const db = bridge.controlStore.db;
  ensure(db);
  return require('./control-transaction').transaction(db, () => {
    const rows = db.prepare(`SELECT id FROM cp_missions WHERE state IN ('completed','cancelled') AND id>?
      AND NOT EXISTS (SELECT 1 FROM cp_mission_visibility v WHERE v.mission_id=cp_missions.id)
      ORDER BY id LIMIT ?`).all(after, limit);
    const archived = [];
    for (const row of rows) {
      const mission = bridge.missions.require(row.id, 'operator');
      if (terminalUpdatedAt(bridge, mission) > now - AUTO_ARCHIVE_AGE_MS || !organizeEligible(mission, bridge)) continue;
      db.prepare("INSERT INTO cp_mission_visibility(mission_id,archived,archived_at,reason) VALUES(?,1,?,'terminal_auto_archive_v1')").run(mission.id, now);
      bridge.controlStore.event('product.mission.visibility_archived', mission.id, {automatic: true, authority: false});
      archived.push(mission.id);
    }
    return {archived, scanned: rows.length, after: rows.length === limit ? rows.at(-1).id : '', authority: false};
  });
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
  isHistoricalConversationResult,
  archiveEligible,
  archiveBlockers,
  organizeEligible,
  previewArchive,
  previewOrganize,
  archiveMissions,
  organizeHistory,
  restoreMission,
  autoArchive,
  AUTO_ARCHIVE_AGE_MS,
  AUTO_ARCHIVE_INTERVAL_MS,
  digestIds,
  PREVIEW_TTL_MS,
  ACTIVE: [...ACTIVE],
  ATTENTION: [...ATTENTION]
};
