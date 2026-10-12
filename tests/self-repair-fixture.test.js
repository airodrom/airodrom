'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { manifest } = require('./fixtures/opencode-fixture.cjs');
const { applyControlledFailure, MARKER, appliedReceipt } = require('../src/self-repair-fixture');

function placeMarker(repo) {
  const ignore = path.join(repo, '.gitignore');
  const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  if (!current.split('\n').includes('.airodrom/')) {
    fs.writeFileSync(ignore, (current.endsWith('\n') || !current ? current : current + '\n') + '.airodrom/\n');
    const git = (args) => {
      const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      if (r.status !== 0) throw Error('git ' + args.join(' ') + ' failed');
    };
    git(['add', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Ignore self-repair marker dir']);
  }
  const dir = path.join(repo, '.airodrom');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(repo, MARKER), JSON.stringify({
    version: 1,
    mode: 'exact_file_once',
    file: 'fixture.txt',
    wrong_content: 'gamma\n',
    expected_content: 'beta\n',
    authority: false,
  }, null, 2) + '\n', { mode: 0o600 });
}

test('controlled marker forces one verification failure then repair restores exact bytes', async t => {
  const f = await fixture(t);
  placeMarker(f.repo);
  const parent = f.create({
    objective: 'Change fixture.txt from alpha to beta. Make its test pass.',
    task_type: 'local_files',
    manifest: manifest(f.repo),
    dispatch_policy: {
      privacy: 'local_only', providers: ['local'], billing_classes: ['local'],
      task_category: 'deterministic_files',
      native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'beta\n' }],
    },
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }],
  });
  const plan = f.bridge.missions.goalPlanner.create({
    request_id: randomUUID(),
    goal_id: parent.goal_id,
    stages: [{
      id: 'one', depends_on: [], mission_id: parent.id,
      objective: 'Bounded exact-file step',
      acceptance_criteria: ['Exact file criterion passes'],
      verification_requirements: ['Independent registered tests'],
      human_checkpoint: false,
    }],
    max_runtime_hours: 1, max_attempts: 3,
  });
  f.bridge.autonomousExecution.authorize(plan.id, {
    request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1,
    max_dispatches: 10, max_repairs: 1, confirmed: true,
  });

  await f.bridge.autonomousExecution.tick();
  let repairId = null, sawFail = false;
  for (let i = 0; i < 400 && !repairId; i++) {
    await f.bridge.missions.tick();
    if (f.bridge.missions.detail(parent.id).state === 'needs_rework') sawFail = true;
    repairId = f.bridge.autonomousExecution.inspect(plan.id).autonomous.repair_lineage?.one?.repair_mission_id || null;
    if (!repairId) await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(sawFail, true);
  assert.ok(repairId);
  assert.equal(fs.existsSync(path.join(f.repo, MARKER)), false);
  assert.ok(appliedReceipt(f.repo));

  const repaired = await f.settle(repairId, 'awaiting_acceptance');
  assert.equal(repaired.state, 'awaiting_acceptance');
  assert.equal(Buffer.from(fs.readFileSync(path.join(f.repo, 'fixture.txt'))).toString('hex'), '626574610a');
  assert.equal(f.bridge.missions.goalPlanner.inspect(plan.id).stages[0].mission_id, repairId);
});

test('marker does not apply to repair Missions or expand scope', async t => {
  const f = await fixture(t);
  placeMarker(f.repo);
  const applied = applyControlledFailure({
    id: randomUUID(),
    envelope: {
      repair_of: randomUUID(),
      workspace: f.repo,
      allowed_files: ['fixture.txt'],
      kind: 'coding',
    },
  });
  assert.equal(applied.applied, false);
  assert.equal(fs.existsSync(path.join(f.repo, MARKER)), true);
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n');
});
