'use strict';
/**
 * Global Autopilot V1 — authenticated, revocable owner delegation.
 * Defaults OFF. Model/MCP/browser text cannot enable it.
 * Reuses Developer Autonomy workspace/grant machinery under a global flag.
 */
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { object, identifier, fingerprint } = require('./control-plane-store');

const NEVER_AUTO = Object.freeze([
  'enable_autopilot_from_untrusted_text',
  'credential_value_disclosure',
  'bypass_external_provider_auth'
]);

class GlobalAutopilot {
  constructor(bridge) {
    this.bridge = bridge;
    this.db = bridge.controlStore.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cp_global_autopilot(
        id INTEGER PRIMARY KEY CHECK(id=1),
        enabled INTEGER NOT NULL,
        enabled_at INTEGER,
        enabled_by TEXT,
        enable_request_id TEXT,
        disabled_at INTEGER,
        disabled_by TEXT,
        disable_request_id TEXT,
        stop_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO cp_global_autopilot(id,enabled,updated_at) VALUES(1,0,0);
      CREATE TABLE IF NOT EXISTS cp_autopilot_activity(
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        mission_id TEXT,
        project_id TEXT,
        repository TEXT,
        tool TEXT,
        summary TEXT NOT NULL,
        verification TEXT,
        recovery TEXT,
        request_id TEXT,
        actor TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cp_autopilot_activity_at ON cp_autopilot_activity(at DESC);
    `);
  }

  row() {
    return this.db.prepare('SELECT * FROM cp_global_autopilot WHERE id=1').get();
  }

  enabled() {
    return this.row()?.enabled === 1;
  }

  status(owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated operator may inspect Autopilot');
    const r = this.row();
    const projects = this.discoverProjects();
    return {
      version: 1,
      enabled: r.enabled === 1,
      enabled_at: r.enabled_at || null,
      enabled_by: r.enabled_by || null,
      disabled_at: r.disabled_at || null,
      stop_count: r.stop_count || 0,
      updated_at: r.updated_at || null,
      projects: projects.map(p => ({ project_id: p.projectId, name: p.name, repositories: p.repositories.length, status: p.status })),
      never_auto: [...NEVER_AUTO],
      note: r.enabled === 1
        ? 'Autopilot ON: authenticated owner delegation is active across registered projects. OFF/STOP revokes immediately.'
        : 'Autopilot OFF: existing governed behavior retained. Enable only from authenticated Terminal or Control Center.',
      authority: false,
      defaults_off: true
    };
  }

  discoverProjects() {
    return (this.bridge.projects.listProjects({ status: 'active' }) || [])
      .filter(p => Array.isArray(p.repositories) && p.repositories.length);
  }

  enable(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may enable Autopilot');
    object(input, ['confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    if (this.enabled()) return this.status(owner);
    const now = Date.now();
    this.db.prepare(`UPDATE cp_global_autopilot SET enabled=1, enabled_at=?, enabled_by=?, enable_request_id=?,
      disabled_at=NULL, disabled_by=NULL, disable_request_id=NULL, updated_at=? WHERE id=1`)
      .run(now, owner, input.request_id, now);
    this.record({ kind: 'enabled', summary: 'Owner enabled Global Autopilot', request_id: input.request_id, actor: owner });
    this.bridge.controlStore.event('autopilot.enabled', null, { request_id: input.request_id, authority: false });
    this.bridge.emit?.('change');
    return this.status(owner);
  }

  disable(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may disable Autopilot');
    object(input, ['confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    return this._revoke(input.request_id, owner, 'disabled', false);
  }

  /** Emergency STOP: disable + cancel active Autopilot-tagged Missions. */
  stop(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Only authenticated local owner may STOP Autopilot');
    object(input, ['confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit owner confirmation required');
    identifier(input.request_id);
    return this._revoke(input.request_id, owner, 'stopped', true);
  }

  _revoke(requestId, owner, kind, cancelActive) {
    const now = Date.now();
    const was = this.enabled();
    this.db.prepare(`UPDATE cp_global_autopilot SET enabled=0, disabled_at=?, disabled_by=?, disable_request_id=?,
      stop_count=stop_count+?, updated_at=? WHERE id=1`)
      .run(now, owner, requestId, kind === 'stopped' ? 1 : 0, now);
    let cancelled = 0;
    if (cancelActive) {
      // Emergency STOP also revokes explicitly delegated cognitive planning.
      for (const p of this.bridge.developerAutonomy.list('operator').filter(p => p.state === 'active' && p.cognitive)) {
        this.bridge.developerAutonomy.revoke({ policy_id: p.policy_id, policy_hash: p.policy_hash, confirmed: true }, 'operator');
      }
      for (const m of this.bridge.controlStore.listMissions?.() || []) {
        if (!m.envelope?.autopilot && !m.envelope?.cognitive) continue;
        if (['completed', 'cancelled'].includes(m.state)) continue;
        try {
          this.bridge.missions.cancel(m.id, { request_id: randomUUID() }, owner);
          cancelled++;
        } catch { /* best-effort cancel */ }
      }
    }
    // Revoke Autopilot-managed DA policies so unspent grants cannot continue.
    try {
      for (const p of this.bridge.developerAutonomy.list('operator') || []) {
        if (!p.alias?.startsWith('autopilot-') || p.state !== 'active') continue;
        try {
          this.bridge.developerAutonomy.revoke({
            policy_id: p.policy_id,
            policy_hash: p.policy_hash,
            confirmed: true
          }, owner);
        } catch { /* already revoked / changed */ }
      }
    } catch { /* DA unavailable */ }
    this.record({
      kind,
      summary: was ? `Owner ${kind} Global Autopilot` : `Owner ${kind} Autopilot (already off)`,
      request_id: requestId,
      actor: owner,
      recovery: cancelActive ? `cancelled_missions=${cancelled}` : null
    });
    this.bridge.controlStore.event('autopilot.' + kind, null, {
      request_id: requestId, cancelled_missions: cancelled, authority: false
    });
    this.bridge.emit?.('change');
    return { ...this.status(owner), cancelled_missions: cancelled };
  }

  assertEnabled(action = 'Autopilot action') {
    if (!this.enabled()) throw Error(action + ' requires Autopilot ON');
  }

  assertMission(mission) {
    if (!mission?.envelope?.autopilot) return;
    if (!this.enabled()) throw Error('Autopilot Mission denied: Autopilot is OFF');
  }

  record({ kind, summary, mission_id = null, project_id = null, repository = null, tool = null, verification = null, recovery = null, request_id = null, actor = 'operator' }) {
    this.db.prepare(`INSERT INTO cp_autopilot_activity
      (id,at,kind,mission_id,project_id,repository,tool,summary,verification,recovery,request_id,actor)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), Date.now(), kind, mission_id, project_id, repository, tool, String(summary).slice(0, 2000),
        verification, recovery, request_id, actor);
  }

