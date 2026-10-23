'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/requested-file-scope');
const R = require('../src/cognitive-router');
const C = require('../src/cognitive-contracts');
const requested = 'recovery-proof.txt';
const scope = () => S.extract('Cursor read recovery-proof.txt, then Cursor edit recovery-proof.txt to the required bytes.');
function proposal(paths = [requested]) { return { files: paths, tasks: [
  { id: 'read', operation: 'read', paths, depends_on: [] },
  { id: 'edit', operation: 'edit', paths, depends_on: ['read'] }
] }; }
function mission() { return { envelope: { cognitive: { envelope: { requested_scope: scope() }, proposal: proposal() },
  allowed_files: [requested], baseline: { files: { [requested]: 'before', 'AGENTS.md': 'original' } } } }; }
test('explicit recovery-proof path is preserved as literal read and edit constraints', () => {
  assert.deepEqual(scope(), { version: 1, bindings: [{ operation: 'read', path: requested }, { operation: 'edit', path: requested }] });
  assert.equal(S.normalize('./docs/proof.txt'), 'docs/proof.txt');
  assert.equal(S.normalize('Proof.txt'), 'Proof.txt');
  for (const p of ['../proof.txt', 'docs/../proof.txt', '/proof.txt', 'x//proof.txt', 'x\\proof.txt', 'x/./proof.txt', '.git/config']) assert.throws(() => S.normalize(p));
});
test('planner substitution to AGENTS.md is rejected even when enrolled', () => {
  S.assertEnrollment(scope(), [requested, 'AGENTS.md']);
  assert.throws(() => S.assertProposal(scope(), proposal(['AGENTS.md'])), /requested_file_plan_mismatch/);
});
test('valid enrolled exact files are admitted without aliases', () => {
  S.assertEnrollment(scope(), [requested]); S.assertProposal(scope(), proposal());
  assert.throws(() => S.assertEnrollment(scope(), ['other/recovery-proof.txt']), /not_enrolled/);
});
test('unauthorized requested files fail closed before planning', () => {
  assert.throws(() => S.assertEnrollment(scope(), ['AGENTS.md']), /requested_file_not_enrolled/);
});
test('creation cannot borrow the existing-file read or edit contract', () => {
  const creation = S.extract('Create "new.txt"');
  assert.throws(() => S.assertEnrollment(creation, ['new.txt']), /creation_not_authorized/);
});
test('dependent tasks retain their respective operation and path constraints', () => {
  const s = S.extract('read input.txt then edit output.txt');
  const p = { files: ['input.txt', 'output.txt'], tasks: [{ id: 'r', operation: 'read', paths: ['input.txt'], depends_on: [] }, { id: 'w', operation: 'edit', paths: ['output.txt'], depends_on: ['r'] }] };
  S.assertProposal(s, p);
  p.tasks[1].paths = ['input.txt']; assert.throws(() => S.assertProposal(s, p), /plan_mismatch/);
});
test('READY evaluator prose cannot override host snapshot scope', () => {
  const m = mission(); m.envelope.evaluation = { recommendation: 'ready', summary: 'Correct file changed' };
  const v = S.verification(m, { files: { [requested]: 'before', 'AGENTS.md': 'changed' } });
  assert.equal(v.status, 'failed'); assert.deepEqual(v.evidence.unexpected_changes, ['AGENTS.md']);
});
test('successful worker prose cannot replace independent exact-path verification', () => {
  const m = mission(); m.result = { status: 'completed', changed_files: [requested] };
  const v = S.verification(m, { files: m.envelope.baseline.files });
  assert.equal(v.status, 'failed'); assert.deepEqual(v.evidence.missing_changes, [requested]);
});
test('automatic acceptance scope gate rejects executed changes on a substitute', () => {
  assert.equal(S.verification(mission(), { files: { [requested]: 'after', 'AGENTS.md': 'changed' } }).status, 'failed');
  const v = S.verification(mission(), { files: { [requested]: 'after', 'AGENTS.md': 'original' } });
  assert.equal(v.status, 'passed'); assert.deepEqual(v.evidence.executed_changes, [requested]);
});
test('repair and retry cannot widen or substitute original request constraints', () => {
  const c = mission().envelope.cognitive; c.proposal = proposal(['AGENTS.md']);
  assert.throws(() => S.assertOriginal(c, 'read recovery-proof.txt then edit recovery-proof.txt'), /plan_mismatch/);
  c.envelope.requested_scope = S.extract('edit AGENTS.md');
  assert.throws(() => S.assertOriginal(c, 'read recovery-proof.txt then edit recovery-proof.txt'), /constraint_changed/);
});
test('legitimate unconstrained Missions and old evidence retain their representation', () => {
  const c = { envelope: {}, proposal: proposal(['fixture.txt']) }; const old = JSON.stringify(c);
  S.assertOriginal(c, 'Perform the enrolled routine work');
  assert.equal(S.verification({ envelope: { cognitive: c } }, {}), null);
  assert.equal(JSON.stringify(c), old);
});
test('negated source mention cannot use a success marker to select the source repository', () => {
  const P = require('../src/project-resolution');
  assert.deepEqual(P.detectAuthoritativeTargets('Use chatgpt-handoff to edit recovery-proof.txt to AIRODROM-CHATGPT-HANDOFF-PASS. Do not edit Airodrom source.'), []);
  assert.equal(P.detectAuthoritativeTargets('Fix Airodrom source. Do not edit Arecibo.')[0].id, 'airodrom');
});
test('read task changes fail even when the later edit authorizes that same path', () => {
  const m = mission();
  const v = S.verification(m, { files: { [requested]: 'after', 'AGENTS.md': 'original' } }, { id: 'read', operation: 'read', paths: [requested] }, m.envelope.baseline);
  assert.equal(v.status, 'failed');
});
test('report coercion cannot replace explicitly requested read paths with a preferred deliverable', () => {
  const s = S.extract('Read recovery-proof.txt for a readiness report');
  const p = { files: [requested], tasks: [{ operation: 'read', paths: [requested] }] };
  assert.equal(R.coerceAutopilotDeliverable(p, { requested_scope: s, operations: ['read', 'edit'], permitted_paths: ['README.md', requested] }, 'readiness report'), p);
});

