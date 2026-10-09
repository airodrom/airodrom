'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { object, text, identifier } = require('./control-plane-store');
const { transaction } = require('./control-transaction');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const STATES = new Set(['open', 'checkpoint', 'merged', 'closed']);

function loadPolicy(root) {
  const file = path.join(root || process.cwd(), 'config/development-session-v1.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.version !== 1) throw Error('Unsupported development session policy');
  return {
    hosted_ci_auto_dispatch: raw.hosted_ci_auto_dispatch === true,
    heavy_ci_auto_dispatch: raw.heavy_ci_auto_dispatch === true,
    auto_push_per_mission: raw.auto_push_per_mission === true,
    auto_merge_per_mission: raw.auto_merge_per_mission === true,
    merge_window: {
      timezone: typeof raw.merge_window?.timezone === 'string' ? raw.merge_window.timezone : 'America/Vancouver',
      local_start: raw.merge_window?.local_start || '17:00',
      local_end: raw.merge_window?.local_end || '22:00'
    }
  };
}

function parseHm(value) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!m) throw Error('Invalid merge window time');
  return Number(m[1]) * 60 + Number(m[2]);
}

function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(now));
  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function inMergeWindow(policy, now = Date.now()) {
  const start = parseHm(policy.merge_window.local_start);
  const end = parseHm(policy.merge_window.local_end);
  const cur = localMinutes(now, policy.merge_window.timezone);
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;
}

