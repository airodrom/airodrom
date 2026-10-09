'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { inMergeWindow, loadPolicy } = require('../src/development-session');

test('policy defaults refuse auto push, merge and hosted CI dispatch', async t => {
  const policy = loadPolicy(path.resolve(__dirname, '..'));
  assert.equal(policy.hosted_ci_auto_dispatch, false);
  assert.equal(policy.heavy_ci_auto_dispatch, false);
  assert.equal(policy.auto_push_per_mission, false);
  assert.equal(policy.auto_merge_per_mission, false);
  const f = await fixture(t);
  assert.deepEqual(f.bridge.developmentSessions.assertNoAutoDispatch('push'), { allowed: false, reason: 'operator_checkpoint_required', action: 'push' });
  assert.equal(f.bridge.developmentSessions.assertNoAutoDispatch('merge').allowed, false);
  assert.equal(f.bridge.developmentSessions.assertNoAutoDispatch('hosted_ci').allowed, false);
  assert.equal(f.bridge.developmentSessions.assertNoAutoDispatch('heavy_ci').allowed, false);
});

test('merge window uses configured local timezone without auto-merge', () => {
  const policy = {
    hosted_ci_auto_dispatch: false,
    heavy_ci_auto_dispatch: false,
    auto_push_per_mission: false,
    auto_merge_per_mission: false,
    merge_window: { timezone: 'America/Vancouver', local_start: '17:00', local_end: '22:00' }
  };
  assert.equal(inMergeWindow(policy, Date.parse('2026-10-09T18:30:00-07:00')), true);
  assert.equal(inMergeWindow(policy, Date.parse('2026-10-09T12:00:00-07:00')), false);
});

test('session lifecycle: create, attach, evidence, publish, checkpoint auth blocker', async t => {
  const f = await fixture(t);
  const sessions = f.bridge.developmentSessions;
  const created = sessions.create({
    goal: 'Local-first fixture batch',
    repository: 'airodrom/airodrom',
    branch: 'feat/local-first-batch-merge-v1',
    worktree: '/tmp/airodrom-local-first-fixture',
    confirmed: true,
    capabilities: ['local_edit', 'focused_test'],
    workers: ['opencode']
  }, 'operator');
  assert.equal(created.local_only, true);
  assert.equal(created.published, false);
  assert.equal(created.cost_controls.auto_merge_per_mission, false);

  const m = f.create();
  const attached = sessions.attach({ session_id: created.id, mission_id: m.id, confirmed: true }, 'operator');
  assert.equal(attached.mission_count, 1);
  assert.throws(() => sessions.attach({ session_id: created.id, mission_id: m.id, confirmed: true }, 'mcp'), /operator/);

  assert.throws(() => sessions.recordEvidence({
    session_id: created.id,
    kind: 'focused_test',
    command: 'node --test tests/x.js',
    passed: true,
    summary: 'worker completion claimed pass',
    confirmed: true
  }, 'operator'), /Worker completion/);

  const evidence = sessions.recordEvidence({
    session_id: created.id,
    kind: 'focused_test',
    command: 'NODE_ENV=test node scripts/run.cjs --test tests/development-session-v1.test.js',
    passed: true,
    summary: 'Focused development-session suite passed',
    confirmed: true
  }, 'operator');
  assert.equal(evidence.evidence.passed, 1);

  sessions.markPublished({
    session_id: created.id,
    confirmed: true,
    head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pr_number: 99,
    github_ci_status: 'passed'
  }, 'operator');

  sessions.now = () => Date.parse('2026-10-09T18:00:00-07:00');
  const checkpoint = sessions.checkpoint({ session_id: created.id, confirmed: true }, 'operator');
  assert.equal(checkpoint.checkpoint.merge_window_open, true);
  assert.equal(checkpoint.checkpoint.ready_pending_authorization, true);
  assert.ok(checkpoint.checkpoint.blockers.includes('operator_merge_authorization_required'));
  assert.equal(checkpoint.checkpoint.auto_merge, false);

  sessions.now = () => Date.parse('2026-10-09T10:00:00-07:00');
  const outside = sessions.checkpoint({ session_id: created.id, confirmed: true }, 'operator');
  assert.equal(outside.checkpoint.merge_window_open, false);
  assert.ok(outside.checkpoint.blockers.includes('outside_merge_window'));
});

test('duplicate dispatch prevention and high-risk capabilities refused', async t => {
  const f = await fixture(t);
  const sessions = f.bridge.developmentSessions;
  assert.throws(() => sessions.create({
    goal: 'Bad caps',
    repository: 'airodrom/airodrom',
    branch: 'feat/x',
    worktree: '/tmp/x',
    confirmed: true,
    capabilities: ['auto_push']
  }, 'operator'), /not session capabilities/);
  assert.throws(() => sessions.create({
    goal: 'Bad caps',
    repository: 'airodrom/airodrom',
    branch: 'feat/x',
    worktree: '/tmp/x',
    confirmed: true,
    capabilities: ['hosted_ci_dispatch']
  }, 'operator'), /not session capabilities/);
});

test('candidate workflow gates feature-branch push spend', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/candidate.yml'), 'utf8');
  assert.match(text, /push:\n {4}branches: \[main\]/);
  assert.match(text, /pull_request:\n {4}branches: \[main\]/);
  assert.match(text, /workflow_dispatch:/);
  assert.doesNotMatch(text, /schedule:/);
  assert.match(text, /secret-history:/);
  assert.match(text, /dependency-license:/);
  assert.match(text, /inputs:\n {6}heavy:/);
});

test('worktree isolation: session records absolute worktree path without touching operator checkout', async t => {
  const f = await fixture(t);
  const wt = '/Users/andrew/Documents/Codex/2026-10-09/airodrom-local-first-batch-v1/work/airodrom-local-first';
  const s = f.bridge.developmentSessions.create({
    goal: 'Isolated worktree session',
    repository: 'airodrom/airodrom',
    branch: 'feat/local-first-batch-merge-v1',
    worktree: wt,
    confirmed: true
  }, 'operator');
  assert.equal(s.worktree, wt);
  assert.notEqual(s.worktree, '/Users/andrew/code/airodrom');
});
