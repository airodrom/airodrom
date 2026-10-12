'use strict';
// Zero-setup autonomous WORK: natural-language intake prepares bounded scope.
// Preparation never grants permission. Owner consent remains authenticated and explicit.
const fs = require('node:fs');
const path = require('node:path');
const { object, identifier, text } = require('./control-plane-store');
const handoff = require('./mission-handoff');

const PRODUCTION = /\b(production|prod\b|live\s+prod|deployed\s+prod)\b/i;
const ALIAS = v => { if (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(v)) throw Error('Exact template alias required'); return v; };

function parseExactFileIntent(instruction) {
  const lower = String(instruction || '').toLowerCase();
  if (!/\balpha\b/.test(lower) || !/\bbeta\b/.test(lower)) return null;
  if (!/\b(fixture(?:\.txt)?|test\s+file|test)\b/.test(lower)) return null;
  return { kind: 'exact_file', file: 'fixture.txt', from: 'alpha\n', to: 'beta\n', objective: 'Change fixture.txt from alpha to beta. Preserve exactly one trailing newline. Do not commit, push, merge or deploy.' };
}

function slugAlias(name, fallback) {
  const base = String(name || fallback || 'work').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return ALIAS(base || fallback || 'work');
}

function isProductionProject(project) {
  return PRODUCTION.test(project.name || '') || (project.limitations || []).some(l => PRODUCTION.test(l));
}

function readablePath(workspace) {
  try { return path.basename(workspace); } catch { return 'selected workspace'; }
}

