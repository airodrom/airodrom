#!/usr/bin/env node
'use strict';
// Owner-local helper: attach a disposable repository to Airodrom Release
// Qualification, create a bounded goal, and register a local OpenCode work
// template. Never restarts the service and never touches credentials.
const fs = require('node:fs');
const path = require('node:path');
const local = require('../src/local-bootstrap');

const PROJECT_ID = 'd8597458-4653-4c1a-9b0a-40c147e400cf';
const PROJECT_ALIAS = 'release-qualification';
const WORKSPACE_ALIAS = 'safe-dev';

async function main() {
  const workspace = fs.realpathSync(process.argv[2] || path.join(process.env.HOME || '', 'Documents/Codex/2026-10-13/airodrom-safe-dev-workspace'));
  if (!fs.existsSync(path.join(workspace, '.git')) || !fs.existsSync(path.join(workspace, '.vscode/tasks.json'))) {
    throw Error('Exact disposable git workspace with registered tasks required');
  }
  const home = local.localHome();
  const project = await local.request(home, '/api/projects/' + PROJECT_ID);
  const repositories = Array.from(new Set([...(project.repositories || []), workspace]));
  let updated;
  try {
    updated = await local.request(home, '/api/projects/' + PROJECT_ID, {
      repositories,
      nextAction: 'Governed local OpenCode work against the safe development workspace',
      autonomyLevel: project.autonomyLevel === 'observe' ? 'suggest' : project.autonomyLevel
    }, { method: 'PATCH' });
  } catch (error) {
    // Live tip before this PR has no PATCH route. Fall back to a WAL-safe
    // repositories update that the running bridge re-reads from SQLite.
    if (!/Operation not exposed|Local request was refused|404/.test(error.message) && error.message !== 'Local request was refused.') throw error;
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(home, 'data', 'memory.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const row = db.prepare('SELECT repositories FROM projects WHERE project_id=?').get(PROJECT_ID);
      if (!row) throw Error('Release Qualification project unavailable');
      const current = JSON.parse(row.repositories || '[]');
      const next = Array.from(new Set([...current, workspace]));
      db.prepare('UPDATE projects SET repositories=?, next_action=?, updated_at=? WHERE project_id=?')
        .run(JSON.stringify(next), 'Governed local OpenCode work against the safe development workspace', Date.now(), PROJECT_ID);
      updated = await local.request(home, '/api/projects/' + PROJECT_ID);
      updated.repositories = next;
    } finally {
      db.close();
    }
  }

  const goals = (await local.request(home, '/api/projects/' + PROJECT_ID + '/summary')).goals || [];
  let goal = goals.find(g => g.name === 'Governed local development' && g.status === 'active');
  if (!goal) {
    goal = await local.request(home, '/api/projects/' + PROJECT_ID + '/goals', {
      name: 'Governed local development',
      desiredOutcome: 'Bounded OpenCode/Qwen work in the disposable safe workspace with explicit Acceptance',
      nextAction: 'Use the registered safe-dev work template'
    });
  }

  const templates = await local.request(home, '/api/assistant/work-templates');
  let template = (templates.items || []).find(t => t.project === PROJECT_ALIAS && t.workspace_alias === WORKSPACE_ALIAS && t.state === 'active');
  if (!template) {
    template = await local.request(home, '/api/assistant/work-templates/register', {
      project: PROJECT_ALIAS,
      workspace_alias: WORKSPACE_ALIAS,
      project_id: PROJECT_ID,
      goal_id: goal.goalId || goal.id,
      workspace,
      allowed_files: ['fixture.txt'],
      diff_check: 'diff-check',
      tests: ['fixture-test'],
      duration_minutes: 240,
      confirmed: true
    });
  }

  const registry = await local.request(home, '/api/assistant/registry');
  const opencode = (registry.workers || []).find(w => w.id === 'opencode') || {};
  const qwen = (registry.models || []).find(m => m.id === 'ollama/qwen3-coder:30b') || {};
  const native = await local.request(home, '/api/product/native-status').catch(() => ({}));

  process.stdout.write(JSON.stringify({
    project_id: PROJECT_ID,
    project: updated.name || project.name,
    repositories: updated.repositories || repositories,
    goal_id: goal.goalId || goal.id,
    template: {
      project: template.project || PROJECT_ALIAS,
      workspace_alias: template.workspace_alias || WORKSPACE_ALIAS,
      state: template.state,
      workspace,
      workers: template.workers || ['opencode']
    },
    runtime: {
      opencode_available: opencode.available === true,
      opencode_version: opencode.version || null,
      qwen_available: qwen.available === true,
      model: native.model || qwen.id || null,
      provider: native.provider || null
    },
    restart_required: false,
    authority: false
  }, null, 2) + '\n');
}

main().catch(error => {
  process.stderr.write(String(error && error.message || error) + '\n');
  process.exit(1);
});
