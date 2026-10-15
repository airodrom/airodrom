'use strict';
// Lightweight native FS watcher for independently authorized workspace scopes.
// Observes saved-file changes only inside active Mission / WORK-template allowlists.
// Never invents process authorship without evidence. Never watches idle projects or host roots.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.runtime', 'dist', 'coverage', '.cursor', '.turbo', 'vendor']);
const IGNORE_FILES = /^\.(DS_Store|.*\.swp|.*~$)|^(package-lock\.json)$/;
// Align with control-context SECRET_PATH — never observe credential-looking relative paths.
const SECRET_PATH = /(^|\/)(\.git|node_modules|\.env(?:\.[^/]*)?|\.ssh|\.aws|\.codex|\.pi|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]+\.(pem|key|p12|pfx))($|\/)/i;
const DEBOUNCE_MS = 350;
const MAX_WATCHES = 8;
const REL_FILE = /^(?!\/)(?!\.\.(?:\/|$))[A-Za-z0-9._@+,-]+(?:\/[A-Za-z0-9._@+,-]+)*$/;
// Active execution only — awaiting_acceptance is review, not authorized watch scope.
const ACTIVE_MISSION_STATES = Object.freeze(['dispatching', 'running', 'verifying']);

function safeRel(file) {
  if (typeof file !== 'string' || !REL_FILE.test(file) || file.length > 240) return null;
  if (IGNORE_FILES.test(path.basename(file))) return null;
  if (SECRET_PATH.test(file)) return null;
  const parts = file.split('/');
  if (parts.some(p => IGNORE_DIRS.has(p))) return null;
  if (parts.some(p => p.startsWith('.'))) return null;
  return file;
}

function realWorkspace(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return null;
  try {
    const root = fs.realpathSync(workspace);
    if (!fs.statSync(root).isDirectory()) return null;
    return root;
  } catch { return null; }
}

/** Reject any symlink component on the relative path; require lexical path == realpath. */
function canonicalAuthorizedFile(workspace, relPath) {
  const file = safeRel(relPath);
  if (!file) return null;
  const root = realWorkspace(workspace);
  if (!root) return null;
  let cur = root;
  for (const part of file.split('/')) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; }
    if (st.isSymbolicLink()) return null;
  }
  let realFile;
  try { realFile = fs.realpathSync(path.join(root, file)); } catch { return null; }
  const lexical = path.join(root, file);
  if (realFile !== lexical) return null;
  let st;
  try { st = fs.lstatSync(lexical); } catch { return null; }
  if (!st.isFile() || st.isSymbolicLink() || st.size > 2_000_000) return null;
  return { root, file, lexical, stat: st };
}

function gitMeta(workspace) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C' };
  const branch = spawnSync('/usr/bin/git', ['-C', workspace, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 4096, env
  });
  const name = spawnSync('/usr/bin/git', ['-C', workspace, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 4096, env
  });
  return {
    branch: branch.status === 0 ? String(branch.stdout || '').trim().slice(0, 120) || null : null,
    repository: name.status === 0 ? path.basename(String(name.stdout || '').trim()).slice(0, 120) || null : null
  };
}

function gitNumstat(workspace, relPath) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C' };
  const result = spawnSync('/usr/bin/git', ['-C', workspace, 'diff', '--numstat', '--', relPath], {
    encoding: 'utf8', timeout: 4000, maxBuffer: 64_000, env
  });
  if (result.status !== 0) return { lines_added: null, lines_removed: null, untracked: false };
  const line = String(result.stdout || '').trim().split('\n')[0] || '';
  if (!line) {
    const untracked = spawnSync('/usr/bin/git', ['-C', workspace, 'ls-files', '--others', '--exclude-standard', '--', relPath], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 4096, env
    });
    if (untracked.status === 0 && String(untracked.stdout || '').trim()) {
      return { lines_added: null, lines_removed: null, untracked: true };
    }
    return { lines_added: null, lines_removed: null, untracked: false };
  }
  const parts = line.split(/\t/);
  const added = parts[0] === '-' ? null : Number(parts[0]);
  const removed = parts[1] === '-' ? null : Number(parts[1]);
  return {
    lines_added: Number.isSafeInteger(added) ? added : null,
    lines_removed: Number.isSafeInteger(removed) ? removed : null,
    untracked: false
  };
}