test('explicit lists retain every path and unsupported filename prose requires clarification', () => {
  assert.deepEqual(S.files(S.extract('Edit first.txt, second.txt and `third.txt`')), ['first.txt', 'second.txt', 'third.txt']);
  assert.throws(() => S.extract('The requested file is recovery-proof.txt'), /operation_required/);
  assert.deepEqual(S.files(S.extract('Edit fixture.txt. Do not edit AGENTS.md.')), ['fixture.txt']);
});
test('dependent read must precede the requested edit', () => {
  const p = proposal(); p.tasks[1].depends_on = [];
  assert.throws(() => S.assertProposal(scope(), p), /dependency_mismatch/);
});

test('implicit mutation target cannot weaken an explicit read constraint', () => {
  assert.throws(() => S.extract('Read fixture.txt then change alpha to beta.'), /operation_required/);
  assert.throws(() => S.extract('The requested file is recovery-proof.txt.'), /operation_required/);
});

test('extensionless file requests cannot silently fall back to enrollment defaults', () => {
  assert.throws(() => S.extract('Read LICENSE'), /operation_required/);
  assert.deepEqual(S.files(S.extract('Read file LICENSE')), ['LICENSE']);
  assert.deepEqual(S.files(S.extract('Read `LICENSE`')), ['LICENSE']);
});
test('deletion cannot satisfy an existing-file edit request', () => {
  const v = S.verification(mission(), { files: { 'AGENTS.md': 'original' } });
  assert.equal(v.status, 'failed'); assert.deepEqual(v.evidence.missing_changes, [requested]);
});