class ZeroSetupWork {
  constructor(bridge) {
    this.bridge = bridge;
    this.db = bridge.controlStore.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cp_zero_setup_requests(
      request_id TEXT PRIMARY KEY, principal TEXT NOT NULL, record TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
  }

  read(requestId) {
    identifier(requestId);
    const row = this.db.prepare('SELECT * FROM cp_zero_setup_requests WHERE request_id=?').get(requestId);
    if (!row) return null;
    return { ...JSON.parse(row.record), request_id: row.request_id, state: row.state, principal: row.principal, created_at: row.created_at, updated_at: row.updated_at };
  }

  write(requestId, principal, record, state) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO cp_zero_setup_requests VALUES(?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET record=excluded.record, state=excluded.state, updated_at=excluded.updated_at`)
      .run(requestId, principal, JSON.stringify(record), state, now, now);
  }

  resolveScope(instruction, intent) {
    const projects = (this.bridge.projects.listProjects({ status: 'active' }) || []).filter(p => !isProductionProject(p) && Array.isArray(p.repositories) && p.repositories.length);
    const matches = [];
    for (const project of projects) {
      for (const workspace of project.repositories) {
        if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) continue;
        let root;
        try { root = fs.realpathSync(workspace); } catch { continue; }
        if (require('./control-execution').repositoryRoot(root) !== root) continue;
        const score = { project, workspace: root, reasons: [] };
        if (intent?.file) {
          const target = path.join(root, intent.file);
          try {
            if (fs.lstatSync(target).isFile() && fs.readFileSync(target, 'utf8') === intent.from) score.reasons.push('exact_initial_bytes');
          } catch { /* not a match */ }
        }
        if (/human acceptance exact file/i.test(project.name || '')) score.reasons.push('named_human_acceptance');
        if (score.reasons.length) matches.push(score);
      }
    }
    if (matches.length === 1) return { ok: true, project: matches[0].project, workspace: matches[0].workspace };
    if (matches.length > 1) {
      // Prefer an explicitly named human-acceptance disposable over generic fixture projects sharing the same root.
      const preferred = matches.filter(m => m.reasons.includes('named_human_acceptance'));
      if (preferred.length === 1) return { ok: true, project: preferred[0].project, workspace: preferred[0].workspace };
      const exact = matches.filter(m => m.reasons.includes('exact_initial_bytes'));
      if (exact.length === 1) return { ok: true, project: exact[0].project, workspace: exact[0].workspace };
      return {
        ok: false, clarify: true,
        message: 'Which disposable test workspace should I use?',
        choices: matches.map(m => ({ project_name: m.project.name, workspace_label: readablePath(m.workspace) })),
      };
    }
    // Unique project whose name is mentioned and has a single repository.
    const named = projects.filter(p => (instruction || '').toLowerCase().includes(String(p.name || '').toLowerCase()) && p.repositories.length === 1);
    if (named.length === 1) return { ok: true, project: named[0], workspace: fs.realpathSync(named[0].repositories[0]) };
    return {
      ok: false, clarify: true,
      message: 'I could not uniquely resolve a disposable local workspace. Name the Project or prepare one disposable test repository.',
      choices: projects.slice(0, 8).map(p => ({ project_name: p.name, workspace_label: readablePath(p.repositories[0]) })),
    };
  }

  resolveGoal(project, intent) {
    const goals = (this.bridge.projects.summary(project.projectId).goals || []).filter(g => g.status === 'active');
    if (intent?.kind === 'exact_file') {
      const hit = goals.find(g => /exact-file|alpha to beta|fixture/i.test(g.name || ''));
      if (hit) return hit;
    }
    if (goals.length === 1) return goals[0];
    return this.bridge.projects.createGoal({
      projectId: project.projectId,
      name: intent?.kind === 'exact_file' ? 'Exact-file alpha to beta' : 'Bounded autonomous work',
      description: intent?.objective || 'Bounded local work prepared from a natural-language request.',
      desiredOutcome: intent?.kind === 'exact_file' ? 'fixture.txt bytes 62 65 74 61 0a with independent verification passed; Acceptance remains owner-only.' : 'Verified bounded result; Acceptance remains owner-only.',
    });
  }

  existingTemplate(workspace) {
    for (const item of this.bridge.workTemplates.list('operator') || []) {
      if (item.state !== 'active') continue;
      try {
        const t = this.bridge.workTemplates.template(item.project, item.workspace_alias);
        if (t && t.workspace === workspace) return { project: item.project, workspace_alias: item.workspace_alias, template: t, inspect: item };
      } catch { /* invalid */ }
    }
    return null;
  }

  presentation({ project, workspace, intent, template, proposal }) {
    const files = template?.allowed_files || proposal?.allowed_files || (intent?.file ? [intent.file] : []);
    return {
      brand: 'AIRODROM',
      goal: intent?.objective || 'Bounded local work',
      project_name: project.name,
      workspace_label: readablePath(workspace),
      files,
      worker: 'Local OpenCode',
      verification: intent?.kind === 'exact_file'
        ? 'Exact file content + focused test + git diff --check'
        : 'Registered focused verification',
      network: 'No external access',
      github: 'No commits or pushes',
      production: 'No access',
      status: 'Waiting for your approval',
    };
  }

  async ask({ instruction, request_id }, principal = 'mcp:zero-setup') {
    text(instruction, 'instruction', 4000);
    identifier(request_id);
    identifier(principal);
    if (require('./assistant-intent').secret(instruction) || require('./private-vault-intent').containsPrivate(instruction)) {
      throw Error('Secrets and private identifiers cannot be work instructions. Use the vault flows.');
    }
    const prior = this.read(request_id);
    if (prior) {
      if (prior.principal !== principal) throw Error('Resume the original authenticated handoff session; duplicate execution denied');
      return this.statusView(prior);
    }
    const intent = parseExactFileIntent(instruction) || { kind: 'general', objective: instruction.trim().slice(0, 1000) };
    const scope = this.resolveScope(instruction, intent);
    if (!scope.ok) {
      const record = { version: 1, instruction, intent, clarify: scope, authority: false };
      this.write(request_id, principal, record, 'clarify');
      return { state: 'CLARIFY', message: scope.message, choices: scope.choices, authority: false, next_action: 'answer_one_short_clarification' };
    }
    const { project, workspace } = scope;
    const existing = this.existingTemplate(workspace);
    const goal = existing?.template
      ? this.bridge.projects.getGoal(existing.template.goal_id)
      : this.resolveGoal(project, intent);
    const goalId = goal.goalId || goal.id;
    const projectAlias = existing?.project || slugAlias(project.name, 'local-work');
    const workspaceAlias = existing?.workspace_alias || slugAlias(readablePath(workspace), 'workspace');
    let proposal = null;
    if (!existing) {
      if (!intent.file) {
        return {
          state: 'CLARIFY',
          message: 'Which exact file should change in ' + project.name + '?',
          choices: [{ project_name: project.name, workspace_label: readablePath(workspace) }],
          authority: false,
          next_action: 'answer_one_short_clarification',
        };
      }
      proposal = {
        project: projectAlias,
        workspace_alias: workspaceAlias,
        project_id: project.projectId,
        goal_id: goalId,
        workspace,
        allowed_files: [intent.file],
        diff_check: 'diff-check',
        tests: ['fixture-test'],
        duration_minutes: 120,
      };
      // Validate proposable shape without registering (boundaries + verifier presence).
      for (const f of proposal.allowed_files) {
        const target = path.join(workspace, f);
        if (!fs.existsSync(target)) throw Error('Required file is missing from the disposable workspace: ' + f);
      }
      const tasksPath = path.join(workspace, '.vscode/tasks.json');
      if (!fs.existsSync(tasksPath)) throw Error('Focused verification tasks are missing (.vscode/tasks.json).');
      const dirty = require('./control-context').workspaceSnapshot(workspace).dirty;
      if (dirty.some(f => proposal.allowed_files.includes(f) || f === '.vscode/tasks.json')) throw Error('Workspace has dirty overlap with the proposed scope; clean or commit unrelated edits first.');
      this.bridge.workTemplates.propose(proposal, 'operator');
    }
    const presentation = this.presentation({ project, workspace, intent, template: existing?.template, proposal });
    const record = {
      version: 1,
      instruction,
      intent,
      project_id: project.projectId,
      project_name: project.name,
      goal_id: goalId,
      goal_name: goal.name,
      workspace,
      project_alias: projectAlias,
      workspace_alias: workspaceAlias,
      template_ready: !!existing,
      proposal,
      presentation,
      mission_id: null,
      plan_id: null,
      execution_enabled: false,
      authority: false,
    };
    this.write(request_id, principal, record, 'awaiting_approval');
    this.bridge.controlStore.event('zero_setup.prepared', null, { request_id, project: projectAlias, workspace_alias: workspaceAlias, authority: false });
    return this.statusView(this.read(request_id));
  }

  statusView(record) {
    const live = record.request_id ? this.read(record.request_id) : record;
    const state = live.state || record.state || 'awaiting_approval';
    let outcome = null;
    if (live.mission_id) {
      try {
        const m = this.bridge.missions.require(live.mission_id);
        const view = require('./product-observability').missionView(this.bridge, m);
        outcome = {
          mission_state: m.state,
          verification: view.verification,
          acceptance: view.acceptance,
          settlement: view.settlement,
          progress: view.progress,
        };
      } catch { /* mission may not exist yet */ }
    }
    const statusLabel = ({
      clarify: 'Needs a short clarification',
      awaiting_approval: 'Waiting for your approval',
      approved: 'Working',
      running: 'Working',
      verifying: 'Verification underway',
      verified: 'Completed and verified',
      awaiting_acceptance: 'Completed and verified',
      blocked: 'Blocked',
      failed: 'Failed',
      rejected: 'Cancelled',
    })[state] || live.presentation?.status || state;
    const presentation = { ...(live.presentation || {}), status: statusLabel };
    if (outcome?.verification?.result === 'passed' && ['awaiting_acceptance', 'verified', 'completed'].includes(outcome.mission_state || state)) {
      presentation.status = 'Completed and verified';
      presentation.result = 'Updated ' + (presentation.files || []).join(', ');
      presentation.verification_label = 'Passed';
    }
    return {
      state: state === 'awaiting_approval' ? 'WAIT' : state.toUpperCase(),
      message: state === 'awaiting_approval'
        ? 'Airodrom prepared a bounded task. Confirm in the authenticated Terminal with y/N, or Approve this task in Control Center. No file writes or autonomous scheduling occur before that confirmation.'
        : presentation.status,
      presentation,
      next_action: state === 'awaiting_approval' ? 'approve_in_terminal_or_control_center' : 'inspect_result',
      outcome,
      technical: {
        request_id: live.request_id || record.request_id,
        project_id: live.project_id,
        goal_id: live.goal_id,
        plan_id: live.plan_id,
        mission_id: live.mission_id,
        project_alias: live.project_alias,
        workspace_alias: live.workspace_alias,
      },
      authority: false,
      execution_authorized: !!live.execution_enabled,
    };
  }

  listPending(owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
    return this.db.prepare("SELECT request_id, record, state, created_at FROM cp_zero_setup_requests WHERE state='awaiting_approval' ORDER BY created_at DESC LIMIT 20")
      .all().map(row => {
        const record = JSON.parse(row.record);
        return {
          request_id: row.request_id,
          state: row.state,
          created_at: row.created_at,
          presentation: record.presentation,
          project_name: record.project_name,
          goal_name: record.goal_name,
          template_ready: !!record.template_ready,
          authority: false,
        };
      });
  }

  async approve(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
    object(input, ['request_id', 'confirmed']);
    identifier(input.request_id);
    if (input.confirmed !== true) throw Error('Explicit owner approval required');
    const request_id = input.request_id;
    const live = this.read(request_id);
    if (!live) throw Error('Prepared task unavailable');
    if (['approved', 'running', 'verifying', 'awaiting_acceptance', 'verified'].includes(live.state)) return this.statusView(live);
    if (live.state !== 'awaiting_approval') throw Error('Prepared task is not awaiting approval');
    // Distinct security decisions, presented as one coherent approval experience.
    if (!live.template_ready) {
      if (!live.proposal) throw Error('Template proposal missing');
      this.bridge.workTemplates.register({ ...live.proposal, confirmed: true }, 'operator');
      live.template_ready = true;
    }
    const packet = {
      version: 2,
      request_id: 'zero-setup:' + request_id,
      objective: live.intent?.objective || live.instruction,
      mission_class: 'WORK',
      data_class: 'public',
      privacy: 'local_only',
      project: live.project_alias,
      workspace: live.workspace_alias,
      worker: 'auto',
      model: 'auto',
    };
    const submitted = await handoff.submit(this.bridge, packet, 'operator');
    if (!submitted.mission_id) throw Error(submitted.reason || 'WORK handoff did not create a Mission');
    live.mission_id = submitted.mission_id;
    const stages = [{
      id: 'work',
      depends_on: [],
      mission_id: submitted.mission_id,
      objective: live.intent?.objective || live.instruction,
      acceptance_criteria: ['Independent host verification passed', 'Owner Acceptance remains required'],
      verification_requirements: ['exact_file_or_registered_tests', 'git_diff_check'],
      human_checkpoint: false,
    }];
    const plan = this.bridge.missions.goalPlanner.create({
      request_id: 'zero-setup-plan:' + request_id,
      goal_id: live.goal_id,
      stages,
      max_runtime_hours: 2,
      max_attempts: 2,
    }, 'operator');
    live.plan_id = plan.id;
    this.bridge.autonomousExecution.authorize(plan.id, {
      request_id: 'zero-setup-auth:' + request_id,
      workers: ['opencode'],
      max_concurrent_missions: 1,
      max_dispatches: 3,
      max_repairs: 1,
      confirmed: true,
    }, 'operator');
    const autonomous = this.bridge.autonomousExecution.readAutonomous(this.bridge.autonomousExecution.planRow(plan.id));
    if (autonomous.pending_request) {
      delete autonomous.pending_request;
      this.bridge.autonomousExecution.writeAutonomous(plan.id, autonomous);
    }
    live.execution_enabled = true;
    live.state = 'approved';
    live.presentation = { ...live.presentation, status: 'Working' };
    this.write(request_id, live.principal, live, 'approved');
    this.bridge.controlStore.event('zero_setup.approved', null, { request_id, plan_id: plan.id, mission_id: submitted.mission_id, authority: false });
    try { this.bridge.autonomousExecution.tick(); } catch { /* scheduler owns retries */ }
    return this.statusView(live);
  }

  reject(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
    object(input, ['request_id', 'confirmed']);
    identifier(input.request_id);
    if (input.confirmed !== true) throw Error('Explicit cancellation required');
    const live = this.read(input.request_id);
    if (!live) throw Error('Prepared task unavailable');
    if (live.proposal) {
      try { this.bridge.workTemplates.rejectProposal({ project: live.proposal.project, workspace_alias: live.proposal.workspace_alias, confirmed: true }, 'operator'); } catch { /* optional */ }
    }
    live.state = 'rejected';
    live.presentation = { ...live.presentation, status: 'Cancelled' };
    this.write(input.request_id, live.principal, live, 'rejected');
    return this.statusView(live);
  }

  refreshState(request_id) {
    const live = this.read(request_id);
    if (!live || !live.mission_id) return live ? this.statusView(live) : null;
    try {
      const m = this.bridge.missions.require(live.mission_id);
      let state = live.state;
      if (m.state === 'running' || m.state === 'dispatched') state = 'running';
      else if (m.state === 'verifying') state = 'verifying';
      else if (m.state === 'awaiting_acceptance') state = 'awaiting_acceptance';
      else if (m.state === 'blocked' || m.state === 'needs_rework') state = 'blocked';
      else if (m.state === 'failed' || m.state === 'cancelled') state = 'failed';
      if (state !== live.state) {
        live.state = state;
        this.write(request_id, live.principal, live, state);
      }
      return this.statusView(live);
    } catch {
      return this.statusView(live);
    }
  }
}

module.exports = { ZeroSetupWork, parseExactFileIntent };