function missionAllowsPath(envelope, workspaceRoot, relPath) {
  if (!envelope || typeof envelope.workspace !== 'string') return false;
  const root = realWorkspace(envelope.workspace);
  if (!root || root !== workspaceRoot) return false;
  if (!Array.isArray(envelope.allowed_files) || !envelope.allowed_files.includes(relPath)) return false;
  return true;
}

function loadMissionEnvelope(bridge, missionId) {
  if (!missionId) return null;
  try {
    const row = bridge.controlStore.db.prepare('SELECT envelope FROM cp_missions WHERE id=?').get(missionId);
    if (!row) return null;
    return typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope;
  } catch { return null; }
}

/**
 * Bind writer evidence to exact canonical workspace + authorized path + Mission/Run.
 * Never attribute by relative basename alone across workspaces or allowlists.
 */
function classifyWriter(bridge, workspace, relPath, authorizingMissionIds = null) {
  const root = realWorkspace(workspace);
  const file = safeRel(relPath);
  if (!root || !file) {
    return { writer_class: 'SAVED_FILE_CHANGE', mission_id: null, run_id: null, agent_id: null, authorship: 'unknown' };
  }
  const allow = Array.isArray(authorizingMissionIds) && authorizingMissionIds.length
    ? new Set(authorizingMissionIds)
    : null;

  // Prefer recent OpenCode FS evidence only when Mission workspace + allowlist match.
  try {
    const recent = bridge.ledger.list({ limit: 80, order: 'desc' });
    for (const event of recent.events || []) {
      if (!String(event.event_type || '').startsWith('fs.file_')) continue;
      if (event.metadata?.path !== file) continue;
      if (event.metadata?.agent_id !== 'opencode') continue;
      if (Date.now() - (event.timestamp_ms || 0) >= 15_000) continue;
      if (!event.mission_id) continue;
      if (allow && !allow.has(event.mission_id)) continue;
      const envelope = loadMissionEnvelope(bridge, event.mission_id);
      if (!missionAllowsPath(envelope, root, file)) continue;
      return {
        writer_class: 'OPENCODE_WRITE',
        mission_id: event.mission_id,
        run_id: event.run_id || null,
        agent_id: 'opencode',
        authorship: 'proven'
      };
    }
  } catch { /* best-effort */ }

  // Fallback: latest active OpenCode Mission in THIS workspace that explicitly allows THIS file.
  try {
    const rows = bridge.controlStore.db.prepare(`
      SELECT m.id AS mission_id, r.id AS run_id, m.envelope
      FROM cp_missions m
      JOIN cp_runs r ON r.mission_id = m.id
      WHERE m.state IN ('dispatching','running','verifying')
        AND r.agent_id = 'opencode'
      ORDER BY r.created_at DESC LIMIT 24`).all();
    for (const row of rows) {
      if (allow && !allow.has(row.mission_id)) continue;
      let envelope;
      try { envelope = typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope; } catch { continue; }
      if (!missionAllowsPath(envelope, root, file)) continue;
      return {
        writer_class: 'SAVED_FILE_CHANGE',
        mission_id: row.mission_id,
        run_id: row.run_id,
        agent_id: 'opencode',
        authorship: 'unproven'
      };
    }
  } catch { /* best-effort */ }

  return { writer_class: 'SAVED_FILE_CHANGE', mission_id: null, run_id: null, agent_id: null, authorship: 'unknown' };
}

