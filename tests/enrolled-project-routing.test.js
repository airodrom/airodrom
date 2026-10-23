'use strict';
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
