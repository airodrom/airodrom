'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { matchNamedProjects, preferUniqueProject, instructionMentions } = require('../src/project-resolution');
const sandbox = require('../src/projectless-sandbox');
const intent = require('../src/assistant-intent');
const R = require('../src/cognitive-router');

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', 'base'], { cwd: dir, encoding: 'utf8' });
  return dir;
}

test('No source edits is a denial, not an enrollment target', () => {
  const text = 'In chatgpt-handoff edit recovery-proof.txt. No source edits, merge, install or authority increase.';
  assert.equal(instructionMentions(text, 'Airodrom Source', 'airodrom-source-cursor-dev'), null);
  assert.equal(instructionMentions(text, 'chatgpt-handoff')?.kind, 'full_name');
  assert.equal(instructionMentions('No source edits. Later inspect source.', 'Airodrom Source')?.value, 'source');
  assert.equal(instructionMentions('No chatgpt-handoff work.', 'chatgpt-handoff'), null);
});

test('literal Cursor read and edit verbs and explicit is-role wording preserve specialist identity', () => {
  for (const text of [
    'Cursor reads recovery-proof.txt; OpenCode evaluates READY; dependent Cursor edits recovery-proof.txt.',
    'Cursor READ recovery-proof.txt; OpenCode evaluates READY.',
    'OpenCode is PLANNER and EVALUATOR only. Cursor is the sole IMPLEMENTATION SPECIALIST.',
  ]) {
    assert.equal(R.resolveWorkerRoles(text).specialist, 'cursor');
    assert.throws(() => R.resolveWorkerRoles(text, { cursorDisabled: true }), /CURSOR_EXECUTION_DISABLED/);
  }
  const roles = R.resolveWorkerRoles('OpenCode is PLANNER and EVALUATOR only. Cursor is the sole IMPLEMENTATION SPECIALIST.');
  assert.equal(roles.named_planner, true); assert.equal(roles.named_evaluator, true);
  assert.throws(() => R.resolveWorkerRoles('Cursor reads fixture.txt and OpenCode edits fixture.txt.'), /ambiguous_worker/);
});

test('project resolution matches distinctive tokens and fails closed on ambiguity', () => {
  assert.equal(instructionMentions('Start the Arecibo release-readiness audit in Cursor', 'Arecibo Core')?.value, 'arecibo');
  assert.equal(instructionMentions('Start the Arecibo release-readiness audit in Cursor', 'Arecibo product research')?.value, 'arecibo');
  assert.equal(instructionMentions('Continue ordinary chat', 'Arecibo Core'), null);
  const hits = matchNamedProjects('Start the Arecibo release-readiness audit using Cursor', [
    { name: 'Arecibo Core', repositories: ['/tmp/a'] },
    { name: 'Arecibo product research', repositories: ['/tmp/b'] },
    { name: 'Gateway release acceptance', repositories: ['/tmp/c'] },
  ]);
  assert.equal(hits.length, 2);
  const ambiguous = preferUniqueProject(hits);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.clarify, true);
  const unique = preferUniqueProject(matchNamedProjects('Continue Arecibo Core in Cursor', [
    { name: 'Arecibo Core', repositories: ['/tmp/a'] },
    { name: 'Arecibo product research', repositories: ['/tmp/b'] },
  ]));
  assert.equal(unique.ok, true);
  assert.equal(unique.project.name, 'Arecibo Core');
  const nested = preferUniqueProject(matchNamedProjects(
    'In the Self-Repair Scope Fixture project, change fixture.txt from alpha to beta.',
    [
      { name: 'Self-Repair Scope Fixture', repositories: ['/tmp/a'] },
      { name: 'Fixture project', repositories: ['/tmp/b'] },
    ],
  ));
  assert.equal(nested.ok, true);
  assert.equal(nested.project.name, 'Self-Repair Scope Fixture');
});

test('explicit Cursor destination phrases are recognized without the two-file grammar', () => {
  assert.equal(sandbox.explicitlyRequestsCursor('Start the Arecibo audit in Cursor'), true);
  assert.equal(sandbox.explicitlyRequestsCursor('Continue Arecibo using Cursor'), true);
  assert.equal(sandbox.explicitlyRequestsCursor('Maybe talk about Cursor later'), false);
  assert.equal(sandbox.parseNaturalWorkSpec('Start the Arecibo release-readiness audit in Cursor'), null);
  assert.equal(R.requestedWorker('Start the Arecibo release-readiness audit in Cursor'), 'cursor');
  assert.equal(
    R.requestedWorker('Start the Arecibo release-readiness audit in Cursor. Use OpenCode for planning and evaluation. Do not deploy production.'),
    'cursor'
  );
  assert.equal(intent.isWorkRequest('Start the Arecibo release-readiness audit in Cursor'), true);
  assert.equal(intent.isWorkRequest('How does Cursor routing work in Airodrom?'), false);
});

