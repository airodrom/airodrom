'use strict';
// ADR 0036: Live Agent Observatory — sanitized Mission-scoped telemetry projection.
// Never authority. Never raw secrets, reasoning, env, or out-of-scope file contents.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { id, eventView, missionView, STAGES } = (() => {
  const po = require('./product-observability');
  return { id: po.id, eventView: po.eventView, missionView: po.missionView, STAGES: po.STAGES };
})();
const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const { redactPayload } = require('./event-ledger');

const REL_FILE = /^(?!\/)(?!\.\.(?:\/|$))[A-Za-z0-9._@+,-]+(?:\/[A-Za-z0-9._@+,-]+)*$/;
const TOOL_NAME = /^[A-Za-z0-9_./:-]{1,80}$/;
const MAX_DIFF_LINES = 200;
const MAX_DIFF_BYTES = 24_000;
const MAX_OUTPUT_CHARS = 4_000;
const MAX_SSE_BUFFER = 100;
const HEARTBEAT_MS = 12_000;
const OBSERVATORY_CATEGORIES = Object.freeze(['Mission', 'Runtime', 'Worker', 'Capability', 'File', 'Git', 'Command', 'Test', 'Verification', 'Approval', 'Settlement', 'Memory', 'System']);

function time(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function enumValue(value, values, fallback = null) { return values.includes(value) ? value : fallback; }
function clipText(value, limit = MAX_OUTPUT_CHARS) {
  const redacted = redactPayload(String(value ?? '')).value;
  if (Buffer.byteLength(redacted) <= limit) return redacted;
  return Buffer.from(redacted, 'utf8').subarray(0, Math.max(0, limit - 3)).toString('utf8') + '…';
}
function safeRel(file) {
  if (typeof file !== 'string' || !REL_FILE.test(file) || file.length > 240) return null;
  return file;
}
function safeTool(name) {
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) return null;
  return name;
}

function record(bridge, { eventType, missionId, runId = null, metadata = {}, payload = undefined, idempotencyKey = undefined }) {
  if (!STAGES[eventType]) throw Error('Unsupported observatory event type');
  if (!id(missionId)) throw Error('Invalid Mission ID');
  const meta = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (typeof key !== 'string' || key.length > 64) continue;
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) meta[key] = value;
    else if (typeof value === 'string') meta[key] = clipText(value, 240);
    else if (Array.isArray(value) && value.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)) {
      meta[key] = value.slice(0, 32).map(v => typeof v === 'string' ? clipText(v, 120) : v);
    }
  }
  // Never embed raw 64-hex digests in idempotency keys — identity gate treats them as legacy.
  let key = idempotencyKey;
  if (typeof key === 'string') {
    key = 'obs.' + createHash('sha256').update(key).digest('base64url').slice(0, 22);
  }
  // Drop content digests from display metadata; keep only short non-hex prefixes.
  if (typeof meta.sha256 === 'string') {
    meta.digest_prefix = meta.sha256.slice(0, 12);
    delete meta.sha256;
  }
  return bridge.controlStore.event(eventType, missionId, { ...meta, authority: false }, {
    ...(runId && id(runId) ? { runId } : {}),
    ...(payload !== undefined ? { payload: clipText(payload, MAX_OUTPUT_CHARS) } : {}),
    ...(key ? { idempotencyKey: key } : {})
  });
}

function observeOpenCodeLine(bridge, { missionId, runId, line, agentId = 'opencode' }) {
  let event; try { event = JSON.parse(line); } catch { return null; }
  if (!event || typeof event !== 'object') return null;
  const type = event.type;
  if (type === 'step_start') {
    return record(bridge, { eventType: 'worker.started', missionId, runId, metadata: { agent_id: agentId, phase: 'step' }, idempotencyKey: `obs-worker-start:${missionId}:${runId || 'na'}:${event.timestamp || Date.now()}` });
  }
  if (type === 'tool_use') {
    const tool = safeTool(event.part?.tool || event.tool || event.name || 'tool');
    if (!tool) return null;
    return record(bridge, { eventType: 'worker.tool_requested', missionId, runId, metadata: { agent_id: agentId, tool }, idempotencyKey: `obs-tool-req:${missionId}:${runId || 'na'}:${tool}:${event.part?.id || event.id || Date.now()}` });
  }
  if (type === 'step_finish') {
    return record(bridge, { eventType: 'worker.tool_completed', missionId, runId, metadata: { agent_id: agentId }, idempotencyKey: `obs-step-fin:${missionId}:${runId || 'na'}:${event.timestamp || Date.now()}` });
  }
  // reasoning / text contents are never persisted for observatory.
  return null;
}