/** One scope per authorizing Mission or WORK template — allowlists are never merged for attribution. */
function authorizedScopes(bridge) {
  const scopes = [];
  try {
    const rows = bridge.controlStore.db.prepare(`
      SELECT id, envelope FROM cp_missions
      WHERE state IN ('dispatching','running','verifying')
        AND json_extract(envelope,'$.workspace') IS NOT NULL
      ORDER BY created_at DESC LIMIT 24`).all();
    for (const row of rows) {
      let envelope;
      try { envelope = typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope; } catch { continue; }
      const root = realWorkspace(envelope.workspace);
      if (!root) continue;
      const allowed = new Set((envelope.allowed_files || []).filter(f => typeof f === 'string' && safeRel(f)));
      if (!allowed.size) continue;
      scopes.push({
        workspace: root,
        allowed_files: allowed,
        mission_id: row.id,
        mission_ids: [row.id],
        sources: ['active_mission']
      });
    }
  } catch { /* ignore */ }

  try {
    for (const t of bridge.workTemplates?.list?.('operator') || []) {
      if (t.state !== 'active') continue;
      if (Number.isSafeInteger(t.expires_at) && t.expires_at <= Date.now()) continue;
      const root = realWorkspace(t.workspace);
      if (!root) continue;
      const allowed = new Set((t.allowed_files || []).filter(f => typeof f === 'string' && safeRel(f)));
      if (!allowed.size) continue;
      scopes.push({
        workspace: root,
        allowed_files: allowed,
        mission_id: null,
        mission_ids: [],
        sources: ['work_template']
      });
    }
  } catch { /* ignore */ }

  return scopes.slice(0, MAX_WATCHES * 3);
}

function collectWatchRoots(bridge) {
  const roots = [];
  const seen = new Set();
  for (const scope of authorizedScopes(bridge)) {
    if (seen.has(scope.workspace)) continue;
    seen.add(scope.workspace);
    roots.push(scope.workspace);
    if (roots.length >= MAX_WATCHES) break;
  }
  return roots;
}

function pathAuthorized(scopes, workspace, relPath) {
  const file = safeRel(relPath);
  if (!file) return null;
  const root = realWorkspace(workspace);
  if (!root) return null;
  const matching = scopes.filter(s => s.workspace === root && s.allowed_files.has(file));
  if (!matching.length) return null;
  return { file, root, matching };
}