test('Do not deploy denials do not divert enrolled Cursor work into research clarify', () => {
  const browser = require('../src/browser-research');
  const message = 'Start the Arecibo Core release-readiness audit in Cursor. Inspect current main and rollback readiness. Do not deploy production.';
  assert.equal(browser.parse(message), null);
  const parsed = intent.parse(message);
  assert.equal(parsed.kind, 'work');
  assert.match(parsed.objective || message, /Arecibo Core/i);
});

test('enrolled Arecibo Cursor request never returns projectless two-file syntax', async t => {
  const f = await fixture(t);
  const research = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'arecibo-research-')));
  const core = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'arecibo-core-')));
  t.after(() => {
    fs.rmSync(research, { recursive: true, force: true });
    fs.rmSync(core, { recursive: true, force: true });
  });
  f.bridge.projects.createProject({ name: 'Arecibo product research', repositories: [research], privacyPolicy: 'local_only' });
  f.bridge.projects.createProject({ name: 'Arecibo Core', repositories: [core], privacyPolicy: 'local_only' });

  const ambiguous = await f.bridge.zeroSetupWork.ask({
    instruction: 'Start the Arecibo release-readiness audit in Cursor. Inspect main against production and prepare a reviewed evidence report. Do not deploy production.',
    request_id: randomUUID(),
  }, 'mcp:' + randomUUID());
  assert.equal(ambiguous.state, 'CLARIFY');
  assert.ok(!ambiguous.blockers?.includes('projectless_exact_two_file_syntax_required'));
  assert.ok(!String(ambiguous.message || '').includes('exactly two files'));
  assert.equal(ambiguous.code, 'ENROLLED_REPOSITORY_AMBIGUOUS');
  assert.ok((ambiguous.choices || []).length >= 2);

  const unique = await f.bridge.zeroSetupWork.ask({
    instruction: 'Start the Arecibo Core release-readiness audit using Cursor. Do not deploy production.',
    request_id: randomUUID(),
  }, 'mcp:' + randomUUID());
  // A registered project is not authoritative source enrollment.
  assert.equal(unique.state, 'BLOCKED');
  assert.ok(!unique.blockers?.includes('projectless_exact_two_file_syntax_required'));
  assert.deepEqual(unique.blockers, ['ARECIBO_REPOSITORY_NOT_ENROLLED']);
  assert.equal(unique.mission_id, null);
  assert.equal(unique.execution_authorized, false);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_runs').get().n, 0);
});

test('projectless Cursor prose still requires the exact two-file contract', async t => {
  const f = await fixture(t);
  const held = await f.bridge.zeroSetupWork.ask({
    instruction: 'Use Cursor in a projectless task sandbox. Change fixture.txt from alpha to beta.',
    request_id: randomUUID(),
  }, 'mcp:' + randomUUID());
  assert.equal(held.state, 'CLARIFY');
  assert.deepEqual(held.blockers, ['projectless_exact_two_file_syntax_required']);
});

test('missing enrollment fails closed without inventing authority', async t => {
  const f = await fixture(t);
  const repo = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'solo-enrolled-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  f.bridge.projects.createProject({ name: 'Solo Product', repositories: [repo], privacyPolicy: 'local_only' });
  const result = await f.bridge.zeroSetupWork.ask({
    instruction: 'Continue the Solo Product development task in Cursor.',
    request_id: randomUUID(),
  }, 'mcp:' + randomUUID());
  assert.equal(result.code, 'ENROLLED_WORKSPACE_REQUIRED');
  assert.equal(result.execution_authorized, false);
  assert.equal(result.authority, false);
});

test('unauthorized absolute path still fails closed', async t => {
  const f = await fixture(t);
  const repo = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'allowed-enrolled-')));
  const outsider = gitInit(fs.mkdtempSync(path.join(os.tmpdir(), 'outsider-enrolled-')));
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outsider, { recursive: true, force: true });
  });
  f.bridge.projects.createProject({ name: 'Allowed Product', repositories: [repo], privacyPolicy: 'local_only' });
  const result = await f.bridge.zeroSetupWork.ask({
    instruction: 'Use Cursor to inspect ' + outsider,
    request_id: randomUUID(),
  }, 'mcp:' + randomUUID());
  assert.equal(result.state, 'CLARIFY');
  assert.match(result.message, /not authorized/i);
  assert.ok(!result.blockers?.includes('projectless_exact_two_file_syntax_required'));
});


