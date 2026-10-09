'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { inMergeWindow, loadPolicy, selectFocusedTests } = require('../src/development-session');

test('policy defaults refuse auto push, merge and hosted CI dispatch', async t => {
  const policy = loadPolicy(path.resolve(__dirname, '..'));
  assert.equal(policy.hosted_ci_auto_dispatch, false);
  assert.equal(policy.auto_push_per_mission, false);
  assert.equal(policy.auto_merge_per_mission, false);
  const f = await fixture(t);
  assert.equal(f.bridge.developmentSessions.assertNoAutoDispatch('hosted_ci').allowed, false);
  assert.equal(f.bridge.developmentSessions.assertNoAutoDispatch('push').allowed, false);
});

test('smart local test selection and mandatory security when relevant', () => {
  const base = selectFocusedTests(['src/development-session.js', 'public/control-hub.js']);
  assert.ok(base.tests.includes('tests/development-session-v1.test.js'));
  assert.ok(base.tests.includes('tests/control-server.test.js'));
  assert.equal(base.hosted_ci, false);
  const secure = selectFocusedTests(['src/secret-vault.js', 'src/risk-acceptance.js']);
  assert.equal(secure.mandatory_security, true);
  assert.ok(secure.tests.includes('tests/secret-diagnostic-boundaries.test.js'));
  assert.ok(secure.tests.includes('tests/authority-plane.test.js'));
});

test('related Mission reuses session and worktree without new PR', async t => {
  const f = await fixture(t);
  const sessions = f.bridge.developmentSessions;
  const first = sessions.resolve({
    goal: 'Session reuse fixture',
    repository: 'airodrom/airodrom',
    branch: 'feat/local-first-batch-merge-v1',
    worktree: '/tmp/airodrom-session-reuse',
    confirmed: true,
    mission_id: f.create().id,
    assigned_worker: 'opencode'
  }, 'operator');
  assert.equal(first.reused, false);
  assert.equal(first.new_pr, false);
  assert.equal(first.assigned_worker, 'opencode');
  assert.equal(first.integration_state, 'LOCAL_ONLY');

  const secondMission = f.create({ objective: 'Related follow-up Mission' });
  const second = sessions.resolve({
    goal: 'Session reuse fixture',
    repository: 'airodrom/airodrom',
    branch: 'feat/local-first-batch-merge-v1',
    worktree: '/tmp/airodrom-session-reuse',
    confirmed: true,
    mission_id: secondMission.id
  }, 'operator');
  assert.equal(second.reused, true);
  assert.equal(second.id, first.id);
  assert.equal(second.mission_count, 2);
  assert.equal(second.new_pr, false);
  assert.throws(() => sessions.resolve({
    goal: 'Wrong tree',
    repository: 'airodrom/airodrom',
    branch: 'feat/local-first-batch-merge-v1',
    worktree: '/tmp/other-worktree',
    confirmed: true,
    mission_id: f.create({ objective: 'Isolation mismatch Mission' }).id
  }, 'operator'), /mismatch|already exists|Isolation|worktree/i);
});

test('dirty-work protection and restart recovery never reset worktrees', async t => {
  const f = await fixture(t);
  const sessions = f.bridge.developmentSessions;
  const s = sessions.create({
    goal: 'Dirty protection',
    repository: 'airodrom/airodrom',
    branch: 'feat/dirty-protect',
    worktree: '/tmp/airodrom-dirty',
    confirmed: true
  }, 'operator');
  assert.throws(() => sessions.observeGit({
    session_id: s.id,
    dirty_files: ['src/x.js'],
    confirmed: true,
    reset: true
  }, 'operator'), /reset is forbidden/);
  const observed = sessions.observeGit({
    session_id: s.id,
    dirty_files: ['src/development-session.js'],
    confirmed: true
  }, 'operator');
  assert.deepEqual(observed.dirty_files, ['src/development-session.js']);
  const recovery = sessions.recover();
  assert.equal(recovery.reset_worktrees, false);
  assert.equal(sessions.inspect(s.id).dirty_files.length, 1);
});