function createWorkspaceActivityWatch(bridge) {
  const watchers = new Map();
  const pending = new Map();
  let stopped = false;
  let active = false;
  let scopes = [];

  function emit(workspace, relPath) {
    scopes = authorizedScopes(bridge);
    const auth = pathAuthorized(scopes, workspace, relPath);
    if (!auth) return;
    const canonical = canonicalAuthorizedFile(auth.root, auth.file);
    if (!canonical) return;
    const { file, root, lexical, stat } = canonical;
    const authorizingMissionIds = [...new Set(auth.matching.flatMap(s => s.mission_ids || []).filter(Boolean))];
    const hasTemplate = auth.matching.some(s => s.sources.includes('work_template'));
    const writer = classifyWriter(bridge, root, file, authorizingMissionIds.length ? authorizingMissionIds : null);

    // Never invent a Mission ID. Unknown authorship stays unattributed inside the boundary.
    if (writer.mission_id && authorizingMissionIds.length && !authorizingMissionIds.includes(writer.mission_id)) {
      writer.mission_id = null;
      writer.run_id = null;
      writer.agent_id = null;
      writer.authorship = 'unknown';
      writer.writer_class = 'SAVED_FILE_CHANGE';
    }
    if (!writer.mission_id && !hasTemplate && !authorizingMissionIds.length) return;
    // Mission-null observations only when a WORK template authorizes the path, or authorship is proven.
    if (!writer.mission_id && !hasTemplate && writer.authorship === 'unknown') {
      // Observation remains inside an active Mission allowlist but unattributed — record without Mission stamp.
      // Still permitted as boundary-local observation (no cross-Mission ID).
    }

    const meta = gitMeta(root);
    const stats = gitNumstat(root, file);
    const observatory = require('./live-observatory');
    const digest = createHash('sha256').update([root, file, stat.mtimeMs, stat.size].join('\0')).digest('hex');
    const scopeSource = hasTemplate ? 'work_template' : 'active_mission';
    try {
      observatory.record(bridge, {
        eventType: 'fs.file_modified',
        missionId: writer.mission_id,
        runId: writer.run_id,
        metadata: {
          path: file,
          writer_class: writer.writer_class,
          authorship: writer.authorship || 'unknown',
          agent_id: writer.agent_id,
          project: meta.repository,
          branch: meta.branch,
          lines_added: stats.lines_added,
          lines_removed: stats.lines_removed,
          untracked: stats.untracked === true,
          mtime_ms: Math.trunc(stat.mtimeMs),
          observation: 'saved_filesystem_change',
          continuous_filesystem_watch: true,
          scope_source: scopeSource,
          workspace_bound: true
        },
        idempotencyKey: `ws-watch:${digest}`
      });
      if (stats.lines_added != null || stats.lines_removed != null || stats.untracked) {
        observatory.record(bridge, {
          eventType: 'git.diff_observed',
          missionId: writer.mission_id,
          runId: writer.run_id,
          metadata: {
            path: file,
            writer_class: writer.writer_class,
            agent_id: writer.agent_id,
            project: meta.repository,
            branch: meta.branch,
            lines_added: stats.lines_added,
            lines_removed: stats.lines_removed,
            untracked: stats.untracked === true,
            files_changed: 1,
            workspace_bound: true
          },
          idempotencyKey: `ws-git:${digest}`
        });
      }
      bridge.emit?.('change');
    } catch { /* observatory must never abort the watcher */ }
    void lexical;
  }

  function schedule(workspace, relPath) {
    const key = workspace + '\0' + relPath;
    const prev = pending.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      pending.delete(key);
      if (!stopped) emit(workspace, relPath);
    }, DEBOUNCE_MS);
    timer.unref?.();
    pending.set(key, timer);
  }

  function attach(root) {
    if (watchers.has(root) || stopped) return;
    try {
      const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (stopped || !filename) return;
        const rel = String(filename).split(path.sep).join('/');
        if (!safeRel(rel)) return;
        if (eventType !== 'change' && eventType !== 'rename') return;
        schedule(root, rel);
      });
      watcher.unref?.();
      watcher.on?.('error', () => {
        try { watcher.close(); } catch { /* ignore */ }
        watchers.delete(root);
      });
      watchers.set(root, watcher);
    } catch { /* recursive watch unavailable on some hosts */ }
  }

  function refresh() {
    if (stopped) return;
    scopes = authorizedScopes(bridge);
    const roots = collectWatchRoots(bridge);
    for (const root of roots) attach(root);
    for (const [root, watcher] of watchers) {
      if (!roots.includes(root)) {
        try { watcher.close(); } catch { /* ignore */ }
        watchers.delete(root);
      }
    }
    active = watchers.size > 0;
  }

  function start() {
    stopped = false;
    refresh();
    return status();
  }

  function stop() {
    stopped = true;
    active = false;
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    for (const watcher of watchers.values()) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    watchers.clear();
  }

  function status() {
    return {
      continuous_filesystem_watch: active,
      watched_roots: watchers.size,
      authorized_scopes: scopes.length,
      observation: 'saved_filesystem_change_only',
      authorship_claim: 'never_without_evidence',
      unsaved_typing_observable: false,
      scope: 'active_mission_or_work_template_allowlist'
    };
  }

  return { start, stop, refresh, status, emitForTest: emit };
}

module.exports = {
  createWorkspaceActivityWatch,
  safeRel,
  classifyWriter,
  gitNumstat,
  collectWatchRoots,
  authorizedScopes,
  pathAuthorized,
  canonicalAuthorizedFile,
  missionAllowsPath,
  ACTIVE_MISSION_STATES,
  SECRET_PATH
};
