'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { baselineFile, runGit, securityScan, audit } = require('../src/verifier-baseline');

function repo() {
  const root = fs.mkdtempSync('/private/tmp/baseline-trust-');
  const git = args => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  fs.writeFileSync(path.join(root, 'kept.txt'), 'alpha\n');
  git(['add', 'kept.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'baseline']);
  const sha = git(['rev-parse', 'HEAD']).trim();
  return { root, sha, git };
}

test('trusted baseline lookup distinguishes absence from a failed Git read', t => {
  const f = repo();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const present = baselineFile(f.root, f.sha, 'kept.txt');
  assert.equal(present.absent, false);
  assert.equal(present.content.toString('utf8'), 'alpha\n');
  const absent = baselineFile(f.root, f.sha, 'new.txt');
  assert.equal(absent.absent, true);
  assert.equal(absent.content.length, 0);
  assert.equal(baselineFile(f.root, '0'.repeat(40), 'kept.txt').unavailable, 'baseline_commit_unavailable');
  assert.equal(baselineFile('/private/tmp/missing-baseline-repo', f.sha, 'kept.txt').unavailable, 'repository_unavailable');
  const slow = repo();
  t.after(() => fs.rmSync(slow.root, { recursive: true, force: true }));
  slow.git(['config', 'filter.slow.clean', 'sleep 2']);
  slow.git(['config', 'filter.slow.required', 'true']);
  fs.writeFileSync(path.join(slow.root, '.gitattributes'), '*.txt filter=slow\n');
  fs.writeFileSync(path.join(slow.root, 'kept.txt'), 'beta\n');
  assert.equal(runGit(slow.root, ['add', 'kept.txt'], 80).unavailable, 'git_timeout');
  const object = f.git(['rev-parse', 'HEAD:kept.txt']).trim();
  const blob = path.join(f.root, '.git/objects', object.slice(0, 2), object.slice(2));
  fs.chmodSync(blob, 0);
  t.after(() => { try { fs.chmodSync(blob, 0o644); } catch { /* already removed */ } });
  assert.equal(baselineFile(f.root, f.sha, 'kept.txt').unavailable, 'trusted_baseline_unreadable');
  const contract = { verification: { required_security_checks: ['secret_scan'] } };
  const missingMeta = securityScan(f.root, ['kept.txt'], { contract, baselineRecord: { files: [] } });
  assert.equal(missingMeta.find(check => check.id === 'security:secret_scan').status, 'unavailable');
  assert.notEqual(missingMeta.find(check => check.id === 'security:secret_scan').status, 'passed');
  const badCommit = securityScan(f.root, ['kept.txt'], { contract, baselineRecord: { base_commit_sha: '0'.repeat(40), files: [] } });
  assert.equal(badCommit.find(check => check.id === 'security:secret_scan').status, 'unavailable');
  assert.equal(badCommit.find(check => check.id === 'security:secret_scan').evidence.baseline_reason, 'baseline_commit_unavailable');
  fs.writeFileSync(path.join(f.root, 'new.txt'), 'plain\n');
  const clean = securityScan(f.root, ['new.txt'], { contract, baselineRecord: { base_commit_sha: f.sha, files: [] } });
  assert.equal(clean.find(check => check.id === 'security:secret_scan').status, 'passed');
  assert.equal(clean.find(check => check.id === 'security:secret_scan').evidence.new_findings, 0);
  const reviewed = audit(f.root, { version: 1, base_commit_sha: '0'.repeat(40), files: [{ path: 'kept.txt', sha256: 'abc' }] }, { files: { 'kept.txt': 'abc' } });
  assert.equal(reviewed.trusted_source.available, false);
  assert.equal(reviewed.status, 'unavailable');
  assert.notEqual(reviewed.status, 'passed');
});
