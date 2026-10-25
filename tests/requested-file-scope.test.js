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
  assert.deepEqual(scope(), {
    version: 1,
    bindings: [{ operation: 'read', path: requested }, { operation: 'edit', path: requested }],
    stages: [{ operation: 'read', path: requested }, { operation: 'edit', path: requested }],
  });
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

test('read and edit inflections retain the same literal scope and dependency', () => {
  const s = S.extract('Cursor reads recovery-proof.txt; then Cursor edits recovery-proof.txt.');
  assert.deepEqual(s, scope()); S.assertProposal(s, proposal());
  assert.throws(() => S.extract('Cursor reads recovery-proof.txt then edits something.'), /operation_required/);
});

test('explicit substitution rejection does not enroll the rejected file', () => {
  const text = 'Cursor READ recovery-proof.txt; then Cursor EDIT recovery-proof.txt. Target file is recovery-proof.txt; AGENTS.md substitution must be rejected.';
  const s = S.extract(text); assert.deepEqual(s, scope());
  S.assertEnrollment(s, [requested]);
  assert.throws(() => S.assertProposal(s, proposal(['AGENTS.md'])), /plan_mismatch/);
  assert.throws(() => S.extract(text + ' Edit AGENTS.md.'), /operation_required/);
  assert.throws(() => S.extract('Edit recovery-proof.txt. AGENTS.md substitution may be accepted.'), /operation_required/);
  assert.throws(() => S.extract('Edit recovery-proof.txt. AGENTS.md substitution must not be rejected.'), /operation_required/);
});

test('reported multi-task request keeps roles and exact scope without granting a rejected substitute', () => {
  const text = 'Explicit roles: OpenCode is PLANNER and EVALUATOR only. Cursor is the sole IMPLEMENTATION SPECIALIST for both dependent tasks. In the existing authorized enrolled disposable chatgpt-handoff repository, execute Task A: Cursor READ recovery-proof.txt, host verifies, OpenCode evaluates READY; then Task B: Cursor EDIT recovery-proof.txt to exact bytes AIRODROM-CHATGPT-HANDOFF-PASS plus final newline, host verifies, OpenCode evaluates READY. Target and only authorized modified file is recovery-proof.txt; AGENTS.md substitution must be rejected. Then run registered host checks including requested_file_scope, automatic acceptance, settlement, verified termination and all leases released. Bounded automatic recovery on retryable evaluation errors. No source edits, merge, install or authority increase.';
  const s = S.extract(text); assert.deepEqual(s, scope());
  assert.equal(R.resolveWorkerRoles(text).specialist, 'cursor');
  S.assertEnrollment(s, [requested]); S.assertProposal(s, proposal());
  assert.throws(() => S.assertProposal(s, proposal(['AGENTS.md'])), /plan_mismatch/);
});

test('documentation content operations bind exact literal files without aliases', () => {
  for (const text of ['Update the documentation in docs/README.md.', 'Modify examples within docs/README.md.', 'Rewrite the text of "docs/README.md".']) {
    const s = S.extract(text);
    assert.deepEqual(s.bindings, [{ operation: 'edit', path: 'docs/README.md' }]);
    S.assertEnrollment(s, ['docs/README.md']);
    assert.throws(() => S.assertEnrollment(s, ['README.md']), /not_enrolled/);
    assert.throws(() => S.assertProposal(s, proposal(['README.md'])), /plan_mismatch/);
  }
  assert.deepEqual(S.extract('Update the documentation in "docs/My Guide.md".').bindings,
    [{ operation: 'edit', path: 'docs/My Guide.md' }]);
  assert.deepEqual(S.files(S.extract('Update the documentation in first.md, second.md and `third.md`.')), ['first.md', 'second.md', 'third.md']);
  assert.deepEqual(S.extract('Update the documentation in `LICENSE`.').bindings, [{ operation: 'edit', path: 'LICENSE' }]);
  assert.deepEqual(S.files(S.extract('Update the documentation in README.md and `LICENSE`.')), ['LICENSE', 'README.md']);
});

