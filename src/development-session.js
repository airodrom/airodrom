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
const INTEGRATION = new Set(['LOCAL_ONLY', 'READY_TO_PUSH', 'PR_OPEN', 'READY_TO_MERGE', 'MERGED']);

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

function selectFocusedTests(changedPaths = []) {
  if (!Array.isArray(changedPaths) || changedPaths.length > 500) throw Error('Invalid changed paths');
  const tests = new Set();
  let security = false;
  let authority = false;
  for (const raw of changedPaths) {
    if (typeof raw !== 'string' || raw.length > 400 || raw.includes('\0')) throw Error('Invalid changed path');
    const p = raw.replace(/\\/g, '/');
    if (p.includes('development-session') || p.includes('LOCAL-FIRST') || p.includes('0039-local-first')) {
      tests.add('tests/development-session-v1.test.js');
    }
    if (p.includes('control-server') || p.includes('control-hub')) tests.add('tests/control-server.test.js');
    if (p.includes('bridge-controller')) tests.add('tests/bridge-restart.test.js');
    if (/authority|acceptance|risk-acceptance|fixture-acceptance|deterministic-acceptance/.test(p)) {
      authority = true;
      tests.add('tests/authority-plane.test.js');
      tests.add('tests/authority-integration.test.js');
    }
    if (/secret|vault|credential|oauth/.test(p)) {
      security = true;
      tests.add('tests/secret-diagnostic-boundaries.test.js');
    }
    if (p.startsWith('src/') && !tests.size) {
      const base = path.basename(p, path.extname(p));
      const candidate = 'tests/' + base + '.test.js';
      tests.add(candidate);
    }
  }
  if (security || authority) {
    tests.add('tests/secret-diagnostic-boundaries.test.js');
    tests.add('tests/authority-plane.test.js');
  }
  if (!tests.size) tests.add('tests/development-session-v1.test.js');
  return {
    tests: [...tests].sort(),
    mandatory_security: security || authority,
    mandatory_authority: authority,
    note: 'Selected from changed modules. Worker completion text is never evidence.',
    hosted_ci: false
  };
}