function observeHostFileChanges(bridge, { missionId, runId, changes = [], agentId = 'opencode' }) {
  const out = [];
  for (const change of changes.slice(0, 32)) {
    const file = safeRel(change.path || change.file || change);
    if (!file) continue;
    const op = enumValue(change.op, ['created', 'modified', 'deleted', 'read'], 'modified');
    const eventType = op === 'created' ? 'fs.file_created' : op === 'deleted' ? 'fs.file_deleted' : op === 'read' ? 'fs.file_read' : 'fs.file_modified';
    const linesAdded = count(change.lines_added) ?? null;
    const linesRemoved = count(change.lines_removed) ?? null;
    out.push(record(bridge, {
      eventType, missionId, runId,
      metadata: { agent_id: agentId, path: file, ...(linesAdded !== null ? { lines_added: linesAdded } : {}), ...(linesRemoved !== null ? { lines_removed: linesRemoved } : {}), sha256: typeof change.sha256 === 'string' && /^[a-f0-9]{64}$/.test(change.sha256) ? change.sha256 : undefined },
      idempotencyKey: `obs-fs:${missionId}:${runId || 'na'}:${eventType}:${file}:${change.sha256 || change.preimage_sha256 || Date.now()}`
    }));
  }
  return out;
}

function lineStats(before, after) {
  const a = String(before || '').split('\n'), b = String(after || '').split('\n');
  // Host-bounded approximate churn; not a full Myers diff.
  let removed = 0, added = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (i < a.length && (i >= b.length || a[i] !== b[i])) removed++;
    if (i < b.length && (i >= a.length || a[i] !== b[i])) added++;
  }
  return { lines_added: added, lines_removed: removed };
}

function observeOpenCodeResult(bridge, { missionId, runId, changes = [], agentId = 'opencode' }) {
  const enriched = changes.map(c => {
    const file = safeRel(c.path);
    if (!file) return null;
    const stats = c.content !== undefined && c.preimage_sha256 ? lineStats(
      // Preimage content is not retained; approximate from size when unavailable.
      '', c.content
    ) : { lines_added: null, lines_removed: null };
    // Prefer byte-size delta when full preimage unavailable.
    if (stats.lines_added === 0 && stats.lines_removed === 0 && typeof c.content === 'string') {
      const lines = c.content.split('\n').length;
      return { path: file, op: 'modified', sha256: c.sha256, lines_added: lines, lines_removed: null };
    }
    return { path: file, op: 'modified', sha256: c.sha256, ...stats };
  }).filter(Boolean);
  const recorded = observeHostFileChanges(bridge, { missionId, runId, changes: enriched, agentId });
  if (enriched.length) {
    recorded.push(record(bridge, {
      eventType: 'git.diff_observed', missionId, runId,
      metadata: { agent_id: agentId, files_changed: enriched.length, paths: enriched.map(e => e.path).slice(0, 16) },
      idempotencyKey: `obs-diff:${missionId}:${runId || 'na'}:${enriched.map(e => e.sha256 || e.path).join(':').slice(0, 120)}`
    }));
  }
  recorded.push(record(bridge, {
    eventType: 'worker.terminated', missionId, runId,
    metadata: { agent_id: agentId, status: 'completed' },
    idempotencyKey: `obs-worker-term:${missionId}:${runId || 'na'}`
  }));
  return recorded;
}

function projectEvent(event) {
  const base = eventView(event);
  if (!base) return null;
  const meta = event.metadata || {};
  const extra = {};
  if (safeRel(meta.path)) extra.path = meta.path;
  if (safeTool(meta.tool)) extra.tool = meta.tool;
  if (typeof meta.job_name === 'string' && TOOL_NAME.test(meta.job_name)) extra.job = meta.job_name;
  if (Number.isInteger(meta.exit_code) && meta.exit_code >= 0 && meta.exit_code <= 255) extra.exit_code = meta.exit_code;
  if (count(meta.lines_added) !== null) extra.lines_added = meta.lines_added;
  if (count(meta.lines_removed) !== null) extra.lines_removed = meta.lines_removed;
  if (Array.isArray(meta.paths)) extra.paths = meta.paths.map(safeRel).filter(Boolean).slice(0, 16);
  if (event.payload && ['Command', 'Test', 'Git'].includes(base.category)) extra.output = clipText(event.payload, 1200);
  return { ...base, ...extra, heartbeat_at: time(meta.heartbeat_at) || base.timestamp_ms };
}