test('content refinement retains the immediate explicit edit and its read dependency', () => {
  const direct = S.extract('Edit docs/README.md.');
  for (const text of ['Edit docs/README.md and update the examples.', 'Edit docs/README.md, then rewrite its wording.']) {
    assert.deepEqual(S.extract(text), direct);
  }
  const text = 'Read recovery-proof.txt then edit recovery-proof.txt and update the examples.';
  const s = S.extract(text); assert.deepEqual(s, scope()); S.assertProposal(s, proposal());
  const p = proposal(); p.tasks[1].depends_on = []; assert.throws(() => S.assertProposal(s, p), /dependency_mismatch/);
  S.assertOriginal({ envelope: { requested_scope: s }, proposal: proposal() }, text);
  const m = mission(); m.envelope.cognitive.envelope.requested_scope = s;
  assert.equal(S.verification(m, { files: { [requested]: 'after', 'AGENTS.md': 'changed' } }).status, 'failed');
});

test('content refinement cannot inherit read, creation, negated or prior-clause authority', () => {
  for (const text of [
    'Read docs/README.md and update the examples.',
    'Edit README.md. Update the examples.',
    'Edit README.md; update the examples.',
    'Edit README.md\nupdate the examples.',
    'Edit first.md and second.md. Update the examples.',
    'Edit "README.md". Update the examples.',
    'Edit README.md then read input.txt and update the examples.',
    'Do not edit README.md. Update the examples.',
    'Create README.md and update the examples.',
    'Edit README.md and create the examples.',
    'Edit README.md and update LICENSE.',
    'Edit README.md and edit something.',
    'Edit README.md and update the examples under /etc/passwd.',
    'Edit README.md and update the examples from `LICENSE`.',
    'Edit README.md and update the examples in another file.',
    'Edit README.md and update the examples with other/paths.',
    'Edit README.md and update the examples. Extra file other.md.',
    'Edit README.md and update the examples; `LICENSE`',
    'Edit README.md and update the examples. Then /etc/passwd',
    'Edit README.md and update the examples. other/secret',
    'Edit README.md and update the examples? other/target',
    'Edit README.md and update the examples and change the headings.',
    'Edit README.md and delete `LICENSE` and update the examples.',
    'Edit README.md using /etc/passwd and update the examples.',
    'Edit README.md with other/secret and update the examples.',
    'Edit README.md and update\nthe examples.',
    'Update the documentation in README.md and LICENSE',
    'Update the documentation in README.md, LICENSE',
    'Update the documentation in README.md and update',
    'Update the documentation in README.md and READ',
    'Update the documentation in README.md and update: LICENSE',
  ]) assert.throws(() => S.extract(text), /requested_file_operation_required/, text);
});

test('explicit content targets are never swallowed as refinements of a different file', () => {
  const s = S.extract('Read examples.md then edit README.md and update the examples in examples.md.');
  assert.deepEqual(s.bindings, [{ operation: 'read', path: 'examples.md' }, { operation: 'edit', path: 'README.md' }, { operation: 'edit', path: 'examples.md' }]);
  assert.throws(() => S.assertProposal(s, { files: ['examples.md', 'README.md'], tasks: [
    { id: 'r', operation: 'read', paths: ['examples.md'], depends_on: [] },
    { id: 'w', operation: 'edit', paths: ['README.md'], depends_on: ['r'] }
  ] }), /stage_mismatch|plan_mismatch/);
  assert.deepEqual(S.extract('Edit README.md and update the examples in `private name`.').bindings,
    [{ operation: 'edit', path: 'README.md' }, { operation: 'edit', path: 'private name' }]);
});

test('content syntax retains path validity and separate creation authorization', () => {
  for (const file of ['/etc/passwd', '../README.md', 'docs/../README.md', 'docs\\README.md', '.git/config']) {
    assert.throws(() => S.extract('Update the documentation in ' + file), /requested_file_path_invalid|Unsafe verification path/, file);
  }
  assert.throws(() => S.extract('Update the documentation in LICENSE'), /requested_file_operation_required/);
  const s = S.extract('Create the documentation in docs/new.md.');
  assert.deepEqual(s.bindings, [{ operation: 'create', path: 'docs/new.md' }]);
  assert.throws(() => S.assertEnrollment(s, ['docs/new.md']), /creation_not_authorized/);
});

test('corrected quoted-path punctuation cannot rewrite an older sealed binding', () => {
  const legacy = { version: 1, bindings: [{ operation: 'edit', path: 'LICENSE`' }] };
  const cognitive = { envelope: { requested_scope: legacy }, proposal: proposal(['LICENSE`']) };
  const before = JSON.stringify(cognitive);
  assert.deepEqual(S.extract('Edit `LICENSE`.').bindings, [{ operation: 'edit', path: 'LICENSE' }]);
  assert.throws(() => S.assertOriginal(cognitive, 'Edit `LICENSE`.'), /requested_file_constraint_changed/);
  assert.equal(JSON.stringify(cognitive), before);
});

