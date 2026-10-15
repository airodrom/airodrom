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
  // Dotfiles and dot-directories (except known ignore already handled) stay out of observation.
  const parts = file.split('/');
  if (parts.some(p => IGNORE_DIRS.has(p))) return null;
  if (parts.some(p => p.startsWith('.'))) return null;
  return file;
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

function classifyWriter(bridge, workspace, relPath) {
  // Prefer OpenCode evidence from a recent observatory event for this path.
  try {
    const recent = bridge.ledger.list({ limit: 80, order: 'desc' });
    for (const event of recent.events || []) {
      if (!String(event.event_type || '').startsWith('fs.file_')) continue;
      if (event.metadata?.path !== relPath) continue;
      if (event.metadata?.agent_id === 'opencode' && Date.now() - (event.timestamp_ms || 0) < 15_000) {
        return { writer_class: 'OPENCODE_WRITE', mission_id: event.mission_id || null, run_id: event.run_id || null, agent_id: 'opencode' };
      }
    }
  } catch { /* best-effort */ }

  // Active OpenCode Mission in this workspace is evidence of a candidate worker,
  // but without a matching tool/fs event we must not claim authorship.
  try {
    const row = bridge.controlStore.db.prepare(`
      SELECT m.id AS mission_id, r.id AS run_id, r.agent_id
      FROM cp_missions m
      JOIN cp_runs r ON r.mission_id = m.id
      WHERE m.state IN ('dispatching','running','verifying')
        AND json_extract(m.envelope,'$.workspace') = ?
        AND r.agent_id = 'opencode'
      ORDER BY r.created_at DESC LIMIT 1`).get(workspace);
    if (row) {
      return { writer_class: 'SAVED_FILE_CHANGE', mission_id: row.mission_id, run_id: row.run_id, agent_id: 'opencode', authorship: 'unproven' };
    }
  } catch { /* best-effort */ }

  return { writer_class: 'SAVED_FILE_CHANGE', mission_id: null, run_id: null, agent_id: null, authorship: 'unknown' };
}

/** Independently authorized watch scopes: active Missions and active WORK templates only. */
function authorizedScopes(bridge) {
  const byRoot = new Map();
  const add = (workspace, allowedFiles, missionId, source) => {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return;
    let root;
    try { root = fs.realpathSync(workspace); } catch { return; }
    try {
      if (!fs.statSync(root).isDirectory()) return;
    } catch { return; }
    const allowed = new Set(Array.isArray(allowedFiles) ? allowedFiles.filter(f => typeof f === 'string' && safeRel(f)) : []);
    const prev = byRoot.get(root);
    if (!prev) {
      byRoot.set(root, { workspace: root, allowed_files: allowed, mission_ids: missionId ? [missionId] : [], sources: [source] });
      return;
    }
    for (const f of allowed) prev.allowed_files.add(f);
    if (missionId) prev.mission_ids.push(missionId);
    if (!prev.sources.includes(source)) prev.sources.push(source);
  };

  try {
    const rows = bridge.controlStore.db.prepare(`
      SELECT id, envelope FROM cp_missions
      WHERE state IN ('dispatching','running','verifying')
        AND json_extract(envelope,'$.workspace') IS NOT NULL
      ORDER BY created_at DESC LIMIT 12`).all();
    for (const row of rows) {
      let envelope;
      try { envelope = typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope; } catch { continue; }
      add(envelope.workspace, envelope.allowed_files || [], row.id, 'active_mission');
    }
  } catch { /* ignore */ }

  try {
    for (const t of bridge.workTemplates?.list?.('operator') || []) {
      if (t.state !== 'active') continue;
      if (Number.isSafeInteger(t.expires_at) && t.expires_at <= Date.now()) continue;
      add(t.workspace, t.allowed_files || [], null, 'work_template');
    }
  } catch { /* ignore */ }

  return [...byRoot.values()].slice(0, MAX_WATCHES);
}

function collectWatchRoots(bridge) {
  // Deliberately omits hostRepoRoot and idle project listings.
  return authorizedScopes(bridge).map(s => s.workspace);
}

function pathAuthorized(scopes, workspace, relPath) {
  const file = safeRel(relPath);
  if (!file) return null;
  const scope = scopes.find(s => s.workspace === workspace);
  if (!scope) return null;
  // Empty allowlist means the authorizing record had no approved files — deny all.
  if (!scope.allowed_files.size) return null;
  if (!scope.allowed_files.has(file)) return null;
  return { file, scope };
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
    const { file, scope } = auth;
    let lst;
    try { lst = fs.lstatSync(path.join(workspace, file)); } catch { return; }
    if (lst.isSymbolicLink() || !lst.isFile() || lst.size > 2_000_000) return;
    // Re-resolve to catch symlink races after lstat.
    let realFile;
    try {
      realFile = fs.realpathSync(path.join(workspace, file));
      if (realFile !== path.join(workspace, file) && !realFile.startsWith(workspace + path.sep)) return;
    } catch { return; }
    const writer = classifyWriter(bridge, workspace, file);
    // Mission-null unknown writers are only recorded when an approved WORK-template
    // scope covers the path (standing local auth). Never for idle/global roots.
    if (!writer.mission_id && writer.authorship === 'unknown' && !scope.sources.includes('work_template') && !scope.mission_ids.length) {
      return;
    }
    if (!writer.mission_id && writer.authorship === 'unknown' && !scope.sources.includes('work_template')) {
      // Active mission scope without a bound mission_id from classifyWriter: attach primary mission.
      writer.mission_id = scope.mission_ids[0] || null;
    }
    // Refuse global Mission-null observations outside an approved template/mission scope.
    if (!writer.mission_id && !scope.sources.includes('work_template')) return;

    const meta = gitMeta(workspace);
    const stats = gitNumstat(workspace, file);
    const observatory = require('./live-observatory');
    const eventType = 'fs.file_modified';
    const digest = createHash('sha256').update([workspace, file, lst.mtimeMs, lst.size].join('\0')).digest('hex');
    try {
      observatory.record(bridge, {
        eventType,
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
          mtime_ms: Math.trunc(lst.mtimeMs),
          observation: 'saved_filesystem_change',
          continuous_filesystem_watch: true,
          scope_source: scope.sources[0] || null
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
            files_changed: 1
          },
          idempotencyKey: `ws-git:${digest}`
        });
      }
      bridge.emit?.('change');
    } catch { /* observatory must never abort the watcher */ }
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
    const roots = scopes.map(s => s.workspace);
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
  ACTIVE_MISSION_STATES,
  SECRET_PATH
};
