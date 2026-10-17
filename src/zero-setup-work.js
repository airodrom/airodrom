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
  const hit = (value) => {
    const text = String(value || '');
    if (!PRODUCTION.test(text)) return false;
    // Explicit denials ("No Production") are not production projects.
    if (/\bno\s+production\b|\bnot\s+production\b|\bnon[-\s]?production\b/i.test(text)) return false;
    return true;
  };
  return hit(project.name) || (project.limitations || []).some(hit);
}

function readablePath(workspace) {
  try { return path.basename(workspace); } catch { return 'selected workspace'; }
}
function explicitAuthorizedRepository(instruction, projects) {
  const paths = String(instruction || '').match(/\/(?:Users|private|tmp|var|opt|home)\/[^\s'"]+/g) || [];
  for (const candidate of paths) {
    let root;
    try { root = fs.realpathSync(candidate); } catch { continue; }
    for (const project of projects) for (const workspace of project.repositories || []) {
      try { if (fs.realpathSync(workspace) === root) return { project, workspace: root }; } catch { /* absent */ }
    }
  }
  return null;
}
function explicitUnauthorizedPath(instruction, projects) {
  const paths = String(instruction || '').match(/\/(?:Users|private|tmp|var|opt|home)\/[^\s'"]+/g) || [];
  const allowed = new Set();
  for (const project of projects) for (const workspace of project.repositories || []) {
    try { allowed.add(fs.realpathSync(workspace)); } catch { /* absent enrollment */ }
  }
  for (const candidate of paths) {
    let root;
    try { root = fs.realpathSync(candidate); } catch { continue; }
    if (!allowed.has(root)) return true;
  }
  return false;
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
    if (/projectless task sandbox/i.test(instruction || '')) {
      const sandbox = require('./projectless-sandbox').allocate();
      return { ok: true, projectless: true, exact_fixture: /change fixture\.txt from alpha to beta/i.test(instruction || ''), project: null, workspace: sandbox.workspace, filesystem: sandbox.filesystem };
    }
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
        if (/self[- ]?repair/i.test(project.name || '') || /self-repair/i.test(root)) score.reasons.push('named_self_repair');
        if (score.reasons.length) matches.push(score);
      }
    }
    // A named active Project wins over unrelated self-repair fixture heuristics.
    const named = projects.filter(p => (instruction || '').toLowerCase().includes(String(p.name || '').toLowerCase()) && p.repositories.length === 1);
    if (named.length === 1) {
      const root = fs.realpathSync(named[0].repositories[0]);
      if (require('./control-execution').repositoryRoot(root) === root) return { ok: true, project: named[0], workspace: root };
    }
    // Ordinary work does not require a registered Project. An enrolled repository
    // is used only when the instruction names that project or its authorized path.
    if (intent?.kind === 'general') {
      if (named.length > 1) return { ok: false, clarify: true, message: 'Which authorized repository should I use?', choices: named.map(p => ({ project_name: p.name, workspace_label: readablePath(p.repositories[0]) })) };
      const authorized = explicitAuthorizedRepository(instruction, projects);
      if (authorized) return { ok: true, project: authorized.project, workspace: authorized.workspace };
      if (explicitUnauthorizedPath(instruction, projects)) return { ok: false, clarify: true, message: 'That repository is not authorized. No files were opened.', choices: [] };
      const sandbox = require('./projectless-sandbox').allocate();
      return { ok: true, projectless: true, project: null, workspace: sandbox.workspace, filesystem: sandbox.filesystem };
    }
    if (matches.length === 1) return { ok: true, project: matches[0].project, workspace: matches[0].workspace };
    if (matches.length > 1) {
      // Prefer a Project whose exact name appears in the instruction.
      const namedInInstruction = matches.filter(m => (instruction || '').toLowerCase().includes(String(m.project.name || '').toLowerCase()));
      if (namedInInstruction.length === 1) return { ok: true, project: namedInInstruction[0].project, workspace: namedInInstruction[0].workspace };
      // Owner phrase for the registered disposable Self-Repair Acceptance workspace.
      if (/prepared\s+self[- ]?repair(\s+test)?\s+workspace/i.test(instruction || '')) {
        const prepared = matches.filter(m => m.reasons.includes('named_self_repair') && m.reasons.includes('exact_initial_bytes'));
        const acceptance = prepared.filter(m => /self[- ]?repair\s+acceptance/i.test(m.project.name || ''));
        if (acceptance.length === 1) return { ok: true, project: acceptance[0].project, workspace: acceptance[0].workspace };
        if (prepared.length === 1) return { ok: true, project: prepared[0].project, workspace: prepared[0].workspace };
      }
      // Prefer an explicitly named disposable over generic fixture projects sharing the same root.
      // named_human_acceptance alone (without exact bytes) must not beat exact-file disposables.
      const preferred = matches.filter(m => m.reasons.includes('exact_initial_bytes') && (m.reasons.includes('named_human_acceptance') || m.reasons.includes('named_self_repair')));
      if (preferred.length === 1) return { ok: true, project: preferred[0].project, workspace: preferred[0].workspace };
      if (/self[- ]?repair/i.test(instruction || '')) {
        const selfRepair = matches.filter(m => m.reasons.includes('named_self_repair') && m.reasons.includes('exact_initial_bytes'));
        if (selfRepair.length === 1) return { ok: true, project: selfRepair[0].project, workspace: selfRepair[0].workspace };
        const mentioned = selfRepair.filter(m => (instruction || '').toLowerCase().includes(readablePath(m.workspace).toLowerCase()) || (instruction || '').toLowerCase().includes(String(m.project.name || '').toLowerCase()));
        if (mentioned.length === 1) return { ok: true, project: mentioned[0].project, workspace: mentioned[0].workspace };
      }
      const exact = matches.filter(m => m.reasons.includes('exact_initial_bytes'));
      if (exact.length === 1) return { ok: true, project: exact[0].project, workspace: exact[0].workspace };
      return {
        ok: false, clarify: true,
        message: 'Which disposable test workspace should I use?',
        choices: matches.map(m => ({ project_name: m.project.name, workspace_label: readablePath(m.workspace) })),
      };
    }
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

  existingTemplate(workspace, projectId) {
    for (const item of this.bridge.workTemplates.list('operator') || []) {
      if (item.state !== 'active' || item.project_id !== projectId) continue;
      try {
        const t = this.bridge.workTemplates.template(item.project, item.workspace_alias);
        if (t && t.workspace === workspace) return { project: item.project, workspace_alias: item.workspace_alias, template: t, inspect: item };
      } catch { /* invalid */ }
    }
    return null;
  }

  presentation({ project, workspace, intent, template, proposal }) {
    const files = template?.allowed_files || proposal?.allowed_files || (intent?.file ? [intent.file] : []);
    const tests = template?.verification?.tests || proposal?.tests || [];
    const diffCheck = template?.verification?.diff_check || proposal?.diff_check || '';
    const criteria = intent?.kind === 'exact_file' && intent.file
      ? [{ id: 'expected_file', type: 'exact_file', path: intent.file, content: intent.to }]
      : [];
    const dod = require('./mission-contract').definitionOfDone({ intent, criteria, verification: { tests, diff_check: diffCheck }, allowed_files: files });
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
      success_criteria: dod.items.map(i => i.text),
      completion_policy: intent?.kind === 'exact_file' &&
        intent.file === 'fixture.txt' && intent.from === 'alpha\n' &&
        intent.to === 'beta\n' && files.length === 1 && files[0] === intent.file
        ? 'Your initial approval also preauthorizes automatic completion only when the exact file bytes and all host checks pass.'
        : 'Owner Acceptance remains required after verification.',
      measurable: dod.measurable,
      repair_budget: 'One automatic correction inside this scope',
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
      if (principal === 'operator' && prior.developer_autonomy_policy_id && prior.state === 'awaiting_approval') return this.activateAutonomy(prior);
      return this.statusView(prior);
    }
    // ask_airodrom / prepare_mission prepare WORK only. Ordinary chat and public-research
    // consent stay on host conversation / Terminal flows; never auto-prepare from chat text.
    const routed = require('./assistant-intent').parse(instruction);
    if (routed.kind === 'operator_control') {
      const record = { version: 1, instruction, routed: { kind: routed.kind }, clarify: false, authority: false, workspace: null };
      this.write(request_id, principal, record, 'clarify');
      return { state: 'OPERATOR', message: 'Operator control uses authenticated settings APIs. No coding workspace, Mission, or worker was selected.', authority: false, execution_authorized: false, next_action: 'use_operator_settings' };
    }
    if (['conversation', 'preference', 'connector', 'remember', 'forget', 'recall', 'sensitive', 'vault', 'secret', 'private_storage'].includes(routed.kind)) {
      const record = { version: 1, instruction, routed: { kind: routed.kind }, clarify: true, authority: false };
      this.write(request_id, principal, record, 'clarify');
      return {
        state: 'CLARIFY',
        message: 'That looks like ordinary conversation or a host connector/memory request, not bounded local work. Use the Airodrom Terminal or Control Center conversation for chat. Rephrase with an exact disposable workspace file change to prepare a Mission.',
        authority: false,
        execution_authorized: false,
        next_action: 'use_terminal_or_control_center_chat_or_rephrase_as_work',
      };
    }
    if (['public_web_offer', 'research', 'research_session'].includes(routed.kind)) {
      const record = { version: 1, instruction, routed: { kind: routed.kind }, clarify: true, authority: false };
      this.write(request_id, principal, record, 'clarify');
      return {
        state: 'CLARIFY',
        message: 'Public or authenticated research requires explicit Terminal consent and a governed browser Mission. ask_airodrom prepares local WORK only and does not open public research.',
        authority: false,
        execution_authorized: false,
        next_action: 'use_terminal_public_web_or_research_consent',
      };
    }
    const intent = parseExactFileIntent(instruction) || { kind: 'general', objective: instruction.trim() };
    const scope = this.resolveScope(instruction, intent);
    if (!scope.ok) {
      const record = { version: 1, instruction, intent, clarify: scope, authority: false };
      this.write(request_id, principal, record, 'clarify');
      return { state: 'CLARIFY', message: scope.message, choices: scope.choices, authority: false, next_action: 'answer_one_short_clarification' };
    }
    if (scope.projectless) {
      const handoff = /^mcp:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal);
      let standing = principal === 'operator';
      if (handoff) {
        try {
          const mode = this.bridge.expandedAutonomy?.effective?.('operator');
          standing = !!(mode && mode.mode !== 'manual' && !mode.emergency_stop && mode.flags?.manual_acceptance !== true);
        } catch { standing = false; }
      }
      if ((principal === 'operator' || (handoff && standing)) && scope.exact_fixture) return this.startProjectless(request_id, principal, instruction, intent, scope);
      const record = {
        version: 1, instruction, intent, projectless: true, project_id: null, workspace: scope.workspace,
        authority: false, execution_enabled: false,
        presentation: { brand: 'AIRODROM', goal: intent.objective, project_name: null, workspace_label: 'task sandbox', files: [], worker: 'task sandbox', verification: 'Host verification remains required', completion_policy: 'Automatic Acceptance still requires independent verification', status: 'Projectless task sandbox prepared' }
      };
      this.write(request_id, principal, record, 'awaiting_approval');
      return { state: 'PREPARED', projectless: true, message: 'Prepared a task-scoped sandbox. No registered Project was required or selected.', presentation: record.presentation, authority: false, execution_authorized: false, next_action: 'approve_in_terminal_or_control_center' };
    }
    const { project, workspace } = scope;
    // Global Autopilot ON: ensure a standing policy for the resolved repo (owner-delegated).
    if (principal === 'operator' && this.bridge.globalAutopilot?.enabled?.()) {
      try {
        this.bridge.globalAutopilot.ensureRepositoryPolicy(project, workspace);
        this.bridge.globalAutopilot.record({
          kind: 'task_routed', summary: 'Autopilot routed owner ask to repository',
          project_id: project.projectId, repository: workspace, actor: 'operator'
        });
      } catch (error) {
        const record = { version: 1, instruction, intent, clarify: true, autopilot: true, authority: false, error: error.message };
        this.write(request_id, principal, record, 'clarify');
        return {
          state: 'CLARIFY',
          message: 'Autopilot could not prepare this repository: ' + error.message,
          authority: false,
          execution_authorized: false,
          next_action: 'fix_verification_tasks_or_pick_another_repository'
        };
      }
    }
    const policies = this.bridge.developerAutonomy.activePolicyForRepository(workspace);
    const standing = scope.developer_autonomy_policy_id
      ? policies.find(policy => policy.policy_id === scope.developer_autonomy_policy_id)
      : policies.length === 1 ? policies[0] : null;
    if (standing) {
      const files = this.bridge.developerAutonomy.routineFiles(standing, instruction, intent.file);
      if (!files.length) return { state: 'CLARIFY', message: 'Name the exact repository file or files to change within this enrollment.', authority: false, execution_authorized: false, next_action: 'identify_files' };
      const record = {
        version: 1, instruction, intent, project_id: standing.project_id, goal_id: standing.goal_id,
        project_name: project.name, workspace, developer_autonomy_policy_id: standing.policy_id,
        developer_autonomy_policy_hash: standing.policy_hash, allowed_files: files,
        mission_id: null, plan_id: null, execution_enabled: false, authority: false,
        presentation: { brand: 'AIRODROM', goal: intent.objective, project_name: project.name,
          workspace_label: readablePath(workspace), files, worker: 'Local OpenCode',
          verification: 'Enrolled independent verification', completion_policy: 'Owner Acceptance remains required.',
          repair_budget: standing.workflows.includes('repair') ? standing.budgets.max_repairs : 0,
          status: 'Prepared within standing enrollment' }
      };
      this.write(request_id, principal, record, 'awaiting_approval');
      // Only authenticated local owner intake may use existing standing consent.
      // MCP, model, and connector text remain proposals requiring owner approval.
      return principal === 'operator' ? this.activateAutonomy(this.read(request_id)) : this.statusView(this.read(request_id));
    }
    const existing = this.existingTemplate(workspace, project.projectId);
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
    const presentationHint = live.presentation?.status || '';
    const phase = live.phase || null;
    const repairing = !!(live.repair_of
      || outcome?.mission_state === 'needs_rework'
      || (phase && /^REPAIR_/.test(phase))
      || /Repairing|repair completed|preparing automatic repair|Verification failed/i.test(presentationHint));
    const { blockerMessage } = require('./recovery-phase');
    const blockedLabel = () => {
      if (live.blocker_message) return live.blocker_message;
      if (live.repair_blocked_reason) return 'Automatic repair blocked (' + live.repair_blocked_reason + ')';
      return blockerMessage('blocked');
    };
    const statusLabel = ({
      clarify: 'Needs a short clarification',
      awaiting_approval: 'Waiting for your approval',
      approved: 'Working',
      running: repairing ? (presentationHint || 'Repairing failed verification') : (presentationHint || 'Working'),
      verifying: repairing ? (presentationHint || 'Repair verification underway') : 'Verification underway',
      verified: 'Completed and verified',
      awaiting_acceptance: repairing ? (presentationHint || 'Repair completed. Verification passed') : 'Completed and verified',
      blocked: blockedLabel(),
      failed: live.blocker_message || 'Stopped safely. No Acceptance was recorded.',
      rejected: 'Cancelled',
    })[state] || presentationHint || state;
    const presentation = { ...(live.presentation || {}), status: statusLabel };
    if (outcome?.verification?.result === 'passed' && ['awaiting_acceptance', 'verified', 'completed'].includes(outcome.mission_state || state)) {
      presentation.status = repairing ? 'Repair completed. Verification passed' : 'Completed and verified';
      presentation.result = 'Updated ' + (presentation.files || []).join(', ');
      presentation.verification_label = 'Passed';
    }
    const terminalStates = ['verified', 'awaiting_acceptance', 'blocked', 'failed', 'rejected', 'clarify'];
    const phaseTerminal = phase ? !require('./recovery-phase').OBSERVING.has(phase) : terminalStates.includes(state);
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
        repair_of: live.repair_of || null,
        repair_blocked_reason: live.repair_blocked_reason || null,
        blocker_message: live.blocker_message || null,
        phase,
        phase_terminal: state === 'awaiting_approval' ? false : phaseTerminal,
        repair_attempt: live.repair_attempt || 0,
        max_repairs: live.max_repairs || null,
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

  activateAutonomy(live) {
    const da = this.bridge.developerAutonomy;
    const policy = da.inspect(live.developer_autonomy_policy_id);
    if (!policy || policy.state !== 'active' || policy.policy_hash !== live.developer_autonomy_policy_hash) throw Error('Standing enrollment changed; prepare a new request');
    const objective = String(live.intent?.objective || live.instruction);
    const repairBudget = policy.workflows.includes('repair') ? policy.budgets.max_repairs : 0;
    const prepared = da.authorizeRoutine({
      policy_id: policy.policy_id, request_id: 'zero-setup-da:' + live.request_id,
      objective, allowed_files: live.allowed_files, workflow: 'routine_edit', repair_budget: repairBudget,
      ...(live.intent?.kind === 'exact_file' ? { criteria: [{ id: 'expected-file', type: 'exact_file', path: live.intent.file, content: live.intent.to }] } : {})
    }, 'operator');
    const mission = this.bridge.missions.create(prepared.mission_input, 'operator');
    if (this.bridge.globalAutopilot?.enabled?.()) {
      this.bridge.globalAutopilot.record({
        kind: 'mission_authorized', summary: 'Autopilot authorized standing Mission',
        mission_id: mission.id, project_id: policy.project_id, repository: policy.repository,
        tool: 'developer_autonomy.authorizeRoutine', actor: 'operator', request_id: live.request_id
      });
    }
    const plan = this.bridge.missions.goalPlanner.create({
      request_id: 'zero-setup-da-plan:' + live.request_id, goal_id: policy.goal_id,
      stages: [{ id: 'work', depends_on: [], mission_id: mission.id, objective: objective.slice(0, 1000),
        acceptance_criteria: ['Independent host verification passed', 'Owner Acceptance remains required'],
        verification_requirements: ['registered_tests', 'git_diff_check'], human_checkpoint: false }],
      max_runtime_hours: policy.budgets.max_runtime_hours, max_attempts: repairBudget + 1
    }, 'operator');
    this.bridge.autonomousExecution.authorize(plan.id, {
      request_id: 'zero-setup-da-schedule:' + live.request_id, workers: ['opencode'],
      max_concurrent_missions: 1, max_dispatches: repairBudget + 1, max_repairs: repairBudget, confirmed: true
    }, 'operator');
    Object.assign(live, { mission_id: mission.id, plan_id: plan.id, workspace: prepared.workspace.path,
      execution_enabled: true, state: 'approved', max_repairs: repairBudget,
      presentation: { ...live.presentation, status: 'Working within standing enrollment' } });
    this.write(live.request_id, live.principal, live, 'approved');
    try { this.bridge.autonomousExecution.tick(); } catch { /* scheduler records admission blockers */ }
    return this.statusView(live);
  }

  startProjectless(request_id, principal, instruction, intent, scope) {
    if (principal !== 'operator' && !/^mcp:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal)) throw Error('Projectless execution requires the authenticated operator');
    if (!scope?.exact_fixture || !scope.workspace) throw Error('Projectless execution requires an exact authorized file change');
    const sandbox = require('./projectless-sandbox');
    sandbox.seedExactFixture(scope.workspace);
    const { randomUUID } = require('node:crypto');
    const before = (this.bridge.projects.listProjects() || []).length;
    const mission = this.bridge.missions.create(sandbox.exactMissionInput(scope.workspace, randomUUID()), 'operator');
    if ((this.bridge.projects.listProjects() || []).length !== before) throw Error('Projectless execution must not register a Project');
    this.bridge.missions.dispatch(mission.id, { request_id: randomUUID() });
    const record = {
      version: 1, instruction, intent, projectless: true, project_id: null, workspace: scope.workspace, mission_id: mission.id,
      authority: false, execution_enabled: true,
      presentation: { brand: 'AIRODROM', goal: intent?.objective || instruction, project_name: null, workspace_label: 'task sandbox', worker: 'opencode', verification: 'Independent host verification', completion_policy: 'Automatic Acceptance after verification', status: 'Projectless OpenCode mission dispatched' }
    };
    this.write(request_id, principal, record, 'running');
    return { state: 'DISPATCHED', projectless: true, execution_authorized: true, mission_id: mission.id, workspace: scope.workspace, presentation: record.presentation, authority: false, message: 'Projectless mission dispatched to OpenCode. No registered Project was created.' };
  }

  async approve(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
    object(input, ['request_id', 'confirmed', 'channel']);
    identifier(input.request_id);
    if (input.confirmed !== true) throw Error('Explicit owner approval required');
    const request_id = input.request_id;
    const live = this.read(request_id);
    if (!live) throw Error('Prepared task unavailable');
    if (['approved', 'running', 'verifying', 'awaiting_acceptance', 'verified'].includes(live.state)) return this.statusView(live);
    if (live.state !== 'awaiting_approval') throw Error('Prepared task is not awaiting approval');
    if (live.developer_autonomy_policy_id) return this.activateAutonomy(live);
    if (live.projectless) return this.startProjectless(live.request_id, live.principal, live.instruction, live.intent, { workspace: live.workspace, exact_fixture: /change fixture\.txt from alpha to beta/i.test(live.instruction || '') });
    // Distinct security decisions, presented as one coherent approval experience.
    if (!live.template_ready) {
      if (!live.proposal) throw Error('Template proposal missing');
      this.bridge.workTemplates.register({ ...live.proposal, confirmed: true }, 'operator');
      live.template_ready = true;
    }
    const baseObjective = live.intent?.objective || live.instruction;
    // Project mission names are unique per Goal; keep ZeroSetup retries from colliding.
    const objective = String(baseObjective).slice(0, 160) + ' [' + String(request_id).slice(0, 8) + ']';
    const packet = {
      version: 2,
      request_id: 'zero-setup:' + request_id,
      objective,
      mission_class: 'WORK',
      data_class: 'public',
      privacy: 'local_only',
      project: live.project_alias,
      workspace: live.workspace_alias,
      worker: 'auto',
      model: 'auto',
    };
    // One authenticated approval binds both this exact expected result and
    // its future automatic settlement. General tasks keep owner Acceptance.
    const registered = this.bridge.workTemplates.template(live.project_alias, live.workspace_alias);
    const eligible = live.intent?.kind === 'exact_file' &&
      live.intent.file === 'fixture.txt' && live.intent.from === 'alpha\n' &&
      live.intent.to === 'beta\n' && registered?.allowed_files?.length === 1 &&
      registered.allowed_files[0] === live.intent.file;
    let acceptance = null;
    if (eligible) {
      const target = path.join(live.workspace, live.intent.file);
      if (fs.realpathSync(target) !== target || fs.readFileSync(target, 'utf8') !== live.intent.from)
        throw Error('Exact-file baseline changed; prepare a new bounded request');
      acceptance = { file: live.intent.file, before: live.intent.from, after: live.intent.to };
    }
    const submitted = await handoff.submit(this.bridge, packet, 'operator', acceptance);
    if (!submitted.mission_id) throw Error(submitted.reason || 'WORK handoff did not create a Mission');
    live.mission_id = submitted.mission_id;
    // ADR 0051: one authenticated owner approval bound to the Mission's immutable scope
    // fingerprint, time window and repair budget. Corrective Missions reuse it in-scope.
    const created = this.bridge.controlStore.requireMission(submitted.mission_id);
    if (created.envelope.contract && this.bridge.missionApprovals) {
      const approval = this.bridge.missionApprovals.issue({
        request_id: 'zero-setup-approval:' + request_id,
        channel: input.channel && ['terminal', 'control_center', 'fixture'].includes(input.channel) ? input.channel : 'terminal',
        contract: created.envelope.contract,
        goal_id: live.goal_id,
        confirmed: true,
        ttl_ms: 2 * 60 * 60 * 1000,
        summary: { goal: live.intent?.objective || live.instruction },
      }, 'operator');
      this.bridge.missionApprovals.bind(approval.approval_id, submitted.mission_id, 'operator');
      // Binding the trusted approval seals a new Mission envelope revision.
      // Rebind the auto-completion fingerprint only after that host mutation.
      // A stale hash must never be interpreted as permission.
      if (acceptance) {
        const bound = this.bridge.controlStore.requireMission(submitted.mission_id);
        if (!bound.envelope.risk_auto_acceptance?.authorized)
          throw Error('Preauthorized completion policy was not recorded');
        this.bridge.missions.riskAcceptance.register(bound, bound.envelope.risk_auto_acceptance);
      }
      live.approval_id = approval.approval_id;
      live.approval_expires_at = approval.expires_at;
    }
    const stages = [{
      id: 'work',
      depends_on: [],
      mission_id: submitted.mission_id,
      objective,
      acceptance_criteria: acceptance
        ? ['Exact-file bytes and registered host checks passed; preauthorized automatic completion']
        : ['Independent host verification passed', 'Owner Acceptance remains required'],
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

  repairObservation(live) {
    if (!live.plan_id) return null;
    try {
      const plan = this.bridge.autonomousExecution.inspect(live.plan_id);
      const autonomous = plan.autonomous || {};
      const lineage = autonomous.repair_lineage || {};
      const stage = plan.stages.find(s => s.mission_id === live.mission_id)
        || plan.stages.find(s => lineage[s.id]?.parent_mission_id === live.mission_id || lineage[s.id]?.repair_mission_id === live.mission_id)
        || plan.stages[0];
      if (!stage) return { plan, autonomous, stage: null, lineage: null, blocked: null, phase: null };
      const stageLineage = lineage[stage.id] || null;
      const blocked = autonomous.repair_blocked?.[stage.id] || null;
      const phase = autonomous.phases?.[stage.id] || null;
      return { plan, autonomous, stage, lineage: stageLineage, blocked, phase };
    } catch {
      return null;
    }
  }

  refreshState(request_id) {
    const live = this.read(request_id);
    if (!live || !live.mission_id) return live ? this.statusView(live) : null;
    try {
      const { stagePhase, presentationFor, OBSERVING } = require('./recovery-phase');
      const observation = this.repairObservation(live);
      // Follow CAE repair rebind when the Goal Plan stage moved to a corrective Mission.
      if (observation?.stage?.mission_id && observation.stage.mission_id !== live.mission_id) {
        live.mission_id = observation.stage.mission_id;
        live.repair_of = observation.lineage?.parent_mission_id || live.repair_of || null;
      }
      if (observation?.lineage?.parent_mission_id) {
        live.repair_of = observation.lineage.parent_mission_id;
      }
      const m = this.bridge.missions.require(live.mission_id);
      // One derived phase decides observation vs terminal; never the raw Mission state alone.
      const phase = observation?.phase || stagePhase({ mission: m, autonomous: observation?.autonomous || {}, stageId: observation?.stage?.id || 'work' });
      if (phase.mission_id && phase.mission_id !== live.mission_id) {
        live.mission_id = phase.mission_id;
        live.repair_of = phase.parent_mission_id || live.repair_of || null;
      }
      live.phase = phase.phase;
      live.repair_attempt = phase.repair_attempt || observation?.autonomous?.repair_counts?.[observation?.stage?.id] || 0;
      live.max_repairs = phase.max_repairs || observation?.autonomous?.max_repairs || null;
      let state = live.state;
      let presentationStatus = presentationFor(phase.phase, { files: live.presentation?.files || [] });
      switch (phase.phase) {
        case 'INITIAL_EXECUTION':
        case 'VERIFICATION_FAILED':
        case 'REPAIR_ELIGIBILITY_CHECK':
        case 'REPAIR_PENDING':
        case 'REPAIR_CREATING':
        case 'REPAIR_DISPATCHED':
        case 'REPAIR_RUNNING':
          state = 'running';
          if (phase.phase === 'REPAIR_PENDING' && phase.message) presentationStatus = phase.message;
          break;
        case 'INITIAL_VERIFICATION':
        case 'REPAIR_VERIFYING':
          state = 'verifying';
          break;
        case 'AWAITING_ACCEPTANCE':
        case 'REPAIR_VERIFIED':
          state = 'awaiting_acceptance';
          break;
        case 'MISSION_VERIFIED':
          state = 'verified';
          break;
        case 'REPAIR_BLOCKED':
        case 'QUARANTINED':
        case 'WAITING_OWNER':
          state = 'blocked';
          live.repair_blocked_reason = phase.reason || observation?.blocked || live.repair_blocked_reason || m.reason || 'blocked';
          live.blocker_message = phase.message || null;
          presentationStatus = phase.message || ('Automatic repair blocked (' + live.repair_blocked_reason + ')');
          break;
        case 'FAILED_TERMINAL':
          state = 'blocked';
          live.repair_blocked_reason = phase.reason || m.reason || 'blocked';
          live.blocker_message = phase.message || null;
          presentationStatus = phase.message || presentationStatus;
          break;
        case 'CANCELLED':
          state = 'failed';
          live.blocker_message = 'The task was cancelled. No Acceptance was recorded.';
          break;
        default:
          state = OBSERVING.has(phase.phase) ? 'running' : live.state;
      }
      if (OBSERVING.has(phase.phase)) {
        // A nonterminal phase must never carry a stale terminal reason forward.
        live.repair_blocked_reason = null;
        live.blocker_message = null;
      }
      if (presentationStatus) {
        live.presentation = { ...(live.presentation || {}), status: presentationStatus };
      }
      live.state = state;
      this.write(request_id, live.principal, live, state);
      return this.statusView(live);
    } catch {
      return this.statusView(live);
    }
  }
}

module.exports = { ZeroSetupWork, parseExactFileIntent };