test('a reference document with filenames and freeze rules is not an edit instruction', () => {
  const document = 'ARCHITECTURE FREEZE. Status: FROZEN — NO CHANGES AUTHORIZED.\n' +
    'Verified baseline: recovery-proof.txt was the only changed file.\n' +
    'Do not change agent responsibilities. Do not perform new installation cutovers.';
  assert.throws(() => S.extract(document), /requested_file_operation_required/);
});

test('ONLY is an adverb and status words are not implicit filenames',()=>{
 const S=require('../src/requested-file-scope');
 for(const marker of ['READY','BLOCKED'])assert.deepEqual(S.extract('Edit ONLY fixture.txt and report '+marker+'.').bindings,[{operation:'edit',path:'fixture.txt'}]);
 for(const word of ['READY','ONLY','BLOCKED'])assert.throws(()=>S.extract('Edit file '+word+'.'),/requested_file_operation_required/);
 assert.deepEqual(S.extract('Edit `READY`.').bindings,[{operation:'edit',path:'READY'}]);
});

test('ordinary English prose does not invent file targets (2026-10-24 patterns)', () => {
  assert.deepEqual(S.extract('Edit only README.md').bindings, [{ operation: 'edit', path: 'README.md' }]);
  assert.deepEqual(S.extract('Make changes only to README.md').bindings, [{ operation: 'edit', path: 'README.md' }]);
  assert.deepEqual(S.extract('Use README.md for read and edit operations').bindings, [
    { operation: 'read', path: 'README.md' }, { operation: 'edit', path: 'README.md' },
  ]);
  assert.deepEqual(S.extract('Review the result after editing README.md').bindings, [{ operation: 'edit', path: 'README.md' }]);
  assert.deepEqual(S.extract('Expected evaluation recommendation: READY').bindings, []);
  assert.deepEqual(S.extract('do not edit other files besides README.md').bindings, []);
  assert.throws(() => S.extract('Edit the file'), /requested_file_operation_required/);
  assert.deepEqual(S.extract('Do not change policies, merge, or enable CI.').bindings, []);
  // Descriptive "PATH for read and edit" binds the path without inventing "and".
  const scoped = S.extract('Only two permitted file targets: src/a.js for read, tests/b.js for read and edit.');
  assert.deepEqual(scoped.bindings, [
    { operation: 'read', path: 'src/a.js' },
    { operation: 'read', path: 'tests/b.js' },
    { operation: 'edit', path: 'tests/b.js' },
  ]);
});

test('ordered stages preserve repeated read→edit→read and reject collapsed proposals', () => {
  const text = 'Task A: Cursor read recovery-proof.txt.\nTask B: Cursor edit recovery-proof.txt to exactly PASS.\nTask C: Cursor read recovery-proof.txt.';
  const s = S.extract(text);
  assert.deepEqual(s.bindings, [
    { operation: 'read', path: 'recovery-proof.txt' },
    { operation: 'edit', path: 'recovery-proof.txt' },
  ]);
  assert.deepEqual(s.stages, [
    { operation: 'read', path: 'recovery-proof.txt' },
    { operation: 'edit', path: 'recovery-proof.txt' },
    { operation: 'read', path: 'recovery-proof.txt' },
  ]);
  assert.deepEqual(S.seedTasks(s).map(t => t.operation), ['read', 'edit', 'read']);
  assert.throws(() => S.assertProposal(s, {
    files: ['recovery-proof.txt'],
    tasks: [
      { id: 'request_1', operation: 'read', paths: ['recovery-proof.txt'], depends_on: [] },
      { id: 'request_2', operation: 'edit', paths: ['recovery-proof.txt'], depends_on: ['request_1'] },
    ],
  }), /requested_file_stage_mismatch/);
  S.assertProposal(s, {
    files: ['recovery-proof.txt'],
    tasks: [
      { id: 'request_1', operation: 'read', paths: ['recovery-proof.txt'], depends_on: [] },
      { id: 'request_2', operation: 'edit', paths: ['recovery-proof.txt'], depends_on: ['request_1'] },
      { id: 'request_3', operation: 'read', paths: ['recovery-proof.txt'], depends_on: ['request_2'] },
    ],
  });
});

