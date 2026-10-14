'use strict';
// Lightweight native FS watcher for authorized workspaces.
// Observes saved-file changes only. Never claims unsaved editor typing.
// Never invents process authorship without evidence.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.runtime', 'dist', 'coverage', '.cursor', '.turbo', 'vendor']);
const IGNORE_FILES = /^\.(DS_Store|.*\.swp|.*~$)|^(package-lock\.json)$/;
const DEBOUNCE_MS = 350;
const MAX_WATCHES = 8;
const REL_FILE = /^(?!\/)(?!\.\.(?:\/|$))[A-Za-z0-9._@+,-]+(?:\/[A-Za-z0-9._@+,-]+)*$/;

function safeRel(file) {
  if (typeof file !== 'string' || !REL_FILE.test(file) || file.length > 240) return null;
  if (IGNORE_FILES.test(path.basename(file))) return null;
  const parts = file.split('/');
  if (parts.some(p => IGNORE_DIRS.has(p))) return null;
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

  // Cursor editor may be the visible editor; Airodrom does not qualify Cursor Agent.
  // A saved filesystem event alone is never proof of Cursor authorship.
  return { writer_class: 'SAVED_FILE_CHANGE', mission_id: null, run_id: null, agent_id: null, authorship: 'unknown' };
}

function collectWatchRoots(bridge) {
  const roots = new Set();
  try {
    if (bridge.hostRepoRoot) roots.add(fs.realpathSync(bridge.hostRepoRoot));
  } catch { /* ignore */ }
  try {
    for (const p of bridge.projects?.listProjects?.({ limit: 20 }) || []) {
      const ws = p.workspace || p.root || p.path;
      if (typeof ws === 'string' && path.isAbsolute(ws)) {
        try { roots.add(fs.realpathSync(ws)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  try {
    const rows = bridge.controlStore.db.prepare(`
      SELECT DISTINCT json_extract(envelope,'$.workspace') AS workspace
      FROM cp_missions
      WHERE state IN ('dispatching','running','verifying','awaiting_acceptance')
        AND json_extract(envelope,'$.workspace') IS NOT NULL
      ORDER BY created_at DESC LIMIT 12`).all();
    for (const row of rows) {
      if (typeof row.workspace === 'string' && path.isAbsolute(row.workspace)) {
        try { roots.add(fs.realpathSync(row.workspace)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return [...roots].filter(root => {
    try {
      return fs.statSync(root).isDirectory();
    } catch { return false; }
  }).slice(0, MAX_WATCHES);
}

function createWorkspaceActivityWatch(bridge) {
  const watchers = new Map();
  const pending = new Map();
  let stopped = false;
  let active = false;

  function emit(workspace, relPath) {
    const file = safeRel(relPath);
    if (!file) return;
    let st;
    try { st = fs.statSync(path.join(workspace, file)); } catch { return; }
    if (!st.isFile() || st.size > 2_000_000) return;
    const meta = gitMeta(workspace);
    const stats = gitNumstat(workspace, file);
    const writer = classifyWriter(bridge, workspace, file);
    const observatory = require('./live-observatory');
    const eventType = 'fs.file_modified';
    const digest = createHash('sha256').update([workspace, file, st.mtimeMs, st.size].join('\0')).digest('hex');
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
          mtime_ms: Math.trunc(st.mtimeMs),
          observation: 'saved_filesystem_change',
          continuous_filesystem_watch: true
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
      observation: 'saved_filesystem_change_only',
      authorship_claim: 'never_without_evidence',
      unsaved_typing_observable: false
    };
  }

  return { start, stop, refresh, status };
}

module.exports = {
  createWorkspaceActivityWatch,
  safeRel,
  classifyWriter,
  gitNumstat,
  collectWatchRoots
};