// Host-owned local-first Development Session. Groups related Missions.
// Never auto-pushes, auto-merges, auto-dispatches hosted CI, or resets dirty worktrees.
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
      recorded_at INTEGER NOT NULL,
      commit_sha TEXT
    );
    CREATE TABLE IF NOT EXISTS cp_development_session_commits(
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      subject TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cp_dev_session_updated ON cp_development_sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS cp_dev_session_branch ON cp_development_sessions(repository, branch, state);`);
    this.#migrate();
    this.recover();
  }

  #migrate() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(cp_development_sessions)').all().map(c => c.name));
    const add = (name, sql) => { if (!cols.has(name)) this.db.exec(`ALTER TABLE cp_development_sessions ADD COLUMN ${name} ${sql}`); };
    add('assigned_worker', 'TEXT');
    add('integration_state', "TEXT NOT NULL DEFAULT 'LOCAL_ONLY'");
    add('dirty_files', "TEXT NOT NULL DEFAULT '[]'");
    add('evidence_commit_sha', 'TEXT');
    const ecols = new Set(this.db.prepare('PRAGMA table_info(cp_development_session_evidence)').all().map(c => c.name));
    if (!ecols.has('commit_sha')) this.db.exec('ALTER TABLE cp_development_session_evidence ADD COLUMN commit_sha TEXT');
  }

  // Durable recovery after host restart. Never resets dirty worktrees.
  recover() {
    const rows = this.db.prepare("SELECT id, integration_state, push_status, state FROM cp_development_sessions WHERE state IN ('open','checkpoint')").all();
    for (const row of rows) {
      const next = this.#computeIntegration(row);
      if (row.integration_state !== next) {
        this.db.prepare('UPDATE cp_development_sessions SET integration_state=?, updated_at=? WHERE id=?')
          .run(next, this.now(), row.id);
      }
    }
    this.store.event('development.session.recovered', null, {
      open: rows.length,
      reset_worktrees: false,
      auto_push: false,
      auto_merge: false,
      hosted_ci_auto_dispatch: false
    });
    return { recovered: rows.length, reset_worktrees: false, authority: false };
  }

  #computeIntegration(row) {
    if (row.state === 'merged' || row.integration_state === 'MERGED') return 'MERGED';
    if (row.push_status === 'local_only') {
      const head = row.head_sha || null;
      const evidenceOk = head
        ? this.db.prepare("SELECT 1 FROM cp_development_session_evidence WHERE session_id=? AND kind='focused_test' AND passed=1 AND commit_sha=? LIMIT 1").get(row.id, head)
        : this.db.prepare("SELECT 1 FROM cp_development_session_evidence WHERE session_id=? AND kind='focused_test' AND passed=1 LIMIT 1").get(row.id);
      const evidenceFresh = !head || row.evidence_commit_sha === head;
      return evidenceOk && evidenceFresh ? 'READY_TO_PUSH' : 'LOCAL_ONLY';
    }
    if (row.pr_number && (row.github_ci_status === 'passed' || row.github_ci_status === 'skipped') && row.state === 'checkpoint') {
      return 'READY_TO_MERGE';
    }
    if (row.pr_number || row.push_status === 'published') return 'PR_OPEN';
    return 'LOCAL_ONLY';
  }

  defaults() {
    return {
      ...this.policy,
      auto_push_per_mission: false,
      auto_merge_per_mission: false,
      hosted_ci_auto_dispatch: false,
      heavy_ci_auto_dispatch: false,
      merge_window_open: inMergeWindow(this.policy, this.now()),
      authority: false
    };
  }

  create(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may open a Development Session');
    object(input, ['goal', 'repository', 'branch', 'worktree', 'confirmed', 'capabilities', 'workers', 'request_id', 'assigned_worker']);
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
    const assigned = input.assigned_worker != null ? input.assigned_worker : (workers[0] || 'opencode');
    if (typeof assigned !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(assigned)) throw Error('Invalid assigned worker');
    const existing = this.findOpen({ repository: input.repository.trim(), branch: input.branch, worktree: input.worktree });
    if (existing) throw Error('Open Development Session already exists for this branch/worktree; use resolve');
    const id = randomUUID();
    const at = this.now();
    this.db.prepare(`INSERT INTO cp_development_sessions(
      id,goal,repository,branch,worktree,state,capabilities,workers,push_status,github_ci_status,pr_number,head_sha,created_at,updated_at,created_by,assigned_worker,integration_state,dirty_files,evidence_commit_sha
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.goal.trim(), input.repository.trim(), input.branch, input.worktree, 'open',
        JSON.stringify(capabilities), JSON.stringify(workers), 'local_only', 'not_dispatched', null, null, at, at, actor,
        assigned, 'LOCAL_ONLY', '[]', null);
    this.store.event('development.session.opened', null, {
      session_id: id,
      branch: input.branch,
      assigned_worker: assigned,
      auto_push: false,
      auto_merge: false,
      hosted_ci_auto_dispatch: false
    });
    return this.inspect(id);
  }

  findOpen({ repository, branch, worktree } = {}) {
    if (!repository || !branch) return null;
    const row = worktree
      ? this.db.prepare("SELECT id FROM cp_development_sessions WHERE repository=? AND branch=? AND worktree=? AND state IN ('open','checkpoint') ORDER BY updated_at DESC LIMIT 1").get(repository, branch, worktree)
      : this.db.prepare("SELECT id FROM cp_development_sessions WHERE repository=? AND branch=? AND state IN ('open','checkpoint') ORDER BY updated_at DESC LIMIT 1").get(repository, branch);
    return row ? this.inspect(row.id) : null;
  }

  // Related Mission entry: reuse session/worktree or open one. Never creates a PR.
  resolve(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may resolve a Development Session');
    object(input, ['goal', 'repository', 'branch', 'worktree', 'confirmed', 'mission_id', 'capabilities', 'workers', 'assigned_worker', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    text(input.repository, 'repository', 200);
    if (!BRANCH.test(input.branch)) throw Error('Invalid development branch');
    text(input.worktree, 'worktree', 500);
    const repo = input.repository.trim();
    const byBranch = this.findOpen({ repository: repo, branch: input.branch });
    if (byBranch && byBranch.worktree !== input.worktree) {
      throw Error('Existing session worktree mismatch; isolation required');
    }
    let session = this.findOpen({ repository: repo, branch: input.branch, worktree: input.worktree });
    if (session) {
      if (input.mission_id) {
        session = this.attach({ session_id: session.id, mission_id: input.mission_id, confirmed: true }, actor);
      }
      this.store.event('development.session.reused', input.mission_id || null, {
        session_id: session.id,
        new_pr: false,
        hosted_ci_auto_dispatch: false
      });
      return { ...session, reused: true, new_pr: false };
    }
    const created = this.create({
      goal: input.goal,
      repository: input.repository,
      branch: input.branch,
      worktree: input.worktree,
      confirmed: true,
      capabilities: input.capabilities,
      workers: input.workers,
      assigned_worker: input.assigned_worker,
      request_id: input.request_id
    }, actor);
    if (input.mission_id) {
      return { ...this.attach({ session_id: created.id, mission_id: input.mission_id, confirmed: true }, actor), reused: false, new_pr: false };
    }
    return { ...created, reused: false, new_pr: false };
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
    this.store.event('development.session.mission_attached', input.mission_id, { session_id: session.id, new_pr: false });
    return this.inspect(session.id);
  }

  observeGit(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may observe session git status');
    object(input, ['session_id', 'dirty_files', 'confirmed', 'reset']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (input.reset === true) throw Error('Automatic dirty worktree reset is forbidden');
    const session = this.require(input.session_id);
    if (!Array.isArray(input.dirty_files) || input.dirty_files.length > 500 || input.dirty_files.some(f => typeof f !== 'string' || f.length > 400)) {
      throw Error('Invalid dirty file list');
    }
    const integration = this.#computeIntegration(session);
    this.db.prepare('UPDATE cp_development_sessions SET dirty_files=?, integration_state=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(input.dirty_files), integration, this.now(), session.id);
    this.store.event('development.session.git_observed', null, {
      session_id: session.id,
      dirty_count: input.dirty_files.length,
      reset: false
    });
    return this.inspect(session.id);
  }

  recordCommit(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may record local commits');
    object(input, ['session_id', 'sha', 'subject', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    const session = this.require(input.session_id);
    if (!SHA.test(input.sha)) throw Error('Invalid commit SHA');
    text(input.subject, 'commit subject', 200);
    const id = randomUUID();
    this.db.prepare('INSERT INTO cp_development_session_commits VALUES(?,?,?,?,?)')
      .run(id, session.id, input.sha, input.subject.trim(), this.now());
    // New commit invalidates cached evidence bound to a prior SHA.
    this.db.prepare('UPDATE cp_development_sessions SET head_sha=?, evidence_commit_sha=NULL, updated_at=? WHERE id=?')
      .run(input.sha, this.now(), session.id);
    this.#refreshIntegration(session.id);
    this.store.event('development.session.commit_recorded', null, { session_id: session.id, sha: input.sha, pushed: false });
    return this.inspect(session.id);
  }

  selectTests(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may select session tests');
    object(input, ['session_id', 'changed_paths', 'confirmed', 'commit_sha']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    const session = this.require(input.session_id);
    const selection = selectFocusedTests(input.changed_paths || JSON.parse(session.dirty_files || '[]'));
    const commitSha = input.commit_sha || session.head_sha || null;
    if (commitSha && session.evidence_commit_sha === commitSha) {
      const cached = this.db.prepare("SELECT kind, passed, command FROM cp_development_session_evidence WHERE session_id=? AND commit_sha=? ORDER BY recorded_at DESC").all(session.id, commitSha);
      if (cached.length && cached.every(c => c.passed === 1)) {
        return {
          ...selection,
          cached: true,
          commit_sha: commitSha,
          evidence: cached,
          note: 'Exact-commit focused evidence reused; no hosted CI dispatch'
        };
      }
    }
    return { ...selection, cached: false, commit_sha: commitSha, hosted_ci: false };
  }

  recordEvidence(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may record session evidence');
    object(input, ['session_id', 'kind', 'command', 'passed', 'summary', 'confirmed', 'commit_sha']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    const session = this.require(input.session_id);
    if (!['focused_test', 'typecheck', 'local_smoke', 'mandatory_check'].includes(input.kind)) {
      throw Error('Unsupported evidence kind');
    }
    text(input.command, 'evidence command', 400);
    text(input.summary, 'evidence summary', 1000);
    if (typeof input.passed !== 'boolean') throw Error('passed must be boolean');
    if (/worker[_ ]completion|model[_ ]claims?/i.test(input.summary)) {
      throw Error('Worker completion text cannot substitute for test evidence');
    }
    const commitSha = input.commit_sha != null ? String(input.commit_sha) : session.head_sha;
    if (commitSha != null && !SHA.test(commitSha)) throw Error('Invalid evidence commit SHA');
    const id = randomUUID();
    this.db.prepare('INSERT INTO cp_development_session_evidence VALUES(?,?,?,?,?,?,?,?)')
      .run(id, session.id, input.kind, input.command.trim(), input.passed ? 1 : 0, input.summary.trim(), this.now(), commitSha);
    this.db.prepare('UPDATE cp_development_sessions SET evidence_commit_sha=?, updated_at=? WHERE id=?')
      .run(input.passed ? commitSha : null, this.now(), session.id);
    this.#refreshIntegration(session.id);
    this.store.event(input.passed ? 'development.session.evidence_passed' : 'development.session.evidence_failed', null, {
      session_id: session.id,
      kind: input.kind,
      commit_sha: commitSha,
      hosted_ci: false
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
    this.db.prepare('UPDATE cp_development_sessions SET push_status=?, head_sha=?, pr_number=?, github_ci_status=?, integration_state=?, updated_at=? WHERE id=?')
      .run('published', head, pr, ci, pr ? 'PR_OPEN' : 'READY_TO_PUSH', this.now(), session.id);
    this.#refreshIntegration(session.id);
    this.store.event('development.session.published', null, { session_id: session.id, pr_number: pr, hosted_ci_auto_dispatch: false });
    return this.inspect(session.id);
  }

  checkpoint(input, actor = 'operator') {
    if (actor !== 'operator') throw Error('Only operator may request a batch checkpoint');
    object(input, ['session_id', 'confirmed', 'request_id']);
    if (input.confirmed !== true) throw Error('Explicit operator confirmation required');
    if (this.policy.auto_merge_per_mission) throw Error('auto_merge_per_mission must remain false');
    const session = this.require(input.session_id);
    const blockers = [];
    const evidence = this.db.prepare('SELECT kind, passed, commit_sha FROM cp_development_session_evidence WHERE session_id=? ORDER BY recorded_at DESC').all(session.id);
    if (!evidence.some(e => e.kind === 'focused_test' && e.passed === 1)) blockers.push('focused_tests_missing');
    if (session.head_sha && evidence.some(e => e.kind === 'focused_test' && e.passed === 1 && e.commit_sha && e.commit_sha !== session.head_sha) &&
        !evidence.some(e => e.kind === 'focused_test' && e.passed === 1 && e.commit_sha === session.head_sha)) {
      blockers.push('stale_evidence_after_commit');
    }
    const latestByKind = new Map();
    for (const e of evidence) if (!latestByKind.has(e.kind)) latestByKind.set(e.kind, e);
    for (const [kind, e] of latestByKind) if (e.passed === 0) blockers.push('evidence_failed:' + kind);
    if (session.push_status !== 'published') blockers.push('not_published');
    if (session.github_ci_status !== 'passed' && session.github_ci_status !== 'skipped') blockers.push('github_checks_incomplete');
    const windowOpen = inMergeWindow(this.policy, this.now());
    if (!windowOpen) blockers.push('outside_merge_window');
    blockers.push('operator_merge_authorization_required');
    const ready = blockers.length === 1 && blockers[0] === 'operator_merge_authorization_required' && windowOpen;
    this.db.prepare('UPDATE cp_development_sessions SET state=?, integration_state=?, updated_at=? WHERE id=?')
      .run(ready ? 'checkpoint' : session.state, ready ? 'READY_TO_MERGE' : this.#computeIntegration(session), this.now(), session.id);
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
        note: 'Clock window alone never merges. Explicit operator authorization required. Acceptance remains Mission host verification (PR #43 risk preference when installed).'
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
    const integration = state === 'merged' ? 'MERGED' : session.integration_state;
    this.db.prepare('UPDATE cp_development_sessions SET state=?, integration_state=?, updated_at=? WHERE id=?')
      .run(state, integration, this.now(), session.id);
    this.store.event('development.session.closed', null, { session_id: session.id, state });
    return this.inspect(session.id);
  }

  #refreshIntegration(id) {
    const row = this.require(id);
    const next = this.#computeIntegration(row);
    if (!INTEGRATION.has(next)) throw Error('Invalid integration state');
    this.db.prepare('UPDATE cp_development_sessions SET integration_state=?, updated_at=? WHERE id=?').run(next, this.now(), id);
  }

  inspect(id) {
    const row = this.require(id);
    const missions = this.db.prepare('SELECT mission_id, attached_at FROM cp_development_session_missions WHERE session_id=? ORDER BY attached_at').all(row.id);
    const evidence = this.db.prepare('SELECT id, kind, command, passed, summary, recorded_at, commit_sha FROM cp_development_session_evidence WHERE session_id=? ORDER BY recorded_at DESC LIMIT 50').all(row.id)
      .map(e => ({ ...e, passed: e.passed === 1 }));
    const commits = this.db.prepare('SELECT sha, subject, recorded_at FROM cp_development_session_commits WHERE session_id=? ORDER BY recorded_at DESC LIMIT 50').all(row.id);
    const passed = evidence.filter(e => e.passed).length;
    const failed = evidence.filter(e => !e.passed).length;
    const integration = INTEGRATION.has(row.integration_state) ? row.integration_state : this.#computeIntegration(row);
    let dirty = [];
    try { dirty = JSON.parse(row.dirty_files || '[]'); } catch { dirty = []; }
    return {
      id: row.id,
      goal: row.goal,
      repository: row.repository,
      branch: row.branch,
      worktree: row.worktree,
      state: row.state,
      assigned_worker: row.assigned_worker || (JSON.parse(row.workers || '[]')[0] || null),
      capabilities: JSON.parse(row.capabilities),
      workers: JSON.parse(row.workers),
      missions: missions.map(m => m.mission_id),
      mission_count: missions.length,
      local_commits: commits,
      dirty_files: dirty,
      evidence: { passed, failed, items: evidence, commit_sha: row.evidence_commit_sha || null },
      push_status: row.push_status,
      github_ci_status: row.github_ci_status,
      pr_number: row.pr_number,
      head_sha: row.head_sha,
      integration_state: integration,
      local_only: integration === 'LOCAL_ONLY' || integration === 'READY_TO_PUSH',
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
      ci_runs: row.github_ci_status === 'not_dispatched' ? 0 : 1,
      ci_cost_estimate: null,
      ci_cost_estimate_note: 'Unavailable; no fabricated estimates',
      acceptance_note: 'Mission Acceptance remains host verification / risk preference (PR #43). Sessions do not grant Acceptance.',
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
    const local = this.db.prepare("SELECT count(*) n FROM cp_development_sessions WHERE integration_state IN ('LOCAL_ONLY','READY_TO_PUSH')").get().n;
    const byState = Object.fromEntries(this.db.prepare('SELECT integration_state s, count(*) n FROM cp_development_sessions GROUP BY integration_state').all().map(r => [r.s, r.n]));
    return {
      ...this.defaults(),
      open_sessions: open,
      local_only_sessions: local,
      integration_counts: byState,
      recent: this.list({ limit: 10 }).items,
      active: this.list({ limit: 1 }).items[0] || null,
      authority: false
    };
  }

  assertNoAutoDispatch(action) {
    if (!['push', 'merge', 'hosted_ci', 'heavy_ci'].includes(action)) throw Error('Unknown dispatch action');
    if (action === 'push' && this.policy.auto_push_per_mission) throw Error('AUTO_PUSH_PER_MISSION forbidden');
    if (action === 'merge' && this.policy.auto_merge_per_mission) throw Error('AUTO_MERGE_PER_MISSION forbidden');
    if (action === 'hosted_ci' && this.policy.hosted_ci_auto_dispatch) throw Error('HOSTED_CI_AUTO_DISPATCH forbidden');
    if (action === 'heavy_ci' && this.policy.heavy_ci_auto_dispatch) throw Error('HEAVY_CI_AUTO_DISPATCH forbidden');
    return { allowed: false, reason: 'operator_checkpoint_required', action };
  }
}

module.exports = { DevelopmentSession, loadPolicy, inMergeWindow, selectFocusedTests };
