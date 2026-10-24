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

test('historical controlled marker produces one independently verified mismatch and cannot authorize a new writer',async t=>{
 const f=await fixture(t);placeMarker(f.repo);
 const m=f.create({objective:'Change fixture.txt from alpha to beta.',task_type:'local_files',manifest:manifest(f.repo),dispatch_policy:{privacy:'local_only',providers:['local'],billing_classes:['local'],task_category:'deterministic_files',native_actions:[{name:'file_write',path:'fixture.txt',content:'beta\n'}]}});
 await require('./fixtures/historical-native-fixture.cjs').completeHistoricalNative(f,m);const failed=await f.settle(m.id,'needs_rework');
 assert.equal(failed.verifications[0].result,'failed');assert.ok(failed.verifications[0].evidence.some(c=>c.id==='expected_file'&&c.status==='failed'));assert.equal(fs.readFileSync(path.join(f.repo,'fixture.txt'),'utf8'),'gamma\n');
 assert.equal(fs.existsSync(path.join(f.repo,MARKER)),false);const receipt=appliedReceipt(f.repo);assert.ok(receipt);t.after(()=>fs.rmSync(receipt,{force:true}));assert.equal(JSON.parse(fs.readFileSync(receipt)).mission_id,m.id);
 assert.equal(applyControlledFailure(f.bridge.controlStore.requireMission(m.id)).applied,false);assert.equal(failed.acceptance.length,0);
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