test('explicit absolute path and alias beat Source prose; trailing punctuation does not projectless-fallback', () => {
  const { resolveEnrolledScope, detectAuthoritativeTargets, extractAbsolutePaths, normalizeAbsolutePathCandidate } = require('../src/project-resolution');
  const canary = '/Users/fixture/Documents/Codex/2026-10-25/airodrom-four-stage-self-repair';
  const source = '/Users/fixture/code/airodrom-da-main';
  // Realpath unavailable for synthetic paths — exercise selector precedence with pre-normalized repos.
  const projects = [
    { projectId: 'src', name: 'Airodrom Source', repositories: [source], status: 'active' },
    { projectId: 'can', name: 'Four-stage self-repair canary', repositories: [canary], status: 'active' },
  ];
  const policies = [
    {
      policy_id: 'p-src', alias: 'airodrom-source-cursor-dev', state: 'active', expires_at: Date.now() + 86400000,
      repository: source, project_id: 'src', cognitive: { files: ['README.md', 'CHANGELOG.md', 'docs/ARCHITECTURE.md', 'docs/CURRENT-STATE.md', 'AGENTS.md'] },
    },
    {
      policy_id: 'p-can', alias: 'four-stage-self-repair-773b14d', state: 'active', expires_at: Date.now() + 86400000,
      repository: canary, project_id: 'can', cognitive: { files: ['fixture.txt'] },
    },
  ];
  // Stub realpath for these synthetic roots.
  const realpath = fs.realpathSync;
  fs.realpathSync = (p) => {
    const s = String(p);
    if (s.startsWith(canary) || s.startsWith(source)) return s.replace(/[.,;:)\]]+$/g, '');
    return realpath(p);
  };
  try {
    assert.deepEqual(detectAuthoritativeTargets(
      'Work in /Users/fixture/Documents/Codex/2026-10-25/airodrom-four-stage-self-repair on fixture.txt'
    ), []);
    assert.equal(
      normalizeAbsolutePathCandidate(canary + ','),
      canary
    );
    assert.deepEqual(
      extractAbsolutePaths('at\n' + canary + ',\nusing policy'),
      [canary]
    );

    const byPath = resolveEnrolledScope(
      'In the disposable four-stage self-repair repository at\n' + canary + ',\n'
      + 'using enrolled policy four-stage-self-repair-773b14d. Also check airodrom missions status.',
      { projects, policies, activeRepositories: new Set([canary, source]) }
    );
    assert.equal(byPath.ok, true);
    assert.equal(byPath.projectless, false);
    assert.equal(byPath.selector_kind, 'absolute_path');
    assert.equal(byPath.policy.alias, 'four-stage-self-repair-773b14d');

    const byAlias = resolveEnrolledScope(
      'Using enrolled policy four-stage-self-repair-773b14d, change fixture.txt. Check airodrom missions afterward.',
      { projects, policies, activeRepositories: new Set([canary, source]) }
    );
    assert.equal(byAlias.ok, true);
    assert.equal(byAlias.selector_kind, 'policy_alias');
    assert.equal(byAlias.policy.alias, 'four-stage-self-repair-773b14d');

    // Authoritative Source prose without an explicit enrolled selector still resolves Source.
    const byAuth = resolveEnrolledScope(
      'Fix airodrom notifications in the Airodrom Source project.',
      { projects, policies, activeRepositories: new Set([canary, source]) }
    );
    assert.equal(byAuth.ok, true);
    assert.equal(byAuth.policy.alias, 'airodrom-source-cursor-dev');

    // Policy belonging to another project must not bind via incidental basename.
    const otherRepo = '/Users/fixture/Documents/Codex/2026-10-25/other-four-stage';
    const twinPolicies = policies.concat([{
      policy_id: 'p-twin', alias: 'other-four-stage', state: 'active', expires_at: Date.now() + 86400000,
      repository: otherRepo, project_id: 'other', cognitive: { files: ['fixture.txt'] },
    }]);
    const twinProjects = projects.concat([
      { projectId: 'other', name: 'Other four-stage', repositories: [otherRepo], status: 'active' },
    ]);
    const prev = fs.realpathSync;
    fs.realpathSync = (p) => {
      const s = String(p);
      if (s.startsWith(canary) || s.startsWith(source) || s.startsWith(otherRepo)) return s.replace(/[.,;:)\]]+$/g, '');
      return prev(p);
    };
    try {
      const mismatch = resolveEnrolledScope(
        'In ' + canary + ' using enrolled policy other-four-stage, edit fixture.txt.',
        { projects: twinProjects, policies: twinPolicies, activeRepositories: new Set([canary, source, otherRepo]) }
      );
      // Path and foreign policy alias conflict — fail closed, never substitute.
      assert.equal(mismatch.ok, false);
      assert.equal(mismatch.projectless, false);
      assert.equal(mismatch.code, 'ENROLLED_POLICY_MISMATCH');

      const unknown = resolveEnrolledScope(
        'Work in /Users/fixture/Documents/Codex/2026-10-25/never-enrolled-repo on fixture.txt',
        { projects, policies, activeRepositories: new Set([canary, source]) }
      );
      assert.equal(unknown.ok, false);
      assert.equal(unknown.projectless, false);
      assert.equal(unknown.code, 'ENROLLED_WORKSPACE_REQUIRED');

      const negated = resolveEnrolledScope(
        'Do not use Four-stage self-repair canary. Using enrolled policy four-stage-self-repair-773b14d edit fixture.txt.',
        { projects, policies, activeRepositories: new Set([canary, source]) }
      );
      // Exact alias still binds; negation of the project name must not invent Source.
      assert.equal(negated.ok, true);
      assert.equal(negated.policy.alias, 'four-stage-self-repair-773b14d');
    } finally {
      fs.realpathSync = prev;
    }
  } finally {
    fs.realpathSync = realpath;
  }
});