test('four-stage read→read→edit→edit remains four stages', () => {
  const text = 'Task A: Cursor read a.txt.\nTask B: Cursor read b.txt.\nTask C: Cursor edit b.txt.\nTask D: Cursor edit a.txt.';
  const s = S.extract(text);
  assert.equal(s.stages.length, 4);
  assert.deepEqual(S.seedTasks(s).map(t => t.operation + ':' + t.paths[0]), [
    'read:a.txt', 'read:b.txt', 'edit:b.txt', 'edit:a.txt',
  ]);
  assert.throws(() => S.assertProposal(s, {
    files: ['a.txt', 'b.txt'],
    tasks: [
      { id: 'request_1', operation: 'read', paths: ['a.txt'], depends_on: [] },
      { id: 'request_2', operation: 'edit', paths: ['b.txt'], depends_on: ['request_1'] },
    ],
  }), /requested_file_stage_mismatch/);
});

test('workspace file diagnosis distinguishes missing, oversized and sensitive planner context', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-scope-'));
  fs.writeFileSync(path.join(root, 'ok.txt'), 'hello\n');
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(20000));
  fs.writeFileSync(path.join(root, 'secret.txt'), 'OPENAI_API_KEY=sk-test\n');
  fs.mkdirSync(path.join(root, 'dir'));
  assert.equal(S.diagnoseWorkspaceFile(root, 'ok.txt', {
    planningContextAdmissible: () => true, sourceContextSensitive: () => false, maxDiscoveryFile: 16384,
  }).code, null);
  assert.equal(S.diagnoseWorkspaceFile(root, 'missing.txt', {
    planningContextAdmissible: () => true, sourceContextSensitive: () => false, maxDiscoveryFile: 16384,
  }).code, 'requested_file_absent_from_workspace');
  assert.equal(S.diagnoseWorkspaceFile(root, 'big.txt', {
    planningContextAdmissible: () => false, sourceContextSensitive: () => false, maxDiscoveryFile: 16384,
  }).code, 'requested_file_planning_oversized');
  assert.equal(S.diagnoseWorkspaceFile(root, 'secret.txt', {
    planningContextAdmissible: () => false, sourceContextSensitive: () => true, maxDiscoveryFile: 16384,
  }).code, 'requested_file_planning_sensitive');
  assert.equal(S.diagnoseWorkspaceFile(root, 'dir', {
    planningContextAdmissible: () => true, sourceContextSensitive: () => false, maxDiscoveryFile: 16384,
  }).code, 'requested_file_is_directory');
  fs.rmSync(root, { recursive: true, force: true });
});

test('historical 2026-10-24 v2 instruction parses without false READY/and targets', () => {
  const text = 'Repository: Airodrom Source.\nOpenCode is planner and evaluator.\nCursor is implementation specialist.\n\n'
    + 'Task A: Cursor read src/requested-file-scope.js.\n'
    + 'Task B: Cursor read tests/requested-file-scope.test.js.\n'
    + 'Task C: Cursor edit tests/requested-file-scope.test.js to add regression assertions.\n'
    + 'Task D: Cursor read tests/requested-file-scope.test.js.\n\n'
    + 'Expected evaluation recommendation: READY.\n'
    + 'Only two permitted file targets: src/requested-file-scope.js for read, tests/requested-file-scope.test.js for read and edit.';
  const s = S.extract(text);
  assert.equal(s.stages.length, 4);
  assert.deepEqual(s.stages.map(x => x.operation), ['read', 'read', 'edit', 'read']);
  assert.ok(!s.bindings.some(b => /^(READY|and|ONLY)$/i.test(b.path)));
});


test('implicit mutation verbs bind unique prior path (fix/patch/implement)', () => {
  for (const text of [
    'Inspect README.md and fix typos.',
    'Read README.md and patch the wording.',
    'Inspect README.md and implement the corrections.',
  ]) {
    const s = S.extract(text);
    assert.deepEqual(s.bindings, [
      { operation: 'read', path: 'README.md' },
      { operation: 'edit', path: 'README.md' },
    ]);
    assert.deepEqual(s.stages, s.bindings);
  }
  assert.deepEqual(S.extract('Fix typos in README.md.').bindings, [
    { operation: 'edit', path: 'README.md' },
  ]);
  assert.deepEqual(S.extract('Inspect README.md and fix typos in docs/guide.md.').bindings, [
    { operation: 'read', path: 'README.md' },
    { operation: 'edit', path: 'docs/guide.md' },
  ]);
});

