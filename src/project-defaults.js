'use strict';
// Owner-configured project default repositories for Autopilot / zero-setup.
// Defaults are caller-bound enrollment metadata, never inferred from a project name alone.
const fs = require('node:fs');
const path = require('node:path');
const { identifier, text, object } = require('./control-plane-store');

function isLiveGitRoot(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  try {
    const root = fs.realpathSync(candidate);
    // Require a repository rooted at this exact directory. Walking into an
    // ancestor Git checkout must not revive cleaned disposable leftovers.
    if (!fs.existsSync(path.join(root, '.git'))) return false;
    return require('./control-execution').repositoryRoot(root) === root;
  } catch {
    return false;
  }
}

function liveRepositories(project) {
  const out = [];
  for (const candidate of project?.repositories || []) {
    if (!isLiveGitRoot(candidate)) continue;
    const root = fs.realpathSync(candidate);
    if (!out.includes(root)) out.push(root);
  }
  return out;
}

function isDisposableWorktreePath(root) {
  return /\/\.airodrom-da-worktrees\/worktrees\//.test(String(root || ''))
    || /\/airodrom-task-sandboxes\//.test(String(root || ''));
}

class ProjectDefaults {
  constructor(bridge) {
    this.bridge = bridge;
    this.db = bridge.controlStore.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_project_defaults(
      project_id TEXT PRIMARY KEY,
      repository TEXT NOT NULL,
      record TEXT NOT NULL,
      configured_at INTEGER NOT NULL,
      configured_by TEXT NOT NULL,
      request_id TEXT NOT NULL
    )`);
  }

  read(projectId) {
    identifier(projectId);
    const row = this.db.prepare('SELECT * FROM cp_project_defaults WHERE project_id=?').get(projectId);
    if (!row) return null;
    const record = JSON.parse(row.record);
    return {
      project_id: row.project_id,
      repository: row.repository,
      configured_at: row.configured_at,
      configured_by: row.configured_by,
      request_id: row.request_id,
      remote: record.remote || null,
      head: record.head || null,
      branch: record.branch || null,
      authority: false,
    };
  }

  list() {
    return this.db.prepare('SELECT project_id FROM cp_project_defaults ORDER BY configured_at DESC')
      .all()
      .map(row => this.read(row.project_id))
      .filter(Boolean);
  }

  inspectRepository(repository) {
    const root = fs.realpathSync(repository);
    if (require('./control-execution').repositoryRoot(root) !== root) throw Error('Exact repository root required');
    const { spawnSync } = require('node:child_process');
    const run = (...args) => {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw Error('Repository Git inspection failed');
      return String(result.stdout || '').trim();
    };
    return {
      repository: root,
      remote: run('remote', 'get-url', 'origin'),
      head: run('rev-parse', 'HEAD'),
      branch: run('rev-parse', '--abbrev-ref', 'HEAD'),
    };
  }

  setDefault(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
    object(input, ['project_id', 'repository', 'confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.project_id);
    identifier(input.request_id);
    text(input.repository, 'repository', 1000);
    const project = this.bridge.projects.getProject(input.project_id);
    if (!project || project.status !== 'active') throw Error('Active enrolled project required');
    const inspected = this.inspectRepository(input.repository);
    const allowed = liveRepositories(project);
    if (!allowed.includes(inspected.repository)) {
      throw Error('Default repository must already be enrolled on the project');
    }
    const now = Date.now();
    const record = {
      version: 1,
      project_id: project.projectId,
      project_name: project.name,
      ...inspected,
      authority: false,
    };
    this.db.prepare(`INSERT INTO cp_project_defaults VALUES(?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET repository=excluded.repository, record=excluded.record,
        configured_at=excluded.configured_at, configured_by=excluded.configured_by, request_id=excluded.request_id`)
      .run(project.projectId, inspected.repository, JSON.stringify(record), now, owner, input.request_id);
    this.bridge.controlStore.event('project_default.set', null, {
      project_id: project.projectId,
      repository: inspected.repository,
      request_id: input.request_id,
      authority: false,
    });
    return this.read(project.projectId);
  }

  clear(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
    object(input, ['project_id', 'confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.project_id);
    identifier(input.request_id);
    this.db.prepare('DELETE FROM cp_project_defaults WHERE project_id=?').run(input.project_id);
    this.bridge.controlStore.event('project_default.cleared', null, {
      project_id: input.project_id,
      request_id: input.request_id,
      authority: false,
    });
    return { project_id: input.project_id, cleared: true, authority: false };
  }

  // Prefer the owner default, then a single primary clone, else fail closed.
  selectRepository(project, { instruction = '', explicitWorkspace = null } = {}) {
    const live = liveRepositories(project);
    if (!live.length) return { ok: false, clarify: true, code: 'ENROLLED_WORKSPACE_REQUIRED', message: 'No live Git repository remains enrolled for ' + project.name, choices: [] };

    if (explicitWorkspace) {
      const wanted = String(explicitWorkspace);
      const hit = live.find(root => root === wanted || path.basename(root) === wanted || root.endsWith('/' + wanted));
      if (hit) return { ok: true, project, workspace: hit };
      return { ok: false, clarify: true, code: 'ENROLLED_WORKSPACE_REQUIRED', message: 'That enrolled workspace label is not a live repository under ' + project.name, choices: live.map(root => ({ project_name: project.name, workspace_label: path.basename(root) })) };
    }

    const textInstruction = String(instruction || '');
    for (const root of live) {
      if (textInstruction.includes(root) || new RegExp('\\b' + escape(path.basename(root)) + '\\b').test(textInstruction)) {
        return { ok: true, project, workspace: root };
      }
    }

    const configured = this.read(project.projectId);
    if (configured?.repository && live.includes(configured.repository)) {
      return { ok: true, project, workspace: configured.repository, defaulted: true };
    }

    const primary = live.filter(root => !isDisposableWorktreePath(root));
    const pool = primary.length ? primary : live;
    if (pool.length === 1) return { ok: true, project, workspace: pool[0] };
    return {
      ok: false,
      clarify: true,
      code: 'ENROLLED_REPOSITORY_AMBIGUOUS',
      message: 'Which authorized repository under ' + project.name + ' should I use?',
      choices: pool.map(root => ({ project_name: project.name, workspace_label: path.basename(root) })),
    };
  }
}

function escape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  ProjectDefaults,
  isLiveGitRoot,
  liveRepositories,
  isDisposableWorktreePath,
};