test('local commits invalidate stale evidence; exact-commit cache reuses', async t => {
  const f = await fixture(t);
  const sessions = f.bridge.developmentSessions;
  const s = sessions.create({
    goal: 'Evidence cache',
    repository: 'airodrom/airodrom',
    branch: 'feat/evidence-cache',
    worktree: '/tmp/airodrom-evidence',
    confirmed: true
  }, 'operator');
  const sha1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  sessions.recordCommit({ session_id: s.id, sha: sha1, subject: 'local one', confirmed: true }, 'operator');
  sessions.recordEvidence({
    session_id: s.id,
    kind: 'focused_test',
    command: 'node --test tests/development-session-v1.test.js',
    passed: true,
    summary: 'Focused suite passed',
    confirmed: true,
    commit_sha: sha1
  }, 'operator');
  assert.equal(sessions.inspect(s.id).integration_state, 'READY_TO_PUSH');
  const cached = sessions.selectTests({
    session_id: s.id,
    changed_paths: ['src/development-session.js'],
    confirmed: true,
    commit_sha: sha1
  }, 'operator');
  assert.equal(cached.cached, true);
  const sha2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  sessions.recordCommit({ session_id: s.id, sha: sha2, subject: 'local two', confirmed: true }, 'operator');
  const stale = sessions.checkpoint({ session_id: s.id, confirmed: true }, 'operator');
  assert.ok(stale.checkpoint.blockers.includes('stale_evidence_after_commit') || stale.checkpoint.blockers.includes('not_published'));
  const freshSelect = sessions.selectTests({
    session_id: s.id,
    changed_paths: ['src/development-session.js'],
    confirmed: true,
    commit_sha: sha2
  }, 'operator');
  assert.equal(freshSelect.cached, false);
});

test('batch integration gating and merge window without auto-merge', async t => {
  const f = await fixture(t);
  const sessions = f.bridge.developmentSessions;
  const s = sessions.create({
    goal: 'Batch gate',
    repository: 'airodrom/airodrom',
    branch: 'feat/batch-gate',
    worktree: '/tmp/airodrom-batch',
    confirmed: true
  }, 'operator');
  const sha = 'cccccccccccccccccccccccccccccccccccccccc';
  sessions.recordCommit({ session_id: s.id, sha, subject: 'batch', confirmed: true }, 'operator');
  sessions.recordEvidence({
    session_id: s.id, kind: 'focused_test', command: 'node --test tests/development-session-v1.test.js',
    passed: true, summary: 'Focused suite passed', confirmed: true, commit_sha: sha
  }, 'operator');
  sessions.markPublished({
    session_id: s.id, confirmed: true, head_sha: sha, pr_number: 101, github_ci_status: 'passed'
  }, 'operator');
  assert.equal(sessions.inspect(s.id).integration_state, 'PR_OPEN');
  sessions.now = () => Date.parse('2026-10-09T18:00:00-07:00');
  const ready = sessions.checkpoint({ session_id: s.id, confirmed: true }, 'operator');
  assert.equal(ready.checkpoint.ready_pending_authorization, true);
  assert.equal(ready.integration_state, 'READY_TO_MERGE');
  assert.equal(ready.checkpoint.auto_merge, false);
  assert.ok(inMergeWindow(loadPolicy(path.resolve(__dirname, '..')), Date.parse('2026-10-09T18:00:00-07:00')));
});

test('candidate workflow gates feature-branch push spend', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/candidate.yml'), 'utf8');
  assert.match(text, /push:\n {4}branches: \[main\]/);
  assert.match(text, /pull_request:\n {4}branches: \[main\]/);
  assert.doesNotMatch(text, /schedule:/);
  assert.match(text, /secret-history:/);
});

test('branch isolation refuses conflicting worktree reuse', async t => {
  const f = await fixture(t);
  const sessions = f.bridge.developmentSessions;
  sessions.create({
    goal: 'Isolation A',
    repository: 'airodrom/airodrom',
    branch: 'feat/iso',
    worktree: '/tmp/iso-a',
    confirmed: true
  }, 'operator');
  assert.throws(() => sessions.create({
    goal: 'Isolation B',
    repository: 'airodrom/airodrom',
    branch: 'feat/iso',
    worktree: '/tmp/iso-a',
    confirmed: true
  }, 'operator'), /already exists/);
});