  activity(limit = 50) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.db.prepare('SELECT id,at,kind,mission_id,project_id,repository,tool,summary,verification,recovery,request_id,actor FROM cp_autopilot_activity ORDER BY at DESC LIMIT ?')
      .all(n)
      .map(r => ({ ...r, authority: false }));
  }

  // Prefer the stable project alias; when a revoked row still occupies it,
  // allocate a free autopilot-* alias so STOP can still match the prefix.
  allocateAutopilotAlias(projectId, workspace) {
    const base = 'autopilot-' + String(projectId).replace(/-/g, '').slice(0, 12);
    const taken = (alias) => !!this.bridge.developerAutonomy.db
      .prepare('SELECT 1 AS ok FROM cp_developer_autonomy_policies WHERE alias=?').get(alias);
    if (!taken(base)) return base;
    const crypto = require('node:crypto');
    for (let n = 0; n < 32; n += 1) {
      const digest = crypto.createHash('sha256').update(String(workspace) + ':' + n).digest('hex').slice(0, 8);
      const alias = base + '-' + digest;
      if (!taken(alias)) return alias;
    }
    throw Error('Unable to allocate a free Autopilot policy alias');
  }

  /**
   * Ensure a standing DA policy exists for Autopilot-managed routine work in a repo.
   * Marked with alias autopilot:* so OFF/STOP can revoke unspent grants.
   */
  ensureRepositoryPolicy(project, workspace) {
    this.assertEnabled('Repository Autopilot policy');
    const existing = this.bridge.developerAutonomy.activePolicyForRepository(workspace);
    if (existing.length) return existing[0];
    const goals = this.bridge.projects.summary(project.projectId).goals.filter(g => g.status === 'active');
    const goal = goals[0] || this.bridge.projects.createGoal({
      projectId: project.projectId,
      name: 'Autopilot ' + project.name
    });
    const goalId = goal.goalId || goal.id;
    const taskFile = path.join(workspace, '.vscode/tasks.json');
    let diff = null;
    let tests = [];
    if (fs.existsSync(taskFile)) {
      const tasks = JSON.parse(fs.readFileSync(taskFile, 'utf8')).tasks || [];
      const labels = tasks.filter(t => t.type === 'process').map(t => t.label);
      diff = labels.includes('diff-check') ? 'diff-check' : null;
      tests = labels.filter(l => l !== diff).slice(0, 4);
    }
    // Prefer repository-registered VS Code tasks. When absent, use the host's
    // existing Work Template verification labels only if a signed template already
    // exists for this exact workspace — never invent unverified commands.
    if (!diff || !tests.length) {
      for (const item of this.bridge.workTemplates.list('operator') || []) {
        if (item.state !== 'active' || item.project_id !== project.projectId) continue;
        try {
          const template = this.bridge.workTemplates.template(item.project, item.workspace_alias);
          if (!template || template.workspace !== workspace) continue;
          diff = template.verification?.diff_check || null;
          tests = [...(template.verification?.tests || [])].slice(0, 4);
          if (diff && tests.length) break;
        } catch { /* invalid template */ }
      }
    }
    if (!diff || !tests.length) {
      throw Error('Autopilot needs registered verification (diff-check plus at least one test task) via .vscode/tasks.json or an active Work template for ' + workspace);
    }
    const { DEFAULT_DENIED_PATHS, globMatch } = require('./mission-contract');
    const { sourceContextSensitive } = require('./opencode-adapter');
    const discovery = [
      'README.md', 'CHANGELOG.md', 'docs/README.md',
      'docs/operations/founder-current-state.md', 'lib/platform/manifest.json',
      'src/index.js', 'fixture.txt',
    ].filter(file => {
      if (DEFAULT_DENIED_PATHS.some(pattern => globMatch(pattern, file))) return false;
      try {
        const target = path.join(workspace, file);
        if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== target) return false;
        // Planning must receive only context OpenCode can admit. Setup docs that
        // mention .env paths stay on disk but are not forwarded as planner input.
        return !sourceContextSensitive(fs.readFileSync(target, 'utf8'));
      } catch { return false; }
    }).slice(0, 8);
    const cursorReady = !!(this.bridge.cursorWorker?.lastReadiness?.ready
      || this.bridge.cursorWorker?.lastReadiness?.tiers?.qualified);
    const cursorAllowed = cursorReady && !this.bridge.hostExecutionPolicy?.cursorDisabled?.();
    return this.bridge.developerAutonomy.enroll({
      alias: this.allocateAutopilotAlias(project.projectId, workspace),
      repository: workspace,
      project_id: project.projectId,
      goal_id: goalId,
      workflows: ['routine_edit', 'test', 'repair', 'feature_branch', 'draft_pr'],
      budgets: {
        max_repairs: 2,
        max_concurrent_missions: 1,
        grant_ttl_minutes: 240,
        max_files: 12,
        max_worktrees: 4,
        max_runtime_hours: 4,
        max_disk_mb: 4096
      },
      workers: cursorAllowed ? ['opencode', 'cursor'] : ['opencode'],
      duration_days: 30,
      confirmed: true,
      diff_check: diff,
      default_tests: tests,
      ...(discovery.length ? {
        cognitive: {
          version: 3,
          files: discovery,
          delegated_callers: [],
          planning_attempts: 2,
          planning_ms: 120000,
          execution_ms: 120000,
          repair_attempts: 1,
          max_assignments: 2,
          acceptance: 'automatic',
        },
      } : {}),
    }, 'operator');
  }

  tagMissionInput(input) {
    if (!this.enabled()) return input;
    return { ...input, autopilot: true };
  }
}

module.exports = { GlobalAutopilot, NEVER_AUTO };