// Host-owned local-first Development Session. Groups related Missions.
// Never auto-pushes or auto-merges. Worker text is not verification evidence.
class DevelopmentSession {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.store = bridge.controlStore;
    this.db = this.store.db;
    this.root = options.root || path.resolve(__dirname, '..');
    this.now = options.now || Date.now;
    this.policy = options.policy || loadPolicy(this.root);
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_development_sessions(
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      repository TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree TEXT NOT NULL,
      state TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      workers TEXT NOT NULL,
      push_status TEXT NOT NULL,
      github_ci_status TEXT NOT NULL,
      pr_number INTEGER,
      head_sha TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cp_development_session_missions(
      session_id TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      attached_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, mission_id)
    );
    CREATE TABLE IF NOT EXISTS cp_development_session_evidence(
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      command TEXT NOT NULL,
      passed INTEGER NOT NULL,
      summary TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cp_dev_session_updated ON cp_development_sessions(updated_at DESC);`);
  }

  defaults() {
    return {
      ...this.policy,
      auto_push_per_mission: false,
      auto_merge_per_mission: false,
      hosted_ci_auto_dispatch: this.policy.hosted_ci_auto_dispatch === true,
      heavy_ci_auto_dispatch: this.policy.heavy_ci_auto_dispatch === true,
      merge_window_open: inMergeWindow(this.policy, this.now()),
      authority: false
    };
  }

  create(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may open a Development Session');
    object(input, ['goal', 'repository', 'branch', 'worktree', 'confirmed', 'capabilities', 'workers', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    text(input.goal, 'session goal', 400);
    text(input.repository, 'repository', 200);
    if (!BRANCH.test(input.branch)) throw Error('Invalid development branch');
    text(input.worktree, 'worktree', 500);
    if (input.worktree.includes('\0')) throw Error('Invalid worktree');
    const capabilities = Array.isArray(input.capabilities) ? input.capabilities : ['local_edit', 'focused_test'];
    const workers = Array.isArray(input.workers) ? input.workers : [];
    if (capabilities.length > 20 || capabilities.some(c => typeof c !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(c))) {
      throw Error('Invalid capability allowlist');
    }
    if (workers.length > 10 || workers.some(w => typeof w !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(w))) {
      throw Error('Invalid worker allowlist');
    }
    if (capabilities.includes('auto_push') || capabilities.includes('auto_merge') || capabilities.includes('hosted_ci_dispatch')) {
      throw Error('Auto push, merge and hosted CI dispatch are not session capabilities');
    }
    const id = randomUUID();
    const at = this.now();
    this.db.prepare('INSERT INTO cp_development_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.goal.trim(), input.repository.trim(), input.branch, input.worktree, 'open',
        JSON.stringify(capabilities), JSON.stringify(workers), 'local_only', 'not_dispatched', null, null, at, at, actor);
    this.store.event('development.session.opened', null, {
      session_id: id,
      branch: input.branch,
      auto_push: false,
      auto_merge: false,
      hosted_ci_auto_dispatch: false
    });
    return this.inspect(id);
  }

  require(id) {
    if (!ID.test(id || '')) throw Error('Development Session identity required');
    const row = this.db.prepare('SELECT * FROM cp_development_sessions WHERE id=?').get(id);
    if (!row) throw Error('Development Session not found');
    return row;
  }

  attach(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may attach Missions');
    object(input, ['session_id', 'mission_id', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    const session = this.require(input.session_id);
    if (session.state !== 'open' && session.state !== 'checkpoint') throw Error('Session is closed');
    identifier(input.mission_id);
    const mission = this.store.getMission(input.mission_id);
    if (!mission) throw Error('Mission not found');
    if (mission.owner !== 'operator') throw Error('Only operator Missions may join a Development Session');
    transaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO cp_development_session_missions VALUES(?,?,?)')
        .run(session.id, input.mission_id, this.now());
      this.db.prepare('UPDATE cp_development_sessions SET updated_at=? WHERE id=?').run(this.now(), session.id);
    });
    this.store.event('development.session.mission_attached', input.mission_id, { session_id: session.id });
    return this.inspect(session.id);
  }

  recordEvidence(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may record session evidence');
    object(input, ['session_id', 'kind', 'command', 'passed', 'summary', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    const session = this.require(input.session_id);
    if (!['focused_test', 'typecheck', 'local_smoke', 'mandatory_check'].includes(input.kind)) {
      throw Error('Unsupported evidence kind');
    }
    text(input.command, 'evidence command', 400);
    text(input.summary, 'evidence summary', 1000);
    if (typeof input.passed !== 'boolean') throw Error('passed must be boolean');
    // Worker completion text is never accepted as evidence.
    if (/worker[_ ]completion|model[_ ]claims?/i.test(input.summary)) {
      throw Error('Worker completion text cannot substitute for test evidence');
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO cp_development_session_evidence VALUES(?,?,?,?,?,?,?)')
      .run(id, session.id, input.kind, input.command.trim(), input.passed ? 1 : 0, input.summary.trim(), this.now());
    this.db.prepare('UPDATE cp_development_sessions SET updated_at=? WHERE id=?').run(this.now(), session.id);
    this.store.event(input.passed ? 'development.session.evidence_passed' : 'development.session.evidence_failed', null, {
      session_id: session.id,
      kind: input.kind
    });
    return this.inspect(session.id);
  }

  markPublished(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may mark publication');
    object(input, ['session_id', 'confirmed', 'head_sha', 'pr_number', 'github_ci_status']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (this.policy.auto_push_per_mission) throw Error('auto_push_per_mission must remain false');
    const session = this.require(input.session_id);
    const head = input.head_sha == null ? session.head_sha : String(input.head_sha);
    if (head != null && !SHA.test(head)) throw Error('Invalid head SHA');
    const pr = input.pr_number == null ? session.pr_number : input.pr_number;
    if (pr != null && (!Number.isInteger(pr) || pr < 1)) throw Error('Invalid PR number');
    const ci = input.github_ci_status == null ? 'not_dispatched' : String(input.github_ci_status);
    if (!['not_dispatched', 'pending', 'passed', 'failed', 'skipped'].includes(ci)) throw Error('Invalid CI status');
    this.db.prepare('UPDATE cp_development_sessions SET push_status=?, head_sha=?, pr_number=?, github_ci_status=?, updated_at=? WHERE id=?')
      .run('published', head, pr, ci, this.now(), session.id);
    this.store.event('development.session.published', null, { session_id: session.id, pr_number: pr, hosted_ci_auto_dispatch: false });
    return this.inspect(session.id);
  }

  // Evaluates batch-merge readiness. Does not merge.
  checkpoint(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may request a batch checkpoint');
    object(input, ['session_id', 'confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (this.policy.auto_merge_per_mission) throw Error('auto_merge_per_mission must remain false');
    const session = this.require(input.session_id);
    const blockers = [];
    const evidence = this.db.prepare('SELECT kind, passed FROM cp_development_session_evidence WHERE session_id=? ORDER BY recorded_at DESC').all(session.id);
    if (!evidence.some(e => e.kind === 'focused_test' && e.passed === 1)) blockers.push('focused_tests_missing');
    const latestByKind = new Map();
    for (const e of evidence) if (!latestByKind.has(e.kind)) latestByKind.set(e.kind, e);
    for (const [kind, e] of latestByKind) if (e.passed === 0) blockers.push('evidence_failed:' + kind);
    if (session.push_status !== 'published') blockers.push('not_published');
    if (session.github_ci_status !== 'passed' && session.github_ci_status !== 'skipped') blockers.push('github_checks_incomplete');
    const windowOpen = inMergeWindow(this.policy, this.now());
    if (!windowOpen) blockers.push('outside_merge_window');
    blockers.push('operator_merge_authorization_required');
    const ready = blockers.length === 1 && blockers[0] === 'operator_merge_authorization_required' && windowOpen;
    this.db.prepare("UPDATE cp_development_sessions SET state=?, updated_at=? WHERE id=?")
      .run(ready ? 'checkpoint' : session.state, this.now(), session.id);
    this.store.event('development.session.checkpoint', null, {
      session_id: session.id,
      ready_pending_auth: ready,
      merge_window_open: windowOpen,
      auto_merge: false
    });
    return {
      ...this.inspect(session.id),
      checkpoint: {
        merge_window_open: windowOpen,
        ready_pending_authorization: ready,
        blockers,
        auto_merge: false,
        note: 'Clock window alone never merges. Explicit operator authorization required.'
      }
    };
  }

  close(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may close a Development Session');
    object(input, ['session_id', 'confirmed', 'state']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    const session = this.require(input.session_id);
    const state = input.state || 'closed';
    if (!STATES.has(state) || state === 'open') throw Error('Invalid close state');
    this.db.prepare('UPDATE cp_development_sessions SET state=?, updated_at=? WHERE id=?').run(state, this.now(), session.id);
    this.store.event('development.session.closed', null, { session_id: session.id, state });
    return this.inspect(session.id);
  }

  inspect(id) {
    const row = this.require(id);
    const missions = this.db.prepare('SELECT mission_id, attached_at FROM cp_development_session_missions WHERE session_id=? ORDER BY attached_at').all(row.id);
    const evidence = this.db.prepare('SELECT id, kind, command, passed, summary, recorded_at FROM cp_development_session_evidence WHERE session_id=? ORDER BY recorded_at DESC LIMIT 50').all(row.id)
      .map(e => ({ ...e, passed: e.passed === 1 }));
    const passed = evidence.filter(e => e.passed).length;
    const failed = evidence.filter(e => !e.passed).length;
    return {
      id: row.id,
      goal: row.goal,
      repository: row.repository,
      branch: row.branch,
      worktree: row.worktree,
      state: row.state,
      capabilities: JSON.parse(row.capabilities),
      workers: JSON.parse(row.workers),
      missions: missions.map(m => m.mission_id),
      mission_count: missions.length,
      evidence: { passed, failed, items: evidence },
      push_status: row.push_status,
      github_ci_status: row.github_ci_status,
      pr_number: row.pr_number,
      head_sha: row.head_sha,
      local_only: row.push_status === 'local_only',
      published: row.push_status === 'published',
      merge_window: {
        ...this.policy.merge_window,
        open: inMergeWindow(this.policy, this.now())
      },
      cost_controls: {
        hosted_ci_auto_dispatch: false,
        heavy_ci_auto_dispatch: false,
        auto_push_per_mission: false,
        auto_merge_per_mission: false
      },
      ci_cost_estimate: null,
      ci_cost_estimate_note: 'Unavailable; no fabricated estimates',
      authority: false,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  list({ limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid session page');
    const rows = this.db.prepare('SELECT id FROM cp_development_sessions ORDER BY updated_at DESC LIMIT ?').all(limit);
    return {
      items: rows.map(r => this.inspect(r.id)),
      defaults: this.defaults(),
      authority: false
    };
  }

  status() {
    const open = this.db.prepare("SELECT count(*) n FROM cp_development_sessions WHERE state IN ('open','checkpoint')").get().n;
    const local = this.db.prepare("SELECT count(*) n FROM cp_development_sessions WHERE push_status='local_only'").get().n;
    return {
      ...this.defaults(),
      open_sessions: open,
      local_only_sessions: local,
      recent: this.list({ limit: 10 }).items,
      authority: false
    };
  }

  // Guard used by host tooling: refuse Airodrom-originated auto CI/push/merge.
  assertNoAutoDispatch(action) {
    if (!['push', 'merge', 'hosted_ci', 'heavy_ci'].includes(action)) throw Error('Unknown dispatch action');
    if (action === 'push' && this.policy.auto_push_per_mission) throw Error('AUTO_PUSH_PER_MISSION forbidden');
    if (action === 'merge' && this.policy.auto_merge_per_mission) throw Error('AUTO_MERGE_PER_MISSION forbidden');
    if (action === 'hosted_ci' && this.policy.hosted_ci_auto_dispatch) throw Error('HOSTED_CI_AUTO_DISPATCH forbidden');
    if (action === 'heavy_ci' && this.policy.heavy_ci_auto_dispatch) throw Error('HEAVY_CI_AUTO_DISPATCH forbidden');
    return { allowed: false, reason: 'operator_checkpoint_required', action };
  }
}

module.exports = { DevelopmentSession, loadPolicy, inMergeWindow };