test('implicit mutation negatives stay fail-closed or read-only', () => {
  assert.deepEqual(S.extract('Inspect README.md but do not fix typos.').bindings, [
    { operation: 'read', path: 'README.md' },
  ]);
  assert.throws(() => S.extract('Inspect README.md and CHANGELOG.md, then fix typos.'), /requested_file_operation_required/);
  assert.throws(() => S.extract('Implement the solution'), /requested_file_operation_required/);
  assert.throws(() => S.extract('Patch the system'), /requested_file_operation_required/);
  assert.deepEqual(S.extract('Review the implementation').bindings, []);
  assert.deepEqual(S.extract('Fix only if verification fails').bindings, []);
  assert.deepEqual(S.extract('Do not modify AGENTS.md').bindings, []);
});

test('negated and empty mutation phrases do not refine edits', () => {
  assert.deepEqual(S.extract('Inspect README.md without fixing typos.').bindings, [
    { operation: 'read', path: 'README.md' },
  ]);
  assert.deepEqual(S.extract('Inspect README.md and fix nothing.').bindings, [
    { operation: 'read', path: 'README.md' },
  ]);
  assert.deepEqual(S.extract('Read README.md. Implement nothing.').bindings, [
    { operation: 'read', path: 'README.md' },
  ]);
});

test('structured file phrases preserve negation before planning and sealing', () => {
  for (const text of [
    'Do not make changes only to README.md.',
    'Never make changes only in README.md.',
    "Don't use README.md for read and edit.",
    'Do not review the result after editing README.md.',
    'Implement nothing.',
  ]) {
    assert.deepEqual(S.extract(text).bindings, [], text);
    assert.equal(R.requestedWorker(text), 'auto', text);
  }
  const text = 'Read README.md. Do not use README.md for read and edit.';
  const s = S.extract(text);
  assert.deepEqual(s.stages, [{ operation: 'read', path: 'README.md' }]);
  assert.equal(R.requestedWorker(text), 'auto');
  assert.throws(() => S.assertProposal(s, { files: ['README.md'], tasks: [
    { id: 'write', operation: 'edit', paths: ['README.md'], depends_on: [] },
  ] }), /requested_file_plan_mismatch/);
});

test('structured operations retain source order and dependency requirements', () => {
  const s = S.extract('Read README.md then make changes only to README.md.');
  assert.deepEqual(s.stages, [
    { operation: 'read', path: 'README.md' }, { operation: 'edit', path: 'README.md' },
  ]);
  assert.throws(() => S.assertProposal(s, { files: ['README.md'], tasks: [
    { id: 'read', operation: 'read', paths: ['README.md'], depends_on: [] },
    { id: 'edit', operation: 'edit', paths: ['README.md'], depends_on: [] },
  ] }), /requested_file_dependency_mismatch/);
  const four = S.extract('Task A: Read fixture.txt. Task B: Inspect fixture.txt. Task C: Make changes only to fixture.txt. Task D: Read fixture.txt.');
  assert.deepEqual(four.stages.map(s => s.operation), ['read', 'read', 'edit', 'read']);
  const tasks = S.seedTasks(four);
  assert.equal(new Set(tasks.map(t => t.id)).size, 4);
  S.assertProposal(four, { files: ['fixture.txt'], tasks });
});

test('mutation refinement neither duplicates explicit targets nor borrows future reads', () => {
  for (const text of ['Read A.md and fix typos in B.md.', 'Read A.md and implement corrections in B.md.']) {
    assert.deepEqual(S.extract(text).stages, [
      { operation: 'read', path: 'A.md' }, { operation: 'edit', path: 'B.md' },
    ]);
  }
  assert.deepEqual(S.extract('Read A.md and fix typos, then read A.md.').stages, [
    { operation: 'read', path: 'A.md' }, { operation: 'edit', path: 'A.md' }, { operation: 'read', path: 'A.md' },
  ]);
  assert.throws(() => S.extract('Fix typos, then read A.md.'), /requested_file_operation_required/);
  assert.throws(() => S.extract('Fix typos. Read the content in B.md.'), /requested_file_operation_required/);
  const text = 'Read A.md and fix typos. Do not patch B.md.';
  assert.deepEqual(S.extract(text).stages, [
    { operation: 'read', path: 'A.md' }, { operation: 'edit', path: 'A.md' },
  ]);
});