function liveEvents(bridge, url) {
  const after = Number(url.searchParams.get('after') || 0);
  if (!Number.isSafeInteger(after) || after < 0) throw Error('Invalid event cursor');
  const mission = url.searchParams.get('mission');
  if (mission && !id(mission)) throw Error('Invalid Mission ID');
  const category = url.searchParams.get('category');
  if (category && !OBSERVATORY_CATEGORIES.includes(category)) throw Error('Invalid category');
  const query = (url.searchParams.get('q') || '').trim().slice(0, 80).toLowerCase();
  const batch = bridge.ledger.list({ afterSequence: after, limit: 200, ...(mission ? { missionId: mission } : {}) });
  const seen = new Set();
  const events = [];
  for (const raw of batch.events) {
    if (!id(raw.event_id) || seen.has(raw.event_id)) continue;
    seen.add(raw.event_id);
    const view = projectEvent(raw);
    if (!view) continue;
    if (category && view.category !== category) continue;
    if (query && !`${view.label} ${view.path || ''} ${view.tool || ''} ${view.job || ''}`.toLowerCase().includes(query)) continue;
    events.push(view);
  }
  return { events, cursor: batch.events.at(-1)?.sequence || after, has_more: batch.has_more, observed_at: Date.now(), transport: 'poll' };
}

function snapshot(bridge, missionId) {
  if (!id(missionId)) throw Error('Invalid Mission ID');
  const mission = bridge.missions.require(missionId);
  const view = missionView(bridge, mission);
  const batch = bridge.ledger.list({ missionId, limit: 200, order: 'desc' });
  const projected = [];
  const seen = new Set();
  for (const raw of batch.events) {
    if (seen.has(raw.event_id)) continue;
    seen.add(raw.event_id);
    const p = projectEvent(raw);
    if (p) projected.push(p);
  }
  projected.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  const files = [];
  const commands = [];
  const tests = [];
  const worker = [];
  for (const e of projected) {
    if (e.category === 'File' || e.category === 'Git') files.push(e);
    if (e.category === 'Command') commands.push(e);
    if (e.category === 'Test') tests.push(e);
    if (e.category === 'Worker' || e.category === 'Runtime' || e.category === 'Capability') worker.push(e);
  }
  const latest = projected.at(-1) || null;
  const advancing = ['dispatching', 'running', 'verifying'].includes(view.state);
  const heartbeat = projected.filter(e => e.event_type === 'observatory.heartbeat' || e.category === 'Worker' || e.category === 'Runtime').at(-1);
  const midRunWorker = worker.some(e => ['worker.tool_requested', 'worker.started', 'runtime.execution.started'].includes(e.event_type));
  const postRunFiles = files.some(e => String(e.event_type || '').startsWith('fs.') || e.event_type === 'git.diff_observed' || e.event_type === 'git.diff.observed');
  return {
    version: 1,
    mission: view,
    activity: {
      current_label: latest?.label || view.timeline.at(-1)?.label || null,
      phase: latest?.stage || null,
      worker: view.runtime,
      model: view.model?.id || null,
      elapsed_s: view.started_at ? Math.max(0, Math.floor(((view.finished_at || Date.now()) - view.started_at) / 1000)) : null,
      last_heartbeat_ms: heartbeat?.timestamp_ms || latest?.timestamp_ms || view.observed_at,
      advancing,
      error: latest?.branch === 'attention' ? latest.label : null,
      detail_available: projected.length > 0
    },
    observation_boundary: {
      worker_tools: 'openCode_ndjson_mid_run',
      files: 'host_measured_after_turn',
      git_diff: 'host_measured_authorized_paths',
      commands_tests: 'governed_job_ledger',
      continuous_filesystem_watch: false,
      hidden_reasoning: false
    },
    files: files.slice(-64),
    commands: commands.slice(-64),
    tests: tests.slice(-32),
    worker: worker.slice(-64),
    events: projected.slice(-200),
    cursor: batch.events[0]?.sequence || 0,
    has_more: batch.has_more,
    observed_at: Date.now(),
    signals: { mid_run_worker: midRunWorker, post_run_files: postRunFiles },
    limitations: [
      'Observatory shows host-observed sanitized events only.',
      'OpenCode tool names are observed from mid-run NDJSON; arguments and reasoning are never stored.',
      'File creates/modifies/deletes are host-measured after the worker turn — not a continuous filesystem watch.',
      'File contents appear only for authorized workspace paths via bounded Git diff.',
      'Model reasoning and prompts remain private.'
    ]
  };
}

