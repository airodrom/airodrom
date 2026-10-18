'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const integrity = require('../scripts/checkpoint-integrity.cjs');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-src-'));
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'data', 'note.txt'), 'kept\n');
  fs.writeFileSync(path.join(root, 'data', 'private.txt'), 'secret\n');
  fs.chmodSync(path.join(root, 'data', 'note.txt'), 0o644);
  fs.chmodSync(path.join(root, 'data', 'private.txt'), 0o600);
  fs.symlinkSync('note.txt', path.join(root, 'data', 'alias.txt'));
  const manifest = ['data/note.txt', 'data/private.txt'].map(file => {
    const stat = fs.lstatSync(path.join(root, file));
    return { file, bytes: stat.size, mode: stat.mode & 0o777, sha256: integrity.hashFile(path.join(root, file)) };
  });
  manifest.push({ file: 'data/alias.txt', symlink: 'note.txt' });
  return { root, manifest };
}

test('private copy keeps recorded modes under umask 077 and rejects corruption or escaping links', () => {
  const previous = process.umask(0o077);
  const { root, manifest } = tree();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-copy-'));
  fs.chmodSync(dir, 0o700);
  const copy = path.join(dir, 'payload');
  try {
    integrity.copyPayload(root, copy);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    integrity.assertTree(root, manifest);
    integrity.assertTree(copy, manifest);
    assert.equal(fs.lstatSync(path.join(copy, 'data/note.txt')).mode & 0o777, 0o644);
    assert.equal(fs.lstatSync(path.join(copy, 'data/private.txt')).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(copy, 'data/note.txt'), 'changed\n');
    fs.chmodSync(path.join(copy, 'data/note.txt'), 0o644);
    assert.throws(() => integrity.assertTree(copy, manifest), /integrity mismatch/);
    const escaped = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-link-'));
    fs.mkdirSync(path.join(escaped, 'data'), { mode: 0o700 });
    fs.symlinkSync('/tmp', path.join(escaped, 'data', 'out'));
    assert.throws(() => integrity.copyPayload(escaped, path.join(dir, 'escaped')), /escapes/);
    fs.rmSync(escaped, { recursive: true, force: true });
  } finally {
    process.umask(previous);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
