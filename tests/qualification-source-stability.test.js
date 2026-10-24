'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { sourceFingerprint } = require('../src/runtime-fingerprint');
const { AuthorityQualification } = require('../src/authority-qualification');

test('qualification retains the source-drift denial instead of treating a rerun as authorization', () => {
  const source = AuthorityQualification.prototype.source;
  const unchanged = {bridge:{runtimeFingerprint:sourceFingerprint()}};
  assert.equal(source.call(unchanged), unchanged.bridge.runtimeFingerprint.source_sha256);
  assert.throws(() => source.call({bridge:{runtimeFingerprint:{source_sha256:'stale-fixture-hash'}}}), /Source\/live fingerprint mismatch/);
});

test('source or lockfile edits during qualification change the fingerprint; test artifacts do not', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airodrom-fingerprint-')); t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'src')); fs.writeFileSync(path.join(root,'src/example.js'),'module.exports=1;');
  fs.writeFileSync(path.join(root,'package.json'),'{}'); fs.writeFileSync(path.join(root,'package-lock.json'),'{}');
  const initial = sourceFingerprint(root).source_sha256;
  fs.writeFileSync(path.join(root,'test-result.json'),'{}'); assert.equal(sourceFingerprint(root).source_sha256,initial);
  fs.writeFileSync(path.join(root,'src/example.js'),'module.exports=2;'); assert.notEqual(sourceFingerprint(root).source_sha256,initial);
  fs.writeFileSync(path.join(root,'src/example.js'),'module.exports=1;'); assert.equal(sourceFingerprint(root).source_sha256,initial);
  fs.writeFileSync(path.join(root,'package-lock.json'),'{"lockfileVersion":3}'); assert.notEqual(sourceFingerprint(root).source_sha256,initial);
});
