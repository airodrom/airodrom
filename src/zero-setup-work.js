'use strict';
// Zero-setup autonomous WORK: natural-language intake prepares bounded scope.
// Preparation never grants permission. Owner consent remains authenticated and explicit.
const fs = require('node:fs');
const path = require('node:path');
const { object, identifier, text } = require('./control-plane-store');

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
  const { extractAbsolutePaths, normalizeAbsolutePathCandidate } = require('./project-resolution');
  const paths = extractAbsolutePaths(instruction);
  for (const candidate of paths) {
    let root;
    try { root = fs.realpathSync(normalizeAbsolutePathCandidate(candidate)); } catch { continue; }
    for (const project of projects) for (const workspace of project.repositories || []) {
      try { if (fs.realpathSync(workspace) === root) return { project, workspace: root }; } catch { /* absent */ }
    }
  }
  return null;
}
function explicitUnauthorizedPath(instruction, projects) {
  const { extractAbsolutePaths, normalizeAbsolutePathCandidate } = require('./project-resolution');
  const paths = extractAbsolutePaths(instruction);
  const allowed = new Set();
  for (const project of projects) for (const workspace of project.repositories || []) {
    try { allowed.add(fs.realpathSync(workspace)); } catch { /* absent enrollment */ }
  }
  let sawResolvable = false;
  for (const candidate of paths) {
    let root;
    try { root = fs.realpathSync(normalizeAbsolutePathCandidate(candidate)); } catch { continue; }
    sawResolvable = true;
    if (!allowed.has(root)) return true;
  }
  // Explicit path text that cannot be resolved still counts as an unauthorized claim.
  return !sawResolvable && paths.length > 0;
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
    const previous = (() => {
      try { return this.read(requestId)?.state || null; } catch { return null; }
    })();
    if (state === 'blocked' && !record.limits_blockers) {
      try {
        const codes = Array.isArray(record.blockers) && record.blockers.length
          ? record.blockers
          : [record.presentation?.status || state];
        const L = require('./limits-blockers-registry');
        const report = L.reportForBlock(this.bridge, {
          codes, request_id: requestId, mission_id: record.mission_id || null,
        });
        record.limits_blockers = report;
        record.recovery_attempt = L.attemptAuthorizedRecovery(this.bridge, report, 'operator');
        record.presentation = {
          ...(record.presentation || {}),
          registry_id: report.primary_registry_id,
          next_safe_action: report.next_safe_action,
          owner_approval_required: report.owner_approval_required,
          security_critical: report.security_critical,
          recovery_receipt_id: record.recovery_attempt?.recovery_receipt?.id || null,
          recovery_performed: !!record.recovery_attempt?.performed,
          owner_gate: record.recovery_attempt?.owner_gate || null,
        };
      } catch { /* annotation must not block durable ask write */ }
    }
    const now = Date.now();
    this.db.prepare(`INSERT INTO cp_zero_setup_requests VALUES(?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET record=excluded.record, state=excluded.state, updated_at=excluded.updated_at`)
      .run(requestId, principal, JSON.stringify(record), state, now, now);
    // Event-driven ask notifications for terminal / actionable WAIT states before
    // a Mission id exists. Duplicate-safe; never throws into intake.
    try {
      require('./mission-terminal-notifications').onRequestState(this.bridge, {
        ...record, request_id: requestId, principal, state,
      }, { previous, state });
    } catch { /* notification must not block durable ask write */ }
  }

  activeProjects() {
    return (this.bridge.projects.listProjects({ status: 'active' }) || [])
      .filter(p => !isProductionProject(p) && Array.isArray(p.repositories) && p.repositories.length);
  }

  // Discover an enrolled Project without allocating a projectless sandbox.
  resolveEnrolledProject(instruction) {
    const projects = this.activeProjects();
    const { resolveEnrolledScope, isFixtureOrHandoffPath } = require('./project-resolution');
    const { liveRepositories } = require('./project-defaults');
    const activeRepositories = new Set();
    const defaultProjectIds = new Set();
    let policies = [];
    try {
      policies = this.bridge.developerAutonomy?.list?.('operator') || [];
      for (const policy of policies) {
        if (policy.state === 'active' && policy.repository) activeRepositories.add(policy.repository);
      }
      for (const item of this.bridge.projectDefaults?.list?.() || []) {
        if (item?.project_id && item?.repository) defaultProjectIds.add(item.project_id);
      }
    } catch { /* enrollment store unavailable */ }
    const mapped = projects.map(p => ({ ...p, repositories: liveRepositories(p) }));
    const resolved = resolveEnrolledScope(instruction, {
      projects: mapped,
      policies,
      activeRepositories,
      defaultProjectIds,
    });
    if (resolved.projectless) {
      return { ok: true, projectless: true, project: null, workspace: null };
    }
    if (!resolved.ok) {
      return {
        ok: false,
        clarify: true,
        projectless: false,
        code: resolved.code || 'ENROLLED_WORKSPACE_REQUIRED',
        message: resolved.message || 'That repository is not authorized. No files were opened.',
        choices: resolved.choices || [],
        selector_kind: resolved.selector_kind || null,
        project: resolved.project || null,
        workspace: resolved.workspace || null,
        policy: resolved.policy || null,
      };
    }
    const excludeFixtures = /\b(?:not|neither|except|excluding)\b[\s\w,/.'"-]{0,120}\b(?:chatgpt-handoff|recovery[- ]proof|fixture)\b/i.test(instruction);
    if (excludeFixtures && (isFixtureOrHandoffPath(resolved.workspace) || isFixtureOrHandoffPath(resolved.project?.name))) {
      return {
        ok: false, clarify: true, projectless: false,
        code: 'CROSS_PROJECT_FIXTURE_FALLBACK_REJECTED',
        message: 'That request excluded fixture/handoff projects. Name an enrolled non-fixture repository, or enroll airodrom/airodrom for source work.',
        choices: [],
      };
    }
    return {
      ok: true,
      project: resolved.project,
      workspace: resolved.workspace,
      projectless: false,
      policy: resolved.policy || null,
      selector_kind: resolved.selector_kind || null,
      source_bound: resolved.selector_kind === 'authoritative_target',
      target_id: resolved.authoritative?.target_id,
      repository_id: resolved.authoritative?.repository_id,
      repository_binding: resolved.authoritative?.repository_binding,
    };
  }

  resolveScope(instruction, intent) {
    if (/projectless task sandbox/i.test(instruction || '')) {
      const sandbox = require('./projectless-sandbox').allocate();
      return { ok: true, projectless: true, exact_fixture: /change fixture\.txt from alpha to beta/i.test(instruction || ''), project: null, workspace: sandbox.workspace, filesystem: sandbox.filesystem };
    }
    const projects = this.activeProjects();
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
    const enrolled = this.resolveEnrolledProject(instruction);
    if (!enrolled.projectless) {
      if (!enrolled.ok) {
        // Named registered project without standing DA still binds the project for
        // ordinary (non-Cursor) scope. Cursor intake keeps the fail-closed code.
        if (enrolled.project && enrolled.workspace
            && (enrolled.code === 'ENROLLED_WORKSPACE_REQUIRED' || enrolled.code === 'STANDING_ENROLLMENT_REQUIRED')) {
          return { ok: true, project: enrolled.project, workspace: enrolled.workspace };
        }
        return enrolled;
      }
      return { ok: true, project: enrolled.project, workspace: enrolled.workspace };
    }
    // Ordinary work does not require a registered Project. An enrolled repository
    // is used only when the instruction names that project or its authorized path.
    if (intent?.kind === 'general') {
      const sandbox = require('./projectless-sandbox').allocate();
      return { ok: true, projectless: true, project: null, workspace: sandbox.workspace, filesystem: 'task_sandbox_only' };
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
      const error = Error('SECRET_DETECTED_IN_WORK_INSTRUCTION');
      error.code = 'SECRET_DETECTED_IN_WORK_INSTRUCTION';
      throw error;
    }
    const prior = this.read(request_id);
    if (!prior || prior.cognitive) {
      const cognitive = await require('./cognitive-router').prepare(this, { instruction, request_id }, principal);
      if (cognitive) return cognitive;
    }
    if (prior) {
      if (prior.principal !== principal) throw Error('Resume the original authenticated handoff session; duplicate execution denied');
      if ((prior.work_spec || prior.projectless || prior.intake_blockers) && prior.instruction !== instruction)
        throw Error('projectless_request_replay_mismatch');
      if (prior.state === 'awaiting_approval' && !prior.intake_blockers &&
          (prior.developer_autonomy_policy_id || prior.work_spec || prior.proposal || prior.template_ready || prior.intent?.kind === 'exact_file'))
        return this.blockUnplanned(prior);
      return this.statusView(prior);
    }
    // ask_airodrom / prepare_mission prepare WORK only. Ordinary chat and public-research
    // consent stay on host conversation / Terminal flows; never auto-prepare from chat text.
    const sandbox = require('./projectless-sandbox');
    const workSpec = sandbox.parseWorkSpec(instruction) || sandbox.parseNaturalWorkSpec(instruction);
    // Enrolled-project Cursor requests must never be intercepted by the projectless
    // exact two-file fixture grammar. Resolve the named repository first.
    let enrolledCursorScope = null;
    if (!workSpec && sandbox.explicitlyRequestsCursor(instruction)) {
      const enrolled = this.resolveEnrolledProject(instruction);
      if (!enrolled.ok) {
        const record = {
          version: 1, instruction, clarify: enrolled, authority: false,
          intake_blockers: enrolled.code ? [enrolled.code] : undefined,
          presentation: { worker: 'cursor', files: [], measurable: false, status: enrolled.message },
        };
        this.write(request_id, principal, record, 'clarify');
        return {
          state: 'CLARIFY',
          code: enrolled.code || null,
          message: enrolled.message,
          choices: enrolled.choices || [],
          authority: false,
          execution_authorized: false,
          next_action: 'answer_one_short_clarification',
          blockers: enrolled.code ? [enrolled.code] : [],
        };
      }
      if (enrolled.projectless) {
        // Genuine projectless Cursor work still requires the finite two-file contract.
        const record = { version: 1, instruction, clarify: true, authority: false,
          intake_blockers: ['projectless_exact_two_file_syntax_required'],
          presentation: { worker: 'cursor', files: [], measurable: false,
            status: 'Cursor needs explicit bounded files and exact contents' } };
        this.write(request_id, principal, record, 'clarify');
        return this.statusView(this.read(request_id));
      }
      enrolledCursorScope = enrolled;
    }
    if (workSpec && workSpec.files.some(file => require('./assistant-intent').secret(file.content) ||
        require('./private-vault-intent').containsPrivate(file.content))) {
      const error = Error('SECRET_DETECTED_IN_WORK_INSTRUCTION');
      error.code = 'SECRET_DETECTED_IN_WORK_INSTRUCTION';
      throw error;
    }
    // A strictly validated data packet is bounded work, not conversational text.
    // The same secret/private-content and authenticated-session gates still apply.
    // Enrolled Cursor prose that named an authorized project is bounded work even
    // when the sentence does not start with a classic edit verb.
    const routed = workSpec || enrolledCursorScope?.project
      ? { kind: 'work' }
      : require('./assistant-intent').parse(instruction);
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
        code: 'WORK_INTENT_NOT_RECOGNIZED',
        message: 'WORK_INTENT_NOT_RECOGNIZED. That request is ordinary conversation or a host connector/memory request, not bounded local work. Rephrase with an exact file change, or use Terminal or Control Center for chat.',
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
    const intent = workSpec ? { kind: 'general', objective: require('./projectless-sandbox').workPresentation(workSpec).goal }
      : parseExactFileIntent(instruction) || { kind: 'general', objective: instruction.trim() };
    const scope = workSpec ? { ok: true, ...require('./projectless-sandbox').allocate(), work_spec: workSpec }
      : (enrolledCursorScope || this.resolveScope(instruction, intent));
    if (!scope.ok) {
      const record = { version: 1, instruction, intent, clarify: scope, authority: false };
      this.write(request_id, principal, record, 'clarify');
      return {
        state: 'CLARIFY',
        code: scope.code || null,
        message: scope.message,
        choices: scope.choices,
        authority: false,
        next_action: 'answer_one_short_clarification',
        blockers: scope.code ? [scope.code] : [],
      };
    }
    if (scope.projectless) {
      const handoff = /^mcp:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal);
      let standing = principal === 'operator';
      if (handoff) {
        try {
          const mode = this.bridge.expandedAutonomy?.effective?.('operator');
          standing = !!(mode && mode.mode !== 'manual' && !mode.emergency_stop && !mode.expired && mode.flags?.manual_acceptance !== true);
        } catch { standing = false; }
      }
      if (workSpec) {
        const record = { version: 1, instruction, intent, work_spec: workSpec, projectless: true,
          project_id: null, goal_id: null, workspace: scope.workspace, authority: false, execution_enabled: false,
          presentation: require('./projectless-sandbox').workPresentation(workSpec) };
        return this.blockUnplanned({ ...record, request_id, principal });
      }
      if ((principal === 'operator' || (handoff && standing)) && scope.exact_fixture) return this.startProjectless(request_id, principal, instruction, intent, scope);
      const record = {
        version: 1, instruction, intent, projectless: true, project_id: null, workspace: scope.workspace,
        authority: false, execution_enabled: false,
        presentation: { brand: 'AIRODROM', goal: intent.objective, project_name: null, workspace_label: 'task sandbox', files: [], worker: 'task sandbox', verification: 'Host verification remains required', completion_policy: 'Automatic Acceptance still requires independent verification', status: 'Projectless task sandbox prepared' }
      };
      this.write(request_id, principal, record, 'awaiting_approval');
      return { ...this.statusView(this.read(request_id)), state: 'PREPARED', projectless: true };
    }
    const { project, workspace } = scope;
    const autopilotOn = !!this.bridge.globalAutopilot?.enabled?.();
    const mcpHandoff = /^mcp:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal);
    const wantsCursorEarly = require('./projectless-sandbox').explicitlyRequestsCursor(instruction)
      || (() => {
        try { return require('./cognitive-router').requestedWorker(instruction, { cursorDisabled: false }) === 'cursor'; }
        catch { return false; }
      })();
    const selectStanding = (policies) => {
      if (scope.developer_autonomy_policy_id) {
        return policies.find(policy => policy.policy_id === scope.developer_autonomy_policy_id) || null;
      }
      if (policies.length === 1) return policies[0];
      if (!wantsCursorEarly) return null;
      // When Autopilot and a named enrollment both cover the same repo, prefer the
      // cognitive / Cursor-capable standing policy for explicit Cursor requests so
      // Autopilot's OpenCode-only policy is not silently selected.
      const withCursor = policies.filter(p => Array.isArray(p.workers) && p.workers.includes('cursor')
        && p.cognitive && Array.isArray(p.cognitive.files) && p.cognitive.files.length);
      if (withCursor.length === 1) return withCursor[0];
      const withCognitive = policies.filter(p => p.cognitive && Array.isArray(p.cognitive.files) && p.cognitive.files.length);
      if (withCognitive.length === 1) return withCognitive[0];
      return null;
    };
    const cursorStandingGate = (standingIn, files) => {
      let standing = standingIn;
      if (this.bridge.hostExecutionPolicy?.cursorDisabled?.()) {
        const record = {
          version: 1, instruction, intent, clarify: true, authority: false,
          project_id: standing.project_id, project_name: project.name, workspace,
          requested_specialist: 'cursor', planner: 'opencode', evaluator: 'opencode',
          intake_blockers: ['CURSOR_EXECUTION_DISABLED'],
          presentation: {
            worker: 'cursor', files: files || [], measurable: false, project_name: project.name,
            workspace_label: readablePath(workspace),
            status: 'Cursor execution disabled in Airodrom; implementation waits for authorized enablement',
          },
        };
        this.write(request_id, principal, record, 'blocked');
        return {
          state: 'BLOCKED',
          code: 'CURSOR_EXECUTION_DISABLED',
          message: 'Cursor execution is disabled in Airodrom. Re-enable Cursor from the authenticated Terminal or Control Center. An external Cursor subscription is unaffected.',
          blockers: ['CURSOR_EXECUTION_DISABLED'],
          authority: false,
          execution_authorized: false,
          requested_specialist: 'cursor',
          planner: 'opencode',
          evaluator: 'opencode',
          next_action: 'enable_cursor_via_authenticated_local_api',
          presentation: record.presentation,
        };
      }
      // Admission is read-only with respect to enrollment. Reuse an exact active
      // policy; adding files or workers requires the existing owner control API.
      const cognitiveReady = !!(standing.cognitive && Array.isArray(standing.cognitive.files) && standing.cognitive.files.length);
      if (!cognitiveReady) {
        const record = {
          version: 1, instruction, intent, clarify: true, authority: false,
          project_id: standing.project_id, project_name: project.name, workspace,
          requested_specialist: 'cursor', planner: 'opencode', evaluator: 'opencode',
          intake_blockers: ['standing_cognitive_enrollment_required'],
          presentation: {
            worker: 'cursor', files: files || [], measurable: false, project_name: project.name,
            workspace_label: readablePath(workspace),
            status: 'Standing enrollment needs cognitive discovery files before Cursor planning',
          },
        };
        this.write(request_id, principal, record, 'clarify');
        return {
          state: 'CLARIFY',
          code: 'standing_cognitive_enrollment_required',
          message: 'Project ' + project.name + ' is authorized, but Cursor planning needs a standing Developer Autonomy enrollment with cognitive discovery files. Enroll once from Control Center → Developer Autonomy for this repository, then retry the same request. Do not use the projectless two-file fixture syntax for enrolled work.',
          blockers: ['standing_cognitive_enrollment_required'],
          authority: false,
          execution_authorized: false,
          requested_specialist: 'cursor',
          planner: 'opencode',
          evaluator: 'opencode',
          next_action: 'enroll_developer_autonomy_cognitive_for_repository',
          presentation: record.presentation,
        };
      }
      const workers = Array.isArray(standing.workers) ? standing.workers : [];
      if (workers.length && !workers.includes('cursor')) {
        const record = {
          version: 1, instruction, intent, clarify: true, authority: false,
          project_id: standing.project_id, project_name: project.name, workspace,
          requested_specialist: 'cursor', planner: 'opencode', evaluator: 'opencode',
          intake_blockers: ['standing_cursor_worker_not_enrolled'],
          presentation: {
            worker: 'cursor', files: files || [], measurable: false, project_name: project.name,
            workspace_label: readablePath(workspace),
            status: 'Standing enrollment allows Local OpenCode only; Cursor is not on the worker allowlist',
          },
        };
        this.write(request_id, principal, record, 'blocked');
        return {
          state: 'BLOCKED',
          code: 'standing_cursor_worker_not_enrolled',
          message: 'Project ' + project.name + ' has a standing policy, but Cursor is not enrolled on that policy worker allowlist. Use an owner-enrolled Developer Autonomy policy with Cursor permitted. Chat text cannot expand the allowlist.',
          blockers: ['standing_cursor_worker_not_enrolled'],
          authority: false,
          execution_authorized: false,
          requested_specialist: 'cursor',
          planner: 'opencode',
          evaluator: 'opencode',
          next_action: 'enroll_developer_autonomy_with_cursor_worker',
          presentation: record.presentation,
        };
      }
      return null;
    };
    // Global Autopilot ON: ensure a standing policy for the resolved repo (owner-delegated).
    // Authenticated MCP handoff may use the standing policy only while Autopilot remains ON.
    if (autopilotOn && (principal === 'operator' || mcpHandoff)) {
      try {
        this.bridge.globalAutopilot.ensureRepositoryPolicy(project, workspace);
        this.bridge.globalAutopilot.record({
          kind: 'task_routed', summary: 'Autopilot routed authorized ask to repository',
          project_id: project.projectId, repository: workspace, actor: principal === 'operator' ? 'operator' : 'mcp_handoff'
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
      // Explicit Cursor must pass standing gates before Autopilot cognitive planning,
      // so OpenCode-only enrollments never enter PLANNING under a Cursor request.
      if (wantsCursorEarly) {
        const autopilotStanding = selectStanding(this.bridge.developerAutonomy.activePolicyForRepository(workspace));
        if (autopilotStanding) {
          const files = this.bridge.developerAutonomy.routineFiles(autopilotStanding, instruction, intent.file);
          const gated = cursorStandingGate(autopilotStanding, files);
          if (gated) return gated;
        }
      }
      // Autopilot enrollment may have just added cognitive discovery files. Prefer
      // OpenCode planning over asking the caller to name exact files again.
      const cognitive = await require('./cognitive-router').prepare(this, { instruction, request_id }, principal);
      if (cognitive) return cognitive;
    }
    const policies = this.bridge.developerAutonomy.activePolicyForRepository(workspace);
    const standing = selectStanding(policies);
    if (standing) {
      const files = this.bridge.developerAutonomy.routineFiles(standing, instruction, intent.file);
      const wantsCursor = wantsCursorEarly;
      // Explicit Cursor must never silently become Local OpenCode on the standing
      // DA path — including when routineFiles already resolved a fixture path.
      if (wantsCursor) {
        const gated = cursorStandingGate(standing, files);
        if (gated) return gated;
        // Explicit Cursor with cognitive enrollment: never fall through to Local OpenCode standing activate.
        const cognitive = await require('./cognitive-router').prepare(this, { instruction, request_id }, principal);
        if (cognitive) return cognitive;
        const blocked = {
          version: 1, instruction, intent, clarify: true, authority: false,
          project_id: standing.project_id, project_name: project.name, workspace,
          requested_specialist: 'cursor', planner: 'opencode', evaluator: 'opencode',
          intake_blockers: ['standing_cognitive_cursor_admission_failed'],
          presentation: {
            worker: 'cursor', files: files || standing.cognitive.files || [], measurable: false,
            project_name: project.name, workspace_label: readablePath(workspace),
            status: 'Cursor specialist preserved; cognitive admission could not start',
          },
        };
        this.write(request_id, principal, blocked, 'blocked');
        return {
          state: 'BLOCKED',
          code: 'standing_cognitive_cursor_admission_failed',
          message: 'Cursor was explicitly requested and remains the specialist, but cognitive admission could not start under the standing enrollment. Inspect Developer Autonomy cognitive files and worker allowlist; do not substitute Local OpenCode.',
          blockers: ['standing_cognitive_cursor_admission_failed'],
          authority: false,
          execution_authorized: false,
          requested_specialist: 'cursor',
          planner: 'opencode',
          evaluator: 'opencode',
          next_action: 'inspect_developer_autonomy_cognitive_enrollment',
          presentation: blocked.presentation,
        };
      }
      if (!files.length) {
        return { state: 'CLARIFY', message: 'Name the exact repository file or files to change within this enrollment.', authority: false, execution_authorized: false, next_action: 'identify_files' };
      }
      const record = {
        version: 1, instruction, intent, project_id: standing.project_id, goal_id: standing.goal_id,
        project_name: project.name, workspace, developer_autonomy_policy_id: standing.policy_id,
        developer_autonomy_policy_hash: standing.policy_hash, allowed_files: files,
        mission_id: null, plan_id: null, execution_enabled: false, authority: false,
        requested_specialist: 'opencode', planner: 'opencode', evaluator: 'opencode',
        presentation: { brand: 'AIRODROM', goal: intent.objective, project_name: project.name,
          workspace_label: readablePath(workspace), files, worker: 'Local OpenCode',
          verification: 'Enrolled independent verification', completion_policy: 'Owner Acceptance remains required.',
          repair_budget: standing.workflows.includes('repair') ? standing.budgets.max_repairs : 0,
          status: 'Prepared within standing enrollment' }
      };
      return this.blockUnplanned({ ...record, request_id, principal });
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
        const wantsCursor = require('./projectless-sandbox').explicitlyRequestsCursor(instruction);
        const record = {
          version: 1, instruction, intent, clarify: true, authority: false,
          project_id: project.projectId, project_name: project.name, workspace,
          intake_blockers: ['ENROLLED_WORKSPACE_REQUIRED'],
          presentation: {
            worker: wantsCursor ? 'cursor' : 'Local OpenCode',
            files: [], measurable: false, project_name: project.name,
            workspace_label: readablePath(workspace),
            status: 'Standing Developer Autonomy enrollment required',
          },
        };
        this.write(request_id, principal, record, 'clarify');
        return {
          state: 'CLARIFY',
          code: 'ENROLLED_WORKSPACE_REQUIRED',
          message: 'Project ' + project.name + ' was recognized at ' + readablePath(workspace) + ', but there is no active standing Developer Autonomy enrollment for that repository. Enroll once from Control Center → Developer Autonomy (include cognitive discovery files when Cursor planning is required), then retry. Do not use the projectless two-file fixture syntax for enrolled work.',
          blockers: ['ENROLLED_WORKSPACE_REQUIRED'],
          choices: [{ project_name: project.name, workspace_label: readablePath(workspace) }],
          authority: false,
          execution_authorized: false,
          next_action: 'enroll_developer_autonomy_for_repository',
          presentation: record.presentation,
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
    return this.blockUnplanned({ ...record, request_id, principal });
  }

  statusView(record) {
    if (record.cognitive) return require('./cognitive-router').view(record, this.bridge);
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
    const waiting = state === 'awaiting_approval';
    const cursorApproval = waiting && live.work_spec?.worker === 'cursor';
    const cursorDisabled = !!this.bridge.hostExecutionPolicy?.cursorDisabled?.();
    if (cursorDisabled && cursorApproval) {
      live.state = 'blocked';
      live.intake_blockers = ['CURSOR_EXECUTION_DISABLED'];
      this.write(live.request_id, live.principal, live, 'blocked');
      return {
        state: 'BLOCKED',
        code: 'CURSOR_EXECUTION_DISABLED',
        message: 'Cursor execution is disabled in Airodrom. Re-enable Cursor from the authenticated Terminal or Control Center.',
        blockers: ['CURSOR_EXECUTION_DISABLED'],
        presentation: { ...(live.presentation || {}), worker: 'cursor', status: 'Cursor execution disabled in Airodrom' },
        authority: false,
        execution_authorized: false,
        next_action: 'enable_cursor_via_authenticated_local_api',
      };
    }
    // A generic task sandbox is not an executable Mission. Approval cannot supply
    // missing files or verification; keep the original admission guards intact.
    // Derive this for old durable proposals too, without rewriting their state.
    const unboundedProjectless = waiting && live.projectless && !live.work_spec &&
      !/change fixture\.txt from alpha to beta/i.test(live.instruction || '');
    const ownerIntake = waiting && live.developer_autonomy_policy_id && live.principal !== 'operator';
    const blockers = live.intake_blockers || (unboundedProjectless
      ? ['projectless_scope_required', 'measurable_success_criteria_required']
      : cursorApproval ? ['scoped_external_disclosure_required', 'BLOCKED_SPEND_AUTHORIZATION']
      : ownerIntake ? ['standing_policy_requires_authenticated_owner_intake']
      : waiting ? ['owner_approval_required'] : []);
    if (unboundedProjectless) presentation.status = 'Needs bounded file scope and verification';
    const requestedSpecialist = live.requested_specialist
      || live.work_spec?.worker
      || (presentation.worker === 'cursor' || /cursor/i.test(String(presentation.worker || '')) ? 'cursor' : null)
      || (presentation.worker === 'Local OpenCode' ? 'opencode' : null);
    if (requestedSpecialist === 'cursor' && presentation.worker === 'Local OpenCode') {
      presentation.worker = 'cursor';
    }
    return {
      state: state === 'awaiting_approval' ? 'WAIT' : state.toUpperCase(),
      ...(live.intake_blockers?.includes('CURSOR_PLANNING_REQUIRED') ? { code: 'CURSOR_PLANNING_REQUIRED' } : {}),
      message: live.intake_blockers?.includes('projectless_exact_two_file_syntax_required')
        ? 'Use Cursor only in a new disposable workspace to create exactly two files: then list each relative path and a JSON-quoted exact content string. Encode newlines as \\n. Unsupported or additional constraints require a new bounded request; approval cannot supply missing scope.'
        : live.intake_blockers?.includes('ENROLLED_WORKSPACE_REQUIRED')
        ? ('Project ' + (live.project_name || 'named') + ' was recognized, but standing Developer Autonomy enrollment is required before Mission preparation. Do not use the projectless two-file fixture syntax for enrolled work.')
        : live.intake_blockers?.includes('standing_cognitive_enrollment_required')
        ? ('Project ' + (live.project_name || 'named') + ' is authorized. Cursor planning needs cognitive discovery files on the standing enrollment. Do not use the projectless two-file fixture syntax.')
        : live.intake_blockers?.includes('standing_cursor_worker_not_enrolled')
        ? ('Project ' + (live.project_name || 'named') + ' has a standing policy, but Cursor is not on that policy worker allowlist.')
        : live.intake_blockers?.includes('ENROLLED_REPOSITORY_AMBIGUOUS')
        ? 'Multiple authorized repositories match that request. Choose one enrolled project or repository.'
        : live.intake_blockers?.length
        ? (live.presentation?.status || live.intake_blockers.join(', '))
        : state === 'awaiting_approval'
        ? unboundedProjectless
          ? 'Prepared a task-scoped sandbox. No registered Project was selected. This request has no executable file scope or measurable success criteria; approval alone cannot start it. Provide bounded exact-result files, or name an authorized repository and its exact files. Autopilot and automatic Acceptance do not supply missing scope.'
          : cursorApproval
          ? ((live.blockers || live.intake_blockers || []).some(code => String(code).startsWith('STANDING_CURSOR_GRANT_'))
            ? (live.presentation?.standing_cursor_diagnosis?.reason
              || 'Standing Cursor development grant does not cover this Mission. Enroll or renew via the authenticated local owner API.')
            : 'Cursor requires scoped disclosure and subscription authorization through the authenticated local operator API. Enroll a standing Cursor development grant once, or approve this Mission with a finite subscription_execution grant.')
          : ownerIntake
            ? 'This repository has a standing policy, but MCP intake remains a proposal. Existing standing consent is activated through authenticated owner intake or explicit owner approval; ChatGPT text does not activate it.'
          : 'Airodrom prepared a bounded task. Confirm in the authenticated Terminal with y/N, or Approve this task in Control Center. No file writes or autonomous scheduling occur before that confirmation.'
        : presentation.status,
      presentation,
      blockers,
      requested_specialist: requestedSpecialist || undefined,
      planner: live.planner || 'opencode',
      evaluator: live.evaluator || 'opencode',
      admission: { standard_approval_supported: waiting && !unboundedProjectless && !cursorApproval, authority: false },
      next_action: live.intake_blockers?.includes('CURSOR_PLANNING_REQUIRED') ? 'prepare_planned_cursor_mission'
        : live.intake_blockers || unboundedProjectless ? 'define_bounded_projectless_work'
        : cursorApproval && (live.blockers || live.intake_blockers || []).some(code => String(code).startsWith('STANDING_CURSOR_GRANT_'))
          ? (live.presentation?.standing_cursor_diagnosis?.next_action || 'enroll_standing_cursor_development_via_authenticated_local_api')
        : cursorApproval ? 'authorize_cursor_via_authenticated_local_api'
        : state === 'awaiting_approval' ? 'approve_in_terminal_or_control_center'
        : 'inspect_result',
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

  blockUnplanned(live) {
    // A one-time approval cannot manufacture a sealed OpenCode plan or expand a
    // standing enrollment. Stop before allocating a Mission, grant, or writer.
    const code = 'CURSOR_PLANNING_REQUIRED';
    live.execution_enabled = false;
    live.requested_specialist = 'cursor';
    live.planner = live.evaluator = 'opencode';
    live.intake_blockers = [code];
    live.blocker_message = 'Implementation requires an OpenCode plan sealed by Airodrom for Cursor. Prepare a new request under an enrollment that covers planning and Cursor execution.';
    live.presentation = { ...(live.presentation || {}), worker: 'cursor', status: live.blocker_message,
      completion_policy: 'This proposal authorizes neither execution nor Acceptance.',
      network: 'Cursor execution requires scoped external disclosure authorization' };
    this.write(live.request_id, live.principal, live, 'blocked');
    return this.statusView(this.read(live.request_id));
  }

  activateAutonomy(live) { return this.blockUnplanned(live); }

  startProjectless(request_id, principal, instruction, intent, scope) {
    if (principal !== 'operator' && !/^mcp:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal)) throw Error('Projectless execution requires the authenticated operator');
    if (!scope?.exact_fixture || !scope.workspace) throw Error('Projectless execution requires an exact authorized file change');
    return this.blockUnplanned({ version: 1, request_id, principal, instruction, intent,
      projectless: true, project_id: null, workspace: scope.workspace, authority: false });
  }

  async startBoundedProjectless(live) { return this.blockUnplanned(live); }

  async approve(input, owner = 'operator') {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
    object(input, ['request_id', 'confirmed', 'channel', 'subscription_execution']);
    identifier(input.request_id);
    if (input.confirmed !== true) throw Error('Explicit owner approval required');
    const request_id = input.request_id;
    const live = this.read(request_id);
    if (!live) throw Error('Prepared task unavailable');
    if (['approved', 'running', 'verifying', 'awaiting_acceptance', 'verified'].includes(live.state)) return this.statusView(live);
    if (live.state !== 'awaiting_approval') throw Error('Prepared task is not awaiting approval');
    if (live.cognitive) return await require('./cognitive-router').approve(this, live, { ...input, channel: input.channel || 'terminal' }, owner);
    if (live.projectless && !live.work_spec && this.statusView(live).blockers?.includes('projectless_scope_required'))
      throw Error('Projectless execution requires an exact authorized file change');
    return this.blockUnplanned(live);
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
    if (live.cognitive && live.mission_id) this.bridge.missions.cancel(live.mission_id, { request_id: 'cognitive-cancel:' + input.request_id }, owner);
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