test('MCP ask with comma-suffixed enrolled path never returns projectless two-file syntax', async t => {
  const f = await fixture(t);
  const { qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  f.bridge.hostExecutionPolicy.enableCursor({ confirmed: true, request_id: randomUUID() }, 'operator');
  f.bridge.cursorWorker = new (require('../src/cursor-worker').CursorWorker)(f.bridge, {
    fixtureExecutable: path.join(__dirname, 'fixtures/cursor-agent-fixture.cjs'),
  });
  const project = f.bridge.projects.listProjects({ status: 'active' })[0];
  const goal = f.bridge.projects.summary(project.projectId).goals[0];
  f.bridge.developerAutonomy.enroll({
    alias: 'four-stage-self-repair-773b14d', repository: f.repo, project_id: project.projectId,
    goal_id: goal.goalId, workflows: ['routine_edit', 'test', 'repair'], workers: ['opencode', 'cursor'],
    duration_days: 1, confirmed: true, diff_check: 'diff-check', default_tests: ['fixture-test'],
    budgets: { max_repairs: 1 },
    cognitive: {
      version: 3, files: ['fixture.txt'], delegated_callers: [], planning_attempts: 2,
      planning_ms: 120000, execution_ms: 120000, repair_attempts: 1, max_assignments: 4, acceptance: 'automatic',
    },
  }, 'operator');
  f.bridge.hostExecutionPolicy.enrollStandingCursorDevelopment({
    request_id: randomUUID(), confirmed: true, repository: f.repo,
    policy_id: f.bridge.developerAutonomy.list('operator').find(p => p.alias === 'four-stage-self-repair-773b14d').policy_id,
    acknowledge_unknown_cost: true, max_invocations_per_mission: 6, max_runtime_ms: 120000,
    max_missions: 5, path_allowlist: ['fixture.txt'],
  }, 'operator');

  const instruction = [
    'In the disposable four-stage self-repair repository at',
    f.repo + ',',
    'using enrolled policy four-stage-self-repair-773b14d:',
    '1. Read fixture.txt.',
    '2. Independently analyze fixture.txt.',
    '3. Change fixture.txt to exactly beta with a trailing newline using Cursor.',
    '4. Read fixture.txt again after correction.',
    'Also check airodrom missions status while you work.',
  ].join('\n');

  for (const entry of ['ask_airodrom', 'prepare_mission']) {
    const view = await f.bridge.zeroSetupWork.ask({ instruction, request_id: randomUUID() }, 'mcp:' + randomUUID());
    assert.notEqual(view.state, 'CLARIFY', entry + ' state=' + view.state + ' blockers=' + JSON.stringify(view.blockers));
    assert.ok(!view.blockers?.includes('projectless_exact_two_file_syntax_required'), entry + ' ' + JSON.stringify(view.blockers));
    assert.ok(!view.blockers?.includes('requested_file_not_enrolled'), entry);
    assert.ok(view.mission_id || ['PLANNING', 'WAIT', 'BLOCKED', 'SEALED', 'DISPATCHED', 'RUNNING', 'AWAITING_ACCEPTANCE', 'ACCEPTED'].includes(view.state),
      entry + ' unresolved view=' + JSON.stringify({ state: view.state, blockers: view.blockers, code: view.code }));
    const files = view.presentation?.files || view.files || [];
    if (files.length) assert.deepEqual(files, ['fixture.txt']);
  }

  const matches = R.policyFor(f.bridge, instruction);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].alias, 'four-stage-self-repair-773b14d');
});
