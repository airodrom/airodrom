'use strict';
// Live Activity V2 — Mission-centric board projection (display only, never authority).
const display = require('./product-observability');
const observatory = require('./live-observatory');
const visibility = require('./mission-visibility');

const ACTIVE = new Set(['dispatching', 'running', 'verifying']);
const RECENT_STATES = new Set(['completed', 'cancelled', 'blocked', 'needs_rework', 'awaiting_acceptance']);
const STAGE_ORDER = Object.freeze([
  ['scope', 'Scope', new Set(['request'])],
  ['preparation', 'Preparation', new Set(['context', 'runtime'])],
  ['execution', 'Execution', new Set(['execution'])],
  ['testing', 'Testing', new Set(['execution'])], // refined by Test category events
  ['verification', 'Verification', new Set(['verification'])],
  ['acceptance', 'Acceptance', new Set(['acceptance'])],
  ['settlement', 'Settlement', new Set(['settlement'])]
]);
const WINDOWS = Object.freeze({
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000
});

function unavailable(value) {
  if (value == null || value === '') return 'Unavailable';
  return value;
}

function clip(value, n = 160) {
  const s = String(value ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function projectEvents(bridge, missionId, limit = 120) {
  const batch = bridge.ledger.list({ missionId, limit, order: 'desc' });
  const out = [];
  const seen = new Set();
  for (const raw of batch.events) {
    if (!raw?.event_id || seen.has(raw.event_id)) continue;
    seen.add(raw.event_id);
    const p = observatory.projectEvent(raw);
    if (p) out.push(p);
  }
  out.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  return out;
}

function groupSummary(events) {
  const caps = events.filter(e => e.category === 'Capability').length;
  const files = events.filter(e => e.category === 'File').length;
  const tools = events.filter(e => e.category === 'Worker' && /tool/i.test(e.event_type || '')).length;
  const tests = events.filter(e => e.category === 'Test').length;
  const parts = [];
  if (caps) parts.push(`${caps} capability operation${caps === 1 ? '' : 's'}`);
  if (tools) parts.push(`${tools} tool observation${tools === 1 ? '' : 's'}`);
  if (files) parts.push(`${files} saved-file change${files === 1 ? '' : 's'}`);
  if (tests) parts.push(`${tests} test observation${tests === 1 ? '' : 's'}`);
  const latestMeaningful = [...events].reverse().find(e =>
    e.category === 'File' || e.category === 'Git' || e.category === 'Test' || e.category === 'Verification'
    || e.category === 'Mission' || e.category === 'Worker' || e.category === 'Settlement'
  );
  return {
    summary: latestMeaningful?.label || (parts.length ? parts.join(' · ') : 'No meaningful host observations yet'),
    detail: parts.length ? parts.join(' · ') : null,
    event_count: events.length,
    capability_count: caps,
    file_count: files,
    tool_count: tools,
    test_count: tests
  };
}

function workflowTimeline(view, events) {
  const testEvents = events.filter(e => e.category === 'Test');
  const byStage = new Map();
  for (const e of events) {
    if (!e.stage) continue;
    if (!byStage.has(e.stage)) byStage.set(e.stage, []);
    byStage.get(e.stage).push(e);
  }
  const currentStage = events.filter(e => e.stage).at(-1)?.stage || null;
  const advancing = ACTIVE.has(view.state);
  return STAGE_ORDER.map(([key, name, stageSet]) => {
    let observed = [];
    if (key === 'testing') observed = testEvents;
    else {
      for (const s of stageSet) observed = observed.concat(byStage.get(s) || []);
      if (key === 'execution') {
        // Exclude pure test category from the execution bucket when testing stage is present.
        observed = observed.filter(e => e.category !== 'Test');
      }
    }
    observed.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    const start = observed[0]?.timestamp_ms || null;
    const end = observed.at(-1)?.timestamp_ms || null;
    let status = 'Unavailable';
    if (!observed.length) {
      if (key === 'testing' && !testEvents.length) status = 'Pending';
      else if (['blocked', 'needs_rework'].includes(view.state) && currentStage && stageSet.has(currentStage)) status = 'Blocked';
      else status = advancing ? 'Pending' : 'Unavailable';
    } else if (key === 'testing' && observed.some(e => e.outcome === 'failed' || /failed/i.test(e.event_type || ''))) {
      status = 'Failed';
    } else if (key === 'verification' && view.verification?.status === 'failed') {
      status = 'Failed';
    } else if (currentStage && stageSet.has(currentStage) && advancing) {
      status = 'In progress';
    } else if (key === 'settlement' && view.settlement?.status === 'settled') {
      status = 'Completed';
    } else if (key === 'acceptance' && ['awaiting_acceptance', 'waiting_for_operator'].includes(view.state)) {
      status = 'In progress';
    } else if (key === 'acceptance' && view.acceptance?.status === 'accept') {
      status = 'Completed';
    } else if (key === 'verification' && view.verification?.current && view.verification?.status === 'passed') {
      status = 'Completed';
    } else if (!advancing || (currentStage && STAGE_ORDER.findIndex(s => s[2].has(currentStage)) > STAGE_ORDER.findIndex(s => s[0] === key))) {
      status = 'Completed';
    } else {
      status = 'In progress';
    }
    return {
      key,
      name,
      status,
      start_ms: start,
      end_ms: end && end !== start ? end : (status === 'Completed' ? end : null),
      duration_ms: start && end && end >= start ? end - start : null,
      evidence_event_id: observed.at(-1)?.event_id || null,
      evidence_count: observed.length
    };
  });
}

function changedFilesFromEvents(events, { missionId = null, branch = null, project = null } = {}) {
  const byPath = new Map();
  for (const e of events) {
    if (e.category !== 'File' && e.category !== 'Git') continue;
    const paths = e.path ? [e.path] : (Array.isArray(e.paths) ? e.paths : []);
    for (const p of paths) {
      if (!observatory.safeRel(p)) continue;
      const prev = byPath.get(p) || {
        path: p,
        name: p.split('/').pop(),
        change_type: 'modified',
        branch: null,
        lines_added: null,
        lines_removed: null,
        last_modified_ms: null,
        observation_source: 'event_ledger',
        writer_class: null,
        mission_id: missionId,
        project: project || null,
        git_backed: false
      };
      if (e.event_type === 'fs.file_created') prev.change_type = 'created';
      else if (e.event_type === 'fs.file_deleted') prev.change_type = 'deleted';
      else if (e.event_type?.startsWith('fs.file_')) prev.change_type = prev.change_type === 'created' ? 'created' : 'modified';
      if (Number.isInteger(e.lines_added)) { prev.lines_added = e.lines_added; prev.git_backed = true; }
      if (Number.isInteger(e.lines_removed)) { prev.lines_removed = e.lines_removed; prev.git_backed = true; }
      if (typeof e.branch === 'string' && e.branch && e.branch !== 'observed') prev.branch = e.branch;
      if (typeof e.writer_class === 'string') prev.writer_class = e.writer_class;
      if (e.category === 'Git') prev.observation_source = 'git_diff';
      if (e.timestamp_ms && (!prev.last_modified_ms || e.timestamp_ms >= prev.last_modified_ms)) {
        prev.last_modified_ms = e.timestamp_ms;
      }
      byPath.set(p, prev);
    }
  }
  if (branch) {
    for (const row of byPath.values()) {
      if (!row.branch) row.branch = branch;
    }
  }
  return [...byPath.values()].sort((a, b) => (b.last_modified_ms || 0) - (a.last_modified_ms || 0));
}

function resolveBranch(bridge, mission) {
  const workspace = mission.envelope?.workspace;
  if (typeof workspace !== 'string') return null;
  try {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('/usr/bin/git', ['-C', workspace, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', timeout: 2000, env: { PATH: '/usr/bin:/bin', LANG: 'C' }
    });
    if (result.status === 0) {
      const name = String(result.stdout || '').trim();
      return name && name !== 'HEAD' ? name.slice(0, 120) : null;
    }
  } catch { /* unavailable */ }
  return null;
}

function missionCard(bridge, mission, { includeTimeline = true, includeTechnical = false } = {}) {
  const view = display.missionView(bridge, mission);
  const title = display.operatorTitle(bridge, mission);
  const events = projectEvents(bridge, mission.id, 160);
  const grouping = groupSummary(events);
  const branch = resolveBranch(bridge, mission);
  const files = changedFilesFromEvents(events, {
    missionId: mission.id,
    branch,
    project: typeof mission.envelope?.project === 'string' ? mission.envelope.project : null
  });
  const latestFile = files[0] || null;
  const testEvents = events.filter(e => e.category === 'Test');
  const verificationState = view.verification?.status || 'not_observed';
  const blockers = [];
  if (['blocked', 'needs_rework'].includes(view.state)) {
    blockers.push({
      mission_id: view.id,
      reason: view.recovery?.detail || view.display?.label || view.state,
      required_decision: view.next_action || 'Owner review required',
      evidence_event_id: events.filter(e => e.branch === 'attention').at(-1)?.event_id || null
    });
  }
  if (display.ownerAttentionRequired(mission, view)) {
    blockers.push({
      mission_id: view.id,
      reason: view.display?.label || 'Needs Attention',
      required_decision: view.next_action || 'Owner decision required',
      evidence_event_id: null
    });
  }
  const stageLabel = (() => {
    if (ACTIVE.has(view.state)) {
      const last = events.filter(e => e.stage).at(-1);
      return last?.label || view.latest_activity || view.display?.label || 'In progress';
    }
    return view.display?.label || view.state;
  })();
  const card = {
    id: view.id,
    title: clip(title, 180),
    project: typeof mission.envelope?.project === 'string' ? mission.envelope.project : (mission.envelope?.kind || 'Unavailable'),
    worker: view.worker_assigned ? (view.runtime || 'Unavailable') : (ACTIVE.has(view.state) ? 'Unavailable' : 'Unavailable'),
    model: view.model?.id || 'Unavailable',
    repository: view.workspace || 'Unavailable',
    branch: branch || 'Unavailable',
    state: view.state,
    display: view.display,
    elapsed_s: view.started_at ? Math.max(0, Math.floor(((view.finished_at || Date.now()) - view.started_at) / 1000)) : null,
    current_stage: stageLabel,
    latest_event: grouping.summary,
    grouping,
    changed_file_count: files.length,
    changed_files: files.slice(0, 24),
    latest_file: latestFile,
    verification_state: verificationState,
    tests: {
      observed: testEvents.length > 0,
      latest: testEvents.at(-1)?.label || null,
      outcome: testEvents.at(-1)?.outcome || null
    },
    blockers: blockers.slice(0, 4),
    advancing: ACTIVE.has(view.state),
    attention: display.ownerAttentionRequired(mission, view),
    cursor_agent_qualified: false,
    open_in_cursor: typeof mission.envelope?.workspace === 'string',
    workspace: typeof mission.envelope?.workspace === 'string' ? 'registered' : null,
    timeline: includeTimeline ? workflowTimeline(view, events) : undefined,
    technical_event_count: events.length,
    technical_events: includeTechnical ? events.slice(-80).map(e => ({
      event_id: e.event_id,
      event_type: e.event_type,
      category: e.category,
      label: e.label,
      timestamp_ms: e.timestamp_ms,
      sequence: e.sequence,
      path: e.path || null,
      tool: e.tool || null,
      run_id: e.run_id || null,
      writer_class: e.writer_class || null,
      outcome: e.outcome || null
    })) : undefined,
    observed_at: Date.now(),
    authority: false
  };
  // Ready worker with no active run must not appear as working.
  if (!ACTIVE.has(view.state)) {
    card.current_stage = view.display?.label || unavailable(view.state);
  }
  return card;
}

function workspaceFiles(bridge, sinceMs) {
  const page = new URL('http://local/api/product/live-events');
  page.searchParams.set('after', '0');
  page.searchParams.set('category', 'File');
  const batch = observatory.liveEvents(bridge, page);
  const recent = batch.events.filter(e => !sinceMs || (e.timestamp_ms || 0) >= sinceMs);
  return changedFilesFromEvents(recent).slice(0, 40);
}

function activeWorkers(bridge, activeCards) {
  const workers = [];
  const seen = new Set();
  for (const card of activeCards) {
    if (!card.advancing) continue;
    const key = `${card.worker}:${card.model}:${card.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    workers.push({
      worker: card.worker,
      model: card.model,
      mission_id: card.id,
      mission_title: card.title,
      stage: card.current_stage,
      active: true
    });
  }
  return workers;
}

function liveActivityBoard(bridge, url) {
  visibility.ensure(bridge.controlStore.db);
  const tab = ['now', 'recent', 'history'].includes(url.searchParams.get('tab')) ? url.searchParams.get('tab') : 'now';
  const windowKey = WINDOWS[url.searchParams.get('window')] ? url.searchParams.get('window') : '24h';
  const windowMs = WINDOWS[windowKey];
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80).toLowerCase();
  const missionId = url.searchParams.get('mission');
  if (missionId && !display.id(missionId)) throw Error('Invalid Mission ID');
  const includeTechnical = url.searchParams.get('technical') === '1';
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20) || 20));
  const now = Date.now();
  const since = now - windowMs;

  const all = display.missionIndex(bridge);

  const cardsCache = new Map();
  const cardFor = (m, opts) => {
    const key = m.id + ':' + (opts.includeTechnical ? 't' : '') + (opts.includeTimeline === false ? 'n' : 'y');
    if (!cardsCache.has(key)) cardsCache.set(key, missionCard(bridge, m, opts));
    return cardsCache.get(key);
  };

  const activeMissions = all.filter(m => ACTIVE.has(m.state) && !visibility.isArchived(bridge.controlStore.db, m.id));
  const attention = all
    .filter(m => !visibility.isArchived(bridge.controlStore.db, m.id))
    .map(m => ({ m, v: display.missionView(bridge, m) }))
    .filter(({ m, v }) => display.ownerAttentionRequired(m, v))
    .slice(0, 20)
    .map(({ m, v }) => ({
      mission_id: m.id,
      title: clip(display.operatorTitle(bridge, m), 160),
      reason: v.display?.label || v.recovery?.headline || 'Needs Attention',
      required_decision: v.next_action || 'Owner decision required',
      evidence: v.recovery?.detail || null,
      state: v.state
    }));

  const nowCards = activeMissions.map(m => cardFor(m, { includeTimeline: true, includeTechnical: false }));
  const blockers = nowCards.flatMap(c => c.blockers).concat(
    attention.filter(a => !nowCards.some(c => c.id === a.mission_id)).map(a => ({
      mission_id: a.mission_id,
      reason: a.reason,
      required_decision: a.required_decision,
      evidence_event_id: null
    }))
  ).slice(0, 24);

  const recentMissions = all.filter(m => {
    if (visibility.isArchived(bridge.controlStore.db, m.id)) return false;
    if (ACTIVE.has(m.state)) return false;
    if (!RECENT_STATES.has(m.state)) return false;
    const view = display.missionView(bridge, m);
    const updated = view.finished_at || view.started_at || view.created_at || m.created_at || 0;
    return updated >= since;
  }).slice(0, 80);

  let historyMissions = all.filter(m => {
    if (missionId) return m.id === missionId;
    return true;
  });
  if (q) {
    historyMissions = historyMissions.filter(m => {
      const title = display.operatorTitle(bridge, m).toLowerCase();
      return title.includes(q) || m.id.toLowerCase().includes(q) || String(m.state).includes(q);
    });
  }
  const historyTotal = historyMissions.length;
  const historyPage = historyMissions.slice(offset, offset + limit).map(m =>
    cardFor(m, { includeTimeline: true, includeTechnical })
  );

  const changedNow = [
    ...nowCards.flatMap(c => c.changed_files),
    ...workspaceFiles(bridge, now - 3_600_000)
  ];
  const fileSeen = new Set();
  const dedupedNowFiles = [];
  for (const f of changedNow) {
    const key = `${f.mission_id || 'ws'}:${f.path}`;
    if (fileSeen.has(key)) continue;
    fileSeen.add(key);
    dedupedNowFiles.push(f);
  }

  const recentCards = recentMissions.map(m => cardFor(m, { includeTimeline: true, includeTechnical: false }));
  const recentFiles = recentCards.flatMap(c => c.changed_files).slice(0, 40);

  // Technical event stream for History (bounded, never the default Now view).
  let technical = { events: [], cursor: 0, has_more: false };
  if (tab === 'history' || includeTechnical) {
    const page = new URL('http://local/api/product/live-events');
    page.searchParams.set('after', url.searchParams.get('after') || '0');
    if (missionId) page.searchParams.set('mission', missionId);
    if (q) page.searchParams.set('q', q);
    const cat = url.searchParams.get('category');
    if (cat) page.searchParams.set('category', cat);
    technical = observatory.liveEvents(bridge, page);
  }

  const watch = bridge.workspaceActivityWatch?.status?.() || {
    continuous_filesystem_watch: false,
    observation: 'saved_filesystem_change_only',
    unsaved_typing_observable: false,
    authorship_claim: 'never_without_evidence'
  };

  return {
    version: 2,
    tab,
    window: windowKey,
    window_ms: windowMs,
    query: q || null,
    now: {
      empty: nowCards.length === 0,
      missions: nowCards,
      workers: activeWorkers(bridge, nowCards),
      changed_files: dedupedNowFiles.slice(0, 32),
      blockers: blockers.slice(0, 16),
      message: nowCards.length ? null : 'No active work.'
    },
    recent: {
      window: windowKey,
      window_ms: windowMs,
      missions: recentCards,
      changed_files: recentFiles,
      empty: recentCards.length === 0
    },
    history: {
      total: historyTotal,
      offset,
      limit,
      has_more: offset + limit < historyTotal,
      missions: historyPage,
      technical_events: technical.events,
      technical_cursor: technical.cursor,
      technical_has_more: technical.has_more
    },
    attention,
    connection: {
      stream: 'sse',
      resume: 'cursor',
      replay_on_reconnect: false,
      coalescing: true
    },
    observation_boundary: {
      continuous_filesystem_watch: !!watch.continuous_filesystem_watch,
      unsaved_typing_observable: false,
      authorship_without_evidence: false,
      cursor_agent_qualified: false,
      cursor_editor_visible_as: 'saved_file_change_only',
      opencode_activity: 'host_observed_events_only'
    },
    cursor: technical.cursor || 0,
    observed_at: now,
    authority: false
  };
}

module.exports = {
  WINDOWS,
  STAGE_ORDER,
  liveActivityBoard,
  missionCard,
  groupSummary,
  workflowTimeline,
  changedFilesFromEvents,
  projectEvents
};