function authorizedDiff(bridge, missionId, relPath) {
  if (!id(missionId)) throw Error('Invalid Mission ID');
  const file = safeRel(relPath);
  if (!file) throw Error('Invalid file path');
  const mission = bridge.missions.require(missionId);
  const allowed = mission.envelope?.allowed_files || [];
  if (!allowed.includes(file)) throw Error('File is outside this Mission permission scope');
  const workspace = mission.envelope?.workspace;
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw Error('Mission workspace unavailable');
  const realWorkspace = fs.realpathSync(workspace);
  const target = fs.realpathSync(path.join(realWorkspace, file));
  if (!target.startsWith(realWorkspace + path.sep) && target !== path.join(realWorkspace, file)) throw Error('File is outside authorized workspace');
  const result = spawnSync('/usr/bin/git', ['-C', realWorkspace, 'diff', '--no-color', '--unified=3', '--', file], {
    encoding: 'utf8', timeout: 5000, maxBuffer: MAX_DIFF_BYTES, env: { PATH: '/usr/bin:/bin', LANG: 'C' }
  });
  if (result.error) throw Error('Git diff unavailable');
  let text = clipText((result.stdout || '') + (result.stderr ? '\n' + result.stderr : ''), MAX_DIFF_BYTES);
  const lines = text.split('\n').slice(0, MAX_DIFF_LINES);
  if (text.split('\n').length > MAX_DIFF_LINES) lines.push('…');
  // Never return binary or credential-looking blobs.
  if (lines.some(l => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(l))) throw Error('Binary or unsafe diff withheld');
  const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
  return {
    mission_id: missionId,
    path: file,
    exit_code: result.status ?? null,
    lines_added: added,
    lines_removed: removed,
    truncated: text.split('\n').length > MAX_DIFF_LINES || Buffer.byteLength(result.stdout || '') >= MAX_DIFF_BYTES,
    diff: lines.join('\n'),
    digest: createHash('sha256').update(lines.join('\n')).digest('hex'),
    observed_at: Date.now(),
    authority: false
  };
}

function attachSse(req, res, bridge, url) {
  const mission = url.searchParams.get('mission');
  if (mission && !id(mission)) throw Error('Invalid Mission ID');
  let cursor = Number(url.searchParams.get('after') || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error('Invalid event cursor');
  const category = url.searchParams.get('category') || '';
  if (category && !OBSERVATORY_CATEGORIES.includes(category)) throw Error('Invalid category');
  req.setTimeout?.(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const seen = new Set();
  let closed = false;
  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('ready', { cursor, observed_at: Date.now(), transport: 'sse' });
  const pump = () => {
    if (closed) return;
    try {
      const page = new URL('http://local/api/product/live-events');
      page.searchParams.set('after', String(cursor));
      if (mission) page.searchParams.set('mission', mission);
      if (category) page.searchParams.set('category', category);
      const batch = liveEvents(bridge, page);
      let buffered = 0;
      for (const event of batch.events) {
        if (seen.has(event.event_id)) continue;
        seen.add(event.event_id);
        if (seen.size > 2000) {
          const first = seen.values().next().value;
          seen.delete(first);
        }
        send('event', event);
        cursor = Math.max(cursor, event.sequence || cursor);
        if (++buffered >= MAX_SSE_BUFFER) break;
      }
      if (batch.cursor > cursor) cursor = batch.cursor;
    } catch (error) {
      send('error', { message: 'Observatory stream interrupted', reconnect_after_ms: 2000 });
    }
  };
  pump();
  const poll = setInterval(pump, 750);
  const beat = setInterval(() => send('heartbeat', { cursor, observed_at: Date.now() }), HEARTBEAT_MS);
  const onChange = () => pump();
  bridge.on?.('change', onChange);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(beat);
    bridge.off?.('change', onChange);
    try { res.end(); } catch {}
  };
  req.on('close', close);
  req.on('aborted', close);
  return { close };
}

module.exports = {
  OBSERVATORY_CATEGORIES,
  record,
  observeOpenCodeLine,
  observeHostFileChanges,
  observeOpenCodeResult,
  lineStats,
  projectEvent,
  liveEvents,
  snapshot,
  authorizedDiff,
  attachSse,
  clipText,
  safeRel,
  safeTool
};
