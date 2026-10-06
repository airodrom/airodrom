'use strict';
// Evidence contains identities, metadata and digests only, never file contents.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { fingerprint } = require('./control-plane-store');
const POLICY = Object.freeze({ version: 2, maxFiles: 10000, maxMetadataBytes: 4 * 1024 * 1024,
  maxScope: 40, chunkBytes: 64 * 1024, legacyBytes: 64 * 1024 * 1024,
  legacyFileBytes: 16 * 1024 * 1024, maxHashBytes: 8 * 1024 * 1024 * 1024,
  // Git's repository ignore policy excludes generated/untracked dependencies.
  // Tracked files are always protected, even when named by an ignore rule.
  exclusions: 'git-untracked-ignore-policy; .git administrative directory' });
function resolveGitExecutable() {
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
        '/Library/Developer/CommandLineTools/usr/bin/git',
        '/usr/bin/git'
      ]
    : [
        '/usr/bin/git',
        '/usr/local/bin/git',
        '/opt/homebrew/bin/git'
      ];
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).isFile()) return real;
    } catch {}
  }
  throw Error('Required Git executable unavailable');
}
function safePath(name) {
  if (typeof name !== 'string' || !name || name.length > 1000 || name !== name.normalize('NFC') ||
      /[\\\x00-\x1f\x7f]/.test(name) || path.isAbsolute(name) ||
      name.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git'))
    throw Error('Unsafe verification path');
  return name;
}
function metadata(s) { return { type: s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : 'other',
  size: s.size, mode: s.mode, dev: s.dev, ino: s.ino, mtime: s.mtimeMs, ctime: s.ctimeMs }; }
function inspect(root, name, { owned = false } = {}) {
  safePath(name);
  let parent = root;
  for (const part of name.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    try { const s = fs.lstatSync(parent); if (!s.isDirectory() || s.isSymbolicLink()) throw Error('Verification symlink parent'); }
    catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; }
  }
  const file = path.join(root, name); let s;
  try { s = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; }
  if (s.isSymbolicLink()) {
    const target = fs.readlinkSync(file), resolved = path.resolve(path.dirname(file), target);
    if (owned || !(resolved === root || resolved.startsWith(root + path.sep))) throw Error('Verification symlink escape or owned symlink');
    return { exists: true, ...metadata(s), digest: 'symlink:' + createHash('sha256').update(target).digest('hex') };
  }
  if (!s.isFile()) throw Error('Unknown required verification file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (before.ino !== s.ino || before.dev !== s.dev) throw Error('Verification file identity changed');
    const hash = createHash('sha256'), buffer = Buffer.alloc(POLICY.chunkBytes);
    let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n));
    const after = fs.fstatSync(fd), last = fs.lstatSync(file);
    if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after)) ||
        JSON.stringify(metadata(after)) !== JSON.stringify(metadata(last))) throw Error('Verification file changed during hashing');
    return { exists: true, ...metadata(after), digest: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function repositorySnapshot(root) {
  root = fs.realpathSync(root);
  const gitPath = resolveGitExecutable();
  const git = args => {
    const r = spawnSync(gitPath, ['-C', root, ...args], { encoding: 'utf8', timeout: 30000,
      maxBuffer: POLICY.maxMetadataBytes, env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } });
    if (r.status !== 0 || r.error) throw Error('Required Git verification observation unavailable');
    return r.stdout;
  };
  if (fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== root) throw Error('Verification root mismatch');
  const head = git(['rev-parse', '--verify', 'HEAD']).trim();
  const branch = git(['branch', '--show-current']).trim();
  const gitDir = fs.realpathSync(git(['rev-parse', '--absolute-git-dir']).trim());
  const commonDir = fs.realpathSync(path.resolve(root, git(['rev-parse', '--git-common-dir']).trim()));
  const index = git(['ls-files', '-s', '-z']);
  if (git(['ls-files', '-u', '-z'])) throw Error('Unmerged index cannot be verified');
  const tracked = git(['ls-files', '-z', '--cached']).split('\0').filter(Boolean);
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const names = [...new Set([...tracked, ...untracked])].sort();
  if (names.length > POLICY.maxFiles) throw Error('Verification file budget exceeded');
  const folded = new Set();
  for (const name of names) { safePath(name); const key = name.toLowerCase();
    if (folded.has(key)) throw Error('Verification canonical/case ambiguity'); folded.add(key); }
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const rows = status.split('\0'), dirty = [], statusEntries = [];
  for (let i = 0; i < rows.length; i++) if (rows[i]) {
    const code = rows[i].slice(0, 2), name = safePath(rows[i].slice(3)); dirty.push(name);
    const entry = { code, path: name }; if (/[RC]/.test(code)) { entry.from = safePath(rows[++i]); dirty.push(entry.from); }
    statusEntries.push(entry);
  }
  const files = Object.create(null), inventory = Object.create(null); let bytes = 0, largest = 0;
  for (const name of names) {
    const st = fs.lstatSync(path.join(root, name), { throwIfNoEntry: false });
    bytes += st?.size || 0; largest = Math.max(largest, st?.size || 0);
    if (bytes > POLICY.maxHashBytes) throw Error('Verification streaming byte budget exceeded');
    const item = inspect(root, name); inventory[name] = item; if (item.exists) files[name] = item.digest;
  }
  if (git(['rev-parse', '--verify', 'HEAD']).trim() !== head || git(['branch', '--show-current']).trim() !== branch ||
      git(['ls-files', '-s', '-z']) !== index ||
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all']) !== status ||
      git(['ls-files', '-z', '--cached']).split('\0').filter(Boolean).join('\0') !== tracked.join('\0') ||
      git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean).join('\0') !== untracked.join('\0'))
    throw Error('Repository changed during verification');
  const repository = { root, head, branch, git_dir: gitDir, common_dir: commonDir };
  const mode = bytes > POLICY.legacyBytes || largest > POLICY.legacyFileBytes ? 'streaming-v2' : 'legacy-compatible-v2';
  const snapshot = { version: 2, mode, policy: POLICY, repository, files, inventory, dirty: [...new Set(dirty)].sort(),
    status_entries: statusEntries, index, tracked, untracked, head, branch, total_bytes: bytes };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > POLICY.maxMetadataBytes) throw Error('Verification metadata budget exceeded');
  return { ...snapshot, hash: fingerprint({ repository, files, inventory, index, status: statusEntries }) };
}
function manifest(snapshot, allowed, { inspectNow = true } = {}) {
  if (snapshot.version !== 2 || !Array.isArray(allowed) || !allowed.length || allowed.length > POLICY.maxScope || new Set(allowed).size !== allowed.length)
    throw Error('Invalid verification manifest');
  const known = new Map(Object.keys(snapshot.inventory).map(n => [n.toLowerCase(), n]));
  const scopeFolded = new Set();
  for (const name of allowed) {
    if(scopeFolded.has(name.toLowerCase()))throw Error('Verification scope case ambiguity');
    scopeFolded.add(name.toLowerCase());
    safePath(name);
    if (known.has(name.toLowerCase()) && known.get(name.toLowerCase()) !== name) throw Error('Verification scope case ambiguity');
    if (inspectNow && snapshot.dirty.includes(name)) throw Error('Verification scope overlaps existing dirty work');
    if (/^(?:tests?\/|\.vscode\/)|(^|\/)(?:\.env(?:\.|$)|credentials|secrets)/i.test(name)) throw Error('Protected verification scope');
    const actual=inspectNow?inspect(snapshot.repository.root, name, { owned: true }):(snapshot.inventory[name]||{exists:false});
    if(actual.exists && !snapshot.inventory[name]?.exists)throw Error('Ignored/unobserved owned path');
  }
  return { version: 2, repository: snapshot.repository, baseline_hash: snapshot.hash,
    allowed_files: [...allowed].sort(), before: Object.fromEntries(allowed.map(n => [n, snapshot.inventory[n] || { exists: false }])),
    pre_existing_dirty: snapshot.dirty, pre_existing_untracked: snapshot.untracked, policy: POLICY };
}
function compare(before, after, scope, tests = [], { creation = null } = {}) {
  const m = manifest(before, scope, { inspectNow: false });
  if (after.version !== 2 || fingerprint(before.repository) !== fingerprint(after.repository)) throw Error('Verification repository/HEAD/worktree identity mismatch');
  const names = [...new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)])].sort();
  const changed = names.filter(n => fingerprint(before.inventory[n] || { exists: false }) !== fingerprint(after.inventory[n] || { exists: false }));
  const retouches = changed.filter(n=>scope.includes(n)&&before.dirty.includes(n)&&creation?.version===2&&!creation.dirty.includes(n)&&fingerprint(creation.repository)===fingerprint(before.repository)&&['digest','type','size','mode','dev','ino','exists'].every(k=>before.inventory[n]?.[k]===after.inventory[n]?.[k]));
  const outside = changed.filter(n => !scope.includes(n) || (before.dirty.includes(n)&&!retouches.includes(n)));
  // Index/status changes count even when working-tree bytes are identical.
  const statusChanged = [...new Set([...before.status_entries, ...after.status_entries].map(e => e.path))]
    .filter(n => fingerprint(before.status_entries.filter(e => e.path === n)) !== fingerprint(after.status_entries.filter(e => e.path === n)));
  for (const n of statusChanged) if ((!scope.includes(n) || before.dirty.includes(n)) && !outside.includes(n)) outside.push(n);
  const indexRows = s => Object.fromEntries(s.index.split('\0').filter(Boolean).map(r=>[r.slice(r.indexOf('\t')+1),r.slice(0,r.indexOf('\t'))]));
  const bi=indexRows(before),ai=indexRows(after);
  for(const name of new Set([...Object.keys(bi),...Object.keys(ai)]))if(bi[name]!==ai[name]&&!scope.includes(name)&&!outside.includes(name))outside.push(name);
  for (const name of scope) { const actual=inspect(after.repository.root, name, { owned: true });
    if(actual.exists&&!after.inventory[name]?.exists)throw Error('Ignored/unobserved owned path'); }
  return { version: 2, mode: after.mode, manifest: m, status: outside.length ? 'failed' : 'passed',
    before_hash: before.hash, after_hash: after.hash, changed_paths: changed, protected_changes: outside.sort(), retouched_owned_paths: retouches,
    newly_created: changed.filter(n => !before.inventory[n]?.exists && after.inventory[n]?.exists),
    after: Object.fromEntries(scope.map(n => [n, after.inventory[n] || { exists: false }])), tests };
}
module.exports = { POLICY, resolveGitExecutable, safePath, inspect, repositorySnapshot, manifest, compare };
